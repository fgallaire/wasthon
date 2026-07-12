# The Wasthon bridge — architecture

How unmodified CPython C extension code, compiled to WebAssembly, runs against
Brython's JavaScript runtime. This is the design document for `src/wasthon.h`
(the C-side contract), `src/wasthon.c` (extern definitions + init) and
`src/wasthon.js` (the JS-side implementation, an Emscripten `--js-library`).
Fix-by-fix history lives in `CHANGELOG.md`; this file is the map.

## The problem

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
bridge.

## Handles

`PyObject *` is a 32-bit integer **handle** into a JS-side table
(`WasthonRT.handles: Map<int, object>`) holding strong references to Brython
objects. Three key ranges share one map:

- **1–4** — the immortal singletons (`None`, `True`, `False`,
  `NotImplemented`).
- **5 – 0xFFFF** — *sentinel* handles: Brython objects passed into C
  (`wrap(obj)`). IDs are recycled through a free list. `wrap` is
  idempotent per object (identity interning via a `WeakMap`), so handle
  equality is object identity — C-side `a == b` pointer comparisons work.
- **≥ 0x10000** — *instance* handles: real linear-memory pointers returned
  by `_malloc` for instances of C-defined types
  (`wasthon_object_gc_new`). The pointer doubles as the map key, so JS can
  find the Brython wrapper of any C struct and vice versa
  (`obj.__wasthon_ptr__`).

The C code never inspects object layout (`wasthon.h` hard rule #4):
`PyObject` is declared as `{ intptr_t ob_refcnt; }` and every macro that
CPython implements by struct access (`Py_TYPE`, `PyTuple_GET_ITEM`,
`PyUnicode_GET_LENGTH`, …) is routed through a bridge function.

## Object lifetime — three tiers

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
   (read from the type struct at offset 40, called through the wasm
   table under its own scope) and then `PyObject_GC_Del` frees the struct
   and the map entries. This is what lets an lzma encoder context (~94 MB)
   or a sqlite3 connection be reclaimed deterministically.
3. **Immortal**. No scope active (module init, loader time) → handles are
   never collected. Interned strings live in a pinned pool.

Verified property: `handles.size` is **flat per call** (±0.00 entries per
`pickle.dumps` over 2000 iterations, `loader/test-scopes.html`) versus ~+105
per call before scopes existed.

Two deliberate complements, both *explicit* (the automatic
`FinalizationRegistry` route was evaluated and rejected — JS finalizers
never fire inside a synchronous run):

- **The `close()`/`with` contract** for heavy native resources
  (compressor contexts, DB connections) — same stance as Pyodide's
  `PyProxy.destroy()`.
- **`gc.collect()` as an explicit partial mark-sweep**: marks C instances
  reachable from live Brython frames, then finalizes unreachable instances
  of types that opted in (`$wasthon_gc_finalizable` — sqlite3's
  resource-holding types). Empty registry → instant no-op for everything
  else.

## Types

C extensions create types with `PyType_FromModuleAndSpec` / `PyType_FromSpec`
(heap types, slots identified by CPython's numeric slot IDs). The bridge:

- creates a **Brython class** for Python-side use, and
- allocates a **compact `PyTypeObject` struct in linear memory** (field
  order documented in `wasthon.h`; e.g. `tp_dealloc` at offset 40) for the
  C code that reads type fields directly (`type->tp_alloc(type, 0)`,
  `st->type->tp_dict`, …). The type handle *is* this struct's pointer.
  Brython classes that never went through FromSpec get one lazily
  (`ensureTypeStruct`).

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

## Calls

**JS→C**: `__wasthon_make_trampoline` turns a `PyMethodDef` entry into a
Brython-callable closure — it wraps arguments into a malloc'd handle array,
dispatches on the `METH_*` flags (FASTCALL, KEYWORDS, METH_O, VARARGS,
METH_METHOD), calls the C function pointer through the wasm table, and
unwraps the result. Vectorcall-capable objects (Cython's `CyFunctionType`)
are dispatched through their stored vectorcall pointer.

**C→JS**: every C-API function the modules call (`PyObject_GetAttr`,
`PyDict_Next`, `PyNumber_Multiply`, `PyErr_SetString`, ~700+ entries) is a
JS implementation in `wasthon.js` calling straight into Brython's runtime
(`$B.$getattr`, `$B.rich_op`, …).

## Errors

C signals failure by returning `NULL` with an exception *set*; Brython
raises exceptions as JS throws. The bridge holds the C-side state in
`WasthonRT.pendingException`: `PyErr_SetString/SetObject/Format` populate
it, `PyErr_Occurred/Fetch/Restore` manage it, and the trampoline re-throws
it as a real Brython exception when the C call returns `NULL`. Conversely a
Brython exception thrown *during* a C→JS call is caught, stored as pending,
and `NULL`/`-1` is returned to C — matching CPython's contract exactly is
what most error-path bugs came down to.

## Data crossing the boundary

- **Bytes/str**: copied. C-produced buffers travel back through
  `__wasthon_cstr__` linear-memory records drained recursively by the
  trampoline (`syncBytes`) — critical for pickle/zlib output.
- **Buffer protocol**: real. Instances of C types own actual data in
  linear memory, so `bf_getbuffer` hands out genuine pointers — this is
  why numpy's ndarrays (and matplotlib's C++ reading their vertices) work
  at native speed. Exporter-owned ("borrowed") views are tracked so
  `PyBuffer_Release` never frees memory the bridge doesn't own.

## Build integration

`wasthon.js` is an Emscripten `--js-library`: it is **inlined into each
module's `.mjs` at link time**. Consequences:

- A bridge change requires **relinking every `.mjs`** (the CPython bundle
  and each NumBry module). `grep` the built `.mjs` for your change to
  verify it took.
- The vendored Brython (`loader/brython/brython.js`) is loaded fresh by
  the page — Brython-level fixes are testable without any relink. Hence
  the two logs: bridge fixes → `CHANGELOG.md`, vendored Brython fixes →
  `BRYTHON_FIX.md`.

`wasthon.c` defines the extern sentinels (`Py_None`, `PyExc_*`,
`PyType_Type`, …); `wasthon_init()` must run once per module instance to
populate them via JS accessors before any ported code executes.

## Beyond the stdlib: Cython and pybind11

The bridge surface above carries 25 stdlib modules. Two support layers
extend it to binding generators, in increasing order of layout hostility:

- **Cython** (numpy.random, pandas, scipy) — mostly handle-friendly;
  needs compat headers, spec-based type creation
  (`-DCYTHON_USE_TYPE_SPECS=1`) and two generic post-cythonize patches.
  See `cython-support/README.md`.
- **pybind11** (matplotlib, kiwisolver) — aggressively
  struct-layout-dependent: it casts handles to `PyCFunctionObject*` /
  `PyHeapTypeObject*` and reads fields by offset. The bridge answers by
  making those specific objects *real*: `PyCFunction_NewEx` returns an
  actual 24-byte C struct whose address is the handle (trampoline bound on
  top), and `PyType_Type.tp_alloc` hands out raw `PyHeapTypeObject` memory
  that `PyType_Ready` consumes. See `cython-support/pybind11_compat.h` and
  NumBry's `docs/MATPLOTLIB.md`.

## What the bridge is not

No interpreter, no bytecode, no `PyEval_*`/`PyImport_*` core, no GIL
(single-threaded wasm; locks are no-ops). The header's hard rules: only
what targeted modules actually call, grow on demand, `PyObject` stays
opaque. Everything Python-semantic is Brython's job — the bridge's job is
to be a faithful, lying-through-its-teeth `Python.h`.
