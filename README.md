# Wasthon

<div align="center">
    <img src="Wasthon.png" alt="Wasthon Logo" width="200"/>
</div>

**A CPython C-API bridge for Brython: unmodified C extension modules,
compiled to WebAssembly, running inside Brython.**

> Brython is Holmes — the genius detective doing Python→JS magic.
> Wasthon is Watson — the loyal companion bringing the C extensions along.

## What it is

Wasthon implements just enough of CPython's public C-API, on top of
Brython's runtime, for C extension modules to compile unmodified with
Emscripten and run inside Brython. The C side works with `PyObject *`; the
bridge maps each one onto a Brython object, with reference counting,
`tp_dealloc`, the buffer protocol, type specs, arg parsing and the rest of
the surface extension modules actually use.

What runs on it lives in its own repositories, which take the bridge from
here (`src/`, `cython-support/`, the vendored Brython and the loader helpers):

- [Wastdlib](https://github.com/fgallaire/wastdlib) — CPython's C
  standard-library modules (`hashlib`, `zlib`, `_decimal`, `_json`,
  `_sqlite3`, …), validated against CPython's own test suites
- [NumBry](https://github.com/fgallaire/numbry) — NumPy, SciPy, pandas,
  matplotlib, seaborn, Pillow, SymPy
- [BryTorch](https://github.com/fgallaire/brytorch) — PyTorch
- [Brygame](https://github.com/fgallaire/brygame) — pygame-ce and Dear ImGui

## How it works

Brython executes Python by compiling it to JavaScript: its objects are JS
objects, its garbage collector is the JS engine's tracing GC, and **nothing
has a reference count**. CPython extension modules are C code that expects
the opposite world: `PyObject *` pointers into a C heap, reference counting,
struct layouts (`ob_type`, `tp_dealloc`, buffer pointers) read directly by
offset.

Pyodide resolves this by shipping the entire CPython interpreter as wasm.
Wasthon does not: it keeps Brython as the runtime and **reifies the CPython
C-API as a foreign-function boundary** — every `Py*` call made by the C code
is served, on the JS side, by Brython. The extension's algorithms run as
native wasm; its view of "Python objects" is an illusion maintained by the
bridge. From a `<x>module.c`, one `emcc` invocation against `src/` produces
an Emscripten ES6 module exposing `PyInit_<x>()`; `loader/wasthon-loader.js`
instantiates it and registers it under `__BRYTHON__.imported[<x>]`, so
`import <x>` from Python just works.

```
                ┌──────────────────────────────────────────────┐
   <x>module.c  │  emcc  →  PyInit_<x>() exported via WASM     │
   (unmodified) │     ↑                                        │
                │  wasthon.h + wasthon.c + wasthon.js          │
                │  (CPython C-API replicated atop Brython)     │
                └──────────────────────────────────────────────┘
                                  ↑
                          Brython runtime
                          (__BRYTHON__, _b_)
                                  ↑
                          User Python:
                              import _decimal
                              d = _decimal.Decimal('3.14') * 2
```

Fix-by-fix history lives in `CHANGELOG.md` (bridge) and `BRYTHON_FIX.md`
(vendored Brython); what follows is the map.

### Handles

`PyObject *` is a 32-bit integer **handle** into a JS-side table
(`WasthonRT.handles: Map<int, object>`) holding strong references to Brython
objects. Three key ranges share one map:

- **11–14** — the immortal singletons (`None`, `True`, `False`,
  `NotImplemented`); not 1–4, since pybind11 reads a returned 1 as its "try
  the next overload" marker.
- **15 – 0xFFFF** — *sentinel* handles: Brython objects passed into C
  (`wrap(obj)`). IDs are recycled through a free list. `wrap` is
  idempotent per object (identity interning via a `WeakMap`), so handle
  equality is object identity — C-side `a == b` pointer comparisons work.
- **≥ 0x10000** — *instance* handles: real linear-memory pointers returned
  by `_malloc` for instances of C-defined types
  (`wasthon_object_gc_new`). The pointer doubles as the map key, so JS can
  find the Brython wrapper of any C struct and vice versa
  (`obj.__wasthon_ptr__`).

`PyObject` is declared as `{ intptr_t ob_refcnt; }` (hard rule 3) and every
macro that CPython implements by struct access (`Py_TYPE`,
`PyTuple_GET_ITEM`, `PyUnicode_GET_LENGTH`, …) is routed through a bridge
function.

### Object lifetime

The core difficulty: C code *does* refcount (it calls `Py_INCREF`/`DECREF`
and stores "owned" references in structs), while Brython cannot. The bridge
resolves this with **handle scopes** (the JNI local-reference / HPy model)
layered under a real refcount for whatever C explicitly owns:

1. **Scope-owned** (the default). Every JS→C entry point — method
   trampoline, slot dispatch, `tp_new`/`tp_init`/`tp_call`, getset — runs
   under `pushScope()`/`popScope()`. Sentinel handles created while the
   scope is active belong to it and are released at pop. A borrowed
   argument therefore lives exactly as long as the C call, like CPython's
   borrowed references.
2. **Refcounted**. A handle escapes its scope by acquiring a refcount:
   `wrapNewRef()` (the new-reference convention of constructors and call
   results — seeds refcount 1), a C-side `Py_INCREF`, or a "no-steal" store
   API (`PyList_SET_ITEM`, `PyModule_AddObjectRef`, …). At pop, ownership
   transfers from the scope to the refcount; the handle dies when it drops
   to zero. For instances, zero dispatches the type's **`tp_dealloc`**
   (read at offset 40 of the type struct, up the base chain as CPython's
   `subtype_dealloc` does, called through the wasm table under its own
   scope) and then `PyObject_GC_Del` frees the struct and the map entries.
3. **Immortal**. No scope active (module init, loader time) → handles are
   never collected. Interned strings live in a pinned pool.

`tests/lifetime.py` proves both halves A/B: over 2000 calls `handles.size`
stays flat with scopes (+91 per call without), `refcounts.size` stays flat
with `tp_dealloc` (+1 per call without).

What no refcount sees is Python dropping its last reference: Brython has no
scope-exit or GC callback into `wasthon_decref`. So an instance Python holds
is released on a **trigger** (history and measurements under "What's next"):

- **`close()`/`with`** for heavy native resources (compressor contexts, DB
  connections) — the stance of Pyodide's `PyProxy.destroy()` — plus the
  wrap of the one-shot `compress()`/`decompress()` helpers
  (`loader/wasthon-dealloc.js`);
- **`del`**: a quick walk decides `__del__` on the spot, and the instance is
  freed only once a complete mark from every live frame and module proves
  it unreachable;
- **`gc.collect()`**: settles everything pending since a `del`, cycles
  included, and sweeps the resource-holding types that opt in
  (`$wasthon_gc_finalizable`: sqlite3's, `_pickle`'s Pickler/Unpickler);
- **the whole-heap collection** (`$wasthon_reclaim`): one mark, then each
  runtime frees every instance only its wrapper owns (refcount 1, handed
  over at its first crossing) that the mark did not reach — what a program
  simply stopped using. The host calls it where no expression is half
  evaluated (brytorch: between two tests);
- **`FinalizationRegistry`**, opt-in (`rt.reclaimResults`) on a page that
  yields between units of work: the JS GC's own proof that a result's
  wrapper died.

### Types

C extensions create types with `PyType_FromModuleAndSpec` / `PyType_FromSpec`
(heap types, slots identified by CPython's numeric slot IDs). The bridge:

- creates a **Brython class** for Python-side use, and
- allocates a **`PyTypeObject` struct in linear memory** (field order
  documented in `wasthon.h`; e.g. `tp_dealloc` at offset 40) for the C code
  that reads type fields directly (`type->tp_alloc(type, 0)`,
  `st->type->tp_dict`, …). The type handle *is* this struct's pointer.
  Brython classes that never went through FromSpec get one lazily
  (`ensureTypeStruct`).

Static `PyTypeObject` definitions (torch, pygame) go through `PyType_Ready`
instead; same wiring, read from the struct at the `wasthon.h` offsets.
**Metatypes**: `PyVarObject_HEAD_INIT(&meta, 0)` stores its first argument
in the tail `ob_type` field (offset 176, appended — no historical offset
moved) and `PyType_Ready` sets the class's `__class__` to the readied
metatype, so `__instancecheck__` and metaclass getsets dispatch exactly as
CPython (`isinstance(t, torch.FloatTensor)`, `torch.FloatTensor.dtype`).
The value is honoured only if it names an already-readied type — modules
compiled before the field existed carry arbitrary trailing bytes.

Slots are wired **by ID, not by struct offset** — `Py_tp_call`,
`Py_nb_add`, `Py_bf_getbuffer` etc. map to Brython dunders and to the
protocol dispatchers. Making a method visible to Brython requires three
installs (learned the hard way, all mandatory): the `tp_funcs` fast path,
the `$getattribute` marker, and a real `method_descriptor` in the class
dict — `__wasthon_install_methods` / `_getsets` / `_members` do all three.

**Dual identity.** An instance carries two type facts: `ob_type` = the live
Brython class (so `type(x)` and Python subclassing behave), and
`__wasthon_type__` = the C type struct (so C-side `Py_TYPE` /
`PyObject_TypeCheck` see the layout they allocated). `Py_TYPE` returns the
live class when it differs from the registered one (Python subclass of a C
type), the registered struct otherwise. Python subclasses of C types get
identity preservation and an instance `__dict__` in the `tp_new` path.

One module gets an extra build step. `_datetime` defines its 7 types as
**static `PyTypeObject` initializers** — positional C89 lists whose meaning
depends on the exact field order of `struct _typeobject`, which wasthon.h
reorders. Compiled raw, every slot lands in the wrong field. So
`src/dtconvert.py` rewrites the 227 positional slots into **C99 designated
initializers** (`.tp_dealloc = ...`) at copy time, keyed on CPython's
canonical slot order. It is a deterministic source-to-source pass, the
output is ordinary diffable C, and the source stays byte-for-byte upstream
CPython in the repo — the same zero-fork rule as every other module. The
runtime half (`_PyDateTime_InitTypes`, singleton registration, the real
packed-struct `datetime.h` for capsule consumers like pandas) rides in
`datetime_exec` via [Wastdlib](https://github.com/fgallaire/wastdlib)'s
`build.sh`.

### Calls

**JS→C**: `__wasthon_make_trampoline` turns a `PyMethodDef` entry into a
Brython-callable closure — it wraps arguments into a malloc'd handle array,
dispatches on the `METH_*` flags (FASTCALL, KEYWORDS, METH_O, VARARGS,
METH_METHOD), calls the C function pointer through the wasm table, and
unwraps the result. Vectorcall-capable objects (Cython's `CyFunctionType`)
are dispatched through their stored vectorcall pointer.

**C→JS**: every C-API function the modules call (`PyObject_GetAttr`,
`PyDict_Next`, `PyNumber_Multiply`, `PyErr_SetString`, ~630 entries) is a
JS implementation in `wasthon.js` calling straight into Brython's runtime
(`$B.$getattr`, `$B.rich_op`, …).

### Errors

C signals failure by returning `NULL` with an exception *set*; Brython
raises exceptions as JS throws. The bridge holds the C-side state in
`WasthonRT.pendingException`: `PyErr_SetString/SetObject/Format` populate
it, `PyErr_Occurred/Fetch/Restore` manage it, and the trampoline re-throws
it as a real Brython exception when the C call returns `NULL`. Conversely a
Brython exception thrown *during* a C→JS call is caught, stored as pending,
and `NULL`/`-1` is returned to C — matching CPython's contract exactly is
what most error-path bugs came down to.

### Data crossing the boundary

- **Bytes/str**: copied. C-produced buffers travel back through
  linear-memory records (under the runtime's `_cstrKey`) drained
  recursively by the trampoline (`syncCstrBytes`) — critical for
  pickle/zlib output.
- **Buffer protocol**: real. Instances of C types own actual data in
  linear memory, so `bf_getbuffer` hands out genuine pointers — this is
  why numpy's ndarrays (and matplotlib's C++ reading their vertices) work
  at native speed. Exporter-owned ("borrowed") views are tracked so
  `PyBuffer_Release` never frees memory the bridge doesn't own.

### Build integration

`wasthon.js` is an Emscripten `--js-library`: it is **inlined into each
module's `.mjs` at link time**. Consequences:

- A bridge change requires **relinking every `.mjs`** (Wastdlib's bundles,
  every NumBry and BryTorch module). `grep` the built `.mjs` for your
  change to verify it took.
- The vendored Brython (`loader/brython/brython.js`) is loaded fresh by
  the page — Brython-level fixes are testable without any relink. Hence
  the two logs: bridge fixes → `CHANGELOG.md`, vendored Brython fixes →
  `BRYTHON_FIX.md`.

`wasthon.c` defines the extern sentinels (`Py_None`, `PyExc_*`,
`PyType_Type`, …); `wasthon_init()` must run once per module instance to
populate them via JS accessors before any ported code executes.

### Two runtimes in one page: addresses are heap-local

A page can load several bridge modules at once — brytorch runs torch and
NumBry's numpy side by side. Each is a separate Emscripten module with its
**own linear memory and its own `_malloc`**; `wasthon.js` is inlined into
each, so a bridge call runs against the *calling* module's heap, and each
runtime registers in `B.$wasthon_rts`. The Brython objects are shared;
linear memory is not, and the heaps can differ wildly in size (torch's
reaches ~1.6 GB, numpy's stays tens of MB). The rule: **an address means
something only in the heap that allocated it, so anything a runtime
records on a shared Brython object is keyed by runtime.**

- A pointer cached on a shared object carries its module: a list indexed
  by torch then by numpy reused torch's `PySequence_Fast_ITEMS` buffer
  inside numpy's heap (`index out of bounds`). Content copies live under
  per-runtime keys (`_cstrKey`, `_cstrSizeKey`, `_bufKey`, `_bufLenKey`):
  `_sha1` read `_md5`'s buffer address in its own heap.
- Class stamps live under the runtime's `_thKey`, minted in `init()`
  because Emscripten folds a library literal at build time — with one
  shared key, numpy's `&PyFloat_Type` overwrote torch's on `float`.
- An instance carries its runtime (`__wasthon_type_rt__`). Another
  runtime's instance crosses `wrap` as an object, never as its address,
  and its `Py_TYPE` is a local struct minted for its class
  (`foreignTypes`): an honest `tp_name`, subtype of nothing registered
  here. The tag is checked only when it positively names another runtime.
- The whole-heap collection marks the one graph but frees each instance in
  its own runtime, and reads its C edges there.

Such mix-ups need an address to be reused or two heaps of different sizes;
a single-heap page never meets them.

### Beyond the stdlib: Cython and pybind11

Two support layers in `cython-support/` extend the surface to binding
generators, in increasing order of layout hostility:

- **Cython** (numpy.random, pandas, scipy) — mostly handle-friendly;
  needs compat headers, spec-based type creation
  (`-DCYTHON_USE_TYPE_SPECS=1`) and two generic post-cythonize patches.
  See `cython-support/README.md`.
- **pybind11** (matplotlib, kiwisolver, torch) — aggressively
  struct-layout-dependent: it casts handles to `PyCFunctionObject*` /
  `PyHeapTypeObject*` and reads fields by offset. The bridge answers by
  making those specific objects *real*: `PyCFunction_NewEx` returns an
  actual 24-byte C struct whose address is the handle (trampoline bound on
  top), and `PyType_Type.tp_alloc` hands out raw `PyHeapTypeObject` memory
  that `PyType_Ready` consumes. See `cython-support/pybind11_compat.h` and
  NumBry's `docs/MATPLOTLIB.md`.

## Repo layout

- **`src/`** — the C-API bridge.
  - `wasthon.h` (~2400 lines) — type defs, macros, function prototypes.
    Mostly a mirror of CPython's public C-API surface; the load-bearing
    parts are struct layouts (`PyTypeObject` offsets), macro values that
    must match `Include/typeslots.h` exactly (`Py_nb_multiply=29`, etc.),
    and the selection of which API to expose at all.
  - `wasthon.c` (~1100 lines) — `extern` definitions, `wasthon_init()`
    which populates them at boot, plus a few small C helpers.
  - `wasthon.js` (~19 000 lines) — Emscripten js-library: ~630 entry points
    covering handle management, object protocol, type-spec creation,
    buffer protocol, arg parsing, Unicode, dict/list/tuple, IEEE 754,
    sequence protocol, METH_METHOD trampoline, getset descriptors, slot
    dispatch shapes (b/t/r/i/n/c/si/sis), `Py_BuildValue`/
    `PyUnicode_FromFormat` real variadic impls. Where the actual logic
    lives — most C-side functions in `wasthon.h` are declarations whose
    implementation is here.
  - Plus `Python.h`, `pyconfig.h`, `pymacro.h`, `hashlib.h`, `pyexpat.h`,
    `complexobject.h`, and ~35 `pycore_*.h` stubs that mostly redirect
    `#include "pycore_X.h"` to `wasthon.h` so unmodified CPython source
    files compile. The notable exception is `pycore_blocks_output_buffer.h`
    (321 lines), copied verbatim from CPython — used by compression modules.
- **`cython-support/`** — the Cython and pybind11 layer on top of the
  bridge, shared by NumBry and BryTorch.
- **`loader/`** — the Brython side: `wasthon-loader.js` instantiates a
  module and registers it under `__BRYTHON__.imported`; `wasthon-fs*.js`,
  `wasthon-io-write.js`, `wasthon-dealloc.js` and `wasthon-dbm.js` back the
  filesystem, I/O and lifetime hooks; `brython-src.js` loads the **vendored,
  patched Brython in `loader/brython/`** (stock release plus the fixes
  tracked in `BRYTHON_FIX.md`, pending upstream); `test-bridge.html` runs
  the unit tests in the browser.
- **`tests/`** — the bridge's unit tests (see "Tests").

## Hard rules (so the bridge stays small)

The C-API bridge only grows when a target module forces it. Four rules
prevent it from becoming "CPython in JS" (which would defeat the point —
that's Pyodide):

1. **Implement only what targeted modules actually call.** Grow on demand.
2. **No Python runtime.** Brython is the runtime: `PyImport_*` goes through
   Brython's import, `PyEval_*` is `PyEval_GetBuiltins` and the GIL stubs,
   no `PyCode_*`, no exception machinery beyond a single pending-exception
   flag.
3. **`PyObject*` is opaque** for most code. C inspects layout only where
   CPython code reads it directly: `PyTypeObject` (the slots C touches at
   fixed offsets, `tp_dealloc` at 40, the rest in CPython's order,
   `ob_type` at the tail, offset 176), and `PyObject_VAR_HEAD`, which
   declares `Py_ssize_t ob_size` at offset 4 (after `ob_refcnt`) for
   variable-size objects (array, bytes-like).
4. **Two handle kinds**: sentinel-range small integers for ordinary Brython
   objects; real WASM pointers for C-allocated instances. The handle IS the
   pointer so `self->field` dereferences hit the right linear memory.

Everything Python-semantic is Brython's job — the bridge's job is to be a
faithful, lying-through-its-teeth `Python.h`.

The bridge today covers ~510 distinct C-API entry points. That's enough for
CPython's C standard-library modules, NumPy, SciPy, pandas and PyTorch,
all major type-creation patterns (factory functions,
tp_new-only, tp_new+tp_init, multi-phase exec slot), buffer protocol,
Unicode (PEP 393 strict, kind-aware), dict/list/tuple, IEEE 754, slot
dispatch including sequence and number protocols, getset descriptors
(static and dynamic via `PyDescr_NewGetSet`), METH_METHOD bound methods,
`Py_BuildValue` varargs, real `PyUnicode_FromFormat` (printf-style with
`%s`/`%d`/`%zd`/`%c`/`%p`/`%R`/`%S`/`%U`/`%x`/flags/width/precision —
fixes broken `repr()` on every stateful instance type),
full `PyUnicodeWriter` API (3.14), proper
`tp_setattro`/`tp_getattro` wiring, weak GIL stubs.

**⚠ Platform-width divergence — Brython says 64-bit, the C layer says
32-bit, by design.** Brython emulates a 64-bit CPython: `sys.hash_info.width`
is 64, `float.__hash__` is the 61-bit `_Py_HashDouble`, and
`str.__sizeof__`/`sys.getsizeof('abc')` report 64-bit sizes (44, what a
desktop CPython says). The wasthon C layer is genuinely wasm32 and reports
its own truth: `struct.calcsize('P')` is 4, and a C instance's `__sizeof__`
is in CPython-32-bit canonical units (`sys.getsizeof(array.array('i'))` is
32 — the number a CPython-in-wasm like Pyodide gives). Each layer is
self-consistent and its tests measure through its own ruler (test_array's
`check_sizeof` computes expectations with *our* `struct`, 32-bit; the hash
tests go through Brython, 64-bit) — but code comparing sizes *across* the
two layers must expect the seam.

**⚠ Out-of-bounds heap reads yield `undefined`, not garbage — bound every
`HEAPU8` loop by the allocation, never by a caller-supplied size.** A JS
typed array read past its end returns `undefined`, which then flows into
Brython as an `UndefinedType` object and detonates far from the cause
(`'UndefinedType' object cannot be interpreted as an integer`). Worse, it
only detonates *under heap pressure*: while memory happens to exist past
the block the same overrun reads junk-but-defined bytes and works, so the
bug looks like inter-test poisoning — green in every standalone probe,
failing deterministically in suite context (this was pickle's long-hunted
`optional_frames` "poison": `_PyBytes_Resize` read the *new* size from
the *old* block). Any `HEAPU8[ptr + i]` loop must clamp to
the tracked allocation size (e.g. the runtime's `_cstrSizeKey`) — a size the C
side asks for is a request, not a promise about the block under `ptr`.

**⚠ Recursion is three nested stacks, and the wasm one must never win.**
A Python-level recursion is a JS recursion (Brython compiles Python to
JS): Brython's own counter — driven by `sys.setrecursionlimit`, with the
engine's `InternalError: too much recursion` converted as a backstop —
raises `RecursionError` there. A C-level recursion (`_json`'s
scanner/encoder, `_pickle`'s save/load, expat's content model) runs on
the **wasm stack**, a fixed reservation chosen at link time (`-sSTACK_SIZE`,
4 MB in Wastdlib) whose overflow is an *uncatchable trap* that kills the
page — so `Py_EnterRecursiveCall` routes to a bridge depth counter (cap
4000 ≈ CPython's `Py_C_RECURSION_LIMIT`, a ×5 margin under 4 MB) that
raises CPython's exact `RecursionError` first, call-site suffix included.
The C cap is fixed and deliberately *not* tied to `sys.setrecursionlimit`
— that is CPython 3.12+'s own design (the C recursion limit is decoupled
from the Python one). Cross-boundary recursion (a C encoder calling a
Python `default` hook per level) burns both counters and whichever fires
first raises. One fidelity inversion worth knowing: CPython's *own*
emscripten builds skip the deep-recursion tests (their stack-probing
guard has no headroom in wasm); wasthon runs them and passes — a 500k-deep
JSON nesting raises `RecursionError` instead of trapping.

## Tests

```bash
source /path/to/emsdk/emsdk_env.sh   # emcc 5.0.7, and node
tests/run.sh
```

builds `tests/_bridgetest.c` — a test module compiled against `src/`
alone — and runs the test files in Node: `tests/lifetime.py` proves
`tp_dealloc` and handle scopes A/B (each mechanism switched on keeps its
table flat, switched off leaks what it is there to reclaim). They depend on
nothing else; the repositories built on the bridge test the rest. The same
file runs in the browser on the Pages: `loader/test-bridge.html`.

## What's next

- [x] Bridge fixes since the polish pass — moved to `CHANGELOG.md` to
      keep this list focused on what's *in* the bridge rather than
      what was *fixed in* it. Recent highlights: `tp_init` kwarg
      threading, `$kw` `**d` expansion, `array.array` cluster, `'w*'`
      writable-buffer format, `bool` coercion + `callable()` on C-call
      types. Older entries (`PyUnicode_FromFormat`, writable-bytes
      refactor, slot-ID collision, `unicodedata.numeric`/`.digit`/
      `.decimal`) are there too.
- [x] Bridge surface: METH_METHOD trampoline, getset
      descriptors, sequence protocol slots, dict-style kwargs in
      `_PyArg_UnpackKeywords`, struct-aware `Py_SIZE`/`Py_SET_SIZE`,
      numeric format dispatch in `PyArg_Parse` (was a no-op stub for
      months — exposed by array.array), `Py_BuildValue` real impl with
      varargs format dispatch (was a SystemError stub — exposed by
      pyexpat), dynamic getset descriptor creation via `PyDescr_NewGetSet`,
      `tp_setattro`/`tp_getattro` wired on all builtin classes (was a
      latent gap — "setattr is not a function" once any module installed
      property descriptors), 4-byte memory corruption on the type struct
      fixed (was 44-byte struct allocated 40 since the beginning), full
      `PyUnicodeWriter` API (new in CPython 3.14, 9 entry points),
      `PyUnicode_KIND` / `PyUnicode_DATA` made PEP-393-strict so input
      and output buffers agree on stride — was returning kind=4 with
      UCS4-strided data unconditionally, broke any module that built
      output strings with smaller kind than input (exposed by _json's
      encode_basestring on ASCII strings, where input kind=4 was read
      with output kind=1 stride and produced zero-byte garbage between
      chars).

Infrastructure work that pays back on existing modules:

- [x] `tp_dealloc` dispatch + reference counting — C-allocated instances are
      reclaimed when their refcount reaches zero. Refcount kept JS-side in a
      `Map<ptr,int>` (discrimination by Map membership, not value range); ABI
      aligned so `ob_refcnt` sits at offset 0; `Py_INCREF`/`DECREF` route
      through `wasthon_incref`/`decref`; on zero the bridge dispatches the
      type's `tp_dealloc` → `tp_free` → `PyObject_GC_Del`. Backed by a C-API
      refcount-convention audit (no-steal INCREF / steal / new-ref) that
      kept the CPython harness at 1750/4485 at the time, zero regression.
      Proven by `tests/lifetime.py` (`refcounts.size` flat with dispatch on,
      +1/call with it off). Full design in `CHANGELOG.md`.
      Exact state of the dispatch chain (2026-07-16): a C subclass dealloc
      that *delegates up to a builtin* (numpy's `unicode_arrtype_dealloc`
      ends with `PyUnicode_Type.tp_dealloc(v)`) now lands on a real slot —
      `wasthon_bind_builtin_type` wires `tp_dealloc`@40 on every builtin
      struct to `PyObject_GC_Del` (unbind handle + free struct), the base
      behaviour in the bridge model. Before that the NULL slot trapped
      *silently* (the dispatcher's defensive catch ate the "indirect call to
      null") and the gc_new struct of every reclaimed `np.str_` scalar
      leaked — measured: 3 swallowed traps on a single
      `chararray.upper()/rstrip()`, 0 after wiring, handle count flat over
      3000 scalar round-trips. Note the dispatcher's defensive catch is
      load-bearing for robustness but *hides* exactly this class of bug: if
      a dealloc chain regresses, the symptom is a slow leak, not a crash —
      re-check with a gated counter in that catch before trusting it.
      Lifetime of an `np.str_` scalar box specifically: the C struct is a
      plain gc_new allocation (`PyUnicodeScalarObject`, ~24 B, obval left
      NULL); the string payload lives only as the JS `$brython_value`
      primitive; the struct is freed by this dispatch when C code drops its
      last reference (`_vec_string` per-element temporaries) or when the JS
      wrapper is collected (reclaimResults path).
- [x] Deterministic free of heavy native resources at `close()`/`with`-exit —
      Brython is tracing-GC with no refcount, so a dropped LZMA/Zstd compressor
      (its context is ~94 MB) has no deterministic finalizer and would leak to
      OOM. The C free itself works (`decref` → `tp_dealloc` →
      `lzma_end`/`ZSTD_free` → memory reused); the only missing piece was a
      deterministic trigger. The model is an explicit `close()`/`with` contract
      (as in Pyodide), not an automatic finalizer — within a synchronous run
      nothing yields, so no auto-GC callback can fire (a page that *does* yield
      between units of work gets the automatic path too; see "Wrapper-owned
      result reclamation" below). For a heavy native this stays the right
      model regardless: `close()` frees a 94 MB context *deterministically*,
      where a finalizer only frees it whenever the GC gets around to it.
      `loader/wasthon-dealloc.js` wraps the synchronous `$B.$import` to patch
      `lzma.LZMAFile`/`bz2.BZ2File`/`compression.zstd.ZstdFile` `.close()` so a
      `with` block decref's the compressor it drops and reclaims the context at
      block exit. +8 (`test_lzma` +7, `test_zstd` +1). A second deterministic
      trigger covers the *one-shot* module helpers (`lzma.compress(data)` /
      `decompress`, and the bz2/zstd equivalents): these build a bare
      `LZMACompressor`/`LZMADecompressor` with **no** `close()`, so the ~94 MB
      encoder leaked on every call — the tests call `compress()` once per
      round-trip comparison, so the heap OOM'd mid-suite and the next compressor
      allocation returned NULL silently into `LZMAFile._compressor`, surfacing
      as a `Symbol("DICT") of null` cascade. The shim runs the real helper (it
      owns the format/preset/filters logic and the decompress retry loop) and
      then decref's every instance of the compressor/decompressor *type* it
      created and left behind — capture-by-type, so the returned bytes are
      untouched. This confirmed the dispatch mechanism was never the issue
      (an explicit free survives 60 iterations that otherwise OOM at ~22); only
      the trigger was missing. +16 (`test_lzma` 96 → 112). Details in
      `CHANGELOG.md`.
- [x] Buffer-export safety, without a GC — `memoryview(a)` must make array
      mutations raise `BufferError` while the view lives (and succeed once it's
      released). No finalizer needed: the bridge syncs the export count Brython
      already maintains (`obj.exports`, `++` on create / `--` on
      `release`/`__exit__`) into the C struct's `ob_exports`, which array's
      resize ops check. Same "connect two already-correct halves" move as the
      `close()`/`with` contract above — Brython's bookkeeping + CPython's C
      check, no tracing GC. +28 (`test_array` `test_buffer` + `test_clear`).
      Details in `CHANGELOG.md`.
- [x] Partial `gc.collect()` finalization, an *explicit* trigger (not an
      auto-GC) — a sqlite3 cursor `del`'d while holding a pending statement
      keeps its table lock, and an unclosed `Connection` owes a
      `ResourceWarning`; in CPython both fire at the object's refcount-0, which
      Brython (tracing-GC, no prompt finalization) never reaches. The bridge
      implements `$B.$wasthon_gc_collect()` (wired to `support.gc_collect` /
      `gc.collect()`): a synchronous mark-sweep that MARKs the C instances
      reachable from the live Brython frames — locals + globals, recursing into
      containers and the **Symbol-keyed instance `__dict__`** (`self.cur` lives
      at `self[$B.DICT].cur`, invisible to `getOwnPropertyNames`), tracking the
      **max visit-depth per object** so one first reached shallow via the huge
      globals graph is re-walked deep from a frame local — then fires
      `tp_dealloc` on every gc-finalizable instance no longer reachable
      (`cursor_dealloc` → `stmt_reset` releases the lock; `connection_dealloc` →
      `tp_finalize` → `ResourceWarning`). This is the explicit `gc.collect()`
      contract, distinct from the automatic `FinalizationRegistry` path below:
      that one needs job boundaries (a synchronous run never yields for a
      finalizer callback) and only frees what the JS GC has *proven* dead,
      whereas this sweep must fire on demand, mid-job, from a heuristic mark —
      which is why it is clear-only for the conservative cases and gated to an
      opt-in set of
      resource-holding types (`$wasthon_gc_finalizable`: sqlite3's
      Connection/Cursor/Blob/Backup, and `_pickle`'s Pickler/Unpickler — their
      memo takes a ref per object pickled, released only at `tp_dealloc`, so a
      Brython-held pickler that never died pinned ~5 handles per object
      dumped) registered at `bindInstance` into a
      `gcRegistry`, so an empty registry returns instantly (zero cost to every
      other suite) and the mark skips the bridge's own strong-ref bookkeeping
      (`handles`/`gcRegistry`/`refcounts`, which pin every instance) and module
      graphs. `PyObject_CallFinalizerFromDealloc` now invokes `tp_finalize`
      (stashed on the class, past the 64-byte type struct) and a real
      `PyErr_ResourceWarning`/`PyExc_ResourceWarning` emit the warning. The
      same sweep also clears weak cells: `weakref.proxy`/`ref` on a C instance
      raise `ReferenceError` / return `None` once the referent is unreachable
      (or refcount-dead) — clear-only, never freeing on that path, and the
      mark skips the cells themselves so a live proxy cannot pin its referent.
      +3
      (`test_sqlite3` `test_table_lock_cursor_dealloc` /
      `test_table_lock_cursor_non_readonly_select` /
      `test_connection_resource_warning`). Details in `CHANGELOG.md`.
- [x] `del name` means CPython's `del`, and `gc.collect()` finally reaches the
      sweep above. Two gaps sat under the whole "GC that isn't one" chapter.
      First, Brython's `del name` called `__del__` **unconditionally** and
      *before* unbinding, so an object a container still held was finalized on
      the spot — measured in the port: `x.arf = t; del t` fired `t.__del__`
      where CPython stays silent. Second, Brython's `gc` module is a stub
      (`def collect(*a, **k): pass`), so the explicit sweep documented here was
      only ever reached through the `support.gc_collect` shim of the CPython
      test page (`test-cpython.html`, now in Wastdlib); a suite calling plain
      `gc.collect()` got a no-op.
      The bridge now answers `del` from **reachability out of the live Python
      frames** (`$wasthon_should_finalize`, two hook points in
      `$B.$delete` — the pattern `Lib/_weakref.py` already uses for
      `$wasthon_weakref_track`): still held → the object joins `pendingDel`,
      held strongly exactly as a refcount would hold it; unreachable → `__del__`
      runs now. `$wasthon_drain_pending` fires the deferred ones once they
      become unreachable (the cycle-collector half, called by `gc.collect()`),
      and `$wasthon_after_unbind` cascades when the deleted object *itself*
      just died — unreachable **and acyclic**, which is precisely how CPython
      separates "freed at once" from "left to the collector". A C instance's
      weak cells are cleared on its `del` when the bridge alone still holds it
      (refcount 1): `weakref.ref()` reads None and its callback fires,
      refcount-0 behaviour obtained **clear-only, without freeing a byte** —
      the bytes remain the bulk reclaim's job, and freeing here would re-open
      the failure mode that pass already measured.
      Why this is sound where the bulk reclaim is not: the question is not
      "which of 406 039 candidates are dead" but "is THIS one still held", on
      an **observed** event (the user wrote `del x`) rather than an inferred
      one. One object per answer buys iterative deepening (2, then 4, then 7)
      and an early exit at the first referrer — affordable here, ruinous there.
      And the predicate is one-sided by construction: *found* always defers, a
      miss only reproduces the old eager behaviour, so the `del` path can only
      become more conservative than it was.
      **+9 test_torch** (the `Tracker`/dealloc family: tensor and storage
      `dict_dealloc`, `slot_dealloc`, `weakref_dealloc`,
      `fix_weakref_no_leak`, `storage_dealloc`), and `gc.collect()` itself went
      **84 s → 0.0 s** once both walks stopped stepping into the DOM `window`
      that `from browser import window` leaves in the frame globals.
- [x] The walk can read the **C++ side**, and the root set became the instances
      it can actually reach. Until then this chapter ended on a limit: the rest
      of the family (`cycle_via_*`, `dead_weak_ref`, resurrection/zombie) hung
      on edges the Brython side cannot see — `z.grad = x` is an **accessor**
      into autograd metadata, not a stored property, and torch's own test says
      so out loud (*"C++ reference should keep the cycle live!"*).
      Three things had to give way, and each was a silent no-op rather than a
      hard problem. `Py_VISIT` was defined as `((void)(op))` — with a comment
      saying so — so every `tp_traverse` body in every C module compiled and
      reported nothing. A Python subclass of a C type gets a struct minted here
      with no traverse slot, where CPython inherits one, so `rt.cTraverse` walks
      `tp_base` until a type states its edges, exactly as `subtype_traverse`
      does. And torch's traverse deliberately **skips** `grad` (there is a NOTE
      about it) because CPython gets that liveness from the refcount, not from
      the collector — so tp_traverse alone could never answer the case the suite
      tests; the edge is read from the C++ state through an optional embedder
      helper, guarded like the census lookups next to it.
      Seeing the edges is only half of it, and on its own it measured **zero**:
      it made the deferred objects survive collection, then never let them die.
      The reason is the root set. The bilateral half took every instance in
      `rt.handles` — a map that holds each wrapper for its whole life, so an
      object whose last name was gone stayed a root forever. That blanket only
      ever existed **because the walk was blind to C++ edges**; with them
      visible, `_liveCRoots()` marks forward from the live frames, through the
      Brython graph and the C++ edges, and returns what it actually reaches —
      once per drain, where the old code paid a full walk per deferred object.
      Two refcount behaviours fall out of it: the `del` cascade no longer
      carries into a **cycle** (a refcount drops when the holder dies, but a
      cycle keeps it above zero and CPython defers to the collector), and `del`
      itself defers an unreachable-but-**cyclic** object instead of finalizing
      it on the spot. **+3 test_torch.**
      A third silent no-op of the same family sat one level down: reading the
      edges had been wired into the *root-set* paths only. The walks that answer
      the question itself — `_reach`'s forward scan out of the frames, and
      `_inCycle` — still looked at `$B.DICT` and own properties alone, and the
      two entry points that decide `del` call them with no root set, so a
      reference held by C++ was invisible to the predicate that mattered
      (`x._backward_hooks = y` goes through a torch setter, not into `__dict__`,
      and `del x` finalized x's tracker while `y` still pointed at it). Both
      walks now follow `cTraverse` on any value carrying an **own**
      `__wasthon_ptr__` — own-property, since a plain read resolves through the
      class and would fire the wasm call for everything walked. **+1 test_torch**
      at unchanged wall time.
      With the walks reading C++ edges, the family's biggest cluster turned out
      to hang on **one more edge**: a tensor's storage. `a.untyped_storage()` is
      an accessor and the wrapper it returns lives in the `StorageImpl`'s
      `pyobj_slot`, not in `a`'s `__dict__` and not in `tp_traverse` either — so
      putting a tracker on a storage and dropping its only Python name read as
      death while the tensor was still alive and about to hand the same object
      back. Worth recording: resurrection semantics were never the missing
      piece. C++ identity through `pyobj_slot` already worked (`del s` then
      `a.untyped_storage()` returns *that* object, `_tracker` intact); only the
      edge was absent. **+5 test_torch**, again at unchanged wall time.
      Last of the family, weak cells learned to die with their **holder**. They
      were cleared only for the object whose own name was deleted, and only when
      the bridge held it alone (`refcount === 1`) — another proxy from the blind
      days, dropped in favour of the reachability answer. And an object still
      held when its name went was left alone, correctly, but nothing ever came
      back to it: the `del` that ends its life is its holder's. Those park in
      `pendingWeak`, the shape of `pendingDel`, drained by the same cascade.
      **+2 test_torch**, this one at a real price — **13% suite wall time**,
      because the gate is no longer a cheap refcount test.
      One asymmetry to keep in mind on that path: for `pendingDel` a missed
      referrer only *defers*, which is safe; for a weak cell it *clears*, so a
      walk that gives up early would kill a live object's cell. The walk is the
      same one `gc.collect()`'s sweep already uses, and it now reads both sides
      — but it is bounded (depth 7, 60 000 nodes), and that is where the
      remaining risk sits.
      Finally, the cascade fires **after `__del__`** as well, not only for
      objects that have none: one with its own finalizer used to be finalized
      and then simply dropped, so `s._tracker = t; del s` ran `s.__del__` and
      left `t` alive forever. CPython does both, in that order. **+1
      test_torch**, and the suite got *faster* (373.7 s → 345.2 s) because the
      pending sets now empty sooner. Vendored side in `BRYTHON_FIX.md`.
      The family is down to **two** failures, and both are the same one:
      **releasing**. Nothing else in it is unexplained.
      One prerequisite for that step is in place: `decref` reads `tp_dealloc`
      through the **base chain**. It used to read the slot straight off the
      instance's own type, and a Python class over a C type gets a struct minted
      here with no slots of its own where CPython inherits them — so for every
      instance of that shape the count reached zero and **no destructor ran at
      all**, silently, port-wide. Measured alone (that was the point: it wakes
      destructors that had never run) it changes no result on any dashboard, but
      nothing can be freed while the dispatcher cannot find the destructor.
      **The limit, stated plainly:** what remains is no longer about *seeing* or
      *deciding* but about *releasing*. Nothing drops the C++ reference itself —
      a temporary view still pins its base (`_use_count` climbs 2 → 3 → 4 and
      neither `del` nor `gc.collect()` brings it back), which is why
      `test_swap_basic` fails and why `gc.get_objects()` has no honest answer to
      give: the objects really are still there. Releasing needs a *trigger* more
      than a mechanism, and `del` is not it: a temporary that dies with its
      Brython frame has no `del` to hang on, `refcount === 1` is not proof of
      death (a Brython assignment does not increment), and a reachability walk
      per function return would be ruinous. That is the wrapper-refcount option,
      a different order of work.
      None of this touches the reclaim-scale question — deciding among hundreds
      of thousands of candidates at once is a different problem, answered since
      by the whole-heap collection below.
- [x] `del` and `gc.collect()` **release**, and only on proof. The limit above
      had two halves, and the first was not about triggers at all: a C function
      returning an object Python already holds left one count behind (see the
      entry on instances handed back to Python), so a temporary view sat at
      refcount 2 and no path could ever find it sole-owned. With that fixed,
      `del` is enough of a trigger for the family — what it lacked was a sound
      verdict. The walks above are bounded and walled (modules, classes, depth
      7): they are fit to say *held*, never *dead*. Used as a death verdict,
      each wall is a use-after-free, and the audit probes built eight of them —
      a class attribute, another module's global, a default argument, a bound
      method, a closure, nine levels of nesting, a dict with a non-str key
      (Brython then keeps **all** entries in Symbol-keyed arrays no property
      walk sees) and a resurrecting `__del__`.
      So the chapter now has two tiers over **one** definition of the graph
      (`_edges`: own data properties, Symbol-keyed ones, a function's
      `__dict__`, defaults and defining frame — which is where a closure's free
      variables live, visible after all — and the C++ side through
      `cTraverse`). The quick walk runs on every `del`, so it stays as lean as
      the old one: from the frames' locals and globals, depth 2, 4 then 7, into
      no function beyond a bound C method's self, no non-str dict's entry
      arrays, no big array's index list (enumerating those allocated a string
      per byte of `test_bz2`'s payloads: 24 s → 113 s until it stopped). It
      decides a finalizer on the spot, as before: a wrong "dead" there can only
      run a `__del__` early, which is what Brython does on every `del`, and a
      mark per `del` cost `test_bz2`'s 10 000-iteration `BZ2File` loop
      24 s → 961 s. Nothing is **freed** until **the mark** — a complete
      traversal from every live frame and every imported module, no walls, no
      depth bound — proves it unreachable, and a mark that cannot finish proves
      nothing; the mark also decides the pending objects a death or
      `gc.collect()` settles. It is paid only when something is about to die (56
      marks across `test_torch`, 44 s in all at a million objects), one
      mark decides a whole batch, and a pending object found alive backs off (1,
      2, 4 … 1024 settles) so one held out of the quick walk's sight cannot cost
      a mark per `del`. The cascade keeps CPython's split: what a dying object held
      dies with it, unless a reference cycle is within reach of that data — the
      cycle's count stays above zero until the collector runs, and whatever
      hangs from it waits too.
      One hole no walk can close remains: a value an enclosing frame is still
      evaluating (`[g, f()]` while `f` deletes `g`) lives in a compiled-JS
      local. Such a miss no longer corrupts memory: `_release` retypes the
      wrapper to `released`, whose every attribute read raises
      `ReferenceError`, and repoints it at a tombstone block, so the worst case
      is an exception to read. `released.touched` counts those reads — **0**
      across the lifetime family and `test_torch`.
      And one hazard the old path carried unseen: a page can load two wasm
      runtimes under one Brython (brytorch loads numpy next to torch), and these
      hooks are installed once, bound to the first. An instance of the other
      runtime carries a pointer into another heap, which can name an unrelated
      object of ours; only instances whose `__wasthon_type_rt__` is ours are
      ever released or have their cells cleared.
      `gc.get_objects()` answers with the C instances the bridge still holds.
      Measured: `test_torch` **912/912** (was 910), the eight probe cases now
      behave as CPython, and the chapter is shorter than the one it replaces.
- [x] A **whole-heap collection**, every runtime's (`$wasthon_reclaim`). `del`
      frees what was just unbound; what a program simply stops using — a name
      rebound in a loop, a temporary of a finished call — was never freed, so a
      suite piled up its garbage until the 2 GB cap. The collection marks the one
      Brython graph once and frees, each in its own heap (a page can run torch
      and numpy side by side: every runtime registers in `B.$wasthon_rts`), each
      instance only its wrapper owns: refcount exactly 1, **and** that reference
      handed to the wrapper when the instance first reached Python
      (`$wasthon_py`) — before that, it is C's. Everything else the handle
      tables bind is held by C and is a root, like the classes and modules the
      bridge keeps: that root set is what July's attempt lacked (numpy's
      `_ArrayMethod` objects, held through a ufunc's `_loops` list, looked dead).
      A dead object can keep another at refcount 2 — a tensor's `grad_fn` saves
      its input, which torch then preserves — so it passes again while a pass
      changed a root (an instance dropping to refcount 1, a binding a dealloc
      released): on two 1.7 GB tests the first pass gave back 172 MB, the second
      1.6 GB, and a third, which could only find the same live set, is skipped.
      It is sound only where no expression is half evaluated — between two tests
      — since a temporary lives in a compiled-JS local. The marks also read each
      instance's C edges through its own runtime (`cTraverse`), where they read
      only the first runtime's. Measured in brytorch, collecting between two
      tests: the two 1.7 GB `test_sum_noncontig_lowp` tests pass in one frame
      (1774 → 41 MB after each), `test_torch` peaks at 669 MB, `test_masked`
      goes 0 → **154** once its heap is no longer full and
      `test_scatter_gather_ops` +7; `released.touched` 0 throughout.
- [x] **Two bridge runtimes in one page.** brytorch loads torch and numpy as
      two wasms under one Brython: one object graph, two heaps, two handle
      tables. The rule: **an address means something only in the heap that
      allocated it, and any identity recorded on a shared Brython object must
      be keyed by runtime.** Four places apply it:
      - a foreign instance's type is a local struct (`foreignTypes`), never the
        sibling's type address (`Py_TYPE` of a numpy array in torch trapped);
      - a foreign instance crosses `wrap` as an object, never by its
        `__wasthon_ptr__`: torch read a numpy array's address as the leftover
        tensor living there in its own heap, and `t + a` gave `1 + 24`;
      - each runtime stamps classes under its own `_thKey`, minted in `init()`
        because Emscripten folds the library literal at build time — with one
        shared key, numpy's `&PyFloat_Type` overwrote torch's on `float` and
        `dtype=float` stopped matching;
      - the collection marks the one graph but frees each instance in its own
        runtime, and reads its C edges there.
      Such mix-ups need an address to be reused or an order to change, so a
      page whose heap only grows rarely meets them: they surfaced once the
      collection gave memory back and a long single frame chained the suites.
- [x] Container-boundary reference discipline + scope-owned `GET_ITEM` buffers
      — the three memory roots behind pickle's "delayed-writer page poison"
      (a 10k-object framed dump left ~300k pinned handles and a 1.6 GB heap,
      failing everything behind it), each a general bridge rule, all measured
      flat after the fix (a 10k-object dump+loads cycle now runs at the 16 MB
      boot baseline). (1) `PyDict_SetItem`/`PyObject_SetItem` no longer take
      CPython's "container ref" for plain Brython/JS values — the Brython
      container stores the JS value and never deallocs, so that ref was
      unreleasable; only struct-backed instances (`__wasthon_ptr__`) keep it,
      the instance-exempt rule `consumeResultRef` already used for steal APIs.
      (2) `_pickle.Pickler`/`Unpickler` joined the gc-finalizable set above.
      (3) `PyList_GET_ITEM` materialisations are cached per array and their
      buffers are owned by the handle scope of the C call that made them,
      freed at scope close like sentinels — the single-slot cache thrashed
      between `batch_list`'s outer list and each item's containers, O(n²)
      bytes. Also halved the pickle suite's wall time (449 s → 255 s).
      Details in `CHANGELOG.md`.
- [x] Wrapper-owned result reclamation — the *automatic* finalizer, which the
      entries above call impossible. They are right about a **synchronous run**
      and wrong about a **yielding one**, and that distinction is the whole
      design.

      The seam: CPython is refcounted, Brython is tracing-GC with **no
      refcount at all**. Every C-call result crosses that seam — the bridge
      allocates the instance at refcount 1 and hands the Brython wrapper back
      with ownership of that one reference (`consumeResultRef` exempts
      instances by design). CPython's eval loop would `POP_TOP` a discarded
      expression statement to zero; Brython simply drops the wrapper and
      **nothing crosses back**. There is no site to fix: the bridge cannot
      observe the drop, so the struct plus its `handles`/`refcounts` entries
      were pinned for the life of the job. One leaked instance per ufunc call.

      Correct, and asymptotically fatal: per-call cost grows with the live-set
      (the JS GC keeps tracing the pinned wrappers, and the never-freed structs
      fragment the wasm heap), measured **72 µs flat vs 287 µs after 60k
      leaked calls**. Nobody hit the knee until a suite ran ~10⁵–10⁶ ops inside
      one job (scipy's `test_cython_special`), where the tail slowed until the
      browser killed the script.

      Two mechanisms are *provably* unavailable. A synchronous mark-sweep from
      the live frames (the `gc.collect()` machinery above) is **racy** for
      transients: while Brython evaluates `abs(a-b) <= atol + rtol*abs(b)`, the
      `abs(a-b)` result is alive, refcount 1, and reachable from **neither** a
      frame local nor the entering call's arguments — a sweep would free it
      under the running expression. And refcount-1 does not mean dead, because
      Brython's `x = arr` never increfs. `WeakRef` polling is worse: the spec's
      *keptObjects* list pins every target of a `new WeakRef` / `.deref()`
      until the end of the job, so inside one synchronous run **nothing is ever
      collectible** (verified: 300k WeakRefs plus 1 GB of churn → zero
      collected). The first attempt demoted the `handles` entries to WeakRefs
      and was strictly dominated — same live-set, plus a deref on the hottest
      path in the bridge.

      What survives is the JS GC itself, which is the *only* oracle that can
      see a Brython drop — and it runs **between jobs**. So: at the outermost
      scope pop, an instance still at refcount 1 (C kept no reference) is
      **unbound** from `handles` and its wrapper registered in a
      `FinalizationRegistry` holding `{ptr, typeH}`. Nothing weak sits on the
      hot path: Python passing the wrapper back into C re-binds it through
      `wrap()` (the wrapper carries its own `__wasthon_ptr__`), and the
      dispatcher fast paths that read that pointer *without* calling `wrap()`
      recover through `unwrap()`'s miss path — a `demoted` `Map<ptr, WeakRef>`
      side table consulted only on a miss, so its keptObjects pinning lasts at
      most until the next boundary, which is exactly when collection could
      happen anyway. A mid-call `Py_INCREF` (refcount ≥ 2 — C taking durable
      ownership) simply prevents the demotion at pop; `PyObject_GC_Del`
      unregisters, or a late callback on a malloc-reused pointer would
      double-free. When the GC proves the wrapper dead the callback runs the
      type's `tp_dealloc` against a tombstone binding and frees the struct —
      a dead wrapper is *proof* of unreachability, which is what makes this
      sound where the mark-sweep heuristic is not.

      The other half of the contract is the driver: reclamation needs job
      boundaries, so a page must yield between units of work (`MessageChannel`,
      not `setTimeout` — nested timeouts clamp to 4 ms). This is why the
      feature is **opt-in** (`rt.reclaimResults`, default `false` = bit-for-bit
      the old behaviour). Unconditional reclamation breaks `import numpy`
      instantly: module-init code pervasively stores fresh refcount-1 instances
      C-side as borrowed references (statics, caches), and the whole ecosystem
      quietly *depends* on the leak for its correctness during init. The flag is
      flipped once imports have settled, when the steady-state per-call flood is
      the only thing worth reclaiming. With a per-case async runner the handle
      table stays flat and per-call cost stays at its ~72 µs floor:
      `test_cython_special` 167/54 → **221 passed / 0 failed** (was killed by
      the watchdog). Details in `CHANGELOG.md`.

      **2026-07-19 amendment — the oracle is real but mute.** Measured under
      Firefox (brytorch, 8 official pytorch suites in one page): the
      `FinalizationRegistry` callbacks simply never ran — not for demoted
      wrappers, not even for a sacrificial witness object dropped on the spot,
      through allocation pressure and multi-second idles. The proof-based path
      stays sound but fires at the engine's discretion, which can be *never*
      within a session; `demoted` then grows without bound (~100-400 MB of
      native tensors per suite, the 2 GB wasm ceiling by suite 8). The
      complement is `$B.$wasthon_reclaim_demoted()`: a **driver-invoked,
      between-batches** pass that substitutes the missing proof with a mark
      from every live frame *and every imported module's full graph* (depth 6
      — module-level data stays live, unlike the bounded in-test heuristic
      above). Candidates are the demoted, refcount-1 population only —
      everything C references is untouchable by the existing `_reclaimDead`
      guard, and between batches no expression is in flight, so the May
      objection (a mid-expression temporary reachable from neither frame nor
      arguments) does not arise. Dealloc dispatch resolves through the mro
      (`subtype_dealloc` semantics): a Python subclass of a C type carries a
      slot-less struct, the base owns `tp_dealloc` — without that walk the
      shell was freed but the native payload (torch's `TensorImpl`) leaked.
      Residual risk, stated plainly: a refcount-1 wrapper reachable *only*
      through a JS-side structure the scan cannot see would be reclaimed
      early; narrower exposure than the rejected global mark-sweep, and the
      21-suite sweep plus the brytorch full run show no such class. Measured:
      flat 133 MB across repeated 2000-tensor rounds (was +32-46 MB/round).

      **2026-07-22 amendment — the pass is now BILATERAL.** The 07-19 mark
      substituted the missing proof from one side only, and volume falsified
      it two ways (measured on brytorch): candidates whose types wire no
      dealloc slot (`torch.device` ×8378 per suite, `Size`, `finfo`) took a
      destructor-less `_free`, recycling structs under C-side borrowed
      pointers; and every demoted pybind11 instance's own real dealloc
      raises pybind11's `!types->empty()` registry assert (1 566/1 566 on
      one suite). The pass now demands evidence from **both** GC models
      before freeing: `{safe:true}` frees through a real `tp_dealloc` or
      not at all, skips tensors the C++ side still shares (TensorImpl
      `use_count > 1`, read through read-only census helpers the embedding
      module exports) and pybind11 instances wholesale, and frees
      collected wrappers through the type stamped at demotion
      (`demotedType`). `{dry:true}` runs the same walk as a pure census;
      `$B.$wasthon_census_live()` maps who owns the heap (bound vs
      demoted, storages deduped by StorageImpl). Instrument rule learned
      the hard way: `unwrap` of a demoted ptr RE-BINDS it, so every census
      call temp-binds by hand — a measurement must not mutate the bridge.
      Measured (brytorch 7-suite page, all green, corruption canary 0):
      page high-water 1390 vs 1870 MB, one suite pass returning 387 MB.

      **And the honest limit, measured the same day: the reachability half
      is not a proof, so the pass is NOT safe at scale.** Adding torch's
      own suite to that page (407 039 demoted candidates instead of ~34 000)
      frees 304 697 instances and returns 1165 MB — then the next suite
      collapses and later ones die on `bad Table get address` /
      `UnicodeDecodeError: invalid start byte`: the wasm function table and
      the linear heap are corrupted, i.e. live objects were freed. The
      census says why: the depth-6 mark from the frames plus the module
      graphs marks **998** objects live out of 407 039, having visited
      68 085 objects — its visit budget (400 000) was never even reached,
      so the depth bound alone accounts for it. "Not reached" means "not
      searched", not "dead". The C++ half
      cannot compensate: `use_count == 1` says the C++ side does not share
      the tensor, never that a Python variable stopped holding it. So the
      green 7-suite result above reflects a graph the bounded mark happens
      to cover — a property of those suites, not a safety property. The
      pass stays opt-in and off by default. The only sound proof of
      Python-side death here remains a collected wrapper, which Firefox
      does not deliver during a synchronous run (54 of 407 039), which is
      why the substitute existed in the first place. Making per-object
      reclamation sound needs a real refcount on the wrapper (the
      wasthonc / WasmGC pivot), not a better heuristic; for a driver that
      merely needs the memory back, throwing the whole context away
      (iframe isolation) proves nothing and therefore cannot be wrong.
      **Closed since** without either: the whole-heap collection above marks
      completely (no depth bound, no visit budget), takes everything C holds
      as a root, and runs only between two tests.
- [x] An instance C hands back to Python is counted once — the exemption
      above (`consumeResultRef` leaves an instance's reference to its wrapper)
      is right for the **first** crossing only. Once the wrapper exists, a C
      function returning the same object again (`return Py_NewRef(self)`, an
      in-place op, a `__torch_function__` result coming back through
      `PyObject_CallFunctionObjArgs`) hands over a reference nobody takes, and
      it stayed: measured 1 → 2 after one call, 6 after five, where CPython
      stays at 1. Every path to `tp_dealloc` described here requires the
      bridge to be sole owner (refcount 1), so an instance stuck above 1 was
      out of reach of all of them, whatever Python did with it. The first
      crossing now marks the instance and gives the C reference to the
      wrapper; every later return releases the caller's reference, never
      below 1. Deciding "already held" from the current count instead — the
      July attempts — also consumed borrowed returns and freed live objects
      (33 failures on `test_torch`); the crossing mark does not.
- [ ] Automatic-trigger residual — Brython offers no scope-exit or GC
      callback into `wasthon_decref`, so a C instance's release needs a
      trigger. Six now cover the cases: the `close()`/`with` contract for
      every heavy native that exposes one (LZMA/Zstd/bz2 file wrappers; sqlite
      `Connection.close()` frees natively), the one-shot
      `compress()`/`decompress()` helper wrap for the create-use-drop transient
      with no `close()`, `del` (freed once the mark proves it unreachable),
      `gc.collect()` (everything pending since a `del`, cycles included, and
      the resource-holding types' sweep), the whole-heap collection
      (`$wasthon_reclaim`, what a program simply stopped using), and — on a
      yielding page that opts in — the `FinalizationRegistry` reclamation
      above. The residual is what none of them reach: an instance dropped
      **without** `del` (a name rebound, a local of a finished call) in a
      program where nothing calls `$wasthon_reclaim` — the bridge never calls
      it itself, the host does (brytorch between two tests), since it is sound
      only where no expression is half evaluated. Freed at the next
      collection, kept until then; with none, kept for the page's life. Next:
      firing the collection automatically at such a point. (Instance /
      `refcounts` axis; distinct from the sentinel / `handles` leak below.)
- [x] JS-side handle-map (sentinel) leak — FIXED by **handle scopes** (the
      JNI local-reference / HPy model). Every JS→C entry point (method
      trampoline, slot dispatch, tp_new/tp_init/tp_call, getsets) pushes a
      scope; sentinel handles wrapped during the C call are released at
      return unless C took a reference — Py_INCREF promotes, new-reference
      APIs seed refcount 1 (`wrapNewRef`, the instance-era refcount-convention
      audit extended to sentinels), steal APIs consume. Module init stays
      unscoped (immortal, as before); a real intern pool backs
      `PyUnicode_InternFromString`/`_Py_ID` (lazy C statics). Measured on
      2000 `pickle.dumps` of a rich graph: `handles.size` grows
      **+0.00/call** vs **+105/call** without scopes; proven by
      `tests/lifetime.py` (`noScopeFree` A/B). This was the dominant `pickle.dumps`
      byte-leak — and, it turned out, an invisible cap on the test suite
      itself: the map's internal resize blew up ("allocation size overflow")
      once enough state accumulated, making correct fixes measure as huge
      regressions. Landing scopes immediately unlocked +46 pickle passes.
      It also removes the main motivation for a WasmGC pivot (which is
      structurally closed to linear-memory C anyway — externref can't live
      in C structs).

Eventually:

- [x] NumPy-class numerical computing in Brython — **achieved, beyond the
      original formulation**. The plan written here was an [Array API
      Standard](https://data-apis.org/array-api/) implementation atop
      Wasthon's `array` foundation; what landed instead is **real NumPy
      2.5.1**: the actual C core (`_multiarray_umath`, ~150 files)
      compiled against the bridge, numpy's own Python layer served to
      Brython, `import numpy` completing (83 modules; `np.linalg` on
      f2c'd LAPACK-lite). Validated by running **numpy's own
      test suite** in the browser (via a minimal pytest shim), and
      numpy.random's nine Cython extensions run with `MT19937.random_raw`
      **bit-exact vs upstream numpy 2.5.1**. No facade, no semantic
      drift — the same C that ships in the manylinux wheels. The
      bridge-side C-API growth this took (an 87-symbol link contract,
      vectorcall, the buffer protocol over `__array_interface__`, Cython
      cdef-class support) is merged on `main`; the build recipe, browser
      demo and test dashboard live in **NumBry** — *the NumPy stack in the
      browser with Wasthon* (NumPy, SciPy, pandas, matplotlib, seaborn,
      Pillow, SymPy). An Array API layer atop
      `array` could never have gotten there: pandas and matplotlib
      consume numpy's real C-API (`PyArray_*`, capsules, dtypes), not
      the Array API surface.
- [ ] [HPy](https://hpyproject.org/) support — the modern portable C-API.

## Acknowledgements

Wasthon plugs into [Brython](https://brython.info/) (Pierre Quentel and
contributors) and is compiled with [Emscripten](https://emscripten.org/);
the C-API it reproduces is CPython's.

## License

Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>

BSD 3-Clause License — same as Brython. See `LICENSE` for the full text
and `THIRD_PARTY.md` for the upstream components and their licenses.
