# wasthonp — the wasthon parser

**Goal:** compile *only* CPython's frontend (tokenizer + PEG parser → AST) to
WebAssembly and use it inside Brython as a drop-in replacement for Brython's
hand-written JS parser. Unlike Pyodide, we do **not** compile the interpreter
(no eval loop, no compiler-to-bytecode, no stdlib).

Sibling project to `../wasthon` (the "backend": CPython C extension modules
compiled to WASM + a JS bridge to Brython). wasthonp is the "frontend".

## Why

1. **Correctness**: CPython's parser is the reference — exact grammar (walrus,
   match, PEP 695, PEP 701 f-strings), exact `SyntaxError` messages/offsets, a
   faithful `ast` module. Brython's JS parser perennially lags and has bugs
   (e.g. the `_parser.getuntil` Tokenizer bug and `\N{}` handling seen in
   `../wasthon` test_re).
2. **Performance** (potential): the C tokenizer/PEG parser over a bump-pointer
   arena should beat Brython's allocation-heavy JS parser on the *parse* itself.
   The net end-to-end win depends entirely on how cheaply we hand the AST back
   to JS (see "the boundary" below).

## Architecture decision: Strategy A (real CPython subset)

The wasthon backend uses *shim* headers (`src/Python.h` → `wasthon.h`) and lets a
JS bridge implement an opaque PyObject-handle C-API. **That approach does NOT
work for the parser**: the tokenizer/pegen/parser code needs the *concrete*
internal struct layouts (`mod_ty`, `Parser`, tokenizer state, `PyArena`, the
`_ast` node structs) and many private `_Py*` functions. So wasthonp compiles
against CPython's **real** `Include/` + `Include/internal/` headers and links a
*minimal real subset* of CPython:

- `Parser/` — `lexer/*.c`, `tokenizer/*.c`, `pegen.c`, `parser.c` (generated),
  `pegen_errors.c`, `string_parser.c`, `action_helpers.c`, `token.c`
- `Python/` — `Python-ast.c` (AST node ctors), `pyarena.c`, `asdl.c`
- `Objects/` — the object types the parser actually touches when building
  constants/identifiers: unicode, long, float, complex, bytes (+ their deps).
  **This set is the open question the dependency audit answers.**

The seam into Brython is its AST: Brython already mirrors CPython's ASDL 1:1 in
`$B.ast_classes`. Two routes:
- (later) `PyAST_mod2obj(mod_ty)` → `_ast` objects, if we align `_ast` types
  with Brython's ast classes, **or**
- **(preferred for perf)** serialize the `mod_ty` to one compact buffer in WASM,
  cross the JS boundary **once**, and rebuild Brython AST node objects in a tight
  JS loop (string table for literals/identifiers — no per-node bridge calls).
  This is the only way to not give the parse-speed win back at the boundary.

## Status

🚧 Prototype, day 0 — **milestone 1 (audit) done**. All 15 parser translation
units **compile** to WASM against CPython's real internal headers. Link audit
(`build/missing.txt`): of **165 Py-level symbols** the parser needs, **109 (66%)
are already implemented by the wasthon bridge**; the **gap is 56**, all
categorizable (singletons, a ~dozen-stub minimal runtime, ~9 Unicode internals,
error helpers, a few bytes/set bits). → wasthonp can likely **reuse the bridge**
(Strategy B) instead of compiling `Objects/*.c`; plausibly weekend-scale, not
Pyodide-scale. Open question = ABI compatibility of bridge objects under the
parser's macros/refcounts (milestone 2). Full write-up: `BUILD_NOTES.md`.

## Milestones

1. [x] **Audit**: compile parser TUs; list undefined symbols. ✅ (56-symbol gap)
2. [x] **Parse to mod_ty**: ✅ **DONE.** Every test expression (`x`, `1`, `3.14`,
       `1+2*3`, `f(a, b)`, `[1, 2, 3]`) parses to a real Expression AST
       (`mod->kind == 3`) in a **234 KB** WASM (`build/wasthonp.wasm`) with NO
       object layer, NO eval loop, NO runtime — just the parser + `Python/
       pyctype.c` (8 KB char tables) + minimal POD/compat shims (`shims/`).
       Run: `node build/wasthonp.js`. The two earlier walls were resolved by
       Strategy C: a ~40-function real-signature shim layer (`shims/pod_real.c`)
       with ABI-compatible minimal str/bytes (compact `PyASCIIObject`/
       `PyBytesObject`, pinned refcount) and opaque pinned leaves for int/float/
       tuple/list. See BUILD_NOTES "Strategy-C experiment".
3. [x] **Serialize**: ✅ `shims/ast_dump.c` walks `mod_ty` → JSON, identifiers
       from the real minimal str, **literals from the source span**
       (col_offset..end_col_offset — the production hand-off design). Correct
       precedence/associativity proven: `1+2*3` → `BinOp(+,1,BinOp(*,2,3))`,
       `a.b.c` → nested Attribute, etc. `node build/wasthonp.js`. 240 KB WASM.
4. [x] **JS rebuild**: ✅ **DONE** (`m3b_stmt.js`). wasthonp dumps a whole module
       to JSON aligned with `$B.ast_classes`; a **single generic builder** (~15
       lines, driven by the ASDL field specs) rebuilds the `$B.ast` tree; Brython's
       `js_from_root` codegen compiles it to JS **logic-identical** to Brython's
       own parser+codegen. **5/5 real modules** pass — covering def/class/for/
       while/if/with/lambda/ternary/import/from/global/del/assert/augassign/
       comprehensions(list/set/dict/gen)/unpack/starred/slices/dict/compare.
       (Diffs only in per-compile UUID suffixes + Brython's own `__file__`
       inconsistency in comprehension frames.) Run: `node m3b_stmt.js`.
       wasthonp is a **drop-in** for Brython's parser, statements included.
       **FULL grammar (9/9)**: now also match/case + patterns, try/except/finally,
       async def/await/async-for/with, generators/yield, f-strings (JoinedStr/
       FormattedValue), type aliases + PEP 695 type params. Real stdlib files
       (`node realfile.js re/_parser.py`) parse+build+compile **99.6% identical**
       (11/2728 lines); residual diffs are only string-literal value encoding
       (exotic escapes `\a`/octal, implicit concatenation) — no grammar/structure
       gap. Found a Brython bug: wrong `match_case` lineno (uses the next case's).
5. [x] **Bench**: ✅ parse-only, wasthonp vs Brython's JS parser on a realistic
       module body (`node bench.js`): **wasthonp ~5.7–6× faster** (0.6 ms vs
       3.4 ms/parse), WASM boundary cost included. The perf thesis holds.
6. [x] **Execute end-to-end**: ✅ `node m3c_exec.js` — parse with wasthonp →
       `$B.ast` → **Brython's real `exec`** → read the result. **7/7 programs run
       correctly** (fib(10)=55, comprehensions, class+method, dict-comp, match,
       try/except+f-string, generators+closures+lambda). Inject the wasthonp AST
       via a code object `{ob_type:$B.code,_ast:{$js_ast},mode:'exec'}` to
       `_b_.exec` (root frame set with `$B.enter_frame`). "codegen identical" is
       now "**runs correctly**".
7. [x] **Browser integration**: ✅ `web/index.html` (headless-tested via
       `web_test.py`) loads Brython + the wasthonp `.wasm` and **monkeypatches
       `$B._PyPegen.run_parser` with wasthonp**, then runs a real Python script
       (fib, class, f-string, comprehension, match) → correct output in Chromium:
       `fib(15)=610`, `hello, wasthonp!`, etc. In-browser parse bench ~2.5× faster.
       The full PoC — "Brython, but with the exact CPython parser, in WASM" —
       runs in a browser.
8. [ ] **Polish/product**: exotic string-escape encoding; ES6-module packaging +
       auto-hook of `text/python` tags; compact binary AST serialization; a
       faithful `ast.parse`.

## Build

```
CPYTHON_SRC=../wasthon/external/Python-3.14.6 ./build.sh
```
Reuses the emsdk already installed under `../wasthon/external/emsdk`.
