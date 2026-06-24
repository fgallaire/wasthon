# wasthonp — the wasthon parser

**What it is:** CPython's real frontend — the tokenizer + PEG parser → AST —
compiled to WebAssembly (~300 KB) and used inside Brython as a **drop-in
replacement for Brython's hand-written JS parser**. Unlike Pyodide, it does
**not** compile the interpreter (no eval loop, no bytecode compiler, no stdlib):
just the parser. It is the "frontend" sibling of `../wasthon` (the "backend":
CPython C extension modules → WASM + a JS bridge).

It plugs in by monkeypatching `$B._PyPegen.run_parser`; the whole glue is one
file (`wasthonp.js`). Proposed as-is for Brython to adopt — the integration is
Pierre's call, this repo never modifies Brython itself.

---

## Why wasthonp beats Brython's parser (all measured)

wasthonp **is** CPython's parser, so by construction it can't lag the grammar or
invent quirks. Concretely, against the vendored Brython:

### 1. Correctness — exact CPython 3.14 grammar
- **Full CPython 3.14 stdlib round-trip** (`node validate2.js`, 1851 files):
  **1830 parse + build + codegen with 0 wasthonp crashes**; **1147 byte-identical**
  to Brython's own codegen, the rest cosmetic (position/pretty-print) diffs.
- **Files Brython's hand-written parser crashes on, wasthonp handles** (`node
  superiority.js`): t-strings with the debug specifier `t"{x=}"`, some f-string
  and unicode-identifier edges — 5 stdlib files where Brython's parser throws an
  internal error and wasthonp parses cleanly. Brython rejecting valid 3.14 code
  that wasthonp accepts: the reverse never happens.

### 2. Error fidelity — faithful `SyntaxError` (v2)
wasthonp reports CPython's **exact** error message and position, not an
approximation. On CPython's own error corpus (`test_syntax.py`, 71 cases,
regex-matched like CPython's `_check_error`):

| | wasthonp | Brython |
|---|---:|---:|
| message matches CPython's expected pattern | **52 / 71** | 45 / 71 |
| wins where the other is wrong | **7** | 0 |
| parse-stage errors missed | **0** | — |

The 19 cases both "miss" are post-parse (codegen-stage) errors — outside a
parser's job. On the parse errors wasthonp catches, message fidelity is 100%,
including tokenizer errors (`invalid non-printable character U+0017`,
`unterminated triple-quoted string literal`) and the helpful 3.x hints
(`'(' was never closed`, `Maybe you meant '==' instead of '='?`). Position is at
parity with Brython.

### 3. Performance — ~3.5–6× faster parse, ~1.5× end-to-end
Two honest numbers, measured (`node bench.js`, `node breakdown.js`):
- **Parse-only** — the parser itself, vs Brython's JS parser (WASM boundary cost
  included): **~3.5–5× on typical code, up to ~6× on numeric-heavy code**
  (`_pydecimal.py` 5.9×, `argparse.py` 4.5×, `typing.py` 3.3×), ~3× in-browser.
- **End-to-end** — source → JS (parse + serialize + rebuild `$B.ast` + codegen):
  **~1.5×** (`_pydecimal.py` 55 vs 89 ms = 1.6×; `typing.py` 1.5×). The full
  compile is gated by Brython's **code generator** (`js_from_root` + symtable,
  ~37% of the time) and the `$B.ast` node construction — both shared with the
  native path — so the parser's large lead dilutes across the rest of the
  pipeline. (A binary AST hand-off was tried to shave the serialize/`JSON.parse`
  step; measured as a wash — V8's `JSON.parse` is not the bottleneck, the node
  construction and Brython's codegen are.)

### 4. Size — a ~300 KB drop-in (vs ~10 MB Pyodide)
The parser is structurally separable from the interpreter: ~300 KB of WASM, no
object layer, no eval loop. Because the codegen stays Brython's, adopting
wasthonp could let Brython **retire its hand-written parser** (`gen_parse.js` &
co, ~40% of the engine's JS source, ~550 KB off `brython.js`) — an argument for
the integration, on Brython's side.

---

## Architecture (Strategy C)

The parser is compiled against CPython's **real** internal headers — it needs the
concrete `mod_ty`, `Parser`, tokenizer-state and `_ast` struct layouts. Two dead
ends were ruled out first: reusing the wasthon bridge for objects (Strategy B)
breaks on ABI — the bridge's `PyObject` is an opaque handle, the parser inlines
real struct macros; and compiling the real object layer (Strategy A) pulls in the
eval loop, GC, import and codecs — i.e. ~all of libpython. Full write-up in
`BUILD_NOTES.md`.

**Strategy C** keeps it small by never materializing real Python objects:
- minimal **ABI-correct** `str`/`bytes` (`shims/pod_real.c`) so the parser's
  macros read the right offsets, opaque pinned leaves for numbers, and CPython's
  `Python/pyctype.c` classification tables;
- literals carried as **source spans**; the **JS side** rebuilds the real Brython
  AST objects (`wasthonp.js`, a single generic builder driven by `$B.ast_classes`);
- `shims/ast_dump.c` serializes the `mod_ty` → JSON, crossing the JS boundary once.

**Errors (v2)** use the same trick: instead of building a `SyntaxError` object in
C (which would pull in the exception/type/ceval machinery), `wasm-ld --wrap`
intercepts CPython's error funnel (`_PyPegen_raise_error_known_location`) and the
two tokenizer entry points; the message (formatted verbatim by CPython) + position
are captured into a struct, serialized as JSON, and `wasthonp.js` raises a faithful
Brython `SyntaxError` via `$B.raise_error_known_location`. CPython's exact wording
comes for free — it's compiled into the parser.

---

## Status — proof of concept complete

All milestones done; wasthonp is a working drop-in (parse → `$B.ast` → Brython
codegen → real `exec`), validated on the full stdlib, with faithful errors, in
node and the browser.

1. [x] **Audit** — parser TUs compile against CPython's real headers.
2. [x] **Parse → `mod_ty`** — real AST, no object layer / eval / runtime.
3. [x] **Serialize** — `mod_ty` → JSON (`shims/ast_dump.c`).
4. [x] **JS rebuild → codegen** — full 3.14 grammar (def/class/async/match/try/
       f-strings/PEP 695…), codegen logic-identical to Brython (`node m3b_stmt.js`).
5. [x] **Bench** — 3.5–6× faster parse-only (`node bench.js`).
6. [x] **Execute end-to-end** — 7/7 programs run correctly (`node m3c_exec.js`).
7. [x] **Browser** — `loader/wasthonp.html` (run real Python on wasthonp + in-page
       bench); also standalone `web/index.html`.
8. [x] **Faithful errors (v2)** — exact CPython `SyntaxError` message+position
       (corpus 52/71 vs Brython 45/71). See "Error fidelity" above.
9. [ ] **Product polish** — ES6-module packaging + auto-hook of `text/python`
       tags; compact binary AST serialization; non-ASCII caret offset; faithful
       `ast.parse`.

---

## Build & run

```sh
./build.sh            # → build/wasthonp_mod.{js,wasm}  (~300 KB)
```
Reuses the wasthon checkout's emsdk + CPython 3.14 source under `../external`;
the cross `pyconfig.h` is committed (`cpy-build/`). Then:

```sh
node bench.js         # parse-speed vs Brython
node validate2.js     # full-stdlib round-trip
node superiority.js   # files Brython's parser chokes on
node m3c_exec.js      # parse → $B.ast → exec, end to end
```
Browser demo: serve the repo root and open `/loader/wasthonp.html`.
