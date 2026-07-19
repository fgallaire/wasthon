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

- [x] **`memoryview` ignores `format`/`itemsize` for every standard format
  except a hardcoded `"I"`** (`www/src/py_memoryview.js` — `mp_subscript`,
  `sq_ass_item`, `tp_iter`, `tolist`, `cast`). Element access read raw
  BYTES: `cast('i')` returned `undefined` (the cast switch only knew
  `B`/`I`), and a view stamped with a multi-byte format indexed
  byte-by-byte. CPython indexes ELEMENTS:

  ```python
  mv = memoryview(bytearray(b'\x01\x00\x00\x00\x02\x00\x00\x00')).cast('i')
  mv[0], mv[1], mv[-1]   # CPython: (1, 2, 2) — Brython: crash (cast gave None)
  mv[1] = 300            # writes 4 little-endian bytes
  mv.tolist()            # [1, 300]
  ```

  Fix — a `DataView`-backed `mv_read`/`mv_write` pair over the little-endian
  byte source handles every standard struct format (`b B h H i I l L q Q f
  d ?`, int64 returning BigInt only past 2**53); `mp_subscript`/`sq_ass_item`
  route through it when the view is typed (negative indices and CPython's
  IndexError/`cannot modify read-only memory` included), `tp_iter`/`tolist`
  yield elements, and `cast` grows a generic default branch (the `B`/`I`
  hardcodings untouched). Byte-level views (`format 'B'`, itemsize 1) keep
  the existing code paths byte-for-byte. (+1 numpy with the bridge
  live-heap-proxy companion: test_random 142/142 green,
  `rng.shuffle(np.arange(5).data)` permutes the array.)
- [x] **str-subclass instances break four str/bytes paths that consume the
  value raw instead of unboxing `$brython_value`** (`www/src/py_string.js`,
  `www/src/py_bytes.js`). A `class S(str)` instance is
  `{ob_type: S, $brython_value: '…'}`; CPython accepts str subclasses
  everywhere a str is expected. Four spots didn't:

  ```python
  class S(str): pass
  b'ab'.decode(S('ascii'))          # RuntimeError: encoding.toLowerCase is not a function
  list(S('abc'))                    # RuntimeError: self[Symbol.iterator] is not a function
  '-'.join(['a', S('b')])           # 'a-[object Object]'
  S(' Σ ').encode('unicode_escape') # b'' (empty)
  ```

  Fixes, one line each: `normalise(encoding)` unboxes a str subclass before
  `.toLowerCase()` (covers every bytes.decode/str.encode codec lookup);
  `str.tp_iter` iterates `to_string(self)`; `str.join` pushes
  `to_string(obj2)` into the JS `Array.join` (the is_str type check already
  passed — the raw box stringified as `[object Object]`); `str.encode`
  passes the `_self` it already computed to `bytes.tp_new` instead of the
  raw `$.self`. (+2 numpy with the bridge str_-boxing companion:
  test_defchararray 99/0 green, test_scalarinherit 6/6 — np.str_ scalars
  are str subclasses that now cross these paths constantly.)
- [x] **`bytes(obj)` never tries the buffer protocol** (`www/src/py_bytes.js`,
  the iteration fallback of `bytes.tp_new`). CPython's bytes() accepts any
  buffer exporter; Brython went list()->__bytes__->TypeError, so
  `bytes(np.array(567.))` (a 0-d array: not iterable, no __bytes__) raised
  `cannot convert 'ndarray' object to bytes` instead of yielding the
  double's 8 bytes. Fix — before the error, go through the exporter's
  `tobytes()` (the same convention `$B.to_bytes` already uses). (+1 numpy
  test_scalar_ctors `test_void_from_byteslike`, with the bridge
  GET_BUFFER-fill companion.)

- [x] **`open()` 404s on an URL-shaped path whose scheme was collapsed by
  `os.path`** (`www/src/py_files.js`-area, the XHR branch of the file
  opener). In the browser `os.getcwd()`/module `__file__` are URLs;
  `os.path.abspath`/`normpath` collapse their `//` (POSIX semantics), so
  `dirname(abspath(__file__)) + '/data/f'` yields `http:/host/…` and the
  XHR fails. Repro:

  ```python
  import os
  p = os.path.join(os.path.split(os.path.abspath("./x.py"))[0], "data.txt")
  open(p)   # FileNotFoundError: http:/host/…  (file exists at http://…)
  ```

  Fix — repair `^https?:/(?!/)` to `https?://` at the I/O boundary, right
  before the GET. numpy's legacy-pickle data tests build exactly this path.
  (+3 numpy: test_generator_mt19937 legacy_pickle x2 — 321/0 green — and
  test_direct SFC64 legacy_pickle.)

- [x] **`bytes(-2)` returns `b''` instead of raising ValueError("negative
  count")** (`www/src/py_bytes.js`, the int branch of `bytes.tp_new`).
  Repro: `bytes(-2)` / `bytearray(-1)`. numpy's `string_arrtype_new` relies
  on the raise to take its int-to-decimal fallback — `np.bytes_(-2)` must be
  `b'-2'`, and silently getting `b''` from the superclass skipped it. Fix —
  raise before building the zero-fill. (+1 numpy test_scalar_ctors with the
  bridge kwargs-forwarding companion.)

- [x] **`getset_descriptor` has no `__doc__` getset — reading it climbs to
  `object.__doc__` ("The base class of the class hierarchy.")**
  (`www/src/py_dict.js`-area, `getset_descriptor_funcs`). The descriptor's own
  `__doc__` JS property is not a Brython `__dict__`, so attribute lookup never
  saw it. Repro: any C-extension getset, e.g. a wasthon module's property —
  `SomeCType.prop.__doc__` returned object's docstring instead of the
  extension's. Fix — `__doc___get`/`__doc___set` in tp_funcs plus `__doc__` in
  tp_getset (the setter is a plain store; the wasthon bridge layers numpy's
  fill-once rule on its own descriptors). Companion to the bridge's
  PyGetSetDef.doc wiring. (+1 numpy test_function_base with it.)

- [x] **`frame.f_locals` of a method frame returns the raw namespace object,
  whose `__class__` key (super() support) makes it LOOK like an instance of
  the enclosing class** (`www/src/py_frame.js`-equivalent, `f_locals_get`;
  `$B.obj_dict` is the identity). `type(frame.f_locals)` came out as the
  class, and every mapping operation crashed. Repro:

  ```python
  import sys
  class T:
      def run(self):
          f = sys._getframe(0)
          print(type(f.f_locals))       # <class 'T'> — expected dict
          'x' in f.f_locals             # TypeError: 'T' is not a container
  T().run()
  ```

  numpy's `bmat("A,B;C,D")` reads the CALLER's `f_locals` to resolve the
  matrix names and died on it. Fix — when the namespace carries a
  `__class__`/foreign `ob_type` marker, serve a plain-dict snapshot without
  the compiler-internal keys (`$…`), like CPython's function-frame f_locals;
  `super()` still works (the marker stays on the real namespace).
  (+2 numpy test_defmatrix TestCtor.)

- [x] **`list.sort`/`sorted` never sorts objects whose `__lt__` returns a
  non-bool — the comparator uses raw JS truthiness** (`www/src/py_list.js`,
  `basic_cmp`). numpy scalars' `__lt__`/`__eq__` return a wrapped `np.bool_`
  object, which is ALWAYS truthy in JS, so `basic_cmp` answered "less" for
  every pair and the sort was an identity. Repro (pure Python):

  ```python
  class N:
      def __init__(self, v): self.v = v
      def __lt__(self, other): return TruthyBox(self.v < other.v)  # non-bool truthy object
  # sorted([N(3), N(1), N(2)]) keeps [3, 1, 2]
  ```

  (with numpy: `sorted([np.int32(3), np.int32(1), np.int32(2)])` → `[3, 1, 2]`;
  `key=int` sorted fine — that path goes through TimSort.) Fix — truth-test the
  `rich_comp` results through `$B.$bool`, exactly like `$extreme` (min/max)
  already does. (+3 numpy test_shuffle_masked across generator/randomstate/
  random suites.)

- [x] **`str.sq_repeat` raises TypeError on a non-index count instead of
  returning NotImplemented — the right operand's `__rmul__` never runs**
  (`www/src/py_string.js`). CPython's `str.__mul__` defers (NotImplemented)
  when the count has no `__index__`, letting the binop protocol try
  `type(y).__rmul__`; `rich_op1` already emits the exact
  `can't multiply sequence by non-int of type 'X'` TypeError when nothing
  handles it. Repro:

  ```python
  class M:
      def __rmul__(self, other): return 'RMUL'
  assert 'x' * M() == 'RMUL'   # TypeError before the fix
  ```

  Fix — `catch → return NotImplemented`. Message parity kept: `'a' * 'b'`
  still raises `can't multiply sequence by non-int of type 'str'`.
  (+1 numpy test_defchararray — `'qrs' * chararray` now reaches numpy's
  `ValueError: Can only multiply by integers`.)

- [x] **`str.strip`/`lstrip`/`rstrip` with a non-None, non-str argument crash
  with a raw JS error instead of TypeError** (`www/src/py_string.js`).
  `to_string(chars)` returns the NULL sentinel for a non-str and the code then
  iterates it (`for (var char of chars)`) → `chars is not iterable`. CPython
  raises `TypeError: strip arg must be None or str`. Repro: `'abc'.strip(1)`.
  Fix — raise the CPython TypeError right after the conversion in all three
  methods. (+1 numpy test_defchararray, `_vec_string` invalid-args.)

- [x] **`unicode_escape` codec: decode handles only 7 escapes via chained
  `str.replace` (and crashes on a bytes subclass); encode is missing
  entirely** (`www/src/py_bytes.js`, the `decode`/`encode` switches). Decode
  matched only `\n \a \b \f \t \' \"` with regex replaces over a
  latin-1-decoded string — `\ooo`, `\xhh`, `\uxxxx`, `\Uxxxxxxxx` passed
  through as literal text — and the latin-1 pre-pass tested
  `[bytes, bytearray].includes(get_class(obj))`, so a bytes SUBCLASS instance
  fell through to `obj.replace` (JS crash). Encode had no `unicode_escape`
  case and fell to the `_codecs` stdlib stub, which returns `None`
  (`TypeError: codec returns UndefinedType`). Repro:
  `b'\\u03a3'.decode('unicode_escape')` → `'\\u03a3'` (expected `'Σ'`);
  `'Σ'.encode('unicode_escape')` → TypeError. Fix — full byte-walking decoder
  over the raw bytes (C escapes, `\ooo` octal, `\xhh`, `\uxxxx`,
  `\Uxxxxxxxx`, truncation/out-of-range errors) and a CPython-shaped encoder
  (printable ASCII verbatim; `\\ \n \r \t`; `\xhh`/`\uxxxx`/`\Uxxxxxxxx`).
  (+2 numpy test_defchararray.)

- [x] **`bytes`/`bytearray` `strip`/`lstrip`/`rstrip` with NO argument raise
  `TypeError: Type str doesn't support the buffer API`; two-sided
  `strip(arg)` hits a JS ReferenceError** (`www/src/py_bytes.js`). The no-arg
  default is `ws_cars` — a plain JS array of the four whitespace codes — but
  the shared `strip(self, cars, lr)` helper only accepts `undefined` or a real
  `bytes` and raises for anything else, so `b'x  '.rstrip()` never worked.
  Independently, `bytes.strip`/`bytearray.strip` computed
  `var stripped_right = …` then folded `strip.call(cls, res, …)` — `res` is
  not defined. Repro: `b'abc  '.rstrip()` → TypeError;
  `b' x '.strip(b' ')` → `res is not defined`. Fix — the helper passes
  `cars === ws_cars` through untouched (it IS the whitespace list), and the
  fold uses `stripped_right`. (+5 numpy test_defchararray —
  `chararray.__getitem__` rstrips every `bytes_` scalar.)

- [x] **`bytes.rsplit` returns byte-reversed pieces, and its no-sep whitespace
  path splits the wrong string** (`www/src/py_bytes.js`, `rsplit` +
  `bytes_split_with_whitespace`). The implementation reverses the input,
  splits, then must un-reverse each piece — it called `part.reverse()` on the
  WRAPPER objects and re-wrapped the still-reversed source arrays; the
  `sep=None` branch split `self` instead of `reversed_self`; and the
  whitespace right-trim sliced `source.slice(start, pos-start+1)` (a length
  where an end index belongs). Repro: `b'ab cd'.rsplit()` /
  `b'a,bb'.rsplit(b',')` → reversed/garbled pieces. Fix —
  `parts.map(t => this.$factory(Array.from(t.source).reverse()))`, whitespace
  path over `reversed_self`, slice end `pos+1`. (+1 numpy test_defchararray
  via `np.char.rsplit`.)

- [x] **A class created through `type.tp_new` is missing from its bases'
  `__subclasses__()`** (`www/src/py_type.js`, the two `return class_obj` exits
  of `type.tp_new`). Brython's `$class_constructor`/`finalize_type` push a
  newly created class into each base's `tp_subclasses`, but the `type.tp_new`
  path (C code building a class, or `type(name, bases, ns)`) returned without
  registering it. `abc.ABCMeta.__subclasscheck__` walks `cls.__subclasses__()`
  to honour `register()`, so virtual-subclass checks silently failed. Repro:

  ```python
  class Base: pass
  Child = type('Child', (Base,), {})
  assert Child in Base.__subclasses__()   # [] before the fix
  ```

  Fix — bare `tp_subclasses.push(class_obj)` before both exits, guarded with
  `if (_sb.tp_subclasses)` (C-extension bases have none), mirroring
  `$class_constructor`. (+2 numpy test_seed_sequence:
  `issubclass(SeedSequence, ISeedSequence)` after `register()`.)

- [x] **A replaced `warnings.showwarning` was ignored — `_warnings.warn` called
  `_showwarnmsg_impl` instead of `_showwarnmsg`** (`www/src/builtin_modules.js`,
  the `_warnings` module's `warn`). `numpy.testing`'s `assert_warns` /
  `suppress_warnings` record a warning by replacing `warnings.showwarning`;
  CPython's machinery routes through `_showwarnmsg`, which calls a replaced
  `showwarning` and only falls back to `_showwarnmsg_impl` (the default stderr
  sink) when it is unchanged. Brython's C-level `warn` shortcut called
  `_showwarnmsg_impl` directly, so the override never fired and `assert_warns`
  reported "No warning raised". Fix — call `_showwarnmsg`:

  ```javascript
  // www/src/builtin_modules.js — _warnings.warn
  var showwarn = $B.module_getattr($B.imported.warnings, '_showwarnmsg')
  // was: '_showwarnmsg_impl'
  ```

  (Second part, vendored bundle only: the 3.14.1 `brython.js` had also dropped
  the `warn(str, category)` → `category(str)` instance conversion the brython-dev
  source still does, so the replaced `showwarning` received a bare `str` and hit
  `'str' object has no attribute 'args'` — restored in the bundle.) Repro:
  `numpy.testing.assert_warns(UserWarning, warnings.warn, 'x', UserWarning)`.
  +1 scipy.cluster test_hierarchy.

- [x] **Float dict *literal* keys whose hash exceeds 2\*\*53 missed on lookup**
  (`www/src/py_dict.js`, `dict.$literal`). A dict literal `{0.8: 1}` compiles to
  `dict.$literal([[key, value, hash], …])` where `item[2]` is the key hash the
  **compiler precomputed**. For a non-string key that hash can be an imprecise
  JS number — a float's hash exceeds 2\*\*53 (`hash(0.8) == 1844674407370955264`),
  and `_b_.dict.$setitem` buckets on `self[TABLE][hash]`, so the precomputed
  Number key disagrees with the exact BigInt hash recomputed by
  `__getitem__`/`__contains__` on lookup. Hence `0.8 in {0.8: 1}` → False while
  `x = 0.8; x in {x: 1}` → True (a variable key isn't precomputed, so both sides
  hash at runtime). Fix — keep the fast path for string keys, recompute every
  other key's hash at runtime (matching lookup):

  ```javascript
  // www/src/py_dict.js — dict.$literal, inside the loop
  dict.$setitem(res, item[0], item[1],
                typeof item[0] == "string" ? item[2] : undefined)
  // was: dict.$setitem(res, item[0], item[1], item[2])
  ```

  Repro: `0.8 in {0.8: 1}` (→ False before). +3 scipy.cluster `test_hierarchy`
  (`TestFcluster`, whose test-data dicts are keyed by float thresholds).

- [x] **`len()` overcounts a dict once a string key follows a non-string key**
  (`www/src/py_dict.js`, `dict.mp_length` — regressed in the vendored 3.14.1
  bundle; the brython-dev source already has it right). A dict switches to TABLE
  mode the moment a non-string key is inserted; string keys then live in KEYS,
  but `dict.$setitem` still also writes the value as a direct JS property
  (`self[key] = value`) — a stale duplicate. The buggy `mp_length` summed BOTH
  `Object.keys(self).length` (the stray direct props) AND the KEYS entries, so
  every string key added in TABLE mode was counted twice:

  ```pycon
  >>> d = {1: 0}; d['a'] = 1; len(d)
  3          # should be 2 — d.items()/keys() correctly show 2
  ```

  Fix — in TABLE mode count only KEYS (the direct props are stale duplicates;
  every read path already goes through KEYS); use `Object.keys` only for a
  pure-string (non-TABLE) dict:

  ```javascript
  // www/src/py_dict.js — dict.mp_length  (matches the brython-dev source)
  _b_.dict.mp_length = function(self) {
      var count = 0
      if (self[KEYS]) { for (var d of self[KEYS]) if (d !== undefined) count++ }
      else { count = Object.keys(self).length }
      return count }
  ```

  Repro: `len({1: 0, 'a': 1})` → 3 before. +9 scipy.cluster `test_disjoint_set`
  (whose keys mix numpy-float/int/str/tuple/None). NB numpy's float scalar hash
  differs from Brython's (`hash(np.float64(0.8))` = 9007199254740557 vs
  1844674407370955264) but is self-consistent — the len miscount was the failure,
  not the hash.

- [x] **`deque(iterable, maxlen=N)` raised `TypeError: object.__new__() takes
  exactly one argument`** (`www/src/Lib/_collections.py`, `deque.__new__`).
  `deque.__new__(cls, iterable=(), *args, **kw)` forwarded `*args, **kw` to
  `object.__new__(cls, *args, **kw)`; with a keyword such as `maxlen` present,
  `object.__new__` rejects the excess arg (correctly, as in CPython, because
  `__new__` is overridden). CPython's real deque is a C type and never runs this
  Python `__new__`. Fix — don't forward (iterable/maxlen are consumed by
  `__init__`, and `__new__` needs neither):

  ```python
  # www/src/Lib/_collections.py — deque.__new__
  def __new__(cls, iterable=(), *args, **kw):
      self = object.__new__(cls)   # was: object.__new__(cls, *args, **kw)
      self.clear()
      return self
  ```

  Repro: `from collections import deque; deque([1, 2, 3, 4], maxlen=2)`. Surfaced
  in scipy.cluster `_kmeans` (`deque([diff], maxlen=2)`). +6 test_vq
  (scipy.cluster kmeans, with the BLAS-shim fix → test_vq 31/0).

- [x] **`str * n` rejected any non-`int`, ignoring `__index__`** (`www/src/py_string.js`, `_b_.str.sq_repeat`). CPython's `PySequence_Repeat` converts the count with `PyNumber_AsSsize_t` → `__index__`, so `'ab' * numpy.int32(3)` works. Brython's `str.sq_repeat` guarded with a strict `$B.is_int(other)` and raised `TypeError: Can't multiply sequence by non-int of type 'int32'`. `list`/`tuple` already do the right thing — their shared `sq_repeat` (`www/src/py_list.js`) goes through `$B.PyNumber_Index` — so only `str` was out of line. Repro: `'ab' * numpy.int32(3)`. Fix — swap the type guard for the same `PyNumber_Index` conversion (still a `TypeError`, same message, for anything with no `__index__` — `float`, `str`, …):

  ```js
  // www/src/py_string.js — _b_.str.sq_repeat
   var _self = to_string(self)
  -    if(! $B.is_int(other)){
  +    try{
  +        other = $B.PyNumber_Index(other)
  +    }catch(err){
           $B.RAISE(_b_.TypeError,
           "Can't multiply sequence by non-int of type '" +
               $B.class_name(other) + "'")
       }
       return _self.repeat(other < 0 ? 0 : other)
  ```

  `'ab' * numpy.int32(3)` now works (it surfaced in scipy.special's `FuncData` error formatter, which does `str * np.int32`). No pass-count gain today — a real CPython divergence fixed for its own sake.

- [x] **`SomeType == obj` skipped the reflected `__eq__` (returned identity)** (engine, `rich_comp`). The fast path for a class with a plain `type` metaclass returned `x === y` directly for `__eq__`/`__ne__`, so a non-identical operand never got the reflected comparison CPython gives it (a plain type compares by object identity = NotImplemented, THEN tries `y.__eq__(x)`). `np.float64 == np.dtype('float64')` was `False` because numpy's `dtype.__eq__` — which coerces the scalar type to `dtype('float64')` — was never called (only `dtype == np.float64`, the other order, worked). Fix: when the left is a plain-metatype type, the operand is non-identical, and the RHS is not itself a plain-metatype type, try the RHS's reflected `__eq__`/`__ne__` and fall back to identity only if it returns NotImplemented; two bare types still compare by identity. Measured: numpy dashboard **+38** (`test_array_api_info` green + `dtype == scalar-type` comparisons across many suites — `test_multiarray`, `test_dtype`, `test_numerictypes`…); identity sanity intact (`float == int` False, `np.float64 == np.int32` False, `int == np.dtype(int)` True, `M == M` True).

- [x] **`divmod(x, y)` crashed on operands whose reflected `int` slot hit BigInt** (engine, `int.nb_divmod`). `divmod(np.array([-1,0,1,2]), 1)` raised `JavascriptError: Cannot mix BigInt and other types`: ndarray exposes no Python `__divmod__` (numpy uses the C `nb_divmod` slot, which the bridge doesn't surface), so `_b_.divmod`'s `rich_op('__divmod__', …)` fell through to the reflected `int` path, and `int.nb_divmod`'s inner `nb_floor_divide`/`nb_remainder` mixed a BigInt with the array. `_b_.divmod` already has the CPython fallback `[floordiv, mod]` but only on `TypeError`, and this was a raw JS error. Fix: `int.nb_divmod` wraps its body so a raw JS error yields `NotImplemented` (Python exceptions — e.g. `ZeroDivisionError` — are re-thrown), letting `rich_op` raise `TypeError` and `_b_.divmod` take its `[floordiv, mod]` fallback (both work). Measured: numpy dashboard `test_mixins.test_forward_binary_methods` green (18/19 ops already passed; `divmod` was the last); `divmod(arr,1)` == `np.divmod`; `divmod(5,0)` still `ZeroDivisionError`; test_math/decimal/statistics unchanged.

- [x] **float `format()`/f-string mishandled the `#` (alternate) flag and precision 0** (engine, `float.$format`'s `preformat`). Two roots. (1) The `prec==0` shortcut returned `Math.round(value)+""`, which ignored `#` (no trailing `.` for `f`), dropped the `%` suffix, and mis-handled `g`/`G` (CPython treats `.0g` as `.1g`). (2) The `g` branch chose fixed-vs-exponential and its decimal count from the UNROUNDED value's exponent (`preformat(self,{type:"e"})` = 6 sig figs), so when rounding to N sig figs crossed a power of ten (`0.9995`→`1.00`, exp −1→0) the decimal count was off by one. So `'{:#.0f}'.format(1023.4)`→`'1023'` (want `'1023.'`) and `'{:#.3g}'.format(0.9995)`→`'1.000'` (want `'1.00'`), killing numpy's `_ArrayMemoryError._size_to_string` (`test__exceptions`). Fix: (1) for prec 0, treat `g`/`G` as precision 1 (fall through), else round-to-int plus the `#` dot (`f`/`F`) and the `%` suffix; (2) take the exponent from `value.toExponential(fmt.precision-1)` — the value already rounded to `precision` sig figs — matching CPython. Measured: numpy dashboard `test__exceptions` green (`_size_to_string` 13/13); a node comparison against CPython over 1120 float-format specs closes the whole `#`/precision-0 family (160→16 diffs, the 16 remaining being a separate round-half-even issue in `Math.round`/`roundDownToFixed`, untouched). Numeric sweep unchanged: math 82 / cmath 32 / statistics 370 / json 170 / decimal 357.

- [x] **printf-style `%` rejected any non-int/float with `__float__`/`__index__`** (engine). `number_check` hard-required `isinstance(x, (int, float))`, so `'%.1f' % np.float64(2.5)` raised TypeError — CPython's `%f`/`%e`/`%g` go through `PyFloat_AsDouble` (accepts any `__float__`) and `%d`/`%x`/`%o`/`%c` through `PyNumber_Index`. Killed matplotlib's tick formatter (`ticker._format_maybe_minus_and_locale`). Fix: `number_check` converts through the matching dunder and returns the converted value; the three call sites (`num_format`, `_float_helper`, `octal_format`) consume it.

- [x] **`min()`/`max()` returned the LAST element when `__lt__` returns a non-bool** (engine). `$extreme` used `$B.rich_comp(op, …)` raw as a JS truthy — a bridge `np.bool_` (or any object with `__bool__`) is a JS object, always truthy, so every comparison "won": `min(pts[:, 0])` = last element. CPython calls `PyObject_IsTrue` on the comparison result. This zeroed matplotlib figures: `TransformedBbox.get_points` does `min(points[:, 0]), max(points[:, 0])` → min==max → every renderer was 0×0. Fix: `$B.$bool(...)` around both `rich_comp` sites. Minimal repro: a class whose `__lt__` returns an object with `__bool__`.

- [x] **`f(**mapping)` crashed on non-builtin-dict mappings** (engine). `parse_kwargs` fetched `getitem = $B.$getattr(cls, '__getitem__')` and called it as a bare JS function — for a dict subclass (or any mapping) that lookup returns a descriptor, not a JS function → "getitem is not a function". Hit by matplotlib's `_docstring` substitution (`template.format(**interpd.params)` at `import matplotlib.axes`). Fix: call through `$B.$call` when the lookup isn't a plain function.

- [x] **`str.split(sep, maxsplit)`: trailing empty field lost + latent double-push** (engine). The implementation delegates to JS `String.split(sep, limit)` (which TRUNCATES at limit) then re-appends the tail after the maxsplit-th separator — but only `if (pos < self.length)`, so `'a:'.split(':', 1)` returned `['a']` instead of CPython's `['a', '']` (broke matplotlibrc parsing: only 310 of 437 rc keys survived, `rcParams['figure.hooks']` KeyError killed `import matplotlib`). Worse, the re-append ran even when the JS split was NOT truncated (`maxsplit` larger than the number of separators), duplicating the last field. Fix: append (even an empty string) exactly when the counting loop hit maxsplit.

- [x] **`property.getter/setter/deleter` mutated the parent property** (engine). The three decorators did `self.prop_set = fset; return self` — CPython returns a NEW property. So `class B(A): @A.x.setter def x(...)` rewired A's OWN setter to B's, and any subclass setter that delegates with `A.x.fset(self, v)` recursed forever (matplotlib `OffsetBox.axes` @Artist.axes.setter → RecursionError building the first Figure). Fix: copy-on-decorate (`Object.assign({}, self)` + the changed slot).

- [x] **`$B.method.tp_hash` was an EMPTY STUB** (engine) — `hash(bound_method)` returned JS `undefined`, so weakref-keyed registries (matplotlib's `CallbackRegistry.connect` hashing a `WeakMethod`) crashed. Fix: CPython's `method_hash` — `(hash(im_self) ^ hash(im_func)) & 0x7FFFFFFF`.

- [x] **`tuple.tp_hash` / `$B.$hash`: BigInt hash values crashed the mix** (engine). A tuple element whose hash is a JS BigInt (any large-int-backed value) hit `y & 0xFFFFFFFF` → "Cannot mix BigInt and other types"; and a `__hash__` returning a big int hit the "should return an integer" guard. Both now fold BigInts to 32 bits (`Number(BigInt.asIntN(32, y))`), and `$hash` guards undefined/null before probing `is_big_int` (an empty tp_hash must still raise TypeError, not crash).

- [x] **`$B.$is_member` falls back to iteration when there is no `__contains__`** (engine) — CPython's `PySequence_Contains` protocol. `x in d.values()` raised "argument of type 'dict_values' is not a container or iterable" (matplotlib `validate_fonttype`); now it iterates with `is_or_equals`, returning False on StopIteration. One refinement mirrors CPython exactly: the old-protocol fallback only applies to real sequences — a C type whose `__getitem__` is MAPPING-only (the bridge's `$mp_only` tag) and that has no `tp_iter` still raises TypeError (sqlite3 `Blob` has `mp_subscript` but no `sq_item`; `"a" in blob` must raise, test_blob_sequence_not_supported).

- [x] **stdlib `threading`: `sys.flags.thread_inherit_context` read with a getattr default** (stdlib, threading.py in brython_stdlib.js). Brython's `sys.flags` lacks the 3.14 flag, so `Thread.start()` died with AttributeError — the 5 TestThreading failures in the scipy.ndimage dashboard (test_filters) and matplotlib's font_manager lock path. `getattr(_sys.flags, 'thread_inherit_context', 0)`.

- [x] **`make_descr_get` wraps a non-JS-function `__get__`** (engine, class creation). `$B.make_descr_get` copies the class dict's `__get__` STRAIGHT into `cls.tp_descr_get`; every call site then invokes it as a JS function (`local_get(attribute, _b_.None, obj)`). For a pure-Python class the dunder IS a JS function, but a class created through the C API with a C-implemented `__get__` (pandas' `MinMaxReso` descriptor in `timestamps.pyx`: a plain Python class defined inside a Cython module, its `__get__` a `cython_function_or_method` — a callable OBJECT, not a JS function) puts an object into the slot, and `pd.Timestamp.min` died with "JavascriptError: local_get is not a function" (blocking pandas' `_testing._hypothesis`, hence EVERY pandas test module importing `pandas._testing`). Fix: when the dict's `__get__` is not a JS function, store a wrapper routing through `$B.$call(get, self, obj→None, klass→None)` (mapping `$B.NULL`/undefined to None per the descriptor protocol). Same-shape latent siblings NOT touched (measure first): `make_descr_set` (`__set__`), `make_call` (`__call__`). Measured: pandas.tests.tslibs importable+running (test_ccalendar 17 collected vs IMPORT FAILED).

- [x] **complex arithmetic returns NotImplemented for non-number operands (no `__complex__` coercion)** (engine, `conv_complex`). `complex.nb_add/subtract/multiply` ran their other operand through `conv_complex`, which for anything that wasn't int/float looked up `__complex__` and CALLED it. CPython's complex arithmetic never does this — it accepts only int/float/complex and returns NotImplemented otherwise (the `__complex__` protocol is for the `complex()` constructor only). So `(1j) * ndarray` called `ndarray.__complex__()`, which raises "only 0-dimensional arrays can be converted to Python scalars" for a size>1 array, instead of returning NotImplemented and letting `ndarray.__rmul__` broadcast. Broke `1j * complex_array` and every numpy expression of that shape (`numpy.polynomial.polyutils.mapdomain` on complex domains, `test_umath_complex`). Fix: `conv_complex` handles complex/float/int and returns NULL (→ NotImplemented) for everything else. Measured: numpy dashboard test_polyutils + test_umath_complex green; test_cmath 32/0, test_math 82/0 unchanged.

- [x] **slice.indices() normalizes bounds through `__index__` before the JS math** (engine, `slice_funcs.indices`). The method read `self.start`/`self.stop`/`self.step` directly into raw JS comparisons (`_start < 0`, `_start + len`). Brython ints are JS numbers so this worked for them, but a boxed integer with `__index__` (a numpy `int32`/`int64` scalar — a bridge object with no `valueOf`) made `_start < 0` evaluate against `NaN` → false → the negative-index adjustment `_start += len` was SKIPPED, and `slice(np.int32(-1), None).indices(4)` came back `(np.int32(-1), 4, 1)` instead of `(3, 4, 1)`. numpy's C `PyArray_Subscript` calls this through the bridge's `PySlice_GetIndicesEx`, so `arr[np.int32(-1):]` on a (4,5) array returned shape (5,5) of garbage, and every `np.pad` mode that slices with computed numpy-int bounds (`wrap`, `reflect`, `symmetric`) produced empty/uninitialized results (test_arraypad). Fix: `nstart/nstop = PyNumber_Index(...)` (None-safe), `_step = PyNumber_Index(step)`, then run the existing normalization on those — identical for plain ints, correct for `__index__` scalars. Measured: numpy dashboard +23 (test_arraypad 574→597; every `np.pad` reflect/wrap/symmetric that computed negative numpy-int slice bounds).

- [x] **list subscripts accept anything with `__index__`** (engine, `py_list.js` area). `mp_subscript` rejected every non-int/slice key BEFORE reaching the `PyNumber_Index` call right below it — `lst[np.int32(1)]` raised "list indices must be integers or slices, not int32" (pandas' engines hand back numpy scalars as positions everywhere). The isinstance pre-check is gone; `PyNumber_Index` decides, and its failure raises the exact CPython message.

- [x] **len(): stray "VVV" debug marker removed from the no-`__len__` TypeError message** (engine).

- [x] **builtin_function_or_method: `__doc__` getset** (engine, `py_builtin_functions.js` area). The type's getsets stop at `__name__`/`__qualname__`/`__self__`/`__text_signature__` — no `__doc__` — so reading `__doc__` on ANY C builtin fell through the mro to OBJECT's docstring ("The base class of the class hierarchy…"). numpy.ma.core's `_convert2ma` asserts its `np_ret` marker is in `np.arange.__doc__` and got object's doc instead, killing `import numpy.ma` (and with it `from numpy import ma` in pandas.core.construction — the whole pandas boot on the browser page). The getset prefers an own `__doc__` property (a runtime `add_docstring` wins over the creation-time doc) and falls back to `$function_infos[func_attrs.__doc__]`; the setter is None (CPython: read-only).

- [x] **make_next: C-convention `tp_iternext` slots return the value, not a generator** (engine, wrapper methods). `make_next` built `__next__` as `cls.tp_iternext(obj).next()` — native Brython slots are JS generator FUNCTIONS, so calling them returns a generator. A bridge C-type's `tp_iternext` follows the CPython slot convention instead: it returns the next VALUE directly (its wrapper already raises StopIteration on NULL). Iterating any C iterator through Brython's `next()` died "itn.next is not a function" — numpy.ma's `MaskedIterator.__next__` calls `next(self.dataiter)` on a C `flatiter`. `make_next` now recognizes a generator by `.next` + `.throw` and passes anything else through as the value.

- [x] **object.tp_new: `__slots__` suppresses the instance `__dict__` only when the WHOLE mro is slotted** (engine, `py_object.js` area). The dict decision was `get_from_dict(cls, '__slots__') === NULL` — an mro-wide lookup, so a `__slots__ = ()` LEAF made instances dict-less even when every base is a plain class. CPython only drops the dict when every class below `object` is `__slots__`-only; a single slot-less class contributes it. pandas builds exactly that shape (SingleBlockManager: `__slots__=()` over plain DataManager/PandasObject bases), so `Series()` died "'SingleBlockManager' object has no attribute 'axes' and no __dict__ for setting". Now each class in `[cls] + mro` is checked for an OWN `__slots__`; classes with no queryable dict count as contributing (permissive for C bases). Strict slot classes still refuse attributes (`class C: __slots__ = ()` → AttributeError, unchanged).

- [x] **f-string tokenizer: nested replacement fields inside format specs** (engine, tokenizer). Three bugs in the `token_modes` stack, surfaced by pandas' `f"{x: .{precision:d}f}"` (io/formats/format.py — a replacement field inside a format spec carrying its own `:d` spec). (1) The `':' → format_specifier` switch compared `braces.length-1` against the nesting recorded at FSTRING_START, so a `:` inside a nested field (one brace deeper) never switched modes and its spec chars tokenized as NAMEs; each pushed `regular_within_ft` mode now records its own `braces.length` (and `nesting_level` finds the nearest). (2) The `'}'` branch symmetrically popped the expression mode on ANY closing brace, so a dict/set literal inside a field broke the mode stack — `f"{ {'a':1}['a'] }"` was "'{' was never closed"; same nesting guard, deeper braces fall through to the generic OP path. (3) `format_specifier` is a single variable, not a stack: popping from a nested spec back into the outer one (format_specifier → format_specifier, so the mode-change reset never fired) leaked the inner spec's text into the outer spec (`'.3df'` — "Invalid format specifier"); the `'}'` branch now resets it (plus no empty FSTRING_MIDDLE before a nested `{`). Token stream now matches CPython's `tokenize` exactly; 12-form battery (nested specs, dict literals, lambdas, nested f-strings) 12/12 against python3.

- [x] **PEG parser codegen: `$B.helper_functions.$B._PyPegen.PyErr_Occurred`** (engine, generated parser). Ten `invalid_*` rule actions reference `PyErr_Occurred` through a mangled `$B.helper_functions.$B.…` chain — `$B.helper_functions.$B` is undefined, so the SECOND parser pass (the one that produces the good error message after a parse failure) died with a raw JS TypeError instead of raising the SyntaxError. Any syntax error in an f-string rule crashed the parser instead of reporting. Now `$B._PyPegen.PyErr_Occurred`.

- [x] **property(): keyword arguments** (engine, `py_builtin_functions.js` area). `$B.$call` routes classes through `$factory` before `tp_call`, and `property.$factory(fget,fset,fdel,doc)` bound its parameters positionally — `property(fget=f, fset=g, doc='x')` (pandas accessor.py generates every delegated property this way) landed the kwargs object in `fget`, filled the rest with `?? None` positionally, and `tp_init`'s `$B.args` then saw both → "got multiple values for argument 'fset'". `$factory` now just delegates to `tp_init`, whose `$B.args` already parses kwargs.

- [x] **str %: a mapping RHS never requires conversion** (engine, `printf_format`). `"no specifier here" % {'name': 'x'}` raised "not all arguments converted during string formatting" — the final check treated `nbph == 0` as an error regardless of the RHS. CPython only enforces consumption for non-mapping RHS (a dict with zero placeholders is fine; `"abc" % "x"` still raises). This is pandas' `@Substitution(name="groupby")` on docstrings with no `%(name)s` — every GroupBy method decorator died. Now `nbph==0 && !is_mapping(args)`.

- [x] **frozenset - frozenset** (engine, set slots). `set.nb_subtract` required `self` to be a strict `set` while `nb_and`/`nb_or`/`nb_xor` all accept `[set, frozenset]` — frozenset inherits the slot and got refused, so `frozenset - frozenset` (pandas.core.computation.expr builds its node whitelists this way at import) raised "unsupported operand type(s)". Aligned with the other three; result type follows `self` as before.

- [x] **isinstance/issubclass: bound `__instancecheck__`/`__subclasscheck__`** (engine, `py_builtin_functions.js` area). The protocol lookup `type_getattribute(get_class(cls), '__instancecheck__')` returns a BOUND method when the metaclass defines it as a classmethod (pandas' `create_pandas_abc_type` — every ABCSeries/ABCDataFrame check), and the call site passed `cls` again → "takes 2 positional arguments but 3 were given" on every isinstance against a pandas ABC. If the lookup result carries `im_self` the receiver is already bound, call with the single remaining argument; plain metaclass functions and abc.ABC unchanged (4/4 against CPython).

- [x] **unicodedata.east_asian_width** (stdlib, `unicodedata` JS module). Missing entirely (the module's `unicode.txt` is UnicodeData.txt, which doesn't carry EastAsianWidth); `from unicodedata import east_asian_width` at the top of pandas.io.formats.printing killed the whole pandas.core.indexes chain. Added as a 317-range non-N table (Unicode 16.0.0, "start:end:width" hex triples, binary search) — 212 sampled code points match host CPython exactly; astral chars arrive as wrapped String objects, so the one-character guard uses `$B.$isinstance(unistr, _b_.str)`, not `typeof`.

- [x] **cmath: drop the `type(abs)(func)` re-badging** (stdlib, `Lib/cmath.py`). The module's epilogue rewrapped every public function via `type(abs)(f)` to cosmetically match CPython's `builtin_function_or_method` — but instantiating `builtin_function_or_method` is refused (CPython refuses it too), so plain `import cmath` raised TypeError cold (pandas `_libs.testing`'s Py_mod_exec imports cmath; the bundled C cmath masks this everywhere the full bundle is loaded). Block removed; the functions stay ordinary Python functions.

- [x] **type.tp_call: pass `instance` to a non-function `__init__`** (engine, `py_type.js` area). The init branch for a callable-but-not-JS-function `tp_init` (a Cython cyfunction `__init__`) called `$B.$call(init_func, ...args)` WITHOUT the freshly created instance — the first user argument arrived as `self`, so instantiating any Cython class-body class with `__init__(self, x)` died with "takes exactly 2 positional arguments (1 given)" (pandas timedeltas' `MinMaxReso("min")`, blocking the whole tslibs chain). The JS-function branch and the `tp_new` branch both pass the receiver; this one now does too.

- [x] **module.tp_setattro: subclasses delegate to object.tp_setattro (no descriptor `__get__` on assignment)** (engine, `py_module.js` area). `module.tp_setattro` located a data descriptor by calling `object.tp_getattro` — which INVOKES a class-level descriptor's `__get__`. For module SUBCLASSES with lazy attribute descriptors this is fatal: six's `_LazyDescr.__get__` itself does `setattr(module, name, resolved)` → tp_setattro → tp_getattro → `__get__` → infinite recursion (`import six` = RecursionError, killing dateutil.tz and everything above it). CPython's setattr never runs `__get__`; it type-lookups the descriptor raw and calls its `__set__` if any — exactly what `object.tp_setattro` already does (`search_in_mro` + `tp_descr_set`), so subclass instances now delegate straight to it; the getattro pre-pass survives only for plain modules (their getset shims).

- [x] **import machinery: `exec_module`/`load_module` called through `$B.$call`** (engine, import code). The module-from-spec path called `exec_module(module)` and `$B.$getattr(_loader,"load_module")(name)` as bare JS functions. For a PYTHON loader registered on `sys.meta_path` (six's `_SixMetaPathImporter`, the machinery behind every `six.moves.*` import) `$getattr` returns a Brython bound method — not callable as a JS function — so any package importing through six died with "exec_module is not a function". Both call sites now dispatch through `$B.$call` (which handles native loaders unchanged).

- [x] **_IOBase.tell: call the object's `seek` through `$B.$call`** (engine, `_IOBase` shim). `tell` did `$B.$getattr(self,'seek')(0,1)` — a bare JS call, broken for any PYTHON file-like object (a bound method comes back). dateutil's tzfile parser calls `tell()` on the stream it's handed; every gettz() died with "is not a function".

- [x] **mappingproxy.copy returns a dict, calls dict.copy through `$B.$call`** (engine). Two bugs in one line: `copy` invoked the `dict.copy` method-descriptor as a bare JS function, and wrapped the result back into a NEW mappingproxy — CPython's `mappingproxy.copy()` returns a plain (mutable) dict. six's `add_metaclass` / functools paths do `vars(cls).copy()` then `.pop()` on the result; the pop raised "mappingproxy object has no attribute 'pop'".

- [x] **sys: structseq slices are tuples** (stdlib, `Lib/sys.py`). `_dataclass.__getitem__` (the shared shape behind `version_info`, `flags`, `float_info`, …) returned a LIST for a slice key; CPython structseq slicing returns a tuple. six's `PY34 = sys.version_info[0:2] >= (3, 4)` raised `'>=' not supported between instances of 'list' and 'tuple'` — the first domino that kept dateutil.tz (hence pandas tslibs.timezones) from importing.

- [x] **zlib: `error` alias** (stdlib, `Lib/zlib.py`). The module defines `class Error(Exception)` but never the canonical `zlib.error` alias; tarfile's gzip error handling does `except zlib.error` and died with AttributeError before it could even report the real problem.

- [x] **zlib._Decompressor: stateful decompressobj (chunked input, max_length, eof/unused_data contract, rewind cache)** (stdlib, `Lib/zlib.py`). The pure-Python `_Decompressor.decompress` built a fresh `BitReader(data)` per call and inflated the whole stream in one shot — but gzip.py's `_GzipReader` (verbatim CPython) feeds a decompressobj in 8192-byte chunks, so ANY gzip member whose compressed size exceeds 8192 bytes died with the raw `Error('end of steam')` from the bit reader hitting the truncated chunk (dateutil's 156 KB zoneinfo tarball; the decoder itself is correct — a bare-node token-by-token comparison against a reference DEFLATE parser matched all 6522 tokens). The decompressor now accumulates input and retries with size-doubling backoff (an empty incoming chunk — EOF — forces a final attempt), serves the inflated output in `max_length` slices per the decompressobj contract (eof only when drained, `unused_data` = trailer + over-read bytes so `_read_eof` and multi-member gzip work), and keeps a 1-slot input→output cache so tarfile's backward seeks (gzip `_rewind` + full re-read per `extractfile`, ~600 members in the zoneinfo tarball) don't re-inflate 1.5 MB each time.

- [x] **_struct: pad alignment added a full size when already aligned** (stdlib, `Lib/_struct.py`). The native-mode alignment formula was `size - pos % size`, which yields `size` (not 0) whenever `pos` is already a multiple — so any format resuming after a pad (`"148B8x356B"`, tarfile's header checksum) read every subsequent group one byte late: `struct.unpack_from("3x2B", b'\\x01..\\x05')` returned `(5, 0)` instead of `(4, 5)`, and every tar header failed "bad checksum". All three sites (calcsize, pack, unpack) now use `-pos % size`.

- [x] **weakref: KeyedRef/WeakMethod `__slots__` dropped** (stdlib, `Lib/weakref.py`). Brython's `_weakref.ref` is pure Python and stores `obj`/`callback` in the instance dict; the stdlib's `KeyedRef.__slots__ = "key",` (and WeakMethod's) removes that dict, so creating any WeakValueDictionary entry raised "'KeyedRef' object has no attribute 'obj' and no __dict__" (dateutil tz caches). The subclass `__slots__` are disabled (renamed) — slightly larger instances, correct behaviour.

- [x] **type.tp_call: route a non-function `tp_new` through `$B.$call`** (engine, `py_type.js` area). `type.tp_call` calls `cls.tp_new` as a bare JS function; when a class's `__new__` is a C-object callable (a Cython cyfunction — pandas' `NaTType.__new__`), the slot holds a plain object and instantiation died with `Function.prototype.apply was called on #<Object>`. One added branch: if `tp_new` is not a JS function, call it through `$B.$call`, which dispatches via the object's class `tp_call`.

- [x] **typing._type_check: convert string constraints and RETURN the checked type** (stdlib, `Lib/typing.py`). Brython's `_type_check` was `assert isinstance(t, type), msg` — no `_type_convert` call and no return. Consequences: (1) any `TypeVar` with a string forward-reference constraint (pandas' `TypeVar("NumpyIndexT", np.ndarray, "Index")`) raised "constraints must be types" where CPython converts to `ForwardRef`; (2) every constrained TypeVar got `__constraints__ = (None, None, …)` since the checked values were dropped. Now: `t = _type_convert(t); assert isinstance(t, (type, ForwardRef)) or callable(t), msg; return t` — `_type_convert` (already present, never called) does the str→ForwardRef conversion.

- [x] **pickle.py: pure-Python `PickleBuffer` fallback when `_pickle` is absent** (stdlib, `Lib/pickle.py`). Brython's pickle.py carries the complete pure-python PickleBuffer machinery (`save_picklebuffer`, `buffer_callback`, NEXT_BUFFER opcodes) but the class itself only comes from `from _pickle import PickleBuffer` — on ImportError the whole feature is disabled (`_HAVE_PICKLE_BUFFER=False`) and `pickle.PickleBuffer` doesn't exist. numpy's `array_reduce_ex_picklebuffer` (the default-protocol dumps of every contiguous ndarray, since `DEFAULT_PROTOCOL=5` in 3.14) does `npy_cache_import_runtime("pickle", "PickleBuffer")` with NO fallback, so every `pickle.dumps(arr)` raised `AttributeError: PyObject_GetAttrString: 'PickleBuffer'` on pages without the C `_pickle`. The `except ImportError` branch now defines a minimal pure-Python `PickleBuffer` (wraps the buffer; `raw()`/`__buffer__` → `memoryview(self.obj)`, `release()`) and sets `_HAVE_PICKLE_BUFFER=True` — `save_picklebuffer` then serializes it in-band exactly like CPython's pure-python pickler with `buffer_callback=None` (writable buffers as bytearray, so unpickled arrays round-trip writable through numpy's `_frombuffer`). Needs the bridge's PEP 688 `__buffer__` on ndarray for `memoryview(ndarray)` to resolve. **numpy grand total +18 on top of the bridge commit (core+random: test_direct +10, test_smoke +6, test_generator_mt19937 +1, test_randomstate +1)**.

  ```python
  # Lib/pickle.py — the ImportError branch of `from _pickle import PickleBuffer`
  except ImportError:
      class PickleBuffer:
          def __init__(self, buffer):
              self.obj = buffer
          def raw(self):
              return memoryview(self.obj)
          def release(self):
              self.obj = None
          def __buffer__(self, flags=0):
              return memoryview(self.obj)
      __all__.append("PickleBuffer")
      _HAVE_PICKLE_BUFFER = True
  ```

## [x] hashlib rejects buffer-protocol objects (`expected bytes, got ndarray`)

**Impact: `hashlib.md5(numpy_array)` / `sha256(memoryview(...))` raised `TypeError: expected bytes, got ndarray` — CPython's hashlib accepts any buffer-protocol object.** `bytes2WordArray` (hashlib's CryptoJS module in `brython_stdlib.js`) only accepts `bytes`/`bytearray`. Fix: when the argument isn't bytes, materialize it through its `tobytes()` (memoryview, array.array, numpy ndarray all expose it) before the check.

```js
if(!$B.$isinstance(obj,[_b_.bytes,_b_.bytearray])){
    var tb = $B.$getattr(obj, 'tobytes', null)
    if(tb !== null){ obj = $B.$call(tb) }
    if(!$B.$isinstance(obj,[_b_.bytes,_b_.bytearray])){
        $B.RAISE(_b_.TypeError, "expected bytes, got " + $B.class_name(obj))
    }
}
```

```
>>> import hashlib, numpy as np
>>> hashlib.md5(np.arange(16, dtype=np.int8)).hexdigest()
'1ac1ef01e96caf1be0d329331a4fc2a8'
```

Measured: numpy grand total +4 (test_generator_mt19937's test_jumped hash comparisons).

---

## [x] `repr(complex)` prints integral components in full digits instead of switching to scientific notation

**Impact: `str(complex(1e20))` → `'(100000000000000000000+0j)'` (CPython: `'(1e+20+0j)'`) — numpy's test_print complex suite failed 6 tests because the numpy scalars printed CORRECTLY and the Brython `complex` reference they are compared against did not.** `complex.tp_repr` (py_complex.js) formats an integral component with `Number.isInteger(v) ? v + '' : str(v)` — JS `Number.toString()` only switches to exponent notation at 1e21, while CPython's float repr switches at 1e16. CPython's `complex_repr` formats each component with `PyOS_double_to_string(v, 'r', 0, 0, NULL)` — plain float repr WITHOUT the `.0` suffix. Fix: format both components through Brython's own (already CPython-exact) float `str`, then strip a trailing `.0` (the imag side already did the strip).

```js
// before
var real=Number.isInteger(self.real.value)? self.real.value+'' : _b_.str.$factory(self.real),
    imag=Number.isInteger(self.imag.value)? self.imag.value+'' : _b_.str.$factory(self.imag)
if(imag.endsWith('.0')){imag=imag.substr(0,imag.length-2)}
// after
var real=_b_.str.$factory(self.real),imag=_b_.str.$factory(self.imag)
if(real.endsWith('.0')){real=real.substr(0,real.length-2)}
if(imag.endsWith('.0')){imag=imag.substr(0,imag.length-2)}
```

```
>>> complex(1e16)
(1e+16+0j)
```

Measured: numpy dashboard +6 (test_print 6 complex tests flip). Numeric sweep clean — 8 suites 0 fails (re 154, pickle 941, decimal 357, pyexpat 58, math 82, cmath 32, statistics 370, json 170); numpy smoke 38/38.

---

## [x] stray debug `print('NotImplementedError for format')` in `annotationlib`

**Impact: cosmetic — numpy's lazy PEP-649 annotations (typing constructs in `numpy._typing`, `numpy.lib._arraysetops_impl`, `numpy.linalg._linalg`) each raise `NotImplementedError` in `annotationlib.call_annotate_function`, which then printed a debug line to stdout. `import numpy` spewed ~9 `NotImplementedError for format` lines onto every page (loader/numpy.html).** A leftover `print(...)` sits in the `except NotImplementedError:` arm of `annotationlib.get_annotations` (`Lib/annotationlib.py`, bundled in `brython_stdlib.js`); the exception is expected (it falls through to the `Format.STRING` path) so the print is pure noise. Removed the `print`, kept the `pass`.

```python
try:
    return annotate(format)
except NotImplementedError:
    print('NotImplementedError for format')   # before — debug leftover
    pass
# after:
try:
    return annotate(format)
except NotImplementedError:
    pass
```

---

## [x] `id()` collides across types — `id(42) == id('42')` (killed the pure-Python pickle memo)

**Impact: `_Pickler`'s memo is keyed by `id(obj)`; an int whose text matches an earlier-memoized str made a false memo hit, so the framed-writer roundtrip read the int `0` back as the string `'0'` (+2 pickle, the delayed-writer Py variants — the last of the framer family; general correctness for anything id-keyed).** Brython derives a primitive's id from `hash(str(value))` — the value's *text*, with no type in the mix, so `42` and `'42'` (and `True`/`'True'`) shared one id: two live, distinct objects with equal ids. The type's class name is now mixed into the hashed string. Source: `_b_.id` in `py_builtin_functions.js`.

```python
>>> id(42) == id('42')
True   # before
>>> id(42) == id('42')
False  # after
```

## [x] `object.__sizeof__` is an empty function — returns Javascript undefined (wasthon-only delegation)

**Impact: `object.__sizeof__(instance)` on a wasthon C instance must report the wasm struct basicsize (+ the ob_type pointer kept JS-side), CPython's `_PyObject_SIZE(Py_TYPE(self))` (+2 pickle SizeofTests with the bytes half and the bridge `_PySys_GetSizeOf` delegation; pickle's tests assert `object.__sizeof__(Pickler(...)) == support.calcobjsize(...)`).** `object_funcs.__sizeof__ = function(self){}` returned undefined for everything. The wasthon delegation reads `cls.__wasthon_basicsize__` (the spec value the bridge stores on the class) + 4; non-wasthon objects keep the old behaviour. ⚠ VENDORED-ONLY as written (the `__wasthon_basicsize__` half lives in the bridge); the upstreamable piece would be a generic `object.__sizeof__`, separate work.

```python
>>> import pickle, io
>>> object.__sizeof__(pickle.Pickler(io.BytesIO()))
<Javascript undefined>  # before
>>> object.__sizeof__(pickle.Pickler(io.BytesIO()))
88                      # after (wasm32-canonical, matches support.calcobjsize('7P2n3i2n4i2P'))
```

## [x] `bytes` has no `__sizeof__` — `sys.getsizeof(b'…')` raises TypeError

**Impact: any code sizing a bytes object; pickle SizeofTests measures the Pickler's output buffer via `sys.getsizeof(b'x'*4096)` (+ part of the +2 above).** bytes.tp_methods had no `__sizeof__` at all (str got one during the array sizeof work, bytearray has a stub). Added the CPython-canonical 64-bit value (33 + len), the same ruler as the vendored `str.__sizeof__` — Brython-side objects report 64-bit sizes per the platform-width seam (README hard rules).

```python
>>> import sys
>>> sys.getsizeof(b'x' * 4096)
TypeError: Type bytes doesn't define __sizeof__  # before
>>> sys.getsizeof(b'x' * 4096)
4129                                             # after
```

## [x] backslash-newline in an f-string literal part is kept instead of vanishing (line continuation)

**Impact: any f-string using `\`-at-end-of-line — pyexpat's MemoryProtectionTest builds its billion-laughs payload with `textwrap.dedent(f"""\ …` and the stray `\<newline>` prefix made expat reject the document at line 1 column 0 (+12 pyexpat with the expat 2.8.2 bump; general correctness).** In the tokenizer's f-string mode, a `\` arms `ft_escape` and the *next* char is pushed with the backslash re-emitted — a real newline included, so the emitted literal kept `\<newline>` where CPython's tokenizer eats the continuation. Plain strings were fine (their whole token goes through `prepare_string`); every f-string form (`f"…"`, `f"""…"""`, mid-string) was wrong. Fix: in the ft-mode escape path, a newline following the escape backslash is consumed (buffer untouched, `line_num++`). Raw f-strings are unaffected (`ft_escape` is never armed in raw mode). Source: the tokenizer's `token_mode=='ft'` block in `py_tokenizer.js`-generated code.

```python
>>> f"""\
... x"""
'\\\nx'                                                    # before
>>> f"""\
... x"""
'x'                                                        # after (CPython-exact)
```

## [x] `__import__` of a missing module raises a bare-name `ImportError`, not `ModuleNotFoundError("No module named …")`

**Impact: importing a nonexisting module raises the CPython exception class and message (pickle test_global_lookup_error asserts both via `str(exc)`/`__context__`; general).** `import_error(mod_name)` raised `ImportError(mod_name)` — `args[0]` was just the bare name, and the class was the parent `ImportError`. Everything that formats the exception (pickle's `Can't pickle X: %S`, tracebacks, `str(exc)`) printed `nonexisting` instead of `No module named 'nonexisting'`. Source: `import_error` in `py_import.js`.

```python
>>> __import__('nonexisting')
ModuleNotFoundError: nonexisting                           # before
>>> __import__('nonexisting')
ModuleNotFoundError: No module named 'nonexisting'         # after
```

## [x] `AttributeError` on a module says `'module' object`, not `module '<name>'`

**Impact: a failed module attribute lookup names the module (pickle's save_global `__context__` asserts the exact string; general).** `$B.attr_error` had no module branch, so every module getattr failure read `'module' object has no attribute 'x'` where CPython says `module 'os' has no attribute 'x'`. The module branch must read `__name__` through `$B.module_getattr` — a Brython module's `__name__` lives in its dict, not as a direct JS property. Source: `$B.attr_error` in `py_exceptions.js`.

```python
>>> import picklecommon
>>> picklecommon.spam
AttributeError: 'module' object has no attribute 'spam'          # before
>>> picklecommon.spam
AttributeError: module 'picklecommon' has no attribute 'spam'    # after
```

## [x] a deleted `function.__module__` leaks `$B.NULL` as a `JSObject` value

**Impact: after `del f.__module__`, reading the attribute raises `AttributeError` instead of returning an internal sentinel (pickle whichmodule then crashed with `JavascriptError: mod_name.split is not a function`; general).** `function_funcs.__module___get` (and the legacy `module_get`) returned the raw `$function_infos` slot; after a `del` that slot holds `$B.NULL`, which surfaced to Python as a `JSObject` — `getattr(f, '__module__', None)` returned `[object Object]`, pickle's whichmodule took it as a module name and `__import__` crashed. The getters now raise `$B.attr_error('__module__', f)` when the slot is `$B.NULL`/undefined. Source: `py_functions.js`.

```python
>>> def f(): pass
...
>>> del f.__module__
>>> getattr(f, '__module__', None)
<Javascript object: [object Object]>  # before
>>> getattr(f, '__module__', None)
None                                  # after
```

## [x] `getattr(obj, name, default)` propagates an `AttributeError` raised inside a descriptor

**Impact: the 3-arg `getattr` swallows an `AttributeError` raised anywhere in the lookup — including inside a getset/property `__get__` — and returns the default.** `_b_.getattr` passed the default down to `$B.$getattr`, which only applies it when the *lookup* misses; an `AttributeError` thrown by the descriptor itself propagated. Combined with the `__module__` fix above, `getattr(f, '__module__', None)` raised instead of returning `None`. `_b_.getattr` now wraps the call and returns the default on `AttributeError`. Source: `_b_.getattr` in `py_builtin_functions.js`.

```python
>>> def f(): pass
...
>>> del f.__module__
>>> getattr(f, '__module__', None)
AttributeError: 'function' object has no attribute '__module__'  # before
>>> getattr(f, '__module__', None)
None                                                             # after
```

## [x] `save_picklebuffer` memoized a throwaway `tobytes()` instead of the `PickleBuffer` ⚠ VENDORED-ONLY

**Impact: the Python pickler dumping the same `PickleBuffer` twice writes a back-reference the second time instead of the data again, so the loaded pickle shrinks and both references share one object (+2 pickle, test_picklebuffer_memoization).** Brython's in-band `save_picklebuffer` computed `in_memo = id(buf) in self.memo` where `buf = m.tobytes()` — a fresh throwaway `bytes` each call, never in the memo — and memoized *that* via `save_bytes(buf)`/`save_bytearray(buf)`, never the `PickleBuffer` `obj`. So `_Pickler.dump((b, b))` serialized the data twice and the two loaded buffers came back distinct (`assertIs` failed). It now matches CPython 3.14.6 (gh-148914): write the data with `_save_bytes_no_memo`/`_save_bytearray_no_memo`, then `self.memoize(obj)`. Source: `save_picklebuffer` in `Lib/pickle.py`.

```python
>>> import io, pickle
>>> b = pickle.PickleBuffer(bytearray(b'xyz'))
>>> f = io.BytesIO()
>>> pickle._Pickler(f, 5).dump((b, b))
>>> len(f.getvalue())
40  # before
>>> len(f.getvalue())
29  # after
```

⚠ VENDORED-ONLY — vanilla Brython has no `PickleBuffer` (`from _pickle import PickleBuffer` fails → `_HAVE_PICKLE_BUFFER = False`, so `pickle.PickleBuffer` raises `AttributeError` and `save_picklebuffer` is dead code); only wasthon reaches this path, since its bridge exposes `_pickle.PickleBuffer`.

## [x] `codecs.escape_decode` was a stub returning `None`

**Impact: `codecs.escape_decode(b'a\\nb')` decodes the escapes, and a trailing backslash raises `ValueError` (+3 pickle, test_badly_escaped_string + proto-0 STRING; general).** The function was `def escape_decode(*args, **kw): pass`, so it returned `None` — pickle's proto-0 `STRING` opcode (`codecs.escape_decode(data)[0]`) then did `None[0]` → `TypeError: 'NoneType' object is not subscriptable` (any old-style string pickle), and a badly-escaped string raised that `TypeError` instead of `ValueError`. It now decodes the C-style escapes (`\n \t \r \\ \' \" \a \b \f \v`, `\xHH`, octal `\ooo`, unknown escapes kept literally) and raises `ValueError` on a trailing backslash. Source: `escape_decode` in `_codecs` (`Lib/_codecs.py`-equivalent). The C `_pickle` unpickler has its own C escape decode, so its STRING path is unaffected.

```python
>>> import codecs
>>> codecs.escape_decode(b'a\\nb')
TypeError: 'NoneType' object is not subscriptable  # before
>>> codecs.escape_decode(b'a\\nb')
(b'a\nb', 4)                                        # after
```

## [x] `__import__('')` crashes instead of raising `ValueError`

**Impact: `__import__('')` raises `ValueError: Empty module name` (+3 pickle, test_load_global/test_load_stack_global; general).** An empty module name fell through to the path-entry finder, whose `find_spec` does `fullname.match(/[^.]+$/g)[0]` — for `''` the match is `null`, so `[0]` threw a `JavascriptError` (`fullname.match(...) is null`). CPython's `__import__` sanity-checks the name first (`if not name and level == 0: raise ValueError('Empty module name')`). `__import__` now does the same, so pickle's `find_class` on an empty module name raises a normal `ValueError` instead of a JS crash. Source: `_b_.__import__` in `py_import.js`.

```python
>>> __import__('')
JavascriptError: can't access property 0, fullname.match(...) is null  # before
>>> __import__('')
ValueError: Empty module name                                         # after
```

## [x] `object.__new__` doesn't allocate a wasthon C type's struct ⚠ VENDORED-ONLY

**Impact: `sqlite3.Connection.__new__(Connection)` (and any explicit `__new__` on a C type) gets a real zeroed C struct (+1 sqlite3, test_uninit_operations).** Brython's `object.tp_new` returns a bare `{ob_type: cls}` JS object. For a wasthon C type (`cls.__wasthon_type_handle__` set), `object.__new__` must instead allocate the C struct — like CPython's `object_new` calling `type->tp_alloc` — so C code that casts the instance and reads struct fields sees a zeroed struct, not stale heap (the uninit guard otherwise misfired with index-OOB / a thread-id mismatch). `object.tp_new` now dispatches to the bridge's leaf allocator `$B.$wasthon_new_instance(cls)` (mallocs+zeroes the struct, never calls `cls.tp_new`, so no recursion) for such types; all other classes are unchanged. Source: `object.tp_new` in `py_object.js`.

⚠ VENDORED-ONLY — `cls.__wasthon_type_handle__` and `$B.$wasthon_new_instance` exist only with wasthon's bridge; vanilla Brython has no C structs, so the branch never fires.

## [x] a class with `'__dict__'` in `__slots__` gives no instance `__dict__` at `__new__`

**Impact: `C.__new__(C).__dict__ == {}` when `C.__slots__` contains `'__dict__'` (+5 pickle; general).** `object.__new__` calls `init_dict` only when the class has no `__slots__` at all, so a class that opts back into a per-instance dict via `'__dict__'` in `__slots__` got none on a bare `__new__` instance. `setattr` created one lazily, but pickle's `load_build` writes `inst.__dict__[k] = v` directly — so unpickling a `WithSlotsAndDict` (slots + dict) crashed with `'UndefinedType' object does not support item assignment` (`test_object_with_slots`). `__new__` now also inits the dict when `cls.$slots_has_dict` (the flag already set when `'__dict__'` is in `__slots__`); pure-`__slots__` classes still get none. Source: `object.tp_new` in `py_object.js`.

```python
>>> class C:
...     __slots__ = ('a', '__dict__')
>>> C.__new__(C).__dict__
<undefined>  # before
>>> C.__new__(C).__dict__
{}           # after
```

## [x] subclasses of `set`/`frozenset` aren't picklable with instance attributes

**Impact: a `set`/`frozenset` subclass instance takes attributes and round-trips through pickle (+3 pickle; general).** Two gaps: (1) `set.tp_new`/`frozenset.tp_new` didn't `init_dict` a subclass instance (`list`/`dict`/`float`/`tuple`/`bytes` do), so `MySet().foo = 1` failed (no instance dict); (2) `set.__reduce__` hard-coded the state slot to `None`, dropping the instance `__dict__`, so even once the dict existed the attribute was lost on round-trip — CPython's `set_reduce` returns `(cls, (list(self),), self.__dict__)`. Now both tp_news `init_dict` a strict subclass (base `set`/`frozenset` keep none) and `__reduce__` returns the instance dict as state when non-empty (`test_newobj_generic`). Source: `set.tp_new`, `frozenset.tp_new`, `set.__reduce__` in `py_set.js`.

```python
>>> class S(set): pass
>>> s = S([1, 2]); s.foo = 9; import pickle; pickle.loads(pickle.dumps(s)).foo
AttributeError  # before
>>> s = S([1, 2]); s.foo = 9; import pickle; pickle.loads(pickle.dumps(s)).foo
9               # after
```

## [x] `memoryview` contiguity getsets read a never-set field; `toreadonly` returns `None`

**Impact: `memoryview(b'x').contiguous` is `True`, and `m.toreadonly()` is a usable readonly view (+11 pickle protocol-5 buffers, with the bridge `PickleBuffer.raw()` fix; general).** The `c_contiguous`/`contiguous`/`f_contiguous` getsets returned `self.flags & …`, but the constructor never sets `self.flags` — it sets the direct boolean props `self.c_contiguous`/`self.contiguous`/`self.f_contiguous` (and clears them for a strided slice). So every contiguous view reported `0`, which made pickle's `save_picklebuffer` (`if not m.contiguous: raise`) reject a plain bytes buffer as non-contiguous. The getsets now read those direct props. Separately, `memoryview.toreadonly()` mutated `self.readonly` and returned `None`; it now returns a new readonly view (`load_readonly_buffer` does `self.stack[-1] = m.toreadonly()`). Source: `memoryview_funcs.{c_contiguous,contiguous,f_contiguous}_get` + `toreadonly` in `memoryobject.js`.

```python
>>> memoryview(b'xyz').contiguous
0     # before
>>> memoryview(b'xyz').contiguous
True  # after
```

## [x] `int.to_bytes` overflows to `Infinity` for a large signed negative int

**Impact: `(-n).to_bytes(length, signed=True)` works for any length (+2 pickle, `test_long`; general).** Encoding a negative int adds the two's-complement bias `256**length`, computed as `BigInt(Math.pow(256, length))` — but `Math.pow(256, length)` overflows the JS double to `Infinity` once `length` exceeds ~128, and `BigInt(Infinity)` raises `Infinity can't be converted to BigInt`. Now uses exact BigInt exponentiation `256n ** BigInt(length)`. Surfaced by pickling a ~1M-bit negative int. Source: `int_funcs.to_bytes` in `py_int.js`.

```python
>>> (-(1 << 2048)).to_bytes(257, "big", signed=True)
JavascriptError: Infinity can't be converted to BigInt   # before
>>> (-(1 << 2048)).to_bytes(257, "big", signed=True)
b'...'                                                    # after
```

## [x] a `str`/`int`/`float` subclass instance shares its `id()` with its value

**Impact: `id(MyStr("x")) != id("x")` and two distinct `MyStr("x")` get distinct ids (+4 pickle, `test_newobj_generic` MyStr/MyUnicode/… × picklers; general identity).** `id()` derived a value-based id (`hash(str(obj))`) for *anything* that is an instance of `str`/`int`/`float`, to give the JS primitives (which can't carry an id property) a stable identity — but that also caught subclass *wrappers*, which are real objects with their own identity, so two distinct `MyStr("x")` collided on one id. This broke pickling a `str`/`int`/`float` subclass with instance attributes: the pickler memoizes the value string while saving the reduce args, then after `REDUCE` finds the reconstructed instance "already in the memo" (same id), discards it (`POP`) and fetches the bare value back (`GET`) — so the loaded object is a plain `str`/`int`/`float` and applying the `__dict__` state crashes (`'str' object has no attribute '__dict__'`, protocols 0–3). `id()` now value-identifies only JS primitives and base `float`; a subclass instance falls through to a per-instance UUID like any other object. Source: `_b_.id` in `py_builtin_functions.js`.

```python
>>> class MyStr(str): pass
>>> id(MyStr("x")) == id("x")
True   # before
>>> id(MyStr("x")) == id("x")
False  # after
```

## [x] a method of a nested class gets a truncated `__qualname__`

**Impact: `PyMethodsTest.Nested.ketchup.__qualname__ == 'PyMethodsTest.Nested.ketchup'` (with the next fix, +5 pickle, `test_py_methods` × all picklers; general).** The compiler computes a function's `__qualname__` from its *immediate* enclosing class only (`func_name_scope.name + '.' + name`), so a method of a class nested in another class got `'Nested.ketchup'` instead of `'PyMethodsTest.Nested.ketchup'` — `ClassDef.to_js` already walks every enclosing `ClassDef` scope to build a class's own qualname, but `FunctionDef.to_js` did not. Pickling such a method saves it by reference and looks it up under its `__qualname__`, so the wrong (short) name failed (`Can't pickle <function Nested.ketchup>: it's not found as picklecommon.Nested.ketchup`). `FunctionDef.to_js` now walks the enclosing class scopes the same way. Source: `$B.ast.FunctionDef.prototype.to_js`.

```python
>>> class A:
...     class B:
...         def f(self): pass
>>> A.B.f.__qualname__
'B.f'    # before
>>> A.B.f.__qualname__
'A.B.f'  # after
```

## [x] `staticmethod`/`classmethod`/`memoryview` are picklable at protocol >= 2

**Impact: `pickle.dumps(staticmethod(f), 2)` raises `TypeError: cannot pickle 'staticmethod' object` (with the qualname fix above, +5 pickle, `test_py_methods` × all picklers; general).** A non-heap builtin type whose nearest non-heap base is itself and which offers no `__getnewargs__` has no reconstruction path: `copyreg._reduce_ex` already raises `cannot pickle <cls> object` for protocol < 2 (its `base is cls` branch), but `object.__reduce_ex__` for protocol >= 2 built a `__newobj__` reduce regardless, so `staticmethod`, `classmethod`, `memoryview`, generators… pickled instead of raising (the C `_pickle` reaches the same `object.__reduce_ex__`, so both picklers were affected). `object.__reduce_ex__` now applies the same guard at protocol >= 2 (nearest non-heap base — `$B.is_builtin_type` — is the class itself, and no `__getnewargs__`). Source: `object_funcs.__reduce_ex__` in `py_object.js`.

```python
>>> import pickle
>>> pickle.dumps(staticmethod(len), 2)
b'...'                               # before (wrongly pickled)
>>> pickle.dumps(staticmethod(len), 2)
TypeError: cannot pickle 'staticmethod' object   # after
```

## [x] `weakref.proxy` objects aren't picklable

**Impact: `pickle.dumps(weakref.proxy(x))` round-trips to a copy of the referent (+5 pickle, `test_newobj_proxies` × all picklers).** CPython's weakproxy forwards `__reduce_ex__` and `__class__` to the referent, so pickling a proxy reduces the *referent* via NEWOBJ using the referent's `__class__`, not the raw weakproxy type (hence the test comment "NEWOBJ should use the `__class__` rather than the raw type"). Brython's pure-Python `ProxyType` forwards arbitrary attributes through `__getattr__`, but `__getattr__` only fires on lookup failure — `__reduce_ex__`, `__reduce__` and `__class__` are all inherited from `object`, so they were never forwarded: the proxy tried to pickle *itself*, and wasthon's C `_pickle` rejected it (`first argument to __newobj__() must be ProxyType, not MyFloat`). `ProxyType` now explicitly forwards `__reduce_ex__`/`__reduce__` to the referent and exposes the referent's type through a `__class__` property. Source: `class ProxyType` in `_weakref.py`.

```python
>>> import weakref, pickle
>>> class MyList(list): pass
>>> x = MyList([1, 2, 3]); x.foo = 42
>>> type(pickle.loads(pickle.dumps(weakref.proxy(x))))
PicklingError       # before
>>> type(pickle.loads(pickle.dumps(weakref.proxy(x))))
<class 'MyList'>    # after
```

## [x] setting `cls.__qualname__` doesn't update what the getter reads

**Impact: `cls.__qualname__ = 'X'; cls.__qualname__ == 'X'` (+10 pickle; general).** `type.__qualname___get` reads `__qualname__` from the class dict, but `type.__qualname___set` wrote `cls.tp_name` instead — so after `cls.__qualname__ = 'X'` the getter still returned the auto-computed qualname (the dict stayed stale) while `repr(cls)` (which uses `tp_name`) did show `'X'`. pickle reads `obj.__qualname__` through the getter, so a class with a reassigned `__qualname__` (e.g. the self-referential ones in the regression tests) was looked up under the wrong name and failed (`test_recursive_nested_names`/`2`, all picklers). The setter now writes the dict (where the getter reads) in addition to `tp_name`. Source: `type_funcs.__qualname___set` in `py_type.js`.

```python
>>> class C: pass
>>> C.__qualname__ = 'A.B.C'
>>> C.__qualname__
'C'  # before
>>> C.__qualname__
'A.B.C'  # after
```

## [x] subclasses of `bytes`/`bytearray` get no instance `__dict__`

**Impact: `class B(bytes): pass; B().__dict__ == {}` (+2 pickle; general).** `list`, `dict`, `float` and `tuple` all call `$B.init_dict(instance)` in their `tp_new` when `cls` is a subclass, so a heap subclass gets an instance dict; `bytes.tp_new` (and `bytearray.tp_new`, which delegates to it) did not, so `MyBytes().__dict__` / `MyBytearray().__dict__` was `undefined` — attributes couldn't be set, and pickling a subclass instance failed `assert_is_copy` (it compares `obj.__dict__`). `bytes.tp_new` has several return points, so it's wrapped to `init_dict` the result when `cls` is neither `bytes` nor `bytearray` (covering both families through the bytearray→bytes delegation); the base types keep no `__dict__`, as in CPython. Source: `bytes.tp_new` in `py_bytes.js`.

```python
>>> class B(bytearray): pass
>>> B().__dict__
<undefined>  # before
>>> B().__dict__
{}  # after
```

## [x] `type.__module__` returns the getset descriptor instead of `'builtins'`

**Impact: `type.__module__ == 'builtins'`, so pickling `type` (and types reduced through it) works (+7 pickle; general).** `type.__module___get` reads `__module__` from the class dict and returns it as-is. For every normal class the dict holds the module string, but `type.__dict__['__module__']` is the `__module__` getset descriptor itself (`<attribute '__module__' of 'type' objects>`, exactly as CPython) — and `type` is its own metaclass, so the getter returned that descriptor instead of `'builtins'`. This broke `pickle.dumps(type)`: `whichmodule` got the descriptor as the module name and `__import__(descriptor)` blew up (`mod_name.split is not a function`), which in turn broke pickling the singleton *types* `type(None)`/`type(...)`/`type(NotImplemented)` (reduced as `(type, (None,))` etc. — `test_singleton_types`). A module name is always a string, so the getter now returns the dict value only when it is a string, else falls through to `'builtins'`. Source: `type_funcs.__module___get` in `py_type.js`.

```python
>>> type.__module__
<attribute '__module__' of 'type' objects>  # before
>>> type.__module__
'builtins'  # after
```

## [x] `str` case/predicate methods delegate to wasthon's CPython Unicode tables ⚠ VENDORED-ONLY

**Impact: `str.upper/lower/title/casefold` and `is*` are CPython-exact (+1 unicodedata test_method_checksum, with the surrogatepass fix below).** Brython's own Unicode tables (`unicode_data.js` categories, JS `toUpperCase`/`toLowerCase`) diverge from CPython on ~2400 codepoints, so the checksum over every codepoint's case/predicate results failed. When wasthon's bridge has installed `$B.$wasthon_unicode` (CPython's `unicodectype` tables — see CHANGELOG), these methods now delegate to it per codepoint: predicates read the bit-packed `flags(cp)` (with the CPython `cased`/`case-ignorable` semantics for `islower`/`isupper`/`istitle`), case methods use the full 1→N `upper/lower/title/fold(cp)`, and `lower`/`title` apply CPython's word-final `Σ`→`ς` (`Final_Sigma`) via the cased/case-ignorable flags + a lookbehind/lookahead. Each method falls back to Brython's own logic when `$B.$wasthon_unicode.available()` is false. Source: `str_funcs.{upper,lower,title,casefold,isalpha,isdecimal,isdigit,isnumeric,islower,isupper,istitle,isspace,isalnum}` in `py_string.js`.

⚠ **VENDORED-ONLY — no upstream PR.** The delegation only works because wasthon links CPython's `unicodectype` tables and exposes them as `$B.$wasthon_unicode`; vanilla Brython has no such hook, so this is a wasthon-architecture change, not a portable Brython fix. (The companion surrogatepass-encode fix below IS a real Brython bug → upstreamable.)

## [x] `str.encode('utf-8', 'surrogatepass')` replaces lone surrogates with U+FFFD

**Impact: `'\ud800'.encode('utf-8', 'surrogatepass')` yields the WTF-8 bytes, not the replacement char (+1 unicodedata via test_method_checksum, +2 pickle; general).** Brython's `$B.encode` utf-8 path uses `new TextEncoder('utf-8', {fatal:true})`, but JS `TextEncoder` always replaces a lone surrogate with U+FFFD (`{fatal}` only affects *decoding*), so `'\ud800'.encode('utf-8','surrogatepass')` returned `b'\xef\xbf\xbd'` instead of CPython's `b'\xed\xa0\x80'`. (Its manual fallback loop only ran when `TextEncoder` is absent, and it can't reach astral — it logs `"4 bytes"`.) A `surrogatepass` branch now bypasses `TextEncoder` and encodes by hand: a valid surrogate PAIR → 4-byte UTF-8, a LONE surrogate → its 3-byte WTF-8 (`ED A0..BF 80..BF`), like CPython's surrogatepass handler. Source: `$B.encode` (utf-8 case) in `py_bytes.js`.

```python
>>> '\ud800'.encode('utf-8', 'surrogatepass')
b'\xef\xbf\xbd'  # before
>>> '\ud800'.encode('utf-8', 'surrogatepass')
b'\xed\xa0\x80'  # after
```

## [x] `str.encode('utf-8')` (strict) silently substitutes U+FFFD for a lone surrogate instead of raising

**Impact: `'\ud800'.encode('utf-8')` raises `UnicodeEncodeError: ... surrogates not allowed`, as CPython does (general Brython correctness; same PR as the surrogatepass fix above).** The default strict handler shares the `new TextEncoder('utf-8', {fatal:true})` path — but `{fatal}` is a `TextDecoder`-only option, so `TextEncoder` never throws and replaces a lone surrogate with U+FFFD, returning `b'\xef\xbf\xbd'` where CPython raises. A `strict` guard now scans for a surrogate code unit (via the same regex/`codePointAt` that distinguishes a lone surrogate from a combined astral pair) and raises `UnicodeEncodeError`; valid astral characters (`'\U00010e6d'`) and plain text are untouched. The `$UnicodeEncodeError` helper gains an optional `reason`. Source: `$B.encode` (utf-8 case) + `$UnicodeEncodeError` in `py_bytes.js`.

```python
>>> '\ud800'.encode('utf-8')
b'\xef\xbf\xbd'  # before
>>> '\ud800'.encode('utf-8')
UnicodeEncodeError: 'utf-8' codec can't encode character '\ud800' in position 0: surrogates not allowed  # after
```

## [x] `float.__hash__` uses the legacy 32-bit algorithm, disagreeing with `int`/`Fraction`/`Decimal`

**Impact: `hash(2.5) == hash(Fraction(5, 2)) == hash(Decimal('2.5'))` (enables +1 decimal of the hash cluster; general Brython correctness).** Brython's `float.$hash_func` computes a non-integer float's hash with the pre-3.x algorithm (`frexp` → `hipart + parseInt(...) + (exp << 15)`, then `& 0xFFFFFFFF`), a 32-bit value. But its `int_hash` already uses CPython 3's `2**61-1` modulus (and the function even hard-codes the 61-bit hash of `MAX_VALUE`), so `hash(2.5) = 1342242816` while `hash(Fraction(5, 2)) = 1152921504606846978` — Python requires numerically-equal `int`/`float`/`Fraction`/`Decimal` to hash equal. Replaced the non-integer branch with CPython 3's `_Py_HashDouble`: a modular base-`2**61-1` reduction (`frexp`, pull 28 bits per loop in BigInt, rotate, then shift by the exponent mod 61, sign, `-1`→`-2`). The integer-valued and `inf`/`nan`/`MAX_VALUE` fast paths are unchanged. Source: `float.$hash_func` in `py_float.js`.

## [x] `sys.hash_info` reports 32-bit (`width=32, modulus=2**31-1`) but hashing is 61-bit

**Impact: `_pydecimal`'s hash matches `hash(int)` (+1 decimal); `sys.hash_info` no longer lies.** `sys.hash_info` is built with `width=32, modulus=2147483647` (`2**31-1`), yet Brython's actual `int`/`float` hashing uses `2**61-1` (a 64-bit CPython's modulus). Code that reads `sys.hash_info.modulus` to stay consistent with the hash protocol then computes the wrong thing — the pure-Python `_pydecimal.Decimal.__hash__` reduced mod `2**31-1`, so `hash(Decimal(n)) != hash(n)`. Corrected to `width=64, modulus=2305843009213693951` (`2**61-1`), matching the real `int_hash`/`_Py_HashDouble`. Source: `hash_info = make_dataclass('hash_info')(...)` in the `sys` module (`brython_stdlib.js` VFS / `Lib`).

## [x] `inspect.signature` can't read a C `__text_signature__` (empty getters + tokenizer rejects `$`)

**Impact: `inspect.signature` works on wasthon's C `_decimal` functions/types (+2 decimal).** Two companions to a bridge change that finally exposes C clinic text signatures (see CHANGELOG `ml_doc`/`tp_doc`). (1) The `__text_signature___get` getters on `type`, `method_descriptor`, `classmethod_descriptor`, `method_wrapper` and `builtin_function_or_method` were empty stubs returning `undefined`; they now return a stored `self.$text_signature` (the bridge sets it from the C docstring). ⚠ **VENDORED-ONLY** — nothing in vanilla Brython populates `$text_signature`. (2) `inspect._signature_strip_non_python_syntax` tokenizes the signature to find the clinic `$self`/`$module` marker, but Brython's tokenizer raises on `$` (it emits a `SyntaxError` ERRORTOKEN, where CPython emits an `OP`), so the function crashed (`can't access property "lineno"`) on every clinic signature. It now strips the leading `$` textually (its parameter index is the comma count before it) before tokenizing. Source: `*_funcs.__text_signature___get` in the engine + `_signature_strip_non_python_syntax` in `inspect.py`.

## [x] `_pydecimal`'s format mini-language is stale vs CPython 3.14

**Impact: `format(Decimal, '.01f')` and CPython 3.14's fractional-grouping specs work (+1 decimal).** Brython's bundled `_pydecimal` predates two CPython 3.14 format changes. (1) Its spec regex forbade a leading zero in the precision/width (`(?P<precision>0|(?!0)\d+)`, `(?P<minimumwidth>(?!0)\d+)`), so `format(Decimal('3.14'), '.01f')` raised `ValueError: Invalid format specifier`. CPython 3.14 simplified both to `\d+`. (2) CPython 3.14 added fractional-part digit grouping — a `frac_separators` group (`[,_]` after the precision, e.g. `'.4_e'`) which `_format_number` joins the fractional digits with in groups of 3. The regex now matches `(?:\.(?=[\d,_])(?P<precision>\d+)?(?P<frac_separators>[,_])?)?` and `_format_number` inserts `frac_sep` into `fracpart`, both as in CPython 3.14.4. This greens `CFormatTest.test_formatting`: wasthon's C `_decimal.dec_format` parses the spec with libmpdec and *falls back to `_pydecimal.Decimal.__format__`* for specs libmpdec can't (the new 3.14 forms, and `.01f`) — so the C variant routes through this code (`build/_decimal.c` `pydec_format`). `PyFormatTest.test_formatting` advances past these but still fails later on a null/astral fill-char spec (a separate re-engine `.`-match issue). Source: `_parse_format_specifier_regex` + `_format_number` in `_pydecimal.py`.

## [x] `re.finditer(bytearray)` doesn't pin the buffer over the wasthon `_sre` path ⚠ VENDORED-ONLY

**Impact: resizing a `bytearray` while a `re.finditer` over it is alive raises `BufferError` (+1 re).** CPython pins a mutable buffer for the lifetime of the finditer scanner (bug 14212), so `b.extend(...)` mid-iteration must raise. Brython's own `re` (`python_re.js`) models this by setting `string.in_iteration` in its module-level `finditer`, which `bytearray.extend` checks. But the harness runs CPython's `re` package over wasthon's C `_sre`, so `re.finditer(b'a', b)` goes `_compile(...).finditer(b)` → the C scanner and never touches `python_re`'s `in_iteration`. The C scanner does acquire a buffer, but the wasthon bridge copies the bytes rather than holding a live export, and Brython is GC- not refcount-based, so the scanner's `PyBuffer_Release` (at dealloc) never fires — `del it; gc_collect()` deallocates nothing. Fixed mirroring how Brython already tracks a live `memoryview`: (1) the harness `re/__init__.py` wraps `finditer` of a `bytearray` in a small iterator that keeps a `memoryview(string)` (bumping `string.exports`) as `__pin_view__`; (2) `bytearray.check_exports` — its GC substitute, which scans the running frames for a live `memoryview` of `self` — also recognises a frame-local object that holds such a memoryview via `__pin_view__`. So the bytearray stays pinned while the iterator `it` is reachable and is freed the moment it leaves scope, with no refcounting. Source: `check_exports` in `py_bytes.js` (companion shim in `loader/cpython-tests/re/__init__.py`).

⚠ **VENDORED-ONLY — no upstream PR.** Brython's own `re` is `python_re.js`, which already pins via `in_iteration`; the `__pin_view__` holder exists only because wasthon runs the CPython `re` package over its C `_sre`. Nothing in vanilla Brython sets `__pin_view__`, so the `check_exports` clause is dead code upstream.

## [x] Nested class / method `__qualname__` is scrambled past one level

**Impact: the `__qualname__` of a class or method nested 2+ levels deep is correct (+5 pickle).** `$class_constructor` builds the qualname prefix by walking the enclosing frames innermost-first and joining as-is, so `Outer.Inner.Deep` became `Inner.Outer.Deep` (the prefix was reversed); a method took the class's bare `__name__` rather than its `__qualname__`, so `Outer.Inner.meth` became `Inner.meth`. This blocked pickling any 2+-level-nested class or method (`Can't pickle X: it's not found as module.Inner.Outer.Deep`). The frame stack is now reversed (outermost-first) and methods use the class qualname. Source: `$B.$class_constructor` in `py_type.js`.

```python
>>> class Outer:
...     class Inner:
...         class Deep: pass
...
>>> Outer.Inner.Deep.__qualname__
'Inner.Outer.Deep'  # before
>>> Outer.Inner.Deep.__qualname__
'Outer.Inner.Deep'  # after
```

## [x] `Ellipsis` / `NotImplemented` can't be pickled (no `__reduce__`)

**Impact: pickling `Ellipsis` or `NotImplemented` works at every protocol (+10 pickle).** Their types had no `__reduce__`, so `object.__reduce_ex__` fell to the protocol-2 `copyreg.__newobj__` path `(__newobj__, (ellipsis,), None)` — which crashed the pickler (`can't access property "hasOwnProperty", d is undefined`) — and raised `cannot pickle 'ellipsis' object` at protocol 0/1. CPython pickles both singletons as global references via a `__reduce__` returning their name (`"Ellipsis"` / `"NotImplemented"`). The `ellipsis` and `NotImplementedType` types now carry that `__reduce__`. Source: `ellipsis` / `NotImplementedType` in `py_builtin_functions.js`.

```python
>>> import pickle
>>> pickle.loads(pickle.dumps(..., 2)) is ...
JavascriptError: can't access property "hasOwnProperty", d is undefined  # before
>>> pickle.loads(pickle.dumps(..., 2)) is ...
True  # after
```

## [x] Instantiation ignores a non-function callable `__init__`

**Impact: instantiating a class whose `__init__` is a callable that isn't a plain function (e.g. a `unittest.mock.Mock`, or any object with `__call__`) now calls it (+1 sqlite3).** CPython calls any callable `__init__`, without binding the instance (a non-descriptor callable receives no `self`). Brython required `typeof tp_init == 'function'`: `type.tp_call` silently skipped a non-function `__init__`, and (upstream) the `make_factory` fast path crashed on `cls.tp_init.call` (undefined on a non-function). Both now call it via `$B.$call(init_func, ...args)` (no instance), guarded by `_b_.callable`. Surfaced by sqlite3's window-function test, which `patch.object(cls, '__init__', side_effect=BadWindow)` and expects instantiation to raise (test_sqlite3 test_win_exception_in_method). Source: `_b_.type.tp_call` (+ `make_factory` upstream) in `py_type.js`; the vendored Brython here predates `make_factory`, so only `tp_call` is patched. Branch `type-call-callable-init` off `upstream/master`, pushed to `origin` — Florent opens the PR.

```python
>>> class Boom:
...     def __call__(self): raise ValueError
...
>>> class C: pass
...
>>> C.__init__ = Boom()
>>> C()
JavascriptError: cls.tp_init.call is not a function  # before
>>> C()
ValueError                                           # after
```

## [x] `type.__module__` getter ignored a class's JS-property `__module__` ⚠ VENDORED-ONLY

**Impact: a class created by the C bridge reports its real module instead of `'builtins'` (+3 decimal).** `type_funcs.__module___get` reads `__module__` from the type's dict, then defaults to `'builtins'`. wasthon's `PyErr_NewException` sets `cls.__module__` as a JS own-property (e.g. `'decimal'` for `decimal.InvalidOperation`) but doesn't write it to the tp_dict, so the getter returned `'builtins'`: `pickle` then couldn't find `InvalidOperation`/`Clamped` as `builtins.X` when pickling a Context's `flags`/`traps` (whose keys are those C signal classes), and a signal class's `__module__` read wrong elsewhere too. The getter now falls back to the JS-property `self.__module__` before defaulting to `'builtins'`. Source: `type_funcs.__module___get` in `py_type.js`. (test_decimal test_pickle CContextAPItests/PyContextAPItests, test_flag_comparisons CContextFlags.)

⚠ **VENDORED-ONLY — this getter fix stays upstream.** In pure Brython `finalize_type` always writes a dict `__module__` (computed from the dotted `tp_name`, → `'builtins'` for a dot-less name like `UnsupportedOperation`), so the type dict is never empty and this getter fallback never fires; the only classes with a JS-property `__module__` and no dict entry come from wasthon's C bridge. No PR for the getter.

**→ A related genuine upstream bug, vendored here AND PR'd.** In Brython, `io.UnsupportedOperation.__module__` is `'builtins'` instead of `'io'`: `make_IOUnsupported` set `$B._IOUnsupported.__module__ = '_io'` as a JS property, which `finalize_type` then overwrote in the dict with the `tp_name`-derived `'builtins'` (the name has no dot) — so the value was lost entirely. Fix = set it in the type dict (like the `ast` classes do) with the CPython value `'io'` (applied here in the vendored `brython.js`; also a separate one-line change to `py_io.js`). Verified before/after on brython-dev: `'builtins'` → `'io'` (matches CPython 3.14), `__name__='UnsupportedOperation'`, `int`/user-class/`collections.OrderedDict` unchanged; vendored side swept clean (bz2/lzma/zstd/decimal unchanged, +0). Branch `io-unsupportedoperation-module` off `upstream/master`, pushed to `origin` (fork) — Florent opens the PR.

## [x] An `IterableJavascriptObject` can't be advanced with `next()` before `iter()`

**Impact: `next(it)` on an `IterableJavascriptObject` no longer raises `self.it is undefined`.** Its `tp_iternext` iterates `self.it`, which is only set by `tp_iter`. CPython iterators are self-contained — `tp_iternext` must not require `tp_iter` to have run first (`next(it)` calls `tp_iternext` directly). It now lazily sets `self.it = self[Symbol.iterator]()` when undefined. Surfaced by `re.finditer`, whose C result reaches the bridge as an IterableJSObj over the scanner's `search`, so `next(re.finditer(...))` crashed (test_re test_bug_581080 / test_bug_817234 / test_finditer; needs the wasthon bridge `GetAttrString` companion for the scanner to actually yield). Source: `$B.IterableJSObj.tp_iternext` (the `IterableJavascriptObject` definition).

## [x] 3-arg `pow()` doesn't dispatch on the modulus's type

**Impact: `pow(10, 2, Decimal(7))` is now `Decimal('2')`.** For `pow(x, y, z)` with `x` and `y` ints and a non-int modulus `z`, `_b_.pow` raised `TypeError: pow() 3rd argument not allowed unless all arguments are integers` upfront. CPython instead dispatches the ternary power on all three operands' `nb_power` slot, including the modulus — `Decimal` implements 3-arg power, so it handles it. The fix tries `type(z).__pow__(x, y, z)` (unless `z` is a `float`, which has no 3-arg power) and falls back to the original `TypeError` if it returns `NotImplemented` or raises (e.g. pure-Python `decimal`, whose `__pow__` expects a `Decimal` self — matching CPython, which raises `TypeError` there too). Source: `_b_.pow` in `py_builtin_functions.js`. (test_decimal test_implicit_context, C and Py.)

```python
>>> pow(10, 2, Decimal(7))
TypeError: pow() 3rd argument not allowed unless all arguments are integers  # before

>>> pow(10, 2, Decimal(7))
Decimal('2')                                                                 # after
```

## [x] `memoryview` compares equal only to another `memoryview`, never to `bytes`/`bytearray`

**Impact: `memoryview(b"x") == b"x"` is now `True`.** `memoryview.tp_richcompare` returned `NotImplemented` for any non-`memoryview` operand, so a comparison to a `bytes`/`bytearray` of the same contents fell through to identity and was always `False`/`True` (eq/ne). CPython compares a memoryview to any buffer-like by contents. The guard now also accepts `bytes`/`bytearray`, and `memoryview_eq` reads the other operand directly instead of `other.obj`. Source: `_b_.memoryview.tp_richcompare` / `memoryview_eq` in `memoryobject.js`. (test_sqlite3 test_func_params: a `memoryview(b"blob")` parameter round-trips through SQLite as `b"blob"`, and `dataset == results` then needs `memoryview(b"blob") == b"blob"`.)

```python
>>> memoryview(b"blob") == b"blob"
False  # before
>>> memoryview(b"blob") == b"blob"
True   # after
```

## [x] `<class>.__class__` returns the descriptor instead of the metaclass

**Impact: `object.__class__` is now `type`, not the `__class__` getset descriptor.** Accessing `__class__` on a class goes through `$getattr`'s class branch, where a getset descriptor found in the class dict only has its getter invoked when it lives in `type.tp_funcs`. `__class__` is an `object`-level getset (inherited by everything, classes included), so it fell through to returning the raw descriptor. `isinstance(<a class>, <an ABC>)` then broke — `ABCMeta.__instancecheck__` does `instance.__class__` and handed the descriptor to `issubclass` (`issubclass() arg 1 must be a class`). The class branch now resolves `__class__` to `$B.get_class(obj)` (the metaclass) up front. Source: `$B.$getattr` in `py_builtin_functions.js`. (test_decimal test_comparison_operators C+Py: `Decimal('23.42') != object`.)

```python
>>> object.__class__
<attribute '__class__' of 'object' objects>  # before
>>> object.__class__
<class 'type'>                                # after
```

## [x] `int('-<non-ASCII digits>')` drops the sign

**Impact: `int('-٣')` (minus + Arabic-Indic digits) is now `-3`, not `3`.** When the string holds non-ASCII Unicode digits the ASCII fast-path regex misses, so `int()` takes the per-character `\p{Nd}` branch — which returned the magnitude before the `if (sign == '-') res = -res` step ran (that step sits after the early `return`). The sign is now applied in that branch too. Source: `int.$factory` (string path) in `py_int.js`. (test_decimal PyExplicitConstructionTest.test_unicode_digits: `Decimal('٠.٠٣٧٢e-٣')` → `0.0000372`.)

## [x] `pow(x, y, z)` returns `undefined` for a non-int/float/complex base

**Impact: 3-arg `pow()` now works for any base with `__pow__`/`__rpow__` — `pow(Decimal(10), 2, 7)` is `Decimal('2')` (was JS `undefined`).** The 3-arg branch only handled `int`, `float` and `complex` bases; any other base (a `Decimal`, a user class with `__pow__`) matched none of them and fell off the end of the function, returning JavaScript `undefined`. After the integer fast path and the float/complex error checks it now dispatches the ternary power slot — `x.__pow__(y, z)`, then `y.__rpow__(x, z)` on `NotImplemented` — like CPython's `PyNumber_Power`. Source: `_b_.pow` in `py_builtin_functions.js`. (test_decimal test_implicit_context.)

## [x] `int.from_bytes(b'')` crashes instead of returning 0

**Impact: `int.from_bytes(b'', 'big')` now returns `0`.** The empty case read `_bytes[0]` (undefined) into `BigInt()`, raising a JS error. Now an empty input returns `0`. Source: `int.from_bytes` in `py_int.js`.

## [x] `int(float('nan'))` / `int(float('inf'))` return the float instead of raising

**Impact: `int(float('nan'))` raises `ValueError`, `int(float('inf'))` raises `OverflowError`.** `float` has no `__int__`, so `int()` fell through to `__trunc__` and kept `NaN`/`Infinity`. Now a float operand is checked first. Source: `int.$factory` in `py_int.js`.

## [x] `MyInt()` (int subclass, no arg) returns the shared literal 0

**Impact: a no-arg int subclass call builds a distinct instance — `type(MyInt())` is `MyInt`, `MyInt() is not MyInt()`.** `int.tp_new` returned `0` for the zero-arg case regardless of `cls`. Now only `int` returns the literal; a subclass builds its own instance. Source: `int.tp_new` in `py_int.js`.

## [x] `str.expandtabs` emits zero spaces for a tab on a tabstop

**Impact: `'\t'.expandtabs(4)` is now `'    '`, and `expandtabs(0)` removes tabs.** `while (col % s > 0)` added nothing when the tab sat on a tabstop. Now a do-while advances to the next tabstop, with a `s <= 0` guard. Source: `str.expandtabs` in `py_string.js`.

## [x] `itertools.repeat` rejects a `__index__` object for `times`

**Impact: `repeat(obj, MyIndex(5))` works.** `range(times)` was used only as a TypeError check, leaving `times` as the original object, so `times < 0` raised. Now `operator.index(times)` coerces it. Source: `repeat` in `Lib/itertools.py`.

## [x] `os.urandom` does not validate its argument

**Impact: `os.urandom(1.5)` → `TypeError`, `os.urandom(-1)` → `ValueError`, oversized → `OverflowError`.** `new Uint8Array(n)` raised a raw JS error or truncated. Now the count goes through `__index__` with range/overflow checks. Source: `os.urandom` in `libs/posix.js`.

## [x] `hashlib` rejects a `bytearray` and raises a JS error

**Impact: `hashlib.md5(bytearray(b'x'))` works.** `bytes2WordArray` rejected bytearray and did `throw _b_.TypeError(...)` (a type object is not callable → JS error). Now it accepts bytearray and raises via `$B.RAISE`. Source: `bytes2WordArray` in `libs/hashlib.js`.

## [x] `BufferedIOBase.readinto` rejects a typed buffer (`array.array`)

**Impact: `readinto(array('I', ...))` fills the array (test_zstd test_readinto).** It read the element count (not byte length) and did `buffer[0:n] = bytes`, which an array rejects. Now it requests `len*itemsize` bytes and, on a typed buffer, decodes into a same-type temp and copies element-wise. Source: `_bufferediobase_readinto_generic` in `py_io.js`.

## [x] Slicing a `bytearray` returns `bytes` instead of `bytearray`

**Impact: `bytearray(b'abc')[0:2]` is now a `bytearray` (general correctness; removes a JS `$factory` crash when `readinto()` targets a sliced bytearray).** `bytearray.mp_subscript` delegated to `bytes.mp_subscript`, which always built the slice result with `bytes.$factory`, so a bytearray slice came back read-only `bytes` — unlike CPython where it is a writable `bytearray`. Now the slice result type is taken from the operand's class (`bytearray` → `bytearray`, `bytes` → `bytes`). Source: `bytes.mp_subscript`, vendored in `loader/brython/brython.js`.

## [x] `BytesIO.read` returned a `bytearray` (companion to the bytearray-slice fix)

**Impact: keeps `io.BytesIO.read()` returning `bytes` (no `_Unpickler`-over-BytesIO regression; pickle stays at baseline).** `BytesIO` stores its buffer as a `bytearray` and `read()` slices it with `bytes.mp_subscript`; once that slice correctly yields a `bytearray`, `read()` started returning a `bytearray`, so pure-Python unpickling read bytes payloads as bytearray. `read()` now wraps the slice in `bytes.$factory` (like CPython's `_pyio.BytesIO.read` returning `bytes(b)`). Source: `BytesIO.read` in the `_io_classes` module, vendored in `loader/brython/brython_stdlib.js`.

## [x] `BufferedReader.seek` on a non-seekable stream silently delegates instead of raising

**Impact: `ZstdFile`/`bz2`/`lzma` over a non-seekable raw stream now raise `io.UnsupportedOperation` on `seek()` (test_zstd test_seek_not_seekable); +1 zstd.** `_BufferedReader.seek` forwarded straight to the raw stream's `seek` without checking `seekable()`, so seeking a wrapper over a non-seekable source succeeded (or emulated) instead of failing like CPython, whose `BufferedReader.seek` raises `UnsupportedOperation("File or stream is not seekable.")`. Now it checks `self.seekable()` first and raises the same exception/message. Source: `_BufferedReader.seek`, vendored in `loader/brython/brython.js`.

## [x] `bytes.join`/`bytearray.join` reject a buffer-protocol item (e.g. `array.array`)

**Impact: `b''.join([array.array(...), …])` now works (test_zstd test_train_buffer_protocol_samples); +1 zstd, general.** `join` concatenated each item with `bytes.sq_concat` (the `+` operator), which only accepts bytes/bytearray (`is_bytes_like` checks `__buffer__`, which `array.array` lacks). CPython's `bytes.join` accepts any buffer-protocol object. Now a non-bytes/bytearray item is converted via `$B.to_bytes` (its `tobytes()`). Source: the shared `join` for bytes/bytearray, vendored in `loader/brython/brython.js`.

## [x] `property.__set__` on a read-only property crashes when the getter has no `$function_infos`

**Impact: setting a read-only C-bridge property (e.g. `ZstdDict.dict_content = x`, test_zstd test_is_raw) now raises AttributeError instead of a JS error; +1 zstd, general.** `property.tp_descr_set` built the "has no setter" message via `prop_get.$function_infos[__name__]`, but a property whose getter is a wasthon C-bridge function has no `$function_infos` → "can't access property … is undefined". Now it falls back to the property's `prop_name`/`__name__`. Source: the `property` type's `tp_descr_set`, vendored in `loader/brython/brython.js`.

## [x] `object.__repr__` omits the module prefix and the address

**Impact: `<hmac.HMAC object at 0x...>` instead of `<HMAC object>` (test_hmac test_repr); +1 hmac, general.** `object.tp_repr` read `klass.__module__` as a JS property — always `undefined`, since `__module__` is a Brython attribute (in the type's dict), not a direct JS prop — so the `<module.qualname>` branch never fired for user classes, and CPython's `at 0x{addr}` was missing entirely. Now it reads `__module__` via `$getattr` and appends ` at 0x{id(self).toString(16)}`, matching CPython's `<module.qualname object at 0xADDR>`. Source: the `object` type's `tp_repr`, vendored in `loader/brython/brython.js`.

## [x] `0 ** negative_int` returns `inf` instead of raising `ZeroDivisionError`

**Impact: `0 ** -1` now raises `ZeroDivisionError: zero to a negative power` (test_math's ieee754 doctest); +1 math.** `int.nb_power`'s negative-exponent branch did `fast_float(Number(x) ** Number(y))`, and JS `0 ** -1` is `Infinity`. Added an `x == 0` guard raising ZeroDivisionError like CPython. Source: the `int` type's `nb_power`, vendored in `loader/brython/brython.js`.

## [x] A binary operator on same-type operands leaks `NotImplemented` instead of raising `TypeError`

**Impact: `[1] * [2]` / `[] * [1]` now raise `TypeError: can't multiply sequence by non-int of type 'list'` (CPython parity); +0 measured** (the C-module suites reach multiply through the bridge, which already maps a `NotImplemented` result). `$B.rich_op1`'s same-type branch returned `__op__`'s result directly, so a `NotImplemented` (e.g. `list.__mul__([1], [2])`) leaked to user code. Now it raises — the "can't multiply sequence by non-int of type X" message for `__mul__` on a sequence, the generic "unsupported operand type(s)" otherwise. Companion to the `sq_repeat` fix below (which lets `[] * [1]` reach this path). Source: `www/src/py_utils.js` (`rich_op1`), vendored in `loader/brython/brython.js`.

## [x] `list`/`tuple` repeat (`sq_repeat`) returns empty for an empty sequence before validating the count type

**Impact: `math.prod([[1], [2], [3]], start=[])` now raises TypeError.** `sq_repeat` short-circuited `if (self.length == 0) return empty` *before* `PyNumber_Index(other)`, so `[] * [1]` returned `[]` instead of rejecting the non-int multiplier. Moved the index conversion and the big-int overflow check ahead of the empty/negative short-circuit, so `[] * [1]` raises (CPython validates the count regardless of emptiness) while `[] * 3` still yields `[]`. Source: the list/tuple `sq_repeat`, vendored in `loader/brython/brython.js`.

## [x] `int.__float__`/`int.nb_float` return `inf` for an int beyond the double range instead of raising `OverflowError`

**Impact: enables `OverflowError` for `float(10**1000)` and `math.hypot(1, 10**400)` (test_math).** CPython's `int.__float__` raises `OverflowError: int too large to convert to float`; Brython did `fast_float(Number(int_value(self)))`, and `Number(bigint)` silently yields `Infinity`. Added a finite check before `fast_float`. Source: the `int` type implementation, vendored in `loader/brython/brython.js`.

## [x] `SomeType.__name__`/`__qualname__` returns a *descriptor* instead of the name when the type defines its own member of that name

**Impact: +0 measured on the suite, but a correct fix that enables nested-class pickling** (`Outer.Inner` now round-trips) and matches CPython for builtin descriptor types. Source: `www/src/py_type.js` (`$B.$getattr` class branch + `type.__qualname___get`), vendored in `loader/brython/brython.js`. Zero regression across the full 21-suite set.

Symptom: `type(str.count).__name__` returned `<member '__name__' of 'method_descriptor' objects>` (the descriptor) instead of `'method_descriptor'`; likewise `__qualname__`. This broke `_pickle`'s `save_global`/`PyUnicode_Split`/`find_class`, which read `obj.__qualname__` expecting a string.
Root: in `$B.$getattr`'s class branch, attribute access on a *type* looked the name up in the type's own dict first and, for a `member_descriptor`/`method_descriptor` (the descriptor types define `__name__`/`__qualname__` for *their instances*, e.g. `str.count.__name__ == 'count'`), returned that descriptor — without first honoring a data descriptor on the metatype. CPython's `type_getattro`: a **data descriptor on the metatype wins** over the type's own attribute, and `type.__name__`/`__qualname__` are data getsets. Separately, `type.__qualname___get` did `get_from_dict(cls, '__qualname__', …)`, which for those types returns the instance getset stored under the same key.
Fix: in the class branch, when the metatype (`type`) has a *data* getset for the attr (`attr+'_get'` exists and `attr+'_set'` is a real function), return the metatype getter applied to the type — before the type's own dict entry. And `type.__qualname___get` returns the dict value only when it's a string, else the type name.

```python
>>> type(str.count).__name__
<member '__name__' of 'method_descriptor' objects>  # before
'method_descriptor'                                 # after
```

## [x] Builtin method/descriptor types ship empty `__reduce__` stubs (return `undefined` → unpicklable)

**Impact: +6 test_pickle** (and clears the dominant failure mode in the harness — `RuntimeError: dumps: call returned NULL` dropped from 440 to 21 subtest occurrences). Source: `www/src/py_*.js` (per-type `tp_funcs.__reduce__`), vendored in `loader/brython/brython.js`.

Symptom: pickling a bound method / `method_descriptor` / slot wrapper / member descriptor / `__getitem__`-based iterator failed. Under wasthon's C `_pickle` it surfaced as `RuntimeError: dumps: call returned NULL`: the C `save` calls `obj.__reduce__()`, Brython returns JS `undefined`, and the C code (a NULL with no exception set) raises the generic error.
Root: these types defined `__reduce__ = function(self){}` — an empty stub returning `undefined` instead of CPython's reduce.
Fix: implement them — the descriptor/method family (`method_descriptor`, `member_descriptor`, `wrapper_descriptor`, `method`, `method_wrapper`, and bound `builtin_function_or_method`) as CPython's `(getattr, (owner, name))`; the `__getitem__`-fallback `iterator` as `(iter, (it_seq,), it_index)` with a real `__setstate__`. (The JS-iterator-wrapping iterators — `filter`/`map`/`zip`/`enumerate`/`tuple_iterator`/`dict_reverse*iterator` — and `GenericAlias` still need a deeper change: their constructor wraps the source in a non-picklable JS iterator, or the reduce references a type that isn't itself picklable by reference.)

```python
>>> str.count.__reduce__()
<Javascript undefined>                                   # before
(<built-in function getattr>, (<class 'str'>, 'count'))  # after
```

## [x] `%x`/`%X`/`%o` and `int.__format__` give `'NaN'`/`'[object Object]'` for an int subclass instance

**Impact: +0 measured** (correct; reproduces on stock CDN brython@3.14.3; the int-subclass pickle tests that exercise it fail further along their own deeper layers). Source: `www/src/py_string.js` (`signed_hex_format`, `octal_format`), `www/src/py_int.js` (`preformat`), vendored in `loader/brython/brython.js`.

Symptom: for `class S(int): pass` and `x = S(0xface)`, `'%x' % x` → `'NaN'`, `'%X' % x` → `'NAN'`, `'%o' % x` → `'NaN'`, `format(x, 'x')` → `'[object Object]'`. Plain `int` and `'%d' % x` are correct, and a *big* int subclass is correct (it takes the `is_big_int` branch).
Root: a Brython int subclass instance boxes its value in `.value`. The hex/octal printf path did `parseInt(val)` for the non-big-int case — `parseInt` on the boxed object is `NaN` → `.toString(16)` → `'NaN'`. `int.__format__`'s `preformat` did `self.toString(16)` on the boxed object → `'[object Object]'`. `%d` only worked because it routes through `str.$factory(val)`.
Fix: unbox with `$B.int_value(val)` (`obj.value ?? obj` — handles plain number, boxed subclass, and bigint uniformly; already used by the float `preformat` and by the `is_big_int` branch here). `preformat` reads `var value = $B.int_value(self)` once and uses it for the `b`/`o`/`x`/`X`/`d` conversions and the sign test.

```python
>>> class S(int): pass
>>> '%X' % S(0xface)
'NAN'   # before
'FACE'  # after
>>> format(S(0xface), 'x')
'[object Object]'  # before
'face'             # after
```

## [x] `__reduce_ex__` drops `__getnewargs_ex__` keyword args (always `__newobj__`, never `__newobj_ex__`)

**Impact: +0 measured** (correct; reproduces on stock CDN; `test_complex_newobj_ex` still fails at protocol 2/3 on a separate `object.__new__.__qualname__` issue). Source: `www/src/py_object.js` (`object.__reduce_ex__`), vendored in `loader/brython/brython.js`.

Symptom: pickling (protocol >= 2) an object whose `__getnewargs_ex__` returns non-empty kwargs lost the kwargs. `S(0xface).__reduce_ex__(2)` returned `(copyreg.__newobj__, (S, 'FACE'), ...)` — the `{'base': 16}` was gone — so unpickling did `int('FACE')` (base 10) → `ValueError`.
Root: `object.__reduce_ex__` always used `copyreg.__newobj__` and only concatenated `newargs.args`, ignoring `newargs.kwargs` from `getNewArguments`. CPython's `reduce_2`: when kwargs is non-empty, use `copyreg.__newobj_ex__` with the tuple `(cls, args, kwargs)`; otherwise `__newobj__` with `(cls,) + args`.
Fix: branch on `_b_.dict.mp_length(newargs.kwargs) > 0` → emit `__newobj_ex__` with `(cls, args, kwargs)`; else keep the `__newobj__` path unchanged.

```python
>>> class S(int):
...     def __getnewargs_ex__(self): return (('%X' % self,), {'base': 16})
>>> S(0xface).__reduce_ex__(2)[:2]
(<function __newobj__>, (<class 'S'>, 'FACE'))                      # before
(<function __newobj_ex__>, (<class 'S'>, ('FACE',), {'base': 16}))  # after
```

## [x] `object.__reduce_ex__` calls `__getnewargs_ex__` via `$B.$call`, not a raw JS call

**Impact: +0 measured** (removes a real error; the affected tests — test_complex_newobj_ex, test_compat_pickle, test_buffers_numpy — then fail further along their own deeper layers). Source: `www/src/py_object.js` (`getNewArguments`), vendored in `loader/brython/brython.js`.

Symptom: pickling an object whose `__getnewargs_ex__` is a Python method raised `RuntimeError: newargs_ex is not a function` from `_pickle`/copyreg reduce.
Root: `getNewArguments` did `let newargs = newargs_ex()` — a direct JS call — on the result of `$B.$getattr(self, '__getnewargs_ex__', null)`. A Brython bound method is an *object* (`__class__` = method), not a JS function, so the direct call throws "not a function". The parallel `__getnewargs__` branch a few lines below already calls it correctly via `$B.$call(newargs, self)`.
Fix: `let newargs = $B.$call(newargs_ex)` (the method is already bound to `self`). `$B.$call` dispatches both JS functions and Brython callables, so the C-method case that worked before is unaffected.

## [x] `float(str)` raises ValueError on an overflowing literal instead of returning inf

**Impact: +2 test_json** (`test_out_of_range`, C and Py float paths). Source:
`www/src/py_float.js` (string parse), vendored in `loader/brython/brython.js`.

Symptom: `float('1e999')` raised `ValueError: could not convert string to float`.
Root: the parser validates the cleaned string with `isFinite(value)` (which
coerces via `Number()`), then `parseFloat`. `isFinite` is false for BOTH an
invalid string (`Number()` → NaN) AND a valid literal that overflows the double
range (`Number()` → ±Infinity), so a real overflow was rejected. CPython returns
inf for overflow. Fix: in the `else` branch, return `inf`/`-inf` when
`Number(value)` is `±Infinity`; only NaN stays an error.

```python
>>> float('1e999')
ValueError: could not convert string to float: '1e999'  # before
inf                                                      # after
```

## [x] `bytes.startswith(tuple)` crashes (let-shadow TDZ) and concatenated the prefixes

**Impact: +2 test_json** (`test_bytes`, C and Py decoders — `json.detect_encoding`
does `b.startswith((BOM_UTF32_BE, BOM_UTF32_LE))`). Source: `www/src/py_bytes.js`
(`startswith`), vendored in `loader/brython/brython.js`.

Symptom: `b'abc'.startswith((b'x', b'ab'))` threw `can't access lexical
declaration 'prefix' before initialization`.
Root: two bugs, one masking the other. (1) the tuple branch ended with
`let prefix = cls.$factory(items)`; being block-hoisted, that put the `prefix`
parameter in the temporal dead zone for the whole branch, so the earlier
references (`prefix.length`, `prefix[i]`, `class_name(prefix)`) threw. (2) even
without the crash the logic was wrong — it concatenated all tuple items into one
bytes and tested that, instead of matching if ANY prefix matches. Fix: mirror
`endswith` — iterate the tuple and return true on the first matching prefix
(short-circuiting before validating later items, as CPython does).

```python
>>> b'abc'.startswith((b'x', b'ab'))
JavascriptError: can't access lexical declaration 'prefix' before initialization  # before
True                                                                              # after
```

## [x] `hash()` does not remap a computed -1 to -2

**Impact: +0 on the wasthon suites** (surfaced by decimal's `test_hash_method`,
whose remaining failure has a separate deeper root) — but a real CPython
faithfulness bug: `hash(-1)` is `-2`, not `-1`. Source:
`www/src/py_builtin_functions.js` (`$B.$hash`), vendored in `loader/brython/brython.js`.

Symptom: `hash(-1) == -1` (CPython: `-2`), and likewise any object whose hash
computes to -1. Root: CPython reserves a hash of -1 as the "hash failed"
sentinel, so a value that would hash to -1 is remapped to -2 (in `hash()` / each
`tp_hash`). `$B.$hash` returned the raw value from both the number fast-path and
`tp_hash`, never applying that remap. Fix: funnel both paths through a single
exit and remap `-1 -> -2` there.

```python
>>> hash(-1)
-1  # before
>>> hash(-1)
-2  # after
```

## [x] `int` does not expose `__float__`

**Impact: +0 on the wasthon suites** (surfaced via the C `nb_float` slot, which
looked up `__float__` on an int and found nothing) — but a real CPython
faithfulness gap: `(5).__float__()` raised `AttributeError` (CPython provides it
via `long_float`). Source: `www/src/py_int.js`, vendored in
`loader/brython/brython.js`.

Symptom: `(5).__float__()` → `AttributeError: 'int' object has no attribute
'__float__'`. Root: `int` defines the `nb_float` slot but never exposes it as the
`__float__` method/dunder. **Gotcha:** the naive `int.__float__ = float.$factory(self)`
recurses infinitely — `float.$factory` itself dispatches to `__float__` when the
operand defines one. Fix: reuse the existing `nb_float` conversion directly
(`$B.fast_float(Number(int_value(self)))`) and add `__float__` to `int.tp_methods`.

```python
>>> (5).__float__()
AttributeError: 'int' object has no attribute '__float__'  # before
5.0                                                        # after
>>> (2**300).__float__()
AttributeError                                             # before
2.037035976334486e+90                                      # after
```

## [x] `iso8859` encoding label not recognised (LookupError)

**Impact: +1 test_pyexpat** (`test_parse_only_xml_data` — the XML declares
`encoding='iso8859'`, so `xml.encode('iso8859')` and expat's decode must both
accept it). Source: the latin-1 alias group of the `encode`/`decode` switches,
vendored in `loader/brython/brython.js`.

Symptom: `'abc'.encode('iso8859')` raised `LookupError: unknown encoding:
iso8859`. Root: the latin-1 alias group lists `latin1`, `iso8859_1`, `8859`,
`cp819`, `windows1252`, … but not the bare `iso8859` label — CPython's
`encodings/aliases.py` maps `'iso8859' -> 'latin_1'`. Fix: add `iso8859` to the
latin-1 cases in both the encode and decode switches.

```python
>>> 'abc'.encode('iso8859')
LookupError: unknown encoding: iso8859  # before
b'abc'                                  # after
```

## [x] `open()` rejects a bytes filename ("invalid file: [object Object]")

**Impact: +1 test_bz2** (`testOpenBytesFilename`). Source: `_io_open_impl`,
vendored in `loader/brython/brython.js`.

Symptom: `open(b'/tmp/x', 'wb')` (and `BZ2File(b'...')`) raised `TypeError:
invalid file: [object Object]`. Root: `_io_open_impl` resolves `__fspath__` but
then requires a str, so a bytes filename fell straight through to the error.
CPython's `open()` accepts bytes paths (decoded via `os.fsdecode`). Fix: decode a
bytes/bytearray path before the str check.

```python
>>> open(b'/tmp/x', 'wb')
TypeError: invalid file: [object Object]  # before
<_io.BufferedWriter ...>                  # after
```

## [x] `function.__annotations__` crashes on a function with no annotations

**Impact: +21 test_hmac** (no-annotation functions in two test classes' setUpClass
crashed, erroring the whole classes). Source: the `function.__annotations__`
getter, vendored in `loader/brython/brython.js`.

Symptom: `(lambda: None).__annotations__` raised `JavascriptError:
self.__annotate__ is not a function`. Root: the getter lazily computes annotations
via `self.__annotate__(1)` (PEP 649), but a function with no annotations has no
`__annotate__` — CPython returns an empty dict in that case. Fix: when
`__annotate__` is not callable, return `{}`.

```python
>>> (lambda: None).__annotations__
JavascriptError: self.__annotate__ is not a function  # before

>>> (lambda: None).__annotations__
{}                                                    # after
```

## [x] An instance attribute does not override a builtin method (non-data descriptor)

**Impact: +3** (test_bz2 / test_lzma / test_zstd `test_seekable` — `BZ2File(src).seekable()`
with `src.seekable = lambda: False` must be False). Source: `$B.call_attr` (the `obj.m()`
method-call optimization) and the `$B.$getattr` builtin-type fast path, vendored in
`loader/brython/brython.js`. **Two independent upstream PRs** (call_attr / getattr) — distinct paths.

Symptom: an instance attribute shadowing a builtin method was ignored (`b.seekable()` still
ran the class method). Root: both `$B.call_attr` (builtin_method branch) and the `$B.$getattr`
fast path returned the class method without first checking the instance dict. CPython's
`__getattribute__` precedence is data descriptor > instance `__dict__` > non-data descriptor
(method). Fix: in both paths an instance attribute (via `search_in_dict`) wins over a non-data
descriptor; data descriptors (getset/member) still win.

```python
>>> b = io.BytesIO(b''); b.seekable = lambda: False
>>> b.seekable()
True   # before
False  # after
```

## [x] `slice.$conv_for_seq` over-runs on `stop`/`start` < -len with step < 0

**Impact: +14 test_array** (`test_extended_getslice` across all 14 typecodes; the
reference side `list(a)[start:stop:step]` was wrong) — and fixes list/str/bytes
extended slicing generally. Source: `www/src/brython.js` (`slice.$conv_for_seq`).

Symptom: `[1,..,10][0:-31:-1]` returned `[1, undefined×20]` instead of `[1]`.
Root: when normalising a negative index, `stop += len` was applied but, unlike
CPython's `PySlice_AdjustIndices`, the result was **not re-clamped** when still
`< 0` — so `stop = -31+10 = -21` and the loop `for (i=0; i>-21; i--)` walked into
negative JS array indices (`items[-1]` = `undefined`). The `start` low-clamp had
the same gap (clamped to `0`, not `step<0 ? -1 : 0`). Fix: after `+= len`, clamp
both to `step_is_neg ? -1 : 0`, mirroring `PySlice_AdjustIndices`.

```python
>>> [1,2,3,4,5,6,7,8,9,10][0:-31:-1]
[1, <Javascript undefined>, <Javascript undefined>, ...]  # before
[1]                                                        # after
```

## [x] `memoryview.cast('I')` / `.tolist()` broken (4-byte format)

**Impact: enables CPython's `re` package on wasthon's `_sre`** (`re._compiler._bytes_to_codes`
does `memoryview(b).cast('I').tolist()`); unblocks test_re → CPython re (+11). Source:
`www/src/memoryobject.js`. The `cast` `len`→`_b_.len` part is Pierre's commit `8d3fd4b56`.

Two bugs in the 4-byte (`"I"`) path: `cast` used a bare `len(self.obj)` (undefined →
`JavascriptError: len is not defined`); `tolist` returned a raw JS array, so
`[block] + that` raised `TypeError: unsupported operand … 'list' and 'JavascriptArray'`.
Fix: `_b_.len(self.obj)` in cast, and `_b_.list.$factory(res)` in tolist (matching the
1-byte path).

```python
>>> memoryview(b'\x04\x00\x00\x00').cast('I').tolist()
JavascriptError: len is not defined   # before
>>> memoryview(b'\x04\x00\x00\x00').cast('I').tolist()
[4]                                   # after
```

## [x] `float.hex()` emits uppercase mantissa digits

**Impact: +3 test_random** (`test_guaranteed_stable`, `test_bug_27706`,
`test_bug_31482` — they compare `random().hex()` against CPython's lowercase
literals). Source: `www/src/py_float.js`, `float.hex` (`_int2hex`).

Root cause: the hex-digit table was `_int2hex = "0123456789ABCDEF"` (uppercase);
CPython's `float.__hex__` always uses lowercase a–f. Fix: lowercase the table.

```python
>>> (255.0).hex()
'0x1.FE00000000000p+7'  # before
>>> (255.0).hex()
'0x1.fe00000000000p+7'  # after
```

## [x] `_operator._compare_digest` rejects bytearray/memoryview and uses `==`

**Impact: +8 test_hmac** (`HMACCompareDigestTestCase` + `OperatorCompareDigestTestCase`:
`test_bytearray`, `test_mixed_types`, `test_bytes_subclass`, `test_string_subclass`).
Source: `Lib/_operator.py`, `_compare_digest_impl`.

Symptom: `hmac.compare_digest(bytearray(b'x'), bytearray(b'x'))` raised
`TypeError: unsupported operand types`; a `bytes`/`str` subclass overriding
`__eq__` to raise hit `ValueError: should not be called`.

Root cause: the impl only accepted `(str, str)` and `(bytes, bytes)` and compared
with `a == b` — so `bytearray`/`memoryview` were rejected, and `==` invoked the
operand's `__eq__` (compare_digest must be constant-time and never call it).

Fix: accept any `(bytes, bytearray)` pair (mixed ok), require ASCII for `str`,
compare value-by-value (`ord` for str, byte ints for bytes-like) with a
length-difference guard — no `==`, no `__eq__`. A slice (`a[:]`) normalises a str
subclass to a primitive first (Brython subclass instances are not directly
iterable/encodable — a separate engine bug).

```python
>>> from hmac import compare_digest
>>> compare_digest(bytearray(b'abc'), b'abc')
TypeError: unsupported operand types  # before
>>> compare_digest(bytearray(b'abc'), b'abc')
True                                  # after
```

## [x] `BytesIO` does not report `seekable()` / `writable()`

**Impact: io fidelity (part of the `LZMAFile(BytesIO(...)).seekable()` chain;
+0 alone — `test_seekable` also needs instance-attribute shadowing of a
built-in method, untouched).** PR branch `io-bytesio-seekable-writable`.
`BytesIO.tp_methods` (`www/src/libs/_io_classes.js`) ended at `"readable"`,
omitting `"seekable"` and `"writable"`, so although `BytesIO_funcs.seekable`
/`.writable` are defined (returning `True`) they were never installed and
the instance inherited `_IOBase`'s `False`.

```python
>>> from io import BytesIO
>>> BytesIO(b'x').seekable()
False   # before
True    # after
>>> BytesIO(b'x').writable()
False   # before
True    # after
```

## [x] `BufferedReader` does not delegate `seekable()`/`readable()`/`writable()`

**Impact: io fidelity (the other half of the chain above; +0 alone).** PR
branch `io-bufferedreader-delegate-seekable`. `_BufferedReader.tp_methods`
(`www/src/py_io.js`) listed only `["peek","seek","read","readline"]`, so the
buffer inherited `_IOBase`'s `seekable()`/`writable()` = `False` instead of
delegating to its raw stream as CPython does.

Side effect (honest): a correct `readable()` lets the file-based doctests
read their data file to completion instead of stopping short. This unmasked
two latent bugs the truncated read had hidden — `cmath.polar` overflow (now
fixed in the bridge, see `CHANGELOG.md` `_Py_c_abs`), and a cosmetic
`math/ieee754.txt` doctest mismatch where `asin(INF)`'s domain error prints
the value as `Infinity` instead of `inf` (skip → fail, no pass lost; a real
formatting bug to fix later).

```python
>>> import io
>>> class R(io.RawIOBase):
...     def readable(self): return True   # required, else UnsupportedOperation
...     def seekable(self): return True
...     def readinto(self, b): return 0
>>> io.BufferedReader(R()).seekable()
False   # before (inherits _IOBase, ignores raw)
True    # after (delegates to raw.seekable())
```

## [x] `_testcapi` stub missing `nan_msb_is_signaling`

**Impact: +1 struct (test_half_float, 35→36 → suite at 100%).** Brython's
`_testcapi` stub (`Lib/_testcapi.py`, bundled into the `brython_stdlib.js`
VFS) ships the integer limit constants (`ULLONG_MAX`, `PY_SSIZE_T_MAX`, …)
but omits `nan_msb_is_signaling`, the bool CPython's `_testcapi` exposes for
the platform's NaN convention. `test_half_float` reads it to pick the
expected quiet-NaN bit pattern and died with `AttributeError`. JS/wasm are
IEEE-754 with the quiet-NaN MSB **set** (not signaling), so the correct
stub value is `False` — add it next to the other module constants.

```python
>>> import _testcapi
>>> _testcapi.nan_msb_is_signaling
AttributeError: module '_testcapi' has no attribute 'nan_msb_is_signaling'  # before
>>> _testcapi.nan_msb_is_signaling
False  # after (IEEE-754: quiet NaN has the MSB set)
```

## [x] float binary ops coerce ANY operand via `__float__`

**Impact: +2 decimal (restores 295 with the real semantics) —
`Decimal(5) + 2.2` computed 7.2 instead of raising TypeError.** CPython's
float binary ops (CONVERT_TO_DOUBLE) accept ONLY int/float; `conv_float`
also called the operand's `__float__`, so implicit Decimal/float mixing
silently succeeded (test_implicit_from_float only passed by accident
before the locals() fix). Drop the `__float__` branch from `conv_float`
(`www/src/py_float.js`).

```python
>>> Decimal(5) + 2.2
Decimal('7.2')  # before (wrong)
>>> Decimal(5) + 2.2
TypeError: unsupported operand type(s) for +: 'decimal.Decimal' and 'float'  # after
```

## [x] `locals()` returns the raw frame object (methods saw their instance)

**Impact: test_hashlib +8 (58→66) — replaces the test_get_builtin_constructor
skip.** (The transient decimal −2 was test_implicit_from_float passing FOR THE
WRONG REASON before — eval() on the raw frame object happened to raise the
expected TypeError; fixed for real by the conv_float entry below.) `_b_.locals` returned `$B.frame_obj.frame[1]` raw: not a Python mapping
(`'x' in locals()` raised "argument of type 'X' is not a container"), and in
a test METHOD the frame object carries `__class__`/`ob_type` infrastructure
keys, so the object even REPORTED itself as the instance's class. CPython's
test_hashlib does `if '_md5' in locals()` inside a `finally:` — the raise
left `sys.modules['_md5'] = None`, poisoning six subsequent tests
("unsupported hash type md5"). Fix: return a dict snapshot (CPython
semantics), honoring a class-body `$target` only when it is dict-classed,
and skipping `$`-prefixed / `__class__` / `ob_type` infrastructure keys
(whose `$setitem` would clobber the dict's own JS identity).

```python
>>> 'x' in locals()
TypeError: argument of type 'Probe' is not a container or iterable  # before
>>> 'x' in locals()
True  # after
```

## [x] `int * bytes` / `int * bytearray` raise TypeError

**Impact: test_struct +1 (28→29); unblocks `46*b"!"`-style constructions
(test_binascii's b2a_uu argument).** The slot convention delivers args in
ORIGINAL order, so on the reflected path (`46 * b'!'` → `__rmul__`)
`bytes.nb_multiply` receives the INT as self and does
`PyNumber_Index(bytes)` → "'bytes' object cannot be interpreted as an
integer". Handle either operand order, like CPython's `bytes_repeat`
(both `bytes.nb_multiply` and the bytearray `nb_multiply` helper).

```python
>>> 46 * b'!'
TypeError: 'bytes' object cannot be interpreted as an integer  # before
>>> 46 * b'!'
b'!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'  # after
```

## [x] VFS array: q/Q typecodes unimplemented, i/I wrong width

**Impact: zstd +1, bz2 +1.** The array module's typecode table had
`'q'/'Q': null` ("not implemented") — `BigInt64Array`/`BigUint64Array` have
been universal for years — and mapped `'i'/'I'` to 16-bit views (CPython's
int itemsize is 4).

```python
>>> array.array('Q', [1, 2])
NotImplementedError: type code Q is not implemented  # before
>>> array.array('Q', [1, 2])
array('Q', [1, 2])  # after
>>> array.array('i').itemsize
4  # after (was 2)
```

## [x] class comparison ignored custom metaclass `__eq__`

**Impact: pickle +5 (644) — test_dynamic_class (classes recreated through
`copyreg.pickle` compare equal via their metaclass).** `rich_comp` had an
identity shortcut for ANY type operand (`x === y`), so a metaclass's
`__eq__`/`__ne__` was never consulted. The shortcut now applies only to
plain `type` classes; custom metaclasses fall through to the regular
dunder dispatch.

```python
>>> class Meta(type):
...     def __eq__(self, other):
...         return self.tag == other.tag
>>> A = Meta('X', (), {'tag': 1}); B = Meta('X', (), {'tag': 1})
>>> A == B
False  # before
>>> A == B
True  # after
```

## [x] stdev/pstdev crash instead of ValueError on inf/nan (gh-140938)

**Impact: statistics +1 (368).** The bundled statistics.py predates
CPython's gh-140938 guard: `mss.numerator` on the float inf/nan result
raised AttributeError instead of `ValueError('inf or nan encountered in
data')`. Ported the upstream try/except into stdev and pstdev.

```python
>>> statistics.pstdev([1.0, math.inf])
AttributeError: 'float' object has no attribute 'numerator'  # before
>>> statistics.pstdev([1.0, math.inf])
ValueError: inf or nan encountered in data  # after
```

## [x] int subclass constructor stored its argument unconverted

**Impact: statistics +1 (367), random +1 (86).** `int.tp_new` converted
through `int.$factory` only for plain `int`; for subclasses it built
`{ob_type: cls, value}` with the RAW argument — `MyInt(Fraction(17))`
carried a Fraction as its value and printed `[object Object]` everywhere
downstream. Subclasses now convert through the same factory.

```python
>>> class MyInt(int): pass
>>> MyInt(Fraction(17))
[object Object]  # before
>>> MyInt(Fraction(17))
17  # after
```

## [x] `int.from_bytes` subtracted 256 from signed values with a high low-byte

**Impact: pickle +5 (pickle 639) +1 (batch) — decode_long in the pure-Python pickler (the
CDumpPickle_LoadPickle / PyPicklerTests class family), test_ints/test_long
and the numeric is-not-a-copy cluster.** The two's-complement was applied
TWICE: once (wrongly) on the LEAST significant byte at loop start
(`if(signed && num >= 128) num -= 256`), once (correctly) on the MSB at the
end — so every signed conversion whose low byte was ≥ 0x80 came out 256
short. The C loaders were fine, which is why the corruption only appeared
in suite classes that load through Python.

```python
>>> int.from_bytes(b'\xff\xff', 'little', signed=True)
-257  # before
>>> int.from_bytes(b'\xff\xff', 'little', signed=True)
-1  # after
```


## [x] `__slots__` machinery: `'__dict__'` marker, private-name mangling, slots-aware `__getstate__`

**Impact: pickle +10 (cluster WithPrivateSlots/WithSlotsAndDict/my_dynamic_class).**
Three faithful-CPython gaps in the class machinery:
(1) `'__dict__'` (and `'__weakref__'`) inside `__slots__` are MARKERS, not
slots — their presence means the instance keeps a `__dict__`; Brython
created a bogus `slot_value___dict__` member instead, so any out-of-slots
setattr raised "no __dict__ for setting new attributes". Now a class
marker + a lazily-created per-instance dict.
(2) CPython mangles private slot names at class-creation time
(`__private` → `_Cls__private`); Brython didn't, so the compiler-mangled
`self.__private = x` never found its slot.
(3) `object.__getstate__` ignored slots entirely; CPython 3.11+ returns
`(dict-or-None, {slot: value})` when slots are filled — pickle's reduce
protocol depends on it. Slot values live as `slot_value_*` JS properties
(the member-descriptor storage), collected from there.

```python
>>> class S:
...     __slots__ = ('a', '__dict__')
>>> s = S(); s.b = 2
AttributeError: 'S' object has no attribute 'b' and no __dict__ for setting new attributes  # before
>>> s = S(); s.b = 2; s.b
2  # after
>>> class T:
...     __slots__ = ('a',)
>>> t = T(); t.a = 1; t.__getstate__()
None  # before
>>> t = T(); t.a = 1; t.__getstate__()
(None, {'a': 1})  # after
```


## [x] `bytes.__contains__` subsequence search never matched

**Impact: pickle +22 (589→611) — every `assertIn(fragment, dump)` in the
suite; single-byte `in` was fine.** Two swapped indices in the inner loop
of `bytes.sq_contains` compared the needle shifted against the start of
the haystack (`other.source[i+j] != self.source[j]`), so any multi-byte
needle missed unless it matched at position 0. Fixed the indices — then
replaced the naive O(n*m) JS loop outright with native `String.indexOf`
over latin-1 strings (chunked `String.fromCharCode`): with the loop merely
corrected, real scans over multi-MB pickle dumps timed the suite out.

```python
>>> b'wor' in b'hello world'
False  # before
>>> b'wor' in b'hello world'
True  # after
```

## [x] `assertWarns` never matched (recorded message is a raw str)

**Impact: sqlite3 +10 (315→325), array +2 — and every `assertWarns` in any
suite.** Brython's JS `_warnings.warn` shim records the message AS GIVEN;
CPython materializes `category(message)` for str messages, and unittest's
`_AssertWarnsContext` does `isinstance(m.message, expected)` — a raw str
never matches, so `assertWarns` reported "X not triggered" even when the
warning fired. Fixed in `_AssertWarnsContext.__exit__` (late
materialization from `m.category`): patching the warn shim itself hangs
import-time warnings (constructor → module-resolution loop), so the
context manager is the safe point.

```python
>>> with self.assertWarns(DeprecationWarning):
...     warnings.warn('x', DeprecationWarning)
AssertionError: DeprecationWarning not triggered  # before
>>> with self.assertWarns(DeprecationWarning):
...     warnings.warn('x', DeprecationWarning)
# after: passes
```

## [x] `readinto()` rejected bytearray; VFS array called phantom JS methods

**Impact: zstd +1 (96→97) — joint across three defects on the readinto
path.** (1) `is_buffer` iterated `get_class(obj).__mro__`, which is
undefined in Brython 3.14 (MRO lives in `tp_mro`) → crash; use
`$B.get_mro`. (2) `bytearray` — THE canonical read-write buffer — never got
the `$buffer_protocol` flag (bytes and memoryview have it) → "readinto()
argument must be read-write bytes-like object, not bytearray". (3) the VFS
array module called `array.append/insert/pop(self, x)` as raw JS class
properties, which don't exist (`array_funcs.X` is the real table) →
"array.append is not a function" on every extend/fromlist path.

```python
>>> f.readinto(bytearray(5))
TypeError: readinto() argument must be read-write bytes-like object, not bytearray  # before
>>> f.readinto(bytearray(5))
5  # after
```

## [x] `BufferedReader.raw` attribute missing

**Impact: zstd +1, bz2 +1 (the `decomp._buffer.raw.tell()` test pattern).**
Brython's `_BufferedReader` stores the underlying stream as a JS property
but never exposes it: the `X_get` tp_funcs convention only takes effect for
names DECLARED in `cls.tp_getset` (which builds the getset_descriptors at
finalize). Added `tp_getset = ['raw']` + `raw_get`.

```python
>>> io.BufferedReader(io.BytesIO(b'x')).raw
AttributeError: '_BufferedReader' object has no attribute 'raw'  # before
>>> io.BufferedReader(io.BytesIO(b'x')).raw
<_io.BytesIO object>  # after
```

## [x] `file.write(buffer-protocol object)` silently wrote 0 bytes

**Impact: array +14 (742→756) — the `f.write(array(...))` /
fromfile-roundtrip family (×28 EOFError cluster).** The fs layer's `toU8`
returned an EMPTY Uint8Array for any object it didn't recognize (it only
knew `.source`, TypedArrays and JS arrays) — so writing a wasthon C array
truncated the file to 0 bytes and every later `fromfile` died with
"read() didn't return enough bytes". Materialize Python buffer-protocol
objects via `tobytes()` (fallback `bytes(obj)`).

```python
>>> open(fn, 'wb').write(array.array('i', [1, 2, 3, 4, 5]))
0  # before
>>> open(fn, 'wb').write(array.array('i', [1, 2, 3, 4, 5]))
20  # after
```

## [x] os-level calls stringify PathLike objects to '[object Object]'

**Impact: zstd +6 (89→95).** `open()` resolves `__fspath__` (fixed earlier)
but the fs layer's `norm()` did `String(p)` — so `os.remove(pathlib.Path(x))`
(and stat/access/unlink/...) looked up the literal key `'[object Object]'`
and raised FileNotFoundError at the END of every Path-based test. Resolve
`__fspath__` at the top of `norm()`: one fix point covers the whole posix
surface (`wasthon-fs-mem.js`).

```python
>>> os.remove(pathlib.Path('f.bin'))
FileNotFoundError: No such file or directory: '[object Object]'  # before
>>> os.remove(pathlib.Path('f.bin'))  # after: removes the file
```

## [x] Text I/O over compression files (the write path didn't exist)

**Impact: bz2 +4 (84→88), zstd +2 (87→89), cmath +1, pickle +1 — the whole
`open(fn, 'wt'|'rt')`-over-BZ2File/ZstdFile family.** Five stacked defects:
`_TextIOWrapper.$factory` eagerly `read(-1)`s its buffer at CONSTRUCTION
(UnsupportedOperation on a write-mode compression file) and didn't know
`encoding='locale'`; it had no `write` at all; the wasthon io layer's
TextIOWrapper `write`/`flush`/`close`/`writable` raised or no-opped for
non-fd-backed buffers instead of delegating (so the compressor's output —
emitted at close — never reached the file, leaving 0 bytes); and
`_bufferedreader_read_fast` assumed a preloaded `raw.$bytes` snapshot,
crashing on fd-backed raws ("can't access property length"). Fixes: lazy
read gated on `readable()`, write/flush/close delegation to `$buffer`,
locale→utf-8, and an fd fallback (`raw.read(n)`) in the buffered reader.

```python
>>> with bz2.open('f.bz2', 'wt') as f: f.write('hello')
io.UnsupportedOperation: File not open for reading  # before
>>> with bz2.open('f.bz2', 'wt') as f: f.write('hello')
>>> bz2.open('f.bz2', 'rt').read()
'hello'  # after
```

## [x] `open()` rejects os.PathLike objects

**Impact: test_bz2 +1 (83→84); unblocks every `open(pathlib.Path(...))` /
custom `__fspath__` path.** Brython's `open()` does
`if(!is_str(path_or_fd)) raise TypeError('invalid file: ...')` with no
`__fspath__` resolution — CPython's open() accepts any path-like. Resolve
`__fspath__` before the str check.

```python
>>> open(MyPath('f.bin'), 'wb')
TypeError: invalid file: [object Object]  # before
>>> open(MyPath('f.bin'), 'wb')
<_io.BufferedWriter name='f.bin'>  # after
```

## [x] `object.__reduce_ex__` ignores Python `__reduce__` overrides and passes a dict VIEW as dictitems

**Impact: test_pickle +73 (469→542) — and the suite runs in 88s instead of
~290s.** Two bugs in the protocol-2 default reduce (`www/src/py_object.js`):
1. The override guard only honored C-style overrides
   (`reduce.ob_type === method_descriptor`); a **Python-level `__reduce__`**
   (any user subclass) is a plain function → silently ignored, the default
   reduce ran instead.
2. `key_value_iterator = dict.items(self)` — the VIEW; CPython's `reduce_2`
   does `PyObject_GetIter(items)`. `_pickle` then rejected every dict
   subclass: "fifth item of the tuple returned by __reduce__ must be an
   iterator, not dict_items". Wrap in `iter(...)`.

```python
>>> class D(dict):
...     def __reduce__(self): return (D, (), None, None, iter(self.items()))
>>> _pickle.loads(_pickle.dumps(D(a=1), 2))
PicklingError: fifth item of the tuple returned by __reduce__ must be an iterator, not dict_items  # before
>>> _pickle.loads(_pickle.dumps(D(a=1), 2))
{'a': 1}  # after
```

## [x] `range[i:j]` calls the nonexistent `range.$factory`

**Impact: test_pickle +6** (pickletester slices ranges in several helpers; the
2026-06-04 audit had already flagged this as a real Brython bug). The slice
branch of range's subscript computes substart/substop/substep then calls
`range.$factory(...)` — which doesn't exist (Brython 3.14 ranges are built by
`range.tp_new`). Call `range.tp_new(range, [substart, substop, substep])`
instead (`www/src/py_range_slice.js`).

```python
>>> range(1, 7, 2)[1:]
JavascriptError: range.$factory is not a function  # before
>>> range(1, 7, 2)[1:]
range(3, 7, 2)  # after
```

## [x] `bool` bitwise ops are JS logical ops and only guard one operand

**Impact: statistics `_integer_sqrt_of_frac_rto` (`a | (a*a*m != n)`) returned
even roots — `2 | True` was `2`.** `bool.nb_or/nb_and` use JS `||`/`&&`
(logical, not bitwise), and the guard tests `other` only. Called directly with
two bools that *happens* to work; called REFLECTED (`bool.__ror__`, which
Brython's subclass-priority dispatch in `rich_op1` selects for `int OP bool`
since bool subclasses int), `self` is the INT: `bool.nb_or(2, True)` hit
`self || other` = JS `2 || true` = `2`. Same shape for `&` (`2 && true` =
`true`) and the xor guard. Fix: two booleans → bool of the BITWISE result;
otherwise delegate both coerced operands to the int op; NotImplemented for
non-ints (`www/src/py_int.js` region, `bool.nb_and/nb_xor/nb_or`).

```python
>>> 2 | True
2  # before
>>> 2 | True
3  # after
```

## [x] `math.isinf` doesn't coerce via `__float__`; `math.fsum` ignores special values

**Impact: test_statistics 359→364 (+5)** — the whole inf-family
(ApproxEqualSpecials/ExactRatio/SumSpecialValues/TestMean `test_inf`,
TestFMean `test_special_values`). Two gaps in Brython's `math` (VFS
`libs/math.js`):
1. `isinf(x)` returned `_b_.float.$funcs.isinf(x)`, which reads `x.value` —
   undefined on a `Decimal` → always False, where CPython coerces any
   `__float__`-able argument (`isnan`/`isfinite` already went through
   `float_check`). Now falls back to `float_check`.
2. `fsum` is the plain msum recipe: `Infinity + -Infinity` → silently `nan`.
   CPython tracks `inf_sum`/`special_sum` and raises
   `ValueError('-inf + inf in fsum')` on mixed infinities, returns ±inf /
   nan otherwise. Faithful translation added.

```python
>>> math.isinf(Decimal('inf'))
False  # before
>>> math.isinf(Decimal('inf'))
True  # after
```

```python
>>> math.fsum([float('inf'), float('-inf')])
nan  # before
>>> math.fsum([float('inf'), float('-inf')])
ValueError: -inf + inf in fsum  # after
```

## [x] `JavascriptArray` doesn't support slicing (nor negative indices)

**Impact: test_csv 111→115 (+4)** — `DictReader` with extra fields does
`row[lf:]` on the row, and a row built C-side (`PyList_New`, _csv reader) is a
`JavascriptArray`; its `mp_subscript` went straight to `$B.PyNumber_Index(i)` →
"'slice' object cannot be interpreted as an integer"
(test_read_long ×3 + test_ordered_dict_reader). Also `row[-1]` read `self[-1]`
= undefined. Add a slice branch (via `slice.tp_funcs.indices`, items keep their
JS-side reps like `sq_concat` does) and normalize negative indices
(`www/src/js_objects.js`, `js_array.mp_subscript`).

```python
>>> next(csv.reader(io.StringIO("1,2,abc,4\r\n")))[2:]
TypeError: 'slice' object cannot be interpreted as an integer  # before
>>> next(csv.reader(io.StringIO("1,2,abc,4\r\n")))[2:]
['abc', '4']  # after
```

## [x] `memoryview[::k]` (stepped slice) reported itself C-contiguous

**Impact: completes `struct.pack_into` into array/memoryview buffers —
test_struct 26→28 (+2), jointly with the bridge `'w*'` writable-buffer fix in
`CHANGELOG.md`.** In CPython `mv[::2]` / `mv[::-1]` is a *non-contiguous* view, so
`pack_into`'s `getbuffer(PyBUF_WRITABLE)` rejects it with TypeError
(`test_pack_into` asserts this). Brython's `memoryview.mp_subscript` turns any
slice into `memoryview.$factory(self.obj[key])` — and for a stepped slice
`self.obj[key]` is a fresh *contiguous* copy, so the view looked contiguous and
`pack_into` silently wrote into the throwaway instead of raising. Mark the result
non-contiguous when the slice step is not 1 (`www/src/py_buffer.js`,
`memoryview.mp_subscript`):

```js
// avant : if($B.get_class(key)===_b_.slice){return memoryview.$factory(res)}
// après :
if($B.get_class(key)===_b_.slice){var mv=memoryview.$factory(res)
    var st=key.step
    if(st!==undefined && st!==_b_.None && st!==1 && st!==1n){
        mv.c_contiguous=false; mv.f_contiguous=false; mv.contiguous=false}
    return mv}
```

## [x] `JavascriptArray` is unpicklable ("Can't pickle <class 'JavascriptArray'>")

**Impact: keystone of test_array 596→620 (+24)** — unblocks the `jsobj2pyobj` /
`reversed.__reduce__` fixes below. A list built C-side (`array.tolist()`, used by
array's proto-`<3` `__reduce_ex__`) comes back as a `JavascriptArray`, not a
`list`: Brython 3.14's `get_class` keys `list` off `ob_type`, and a C array has
none. Brython's pure-Python `pickle` then has no handler for `JavascriptArray`
and raises. Making the *list* a real list globally (`PyList_New` →
`ob_type=list`) regressed wasthon's own `_pickle` by −159 (4136 native
`allocation size overflow`s — `JavascriptArray.__reduce_ex__` is a far smaller,
non-regressing surface), so instead `JavascriptArray` is made directly picklable.

```python
>>> import array, pickle
>>> pickle.loads(pickle.dumps(array.array('i', [1, 2, 3]), 0))
PicklingError: Can't pickle <class 'JavascriptArray'>: it's not found as builtins.JavascriptArray   # before (tolist() in the reduce)
array('i', [1, 2, 3])                                                                              # after
```

Fix (`www/src/js_objects.js`, `JavascriptArray.tp_funcs`): add `__reduce_ex__`
returning `(list, (tuple(items),))` — pickle it as a plain list, items in a
tuple so it never recurses back into itself.

## [x] `jsobj2pyobj` re-wraps an already-Python callable into a `JavascriptFunction`

**Impact: part of test_array 596→620 (+24)** — this + `reversed.__reduce__` +
the `JavascriptArray.__reduce_ex__` fix below (the third is what makes
`array.tolist()` picklable under Brython's pickle; the obvious alternative,
`PyList_New` setting `ob_type=list`, regressed wasthon's own `_pickle` −159 with
4136 allocation-size-overflows and was abandoned). `jsobj2pyobj` (`js_objects.js`) converts a raw JS
value to a Python one; container `$factory` runs it on every element. For a JS
**function** it built a fresh `JavascriptFunction` wrapper — even when the
function was already a Python callable (`ob_type` set, e.g. a
`builtin_function_or_method` like `iter`). So an array iterator's
`__reduce__` → `(iter, (array,), index)`, once the tuple was materialised, held
a throwaway `JavascriptFunction` named `'tramp'` (`__module__='builtins'`)
instead of `iter` — and `pickle` couldn't save it.

```python
>>> from browser import window
>>> window.Array(iter)[0] is iter   # a builtin round-tripped through a JS array
False   # before
True    # after
```

Fix (`www/src/js_objects.js`, `jsobj2pyobj`): in the `typeof jsobj==="function"`
branch, `if(jsobj.ob_type!==undefined){return jsobj}` — an object that already
carries a Brython type is already Python; return it unchanged.

## [x] `reversed.__reduce__` / `reversed.__setstate__` are empty stubs (unpicklable)

**Impact: part of test_array 596→620** (`test_reverse_iterator_picking`; with
the `jsobj2pyobj` + `JavascriptArray.__reduce_ex__` fixes).
`reversed_funcs.__reduce__`/`__setstate__` (`py_builtin_functions.js`) were
`function(self){}` — returning `undefined`, so `pickle.dumps(reversed(x))` got a
NULL reduce ("can't pickle"). Implemented per CPython `reversed_reduce`: a
`reversed` keeps a `counter` (= CPython's `index` + 1), so

```python
>>> class S:                       # a sequence with no __reversed__ (list/str/range have theirs)
...     def __getitem__(self, i): return [10, 20, 30][i]
...     def __len__(self): return 3
...
>>> reversed(S()).__reduce__()
<Javascript undefined>                    # before
(<class 'reversed'>, (<S object>,), 3)    # after
```

Fix: `__reduce__` returns `(type(self), (seq,), counter)`; `__setstate__`
restores `counter` (clamped to `[-1, len]`) **and returns `None`** — a JS
function that falls off the end returns `undefined`, which `pickle`'s
`load_build` reads as a NULL result (setstate "raised"), corrupting the
unpickle stack of any tuple that contains the `reversed`.

## [x] `str.title()` uppercases the first letter instead of titlecasing it

**Impact: +1** (`test_unicodedata` bug_4971). A real Brython bug worth
upstreaming. (The larger `test_method_checksum` still fails — it also hashes
`upper`/`lower`/predicates over every codepoint, which diverge elsewhere; that's
a separate, deeper Unicode-data issue.)

`str.title()` must map the first letter of each word through the Unicode
**titlecase** mapping, which differs from uppercase only for the digraph letters
(DŽ/LJ/NJ/DZ families, U+01C4–01CC and U+01F1–01F3). Brython uppercased a
leading `Ll` char (`char.toUpperCase()`) and kept a leading `Lu`/`Lt` char
as-is — both wrong for those 12 codepoints — and `istitle` (defined as
`title(s) == s`) inherited the bug.

```python
>>> [c.title() for c in '\u01c4\u01c5\u01c6']   # the DŽ digraph family
['\u01c4', '\u01c5', '\u01c4']   # before
['\u01c5', '\u01c5', '\u01c5']   # after — all → U+01C5 (titlecase)
```

Fix (`www/src/py_string.js`, `str.title`): titlecase the first letter of each
word via a 12-entry digraph map (else `toUpperCase()`), lowercase the rest.

## [x] `str.isalnum()` missed `Other_Numeric` characters (used a fixed category list)

**Impact: +0 on the sweep** (the `test_unicodedata` checksum still diverges on
deeper Unicode-data gaps), but a real Brython bug worth upstreaming. CPython
defines a char as alphanumeric iff `isalpha() or isdecimal() or isdigit() or
isnumeric()`. Brython instead tested membership in a fixed category list
`['Ll','Lu','Lm','Lt','Lo','Nd']`, which omits the characters that only
`isnumeric()` accepts (general category `Nl`/`No` with a numeric value, e.g.
fractions and CJK numerals).

```python
>>> '½'.isalnum()   # ½ VULGAR FRACTION ONE HALF (isnumeric → True)
False   # before
True    # after
```

Fix (`www/src/py_string.js`, `str.isalnum`): test each char with
`isalpha|isdecimal|isdigit|isnumeric`, matching CPython's definition.

## [x] `str.istitle()` returned True for uncased strings (`title(s) == s`)

**Impact: +0 on the sweep** (same deeper-Unicode-data checksum), real Brython
bug. `istitle` was defined as `len(s) > 0 and title(s) == s`, so any string with
no cased characters (`'0'`, `'  '`, `'\x00'`) was wrongly titlecased — CPython
requires **at least one cased character** in the title pattern.

```python
>>> '0'.istitle()
True    # before
False   # after
```

Fix (`www/src/py_string.js`, `str.istitle`): scan the string for the title
pattern — a cased run must begin with `Lu`/`Lt`, lowercase only follows a cased
char — and require at least one cased character (the CPython algorithm). (This
supersedes the earlier `str.istitle` entry that only restored the missing
`str.title` reference.)

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

## [x] `int.__truediv__` broken on big ints: `(2**1200)/(2**1100)` = nan, `1/2**1074` = 0.0
**Impact: +1 test** (test_statistics test_random_25177; zero regression on statistics/
random/math/cmath/decimal/zlib). Generic correctness fix: every `int/int` where an
operand exceeds 2**53 (and every `float(Fraction)`, which divides numerator by
denominator) was wrong or NaN.

**Symptom:** `(2**1200)/(2**1100)` → `nan` (expected `2**100`), `1/2**1074` → `0.0`
(expected `5e-324`, the min subnormal), and ordinary big-int quotients were off by
several ulps (double-rounding through two lossy conversions).

**Root cause:** `py_int.js`, `int.nb_true_divide` converts both operands to double
*before* dividing: `Number(x)/Number(y)`. Any operand ≥ 2**1024 becomes `Infinity`
(Inf/Inf = NaN), any ≥ 2**53 loses bits before the division, and subnormal results
underflow to 0 through the intermediate conversion.

**Fix** — `py_int.js`, `int.nb_true_divide`: port of CPython's `long_true_divide`
(`Objects/longobject.c`) on BigInt — divide first, convert once, with correct
round-half-to-even at the right bit position (handles subnormals without double
rounding, raises OverflowError like CPython):

```js
// after the existing NULL / ZeroDivisionError guards:
var negate=(x<0n)!=(y<0n)
if(x<0n){x=-x}
if(y<0n){y=-y}
if(x===0n){return $B.fast_float(negate ? -0.0 : 0.0)}
var bx=x.toString(2).length,by=y.toString(2).length,diff=bx-by
var shift=Math.max(diff,-1021)-55          // -1021 = DBL_MIN_EXP
var q,r
if(shift>=0){var ys=y<<BigInt(shift);q=x/ys;r=x%ys}
else{var xs=x<<BigInt(-shift);q=xs/y;r=xs%y}
if(r!==0n){q|=1n}                          // sticky bit
var qbits=q.toString(2).length
var extra=Math.max(qbits,-1021-shift)-53   // 53 = DBL_MANT_DIG
var half=1n<<BigInt(extra-1),low=q&((half<<1n)-1n)
q>>=BigInt(extra)
if(low>half||(low===half&&(q&1n))){q+=1n}  // round-half-to-even
shift+=extra
var res=Number(q)*2**shift                 // both factors exact ⇒ product exact
if(!isFinite(res)){$B.RAISE(_b_.OverflowError,'integer division result too large for a float')}
return $B.fast_float(negate ? -res : res)
```

Validated bit-exact against CPython on 3006 differential cases (random 1–1200-bit
operands, signs, subnormals, ties, overflow) plus 200k random small-int cases.
The `rich_op1` small-int fast path (`typeof x == "number"`) is untouched.

## [x] TextIOWrapper line iteration ignores the `newline` mode (csv `lineterminator='\r'` roundtrips broken)
**Impact: +2 tests** (test_csv roundtrip_escaped_unquoted_newlines + roundtrip_quoteed_newlines,
`lineterminator='\r'` subtests; zero regression on bz2/lzma/zstd/array/zlib) —
**test_csv 122/122 runnable = 3rd suite at 100%.**

**Symptom:** a file written with `newline=''` and `'\r'` line endings comes back
as ONE giant line when iterated — `_csv.Error: new-line character seen in
unquoted field` on read-back.

**Root cause:** `wasthon-io-write.js` `G.readline` split only on `'\n'`,
whatever the TextIOWrapper `newline` mode. CPython semantics: `newline=None`
translates `\r\n`/`\r` → `\n` on input (ensureText already did this, so '\n'
split was right); `newline=''` does NOT translate and a line ends at `\r\n`,
`\r` or `\n` (terminator kept); an explicit `'\r'`/`'\r\n'` splits only on
that exact string.

**Fix** — `wasthon-io-write.js` `G.readline`: branch on `s.$newline` — `null`/
`'\n'` keep the old indexOf('\n'); `''` takes min(indexOf('\r'), indexOf('\n'))
with `\r\n` lookahead; explicit terminators use indexOf(that string). All
indexOf-based (no per-char scan).


## [x] `_thread`/`_contextvars` VFS predate 3.14: threads silently do nothing
**Impact: +1 test** (test_hashlib test_threaded_hashing — **hashlib 73/73 runnable,
4th suite at 100%**) + the whole threading surface unblocked for other suites.

**Symptom:** `threading.Thread(target=f).start()` raised
`TypeError: start_new_thread() got an unexpected keyword argument 'handle'`;
after aliasing, threads "ran" but the target was never executed (a shared
hasher stayed at the empty digest).

**Root cause (two layers):**
1. `_thread` VFS: `start_joinable_thread = start_new_thread` — but 3.14's
   `threading.Thread.start()` calls
   `_start_joinable_thread(bootstrap, handle=..., daemon=...)`, and
   `_ThreadHandle` was an empty `pass` class (`threading` needs
   `.join()`/`.is_done()`).
2. `_contextvars` VFS is an auto-generated skeleton whose methods are repr
   STRINGS — `Context.run` was literally
   `"<method 'run' of 'Context' objects>"`, so `_bootstrap_inner`'s
   `self._context.run(self.run)` raised `TypeError: 'str' object is not
   callable`… swallowed by `_invoke_excepthook` (stderr), making the
   no-op look like a passing thread.

**Fix (vendored brython_stdlib.js):**
```python
# _thread
def start_joinable_thread(function, handle=None, daemon=True):
    start_new_thread(function, ())     # dummy threads run synchronously
    return handle if handle is not None else _ThreadHandle()

class _ThreadHandle:
    ident = -1
    def join(self, timeout=None): pass
    def is_done(self): return True

# _contextvars
class Context:
    def run(self, callable, *args, **kwargs):
        return callable(*args, **kwargs)
```

## [x] `_IOBase` finalize/iteration/`__enter__` defects (bz2 closed-file family)
**Impact: +2 tests** (test_bz2 testOpenDel + testClosedIteratorDeadlock → bz2 92;
zero regression on csv/lzma/zstd/zlib).

Three defects in the native `_IOBase` layer (vendored brython.js):

1. **`tp_finalize`**: `$B$call(...)` typo (ReferenceError on every `del f`
   of an open file) + a leftover debug `console.log('del', self)`.
2. **`tp_iternext`**: `next(f)` without `iter(f)` crashed — the slot read
   `self.readline`, which only `tp_iter` assigns. Now resolves readline
   itself as a fallback. ★ The slot MUST stay a generator function —
   rewriting it as a plain return-null function broke every StringIO
   iteration path (csv −10): the generator form is the convention
   Brython's iteration protocol consumes for this slot.
3. **`__enter__` (`_IOBase` + the `_BufferedIOBase` shadow copy)**: no
   closed-check, so `with closed_file:` silently succeeded. Now raises
   ValueError like CPython's `_checkClosed()`. The check reads `closed`
   defensively ($getattr in a try): on some native classes (StringIO) the
   getset resolution crashes with "func.getter is not a function".

**Known landmines documented for the next io session:**
- `_BufferedIOBase.__exit__` returns `true` → SUPPRESSES every with-block
  exception (testContextProtocol's `1/0`). Making it faithful
  (`return False`) measured **−31 on bz2 alone** through an
  order/state interaction never diagnosed (plain `with` probes pass).
  Bisected twice; needs a dedicated session.
- `_bufferedreader_readline` assumes the `raw.$bytes` snapshot; the
  no-seek read(1) fallback for stream raws (DecompressReader) measured
  −31 as well (2nd confirmation after the zstd −57 scar). Real design:
  buffer inside the BufferedReader.

## [x] io stack: faithful `__exit__` + in-`BufferedReader` stream buffer + the cascade it unmasked

**Impact: bz2 95→97, lzma 115→117, zstd 105→108, zero regression** (full sweep
of all 21 suites). This is the "dedicated session" the two landmines above
called for. Source: `www/src/py_io.js` + the JS-defined io in `www/src/libs.js`
(BytesIO) + `www/src/py_memoryview.js`, vendored in `loader/brython/brython.js`
and `loader/brython/brython_stdlib.js`.

Root: `_BufferedIOBase.__exit__` returned `true`, suppressing every exception
raised inside a `with` block. That single lie masked a cascade of broken file
operations — every test whose body raised got swallowed and "passed". The −31
"interaction" was never an interaction: it was the unmasked latent bugs
surfacing once `__exit__` stopped hiding them. Making `__exit__` faithful
(return `None`, like CPython `IOBase.__exit__ = self.close()`) then fixing each
unmasked bug:

1. **streaming `BufferedReader`** — read/readline/peek/read1 assumed a
   `raw.$bytes` whole-file snapshot, which streaming raws
   (`_compression.DecompressReader` behind bz2/lzma) don't have. Now an
   in-reader `$pending` byte buffer is fed by `raw.read()`; `read_fast` drains
   it then reads *exactly* n (never reads ahead, so the raw position stays in
   sync for `seek`). The "buffer inside the BufferedReader" the landmine asked for.
2. **`BufferedReader.seek`** — `$B.args('seek',2,…)` had argcount 2 for a 3-arg
   signature (`takes 2 positional but 3 given` on every `seek(off,whence)`); and
   it poked `$byte_pos` instead of delegating. Now argcount 3 + delegates to
   `raw.seek` for streaming raws.
3. **`BufferedReader.read1` / `read` validation** — added `read1`; `read`/`read1`
   run the arg through `PyNumber_Index` so `read(1.0)` raises TypeError.
4. **`BufferedReader.name`/`fileno` + `FileIO.name`/`closed`** — name forwards to
   the raw; `FileIO.name` is writable (tempfile assigns `raw.name = fd`);
   `FileIO.closed` reflects the fd-backed `self.closed`/`self.fd` the io-write
   layer tracks (the inherited `_IOBase.closed` read the unset `self._closed`).
5. **`io.BytesIO.close`** — called `$B._BufferedIOBase.close(self)` (undefined;
   the method lives in `.tp_funcs.close`) → `is not a function` on every
   `BytesIO().close()`, swallowed by the old `__exit__`.
6. **`io.BytesIO.readlines`** — returned a raw JS array, not a `list`
   (`assertListEqual` "second sequence is not a list").
7. **`TextIOWrapper.readline`** — ignored the `newline` arg (always split on
   `\n`); now honors None/'' (universal: `\n`/`\r`/`\r\n`) vs a literal separator,
   with `\r\n` handling and None→`\n` translation.
8. **`io.UnsupportedOperation`** — was `make_type([OSError])`; CPython is
   `(OSError, ValueError)`, so `assertRaises(ValueError, f.read)` on a write-mode
   file (the `_bad_args` tests) now matches.
9. **`memoryview(array).nbytes`** — the factory hard-codes `itemsize:1`, so nbytes
   over an `array('Q')` was the element count not the byte length; `nbytes_get`
   now falls back to the source object's real itemsize (and used the loop var `x`
   instead of `product`).
10. **read-only `getset_descriptor` setter** (`descriptors.js`) — the root behind
   the read-only getsets in (4). A read-only getset stores its setter as
   `_b_.None`, but `closed_set`/`name_set` are assigned in `py_io.js` before
   `_b_.None` exists (load order), so they land `undefined`. `tp_descr_set`
   tested `self.setter === _b_.None`, so a read-only write fell through to
   `self.setter(obj, value)` → `self.setter is not a function`. Now it tests
   `typeof self.setter !== 'function'`, raising AttributeError for any
   non-callable setter.

```python
>>> open('x', 'wb').closed = True
TypeError: self.setter is not a function                              # before
>>> open('x', 'wb').closed = True
AttributeError: attribute 'closed' of '_io.FileIO' objects is not writable  # after
```

## [x] `open(bytes_filename)` decodes the name, losing the original bytes

**Impact: +1 test_bz2** (`testOpenBytesFilename`: `BZ2File(os.fsencode(name)).name`
must be the bytes filename, not a str). Source: `www/src/py_io.js` (`_io_open_impl`).

CPython's `open()` fsdecodes a bytes filename only to perform the actual open; it
keeps the original bytes object as the file's `.name`. `_io_open_impl` decoded
`path_or_fd` in place and passed the str on to `_FileIO`, so `.name` came back a
str. Fix: remember the filename before the fsdecode and, when it was decoded,
restore the original on the raw object after construction.

```python
>>> open(b'/tmp/x', 'wb').name
'/tmp/x'    # before
>>> open(b'/tmp/x', 'wb').name
b'/tmp/x'   # after
```

## [x] `_warnings.warn` with an `'error'` filter crashes on a non-SyntaxWarning

**Impact: +1 test_hmac** (`test_legacy_block_size_warnings`: under
`simplefilter('error', RuntimeWarning)`, `hmac.HMAC(...)` must raise the
RuntimeWarning). Source: `www/src/builtin_modules.js` (`_warnings.warn`).

When the active filter's action is `'error'`, `warn()` unconditionally built a
`SyntaxError` from `message.args[0]` / `message.filename` / `.offset` — fields
only a `SyntaxWarning` instance carries. For any other warning (and for the
common `warn("text", SomeWarning)` form where `message` is a *str*),
`message.args` is `undefined` → `JavascriptError: can't access property 0`.
CPython's `'error'` action raises the warning itself. Fix: keep the
SyntaxWarning→SyntaxError path, otherwise raise the warning instance (or
`category(message)` when `message` is a plain string).

```python
>>> import warnings
>>> warnings.simplefilter('error', RuntimeWarning)
>>> warnings.warn('boom', RuntimeWarning)
JavascriptError: can't access property 0, message.args is undefined   # before
>>> warnings.warn('boom', RuntimeWarning)
RuntimeWarning: boom                                                  # after
```

## [x] `bytes.decode('utf-8')` strips a leading BOM (U+FEFF)

**Impact: +2 test_json** (`test_string_with_utf8_bom`, C + Py: `json.loads` must
raise on a leading BOM). Source: `www/src/py_bytes.js` (`$B.decode`).

`$B.decode`'s utf-8 fast path did `new TextDecoder('utf-8', {fatal: true})`, and
`TextDecoder` defaults to `ignoreBOM: false` — so a leading U+FEFF was silently
dropped. CPython's utf-8 codec keeps it (only `utf-8-sig` strips it), so
`b'\xef\xbb\xbf[1,2,3]'.decode('utf-8')` came back `'[1,2,3]'` instead of
`'﻿[1,2,3]'`, and json's BOM guard never fired. Now `{fatal: true,
ignoreBOM: true}` (matching the C-side DecodeUTF8 fix).

```python
>>> len('[1,2,3]'.encode('utf-8-sig').decode('utf-8'))
7   # before
>>> len('[1,2,3]'.encode('utf-8-sig').decode('utf-8'))
8   # after
```

## [x] `sys.set_int_max_str_digits` / `get_int_max_str_digits` missing

**Impact: +2 test_json** (`test_limit_int`, C + Py — with the harness modelling
`test.support.adjust_int_max_str_digits`). Source: `www/src/builtin_modules.js`
(the `sys` module object).

The int<->str conversion limit was a fixed `$B.int_max_str_digits = 4300`; the
int parser already consulted it dynamically, but `sys` exposed no getter/setter,
so `sys.set_int_max_str_digits(5000)` raised AttributeError and the limit could
never be raised or lowered at runtime. Added both functions (the setter validates
`0` or `>= 640` like CPython and recomputes the str-side `$B.max_printable`).

```python
>>> import sys
>>> sys.get_int_max_str_digits()
AttributeError: module 'sys' has no attribute 'get_int_max_str_digits'   # before
>>> sys.get_int_max_str_digits()
4300                                                                     # after
```

## [x] `float` is missing `__float__`

**Impact: enables +3 test_cmath** (with the bridge `PyComplex_AsCComplex` fix:
`test_input_type`, `test_decimals`, `test_fractions`). Source: `www/src/py_float.js`
(`float.tp_funcs` + `tp_methods`).

`int` had `__float__` but `float` did not, so `(2.0).__float__()` raised
AttributeError (CPython returns the float itself). The method was absent from both
`float.tp_funcs` and the `tp_methods` registration list. Added
`float_funcs.__float__` (returns `self`) and `"__float__"` to `tp_methods`.

```python
>>> (2.0).__float__()
AttributeError: 'float' object has no attribute '__float__'   # before
>>> (2.0).__float__()
2.0                                                           # after
```

## [x] `range` fast-iterator mixes BigInt and Number on a large-int range (`list(range(2**60, 2**60+2))` crashes)

**Impact: iterating a range with a bigint bound no longer raises.** `range.tp_iter`/`tp_iternext` normalise the bounds with `to_bigint` when the range is not `$safe`, but the faster `range[FAST_ITER]` path (used by `list()`/`set()`/`for` via `make_js_iterator`) read `self.start`/`self.step` directly: a bigint `start` with a Number `step` made `ix += step` a `BigInt + Number` mix, which SpiderMonkey rejects ("can't convert BigInt to number"). Now FAST_ITER mirrors `tp_iter` — bigint-normalise when not `$safe` and yield `int.$int_or_long(value)`. Source: `www/src/py_range.js` (`range[$B.FAST_ITER]`).

```python
>>> list(range(2**60, 2**60 + 2))
JavascriptError: can't convert BigInt to number   # before
>>> list(range(2**60, 2**60 + 2))
[1152921504606846976, 1152921504606846977]        # after
```

## [x] `set`/`frozenset` discards a hash-colliding element (`set([-2, -1])` loses one)

**Impact: a set keeps distinct elements that share a hash.** With `hash(-1) == hash(-2) == -2` (see the `hash(-1) -> -2` fix above), adding the second element took the `else` branch of `set_add`, which did `so.$store[hash] = []` — replacing the whole bucket and dropping the element already stored there, while still bumping `$used`. The set then reported `len == 2` but `-2 in s` was `False`, and iteration / `==` saw only one element. Now `set_add` appends to an existing bucket instead of recreating it. Source: `www/src/py_set.js` (`set_add`).

```python
>>> s = set([-2, -1]); len(s), (-2 in s), s == set([-1, -2])
(2, False, False)   # before
>>> s = set([-2, -1]); len(s), (-2 in s), s == set([-1, -2])
(2, True, True)     # after
```

Together these two fix **+2 test_random** (`test_rangelimits` for MersenneTwister and SystemRandom: `set(range(start, stop)) == set(randrange(...) samples)` over both small-negative and `±2**60` ranges).

## [x] A bound `method-wrapper`'s `__name__` returns the bound object's name, not the method's

**Impact: `"".__len__.__name__` returns `'__len__'`.** The `method-wrapper` `__name__` getter returned `self.self.__name__` — `self.self` is the *bound object*, so the name came from the instance (which usually has no `__name__`) instead of the wrapped slot. The slot name is already stored as `self.d_name` (used by the wrapper's `repr`); `__name__` now returns it. Source: `www/src/descriptors.js` (`method_wrapper.__name__`).

```python
>>> "".__len__.__name__
AttributeError: 'str' object has no attribute '__name__'  # before

>>> "".__len__.__name__
'__len__'                                                 # after
```

## [x] `object.__setattr__` accepts a non-string attribute name

**Impact: `object().__setattr__(range(3), 0)` raises `TypeError`.** `object.tp_setattro` never checked that the name is a string, so a non-string fell through to the no-`__dict__` path and raised `AttributeError`. The builtin `setattr`/`getattr`/`delattr` already reject a non-string name, but the generic setattr — reached by a direct `__setattr__` call — did not. Now it raises `TypeError`. Source: `www/src/py_object.js` (`object.tp_setattro`).

```python
>>> object().__setattr__(range(3), 0)
AttributeError: 'object' object has no attribute 'range...' and no __dict__ for setting new attributes  # before

>>> object().__setattr__(range(3), 0)
TypeError: attribute name must be string, not 'range'  # after
```

Together these two fix **+1 test_pyexpat** (`test_invalid_attributes`): unittest's `assertRaises(TypeError, parser.__setattr__, range(0xF), 0)` does `self.obj_name = callable.__name__` in `handle()`, so a `method-wrapper.__name__` of `undefined` poisoned that setattr (raising the misleading "can't set attributes of object type") before the call under test even ran.

## [x] `mappingproxy` comparison is broken — `tp_richcompare` is empty

**Impact: `MappingProxyType({'a': 1}) == {'a': 1}` returns `True`.** `mappingproxy.tp_richcompare` was an empty function returning `undefined`, so any rich comparison of a mappingproxy was wrong (e.g. `re.Pattern.groupindex`, a C type's `__dict__`). Now it compares the underlying mapping via `$B.rich_comp`. Source: `www/src/py_dict.js` (`mappingproxy.tp_richcompare`).

```python
>>> from types import MappingProxyType
>>> MappingProxyType({'a': 1}) == {'a': 1}
False  # before
>>> MappingProxyType({'a': 1}) == {'a': 1}
True   # after
```

## [x] `mappingproxy` len / `[]` / `in` / `get` / iteration miss non-string keys

**Impact: a key that is not stored as a plain JS string property — an astral `str`, a tuple, any boxed/object key — is invisible through a `mappingproxy`.** The read methods used raw JS (`Object.keys(self.mapping).length`, `self.mapping.hasOwnProperty(key)`, `self.mapping[key]`, `for (key in self.mapping)`) instead of delegating to the underlying mapping, so they only saw keys held as enumerable JS string properties. An astral group name in `re.Pattern.groupindex` (a `mappingproxy`) reported `len 0`, `name in proxy` False and `proxy[name]` KeyError even though the wrapped dict held it. Now `mp_length` / `mp_subscript` / `sq_contains` / `get` / `mappingproxy_iter_items` delegate to `dict.mp_length` / `$getitem` / `$contains` / `$iter_items`, which handle both the fast string-property store and the hash table. Source: `www/src/py_dict.js`.

```python
>>> import re
>>> p = re.compile('(?P<𝔘𝔫𝔦𝔠𝔬𝔡𝔢>x)')
>>> len(p.groupindex), '𝔘𝔫𝔦𝔠𝔬𝔡𝔢' in p.groupindex
(0, False)  # before
>>> len(p.groupindex), '𝔘𝔫𝔦𝔠𝔬𝔡𝔢' in p.groupindex
(1, True)   # after
```

## [x] astral string literal containing a backslash has wrong surrogate positions

**Impact: indexing a `str` literal that has an astral char somewhere after a backslash returns surrogate halves.** A string constant was emitted as `$B.make_String('<value>', [<surrogates>])`, the positions computed by `$B.surrogates(<value>)` over the still-escaped source. `$B.surrogates` re-resolved escapes but counted `\\` as two code points, while the emitted JS string literal evaluates `\\` to one — so every astral position shifted by +1 for any literal with a backslash before an astral char (e.g. the raw template `r'\g<𝔘…>'`). `$B.surrogates` is now a plain code-point scan, and the codegen emits `$B.String('<value>')`, recomputing the positions on the evaluated value. Source: `www/src/py_string.js` (`$B.surrogates`), `www/src/ast_to_js.js` (`Constant.to_js`).

```python
>>> s = '\\g<𝔘>'
>>> [hex(ord(s[i])) for i in range(len(s))]
['0x5c', '0x67', '0x3c', '0x1d518', '0xdd18']  # before — s[4] is a lone low surrogate
>>> [hex(ord(s[i])) for i in range(len(s))]
['0x5c', '0x67', '0x3c', '0x1d518', '0x3e']    # after — s[4] is '>'
```

## [x] 3-arg `pow()` leaks NotImplemented instead of raising TypeError

**Impact: `pow(Decimal(1), 2, "3")` returns NotImplemented instead of raising TypeError.** When the base is not int/float/complex, `pow(x, y, z)` tries `x.__pow__(y, z)` then `y.__rpow__(x, z)` — but returned the latter's result verbatim. When both are NotImplemented (here `_decimal`'s nb_power rejects the str modulus by returning NotImplemented, and `int.__rpow__` of a Decimal base does too), the NotImplemented leaked out as the value of `pow()`. CPython raises `TypeError: unsupported operand type(s) for pow()`. `pow` now raises TypeError once the ternary `__pow__`/`__rpow__` are exhausted. Source: `www/src/py_builtin_functions.js` (`pow`).

```python
>>> from decimal import Decimal
>>> pow(Decimal(1), 2, "3")
NotImplemented   # before
>>> pow(Decimal(1), 2, "3")
TypeError: unsupported operand type(s) for pow(): 'decimal.Decimal', 'int', 'str'   # after
```

## [x] `dir(module)` exposes Brython's `$annotations` internal

**Impact: `dir(m)` lists `$annotations`.** A module whose source carries annotations gets a `$annotations` entry in its namespace (the codegen emits `locals.$annotations = {}`), and `module.__dir__` returned every namespace key — so the compiler artifact leaked into `dir()`. No Python identifier can start with `$`, so these internals must stay hidden. `module.__dir__` now skips `$`-prefixed keys.

```python
>>> import _decimal
>>> '$annotations' in dir(_decimal)
True    # before
>>> '$annotations' in dir(_decimal)
False   # after
```

## [x] `float` comparison coerces any `__float__` operand, losing precision

**Impact: `0.1 == Decimal('0.1')` returns True.** `float.tp_richcompare` converted any operand carrying an `nb_float`/`__float__` to a float and compared raw values — so a `Decimal` was rounded to the float `0.1` and compared equal. CPython's `float_richcompare` compares directly only against int and float (exactly); for any other type it returns NotImplemented and lets the other operand's reflected comparison decide. `float.tp_richcompare` now returns NotImplemented unless the operand is an int or float, so `Decimal.__eq__` runs and compares the exact value. Source: `www/src/py_float.js`.

```python
>>> from decimal import Decimal
>>> 0.1 == Decimal('0.1')
True    # before (float coerced the Decimal to 0.1)
>>> 0.1 == Decimal('0.1')
False   # after (compared against the exact float value 0.1000…0055)
```

> ⚠ **VENDORED-ONLY — the bug stays in upstream Brython.** It only surfaces when the operand carries the C `nb_float` slot on a non-int/float type, i.e. a C-accelerated `_decimal` (wasthon's). Brython's own `decimal` is pure-Python `_pydecimal` with no `nb_float` slot, and a Python class with `__float__` doesn't get one either — so there is no failing case in a vanilla Brython. The fix matches CPython's `float_richcompare`, but with no reproducer it isn't worth an upstream PR. Branch `float-compare-int-float-only` is pushed to the fork for the record but should NOT be opened; the latent bug remains upstream.

## [x] `raw-unicode-escape` decode leaves `\UXXXXXXXX` escapes as literal text

**Impact: pickle protocol 0 loses every astral char (+2 pickle, `test_unicode`/`test_unicode_high_plane` × CDumpPickle_LoadPickle; general).** Protocol 0 stores a `str` as its raw-unicode-escape encoding, where a non-BMP char becomes the 8-hex escape `\U00012345` — CPython's decoder turns it back into the char, Brython's only matched `\u` + 4 hex digits and passed `\U` + 8 through as literal text, so the pure-Python Unpickler returned `'\\U00012345'` (11 chars) instead of `'𒍅'`. Also needed `String.fromCodePoint` (the existing `fromCharCode` cannot build an astral char), plus the same out-of-range guard CPython applies for values beyond U+10FFFF. Source: `decode`, case `raw_unicode_escape`, in `py_bytes.js`.

```python
>>> b'\\U00012345'.decode('raw-unicode-escape')
'\\U00012345'   # before (escape left as 11 chars of literal text)
>>> b'\\U00012345'.decode('raw-unicode-escape')
'𒍅'            # after (U+12345)
```

## [x] `__qualname__` is built from the runtime call stack, not the lexical scopes (PEP 3155)

**Impact: +2 pickle alone (`test_local_lookup_error` × C/Py picklers) and unblocks the 7 `test_evil_*` tests (next entry); general.** Three CPython rules restored. (1) A function nested in a function got a bare `__qualname__` (the compile-time walk only climbed *class* scopes), so pickle's "Can't pickle local object" path — which looks for `'<locals>'` in the qualname — never fired; enclosing function scopes now contribute `f.<locals>.` segments. (2) A class defined inside a function got a qualname built at runtime from `$B.frame_obj` — the dynamic *call* stack, unittest wrappers included (`run.__call__._callTestMethod.test_x.Bad`) — instead of the lexical scopes; `make_class_namespace` now seeds the compile-time qualname into the class dict and `$class_constructor` only falls back to the frame walk when the dict has none (the `type(name, bases, dict)` path, where CPython also honors a caller-provided `__qualname__`). (3) A name declared `global` in its defining scope gets a bare qualname (PEP 3155), which is exactly what lets CPython pickle a `global`-declared class defined inside a test method. Source: `ClassDef.to_js`/`FunctionDef.to_js` in `ast_to_js.js`, `$B.make_class_namespace`/`$B.$class_constructor` in `py_type.js`.

```python
>>> def outer():
...     def inner(): pass
...     return inner
...
>>> outer().__qualname__
'inner'                   # before
>>> outer().__qualname__
'outer.<locals>.inner'    # after
```

```python
>>> def f():
...     global Bad
...     class Bad: pass
...
>>> f()
>>> Bad.__qualname__
'f.Bad'   # before (runtime call stack — grows with the caller chain)
>>> Bad.__qualname__
'Bad'     # after (PEP 3155: global name -> bare qualname)
```

## [x] mutating a dict during iteration raises `RuntimeError('changed in iteration')`

**Impact: +7 pickle with the qualname fix above (`test_evil_class_mutating_dict` × 5 picklers, `test_evil_pickler_mutating_collection` × 2, which assert the CPython substring); general.** The five version guards in the dict iterators raised a home-grown message where CPython says `dictionary changed size during iteration`. Source: the `d[VERSION] !== version` guards in `$iter_items`/`$iter_items_reversed` in `py_dict.js`.

```python
>>> d = {1: 1}
>>> for k in d:
...     d[k + 1] = 1
...
RuntimeError: changed in iteration                        # before
RuntimeError: dictionary changed size during iteration    # after
```

## [x] `memoryview()` detects `__buffer__` (PEP 688) but never calls it, and its native-buffer check skips the MRO

**Impact: +4 pickle with the bridge PickleBuffer `__buffer__` (test_dump_load_oob_buffers / test_dumps_loads_oob_buffers × C/Py picklers); general — any PEP 688 class.** The factory's `has_buffer` accepted an object whose getattr found `__buffer__`, then built the memoryview around the object *itself* — the method was never called, so the view pointed at something the memoryview internals cannot read (`tobytes()` → `TypeError: cannot run tobytes with …`, subscription reads an undefined `obj.source`). The factory now keeps the native path for types exposing `bf_getbuffer`/`$buffer_protocol` — checked along the **MRO**, since those are plain JS properties a Python subclass of `bytes`/`bytearray` does not inherit — and otherwise *calls* `__buffer__(0)`, returning its memoryview (raising `TypeError` if it returns anything else, like `get_list_from_bytes_like` already does). The MRO walk is what keeps `bytes` subclasses on the native path: their inherited slot-wrapper `__buffer__` itself builds a `memoryview(self)`, so routing them through the call fallback would recurse into the factory forever. Source: `memoryview.$factory` in `memoryobject.js`.

```python
>>> class Chunk:
...     def __init__(self, data):
...         self.data = data
...     def __buffer__(self, flags):
...         return memoryview(self.data)
...
>>> memoryview(Chunk(b'abc')).tobytes()
TypeError: cannot run tobytes with Chunk    # before
>>> memoryview(Chunk(b'abc')).tobytes()
b'abc'                                      # after
```

## [x] `BytesIO.readinto(memoryview)` returns n but writes nothing

**Impact: THE root of the pickle "zeros" cluster (with the bridge from-memory write-back: bytes/bytearray values C-unpickled from a file came back the right length but all `\x00`); general.** `BytesIO.readinto` resolves its write target as `buffer.source` for a bytearray but **`buffer.obj` for anything else** — for a memoryview that is the underlying bytearray *object*, and `buf[i] = x` then lands on JS numeric *properties* of that object, never in its `.source` byte array. JS accepts silently, so readinto reported n bytes read and the buffer stayed untouched. The C `_pickle` Unpickler over a file object reads every `SHORT_BINBYTES`/`BINBYTES`/`BYTEARRAY8` payload through exactly this path (`_Unpickler_ReadInto` → `file.readinto(memoryview-over-C-buffer)`), which is why only the file-based pickler tests failed while `_pickle.loads(bytes)` — the memcpy fast path — always round-tripped. The target now descends to the backing `.source` (the bytearray itself, or the memoryview's underlying object). Source: `BytesIO_funcs.readinto` in `libs/_io_classes.js`.

```python
>>> import io
>>> mv = memoryview(bytearray(4))
>>> io.BytesIO(b'abcd').readinto(mv)
4
>>> bytes(mv)
b'\x00\x00\x00\x00'   # before (4 bytes "read" into nowhere)
>>> bytes(mv)
b'abcd'               # after
```

## [x] `locals()` and bare `eval()`/`exec()` don't see closure free variables (upstream #2855)

**Impact: +1 decimal — the LAST decimal fail (`PyWhitebox.test_py_immutability_operations` does `eval("d1." + op + "(d2)")` inside a nested `checkSameDec()` where `d1`/`d2` are free variables) → decimal 357/0 = 100%; general.** A nested function's frame locals object holds only its own assigned locals; free variables captured from an enclosing scope compile to direct references to the enclosing scope's locals object (`locals_outer.x`) and exist nowhere in the inner frame — so `locals()` omitted them and a bare `eval("x")` raised NameError where CPython sees them (cell/free variables are part of `frame.f_locals`). Three pieces: (1) codegen — a function whose symtable block has FREE symbols gets a hidden map in its prologue, `locals.$cells = {x: locals_outer}` (name → enclosing locals object, live, zero-copy; `$`-keys are already skipped as frame infrastructure everywhere); (2) `locals()` merges the cells into its snapshot with their current values; (3) bare `eval()`/`exec()` (the no-namespace branch) materializes the cells into `exec_locals` before compiling. An explicit namespace (`eval("x", {})`) still raises NameError, like CPython. Source: `$B.ast.FunctionDef.prototype.to_js` in `ast_to_js.js`, `_b_.locals` in `py_builtin_functions.js`, `py_eval_exec.js`.

```python
>>> def outer():
...     x = 5
...     def inner():
...         _ = x
...         return eval("x")
...     return inner()
...
>>> outer()
NameError: name 'x' is not defined   # before
>>> outer()
5                                    # after
```

## [x] `os.stat_result` can't be pickled: the class hides behind a wrapper function and lacks pickling metadata

**Impact: +5 pickle (test_structseq × all picklers); general.** Four stacked gaps in Brython's `posix` module made `pickle.dumps(os.stat(p))` impossible. (1) The module exported `stat_result` as a wrapper *function*, so pickle's `save_global` identity check (`getattr(os, 'stat_result') is type(obj)`) could never pass — the module now exports the class itself (calling a class goes through its `$factory`, so `posix.stat_result(filename)` still works). (2) The `make_type` class read `__module__ = 'builtins'` — set to `'os'` in the class dict (the route the `type.__module__` getter checks first), so `save_global` emits `os stat_result` like CPython. (3) Instances had no `__dict__` attribute (only `$class_constructor` classes get the getset), so unpickling's `inst.__dict__` read raised AttributeError — the class dict now carries the same `getset_descriptor` a Python class gets. (4) No `__eq__` (identity compare made `assert_is_copy` fail at proto 0/1) and no heap-type flag (our `object.__reduce_ex__` guard rightly refuses builtin-typed instances at proto ≥ 2) — the class dict now has `__eq__` comparing the stat-field dicts and an explicit `__reduce__` returning the `copyreg._reconstructor` shape, which round-trips at every protocol. Source: the `posix` module in `brython_stdlib.js`.

> ⚠ **Upstream split.** Only the class-identity half (export the class, `__module__ = 'os'`) is upstreamable — branch `posix-stat-result-pickle` (vanilla repro: `isinstance(1, os.stat_result)` crashes on a function). The `__dict__` getset, `__eq__` and `__reduce__` are **VENDORED-ONLY**: vanilla Brython has no filesystem, `os.stat()` fails before an instance can exist, so there is no upstream failing case to demonstrate.

```python
>>> import os
>>> import pickle
>>> pickle.loads(pickle.dumps(os.stat(os.curdir))).st_mode
TypeError: cannot pickle 'stat_result' object   # before
>>> pickle.loads(pickle.dumps(os.stat(os.curdir))).st_mode
16895                                           # after
```

## [x] unpack error messages: double space and a generic message for a non-iterable source

**Impact: message fidelity in `a, b, c = x` failures (subtests of pickle's test_bad_newobj_ex_args; the parent test needs the call-site messages too, still open).** Two gaps in the unpack helper. The "not enough values" template interpolated `${has_starred ? ' at least ' : ''} ` — a double space in the plain case (`expected  3`) and `expected  at least  3` in the starred case, where CPython writes `expected 3` / `expected at least 3`. And unpacking a non-iterable went through the generic iterator error (`'int' object is not iterable`) where the unpack opcode has its own message — the helper now catches that TypeError and raises CPython's `cannot unpack non-iterable int object`. Source: the unpack helper in `py_utils.js`.

```python
>>> a, b, c = ()
ValueError: not enough values to unpack (expected  3, got 0)   # before
>>> a, b, c = ()
ValueError: not enough values to unpack (expected 3, got 0)    # after
```

## [x] `functools.partial` says `__module__ = '_functools'`

**Impact: +6 pickle (test_unpickleable_newobj_ex_args/class/kwargs × C and Python picklers); general.** Brython defines `partial` in the pure-Python `_functools` module, so the class reads `__module__ = '_functools'` — CPython's reads `'functools'`. Every fully-qualified rendering diverged: the protocol-2/3 `__newobj_ex__` translation pickles a `functools.partial` reconstructor and decorates errors with `__notes__` like `when serializing functools.partial state` — ours said `_functools.partial`, failing the exact-list assertions (that was the ONLY difference: the six-entry notes chains matched otherwise). One line after the class definition: `partial.__module__ = 'functools'`. Source: `Lib/_functools.py`.

```python
>>> from functools import partial
>>> partial.__module__
'_functools'   # before
>>> partial.__module__
'functools'    # after
```

## [x] two bound builtin methods of the same object never compare equal

**Impact: +pickle (the instance_attribute tests assert `pickler.persistent_id == old_persistent_id` after a del); general.** Accessing a builtin method (`obj.method` on a C-style type) mints a fresh bound wrapper per access (`method_descriptor.tp_descr_get` returns `self.method.bind(null, obj)`), and with no `__eq__` on the `builtin_method` class the comparison fell back to identity — always False. CPython's `meth_richcompare` compares the underlying method and the bound object. The class dict now carries an `__eq__` returning True iff both wrappers bind the same method name of the same object (`m_self` identity + `ml.ml_name`), NotImplemented for non-builtin-method operands. Source: the `builtin_method` type wiring in `py_type.js`.

```python
>>> d = {}
>>> a = d.keys
>>> b = d.keys
>>> a == b
False   # before
>>> a == b
True    # after
```

## [x] `io.BufferedRandom` is a stub returning the string `"fileio"`

**Impact: +2 pickle (test_unpickling_buffering_readline × C/Py picklers); general.** The `_io` module's `BufferedRandom` factory literally returned the string `"fileio"` (and the class based itself on `_TextIOBase`), so `io.BufferedRandom(io.BytesIO(), buffer_size=n)` handed pickle a `str` — `TypeError: file must have a 'write' attribute`. The factory now passes the raw through (a `BytesIO` is already a usable read/write seekable file in the browser; `buffer_size` only affects chunking) and the class bases itself on `_BufferedIOBase`. Source: the `_io` module in `brython_stdlib.js`.

```python
>>> import io
>>> io.BufferedRandom(io.BytesIO(), buffer_size=5).write(b'x')
AttributeError: 'str' object has no attribute 'write'   # before
>>> io.BufferedRandom(io.BytesIO(), buffer_size=5).write(b'x')
1                                                        # after
```

## [x] writing bytes to a text file crashes instead of raising TypeError

**Impact: +2 pickle (test_dump_text_file × C/Py picklers); general.** `pickle.dump(obj, open(p, "w"))` must raise `TypeError` (the pickler writes bytes, the text file refuses them); the harness io layer's text `write` called `txt.encode(...)` unconditionally, surfacing `AttributeError: 'bytes' object has no attribute 'encode'`. The write now type-checks its argument first, raising CPython's `write() argument must be str, not bytes`. Source: `loader/wasthon-io-write.js`.

```python
>>> f = open('x.txt', 'w')
>>> f.write(b'abc')
AttributeError: 'bytes' object has no attribute 'encode'   # before
>>> f.write(b'abc')
TypeError: write() argument must be str, not bytes         # after
```

## [x] `__import__` of a non-str module name crashes in JS

**Impact: +pickle (test_find_class asserts TypeError for `find_class(None, 'log')`); general.** `$B.$__import__(None, ...)` reached `mod_name.split(".")` and surfaced `JavascriptError: mod_name.split is not a function` where CPython raises `TypeError: module name must be a string`. The entry point now type-checks its argument. Source: `$B.$__import__` in `py_import.js`.

```python
>>> __import__(None)
JavascriptError: mod_name.split is not a function   # before
>>> __import__(None)
TypeError: module name must be a string             # after
```

## [x] `object.__reduce_ex__` looks up `__getnewargs_ex__` on the instance, recursing into a `__getattr__` hook

**Impact: +2 pickle (test_bad_getattr × C/Py picklers — a class whose `__getattr__` infinitely recurses must still pickle at proto ≥ 2, like CPython); general.** Every other lookup in the reduce chain is type-only (`__getnewargs__`, `__getstate__` via `search_in_mro`), but `getNewArguments` read `__getnewargs_ex__` off the *instance* — on a miss, an instance getattr falls into the class `__getattr__` hook, so `pickle.dumps(BadGetattr(), 2)` recursed to death where CPython (which resolves implicit dunders on the type only) succeeds. Now mirrors its `__getnewargs__` neighbor: class lookup, explicit `self` at the call. Source: `getNewArguments` in `py_object.js`.

```python
>>> class BadGetattr:
...     def __getattr__(self, key):
...         self.foo
...
>>> len(pickle.dumps(BadGetattr(), 2))
RecursionError: maximum recursion depth exceeded   # before
>>> len(pickle.dumps(BadGetattr(), 2))
57                                                 # after
```

## [x] a string constant in a set literal is stored under a stale compile-time hash

**Impact: +2 pickle (test_bad_object_list_items × Py picklers, whose `assertIn(str(exc), {"'int' object is not iterable", ...})` never matched); general — any `x in {"literal", ...}`.** `Set.to_js` baked a hash for each constant element into the generated JS (`{constant: [value, HASH]}`) computed from `remove_escapes(elt.value)`, but the stored value is `js_from_ast(elt)` — the two diverge (`remove_escapes` treats its `\b` key as a regex word boundary and inserts backspaces), so a plain string constant landed in a bucket the runtime lookup never probed, and `"s" in {"s"}` returned False. String constants now go through the `{item: value}` path, where `set_add` computes the hash from the value actually stored — always consistent. Non-string constants keep the baked-hash fast path. Source: `$B.ast.Set.prototype.to_js` in `ast_to_js.js`.

```python
>>> "'int' object is not iterable" in {"'int' object is not iterable"}
False   # before
>>> "'int' object is not iterable" in {"'int' object is not iterable"}
True    # after
```

## [x] `UnicodeEncodeError`/`UnicodeDecodeError` don't expose encoding/object/start/end/reason

**Impact: +pickle (test_unpickle_from_2x reads `loaded.object`/`.encoding`/`.start`/… off an unpickled UnicodeEncodeError); general.** The Unicode error classes carry their five constructor arguments only in `.args`; CPython also exposes them as the attributes `encoding`, `object`, `start`, `end`, `reason`. Reading any of them raised AttributeError. Getset descriptors now derive each from the 5-argument form. Source: `py_exceptions.js`.

```python
>>> UnicodeEncodeError('ascii', 'foo', 0, 1, 'bad').object
AttributeError: 'UnicodeEncodeError' object has no attribute 'object'   # before
>>> UnicodeEncodeError('ascii', 'foo', 0, 1, 'bad').object
'foo'                                                                  # after
```

## [x] `_socket.SocketType` is a distinct empty class, not an alias of `socket`

**Impact: +pickle (test_name_mapping asserts `getattribute('_socket','SocketType') is getattribute('socket','socket')`); general.** CPython's `_socket.SocketType` IS the socket type object; Brython declared it as a separate `class SocketType: pass`, so the 2.x compat name mapping (`('socket','_socketobject') -> ('socket','SocketType')`) resolved to a different class than `_socket.socket`. `SocketType` now aliases `socket`. Source: the `_socket` module in `brython_stdlib.js`.

```python
>>> import _socket
>>> _socket.SocketType is _socket.socket
False   # before
>>> _socket.SocketType is _socket.socket
True    # after
```

## [x] `urllib.request` is missing `getproxies`/`url2pathname`/`pathname2url`/`urlcleanup`/`urlretrieve`

**Impact: +2 pickle (test_name_mapping/test_reverse_name_mapping × the five urllib globals, whose 2.x-3.x mapping resolves `urllib.<name>` to `urllib.request.<name>`); general.** Brython's `urllib.request` shipped only `urlopen` and the URL-parsing helpers; the five path/proxy functions were absent, so any lookup of them raised AttributeError. Added browser-appropriate implementations (`getproxies` -> `{}`, `url2pathname`/`pathname2url` via `urllib.parse` quoting, `urlretrieve` writing through `urlopen` to a temp file, `urlcleanup`). Source: `Lib/urllib/request` in `brython_stdlib.js`.

```python
>>> import urllib.request
>>> urllib.request.getproxies()
AttributeError: module 'urllib.request' has no attribute 'getproxies'   # before
>>> urllib.request.getproxies()
{}                                                                      # after
```

## [x] fd-backed `FileIO` has no `readline`

**Impact: +1 pickle (test_invocation runs `pickle._main` which unpickles from an opened binary file — the C Unpickler requires `read` and `readline` on its file argument); general.** The writable-io FileIO exposed `read`/`readinto` but not `readline`, so `_pickle.Unpickler(open(path,'rb'))` raised `TypeError: file must have 'read' and 'readline' attributes`. Added a binary `readline` (bytes up to and including the next newline). Source: `loader/wasthon-io-write.js`.

```python
>>> import io, _pickle
>>> _pickle.Unpickler(open('x.pkl', 'rb')).load()
TypeError: file must have 'read' and 'readline' attributes   # before
>>> _pickle.Unpickler(open('x.pkl', 'rb')).load()
{'a': 1}                                                     # after
```

## [x] builtin-class staticmethods (`bytearray.maketrans`) are unpicklable bare JS functions

**Impact: +5 pickle (test_c_methods × all five picklers, unskipped with this fix); general.** A staticmethod of a builtin class unwraps to the bare JS function stored in `tp_funcs`, typed `JavascriptFunction` with no pickling path — while every other C-method shape in the test (method_descriptor, wrapper_descriptor, method-wrapper, bound builtin method) already carries the CPython getattr-style `__reduce__`. Added `JSFunction_funcs.__reduce__`: when the function's `$function_infos` qualname resolves to `owner.name` in builtins with `owner.tp_funcs[name]` being this very function, pickle it by reference as `(getattr, (owner, name))`; any other JS function keeps raising the same TypeError as before. Known limit: class creation requalifies shared functions in its namespace (`import pickle` pulls `collections.UserString`, whose creation rewrites the str method's `$function_infos` to `UserString.maketrans`), so `str.maketrans` still refuses to pickle — same root as the parked `__qualname__`-clobbering bug. Source: the `JSFunction` section (`js_objects.js`) in `brython.js`.

```python
>>> import pickle
>>> pickle.dumps(bytearray.maketrans)
TypeError: cannot pickle 'JavascriptFunction' object   # before
>>> pickle.loads(pickle.dumps(bytearray.maketrans)) is bytearray.maketrans
True                                                   # after
```

## [x] `pickle.py` NEWOBJ/NEWOBJ_EX crash on a non-type class argument

**Impact: +2 pickle (test_bad_newobj/test_bad_newobj_ex × PyUnpickler); general.** CPython 3.14's `load_newobj`/`load_newobj_ex` validate the class argument before calling `__new__`; Brython's bundled `pickle.py` predates the check, so a poisoned pickle reached `len.__new__(len)` and died in a JS crash inside `object.__new__` (`can't access property "hasOwnProperty", d is undefined` — `$B.get_from_dict` on a non-type; that underlying crash is still there, separate fix). Added the two `isinstance(cls, type)` checks with CPython's UnpicklingError messages. Source: `Lib/pickle` in `brython_stdlib.js`.

```python
>>> import pickle
>>> pickle.loads(b'cbuiltins\nlen\n)\x81.')
JavascriptError: can't access property "hasOwnProperty", d is undefined                 # before
>>> pickle.loads(b'cbuiltins\nlen\n)\x81.')
UnpicklingError: NEWOBJ class argument must be a type, not builtin_function_or_method   # after
```

## [x] call-site unpack messages: `*` iterable and `**` mapping errors

**Impact: +1 pickle (test_bad_newobj_ex_args × Py pickler, which asserts the exact messages); general.** Three pieces. (1) A starred argument in a call compiled to a bare iterator spread, so `f(a, *42)` raised the generic `'int' object is not iterable` — it now goes through `list.$unpack`, whose message is CPython's call-site wording. (2) The `$B.args` non-mapping error printed the callable without CPython's parentheses. (3) Calling a class routes argument parsing through `type.tp_call`'s literal `'__call__'` name; the error path now renames that prefix to the class's qualified name — computed only when the error is raised, the nominal path is untouched. Source: `ast_to_js` (make_args), args-parsing and `type.tp_call` sections in `brython.js`.

```python
>>> import functools
>>> functools.partial(int, *42)
TypeError: 'int' object is not iterable                                        # before
>>> functools.partial(int, *42)
TypeError: Value after * must be an iterable, not int                          # after
>>> functools.partial(int, **[])
TypeError: __call__ argument after ** must be a mapping, not list              # before
>>> functools.partial(int, **[])
TypeError: functools.partial() argument after ** must be a mapping, not list   # after
```

## [x] `$B.$getattr`'s class-dict fast path bypasses an inherited `__getattribute__`/tp_getattro

**Impact: +2 pickle (test_pickler/test_unpickler_super_instance_attribute × C picklers — the last two failures; pickle now has ZERO fails); general.** `$B.$getattr` has a fast path for instances of Python classes: attribute found as a plain function in the class's own dict, no same-named entry in the instance's Brython dict → bind and return. That shortcut never consults the MRO's tp_getattro, so any class under a custom getattro resolved the class method instead of the intercept — a subclass of wasthon's C `Pickler` (whose slot trampoline serves the `persistent_id` stored on the C struct: the setattr half worked since the pinning fix, the read never reached C), and equally plain Python `class B(A)` with `A.__getattribute__` defined. Gated the fast path on `klass.$getattribute === object.tp_getattro`, exactly like the tp_funcs fast path above it (a stray `attr=='path'` debug console.log went with it). Source: `$B.$getattr` (py_builtin_functions.js) in `brython.js`.

```python
>>> class A:
...     def __getattribute__(self, name):
...         return 'intercepted'
>>> class B(A):
...     def m(self):
...         return 1
>>> B().m
<bound method B.m of <B object>>   # before
>>> B().m
'intercepted'                      # after
```

## [x] `del list[a:b:step]` with a negative step deletes the wrong elements

**Impact: +14 array (test_extended_set_del_slice × 14 typecodes, unskipped with this fix — the wasthon C array was correct on all 864 probe combos, the *expected* side built from a Brython list was wrong); general.** `$B.list_delitem`'s slice branch hand-rolled its normalization and got every negative-step default wrong: `start=None` became `len` (CPython: `len-1`) and `stop=None` became `0` — which *excludes index 0* (CPython: the exclusive `-1` sentinel). `del L[::-1]` left `[first]` instead of emptying the list, and `del L[::-2]` deleted the complement of the right set. The fix routes the slice through `_b_.slice.$conv_for_seq` — the CPython-exact normalizer `$getitem_slice` already uses, so get and del can't drift apart again. Source: `$B.list_delitem` (py_list.js) in `brython.js`.

```python
>>> L = [1, 2, 3, 4, 5]
>>> del L[::-2]
>>> L
[1, 3, 5]   # before
>>> L
[2, 4]      # after
```


## [x] `_weakref` cells never die — proxy/ref on a wasthon C instance now clear

**Impact: +14 array (test_weakref × 14 typecodes, with the bridge weakRegistry half). ⚠ VENDORED-ONLY: vanilla Brython has no reachability engine to decide death — this half supplies the semantics, the bridge decides when.** Brython's pure-Python `_weakref` stores a strong `obj` on the cell with no dead state, so `weakref.proxy(a)` outlived its referent forever. Added a `_dead` sentinel and a `_deref()` helper raising CPython's `ReferenceError: weakly-referenced object no longer exists` (all 24 ProxyType forwards route through it), `ref.__call__` returns `None` once dead, and `proxy()`/`ref()` register a `clear` closure through the bridge hook `$wasthon_weakref_track` when the target is a wasthon C instance (guarded no-op anywhere else). Source: `Lib/_weakref` in `brython_stdlib.js`.

```python
>>> import array, weakref, gc
>>> a = array.array('i', [1, 2, 3]); p = weakref.proxy(a)
>>> del a; gc.collect(); len(p)
3                                                           # before
>>> del a; gc.collect(); len(p)
ReferenceError: weakly-referenced object no longer exists   # after
```


## [x] `sys.getsizeof` is missing

**Impact: +28 array (the sizeof tests, with the bridge `wasthon_basicsize` half); general. ⚠ VENDORED-ONLY in practice: on vanilla Brython almost no object carries a real `__sizeof__`, so the delegate raises TypeError — it becomes useful with wasthon's C instances, whose `__sizeof__` is the real CPython method.** Brython's `sys` has no `getsizeof`; added the CPython-shaped delegate: call `obj.__sizeof__()` (real for wasthon C instances via the method trampoline), return the `default` when given, else `TypeError: Type X doesn't define __sizeof__`. Source: the `sys` module in `brython.js`.

> ⚠ **Platform-width seam** (see README, Hard rules): Brython-core sizes are 64-bit-emulated (`'abc'.__sizeof__()` = 44, upstream PR sys-getsizeof), wasthon C-instance sizes are wasm32-canonical (array = 32 + payload). Both true, different rulers.

```python
>>> import array, sys
>>> sys.getsizeof(array.array('i', [1, 2, 3]))
AttributeError: module 'sys' has no attribute 'getsizeof'   # before
>>> sys.getsizeof(array.array('i', [1, 2, 3]))
44                                                          # after
```

## [x] slice assignment passes every element as a JS argument — big writes blow the engine's call limit

**Impact: +7 pickle (test_framing_large_objects × C picklers, test_framed_write_sizes_with_delayed_writer × C-dump variants — the write path of every file-based pickling of ≥~128 KB payloads, protocol-4 frames land in `BytesIO.write`'s `self._buffer[pos:pos+n] = b`); general.** Both `bytearray[a:b] = data` and `list[a:b] = data` ran `splice.apply(target, [start, ndel].concat(items))` — every element becomes one JS *argument*, and engines cap a call at ~125k arguments, so a 1 MB frame raised `RuntimeError: too many arguments provided for a function call` (the historic "framing hang" family). Past 16384 items both sites now rebuild the tail through 16 KB `push.apply` chunks (the pattern the bridge's fromCharCode paths already use). Source: `bytearray.sq_ass_item` (py_bytes.js) and `set_list_slice` (py_list.js) in `brython.js`.

```python
>>> ba = bytearray()
>>> ba[0:0] = bytes(1000000)
RuntimeError: too many arguments provided for a function call   # before
>>> ba[0:0] = bytes(1000000)
>>> len(ba)
1000000                                                         # after
```

## [x] posix.putenv/unsetenv raise NotImplementedError — no way to set an env var at the C level

**Impact: unblocks `import numpy` (numpy 2.5's `numpy/_core/__init__.py` reload-guard calls `os.putenv('OPENBLAS_MAIN_FREE','1')` then `os.unsetenv(...)` on purpose instead of touching `os.environ`, to avoid a race — gh-30627); general.** Brython's `posix` stubbed `putenv` in the big "not implemented" list and never defined `unsetenv`, so any code using `os.putenv`/`os.unsetenv` (rather than mutating `os.environ`) died with `NotImplementedError: posix.putenv is not implemented`. Gave both real, minimal implementations backed by the module's own `environ` dict, so `getenv` stays consistent with what `putenv` set. Source: the `posix` module in `brython_stdlib.js`.

```python
>>> import os
>>> os.putenv('FOO', '1')
NotImplementedError: posix.putenv is not implemented   # before
>>> os.putenv('FOO', '1'); os.getenv('FOO')
'1'                                                     # after
>>> os.unsetenv('FOO'); os.getenv('FOO') is None
True
```

## [x] os.uname() returned 6 fields (platform.uname()) — CPython's is a 5-field uname_result

**Impact: unblocks `numpy._core._add_newdocs_scalars` (`system, _, _, _, machine = os.uname()`); general.** Brython's `os.uname()` was `return platform.uname()`, whose namedtuple carries a 6th `processor` field — but POSIX/CPython `os.uname()` returns exactly 5 (`sysname, nodename, release, version, machine`), so any 5-target unpack raised `ValueError: too many values to unpack (expected 5, got 6)`. It now returns a proper 5-field `uname_result` (dropping `processor`, which belongs to `platform.uname()`). Source: the `os` module in `brython_stdlib.js`.

```python
>>> import os
>>> a, b, c, d, e = os.uname()
ValueError: too many values to unpack (expected 5, got 6)   # before
>>> os.uname()._fields
('sysname', 'nodename', 'release', 'version', 'machine')     # after
```

## [x] `from . import X, X as Y` bound only the alias — the plain name was dropped

**Impact: unblocks `numpy._core.numeric` (`from . import multiarray, numerictypes, numerictypes as nt, overrides, shape_base, umath`, then `extend_all(numerictypes)`); general.** When the same module is imported both plain and aliased in one statement, the codegen emits it twice in `names` (`[…, "numerictypes", "numerictypes", …]`) with a single `aliases` entry keyed by the source name (`{numerictypes: [ns, "nt"]}`). `$import_from`'s loop consulted `aliases[name]` for *every* occurrence, so both bound `nt` and the plain `numerictypes` was never bound — a later `numerictypes.__all__` then hit `undefined`. The loop now tracks names already seen: the first occurrence uses its alias (or plain), any repeat binds the plain name, so both targets land. Source: `$B.$import_from` in `brython.js`.

```python
>>> from os import path, path as p   # after
>>> path is p
True                                  # before: `path` was undefined (only `p` bound)
```

## [x] issubclass() with a non-class first arg crashed (JS `undefined.indexOf`) instead of raising TypeError

**Impact: unblocks numpy `dtype.name` / `np.issubdtype` (numpy's `issubclass_` wraps `issubclass` in `try/except TypeError`, relying on the TypeError to fall back to `dtype(arg1).type`); general.** CPython's `issubclass(x, C)` raises `TypeError: issubclass() arg 1 must be a class` when `x` isn't a class. Brython went straight to `$B.get_mro(klass).indexOf(...)`; for a non-class `klass` (e.g. a numpy dtype instance passed by `issubdtype`) `get_mro` returns `undefined`, so `.indexOf` threw a raw JS `TypeError: Cannot read properties of undefined` that numpy's `except TypeError` couldn't recognize. It now raises a proper Python `TypeError` when `get_mro(klass)` is undefined. Source: `_b_.issubclass` in `brython.js`.

```python
>>> issubclass(42, int)
TypeError: Cannot read properties of undefined (reading 'indexOf')   # before (raw JS)
>>> issubclass(42, int)
TypeError: issubclass() arg 1 must be a class                        # after
```

## [x] types.FunctionType bound module globals to the CALLING frame's module — cross-module re-materialization broke (PEP 695 + Protocol annotations)

**Impact: unblocks numpy `_typing._dtype_like` / `_arraysetops_impl` and any PEP 695 generic class with a `Protocol` base + annotated attribute; general.** `$B.function.$factory` (the `FunctionType(code, globals)` implementation) re-creates a function with `new Function('_b_','__file__', 'locals_'+frame[2], 'return '+code.co_code)` — but `code.co_code` references `locals_<the-defining-module>`, while `frame[2]` is the module of whatever frame is *active at call time*. When `typing.Protocol` lazily evaluates a PEP 695 generic class's `__annotate__` cross-module (through `annotationlib.get_annotations`), the active frame is `annotationlib`, so the parameter came out `locals_annotationlib` and the body threw a raw JS `locals_<orig-module> is not defined` — killing the whole import. It now binds the parameter to the code's OWN module (from the passed globals' `__name__`, else the `locals_…` name the code literally references), so the closure resolves; an unresolved *name* inside the annotation now surfaces as a normal Python `NameError` that the annotation machinery handles, instead of a fatal JS crash. Source: `$B.function.$factory` in `brython.js`.

```python
>>> from typing import Protocol
>>> class C[T](Protocol):
...     x: T
JavascriptError: locals_<module> is not defined   # before (fatal, at import)
>>> # after: class defines; Protocol's lazy annotation introspection no longer crashes the module
```

## `super(X, self)` on a list subclass unpacks self's first element

**Impact: unblocks `pd.to_datetime` (dateutil's `_ymd(list)` calls `super(self.__class__, self).__init__(*args)`; the empty-list case turned self into `undefined` and supercheck crashed "Javascript object 'undefined' has no attribute"); general.** Brython's `super.tp_init` ran `if(Array.isArray(object_or_type)){object_or_type=object_or_type[0]}` on its second argument — but instances of `list` subclasses ARE JS arrays, so `super(X, self)` replaced self with its first element (or `undefined` when empty). The unwrap is now gated on the array carrying no `__class__`/`ob_type`, i.e. it no longer fires for real instances. Source: `_b_.super.tp_init` in `brython.js`.

```python
>>> class X(list):
...     def __init__(self, *a):
...         super(X, self).__init__(*a)
>>> X()
AttributeError: Javascript object 'undefined' has no attribute   # before
>>> X()
[]                                                               # after
```

## [x] Stray upstream debug console.log in dict.update and the string tokenizer

`dict.update(iterable)` printed `o <object> it <iterator>` on every call
(brython.js dict.$factory update path), and an unterminated string literal
printed `pos end <source slice>` before the SyntaxError. Both are leftover
upstream debug prints; every Brython page that captures console.log (the
NumBry dashboards) got `[object Object]` spam in its output. Removed.

```
>>> dict([(1, 2)])
o [object Object] it [object Object]   # before (on the JS console)
{1: 2}
>>> dict([(1, 2)])
{1: 2}                                  # after
```

## [x] f(*generator) masked the generator's real exception as StopIteration

`list.$unpack`'s not-iterable diagnostic re-probed the iterator after
`list.$factory` failed: on a generator the failed iteration has already
closed it, so the probe `__next__` raises StopIteration and `throw err1`
replaced the original exception. pandas' `zip(*(factorize_from_iterable(it)
for it in iterables))` (MultiIndex.from_product) surfaced a bare
StopIteration instead of the real error. The probe now only classifies
TypeError (the nicer not-iterable message); everything else rethrows the
ORIGINAL exception.

```
>>> def boom(): raise AttributeError('boom')
>>> zip(*(boom() for _ in [1]))
StopIteration                     # before
>>> zip(*(boom() for _ in [1]))
AttributeError: boom              # after
```

## f-string literal parts: \UXXXXXXXX, \N{NAME}, octal and unknown escapes are not decoded

The literal segments of an f-string keep their escape sequences textually
(plain strings are decoded by `prepare_string`, but the FSTRING_MIDDLE
tokens go through `_PyPegen.constant_from_token` and `joined_str` with no
decoding). The generated JS embeds the raw text in a JS string literal, so
only the escapes whose syntax JavaScript happens to share (`\n`, `\xHH`,
`\uHHHH`...) come out right. Everything JS lacks is corrupted:

```python
>>> f"\U0001F40D"      # expected '🐍'
'U0001F40D'
>>> f"\N{BULLET}"      # expected '•'
'N{BULLET}'
>>> f"\101"            # expected 'A'
'101'                  # (and octal escapes are SyntaxErrors in strict-mode JS)
>>> f"\q"              # expected '\\q' (unknown escape keeps the backslash)
'q'
```

Suggested fix (mirrors CPython's `_PyPegen_decode_string` on fstring parts):
either decode the escapes when building the Constant, or — matching the
"JS-source-ready" convention the tokenizer already uses — transpose the
non-JS escapes in `$B._PyPegen.joined_str`: `\UXXXXXXXX` → `\u{XXXXXXXX}`,
`\N{NAME}` → `\u{codepoint}` (unicodedb lookup), `\ooo` → `\u{hex}`,
`\a` → `\x07`, unknown escape `\q` → `\\q`; leave literal `\\` pairs and the
JS-shared escapes untouched. Raw f-strings (`rf'...'`) skip the transform.

## class attribute `__setattr__ = dict.__setitem__` breaks attribute assignment

`$B.$setattr` calls `klass.tp_setattro` as a raw JS function. When a class
assigns a non-function callable as `__setattr__` — the standard "attribute
dict" idiom used by scipy's `OptimizeResult`, sklearn's `Bunch`, etc. —
`tp_setattro` is a wrapper_descriptor OBJECT and the call throws.

```python
>>> class R(dict):
...     __setattr__ = dict.__setitem__
>>> r = R()
>>> r.x = 1
JavascriptError: setattr is not a function     # expected: r['x'] == 1
```

(Inside scipy the same root surfaced as a ~25 s "InternalError: allocation
size overflow".) Suggested fix: in `$B.$setattr`, when `tp_setattro` is not a
JS function, dispatch through `$B.$call(setattr, obj, attr, value)`.

## typing.ParamSpec is broken: `super().__init__(bound, covariant, contravariant)` reaches object.__init__

In `_typing.py`, `ParamSpec.__init__` still calls
`super().__init__(bound, covariant, contravariant)` — the CPython-3.11-era
`_BoundVarianceMixin` base that provided that 3-argument `__init__` was
flattened away, so the call lands on `object.__init__` and raises. Any
library that instantiates a ParamSpec at import time (torch, typing-heavy
code) dies immediately.

```python
from typing import ParamSpec
P = ParamSpec("P")          # TypeError: object.__init__() takes exactly
                            # one argument (the instance to initialize)
```

CPython: `ParamSpec("P").__bound__ is None` and the object is usable.

Fix: replace the orphan `super().__init__(...)` with the mixin's two real
effects — raise `ValueError("Bivariant types are not supported.")` when
`covariant and contravariant`, and set
`self.__bound__ = _type_check(bound, "Bound must be a type.") if bound else None`.

## typing.TypeVar lacks __or__/__ror__ — PEP 604 unions with TypeVars fail

`_typing.py`'s TypeVar (and ParamSpec) defines no `__or__`/`__ror__`, so
`T | U` and `int | T` — the standard PEP 604 idiom, used heavily by torch's
typing layer — raise instead of building a Union.

```python
from typing import TypeVar
T = TypeVar('T')
U = TypeVar('U')
T | U          # CPython: typing.Union[~T, ~U]; Brython: TypeError
int | T        # CPython: int | ~T; Brython: TypeError
```

Fix: give both classes the CPython methods —
`def __or__(self, right): return Union[self, right]` and
`def __ror__(self, left): return Union[left, self]`.

## builtin methods leak raw JS `undefined` for __module__ — functools.wraps(object.__new__) dies

Reading `__module__` on a builtin method resolves the JS property directly
and returns wrapped-undefined instead of 'builtins' (or AttributeError);
`setattr(f, '__module__', <undefined>)` then fails with the misleading
"can't set attributes of built-in/extension type 'object'". Any
`functools.wraps(object.__new__)` — notably `warnings.deprecated` (PEP 702)
on a class that doesn't override __new__, used across torch — dies.

```python
object.__new__.__module__      # <Javascript undefined>; CPython: 'builtins'
import functools
@functools.wraps(object.__new__)
def nn(cls): ...
# TypeError: can't set attributes of built-in/extension type 'object'
```

Also observed: `object.__new__.__qualname__` returns 'Flag.__new__' (slot
aliased by whichever class last wrapped it) instead of 'object.__new__'.

Root fix: builtin-function attribute reads must never return raw JS
undefined — serve 'builtins' for __module__ / raise AttributeError.

## object hash counter starts at 2**53-1 — composite hashes lose integrality

`$B.$py_next_hash` starts at `Math.pow(2,53)-1`, so any object's assigned
hash sits at the float64 precision edge. Hashing anything that COMBINES such
hashes arithmetically (a generic alias `list[SomeClass]`, a tuple containing
a class) multiplies past 2**53 and the result stops being an exact integer:
`hash()` then raises "__hash__ method should return an integer". torch dies
building `SUPPORTED_RETURN_TYPES = {list[Tensor]: ...}`.

```python
class A: pass
hash((A, 1))     # or hash(list[A]) — fails once hash(A) is near 2**53
```

Fix: start the counter at `Math.pow(2,31)-1` (2 billion unique descending
values, all combination arithmetic stays exact).

## types.GenericAlias has an EMPTY tp_hash — hash(list[int]) fails

`$B.GenericAlias.tp_hash = function(self){}` returns undefined, so hashing
any parametrized builtin generic raises "__hash__ method should return an
integer". Any dict keyed by generic aliases (torch's
`SUPPORTED_RETURN_TYPES = {list[Tensor]: ...}`) dies.

```python
hash(list[int])   # TypeError; CPython: an int (hash(origin) ^ hash(args))
```

Fix: `return ($B.$hash(self.origin) ^ $B.$hash(self.args)) & 0x7FFFFFFF`
(CPython's ga_hash is exactly hash(origin) ^ hash(args)).

## collections.abc.Callable[ParamSpec, T] rejects ParamSpec — module check misses `_typing`

`_collections_abc._is_param_expr` checks `type(obj).__module__ == 'typing'`,
but Brython defines ParamSpec (and _ConcatenateGenericAlias) in `_typing`,
so the check is always False and `Callable.__class_getitem__` raises.
`typing.Callable[P, T]` works (typing's own `_is_param_expr` uses isinstance),
only the collections.abc path is broken — torch/library.py hits it.

```python
from typing import ParamSpec
from collections.abc import Callable
P = ParamSpec('P')
Callable[P, int]  # TypeError: Expected a list of types, an ellipsis,
                  # ParamSpec, or Concatenate. Got P — CPython: GenericAlias
```

Fix (either): accept both modules in `_collections_abc._is_param_expr`
(`obj.__module__ in ('typing', '_typing')`), or set `__module__ = 'typing'`
on the ParamSpec/_ConcatenateGenericAlias classes to match CPython.

## a Python subclass of property cannot take instance attributes — tp_new ignores the subclass

`property.tp_new` returns a bare `{ob_type: cls}` whatever `cls` is. In
CPython a Python subclass of property is a heap type with a nonzero
tp_dictoffset, so its instances have a `__dict__`; in Brython setattr dies.
torch's `_DependentProperty(property)` does `self._is_discrete = ...` in
`__init__` (torch/distributions/constraints.py).

```python
class P(property):
    def __init__(self, fn=None):
        super().__init__(fn)
        self.tag = 1        # AttributeError: 'P' object has no attribute
P(lambda s: 0)              # 'tag' and no __dict__ for setting new attributes
```

Fix: in `property.tp_new`, when `cls is not property` and the subclass does
not declare `__slots__`, attach an instance dict (`$B.init_dict(self)`).

## urllib.request has no Request class — urlopen only takes a str

Brython's ajax-backed `urllib.request` exposes `urlopen` but not `Request`,
so the standard `urlopen(Request(url, headers=...))` idiom fails at import
time (`from urllib.request import Request, urlopen` — torch/hub.py does).

```python
from urllib.request import Request, urlopen   # ImportError: Request
```

Fix: minimal faithful `Request` (full_url/data/headers/method, add_header,
get_method) + `urlopen` unwraps a Request argument (url/data).

## class/module __annotate_func__ only honors format=1 passed as a raw int — dataclasses on a class with annotations dies

Two gaps in the runtime `__annotate_func__` built for class/module bodies:
(1) `switch(format)` compares strictly, but annotationlib passes a
`Format` IntEnum member, so even VALUE misses every case; (2) FORWARDREF
(3) raises NotImplementedError, which sends annotationlib into its
fake-globals retry — impossible for a JS function without
`__code__`/`__closure__`, and the failure surfaces as
"'UndefinedType' object is not subscriptable" deep inside dataclasses
(any `@dataclass` whose fields have annotations, e.g. torch's
`_ConfigEntry`).

```python
from dataclasses import dataclass
from typing import Any
@dataclass
class C:
    x: Any          # TypeError: 'UndefinedType' object is not subscriptable
```

Fix (two sites): `$B.check_annotate_format` — called first by the
class-body annotate the codegen emits — unboxes a non-int format via its
`.value` and accepts 3; the module-level `__annotate_func__` gets the same
normalization + `case 3`. FORWARDREF is served like VALUE: the annotation
thunks close over the real scope chain (same treatment as the function
`__annotate__` template).

## contextvars.ContextVar is not subscriptable

CPython's ContextVar supports `ContextVar[object]` (PEP 585 style,
`__class_getitem__ = classmethod(GenericAlias)`); Brython's pure-Python
`_contextvars.ContextVar` has no `__class_getitem__`, so any annotation
using it dies at evaluation (torch's `_ConfigEntry` dataclass).

```python
from contextvars import ContextVar
ContextVar[object]     # TypeError: type 'ContextVar' is not subscriptable
```

Fix: add `__class_getitem__` returning `types.GenericAlias(cls, item)`.

## linecache cannot serve the source of imported modules — inspect.getsource always fails

Brython keeps every imported module's source in `$B.file_cache` (the
traceback machinery reads it), but `linecache.getlines` only tries the
filesystem, so `inspect.getsource`/`findsource` raise
"OSError: could not get source code" for ALL Brython modules — torch's
config system (`inspect.getsource(module)`) and every fx/jit source-reading
path dies.

```python
import inspect, json
inspect.getsource(json.dumps)   # OSError; CPython returns the source
```

Fix: in `getlines`, before the filesystem path, look the filename up in
`__BRYTHON__.file_cache` (via `browser.window`) and serve/cache its lines.

## _tokenize's TokenizerIter tokenizes line by line — tokenize/inspect.getsource are broken for any multi-line construct

The `_tokenize` shim feeds each readline() result to `$B.tokenizer`
SEPARATELY and stamps every token with its physical line number. Any
construct spanning lines dies: an open parenthesis at end of line raises
"'(' was never closed", and `inspect.getblock` truncates every multi-line
`def` (torch's `@overload` signatures, `inspect.getsource(json.dumps)`
returns the first line only).

```python
import tokenize, io
src = "def f(a,\n      b):\n    return a+b\n"
list(tokenize.generate_tokens(io.StringIO(src).readline))
# SyntaxError: '(' was never closed — CPython: NL inside the parens
```

Fix: drain readline first and run `$B.tokenizer` once on the whole source
(it is the compiler's own tokenizer, and it handles multi-line fine); the
real lineno/end_lineno come out correct.

## module.__annotations__/__annotate__ getsets are EMPTY functions — getattr returns raw JS undefined

`$B.module.tp_getset` declares `__annotations__`/`__annotate__` but their
`tp_funcs` getters are empty (`function(self){}`), and the getset shadows
the working defineProperty accessors `make_module_annotate` installs on the
namespace object. Inside the module `__annotations__` works; from outside,
`getattr(module, '__annotations__')` yields undefined and annotationlib
raises "__annotations__ is neither a dict nor None" (torch's config system
calls `inspect.get_annotations(module)`).

```python
# mod.py contains:  x: int = 1
import mod
mod.__annotations__    # UndefinedType; CPython: {'x': <class 'int'>}
```

Fix: the getset getters read the JS property THROUGH get_dict(module)
(for an imported module the object and its namespace are distinct, and the
accessor lives on the namespace), `__annotations__` materializes and caches
an empty dict when absent (CPython behaviour), and the setters assign
through.

## module __dict__ iteration leaks internal $-prefixed keys

Iterating a module's `__dict__` (`vars(mod).items()`) exposes Brython's
internal bookkeeping keys (`$annotations`, raw JS objects). Brython's own
`module.__dir__` filters `key[0] != '$'` manually, but plain dict iteration
does not — CPython module dicts have no such keys. Any "walk the module
namespace" pattern chokes on the JS object (torch's config system asserts).

```python
# mod.py contains:  x: int = 1
import mod
[k for k in vars(mod)]   # contains '$annotations'; CPython never
```

Fix direction: skip '$'-prefixed keys when iterating namespace-backed
dicts (a Python identifier can never contain '$').

## `None | SomeUnion` crashes — UnionType.nb_or assumes self is a union

With None on the left of `|` against an existing union, the reflected
fallback invokes `$B.UnionType.nb_or` with `self=None`, and
`self.args.slice()` dies with a raw JS error ("self.args is undefined").
torch evaluates `None | PySymType | ...` type aliases at import.

```python
U = int | str
None | U     # JS error; CPython: int | str | None
```

Fix: when self carries no `.args`, treat it as a single operand
(CPython's union___or__ accepts any unionable operand on either side).

## GenericAlias.__unpacked__ raises AttributeError unless the alias was starred

`__unpacked__` is declared as a tp_member reading the `starred` JS field,
which only exists on `*tuple[int]`-style aliases — a plain `list[int]` has
NO `__unpacked__` at all. CPython exposes False. typing's caching walk
(`typing.py` `_unpack_args`) reads it on every alias (torch's `_refs`
singledispatch registration dies).

```python
list[int].__unpacked__   # AttributeError; CPython: False
```

Fix: expose it as a getset returning `self.starred === true`.

## unions never compare equal — UnionType has no __eq__

`(str | None) == (str | None)` is False (identity compare), and so is
`(str | None) == Optional[str]` — CPython 3.14: True (same member set,
None ≡ NoneType, typing unions included). torch's config system checks
`value_type in (bool, str, Optional[bool], Optional[str])`.

```python
(str | None) == (str | None)   # False; CPython: True
```

Fix: set-wise `__eq__` on $B.UnionType (None normalized to NoneType,
`__args__` consulted on the other operand for typing unions).

## non-heap type repr drops the module prefix — HEAPTYPE gate removed

`_b_.type.tp_repr` only consulted `__module__` when `tp_flags & HEAPTYPE`; a
static (non-heap) extension type printed its bare short name. CPython consults
the module for EVERY type (a static type derives it from its dotted tp_name):
`repr(np.ndarray)` is `<class 'numpy.ndarray'>`. Brython's own builtins carry
`__module__ == 'builtins'` so their repr is unchanged.

```python
str(type(np.array([1])))   # was "<class 'ndarray'>"; CPython: "<class 'numpy.ndarray'>"
```

Fix: drop the HEAPTYPE condition — `__module__` (NULL, empty or 'builtins'
kept short) prefixes the name for heap and non-heap types alike. (+1 pandas
test_timedeltas: a TypeError message built from `str(type(obj))` is matched
against "<class 'numpy.ndarray'>".)

## struct.unpack treats an explicit 0 repeat count as "no count"

`_struct.unpack`'s repeat-count default uses `if not num: num = 1` — an
explicit `0` count (falsy) is indistinguishable from "no digit" (`None`), so
every 0-count field yields one spurious item AND consumes its size, shifting
every later read. `pack` and `calcsize` use the correct `== None` test.
CPython: a 0-count field produces nothing and consumes nothing.

```python
unpack('>0l 0B lBB 4s', b'\x00\x01\x02\x03\x04\x05ABCD')
# Brython: 6 items, trailing 4s reads b''  — CPython: (66051, 4, 5, b'ABCD')
```

Fix (one line): `if num is None: num = 1`. Hit in the wild by pytz's TZif
parser on transition-less zones (GMT: timecnt=0 → `assert len(data) == …`
fails): pandas test_timezones' pytz/dateutil cache-key test. (+1 pandas
timezones)

## `is` value-compares floats — two distinct NaN objects are "identical"

`$B.$is` special-cases floats (`.value ==` plus a NaN/NaN branch returning
True), so `is` is an equality test for floats and two distinct `float("nan")`
objects are `is`-identical. CPython's `is` is object identity.

```python
float("nan") is float("nan")     # was True; CPython: False
float("nan") in [float("nan")]   # was True; CPython: False (is-or-eq, both fail)
x = float("nan"); x in [x]       # True both (identity hit)
```

The branch guards against float re-boxing — measured stable on 3.14 across
every access path (variable re-read, list/tuple/dict element, call
round-trip, instance attribute, math.nan): `x is x` holds with plain `===`
everywhere. Fix: drop the float branch, `is` = object identity. (+2 pandas
test_hashtable `nan1 is not nan2` asserts; NaN membership becomes
CPython-exact as a side effect.)

## tuple/list `+` rejects subclass operands — sq_concat wants exact class equality

The shared `sq_concat` (py_list) returns NotImplemented whenever
`$B.get_class(self) !== $B.get_class(other)`. CPython's tuple_concat/
list_concat check `PyTuple_Check`/`PyList_Check` on the OTHER operand —
subclass instances included. A tuple subclass therefore cannot concatenate
with a plain tuple (torch's `torch.testing._internal.common_dtype`
`_dispatch_dtypes(tuple)` does exactly this at import).

```python
class T(tuple): pass
tuple.__add__(T((1,)), (2,))   # was NotImplemented; CPython: (1, 2)
T((1,)) + (2,)                 # was TypeError; CPython: (1, 2)
```

Fix: keep the fast path (equal classes proceed), on mismatch accept when
`other` isinstance of the slot's base (tuple or list); result stays the base
type, as in CPython.

## copy/deepcopy of a JS function pickles it — TypeError instead of identity

`copy.copy`/`copy.deepcopy` fall through to `__reduce_ex__(4)` for objects
whose class has no dispatch entry. A JS-backed callable (class
`JavascriptFunction`) cannot be pickled, so any structure holding one dies —
CPython treats every function type as atomic (`_deepcopy_atomic`: identity).
torch's OpInfo `__post_init__` (`dataclasses.asdict` → `copy.deepcopy`)
tripped it on 25k lines of common_methods_invocations.

```python
import copy
from browser import window
copy.deepcopy(window.console.log)   # was TypeError; CPython-equivalent: identity
```

Fix (stdlib copy.py): before the reductor fallback, return the object itself
when its class is JavascriptFunction, in both copy() and deepcopy().

## method-wrapper: empty tp_hash and tp_richcompare — unusable in sets, undefined comparisons

`$B.method_wrapper.tp_hash` and `tp_richcompare` are EMPTY function bodies:
hash returns undefined ("__hash__ method should return an int" on any
set/dict use) and every rich comparison silently yields undefined. CPython
bound methods hash and compare by (receiver identity, wrapped function).

```python
t = 3.5
s = {t.is_integer}          # was TypeError; CPython: ok
t.is_integer == t.is_integer  # was undefined-ish; CPython: True
```

Fix: tp_hash combines hash(self.self) with a per-wrapped-slot sequence id
(bounded to int32); tp_richcompare implements __eq__/__ne__ by receiver
`is` + wrapped identity, NotImplemented otherwise. (torch's gradcheck puts
bound methods in sets — the x22 failure cluster in test_autograd.)
