# Bug report — Brython parser: t-string debug specifier `t"{x=}"` fails to compile

## Summary

Brython's parser/AST builder cannot compile a **t-string** (PEP 750) that uses the
**debug `=` specifier**, e.g. `t"{x=}"`. The equivalent **f-string** form
`f"{x=}"` compiles correctly. The failure happens at parse/compile time, before
any code runs, so a single such literal anywhere in a module breaks compilation
of the whole module.

This is what makes CPython's `Lib/test/test_tstring.py` fail to compile under
Brython.

## Environment

- **Brython:** `__BRYTHON__.implementation = [3, 14, 1, 'dev', 0]` (3.14.1.dev)
- **File:** `brython.js` (the bundled build)
- **Reproduced in:** Node (Brython loaded directly). The same code path is taken
  in the browser.

## Minimal reproduction

```python
x = 1
y = t"{x=}"      # ← fails to compile
```

Compare with the f-string equivalent, which works:

```python
x = 1
y = f"{x=}"      # ← compiles fine
```

Reproduction via the parser entry point:

```js
const $B = require(".../brython.js");
const run = $B._PyPegen.run_parser;

function parses(src){
  try { const p = new $B.Parser(src, "<b>", "file"); run.call($B._PyPegen, p); return "OK"; }
  catch(e){ return "FAIL: " + ((e && e.message) || String(e)); }
}

console.log("f-string {x=}", parses('x=1\ny=f"{x=}"'));  // f-string {x=} OK
console.log("t-string {x=}", parses('x=1\ny=t"{x=}"'));  // t-string {x=} FAIL: PyErr_Format is not defined
```

Observed output:

```
f-string {x=}  OK
t-string {x=}  FAIL: PyErr_Format is not defined
```

### Variant matrix (only the debug `=` t-string fails)

| Source            | Brython parser |
|-------------------|----------------|
| `f"{x=}"`         | ✅ compiles    |
| `t"a {x}"`        | ✅ compiles    |
| `t"{x:>10}"`      | ✅ compiles    |
| `t"{x!r}"`        | ✅ compiles    |
| `t"""a {x} b"""`  | ✅ compiles    |
| **`t"{x=}"`**     | ❌ **fails**   |

So the gap is specific to the **debug `=` specifier inside a t-string**; ordinary
t-strings, format specs, conversions and nesting are all fine.

## Root cause

Two layered problems in `brython.js`:

1. **Wrong AST shape for the t-string debug case.** In
   `_get_resized_exprs(p, a, raw_expressions, b, string_kind)`, the debug-text
   reconstruction loop expects each interpolation node to expand to exactly two
   `values`:

   ```js
   for (var i = 0; i < n_items; i++) {
     var item = raw_expressions[i];
     if (item instanceof $B.ast.JoinedStr) {
       var values = item.values;
       if (values.length != 2) {
         PyErr_Format(PyExc_SystemError, string_kind == TSTRING
           ? "unexpected TemplateStr node without debug data in t-string at line %d"
           : "unexpected JoinedStr node without debug data in f-string at line %d",
           item.lineno);
         return NULL;
       }
       ...
   ```

   For `t"{x=}"` the corresponding `TemplateStr` node does **not** have
   `values.length == 2`, so this "should never happen" internal-error branch is
   taken. The f-string path produces the expected 2-value shape, which is why
   `f"{x=}"` works and `t"{x=}"` does not.

2. **`PyErr_Format` is not in scope at that call site**, so instead of raising the
   intended `SystemError`, the engine throws a JS `ReferenceError:
   PyErr_Format is not defined`. `PyErr_Format` is declared as a top-level
   `function PyErr_Format(exc_type, message, arg)` but is not reachable from
   inside `_get_resized_exprs`. This masks the real error and turns a (would-be)
   Python `SystemError` into an uncaught JS exception.

## Expected behavior

`t"{x=}"` should compile, producing a `TemplateStr` whose interpolation carries
the debug text `"x="` followed by the value of `x` (mirroring f-string `{x=}`
behavior, as specified by PEP 750 / PEP 501). At minimum, the
`values.length != 2` branch should not be reachable for valid debug t-strings,
and `PyErr_Format` should be in scope wherever it is called.

## Suggested fixes

- Handle the t-string (`TemplateStr`) node shape in `_get_resized_exprs` so the
  debug `=` reconstruction works for t-strings as it does for f-strings (the
  `values.length == 2` assumption does not hold for `TemplateStr`).
- Independently, ensure `PyErr_Format` (and `PyExc_SystemError`) are in scope at
  every call site, so internal errors surface as proper Python exceptions rather
  than `ReferenceError`s.

## How it was found

While validating **wasthonp** (CPython 3.14's real PEG parser compiled to WASM,
used as a drop-in for Brython's hand-written JS parser), every CPython 3.14
stdlib file was round-tripped through both parsers. wasthonp parses `t"{x=}"`
correctly (it is the unmodified CPython parser); Brython's parser is the only one
that fails on it, which is the sole concrete grammar gap found between the two on
the 3.14 stdlib.
