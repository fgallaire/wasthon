# wasthonp — build notes & dependency audit

## Toolchain bring-up (day 0)

The parser needs CPython's **real** internal headers + a proper `pyconfig.h`
(the wasthon shim headers are for the opaque-handle extension-module API and do
NOT describe the concrete `mod_ty` / `Parser` / `PyArena` struct layouts the
parser requires).

Steps that worked:

1. **Host CPython 3.14** (`./host-build`) — plain native `./configure && make`.
   Needed only as `--with-build-python` for the cross-configure (configure
   refuses cross-compilation without a build-python of the *exact* 3.14 version;
   the system python was 3.12).
2. **Cross `pyconfig.h`** (`./cpy-build/pyconfig.h`, 330 defines) via:
   ```
   CONFIG_SITE=<cpython>/Platforms/emscripten/config.site-wasm32-emscripten \
   emconfigure <cpython>/configure \
     --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu \
     --disable-wasm-dynamic-linking --disable-ipv6 \
     --with-build-python=./host-build/python
   ```
   The `config.site-wasm32-emscripten` is essential — it sets the `ac_cv_*`
   cross cache vars (dev/ptmx, getaddrinfo, posix_spawn, …) configure can't
   probe when cross-compiling.

## Compile audit ✅

**All 15 parser translation units compile cleanly** with emcc against the real
internal headers (`Parser/lexer/*`, `Parser/tokenizer/*`, `pegen.c`, `parser.c`,
`pegen_errors.c`, `string_parser.c`, `action_helpers.c`, `token.c`,
`Python/Python-ast.c`, `asdl.c`, `pyarena.c`). No header/config gaps. Good sign:
the frontend is self-contained at the source level.

## Link audit — the key finding

`wasm-ld` caps at 20 errors, so the full picture comes from `llvm-nm` over all
`.o` files (`build/missing.txt`):

- **385** distinct undefined references; **1545** symbols provided by our own
  parser objects; **179** genuinely missing.
- ~14 are libc/emscripten builtins (`memchr`, `strlen`, `stdin`, …) — supplied
  by the emscripten sysroot at the final link, not a real gap.
- **165 are Py-level symbols.**

Cross-referencing those 165 against the **wasthon bridge** (`../wasthon/src/
wasthon.js` + `wasthon.c` + `wasthon.h`):

| | count |
|---|---|
| Py-level symbols the parser needs | **165** |
| **already implemented by the wasthon bridge** | **109 (66%)** |
| **gap wasthonp must add** | **56** |

### What this means (architecture)

The audit **revives Strategy B**: rather than compiling `Objects/*.c` (the heavy,
Pyodide-ward path), wasthonp can **link the parser against the existing wasthon
bridge** for the object layer (str/bytes/long/float/list/tuple/dict/set/type,
PyErr_*, PyMem_*, …). Only **56 symbols** remain, and they're tractable:

- **Singletons / type objects (~10)** — `_Py_NoneStruct`, `_Py_TrueStruct`,
  `_Py_FalseStruct`, `_Py_EllipsisObject`, `PyBaseObject_Type`, `PyComplex_Type`,
  `_PyUnion_Type`, `Py_GenericAliasType`. Mostly thin aliases to bridge values.
- **Minimal runtime / recursion / state (~12)** — `_PyRuntime`, `_Py_tss_tstate`,
  `PyThreadState_Get`, `Py_Initialize/Finalize`, `Py_EnterRecursiveCall` &c.,
  `_PyOnceFlag_CallOnceSlow`, `_Py_FatalErrorFunc`. Stubbable: the parser needs a
  thread state mainly to *set exceptions* and a recursion counter. A fake
  thread-state + counters is enough — this is the "how much runtime do we really
  need" question, and the answer is "~a dozen stubs", not Py_Initialize proper.
- **Unicode internals (~9)** — `_PyUnicode_ScanIdentifier`, `_Py_ctype_table`,
  `_Py_ctype_tolower`, `_PyUnicode_IsWhitespace`, `_PyUnicode_IsPrintable`,
  `_PyUnicode_DecodeUnicodeEscapeInternal2`, `PyUnicodeWriter_FromFormatV`,
  `_PyUnicode_InternImmortal`. The genuinely parser-specific Unicode bits
  (identifier classification, escape decoding). Pull selectively from
  `Objects/unicodectype.c` / `unicodeobject.c`, or implement.
- **Error helpers + exception types (~12)** — `PyErr_Fetch/Restore`,
  `PyErr_GivenExceptionMatches`, `PyErr_Warn*`, `PyExc_SyntaxError`,
  `PyExc_IndentationError`, `PyExc_TabError`, `_PyExc_IncompleteInputError`.
  Thin wrappers over the bridge's error machinery + map to Brython exceptions.
- **Bytes / seq / set bits (~8)** — `PyBytes_AsStringAndSize`, `PyBytes_Concat`,
  `_PyBytes_DecodeEscape2`, `PySequence_Contains`, `PySet_Discard/Size/
  _NextEntry`. Bridge additions.
- **Misc (~5)** — `_PyTokenizer_FromFile` (no files in browser → stub),
  `PyOS_strtol/strtoul` (libc wrappers), `Py_GenericAlias`.

## Milestone 2 attempt — the ABI wall, then the monolith wall

Two hard findings, in order.

### (1) Strategy B (reuse the bridge) is blocked by ABI

`../wasthon/src/wasthon.h` defines `struct _object { intptr_t ob_refcnt; }` —
**one field, no `ob_type`** (`PyObject_HEAD` is 4 bytes, `Py_TYPE` is a function
call, not a struct read). Real CPython's `PyObject` head is `{ob_refcnt;
ob_type}` = 8 bytes. The parser is compiled with **real** CPython headers, so it
inlines real struct access — `op->ob_type` (offset 4), `PyUnicode_GET_LENGTH`,
`Py_SIZE`, `ob_refcnt` arithmetic. The bridge hands back opaque JS handles with a
different (smaller, type-less) layout. So the 109 "bridge-covered" symbols match
by **name only**; the moment the parser pokes at the objects they return, it
reads garbage. Direct linking against the bridge cannot work.

### (2) Strategy A (compile the real object layer) explodes toward full libpython

All 45 `Objects/*.c` **compile** cleanly. But re-running the symbol audit with
them added makes the missing set **grow 165 → 197**, now demanding the rest of
the core:

- **the eval loop** — `_PyEval_EvalFrameDefault`, `_PyEval_Vector`, `PyEval_*`
  (`typeobject.c` routes `__call__`/vectorcall through ceval),
- **import + lifecycle** — `PyImport_*`, `Py_Initialize`, `Py_Finalize`,
- **codecs** — `PyCodec_*`, `_PyCodec_*` (unicode decode),
- **GC** — `PyObject_GC_*`, **threading/runtime** — `PyGILState_*`,
  `PyThreadState_*`, `_PyRuntime`, **contextvars** — `_PyHamt_*`, `PyContext*`,
- **arg parsing** — `PyArg_Parse*`, **float repr** — `_Py_dg_dtoa/strtod`.

CPython's object layer is **not separable** from the runtime: the parser builds
real PyObjects for literals/identifiers → real objects need the real type
machinery → the type machinery needs ceval + GC + import + codecs + threading.
"A little bit of CPython" doesn't exist. Strategy A converges on **≈ full
libpython core (incl. the eval loop)** = the Pyodide-scale outcome the project
set out to avoid.

### Conclusion → Strategy C (the only path that stays small)

The object layer gets pulled in **only because the parser materialises PyObjects
for constants and identifiers** (`Constant.value`, `Name.id`, the string/number
parsers in `string_parser.c` / `action_helpers.c`). The way out is to **stop the
parser from creating PyObjects**: fork the frontend so the AST carries literals
and identifiers as **plain data** (UTF-8 byte ranges / offsets into the source),
not `PyObject*`. Then:
- no `PyUnicode_*` / `PyLong_*` / object layer needed → no runtime → stays small;
- the "POD AST" serialises directly to one buffer (exactly the perf-friendly
  hand-off we wanted); the **JS side** creates the actual str/int objects as
  Brython values when rebuilding the AST.

This is real, invasive work (patch `Python-ast.c` node structs + the action
helpers + `string_parser.c` to a POD representation), but it's the **only**
architecture that delivers a genuinely small "parser-only" WASM. It also happens
to be the cleanest possible boundary design.

## Strategy-C experiment (POD stubs) — results

To test "can the parser run without the object layer?", I linked the parser-only
objects against **POD stubs** (`shims/pod_stubs.c` generic + `shims/pod_real.c`
real-signature) for all 165 Py-level symbols — NO `Objects/*.c`, NO ceval, NO
runtime. Iterated by runtime trap (`./exp.sh`).

**Headline: the parser links to a 102 KB WASM** with only stubs (vs Pyodide's
~10 MB). The frontend is **structurally separable** from the object layer — the
core size thesis of Strategy C holds.

At runtime, fixing one stub per round, the parser ran **deep into a real parse**:
```
_PyArena_New → _PyPegen_run_parser → _PyPegen_parse → expressions_rule
  → _PyPegen_fill_token → _PyTokenizer_Get → tok_get_normal_mode
```
The **runtime-critical surface for a tiny expression is small** and exactly the
predicted categories:
- memory (`PyMem_*` → libc malloc),
- the arena's object-tracking list (`PyList_New/Append/Sort`),
- recursion guards (`_Py_ReachedRecursionLimitWithMargin`, `Py_*RecursiveCall`),
- **Unicode character classification** (`_PyUnicode_IsPrintable/IsWhitespace/
  IsXidStart/IsXidContinue/IsLinebreak`) — the tokenizer's real need,
- string comparison (`PyUnicode_CompareWithASCIIString`, …),
- error formatting (`PyUnicode_FromFormatV`, `PyErr_*`).

### Two concrete walls hit — and they're the real verdict

1. **The grammar rejected the fake input** (took the `_Pypegen_set_syntax_error`
   path) because semantic checks **inspect string content** (soft-keyword / name
   equality). Opaque fake objects make all comparisons misfire. → identifiers/
   literals must be **real comparable POD** (byte ranges), not opaque blobs.

2. **`PyUnicode_GET_LENGTH` asserted `PyUnicode_Check(op)`** — a struct-layout
   **macro** the parser inlines (here while building the error message) reads the
   object's type/length directly. POD fake objects can't satisfy it. This is the
   ABI wall made concrete: **you cannot just stub the object functions** — the
   parser pokes at object internals via macros in several paths.

### Verdict

Strategy C is the right architecture **and** the experiment pins down precisely
what it requires: not a stubbing job, but **source surgery on the frontend** —
patch `Python-ast.c` (the `Constant.value` / `identifier` fields), the pegen
action helpers, and `string_parser.c` so literals/identifiers are carried as
**POD byte-ranges**, and fix the handful of inspection sites (string compares,
length reads) to operate on that POD. Bounded and well-located work, and the
payoff is real: a **~100 KB** parser-only WASM, no object layer, no eval loop.

Reproduce: `./exp.sh` (rebuilds stubs + parser, links `build/expdbg.js`, runs).

### Strategy-C experiment — milestone 2 REACHED ✅

Iterating the shims (one runtime trap per round) the parser went from "links" to
**parses real expressions to a real AST**, all without the object layer:

```
parse(x)         -> kind=3   parse(1)        -> kind=3
parse(3.14)      -> kind=3   parse(1+2*3)    -> kind=3
parse(f(a, b))   -> kind=3   parse([1, 2, 3])-> kind=3
```
(`kind==3` = `Expression_kind`; `mod_ty` non-NULL.) **234 KB** `wasthonp.wasm`
at -O2 (`node build/wasthonp.js`), vs Pyodide's ~10 MB.

What it took (the real runtime-critical surface, ~40 functions in
`shims/pod_real.c`):
- `PyMem_*` → libc malloc; the arena's tracking list (`PyList_New/Append/Sort`)
  as harmless stubs.
- **ABI-compatible minimal str/bytes**: built from the genuine `PyASCIIObject` /
  `PyBytesObject` structs (so `PyUnicode_Check` / `PyUnicode_GET_LENGTH` /
  `PyBytes_AsString` read correct offsets), with a static `str`/`bytes`
  `PyTypeObject` carrying the right `Py_TPFLAGS_*_SUBCLASS`, refcount pinned
  high so DECREF never deallocs. Comparisons (`PyUnicode_CompareWithASCIIString`,
  …) operate on the real bytes — required, the grammar inspects identifier text.
- Opaque pinned leaves for int/float/complex/tuple/list (the parser only stores
  them).
- `PyOS_strtol/strtoul/string_to_double` → libc; recursion guards → 0.
- **`Python/pyctype.c`** (8 KB, self-contained) for the real `_Py_ctype_table`
  — the bug that took longest: a zeroed ctype table made `Py_ISDIGIT('1')` false,
  so the tokenizer classified every number as an `OP` token (type 55) and the
  grammar rejected all numeric literals.

### What this proves (and the honest gap to a real wasthonp)

Proven: **the CPython parser is separable from the interpreter** — it produces a
real `mod_ty` for real source in a ~234 KB WASM, no eval/object-layer/runtime.
The "you can't take a little bit of CPython" claim is **false for the frontend**,
once you supply the small classification tables + minimal str/bytes.

Still hybrid, not the final design: numeric leaves are opaque (fine to store,
but their *value* isn't real). A production wasthonp would either (a) keep these
minimal compat str/bytes and **serialize the AST** reading their bytes directly
(re-parsing numbers in JS from the source span), or (b) finish the POD-AST
surgery. Either way the architecture question is now answered: **small is
achievable.** Next: serialize `mod_ty` → buffer → rebuild Brython AST in JS
(milestone 3), and bench parse-only vs Brython's JS parser.

## Honest caveat (next validation)

Symbol coverage is necessary but **not sufficient**. "Provided by the bridge"
means the *name* exists; the open ABI question is whether the parser's use of
those objects is bridge-compatible:
- the bridge represents `PyObject*` as an opaque handle, not a C struct — any
  parser code using **struct-layout macros** (`PyUnicode_GET_LENGTH`,
  `Py_SIZE`, direct `ob_refcnt`) on those objects would read garbage;
- `Py_INCREF/DECREF` patterns must agree with the bridge's refcount model.

That's exactly milestone 2: link against the bridge, implement the 56 gap
shims, and parse one expression. If the ABI holds, wasthonp is a **weekend-scale**
project, not a Pyodide-scale one.

## Reproduce

```
cd cpy-build && CONFIG_SITE=.../config.site-wasm32-emscripten \
  emconfigure .../configure --host=wasm32-unknown-emscripten \
  --build=x86_64-pc-linux-gnu --disable-wasm-dynamic-linking --disable-ipv6 \
  --with-build-python=../host-build/python
cd .. && ./build.sh         # compiles TUs, link surfaces the gap
# full gap list: build/missing.txt ; bridge-covered: build/covered.txt ; gap: build/gap.txt
```
