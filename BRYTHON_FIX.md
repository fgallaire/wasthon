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

## [x] `TextIOWrapper` only worked over a buffer exposing `.raw.$bytes`

**Impact: +2** (test_bz2, test_zstd — the text-mode `OpenTest`/`OpenTestCase`
group; the lzma/zstd siblings advance past this crash but then cascade into
separate MemoryError / "File not open for reading" bugs).

`_io._TextIOWrapper.$factory` eagerly slurps the underlying bytes with
`$B.fast_bytes($.buffer.raw.$bytes)`, which assumes the buffer is Brython's own
`$BufferedReader`/FileIO carrying a `.raw.$bytes` blob. Wrapping any other
readable — `lzma.open(p,'rt')` / `bz2.open` / `ZstdFile` hand a compression file
object straight in as the buffer, with no `.raw.$bytes` — so construction
crashed with "`$.buffer.raw is undefined`". Fix: keep the fast path when
`.raw.$bytes` is present, else read the bytes generically via
`$B.$call($B.$getattr($.buffer,'read'),-1)` (which returns a bytes object with
`.source`, exactly what `$B.decode` later consumes).

```js
// _io._TextIOWrapper.$factory
var bytes=$B.fast_bytes($.buffer.raw.$bytes)
// →
var bytes
if($.buffer.raw!==undefined && $.buffer.raw.$bytes!==undefined){bytes=$B.fast_bytes($.buffer.raw.$bytes)}
else{bytes=$B.$call($B.$getattr($.buffer,'read'),-1)}
```

---

## [x] `float.fromhex()` of a negative value crashes (`float.__neg__` undefined)

**Impact: +0** on the harness (only `test_math`'s `testFsum` touches a negative
`float.fromhex`, and it fails a layer later on `OverflowError`), but it's a real
crash worth upstreaming. Already PR'd: branch `fix-fromhex-negative` on
`fgallaire/brython`.

`float.fromhex('-0x…')` negates the parsed value with `float.__neg__(x)`, but
`float.__neg__` is undefined — Brython never exposes operator dunders as raw JS
properties on the type constructor. The negation slot is `float.nb_negative`
(py_float.js); `__neg__` itself lives in the type `__dict__` as a
wrapper_descriptor generated from it (`finalize_builtin_types.js`). So any
negative hex float raises `JavascriptError: float.__neg__ is not a function`.

```python
>>> float.fromhex('-0x1p0')
JavascriptError: float.__neg__ is not a function   # before
-1.0                                               # after
```

Fix (`py_float.js`): call the slot, `float.nb_negative(x)`.

## [x] sequence iterator over a `__getitem__`-only object never stops, swallows non-IndexError

**Impact: +16 tests** (`test_csv` 94 → 110; full sweep 2679 → 2695, zero
regressions). Latent until wasthon's C-exception fix let `test_csv`'s write-error
tests run far enough to hit it.

`iter(obj)` on an object that defines `__getitem__` (+ `__len__`) but no
`__iter__` returns the legacy sequence iterator (`$B.iterator`). CPython's
`PySeqIter_Type` calls `__getitem__(i)` for i = 0, 1, 2, … and stops **only** on
`IndexError`, propagating any other exception. Brython's `$B.iterator.tp_iternext`
instead bounded the walk by `__len__` and evaluated `__getitem__` directly in the
`yield`, catching nothing — so an object whose `__getitem__` raises a
non-`IndexError` neither stopped nor propagated. `test_csv`'s `BadList`
(`__getitem__` raising `OSError` past index 2) sent `_csv`'s writer
`while (PyIter_Next(...))` loop spinning forever.

```python
>>> class C:
...     def __len__(self): return 10
...     def __getitem__(self, i):
...         if i > 2: raise OSError
...         return 'x'
...
>>> list(C())
# hangs forever                                   # before
OSError                                            # after
```

Fix (`$B.iterator.tp_iternext`): drop the `__len__` bound, call `__getitem__` in a
`try`, `return` (→ StopIteration) on `IndexError`, re-`throw` everything else.

## [x] name mangling skips the parameters of a function nested inside a class

**Impact: +42 tests** (`test_hashlib` 15 → 57; full sweep 2554 → 2596, zero
regressions). This was the single biggest blocker in `test_hashlib`: ~50 tests
all died with the same opaque `JavascriptError: can't access property
"__hashvalue__" of undefined` — and because the trigger is in the test case's
`__init__`, every test in the class reported the identical error.

Python name-mangling rewrites any identifier `__spam` (≥2 leading underscores,
≤1 trailing) to `_Class__spam` everywhere it appears textually inside a class
body — **including inside functions nested in a method**. Brython mangled the
*body* references correctly (its `mangle()` walks up for any enclosing
`ClassDef`) but mangled the *parameter binding* only when the immediately
enclosing scope was the class itself
(`in_class = last_scope(scopes).ast instanceof ClassDef`). For a closure built
inside a method — exactly the late-binding idiom in `Lib/test/test_hashlib.py`:

```python
class HashLibTestCase(unittest.TestCase):
    def __init__(self, *args, **kwargs):
        for algorithm in algorithms:
            def c(*args, __algorithm_name=algorithm, **kwargs):
                return hashlib.new(__algorithm_name, *args, **kwargs)
```

the parameter was bound under `__algorithm_name` while the body read the mangled
`_HashLibTestCase__algorithm_name`, which resolved to `undefined`. So
`hashlib.new(undefined, …)` → `__get_builtin_constructor(undefined)` →
`undefined in {…}` / `cache.get(undefined)` → `hash(undefined)` →
`undefined.__hashvalue__` → the JS throw. A second, independent bug in the same
spot: `__kwdefaults__` keys (and their lookup names) were built from the raw
`arg.arg`, so even a dunder kw-only parameter of a method *directly* in a class
body was inconsistent with its mangled binding.

**Fix** (`brython.js`, `$B.ast.FunctionDef.to_js` + `transform_args`): mangle
argument names from the *enclosing* scope via the same `mangle()` walk used for
name references (a no-op when there is no enclosing class), and mangle the
`__kwdefaults__` keys + their names to match the binding.

```js
// FunctionDef.to_js — was: mangle_arg=x=>x, upgraded to mangle only if the
// immediate parent is the class; now walk up like body references do:
-var ...,mangle_arg=x=> x
-if(in_class){var class_scope=last_scope(scopes)
-mangle_arg=x=> mangle(scopes,class_scope,x)}
+var ...,arg_mangle_scope=last_scope(scopes),mangle_arg=x=> mangle(scopes,arg_mangle_scope,x)
+if(in_class){var class_scope=last_scope(scopes)}

// transform_args — key __kwdefaults__ by the mangled name:
+var mangle_arg=x=> mangle(scopes,last_scope(scopes),x)
-kw_defaults.push(`${arg.arg}: ${v}`)
+kw_defaults.push(`${mangle_arg(arg.arg)}: ${v}`)
-kw_default_names.push(`'${kw.arg}'`)
+kw_default_names.push(`'${mangle_arg(kw.arg)}'`)
```

Source-level for upstream: `www/src/py2js.js`, same two functions. Touches
normal code by zero bytes — `mangle()` early-returns unless the name is
`__x`-shaped *and* has a class ancestor; only dunder-prefixed parameters (which
produced `undefined` before) change. Known remaining gap, separate and not
exercised here: argument *annotation* mangling (`arg_ann`) is still gated on
`in_class`, so a dunder parameter's annotation in a nested function is not yet
mangled.

---

## [x] writable in-browser file I/O — `_io` is read-only and `posix` is unimplemented
**Impact: +97 tests** (`test_csv` 43 → 93, `test_bz2` 35 → 78, `test_zstd`
70 → 72, `test_pickle` 312 → 313, `test_hashlib` 14 → 15; full sweep
2441 → 2538, zero regressions). A follow-up harness commit (real
`os_helper.TESTFN`) lands another +8 (lzma +4, pickle +2, bz2 +1, sqlite3 +1).

Brython cannot write a file. `posix` is entirely `NotImplementedError`, and
the `_io` stack is read-only: `_FileIO.tp_init` does a synchronous
`XMLHttpRequest` GET, there is no `BufferedWriter`/`BufferedRandom` (the names
are `undefined`), and `_TextIOWrapper` has no `write`/`tell`/`truncate`. So
anything that writes then re-reads a file — `tempfile`, `open(name,'w+')`,
`bz2.BZ2File`, `array.tofile` — is dead.

**Fix.** A writable io stack layered on the os/posix fd syscalls, exactly like
CPython's `io`. Because it must work for stock Brython too (no wasm), it does
I/O through an injected syscall hook rather than any fixed backend:

- `_FileIO` made fd-aware (read/write/seek/tell/truncate/close over the hook),
  honoring an int fd, a writable path, a custom `opener` (tempfile passes one),
  and `os.PathLike`. Plain reads of paths absent from the FS keep the legacy
  XHR path (zero regression).
- `_TextIOWrapper` given a writable, incremental code path (encode/decode +
  newline handling, text cache invalidated on write/seek).
- `BufferedWriter`/`BufferedRandom` defined as pass-throughs; `io.open`/
  `_io.open`/`builtins.open` re-dispatched to build raw → text directly (the
  stock buffered layer is unusable — its `BufferedReader` slices `raw.$bytes`,
  the whole-file model, undefined for an fd-backed raw; this is what `bz2`/
  `lzma` reach via `builtins.open`).
- a tiny pure-JS in-memory filesystem provides the hook + a real `posix`
  (open/read/write/lseek/stat/unlink/mkdir/… with unlinked-but-open fd
  semantics for tempfile), raising Brython `OSError` subclasses (NOT raw JS
  throws — else `os.path.exists`'s `try/except OSError` breaks the stdlib).

Two gotchas worth keeping: new/overridden type methods must be installed as
`method_descriptor`s in the type dict (the `finalize_type` tp_methods
convention — `set_func_names` alone is not enough); and `posix.O_TMPFILE` must
stay undefined (its mere presence makes tempfile bit-or an undefined flag).

**Not a `brython.js` source diff yet** — prototyped as runtime patches in
wasthon's `loader/wasthon-io-write.js` (the io stack) + `loader/wasthon-fs-mem.js`
(the JS backing), gated to vendored mode. To land upstream: fold the io stack
into Brython's `_io`/`io.py` and ship a default in-memory posix backing so
plain Brython gains writable browser files. (An Emscripten-MEMFS backing was
also prototyped — identical perf, +44 KB, shares files with wasm C code like
sqlite file DBs — kept out-of-tree for when that sharing is wanted.)

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

## [x] `$B.set_func_names` skipped `tp_funcs` entries — bound methods crashed on repr / __qualname__
**Impact: +2 tests** (test_re 99 → 101).

**Symptom:** `repr(instance.method)` or any `assertRaises` reporting the
callable's name for a Brython-native class crashed with
`JavascriptError: self.$function_infos is undefined`.

**Root cause:** Brython-native classes (`Pattern`, `Match`, `Scanner`,
`error`, …) expose their methods through `tp_funcs` (the C-style slot
table). `$B.set_func_names(klass, module)` iterated direct properties of
`klass` and seeded `$function_infos` on each function found there — but
never descended into `tp_funcs`. So those methods had no
`$function_infos`. When `m.group` returned a bound method, `method.tp_repr`
read `self.im_func.$function_infos[__qualname__]` → crash.

**Fix:** widen `set_func_names` to also iterate `klass.tp_funcs`.

```js
// brython_builtins.js
$B.set_func_names = function(klass, module){
    for(var attr in klass){
        if(typeof klass[attr] == 'function'){
            $B.add_function_infos(klass, attr, module)
        }
    }
+   if(klass.tp_funcs){
+       for(var attr in klass.tp_funcs){
+           if(typeof klass.tp_funcs[attr] == 'function'){
+               $B.add_function_infos(klass.tp_funcs, attr, module,
+                   (klass.tp_name || '') + '.' + attr)
+           }
+       }
+   }
}
```

---

## [x] `reversed.$factory` never initialised `counter` + `tp_iter` re-armed exhausted iterators
**Impact: +13 tests** (test_array 461 → 474). Affects any sequence type
without `__reversed__` — Brython's pure-Python lists/tuples mask the bug
via fast paths, but wasthon C-typed arrays go through this generic
reversed.

**Symptom:** `next(reversed(seq))` without a preceding `iter(...)` raised
"array indices must be integers" (`undefined-- = NaN` → getitem(seq, NaN)).
ALSO `list(exhausted_reversed)` re-yielded the full sequence instead of
the empty list, because `tp_iter` reset `counter = len` on every
re-iteration.

**Root cause (two bugs masking each other):**
1. `reversed.$factory` set `len` but no `counter`. The tp_iternext path
   did `self.counter--` first — `undefined--` is `NaN`, never < 0, and
   yielded `getitem(seq, NaN)` forever.
2. `tp_iter` "lazy-init"ed counter to len. Worked for the common `for x
   in reversed(seq):` case but RE-armed exhausted iterators if iter() was
   called twice (e.g. `list(exhausted)` → calls `__iter__` → counter
   reset → iteration restarts).

**Fix:**
- `$factory`: set `counter: seqlen` at creation, with a JS-primitive
  coercion guard (`_b_.len` may return a Brython int wrapper).
- `tp_iter`: just `return self` (CPython behaviour). Don't touch counter.

---

## [x] `$delitem` ignores `mp_ass_subscript` / `sq_ass_item` slots
**Impact: 0 net on this fix alone** but unblocks the wasthon-side bridge
companion (CHANGELOG.md "sq_ass_item negative-index normalisation").

**Symptom:** `del arr[i]` on a wasthon C-typed array raised
`TypeError: 'array' object doesn't support item deletion`. Brython's
`$setitem` (in `py_utils.js`) consults `klass.mp_ass_subscript` first as
a fast path, but the symmetric `$delitem` only had `__delitem__`-via-
getattr — so types with the slot but no Python-level wrapper missed it.

**Fix:** make `$delitem` check `mp_ass_subscript` and `sq_ass_item`
directly with `value = $B.NULL` (the wasthon dispatch is updated in
parallel to route NULL through to the C slot's delete path).

---

## [x] `memoryview.$factory` looked for wrong slot name `tp_getbuffer` (real one is `bf_getbuffer`)
**Impact: 0 net** (the downstream `memoryview(x).pack_into(…)` / `.tobytes()`
paths still fail at the next layer for wasthon C arrays), but a real
correctness fix: `memoryview(any_buffer_object)` had been raising
TypeError unconditionally except for objects already typed as memoryview.

**Symptom:** `memoryview(array.array('b', b'…'))` raised
`TypeError: a bytes-like object is required, not 'array'` even when the
array exposed the buffer protocol. The `tp_new` path I'd extended earlier
was never reached because `memoryview.$factory` (line 22 of
`memoryobject.js`) takes precedence in `$B.$call` — and it checked for
slot `tp_getbuffer`, which Brython doesn't use anywhere (the slot is
called `bf_getbuffer`).

**Fix:** widen the check the same way as `tp_new`: accept `__buffer__`
(PEP 688) OR `bf_getbuffer` slot OR the `$buffer_protocol = true` marker.

```js
// memoryobject.js (memoryview.$factory)
-    var getbuffer = $B.search_slot($B.get_class(obj), 'tp_getbuffer', $B.NULL)
-    if(getbuffer === $B.NULL){
+    var cls_obj = $B.get_class(obj)
+    var has_buffer = $B.$getattr(obj, '__buffer__', $B.NULL) !== $B.NULL
+                  || (cls_obj && cls_obj.bf_getbuffer)
+                  || (cls_obj && cls_obj.$buffer_protocol)
+    if(!has_buffer){
         $B.RAISE(_b_.TypeError, "memoryview: a bytes-like object …")
     }
```

Also fixed `memoryview_funcs.tobytes`: `array.tobytes(self.obj)` →
`array.tp_funcs.tobytes(self.obj)` (same `str.encode` family pattern —
methods live in `tp_funcs`, not direct JS properties).

---

## [x] `range.__len__` referenced instead of `range.mp_length` in `mp_subscript`
**Impact: +1 test_random**, +2 test_pickle (incidental).

**Symptom:** `range_obj[slice]` or `range_obj[negative_index]` raised
`JavascriptError: range.__len__ is not a function`. `_b_.range` exposes
`mp_length`, not `__len__`. Two calls in `py_range_slice.js:263,276` had
the wrong name.

**Fix:** `s/range\.__len__/range.mp_length/` in those two lines.

---

## [x] `type.tp_call` crashes when `tp_init` is `undefined` (not `$B.NULL`)
**Impact: 0 net** but prevents one crash; converts crash into a normal
"TypeError not raised" failure for `test_uninstantiable` (the test expects
a specific TypeError that wasthon's bridge doesn't yet raise).

**Symptom:** `JavascriptError: can't access property "call", init_func is
undefined`. Some bridge-installed heap types skip the `finalize_type`
wrapper_methods loop that normally fills `tp_init`. tp_call's path was
guarded against `tp_init === $B.NULL` and against `tp_init === object.tp_init`,
but not against the JS `undefined` case.

**Fix:** add `typeof init_func == 'function'` to the same guard chain.

---

## [x] `_operator._compare_digest` auto-binds when used as class attribute
**Impact: +5 tests** (test_hmac 8 → 13).

**Symptom:** `class T(unittest.TestCase): compare_digest = hmac.compare_digest`
then `self.compare_digest(a, b)` raises
`TypeError: _compare_digest() takes 2 positional arguments but 3 were given`.

**Root cause:** Brython's `_operator.py` defines `_compare_digest` as a plain
Python function. Functions implement `__get__` and bind to the instance when
accessed via class attribute — `self.compare_digest(a, b)` becomes
`_compare_digest(self, a, b)` (3 args). CPython's `_compare_digest` is a C
builtin; builtin functions skip the descriptor protocol and don't auto-bind.
84 raw failure entries in `test_hmac.HMACCompareDigestTestCase` collapsed
to 5 parent tests.

**Fix:** wrap `_compare_digest` with a no-bind descriptor so accessing it
via `instance.f` returns the wrapper itself, not a bound method.

```python
# _operator.py
class _NonBindingFunction:
    def __init__(self, f):
        self._f = f
        self.__name__ = getattr(f, '__name__', '<unbound>')
    def __call__(self, *args, **kwargs):
        return self._f(*args, **kwargs)
    def __get__(self, obj, owner=None):
        return self

def _compare_digest_impl(a, b):
    ...

_compare_digest = _NonBindingFunction(_compare_digest_impl)
```

Note: the wasthon-side companion fix (CHANGELOG.md, "module-scope
trampolines are builtin_function_or_method") handles the same pattern for
C-module functions like `math.isclose` — together they cover both Python
stdlib helpers and wasthon C bindings used as class attributes.

---

## [x] `re.PatternError` alias missing (CPython 3.13+)
**Impact: +3 tests** (test_re 82 → 85). 22 distinct `'module' object has no
attribute 'PatternError'` failures collapsed to 3 distinct tests after
unittest's parent-test dedup.

**Symptom:** `re.PatternError` raises `AttributeError`. CPython 3.13
renamed `re.error` to `re.PatternError` (old name kept as alias). Tests
written against 3.13+ use the new name. Two-line fix in the module export
table:
```js
// libs/python_re.js (module exports)
    error: error,
+   PatternError: error,
```

---

## [x] `_b_.str.encode` is undefined — `str.tp_funcs.encode` is the real method
**Impact: +3 tests** (test_re 85 → 88) **+ unexpected +3 on test_binascii**
(38 → 41) — same root pattern as `str.istitle` calling `str.title`.

**Symptom:** every code path that did `_b_.str.encode(s, 'latin-1')` in
`libs/python_re.js` crashed with `JavascriptError: _b_.str.encode is not a
function`. There are 4 such call sites — in `Pattern.tp_repr`, in `escape`,
in the `compile` byte-pattern path, and in `_pickle`'s reconstructor.
`str.tp_funcs.encode` is the real method; `_b_.str.encode` is undefined
because finalize_type installs methods into `tp_dict` (as
method_descriptors) rather than as direct JS properties on the class.

**Fix:** `s/_b_\.str\.encode(/_b_.str.tp_funcs.encode(/` × 4.

---

## [x] `re.Pattern.tp_richcompare`'s `__ne__` branch — typo `Patttern_eq` (3 t's)
**Impact: not separately measured** (folded into the str.encode pass).
`p1 != p2` between compiled patterns raised `ReferenceError: Patttern_eq
is not defined`. One-letter fix.

---

## [x] `re.error` — `.msg / .pattern / .pos / .lineno / .colno` not exposed to Python
**Impact: +9 tests** (test_re 88 → 99 over two passes — first the `tp_init`
attempt below, then the descriptor exposure).

**Symptom:** `re.error("hello").msg` raised `AttributeError: 'error'
object has no attribute 'msg'`. The 229 raw failure entries collapsed to ~9
distinct parent tests after unittest's dedup.

**Root cause:** the JS-side `error.$factory` already set `msg`, `pattern`,
etc. on the instance as JS properties. But Brython's Python-side attribute
lookup ignores raw JS instance props — only entries surfaced via
`tp_funcs` + `tp_getset` are visible. Same root pattern as the Pattern fix
above. Also needed a Python-side `tp_init` for `raise re.error("msg")`
because Brython's `$B.$call` picks `$factory` over `tp_call`, so the
Exception default `__init__` path never ran — but adding tp_init alone
gained 0 tests since the JS props it set were still invisible to Python.

**Fix:** add `tp_init` (for the Python construction path), `tp_funcs`
getters for each field, and list them in `tp_getset`.

```js
// Construction path
error.tp_init = function(self, ...rest){
    self.args = $B.fast_tuple(rest)
    self.msg = rest.length > 0 ? rest[0] : _b_.None
    self.pattern = rest.length > 1 ? rest[1] : _b_.None
    self.pos = rest.length > 2 ? rest[2] : _b_.None
    self.lineno = 1
    self.colno = 1
    return _b_.None
}

// Attribute exposure
var error_funcs = error.tp_funcs = {}
error_funcs.msg_get      = function(self){ return self.msg     !== undefined ? self.msg     : _b_.None }
error_funcs.msg_set      = _b_.None
error_funcs.pattern_get  = function(self){ return self.pattern !== undefined ? self.pattern : _b_.None }
error_funcs.pattern_set  = _b_.None
error_funcs.pos_get      = function(self){ return self.pos     !== undefined ? self.pos     : _b_.None }
error_funcs.pos_set      = _b_.None
error_funcs.lineno_get   = function(self){ return self.lineno  !== undefined ? self.lineno  : 1 }
error_funcs.lineno_set   = _b_.None
error_funcs.colno_get    = function(self){ return self.colno   !== undefined ? self.colno   : 1 }
error_funcs.colno_set    = _b_.None

error.tp_getset = ["msg", "pattern", "pos", "lineno", "colno"]
```

Also `$factory` was emitting `args: empty_tuple` — now `args: fast_tuple([message])` to match the Exception convention.

---

## [x] `re.Match` — broken `tp_new`, missing `endpos / pos / re` on `$factory`
**Impact: 0 visible test gain** but a correctness fix for any `match.pos /
endpos / re` access.

**Symptom:** `match.pos`, `match.endpos`, `match.re` returned
`UndefinedType`. `MatchObject.tp_new` was unreachable because it
dereferenced `self.mo.endpos` (no `self` in scope at tp_new — this is a
ReferenceError that gets swallowed; instances came from `$factory`
silently, with only `mo` set).

**Fix:**
1. Have `$factory` populate `endpos / pos / re` from the internal match
   object (`mo.endpos`, `mo.start`, `mo.node.pattern`).
2. Drop the broken `self.*` lines from `tp_new` — `$factory` already does it.

---

## [x] `warn(klass, ...)` in `python_re.js` calls `klass.$factory` — builtin Warning classes don't expose `$factory`
**Impact: 0 net** (the 2 tests it unmasks still fail at the next
assertion, which is the actual feature gap — these tests expect specific
DeprecationWarnings from the regex parser). Real-bug fix anyway.

**Symptom:** `JavascriptError: klass.$factory is not a function` from
`python_re.js:170` when the parser tried to emit a deprecation /
future-warning during compile (e.g. `re.compile(...)` with `\d` in a
bytes pattern). Built-in exception classes like `DeprecationWarning`
are made via `make_builtin_exception` and don't expose `$factory`.

**Fix:** use `$B.$call(klass, message)` instead — handles both `$factory`
and `tp_call` paths.

---

## [x] `re.Scanner` methods missing from tp_funcs (search/match raised AttributeError)
**Impact: +2 tests** (test_re 90 → 92). `Scanner.match` and `Scanner.search`
were defined directly as JS class properties; Brython's instance attribute
lookup goes through `tp_funcs` / `tp_methods` and didn't pick them up.

**Fix:** move them into the standard `tp_funcs` dict + list them in
`tp_methods` so `set_func_names` and `finalize_type` register them.

```js
var Scanner_funcs = Scanner.tp_funcs = {}
Scanner_funcs.match  = function(self){ /* … */ }
Scanner_funcs.search = function(self){ /* … */ }
Scanner.tp_methods = ["match", "search"]
```

---

## [x] `array.array(typecode, initializer)` raises `bad typecode` for ANY valid typecode
**Impact: +2 tests** (test_binascii 36 → 38; the test calls
`array.array('B', bytes_value)` while validating `b2a_base64`-style outputs).
The buggy line was completely broken — anyone hitting `array.array(tc, init)`
got a `ValueError` regardless of the typecode. Empty form `array.array(tc)`
worked, masking the regression in test suites that don't pass an initialiser.

**Symptom:** `array.array('b', b' '*100)` → `ValueError: bad typecode (must
be b, B, u, h, H, i, I, l, L, q, Q, f or d)` — even though 'b' is right there
in the list.

**Root cause:** in `libs/array.js`, `array.tp_new`:
```js
array.tp_new = function(cls, args, kw){
    var [cls, ...args] = arguments     // ← BUG
    var obj = make_array(args, kw)
    ...
}
```
The destructuring `var [cls, ...args] = arguments` **re-binds** the local
`args` variable to `[arguments[1], arguments[2]] = [originalArgs, kw]`. So
`make_array` is then called with `args = [[real_args], kw]`, and
`unpack_args` returns `typecode = [real_typecode, real_initializer]` (a JS
array). `typecodes.hasOwnProperty(arrayOfTwo)` is false → "bad typecode"
even though the user passed a legitimate one. The empty-initializer form
escapes because the failing destructure happens for any non-empty `args`,
but `array.array(tc)` has args=[tc] and unpack_args runs the same way → the
destructure path also fails… wait actually it also produces the same wrong
shape in theory. The test discrepancy ("'B' empty: ok" vs "'B' bytes: fail")
may be due to a separate path tracking. Either way, the line is unambiguous
junk: the function signature already destructures `(cls, args, kw)` from
`arguments`; re-doing it shadows the parameters.

**Fix:** delete the redundant re-destructure.

```js
array.tp_new = function(cls, args, kw){
-    var [cls, ...args] = arguments
    var obj = make_array(args, kw)
    obj.cls = cls
    return obj
}
```

---

## [x] `memoryview()` rejects objects exposing only `bf_getbuffer` / `$buffer_protocol`
**Impact: 0 tests this session** (it unblocks the path but the downstream
`memoryview` operations on wasthon arrays still don't fully work for
`struct.pack_into`'s writable path; counted as the wasthon-side companion to
the bridge-level `Py_bf_getbuffer → cls.$buffer_protocol = true` patch.)

**Symptom:** `memoryview(array.array('b', b'x'))` raises `TypeError: a
bytes-like object is required, not 'array'`, even though `array` declares
`$buffer_protocol = true` (Brython's own native types do) and implements
`bf_getbuffer`. CPython's `memoryview()` accepts anything implementing the
buffer protocol; Brython's tp_new only accepted PEP 688's `__buffer__`.

**Fix:** widen the acceptance check.

```js
// memoryobject.js (memoryview.tp_new)
-    if($B.$getattr(obj, '__buffer__', $B.NULL) !== $B.NULL){
+    var cls_obj = $B.get_class(obj)
+    var has_buffer = $B.$getattr(obj, '__buffer__', $B.NULL) !== $B.NULL
+                  || (cls_obj && cls_obj.bf_getbuffer)
+                  || (cls_obj && cls_obj.$buffer_protocol)
+    if(has_buffer){
        obj.exports = obj.exports ?? 0
        ...
```

---

## [x] `weakref.ProxyType` does not forward dunder operators (`len`, `iter`, `==`, `repr`, …)
**Impact: 0 net on test totals** (test_array's `test_weakref` also asserts
`ReferenceError` after `s = None; gc_collect()` — Brython's weak references
aren't actual weak references, so that assertion can't pass without a
deeper change), but a clean correctness fix for every other use of
`weakref.proxy(obj)`.

**Symptom:** `len(proxy)` raises `TypeError: object of type 'ProxyType'
has no len()`. Same for `iter(proxy)`, `proxy == x`, `repr(proxy)`,
`bool(proxy)`, `proxy[i]`, etc. — Python looks up these dunders on the
CLASS, sidestepping the proxy's `__getattr__` that was supposed to
forward everything. CPython's weakproxy proxies every operator via its
slot table.

**Fix:** spell out the dunder forwards on `ProxyType` so the class-level
lookup hits a real method that delegates to the wrapped object. Matches
CPython's weakproxy slot table exactly — including the one slot that is
*not* forwarded:

```python
# Lib/_weakref.py — inside class ProxyType
+    def __len__(self):           # forwarded
+        return len(object.__getattribute__(self, "obj"))
+    # … __iter__, __getitem__/__setitem__/__delitem__, __contains__,
+    # __eq__/__ne__/__lt__/__le__/__gt__/__ge__,
+    # __hash__, __bool__, __str__,
+    # __add__/__mul__/__rmul__ — all forward the same way.
+
+    # `__repr__` is the one slot CPython's weakproxy does NOT forward:
+    # it shows the proxy's own identity. Match that exactly.
+    def __repr__(self):
+        obj = object.__getattribute__(self, "obj")
+        return (f"<weakproxy at {id(self):#x}; to "
+                f"'{type(obj).__name__}' at {id(obj):#x}>")
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
