# Wasthon

<div align="center">
    <img src="Wasthon.png" alt="Wasthon Logo" width="200"/>
</div>

**Run real CPython C extension modules inside Brython, compiled to WebAssembly.**

> Brython is Holmes — the genius detective doing Python→JS magic.
> Wasthon is Watson — the loyal companion bringing the C extensions along.

## What it does

Brython ships a Python 3 runtime in the browser by compiling Python to
JavaScript. The catch: CPython's stdlib modules written in C (`_sha256`,
`zlib`, `_sre`, `_decimal`, …) don't compile to JS — Brython has either
re-implemented them in JavaScript / pure Python (smaller surface, sometimes
worse perf, the occasional silent semantic divergence) or simply doesn't
ship them at all.

Wasthon takes the **unmodified C source** of those CPython modules,
compiles them to WebAssembly with Emscripten, and exposes them to Brython
through a minimal CPython C-API bridge. Result for Brython users:

- The same `import hashlib`, `import struct`, `import zlib`, `import
  _decimal` works — and flies. Bulk-operation speedups range from 4× to
  **131×** depending on module.
- **New algorithms Brython doesn't ship**: full SHA-3, BLAKE2, HMAC, full
  Unicode database, `_bz2`, `_lzma`, `_zstd`, real `array.array`.
- **Modules that now work**: Brython's `_struct`, `unicodedata`, `zlib`,
  `array` are partially broken / very lossy / unusable in some cases —
  Wasthon implementations are bit-exact with CPython.
- **Bit-exact CPython semantics** — when CPython fixes a bug or adds a
  feature in 3.x, Wasthon picks it up by recompiling, not re-porting.

## Status

### Headline result — `_json.encode_basestring`: 25× to 332× faster

| Input                  | Wasthon  | Brython pure-Python | Speedup    |
| ---------------------- | -------- | ------------------- | ---------- |
| 11-char ASCII          | 0.014 ms | 0.358 ms            | **25.57×** |
| 1300-char ASCII        | 0.110 ms | 22.88 ms            | **208×**   |
| 1700-char w/ escapes   | 0.090 ms | 24.12 ms            | **268×**   |
| 11000-char Lorem Ipsum | 0.450 ms | 149.45 ms           | **332×**   |

`_json.encode_basestring` produces ~24 MB/s of JSON encoding at 11 KB
input — basically native libC speed, against a pure-Python loop saturated
at ~75 KB/s. Largest speedup we've measured on any ported module.

### Modules ported

| Module         | What it provides                                         | `.wasm`     |
| -------------- | -------------------------------------------------------- | ----------- |
| `_md5`         | md5                                                      | 14 KB       |
| `_sha1`        | sha1                                                     | 12 KB       |
| `_sha2`        | sha224, sha256, sha384, sha512                           | 36 KB       |
| `_sha3`        | sha3_224, sha3_256, sha3_384, sha3_512                   | 26 KB       |
| `_blake2`      | blake2b, blake2s                                         | 36 KB       |
| `_hmac`        | HMAC over any of the hashes above                        | 98 KB       |
| `_zlib`        | compress / decompress, crc32, adler32                    | 83 KB       |
| `_bz2`         | bzip2 compress / decompress (libbz2 1.0.8)               | 91 KB       |
| `_lzma`        | XZ / LZMA / raw (xz-utils 5.4.6, pre-CVE-2024-3094)      | 133 KB      |
| `_zstd`        | Zstandard compress / decompress (libzstd 1.5.6)          | 555 KB      |
| `_sre`         | regex engine                                             | 73 KB       |
| `_random`      | Mersenne Twister (bit-exact with CPython)                | 12 KB       |
| `_struct`      | binary pack/unpack, full format-code coverage            | 29 KB       |
| `_decimal`     | arbitrary-precision decimal arithmetic (libmpdec)        | 360 KB      |
| `_csv`         | C-level CSV reader/writer state machine                  | 25 KB       |
| `array`        | typed arrays (b/B/h/H/i/I/l/L/q/Q/f/d)                   | 41 KB       |
| `pyexpat`      | XML parser (libexpat 2.8.2)                              | 169 KB      |
| `_json`        | JSON encoder/decoder C accelerator                       | 28 KB       |
| `math`         | int-heavy fns (factorial, gcd, isqrt, prod, …)           | 77 KB       |
| `cmath`        | complex math (sqrt/exp/log/sin/polar/rect/…)             | 51 KB       |
| `unicodedata`  | full Unicode 15.x database + normalization               | 669 KB      |
| `_statistics`  | `_normal_dist_inv_cdf` (Wichura AS241)                   | 15 KB       |
| `_pickle`      | C accelerator for pickle (protocols 0-5)                 | 79 KB       |
| `_sqlite3`     | SQLite 3.46.1 embedded DB (FTS5 + RTREE + JSON1)         | 730 KB      |
| `binascii`     | hex / base64 / CRC encoding (CPython C accelerator)      | 24 KB       |
|                | **Total**                                                | **~3.4 MB** |

### Highlight benchmarks — Wasthon vs Brython

**hashlib** (0.5 MB payload, MB/s):

| Algo   | Wasthon | Brython | Speedup   |
| ------ | ------- | ------- | --------- |
| md5    | 238     | 17.7    | **13.5×** |
| sha256 | 119     | 20.6    | 5.8×      |
| sha512 | 192     | 8.3     | **23.3×** |
| sha3_* | 51-82   | absent  | ∞         |

**`_struct`** (per-call ms, 100 ops/loop):

| Operation   | Wasthon | Brython | Speedup  |
| ----------- | ------- | ------- | -------- |
| pack '>I'   | 1.17    | 22.4    | **19×**  |
| pack '<10I' | 1.53    | 201     | **131×** |
| pack '>d'   | 0.73    | 34.0    | **46×**  |

**`_decimal`** (ms/op vs Brython's `_pydecimal`):

| Operation                         | Wasthon | _pydecimal | Speedup |
| --------------------------------- | ------- | ---------- | ------- |
| Decimal('3.14') × Decimal('2.71') | 0.04    | 1.8        | **46×** |
| 1000 mul chain                    | 1.7     | 31         | **18×** |

**`_csv`** (parse/write, ms/op):

| Operation                     | Wasthon | csv.py | Speedup   |
| ----------------------------- | ------- | ------ | --------- |
| parse 1000 simple rows        | 20.2    | 495.6  | **24.5×** |
| parse 500 quoted-comma rows   | 15.9    | 314.7  | **19.8×** |
| parse tab-delimited 1000 rows | 71.0    | 630.5  | **8.9×**  |

**Compression family** (MB/s throughput; higher is better):

| Op                      | _bz2 | _lzma | _zstd |
| ----------------------- | ---- | ----- | ----- |
| compress 10 KB text     | 1.14 | 1.95  | 2.44  |
| compress 100 KB text    | 3.12 | 12.21 | 10.85 |
| compress 500 KB text    | —    | —     | 21.54 |
| compress 1 MB text      | 2.61 | —     | —     |
| decompress 10 KB text   | 6.98 | 7.32  | 7.32  |
| decompress 100 KB text  | 5.78 | 5.74  | 5.43  |
| decompress 1 MB text    | 7.98 | —     | —     |
| compress 50 KB binary   | —    | 10.46 | 10.46 |
| decompress 50 KB binary | —    | 10.46 | 14.65 |

(`_bz2`/`_lzma`/`_zstd` have no Brython equivalent, so the columns measure
absolute throughput, not speedup. The writable-bytes bridge refactor
roughly doubled decompress throughput vs the prior baseline by skipping
one O(n) copy on the output path.)

**`array`** (5000-element typed array, ms/op):

| Operation                      | Wasthon | Brython list (best alt) | Verdict   |
| ------------------------------ | ------- | ----------------------- | --------- |
| tobytes 5000 ints              | 7.5     | 51.4 (manual pack)      | **6.9×**  |
| tobytes + frombytes round-trip | 6.7     | 85.1                    | **12.7×** |
| construct array('i', 5000)     | 6.2     | ~0 (list copy)          | list wins |
| extend 10000 ints              | 28.0    | 0.5                     | list wins |

Brython's own `Lib/array.py` is broken (rejects valid typecodes, missing
methods). Wasthon's `array` is the first working typed array in Brython.

**`_json`** (`encode_basestring`, scaling with input size):

| Input size            | Wasthon ms | Brython pure-Py ms | Speedup    |
| --------------------- | ---------- | ------------------ | ---------- |
| 11 chars ASCII        | 0.014      | 0.358              | **25.57×** |
| 1300 chars ASCII      | 0.110      | 22.88              | **208×**   |
| 1700 chars w/ escapes | 0.090      | 24.12              | **268×**   |
| 11000 chars Lorem     | 0.450      | 149.45             | **332×**   |

Largest single-operation speedup measured on any ported module. The C
state machine asymptotes to ~24 MB/s of JSON encoding while pure-Python
char-by-char saturates around 75 KB/s — interpreter overhead vs native
string scan.

**Brython has a broken `_json` module**: a user (the author of this project)
filed a Brython issue 3 months before this port noting that
`json.loads(invalid_xml_string)` raised `json.decoder.JSONError` (an
exception that doesn't exist in CPython) instead of `JSONDecodeError`.
Brython's `_json` is also API-incompatible with CPython — Brython's
`_json.loads(s, **kw)` exists but CPython's `_json` has no top-level
`loads`. Wasthon's `_json` ships the genuine CPython API. Combined with
bundling `Lib/json/`, `import json` would resolve that filed Brython
issue automatically.

**`math`** (int-heavy functions vs pure-Python equivalents):

| Operation          | Wasthon ms | Brython ms | Speedup      |
| ------------------ | ---------- | ---------- | ------------ |
| factorial(200)     | 0.024      | 0.289      | **12×**      |
| factorial(500)     | 0.066      | 0.773      | **11.7×**    |
| gcd(10**18, 7**18) | 0.008      | 0.156      | **19.4×**    |
| isqrt(10**18)      | 0.004      | 0.089      | **22.2×**    |
| isqrt(10**40)      | 0.020      | 0.178      | 8.9×         |
| prod(range(1,100)) | 0.289      | 0.126      | 0.44× (loss) |

The int-heavy helpers (factorial, gcd, isqrt) win 9-22× because CPython's
C implementation does the BigInt arithmetic in tight C loops — exactly the
pattern wasthon thrives on. The trig/log floats (sin/cos/sqrt) are
delegated to libm and would barely beat Brython (browser `Math.sin` is
the same hardware op). `prod` loses because iteration crosses the bridge
per element — canonical case of the work-density anti-pattern (each
multiplication walks JS → bridge → C → bridge → JS).

**`cmath`** (complex math) — smoke 8/8. Historically the bench was noisy
across runs because each iteration used to leak a Brython complex wrapper
into the bridge's handle map (the sentinel handle-map leak — since fixed
by handle scopes, see *What's next*). Across reruns the directional pattern
is consistent: complex→complex ops (sqrt/exp/log/sin/cos) tend to win
**2-3.5×** while scalar-returning ops (`phase`, `polar`) lose. Exact
speedup numbers await a bench rerun now that the leak is gone (the
historical noise floor was ~50% on cmath bench results). Brython's bundled `cmath.py` is
broken at import time — wasthon's port is the first working complex math
for Brython users regardless.

**`_statistics`** (`_normal_dist_inv_cdf`, Wichura AS241 — ms/op):

| Quantile / branch                     | Wasthon | Pure-Py AS241 | Speedup  |
| ------------------------------------- | ------- | ------------- | -------- |
| inv_cdf(0.5,   0, 1)   [central, q=0] | 0.00750 | 0.01800       | 2.4×     |
| inv_cdf(0.7,   0, 1)   [central]      | 0.00300 | 0.00900       | 3.0×     |
| inv_cdf(0.975, 0, 1)   [near-tail]    | 0.00500 | 0.01750       | 3.5×     |
| inv_cdf(0.999, 0, 1)   [near-tail]    | 0.00300 | 0.01900       | **6.3×** |
| inv_cdf(1−1e-15, 0, 1) [extreme tail] | 0.00350 | 0.02150       | **6.1×** |
| inv_cdf(0.95, 100, 15) [scaled]       | 0.00400 | 0.01500       | 3.8×     |

Textbook work-density curve: the tail branches evaluate one extra polynomial,
so more flops sit behind the single bridge crossing → bigger win. 1 call =
1 crossing for ~30-50 flops, so always a win, never close to break-even.

**`pyexpat`** (parse 5000 XML items, ~22 KB doc):

| Callback pattern                 | Time   | Throughput                    |
| -------------------------------- | ------ | ----------------------------- |
| Parse only (no Python callbacks) | 4.4 ms | **63 MB/s** (native libexpat) |
| Parse + 1 callback per element   | 364 ms | 767 KB/s (80× slower)         |
| Parse + 3 callbacks per element  | 678 ms | 412 KB/s (150× slower)        |

Cleanest demo of the work-density rule we have: same module, three patterns,
three orders of magnitude difference. The "parse only" path runs at native
libexpat speed because *no bridge crossings happen during the parse* — C
state machine just consumes bytes. Add a Python handler per element and
throughput collapses. Strategic implication: for XML in practice, the next
port should be `_elementtree` (the C accelerator for `xml.etree.ElementTree`)
which builds the DOM tree *inside C* from libexpat callbacks, so only one
bridge crossing happens at the end.

**Brython has no working XML parser**: own `pyexpat` errors on basic
`ParserCreate()` calls; `xml.etree`, `xml.dom`, `xml.sax` are not shipped.
Brython upstream explicitly labelled the XML gap **"won't fix"** — the
reasoning was that `pyexpat` is CPython C and no pure-Python port exists,
proposing browser `DOMParser` as the workaround. Wasthon's `pyexpat` is the
first working XML parser for Brython users; combined with bundling CPython's
pure-Python `xml/` stdlib it lights up `xml.dom.minidom.parseString(...)`
and `xml.etree.ElementTree.fromstring(...)` end-to-end (etree at pure-Python
speeds until `_elementtree` is ported).

### What the bench results teach — the "work-density rule"

A clear pattern emerged across the ports. WASM-via-bridge wins when the C
code does substantial work **between** bridge crossings; it loses when the
operation is small and the bridge crossing dominates:

| Profile                                            | Speedup expected  | Examples                             |
| -------------------------------------------------- | ----------------- | ------------------------------------ |
| Compute-dense, custom C types, work in WASM        | **5-50×**         | `_decimal`, `_csv`, hashlib, zlib    |
| Single bulk call with O(N) inner loop in C         | **5-15×**         | `array.tobytes`, compress/decompress |
| Per-element bridge crossings (loop in JS, op in C) | **0.5-1×** (LOSS) | `math.prod`, `cmath.phase`           |

This is the second selection rule for choosing modules to port. The first
is **"engine separable from Py-API"** (the C side does substantive work
that doesn't constantly call back into Python). There used to be a third —
**"no static PyTypeObject"**: modules that define their types with 50-field
static struct initializers were incompatible with the bridge, because
wasthon.h reorders `struct _typeobject` and a positional initializer fills
the wrong slots. That rule fell with `src/dtconvert.py` (see "How it's
built" below): `_datetime` — 7 static types, 227 positional slots — now
compiles verbatim and ships in both bundles (`datetime.date + timedelta`
drops from 146 µs interpreted to 1.7 µs, **86×**). The same conversion,
generalized, is what put real PyTorch on the bridge
([BryTorch](https://github.com/fgallaire/brytorch): 31 static types,
1029 slots).

## wasthonp — CPython's parser as the frontend

The modules above are Wasthon's "backend" (CPython's C extensions behind the
C-API bridge). **`wasthonp/` is the frontend sibling**: CPython's real
tokenizer + PEG parser → AST, compiled to WebAssembly (~400 KB) and used as a
**drop-in replacement for Brython's hand-written JS parser**. It plugs in by
monkeypatching `$B._PyPegen.run_parser`; the whole glue is one file
(`wasthonp/wasthonp.js`). No interpreter, no eval loop, no stdlib — just the
parser (that is what keeps it 25× smaller than Pyodide's ~10 MB).

All measured, against the vendored Brython:

- **Correctness — it *is* the CPython 3.14 grammar.** Full-stdlib round-trip
  (1851 files): 1830 parse + build + codegen with **0 wasthonp crashes**,
  1147 byte-identical to Brython's own codegen (the rest cosmetic diffs).
  Five stdlib files crash Brython's hand-written parser and parse cleanly
  under wasthonp (e.g. PEP 750 t-strings with the debug specifier
  `t"{x=}"`); the reverse never happens.
- **Faithful `SyntaxError`s** — CPython's exact message and position,
  tokenizer errors and the helpful 3.x hints included (`'(' was never
  closed`, `Maybe you meant '==' instead of '='?`). On CPython's own error
  corpus (`test_syntax.py`, 71 cases): **52/71** message matches vs
  Brython's 45/71, and 0 parse-stage errors missed.
- **~3.5–6× faster parse** (up to 5.9× on `_pydecimal.py`), which dilutes to
  an honest **~1.5× end-to-end** source→JS — the full pipeline is gated by
  Brython's code generator and `$B.ast` construction, both shared with the
  native path.
- **An adoption argument, not a fork**: the codegen stays Brython's, and
  adopting wasthonp would let Brython retire its hand-written parser
  (~40% of the engine's JS source, ~550 KB off `brython.js`). The
  integration is Brython's call; this repo never modifies Brython.

Build it with `./build.sh wasthonp`, try it at `loader/wasthonp.html`
(run Python through it + parse-time bench vs Brython). Full docs:
[`wasthonp/README.md`](wasthonp/README.md) and the measured comparison in
[`wasthonp/WASTHONP_VS_BRYTHON.md`](wasthonp/WASTHONP_VS_BRYTHON.md).

## How it's built

The bridge is the leverage. It implements just enough of the public CPython
C-API to compile unmodified stdlib modules. From a `<x>module.c` in
CPython's `Modules/`, one `emcc` invocation produces an Emscripten ES6
module exposing `PyInit_<x>()`. A small Brython-side loader
(`loader/wasthon-loader.js`) instantiates it and registers it under
`__BRYTHON__.imported[<x>]` so `import <x>` from Python just works.

One module gets an extra build step. `_datetime` defines its 7 types as
**static `PyTypeObject` initializers** — positional C89 lists whose meaning
depends on the exact field order of `struct _typeobject`, which wasthon.h
reorders. Compiled raw, every slot lands in the wrong field. So
`src/dtconvert.py` rewrites the 227 positional slots into **C99 designated
initializers** (`.tp_dealloc = ...`) at copy time, keyed on CPython's
canonical slot order. It is a deterministic source-to-source pass, the
output is ordinary diffable C, and the source stays byte-for-byte upstream
CPython in the repo — the same zero-fork rule as every other module. The
runtime half (`_PyDateTime_InitTypes`, singleton registration, the real
packed-struct `datetime.h` for capsule consumers like pandas) rides in
`datetime_exec` via `build.sh`.

```
                ┌──────────────────────────────────────────────┐
   <x>module.c  │  emcc  →  PyInit_<x>() exported via WASM     │
   (CPython,    │     ↑                                        │
   unmodified)  │  wasthon.h + wasthon.c + wasthon.js          │
                │  (CPython C-API replicated atop Brython)     │
                └──────────────────────────────────────────────┘
                                  ↑
                          Brython runtime
                          (__BRYTHON__, _b_)
                                  ↑
                          User Python:
                              import _decimal
                              d = _decimal.Decimal('3.14') * 2
```

## Repo layout

- **`src/`** — the C-API bridge.
  - `wasthon.h` (~1500 lines) — type defs, macros, function prototypes.
    Mostly a mirror of CPython's public C-API surface; the load-bearing
    parts are struct layouts (`PyTypeObject` offsets), macro values that
    must match `Include/typeslots.h` exactly (`Py_nb_multiply=29`, etc.),
    and the selection of which API to expose at all.
  - `wasthon.c` (~500 lines) — `extern` definitions, `wasthon_init()`
    which populates them at boot, plus a few small C helpers.
  - `wasthon.js` (~7200 lines) — Emscripten js-library: ~395 entry points
    covering handle management, object protocol, type-spec creation,
    buffer protocol, arg parsing, Unicode, dict/list/tuple, IEEE 754,
    sequence protocol, METH_METHOD trampoline, getset descriptors, slot
    dispatch shapes (b/t/r/i/n/c/si/sis), `Py_BuildValue`/
    `PyUnicode_FromFormat` real variadic impls. Where the actual logic
    lives — most C-side functions in `wasthon.h` are declarations whose
    implementation is here.
  - Plus `Python.h`, `pyconfig.h`, `pymacro.h`, `hashlib.h`, `pyexpat.h`,
    `complexobject.h`, and ~25 `pycore_*.h` stubs that mostly redirect
    `#include "pycore_X.h"` to `wasthon.h` so unmodified CPython source
    files compile. The notable exception is `pycore_blocks_output_buffer.h`
    (321 lines), copied verbatim from CPython — used by compression modules.
- **`build/`** — copied CPython sources + compiled `.wasm`/`.mjs` artifacts.
  Per-module compile happens here. Includes pre-built object files for
  bundled external libraries when needed (HACL\* hashes, libmpdec, bzip2).
- **`external/`** — downloaded upstream source trees (CPython, libexpat,
  liblzma, libzstd, bzip2, emsdk itself). Gitignored. Populated on first
  `./build.sh` run, ~3 GB after a full build.
- **`wasthonp/`** — the parser frontend: CPython tokenizer + PEG → AST in
  WASM (see the wasthonp section above). Strategy-C shims under
  `wasthonp/shims/` (minimal POD object layer, AST→JSON, faithful errors),
  its own `build.sh` (driven by `./build.sh wasthonp`), node harnesses
  (`validate2.js`, `superiority.js`, `bench.js`), output in
  `wasthonp/build/` (gitignored, staged into `build/` for the site).
- **`loader/`** — `wasthon-loader.js` (Brython integration), `index.html`
  navigation page, 14 per-module smoke pages (`test-*.html`), 14 per-module
  bench pages (`bench-*.html`). Brython is loaded via `brython-src.js`, which
  defaults to the **vendored, patched build in `loader/brython/`** (stock
  3.14.1 plus the fixes tracked in `BRYTHON_FIX.md`, pending upstream); add
  `?brython=cdn` to any page to load stock `brython@3.14.1` from jsDelivr
  instead, for comparison. (`loader/brython/` is vendored so results are
  reproducible and match GitHub Pages; it goes away once the fixes ship in a
  published Brython.)

## Hard rules (so the bridge stays small)

The C-API bridge only grows when a target module forces it. Four rules
prevent it from becoming "CPython in JS" (which would defeat the point —
that's Pyodide):

1. **Implement only what targeted modules actually call.** Grow on demand.
2. **No Python runtime.** No `PyImport_*`, no `PyEval_*`, no `PyCode_*`,
   no exception machinery beyond a single pending-exception flag.
3. **`PyObject*` is opaque** for most code. C never inspects layout except
   for a small fixed `_typeobject` struct (tp_free, tp_dict, tp_name,
   tp_alloc, tp_init) needed for direct slot access from a handful of
   modules, plus `PyObject_VAR_HEAD` which declares `Py_ssize_t ob_size`
   at struct offset 0 for variable-size objects (array, bytes-like).
4. **Two handle kinds**: sentinel-range small integers for ordinary Brython
   objects; real WASM pointers for C-allocated instances. The handle IS the
   pointer so `self->field` dereferences hit the right linear memory.

The bridge today covers ~425 distinct C-API entry points. That's enough for
**25 stdlib modules**, all major type-creation patterns (factory functions,
tp_new-only, tp_new+tp_init, multi-phase exec slot), buffer protocol,
Unicode (PEP 393 strict, kind-aware), dict/list/tuple, IEEE 754, slot
dispatch including sequence and number protocols, getset descriptors
(static and dynamic via `PyDescr_NewGetSet`), METH_METHOD bound methods,
`Py_BuildValue` varargs, real `PyUnicode_FromFormat` (printf-style with
`%s`/`%d`/`%zd`/`%c`/`%p`/`%R`/`%S`/`%U`/`%x`/flags/width/precision —
fixes broken `repr()` on every stateful instance type),
full `PyUnicodeWriter` API (3.14), proper
`tp_setattro`/`tp_getattro` wiring, weak GIL stubs.

**⚠ Platform-width divergence — Brython says 64-bit, the C layer says
32-bit, by design.** Brython emulates a 64-bit CPython: `sys.hash_info.width`
is 64, `float.__hash__` is the 61-bit `_Py_HashDouble`, and
`str.__sizeof__`/`sys.getsizeof('abc')` report 64-bit sizes (44, what a
desktop CPython says). The wasthon C layer is genuinely wasm32 and reports
its own truth: `struct.calcsize('P')` is 4, and a C instance's `__sizeof__`
is in CPython-32-bit canonical units (`sys.getsizeof(array.array('i'))` is
32 — the number a CPython-in-wasm like Pyodide gives). Each layer is
self-consistent and its tests measure through its own ruler (test_array's
`check_sizeof` computes expectations with *our* `struct`, 32-bit; the hash
tests go through Brython, 64-bit) — but code comparing sizes *across* the
two layers must expect the seam.

**⚠ Out-of-bounds heap reads yield `undefined`, not garbage — bound every
`HEAPU8` loop by the allocation, never by a caller-supplied size.** A JS
typed array read past its end returns `undefined`, which then flows into
Brython as an `UndefinedType` object and detonates far from the cause
(`'UndefinedType' object cannot be interpreted as an integer`). Worse, it
only detonates *under heap pressure*: while memory happens to exist past
the block the same overrun reads junk-but-defined bytes and works, so the
bug looks like inter-test poisoning — green in every standalone probe,
failing deterministically in suite context (this was pickle's long-hunted
`optional_frames` "poison": `_PyBytes_Resize` read the *new* size from
the *old* block). Any `HEAPU8[ptr + i]` loop must clamp to
the tracked allocation size (e.g. `__wasthon_cstr_size__`) — a size the C
side asks for is a request, not a promise about the block under `ptr`.

**⚠ Recursion is three nested stacks, and the wasm one must never win.**
A Python-level recursion is a JS recursion (Brython compiles Python to
JS): Brython's own counter — driven by `sys.setrecursionlimit`, with the
engine's `InternalError: too much recursion` converted as a backstop —
raises `RecursionError` there. A C-level recursion (`_json`'s
scanner/encoder, `_pickle`'s save/load, expat's content model) runs on
the **wasm stack**, a fixed 4 MB reservation (`-sSTACK_SIZE=4MB`) whose
overflow is an *uncatchable trap* that kills the page — so
`Py_EnterRecursiveCall` routes to a bridge depth counter (cap 4000 ≈
CPython's `Py_C_RECURSION_LIMIT`, a ×5 margin under the stack) that
raises CPython's exact `RecursionError` first, call-site suffix included.
The C cap is fixed and deliberately *not* tied to `sys.setrecursionlimit`
— that is CPython 3.12+'s own design (the C recursion limit is decoupled
from the Python one). Cross-boundary recursion (a C encoder calling a
Python `default` hook per level) burns both counters and whichever fires
first raises. One fidelity inversion worth knowing: CPython's *own*
emscripten builds skip the deep-recursion tests (their stack-probing
guard has no headroom in wasm); wasthon runs them and passes — a 500k-deep
JSON nesting raises `RecursionError` instead of trapping.

## Running it

Prerequisites:

- [Emscripten SDK](https://emscripten.org/) is installed automatically into
  `./external/emsdk/` on first build (pinned to 5.0.7); only `curl` or `wget`
  needs to be on PATH up front
- `make` (used by `emmake make` to build liblzma and libzstd)
- Python 3 (for `python3 -m http.server`)
- Brython is loaded by the loader pages from the vendored build in
  `loader/brython/` (stock 3.14.1 + the patches in `BRYTHON_FIX.md`); pass
  `?brython=cdn` on any page to load stock `brython@3.14.1` from jsDelivr — no
  local checkout needed either way

Source trees for CPython and the C libraries (bzip2, expat, xz, zstd) are
**downloaded automatically** by `build.sh` if not already present. Defaults
land them in `./external/<libname>` (gitignored). Override via env vars to
point at an existing checkout outside the repo:

```
CPYTHON_SRC, EXPAT_DIR, ZSTD_DIR, XZ_DIR, BZIP2_DIR
```

Build any module via the wrapper script (after activating emsdk):

```bash
cd wasthon
./build.sh _sha2          # any of the 25 known modules → build/_sha2.{mjs,wasm}
./build.sh _sha2 _decimal # several specific modules in one go
./build.sh all            # everything as per-module .mjs/.wasm
                          # (~45 s once libs are cached; first run downloads + builds the libs too)
./build.sh wasthon        # light bundle: 23 modules in build/wasthon.{mjs,wasm} (~1 MB)
                          # — drops the three specialists (unicodedata, _zstd, _sqlite3)
./build.sh wasthon-full   # full bundle: 26 modules in build/wasthon-full.{mjs,wasm} (~3 MB)
```

The per-module target is best for dev, bench, and incremental work — each
module is fetched only if imported, and rebuilds are cheap. The bundled
targets are the "drop one script tag into your HTML" deliverable: one
fetch, one WASM instance, shared bridge runtime. `wasthon` is the default
(~1 MB / 348 KB gzip); `wasthon-full` adds the three specialists
`unicodedata` (full Unicode DB), `_zstd` (libzstd), and `_sqlite3`
(SQLite 3.46.1 + FTS5/RTREE/JSON1) — together responsible for most of the
full bundle's extra weight. Users who need any of them can also load the
per-module .wasm add-on alongside `wasthon`. See `loader/test-wasthon.html`
and `loader/test-wasthon-full.html` for working bundle pages.

**Compile flags.** Modules are compiled with `emcc -O3` by default. The
project's positioning is perf-first — the C accelerators only earn their
wasm footprint if they beat Brython's pure-Python implementations by
large margins. `_sqlite3` is the single documented exception: built with
`-Oz` (halves the wasm — 1.35 MB → 730 KB — with negligible runtime cost
in practice, since SQLite is bridge-bound and carries large cold-path
features like FTS5/RTREE/JSON1 that aren't on the query hot loop). This
size cut is what made bundling `_sqlite3` in `wasthon-full` viable.

**Link flags.** Links use `emcc -O2` with the standard runtime exports.
Three per-target deviations target the stack and the heap ceiling:

- **`-sSTACK_SIZE=4MB`** on `_decimal`, `_pickle`, `pyexpat` and both
  wasthon bundles. The sizing rule is **"match the legitimate use
  case, not just the tests"**: each of these modules has a stack-heavy
  code path that's part of its public contract — arbitrary-precision
  arithmetic on big numbers (`_decimal`), deeply-nested XML (`pyexpat`),
  deep object-graph serialization (`_pickle`). The test suite plateaus
  are tighter (e.g. `pyexpat` clears all its tests at 1 MB), but real
  workloads can push further — DOM trees with hundreds of nesting
  levels, recursive object graphs, `c.prec` set very high — so we bump
  everyone to 4 MB for headroom on legitimate inputs. **Zero `.wasm`
  byte cost** — STACK_SIZE is a runtime reservation, not embedded
  bytes. ALLOW_MEMORY_GROWTH=1 means the reservation only takes
  effect on actual use; idle code paths pay nothing.
- **`-sSTACK_OVERFLOW_CHECK=2`** on `_decimal` standalone and on the
  `wasthon-full` bundle (which contains `_decimal`). libmpdec is the
  single module that can still push the stack at extreme inputs even
  with 4 MB; the per-prologue guard turns any remaining overflow into
  a clean Python exception instead of silent memory corruption.
  Level 1 (end-of-program sentinel) is too late. Size cost:
  `_decimal.wasm` +4.3%, `wasthon-full.wasm` +~2%. NOT applied to the
  light `wasthon` bundle (which doesn't ship `_decimal`) nor to
  `_pickle`/`pyexpat` standalone — the 4 MB headroom alone clears
  everything we've measured for those, and the per-prologue guard
  carries a small runtime perf cost.
- **`-sMAXIMUM_MEMORY=4GB`** on `_lzma` standalone and both wasthon
  bundles. The default 2GB growth ceiling was the
  real wall behind most of test_lzma's out-of-memory failures: liblzma's
  preset-6 encoder allocates ~94 MB per instance, and the *cumulative*
  heap pressure of a long-running page (the bridge's known handle-map /
  sentinel retention, see the GC section) pushes the total toward the
  cap, where `ALLOW_MEMORY_GROWTH` can grow no further and `malloc`
  starts returning NULL. 4 GB is the wasm32 maximum; the `maximum` is a
  virtual-address-space reservation, not an allocation, so it costs
  nothing on 64-bit hosts (32-bit user agents may fail to instantiate —
  considered acceptable in 2026). This buys headroom, it does not fix
  the retention. Re-evaluated once the per-call arena work landed
  (handle scopes, 2026-06-12): with retention gone, a 2GB build still
  measures −18 on test_lzma and times out test_pickle — the ceiling is
  real allocation appetite (liblzma's larger presets, pickle's biggest
  payloads), not bridge retention. 4GB is the permanent setting; the
  price is the unsigned-pointer discipline required of hand-written JS
  above the 2GB address boundary.

The script handles all the per-module quirks: downloading missing source
trees, compiling external libraries (libexpat, liblzma, libzstd, bzip2,
libmpdec, HACL\*), and the emcc `EXPORTED_FUNCTIONS`/`EXPORT_NAME` for each
target module.

Serve and test:

```bash
# from the wasthon directory
python3 -m http.server 8765
# open http://localhost:8765/loader/index.html
# → individual test-*.html and bench-*.html pages for each module
# → test-all.html for a one-click sequential sweep of every test page
```

Headless runs and CI:

```bash
pip install playwright
playwright install chromium
python3 test.py   # spawns http.server, drives test-all.html via Chromium,
                  # exits 0 on green / 1 on red
```

A GitHub Actions workflow (`.github/workflows/test.yml`) runs this on every
push to `main` and every pull request — it builds all modules, both bundles,
and runs the headless sweep. The first run is the slow one (downloads
CPython + SQLite + emsdk + all libs, cold-compiles everything); subsequent
runs benefit from the `external/` and `build/*.o` caches.

## What's next

Recent ports:

- [x] `binascii` — CPython C accelerator for hex / base64 / CRC encoding
      (`hexlify`/`unhexlify`, `b2a_base64`/`a2b_base64`, `crc32`, `crc_hqx`,
      `b2a_hex` with the 3.14 `sep`/`bytes_per_sep` API). 24 KB wasm, the
      smallest module ported so far. Bundled in `wasthon` light by
      default (+13 KB marginal — encoding is a fundamental Python
      primitive used wherever bytes touch the network or the file
      system). Brython's `binascii` is pure-Python; wasthon replaces it
      transparently with bit-exact CPython behaviour. **Honest
      benchmark** (2 MB payloads, median of 10 runs): decode operations
      are **~4× faster** (`unhexlify` 3.9×, `a2b_base64` 4.3×) and
      `crc32` works at all — Brython's pure-Python `crc32` raises
      `TypeError: ord() expected a character, but int was found`, a
      latent bug in its impl that wasthon resolves in passing. Encode
      operations are mixed: `b2a_base64` ~1.8× faster, but
      **`hexlify` is actually slower than Brython** (~0.55×) because
      the bridge bandwidth cost on `bytes → hex string` (6 MB of
      transfer for 2 MB input) outweighs the C win on what is otherwise
      a trivial byte-to-char operation. Reporting that regression
      honestly rather than papering it over with a JS-side shortcut:
      wasthon's contract is "real CPython C behaviour", optimization
      of `hexlify`-as-pure-Python belongs upstream in Brython.
      Port surfaced two CPython-internal symbols not previously
      needed by the bridge: `_PyLong_DigitValue[256]` (char→digit
      lookup used by hex parsing, added verbatim from
      `Objects/longobject.c`) and `_Py_strhex_bytes_with_sep`
      (hex-with-separator formatter; the naming is misleading — the
      `bytes_` infix denotes the *return* type, not the input, so it
      returns a `bytes` object). Also hit a new instance of the Brython
      kwarg-falsy-default quirk: a direct top-level
      `b2a_base64(b'…', newline=False)` compiles to
      `b2a_base64(b'…', 0=False)` (the kwarg name '`0`' is the value of
      `False`). Previously thought lambda-only; now confirmed to fire
      from plain calls too.
- [x] `_sqlite3` — SQLite 3.46.1 amalgamation + CPython's full `_sqlite`
      hierarchy (Connection / Cursor / Row / Blob / PrepareProtocol /
      Statement / microprotocols / util). FTS5, RTREE, and JSON1 enabled
      for real-world usefulness; `:memory:` only for now (no persistence
      wired yet). Bundled in `wasthon-full`, also loadable standalone for
      sites that only need a database. **Compiled with `emcc -Oz`** —
      the project's overall rule is `-O3` (perf-first, that's wasthon's
      value prop), but SQLite is a documented exception: -Oz halves the
      wasm (1.35 MB → 730 KB) with negligible cost in practice (SQLite
      is bridge-bound + carries large cold-path features like FTS5/RTREE/
      JSON1 that aren't on query hot loops). The size cut is what made
      bundling sqlite in `wasthon-full` viable. Bench validation is still
      blocked on handle reclamation: `tp_dealloc` dispatch has since landed,
      but a loop-bench `con = connect()` drops the Connection at Python
      scope exit, outside the explicit `close()`/`with` contract, so its
      native context leaks (the documented scope-exit residual — not an
      auto-finalizer, which a synchronous run can't fire promptly anyway).
      A proper compare-loop bench waits on that scope-exit reclamation. Bridge growth from this port — chief
      among them: `forwardError` helper preserves the original Brython
      exception class through C boundaries (replaces ~30 sites of
      `setError(RuntimeError, e.message)` flattening); `Py_tp_call`
      slot wiring lets callable types dispatch through C (sqlite's
      `statement_cache(lru_cache(n))` flow needs this); `__wasthon_type__`
      on `tp_new`'d instances unlocks `PyObject_TypeCheck` for clinic
      `__init__` guards; new bridge symbols `_PyUnicode_AsUTF8NoNUL`,
      `PyUnicode_FSConverter`, `PyLong_AsUInt32`, `PySequence_Check`,
      `_PyErr_FormatFromCause`, `PyErr_Print`, `PyExc_Warning`, plus
      single-threaded GIL stubs and `PyArg_ParseTuple` format-char `'U'`.
- [x] `_pickle` — C accelerator for `pickle`. Round-trips ints (incl. BigInts),
      floats, str (incl. non-ASCII unicode), bytes, bool, None, list, tuple,
      dict, set, frozenset, and arbitrary nestings of these across all four
      protocols (0–5; default 5). Bit-exact with CPython 3.14. Bundled in
      `wasthon` light (+57 KB marginal) since serialization is a fundamental
      Python primitive. Brython's own pickle is pure-Python (slow) and
      exposes a different API surface; wasthon's port is the genuine
      CPython API. Surfaced and fixed a stack of latent bridge bugs
      benefiting all future ports — chief among them: `PyObject_GetAttr`
      must fall back through `cls.tp_funcs` (Brython's `$getattr` only
      consults the class dict); `PyErr_NewException` must rebuild the MRO
      and inherit `tp_new`/`tp_init` (raise-time "$is_slot of undefined"
      otherwise); the bytes "C wrote into `__wasthon_cstr__` but `.source`
      still zero" sync must descend recursively into container return
      values; `PyTuple_New` must go through `tuple.$factory` (a tagged JS
      Array doesn't fully mimic a Brython tuple); `PyOS_snprintf` needed
      a real varargs implementation (it was a stub that copied the format
      string verbatim, so `%zd\n` from protocol-0 INT serialization went
      straight into the pickle stream). And the gem: `bind_builtin_type`
      was last-write-wins on the Brython-class key, so `PyODict_Type` was
      overwriting `PyDict_Type` — making `Py_TYPE(dict) == &PyDict_Type`
      silently false and pickle fall through to the reduce path. Latent
      for the previous 22 modules because none compared
      `Py_TYPE(obj) == &PyXxx_Type` directly.
- [x] `_decimal` (libmpdec) — arbitrary-precision math, 18-46× speedup.
- [x] `_csv` — full state machine port, 8-25× speedup.
- [x] Full compression family: `_bz2`, `_lzma`, `_zstd` alongside `_zlib`.
- [x] `array` — foundation for typed arrays / future numerics.
- [x] `pyexpat` (libexpat) — XML parser. Brython upstream had labelled the
      XML gap "won't fix" (no pure-Python pyexpat). Wasthon's port resolves
      it: real CPython pyexpat, 63 MB/s on the parse-only path.
- [x] `_json` — JSON encoder/decoder C accelerator. **25-332× speedup**
      on encode_basestring vs pure-Python (largest single-op speedup of
      any port). Brython has its own incompatible `_json` with a known bug
      filed 3 months prior to this port — wasthon's port ships the real
      CPython API and resolves it.
- [x] `math` — int-heavy fns (factorial / gcd / isqrt / prod / comb / perm).
      **9-22× speedup** on the int helpers (factorial(500): 11.7×,
      isqrt(10**18): 22.2×). Float ops (sin/cos/sqrt) delegate to libm
      and gain nothing over browser `Math.X`. Exposed two latent generic
      bridge bugs: PyNumber_Multiply/Add silently produced JS Infinity on
      Number×Number overflow (now promotes to BigInt automatically), and
      `_PyLong_Lshift`/`_Rshift` were declared `size_t` in our header but
      CPython 3.14 uses `int64_t` — emcc ABI mismatch produced garbage
      shift values for the new BigInt-aware code paths.
- [x] `cmath` — complex math. 8/8 smoke. Bench numbers pending a rerun:
      the old 50%+ variance came from handle-map pressure — the sentinel
      handle-map leak behind that noise is now fixed (handle scopes — see
      *What's next*); directionally: complex→complex ops win ~2-3.5×,
      scalar-returning ops lose. Exposed the emcc wasm32
      ABI pattern for passing/returning
      small structs (Py_complex) by value via sret. Brython's own
      `cmath.py` is broken at import time — wasthon's is the first
      working complex math for Brython users regardless.
- [x] `_statistics` — `_normal_dist_inv_cdf` (Wichura AS241). 7/7 smoke.
      6/6 bench wins: 2.4× central, up to **6.3×** on the tail branches.
      Smallest port to date (15 KB wasm), single METH_FASTCALL function.
      Textbook validation of the work-density rule — one bridge crossing,
      ~30-50 flops inside C, never close to break-even.
- [x] Bridge fixes since the polish pass — moved to `CHANGELOG.md` to
      keep this list focused on what's *in* the bridge rather than
      what was *fixed in* it. Recent highlights: `tp_init` kwarg
      threading, `$kw` `**d` expansion, `array.array` cluster, `'w*'`
      writable-buffer format, `bool` coercion + `callable()` on C-call
      types. Older entries (`PyUnicode_FromFormat`, writable-bytes
      refactor, slot-ID collision, `unicodedata.numeric`/`.digit`/
      `.decimal`) are there too.
- [x] Bridge surface ~7200 lines: METH_METHOD trampoline, getset
      descriptors, sequence protocol slots, dict-style kwargs in
      `_PyArg_UnpackKeywords`, struct-aware `Py_SIZE`/`Py_SET_SIZE`,
      numeric format dispatch in `PyArg_Parse` (was a no-op stub for
      months — exposed by array.array), `Py_BuildValue` real impl with
      varargs format dispatch (was a SystemError stub — exposed by
      pyexpat), dynamic getset descriptor creation via `PyDescr_NewGetSet`,
      `tp_setattro`/`tp_getattro` wired on all builtin classes (was a
      latent gap — "setattr is not a function" once any module installed
      property descriptors), 4-byte memory corruption on the type struct
      fixed (was 44-byte struct allocated 40 since the beginning), full
      `PyUnicodeWriter` API (new in CPython 3.14, 9 entry points),
      `PyUnicode_KIND` / `PyUnicode_DATA` made PEP-393-strict so input
      and output buffers agree on stride — was returning kind=4 with
      UCS4-strided data unconditionally, broke any module that built
      output strings with smaller kind than input (exposed by _json's
      encode_basestring on ASCII strings, where input kind=4 was read
      with output kind=1 stride and produced zero-byte garbage between
      chars).
- [x] Top-level `build.sh <module>|all|wasthon|wasthon-full|list` script. Bootstraps emsdk into
      `external/emsdk/` if missing, downloads CPython + libexpat + libxz +
      libzstd + bzip2 sources via `curl`/`wget` on first run, compiles all
      the per-module quirks (which CPython sources, which external library
      objects, include paths, `EXPORTED_FUNCTIONS`, `EXPORT_NAME`). On a
      fresh checkout: `./build.sh all` goes from zero to 23 `.wasm` in
      a single command (~45 s once libs are cached).

The "stdlib integration" layer — where the next wins live:

Wasthon ports the C modules. The natural complement is wiring them to the
pure-Python stdlib wrappers that Brython users actually import. Each gap
below has a C module already in place; what's left is integration glue.

- [ ] **Bundle CPython's `Lib/xml/` into Brython.** `xml.dom.minidom`,
      `xml.etree.ElementTree`, `xml.sax`, `xml.parsers.expat` are all
      pure-Python — they just need `pyexpat` to exist, which it now does.
      `xml.dom.minidom.parseString(...)` and similar would light up
      immediately. Direct response to Brython's "won't fix" on XML.
- [ ] **Bundle CPython's `Lib/json/` into Brython.** `json/__init__.py`,
      `decoder.py`, `encoder.py`, `scanner.py` are pure-Python wrappers
      around `_json`. Brython has its own incompatible `json/` package
      with an open bug. Replacing it with CPython's gives the proper
      `JSONDecodeError`-with-context behaviour AND picks up wasthon's
      25-332× speedup automatically.
- [ ] **`_elementtree` (the C accelerator).** With it, `xml.etree`
      operates at near-libexpat speed (50-60 MB/s effective) because the
      DOM tree is built in C from libexpat callbacks — one bridge crossing
      at the end of the parse instead of one per element.
- [x] **Wire `_sre` into Brython's `re.py`.** Brython ships its own
      pure-Python regex code in `re.py`. Patch (or replace) `re.py` so it
      uses our `_sre` C module when available. More invasive than the XML
      case because Brython has an incumbent, not a gap.
      *Done by Pierre 2026-05-26: Brython's `Lib/re/` is now CPython
      3.14's `re/` package verbatim, importing `_sre` (auto-loaded via
      `$B.wasthonLoad` at boot). Confirmed all `tests/test_wasthon`
      pass.*

Module candidates worth porting are largely exhausted at this point. What
remains in CPython's stdlib falls into one of three buckets:

- **Structurally impossible in browser** — `_socket`, `_ssl`, `_thread`,
  `_ctypes`, `_curses`, `mmap`, `select`, `_asyncio`, heavy `_io`,
  `_multiprocessing` (no OS). (`_datetime` used to sit here under the
  static-`PyTypeObject` ban; `dtconvert.py` lifted the ban and it is now
  module #26.)
- **Fails the work-density rule** — `_functools` (`lru_cache`/`reduce`),
  `_operator`, `_queue` (no threads anyway). `_heapq` and `_bisect` were
  ported and dropped after benchmarks measured zero-or-negative gain.
- **Needs integration layer or non-trivial bridge work** — `itertools`
  (attempted, rolled back — exposed 4 transversal bridge gaps in series),
  `_elementtree` (needs `Lib/xml/` bundled), `_tokenize` (needs Parser/
  sources bundled), `_multibytecodec` + CJK codecs (needs codec system
  integration in Brython).

Future work is therefore in **depth** (better infra, integration) rather
than **breadth** (more modules).

Infrastructure work that pays back on existing modules:

- [x] `tp_dealloc` dispatch + reference counting — C-allocated instances are
      reclaimed when their refcount reaches zero. Refcount kept JS-side in a
      `Map<ptr,int>` (discrimination by Map membership, not value range); ABI
      aligned so `ob_refcnt` sits at offset 0; `Py_INCREF`/`DECREF` route
      through `wasthon_incref`/`decref`; on zero the bridge dispatches the
      type's `tp_dealloc` → `tp_free` → `PyObject_GC_Del`. Backed by a C-API
      refcount-convention audit (no-steal INCREF / steal / new-ref) that
      keeps the harness at 1750/4485, zero regression. Proven by
      `loader/test-tp-dealloc.html` (`refcounts.size` flat with dispatch on,
      +1/call with it off). Full design in `CHANGELOG.md`.
      Exact state of the dispatch chain (2026-07-16): a C subclass dealloc
      that *delegates up to a builtin* (numpy's `unicode_arrtype_dealloc`
      ends with `PyUnicode_Type.tp_dealloc(v)`) now lands on a real slot —
      `wasthon_bind_builtin_type` wires `tp_dealloc`@40 on every builtin
      struct to `PyObject_GC_Del` (unbind handle + free struct), the base
      behaviour in the bridge model. Before that the NULL slot trapped
      *silently* (the dispatcher's defensive catch ate the "indirect call to
      null") and the gc_new struct of every reclaimed `np.str_` scalar
      leaked — measured: 3 swallowed traps on a single
      `chararray.upper()/rstrip()`, 0 after wiring, handle count flat over
      3000 scalar round-trips. Note the dispatcher's defensive catch is
      load-bearing for robustness but *hides* exactly this class of bug: if
      a dealloc chain regresses, the symptom is a slow leak, not a crash —
      re-check with a gated counter in that catch before trusting it.
      Lifetime of an `np.str_` scalar box specifically: the C struct is a
      plain gc_new allocation (`PyUnicodeScalarObject`, ~24 B, obval left
      NULL); the string payload lives only as the JS `$brython_value`
      primitive; the struct is freed by this dispatch when C code drops its
      last reference (`_vec_string` per-element temporaries) or when the JS
      wrapper is collected (reclaimResults path).
- [x] Deterministic free of heavy native resources at `close()`/`with`-exit —
      Brython is tracing-GC with no refcount, so a dropped LZMA/Zstd compressor
      (its context is ~94 MB) has no deterministic finalizer and would leak to
      OOM. The C free itself works (`decref` → `tp_dealloc` →
      `lzma_end`/`ZSTD_free` → memory reused); the only missing piece was a
      deterministic trigger. The model is an explicit `close()`/`with` contract
      (as in Pyodide), not an automatic finalizer — within a synchronous run
      nothing yields, so no auto-GC callback can fire (a page that *does* yield
      between units of work gets the automatic path too; see "Wrapper-owned
      result reclamation" below). For a heavy native this stays the right
      model regardless: `close()` frees a 94 MB context *deterministically*,
      where a finalizer only frees it whenever the GC gets around to it.
      `loader/wasthon-dealloc.js` wraps the synchronous `$B.$import` to patch
      `lzma.LZMAFile`/`bz2.BZ2File`/`compression.zstd.ZstdFile` `.close()` so a
      `with` block decref's the compressor it drops and reclaims the context at
      block exit. +8 (`test_lzma` +7, `test_zstd` +1). A second deterministic
      trigger covers the *one-shot* module helpers (`lzma.compress(data)` /
      `decompress`, and the bz2/zstd equivalents): these build a bare
      `LZMACompressor`/`LZMADecompressor` with **no** `close()`, so the ~94 MB
      encoder leaked on every call — the tests call `compress()` once per
      round-trip comparison, so the heap OOM'd mid-suite and the next compressor
      allocation returned NULL silently into `LZMAFile._compressor`, surfacing
      as a `Symbol("DICT") of null` cascade. The shim runs the real helper (it
      owns the format/preset/filters logic and the decompress retry loop) and
      then decref's every instance of the compressor/decompressor *type* it
      created and left behind — capture-by-type, so the returned bytes are
      untouched. This confirmed the dispatch mechanism was never the issue
      (an explicit free survives 60 iterations that otherwise OOM at ~22); only
      the trigger was missing. +16 (`test_lzma` 96 → 112). Details in
      `CHANGELOG.md`.
- [x] Buffer-export safety, without a GC — `memoryview(a)` must make array
      mutations raise `BufferError` while the view lives (and succeed once it's
      released). No finalizer needed: the bridge syncs the export count Brython
      already maintains (`obj.exports`, `++` on create / `--` on
      `release`/`__exit__`) into the C struct's `ob_exports`, which array's
      resize ops check. Same "connect two already-correct halves" move as the
      `close()`/`with` contract above — Brython's bookkeeping + CPython's C
      check, no tracing GC. +28 (`test_array` `test_buffer` + `test_clear`).
      Details in `CHANGELOG.md`.
- [x] Partial `gc.collect()` finalization, an *explicit* trigger (not an
      auto-GC) — a sqlite3 cursor `del`'d while holding a pending statement
      keeps its table lock, and an unclosed `Connection` owes a
      `ResourceWarning`; in CPython both fire at the object's refcount-0, which
      Brython (tracing-GC, no prompt finalization) never reaches. The bridge
      implements `$B.$wasthon_gc_collect()` (wired to `support.gc_collect` /
      `gc.collect()`): a synchronous mark-sweep that MARKs the C instances
      reachable from the live Brython frames — locals + globals, recursing into
      containers and the **Symbol-keyed instance `__dict__`** (`self.cur` lives
      at `self[$B.DICT].cur`, invisible to `getOwnPropertyNames`), tracking the
      **max visit-depth per object** so one first reached shallow via the huge
      globals graph is re-walked deep from a frame local — then fires
      `tp_dealloc` on every gc-finalizable instance no longer reachable
      (`cursor_dealloc` → `stmt_reset` releases the lock; `connection_dealloc` →
      `tp_finalize` → `ResourceWarning`). This is the explicit `gc.collect()`
      contract, distinct from the automatic `FinalizationRegistry` path below:
      that one needs job boundaries (a synchronous run never yields for a
      finalizer callback) and only frees what the JS GC has *proven* dead,
      whereas this sweep must fire on demand, mid-job, from a heuristic mark —
      which is why it is clear-only for the conservative cases and gated to an
      opt-in set of
      resource-holding types (`$wasthon_gc_finalizable`: sqlite3's
      Connection/Cursor/Blob/Backup, and `_pickle`'s Pickler/Unpickler — their
      memo takes a ref per object pickled, released only at `tp_dealloc`, so a
      Brython-held pickler that never died pinned ~5 handles per object
      dumped) registered at `bindInstance` into a
      `gcRegistry`, so an empty registry returns instantly (zero cost to every
      other suite) and the mark skips the bridge's own strong-ref bookkeeping
      (`handles`/`gcRegistry`/`refcounts`, which pin every instance) and module
      graphs. `PyObject_CallFinalizerFromDealloc` now invokes `tp_finalize`
      (stashed on the class, past the 64-byte type struct) and a real
      `PyErr_ResourceWarning`/`PyExc_ResourceWarning` emit the warning. The
      same sweep also clears weak cells: `weakref.proxy`/`ref` on a C instance
      raise `ReferenceError` / return `None` once the referent is unreachable
      (or refcount-dead) — clear-only, never freeing on that path, and the
      mark skips the cells themselves so a live proxy cannot pin its referent.
      +3
      (`test_sqlite3` `test_table_lock_cursor_dealloc` /
      `test_table_lock_cursor_non_readonly_select` /
      `test_connection_resource_warning`). Details in `CHANGELOG.md`.
- [x] `del name` means CPython's `del`, and `gc.collect()` finally reaches the
      sweep above. Two gaps sat under the whole "GC that isn't one" chapter.
      First, Brython's `del name` called `__del__` **unconditionally** and
      *before* unbinding, so an object a container still held was finalized on
      the spot — measured in the port: `x.arf = t; del t` fired `t.__del__`
      where CPython stays silent. Second, Brython's `gc` module is a stub
      (`def collect(*a, **k): pass`), so the explicit sweep documented here was
      only ever reached through `test-cpython.html`'s `support.gc_collect`
      shim; a suite calling plain `gc.collect()` got a no-op.
      The bridge now answers `del` from **reachability out of the live Python
      frames** (`$wasthon_should_finalize`, two hook points in
      `$B.$delete` — the pattern `Lib/_weakref.py` already uses for
      `$wasthon_weakref_track`): still held → the object joins `pendingDel`,
      held strongly exactly as a refcount would hold it; unreachable → `__del__`
      runs now. `$wasthon_drain_pending` fires the deferred ones once they
      become unreachable (the cycle-collector half, called by `gc.collect()`),
      and `$wasthon_after_unbind` cascades when the deleted object *itself*
      just died — unreachable **and acyclic**, which is precisely how CPython
      separates "freed at once" from "left to the collector". A C instance's
      weak cells are cleared on its `del` when the bridge alone still holds it
      (refcount 1): `weakref.ref()` reads None and its callback fires,
      refcount-0 behaviour obtained **clear-only, without freeing a byte** —
      the bytes remain the bulk reclaim's job, and freeing here would re-open
      the failure mode that pass already measured.
      Why this is sound where the bulk reclaim is not: the question is not
      "which of 406 039 candidates are dead" but "is THIS one still held", on
      an **observed** event (the user wrote `del x`) rather than an inferred
      one. One object per answer buys iterative deepening (2, then 4, then 7)
      and an early exit at the first referrer — affordable here, ruinous there.
      And the predicate is one-sided by construction: *found* always defers, a
      miss only reproduces the old eager behaviour, so the `del` path can only
      become more conservative than it was.
      **+9 test_torch** (the `Tracker`/dealloc family: tensor and storage
      `dict_dealloc`, `slot_dealloc`, `weakref_dealloc`,
      `fix_weakref_no_leak`, `storage_dealloc`), and `gc.collect()` itself went
      **84 s → 0.0 s** once both walks stopped stepping into the DOM `window`
      that `from browser import window` leaves in the frame globals.
- [x] The walk can read the **C++ side**, and the root set became the instances
      it can actually reach. Until then this chapter ended on a limit: the rest
      of the family (`cycle_via_*`, `dead_weak_ref`, resurrection/zombie) hung
      on edges the Brython side cannot see — `z.grad = x` is an **accessor**
      into autograd metadata, not a stored property, and torch's own test says
      so out loud (*"C++ reference should keep the cycle live!"*).
      Three things had to give way, and each was a silent no-op rather than a
      hard problem. `Py_VISIT` was defined as `((void)(op))` — with a comment
      saying so — so every `tp_traverse` body in every C module compiled and
      reported nothing. A Python subclass of a C type gets a struct minted here
      with no traverse slot, where CPython inherits one, so `rt.cTraverse` walks
      `tp_base` until a type states its edges, exactly as `subtype_traverse`
      does. And torch's traverse deliberately **skips** `grad` (there is a NOTE
      about it) because CPython gets that liveness from the refcount, not from
      the collector — so tp_traverse alone could never answer the case the suite
      tests; the edge is read from the C++ state through an optional embedder
      helper, guarded like the census lookups next to it.
      Seeing the edges is only half of it, and on its own it measured **zero**:
      it made the deferred objects survive collection, then never let them die.
      The reason is the root set. The bilateral half took every instance in
      `rt.handles` — a map that holds each wrapper for its whole life, so an
      object whose last name was gone stayed a root forever. That blanket only
      ever existed **because the walk was blind to C++ edges**; with them
      visible, `_liveCRoots()` marks forward from the live frames, through the
      Brython graph and the C++ edges, and returns what it actually reaches —
      once per drain, where the old code paid a full walk per deferred object.
      Two refcount behaviours fall out of it: the `del` cascade no longer
      carries into a **cycle** (a refcount drops when the holder dies, but a
      cycle keeps it above zero and CPython defers to the collector), and `del`
      itself defers an unreachable-but-**cyclic** object instead of finalizing
      it on the spot. **+3 test_torch.**
      A third silent no-op of the same family sat one level down: reading the
      edges had been wired into the *root-set* paths only. The walks that answer
      the question itself — `_reach`'s forward scan out of the frames, and
      `_inCycle` — still looked at `$B.DICT` and own properties alone, and the
      two entry points that decide `del` call them with no root set, so a
      reference held by C++ was invisible to the predicate that mattered
      (`x._backward_hooks = y` goes through a torch setter, not into `__dict__`,
      and `del x` finalized x's tracker while `y` still pointed at it). Both
      walks now follow `cTraverse` on any value carrying an **own**
      `__wasthon_ptr__` — own-property, since a plain read resolves through the
      class and would fire the wasm call for everything walked. **+1 test_torch**
      at unchanged wall time.
      **The limit, stated plainly:** what remains is no longer about *seeing* or
      *deciding* but about *releasing*. `__del__` resurrection semantics are not
      implemented (the zombie/resurrected tests), and nothing drops the C++
      reference itself — a temporary view still pins its base
      (`_use_count` climbs 2 → 3 → 4 and neither `del` nor `gc.collect()` brings
      it back), which is why `test_swap_basic` fails and why `gc.get_objects()`
      has no honest answer to give: the objects really are still there.
      None of this touches the reclaim-scale question — deciding among hundreds
      of thousands of candidates at once is a different problem, and still open.
      Full dossier: brytorch `BUG_torch_dealloc_cluster.md`.
- [x] Container-boundary reference discipline + scope-owned `GET_ITEM` buffers
      — the three memory roots behind pickle's "delayed-writer page poison"
      (a 10k-object framed dump left ~300k pinned handles and a 1.6 GB heap,
      failing everything behind it), each a general bridge rule, all measured
      flat after the fix (a 10k-object dump+loads cycle now runs at the 16 MB
      boot baseline). (1) `PyDict_SetItem`/`PyObject_SetItem` no longer take
      CPython's "container ref" for plain Brython/JS values — the Brython
      container stores the JS value and never deallocs, so that ref was
      unreleasable; only struct-backed instances (`__wasthon_ptr__`) keep it,
      the instance-exempt rule `consumeResultRef` already used for steal APIs.
      (2) `_pickle.Pickler`/`Unpickler` joined the gc-finalizable set above.
      (3) `PyList_GET_ITEM` materialisations are cached per array and their
      buffers are owned by the handle scope of the C call that made them,
      freed at scope close like sentinels — the single-slot cache thrashed
      between `batch_list`'s outer list and each item's containers, O(n²)
      bytes. Also halved the pickle suite's wall time (449 s → 255 s).
      Details in `CHANGELOG.md`.
- [x] Wrapper-owned result reclamation — the *automatic* finalizer, which the
      entries above call impossible. They are right about a **synchronous run**
      and wrong about a **yielding one**, and that distinction is the whole
      design.

      The seam: CPython is refcounted, Brython is tracing-GC with **no
      refcount at all**. Every C-call result crosses that seam — the bridge
      allocates the instance at refcount 1 and hands the Brython wrapper back
      with ownership of that one reference (`consumeResultRef` exempts
      instances by design). CPython's eval loop would `POP_TOP` a discarded
      expression statement to zero; Brython simply drops the wrapper and
      **nothing crosses back**. There is no site to fix: the bridge cannot
      observe the drop, so the struct plus its `handles`/`refcounts` entries
      were pinned for the life of the job. One leaked instance per ufunc call.

      Correct, and asymptotically fatal: per-call cost grows with the live-set
      (the JS GC keeps tracing the pinned wrappers, and the never-freed structs
      fragment the wasm heap), measured **72 µs flat vs 287 µs after 60k
      leaked calls**. Nobody hit the knee until a suite ran ~10⁵–10⁶ ops inside
      one job (scipy's `test_cython_special`), where the tail slowed until the
      browser killed the script.

      Two mechanisms are *provably* unavailable. A synchronous mark-sweep from
      the live frames (the `gc.collect()` machinery above) is **racy** for
      transients: while Brython evaluates `abs(a-b) <= atol + rtol*abs(b)`, the
      `abs(a-b)` result is alive, refcount 1, and reachable from **neither** a
      frame local nor the entering call's arguments — a sweep would free it
      under the running expression. And refcount-1 does not mean dead, because
      Brython's `x = arr` never increfs. `WeakRef` polling is worse: the spec's
      *keptObjects* list pins every target of a `new WeakRef` / `.deref()`
      until the end of the job, so inside one synchronous run **nothing is ever
      collectible** (verified: 300k WeakRefs plus 1 GB of churn → zero
      collected). The first attempt demoted the `handles` entries to WeakRefs
      and was strictly dominated — same live-set, plus a deref on the hottest
      path in the bridge.

      What survives is the JS GC itself, which is the *only* oracle that can
      see a Brython drop — and it runs **between jobs**. So: at the outermost
      scope pop, an instance still at refcount 1 (C kept no reference) is
      **unbound** from `handles` and its wrapper registered in a
      `FinalizationRegistry` holding `{ptr, typeH}`. Nothing weak sits on the
      hot path: Python passing the wrapper back into C re-binds it through
      `wrap()` (the wrapper carries its own `__wasthon_ptr__`), and the
      dispatcher fast paths that read that pointer *without* calling `wrap()`
      recover through `unwrap()`'s miss path — a `demoted` `Map<ptr, WeakRef>`
      side table consulted only on a miss, so its keptObjects pinning lasts at
      most until the next boundary, which is exactly when collection could
      happen anyway. A mid-call `Py_INCREF` (refcount ≥ 2 — C taking durable
      ownership) simply prevents the demotion at pop; `PyObject_GC_Del`
      unregisters, or a late callback on a malloc-reused pointer would
      double-free. When the GC proves the wrapper dead the callback runs the
      type's `tp_dealloc` against a tombstone binding and frees the struct —
      a dead wrapper is *proof* of unreachability, which is what makes this
      sound where the mark-sweep heuristic is not.

      The other half of the contract is the driver: reclamation needs job
      boundaries, so a page must yield between units of work (`MessageChannel`,
      not `setTimeout` — nested timeouts clamp to 4 ms). This is why the
      feature is **opt-in** (`rt.reclaimResults`, default `false` = bit-for-bit
      the old behaviour). Unconditional reclamation breaks `import numpy`
      instantly: module-init code pervasively stores fresh refcount-1 instances
      C-side as borrowed references (statics, caches), and the whole ecosystem
      quietly *depends* on the leak for its correctness during init. The flag is
      flipped once imports have settled, when the steady-state per-call flood is
      the only thing worth reclaiming. With a per-case async runner the handle
      table stays flat and per-call cost stays at its ~72 µs floor:
      `test_cython_special` 167/54 → **221 passed / 0 failed** (was killed by
      the watchdog). Details in `CHANGELOG.md`.

      **2026-07-19 amendment — the oracle is real but mute.** Measured under
      Firefox (brytorch, 8 official pytorch suites in one page): the
      `FinalizationRegistry` callbacks simply never ran — not for demoted
      wrappers, not even for a sacrificial witness object dropped on the spot,
      through allocation pressure and multi-second idles. The proof-based path
      stays sound but fires at the engine's discretion, which can be *never*
      within a session; `demoted` then grows without bound (~100-400 MB of
      native tensors per suite, the 2 GB wasm ceiling by suite 8). The
      complement is `$B.$wasthon_reclaim_demoted()`: a **driver-invoked,
      between-batches** pass that substitutes the missing proof with a mark
      from every live frame *and every imported module's full graph* (depth 6
      — module-level data stays live, unlike the bounded in-test heuristic
      above). Candidates are the demoted, refcount-1 population only —
      everything C references is untouchable by the existing `_reclaimDead`
      guard, and between batches no expression is in flight, so the May
      objection (a mid-expression temporary reachable from neither frame nor
      arguments) does not arise. Dealloc dispatch resolves through the mro
      (`subtype_dealloc` semantics): a Python subclass of a C type carries a
      slot-less struct, the base owns `tp_dealloc` — without that walk the
      shell was freed but the native payload (torch's `TensorImpl`) leaked.
      Residual risk, stated plainly: a refcount-1 wrapper reachable *only*
      through a JS-side structure the scan cannot see would be reclaimed
      early; narrower exposure than the rejected global mark-sweep, and the
      21-suite sweep plus the brytorch full run show no such class. Measured:
      flat 133 MB across repeated 2000-tensor rounds (was +32-46 MB/round).

      **2026-07-22 amendment — the pass is now BILATERAL.** The 07-19 mark
      substituted the missing proof from one side only, and volume falsified
      it two ways (measured on brytorch): candidates whose types wire no
      dealloc slot (`torch.device` ×8378 per suite, `Size`, `finfo`) took a
      destructor-less `_free`, recycling structs under C-side borrowed
      pointers; and every demoted pybind11 instance's own real dealloc
      raises pybind11's `!types->empty()` registry assert (1 566/1 566 on
      one suite). The pass now demands evidence from **both** GC models
      before freeing: `{safe:true}` frees through a real `tp_dealloc` or
      not at all, skips tensors the C++ side still shares (TensorImpl
      `use_count > 1`, read through read-only census helpers the embedding
      module exports) and pybind11 instances wholesale, and frees
      collected wrappers through the type stamped at demotion
      (`demotedType`). `{dry:true}` runs the same walk as a pure census;
      `$B.$wasthon_census_live()` maps who owns the heap (bound vs
      demoted, storages deduped by StorageImpl). Instrument rule learned
      the hard way: `unwrap` of a demoted ptr RE-BINDS it, so every census
      call temp-binds by hand — a measurement must not mutate the bridge.
      Measured (brytorch 7-suite page, all green, corruption canary 0):
      page high-water 1390 vs 1870 MB, one suite pass returning 387 MB.

      **And the honest limit, measured the same day: the reachability half
      is not a proof, so the pass is NOT safe at scale.** Adding torch's
      own suite to that page (407 039 demoted candidates instead of ~34 000)
      frees 304 697 instances and returns 1165 MB — then the next suite
      collapses and later ones die on `bad Table get address` /
      `UnicodeDecodeError: invalid start byte`: the wasm function table and
      the linear heap are corrupted, i.e. live objects were freed. The
      census says why: the depth-6 mark from the frames plus the module
      graphs marks **998** objects live out of 407 039, having visited
      68 085 objects — its visit budget (400 000) was never even reached,
      so the depth bound alone accounts for it. "Not reached" means "not
      searched", not "dead". The C++ half
      cannot compensate: `use_count == 1` says the C++ side does not share
      the tensor, never that a Python variable stopped holding it. So the
      green 7-suite result above reflects a graph the bounded mark happens
      to cover — a property of those suites, not a safety property. The
      pass stays opt-in and off by default. The only sound proof of
      Python-side death here remains a collected wrapper, which Firefox
      does not deliver during a synchronous run (54 of 407 039), which is
      why the substitute existed in the first place. Making per-object
      reclamation sound needs a real refcount on the wrapper (the
      wasthonc / WasmGC pivot), not a better heuristic; for a driver that
      merely needs the memory back, throwing the whole context away
      (iframe isolation) proves nothing and therefore cannot be wrong.
- [ ] Explicit-contract residual — a C instance held by a Python local that is
      dropped or reassigned without a `close()`/`with` (and with no
      `gc.collect()` call, and on a page that does not opt into
      `reclaimResults` + yields) is never DECREF'd:
      Brython offers no scope-exit or GC callback into `wasthon_decref`, so its
      native context leaks. Four triggers now cover the common cases: the
      `close()`/`with` contract for every heavy native that exposes one
      (LZMA/Zstd/bz2 file wrappers; sqlite `Connection.close()` frees
      natively), the one-shot `compress()`/`decompress()` helper wrap for
      the create-use-drop transient with no `close()`, an explicit
      `gc.collect()` mark-sweep for unreachable resource-holding sqlite3 types,
      and — on a yielding page that opts in — the automatic
      `FinalizationRegistry` reclamation above, which covers the create-use-drop
      *result* flood the other three cannot see. The residual is what none of
      them reach: a bare compressor/`Connection` kept in a long-lived local and
      dropped on its own, on a page with no `gc.collect()` and no job boundaries
      — acceptable for light natives and a known cap on loop-bench depth for
      heavy ones, since a heavy native is exactly the case that *should* carry
      an explicit `close()`. (Instance /
      `refcounts` axis; distinct from the sentinel / `handles` leak below.)
- [x] JS-side handle-map (sentinel) leak — FIXED by **handle scopes** (the
      JNI local-reference / HPy model). Every JS→C entry point (method
      trampoline, slot dispatch, tp_new/tp_init/tp_call, getsets) pushes a
      scope; sentinel handles wrapped during the C call are released at
      return unless C took a reference — Py_INCREF promotes, new-reference
      APIs seed refcount 1 (`wrapNewRef`, the instance-era refcount-convention
      audit extended to sentinels), steal APIs consume. Module init stays
      unscoped (immortal, as before); a real intern pool backs
      `PyUnicode_InternFromString`/`_Py_ID` (lazy C statics). Proven by
      `loader/test-scopes.html` (`noScopeFree` A/B): `handles.size` grows
      **+0.00/call** across 2000 `pickle.dumps` of a rich graph vs
      **+105/call** without scopes. This was the dominant `pickle.dumps`
      byte-leak — and, it turned out, an invisible cap on the test suite
      itself: the map's internal resize blew up ("allocation size overflow")
      once enough state accumulated, making correct fixes measure as huge
      regressions. Landing scopes immediately unlocked +46 pickle passes.
      It also removes the main motivation for a WasmGC pivot (which is
      structurally closed to linear-memory C anyway — externref can't live
      in C structs).

Eventually:

- [x] NumPy-class numerical computing in Brython — **achieved, beyond the
      original formulation**. The plan written here was an [Array API
      Standard](https://data-apis.org/array-api/) implementation atop
      Wasthon's `array` foundation; what landed instead is **real NumPy
      2.5.1**: the actual C core (`_multiarray_umath`, ~150 files)
      compiled against the bridge, numpy's own Python layer served to
      Brython, `import numpy` completing (83 modules; `np.linalg` is the
      one honest stub — LAPACK isn't built for this target, those calls
      raise `NotImplementedError`). Validated by running **numpy's own
      test suite** in the browser (via a minimal pytest shim), and
      numpy.random's nine Cython extensions run with `MT19937.random_raw`
      **bit-exact vs upstream numpy 2.5.1**. No facade, no semantic
      drift — the same C that ships in the manylinux wheels. The
      bridge-side C-API growth this took (an 87-symbol link contract,
      vectorcall, the buffer protocol over `__array_interface__`, Cython
      cdef-class support) is merged on `main`; the build recipe, browser
      demo and test dashboard are being spun out as **NumBry** — *the
      NumPy stack in the browser with Wasthon* (numpy today; pandas and
      matplotlib are the mapped next walls). An Array API layer atop
      `array` could never have gotten there: pandas and matplotlib
      consume numpy's real C-API (`PyArray_*`, capsules, dtypes), not
      the Array API surface.
- [ ] [HPy](https://hpyproject.org/) support — the modern portable C-API.

## Acknowledgements

The crypto work rides on [HACL\*](https://project-everest.github.io/) —
formally verified C implementations bundled in CPython 3.13+. The zlib
build uses Emscripten's `madler/zlib` port. The compression trilogy bundles
[bzip2](https://sourceware.org/bzip2/) (Julian Seward),
[xz-utils](https://tukaani.org/xz/) (Lasse Collin and Igor Pavlov's LZMA),
and [zstd](https://facebook.github.io/zstd/) (Yann Collet, Meta). `_decimal`
embeds [libmpdec](https://www.bytereef.org/mpdecimal/) (Stefan Krah).
`pyexpat` rides on [libexpat](https://libexpat.github.io/) (James Clark
and successors).
`_sqlite3` bundles the [SQLite](https://www.sqlite.org/) amalgamation
(D. Richard Hipp; placed in the public domain).
Wasthon is mostly the plumbing that lets these libraries talk to Python
code translated to JavaScript by Brython, through a synthetic CPython
C-API implemented over the JavaScript runtime.

## License

Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>

BSD 3-Clause License — same as Brython. See `LICENSE` for the full text
and `THIRD_PARTY.md` for the upstream components and their licenses.
