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
