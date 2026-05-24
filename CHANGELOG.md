# Wasthon — bridge fixes log

Chronological log of bridge gaps fixed since the project's polish pass.
Newest first. Each entry sketches the symptom, the root cause and the fix
so future-me (or you) can revisit the reasoning without git-archaeology.
Module ports and the bridge-surface inventory live in `README.md`.

---

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
