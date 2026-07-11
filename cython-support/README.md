# Cython support layer (for pandas / numpy.random / any Cython module)

Shared foundation to build Cython-generated C extensions against wasthon's
`wasthon.h` and run them in the bridge. Common to **pandas** and **numpy.random**
(both Cython) — cf. `../PANDAS.md`, `../NUMPY_RANDOM.md`.

## pandas (2026-07-11): the full smoke page runs 20/20

`pdbuild.sh <pandas-src> <numpy-src>` builds all 45 pandas._libs extensions
(43 Cython C, window.aggregations Cython C++, vendored ujson single-phase C)
plus the plain-C lot and links them WITH the numpy core and numpy.random
objects into ONE module, `build/nppd.{mjs,wasm}` (prereqs:
`numpy-probe/probe.sh` then `nprnd.sh`). `gen_pandas_vfs.mjs <pandas-src>
<deps-dir>` builds `build/pandas_vfs.js` (pandas' pure-Python layer + six /
dateutil / pytz from the unpacked wheels + the `pandas-stubs/` browser stubs)
and `build/dateutil_zoneinfo_data.js`. `loader/test-pandas.html` loads it
all: 20/20 checks.

## numpy.random (2026-07-08): 3 C modules INITIALIZE in a combined wasm

A **combined** wasm (numpy core objects + `_common`/`bit_generator`/`_mt19937` +
`npyrandom` + `wasthon.o`, all `PyInit_*` exported, one shared memory) links and
boots; `import numpy` works, the numpy C-API capsule (`_ARRAY_API`) is present and
valid across the boundary, and **all three random Cython C modules initialize**
(`import_array()` succeeds). Getting there needed three post-cythonize size-check
patches (now in `cybuild.sh` as P3a/b/c): bridge types have no CPython memory
layout, so `__Pyx_ImportType` ("size changed") and `__Pyx_VerifyCachedType`
("Shared Cython type … wrong size", for the CyFunctionType shared across modules)
must have their `tp_basicsize` gates neutralised. **Next:** instantiating
`MT19937(seed)` traps with "null function or function signature mismatch" in the
cdef-class `__new__`/`__init__` slot dispatch — the current runtime wall.

## numpy.random (2026-07-07): base modules compile + link

`_common`, `bit_generator`, `_mt19937` (+ the `npyrandom` C algo lib) all
**cythonize → compile 0-error → link 0-undefined** with this layer plus the numpy
core headers (`numpy-probe/gen/`, `numpy/_core/include`) and `-DNPY_NO_DEPRECATED_API=0`.
Reaching that pulled in a batch of extra compat symbols (below). The `.pxd`
cimports (`cimport numpy`, `from numpy.random cimport BitGenerator`) resolve via
`-I <numpy-src-tree> -I numpy/random` on the cythonize command. Still TODO: the
**runtime** — a Cython extension that `import_array()`s the numpy C-API needs the
numpy core and the random modules linked into **one** wasm (shared memory, so the
`PyArray_API` / `"BitGenerator"` capsule pointers are valid across the boundary),
then boot-harness hooks for each `PyInit_*`.

## State (2026-07-07): a Cython module RUNS AND IS CALLABLE end-to-end ✅

Validated on pandas `byteswap` (the smallest, self-contained pandas Cython module):

- ✅ **cythonize** (`Cython==3.0.11`) `.pyx` → `.c`
- ✅ **compile** the Cython C against `wasthon.h` — **0 errors** with this layer
- ✅ **link** with `wasthon.js` + `cython_support.js` — **0 undefined symbols**
- ✅ **load** in the bridge, `PyInit_<mod>` runs, the `Py_mod_exec` slot is called
- ✅ **module init** runs its full boilerplate (module create, builtins, constants,
  the `__pyx_CyFunctionType` heap type) and registers the `def` functions
- ✅ **call** the functions from Python with correct results:
  `read_uint16_with_byteswap(b'\x01\x02…', 0, False) == 513` (`0x0201` LE),
  `== 258` byteswapped (`0x0102`); uint32/uint64 likewise exact.

Five walls fell to get from init to a working call (four generic, one config):

1. **`'module' object is not subscriptable`** — `PyEval_GetBuiltins()` returned the
   builtins *module*; Cython's `__Pyx_init_assertions_enabled` does
   `PyObject_GetItem(builtins, "__debug__")`. CPython returns the *dict*. → bridge fix.
2. **`InitCachedConstants` aborts** — code objects came back NULL. `PyUnstable_Code_-
   NewWithPosOnlyArgs` was a cosmetic `→0` stub; each `def`'s `__code__` must be
   non-NULL. → implemented in `cython_support.js` (Brython-shaped `co_*` record).
3. **tp_call reads garbage** — `PyCMethodObject` in `cython_compat.h` did not embed
   `PyCFunctionObject` as its first member, so `m_ml`/`vectorcall` offsets were wrong.
   → fixed the struct.
4. **tp_call points at the wrong function** — with `CYTHON_USE_TYPE_SPECS=0` Cython
   builds `CyFunctionType` from a **static positional** `PyTypeObject` initializer
   whose field order must match `wasthon.h` exactly (it doesn't → `Py_tp_call` lands
   elsewhere). → **`-DCYTHON_USE_TYPE_SPECS=1`** in `cybuild.sh` (build types via
   `PyType_Spec` + slot IDs, which the bridge maps by ID).
5. **infinite recursion on call** — the spec-based `CyFunctionType` uses the bridge's
   compact type struct (no `tp_vectorcall_offset` at +72), so `PyVectorcall_Call` fell
   to the slow `$B.$call` path = re-enter tp_call. → bridge now reads the
   `__vectorcalloffset__` member into `cls.$wasthon_vectorcall_offset` and dispatches
   the instance's stored vectorcall pointer directly.

Fixes 1, 3, 5 (+ the `__dictoffset__`/`__weaklistoffset__` member skip) are in
`src/wasthon.js` (real bridge, logged in `../CHANGELOG.md`). Fixes 2, 4 and the struct
are in this layer.

## Pieces

- **`cython_compat.h`** — `-include`d before the Cython C. Trivial typedefs/macros
  (`PY_INT64_T`, `CO_*`, `Py_UNICODE`, `Py_Version`, exception-check macros, legacy
  unicode), struct completions (`PyCodeObject`/`PyFrameObject`/`PyCMethodObject`),
  and prototypes for the C-API funcs the bridge implements. Also declares the
  3.13 `PyLong_From*NativeBytes` (already in `wasthon.js`).
- **`cython_support.js`** — bridge side: the C-API funcs Cython references that
  `wasthon.js` lacks. 4 cosmetic traceback stubs (`PyCode_NewEmpty`, `PyFrame_New`,
  `PyTraceBack_Here`, `PyInterpreterState_GetID` → NULL, so `__Pyx_AddTraceback`
  degrades gracefully) + **`PyUnstable_Code_NewWithPosOnlyArgs`** (builds a real
  Brython-shaped code object — each `def`'s `__code__`, required non-NULL) + 4 real
  (`PyModule_NewObject`, `PyImport_AddModuleRef`, `PyImport_ImportModuleLevelObject`,
  `_PyObject_GetDictPtr`). Meant to fold into `wasthon.js` once stable.
- **`compile.h`, `traceback.h`, `frameobject.h`, `pythread.h`, `structmember.h`,
  `internal/pycore_frame.h`** — empty stubs for CPython internal headers Cython
  `#include`s. Put this dir on the `-I` path.
- **`cybuild.sh`** — the pipeline: cythonize → **post-cythonize patches** → compile.
  The two generic patches (the "recipe" for Cython on the handle bridge):
  1. `def->ml_meth(` → `((PyCFunction)def->ml_meth)(` — `ml_meth` is `void*` in wasthon.h.
  2. `__Pyx_PyList_FromArray`'s `((PyListObject*)res)->ob_item` bulk copy →
     a `PyList_SET_ITEM` loop (lists are handles, no C `ob_item`).

## Build flags that matter

`-DPy_PYTHON_H` (Cython guards on it), **`-DCYTHON_USE_TYPE_SPECS=1`** (build Cython's
heap types via `PyType_Spec` + slot IDs the bridge maps by number, NOT the static
positional `PyTypeObject` initializer — see wall 4 above), and the Cython "portable
profile" that turns off internal-struct fast-paths:
`-DCYTHON_USE_MODULE_STATE=0 -DCYTHON_FAST_THREAD_STATE=0 -DCYTHON_USE_EXC_INFO_STACK=0`
`-DCYTHON_USE_TYPE_SLOTS=0 -DCYTHON_USE_PYTYPE_LOOKUP=0 -DCYTHON_USE_UNICODE_INTERNALS=0`
`-DCYTHON_USE_PYLONG_INTERNALS=0 -DCYTHON_USE_PYLIST_INTERNALS=0 -DCYTHON_ASSUME_SAFE_MACROS=0`
`-DCYTHON_UNPACK_METHODS=0 -DCYTHON_AVOID_BORROWED_REFS=1`

## Known bridge quirk found here

`wasthon.h` has `Py_mod_exec=1, Py_mod_create=2` — **swapped from CPython**
(create=1, exec=2). Internally consistent (Cython's slot table + the bridge both use
wasthon.h's values), but the bridge **ignores the `Py_mod_create` slot** and creates
its own module; Cython's `__pyx_pymod_create` (which copies loader/origin/spec) never
runs. Likely relevant to the remaining module-init work.
