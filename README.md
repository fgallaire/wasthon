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
| `pyexpat`      | XML parser (libexpat 2.6.4)                              | 169 KB      |
| `_json`        | JSON encoder/decoder C accelerator                       | 28 KB       |
| `math`         | int-heavy fns (factorial, gcd, isqrt, prod, …)           | 77 KB       |
| `cmath`        | complex math (sqrt/exp/log/sin/polar/rect/…)             | 51 KB       |
| `unicodedata`  | full Unicode 15.x database + normalization               | 669 KB      |
| `_statistics`  | `_normal_dist_inv_cdf` (Wichura AS241)                   | 15 KB       |
|                | **Total**                                                | **~2.7 MB** |

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

**`cmath`** (complex math) — smoke 8/8, bench is noisy across runs because
each iteration leaks a Brython complex wrapper into the bridge's handle
map (the no-`tp_dealloc` infra debt). Across reruns the directional
pattern is consistent: complex→complex ops (sqrt/exp/log/sin/cos) tend to
win **2-3.5×** while scalar-returning ops (`phase`, `polar`) lose. Won't
commit to exact speedup numbers until `tp_dealloc` lands; the noise floor
right now is ~50% on cmath bench results. Brython's bundled `cmath.py` is
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
that doesn't constantly call back into Python). The third is **"no static
PyTypeObject"** — modules that define their type with a 50-field static
struct initializer (like `_datetime`) are incompatible with our
multi-phase-init-based bridge.

## How it's built

The bridge is the leverage. It implements just enough of the public CPython
C-API to compile unmodified stdlib modules. From a `<x>module.c` in
CPython's `Modules/`, one `emcc` invocation produces an Emscripten ES6
module exposing `PyInit_<x>()`. A small Brython-side loader
(`loader/wasthon-loader.js`) instantiates it and registers it under
`__BRYTHON__.imported[<x>]` so `import <x>` from Python just works.

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
- **`loader/`** — `wasthon-loader.js` (Brython integration), `index.html`
  navigation page, 14 per-module smoke pages (`test-*.html`), 14 per-module
  bench pages (`bench-*.html`). Brython itself is loaded from a pinned CDN
  URL (`brython@3.14.1` on jsDelivr) — no local checkout needed.

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

The bridge today covers ~395 distinct C-API entry points. That's enough for
**22 stdlib modules**, all major type-creation patterns (factory functions,
tp_new-only, tp_new+tp_init, multi-phase exec slot), buffer protocol,
Unicode (PEP 393 strict, kind-aware), dict/list/tuple, IEEE 754, slot
dispatch including sequence and number protocols, getset descriptors
(static and dynamic via `PyDescr_NewGetSet`), METH_METHOD bound methods,
`Py_BuildValue` varargs, real `PyUnicode_FromFormat` (printf-style with
`%s`/`%d`/`%zd`/`%c`/`%p`/`%R`/`%S`/`%U`/`%x`/flags/width/precision —
fixes broken `repr()` on every stateful instance type),
full `PyUnicodeWriter` API (3.14), proper
`tp_setattro`/`tp_getattro` wiring, weak GIL stubs.

## Running it

Prerequisites:

- [Emscripten SDK](https://emscripten.org/) is installed automatically into
  `./external/emsdk/` on first build (pinned to 5.0.7); only `curl` or `wget`
  needs to be on PATH up front
- `make` (used by `emmake make` to build liblzma and libzstd)
- Python 3 (for `python3 -m http.server`)
- Brython itself is loaded from a pinned CDN URL by the loader pages — no
  local checkout needed

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
./build.sh _sha2          # any of the 22 known modules → build/_sha2.{mjs,wasm}
./build.sh _sha2 _decimal # several specific modules in one go
./build.sh all            # everything as per-module .mjs/.wasm
                          # (~45 s once libs are cached; first run downloads + builds the libs too)
./build.sh unified        # all 22 modules bundled into build/wasthon-unified.{mjs,wasm}
                          # — single fetch, single WASM instance, shared bridge runtime
```

The per-module target is best for dev, bench, and incremental work — each
module is fetched only if imported, and rebuilds are cheap. The unified
target is the "drop one script tag into your HTML" deliverable: one fetch,
one instance, but you pay for the full bundle even if you only use one
module. See `loader/test-unified.html` for a working unified-bundle page.

The script handles all the per-module quirks: downloading missing source
trees, compiling external libraries (libexpat, liblzma, libzstd, bzip2,
libmpdec, HACL\*), and the emcc `EXPORTED_FUNCTIONS`/`EXPORT_NAME` for each
target module.

Serve and test:

```bash
# from the wasthon directory
python3 -m http.server 8765
# open http://localhost:8765/loader/test-cascade.html
```

## What's next

Recent ports:

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
- [x] `cmath` — complex math. 8/8 smoke. Bench is too noisy across reruns
      to claim exact speedups (50%+ variance, occasional FAIL from
      handle-map pressure) — directionally: complex→complex ops win
      ~2-3.5×, scalar-returning ops lose. Will solidify once `tp_dealloc`
      lands. Exposed the emcc wasm32 ABI pattern for passing/returning
      small structs (Py_complex) by value via sret. Brython's own
      `cmath.py` is broken at import time — wasthon's is the first
      working complex math for Brython users regardless.
- [x] `_statistics` — `_normal_dist_inv_cdf` (Wichura AS241). 7/7 smoke.
      6/6 bench wins: 2.4× central, up to **6.3×** on the tail branches.
      Smallest port to date (15 KB wasm), single METH_FASTCALL function.
      Textbook validation of the work-density rule — one bridge crossing,
      ~30-50 flops inside C, never close to break-even.
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
- [x] Real `PyUnicode_FromFormat` (was a stub returning the format string
      literal). Implements emcc's `va_list` ABI for variadic args: reads
      sequentially from a pointer into linear memory with proper 4/8-byte
      alignment. Supports `%s`/`%d`/`%i`/`%u`/`%x`/`%X` (with `l`/`ll`/`z`
      length modifiers), `%c`, `%p`, `%R` (calls repr), `%S` (calls str),
      `%U`/`%V` (Unicode object), `%%`, plus flags (`-`, `0`), width and
      precision (including `%.*s` with precision-from-int). 9 modules
      benefit immediately: their `__repr__` now substitutes values
      instead of emitting `array.array('%c', %R)`-style literals.
- [x] Writable-bytes refactor: `PyBytes_FromStringAndSize(NULL, n)` now
      backs the bytes object directly with a malloc'd linear-memory
      buffer, so `PyBytes_AsString` returns its pointer without a second
      malloc+copy pass. Net: one fewer O(n) pass on the output path
      shared by all decompressors (`_zlib`/`_bz2`/`_lzma`/`_zstd`) and
      bytes-producing modules. Measured roughly doubled decompress
      throughput on `_lzma` and `_zstd` (e.g. 100 KB text: _lzma 3.0 →
      5.74 MB/s, _zstd 2.4 → 5.43 MB/s; _zstd 100 KB compress 5.1 →
      10.85 MB/s).
- [x] Top-level `build.sh <module>|all|list` script. Bootstraps emsdk into
      `external/emsdk/` if missing, downloads CPython + libexpat + libxz +
      libzstd + bzip2 sources via `curl`/`wget` on first run, compiles all
      the per-module quirks (which CPython sources, which external library
      objects, include paths, `EXPORTED_FUNCTIONS`, `EXPORT_NAME`). On a
      fresh checkout: `./build.sh all` goes from zero to 22 `.wasm` in
      a single command (~45 s once libs are cached).
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
- [ ] **Wire `_sre` into Brython's `re.py`.** Brython ships its own
      pure-Python regex code in `re.py`. Patch (or replace) `re.py` so it
      uses our `_sre` C module when available. More invasive than the XML
      case because Brython has an incumbent, not a gap.

Module candidates worth porting are largely exhausted at this point. What
remains in CPython's stdlib falls into one of three buckets:

- **Structurally impossible in browser** — `_socket`, `_ssl`, `_thread`,
  `_ctypes`, `_curses`, `mmap`, `select`, `_asyncio`, heavy `_io`,
  `_multiprocessing` (no OS), `_datetime`/`_types` (static `PyTypeObject`,
  banned by our bridge rules).
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

- [ ] Implement `tp_dealloc` dispatch — currently C-allocated instances
      never get freed when Python objects go out of scope, which limits
      bench loop depth for heavy modules (LZMA, Zstd compressors).

Eventually:

- [ ] [Array API Standard](https://data-apis.org/array-api/) implementation
      atop Wasthon's `array` foundation — NumPy-class numerical computing
      in Brython, the original distant goal of this project.
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
Wasthon is mostly the plumbing that lets these libraries talk to Python
code translated to JavaScript by Brython, through a synthetic CPython
C-API implemented over the JavaScript runtime.

## License

Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>

BSD 3-Clause License — same as Brython. See `LICENSE` for the full text
and `THIRD_PARTY.md` for the upstream components and their licenses.
