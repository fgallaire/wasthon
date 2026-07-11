# Wasthon — bridge fixes log

Chronological log of bridge gaps fixed since the project's polish pass.
Newest first. Each entry sketches the symptom, the root cause and the fix
so future-me (or you) can revisit the reasoning without git-archaeology.
Module ports and the bridge-surface inventory live in `README.md`.

---

- **tp_new pointers on Brython-class type structs carry their owning class**
  (`src/wasthon.js`). The generic `wasthon_brython_tp_new` trampoline
  resolved `__new__` on the TARGET type, so when Cython copied a base's
  tp_new down an inheritance chain (`ABCTimestamp->tp_new =
  datetime->tp_new`, then `_Timestamp.__new__(Timestamp, ..., fold=0)`)
  the call re-entered the most-derived `Timestamp.__new__` — whose fold
  guard rejected the components path ("Cannot pass fold with possibly
  unambiguous input") — and with the owner itself as target it recursed
  until "too much recursion". `ensureTypeStruct` now installs a
  per-owner pointer (`addFunction` closure, shared trampoline as
  fallback) that runs the OWNER's constructor for whatever target type
  it receives, like CPython. `pd.Timestamp(...)` in every calling form.

- **Real datetime C-API capsule** (`src/wasthon.js`, `src/datetime.h`).
  `PyCapsule_Import("datetime.datetime_CAPI")` handed back a ZEROED
  struct, so `PyDate_Check`/`PyDateTime_Check`/`PyDelta_Check` compared
  against NULL and never matched — pandas' `convert_to_tsobject` refused
  every datetime ("Cannot convert input [...] to Timestamp") and numpy's
  datetime64<->pydatetime conversions silently fell back. The capsule
  now carries the five type pointers (ensureTypeStruct over Brython's
  pure-Python datetime classes), `timezone.utc`, and the nine
  constructors as addFunction closures calling the target type. The
  field-access macros (`PyDateTime_GET_YEAR`, packed `data[]` byte
  reads — garbage on a Brython instance) became attribute reads via
  static-inline helpers in `datetime.h`. `pd.Timestamp(year=, month=,
  day=)`, `pd.to_datetime` (with the vendored super fix), `Timedelta`
  arithmetic.

- [x] **tp_init inherits through the bases when a spec type has no own Py_tp_init** (bridge). Both class-wiring paths (PyType_Ready and PyType_FromModuleAndSpec) aliased `cls.tp_init` to `object.tp_init` whenever the type declared a tp_new but no tp_init of its own — so a Cython subclass relying on its PARENT's `def __init__` (pandas ObjectEngine over IndexEngine, and every other engine subclass) never ran that init and all its cdef fields stayed None: `Index.get_loc` died "object of type 'NoneType' has no len()", which broke every DataFrame column lookup ("'k' in df.columns" was False, `df['k']`, groupby/merge/sort_values keys, to_json). CPython's PyType_FromSpec inherits tp_init through the bases; the mro isn't populated yet at wiring time, so the slot now resolves lazily on first call and caches on the class (__cinit__-only types still land on object.tp_init and skip). pandas smoke page 5/20 → 10/20 (groupby, Categorical, concat, sort_values, read_csv now compute).

- [x] **add_docstring reaches C-function trampolines + creation-time ml_doc + subclass kwargs/subtype on the FromModuleAndSpec tp_new** (bridge). Three roots behind the pandas smoke page. (1) `wasthon_set_docstring`'s guard read `typeof obj !== 'object'` — a C-function trampoline is `typeof 'function'`, so EVERY numpy `add_docstring` on a function silently dropped (numpy's `_add_docstring` swallows failures with `except Exception: pass`, which is why this never surfaced); with the vendored `__doc__` getset, `np.arange.__doc__` now carries the real doc (numpy.ma's `_convert2ma` asserts on it). (2) `__wasthon_install_methods` now stores ml_doc (minus the clinic signature line, CPython's contract) in `$function_infos[func_attrs.__doc__]` at trampoline creation, so every C module's functions carry their docstring without an add_docstring pass. (3) The `PyType_FromModuleAndSpec` tp_new wrapper — the branch every Cython class comes through — STRIPPED kwargs on subclass instantiation and passed the PARENT struct to the C tp_new (except Decimal), on the theory that a tp_init catches the keywords later. A mandatory Cython `__cinit__` has no tp_init: `Block(values, placement=…, ndim=…)` — behind every pandas Series — died "takes at least 3 positional arguments". Now a subclass instantiation WITH keywords forwards them and hands the C constructor the subclass's canonical ensureTypeStruct handle (the parent struct makes the C base-only kwarg guards wrongly fire); keyword-less subclass calls keep the historical parent-struct path (generalizing the subtype struct regressed test_array -26: array_new/its buffer protocol can't run on the generic struct), and array keeps the historical strip outright — its subclass kwargs are for the Python `__init__`, which still receives them (documented per-module exception alongside Decimal's). pandas smoke page: 0/20 → 5/20 with the vendored companions (Series/DataFrame/cut/isna/np-interop construct and compute). Building pandas' `_libs.window.aggregations` — the first Cython C++ module — surfaced two linkage gaps that apply to every future C++ extension (matplotlib's pybind11 stack): `PyMODINIT_FUNC` now carries `extern "C"` under `__cplusplus` (CPython's definition does; without it the `PyInit_*` wasm export comes out name-mangled) and `cython_compat.h` wraps its declarations in an `extern "C"` guard (seven API symbols resolved mangled at link). New API for the pandas io modules (`_libs.json`/ujson, `_libs.parsers`, `_libs.testing`): `PySet_Discard` and `PyObject_Dir` (wasthon.js, the PySet block's style), `PyAnySet_Check` aliased to the set-or-frozenset `PySet_Check`, `PyObject_Realloc` → `PyMem_Realloc` (wasthon.h). `wasthon_fill_array_buffer` grows the missing buffer formats: `'O'` (an object array's items are 32-bit handles = PyObject* in wasm32, exposable as-is per CPython's `'O'` contract) and complex `'Zf'`/`'Zd'` — Cython typed memoryviews over object/complex128 ndarrays validated format 'B' and died "Buffer dtype mismatch" (every `Series`/`DataFrame` constructor path through `lib.maybe_convert_objects`). `__wasthon_slice_start/stop/step` GetAttr helpers (cython_compat.h) back the build recipe's rerouting of Cython's direct `((PySliceObject*)s)->start` struct reads — garbage on bridge handles (pandas internals.pyx `slice_canonize`, i.e. every `BlockPlacement(slice)` behind every Series). With the vendored companion commit `import pandas` prints `__version__` 2.2.3 end-to-end in the node harness, `BlockPlacement(slice)` constructs, ujson round-trips. numpy grand total unchanged (3041), 21 suites 0 fails, numpy smoke 38/38.

- [x] **Class-body cyfunctions survive Py_mod_exec: staticmethod/classmethod constructors take their callable ref, and struct-backed callables handed to Brython as call arguments are pinned** (bridge + cython-support). Every Cython module defining a Python class with methods died at module exec — pandas nattype's NaTType (head of the whole `_libs` import chain) ended up with a class dict where `value` held a bare `__reduce_ex__` cyfunction and `__new__` a staticmethod whose inner function had mutated: the C structs behind the class-body cyfunctions were FREED during exec and their addresses recycled by the next allocations (named-stack traces: the same pointer hit rc→0 TWICE at two different DECREF sites inside `__pyx_pymod_exec_nattype`, GC_Del double-free). The refcount bookkeeping itself was sound (tp_alloc seeds rc=1, PyDict_SetItem increfs struct-backed values); two STORAGE paths took no ref. (1) `PyStaticMethod_New`/`PyClassMethod_New` stored the callable without the ref CPython's constructors take — Cython's `__Pyx_SetNewInClass` does `PyStaticMethod_New(value)` then DECREFs its own ref, dropping the cyfunction struct to rc 0 under the stored wrapper. (2) A cyfunction passed as a CALL ARGUMENT to a Brython callable — `property(fget)` in every decorated class body — is stored by pure-Brython code that holds only the JS wrapper and can take no bridge ref, so the caller's own DECREF freed the struct. The constructors now incref struct-backed callables (instance-exempt rule, mirror of PyDict_SetItem), and `pinCallableArg` pins one ref the first time a struct-backed CALLABLE crosses as an argument on any call primitive (bounded leak: callables are code definitions; return values already pin via consumeResultRef's instance exemption — this is the argument-position mirror). Diagnostics: the vectorcall-NULL error names the callee, and `rt.debugVectorcall` dumps the failing callee + JS stack. pandas 2.2.3: all 40 `_libs` C modules import and exec green (NaTType/NAType class dicts verified sane; the import now runs deep into pure-Python pandas.core). **numpy grand total +33 (core+random)**; full 21-suite sweep 0 fails (pickle 941, array 876, sqlite3 473, statistics 370, decimal 357, json 170, re 154, lzma 118, zstd 116, random 104, bz2 98, hmac 90, math 82, binascii 76, hashlib 74, zlib 63, pyexpat 58, unicodedata 48, struct 36, cmath 32, csv 123), numpy smoke 38/38.

- [x] **pandas support layer: the C-API long tail + exact-type identity through the builtin reverse map** (bridge + cython-support). pandas 2.2.3's 36 `_libs` extension modules now compile and link against the bridge (the numpy.random recipe applied verbatim, plus: `-include src/patchlevel.h` — without `PY_VERSION_HEX` every Cython TU falls back to Python-2-era wstr code; PEP-393 self-macros `#define PyUnicode_KIND PyUnicode_KIND` since Cython feature-tests with `defined()` which never sees wasthon.h's function declarations; `#undef PyUnicode_WCHAR_KIND` per 3.12 semantics; a `descrobject.h` stub and ~15 declarations in cython_compat.h). New bridge functions: `PySet_Add/Contains/Size/Pop`, `PyCFunction_New`, `PyClassMethod_New`, `PyDescr_NewClassMethod`, `PyErr_PrintEx`, `PyMethod_Check/GET_FUNCTION` (wasthon.js), `PyNumber_InPlaceAnd`, `PyStaticMethod_New`, `PyUnicode_Encode/DecodeLocale` (cython_support.js), `PyWrapperDescr_Type` (wasthon.c). Two identity fixes: `wasthon_is_exact_type` and `PyType_IsSubtype` now resolve a builtin type struct through `builtinClassForStruct` before comparing — a re-readied `&PyUnicode_Type` binding made Cython's exact typed-argument tests fail with "Argument has incorrect type (expected str, got str)" (pandas nattype's `__Pyx_ArgTypeTest(exact=1)` via `Py_IS_TYPE`). `import pandas` reaches and runs the `_libs` PyInits (combined numpy+random+pandas wasm links 0-undefined); the remaining boot blocker is a class-dict corruption under investigation (NaTType's `value` slot carries the `__reduce_ex__` cyfunction). Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array 876, test_random 104; numpy smoke 38/38).

- [x] **Pickle chain closed: reduce-swap guard + `'O!'` in ParseTuple groups + PEP 688 `__buffer__` + object-owned buffer lifetime** (bridge). Four roots, found in sequence behind one symptom (`loads(dumps(x))` failing for every numpy dtype/ndarray/bit generator). (1) The trampoline's subclass-aware reduce swap — which patches a C `__reduce__` result to name the instance's actual class when the C side could only see the parent struct — also fired when the "subclass" is a C-DEFINED class: a dtype instance's type is `Int32DType`, a strict base of it is `np.dtype`, and `arraydescr_reduce` names `np.dtype` DELIBERATELY, so the swap corrupted item 0 into a class whose call-with-args is TypeError by design (a mark probe showed the object set by `PyTuple_SET_ITEM` vanishing from the returned tuple — the mutation was in the trampoline result pass, not in the C or the GetAttr). The swap now skips when `subcls.__wasthon_type_handle__ === rself.__wasthon_type__` (the C saw the real type). (2) `PyArg_ParseTuple`'s `'(...)'` group loop read one varargs slot per CHARACTER, so the `'!'` of numpy `array_setstate`'s `"(iO!O!iO)"` parsed as its own integer slot and every ndarray/bit-generator `__setstate__` died with "integer expected in argument 1"; `'O!'` in a group is now one type-checked code consuming two varargs slots. (3) PyType_Ready installs a PEP 688 `__buffer__` (method_descriptor in the class dict) on C types exposing `tp_as_buffer`, so `memoryview(ndarray)` works — the read `pickle.py`'s protocol-5 `save_picklebuffer` needs for in-band bytes; writable buffers cross as bytearray. (4) `wasthon_get_buffer_data`'s per-view malloc was freed by `PyBuffer_Release`, but numpy's `PyArray_FromBuffer` releases the view and keeps aliasing `view->buf` per the CPython contract (the buffer lives with the OBJECT) — protocol-5 unpickled arrays aliased freed memory and came back as heap garbage; the copy is now cached on the supplying object (`__wasthon_bufptr__`, the `__wasthon_cstr__` model) and marked object-owned so release skips the free. `pickle.loads(pickle.dumps(x))` round-trips ndarray / dtype (incl. structured) / SeedSequence / MT19937 / Generator / scalars at protocol 2 and (with the vendored PickleBuffer fallback) at the 3.14 default protocol 5, exact data, bit-exact generator state; **numpy grand total +2 (core+random; the numpy.random pickle cluster — +18 more — lands with the vendored PickleBuffer commit that depends on this one)**. Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array 876, test_random 104, test_math 82, test_cmath 32, test_statistics 370, test_json 170).

- [x] **Metatypes inherit `type.tp_call`: DType classes are callable (`Int32DType()` returns the int32 singleton)** (bridge). Calling any class whose metaclass came from the bridge (numpy's `_DTypeMeta` DType classes) raised `TypeError: '_DTypeMeta' object is not callable`: the metaclass materialized without a `tp_call`, and Brython's `$call` found nothing — in CPython `_DTypeMeta` simply inherits `type.tp_call` (type_call → the called class's tp_new). Both class-bind sites (PyType_Ready + FromModuleAndSpec, the getattro-metatype twins) now install `type.tp_call` when the mro contains `type` and no tp_call exists. `Int32DType()` returns the int32 SINGLETON per numpy's `legacy_dtype_default_new`, `callable(D)` is True; **numpy grand total +1 (test_polyutils)**. The dtype pickle ROUND-TRIP stays blocked by chain root #6 (our `arraydescr_reduce` item 0 carries the concrete DType class where CPython puts `np.dtype` — dossier updated). Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array 876, test_random 104).

- [x] **`np.dtype(bool/float/complex)` resolve to real dtypes: bool/float/complex join the canonical-struct unification, unlocked by `PyFloat_FromString` accepting bytes** (bridge). `np.dtype(float)` returned `dtype('O')` (object) — numpy's `_convert_from_type` compares the passed class against `&PyFloat_Type`/`&PyBool_Type`/`&PyComplex_Type` by POINTER, and `ensureTypeStruct` only unified `int` (+ singletons) with its canonical struct. Unifying float was a documented dead end: _json's scanner then takes its `parse_float == &PyFloat_Type` fast path and calls `PyFloat_FromString` with the raw numstr as **bytes** — and not any bytes: a C-allocated one (`PyBytes_FromStringAndSize(NULL, n)` placeholder memcpy'd by C afterwards) whose Brython `.source` is still blank, which is why the error surfaced as `could not convert string to float: '    '` and buried the 07-08 diagnosis. `PyFloat_FromString` now accepts bytes/bytearray per the CPython contract, reading the linear-memory buffer (`__wasthon_cstr__`) first and `.source` otherwise; `bool`/`float`/`complex` join the `canon` list. `np.dtype(bool/float/complex)` → `bool`/`float64`/`complex128`, `np.dtype(bool) == np.bool_`, `Generator.integers(0, 2, dtype=bool)` works; test_json 170 (the historical −6 erased) and test_pickle 941 with no timeout. Numeric sweep 8 suites 0 fails (re 154, pickle 941, decimal 357, pyexpat 58, math 82, cmath 32, statistics 370, json 170).

- [x] **Protocol-2 pickle DUMPS work for ndarray/dtype/SeedSequence/bit generators: Cython's reduce aliasing done bridge-side, `Py_BuildValue` grows `'c'`, and metatype instances get class attribute access** (bridge). Three roots on one chain (full dossier: NUMPY_HARD_BUG.md "CHAIN — pickling numpy.random / dtypes"; two locks remain there for protocol 5 and the loads side). (1) Cython's `__Pyx_setup_reduce` promotes `__reduce_cython__` → `__reduce__` at module init but guards it by comparing `PyObject_GetAttr` handles by POINTER identity — unguaranteeable on the bridge for inherited attributes — so the promotion silently never happened and pickling any cdef instance (SeedSequence, MT19937…) fell into Brython's raising `object.__reduce_ex__`. The bridge now aliases at spec-type method install, only when no ancestor below `object` defines the dunder (MT19937 inherits BitGenerator's real `__reduce__` while carrying its own RAISING `__reduce_cython__`; blind aliasing shadowed it). (2) `Py_BuildValue` had no `'c'` (one-byte bytes) format: numpy's `array_reduce` builds its args tuple with `"ONc"`, the whole BuildValue failed, and `PyTuple_SET_ITEM(ret, 1, 0)` stored a JS null — every ndarray `__reduce__` carried a null args slot ("second item … must be a tuple, not NullType"). (3) The default attribute machinery installed `object.tp_getattro` on every class; for a METAtype (mro contains `type`) the instances are classes and need `type.tp_getattro` — `Int32DType.__reduce__` bound `object.__reduce__` through `_DTypeMeta` instead of finding `dtype.__dict__['__reduce__']`, so dtype pickling fell into copyreg ("Can't pickle <class '_DTypeMeta'>"). `pickle.dumps(x, 2)` works for `np.arange(3)`, `np.dtype('int32')`, `SeedSequence(42)`, `MT19937(5)`, `Generator(PCG64(3))`. Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array 876, test_random 104).

- [x] **`PyLong_AsLongLong` returns -1 on error per the CPython contract — 64-bit bounds work across numpy.random (`Generator.integers(2**63)`, uint64 ranges)** (bridge). Every 64-bit-bound call (`g.integers(2**63)`, `integers(0, 2**64, dtype=uint64)`, broadcast variants) raised `OverflowError: Python int too large to convert to C long`. The bridge's `PyLong_AsLongLong` returned **0** on overflow/TypeError; CPython returns **-1**. numpy's `discover_descriptor_from_pylong` detects errors with `error_converting(value)` — `value == -1 && PyErr_Occurred()` — so the overflow went unseen, `value` read as 0, `np.asarray(2**63)` resolved to NPY_INTP (int32 on wasm32) instead of promoting through longlong/ulonglong, and the eventual `LONG_setitem` pack raised. With -1 the discovery ladder works: `np.asarray(2**63)` is uint64, all 64-bit `integers` forms pass; **numpy grand total +40 (test_smoke +26, test_seed_sequence 3/0, test_direct/generator/random/randomstate +3 each)**. Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array 876 — the 'q'/'Q' typecode consumer — test_random 104).

- [x] **Python subclasses of numpy scalars construct and print correctly: `wasthon_builtin_float_tp_new` hands subtypes back to numpy's own fallback + `ensureTypeStruct` allocates the FULL PyTypeObject with a real `tp_mro`** (bridge). `class B(np.float64): ...; B(1.0)` held heap garbage (a different giant float on every read) and `class my_int16(np.int16): ...` printed `my_int16(False)` while holding 3. Two roots. (1) The bridge's `PyFloat_Type.tp_new` returned a plain Brython float for ANY requested type; numpy's `double_arrtype_new` returns that object straight back, the tp_new wrapper re-classed it to the subclass — but a plain float has no `__wasthon_ptr__`, so every C slot read on it wrapped a fresh sentinel handle and dereferenced it as a struct pointer (the garbage). Now a Python-subclass request (an rt.types entry whose class has no `__wasthon_basicsize__`) returns NULL with NO error — CPython's float_new hands subtypes to float_subtype_new; numpy's caller has the equivalent documented fallback (PyErr_Clear + convert + `tp_alloc` the subtype + copy into its obval) which builds a real struct-backed instance. (2) `ensureTypeStruct` allocated a 64-byte struct while C code reads appended PyTypeObject fields directly — `tp_mro`@148 (numpy's `_descr_from_subtype` resolves a scalar subclass's dtype via `mro[1]`; the garbage read resolved my_int16 to a BOOL descr), `tp_itemsize`@68 (`@name@_arrtype_new`), `tp_flags`@120, and bbe1ba4's `tp_basicsize`@64 = 0 read was pure heap luck. Now the full 176 bytes are allocated zeroed and `tp_mro` carries a pinned CPython-convention tuple (class first — Brython's own tp_mro already includes the class for `type.tp_new` classes but not `make_builtin_class` ones; re-prepending blindly made `mro[1]` the class itself and `_descr_from_subtype` recursed to stack overflow). `str(B(1.0))` == '1.0', `repr(my_int16(3))` == 'my_int16(3)' (gh-27106), `.item()`/`.tolist()`/unbound reads all correct; **numpy core dashboard +3 (test_scalarinherit +3), grand total (core+random) 2772 passed**. Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array 876, test_random 104).

- [x] **The spec-type `tp_descr_get` wrapper maps class access to C NULL — `Cls.method` on a cdef class returns the unbound `cython_function_or_method`** (bridge). `getattr(MT19937, 'random_raw')` (any Cython cdef class) returned a Brython `method` — unbound calls `Cls.method(inst, …)` passed the wrong self, `__module__` read 'builtins' and wasn't settable (numpy.random's mtrand repr-cosmetics loop `method.__module__ = "numpy.random"` crashed its whole module init — worked around at the source until now). Root: Brython's `type.tp_getattro` correctly passes `$B.NULL`/None for class-level access, but the wired `Py_tp_descr_get` wrapper wrapped that into a real handle (`rt.wrap(None)` ≠ 0) — Cython's `__Pyx_PyMethod_New` tests `if (!self) return func`, saw non-NULL and bound. CPython's `wrap_descr_get` maps None to C NULL before calling the slot; the wrapper now does the same (`$B.NULL`/None/undefined → 0). `MT19937.random_raw` is the raw function, instance access still binds, `__module__` reads its real module and is settable, `MT19937.random_raw(MT19937(5), 2)` returns the right uint64s. numpy dashboard stable (+0 — the cdef surface isn't in the core modules), smoke 38/38. Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **`PyNumber_Subtract` dispatches the full binary protocol (`rich_op1('__sub__')`) — `np.arange(np.float32(3))` works** (bridge). Passing a numpy scalar as arange's stop raised `ValueError: arange: cannot compute length` (`np.arange(np.float16(5))`, `np.arange(np.float32(3))`, 18 fails in the dossier). `PyNumber_Subtract` was the ONE binary op still on the initial-commit numeric fast path: it coerced operands with `Number(obj)`, and a numpy scalar (a C-struct-backed instance with no `.value`) became **NaN** — numpy's `_calc_length` does `stop - start` through the C-API, took the ceil of NaN and bailed. Every other `PyNumber_*` already went through Brython's `rich_op1`; Subtract now does too, so the scalar's `nb_subtract` is dispatched. All arange forms over numpy float scalars work; **numpy dashboard +19**. Numeric sweep clean, 8 suites 0 fails (test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_math 82, test_cmath 32, test_statistics 370, test_json 170).

- [x] **C tp_new receives the REAL subtype (canonical ensureTypeStruct handle) and subclass kwargs are forwarded — `np.matrix` carries its data, `__array_finalize__` fires on construction** (bridge). Every `np.matrix([[1,2],[3,4]])` was silently ZEROS (so `M @ N`, `M + M`, everything computed zeros), its repr died in StopIteration, `.tolist()` recursed forever and `M.sum()` hit `'ndarray' object has no attribute '_collapse'`. Root: the static-type `tp_new` wrapper always invoked the C constructor with the PARENT struct pointer and (since the +14 array-kwargs commit) stripped kwargs on subclass calls to compensate for CPython's base-only kwarg guards (`type == &X_Type && !_PyArg_NoKeywords`) wrongly firing — so `ndarray.__new__(matrix, shape, dtype, buffer=arr, order=order)` (numpy's defmatrix constructor) lost `buffer=` (fresh zeroed allocation, `base` lost, OWNDATA wrong) and, with `subtype == &PyArray_Type` C-side, `__array_finalize__` never ran (no `_getitem` → the repr/tolist crashes). Now the wrapper passes `rt.wrap(brythonCls)` — the same canonical type-struct identity the proven `arr.view(subclass)` path feeds `PyArray_NewFromDescr` — so the C guards exempt subclasses exactly as in CPython (kwargs forwarded, `array.array` subclass kwargs still accepted, base `array.array(spam=42)` still rejects), numpy honors `buffer=`/`order=` and finalizes. Also `init_dict` on the fresh instance now runs only when it has no dict yet — it wiped attributes `__array_finalize__` had just set. `np.matrix` products/sums/reprs are correct, `m.base is src`, OWNDATA False; **numpy dashboard +14 (test_defmatrix +14, `_collapse` signature extinct)**. Existing ports rebuilt green, sweep widened to the C-subclass territories (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58, test_array, test_random).

- [x] **`PyObject_GetAttr`/`PyObject_GetOptionalAttr` hand class-level access the raw getset descriptor instead of force-applying it — every `np.rec`/recarray construction works** (bridge). `np.rec.array(…)` (and `np.dtype((record, …))` for any np.void subclass) raised `TypeError: descriptor 'dtype' for 'void' objects doesn't apply to a 'type' object`. Both getattr entry points force-applied a raw `getset_descriptor` handed back by `$getattr` with the original object as `obj` — even when that object is a CLASS. (The force-apply exists for instance access: `function.__qualname__` returned raw broke _pickle's save_global.) numpy's `PyArray_DescrFromTypeObject` does `PyObject_GetOptionalAttr(record, "dtype")` on the class and expects CPython class-access semantics — `__get__(NULL, cls)` returns the descriptor itself, which numpy then treats as "class property, keep the default void dtype"; the bridge instead invoked the getter with the class as instance → Brython's MRO guard raised → the whole dtype/recarray construction died. New shared `rt.resolveGetset` applies the descriptor only when `obj` is an instance of its owner (`d_type ∈ mro(type(obj))`) and returns it raw otherwise. `np.rec.array([(1, 2.0)], dtype='i4,f8')`, field attribute access `.x`, and `np.dtype((record, […]))` (CPython-exact repr) all work; **test_records +26, numpy dashboard stable**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **`PyObject_VectorcallMethod` forwards kwnames + `Py_BuildValue` group loop skips separators — `np.from_dlpack` imports writable arrays (the "assignment destination is read-only" family)** (bridge). `np.from_dlpack(writable_array)` returned a read-only array; writing raised `ValueError: assignment destination is read-only`. Paired root, both required. (1) `PyObject_VectorcallMethod` dropped every keyword: numpy's `from_dlpack` calls `obj.__dlpack__(max_version=(1,0), …)` through it, the kwarg was lost, `array_dlpack` saw `max_version=None` and built an unversioned capsule, and the unversioned import path forces `readonly=1`. It now forwards kwnames exactly like `PyObject_Vectorcall` (`{$kw:[kwMap]}`, values read from the args buffer after the positionals) — a general win for every C-side method call carrying kwargs. (2) With kwargs delivered the versioned path STILL failed: `Py_BuildValue`'s `(`/`[`/`{` group loop pushed the `null` that `readOne` returns for the separators `','`/`' '`/`':'` (the top-level loop filters it, the group loop didn't), so numpy's static `dl_max_version = Py_BuildValue("(i,i)", 1, 0)` was the 3-tuple `(1, <JS null>, 0)` → `array_dlpack`'s "tuple with two elements" check raised TypeError → `from_dlpack` fell back to the unversioned protocol anyway. Same corruption hit `dl_cpu_device_tuple` (`from_dlpack(x, device="cpu")`), and a `':'` inside a `{…}` format would shift every key/value pair. `np.from_dlpack(np.arange(4.))` is writable end-to-end; **numpy dashboard +3, test_dlpack +3, "read-only" signature 13→5 occurrences**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **Cython cdef-class methods bind and numpy typed buffers work: `tp_init` returns `None` on success, `Py_tp_descr_get` is wired in `PyType_FromModuleAndSpec`, and `PyObject_GetBuffer` exposes a numpy ndarray's real typed writable buffer** (bridge). Three gaps blocked running numpy.random's Cython bit generators. (1) The spec heap-type `tp_init` wrapper returned `undefined` on success, so a Python-level `Cls.__init__(self, args)` — Cython's `super().__init__()`, e.g. `MT19937.__init__` calling `BitGenerator.__init__` — read NULL and treated it as a raised exception. Now returns `_b_.None`. (2) `Py_tp_descr_get` was never installed, so `bg.random_raw` resolved to the *unbound* `cython_function_or_method` and `bg.random_raw(3)` called it with `self=3` (first positional), reading garbage struct fields. Now instance attribute access invokes the C descriptor and binds `self`. Its wasthon.h slot ID was 56, which **collides with `Py_tp_doc`** (the bridge reads 56 as the class docstring for `__text_signature__`), so wiring off 56 called `getWasmTableEntry` on the doc string pointer of every C type carrying a docstring (`_random.Random` etc.) → "bad Table get address"; `Py_tp_descr_get`/`Py_tp_descr_set` now use free IDs 84/85. (3) `PyObject_GetBuffer` returned a generic byte copy (`"B"`, itemsize 1) via `tobytes()`, which fails Cython's `np.ndarray[np.uint32]` buffer validation and drops in-place writes; it now detects a numpy array via `__array_interface__` and fills the `Py_buffer` with the real linear-memory data pointer, dtype format, ndim, shape and strides (aux allocations freed in `wasthon_buffer_release`; buf aliases numpy's own storage). numpy.random `MT19937(seed)` constructs through the full pipeline (`SeedSequence` entropy mixing on typed ndarrays → `generate_state` → `mt19937_seed`) and `random_raw(3)` matches numpy 2.5.1 bit-for-bit.

- [x] **Cython cdef classes: spec-based types carry a full type struct + are their own C handle, and `PyType_GetFlags` drops `IS_ABSTRACT` — a Cython `cdef class` (numpy.random `MT19937`) constructs through inherited C slots** (bridge). Instantiating a Cython cdef class trapped with "null function or function signature mismatch": its `tp_new` reads the base type's slot **directly as a C struct field** (`__pyx_ptype_BitGenerator->tp_new`, and `t->tp_alloc`, `Py_TYPE(x)->tp_flags`), but `PyType_FromModuleAndSpec` (1) minted a *fresh* handle for the class so `rt.wrap(cls) != typeStructPtr` → the field read landed on unrelated memory, and (2) truncated the type struct at 64 B so `tp_new`@60 / `tp_basicsize`@64 / `tp_call`@100 / `tp_flags`@120 were 0 or out of bounds. Now the class's C handle **is** its type-struct pointer (`cls.__wasthon_ptr__ = typeStructPtr`), the struct is the full `wasthon.h` `PyTypeObject` size (180 B, one malloc per *type* — dozens/session, not per instance), and the C slots Cython reads (`tp_new`/`tp_init`/`tp_basicsize`/`tp_call`/`tp_flags`/`tp_traverse`/`tp_repr`/`tp_hash`/`tp_richcompare`/`tp_getattro`/`tp_setattro`/`tp_str`) are populated at their real offsets. Separately, `PyType_GetFlags` returned a blanket `0xFFFFFFFF` — which asserts `Py_TPFLAGS_IS_ABSTRACT`, so Cython's cdef `tp_new` routed construction to `PyBaseObject_Type.tp_new` (NULL on the bridge) → trap; it now clears `IS_ABSTRACT` and `DISALLOW_INSTANTIATION`. `MT19937(seed).__new__` now allocates and inherited `BitGenerator.__new__` runs (numpy.random init reaches `BitGenerator.__init__`). Because a type now carries `__wasthon_ptr__` (its C struct pointer) it would look like a GC-collectable C instance to the weakref bookkeeping, so type objects are excluded from `$wasthon_weakref_track`: the instance-GC must never clear a live weakref to a class, else an ABC registry built via `collections.abc.Sequence.register(cls)` (e.g. `sqlite3.Row`) silently empties and `issubclass(cls, Sequence)` goes False. Existing ports rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58); numpy core sanity green (`np.arange(6)+np.arange(6)` sums to 30, dtype int32).

- [x] **numpy.random: export `PyExc_ModuleNotFoundError` / `PyExc_GeneratorExit` / `PyExc_UnboundLocalError` + `PyException_SetTraceback` returns `int` — the Cython random modules (`_common`/`bit_generator`/`_mt19937`) link** (bridge). Linking numpy.random's cythonized C left these three exception globals undefined (Cython's module-init and generator/coroutine support reference them) and `PyException_SetTraceback` was declared `void` while Cython does `PyException_SetTraceback(...) < 0` (CPython returns `int` 0/-1). Added the three `PyExc_*` globals following the existing getter pattern (`wasthon_get_PyExc_*` → `_b_.ModuleNotFoundError`/`GeneratorExit`/`UnboundLocalError`) and corrected the declaration to `int` (the impl already returned 0). `_common`/`bit_generator`/`_mt19937` now link 0-undefined. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **Cython: `PyVectorcall_Call` dispatches spec-based heap-type instances (Cython `def`s) through their stored vectorcall pointer — a compiled Cython module becomes CALLABLE (pandas `byteswap` works)** (bridge). Calling a Cython `def` (each is a `__pyx_CyFunctionType` instance) blew the JS stack with `Maximum call stack size exceeded`: `tp_call` → `__Pyx_CyFunction_CallAsMethod` → `PyVectorcall_Call`, whose fast path reads `tp_vectorcall_offset` at `typePtr+72`. That field exists only in full CPython type structs (numpy ufuncs); spec-built heap types use the bridge's compact 64-byte type struct, so `+72` read 0 → the slow `$B.$call` fallback re-entered `tp_call` = infinite recursion. `__wasthon_install_members` now records a heap type's `__vectorcalloffset__` member (the CPython special member Cython emits) as `cls.$wasthon_vectorcall_offset` (and skips installing `__vectorcalloffset__`/`__dictoffset__`/`__weaklistoffset__` as ordinary descriptors, matching PyType_FromSpec); `PyVectorcall_Call` consults it when `typePtr+72` is unset and invokes the instance's vectorcall pointer directly. `read_uint16_with_byteswap(b'\x01\x02…', 0, False)` → `513`; the pandas `byteswap` Cython module now runs and returns correct values end-to-end. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **Cython: `PyEval_GetBuiltins()` returns the builtins *dict*, not the module — Cython module init gets past `'module' object is not subscriptable`** (bridge). A Cython module's `__Pyx_init_assertions_enabled` does `PyObject_GetItem(PyEval_GetBuiltins(), "__debug__")`; the bridge returned the builtins *module* (subscripting a module raises `TypeError: 'module' object is not subscriptable`). CPython's contract is that `PyEval_GetBuiltins()` returns the builtins **dict** — C extensions do `PyDict_GetItem`/`PyObject_GetItem` on the result. Returns `get_dict(__builtins__)` (a real Brython dict carrying `__debug__`, `len`, `AssertionError`, …). Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58 — pickle/decimal hit `PyEval_GetBuiltins` on their reduce/context paths).

- [x] **numpy phase 8: install `__pow__`/`__rpow__` from the ternary `nb_power` slot on heap types — `ndarray ** x` / complex-scalar power work (+4 tests)** (bridge). `np.array([1,2,3]) ** 2` raised `TypeError: unsupported operand type(s) for **: 'ndarray' and 'int'` (add/sub/mul/floordiv/… all worked). Root: the heap-type number-slot installer wired the binary `nb_*` slots via `wrapBin`, but `nb_power` (offset 20 in `PyNumberMethods`) is a **ternary** slot `(a, b, modulo)` — `wrapBin` can't carry the third arg, so `nb_power` was skipped entirely and `__pow__`/`__rpow__` never landed on `ndarray` (or any C heap type). Added a `wrapPow` that calls the slot with `modulo = Py_None` for binary `a ** b` (CPython convention; numpy's `array_power` tests `modulo != Py_None`) and installs `__pow__`/`__rpow__`. `np.array([1,2,3]) ** 2` → `[1,4,9]`, `2 ** np.array([1,2,3])` → `[2,4,8]`; **test_umath_complex 323→326, test_half 11→12 (+4)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58 — decimal exercises `nb_power`).

- [x] **numpy phase 8: `PyObject_CallObject`/`PyObject_Call` on a bound builtin-type struct call its real Brython class — the two-arg complex scalar ctor `np.complex128(re, im)` works (+8 tests)** (bridge). `np.complex128(1, 2)` (and `np.csingle(1, 2)`) raised `TypeError: complex takes no arguments`; the one-arg forms `np.complex128(2)` / `np.complex128(1+3j)` worked. Root: numpy's `cdouble_arrtype_new` builds the two-part value with `PyObject_CallObject((PyObject *)&PyComplex_Type, args)`, but `handles[&PyComplex_Type]` is a bare `PyType_Ready` wrapper (its `tp_new`/`tp_init` are `object`'s) rather than the Brython `complex` class, so the call fell through to `object.tp_new` → "takes no arguments" (the one-arg path never calls `&PyComplex_Type`, which is why it worked). Both generic call entry points now redirect a bound builtin-type struct handle to its real Brython class via the same `builtinClassForStruct` reverse map used by `PyObject_GetAttr`. `np.complex128(1, 2)` → `np.complex128(1+2j)`; **test_scalar_ctors 184→192 pass (−8 fails)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **numpy phase 8: `PyArg_ParseTuple[AndKeywords]` handles the `#` length suffix (`s#`/`z#`/`y#`/`U#`) — `np.char`/`np.strings` comparisons parse their op string (+1 test)** (bridge). `np.char.equal(a, b)` (and every `np.char`/`np.strings` comparison) failed with `SystemError: format char '#' not implemented`: numpy's `compare_chararrays` parses `"OOs#O&:compare_chararrays"`, but the legacy varargs parser had no `#` case — it treated `s`, then hit `#` as an unknown format char and bailed. The `#` suffix means the buffer code is followed by a *second* out-pointer receiving the length (`Py_ssize_t`); the parser now detects it, writes the length (UTF-8 byte count for `s#`/`z#`/`U#` via `PyUnicode_AsUTF8AndSize`, raw byte count for `y#` via `PyBytes_AsStringAndSize`), consumes the extra varargs slot, and steps past the `#`. `np.char.equal(['a'], ['a'])` parses; **test_defchararray 11→12 pass (+1)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green (0 fails: test_re 154, test_pickle 941, test_decimal 357, test_pyexpat 58).

- [x] **numpy phase 8: `PyObject_GetAttr` on a bound builtin-type struct resolves to its real Brython class — `np.strings`/`np.char` case methods work (+2 tests)** (bridge). `np.strings.upper(arr)` (and the `np.char` family) raised `AttributeError: type object 'str' has no attribute 'upper'`. Root: numpy's `_vec_string` (`multiarraymodule.c`) does `PyObject_GetAttr((PyObject *)&PyUnicode_Type, method_name)` to fetch `str.upper`, but `handles[&PyUnicode_Type]` gets clobbered after `PyType_Ready` with a bare type-struct wrapper (its name is `'str'` but it is not the Brython `str` class and carries no method dict), so the getattr missed. `wasthon_bind_builtin_type` now keeps an authoritative reverse map `builtinClassForStruct` (struct ptr → real Brython class), and `PyObject_GetAttr` redirects to it when the target handle is a bound builtin-type struct. `np.strings.upper(np.array(['ab']))` resolves `str.upper`; **test_defchararray 9→11 pass (+2)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: wire `PyLong_Type.tp_as_number->nb_lshift` — float16/float32/longdouble `.as_integer_ratio()` works (+19 tests)** (bridge). `np.float16(1.5).as_integer_ratio()` (and float32/longdouble) crashed with `null function or function signature mismatch`; float64 was fine because it's a Brython `float` and skips numpy's C path. Root: numpy's scalar `@name@_as_integer_ratio` folds in `2**exponent` via `PyLong_Type.tp_as_number->nb_lshift(numerator, py_exponent)`, but the bridge's `wasthon_long_nb` (in wasthon.c) only wired `nb_multiply`/`nb_floor_divide`/`nb_power` — `nb_lshift` was NULL. Added `wasthon_long_nb_lshift` (`int.__lshift__`) and wired it. `np.float16(1.5).as_integer_ratio()` → `(3, 2)` for every float type; **test_scalar_methods 207→226 pass (−19 fails)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyCapsule_IsValid` checks the capsule name — `np.from_dlpack` works (+53 tests in test_dlpack)** (bridge). `np.from_dlpack(arr)` raised `BufferError: from_dlpack(): the exported DLPack major version is too high`. numpy's `from_dlpack` distinguishes the *versioned* vs *unversioned* DLPack capsule purely by name (`PyCapsule_IsValid(capsule, NPY_DLPACK_VERSIONED_CAPSULE_NAME)`), but the bridge's `PyCapsule_IsValid` was a permissive stub returning true for *any* capsule regardless of name — so an unversioned capsule was read as `DLManagedTensorVersioned`, `managed->version.major` came from the wrong struct offset (garbage > 1) → the version error. It now matches only a real capsule whose name equals the requested one (CPython semantics: both NULL or strcmp-equal), mirroring `PyCapsule_GetPointer`. Same family as the earlier `PyCapsule_CheckExact` fix. `np.from_dlpack(np.array([1,2,3]))` → `array([1, 2, 3])`; **test_dlpack 17→70 pass (−53 fails)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `wasthon_set_docstring` restores C-method `__text_signature__` / `__doc__` — `inspect.signature` works on numpy's C methods (+94 tests in test_scalar_methods)** (bridge; paired with the recipe change to `arr_add_docstring`). numpy ships its C methods/types with a NULL `ml_doc` and attaches the real docstring — including the argument-clinic text signature — at import via `numpy._core.multiarray.add_docstring(obj, doc)` (`_add_newdocs`). The stock C impl writes into the object's C struct (`tp_doc` / `m_ml->ml_doc` / …), which OOBs on our opaque handles, so the recipe used to no-op it — silently stripping every C-method `__text_signature__`/`__doc__`. `inspect.signature(np.generic.view)` raised "no signature found", `help()` was empty, and numpy's introspection tests failed en masse (they guard that scalar↔array methods expose identical signatures — real API-parity + IDE/doc tooling, not cosmetics). The recipe now parses `add_docstring`'s args safely and calls `wasthon_set_docstring(obj, docstr)`, which sets `obj.__doc__` and parses `"<name>($self, …)\n--\n\n…"` into `obj.$text_signature` (Brython's `inspect._signature_fromstr` reads it). `inspect.signature(np.generic.view)` → `(self, /, *args, **kwargs)`; **test_scalar_methods 113→207 pass (−94 fails)**. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyTuple_Pack` keeps a lazy handle for a not-yet-registered static pointer — `np.true_divide`/`divide` on scalars (and `np.percentile`) work** (bridge). `np.true_divide(50, 100)` / `np.divide(50, 100)` on Python-int scalars raised `RuntimeError: Only NumPy must call ufunc->type_resolver() explicitly.` (add/multiply/floor_divide were fine — division has a custom legacy `type_resolver`). Root: during import numpy caches division's type-tuple with `PyTuple_Pack(3, float64_descr, float64_descr, float64_descr)`, but the descr singleton isn't bound as a bridge handle yet at that point (the `_cType` side-table isn't even populated), so `unwrap` returned `null` and the cached tuple became `[null, null, null]`. Later, dispatching int scalars through the legacy division resolver fed those NULLs to `type_tuple_type_resolver`, whose `PyArray_DescrCheck(NULL)` failed → the defensive error. `PyTuple_Pack` now, when an item's non-zero pointer doesn't resolve yet, stores a lazy `{__wasthon_ptr__}` proxy instead of `null`; `PyTuple_GetItem` re-wraps it and by read time the pointer resolves to the real descr. `np.true_divide(50, 100)` → `np.float64(0.5)`; `np.percentile` advances past this wall (test_mixins 9→10 pass). Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PySlice_GetIndicesEx` coerces numpy-scalar slice bounds via `__index__` — `arr[np.int32(i):np.int32(j)]` / `np.pad` work** (bridge). Slicing a numpy array with numpy-integer bounds (`arr[np.int32(1):np.int32(3)]`, and every slice numpy builds internally — e.g. `np.pad`'s `_pad_simple` does `padded[slice(left, left+size)] = array` with `left`/`size` as np.int32) silently returned an EMPTY array, so `np.pad([1,2], 1)` died with "could not broadcast input array from shape (2,) into shape (0,)". Root: `PySlice_GetIndicesEx` read `slice.indices(len)` (which in Brython keeps the bound's original type, so np.int32 not plain int) through `Number(...)`; `Number(np.int32(1))` is `NaN`, and `NaN | 0` = 0, collapsing start/stop to 0. It now coerces each bound with `coerceInt` (honors `__index__`). `np.arange(10)[np.int32(1):np.int32(3)]` → `[1, 2]`; `np.pad(np.array([1,2]), 1)` → `[0, 1, 2, 0]`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: static C iterator types expose `__iter__`/`__next__` — `np.roll` (and iterating `np.broadcast`) works** (bridge). `np.roll(a, shift, axis=...)` raised `TypeError: 'broadcast' object is not iterable`: numpy's `broadcast` object (`PyArrayMultiIter_Type`) is a self-iterator with `tp_iter`/`tp_iternext`, but the static-type slot reader installed tp_repr/tp_hash/tp_call and never the iterator slots. Now, when a static type has a `tp_iternext` (offset 56), the bridge installs `__next__` (NULL→StopIteration) and `__iter__` (offset 24, or self-iter). Gated on `tp_iternext` so only real iterators are affected — iterable containers like ndarray (tp_iter but no tp_iternext) keep Brython's sequence-based iteration. `for sh, ax in np.broadcast(shift, axis)` works; `np.roll(np.arange(5), 2)` → `[3,4,0,1,2]`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: bridge-allocated instances of a Python subclass get an instance `__dict__` — `arr.view(Sub)` subclass instances can hold attributes** (bridge). A ndarray subclass instance built through numpy's own C `tp_alloc` (`arr.view(Sub)`, and numpy.ma's `MaskedArray.__array_finalize__` doing `self.__dict__.update(...)`) had no instance `__dict__`: `s.foo = 1` raised "'Sub' object has no attribute 'foo' and no __dict__", and reading `s.__dict__` failed. The bridge only initialized the per-instance dict on the `tp_new` subtype path, not in `wasthon_object_gc_new`/`_var` (which `tp_alloc`/`PyType_GenericAlloc` use). Added `maybeInitInstanceDict`: when a class has its OWN `__dict__` descriptor (Brython stamps one on user subclasses that carry an instance dict; base C types like ndarray don't have one), `gc_new`/`gc_new_var` now `init_dict` the instance. Base C-type instances are unaffected (`np.array([1]).__dict__` still raises AttributeError, matching CPython). `np.array([1.,2.]).view(Sub); s.foo = 42` now works. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyCapsule_CheckExact` only matches real capsules — `.view(subclass)` with a Python `__array_finalize__` works** (bridge). `arr.view(SubClass)` for any ndarray subclass that defines `__array_finalize__` (numpy.ma's `MaskedArray`/`MaskedConstant`, `np.matrix`, recarrays, unit libraries) failed with `RuntimeError: view: call returned NULL`, and the subclass's `__array_finalize__` never ran. Root: `PyCapsule_CheckExact` was a permissive stub returning true for *any* non-null object. numpy's `PyArray_NewFromDescrAndBase` (ctors.c) fetches the subtype's `__array_finalize__` and branches on `PyCapsule_CheckExact(func)` — a capsule means a C finalizer, otherwise a Python callable. Every Python `__array_finalize__` was mistaken for a capsule, so numpy took the C-func branch, `PyCapsule_GetPointer` gave 0, and it bailed to a silent NULL. `PyCapsule_CheckExact` now matches only `PyCapsule_New`'s `{__class__:'PyCapsule'}` objects (same test `PyCapsule_GetPointer` already uses). `np.array([1.,2.]).view(Sub)` runs `Sub.__array_finalize__` and a raising one now propagates its real exception instead of the masking RuntimeError. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: expose `nb_matrix_multiply` / `nb_inplace_matrix_multiply` — the `@` operator works on ndarrays** (bridge). `a @ b` on two ndarrays raised `TypeError: unsupported operand type(s) for undefined: 'ndarray' and 'ndarray'` and `a.__matmul__` didn't exist, even though `np.matmul(a, b)` (the ufunc) worked. The bridge's static-type `tp_as_number` reader mapped nb_add/nb_multiply/… but not the two matrix-multiply slots (`PyNumberMethods` offsets 136 and 140, added in Py3.5). Added `[136,'__matmul__','__rmatmul__']` and `[140,'__imatmul__',null]`; Brython's `@` dispatch then resolves. `np.arange(4).reshape(2,2) @ np.eye(2)` works. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `_PyObject_NewVar` actually allocates the var-object — `np.linspace` works** (bridge). `np.linspace` died with `JavascriptError: Cannot read properties of null (reading 'Symbol(DICT)')` at `function_base.py:131` (`start, stop = conv.as_arrays()`): `conv = _array_converter(start, stop)` came back `null`, so calling a method on it hit `$B.get_dict(null)`. Root: numpy's `array_converter_new` builds itself with `PyObject_NewVar(...)` → `_PyObject_NewVar(cls, narrs)`, which the bridge stubbed as `return 0` → `self == NULL` → the C `tp_new` returned NULL with no exception set. `_PyObject_NewVar` now delegates to `wasthon_object_gc_new_var` (allocs `basicsize + nitems*itemsize`, binds the handle, sets `ob_size`). Paired: `PyObject_Init`/`PyObject_InitVar` are now idempotent — `array_converter_new` re-inits the object it just `NewVar`'d, so they update the type in place when the pointer is already a bound handle instead of clobbering the richer wrapper (which carries `__wasthon_type__` + gc/refcount registration). `np.linspace(0, 1, 5)` → `array([0., 0.25, 0.5, 0.75, 1.])`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyObject_Init`/`PyObject_InitVar` bind the raw pointer to its type — `arr.flat` / `np.eye` / `np.diag` work** (bridge). `arr.flat` came across as JS `null` (`type(a.flat) == NullType`), so `np.eye`/`np.diag` — which do `m[:n].flat[i::step] = 1` — died with `'NullType' object does not support item assignment`. Root: numpy's `PyArray_IterNew` allocates a `PyArrayIterObject` with raw `PyArray_malloc` then `PyObject_Init((PyObject*)it, &PyArrayIter_Type)` (it does NOT go through `tp_alloc`, whose bridge path `_PyType_AllocNoTrack` → `_PyObject_Init` already binds the type). The public `PyObject_Init`/`PyObject_InitVar` were no-ops returning the pointer untyped, so `unwrap` found no handle and yielded `null`. They now register `{__wasthon_ptr__, __class__, ob_type}` for the pointer exactly like `_PyObject_Init`. `a.flat` is a real `flatiter` (read/slice/scalar+slice assignment all work); `np.eye(3)` and `np.diag([1,2,3])` return correct arrays. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyContextVar_New` creates a real Brython `ContextVar` — `np.errstate` / float-array repr / `np.ones`/`np.sqrt` work** (bridge). The bridge minted C-created context vars as bare `{value}` shims; numpy's C makes `_extobj_contextvar` (the ufunc error-state var) that way, then its PYTHON code calls `.set()`/`.reset()` on it (`errstate.__enter__` → `_extobj_contextvar.set(extobj)`). A shim has no such method → `'…' object has no attribute 'set'`, which surfaced through `FloatingFormat.fillFormat`'s `with errstate(over='ignore')` and broke the repr of any float array with non-zero values (`np.ones((2,2))`, `np.sqrt(...)`, `np.linspace`). `PyContextVar_New` now builds an actual `contextvars.ContextVar` (with the C default), and `PyContextVar_Set` goes through its real `.set()`, so C-side and Python-side reads/writes share one object. `np.ones((2,2))`, `np.sqrt([1,4,9])` → `array([1., 2., 3.])`, and `np.linalg.inv(...)` now raises its clean stub `NotImplementedError` instead of the masking AttributeError. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyContextVar_Get` reads a real Brython `ContextVar` via `.get()` — numpy scalar `repr()` works** (bridge). numpy's `format_options` is a `contextvars.ContextVar` created in `printoptions.py`; its C scalar repr (`gentype_repr` → `get_format_options` → `PyContextVar_Get`) got NULL back because the bridge's `PyContextVar_Get` only understood its own `{value}` ContextVars — a real Brython ContextVar has `value === undefined` (and, here, `__class__ === undefined` too), so it fell through to a NULL result → "NumPy internal error: unable to get format_options context variable" (array repr was fine — it reads the var through Python `.get()`). It now, when the var isn't a bridge one, calls the object's `.get()` (with the C default if supplied). `repr(np.int32(1))` → `np.int32(1)`, `repr(a.max())` → `np.int32(4)`, `repr(a.std())` → `np.float64(1.118033988749895)`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyFloat_Type.tp_new` is wired — numpy float scalar construction / `a.mean()` works** (bridge). numpy's `double_arrtype_new` (the `np.float64` constructor) delegates to `PyFloat_Type.tp_new(subtype, args, kwds)` and returns the result, but the bridge's `PyFloat_Type` struct had a 0 `tp_new` slot → "null function or function signature mismatch" when `_mean` did `ret.dtype.type(ret / rcount)`. Added `wasthon_builtin_float_tp_new` (mirrors the existing `PyTuple_Type.tp_new`), building a Brython float from the single optional arg. `array([1,2,3,4]).mean()` → `2.5`, `.astype(float).mean()` → `2.5`, `.cumsum()` → `array([1, 3, 6, 10])`. (A perfect `np.float64` scalar *identity* — vs a plain float of the right value — is the scalar subsystem's remaining polish.) Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyFloat_Check` stops matching Brython ints — numpy int-argument converters accept ints** (bridge). `wasthon_isinstance_of_builtin(o, FLOAT)` returned 1 for any `typeof o === 'number'`, but a raw JS *integer* number is a Brython `int` (floats are boxed `{__class__: float, value}`, already matched by the exact-class check above). So `PyFloat_Check(0)` was true, and numpy's `PyArray_PythonPyIntFromInt` (which does `if (PyFloat_Check(obj)) error "integer argument expected, got float"`) rejected every integer `axis`/`ndim` — `a.mean()` died in `_count_reduce_items`'s `normalize_axis_index(0, 1)`. Guarded the raw-number float match with `!Number.isInteger(obj)`. General: any numpy (or other C) API that float-checks an int argument was affected. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `Py_SET_TYPE` no longer prematurely materializes a static object — numpy scalar comparison (`==`/`<`/`>`) works** (bridge, paired recipe). Now that `unwrap` materializes `_cType` pointers, `_wasthon_Py_SET_TYPE`'s `unwrap(oH)` (used to detect a live handle) would, for a static C-struct being registered, build+cache a wrapper *before* its type class exists — leaving a permanent classless wrapper. numpy's `np.bool_` singletons (`_PyArrayScalar_BoolValues`) hit this: a recipe patch `Py_SET_TYPE`s them (like the dtype descrs), but `initialize_numeric_types` runs before `PyBoolArrType_Type` is bound, so the eager wrapper had `__class__ == undefined` → `int32(1) == 2` came back as a truthy JS object (both True and False looked true). `Py_SET_TYPE` now uses a raw `handles.get` (never materializes); the singletons stay side-table-only and materialize lazily at first real use, once `np.bool_` is bound. `int32(1) == 1` → `np.True_`, `int32(1) == 2` → `np.False_`, `a[0] > 0` → `np.True_`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyArg_VaParseTupleAndKeywords` delegates to the non-va parser — `ndarray.reshape` (and every method using `NpyArg_ParseKeywords`) works** (bridge). The va-list variant was a `return 0` stub ("the va-list ABI is unreachable from JS"), but in emscripten a `va_list` is just a pointer to the same sequential 4-byte varargs slots the non-va `PyArg_ParseTupleAndKeywords` already walks. numpy's `NpyArg_ParseKeywords` (used by `array_reshape` for its `order`/`copy` keyword-only args, and by many other methods) is `PyArg_VaParseTupleAndKeywords` under the hood, so the stub made `a.reshape(2, 2)` return NULL with no exception set → "reshape: call returned NULL". It now forwards `va` straight through as the varargs pointer. `array([1,2,3,4]).reshape(2, 2).tolist()` → `[[1, 2], [3, 4]]`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: `PyVectorcall_Call` does real vectorcall dispatch — ndarray arithmetic (`a+b`) and `repr(array)` work** (bridge). numpy's `ufunc` type sets `tp_call = &PyVectorcall_Call` and `tp_vectorcall_offset = offsetof(PyUFuncObject, vectorcall)`. The bridge's `PyVectorcall_Call` re-dispatched through `$B.$call(callable, …)` — which resolves the callable's `__call__`, which the PyType_Ready tp_call wiring points BACK at `PyVectorcall_Call` → unbounded recursion: `a+b`/`a*b` and `repr(array)` (arrayprint drives element formatting through ufuncs) blew the JS stack ("Maximum call stack size exceeded"), as did `numpy.lib._scimath_impl` at import. It now honors the vectorcall protocol: read `tp_vectorcall_offset` from the callable's type (offset 72), the `vectorcallfunc` from the instance at that offset, and call it directly with the fastcall ABI (positionals + kwnames tuple marshaled into a linear-memory `PyObject*[]`), falling back to `$B.$call` only when there is no vectorcall slot. `array([1,2,3,4]) + b` → `[11,22,33,44]`, `a*b` → `[10,40,90,160]`, `repr(a)` → `array([1, 2, 3, 4])`, `str(a)` → `[1 2 3 4]`. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: DType class hierarchy + `Py_T_CHAR`/longlong members — `numpy._core` imports fully (into `_typing`/`linalg`/`matrixlib`/`lib`)** (bridge). Two roots, both in `PyType_Ready`'s static-type path. (1) **Recursive base readying**: numpy readies a concrete DType (`Int32DType`) inside `set_typeinfo` with `tp_base = &PyArray_IntAbstractDType`, but that abstract superclass isn't readied until `initialize_and_map_pytypes_to_dtypes` runs LATER — so `unwrap(tp_base)` was null and the subclass silently fell back to `object` (`Int32DType.__mro__` lacked `numpy.dtype`, so descr `.type`/`.kind`/… members were unreachable and `_type_aliases`' `v.type` raised `AttributeError`). CPython's `PyType_Ready` readies the base recursively; the bridge now does too when `tp_base` names a real, not-yet-materialized type. (2) **`Py_T_CHAR`/`Py_T_LONGLONG`/`Py_T_ULONGLONG`/`Py_T_DOUBLE`/`Py_T_FLOAT` members**: the member getter switch stopped at `Py_T_UBYTE` (12), so a `numpy.dtype`'s `.kind`/`.char`/`.byteorder` (`Py_T_CHAR` = 15) and `.flags` (`Py_T_ULONGLONG`) raised `SystemError: unsupported PyMemberDef type: 15`. Added the five missing scalar reads (char → 1-char str, longlong pair → BigInt). With both, `_type_aliases`/`numerictypes`/`numeric`/`arrayprint`/`records`/… all import and the cascade reaches numpy's outer packages. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy phase 8: static dtype descrs cross the bridge as real objects — `unwrap` materializes `_cType` pointers on demand** (bridge). numpy's builtin dtype descrs live in `_builtin_descrs[]` as static C structs and are never bound as bridge handles, so any descr pointer that reached Python as a *value* came across as JS `null`: `_multiarray_umath.typeinfo` (used by `_type_aliases.py`) had all 58 values null, `array([1,2,3]).dtype` was null, `repr(dtype)` was impossible. `unwrap(h)` now, when `h` misses the handle table but is present in the `_cType` side-table (a typed C-struct recorded by `Py_SET_TYPE`), materializes a Brython wrapper on demand — `{__wasthon_ptr__: h, __class__: <the dtype class>}` bound back into the handle table for identity — so the descr's class getset/method trampolines can reach the C struct through `__wasthon_ptr__`. With this, `typeinfo` values are real `BoolDType`/`Float16DType`/… instances, `array([1,2,3]).dtype` is an `Int32DType`, and `repr()` works. (Next wall: those concrete DType classes inherit `object` instead of `numpy.dtype`, so the descr `.type`/`.kind`/… members aren't found yet.) Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green — `_cType` is numpy-only, so the new branch never fires for them.

- [x] **numpy phase 8: `tp_dictoffset` instances get a real per-instance `__dict__` — numpy sets `ufunc.__module__`/`__qualname__` and wraps its dispatchers** (bridge). Importing `numpy._core.multiarray` runs `_override___module__()`, which does `ufunc.__module__ = "numpy"; ufunc.__qualname__ = name` for ~90 ufuncs, and `overrides.py` builds `_ArrayFunctionDispatcher(...)` then `functools.update_wrapper(dispatcher, impl)` (which READS `dispatcher.__dict__`). Both numpy types carry a non-zero `tp_dictoffset` (CPython gives their instances a real `__dict__`; `PyObject_GenericSetAttr`/`GenericGetAttr` use it), but the bridge's `PyType_Ready` materialized only a `__getattr__` fallback over the C-side dict — Python-side attribute *writes* raised "`'ufunc' object has no attribute '__module__' and no __dict__ for setting new attributes`" and reading `.__dict__` before any write raised "`'_ArrayFunctionDispatcher' object has no attribute '__dict__'`". Now, when `tp_dictoffset != 0`, the materialized Brython class is marked `$slots_has_dict` (so `object.tp_setattro` lazily creates the instance dict on first out-of-slots setattr, descriptor precedence intact) and gets a `__dict__` getset that AUTO-CREATES the instance dict on read (CPython returns a fresh empty dict; Brython's `object_get_dict` returned `undefined` until the first write). With this `numpy._core.multiarray` imports fully. Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green. (Paired recipe: `arr_add_docstring` no-op — its type/descriptor struct-field writes would deref a bridge handle as a pointer.)

- [x] **★★★ numpy CORE BOOTS: `_multiarray_umath` fully initializes and creates functional ndarrays** (recipe). The last mod_exec wall was a DType-identity check in the umath dispatcher (`DType tuple may only contain None and DType classes`): the ABSTRACT DTypes (`PyArray_IntAbstractDType`/`FloatAbstractDType`/`ComplexAbstractDType`/`PyLongDType`/`PyFloatDType`/`PyComplexDType`) are readied outside `dtypemeta_wrap_legacy_descriptor`, so they never got the metatype the shim's `PyVarObject_HEAD_INIT({0},0)` discarded — a recipe patch adds `Py_SET_TYPE(&X, &PyArrayDTypeMeta_Type)` after each of the 6 `PyType_Ready`s. With that, `_multiarray_umath`'s mod_exec runs to completion and `wasthon_module_create` returns a real module carrying `ndarray/dtype/zeros/array/_ARRAY_API/flatiter`. Functional smoke (numpy-probe/boot4.mjs): `array([1,2,3])` builds an `ndarray` with `.shape==(3,)`, `.ndim==1`, `.size==3`. Remaining gaps are the numpy PYTHON layer (`.sum()` wants ufunc-reduction imports, `repr()` wants `numpy._core.arrayprint`), not the C core.

- [x] **numpy phase 7: `tp_call` → `__call__` in PyType_Ready — numpy ufuncs are callable** (bridge). The static-type `PyType_Ready` path materialized tp_repr/str/hash/richcompare/number/sequence/mapping but NOT `tp_call`, so a numpy ufunc (`add`, `multiply`, … — callable via the tp_call slot) had no `__call__` on its Brython class, `callable(ufunc)` was false, and numpy's `_PyArray_SetNumericOps` rejected every op (the `SET` macro's `PyCallable_Check`). Wired tp_call@offset 100 → `__call__` with the same args-tuple/kw-dict marshaling as the FromModuleAndSpec path. Found by bisecting mod_exec with printf markers: the silent -1 was `initumath → _PyArray_SetNumericOps → SET(add) → !PyCallable_Check`. mod_exec now runs into umath ufunc/promoter setup (next: "DType tuple may only contain None and DType classes" — another DType-identity check).

- [x] **numpy phase 6: scalar-shells progress — `bool`/`float`→C-scalar conversion, `PyFloat_AsDouble` booleans** (bridge + recipe). The bridge hands numpy plain JS primitives (a `float` as a JS number, a `bool` as a JS `boolean`) where numpy's C expects Python objects, so `LONGDOUBLE_setitem`'s fallback `string_to_long_double` (which handles only PyLong/str) failed on them. `PyFloat_AsDouble` now converts a JS boolean (`True`→1.0), and a recipe patch routes any non-string through `PyFloat_AsDouble` in `string_to_long_double` (covers float/bool/`__float__`). With this, `_multiarray_umath` mod_exec runs past the whole longdouble/scalar-conversion path; it now stops at a deeper mod_exec step returning -1 without a set exception (the long tail of numpy init). The full scalar-identity work (numpy scalars as typed objects with `Py_TYPE == ArrType_Type` and a readable C value) remains for making `PyArray_IsScalar` true rather than relying on primitive conversions.

- [x] **numpy phase 5: scalar number-protocol slots — `int(np.int32)` / `float(np.float64)` / `operator.index()` work** (bridge). The bridge's `PyType_Ready` (static-type path) materialized arithmetic dunders (`__add__`/`__neg__`/`__bool__`…) from `tp_as_number` but not the CONVERSION slots, so numpy's scalar types exposed no `__int__`/`__index__`/`__float__` — and Brython's `int()` (which correctly dispatches to those dunders) rejected an `int32` with "argument must be … not 'int32'". Added `nb_int`@64 → `__int__`, `nb_float`@72 → `__float__`, `nb_index`@132 → `__index__` (unary wrappers), plus the bitwise binaries `nb_lshift`/`rshift`/`and`/`xor`/`or` and `__rmod__` that numpy scalars use. With this, `_multiarray_umath` mod_exec proceeds past scalar setup into cast initialization (numpy's debug `assert(PyArray_DescrCheck(...))` in dtype_transfer.c requires building with `-DNDEBUG`, which is how the manylinux wheels ship anyway) and stops at longdouble string parsing (`NumPyOS_ascii_strtold` gets an empty C string — a bridge PyUnicode→bytes buffer question, next).

- [x] **numpy phase 4: the C core boots deep into runtime init — real `Py_SET_TYPE`, DTypeMeta metatype side-table, PyArg `$`** (bridge). With the numpy Python package seeded into Brython (numpy.exceptions/_globals/_core._exceptions/printoptions/dtypes load and RUN on wasthonf), `_multiarray_umath`'s mod_exec runs `initialize_static_globals`, then the whole dtype system: `PyType_Ready` on the static DType classes, sort/cast ArrayMethod registration for every builtin dtype. Two metatype walls fell: (1) numpy's builtin dtype descrs are static C structs in linear memory (`_builtin_descrs[]`), never Brython handles — `Py_SET_TYPE(descr, dtype_class)` now records the type in a raw-pointer side-table (`_cType`) that `Py_TYPE`/`wasthon_get_type_of` consults FIRST (the bridge `PyObject` has no `ob_type` slot to carry it); (2) the DTypeMeta classes themselves lose their metatype because `PyVarObject_HEAD_INIT(&PyArrayDTypeMeta_Type, 0)` expands to `{0},0` under the shim — a recipe patch adds `Py_SET_TYPE(dtype_class, &PyArrayDTypeMeta_Type)` after `PyType_Ready` so `type(np.dtypes.Float16DType)` resolves. `Py_SET_TYPE` went from a no-op macro to a real bridge fn (rebinds the Brython class + `__wasthon_type__` for handle objects, side-table for C structs). PyArg format char `$` (PEP 3102 keyword-only marker) added. Boot now reaches numpy scalar↔int conversion (int32 → int, the scalar-value subsystem, next). Existing ports (_sre/_pickle/_decimal/pyexpat) rebuilt green.

- [x] **numpy compile surface: the shim headers now compile the ENTIRE numpy 2.5.1 core (~150 files) — link contract = 87 known symbols** (numpy port phase 2 begins; shim + one bridge function). What the compile probe surfaced, layer by layer: CPython sub-headers modules include directly (`pymem.h`, `pyerrors.h`, `frameobject.h` as forwarders, `datetime.h` copied from CPython — its `PyDateTime_CAPI` capsule is a later bridge item), `patchlevel.h` with `PY_VERSION_HEX` (without it numpy's vendored pythoncapi-compat silently fell back to Python-2-era code paths — `PyString_*`), `PY_LONG_LONG` (its absence disabled numpy's whole `NPY_LONGLONG_FMT`/`SUFFIX` block), `Py_USING_UNICODE`, upper-case `PyMem_*` aliases, `PyMemAllocatorDomain`, `PyBUF_WRITEABLE` spelling, legacy `ssizessize*` slot typedefs and `T_CHAR/T_PYSSIZET/T_(U)LONGLONG` member codes, `PyAPI_FUNC/PyAPI_DATA`, `Py_GCC_ATTRIBUTE`, `Py_REFCNT/Py_SET_REFCNT`, CPython-3.14-shaped `PyHeapTypeObject` (numpy's `PyArray_DTypeMeta` embeds it by value), `PyCFunctionObject`/descriptor structs (numpy reads `m_ml`/`d_getset` for docs), faithful `PyASCIIObject`/`PyCompactUnicodeObject`/`PyUnicodeObject` shapes (the unicode SCALAR embeds `PyUnicodeObject` by value), `tp_is_gc` appended at the END of `PyTypeObject` (existing JS-side field offsets untouched), `struct _ts` gains its `interp` field (numpy's sub-interpreter guard), plus ~40 extern declarations for the phase-0 missing-at-link list (implementations land by batches). One real bridge function: **`Py_GenericAlias`** now calls `types.GenericAlias` through the runtime instead of the old `#define ((void*)0)` stub — sre's `__class_getitem__` becomes real. Existing ports re-verified after the header surgery: `_sre`, `_pickle`, `_decimal`, `pyexpat` all build and link green.

---

- [x] **`_PySys_GetSizeOf` was a 0 stub — the C side of every sizeof comparison undercounted** (+2 pickle SizeofTests with the vendored object/bytes `__sizeof__` halves; bridge). `Pickler.__sizeof__` adds `_PySys_GetSizeOf(self->output_buffer)` to its own struct-and-memo total, and the test compares that against `sys.getsizeof(b'x'*4096)` computed Python-side — with the stub returning 0 the two sides could never agree. It now does what `sys.getsizeof` does: delegate to the object's `__sizeof__` (real for wasthon C instances via the method trampoline, and for the vendored str/bytes), so both sides of the comparison take the same path; 0 on failure keeps the old skip-the-preallocation-hint behaviour for sizeless objects.

- [x] **libexpat 2.6.4 → 2.8.2 — pyexpat's billion-laughs allocation limiter goes live** (+12 pyexpat, the whole `MemoryProtectionTest` class ("requires Python compiled with Expat >= 2.7.2"); build, with a small bridge-shim alignment). CPython 3.14's pyexpat exposes `SetAllocTrackerMaximumAmplification`/`SetAllocTrackerActivationThreshold` only against expat ≥ 2.7.2; the vendored 2.6.4 predated them, so the twelve tests self-skipped. Two seams surfaced by the bump: (1) newer pyexpat.c seeds `XML_SetHashSalt16Bytes` from `_Py_HashSecret.expat.hashsalt16` — our `pycore_pyhash.h` shim (fixed-seed by design) gains the field with CPython's exact layout and a fixed non-zero pattern; (2) expat 2.8's configure detects `getentropy` on emscripten, which compiles but fails at link (`writeRandomBytes_getentropy`) — added `HAVE_GETENTROPY` to the existing false-positive undef list in `ensure_expat` (the entropy fallback stays `XML_POOR_ENTROPY`, DoS-mitigation not crypto). Five of the twelve also needed the vendored f-string line-continuation fix (BRYTHON_FIX.md) — the test builds its attack payload with `textwrap.dedent(f"""\…`. Cost: +8 919 bytes of wasm (3 226 387 → 3 235 306), .mjs unchanged.

- [x] **`Compress.copy()`/`Decompress.copy()` were compiled out — `HAVE_ZLIB_COPY` was never defined** (+4 zlib, test_compresscopy/test_decompresscopy/test_badcompresscopy/test_baddecompresscopy; build). CPython's `zlibmodule.c` guards `copy`/`__copy__`/`__deepcopy__` behind `#ifdef HAVE_ZLIB_COPY`, which configure detects from `deflateCopy`/`inflateCopy` — present in every zlib ≥ 1.2, including emscripten's bundled port. Our compile line never defined it, so the methods didn't exist and the four tests self-skipped on `hasattr` ("requires Compress.copy()"). Same family as sqlite3's `PY_SQLITE_HAVE_SERIALIZE` gap: a feature the bundled C library ships, gated off by a missing configure-style define. One `-DHAVE_ZLIB_COPY`; the tests un-skip themselves. Cost: +2 858 bytes of wasm (3 223 529 → 3 226 387), zero on the .mjs glue.

- [x] **`PyUnicode_DATA`/`KIND`/`GET_LENGTH` did O(len) JS work per call — DATA walked every codepoint (building a disposable array of them) *before* its cache lookup, GET_LENGTH re-counted codepoints every time** (bridge; with the recursion guard these were the "hang" of the 500k-nesting json decode). The kind computation ran unconditionally just to pick DATA's cache slot, and the scanner calls DATA, KIND and GET_LENGTH at *every* nesting level: the 3.5 MB test input was re-walked (3.5M chars, plus a 3.5M-entry throwaway JS array in DATA's case) about 4000 times per assert — minutes of busy loop indistinguishable from a dead page, even though the actual scan stops at the recursion cap after ~24k characters. All three now share one per-string cache entry ({kind, ptr, cplen}, filled lazily — a string's kind and codepoint count are content-determined), and GET_LENGTH takes the native fast path (no surrogates ⇒ codepoints == UTF-16 units). Same lesson as the `PyList_GET_ITEM` fix below: on a bridge hot path, the work the cache is supposed to save must not run before the cache is checked.

- [x] **`Py_EnterRecursiveCall` was a no-op, so unbounded C recursion hit the wasm stack as an uncatchable trap** (+4 json + 1 pyexpat with the harness un-gating: 500k-deep decoding and the endless encoder across both scanner flavors, plus pyexpat's deeply-nested content model; bridge). The header stub returned 0 with the comment "never overflows in practice" — but `_json`'s scanner and encoder recurse per nesting level, and a 500k-deep input rides the 4 MB wasm stack into a trap that kills the page (CPython skips these tests on its own emscripten builds for exactly this reason: its C guard has no stack headroom there). The macros now route to a bridge depth counter — cap 4000 ≈ CPython's `Py_C_RECURSION_LIMIT`, a ×5 margin under the stack — that raises CPython's `RecursionError` with the call-site suffix ("maximum recursion depth exceeded while decoding a JSON object…"), defensively reset at the outermost handle-scope close. `_pickle`'s deep-recursion paths ride the same guard for free.

- [x] **`PyList_GET_ITEM`'s materialisation cache was single-slot, so a list loop whose element saves touch any other container re-materialised the whole outer buffer per element — O(n²) bytes, a +413 MB wasm-heap peak for a 10k-object dump whose pickle is 313 KB** (the third root behind the delayed-writer page poison; bridge). `PyList_GET_ITEM(list, i)` compiles to `wasthon_list_items(list)[i]`, which materialises the entire list as a `PyObject*[n]` in linear memory; the one-entry cache made a tight loop O(n), but `_pickle`'s `batch_list` saves each element between two GET_ITEMs — the inner containers of every item evicted the slot, so each iteration re-malloc'd the full 40 KB outer buffer, and none of them was ever freed (measured quadratic: N=4k → +53 MB, 6k → +156 MB, 10k → +413 MB; four dumps filled 1.57 GB and the suite behind died on an exhausted 2 GB wasm32 heap). The cache is now keyed per array (a `Map`), and each buffer is registered in the handle scope of the C call that materialised it and freed at that scope's close — C pointers from GET_ITEM die with the C call, exactly like sentinel handles; `Py_SET_SIZE` still flushes buffer writes back into the Brython list and drops the entry. With all three roots fixed a 10k-object dump+loads cycle runs at *flat* heap (16 MB boot-baseline, unchanged) and clean handle counts.

- [x] **`PyDict_SetItem`/`PyObject_SetItem` took CPython's "container ref" on key and value — unreleasable for a Brython container, so every C-loaded dict entry pinned two handles forever** (the loads half of the pickle delayed-writer handle leak; bridge). CPython's no-steal contract has the container take its own ref, released at container dealloc — but a Brython dict stores the JS *value* (owned by the JS GC through the container) and never deallocs, so the bridge ref taken at set-time could never be given back: `_pickle`'s `do_setitems` builds every loaded dict through `PyObject_SetItem`, leaking one pinned handle per key and per value (measured: loads of 2000 `{str: int}` dicts left exactly 4000 pins; bisected by data shape — a list of strings loads clean, a list of dicts leaks 2/entry). Both setters now take the container ref only for struct-backed instances (`__wasthon_ptr__` — the instance-exempt rule of `consumeResultRef`), whose refcount drives `tp_dealloc`: dropping those to 0 under a live JS ref would free the struct under the stored wrapper. Plain Brython/JS values need no bridge ref — the container itself keeps them alive, and a later C read re-wraps fresh.

- [x] **A Brython-held C `Pickler`/`Unpickler` never died, so its memo pinned ~5 handles per (sub)object pickled** (the dump half of the pickle delayed-writer handle leak; bridge). The C memo takes a ref per memoized object, released only at `tp_dealloc` — which for a pickler *held by Brython code* (`p = _pickle.Pickler(f); p.dump(...)`) never fires: Brython has no refcounting, so the bridge never learns the instance dropped (module-level `dumps`/`loads` were immune — their internal pickler dies by C refcount inside the call). A 10k-object dump left ~50k pins; the delayed-writer pair leaked ~300k handles across the suite. `_pickle.Pickler`/`_pickle.Unpickler` are now registered `$wasthon_gc_finalizable` — the same opt-in as sqlite3's Connection/Cursor (they are resource holders of the same nature), so `support.gc_collect()`'s partial GC finalizes unreachable ones: measured, a dump's 10k pins drop back to baseline at the first collect after the pickler goes unreachable.

- [x] **`_PyBytes_Resize` read `newsize` bytes from the *old* allocation — past the block, and past the END of linear memory when the block sat near the heap top, so a big `dumps` blew up "at random"** (+1 pickle, InMemoryPickleTests.test_optional_frames unskipped; bridge). The cstr branch materialized the resized bytes by reading `HEAPU8[ptr + i]` for `i < newsize`; on `_pickle`'s output-buffer doubling (`_Pickler_Write` grows before writing on) `newsize` is up to twice the old block. The overrun read junk-but-defined bytes while memory existed beyond — but a typed array reads out of bounds as **`undefined`**, so once `ptr + newsize` crossed the memory end, `bytes.$factory(newArr)` raised `TypeError: 'UndefinedType' object cannot be interpreted as an integer` at the `pickle.dumps` call site. Whether it detonated depended purely on where the buffer sat in the heap — this was the long-hunted pickle "inter-test poison": CPicklerTests' 1.3 MB dumps pushed the allocation high-water to the top, so the *next* in-memory dump's buffer landed close enough to the edge for its doubling read to cross it (every standalone probe green, deterministic failure in suite context; nothing was actually poisoned — the trigger was heap geography). The copy is now clamped to the tracked allocation (`__wasthon_cstr_size__`, defensively the heap end) with a zero-filled tail, which is exactly CPython's contract — `_PyBytes_Resize` only preserves the old content. The delayed-writer C variants share the *symptom* but not the root: they now pass their own asserts, yet their 10k-object framed dumps leak ~300k pinned handles and ~1.6 GB of wasm heap (measured), failing the suite behind them — that pickler leak is the remaining, separately-documented work.

- [x] **`Py_TPFLAGS_DISALLOW_INSTANTIATION` was ignored — calling an iterator class minted a hollow instance** (+1 array test_disallow_instantiation; bridge). A spec type carrying the flag (array iterators, sqlite3 statements…) fell through to `object.tp_new` and produced a struct-less instance; `PyType_FromModuleAndSpec` now installs a tp_new raising CPython's `TypeError: cannot create 'arrayiterator' instances`.

- [x] **`PyObject_GetBuffer` dereferenced a NULL view — now CPython's BufferError guard** (backs test_obsolete_write_lock × 14 via the harness `_testcapi.getbuffer_with_null_view` mirror; bridge). A NULL `view` made the C write its Py_buffer fields at address 0..44 in linear memory; CPython rejects it with `BufferError: PyObject_GetBuffer: view==NULL argument is obsolete` — so does the bridge now.

- [x] **`_PyObject_SIZE` was a stub — `__sizeof__` reported 4 bytes; now the real tp_basicsize in CPython-canonical units** (+28 array, test_sizeof_with_buffer/test_sizeof_without_buffer × 14 typecodes, with the vendored `sys.getsizeof` and the harness's real `check_sizeof`; bridge). The macro returned `sizeof(void*)`, so `array.__sizeof__()` said 4. The basicsize lives JS-side (the 64-byte C type struct has no tp_basicsize field), so the macro now calls a `wasthon_basicsize` library helper; and because wasthon's PyObject header deliberately has no ob_type pointer (the type lives JS-side), the compiled struct is one pointer smaller than CPython's layout for the same object — the helper adds that pointer back, so the numbers land exactly on CPython's documented sizes (`sys.getsizeof(array.array('i'))` = 32 on wasm32, +itemsize×allocated with content). `_struct.__sizeof__` rides the same macro.

- [x] **weakref cells on C instances now die — `$wasthon_weakref_track` + clearing at `gc.collect()` / refcount death** (+14 array, test_weakref × 14 typecodes, with the vendored `_weakref` companion; bridge). `p = weakref.proxy(a); del a; gc.collect()` must make `len(p)` raise ReferenceError; Brython's `_weakref` keeps a strong reference and nothing ever cleared it. The vendored `proxy()`/`ref()` hand the bridge the cell and a Python `clear` closure (proxy raises ReferenceError, `ref()` returns None, the callback fires) via `$wasthon_weakref_track`; the bridge keeps them in a `weakRegistry` keyed by instance pointer and decides only WHEN: unreachable at the explicit `gc.collect()` mark (the partial-GC sweep, now also armed when only the weak registry is non-empty) or refcount death (`PyObject_GC_Del`). The mark must not traverse the weak cells themselves — a proxy sitting in a live frame would otherwise keep its referent reachable forever (CPython's GC doesn't traverse weak references either) — so tracked cells are skipped. Clear-only on the unreachable path: it never frees, so an imprecise mark can at worst clear a cell early, never corrupt memory.

- [x] **`Connection.serialize`/`deserialize` were compiled out — a build-flag gap plus a missing `PyBuffer_FillInfo`** (+3 sqlite3, test_serialize_deserialize/test_deserialize_wrong_args/test_deserialize_corrupt_database; bridge/build). CPython's `_sqlite/connection.c` guards the serialize API behind `PY_SQLITE_HAVE_SERIALIZE`, which the module compile never defined — `hasattr(Connection, "serialize")` was False and the three SerializeTests skipped, although the bundled amalgamation ships the API (default since SQLite 3.36), so exposing it costs almost nothing. Defining it surfaced the next gap: the deserialize clinic wraps its argument through `PyBuffer_FillInfo`, which the bridge did not implement — added as the pure-C struct fill mirroring `PyObject_GetBuffer`'s field discipline (`view->obj` unrefcounted, the handle stays alive JS-side). FTS3/FTS4 was tried alongside (for `test_dump_virtual_tables`) and dropped: ~89 KB of wasm for the legacy full-text generation when FTS5 is already shipped — that one test is skipped by design instead, like the OpenSSL-vs-HACL family.

- [x] **`PyUnicode_DecodeASCII` ignored its `errors` argument, so a non-ASCII protocol-0 persistent ID didn't raise** (+1 pickle, test_protocol0_is_ascii_only; bridge). Protocol 0 requires persistent IDs to be ASCII; the C Unpickler decodes the PERSID payload with `PyUnicode_DecodeASCII(..., "strict")` and turns a failure into `UnpicklingError: persistent IDs in protocol 0 must be ASCII strings`. The bridge decoded every byte 1:1 regardless of `errors`, so a `>0x7F` byte passed through and the load succeeded. It now raises `UnicodeDecodeError` for a `>0x7F` byte under `strict` (the default and the only mode the unpickler uses).

- [x] **`PyImport_Import` and `PyObject_GetAttr` returned NULL without an exception for a non-str name, losing the error at the C boundary** (+2 pickle with the vendored `__import__` type-check, test_find_class × C/Py; bridge). `Unpickler.find_class(None, 'log')` / `find_class('math', None)` must raise TypeError; both bridge functions silently returned 0 for a non-str name, so the method trampoline surfaced the generic `RuntimeError: find_class: call returned NULL`. They now set CPython's errors — `module name must be a string` and `attribute name must be string, not 'NoneType'`.

- [x] **`PyUnicode_AsUTF8String` silently replaced lone surrogates, so proto-3 identifier checks never raised** (+2 pickle, test_nonencodable_global/module_name_error; bridge). `save_global` at protocol 3 encodes module and global names with `PyUnicode_AsUTF8String` and turns a `UnicodeEncodeError` into `PicklingError("can't pickle global identifier …")` with the original chained as `__context__` — but the bridge encoded via `TextEncoder`, which replaces a lone surrogate with U+FFFD instead of raising, so the check was unreachable. The encoder now scans for lone surrogates (well-formed pairs are astral characters and pass) and raises CPython's `'utf-8' codec can't encode character … surrogates not allowed`. The chain into PicklingError comes free from the earlier `PyErr_ExceptionMatches`/`_PyErr_ChainExceptions1` fixes.

- [x] **`PyBytes_DecodeEscape` kept a trailing backslash instead of raising** (+2 pickle, test_badly_escaped_string × C loaders; bridge). The protocol-0 STRING opcode decodes its payload with `PyBytes_DecodeEscape`; a payload ending in a lone `\` must raise `ValueError: Trailing \ in string` (the unpickling tests feed `b"S'\\'\n."`), but the bridge pushed the backslash through and the load succeeded.

- [x] **The slot-attro trampolines handed the C side scope-tracked handles — the stored value dangled and re-reads went to a different struct** (+2 pickle, test_pickler/test_unpickler_instance_attribute; bridge). CPython 3.13+ routes `Pickler.persistent_id` through C slots (`Pickler_setattr` stores the value in `po->persistent_id_attr`, `Pickler_getattr` returns it ahead of the normal lookup). Two handle-lifetime gaps in the bridge's tp_setattro/tp_getattro trampolines broke the round-trip: the VALUE handle passed to the C setattr was scope-tracked, so the id the C stored long-term was released at frame close and re-minted — the later read unwrapped whatever object had been re-minted under it; and a Brython-side instance without `__wasthon_ptr__` got a fresh `rt.wrap(self)` per call, so set and get could address different memory. Both trampolines now pin: the value handle via `wrapPinned` (the C keeps it), and the self handle cached on `self.__wasthon_ptr__` at first use. The `super_instance_attribute` variants stay open — a deeper wrapper-identity issue where subclass instances reach the trampolines as fresh re-materialized wrappers per operation (documented for the canonical-identity work).

- [x] **`PyErr_Format`'s `%T`/`%N` emitted the bare class name where CPython emits the fully-qualified one** (+2 pickle, test_bad_newobj_class/test_bad_newobj_ex__class × C pickler; bridge). The `_pickle` argument checks (`first argument to __newobj__() must be a class, not %T`) format the offending object's type; the bridge's `PyErr_Format` rendered `%T` as `class_name(obj)` — just `NoNew` — where CPython 3.13+ emits `module.qualname` minus the `builtins.` prefix (`pickletester.NoNew`). The qualification logic already existed in `_PyErr_FormatNote` (the +17 notes fix); it now lives in a shared `rt.qualTypeName(obj, isType)` used by both formatters, so the two can't drift again.

- [x] **`PyMemoryView_FromMemory(PyBUF_WRITE)` copied instead of aliasing, so `file.readinto()` writes never reached the C buffer — the pickle "zeros" root** (bridge, with a vendored `BytesIO.readinto` companion; together they green the zeros cluster: test_bytes/bytearray/binbytes/binbytes8/bytearray8/short_binbytes/bytes_memoization/bytearray_memoization/in_band_buffers/large_pickles on the file-based loaders). A file-backed C `Unpickler` reads every counted-bytes payload via `_Unpickler_ReadInto`, which wraps its destination pointer in `PyMemoryView_FromMemory(buf, n, PyBUF_WRITE)` and hands it to `file.readinto()` (`_Pickle_FastCall`); the stub always copied the heap region into an immutable Brython `bytes` — its comment claimed no bundled caller needs the write path — so the callee's writes never landed at `buf`, and the value stayed the `PyBytes_FromStringAndSize(NULL, size)` zero-fill: right length, zero content. Only the file-based loaders (CPicklerTests, DumpPickle_CLoadPickle, CPicklerUnpicklerObjectTests) were affected — memory input takes the `memcpy` fast path, which is why every `_pickle.loads(bytes)` probe of the same data round-tripped and kept the bug looking "context-dependent". The write path now backs the view with a *writable bytearray* tagged `__wasthon_frommem__ = {ptr, len}`, and `PyObject_CallOneArg` folds the bytearray's `.source` back into the heap region after the callee returns — write-back, not write-through, which suffices because the C side only reads `buf` after the call returns.

- [x] **`PyObject_GetBuffer`'s mutability flag tested the exact class, so a `bytearray` *subclass* pickled its protocol-5 buffer as read-only `bytes`** (+5 pickle, test_oob_buffers ×3 / test_in_band_buffers ×2; bridge). The readonly out-param (previous `GetBuffer` fix) classified writability via `ob_type === bytearray`, so pickletester's `ZeroCopyBytearray(bytearray)` fell to the read-only branch: `view.readonly = 1` made `save_picklebuffer` emit `SHORT_BINBYTES` where CPython emits `BYTEARRAY8`, failing the opcode-count asserts (`1 != 0`) and reconstructing the wrong type. The classifier is now `$B.$isinstance(obj, bytearray)` — a subclass is just as writable.

- [x] **`memoryview(PickleBuffer)` raised `TypeError` — the stub had no path exposing its underlying buffer** (+4 pickle, test_dump_load_oob_buffers/test_dumps_loads_oob_buffers × C/Py picklers; bridge, with a vendored memoryview-factory companion). PEP-574 out-of-band loading wraps the buffer in a memoryview (`with memoryview(obj) as m:` in pickletester's `_reconstruct`, and pickle.py's `load_readonly_buffer` does the same), but Brython's factory found no buffer path on the stub class: `TypeError: memoryview: a bytes-like object is required, not 'PickleBuffer'`. The stub now implements PEP 688's `__buffer__` returning `memoryview(self.obj)` — a view of the *underlying* object, matching CPython where a memoryview over a PickleBuffer reads through to the wrapped buffer — and raises CPython's `ValueError: operation forbidden on released PickleBuffer object` once released. Needs the vendored factory half (BRYTHON_FIX: the factory must actually *call* `__buffer__` when the type has no native buffer path).

- [x] **`_PyErr_ChainExceptions1` dropped the fetched exception instead of chaining it, the bridge's `AttributeError` messages lacked the CPython shape, and `PyErr_ExceptionMatches` never matched subclasses** (+6 pickle with the vendored getattr/import-message fixes, test_global/nested/wrong_object_lookup_error; bridge). Three error-fidelity gaps in pickle's lookup-error path. (1) `save_global` fetches the live `AttributeError`/`ImportError` via `PyErr_GetRaisedException`, formats a `PicklingError`, then calls `_PyErr_ChainExceptions1(exc)` so `cm.exception.__context__` carries the original — but the bridge implementation returned early whenever an exception was pending, silently dropping `exc`, so `__context__` stayed `None` (the tests assert its exact `str`). It now materializes the pending value (kept on `pe.value` so the same instance crosses to Brython) and hangs `exc` off its `__context__` — a plain JS property, mirroring Brython's `__context___get`. The no-pending re-raise half (sqlite3 bind_parameters) is unchanged. (2) The two bridge getattr-failure sites raised `AttributeError: no attribute 'x'`; a new shared `attrErrMsg` emits CPython's shapes — `module 'os' has no attribute 'x'` (reading the module `__name__` through `module_getattr`, since a Brython module's `__name__` lives in its dict, not as a JS property), `type object 'A' has no attribute 'x'` for a class, `'Foo' object has no attribute 'x'` otherwise. (3) `PyErr_ExceptionMatches` called `$B.$issubclass` — which does not exist in this Brython — so its try/catch silently fell back to an identity compare and **every subclass match failed**: a `ModuleNotFoundError` never matched `PyExc_ImportError`, so `save_global` leaked the raw MNFE where `assertRaises(PicklingError)` expected the formatted error. It now calls the real builtin `_b_.issubclass` (identity fast-path kept). This match gap potentially affected every C `PyErr_ExceptionMatches` on an exception subclass, well beyond pickle.

- [x] **`_PyErr_FormatNote`'s `%T` emitted the bare class name, so pickle's "when serializing X" error notes lost the module qualifier** (+17 pickle, test_unpickleable_*/test_bad_* error-fidelity; bridge). CPython's `_pickle` decorates a `PicklingError` with `__notes__` such as `when serializing pickletester.REX object` (PEP 678), formatting the offending type through `%T`. The bridge's `_PyErr_FormatNote` rendered `%T` as `class_name(obj)` — just `REX` — so every note read `when serializing REX object` and mismatched the fully-qualified `assertEqual`. `%T` now emits `type(obj).__module__ + '.' + __qualname__`, dropping the `builtins.` prefix (so `tuple`, but `pickletester.REX`), matching CPython's fully-qualified type format; `%N` (the argument is itself the type) is qualified the same way. The mechanism (append to `exc.__notes__`, survive to the caught exception via `pendingExc` returning `pe.value`) was already correct — only the type formatting was wrong. Nested newobj_ex proto-2/3 inner notes (`__new__ arguments` / `tuple item N`) are a separate path, still open.

- [x] **`PyMemoryView_FromObject` was a stub and a `PickleBuffer` couldn't convert to bytes, so protocol-5 out-of-band buffer unpickling failed** (+6 pickle, test_oob_buffers_writable_to_readonly + oob conversions; bridge). Two gaps on the PEP-574 out-of-band path. (1) `PyMemoryView_FromObject` raised `NotImplementedError` — pickle's `load_readonly_buffer` (the READONLY_BUFFER opcode) wraps an out-of-band buffer in a memoryview to (re)mark it read-only — so any OOB unpickle carrying a read-only buffer failed; it now returns a real `memoryview(obj)`, and `PyMemoryView_GET_BUFFER` backs each view with a per-object `Py_buffer` whose `readonly` (offset 16) reflects the view (bytes-backed → read-only, `bytearray` → writable), so `load_readonly_buffer` keeps a read-only original (zero-copy) instead of re-wrapping it. (2) `bytes(PickleBuffer)`/`bytearray(PickleBuffer)` raised `TypeError: cannot convert 'PickleBuffer' object to bytes` — the test collects buffers and does `map(bytearray, buffers)`; the `_pickle` `PickleBuffer` stub now exposes `__bytes__` returning `bytes(self.obj)` (both bytes/bytearray factories fall back to `__bytes__`). Remaining OOB gaps are separate: `memoryview(PickleBuffer)` needs the vendored memoryview factory to unwrap the stub to its underlying buffer, and the C `Pickler`'s `buffer_callback` kwarg isn't honored (the buffer is written in-band instead of `NEXT_BUFFER`).

- [x] **`PyObject_GetBuffer` reported every buffer as read-only, so a protocol-5 `PickleBuffer` over a `bytearray` pickled as `bytes`** (+6 pickle, test_picklebuffer_memoization/test_empty_picklebuffer_memoization; bridge). The C `_pickle` `save_picklebuffer` does `PyObject_GetBuffer(obj, &view, PyBUF_FULL_RO)` then branches on `view.readonly` — writing a read-only `bytes` (`_save_bytes_data`) or a writable `BYTEARRAY8` (`_save_bytearray_data`). The bridge wrapper hardcoded `view->readonly = 1`, so a `PickleBuffer` wrapping a writable `bytearray` (reached through the stub's `.obj` recursion) always took the `bytes` branch and unpickled as `bytes`, failing `assert_is_copy`'s type check (`<class 'bytes'> is not <class 'bytearray'>`) and `assertIsInstance(buf, bytearray)`. `wasthon_get_buffer_data` now also reports the object's real mutability through a fourth out-param (a `bytearray` is writable → `readonly = 0`; every other bytes-like read here is immutable → `1`; the `PickleBuffer` recursion forwards the pointer so the flag reflects the wrapped object), and the C `PyObject_GetBuffer` copies it into `view->readonly` instead of a constant. The Python pickler picks the same branch from `memoryview(obj).readonly`, so this is the C-pickler half; the shared-object memo identity across a repeated buffer is a separate vendored fix.

- [x] **A class whose metaclass isn't `type` itself (e.g. `ABCMeta`) got a scope-released sentinel handle, so `_pickle`'s `save_global` identity check failed** (+1 pickle; bridge). `save_global` verifies `getattribute(module, qualname) == obj` by a raw `PyObject *` pointer compare (`actual != global`), so the same Brython class must `wrap()` to the same handle on both sides. `rt.wrap` handed the canonical, pinned `ensureTypeStruct` handle only to classes whose metaclass is *exactly* `type` (`obj.ob_type === _b_.type`); a class with an `ABCMeta` metaclass — a *subclass* of `type`, e.g. `collections.UserDict`/`UserList` via `collections.abc` — missed that branch and fell to the sentinel path, whose id is `_scopeTrack`-released at the C-call frame boundary and re-minted fresh on the next wrap. The same class also arrives on the other side through `wrapMaybeType` (`isinstance(obj, type)` → `ensureTypeStruct`), so the two sides carried two different handles and pickling the class raised `PicklingError: it's not the same object as …` (`defaultdict`, metaclass `type`, worked; `UserDict`/`UserList`, `ABCMeta`, didn't). `wrap` now routes **every** class — detected via `obj.tp_name !== undefined`, Brython's own class marker — through `ensureTypeStruct`, so all classes converge on the canonical handle regardless of metaclass. A pinned sentinel doesn't suffice (the other side still uses the struct handle, so both must converge on *it*); `ensureTypeStruct` is idempotent and caches `__wasthon_type_handle__` per class, and a full test_pickle run measured the same wall time.

- [x] **`pickle.find_class` mis-resolved a dotted module and decoded names leniently** (+pickle, test_load_global/test_load_stack_global; bridge). Two C-unpickler `find_class` gaps: `PyImport_Import('os.path')` returned the *top* package `os` (it called `__import__` without walking to the leaf), so `find_class('os.path', 'join')` then did `getattr(os, 'join')` → `AttributeError: no attribute 'join'`; it now walks down to the leaf submodule (and raises `ValueError: Empty module name` for `''`, as CPython does). And `PyUnicode_DecodeUTF8` ignored its `errors` argument and always decoded leniently, so an invalid-UTF-8 module/global name yielded U+FFFD instead of raising — `'strict'` and `'surrogatepass'` (the two modes the unpickler uses for names / SHORT_BINUNICODE) now reject an invalid byte with `UnicodeDecodeError` on the fast path (the lone-surrogate slow path is unchanged, so `surrogatepass` still round-trips real surrogates).

- [x] **Unpickling state set a bad attribute/key with the wrong exception** (+2 pickle, test_bad_state; bridge). Two error-fidelity gaps in the BUILD-opcode path: `PyObject_SetAttr` raised `SystemError: invalid args` when the name wasn't a string (a non-string `__slots__` state key), where CPython raises `TypeError: attribute name must be string, not '…'`; and `PyObject_SetItem` masked any exception from the operation as `TypeError: setitem failed: [object Object]`, swallowing e.g. a dict key whose `__hash__` raises a custom error. `SetAttr` now raises that `TypeError` for a non-string name (keeping `SystemError` only for a genuinely null object), and `SetItem` forwards the original exception (`rt.forwardError`) so a key's `__hash__`/`__eq__` error propagates unchanged (test_bad_state's `BadKey1`/non-hashable-key/non-string-slot cases).

- [x] **`PickleBuffer.raw()` returned the raw buffer object, not a `memoryview`** (+11 pickle protocol-5 buffers, with a vendored memoryview companion; bridge). The `PickleBuffer` stub's `raw()` returned `self.obj` (the wrapped `bytes`/`bytearray`), so pickle's `save_picklebuffer` (`with obj.raw() as m: …`) failed with `'bytes' object does not support the context manager protocol` — and the load side read zeros. `raw()` now returns `memoryview(self.obj)`, a real Brython memoryview (a context manager whose `.tobytes()` yields the actual data), so an in-band protocol-5 buffer round-trips (test_bytes/bytearray_memoization, test_in_band_buffers, …). The full out-of-band zero-copy *identity* semantics (a single shared buffer object across pickle) and `PyMemoryView_FromObject` for the C pickler stay unimplemented — those need the real C buffer protocol.

- [x] **`PyUnicode_FSConverter` rejected an `os.PathLike` path with `TypeError`** (+1 sqlite3; general). It dispatched only `str`/`bytes`, so a path-like argument (`sqlite3.connect(FakePath(...))`) raised `TypeError: expected str, bytes or os.PathLike object` instead of being resolved. It now calls `__fspath__` (CPython's `PyOS_FSPath`) on a non-`str`/non-`bytes` arg before the `str`/`bytes` dispatch (test_open_with_path_like_object). Surfaced once the test harness moved its file-DB tests onto the shared Emscripten MEMFS (so a path-DB created by sqlite3's C side is visible to Brython's `os.path.exists`); see the loader change for that switch.

- [x] **`gc.collect()` was a no-op, so a sqlite3 cursor `del`'d while holding a pending statement kept its table lock** (+2 sqlite3; bridge, with a harness companion). Brython is a tracing GC with no prompt finalization, so `del cur; gc.collect()` never ran the cursor's `tp_dealloc` → its SELECT statement stayed open → a following `DROP TABLE` failed with `database table is locked` (test_table_lock_cursor_dealloc, test_table_lock_cursor_non_readonly_select). The bridge now implements `$B.$wasthon_gc_collect()`: it marks the C instances reachable from the live Brython frames (locals + globals, recursing into containers and the **Symbol-keyed instance `__dict__`** — `self.cur` lives at `self[$B.DICT].cur`, invisible to `getOwnPropertyNames` — tracking the **max visit depth per object** so one first reached shallow via the huge globals graph is still re-walked deep from a frame local), then fires `tp_dealloc` on every gc-finalizable instance no longer reachable, exactly as a refcount-0 DECREF would (cursor_dealloc → cursor_clear → stmt_reset releases the lock). Gated to an opt-in set of resource-holding sqlite3 types (`$wasthon_gc_finalizable`: Connection/Cursor/Blob/Backup, flagged in `PyType_FromModuleAndSpec`) registered at `bindInstance` into a `gcRegistry` (pruned by `PyObject_GC_Del` and a stale-identity check), so another suite's `gc.collect()` sweeps nothing (empty registry → instant return), the mark skips the bridge's own strong-ref bookkeeping (handles/gcRegistry/refcounts — they pin every instance) and module objects (huge graphs, no live test cursor), and never recurses functions (bound-method/proxy reads explode the walk). The reachability mark preserves anything held in a live frame (including the test mixin's `self.cur`), so only genuinely-dead instances are freed. Activated via the harness's `support.gc_collect` (separate commit).

- [x] **`PyObject_CallFinalizerFromDealloc` and `PyErr_ResourceWarning` were no-ops, so an unclosed connection finalized by `gc.collect()` emitted no ResourceWarning** (+1 sqlite3; bridge). `connection_dealloc` runs `PyObject_CallFinalizerFromDealloc(self)` → `connection_finalize` → `PyErr_ResourceWarning(self, 1, "unclosed database in %R", self)`; both were stubs, so `cx = connect(); del cx; gc_collect()` produced no warning (test_connection_resource_warning). `tp_finalize` sits past the 64-byte bridge type struct, so `PyType_FromModuleAndSpec` now stashes the `Py_tp_finalize` spec slot on the class (`$wasthon_tp_finalize`) and `PyObject_CallFinalizerFromDealloc` invokes it once (guarded by `__wasthon_finalized__`), returning 0 (proceed, never resurrect); `PyErr_ResourceWarning` now emits through `PyErr_WarnEx(PyExc_ResourceWarning, …)` (new `PyExc_ResourceWarning` extern wired like the other warning categories — `wasthon.c`/`.h`/`.js`; the `%R` message is collapsed to a fixed string since the bridge has no `PyUnicode_FromFormatV`, and `assertWarns` checks only the category). The C finalizer saves/restores any pending exception itself, so a filter turning the warning into an error stays unraisable.

- [x] **`object.__new__` on a wasthon C type returned a struct-less Brython object, so explicit `Cls.__new__(Cls)` read an uninitialised C struct** (+1 sqlite3; bridge, with a vendored companion). A C type with no `Py_tp_new` slot (e.g. `sqlite3.Connection`) is instantiated via `tp_call` → its zeroing fallback `tp_new` (a real C struct) — but explicit `Connection.__new__(Connection)` resolves `__new__` to Brython's `object.tp_new`, which returns a bare `{ob_type}` JS object with no C struct. C code then cast that and read `con->initialized`/`thread_ident`/`check_same_thread` off stale heap — fine in isolation (fresh-zero memory) but garbage once other tests ran, so the uninit guard misfired with `index out of bounds` / a thread-id mismatch instead of `ProgrammingError` (test_uninit_operations, suite-order-dependent). The bridge now installs `$B.$wasthon_new_instance(cls)`: a **leaf** allocator that mallocs + zeroes `cls`'s C struct (basicsize from the MRO) and binds the instance, and — crucially — never calls `cls.tp_new`, so dispatching `object.tp_new` to it (vendored, see BRYTHON_FIX) can't recurse. The naive fix (have `object.tp_new` delegate to `cls.tp_new`) recursed — C `tp_new`s call `object.__new__` internally — and regressed sqlite3 −10 with array/zlib/random hangs.

- [x] **The singleton types `NoneType`/`ellipsis`/`NotImplementedType` weren't bound to their `&_PyXxx_Type` externs, so `_pickle` couldn't pickle them** (+3 pickle; bridge). `_pickle`'s `save_type` emits `(type, (None,))` / `(type, (...,))` / `(type, (NotImplemented,))` only when `obj == &_PyNone_Type` (& co); otherwise it falls to `save_global` → an unpicklable `builtins.NoneType`. The bridge bound 14 builtin types to their externs but not these three, so `wrap(type(None))` was a fresh `ensureTypeStruct` handle ≠ `&_PyNone_Type` and the C identity check never fired (`test_singleton_types` — the C/InMemory pickler variants; the pure-Python pickler was fixed separately by the vendored `type.__module__` Brython fix). Bound them (`wasthon_bind_builtin_type`, new `BT_NONETYPE`/`BT_ELLIPSIS`/`BT_NOTIMPLEMENTED` tags → `$B.NoneType`/`$B.ellipsis`/`$B.NotImplementedType`) and extended `ensureTypeStruct`'s canonical-handle return (the same path that makes `wrap(int) == &PyLong_Type`) to the three — safe to unify since their only instances are `None`/`...`/`NotImplemented`, never reconstructed via NEWOBJ.

- [x] **`PyUnicode_FromStringAndSize` decoded UTF-8 leniently, so an undecodable C string came back as a str with U+FFFD instead of raising** (+1 sqlite3; general). CPython's `PyUnicode_FromStringAndSize` is strict — invalid UTF-8 raises `UnicodeDecodeError` and returns NULL. The bridge's explicit-size path used a non-fatal `TextDecoder`, silently substituting replacement characters. sqlite3's row builder leans on that NULL to turn an undecodable TEXT column into `OperationalError` ("Could not decode to UTF-8 column …", cursor.c:405): binding an invalid-UTF-8 blob and reading it back as text (`select 'xxx' || ? || 'yyy'` with `bytes([250])`) returned a replacement-char str rather than raising. The explicit-size path now decodes with `fatal:true`, and on failure sets `UnicodeDecodeError` / returns NULL (test_error_msg_decode_error). The NUL-terminated path (`size < 0`, emscripten `UTF8ToString`) stays lenient.

- [x] **C types built by `PyType_FromModuleAndSpec` had a NULL `tp_clear`, so re-`__init__` on such an instance was an indirect call to null** (+1 sqlite3; general). The bridge populates the malloc'd type struct's tp_free/tp_dict/tp_name/tp_alloc/tp_iter/tp_methods/tp_dealloc from the spec slots, but never wrote `tp_clear` (offset 44). C code that re-initialises an instance reads `Py_TYPE(self)->tp_clear` and calls it directly — sqlite3's `Connection.__init__` on an already-initialised connection does `tp->tp_clear((PyObject *)self)` (connection.c:253) before rebuilding — so a second `__init__` (here a subclass re-init) crashed with `JavascriptError: indirect call to null` instead of clearing and re-opening. `PyType_FromModuleAndSpec` now wires the `Py_tp_clear` spec slot (wasthon.h id 54) into offset 44 (test_connection_reinit).

- [x] **`wrap(int)` didn't equal `&PyLong_Type`, so sqlite3's `register_adapter(int, …)` never set BaseTypeAdapted** (+1 sqlite3; with a companion). sqlite3's `register_adapter` compares a type against the canonical extern `&PyLong_Type` by pointer; but `wrap(int)` returned a *fresh* `ensureTypeStruct` handle, distinct from the `&PyLong_Type` that `wasthon_bind_builtin_type` wired (and that `Py_TYPE(int_instance)` already returns) — two handles for `int`. So `type == &PyLong_Type` was false, `state->BaseTypeAdapted` stayed 0, and an int adapter was skipped (`register_adapter(int, float)` left `4` an int, not `4.0` — test_caster_is_used). `ensureTypeStruct(int)` now returns the canonical `&PyLong_Type`, enriched once to be as complete as a fresh struct (tp_dict/tp_alloc/tp_iter/tp_iternext/**tp_new**). **Scoped to `int`**: the earlier blanket "wrap builtins → &PyXxx_Type" regressed pickle 679→601 (incomplete struct), and even completed, unifying str/bytes/containers still moved pickle; `int` alone, fully completed, holds pickle at 697. The missing **tp_new** was the subtlety — pickle's `load_newobj` dereferences `cls->tp_new`, so `int` via NEWOBJ errored instead of yielding `0` until it was wired (test_bad_newobj/test_bad_newobj_ex). + **`PyLong_FromString` enforces `sys.int_info.default_max_str_digits`** (companion): with `wrap(int) == &PyLong_Type`, `_json`'s integer fast path now runs the C `PyLong_FromString(buf)` instead of Brython's `int()` (which checked the limit), so a base-10 int over the limit raises `ValueError` there too (test_json test_limit_int).

- [x] **Expose CPython's real Unicode case/predicate tables to Brython, making `str` CPython-exact** (+1 unicodedata, +2 pickle; bridge infrastructure, consumed by vendored Brython — see BRYTHON_FIX). Bundles that ship `unicodedata` already link CPython's `Objects/unicodectype.c` + the 281 KB `unicodetype_db.h` (the complete UnicodeData case/predicate database). The bridge installs `$B.$wasthon_unicode` — `flags(cp)` (bit-packed: alpha/decimal/digit/numeric/lower/upper/title/space/printable/cased/case-ignorable, one boundary crossing per codepoint), `upper/lower/title/fold(cp)` (full 1→N mappings, e.g. `ß`→`SS`, `ﬁ`→`FI`), and `available()` (false for the ASCII weak-stub fallback in bundles without the table, so Brython never delegates to a worse hook). C shims `wasthon_uc_*` in wasthon.c (with weak ASCII fallbacks to keep table-less bundles linkable) are exported in build.sh and called lazily by the bridge. Brython's `str.upper/lower/title/casefold` + `is*` delegate to this (BRYTHON_FIX, vendored-only — its tables diverge on ~2400 codepoints), replicating CPython's word-final `Σ`→`ς` via the cased/case-ignorable flags; `test_unicodedata test_method_checksum` goes green (the last blocker was a separate Brython surrogatepass-encode bug, also fixed — upstreamable).

- [x] **`PyObject_Hash` returned the error sentinel `-1` for any BigInt hash** (+2 random; bridge). It computed `$B.$hash(obj) | 0`, but `bigint | 0` throws in JS (`Cannot mix BigInt`), so the `catch` returned `-1` — an *error* to the C caller. This was latent for large ints (whose hash is a BigInt) but never hit, until the 61-bit `float.__hash__` fix above made `hash(3.14)` a BigInt: `random.seed(3.14)` (the C `random_seed` hashes a non-int seed) then failed with `RuntimeError: seed: call returned NULL` (`test_seedargs`, `test_seed_when_randomness_source_not_found`). `Py_hash_t` is 32-bit on wasm32, so `PyObject_Hash` now reduces the hash to a signed 32-bit value — `Number(BigInt.asIntN(32, h))` for a BigInt, `h | 0` otherwise — and maps a truncated `-1` to `-2`. Strictly safer: it only ever turned a thrown `-1` into a real 32-bit hash.

- [x] **A Python subclass of `decimal.Decimal` got its parent's type struct passed to the inherited C `tp_new`, so exact-type fast paths fired and reclassed a shared object** (+1 decimal; bridge). A C type's `tp_new` is invoked with the *parent* type handle (the instance's class is patched to the subclass afterwards). For most types that's fine, but `_decimal`'s `dec_new` has exact-type fast paths — `Decimal(d)` when `d` is already an exact `Decimal` returns `d` unchanged (incref). So `A.from_float(42.5)` (A subclasses Decimal) runs `A(base_decimal)`: the C returned the shared `base_decimal`, then the subtype override reclassed it to `A` in place, and `A.__init__`'s `type(arg)` read `A` instead of `Decimal` (`test_decimal_from_float_argument_type`). The bridge now hands a Decimal subclass its *own* dereferenceable type struct (`subtypeStructFor`: a byte-copy of the parent struct so every C slot deref matches, with `tp_dict` set to the subclass's and an `rt.types` entry carrying the parent's basicsize/slots but `brythonClass` = the subclass), so `dec_new` sees a non-base `type`, skips the fast path, and builds a fresh subtype instance (`Py_TYPE` becomes faithful; `PyObject_TypeCheck` still passes via its subtype walk). **Scoped to `decimal.Decimal`**: applying it to every C subtype regresses `array` −28 (`array_new` / the buffer protocol read the type struct in ways a generic subtype struct doesn't satisfy) — the general per-subtype struct is a separate, array-specific problem. This is the narrow, correct version of the reverted `ensureSubtypeStruct` (which botched the clone and lost 86 across decimal/array plus a heap trap).

- [x] **`_decimal`'s hash disagreed with `hash(int)`/`hash(float)` because wasm32 forces a 31-bit `Py_hash_t`** (+3 decimal; with two vendored Brython companions). wasm32 fixes `Py_hash_t` at 32-bit, so CPython compiles `_decimal` with `_PyHASH_BITS == 31` and `_dec_hash` reduces mod `2**31-1`. But Brython (the host) hashes ints/floats/Fractions mod `2**61-1`, like a 64-bit CPython — so `hash(Decimal(-(2**31-1)))` came back `0` while `hash(-(2**31-1))` is `-2147483647`, failing `test_hash_method`'s `hash(d) == hash(int(d))`. A 61-bit value can't be returned through a 32-bit `Py_hash_t` anyway, so the hash of a type compared against Brython's belongs at the bridge, where 61-bit BigInt arithmetic already lives. The bridge now recomputes `decimal.Decimal`'s `tp_hash` in BigInt as CPython's `_dec_hash` does — `(coeff * 10**exp) mod (2**61-1)`, signed, `-1`→`-2`, specials matching (`±Infinity`→`±314159`, quiet NaN by identity, signaling NaN raises). The coefficient is built from `as_tuple()`'s single digits, **not** `as_integer_ratio()` whose huge numerator is marshaled C→JS through a double and overflows to `Infinity` past ~308 digits (e.g. `hash(Decimal(1100**1248))`). Paired with two vendored Brython fixes (see BRYTHON_FIX.md): `float.__hash__` switched from the legacy 32-bit algorithm to CPython 3's 61-bit `_Py_HashDouble`, and `sys.hash_info` corrected from the lying `width=32, modulus=2**31-1` to `width=64, modulus=2**61-1` (read by the pure-Python `_pydecimal`). This is the contained fix for the long-standing "32/61 hash" wall; the alternative — widening `Py_hash_t` to 64-bit — needs `-sWASM_BIGINT`, which changes the calling convention of every i64 bridge function (`PyLong_AsLongLong` & co) and is the path that already failed (test_decimal test_hash_method ×2 C+Py, test_hash_method_nan).

- [x] **`Py_IS_TYPE` was loose — it treated a Python subclass of a C type as the exact base type** (+1 decimal; general). A Python subclass of a C type (`class MyDecimal(Decimal)`) carries its *parent's* type handle in `__wasthon_type__`, so that `PyObject_TypeCheck`'s subtype walk and the C-side module-state lookups keep resolving; but that also made the raw `Py_TYPE(op) == t` pointer compare behind `Py_IS_TYPE` true for the subclass — exact when CPython says it isn't. `_decimal`'s constructor fast path `if (type == st->PyDec_Type && PyDec_CheckExact(v)) return Py_NewRef(v);` then returned the *same* `MyDecimal` object for `Decimal(MyDecimal(x))` instead of a fresh base `Decimal`, so `assertIs(type(Decimal(m)), Decimal)` failed with `MyDecimal is not Decimal`. `Py_IS_TYPE` now resolves both operands to their live Brython classes and compares those (strict), while `Py_TYPE`/`PyObject_TypeCheck` stay on the parent-handle path — splitting the exact and subtype checks exactly like CPython. The seven C call sites (decimal ×2, sha2 ×2, sre, pickle ×2) are all exact-type guards CPython runs strictly (test_decimal test_subclassing). The sibling `test_decimal_from_float_argument_type` still fails: there the intermediate is genuinely an exact base `Decimal`, so the fast path correctly returns it and the subclass-construction override (`inst.ob_type = subclass`) reclasses that shared object — the real fix wants the subclass's own C type struct passed to `dec_new`, which is the reverted subtype-struct work.

- [x] **C clinic text signatures (`ml_doc`/`tp_doc` first line) weren't exposed, so `inspect.signature` failed on every C function/type** (+2 decimal; general). The method installer read a `PyMethodDef`'s name/meth/flags but skipped `ml_doc` (+12), and `PyType_FromModuleAndSpec` ignored the `Py_tp_doc` slot, so every C method/type carried no `__text_signature__` — `inspect.signature(Decimal.compare)` / `inspect.signature(Context)` raised `ValueError: no signature found for builtin`. CPython stores a clinic signature as the first docstring line `"<name>(<sig>)\n--\n\n…"`; the bridge now extracts `"(<sig>)"` from `ml_doc` (onto the method_descriptor / trampoline / classmethod) and from the `Py_tp_doc` slot (onto the type) into a `$text_signature` field. Paired with two vendored Brython companions (the empty `__text_signature___get` getters return `$text_signature`; `inspect._signature_strip_non_python_syntax` strips the clinic `$self`/`$module` marker textually, since Brython's tokenizer rejects `$`) — see BRYTHON_FIX.md (test_decimal test_inspect_module, test_inspect_types).

- [x] **A C `__delitem__` reached through a `**kwargs` splat got Brython's `{$kw}` marker as the value** (+1 decimal; general). The `mp_ass_subscript` dispatch reads `(self, item, value)` and treats `value === undefined`/`$B.NULL` as a delete. But calling a bound C `__delitem__` via a `**kwargs` splat — `unittest.assertRaises(exc, d.__delitem__, key)` does `callable(*args, **kwargs)` — appends Brython's trailing `{$kw}` kwargs marker (even when empty) as a third positional, which the raw JS dispatch (it doesn't run the `$B.args` parser that would consume the marker) read as `value`. `_decimal`'s SignalDict routes delete through `signaldict_setitem(self, key, NULL)` and returns `ValueError("signal keys cannot be deleted")` for a NULL value, but with the marker as a non-NULL value it fell through to `PyObject_IsTrue(value)` → `TypeError: descriptor '__bool__' of 'JSObject' object needs an argument`. The dispatch now treats a `{$kw}` marker like the delete sentinel (NULL); a real `__setitem__` value is never a `{$kw}` marker (test_decimal test_c_context_errors — the only failing assertion of its 59).

- [x] **`Py_BuildValue` stuffed a `PyUnicode_New` placeholder into the built value unmaterialized** (+3 decimal; general). Its `O`/`N`/`S` cases unwrapped the handle but never ran the C→Brython materializer, so a string built the `PyUnicode_New(size, maxchar)` + `PyUnicode_1BYTE_DATA`/`memcpy` way (an opaque linear-memory placeholder) passed through verbatim. `_decimal`'s `dec_reduce` does `Py_BuildValue("O(O)", Py_TYPE(self), dec_str(self))` and `dec_str` → `unicode_fromascii` builds its string exactly that way, so `Decimal.__reduce__()` returned `(Decimal, (<JSObject>,))` and `pickle.dumps(Decimal('-3.14'))` raised `TypeError: cannot pickle 'JSObject' object` — even though `str(d)`/`tp_str` materialized fine, the direct C-to-C `dec_str` result inside `Py_BuildValue` stayed raw. The `O`/`N`/`S` cases now pass the unwrapped value through `toBrythonArg` (materializes a placeholder, no-op for everything else), like the call primitives already did (test_decimal test_pickle CPythonAPItests/PyPythonAPItests — the interchangeability block pickles a C Decimal even from the pure-Python test; the cascading tearDownModule "unbalanced sys.modules['decimal']" clears too, once the module's last failing test_pickle restores it). Its `O`/`N`/`S` cases unwrapped the handle but never ran the C→Brython materializer, so a string built the `PyUnicode_New(size, maxchar)` + `PyUnicode_1BYTE_DATA`/`memcpy` way (an opaque linear-memory placeholder) passed through verbatim. `_decimal`'s `dec_reduce` does `Py_BuildValue("O(O)", Py_TYPE(self), dec_str(self))` and `dec_str` → `unicode_fromascii` builds its string exactly that way, so `Decimal.__reduce__()` returned `(Decimal, (<JSObject>,))` and `pickle.dumps(Decimal('-3.14'))` raised `TypeError: cannot pickle 'JSObject' object` — even though `str(d)`/`tp_str` materialized fine, the direct C-to-C `dec_str` result inside `Py_BuildValue` stayed raw. The `O`/`N`/`S` cases now pass the unwrapped value through `toBrythonArg` (materializes a placeholder, no-op for everything else), like the call primitives already did (test_decimal test_pickle CPythonAPItests/PyPythonAPItests — the interchangeability block pickles a C Decimal even from the pure-Python test; the cascading tearDownModule "unbalanced sys.modules['decimal']" clears too, once the module's last failing test_pickle restores it).

- [x] **A C type's `__delattr__`/`__setattr__` bypassed the Py_tp_setattro trampoline and fed the C setattro the delete sentinel as a value** (+1 decimal; general). Brython's `make_setattr_delattr` captures `cls.tp_setattro` into the type's `__setattr__`/`__delattr__` wrapper_descriptors when the type is built — *before* the bridge overrides `cls.tp_setattro` with its Py_tp_setattro (slot 59) trampoline. So `c.attr = v` (Brython `$setattr` → the live `tp_setattro`) reached the trampoline, but the explicit `c.__delattr__('attr')` / `del c.attr` (through the captured wrapper) called the pre-override setattro and handed the C the `$B.NULL` delete sentinel as a real value. `_decimal`'s `context_setattr` then ran its int converter on it (`TypeError: an integer is required`) instead of taking its delete branch (`AttributeError: cannot delete attribute`). The trampoline now (1) forwards C NULL (0) when the value is the delete sentinel (`$B.NULL`/undefined/null), and (2) re-creates `__setattr__`/`__delattr__` to point at itself, so the explicit-dunder path matches `$setattr` (test_decimal test_invalid_context — deleting any of the 8 Context attrs now raises AttributeError).

- [x] **A big pattern overflowed allocation while compiling, and its repr wasn't clipped** (+2 re; both halves general). Two bridge gaps surfaced by a ~5000-char literal / 10000-alternation pattern. (1) `PyList_GET_ITEM(list, i)` compiles to `wasthon_list_items(list)[i]`, which materialised the whole list (a `_malloc` of `N*4` plus a `wrap` of every element) on every index. `_sre_compile_impl` copies its code list element by element — `for (i<n) self->code[i] = PyLong_AsUnsignedLong(PyList_GET_ITEM(code, i))` — so a 20056-int code list did O(n²) work and leaked ~1.6 GB of per-index buffers, throwing `allocation size overflow` (and hanging the 10000-alternation case). `wasthon_list_items` now reuses its last materialisation when called again for the same `(list, length)`, making a `PyList_GET_ITEM` loop O(n); `popScope` drops that cache at each C-call boundary so a later call can't read the freed handles of an earlier one (which would corrupt e.g. _pickle's read-mutate-read over a list — pickle stays 680). (2) `PyUnicode_FromFormat` ignored the precision on `%R`/`%S`/`%U`/`%V`, so `re.Pattern`'s repr `"re.compile(%.200R)"` emitted the whole pattern instead of clipping it to 200 chars (`len(repr) < 300` failed); it now truncates those conversions to the precision, like `%s` (test_long_pattern, test_big_codesize).

- [x] **`PyObject_GetAttrString` didn't keep a bound method's `__self__` alive** (+6 re, with a Brython companion; general). CPython binds a method holding a new ref to `__self__`, so the object survives a later DECREF. _sre `pattern_finditer` does `search = GetAttrString(scanner, "search"); Py_DECREF(scanner)` then hands `search` to `PyCallIter_New` — without the extra ref the scanner reached refcount 0, `scanner_dealloc` ran `state_fini`, and `search()` returned None, so `re.finditer` came up empty (and `next()` crashed). It now increfs the bound self, but only for a refcounted C self, so the unmatched extra ref is bounded to C-object method lookups (no measurable leak across the suites). Paired with the vendored Brython `IterableJSObj.tp_iternext` fix (lazy `self.it` so `next(it)` works without a prior `iter(it)`), this greens the finditer family and tests that use it: test_finditer, test_bug_581080, test_bug_817234, test_match_repr, test_bug_34294, test_zerowidth.

- [x] **`PyUnicode_Join` stringified a non-str item instead of rejecting it** (+2 re; general). It joined via a native `seq.join(sep)`, which coerces a non-str element (a bytes literal) to `"[object Object]"`. CPython's `PyUnicode_Join` raises `TypeError: sequence item N: expected str instance, X found`. _sre's `pattern_subx` builds the result with `PyUnicode_Join` over a list that interleaves str segments with the replacement literals, so `pat.sub(b'b', 'c')` (a str pattern with a bytes replacement) joined `['', b'b']` to `'[object Object]'` instead of raising. It now type-checks each item before joining (test_re test_bytes_str_mixing).

- [x] **`PyDict_GET_SIZE` reported 0 for a dict subclass** (+1 json; general). Its real key-count logic was gated on `get_class(obj) === _b_.dict` (exact), so a `dict` subclass fell through to a bogus JS own-property count (0). The C `_json` encoder's `encoder_listencode_dict` opens with `if (PyDict_GET_SIZE(dct) == 0) return write("{}")` — so `json.dumps(D(), sort_keys=True)` for a one-item `class D(dict)` returned `'{}'`, never reaching the items walk (the dict-mutating `keys()` of Issue 24094's evil subclass was a red herring). It now returns the real length via `dict.mp_length` for any dict instance, subclass included (test_json test_encode_evil_dict — json now 166/166, suite GREEN). Found by instrumenting the bridge (the C path looked identical for an exact vs subclass dict, but the subclass never reached the items branch).

- [x] **A C type's custom `tp_setattro` was unwired, and `PyObject_GenericSetAttr` swallowed the setter's exception** (+1 decimal, -2 pickle [false passes]; general). Two halves: (1) `PyType_FromModuleAndSpec` now wires `Py_tp_setattro` (slot 59, symmetric to the existing `Py_tp_getattro` — a re-entry guard plus an `object.tp_setattro` fallback); without it a C type with a custom setattr (e.g. `_decimal` Context's `context_setattr`, which intercepts `flags`/`prec`/`traps`) was unwritable, falling through Brython's `$setattr` to "object has no attribute and no __dict__". (2) `PyObject_GenericSetAttr`'s `catch` returned `-1` WITHOUT setting the error, so a setter that rejected its value (Context's `context_setprec` raising `ValueError` on `prec = -1`, or `TypeError` on `prec = 'xyz'`) was silently swallowed — `c.prec = -1` returned None. It now forwards the caught exception, so those raise as in CPython (test_decimal test_invalid_context). The same correct propagation fails 2 test_pickle cases that were passing only because an unpickling setattr error was being swallowed (false passes). The Context `flags = <SignalDict>` dict-assign path (`flags_as_int` over the C SignalDict) is still unsupported — a separate, deeper gap.

- [x] **A C getset setter received a wrapped sentinel instead of NULL for `del obj.attr`** (+1 sqlite3; general). `del obj.attr` reaches the bridge's getset setter as `setter(obj, $B.NULL)`; the bridge wrapped `$B.NULL` into a live handle, so the C setter saw a non-NULL value and ran its type check instead of taking the deletion branch. CPython hands a getset setter `value == NULL` for a delete — sqlite3's `isolation_level` setter then raises `AttributeError: cannot delete attribute`, but the bridge made it raise `TypeError: isolation_level must be str or None`. The setter now gets C NULL (0) when the value is the `$B.NULL` delete sentinel (test_sqlite3 test_del_isolation_level_segfault).

- [x] **`PySlice_Unpack` accepted a zero step** (+1 sqlite3; general). It read `start`/`stop`/`step` but never rejected `step == 0`, so a C caller ran its length math on a degenerate slice. CPython's `PySlice_Unpack` raises `ValueError: slice step cannot be zero` before any indices are adjusted; the bridge now does too — `blob[5:10:0] = b"12345"` raises that instead of falling through to sqlite3's later `IndexError: Blob slice assignment is wrong size` (test_sqlite3 test_blob_set_slice_error).

- [x] **A C-type subclass without a `Py_tp_new` slot got no instance `__dict__`** (+3 sqlite3; general). The raw-alloc `tp_new` fallback (the path for FromSpec types that define `Py_tp_init` but no `Py_tp_new` — e.g. `sqlite3.Connection`, whose slots carry `pysqlite_connection_init` only) set the new instance's `ob_type` to the subclass but never `init_dict`'d it, unlike the `Py_tp_new`-slot path (used by `sqlite3.Row`). So a `class C(sqlite3.Connection)` instance had `self.__dict__ == Undefined`. The C `connection_init` builds its statement cache with `lru_cache(self)`, and `functools.update_wrapper` then runs `getattr(self, '__dict__', {}).update(...)` — on Undefined that raised `'UndefinedType' object is not iterable`, so every `connect(factory=<subclass>)` failed. CPython's `type_new` adds `tp_dictoffset` to such a subclass; the fallback now mirrors the slot path and `init_dict`s a real subclass instance (one with no `__slots__`) (test_sqlite3 test_connection_factories / test_connection_factory_relayed_call / test_connection_factory_as_positional_arg).

- [x] **`PyObject_CallMethodObjArgs` masked the called method's exception as `AttributeError`** (+1 sqlite3; general). Its `catch` replaced any error from the `getattr`/call with `AttributeError(name + ': ' + (e.message || e))` — so the method's real exception was lost, and a Brython exception (no `.message`) stringified to `[object Object]`. It now forwards the original (a missing method still surfaces as `AttributeError`, but the method's own error keeps its class): `Connection.executescript`, which dispatches through here, now raises its `DataError` "query string is too large" instead of `AttributeError: executescript: [object Object]` (test_sqlite3 test_cursor_executescript_too_large_script).

- [x] **`PyList_GetItem` returned NULL on an out-of-range index without setting `IndexError`** (+1 sqlite3; general). A C caller (sqlite3 `bind_parameters`) propagated that bare NULL with no pending exception, so the error silently vanished. CPython's `PyList_GetItem` sets `IndexError: list index out of range` (and `SystemError` for a non-list) — now the bridge does too, so binding a parameter list that `__conform__` clears mid-bind raises `IndexError` (test_sqlite3 test_bind_mutating_list, Issue41662).

- [x] **`PyLong_AsUInt32` raised `OverflowError` for a negative value instead of `ValueError`** (+1 sqlite3; general). It collapsed `n < 0` and `n > UINT32_MAX` into one `OverflowError`, but CPython's `LONG_TO_UINT` macro passes `Py_ASNATIVEBYTES_REJECT_NEGATIVE` — a negative value is a `ValueError`, only a width overflow is an `OverflowError`. Now the two are split (test_sqlite3 test_invalid_array_size: `cursor.arraysize = -3` → `ValueError`, `= UINT32_MAX+1` → `OverflowError`).

- [x] **`PyTuple_GetItem` wrapped negative indices Python-style** (+1 sqlite3; general). It delegated to `$B.$getitem`, which (like `PySequence_GetItem`) wraps a negative index to `len + i` — but CPython's `PyTuple_GetItem` is C-level, valid only for `0 <= i < len`, and raises `IndexError` otherwise. So `row[-3]` on a 2-column `sqlite3.Row` (whose C code does `PyTuple_GetItem(data, -3 + 2)` = `PyTuple_GetItem(data, -1)`) returned the last item instead of raising. Now it bounds-checks against `len` before indexing (test_sqlite3 test_sqlite_row_index).

- [x] **`PySlice_Unpack` truncated a float slice index instead of raising** (+1 sqlite3; general). It read each bound with `x | 0`, so `obj[5:5.5]` silently became `obj[5:5]` rather than a `TypeError`. CPython requires slice indices to be `None` or to have `__index__`; a `float` has none. Now each non-None bound goes through `coerceInt` (which rejects non-integers) and a bad one raises `TypeError: slice indices must be integers or None or have an __index__ method` (test_sqlite3 test_blob_mapping_invalid_index_type: `blob[5:5.5]`).

- [x] **`PySequence_Size` masked the length method's own exception** (+1 sqlite3; general). On any error from `len(obj)` it set a generic `TypeError: object has no len()`, swallowing the real exception. CPython's `PySequence_Size` only raises "has no len()" when there is no `__len__`; if `__len__` exists and raises, that exception propagates. Now it checks for `__len__` first and forwards the original error otherwise (test_sqlite3 Issue41662: a parameter object whose `__len__` does `1/0` must surface `ZeroDivisionError`, not be reported as unsized).

- [x] **`PyLong_AsLongLongAndOverflow` / `coerceInt` dropped `bool` to 0** (+3 sqlite3; general). The 64-bit int extractor defaulted every non-number/non-bigint to `0n`, and `coerceInt` sent a Brython `True`/`False` through `int.$factory` (which yielded 0), so a `bool` bound as a parameter or returned from a user function — both routed through `_sqlite/util.c`'s `PyLong_AsLongLongAndOverflow` — became `0` instead of `1`. `bool` is a Python `int` subclass (`int(True) == 1`); `coerceInt` now maps `True`/`False`/JS-boolean to 1/0 up front and `PyLong_AsLongLongAndOverflow` routes through it (test_sqlite3 test_empty_blob / test_nan_float: `isblob(x'')` / `isnone(nan)` returning `True` now read back as 1).

- [x] **`METH_NOARGS` dispatch ignored keyword arguments** (+1 decimal; general). The C-method trampoline rejected positional args for a `METH_NOARGS` method but never checked keywords, so `Decimal(1).is_canonical(context=xc)` silently ran instead of raising. CPython's `cfunction_vectorcall_NOARGS` rejects both; the bridge now raises `TypeError: <name>() takes no keyword arguments` when `kwNames` is non-empty, before the positional-count check (test_decimal test_named_parameters).

- [x] **A length-only C type gets `__len__`** (+1 zstd; general). `Py_sq_length`/`Py_sq_item` collide with `Py_nb_multiply`/`Py_nb_positive` (29/32) in `wasthon.h`; the bridge disambiguated via the `Py_sq_ass_item`/`Py_sq_contains` markers, so a type with `Py_sq_length` only and neither marker (e.g. `_zstd.ZstdDict`) was misread as a number — `len(ZstdDict)` raised "has no len()". Now a type carrying slot 29/32 with no unambiguous numeric slot (`nb_add`, …) is treated as a sequence, so its 29/32 are `sq_length`/`sq_item` (test_zstd test_len).

- [x] **`flattenKwArray` walks a `**`-expanded `MappingProxyType` via `.items()`** (general). A Brython dict was already walked via `.items()`, but a mappingproxy (from `**types.MappingProxyType(...)`) fell to the plain-JS-object branch where `Object.keys` returned the proxy's internal props as phantom kwarg names. Harmless while FASTCALL methods silently dropped kwargs; once they reject keywords, `compute_md5(key, msg, **MappingProxyType({}))` (hmac's one-shot funcs) wrongly raised "takes no keyword arguments". Now a mappingproxy is detected (`ob_type === $B.mappingproxy`) and walked via `.items()` alongside the dict path (kept `$isinstance`-based, since a Brython dict exposes no `ob_type`/`__class__` JS prop — broadening to "any tagged object" regressed `a2b_qp(**{1:1})`).

- [x] **`PyFloat_AsDouble` rejects str/bytes and propagates a `__float__` exception** (+1 math; general). It coerced via `float.$factory` and flattened every failure to a TypeError, which (a) parsed strings (`float()` does, `PyFloat_AsDouble` does not) and (b) masked a real exception from a `__float__` descriptor: `math.dist([1], [BadFloat()])`, where `BadFloat.__float__.__get__` raises ValueError, surfaced as TypeError. Now str/bytes/bytearray are rejected up front (TypeError), and any exception the conversion raises — a huge int's OverflowError, a descriptor's ValueError, `float.$factory`'s own TypeError for an object with no `__float__` — propagates unchanged (testDist; test_input_exceptions stays TypeError via the str reject).

- [x] **`fma` corrects the sign of an underflow-to-zero result** (+1 math; general). emscripten/musl's `fma` is correctly fused but returns `+0.0` for `fma(1e-300, -1e-300, 0.0)` where IEEE/CPython give `-0.0` (the rounded zero follows the underflowed product's sign). The `pycore_pymath.h` shim now wraps `fma` (calling `__builtin_fma` to keep the real fused result) and, only when the result is zero with a zero addend and finite nonzero factors, sets the sign to `sign(x)*sign(y)` (test_fma_zero_result).

- [x] **`PyNumber_Add`/`PyNumber_Multiply` restrict the BigInt fast-path to int×int** (+1 math; general). The branch fired whenever either operand was a BigInt and coerced the other with `BigInt(Math.trunc(Number(x)))`, so `int*float` did integer math (`10**1000 * 1.0` returned `10**1000` instead of overflowing) and `int+Fraction`/`int*Decimal` hit `BigInt(NaN)`. Now both operands must be `int`; a float/Fraction/Decimal operand falls through to `$B.rich_op1`, so `math.sumprod([10**1000], [1.0])` raises OverflowError (via the int→float conversion) and Fraction/Decimal reach their `__radd__`/`__rmul__`. (Needs the harness `test.test_iter.BasicIterClass` stub for testSumProd to run.)

- [x] **`_PyLong_GCD` returns a gcd beyond the safe-integer range instead of throwing** (+1 math; general). It set `n = Number(aa)` then tested `BigInt(n) === aa`, but for a gcd larger than 2^53 `Number(aa)` is `Infinity` and `BigInt(Infinity)` throws — `math.gcd(2**1074, 2**1074)`, reached via `fractions.Fraction._sub` in test_remainder's subnormal cases. Reordered so `Number.isSafeInteger(n)` short-circuits before the `BigInt()`, returning the BigInt directly when out of range.

- [x] **`PyOS_double_to_string` prints `inf`/`-inf`/`nan` like CPython** (+0 measured; general). It formatted every value via JS `val.toString()`, so a non-finite double came out as `"Infinity"`/`"NaN"` — `math.asin(inf)`'s ValueError read "...got Infinity" instead of "...got inf" (the ieee754 doctest), and any C-side string of an inf/nan float was wrong. A non-finite value now returns the Python spelling directly.

- [x] **METH_FASTCALL methods reject keyword arguments** (+1 math; general). The `flags & FASTCALL` dispatch branch passed only the positional args and silently dropped `kwnames`, so `math.hypot(x=1)`/`math.dist(p=.., q=..)` returned a value (or crashed converting the wrong arg) instead of raising. CPython's `cfunction_vectorcall_FASTCALL` calls `_PyArg_NoKwnames`, so a FASTCALL method without `METH_KEYWORDS` now raises `TypeError: hypot() takes no keyword arguments` when any keyword is given.

- [x] **`PyNumber_Multiply` raises `TypeError` on an unsupported pair** (+0 alone; general). Brython's `rich_op1('__mul__', a, b)` can return the `NotImplemented` sentinel when neither `__mul__` nor `__rmul__` applies (e.g. `[1] * [2]`); the bridge returned it as a value, so `math.prod([[1], [2]])` produced `NotImplemented` instead of raising. Now a `NotImplemented` result becomes `TypeError: unsupported operand type(s) for *: 'list' and 'list'`.

- [x] **`PyFloat_AsDouble` propagates `OverflowError`** (general, with the vendored `int.__float__`). It caught every exception from `float.$factory` and reported a flat `TypeError`, masking the `OverflowError` that converting a huge int now raises (`math.hypot(1, 10**400)`). It still maps a non-number (a `str`, an object with no `__float__`) to `TypeError` — `PyFloat_AsDouble`, unlike `float()`, does not parse strings — but an `OverflowError` is now forwarded.

- [x] **`_PyObject_MaybeCallSpecialNoArgs` resolves the special method on the type only** (+2 math; general). It used `$B.$getattr(obj, name)`, which walks the instance dict too — so `math.ceil(t)`/`math.floor(t)` with an instance attribute `t.__ceil__`/`t.__floor__` wrongly called it instead of ignoring it. CPython's `_PyObject_LookupSpecial` resolves `__ceil__`/`__floor__`/`__trunc__` through the type's MRO (`$B.search_in_mro`) and binds to the instance, so an instance-level dunder is ignored and a non-number falls through to `PyFloat_AsDouble` → TypeError (testCeil/testFloor).

- [x] **Complex division helpers match CPython 3.14** (+1 cmath; general). The `pycore_complexobject.h` shim divided naively: `_Py_c_quot` and `_Py_rc_quot` used `a*conj(b)/|b|²`, dividing by the always-positive `|b|²` — which drops the sign of a zero result (`cmath.log(1, 0.5).real` came out `+0.0` instead of `-0.0` — `math.log(1,0.5)` is `-0.0`, test_cmath_matches_math) and overflows for large operands; `_Py_cr_quot` ignored a zero divisor. Replaced all three with `Objects/complexobject.c`'s versions: Smith's algorithm (scale by the larger-magnitude part, divide by the signed denominator), the C99 infinity/zero end-case recovery, and `errno=EDOM` on a zero divisor.

- [x] **`PyComplex_AsCComplex` rejects a non-complex `__complex__` return** (+1 cmath; general). After `obj.__complex__()` the bridge read `c.real`/`c.imag` without checking `c` is a complex; a `__complex__` that returns a str/int/None gave `Number(undefined)` = NaN, so e.g. `cmath.acos(MyComplex(1))` returned `(nan+nanj)` instead of raising (test_user_object). CPython requires `__complex__` to return a complex object — now the bridge raises `TypeError: __complex__ should return a complex object`.

- [x] **`PyObject_CallObject` folds a writable buffer arg's `__wasthon_cstr__` into `.source` before the call** (+2 pickle; general). `_pickle`'s protocol-5 `load_reduce` calls a Python reconstructor with a `bytearray` that `_Unpickler_ReadInto` filled in place — the content lands in the C-side linear-memory buffer (`__wasthon_cstr__`) while `.source` stays the initial zero placeholder until the post-call `syncBytes` pass. But the reconstructor runs *during* the load and reads `.source`: e.g. `ZeroCopyBytes._reconstruct` does `memoryview(obj).obj`, so the rebuilt object was all-zero bytes (`b'xyz'` → `b'\x00\x00\x00'`). The post-call sync was too late. Now `PyObject_CallObject` runs the existing `syncCstrBytes` over each arg first (idempotent for read-only buffers, a no-op for args with no `__wasthon_cstr__`), so the callee sees the real content.

- [x] **`wasthon_brython_tp_new` forwards keyword args** (general; enables NEWOBJ_EX load). It received `kwargsHandle` but never used it — written for `_pickle`'s NEWOBJ (`cls.__new__(cls, *args)`). `_pickle`'s NEWOBJ_EX (protocol >= 4) reconstructs via `cls->tp_new(cls, args, kwargs)`, so for an int subclass pickled through `__getnewargs_ex__` (returning e.g. `{'base': 16}`) the kwargs were silently dropped and the instance rebuilt with the default base 10 (`int('FACE')` → ValueError). Now forwards them through Brython's `$kw` marker, exactly as `PyObject_Call` does; protocol 4/5 round-trips. (Protocol 2/3 take a different `functools.partial` reconstructor path that still fails on a separate Brython `object.__new__.__qualname__` issue, so `test_complex_newobj_ex` stays red overall.)

- [x] **`PyDict_SetItem` forwards the failure exception** (+1 sqlite3; general). On a failed insert the `catch` returned a bare -1 with no pending exception; CPython's `PyDict_SetItem` returns -1 *and* sets the exception (e.g. `TypeError: unhashable type`). sqlite3's `register_adapter({}, ...)` packs the type into a dict-key tuple in `pysqlite_microprotocols_add`, so an unhashable type made `PyDict_SetItem` fail — but with no error set, `register_adapter` returned NULL and the method trampoline raised a generic "call returned NULL" instead of the expected `TypeError` (test_register_adapter). Now the bridge forwards the caught exception.

- [x] **`PyTuple_GetItem` sets IndexError on an out-of-range index** (+1 sqlite3; general). The `catch` swallowed Brython's IndexError and returned NULL with no pending exception, so a C caller that returns that NULL straight through (sqlite3's `pysqlite_row_subscript`/`row_item`) made `row[out_of_range]` yield None instead of raising — test_row_getitem. CPython's `PyTuple_GetItem` sets IndexError ("tuple index out of range"); now the bridge forwards the caught exception.

- [x] **`_PyErr_ChainExceptions1` re-raises when no exception is set** (+7 sqlite3; general). It was a no-op, so the `exc` it received was dropped. CPython: with a currently-set exception, `exc` becomes its `__context__`; with none, `exc` is re-raised. sqlite3's `bind_parameters` hits the second case — a failed `bind_param` grabs the Python error via `PyErr_GetRaisedException`, calls `set_error_from_db` (which sets nothing when the DB error is `SQLITE_OK`, i.e. a pure-Python failure such as a surrogate `UnicodeEncodeError`), then `_PyErr_ChainExceptions1` to re-raise it. Dropped, the bind silently bound NULL — test_string_with_surrogates / test_param_surrogates / test_surrogates / test_bind_mutating_list. Now the bridge keeps a currently-pending exception (single slot, no chaining) but re-raises `exc` when none is pending.

- [x] **`PyUnicode_AsUTF8` is strict; `PyUnicode_AsEncodedString` honors the error handler** (+4 sqlite3; general). `PyUnicode_AsUTF8`/`AsUTF8AndSize` always CESU-encoded a lone surrogate (a deliberate hack so pickle could round-trip them) and so *never* raised — but CPython's `PyUnicode_AsUTF8` is strict and raises `UnicodeEncodeError` on a lone surrogate. sqlite3 encodes SQL text, collation names and function results through `AsUTF8AndSize` and must raise (test_cursor_executescript_with_surrogates, test_collation, …). The only reason AsUTF8 was lossy-tolerant is pickle's `write_unicode_binary`, which in CPython calls `AsUTF8AndSize` *strict* first and, on NULL, retries via `PyUnicode_AsEncodedString(obj, "utf-8", "surrogatepass")` — but the bridge's `AsEncodedString` ignored the `errors` argument and delegated to a lossy `TextEncoder`. A shared `encodeUTF8(s, surrogatepass)` helper now backs both paths: `AsUTF8`/`AsUTF8AndSize` call it strict (lone surrogate → return NULL + `UnicodeEncodeError`); `AsEncodedString` passes the real handler (`surrogatepass`/`surrogateescape` → 3-byte CESU, which `DecodeUTF8` already round-trips; `strict` → raise). A valid surrogate pair (astral char) still encodes to 4-byte UTF-8. pickle's `write_unicode_binary` keeps its surrogates via that `AsEncodedString` "surrogatepass" fallback.

- [x] **`asJSStr` accepts str subclasses (the `$brython_value` box)** (+2 sqlite3, +5 re; general). `PyUnicode_AsUTF8` / `AsUTF8AndSize` / `_PyUnicode_AsUTF8NoNUL` all resolve the C string through `asJSStr`, which only recognized an *exact* str — a JS primitive, a boxed `String`, or `__class__ === _b_.str`. A Brython str-*subclass* instance (`class S(str)`) boxes its primitive in `$brython_value` with `__class__` set to the subclass, so asJSStr returned `null` → `TypeError: str expected`, even though CPython's `PyUnicode_AsUTF8` accepts str subclasses. sqlite3's `isolation_level_converter` rejected a `CustomStr("DEFERRED")` (test_set_isolation_level / test_del_isolation_level_segfault), and several re tests drive str-subclass values through the C string path. Now asJSStr returns `$brython_value` (string or `String` box) for any `$isinstance(_, str)` instance; exact strings keep the early-return fast path untouched.

- [x] **`PyObject_CallFunction` builds `bytes` for `y`/`y#`, and honors the `#` length modifier** (+5 sqlite3; general). The mini Py_BuildValue parser folded `y` in with `s`/`z`/`U` — `UTF8ToString(ptr)` — so it produced a `str`, and the `#` after a format char (the explicit `Py_ssize_t` length vararg) was never consumed. sqlite3's `_pysqlite_fetch_one_row` returns a TEXT column to a non-`str` text_factory via `CallFunction(text_factory, "y#", text, nbytes)`: with `text_factory = bytes` the str fell through to `bytes(str)` → `TypeError: string argument without an encoding`, and a custom factory `lambda x: str(x, "utf-8")` got a str → `decoding to str: need a bytes-like object` (test_factory TextFactoryTests test_string/test_custom + the embedded-NUL TextFactoryTestsWithEmbeddedZeroBytes bytes/bytearray). Now `y`/`y#` build a real `bytes` from the raw bytes (length = the `#` vararg, else `strlen`), preserving embedded NULs; `s#`/`z#`/`U#` consume their length vararg and decode exactly that many bytes (`s`/`z`/`U` without `#` unchanged).

- [x] **`PyLong_CheckExact` is exact, not isinstance** (+3 test_json; general). All `*_CheckExact` C functions in `wasthon.c` called `wasthon_isinstance_of_builtin`, the same helper as `*_Check` — so they returned true for *subclasses* too (CPython's `PyLong_CheckExact` is `Py_TYPE(o) == &PyLong_Type`, exact only). `_json`'s encoder uses `PyLong_CheckExact` to take the int fast path: an `IntEnum` member (an int subclass) passed it, so it was serialized through the subclass's `__repr__` (`"<BigNum.small: 1>"`) instead of its value (`"1"`) — test_json.test_enum test_ints/test_list/test_dict_values. Added a JS `wasthon_exacttype_of_builtin` (direct `__class__`/primitive/bigint match, NO `$isinstance`) and wired `PyLong_CheckExact` to it. An unboxed JS number/bigint is exact int; a bool / IntEnum / int subclass is boxed with its own `__class__` and is not. The handoff feared math −3 (fsum routes bool via `PyLong_CheckExact`) but `PyFloat_AsDouble`'s `float()` fallback now handles bool, so the else-path covers it.

- [x] **`PyComplex_AsCComplex` coerces via `__complex__`/`__float__` or raises** (+3 test_cmath with the vendored `float.__float__`; general). It ran an unknown argument through `Number(v) || 0`, silently turning a non-number (a `str`, a `Decimal`, a `Fraction`) into `0` instead of converting or rejecting it. So `cmath.acos("a")` returned a value instead of `TypeError`, and `cmath.isclose(Decimal('1.00000001'), 1.0)` / `Fraction(...)` compared as `0` (always "close"). Now it mirrors CPython: a complex/number/Brython-float as before; otherwise dispatch through `__complex__`, then `__float__`/`__index__`; a value with none raises `TypeError: must be real number, not <type>`. Fixes test_cmath.test_input_type / test_decimals / test_fractions.

- [x] **`PyLong_AsLong` rejects a float** (+1 pyexpat; general). CPython's `PyLong_AsLong` goes through `__index__`, which `float` lacks — a float raises `TypeError` ("'float' object cannot be interpreted as an integer"), never a silent truncation. The bridge ran the value through `coerceInt`, which accepts a float via `__int__` and truncates it. So `_pyexpat`'s `INT_HANDLER` return conversion (`rc = PyLong_AsLong(rv)`) silently accepted a handler that returned a float — `parser.NotStandaloneHandler = lambda: 1.234` then `Parse()` returned normally instead of raising `TypeError` (test_pyexpat.test_trigger_leak). Now a boxed `float` argument raises `TypeError` up front (ints, bools and `__index__` objects are unchanged).

- [x] **`PySequence_Size` rejects a mapping (dict)** (+1 lzma; general). CPython's `PySequence_Size` needs the sequence protocol (`sq_length`); a mapping such as `dict` has only `mp_length` and raises `TypeError: ... is not a sequence`. The bridge fell back to `len(obj)`, which succeeds on a dict — so `_lzma`'s `parse_filter_chain_spec` (`num_filters = PySequence_Length(filterspecs)`) accepted `lzma.decompress(b"", format=FORMAT_RAW, filters={})` as a 0-length filter chain, and liblzma then failed the empty RAW chain with `LZMAError: Internal error` instead of the expected `TypeError` (test_lzma.test_bad_args). Now a `dict` argument raises `TypeError` (`<type> is not a sequence`) before reaching the C; arrays/strings/sequences are unchanged.
- [x] **`PyType_Ready` honors `tp_dictoffset` via a `__getattr__` fallback — instance attributes in a C dict work** (runtime-verified; general). A type with `tp_dictoffset` (pygame's `Event`: `ev.key`, `ev.pos`, …) stores instance attributes in a real dict at `(self_ptr + dictoffset)`, and CPython's `PyObject_GenericGetAttr` reads it; Brython's getattr didn't, so only `ev.dict['key']` worked, not `ev.key`. Now `PyType_Ready` installs a `__getattr__` that reads that C dict (via `str_dict_get` — the dict is filled by `PyDict_SetItemString`/`str_dict_set`, which `$getitem` doesn't read back reliably) and, crucially, calls `$B.make_getattr(cls)` afterwards: Brython bakes the `__getattr__` fallback into `cls.$getattribute` at build time, and we'd set `$getattribute = object.tp_getattro` earlier (before the fallback existed), so without the rebuild the fallback never fired. Verified: `for e in pygame.event.get(): if e.type == KEYDOWN: e.key` drives the breakout paddle — 100% standard event code.

- [x] **`PyType_Ready` wires the in-place number slots + fixes two swapped nb_ offsets** (runtime-verified; general). The number-protocol wiring installed `__add__`/`__sub__`/`__mul__`/… but not the *in-place* variants — so `v += w` on a pygame `Vector2` fell back to `__add__` (a brand-new object) and the caller's variable silently stopped tracking it (a bouncing ball froze mid-air while everything else animated). Added `__iadd__` (nb_inplace_add @76), `__isub__` (@80), `__imul__` (@84), `__ifloordiv__` (@124), `__itruediv__` (@128), which return the mutated self. Also fixed `__floordiv__`/`__truediv__`, which read offsets 112/116 (= `nb_inplace_or` / `nb_floor_divide`) instead of the correct 116/120 — a latent wrong-slot bug. Verified: `Vector2(x,y) += Vector2(dx,dy)` mutates in place; the breakout ball moves.

- [x] **Built-in type singletons get functional protocol tables** (runtime-verified; general). C extensions *delegate* to the built-in singleton structs — pygame's `ScancodeWrapper.__getitem__` calls `PyTuple_Type.tp_as_mapping->mp_subscript(...)` and its `tp_new` calls `PyTuple_Type.tp_new` — but the bridge's zero-filled structs only carried `tp_iter`, so `key.get_pressed()[K_LEFT]` died on an *indirect call to null*. Now `PyTuple/PyList/PyDict/PyUnicode_Type.tp_as_mapping` share a generic mapping table (`wasthon_builtin_mp_length`/`mp_subscript` shims dispatching to Brython) and `PyTuple_Type.tp_new` is a tuple-subtype-aware shim (builds a real Brython tuple from `args[0]`, stamps the subtype class). Subtlety: the subscript shim does **raw array access**, not `$B.$getitem` — the C caller invokes it *as the base class's slot* from inside the subclass's own subscript, so a virtual dispatch re-enters the subclass `__getitem__` (infinite recursion, seen live). Verified: `pygame.key.get_pressed()[K_LEFT]` → `False`.

- [x] **Float conversions (`%f`/`%e`/`%g`, with precision) in `PyOS_snprintf` and `PyUnicode_FromFormat`** (runtime-verified; general). Both formatters only knew the integer/string codes and echoed float tokens verbatim — pygame reprs go through `PyOS_snprintf`, so `repr(Vector2(3,4))` printed `[%g, %g]` and `Clock` printed `<Clock(fps=%.2f)>`. Doubles are read 8-aligned from the varargs; `%g` maps to `parseFloat(toPrecision(p||6))` (shortest form), `%f` to `toFixed`, `%e` to `toExponential`. Verified: `[3, 4]`, `[6, 8]`, `fps=0.00`.

- [x] **`PyArg_ParseTuple*` implements the `(...)` sub-tuple format** (runtime-verified; general). A parenthesized group like `"(ii)"` is ONE Python sequence argument unpacked into one varargs out-pointer per inner code — pygame parses every size/position that way (`image.frombytes("(ii)")`, `set_mode`, …) and failed with *"format char '(' not implemented"*. The slot counter now counts a group as a single argument (and `&`/`!` as suffixes of the preceding code, fixing a latent overcount in the max-args check); the walker unpacks the sequence via `$getitem` with int (`coerceInt`) / `f`/`d` (HEAPF32/64) / `O` stores. Verified: `pygame.image.frombytes(b'…', (2,2), 'RGBA')` returns a real `Surface(2x2)`.

- [x] **`PySequence_DelItem` deletes natively on Brython lists (tagged JS arrays) — pygame per-pixel draws work** (runtime-verified). The first pass went through `$getattr(s, '__delitem__')`, which fails on the bridge's own `PyList_New` lists (plain JS arrays tagged with `OB_TYPE`/`__class__`); pygame's surface lock bookkeeping (`pgSurface_UnlockBy` pruning its locklist via `PySequence_DelItem`) then errored, so every per-pixel draw — `pygame.draw.circle` / `line` / `polygon`, anything that locks the surface — raised `RuntimeError('error unlocking surface')` (`draw.rect` survived only because a filled rect is `SDL_FillRect`, no lock). Now `Array.isArray` → bounds-checked `splice` (the same native-array idiom as the `PyList_*` functions), `$getattr` path kept for real mapping/sequence objects. Verified in the browser: `draw.circle` + `draw.line` on the display surface succeed.

- [x] **pygame render path: `PyArg` `O!` (typed object) + `PyModule_AddType` readies the type + `PyImport_ImportModule` resolves C submodules** (runtime-verified to `set_mode`+`fill`+`draw.rect`). Three gaps surfaced driving pygame's display path in the browser: (1) `PyModule_AddType` errored *"type handle N not in types map"* for pygame's Clock/Vector/… because it assumed the type was already readied — CPython's `PyModule_AddType` calls `PyType_Ready` first, so now it does too (fixed `PyInit_time`/`key`/`window`/`pixelarray`; submodules 19 → 27). (2) `PyImport_ImportModule("pygame.time")` (pygame's `pg_mod_autoinit`) fell through to Brython's finder, which has no `.py` for it — now it resolves C-registered submodules from the modules dict first (`str_dict_get`, matching `PyDict_SetItemString`'s `str_dict_set`). (3) `PyArg_ParseTuple*` didn't implement `O!` (typed-object: consumes a `PyTypeObject*` + output `PyObject**`, requires `isinstance`) — `pygame.draw.rect` uses `"O!…"` to require a `Surface`. With these, `pygame.display.set_mode((640,480))` returns a real `Surface(640x480x32)` and `screen.fill(...)` / `pygame.draw.rect(...)` run. (Still open: presenting the software surface to the `<canvas>`, and the surface lock/unlock path for per-pixel draws.)

- [x] **`PyType_Ready` wires the direct protocol slots (tp_repr / tp_str / tp_hash / tp_richcompare) — pygame `Rect` is fully functional** (runtime-verified). Reads the four function pointers straight from the static struct (offsets 52/104/96/128) and wraps them like `PyType_FromModuleAndSpec`'s `'r'`/`'i'`/`'c'` shapes, installing BOTH the Brython slot name (`cls.tp_repr`/`tp_str`/`tp_hash` — what `str()`/`hash()` read) AND the dunder (`__repr__`/`__str__`/`__hash__`). Subtlety: `repr()` worked off the dunder alone, but Brython's `str()` looks up `cls.tp_str`, so the slot name is required. Verified in the browser: `pygame.rect.Rect` round-trips `repr`/`str` = `"Rect(0, 0, 10, 20)"`, `==` (richcompare over 6 dunders sharing one C slot), `hash`, and C methods (`r.move(5,5)` = `Rect(5, 5, 10, 20)`). The number/sequence/mapping sub-tables (`r[0]`, arithmetic) are wired next, when a program needs them.

- [x] **pygame-ce RUNS on wasthon: `PyType_Ready` wires tp_new/tp_init + fills default tp_alloc/tp_free — real `Rect` instantiates** (runtime-verified). The first-pass `PyType_Ready` built the Brython class + installed methods/getsets but not instantiation; `pygame.rect.Rect(0,0,10,20)` first hit `new_func is undefined` (`$is_slot` on an unwired `tp_new`), then `indirect call to null` (pygame leaves `.tp_alloc` NULL expecting `PyType_Ready` to fill the default, as CPython does — its `tp_new` then calls `type->tp_alloc(type,0)` on NULL). Now `PyType_Ready` reads the static struct's `tp_new` (offset 60) / `tp_init` (offset 20) and wraps them exactly like `PyType_FromModuleAndSpec` (scoped C-call, exception forwarding, subclass `ob_type` patch, `__new__`/`__init__` install), and fills the bridge default `tp_alloc`/`tp_free` where the static struct left them NULL. Verified in the browser: real pygame-ce (compiled to WASM, linked to the bridge) imports as `pygame` with 19 C submodules, and `pygame.rect.Rect(0,0,10,20).width == 10`. Protocol slots (`tp_repr`/`str`/`richcompare`/number/sequence/mapping) wired incrementally next.

- [x] **11 more classic C-API functions — pygame-ce now links with ZERO undefined symbols** (module machinery, type readying, error state; general). Implemented the deeper tier in `wasthon.js`: `PyModule_Create2` / `PyModule_FromDefAndSpec2` / `PyModule_ExecDef` / `PyModule_GetDict` / `PyModule_AddObject` / `PyImport_GetModuleDict` (single- and multi-phase module construction, modeled on `wasthon_module_create` + `PyModuleDef_Init`), `PyType_Ready` (reads a static `PyTypeObject` at the wasthon.h offsets and builds a Brython class via `make_builtin_class` + `install_methods`/`getsets`/`members`, binding the struct pointer as the type handle — number/sequence/mapping/richcompare/new slot wiring still to be refined against runtime), `_PyObject_New` (→ `wasthon_object_gc_new`), `PyErr_Fetch` / `PyErr_Restore` (via the `pendingException` state), `PyBytes_AsStringAndSize`, `PySlice_GetIndicesEx`, `PySequence_Fast_ITEMS`, `PyCapsule_IsValid` / `PyCapsule_CheckExact`. With `-DNO_SDL2` (drops the cython `_sdl2.*` renderer submodules) plus a `rotozoomSurface` shim, `_pygame.mjs` links clean. Compiles + links; runtime (browser import) is the next validation.

- [x] **14 trivial classic C-API functions implemented for the pygame port** (Brython one-liners; link stubs → real). After the type-object surface below, `_pygame.mjs` linked with 28 undefined C-API symbols; the straightforward ones are now wired to Brython builtins / `$B` in `wasthon.js`: `PyObject_Size` (`len`), `PySeqIter_New` (`iter`), `PyNumber_Power` (`pow`, 2/3-arg), `PyUnicode_Find` (JS `indexOf`/`lastIndexOf` over `s[start:end]`), `PyObject_IsSubclass` (`issubclass`), `PyDict_GetItem` / `PyDict_GetItemString` (borrowed, error-suppressing per the CPython contract), `PySequence_DelItem` (`__delitem__`), `PyOS_FSPath` (str/bytes passthrough else `__fspath__`), `PyEval_SaveThread` / `PyEval_RestoreThread` (single-threaded no-ops — no GIL), `PyObject_Del` / `PyObject_ClearWeakRefs` (JS-GC no-ops), `PyState_FindModule` (untracked → NULL so the caller creates fresh), `PyWeakref_CheckRef`. Undefined link stubs 28 → 13; the remainder (`PyType_Ready`, the `PyModule_*` / `PyImport_GetModuleDict` machinery, `_PyObject_New`, `PyErr_Fetch`/`Restore`, `PyBytes_AsStringAndSize`, `PySequence_Fast_ITEMS`, `PySlice_GetIndicesEx`, `PyCapsule_IsValid`) is the deeper tier. Compiles + links; not yet runtime-verified (blocked on the module machinery).

- [x] **Type-object protocol surface + classic C-API declarations for type-defining C modules** (enables pygame-ce to compile+link; general). cimgui only exposed *functions*, so a thin bridge sufficed; a C extension that DEFINES types (pygame's `Rect`/`Surface`/`Color`…) needs the full slot-typedef + protocol-table + `PyTypeObject`-field surface, none of which `wasthon.h` declared — pygame-ce's `base.c` (its whole engine merged into one translation unit via `BUILD_STATIC`) hit 379 compile errors. Almost all were pure *declarations*: the bridge (from the pickle/decimal ports) already IMPLEMENTS the classic C-API, it just never declared it. Added to `wasthon.h`: the slot typedefs (`reprfunc`/`richcmpfunc`/`getiterfunc`/`hashfunc`/`lenfunc`/`ssizeargfunc`/`getbufferproc`/…), the protocol tables (`PySequenceMethods`/`PyMappingMethods`/`PyBufferProcs`/`PyAsyncMethods`), the remaining `PyTypeObject` fields appended at the struct's end (pygame uses designated initializers ⇒ field order is irrelevant and the historical offsets read by blake2/zlib don't shift), opaque thread/frame stubs (single-threaded, no GIL), `Py_IS_NAN`/`Py_IS_INFINITY`, the legacy `READONLY`/`T_DOUBLE`/`T_FLOAT` member aliases, and ~40 function prototypes. Wired 6 exception singletons (`PyExc_BaseException`/`SyntaxError`/`RuntimeWarning`/`FutureWarning`/`FileNotFoundError`/`IOError`→`OSError`) in `wasthon.c`/`wasthon.js` on the existing `wasthon_get_PyExc_*` pattern. Result: `base.c` compiles with 0 errors and links to `_pygame.mjs`, leaving 26 not-yet-implemented C-API functions (`PyType_Ready`, `PyModule_Create2`, …) as the only remaining link stubs.

- [x] **`PyArg_ParseTuple*` implement the `s`/`z` (C string) and `f`/`d` (float/double) formats** (general; enables native C/C++ extensions). The legacy varargs parser only knew the integer codes + `O`/`U`/`p`/`C`, so any module using the two most common scalar formats failed with `SystemError: format char 's' not implemented` — every C extension parsing a string (`"s"`) or a float (`"f"`/`"d"`) was stuck. Surfaced while binding Dear ImGui / ImPlot (a real third-party C/C++ extension driven from Python through the bridge): the glue had to parse everything as `'O'` and convert by hand (`PyUnicode_AsUTF8`, `PyFloat_AsDouble`). Now `s`/`z` reuse `PyUnicode_AsUTF8` to write the cached UTF-8 `char*` (`z` maps `None`->`NULL`); `f`/`d` reuse `PyFloat_AsDouble` and store to `HEAPF32`/`HEAPF64`. Verified end-to-end: `igText` via `"s"` and `igSliderFloat` via `"sfff|i"` (string + 3 floats + optional flags) render correctly from Python. No suite regression (the parser's existing codes are untouched).

- [x] **`PyUnicode_FromStringAndSize` decodes the explicit byte slice** (+5 sqlite3; general). It used `UTF8ToString(uPtr, size)`, which stops at the first embedded NUL even with a size bound (C-string semantics), so a text value carrying a `\0` was truncated — sqlite3 returned `'a'` for the stored `'a\x00b'` (test_execute_arg_string_with_zero_byte, test_string_with_null_character, the embedded-zero TextFactory / aggregate / function text tests). Now decodes exactly `size` bytes via `TextDecoder` (ignoreBOM); `size < 0` keeps the NUL-terminated path.

- [x] **UCS4 materializers store one codepoint per element, not per UTF-16 unit** (+1 array -> **test_array GREEN**; general). `PyUnicode_AsWideChar`, `PyUnicode_AsWideCharString`, `PyUnicode_AsUCS4`, `PyUnicode_AsUCS4Copy` and `PyUnicode_4BYTE_DATA` all walked the JS string by UTF-16 code unit (`charCodeAt`, or `codePointAt` with a +1 step) and wrote one 4-byte element each — so an astral char (> U+FFFF) became its surrogate pair / a lone low surrogate instead of the codepoint. `array('u'/'w', '𠌊𠍇')` then held surrogates and didn't match a UTF-32 / frombytes reconstruction (test_array.test_unicode). Now each walks by codepoint (skipping 2 past a surrogate pair), one codepoint per UCS4 element — consistent with `PyUnicode_FromWideChar` / `GET_LENGTH` (the read side). Last test_array failure; suite now 790/0.

- [x] **`ignoreBOM: true` on the other two utf-8 `TextDecoder`s** (+0 measured; completes the BOM fix below). `PyUnicodeWriter_WriteUTF8` and the generic `PyUnicode_Decode(encoding)` path also did a plain `TextDecoder('utf-8')`, stripping a leading U+FEFF; same fix, scoped to utf-8 (utf-16/utf-32 still consume the BOM as the byte-order mark). No suite drives a BOM-leading string through these two paths today, but it removes the same bug from the siblings.

- [x] **`PyUnicode_DecodeUTF8` keeps a leading BOM** (+6 array; general). Its fast path did `new TextDecoder('utf-8').decode(bytes)`, and `TextDecoder` defaults to STRIPPING a leading U+FEFF byte-order mark — so a string starting with `'﻿'` decoded to `''` (and any longer string lost its leading BOM). CPython's UTF-8 codec never strips it. Surfaced as `array('u', '…﻿')` losing the char through a binary pickle round-trip (_pickle's BINUNICODE load -> DecodeUTF8): test_array's test_pickle / test_iterator_pickle / test_reverse_iterator_picking (UCS4 + Unicode) and test_unicode. Now `new TextDecoder('utf-8', { ignoreBOM: true })`.

- [x] **`PyObject_Call` forwards keyword args via the `$kw` marker** (+0 measured; latent, general). It unwrapped only the positional `args` tuple and dropped `kwargsH` entirely, so any C code making an `(args, kwargs)` call through `PyObject_Call` lost every keyword. The sister `PyObject_Vectorcall` had the identical bug (fixed earlier, +38 sqlite3); the current suites' keyword-forwarding paths happen to go through Vectorcall, so this measures +0 — but it removes the same latent footgun from `PyObject_Call`. Mirrors the Vectorcall fix: iterate `kwargs.items()` into a `{name: value}` map pushed as `{ $kw: [map] }`.

- [x] **`PyUnicode_FromOrdinal`/`FromWideChar` raise ValueError on an out-of-range codepoint** (+1 array; general). Both called `String.fromCodePoint(cp)` unguarded, which throws a JS RangeError for `cp > 0x10FFFF` — so a `'u'`/`'w'` array holding a corrupt item read as `0xFFFFFFFF` leaked a `JavascriptError` from `array('u', b'\xff'*4).tounicode()` / `str(...)`. CPython raises ValueError there (test_array.test_issue17223). Now both catch the RangeError and set ValueError.

- [x] **`_PyErr_FormatNote` appends to the exception's `__notes__`** (+5 json; PEP 678). It was a no-op, so the breadcrumb _json's encoder attaches as it unwinds a failed serialization ("when serializing %T item %R") never landed and `exc.__notes__` was never created -> test_json's `cm.exception.__notes__` assertions raised AttributeError (test_default/test_fail/test_recursion). Now formats the message (minimal %T/%R/%S/%d/%s printf subset, the codes _json uses) and pushes it onto the pending exception's `__notes__` (creating the list if absent), mirroring `BaseException.add_note`; successive notes accumulate innermost-first on the same instance as the C stack unwinds.

- [x] **`PyArg_Parse*` `p` (predicate) writes a full int, not 1 byte** (+1 json; general). The `p` converter stored the truth value with `HEAPU8[outPtr]` — a single byte — but CPython's `p` writes an `int*` (4 bytes). The C `int` flag's high 3 bytes stayed uninitialized (stack garbage), so a False predicate could read back as a nonzero int. _json's `make_encoder(..., allow_nan=False)` then saw `s->allow_nan` as true, so `dumps(float('nan'), allow_nan=False)` never raised. Now `HEAP32[outPtr >> 2]`. Affects every `p`-format bool flag; no regression (bz2 92/6, zstd 104/14, zlib 57/0, struct 36/0 unchanged).

- [x] **builtin `tp_repr` reflects the base type for int/float subclasses** (+2 json; general). The shared `wasthon_builtin_tp_repr` trampoline (the PyLong_Type/PyFloat_Type tp_repr slot) did a plain `repr(obj)`, which dispatches on the subclass's `__repr__`. _json's encoder calls `PyLong_Type.tp_repr` / `PyFloat_Type.tp_repr` on int/float subclasses (IntEnum, IntFlag, float enums), so a member encoded as its enum repr ("<BigNum.small: 1>") instead of its value ("1"). Now int/float route through the base type's `__repr__` (CPython's `PyLong_Type.tp_repr(x)` is `int.__repr__(x)`, ignoring overrides); plain int/float are unchanged.

- [x] **`PyErr_SetObject` preserves a numeric value's type** (+5 json; general). For a value that is neither a string nor an exception instance it did `String(v)` and reconstructed `exc("<str>")`. _json's `raise_stop_iteration` sets `StopIteration(idx)` with an int, so `err.value` came back as the str `"5"`; the decoder's `raise JSONDecodeError("Expecting value", s, err.value)` then hit `doc.count('\n', 0, pos)` with a str pos -> "'str' object cannot be interpreted as an integer" on every "Expecting value" decode error (test_fail/test_decode C paths). Now a number/bigint builds `exc(value)` and keeps the instance (pendingExc returns it as-is), so `.value` stays an int -- CPython's `PyErr_SetObject(exc, value)` semantics.

- [x] **`tp_name` resolves the builtin class name via `$getattr`** (+2 json; general). The `tp_repr`/`tp_name` wiring below read the name as `(cls.$infos && cls.$infos.__name__) || cls.__name__`, but builtin classes (`_b_.int`, `_b_.tuple`, ...) keep `__name__` in a slot, not as a direct JS property -> both read `undefined` -> tp_name stayed NULL -> `Py_TYPE(x)->tp_name` still printed "(null)". _json's TypeErrors ("keys must be ... not (null)", "make_encoder() argument 1 must be dict or None, not (null)") now read the real name ("tuple"/"int"). Resolved through Brython's `$getattr(cls, '__name__')` and force-set (the static C struct's offset 12 is unreliable under the bridge's PyTypeObject layout, so only-if-zero couldn't be trusted). Fixes every "not <type>" message that goes through a builtin's `tp_name`.

- [x] **`PyList_Sort` sorts with Python `__lt__`** (+2 json -- completes sort_keys with the `PyMapping_Items` fix above). It called JS `arr.sort()` (lexicographic string sort), which stringifies elements and throws on Brython objects with no usable `toString`. _json's encoder sorts a list of (key, value) tuples under `sort_keys=True`; the bare sort corrupted the order or threw -> "tp_call returned NULL". Now sorts via Brython's `rich_comp('__lt__', ...)`; an unorderable-keys TypeError is the faithful CPython result.

- [x] **`PyMapping_Items` calls `d.items()` via `$getattr`** (+3 json; pairs with the `PyList_Sort` fix below for the full sort_keys path). It did `rt._b_.dict.items(d)`, but `dict.items` is not a direct JS property on `_b_.dict` (Brython keeps it in the type method table, like `__delitem__`) -> `undefined` -> "is not a function" -> caught -> silent NULL. The C encoder's `PyMapping_Items(dct)` (sort_keys / non-exact dicts) then returned NULL -> "tp_call returned NULL". Now resolves `d.items` through Brython attribute lookup (works for any mapping).

- [x] **`tp_repr` + `tp_name` wired on builtin type structs** (+1 json; general). Builtin singletons (`PyLong_Type`, `PyFloat_Type`, ...) bound by `wasthon_bind_builtin_type` left their C struct's `tp_repr` (offset 52) and `tp_name` (offset 12) NULL. _json's encoder calls `PyLong_Type.tp_repr(obj)` / `PyFloat_Type.tp_repr(obj)` to stringify ints/floats -> indirect call to null; and `Py_TYPE(key)->tp_name` in its TypeError messages printed "(null)". Now wired only-if-zero (never clobbering a real C slot): tp_repr -> a `repr(obj)` trampoline, tp_name -> the class name. Mirrors the earlier `tp_iternext` fix.

- [x] **`PyObject_CallFunction` format parser handles `z`/`n`/`l`/`k`/`f`** (+4 json -- completes the decoder-error path with the `_Py_STR` enabler above). Its mini Py_BuildValue parser knew only `O`/`s`/`i`/`d`; any other code returned without advancing the vararg cursor, so every following argument was read from the wrong slot. _json's `raise_errmsg` builds `JSONDecodeError` via `PyObject_CallFunction(JSONDecodeError, "zOn", msg, s, end)` -- the skipped `z`/`n` left `O` reading the char* `msg` as a handle and dropped `end`, so decode errors surfaced as "tp_call returned NULL" or a str `pos` ("'str' object cannot be interpreted as an integer"). Every recognised code now advances `p` by its vararg width.

- [x] **`_Py_STR(name)` resolves `_Py_DECLARE_STR` literals** (+0 json alone; enabler, pairs with the `PyObject_CallFunction` fix below for the decoder-error cluster). `_Py_STR(name)` expanded to `Py_None` for every name and `_Py_DECLARE_STR(name, literal)` was a no-op, so _json's `raise_errmsg` -- which imports JSONDecodeError via `PyImport_ImportModuleAttr(&_Py_STR(json_decoder), ...)` -- got `None` as the module name -> import silently returned NULL. (Construction still failed until the CallFunction format parser was fixed, hence +0 in isolation.) `_Py_DECLARE_STR` now stashes the literal and `_Py_STR` interns it on demand; the predefined global `empty` (no literal; _sre/_io use it as the empty-separator sentinel) stays `Py_None`.

- [x] **`PyDict_DelItem` uses the `dict.$delitem` primitive** (+9 json). It called `rt._b_.dict.__delitem__(d, k)`, but `__delitem__` is not a direct attribute on `_b_.dict` (Brython keeps it in slots) -> `undefined(d,k)` -> always -1. _json's encoder bails cleaning up its circular-reference marker, so `json.dumps([1])` raised "tp_call returned NULL". Now uses `dict.$delitem` (like `$setitem`/`$contains`).

- [x] **`PyArg_Parse` integer formats coerce via `__index__` only** (+7 array).
      The `b/h/i/l/L/q` converters accepted a Python float through Brython's
      boxed-`{value}` fast-path, silently truncating it into an integer array —
      `array('i').append(42.0)` didn't raise. CPython's getargs coerces integer
      formats through `__index__` (a float has none → "'float' object cannot be
      interpreted as an integer"); only `f`/`d` take a float (and still accept
      `nan`/`inf` — the `isNaN` reject now fires only on the last-resort
      `Number(arg)` coercion, not a boxed float). `test_array`'s
      `test_type_error` + `test_nan`; unsigned `I`/`Q` already rejected via
      `PyLong_AsUnsigned*`.

- [x] **slot 25 (`Py_mp_length`) wires `__len__`** (+6 sqlite3, +1 decimal;
      zero regression). The slot-dispatch table mapped `mp_subscript` (27) and
      `sq_length` (29) but omitted `Py_mp_length` (25), so a type exposing only
      `mp_length` got no `__len__` — `len(sqlite3.Blob)` and `len(sqlite3.Row)`
      raised "object has no len()". No ID collision at 25 (unlike 29/32); the
      length-style dispatch already handled the `mp_length` name, only the table
      entry was missing.

- [x] **bytes results sync their C-written buffer in `unwrapResult`** (+5
      sqlite3; zero regression). `PyBytes_FromStringAndSize(NULL, n)` hands C a
      writable `__wasthon_cstr__` buffer while `.source` stays zero-filled; the
      tp_methods trampoline folded it back (`syncBytes`) but slot returns
      (`mp_subscript` / `sq_item`) did not — so `Blob[slice]`
      (`sqlite3_blob_read` into `PyBytes_AS_STRING`) read all zeros. Fold the
      buffer in `unwrapResult`, which every trampoline funnels through
      (idempotent: `syncBytes` clears `__wasthon_cstr__` after folding, and a
      read-only `PyBytes_AsString` copy already mirrors `.source`).

- [x] **`PyObject_Vectorcall` forwards keyword arguments** (+38 sqlite3; zero
      regression). It dropped `kwnames` entirely ("rare in sre's call sites"),
      so any C code forwarding a fastcall with keywords lost them.
      `sqlite3.connect` forwards every keyword (`isolation_level`, `timeout`,
      `detect_types`, …) to the `Connection` factory through
      `PyObject_Vectorcall`, so all of them silently reverted to defaults —
      e.g. `connect(isolation_level='BOGUS')` skipped the `ValueError`
      validation, and `connect(detect_types=…)` / `factory=…` were ignored.
      Read the `kwnames` tuple plus the trailing keyword values and forward
      them through Brython's `$kw` marker (the tp_init/tp_call trampolines
      already flatten it).

- [x] **`PyErr_FormatUnraisable` routes to `sys.unraisablehook`** (+23 sqlite3;
      zero regression). It silently dropped the pending exception. Now it builds
      the `err_msg` — expanding the printf format (incl. `%R`, reading the wasm
      va list like `Py_BuildValue`) — and forwards `(exc_type, exc_value,
      err_msg)` to a harness helper that calls `sys.unraisablehook`. Paired with
      the harness's real `test.support.catch_unraisable_exception`,
      `test_sqlite3`'s `@with_tracebacks` now captures exceptions raised inside
      aggregate / user-function / trace / progress / authorizer callbacks — 24
      methods previously compared the `_Flex` support stub to the expected
      class. (Harness side lives in `test-cpython.html`, not the bridge.)

- [x] **`&PyList_GET_ITEM(list,0)` writes flush back + `PyBytes_Join` treats
      `Py_None` as the empty separator** (+1 re; zero regression).
      `wasthon_list_items` materialises a list into a *disjoint* C buffer, so
      `out = &PyList_GET_ITEM(list,0); out[i]=…; PyBytes_Join(sep,list)` —
      `_sre`'s `expand_template` bytes path — joined the untouched Brython list
      (all `None` → `NoneType.join`). Record the last materialisation;
      `Py_SET_SIZE(list,n)` now flushes that buffer back into the array before
      the read. Plus `_Py_SINGLETON(bytes_empty)` maps to `Py_None` in the
      bridge, so `PyBytes_Join` uses `b''` for it (mirrors
      `_PyUnicode_JoinArray`). Fixes bytes group-ref `re.sub()` templates
      (`test_symbolic_refs`).

- [x] **`forwardError` preserves the exception INSTANCE** (+3 re; zero
      regression). When a Python exception crosses a C call — `re._parser`
      raising `re.PatternError` through `_sre`'s `compile_template` — the bridge
      caught the Brython exception and rebuilt it as `cls(msg)`, refeeding the
      already-formatted `"<msg> at position N"` string as the constructor's
      first arg. `PatternError.__init__` then stored that whole string as
      `.msg` and left `.pos` `None`, but `test_re`'s `checkTemplateError` /
      `checkPatternError` assert `err.msg == "<msg>"` and `err.pos == N`
      (`test_symbolic_refs_errors`, `test_sub_template_numeric_escape`). Keep
      the original instance (guarded to `BaseException`) in
      `pendingException.value`, like `setError` already does for C-built
      exceptions — `pendingExc` re-raises it untouched.

- [x] **C var-objects: `Py_NewRef` single-eval + `PyObject_GC_NewVar` sets
      `ob_size`** (+4 re; zero regression). Two coupled bugs broke every
      group-ref / escape `re.sub()` template (`re.sub('(.)', r'\1\1', 'x')` →
      `''`, bytes path → `NoneType.join`): (1) `Py_NewRef`/`Py_INCREF`/`Py_DECREF`
      were macros that re-read `op` (`Py_NewRef` 3×); harmless for a plain
      lvalue, but `PyList_GET_ITEM(l,i)` expands to `wasthon_list_items(l)[i]`,
      which re-materialises the list with FRESH handles each call — so
      `self->literal = Py_NewRef(PyList_GET_ITEM(t,0))` INCREF'd one handle and
      STORED another (never counted → released → reads back `None`). Now
      single-eval via `static inline`, like CPython. (2) `PyObject_GC_NewVar`
      malloc'd `basicsize + n*itemsize` and zeroed it but never wrote the item
      count, so `Py_SIZE()` was 0 for all C var-objects — `_sre`'s TemplateObject
      gates on `Py_SIZE`, reading a 2-group template as a bare empty literal.

- [x] **`_PyLong_UInt64_Converter` raises OverflowError past `UINT64_MAX`** (+1
      random; zero regression). It wrote the low 64 bits with no range check, so
      `getrandbits(1 << 1000)` truncated to `k = 0` (its low 64 bits) and
      returned 0 instead of raising — `test_random`'s `test_getrandbits`. Bound
      to `0xFFFFFFFFFFFFFFFF` like CPython's converter.

- [x] **`_PyArg_BadArgument` appends `, not <type>`** (+1 pyexpat; zero
      regression). It built `"<fn>() <disp> must be <exp>"` and ignored the
      offending `arg`, so clinic type errors read e.g. `ParserCreate() argument
      'namespace_separator' must be str or None` — missing CPython's `, not int`
      tail (`test_pyexpat`'s `NamespaceSeparatorTest.test_illegal`). Append
      `, not ` + (`None` for `Py_None`, else the value's class name), matching
      `PyErr_Format(..., "%s() %s must be %s, not %s", …)`.

- [x] **The raised exception INSTANCE survives the bridge** (+2 pyexpat, +1
      sqlite3; zero regression). Every trampoline rebuilt the pending exception
      as `exc(msg)` from `{exc, msg}`, discarding the object C had actually
      raised — so attributes C set on it were lost. `pyexpat`'s `set_xml_error`
      builds an `ExpatError`, sets `.code`/`.lineno`/`.offset` on it, then
      `PyErr_SetObject`s it; the caught exception had none of them
      (`test_expaterror`, `test_parse_again`). Now `setError` carries an optional
      `value` (the instance) and a single `pendingExc(pe, fallbackExc)` helper —
      used by every throw site (~19, incl. the tp_methods call trampoline and
      tp_init) plus `PyErr_GetRaisedException` — returns it when present.
      Restricted to genuine `BaseException` instances: `_decimal` passes a *list*
      of signal flags as the `PyErr_SetObject` value, which must still build
      `exc(flags)` rather than be thrown as-is (that overbroad match cost −14
      decimal before the `isinstance` guard).

- [x] **`wasthon_float_nb_absolute` reads a boxed float's `.value`** (+1
      statistics → 370/370 runnable, +4 decimal; zero regression). It did
      `Math.abs(typeof x === 'number' ? x : Number(x))`, but a Brython float is
      a raw JS number only for some literals/fast-paths — results of `rich_op1`
      division, `random.expovariate`, etc. are boxed `{ob_type: float, value:
      …}`, and `Number({…})` is `NaN`. So `abs()` of any *computed* float was
      `NaN`. `_decimal`'s `Decimal(float)` (`PyDecType_FromFloatExact`) calls
      `float.__abs__` as `_py_float_abs` *before* `as_integer_ratio`, so
      `Decimal(<computed float>)` died with "cannot convert NaN to integer
      ratio" — `statistics.geometric_mean`'s Decimal cross-check
      (`math.prod(map(Decimal, expovariate_data))`) hit it. Extract `.value`
      like `PyFloat_AsDouble` already does. The sibling
      `wasthon_float_as_integer_ratio` (which raises that very message, and is
      `_decimal`'s cached `_py_float_as_integer_ratio`) had the same blind spot
      on a boxed operand — same `.value` guard added so it can't recur.

- [x] **`PyLong_AsDouble` handles a `bool`** (+1 statistics; zero regression).
      It returned `obj` for a JS number and `Number(obj)` for a BigInt but fell
      through to `return 0` for a JS boolean. `math.fsum`'s `ASSIGN_DOUBLE` macro
      routes a `bool` through `PyLong_AsDouble` (CPython: `bool` is an `int`
      subclass, `PyLong_AsDouble(True) == 1.0`), so `fsum([True, False, True,
      True, False])` summed every element as `0.0` → `statistics.fmean` over
      booleans returned `0.0` instead of `0.60`. `float(True)` already worked
      (it goes through `nb_float`); only the long-conversion C-API path was
      blind to bools. Added `typeof obj === 'boolean' → obj ? 1 : 0`.

- [x] **`PyNumber_Add`/`Multiply`/`FloorDivide`/`TrueDivide`/`Remainder`/`And`
      use Brython's `rich_op1`** (+9 statistics; zero regression). Each did a bare
      `$call($getattr(a, '__op__'), b)` with no fallback when the left operand's
      slot returns `NotImplemented`. `PyNumber_Add(int, float)` therefore handed
      back `NotImplemented` (`int.__add__` rejects a float and CPython then tries
      `float.__radd__`): `math.sumprod`'s float-total finalize
      (`PyNumber_Add(total=int 0, term=float)`) blew up with "`'NotImplementedType'
      object has no attribute '__add__'`", taking out every float `sumprod`
      (statistics' correlation / covariance / fmean / KDE). `$B.rich_op1(op, a, b)`
      is Brython's own binary-operator protocol — numeric fast path, then
      `op` → reflected `rop` → `TypeError` — so the reflected operand is tried
      and a mixed int/float add yields the right `float`. The numeric fast paths
      already in `PyNumber_Add`/`Multiply` (JS-number + BigInt) are kept;
      only the generic-object fallback changed.

- [x] **`ensureTypeStruct` installs `tp_iternext` (offset 56)** (+1 statistics,
      +1 math; zero regression). C code that reads `Py_TYPE(it)->tp_iternext`
      and calls it directly — `math.sumprod` caches
      `p_next = *Py_TYPE(p_it)->tp_iternext; p_i = p_next(p_it);` — needs a real
      function pointer in that slot. For a Brython-backed iterator (the
      `list_iterator` from `PyObject_GetIter`), `Py_TYPE` routes through
      `ensureTypeStruct`, which synthesised a zero-filled 64-byte type struct and
      populated `tp_iter` (offset 24) but never `tp_iternext` (offset 56) — so
      the call was an indirect call to null and every `sumprod` trapped
      ("indirect call to null", long mistaken for a missing C `fma`; `fma` links
      fine — the int path, which never touches `fma`, crashed too). Added a
      generic `wasthon_builtin_tp_iternext` trampoline (mirrors `PyIter_Next` and
      CPython's `listiter_next`: `next(it)`, returning NULL with NO exception at
      StopIteration, which `sumprod`'s `if (p_i == NULL) { if (PyErr_Occurred())
      …; p_stopped = true; }` loop handles) plus its C accessor, installed for
      every struct symmetrically with `tp_iter`.

- [x] **_decimal's cached int arithmetic resolves int's ops via `$getattr`**
      (+33 statistics, +1 decimal; zero regression). `wasthon_long_nb_multiply`
      /`_floor_divide`/`_power` (the PyLong number slots _decimal caches at init
      and calls for `numerator * 10**exp // gcd`) did `$call(rt._b_.int.__mul__,
      …)` — but Brython keeps int's operators as type SLOTS, not direct JS
      attributes, so `rt._b_.int.__mul__` is `undefined` and `$call(undefined)`
      threw `can't access property "$factory" of undefined`. So
      `Decimal.as_integer_ratio()` — and everything in statistics that turns
      Decimals into ratios (mean/harmonic_mean/_exact_ratio) — crashed. The
      audit that routed test_statistics through wasthon's `_decimal` exposed it
      (its 370 had been Brython-inflated). Resolve each op via
      `$getattr(int, '__op__')`.

- [x] **_PyObject_MaybeCallSpecialNoArgs forwards the special method's
      exception** (+1 math; zero regression). Same shape as the
      PyObject_GenericGetAttr fix: a bare `catch (e) { return 0 }` swallowed
      whatever `__ceil__`/`__floor__`/`__round__`/`__trunc__` raised, so
      `math.floor(Decimal('NaN'))` returned None and `math.ceil(TestBadCeil())`
      didn't surface its ValueError — the C caller (math_floor &co) checks
      `PyErr_Occurred()` right after the NULL and falls through to
      PyFloat_AsDouble when the error is gone. Absence of the method still
      returns NULL with no error (the "Maybe"); only a *raising* present method
      now propagates via forwardError.

- [x] **PyLong_AsLongAndOverflow requires `__index__`** (+1 math
      testFactorialNonIntegers; zero regression). The converter took any JS
      number — `Math.trunc`'d a float, and `BigInt(1.5)` even threw a raw
      JS error — so `math.factorial(5.0)` / `(5.2)` / `("5")` /
      `(Decimal('5'))` returned `120` instead of raising TypeError. CPython
      accepts only an int or an object with `__index__`; Brython gives
      `int.__index__` but not `float.__index__`, so looking it up
      distinguishes `5` from `5.0` and rejects float/str/Decimal faithfully.

- [x] **`_Py_c_abs` sets errno on overflow** (cmath.polar/exp/… now raise
      OverflowError on an unrepresentable magnitude; +0 in isolation, but it
      keeps cmath at 26 once the io-seekable fix below lets
      test_cmath.test_specific_values read its data file to completion). The
      wasthon inline stub in `src/pycore_complexobject.h` returned a bare
      `hypot(real, imag)`, dropping CPython's `errno = ERANGE` on overflow and
      the C99 infinity/NaN rules. cmath reads errno to decide whether to raise,
      so `cmath.polar(complex(1.4e308, 1.4e308))` yielded `(inf, …)` instead of
      raising. The truncated BufferedReader read had been hiding the
      `polar0100` case; reading the file fully unmasked this real bug, now
      fixed faithfully (`abs(complex)` already raised — only the C stub
      diverged).

- [x] **PyLong_AsDouble raises OverflowError instead of yielding inf**
      (+4 math: testLog, testLog10, testLog2, testFsum; zero regression). The
      converter did `Number(bigint)`, which silently returns `Infinity` for an
      integer too large for a double — so `math.log(10**1000)` computed
      `log(inf) = inf` instead of `2302.58…`. CPython's `loghelper` deliberately
      calls `PyLong_AsDouble` first and, on its OverflowError, falls back to
      `_PyLong_Frexp` to take the log of an arbitrary-precision int without
      overflowing; that path was never reached. Now a non-finite result sets
      OverflowError "int too large to convert to float" and returns -1.0, the
      exact CPython contract (`math.fsum`'s overflow check rides the same
      conversion).

- [x] **Deterministic free for the one-shot `compress()`/`decompress()`
      helpers** (+16 lzma 96 → 112; zero regression; bz2/zstd helpers wrapped
      too). The earlier close()-shim reclaimed the compression *file* objects,
      but `lzma.compress(data)` / `lzma.decompress(data)` build a throwaway
      `LZMACompressor` / `LZMADecompressor` with NO close() — the ~94 MB
      encoder context leaked, and the tests call `lzma.compress(...)` on every
      round-trip comparison, so the WASM heap OOM'd part-way through the suite.
      The first failed compressor allocation then returned NULL *silently* into
      `LZMAFile.__init__`'s `self._compressor`, so every later
      `with LZMAFile(..., "w")` died at `self._compressor.compress` with a bare
      `Symbol("DICT") of null` (a ~14-test cascade) plus a few direct
      MemoryErrors. tp_dealloc itself was never the problem — it dispatches and
      frees correctly (verified: an explicit free survives 60 iterations that
      otherwise OOM at ~22). The only gap was a deterministic *trigger* for a
      transient with no close(). `loader/wasthon-dealloc.js` now wraps the
      module helpers: it runs the real function (keeping all the
      format/preset/filters logic and the decompress retry loop), then decrefs
      every instance of the compressor/decompressor type it created and left
      behind — firing tp_dealloc on exactly the leaked transients. Capture is
      by type, so the returned bytes are never touched.

- [x] **PyObject_GenericGetAttr forwards the real exception**
      (+1 struct test_operations_on_half_initialized_Struct; zero regression
      — the shared generic-getattr path, exercised by every C type, is
      unchanged across all 20 suites). A descriptor getter that *raised* was
      lost: `PyObject_GenericGetAttr` caught the exception from `$B.$getattr`
      and returned a bare NULL **without setting the pending exception**, so
      the tp_getattro wrapper (C-first, then synthesizes AttributeError on an
      unexplained NULL) masked it as "object has no attribute". CPython's
      contract is that a NULL return always leaves the exception set — now it
      forwards the original (falling back to AttributeError on a genuine
      miss). Surfaced by an uninitialized `struct.Struct.__new__(Struct)`:
      reading `.format` runs `s_get_format`, which raises RuntimeError
      "Struct object is not initialized" — it had been arriving as the wrong
      AttributeError.

- [x] **Faithful IEEE float packing** (+1 struct test_705836; zero
      regression — array's 'e'/'f' typecodes and pickle floats unchanged).
      • `PyFloat_Pack4` silently produced inf on a finite value too large for
      float32; now raises OverflowError "float too large to pack with f
      format" (the >f/<f/f asserts in test_705836). • `PyFloat_Pack2`
      (binary16) went via a float32 round-trip (double rounding), flushed
      EVERY subnormal to zero, and never raised on overflow. Replaced with a
      direct double→binary16 conversion with round-half-to-even, correct
      subnormals, and OverflowError — validated bit-exact against CPython on
      4024 differential cases (divisions/multiplications by powers of two are
      exact in fp, so the rounding sees no spurious ties). This greens the
      half-float roundtrips in test_half_float (the test still needs
      _testcapi's NaN-signaling helpers for its tail).

- [x] **Two struct type/protocol fidelity fixes** (+2 struct, zero
      regression). • `PyObject_IsTrue` propagated nothing useful — it masked
      whatever `__bool__` raised as a generic TypeError "PyObject_IsTrue
      failed", so `struct.pack('?', ExplodingBool())` lost the OSError
      (test_struct.test_bool). Now forwards the original exception.
      • `Py_TPFLAGS_DISALLOW_INSTANTIATION` (1<<3) was ignored by the
      `PyType_FromModuleAndSpec` factory, so `_struct.unpack_iterator` (a
      DISALLOW type with no tp_new slot) inherited a constructor; calling it
      now raises TypeError "cannot create '...' instances"
      (test_struct.test_uninstantiable).

- [x] **Faithful Py_ssize_t/size_t conversion + sys.maxsize untangle**
      (+3 pickle, +3 array, +2 math, +2 decimal, +2 struct = +12; zero
      regression — zlib, re and every slicing-heavy suite unchanged). A
      compensating lie: `PyLong_AsSsize_t` *clamped* to ±2³¹ (and
      `PyLong_AsSize_t` masked with `>>> 0`) instead of raising OverflowError,
      because `sys.maxsize` (= Brython's `max_array_size`) was wrongly 2³²-1 —
      so `zlib.decompress(data, sys.maxsize)` would have wrapped to negative
      garbage. The clamp masked struct's 'n'/'N' overflow
      (test_struct.test_integers). Untangled faithfully:
      • vendored `brython.js`: `max_array_size` = PY_SSIZE_T_MAX (2³¹-1), the
        correct value for a 32-bit-ssize_t target (this is a wasm32-ABI
        adjustment, not an upstream Brython bug — browsers aren't ssize_t-bound).
      • `PyLong_AsSsize_t` / `PyLong_AsSize_t` now raise OverflowError on a
        value outside the platform range, like CPython. zlib still works
        because sys.maxsize (2³¹-1) fits ssize_t exactly.
      • `_PyNumber_Index` now uses `__index__` ONLY (operator.index semantics),
        never falling back to `__int__` (it used `int(obj)`), so packing an
        object whose `__index__` raises no longer silently used `__int__`
        (test_integers BadIndex). The +2 elsewhere (math/decimal/pickle/array)
        is faithful overflow detection in indexing/sizing paths.

- [x] **Integer conversion overflow + `__index__` in the bridge** (+5 zstd,
      +3 sqlite3; zero regression — the shared-primitive payoff: fixing the
      PyLong primitives fixed zstd/sqlite3's int packing for free, and
      `_random` (a heavy `_PyLong_AsByteArray` user) was untouched). Four
      faithfulness gaps, all on widely-shared converters:
      • **`PyLong_AsLong`/`PyLong_AsInt` truncated with `| 0`** (no overflow
        detection) → C long is 32-bit on wasm32, so a too-big int silently
        wrapped. Now range-checked against ±2³¹, raising OverflowError.
      • **`PyLong_AsLongLong`** had no range check (and didn't even set
        TypeError on a non-int) → now bounded to ±2⁶³.
      • **`_PyLong_AsByteArray` was defined TWICE** (the later shadowed the
        earlier), and *both* masked silently with no magnitude check →
        `struct.pack('>q', 2**64)` wrote a wrapped value. Deduplicated to one
        definition that raises/returns -1 when the value doesn't fit in n
        bytes (signed and unsigned), faithful to CPython.
      • **`PyIndex_Check` only recognized raw JS ints** → an object with
        `__index__` was rejected ("required argument is not an integer").
        Now also checks the type's `__index__`, mirroring the neighbouring
        `PyNumber_AsSsize_t`.

- [x] **binascii buffer-protocol fidelity → test_binascii 76/76 runnable**
      (+8, 5th suite at 100%; zero regression, +1 pickle bonus on the
      proto-5 buffer family). Two distinct root causes, ×4 each across the
      array/bytes/bytearray/memoryview test matrix:
      • **`PyUnicode_1BYTE_DATA` returned NULL for a real str** (it only
        handled `PyUnicode_New` placeholders). binascii's
        `ascii_buffer_converter` set `buf->buf = address 0`, so
        `a2b_base64(str)` read garbage from the heap base (`b'zk\x1c'` vs the
        decoded text — test_unicode_a2b). Now delegates to `PyUnicode_DATA`,
        which already materializes the 1-byte Latin-1 buffer (no duplication).
      • **non-contiguous memoryviews were silently materialized** via
        `tobytes()` in `wasthon_get_buffer_data` instead of rejected.
        `PyObject_GetBuffer` here only honors PyBUF_SIMPLE (C-contiguous), so
        a strided slice (`m[::-2]`) now raises BufferError like CPython
        (test_c_contiguity). Brython sets `c_contiguous` on every memoryview;
        the check reads it falsy-safe (`!== undefined && !c_contiguous`).

- [x] **Unsigned clinic converters: faithful bounds** (+3: hashlib 72 —
      test_blake2b, test_blake2s, test_digest_length_overflow; +1 hmac).
      `_PyLong_UnsignedLong_Converter` stored `v >>> 0` with no upper-bound
      check (blake2 `leaf_size=1<<32` silently became 0) and raised
      OverflowError on negatives where pycore raises
      `ValueError("value must be positive")`. The 64-bit variant masked to
      64 bits the same way (`node_offset=2**64` accepted as 0). Both now
      match pycore_long.h: ValueError on negative, OverflowError
      ("Python int too large to convert to C unsigned long (long)") above
      the bound — which is also what shake `digest(2**32+10)` needs.
      (The sibling `_PyLong_UInt{32,64}_Converter` routes still lack the
      upper-bound check — latent, to fix and measure separately.)

- [x] **`Py_TPFLAGS_IMMUTABLETYPE` propagates to Brython** (+1: hashlib 68
      — test_readonly_types ×12 subtests). C types created through
      `PyType_FromModuleAndSpec` were plain mutable Brython classes;
      CPython marks e.g. every HACL hash type immutable, so
      `sha1.value = False` must raise TypeError. Brython's
      `type.tp_setattro` already enforces its own
      `TPFLAGS.IMMUTABLETYPE` bit ("cannot set ... attribute of immutable
      type ..."); the factory now translates the spec flag (wasthon
      numbering, 1<<4) to Brython's bit (1<<8). Bridge-side installs go
      through `set_to_dict` and are unaffected.

- [x] **CPython pin bump 3.14.4 → 3.14.6** (+1: csv 122/122 runnable —
      3rd suite at 100%). 3.14.6 (released 2026-06-10) ships the
      gh-145105 csv fix upstream — re-entering the reader from its source
      iterator now raises `csv.Error` ("iterator has already advanced the
      reader") instead of letting StopIteration escape — replacing the
      build-time patch that briefly carried it in `build.sh`. Three
      resyncs were the whole cost of the bump: `wasthon.h` defines
      `_Py_atomic_{store,load}_char_relaxed` as plain accesses
      (single-threaded WASM; 3.14.6's `_bz2module.c` calls one directly,
      a free-threading safety backport — the only direct atomic across
      our 25 modules); `pyexpat.h` gains the three `PyExpat_CAPI` tail
      members 3.14.6 added (billion-laughs protection setters +
      `SetHashSalt16Bytes`); `test_binascii` resynced to 3.14.6
      (`a2b_uu` now raises on empty input — the only `binascii.c`
      change). Full sweep iso vs the 3.14.4 baseline: 3484 effective,
      csv 122/0, statistics 370/0, zlib 57/0, every other suite at the
      point.

- [x] **Lone surrogates round-trip through pickle (surrogatepass)** (+2:
      pickle 682). TextEncoder/TextDecoder replace lone surrogates with
      U+FFFD on BOTH sides; CPython pickles them as 3-byte CESU sequences
      (`'\ud800'` → `ed a0 80`) and round-trips them. Manual symmetric
      encoder/decoder, slow path gated on an actual surrogate (encode) /
      0xED lead byte (decode) so normal strings keep the native fast path.

- [x] **Protocol-5 out-of-band buffers work** (+10: pickle 680 — the
      in_band/oob_buffers/ZeroCopy family). The PickleBuffer binding is a
      JS stub carrying its underlying buffer on `.obj`;
      `wasthon_get_buffer_data` didn't know how to dereference it, so
      `save_picklebuffer`'s PyObject_GetBuffer raised "a bytes-like object
      is required, not 'PickleBuffer'" and every proto-5 buffer dump died.
      One early branch recurses on the carried buffer — NEXT_BUFFER /
      READONLY_BUFFER opcodes and the buffer_callback now fire.

- [x] **`PyDict_GET_SIZE` missed non-string dict keys** (+21: pickle 670 — int/
      tuple-keyed and recursive dicts). Brython stores string keys as own
      JS properties and every other key in a `Symbol('KEYS')` table the
      bridge's own-property walk couldn't see — `{1: 'a'}` reported size 0,
      so pickle's save_dict emitted an EMPTY dict (and mixed dicts only
      their string part). The vendored brython.js now exports the symbol
      (`$B.DICT_KEYS`) and GET_SIZE counts that table for real dicts
      (guarded by get_class — probing symbols on Brython proxy objects
      walks their Python getattr handler, and GET_SIZE is C-hot).

- [x] **`PyUnicode_DecodeUTF8` truncated at embedded NULs** (+5: pickle 649 —
      the binunicode family). `UTF8ToString(ptr, size)` bounds the read but
      still stops at the first NUL byte (C-string semantics), so pickle's
      BINUNICODE payloads with embedded NULs lost their tail
      ('€\x00' came back as '€'). Decode the exact heap slice
      with TextDecoder instead.

- [x] **`PyLong_FromString` parsed through a double and rejected trailing
      whitespace** (+12: test_pickle 624). `BigInt(parseInt(s, base))`
      round-trips through a 2^53-precision double — proto-0 LONG literals
      above that silently corrupted (test_ints' 4294967295 arrived as
      4294967039 through a longer chain; test_long1's 30-digit literal lost
      its low digits) — and `BigInt('123\n')` throws, so valid literals
      with pickle's trailing newline raised "invalid literal" (×6).
      Rewritten: digit-at-a-time pure-BigInt parse with CPython semantics
      (leading/trailing whitespace, sign, 0x/0o/0b prefixes, `_`
      separators, `*pend` contract, strict-rest check when pend is NULL).

- [x] **`PyMemoryView_FromMemory` implemented** (+1 pickle; was a
      NotImplementedError stub). Read-only semantics: copies the C buffer
      into a Brython bytes wrapped in a real memoryview, returned as a new
      reference. Write-through (PyBUF_WRITE) would need borrowed
      linear-memory backing — no bundled caller needs it (pickle's
      BINBYTES readers are read-only consumers).

- [x] **Unpickled lists reported type JavascriptArray** (+31: test_pickle
      574, +3: sqlite3 328). `get_class` short-circuits `Array.isArray` to
      JavascriptArray BEFORE reading `__class__`; native Brython lists carry
      the `OB_TYPE` Symbol. PyList_New now sets that Symbol, so
      `assertIs(type(loads(dumps([1])))), list)` holds — and sqlite3's
      fetchall rows too. (This was the −159/−238 minefield: re-measured
      −238 on 2026-06-12, root-caused to the handle-map resize cascade,
      harmless now that scopes keep the map flat.)

- [x] **Unpickled lists reported type JavascriptArray** (+31: test_pickle
      574, +3: sqlite3 328). `get_class` short-circuits `Array.isArray` to
      JavascriptArray BEFORE reading `__class__`; native Brython lists carry
      the `OB_TYPE` Symbol. PyList_New now sets that Symbol, so
      `assertIs(type(loads(dumps([1])))), list)` holds — and sqlite3's
      fetchall rows too. (This was the −159/−238 minefield: re-measured
      −238 on 2026-06-12, root-caused to the handle-map resize cascade,
      harmless now that scopes keep the map flat.)

- [x] **Handle scopes — the JS-side sentinel handle-map leak is fixed**
      (+2 decimal immediately; the enabler for the two entries below and for
      every formerly-impossible fix that adds wraps). The bridge gains the
      third handle lifetime it was missing — **call-scoped** — between
      "immortal" (no scope active: module init, loader-time) and
      "refcounted" (instances). The JNI local-reference / HPy model, ported
      from Florent's release-day prototype: every JS→C entry point (method
      trampoline, slot dispatch shapes, tp_new/tp_init/tp_call/tp_getattro,
      both getset families) pushes a scope; sentinel handles wrapped during
      the call are released at pop unless C took a reference (Py_INCREF
      promotes, new-reference APIs seed refcount 1 via wrapNewRef, steal
      APIs consume). Module init stays unscoped (immortal, as before). A
      real intern pool backs PyUnicode_InternFromString/_Py_ID (lazy C
      statics). Proof: loader/test-scopes.html A/B — handles.size
      +0.00/call over 2000 pickle.dumps of a rich graph vs +105.00/call
      without scopes. This was "the monster": the handle map hitting its
      internal resize limit (~2^25 entries → one >2GB allocation →
      "allocation size overflow" cascading over ~270 pickle tests), which
      made two correct fixes measure −238/−266 and hid ~46 pickle passes.

- [x] **`PyErr_WarnEx` swallowed every C-module warning** (+1: sqlite3
      314→315). It returned 0 without emitting anything; now routes through
      Brython's `warnings.warn` (and returns -1 with the exception set when
      a filter turns the warning into an error). The full sqlite3
      DeprecationWarning cluster (×16) needs the deeper VFS warnings bug
      fixed too — see below.

- [x] **Clinic UInt converters raised OverflowError for negative values**
      (+1 hashlib, +1 lzma). CPython's `_PyLong_UInt32/UInt64_Converter`
      raise **ValueError** ("Cannot convert negative int") on negatives —
      blake2's `leaf_size`/`node_offset` and lzma's `preset` tests assert
      that type. Also: UInt32 silently WRAPPED values above 2**32-1 via
      `>>> 0`; now OverflowError. (The generic `PyLong_AsUnsignedLong`
      family keeps OverflowError — that's faithful there; array depends
      on it.)

- [x] **BigInt elements in a bytes `.source` broke buffer marshalling**
      (+2: test_zstd 85→87; kills the test_hmac 1/5 flaky on
      `test_update_large`). Brython's `random.randbytes` can leave BigInt
      ELEMENTS in the bytes source array (value-dependent — hence flaky);
      `HEAPU8.set(src)` and `src[i] & 0xff` both throw "can't convert BigInt
      to number". Hardened all 4 marshal sites (buffer get-data, `w*` alloc,
      2× cstr) with a `Number()`-converting fallback. Hunted via the
      anomaly-capture trap added to driver-par (auto-dump the page log when a
      suite scores below its known baseline) + a 6-state bisect.

- [x] **`PyUnicode_Decode` passed raw Python encoding names to TextDecoder**
      (+6: test_pyexpat 33→39). pyexpat decodes with 'iso8859' (a CPython
      alias of latin-1) and Python spells encodings with underscores; WHATWG
      TextDecoder rejects both forms ("The given encoding 'iso8859' is not
      supported") — every non-UTF-8 XML document failed. Normalize via an
      alias map + underscore→dash before constructing the decoder.

- [x] **`PyTuple_CheckExact` rejected every real Brython tuple** (+7:
      test_zstd 78→85, 66%→72%). It tested `obj.__class__ === tuple`, but a
      Brython 3.14 tuple (`fast_tuple`) carries `ob_type`, not an own
      `__class__` — the predicate was constantly false. zstd's
      `(ZstdDict, type)` dict-form parsing gates on it
      (`zd.as_digested_dict` / `as_prefix` → "zstd_dict argument should be a
      ZstdDict object"). Check `ob_type` first. (The canonical-class
      precedence family — see the +0 reserve.)

- [x] **Python functions were unpicklable — `Py_TYPE(func)` never equaled
      `&PyFunction_Type`** (+64: test_pickle 399→463, the biggest single fix of
      the campaign). The builtin-type binding mapped `BT_FUNCTION` to
      `_b_.function`, which DOESN'T EXIST in Brython (the Python-function class
      lives at `$B.function`) — the binding registered `undefined`, the type
      comparison in `_pickle`'s save() was dead code, and every module-level
      function degraded to the instance-reduce path ("cannot pickle 'function'
      object", ×87 in the failure histogram). Bind `$B.function`;
      `_pickle.dumps(module_func)` now emits the global ref and loads back BY
      IDENTITY.

- [x] **`$getattr` can return a raw getset_descriptor — resolve it at the C
      boundary** (+0, enabler of the entry above). `PyObject_GetOptionalAttr`
      (via the 3-arg default form) and `PyObject_GetAttr` could hand C an
      UNRESOLVED `getset_descriptor` (seen on `__qualname__` lookups during
      save_global), which then flowed into `PyUnicode_Split` ("not a str").
      Switch to the 2-arg `$getattr` + invoke `tp_descr_get` when a raw
      descriptor surfaces; `PyUnicode_Split`'s error now names the type it got.

- [x] **`MAXIMUM_MEMORY=4GB` on both bundles and standalone `_lzma`** (+12:
      test_lzma 76→88). The default 2GB wasm cap was the real wall behind most
      of test_lzma's "MemoryError: out of memory" cluster: the suite's
      cumulative heap usage plus liblzma's ~94MB preset-6 encoder allocations
      hit the ceiling, and `ALLOW_MEMORY_GROWTH` could not grow past it. 4GB
      is the wasm32 maximum — a virtual-address reservation, free on 64-bit
      hosts. Documented in the README link-flags section as a TEMPORARY fix:
      headroom against the known handle/sentinel retention, to re-evaluate
      (possibly back to 2GB) once the per-call arena work lands.

- [x] **Pickling a C-opaque instance silently produced an empty shell**
      (+1: test_zlib 56→57 — the suite's first 100% —, +4 test_decimal
      Context copy/with, +2 test_bz2, +1 test_lzma compressor-pickle).
      CPython's `object.__getstate__` (3.11+) raises TypeError ("cannot
      pickle 'X' object") for an instance whose C struct holds opaque state
      and which has no instance `__dict__`; ours fell through to Brython's
      default (state=None), so `pickle.dumps(zlib._ZlibDecompressor())`
      "worked". Install the guard on C types defining no pickling protocol
      of their own; Python subclass instances (they carry a `__dict__`) and
      exception types keep their behavior. NOTE: the early TypeErrors shift
      lzma's heap-sensitive OOM boundary — recovered by the 4GB entry below.

- [x] **`PyArg_ParseTupleAndKeywords` coerced anything to int and ignored
      excess positional args** (+1: test_zlib 55→56, +1 test_lzma). Two more
      legacy-parser gaps, siblings of the unknown-kwargs one: integer formats
      went through `Number(value)||0` — `_ZlibDecompressor("ASDA")` parsed as
      `wbits=0` — now int/bool/`__index__` only, TypeError otherwise (CPython
      getargs); and surplus positionals were dropped —
      `_ZlibDecompressor(-15, b"x", 5)` succeeded — now "takes at most N
      arguments (M given)". Requires the `tp_call` marker fix above: the
      untagged kwargs payload used to ride along as a positional.

- [x] **`tp_call` mishandled Brython's kwargs marker** (+0, enabler of the
      parser-validation entries below; sqlite3's whole statement path —
      `connection(sql)` — depended on the bug staying hidden). The wrapper only
      popped the trailing kwargs payload when tagged `$nat='kw'`; a bare call
      through `$B.$call` appends an untagged `{$kw:[{}]}`, which then counted
      as a POSITIONAL arg (latent while the parsers ignored extras) and, once
      popped, was forwarded raw as non-NULL kwargs ("takes no keyword
      arguments"). Detect any `{$kw:…}` shape and flatten to a real dict; an
      empty payload arrives as NULL.

- [x] **`PyObject_GetOptionalAttr` swallowed non-AttributeError exceptions**
      (+1: test_csv 118→119). The contract is 1=found / 0=missing /
      -1=error-propagates; the bridge returned 0 for ANY exception, so a
      `write` property raising OSError (csv.writer's BadWriter test) was
      reported as "attribute missing" and C replaced the OSError with its
      TypeError "argument 1 must have a write method". Discriminate
      AttributeError (→0) from the rest (→forwardError, -1).

- [x] **`PyArg_ParseTupleAndKeywords` accepted unknown keyword arguments**
      (+11: test_csv 116→118, test_decimal 288→291, test_lzma 75→81 — jointly
      with the exception-type fidelity entry below). CPython's legacy parser
      rejects kwargs not named in kwlist; the bridge's silently dropped them,
      so `csv.reader([], bad_attr=0)` / `register_dialect(n, badargument=None)`
      / bad lzma filter-spec keys succeeded instead of raising TypeError. Scan
      the kwds keys against kwlist up front. (The clinic-side
      `_PyArg_UnpackKeywords` got this check on 2026-06-05; this parser was
      left out.)

- [x] **C-raised exception types were flattened to RuntimeError across the
      call primitives** (standalone +0, prerequisite of the entry above —
      validation tests assert the TYPE). The generic call primitive,
      `PyObject_CallObject` and the HasAttr-area getattr recovered the class
      from a bare `(e && e.__class__)`, absent on a freshly-raised Brython
      exception (it carries `ob_type`) — every C TypeError surfacing through
      a nested call (csv dialect validation: "delimiter must be a 1-character
      string") arrived as RuntimeError. Route through `forwardError` (the
      2026-06-08 reserve, applied now that tests exercise these paths).

- [x] **A bytes struct member filled C-side read back as zeros** (+1:
      test_zlib 54→55). zlib's `save_unconsumed_input` builds `unused_data`
      via `PyBytes_FromStringAndSize(NULL, n)` + `memcpy` — a writable
      placeholder whose content lives in linear memory while `.source` still
      holds the zero fill. The post-call syncBytes pass only folds RETURN
      values; a member read later through the PyMemberDef descriptor
      (`dco.unused_data`) returned the placeholder raw — `b'\x00' * n` instead
      of the leftover input. Fold the placeholder in the member getter
      (Py_T_OBJECT_EX); `PyBytes_AsString` re-allocates from `.source` if C
      touches the bytes again.

- [x] **Subclass instances lied about their C type — SignalDict comparisons
      aborted** (+4: test_decimal 284→288). The no-tp_new default allocator
      stamped instances with the handle of the ANCESTOR that supplied the
      layout, where CPython's `object_new` honors the instantiated subtype
      (`tp_alloc(type, 0)`). `_decimal`'s SignalDict —
      `type('SignalDict', (MutableMapping, SignalDictMixin), {})` — is
      exact-type-checked (`Py_IS_TYPE(v, state->PyDecSignalDict_Type)`) in
      `signaldict_richcompare`, so every `context.flags == …` comparison
      aborted on the assert. Stamp `__wasthon_type__` with the instantiated
      class's own type struct. That honesty exposed the COMPENSATING bug:
      `PyObject_TypeCheck` was an exact pointer compare (it only passed for
      subclasses BECAUSE they carried the parent's handle) — sqlite3's
      cursor/row factory guards (`cursor(factory=MyCursor)`) broke (−2).
      Make it faithful: exact match OR `PyType_IsSubtype` walk, like
      CPython's. sqlite3 314 restored, zero regression elsewhere.

- [x] **C-created str placeholders were opaque to Python callees** (+8:
      test_decimal 276→284). A PyUnicode built C-side (`PyUnicode_New` +
      memcpy) is a lazy linear-memory placeholder, materialized on demand by
      `asJSStr`. The C→Python call primitives (`PyObject_CallOneArg`,
      `PyObject_CallMethod` 'O', `PyObject_CallFunctionObjArgs`) passed the raw
      placeholder through to Brython — `_decimal`'s `pydec_format` fallback
      (`_pydecimal.Decimal(dec_str(self))`, used for 'z'/locale format specs)
      died with "Cannot convert <Javascript object: [object Object]> to
      Decimal", killing the whole format-fallback family. Materialize via a
      shared `toBrythonArg` at the call boundary.

- [x] **type→module lookup didn't follow inheritance (and MRO walks read the
      wrong field)** (+2: test_decimal 274→276, unlocks classmethods on
      subclasses — `MyDecimal.from_float(0.5)` now returns a MyDecimal).
      Two halves of one defect: (1) `PyType_GetModuleByDef` /
      `wasthon_type_get_module` (which backs `PyType_GetModule` /
      `_PyType_GetModuleState`) only checked `__wasthon_module__` on the type
      itself, where CPython walks tp_mro — a Python subclass of a C type owns
      no module entry, so `get_module_state_by_def` returned NULL and
      `_decimal` asserted. Add the MRO walk. (2) Brython 3.14 stores a class's
      MRO as `tp_mro` (`$B.get_mro` reads `tp_mro ?? __mro__`); the bridge's
      walks — including the pre-existing `PyType_GetBaseByToken` — read only
      `__mro__`, which exists just on a few legacy builtins, so every walk was
      a no-op exactly for the subclasses that needed it. Read
      `tp_mro || __mro__`.

- [x] **METH_CLASS methods were installed as plain methods — the value arrived
      as `cls`** (+4: test_decimal 270→274). The bridge installed every
      PyMethodDef entry the same way, so a C classmethod like
      `Decimal.from_float(2.5)` reached the trampoline with the FLOAT as
      `self`: the C function cast it to `PyTypeObject*`
      (`get_module_state_by_def` → `assert(mod != NULL)` → abort, killing the
      whole from_float family) and got NULL as the value. Install METH_CLASS
      entries as real Brython classmethod descriptors
      (`{ob_type: classmethod, cm_callable: trampoline}` in the class dict) so
      the descriptor protocol binds the CLASS as first arg; drop the METH_O
      "skip the count check when METH_CLASS" exemption, which was a workaround
      for the missing binding.

- [x] **C numeric types had no reflected operators — `5 + Decimal(2)` raised
      TypeError** (+18: test_decimal 252→270). CPython has ONE slot per binary
      op, tried for both operands with the arguments in the ORIGINAL order; the
      slot impl (e.g. `dec_add`) converts whichever side isn't its own type.
      Brython instead resolves `int + Decimal` by looking up `__radd__` on the
      right operand — which the bridge never installed, so every
      `int/float OP Decimal` (`+ - * / // % ** divmod`, the whole
      CArithmeticOperatorsTest/PyArithmeticOperatorsTest families) raised
      "unsupported operand type(s)". Install `__radd__` & co for each wired
      `nb_*` binary/ternary slot as the SAME C slot with swapped operands
      (`__rOP__(self, other)` = `slot(other, self)` — original order
      preserved). Inplace slots excluded; `sq_repeat`'s existing
      `__rmul__` ('si' shape) untouched.

- [x] **Every float→Decimal conversion raised "Cannot pass NaN to
      float.as_integer_ratio"** (+4: test_decimal 248→252). `_decimal` caches
      `float.as_integer_ratio` at module init (via the bridge's
      `PyFloat_Type.tp_methods`) and calls it during `Decimal(2.5)` /
      `Decimal.from_float` / float comparisons. The bridge's implementation
      forwarded a RAW JS number to Brython's method — but Brython's float funcs
      expect a BOXED float (`{value: x}`), so `isnan()` read `raw.value` =
      undefined and `isNaN(undefined)` is true: every value, NaN or not, took
      the NaN-rejection path. Box with `$B.fast_float` before the call. (The
      2026-06-06 dead-end had correctly ruled out `nb_absolute`; the broken
      half was `as_integer_ratio`, one call later.)

- [x] **`struct.pack_into` couldn't write into an `array.array` / `memoryview`
      buffer** (+2: test_struct 26→28 — `test_pack_into` / `test_pack_into_fn` —
      jointly with the companion `memoryview` slice-contiguity fix in
      `BRYTHON_FIX.md`). Two bridge gaps on `pack_into`'s path, both surfaced by
      `pack_into(memoryview(array.array('b', b' '*100)), off, v)`:
      (1) `PyArg_Parse`'s `'w*'` (writable buffer) only accepted a Brython
      bytearray's `.source` — but the canonical target is a `memoryview` over an
      `array.array`, which has neither `.source` nor a JS `Uint8Array`. Unwrap a
      `memoryview` to its underlying object, and for a wasthon buffer-protocol C
      type (array) point the `Py_buffer` straight at the object's `ob_item` (its
      storage already lives in linear memory) — C writes land in the real array
      with no copy and no write-back; a JS `Set` marks the view borrowed so
      `PyBuffer_Release` neither copies back nor frees `ob_item`. A non-contiguous
      view (`buf[::2]`) and immutable `bytes` are rejected (TypeError), matching
      CPython's `getbuffer(PyBUF_WRITABLE)`. (2) `PyNumber_AsSsize_t` (which
      parses the offset) truncated via `Number(x)|0` and raised a blanket
      `IndexError`; make it faithful — coerce through `__index__`, raise
      `TypeError` for a non-index object (None/float), and on Py_ssize_t overflow
      raise the caller's `exc` (`pack_into` passes `IndexError`) or
      `OverflowError`. Shared primitive — array calls it too.

- [x] **C types' `tp_init` wasn't exposed as `__init__`** (+5: test_struct
      24→26, test_sqlite3 310→313). Sibling of the `__new__` gap below: the
      bridge wired the C init slot as `cls.tp_init` (used by Brython's
      `type.tp_call` at instantiation) but never set the `__init__` *attribute*,
      so an explicit `inst.__init__(args)` — `Struct.__init__('>hh')`
      re-initialization — and a subclass's `super().__init__(args)` both fell
      through to `object.__init__`, which rejects the extra args ("object.
      __init__() takes exactly one argument"). Expose it by mirroring Brython's
      `wrap('__init__')`: a `wrapper_descriptor` over `cls.tp_init` in the class
      dict. Shared primitive — landed across struct and sqlite3.

- [x] **C types had no `__new__`, and `__slots__` subclasses still got a
      `__dict__`** (+12, test_array 728→740 — `test_subclassing` ×14). Two gaps
      in C-type subclassing: (1) `array.array.__new__` resolved to
      `object.__new__` (the C `tp_new` was wired as `cls.tp_new` for
      instantiation but never exposed as the `__new__` attribute), so an
      explicit `array.array.__new__(cls, typecode, data)` hit object's
      one-arg-only `__new__`. Expose it by mirroring Brython's `make_new`
      (a `__new__` that forwards to `cls.tp_new`). (2) The subclass `__dict__`
      was attached unconditionally; the canonical `object.tp_new` skips it when
      the subclass defines `__slots__`, so a `__slots__`-only subclass must have
      NO `__dict__` and `setattr(a, 'color')` must raise `AttributeError`. Gate
      `init_dict` on the absence of `__slots__` (subclasses without slots, e.g.
      random.Random, keep their `__dict__` — unchanged). Verified no regression.

- [x] **Buffer-export safety: array mutations didn't raise `BufferError` while a
      memoryview was live** (+28, test_array 700→728 — `test_buffer` ×14 +
      `test_clear` ×14). array's C resize ops (append/extend/pop/`*=`/slice
      set/del…) check the struct's `ob_exports` and raise `BufferError` when
      it's > 0, but nothing kept that field set: Brython's `memoryview()` bumps a
      *JS* `obj.exports` on the source (and `--`s it on `release`/`__exit__` — its
      own deterministic net count, no GC needed), disconnected from the C struct.
      The method trampoline now syncs `self.exports` into the C struct's
      `ob_exports` (offset recorded on any buffer-protocol type — array is the
      only one) before each call, so resize ops raise exactly while a memoryview
      is alive — both `m = memoryview(a)` and `with memoryview(a):` — and succeed
      once it's released. Pure deterministic Stage-1/2 (NOT the rejected
      tracing-GC door); leans on Brython's existing export accounting. Verified
      no regression across the full sweep.

- [x] **`PyIter_Next` flattened a Python iterator's exception to `RuntimeError`**
      (+15: test_array 686→700, test_csv 110→111). When a C consumer iterates a
      Python iterable whose `__next__` raises (e.g.
      `array(tc, BadIterator())`), the bridge recovered the exception class from
      a bare `e.__class__`, which is absent on a freshly-raised Brython
      exception — so the real type was lost and a generic `RuntimeError`
      surfaced, failing `test_constructor_with_iterable_argument`'s
      `assertRaises(ValueError, …)`. Forward via `rt.forwardError` (which falls
      back to `$B.get_class(e)`), keeping the `StopIteration`→NULL contract.
      General — helps any module iterating a raising Python iterator (csv +1).
      Verified no regression across the full 20-suite sweep.

- [x] **`PyObject_RichCompare` called the comparison method as a bare `fn(b)`**
      (+4, test_array 686 — `test_cmp` / `test_nan` for the `f`/`d` typecodes).
      A Brython bound method needs `$B.$call`'s frame setup; `fn(b)` threw, the
      reflected branch threw too, and the bridge reported "unorderable types".
      So comparing two *distinct* float/double arrays element-wise (array's C
      `array_richcompare` calls `PyObject_RichCompare` on the first differing
      pair) failed, even though `1.0 < 2.0` worked. Delegate to Brython's full
      protocol `$B.rich_comp(op, a, b)` (call → reflected-on-NotImplemented →
      identity fallback for ==/!= → TypeError for unorderable). Verified no
      regression across the full 20-suite sweep.

- [x] **`PyLong_AsUnsignedLong`/`…LongLong` masked instead of raising
      `OverflowError`** (+4, test_array 678→682 — the unsigned `I`/`L`/`Q`
      `test_overflow` typecodes). CPython raises `OverflowError` for a negative
      value or one exceeding `ULONG_MAX`/`ULLONG_MAX` (the wrap-around variant is
      `PyLong_AsUnsignedLongMask`); the bridge instead did `>>> 0` / `abs()`, so
      array's `II`/`LL`/`QQ_setitem` — which call these then compare against the
      max — never saw an out-of-range value. Range-check and raise. Verified no
      regression (struct, which packs `I`/`L`/`Q` through the same calls,
      unchanged).

- [x] **`PyArg_Parse` masked integers instead of range-checking, and choked on
      `__index__` objects** (+8, test_array 670→678 — the signed `test_overflow`
      typecodes plus other `Intable` paths). Two gaps in the single-object
      parser: (1) the signed integer formats (`b`,`h`,`i`,`l`,`L`) wrote
      `num & 0xff` / `num | 0` etc. — silently truncating — so
      `array('i').append(2**31)` never raised. CPython's getargs.c range-checks
      the signed formats and raises `OverflowError` (the unsigned/bitfield
      `B`,`H`,`I`,`k`,`K` legitimately mask); do the same. (2) An argument with
      `__index__`/`__int__` was coerced by calling the Brython method as a bare
      JS `idx()`, which throws (a Brython bound method needs `$B.$call`'s frame
      setup) — the `catch` then reported a bogus "cannot convert", so every
      `__index__` object (array's `Intable` test helper, and anything similar
      across modules) was rejected. Call via `$B.$call`. Verified no regression
      across the full 20-suite sweep. (`'I'`/`'L'`/`'Q'` overflow is a separate
      fix — `PyLong_AsUnsignedLong`/`…LongLong` still mask.)

- [x] **`PyUnicode_AsWideChar(s, NULL, 0)` dropped the trailing-NUL count**
      (+10, test_array 660→670 — the `'u'` wchar_t typecode paths). CPython's
      size-query form (`buf == NULL`) returns the count *including* the trailing
      NUL, i.e. `len + 1`; the bridge returned `len`. array's `u_setitem`
      checks `PyUnicode_AsWideChar(v, NULL, 0) != 2` to reject non-single-char
      items, so every `array('u', …).append(ch)` / item assignment raised
      "string %R cannot be converted to a single wchar_t character"; and
      `array_fromunicode` sizes its copy as `AsWideChar(ustr, NULL, 0) - 1`, so
      `a.fromunicode('foo')` stored `'fo'`. Return `len + 1` in the NULL-buffer
      branch (the copy branch already excludes the NUL, per CPython). Verified
      no regression across the full 20-suite sweep. (The remaining 6 `'u'`/`'w'`
      failures are a separate bug — unicode array reconstruction in
      `_array_reconstructor` yields length-0 items during unpickling.)

- [x] **Python subclasses of a C-type weren't picklable** (+26, test_array
      634→660 — the whole test_pickle / test_pickle_for_empty cluster except
      the 'u'/'w' wchar_t typecodes, which fail in a separate bug). Three
      linked bridge gaps, found by probing `pickle.dumps(ArraySubclass(...))`:
      1. **Instance `__dict__` was a raw JS object.** The subclass `__dict__`
         was attached with `set_dict(inst, obj_dict({}))`, but `$B.obj_dict`
         is the identity function — so `inst.__dict__` came back as a bare
         `JSObject`, and pickle (which embeds `__dict__` as the instance
         state) died with "cannot pickle 'JSObject' object". Use `init_dict`
         (a real `empty_dict`), matching Brython's canonical `object.tp_new`.
      2. **`PyType_IsSubtype` always returned 0 for real subtypes.** It called
         `$B.$issubclass`, which doesn't exist in the vendored Brython, so the
         `try` threw and the `catch` returned 0 — the load-side subtype check
         (`_array_reconstructor`) rejected every subclass. Use `_b_.issubclass`.
      3. **The reduce named the base class, not the subclass.** A C-type's
         `__reduce__`/`__reduce_ex__` embeds `Py_TYPE(self)`, but the bridge
         keeps the C struct's `ob_type` = parent (so C `PyObject_TypeCheck`
         works), so the reduce named the base and unpickling rebuilt a base
         instance ("'array' object has no attribute '__dict__'"). The
         trampoline now rewrites a subclass instance's reduce to name
         `self.ob_type`: the simple `(cls, args, state)` / `__newobj__` forms
         get the class swapped in place; a binary C reconstructor that can't
         allocate a Brython subtype (array's `_array_reconstructor`, which
         crashed with "index out of bounds") falls back, at protocol >= 3, to
         the type's own protocol-2 constructor-form reduce — reconstructing by
         calling the class through the bridge tp_new path. Verified no
         regression across the full 20-suite sweep.

- [x] **Python subclasses of a C-type rejected constructor kwargs** (+14,
      test_array 620→634). `ArraySubclassWithKwargs('b', newarg=1)` raised
      `TypeError: array.array() takes no keyword arguments`. CPython's
      `array_new` only rejects kwargs for the *exact* base type
      (`if (type == state->ArrayType && !_PyArg_NoKeywords(...))`); a subtype's
      kwargs are left for its `__init__`. The bridge's heap-type `cls.tp_new`
      wrapper always calls the C tp_new with the parent `typeHandle` (it patches
      the instance's `ob_type` to the subclass *after* the call), so that
      base-only guard wrongly fired on every subclass. Fix: when instantiating a
      subclass (`brythonCls !== cls`), don't forward kwargs to the C tp_new —
      Brython still delivers them to the subclass `__init__`/`tp_init`. Base
      instantiation is unchanged, so `array.array(spam=42)` still raises.
      Verified +14 with zero regression across array/decimal/sqlite3/csv/pyexpat/struct.

- [x] Two bridge gaps surfaced pushing `test_zlib` toward 100% (+2). (1)
      `PyLong_AsSsize_t` did `n | 0`, wrapping a large positive to a negative
      32-bit value — so `zlib.decompressobj().decompress(data, sys.maxsize)`
      saw `max_length < 0` → "max_length must be non-negative". Clamp to the
      wasm32 `Py_ssize_t` range `[-2³¹, 2³¹-1]` instead. (2) The buffer-protocol
      reader (`wasthon_get_buffer_data`) accepted any `Array.isArray` value as a
      buffer, including Brython `list`/`tuple` (they carry `ob_type`) — so
      `zlib.adler32([])` / `crc32(())` treated the sequence as bytes instead of
      raising `TypeError`. Restrict that branch to raw JS arrays (no `ob_type`).
      Both verified non-regressing across 10 buffer-heavy suites.

- [x] **C-module types/functions weren't picklable** — four linked bridge gaps,
      surfaced by `test_array`'s pickle cluster (array `__reduce_ex__(>=3)` embeds
      `array._array_reconstructor`). Together: +14 (test_array 582→596) and the
      documented "function pickling" lead resolved for the common case.
      1. **Type `__module__` defaulted to `builtins`.** `PyType_FromModuleAndSpec`
         set the class `__module__` only as a raw JS property, but Brython's
         `type.__module__` getter reads `get_from_dict` and falls back to
         `'builtins'` when absent — so `pickle` saved `array.array` as
         `builtins.array` and `loads` failed ("not found as builtins.array").
         Fix: derive `__module__` from the dotted spec-name prefix (CPython's
         `PyType_FromMetaclass` sets `tp_dict['__module__'] = name[:lastdot]`)
         and write it into the type dict, not just a JS property.
      2. **Function `__module__` defaulted to `builtins`.** `make_trampoline`
         read `modObj.__name__` as a raw JS property, but Brython modules keep
         `__name__` in their dict (`module_setattr`) — so every C-module function
         (`array._array_reconstructor`, `struct.pack`, …) reported
         `__module__='builtins'` and was unpicklable. Fix: read the module name
         via `get_from_dict`.
      3. **Trampolines re-wrapped on entering a container.** A C-function
         trampoline placed in a tuple/list/dict (e.g. a reduce tuple) was run
         through Brython's `jsobj2pyobj` by the container `$factory`, which —
         not recognising the bare JS function — wrapped it in a fresh
         `JavascriptFunction` named `'tramp'` with `__module__='builtins'`,
         losing identity and name (so `reduce_ex(3)[0] is _array_reconstructor`
         was False and pickle saw an unpicklable `<JavascriptFunction>`). Fix:
         tag trampolines with `$B.PYOBJ` so `jsobj2pyobj` returns them unchanged.
      4. **Buffer protocol read `.source` instead of the live C buffer.**
         `wasthon_get_buffer_data` copied `.source` (the zero placeholder) for a
         bytes whose content a C producer wrote straight into `__wasthon_cstr__`
         (pickle's `_Unpickler_ReadInto`) before the post-call `syncBytes` fold —
         so the reconstructor's `items` `Py_buffer` read zeros and unpickled
         arrays came back all-`0`. Fix: when `__wasthon_cstr_size__` is set (the
         writable-producer signature), expose the live `__wasthon_cstr__` buffer.
         Guarded to immutable producer-buffers (bytearray's `w*` path excluded).

- [x] `_Py_hashtable` keyed by raw pointer, breaking `_hmac`'s hash-name lookup —
      the JS-Map-backed shim used the `key` value directly as the Map key.
      `hmacmodule` builds a name→algorithm table by `set`ting with static string
      literals (`e->name`, e.g. `"sha256"`) and later `get`s with
      `PyUnicode_AsUTF8(name)` — a *different* pointer for the same text — so
      every lookup missed and `hmac.new(key, msg, 'sha256')` raised
      `UnknownHashError: unsupported hash type: 'sha256'` for every algorithm.
      Fix: key the Map by string CONTENT (`UTF8ToString(key)`) in
      `_Py_hashtable_set`/`_get`/`_get_entry`. `_Py_hashtable` is used only by
      `hmacmodule` among the built modules, and its keys are always C strings.
      +20 (test_hmac, once it's routed to wasthon's `_hmac` instead of Brython's
      hmac.py)

- [x] `PyObject_CallMethod` dropped every integer format code except `i` — its
      varargs walker handled only `O`/`s`/`i`/`d`, so an `n` (Py_ssize_t),
      `l`/`k`/`I` or `L`/`K` slot was silently skipped: no arg pushed, pointer
      not advanced. `array.fromfile(f, n)` calls `f.read("n", nbytes)`, so the
      size was dropped → `f.read()` slurped the whole file → `PyBytes_GET_SIZE
      != nbytes` → "read() didn't return enough bytes". Fix: handle
      `n`/`l`/`k`/`I` (32-bit in wasm32) and `L`/`K` (64-bit low+high halves),
      plus `f` (a float is promoted to double in varargs). +14 (test_array)

- [x] `PyArg_ParseTupleAndKeywords` didn't support the `O&` converter format —
      it walked the format char-by-char and saw the `&` as an unknown code
      ("format char '&' not implemented"), so every call using a converter
      returned 0. `_lzma`'s filter-spec parser is built entirely on it
      (`|OOO&O&O&O&O&O&O&O&` with `_PyLong_UInt32_Converter` /
      `lzma_mode_converter` / `lzma_mf_converter`), so every filter dict was
      rejected with "Invalid filter specifier for … filter". Fix: recognize the
      `X&` form, consume the `&`, and call `converter(PyObject* value, void*
      addr)` from the wasm table — a converter slot consumes two varargs entries
      (fn ptr + output addr). +6 (test_lzma)

- [x] Hash constructors gave the wrong `data`/`string` conflict message —
      wasthon's `src/hashlib.h::_Py_hashlib_data_argument` (the shim CPython
      inlines from `Modules/hashlib.h`) raised `"argument for hashlib must be
      specified as a positional argument"` for e.g. `md5(b'', string=b'')`,
      where CPython raises `"'data' and 'string' are mutually exclusive and
      support for 'string' keyword parameter is slated for removal in a future
      version."`. Fix: mirror CPython's helper exactly (message text and its
      1/0/-1 return contract). With the `_PyArg_UnpackKeywords` ordering fix in
      place this is the last piece that flips hashlib's
      `test_clinic_signature_errors` (696 subtests). +1

- [x] `_PyArg_UnpackKeywords` diverged from CPython on keyword-error messages
      and ordering — the bridge's reimplementation raised `"f() got multiple
      values for argument 'x'"` where CPython's clinic raises `"argument for f()
      given by name ('x') and position (n)"`, and it checked duplicates vs
      unknown keywords in the wrong order. Worse, its legacy kwargs-dict path
      (METH_VARARGS|METH_KEYWORDS callers — sha3/blake2/lzma) never detected
      unknown keywords at all: it only probed the *known* names, so a bogus
      kwarg like `sha3_256(_=None)` was silently accepted ("TypeError not
      raised"). Fix: rewrote it to mirror Python/getargs.c faithfully — fill
      positional then kwtuple slots, then on leftover keywords report "given by
      name and position" before "unexpected keyword", with unknown-keyword
      detection on both the FASTCALL kwnames and legacy dict inputs (dict keys
      enumerated via `list(d.keys())`). Fixes the C-module clinic
      signature-error tests across the board. +11 (binascii +4, zstd +3,
      struct +1, sqlite3 +1, hmac +1, pickle +1)

- [x] C mapping types couldn't assign by slice (or any non-int key) — the bridge
      wired `__getitem__` from `mp_subscript` but never wired `__setitem__` /
      `__delitem__` from `mp_ass_subscript`, so `a[i:j] = x` / `del a[i:j]`
      dispatched through the int-only `sq_ass_item` and raised "array indices must
      be integers". (wasthon.h reuses slot id 26 for both `Py_nb_int` and
      `Py_mp_ass_subscript`; disambiguated by `mp_subscript` presence.) Fix: a
      `mas` shape (item passed as a PyObject, value NULL = delete) wired to
      `__setitem__`/`__delitem__` with precedence — mirror of the
      `mp_subscript`→`__getitem__` wiring. +48 (array +25, decimal SignalDict +18,
      sqlite3 +5)

- [x] C-module exception types weren't recognized as exceptions —
      `PyType_FromModuleAndSpec` ignored its `bases` argument, so a type built
      with `PyTuple_Pack(1, PyExc_Exception)` (e.g. `_csv.Error`) inherited only
      `object`: `issubclass(csv.Error, BaseException)` was False and unittest's
      `assertRaises(csv.Error, …)` rejected it ("arg 1 must be an exception
      type"). And such types, having no own `Py_tp_new` slot, fell through to the
      raw-alloc fallback, so `raise csv.Error('x')` built an instance with no
      `.args` ("args is undefined"). Fix: honor the bases tuple (set
      `tp_bases`/`tp_base`, recompute the MRO via `make_mro`), and for
      exception-subclass types without a `tp_new` slot inherit `tp_new`/`tp_init`
      from the MRO (BaseException's, which set `.args`). Unblocks
      `assertRaises`/`raise`/`except` for every C-module exception. +16 (test_csv,
      together with the Brython sequence-iterator fix)

- [x] `PyMapping_Check` rejected every dict — it tested `obj.__class__ ===
      _b_.dict` (undefined on Brython dict instances — they carry their type on
      the `OB_TYPE` symbol, detected via `$B.is_dict`) and then fell back to
      `$B.$hasattr`, **which does not exist**, so the fallback threw and `catch`
      returned 0. `_lzma`'s `lzma_filter_converter` therefore rejected every
      filter dict with "Filter specifier must be a dict or dict-like object".
      Fix: detect dicts via `$B.is_dict` and probe `__getitem__` with the
      3-arg `$getattr`-with-default. +2

- [x] `PyCallable_Check` too narrow — it returned true only for JS functions
      (`typeof obj === 'function' || obj.$is_func`), so Brython **classes**
      (callable → instantiate) and **bound methods** were reported NON-callable.
      `_pickle`'s `save_reduce` then rejected them: a `__reduce__` returning
      `(callable, args, …)` whose callable is a class or method raised *"first
      item of the tuple returned by __reduce__ must be callable, not
      type/method"*. Fix: for non-function objects, fall back to Brython's
      `callable()`. **+14** (`test_pickle` 379 → 392, `test_csv` 93 → 94; full
      sweep 2663 → 2677, zero regression).

- [x] NEWOBJ reconstruction — `ensureTypeStruct` builds a minimal type-struct
      for a Brython class but left `tp_new` (offset 60) and `tp_name` (offset 12)
      NULL. So once handle identity (entry below) let the *dump* side succeed,
      *unpickling* a NEWOBJ stream still failed on *load*: `_pickle`'s
      `load_newobj` calls `cls->tp_new(cls, args, kwargs)`, read NULL, and raised
      *"NEWOBJ class argument '(null)' doesn't have __new__"* (the `'(null)'`
      being the unset `tp_name`). Every object-subclass round-trip — even
      `class MyList(list)` — failed there. Fix: `ensureTypeStruct` installs a
      real `tp_new` (`wasthon_brython_tp_new`, a JS-library fn that does
      `cls.__new__(cls, *args)` via Brython) plus a C-string `tp_name`. **+48**
      (`test_pickle` 331 → 379; full sweep 2615 → 2663, zero regression). Builds
      on the handle-identity fix below — neither alone moves pickle round-trips;
      together they take `test_pickle` 315 → 379 (**+64**).

- [x] handle identity — a Brython object wrapped twice got two *different*
      C handles: `wrap()` allocated a fresh sentinel id on each call, and a
      class additionally had a malloc'd type-struct handle (`ensureTypeStruct`,
      cached on `__wasthon_type_handle__`). So C code comparing two handles for
      the same object by pointer / `is` failed. `_pickle` is the headline
      victim: `save_reduce`'s `__newobj__` check (`obj_class != cls`) raised
      *"first argument to __newobj__() must be `<class 'X'>`, not `<class 'X'>`"*
      — the same class name on both sides being the tell — and `save_global`'s
      `actual != global` raised *"it's not the same object as M.N"*. Fix:
      `wrap()` now returns the **canonical type-struct handle for types** (one
      `obj.ob_type === type` ref-compare, instantly false for non-types) and
      **interns every other Brython object by identity** via a reverse
      `Map<object,handle>`, so re-wrapping the same object always yields the
      same handle. **+19** (`test_pickle` 315 → 331, `test_array` 542 → 543,
      `test_decimal` 226 → 228; full sweep 2596 → 2615, zero regression). This
      unblocks the *dump* side of pickling plus identity-dependent tests in
      array/decimal; the *load* side (NEWOBJ reconstruction) needs the next fix.

- [x] deterministic free of heavy C resources at `close()` — Brython
      is GC, not refcount, so a transient wasthon C instance (e.g. an
      `LZMACompressor` reassigned/dropped in a test) never reaches
      refcount 0, never runs `tp_dealloc`, and its malloc'd context
      (an lzma encoder dict is ~94 MB at the default preset) leaks until
      the WASM heap hits the 2 GB wasm32 ceiling and OOMs. A
      FinalizationRegistry does NOT help: during a synchronous test run
      the event loop never yields, so its (and any `__del__`) callbacks
      never fire — Brython itself ships no FinalizationRegistry. The
      C-side free is fine (`decref → tp_dealloc → lzma_end → free`, and
      the freed bytes are reused — verified: create→free→create keeps the
      heap flat); the only missing piece is a *deterministic* trigger.
      `loader/wasthon-dealloc.js` supplies one: it wraps `$B.$import`
      (synchronous, in place before the suite runs) to patch the close()
      of the compression file wrappers (`lzma.LZMAFile`, `bz2.BZ2File`,
      `compression.zstd.ZstdFile`) so they decref the compressor/
      decompressor they drop — the tests use `with LZMAFile(...)` etc., so
      the context is reclaimed at the `with` exit. Exposes
      `$B.$wasthon_free(obj)` for reuse on any heavy type. **+8**
      (`test_lzma` 59 → 66, `test_zstd` 72 → 73; full sweep 2546 → 2554,
      zero regression). An audit of every native-resource C type
      (sqlite3, lzma, bz2, zstd, zlib, pyexpat, _elementtree) confirmed
      tp_dealloc (stage 1) is present everywhere and the deterministic
      trigger (stage 2) is now wired for all the HEAVY ones that expose a
      close()/`with`; the residue is the explicit-contract boundary
      (objects with no close() — zlib `compressobj`, raw compressors —
      hold only light native and leak until GC, which is acceptable). (A
      weak-handles + FinalizationRegistry variant in the bridge was
      prototyped and reverted — correct but inert under synchronous load:
      its callbacks never fire while the event loop doesn't yield.)

- [x] `__wasthon_install_getsets` builds a Brython-native
      `getset_descriptor` instead of a Python `property` — the previous
      `property` shape didn't match any of the cases in Brython's
      `$B.$getattr()` fast-path switch (`brython.js:4525-4541`), so
      getsets installed for some attribute names silently fell through
      to AttributeError. Also writes `cls.tp_funcs[name+'_get']` /
      `[name+'_set']` per Brython's convention (see brython.js:3422),
      and forces a tp_dict init if one wasn't allocated yet. Size cost
      +478 bytes mjs, zero wasm. **+4 tests** silently across the
      20-suite sweep — `test_csv` 41 → 43, `test_decimal` 224 → 226
      (sweep total **2437 → 2441**). Hash-module attribute `name`
      (and a few other JS-reserved names) still doesn't resolve via
      this path on every type — that's a separate Brython class storage
      mystery left for future investigation.

- [x] stack sizing per module — `_decimal`, `_pickle`, `pyexpat` and
      both wasthon bundles linked with `-sSTACK_SIZE=4MB`; `_decimal`
      and the `wasthon-full` bundle additionally carry
      `-sSTACK_OVERFLOW_CHECK=2`. The sizing rule is **"match the
      legitimate use case, not just the tests"**: each of these three
      modules has a stack-heavy code path that's part of its public
      contract — arbitrary-precision arithmetic on big numbers for
      `_decimal` (libmpdec NTT multiplication scratch buffers scale
      with precision), deeply-nested XML for `pyexpat` (expat's
      recursive xmlparse/xmlrole/xmltok), and deep object-graph
      serialization for `_pickle` (recursive Pickler/Unpickler walks).
      Under emcc's 64 KB default the SP write past the ceiling corrupts
      adjacent memory silently and surfaces as `RangeError: index out
      of bounds` WASM traps. The probe-bisection plateaus per test
      suite (`pyexpat` at 1 MB, `_pickle` at 4 MB) are tighter than
      what real workloads can hit, so we bump everyone to 4 MB for
      headroom on legitimate inputs (DOM trees with hundreds of nesting
      levels for XML, deeply-recursive object graphs for pickle, very
      high `c.prec` for Decimal). `STACK_OVERFLOW_CHECK=2` is scoped to
      `_decimal` (and the `wasthon-full` bundle that contains it) since
      libmpdec is the single module that can still push the stack at
      extreme inputs even with 4 MB; the per-prologue guard turns any
      remaining overflow into a clean Python exception instead of
      silent corruption. The light `wasthon` bundle does NOT carry the
      check (`_decimal` is not in it, no other module needs it).
      **Zero `.wasm` byte cost** for STACK_SIZE — runtime reservation,
      `wasthon.wasm` measured at 1 093 468 → 1 093 471 bytes (+3 bytes
      from the section header tag). `STACK_OVERFLOW_CHECK=2` carries a
      small `.wasm` cost: `_decimal.wasm` +4.3%, `wasthon-full.wasm`
      +2.1%. Cumulative impact across the 20-suite sweep:
      **2296 → 2437 (+141)** — `test_pickle` **194 → 312 (+118)**,
      `test_decimal` **223 → 224 (+1)** with `test_bignum`
      (`c.prec=1_000_000` legitimate big-number test) now passing
      uniformly in both load modes, `test_pyexpat` **11 → 33 (+22)**,
      all other 17 suites byte-for-byte identical.

- [x] link with `-sSTACK_OVERFLOW_CHECK=2` — `_decimal` (via libmpdec) allocates
      large stack frames during arithmetic on big Decimal values. With the
      Emscripten default (`STACK_OVERFLOW_CHECK=0` under `-O2`), an overflow
      corrupts the stack silently and the next memory load returns garbage,
      manifesting as a generic `RangeError: index out of bounds` WASM trap on
      ~100 test_decimal tests (anywhere that constructs a Decimal in a
      sufficiently deep call chain: `assertEqual` chains, `hashit()` helpers,
      `convert_op` paths, …). Level 1 (`STACK_OVERFLOW_CHECK=1`) only checks at
      exit so the corruption still propagates. Level 2 inserts a guard on
      every function prologue, catching the overflow before it corrupts. The
      `_decimal` C calls then unwind cleanly and Brython sees a normal Python
      exception instead of a WASM trap. **test_decimal 117 → 223 (+106)**, zero
      regression across the other 19 suites (sweep total **2190 → 2296**).
      Scoped to where it's needed: applied to the `_decimal` standalone case
      and to the `wasthon-full` bundle link only. The light `wasthon` bundle
      and all other per-module standalone links are intentionally untouched
      (drop-in size budget). Size delta — `_decimal.mjs` +2.0% (94→96 KB),
      `_decimal.wasm` +4.3% (236→246 KB), `wasthon-full.mjs` +0.8% (244→246 KB),
      `wasthon-full.wasm` +2.1% (3138→3204 KB); `wasthon.{mjs,wasm}` byte-for-
      byte identical. Discovered via a multi-hour bridge-side investigation
      that initially chased a phantom "module state corruption" hypothesis
      from memory — the real cause was an emcc build-flag default, not a
      bridge bug.

- [x] `PyErr_Format` `%R` / `%S` / `%A` / `%T` / `%N` — only `%T`/`%N` were
      missing entirely (emitted as literal `%T` / `%N`), and `%R`/`%S`/`%A`
      were doing a naive `String(obj)` which renders Brython class objects
      as `[object Object]`. _pickle uses both: `PyErr_Format(error,
      "must be %R, not %R", cls1, cls2)` produced `must be [object Object],
      not [object Object]` instead of `must be <class 'int'>, not <class
      'tuple'>`. PyUnicode_FromFormat already routed `%R`/`%S` through real
      `repr`/`str`; PyErr_Format did not. Now:
      - `%R` → `String(repr(obj))`
      - `%S` → `String(str(obj))`
      - `%A` → `String(ascii(obj))`
      - `%T` → `class_name(obj)` (with a string coercion guard for cases
              where the name is a Brython str object rather than a JS
              primitive)
      - `%N` → `(tp_name || __name__)` directly on the type object
      0 net on the local CPython harness (the pickle tests that exercise
      these formats fail at a deeper assertion — the messages now read
      correctly but the structural pickle failures remain), zero
      regression. Correctness fix worth keeping for any future tests
      whose assertion includes the message text.

- [x] trampoline-level arg validation for `METH_O` + slot dispatcher strict
      typing — three tightening fixes to the bridge's slot dispatch made
      sequence/method behaviour match CPython under `assertRaises` and
      strict-type checks:

      1. `METH_O` arg count: was passing whatever `nargs` happened to be
         (could be 0 or >1) to the C function with a wrapped first arg if
         present, else 0. CPython's METH_O *requires* exactly one
         positional. New check raises `TypeError("takes exactly one
         argument")` when `nargs > 1` or any kwargs. **Exempts METH_CLASS**
         — Brython's classmethod path routes the value through `self=cls`
         and leaves `nargs=0` (e.g. `Decimal.from_float(42.5)` on a
         subclass), so a strict `nargs !== 1` regressed test_decimal by 8.
         Letting `nargs == 0 || nargs == 1` past the gate for METH_CLASS
         keeps the gain (+14 test_array, +4 test_binascii) with zero
         regression on test_decimal.
      2. `sq_item / sq_repeat` (shape `'si'`) strict int coercion. Was
         `Number(idx) | 0`, which silently turned `"bad"` into 0 — so
         `a * "bad"` returned an empty array instead of raising
         `TypeError: can't multiply sequence by non-int of type 'str'`.
         Now: reject strings explicitly, accept `__index__`-bearing
         objects via the protocol, raise TypeError otherwise.
      3. `sq_ass_item` (shape `'sis'`) strict int coercion + negative
         index normalisation. CPython's `PyObject_SetItem` normalises
         negative indices before calling `sq_ass_item`; the slot itself
         expects `0 ≤ i < len`. wasthon's dispatch wasn't, so
         `a[-1] = x` raised "array assignment index out of range".
         Also added a `$B.NULL` sentinel pass-through for the `del a[i]`
         path (companion to Brython's `$delitem` slot-aware fix).

      Total **+54 on the local CPython harness**: test_array 461 → 515
      (+54), test_binascii 41 → 45 (+4). Zero regression.

- [x] `sq_ass_item` slot also installs `__delitem__` dunder alias —
      previously only registered `__setitem__`. `assertRaises(TypeError,
      a.__delitem__)` and explicit `a.__delitem__(i)` access raised
      `AttributeError: 'array' object has no attribute '__delitem__'`.
      Same dispatcher serves both (NULL value = delete). +14 test_array,
      zero regression.

- [x] _pickle `PickleBuffer` type — bridge previously bound to a sentinel
      JS object (`{__wasthon_picklebuffer__: true}`) with no `tp_name`, so
      `PyModule_AddType(m, &PyPickleBuffer_Type)` registered it under the
      attribute `<type>` instead of `PickleBuffer`. `from _pickle import
      PickleBuffer` (Brython's `pickle.py:42`) raised ImportError →
      `_HAVE_PICKLE_BUFFER = False` → 109 raw test entries that touch
      `pickle.PickleBuffer` failed. Now: build a real Brython type via
      `make_type('PickleBuffer')`, expose `$factory`/`tp_new`,
      `raw()`/`release()` methods that hand back the underlying buffer.
      Companion fix in `loader/wasthon-loader.js` patches an
      already-imported `pickle` module after install (`__BRYTHON__`
      pre-loads `pickle` before installModule runs, so the `try: from
      _pickle import PickleBuffer` already failed and isn't re-evaluated).
      +1 test_pickle, zero regression — most of the 109 entries fail
      further down on the unrelated "index out of bounds" pattern.

- [x] module-scope trampolines are `builtin_function_or_method`, not bound
      functions — CPython's C-level module functions skip the descriptor
      protocol (no `tp_descr_get`), so `class T: f = math.isclose` then
      `T().f(a, b)` calls `isclose(a, b)`, not `isclose(self, a, b)`. The
      wasthon trampoline returned by `__wasthon_make_trampoline` was a JS
      function whose `ob_type` defaulted to `$B.function`, which DOES define
      `tp_descr_get` → Brython auto-bound it on instance access, so the test
      pattern `class T: helper = somemodule.somefunc; self.helper(a, b)`
      always received an extra `self`. Affected at least the
      `IsCloseTests` / `CompareDigestMixin` family of tests (any
      `class T: <name> = <module>.<func>` shape).

      Fix: after `__wasthon_make_trampoline`, set
      `trampoline.ob_type = $B.builtin_function_or_method` for the
      module-scope branch only (instance methods already explicitly set it
      to `builtin_method` for separate reasons).

      +23 on the local CPython harness: `test_math` 54→65 (+11),
      `test_cmath` 13→25 (+12). Zero regression. Root-pattern fix —
      transverse across any module-level wasthon function used as a class
      helper. Companion to the Brython-side `_compare_digest` non-binding
      wrapper for hmac (logged in BRYTHON_FIX.md).

- [x] heap-type `$buffer_protocol` flag from `Py_bf_getbuffer` slot — when
      `PyType_FromModuleAndSpec` saw a `Py_bf_getbuffer` slot (id 1) in the
      spec, the bridge stored it in `slotMap` but never surfaced anything
      Brython could detect. Brython's `memoryview()` constructor only accepts
      objects whose class exposes `__buffer__`, `bf_getbuffer`, or
      `$buffer_protocol = true` (the marker Brython's own native types set on
      themselves). Without that marker on wasthon types, `memoryview(arr)`
      raised `TypeError: a bytes-like object is required, not 'array'`. The
      fix sets `cls.$buffer_protocol = true` whenever a Py_bf_getbuffer slot
      is present in the spec — bridges the buffer-protocol declaration into
      what Brython's type machinery already recognises. 0 net on the local
      CPython harness (the writable-buffer follow-up paths are still
      incomplete on the Brython side), zero regression. Companion to the
      Brython-side `memoryview` patch landed in `BRYTHON_FIX.md`.

- [x] `PyErr_Format` precision specifier (`%.200s`, `%.Ns`) — same gap as the
      `PyOS_snprintf` parser below: the format reader only consumed length
      qualifiers, so `PyErr_Format(exc, "Error %d: %.200s", err, msg)` left
      `%.200s` verbatim in the exception message. Surfaced by `test_zlib`
      `assertRaisesRegex` paths (`test_wbits`, `test_incomplete_stream`) where
      the expected regex was `"Error -5 while decompressing data: %.200s"`,
      i.e. the test was matching the literal `%.200s` instead of the real
      tail. Fix mirrors `PyOS_snprintf`: parse the full
      `%[flags][width][.precision][length]conv` shape, with `.precision`
      truncating `%s`/`%R`/`%S`/`%A` arguments and width/zero-pad applied
      after. +2 (zlib 49→51), zero regression.

- [x] `PyOS_snprintf` width specifier (`%04X`, `%5d`, …) — the bridge's tiny
      printf parser only consumed length qualifiers (`l`/`h`/`z`/`j`) before
      the conversion letter; flags, width and precision were ignored, so
      `PyOS_snprintf(..., "%04X", 0x31)` wrote `%04X` literally (the parser
      took `0` as the conversion and fell through the unknown branch). Surfaced
      by `test_unicodedata.test_decomposition` — `unicodedata.decomposition()`
      builds its output with `PyOS_snprintf(..., "%04X", cp)` per codepoint, so
      `decomposition('¼')` returned `'<fraction> %04X %04X %04X'` instead of
      `'<fraction> 0031 2044 0034'`. The parser now handles the full
      `%[flags][width][.precision][length]conv` shape: `-`/`0` flags, decimal
      width, `.precision` (used by `%.Ns`), then the same conversions as
      before, with left/right alignment and zero-fill applied after rendering.
      +4 on the local CPython harness (`test_unicodedata` 41→45 — two
      `test_decomposition` + two `test_function_checksum`), zero regression.

- [x] buffer protocol accepts `memoryview` / `array.array` (and any object with
      `tobytes()`) — `wasthon_get_buffer_data` (the read side of
      `PyObject_GetBuffer`) and `wasthon_object_check_buffer` only recognised
      Brython `bytes`/`bytearray` (`.source`), a raw `Uint8Array`, or a JS
      `Array`; anything else raised `TypeError: a bytes-like object is required,
      not 'memoryview'` (and `'array'`). CPython's buffer protocol accepts all
      bytes-like objects. Now, for an object without `.source`, the bridge pulls
      its raw bytes via `obj.tobytes()` — the byte image the buffer protocol
      would hand back — covering `memoryview`, `array.array`, and friends.
      +15 on the local CPython harness: `test_binascii` 26→36, `test_sqlite3`
      297→300 (BLOB/bytes args), `test_struct` 21→23 (unpack-from a buffer),
      zero regression. Read path only — write-back through `w*` still propagates
      only to `bytes`/`bytearray` `.source` (writable `pack_into` into an
      `array` is a separate, smaller follow-up).

- [x] trampoline `$function_infos` — wasthon method/function trampolines now
      carry `$function_infos = [module, name, qualname]` (Brython's native
      builtin-function shape, per `set_func_names`), so a wasthon callable can
      expose `__name__` / `__qualname__` / `__module__` like a native one.
      **Inert on its own:** a *bound* method is built by Brython's
      `method_descriptor.tp_descr_get` via `self.method.bind(...)`, which drops
      the trampoline's own props, and `builtin_function_or_method`'s
      `__name___get` reads `self.$function_infos[...]` unguarded → crash. The
      companion Brython-side fix (propagate `$function_infos` onto the bound
      method in `method_descriptor.tp_descr_get`) is the other half, pending
      upstream in Brython. Together they fix the bound-method
      `__name__`/`__qualname__` crash that breaks `unittest.assertRaises`
      naming the callable (a large suite gain once the Brython half ships in a
      published Brython).

- [x] `METH_NOARGS` arg-count validation in the method trampoline — a C method
      declared `METH_NOARGS` (no-arg methods like array's `tolist` / `tobytes` /
      `reverse` / `count` / `byteswap` / `buffer_info`) silently ignored extra
      positional arguments instead of raising. CPython raises
      `TypeError: m() takes no arguments (N given)`. The NOARGS branch of
      `$__wasthon_make_trampoline` called the C function regardless of `nargs`;
      it now raises when `nargs > 0`. Surfaced by `test_array` — every
      `assertRaises(TypeError, arr.method, x)` on a no-arg method failed with
      "TypeError not raised". +69 on the local CPython harness (array 392→461),
      zero regression across the 20 suites. The symmetric `METH_O`
      "exactly one argument" check was tried and **reverted**: some C methods
      flagged `METH_O` tolerate a 0-arg call (their C body handles a NULL arg),
      and enforcing it regressed `_decimal` by 8 — left for a per-method flag
      audit.

- [x] `'C'` format in `Py_BuildValue` — C int → one-character Python `str`
      (Unicode ordinal). `array.__reduce_ex__` builds
      `Py_BuildValue("O(CO)O", …)` with the typecode passed as a `'C'` char;
      the bridge had no `'C'` case and raised `SystemError: unsupported format
      'C'`. Adds it beside the existing string/char cases (CPython's
      `Py_BuildValue('C')` = single-char `str`, distinct from `'c'` =
      single-char `bytes`). Transversal — any C function using
      `Py_BuildValue('C')`. (Eliminates the error class; the array reduce/pickle
      tests that hit it still fail on a separate downstream layer, so it is
      score-neutral on its own but a correct prerequisite.)

- [x] `tp_dealloc` dispatch + reference counting — C-allocated instances are
      now reclaimed when their refcount reaches zero, instead of living
      forever in the bridge's handle map. Long-standing infra debt (the
      "no-`tp_dealloc`" caveat referenced throughout the benches). Design,
      after two abandoned dead ends (top-bit and high-range sentinel
      encodings — both tripped on i32 signedness / C validation paths
      comparing handle values): the refcount lives **JS-side in a
      `Map<ptr,int>` (`WasthonRT.refcounts`)**, never in the C struct, and
      "is this a refcountable instance?" is decided by **Map membership** —
      no value-range test, no handle-memory deref, so sentinels (small ints
      intermixed with real pointers) stay safe. Pieces:
      *(1)* ABI alignment — `ob_refcnt` given its own slot at offset 0 of
      `PyObject_HEAD` / `PyVarObject` / `PyTypeObject` (every field shifts
      +4, type struct 60→64). This alone scored +10 on the harness: the old
      empty `PyObject_HEAD` meant CPython's `Py_SET_REFCNT` was writing over
      the first real struct field (latent corruption in the richest instance
      structs, sqlite3/_decimal).
      *(2)* `Py_INCREF` / `DECREF` / `XINCREF` / `NewRef` / `CLEAR` / `SETREF`
      macros route through `wasthon_incref` / `wasthon_decref`, NULL-guarded;
      a no-op on any handle not in the Map.
      *(3)* `wasthon_object_gc_new` seeds refcount 1; when `wasthon_decref`
      reaches 0 the bridge reads `tp_dealloc` at `__wasthon_type__ + 40` and
      calls it via `getWasmTableEntry`; the C body `Py_CLEAR`s its fields
      (recursing into decref) then `tp_free` = `PyObject_GC_Del`, freeing the
      linear-memory struct and dropping the handle.
      *(4)* **C-API refcount-convention audit** — every bridge API taking or
      returning a `PyObject*` was checked against CPython's contract and
      fixed: no-steal container inserts INCREF the stored value(s)
      (`PyDict_SetItem` / `SetItemString`, `PyList_Append` / `Insert`,
      `PyModule_AddObjectRef`, `PyObject_SetAttr` / `SetAttrString` /
      `GenericSetAttr`, `PyObject_SetItem`, `PyTuple_Pack`); steal APIs
      (`PyList_SetItem`, `PyTuple_SetItem`, `PyModule_Add`) deliberately do
      not; new-ref returns INCREF (`PyDict_GetItemRef`, `PyWeakref_GetRef`,
      `PyObject_GetOptionalAttr`, and `PyObject_Vectorcall` via a new
      `wrapNewRef` helper). A wrong contract here means a balanced
      `Py_DECREF` hits zero one ref early → `tp_dealloc` fires → use-after-free;
      that is exactly how the `_decimal` import crash (`current_context()`'s
      `PyDict_SetItem` didn't INCREF → DefaultContext freed) and the
      `_struct` `calcsize→0` regression (cache_struct_converter's
      `PyDict_GetItemRef` is a new-ref) were traced via per-type
      INCREF/DECREF logging and fixed. Net: local harness back to
      **1750/4485, zero regression**, with module-by-module recovery
      (decimal 49→58, struct 12→20, sqlite3 258→285) each via a specific
      contract fix.
      **Proven, not asserted** — `loader/test-tp-dealloc.html` runs the same
      `_pickle.dumps` loop twice on one module, toggling a new
      `runtime.noFree` switch (kept as a permanent regression harness; gated,
      default off): with dispatch on, `refcounts.size` stays flat at 0 across
      N calls (every internally-created `Pickler` reclaimed); with it off it
      climbs exactly +1 per call (instances pinned forever).
      **Honest scope** — this reclaims instances whose refcount actually
      reaches zero: C-internal create+`Py_DECREF` (Pickler/Unpickler) and
      container `Py_CLEAR`. It does **not** fix two separate leaks:
      *(a)* an instance held only by a Python local that goes out of scope —
      Brython has no FinalizationRegistry hook back into `wasthon_decref`, so
      nothing DECREFs it (still caps loop-bench depth for compressors /
      sqlite Connections); *(b)* the dominant `pickle.dumps` byte-leak, which
      is JS-side sentinel handle-map accumulation (~67 `wrap()` calls per
      `dumps()` never released — borrowed-ref C code doesn't DECREF and
      sentinels aren't refcounted). `tp_dealloc` structurally cannot touch
      either; both stay in `README.md` → *What's next*. Incidental find (not
      fixed): `_pickle.dumps` on `bytes` > 64 KB trips the protocol-5 framing
      path with `TypeError: 'UndefinedType' object cannot be interpreted as
      an integer`.

- [x] `Py_mp_subscript` (slot 27) wired by default; `__getitem__`
      installed whenever `cls.mp_subscript` is set. Pierre 2026-05-26:
      ```
      regex = re.compile('(a|b)')
      mo = regex.match("a")
      assert mo[0] == "a"   # TypeError: 'Match' object is not subscriptable
      ```
      Root cause: wasthon.h defines `Py_mp_subscript = 27`, but the
      `slotDispatch` table in `PyType_FromModuleAndSpec` had
      `27: nb_invert` as default and only switched to `mp_subscript`
      when `isSequence` was true (detected via `Py_sq_ass_item=39` or
      `Py_sq_contains=41` markers). `_sre.Match` has `mp_subscript` but
      no `sq_*` markers, so it stayed unwired. Verified that
      `Py_nb_invert` is NOT defined in wasthon.h at all, so no C module
      can ever pass slot 27 as nb_invert — the gating was historic /
      cargo-cult. Two changes: (1) slot 27 default in `slotDispatch` is
      now `['mp_subscript', ['__getitem__'], 'b']` unconditionally;
      (2) the `__getitem__` wiring at the end of `PyType_FromModuleAndSpec`
      now fires `if (cls.mp_subscript)` alone (was
      `if (isSequence && cls.mp_subscript && cls.sq_item)`), mirroring
      CPython's `PyObject_GetItem` precedence (mp_subscript first,
      sq_item as fallback). Transversal: any wasthon heap type with
      `mp_subscript` but no `sq_item` now supports `obj[key]`. Regression
      test added to `loader/test-debug.html` ("Match: m[0] subscript").

- [x] `cls.tp_descr_get` / `cls.tp_descr_set` default to `$B.NULL` on heap
      types. Brython's `type_getattribute` (py_type.js:1318) reads
      `$B.get_class(attribute).tp_descr_get` after finding the attribute
      in the MRO, then `if (local_get !== $B.NULL) { ... local_get(...) }`.
      If `cls.tp_descr_get` is `undefined` (not set at all), the truthy
      check passes, Brython logs `not a function undefined NULL` and then
      crashes with `JavascriptError: local_get is not a function` when
      it tries to actually call `undefined(...)`. Surfaces specifically
      when a wasthon C-object is assigned as a **class attribute** on a
      Python subclass — e.g. `class T: db = unicodedata.ucd_3_2_0` —
      because that's when Brython traverses the MRO and lands on the
      wasthon instance, then queries its `__class__.tp_descr_get`.
      Discovered 2026-05-26 fishing the `Unicode_3_2_0_FunctionsTest`
      cluster (18 fails `JavascriptError: getter is not a function`,
      which turned out to be the parent-message variant of the same
      pattern). Fix: in `PyType_FromModuleAndSpec`, default both
      `tp_descr_get` and `tp_descr_set` to `$B.NULL` when not otherwise
      set (mirrors what Brython does for its own native types via
      `init_type`). Transversal — but the gain in the harness was
      moderate (+4 on test_unicodedata, 25 → 29; other suspected
      clusters `__hashvalue__ of undefined`, `$function_infos undefined`
      were unaffected, so those are distinct bugs).

- [x] `PyFloat_AsDouble` — coerce non-floats via `__float__` / `__index__`.
      Previously rejected anything that wasn't a JS `number` or a Brython
      float wrapper (`{value: number}`) with `TypeError: PyFloat_AsDouble:
      argument is not a float` — surfaced as 5 fails in `test_math`
      (testDist, testHypot, testLog1p, test_exception_messages, test_ulp)
      where the test passes a `Decimal`, an `IntEnum`, or any user object
      with a `__float__` method. CPython's `PyFloat_AsDouble` falls back
      to `nb_float`/`__float__` then `nb_index`/`__index__` for non-floats.
      Fix: wrap a `try { _b_.float.$factory(obj) }` around the coercion
      path (mirrors the `coerceInt` pattern already used by every
      `PyLong_As*`). Math score 51/89 → 56/89 (+5). testCeil/testFloor
      still fail — different bug (math.ceil/floor should dispatch on
      `__ceil__`/`__floor__` before falling back to `__float__`, not yet
      wired). Discovered 2026-05-26 fishing the failure clusters in
      `test_math`.

- [x] `tp_new` — honor Python subclasses of wasthon C-types. Sister fix
      to the `__wasthon_install_methods` entry just below, discovered the
      same day fishing why `test_random.py` still crashed at import even
      after the install_methods fix landed. Brython's `random.py:110`
      defines `class Random(_random.Random):` adding `uniform`, `randint`,
      `seed` (Python wrapper that calls `self.gauss_next = None`), etc.
      Then `_inst = Random()` at line 891 instantiated the Python
      subclass, but our `cls.tp_new` (set in `PyType_FromModuleAndSpec`
      ~l.7578) passed the **parent** `typeHandle` to the C side and
      returned the result as-is — so `type(_inst)` was `_random.Random`
      (the parent C-type), not `Random` (the Python subclass).
      Consequences: `_inst.uniform` raised `AttributeError` (the Python
      method was on the subclass, lookup happened on the parent), and
      even after that path was fixed, `self.gauss_next = None` raised
      "no __dict__ for setting new attributes" because the parent C-type
      had `tp_dictoffset = 0` and we hadn't given the subclass instance
      its own `__dict__`. Fix in two parts, both in the post-C-tp_new
      block of `cls.tp_new`: (1) when `brythonCls !== cls` (the captured
      parent), override `inst.ob_type = brythonCls; inst.__class__ =
      brythonCls` — mirrors what CPython's `tp_new` does naturally via
      `tp_alloc(type, 0)` honoring its `type` argument; (2) attach an
      instance `__dict__` via `$B.set_dict(inst, $B.obj_dict({}))` —
      mirrors what Brython's `object.$new` (`py_object.js:130`) does
      unconditionally for `cls !== object`, and what CPython's
      `PyType_Ready` does by auto-adding a `__dict__` slot to subclasses
      of C-types that don't have one. `__wasthon_type__` is left pointing
      at the parent C-type struct so `Py_TYPE`/`PyObject_TypeCheck` on
      the C side still see the correct PyTypeObject. Transversal: any
      Python subclass of any wasthon heap type benefits — `random.Random`
      (now testable, 84/114 vs Brython-native 82/114, +2 from bit-exact
      Mersenne Twister), and any user code doing `class MyX(C_type)`.
      Regression coverage: `loader/test-subclass-debug.html` instruments
      both paths (subclass identity + Python attr storage) on Random,
      BZ2Compressor, and a Brython-native dict control.

- [x] `__wasthon_install_methods` — install methods as `method_descriptor`
      in tp_dict, not just in `tp_funcs`. Discovered fishing Pierre's
      `AttributeError: 'Pattern' object has no attribute 'match'`:
      `pattern.match(...)` (direct call) worked, but `pattern.match`
      (attribute access), `hasattr(p, 'match')`, `getattr(p, 'match')`,
      `'match' in dir(Pattern)`, and `m = p.match; m(...)` all failed —
      on every heap type created via `PyType_FromModuleAndSpec` (Pattern,
      Match, Connection, Cursor, BZ2Compressor, LZMACompressor,
      ZstdCompressor, ZstdDecompressor, ZstdDict, XMLParser, Pickler,
      Unpickler, csv.reader/writer, decimal.Context, …). Latent for the
      previous 25 modules because every test + bench exercises only
      `obj.method(...)` (compiled by Brython to `call_attr` which reads
      `tp_funcs` directly), never the attribute-lookup path used by
      `getattr` / `dir` / `hasattr` / bind-then-call. Root cause: Brython's
      `$B.$getattr` fast path (`py_builtin_functions.js:789`, condition
      `klass.tp_funcs && klass.$getattribute === object.tp_getattro`)
      reads `$B.get_from_dict(klass, attr)` — i.e. the **class dict**, not
      `tp_funcs[attr]`. For its own natives Brython populates tp_dict
      with `method_descriptor` objects (see
      `finalize_builtin_types.js:309-325`). Wasthon installed methods
      only in `tp_funcs` → `get_from_dict` returned NULL → fallback to
      `object_getattribute` returned NULL → `AttributeError`. Fix mirrors
      Brython's own native install: after `target.tp_funcs[name] =
      trampoline` and `trampoline.ob_type = $B.builtin_method`, also do
      `str_dict_set(get_dict(target), name, {ob_type: $B.method_descriptor,
      method: trampoline, d_name: name, d_type: target})` and the
      `trampoline.self = descr` cross-ref. Brython's
      `method_descriptor.tp_descr_get` then builds the proper bound
      wrapper with `m_self` + `ml` + `$infos` — without which the next
      `repr()` or `__name__` access crashes on `$function_infos[1]
      undefined`. Transversal: 15+ heap-type classes across 10+ modules
      benefit. New regression section in `loader/test-debug.html` covers
      the four lookup paths on Pattern / BZ2Compressor / sha256 /
      XMLParser. Earlier sibling fix (PyObject_GetAttr C-side
      tp_funcs fallback, see `_pickle` entry below) covered the
      C-to-Python lookup; this one covers the Python-to-Python lookup.

- [x] custom `tp_getattro` slot wiring — `_decimal.Context.traps` /
      `.flags` live on the C struct (not in any Brython dict / getset)
      and are intercepted by `context_getattr` before its fallback to
      `PyObject_GenericGetAttr`. The bridge didn't read slot 57
      (`Py_tp_getattro` per wasthon.h's numbering), so `ctx.traps`
      raised `AttributeError`. Two earlier strategies failed in
      reproducible ways: *(a)* hooking `$getattribute` directly →
      recursion through `C context_getattr → PyObject_GenericGetAttr →
      $B.$getattr → $getattribute → us`; *(b)* try-default-then-fallback
      → didn't trigger because Brython's default `object.tp_getattro`
      returns an `Object {null:null}` "missing" sentinel for absent
      attrs instead of raising `AttributeError` (so our `catch
      (AttributeError)` never fired). The working
      strategy is **C-first with a re-entry guard**: invoke the C
      function first; for hard-coded interceptions (`traps`/`flags`) it
      returns the struct field directly, and for everything else it
      falls through to `PyObject_GenericGetAttr` → `$B.$getattr` →
      back into us, where the re-entry guard sees the in-flight name
      and bottoms out to the default lookup (which finds `prec` etc.
      via the normal getset). Transversal: any C type with a custom
      `tp_getattro` slot.

- [x] `float` wrapping consistency — `D('1.5').exp()` /
      `D('100').ln()` failed with `JavascriptError: can't access
      property "indexOf", klass.__mro__ is undefined` because
      `Decimal.__float__` goes through `PyDec_AsFloat` →
      `PyFloat_FromString`, and the bridge returned the parsed JS
      number raw (`rt.wrap(v)`) → Brython saw a `JSObject` instead of
      a `float`, and the `float()` builtin's `obj.__class__.__mro__`
      lookup blew up on `undefined`. In Brython 3.14, `_b_.float` is a
      `PyTypeObject` mirror (same shape as `_b_.slice` / `_b_.bool` /
      `_b_.dict`) and its `$factory` produces `{ob_type, value}`
      instances **without** `__class__` — a fact the bridge needed to
      know but wasn't accounting for. *(1)* `PyFloat_FromDouble`:
      patch `obj.__class__ = obj.ob_type` on the `$factory` result so
      both lookup paths resolve. *(2)* `PyFloat_FromString`: route
      through `PyFloat_FromDouble` after parsing instead of
      `rt.wrap(rawNumber)`, so the wrapping is consistent. Transversal
      — any C function returning a float (`math`, `cmath`, `_decimal`,
      `_statistics`, …) now produces a properly-typed Python `float`.

- [x] `'O&'` converter format in `Py_BuildValue` — `pyexpat`'s
      `ProcessingInstruction` and `Comment` handlers use
      `Py_BuildValue("(NO&)", name, conv_string_to_unicode_void, data)`
      to convert the raw `XML_Char *` data argument to a Python `str`
      via a callback. The bridge had no `'O&'` handler and bailed with
      `SystemError: unsupported format '&'`. Add it: read fn ptr +
      arg ptr, dispatch via `getWasmTableEntry(fnPtr)(arg)`, wrap the
      result. Transversal — any C function calling `Py_BuildValue` with
      `'O&'` benefits.

- [x] `_csv` cluster — `list_dialects()`, `reader(…, delimiter='\t')`,
      kwarg-driven dialects. Four bridge gaps surfaced together by
      `loader/test-debug.html`, all in the kwargs/dict path:
      *(1)* `PyDict_Keys` called `_b_.dict.keys(d)`, but `_b_.dict` (a
      `PyTypeObject` mirror in Brython 3.14) only exposes `$`-prefixed
      internal methods (`$getitem`/`$setitem`/`$contains`/…) and no
      top-level `keys` — so the call raised "is not a function". The
      bridge code was simply written against the wrong API surface.
      Route through `$B.$getattr(d, 'keys')` + `$B.$call(list, …)`
      instead, the same canonical pattern `flattenKwArray` already
      uses for `.items()`. Unblocks `_csv.list_dialects()` (was raising
      `RuntimeError: … returned NULL`).
      *(2)* `METH_VARARGS|METH_KEYWORDS` legacy trampoline built its
      `kwDict` with the dead `str_dict_set ? … : (kwDict[k]=v)` idiom —
      same pattern we already replaced for `tp_init` earlier. Use
      `$B.empty_dict()` + `dict.$setitem()` so entries land in real
      hash storage. Without this, every kwarg passed to legacy
      `METH_KEYWORDS` C functions was silently lost.
      *(3)* `flattenKwArray`'s Brython-dict detection checked
      `m.__class__ === _b_.dict`, but Brython 3.14 instances mark
      their type via `ob_type` (and the bridge had the same `__class__`
      assumption baked in elsewhere — same family as the `PySlice_Check`
      fix). Accept either shape.
      *(4)* `PyObject_VectorcallDict` wrapped kwargs as
      `{$nat:'kw', $kw: <Brython dict>}`. Brython's call codegen
      expects `$kw` to be an **Array of plain JS maps**, not a single
      dict — passing a dict as an element made `$call` build a fresh
      empty `kw` at the receiver. The bridge had been emitting the
      wrong shape since this code was written. Walk the dict's
      `.items()` into a plain JS map and pass `{$kw: [flat]}`. `_csv`'s
      `_call_dialect` (and any other
      `PyObject_VectorcallDict` caller) sees the kwargs intact at
      `tp_new`/`tp_init`. Transversal — fixes 2/3/4 benefit every C
      type taking kwargs through these paths (`_sqlite3` Connection
      options, `pyexpat.ParserCreate` flags, etc.).

- [x] `PyLong_FromUnsignedLongLong` i64 sign — `_struct.unpack('>Q',
      b'\xff' * 8)` returned `(-1,)` instead of `(0xFFFFFFFFFFFFFFFF,)`.
      Root cause: `bu_ulonglong` computes the unsigned `u64` correctly
      in C, but at the wasm→JS boundary emcc converts `i64` to BigInt
      with **signed** interpretation, so values with the high bit set
      arrive as negative BigInts. The bridge then wrapped the negative
      BigInt directly. Reinterpret in `[0, 2^64)` before wrapping
      (`if (v < 0n) v = (1n << 64n) + v`). Transversal: any C function
      returning `unsigned long long` benefits; the 32-bit variants are
      fine since wasm i32 stays in `Number` range.

- [x] `'w*'` writable-buffer format in `PyArg_Parse` —
      `_struct.pack_into(buf, off, …)` raised `"cannot convert (got
      object)"`: the bridge had handlers for `'O'`/`'C'`/`'s'`/`'s#'`
      and numerics but no `'w*'`. Adds the format — materialize the
      bytearray's bytes into linear memory, fill the 12-field
      `Py_buffer` struct (48 bytes on wasm32) with `readonly=0` and
      the obj handle stored in `view->obj` — and pairs it with a
      write-back step in `PyBuffer_Release`. The C-side release now
      defers to a new JS helper `wasthon_buffer_release`, which
      copies linear-mem bytes back into `obj.source` for writable
      buffers before freeing. Read-only buffers (the common case
      used by `_bz2`/`_lzma`/`_sha2`/…) take the skip-copy-back
      branch — behaviour unchanged. Transversal: any C function
      using `PyArg_Parse('w*')` benefits.

- [x] `bool` coercion + `callable()` on C-call types — two small bridge
      gaps surfaced by `loader/test-debug.html` while probing
      `_json.make_encoder`. *(1)* `PyArg_Parse` format `'p'` (predicate)
      called `_b_.bool(value)` directly, but in Brython 3.14 `_b_.bool`
      is a `PyTypeObject` mirror, not a callable function — the right
      form is `_b_.bool.$factory(value)`, which the trampoline's own
      `'p'` handler was already using. So the bridge was inconsistent
      with itself, not with Brython. *(2)* `tp_call` wiring set
      `cls.tp_call` but never `cls.__call__`, so Brython's
      `callable(obj)` returned False for any C type defining `tp_call`
      (`_json` Encoder, `_decimal` Context, `_sqlite3` Connection,
      etc.); mirror the dispatch as `cls.__call__` + `set_to_dict` so
      Brython's MRO lookup finds it. Transversal: any C function
      taking a `'p'`-format arg or any C type with `tp_call` benefits.

- [x] `array.array` cluster fixes — 6 ✗ collapsed to 0, surfaced by
      `loader/test-debug.html` fishing. Four root causes, all in the
      type-slot dispatch layer:
      *(1)* `src/wasthon.h` reuses slot IDs across protocols —
      `Py_sq_length=29==Py_nb_multiply`, `Py_sq_item=32==Py_nb_positive`,
      `Py_mp_subscript=27==Py_nb_invert(fallback)`. The dispatch table
      treated 27/29/32 as their `nb_*` meanings unconditionally, so
      sequence types saw `__len__` etc. silently unwired. Disambiguates
      by presence of unambiguous markers (`Py_sq_ass_item=39` or
      `Py_sq_contains=41`); when set, patches the table to treat 27/29/32
      as `mp_subscript`/`sq_length`/`sq_item`.
      *(2)* When both `mp_subscript` and `sq_item` are present (array
      defines both), CPython's `PyObject_GetItem` prefers `mp_subscript`
      because it handles slices and non-int keys natively. Post-loop
      fixup re-binds `cls.__getitem__` to `mp_subscript` so `arr[1:4]`
      and `arr[-1]` work (otherwise `sq_item`'s int-only dispatch wins
      via numerical key ordering in the slot loop).
      *(3)* `PySlice_Check` checked `obj.__class__ === _b_.slice`, but
      slice instances in Brython 3.14 mark their type via `ob_type`,
      not `__class__` (`_b_.slice` is a `PyTypeObject` mirror with
      `tp_name`/`tp_basicsize`). The bridge had been reading the
      wrong field since the check was written — accept both shapes.
      *(4)* `PyObject_RichCompareBool` called `$B.$eq(a, b)` —
      a function that doesn't exist in Brython 3.14 (the actual API is
      `$B.rich_comp(op, x, y)` with op as a dunder-name string). The
      bridge had simply written the wrong symbol name. Rewires all 6
      ops (`<`/`<=`/`==`/`!=`/`>`/`>=`) through `rich_comp` so
      `array_contains`, `list.remove`, dict-key lookup, etc. work.
      Also adds a new dispatch shape `'bi'` (binary returning int) for
      `sq_contains`, which previously used the binary-returns-PyObject
      shape `'b'` and silently turned `99 in arr` into truthy via the
      `resH===0 → NotImplemented` branch.

- [x] `$kw` Brython-dict entries — completes the two prior `**kw` /
      `tp_init` fixes. Per Brython `ast_to_js.js` (and Pierre / pmp-p):
      `$kw` is `[plainJS, dict1, dict2, ...]` where element 0 is a plain
      JS object holding explicit `name=value` pairs and elements 1+ are
      **real Brython dicts** (one per `**d` expansion). Both prior fixes
      enumerated with `Object.keys` / `for...in` + `hasOwnProperty`,
      which only sees plain own properties — Brython dicts store entries
      under Symbol keys in hash storage, so every key in a `**d` element
      was silently dropped. So `Context(**{'prec': 33})` returned a
      default-prec context, and `blake2b(b'x', **opts)` ignored
      `digest_size`. Centralizes the walk in a new
      `WasthonRT.flattenKwArray(src)`: per-element type dispatch —
      Brython dict → `.items()` (same canonical pattern as
      `PyDict_Next` snapshotting); plain JS object → `Object.keys`.
      Used from both the `cls.tp_init` wrapper and
      `$__wasthon_make_trampoline`. Tests in `loader/test-debug.html`
      lock both code paths (`Context(**d)`, mixed
      `Context(name=value, **d)`, `blake2b(**opts)`).

- [x] Trampoline `**kw` fix — calling a C function with `f(*args, **kw)`
      from Python (e.g. `re._compiler.compile` doing
      `_sre.compile(*args, **kw)`) raised `TypeError: got an unexpected
      keyword argument '0'`. Brython passes such calls a marker
      `{$kw: [{}, {}]}` where `$kw` is an **Array of two dicts**
      (`[forced_positional_kw, kw_expansion]`), not a plain dict. The
      trampoline treated the Array itself as the kwargs object, so
      `Object.keys` returned the numeric indices `"0"`/`"1"` and they
      leaked into the C call as bogus kwarg names. Fix merges the two
      dicts. Transversal — benefits every C function taking `*args`/
      `**kw` or keyword args.

- [x] `tp_init` kwarg threading fix — `_decimal.Context(prec=42)` raised
      `TypeError: an integer is required` and never reached
      `context_setattrs`. The `cls.tp_init` wrapper only detected the
      bridge's own *outbound* `{$nat:'kw',$kw:obj}` shape (constructed
      in `PyObject_VectorcallDict`); Brython's actual *inbound* form
      from a call site like `Context(prec=42)` is `{$kw:[{name:value,
      ...}]}` (Array of maps, no `$nat` — `ast_to_js.js` codegen). The
      wrapper missed that entirely, so `kw` stayed `null`,
      the `$kw` marker leaked as the first positional, and
      `PyArg_ParseTupleAndKeywords` coerced it as the `prec` slot. Fix:
      widen detection to `(.$kw !== undefined || .$nat === 'kw')`,
      flatten the `$kw` Array into `[name, value]` pairs, and build a
      real Brython dict with `$B.empty_dict()` + `dict.$setitem` (same
      primitives `PyDict_SetItem` uses) so PyArg's `dict.get`/`$getitem`
      lookups land in real hash storage. Found by instrumenting `tp_init`
      and `PyArg_ParseTupleAndKeywords` with `console.log` — one cycle
      showed the defect was purely in extraction, after three earlier
      guess-driven attempts had blindly rewritten dict construction.
      Transversal: benefits any C type whose `tp_init` reads kwargs via
      `PyArg_ParseTupleAndKeywords`.

- [x] Writable-bytes refactor: `PyBytes_FromStringAndSize(NULL, n)` now
      backs the bytes object directly with a malloc'd linear-memory
      buffer, so `PyBytes_AsString` returns its pointer without a second
      malloc+copy pass. Net: one fewer O(n) pass on the output path
      shared by all decompressors (`_zlib`/`_bz2`/`_lzma`/`_zstd`) and
      bytes-producing modules. Measured roughly doubled decompress
      throughput on `_lzma` and `_zstd` (e.g. 100 KB text: _lzma 3.0 →
      5.74 MB/s, _zstd 2.4 → 5.43 MB/s; _zstd 100 KB compress 5.1 →
      10.85 MB/s).

- [x] Real `PyUnicode_FromFormat` (was a stub returning the format string
      literal). Implements emcc's `va_list` ABI for variadic args: reads
      sequentially from a pointer into linear memory with proper 4/8-byte
      alignment. Supports `%s`/`%d`/`%i`/`%u`/`%x`/`%X` (with `l`/`ll`/`z`
      length modifiers), `%c`, `%p`, `%R` (calls repr), `%S` (calls str),
      `%U`/`%V` (Unicode object), `%%`, plus flags (`-`, `0`), width and
      precision (including `%.*s` with precision-from-int). 9 modules
      benefit immediately: their `__repr__` now substitutes values
      instead of emitting `array.array('%c', %R)`-style literals.

- [x] Slot ID collision fix: `Py_nb_multiply` (29) and `Py_sq_length` were
      both registered under slot 29 in the dispatch table. JS object literal
      semantics meant the second one silently won, so `nb_multiply` was
      never installed on any module's class. Effect: `Decimal('1.1') *
      Decimal('2.2')` raised `TypeError: unsupported operand type(s) for *`
      while `+` and `**` worked. Fix: use the actual slot IDs from
      `Include/typeslots.h` (`sq_length` is 45, `sq_item` is 44, not 29/32).
      Latent silent bug since project start, surfaced by a bench-decimal
      re-read during the polish pass.

- [x] `unicodedata.numeric` / `.digit` / `.decimal` fix. Previously the
      `Py_UNICODE_TO{NUMERIC,DIGIT,DECIMAL}` macros were JS stubs using
      `parseFloat(String.fromCodePoint(ch))`, which only handled ASCII
      digits. Calls on Unicode fractions (½ → 0.5), CJK numerals
      (一 → 1), Roman numerals, circled digits, or non-ASCII digit
      scripts (Arabic, Devanagari, …) raised `ValueError`. Fix: compile
      CPython's `Objects/unicodectype.c` (driven by the generated
      `unicodetype_db.h` table) alongside `unicodedata.c` and redirect
      the macros to the real `_PyUnicode_To{Numeric,Digit,DecimalDigit}`
      symbols. Reusable pattern: when a JS stub approximates a CPython
      lookup, prefer linking the real CPython source over guessing.
- [x] 2-D `.view(<ndarray subclass>)` — "Cannot set the NumPy array 'base'
      dependency more than once". A Brython subclass of a C type reaches
      `tp_alloc` through an `ensureTypeStruct` handle whose `rt.types`
      entry has no `basicsize`, so `wasthon_object_gc_new` allocated
      `_malloc(undefined)` — a minimal ~16-byte chunk instead of the
      44-byte `PyArrayObject_fields`. numpy's very next malloc (the
      `npy_alloc_cache_dim` dims/strides block) then landed INSIDE the
      array struct: for a 2-D view `dims[1]` overwrote `base` (offset
      20) — the long-mysterious `0x2` was never a leaked handle, it was
      the second dimension of a (2,2) array. 1-D views only survived
      because the 8-byte overlap happened to cover the dims/strides
      fields themselves. Fix: `wasthon_object_gc_new`/`_var` inherit
      `tp_basicsize` from the first C ancestor in the MRO (CPython
      subtyping semantics), resolved once into the registry entry.
      Type identity untouched (the scoped decimal subtype-struct path
      is unaffected). test_defchararray 12→60 passed.
- [x] `np.str_('x')` / `np.bytes_(b'x')` constructors — "null function or
      function signature mismatch". numpy's unicode/bytes scalar
      constructors delegate to their superclass first, exactly like
      `double_arrtype_new` does for float: `unicode_arrtype_new` calls
      `PyUnicode_Type.tp_new(subtype, args, kw)` — and that slot (and
      `PyBytes_Type.tp_new`) was NULL, so every scalar construction, and
      everything that builds one (the whole `np.strings.upper`/`lower`
      case-mapping family, `np.char` methods, `chararray.upper()`),
      trapped on an indirect call to null. Fix: wire
      `wasthon_builtin_unicode_tp_new` / `_bytes_tp_new` (build a Brython
      str/bytes from the args), same accepted tradeoff as float64 —
      plain, correct-valued scalars; perfect scalar identity remains the
      scalar subsystem's work. numpy dashboard 1667→1678, the
      np.strings case-mapping API works end to end on U dtypes.
- [x] `np.bytes_` scalars from S arrays were empty shells — and their
      construction scribbled the heap. Two layers, one commit:
      (1) `PyType_Ready`: a static type whose `tp_base` is a bound builtin
      struct (`&PyBytes_Type`, numpy's scalar types) inherited a hollow
      class materialized from the struct's `tp_name` instead of the real
      Brython builtin — `isinstance(scalar, bytes)` was False and instance
      lookup never reached `bytes.upper` & co. Resolve the base through
      `builtinClassForStruct` (the reverse map `PyObject_GetAttr` already
      uses). (2) `PyBytes_AsString` on a C-allocated var-object shell (no
      `.source`) read `length` of the shell itself → `_malloc(NaN)`:
      numpy's `PyArray_Scalar` then memcpy'd the payload into a ~0-byte
      chunk — heap scribble, payload lost, every scalar came out as
      `np.bytes_(b'')`. Hand C a real `ob_size`-byte buffer and
      materialize `.source` lazily on first Python access (C's memcpy has
      long run by then). `len()`/`upper()`/`bytes()`/`==` work on S-array
      elements, `np.strings` case-mapping works on S dtypes,
      `issubclass(np.bytes_, bytes)` / `(np.str_, str)` are True.
