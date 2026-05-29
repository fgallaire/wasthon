# Brython fixes (found while running CPython suites against wasthon)

Patches to **Brython itself**, surfaced by running CPython's `Lib/test/test_*.py`
against wasthon's C modules inside Brython. Each entry: symptom, root cause, the
diff against Brython **source**, and the measured test impact. To upstream to
github.com/brython-dev/brython later.

- Brython tree: `/home/fgallaire/DEV/brython` (the `loader/brython-dev` symlink;
  the test harness `loader/test-cpython.html` now loads `./brython-dev/brython.js`
  + `./brython-dev/brython_stdlib.js` instead of the CDN).
- Build after editing engine source (`descriptors.js`, `py_functions.js`,
  `py_builtin_functions.js`, …): `cd /home/fgallaire/DEV/brython/scripts &&
  python3 make_dist.py` → regenerates `www/src/brython.js`.
- Editing stdlib (`Lib/*.py`, e.g. `_weakref.py`) additionally needs
  `www/src/brython_stdlib.js` rebuilt (the VFS — `make_VFS.py`).

Status legend: [ ] identified · [~] patched+testing · [x] landed (measured gain).

---

## [x] `str[bool]` returns `Undefined` instead of indexing as int (bool is a subclass of int)
**Impact: 0 tests** on this session's sweep, but a clear correctness bug.
`"01"[True]` and `"01"[False]` returned JS `undefined` (the `UndefinedType`
in Brython). `test_unicodedata.test_method_checksum` builds a SHA-1 over
`"01"[char.isalnum()]`-style strings per codepoint; in CPython bool is an
int subclass so `s[True] == s[1]` and `s[False] == s[0]`, but Brython took
`is_int(arg)` true for booleans, then `var jspos = pypos2jspos(self, true)`
returned `true`, and `self[true]` (JS bracket access by property name) is
`undefined`. The dead `is bool` branch a few lines below is unreachable
because `is_int` matched first.

**Fix (1 line):** coerce bool→int via unary `+` at the start of the int branch.

```js
// py_string.js (str.mp_subscript)
-        var pos = arg
-        if(arg < 0){
+        var pos = (typeof arg === 'boolean') ? +arg : arg
+        if(pos < 0){
```

---

## [x] `re.Pattern` exposes only `groupindex` — `pattern`, `flags`, `groups` raise `AttributeError`
**Impact: 0 net on test totals** but masks `assertRaisesRegex` failures.
`unittest.case._AssertRaisesContext` formats the failure message with
`expected_regex.pattern`; when the inner regex didn't match, the formatting
itself crashes with `AttributeError: 'Pattern' object has no attribute
'pattern'`, hiding the real mismatch under a JS-side TypeError. Surfaced
by `test_zlib.test_wbits` and `test_incomplete_stream`. CPython's
`re.Pattern` exposes `pattern`, `flags`, `groups` as `PyMemberDef`-backed
read-only attributes; Brython's JS-native `Pattern` only listed
`groupindex` in `tp_getset`, even though the JS instance object already
carries `pattern`, `flags`, `groups` as JS properties (set in `$factory`).
Brython's attribute lookup ignores raw JS instance props — only
`tp_getset` / `tp_methods` entries are visible.

**Fix:** add the three `_get` wrappers + list them in `tp_getset`.

```js
// libs/python_re.js (~ line 1337 onwards)
+Pattern_funcs.pattern_get = function(self){ return self.pattern }
+Pattern_funcs.pattern_set = _b_.None
+Pattern_funcs.flags_get   = function(self){ return self.flags }
+Pattern_funcs.flags_set   = _b_.None
+Pattern_funcs.groups_get  = function(self){ return self.groups }
+Pattern_funcs.groups_set  = _b_.None
...
-Pattern.tp_getset = ["groupindex"]
+Pattern.tp_getset = ["groupindex", "pattern", "flags", "groups"]
```

---

## [x] `str.istitle` calls `str.title` which is undefined (only `str_funcs.title` exists)
**Impact: 0 tests** (the only test that exercised `istitle` — `test_method_checksum`
in `test_unicodedata` — also fails for an unrelated reason past the istitle call,
so net suite total unchanged. Kept anyway: `istitle()` was broken with a hard
JavaScript error for **any** Python caller, latent on every codepath that uses it.)

**Symptom:** any call to `s.istitle()` crashes with
`JavascriptError: str.title is not a function`. The CPython `test_unicodedata`
`test_method_checksum` hits it inside its inner loop over all codepoints.

**Root cause:** in `www/src/py_string.js`, `str_funcs.istitle` body checks
`s == s.title()` via the JS line `return _self.length > 0 && str.title(_self) == _self`.
But `str.title` is not installed as a direct property of the type object — only
`str_funcs.title` (= `_b_.str.tp_funcs.title`) exists. The methods are dispatched
through the type-protocol machinery; internal-from-JS calls have to go via
`str_funcs.X`, not `str.X`. Sibling `isupper`/`islower`/… get it right.

**Fix (1 line):** `str.title(_self)` → `str_funcs.title(_self)` at the istitle
return.

```js
// py_string.js (str_funcs.istitle)
-    return _self.length > 0 && str.title(_self) == _self
+    return _self.length > 0 && str_funcs.title(_self) == _self
```

---

## [x] bound-method `__name__`/`__qualname__` crash — `$function_infos` not propagated
**Impact: +166 tests** (local-Brython harness total 1751 → 1917, zero regression).
Breakdown: array +70, decimal +58, unicodedata +12, sqlite3 +12, zlib +7, bz2 +4,
lzma +3. Transversal across every wasthon C-type's bound methods.

**Symptom:** any access to `bound_method.__name__` (or `__qualname__`) on a method of
a C/builtin type crashes with `JavascriptError: can't access property 1,
self.$function_infos is undefined`. Hits hard via `unittest.assertRaises`, whose
`handle()` does `self.obj_name = callable_obj.__name__`.

**Root cause:** `method_descriptor.tp_descr_get` (`descriptors.js`) builds the bound
method as `f = self.method.bind(null, obj)` and sets `f.$infos`, `f.ml`, `f.m_self` —
but **not** `f.$function_infos` (a native JS `.bind()` does not copy the target's own
properties). Then `builtin_function_or_method`'s `__name___get` (`py_functions.js`)
reads `self.$function_infos[$B.func_attrs.__name__]` **unguarded** → crash.

**Fix** — two halves:
1. *Brython* — `descriptors.js`, `$B.method_descriptor.tp_descr_get`:
```diff
     var f = self.method.bind(null, obj)
     f.ob_type = $B.builtin_method
     f.$infos = self.$infos
+    // .bind() drops the target's own properties; carry $function_infos
+    // through so builtin_function_or_method's __name__/__qualname__/repr
+    // getters (which read self.$function_infos[...] unguarded) work on the
+    // bound method, as they do on the unbound descriptor's method.
+    f.$function_infos = self.method.$function_infos
     f.ml = {ml_name: self.d_name}
     f.m_self = obj
     return f
```
2. *wasthon* (`src/wasthon.js`, `$__wasthon_make_trampoline`) — the source half:
trampolines now carry `$function_infos = [module, name, qualname]` (native pattern),
so `self.method.$function_infos` is defined for wasthon C-type methods (native methods
get it via Brython's `set_func_names`).

Both halves required: without the trampoline half, `self.method.$function_infos` is
`undefined` for wasthon methods and the propagation copies nothing.
Build: `cd scripts && python3 make_dist.py`.

## [x] `JavascriptFunction.__name__`/`__qualname__` AttributeError → str()/repr() crash
**Impact: +42 tests** (1917 → 1959; all in test_array, zero regression elsewhere).

**Symptom:** `AttributeError: 'JavascriptFunction' object has no attribute '__qualname__'`,
hit via `unittest.assertRaises` → `handle()` line 245 `self.obj_name = str(callable_obj)`
when the tested callable is a bare JS function (e.g. a wasthon slot wrapper like
`a.__add__`). `__name__` (line 243) already failed and the `str()` fallback also reads
`__qualname__`, which a JS function lacks.

**Root cause:** `JSFunction.tp_getattro` (`js_objects.js`) has no case for
`__name__`/`__qualname__`; it falls through to `object.tp_getattro` → AttributeError.
But a JS function carries a usable `.name`.

**Fix** — `js_objects.js`, `$B.JSFunction.tp_getattro`:
```diff
 $B.JSFunction.tp_getattro = function(self, attr){
+    if(attr === '__name__' || attr === '__qualname__'){
+        // A JS function has a `.name`, not `.__name__`; expose it so
+        // str()/repr() and introspection (e.g. unittest.assertRaises naming
+        // the callable) don't crash with AttributeError on a bare JS function.
+        var jsf = self[JSOBJ] || self
+        if(jsf && typeof jsf.name === 'string' && jsf.name){
+            return jsf.name
+        }
+    }
     if(self[JSOBJ] && self[JSOBJ][attr] !== undefined){
         return jsobj2pyobj(self[JSOBJ][attr], self[JSOBJ])
     }
     return _b_.object.tp_getattro(self, attr)
 }
```

---

## Running tally
Local-Brython harness: **1751 → 1959 (+208)** from 2 Brython fixes, zero regression.
