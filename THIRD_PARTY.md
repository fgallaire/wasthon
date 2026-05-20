# Third-party components

Wasthon redistributes, links, or otherwise depends on the following
third-party components, each governed by its own license. Their copyright
notices and licenses are preserved.

## Distributed in this repository (source form)

### CPython — Python Software Foundation License v2

Wasthon mirrors CPython's public C-API surface in its header files, and
includes two files copied (near-)verbatim from CPython:

- `src/pycore_blocks_output_buffer.h` — copied from CPython's
  `Include/internal/pycore_blocks_output_buffer.h`. Used by the compression
  modules (`_bz2`, `_lzma`, `_zlib`, `_zstd`) to manage dynamic output
  buffers during streaming.
- `src/pyexpat.h` — copied from CPython's `Include/pyexpat.h`. Defines the
  `PyExpat_CAPI` capsule struct exposed by `pyexpat` to other parser
  modules.
- `src/pythread.h` — copied from CPython's `Include/pythread.h`. Provides
  thread-state typedefs and primitives that `_sqlite3` references; the
  bridge supplies single-threaded WASM stubs for the operations.
- `src/structmember.h` — copied from CPython's `Include/structmember.h`.
  Provides the `PyMemberDef` type codes used by `_sqlite3` (and any
  module exposing C struct members as Python attributes).

`src/wasthon.h` re-declares many CPython public C-API function prototypes,
macros, and struct layouts. Function signatures and macro values are
factual (Wasthon is a bridge, not a re-implementation) and chosen to match
CPython's typeslots, member-type codes, and ABI exactly.

CPython is (C) 2001–present Python Software Foundation. The full PSF License
v2 text is available at <https://docs.python.org/3/license.html>.

## Redistributed in compiled form (linked into the `.wasm` outputs)

At build time, `build.sh` downloads and compiles the following libraries
to WebAssembly, embedding them in the per-module `.wasm` artifacts shipped
to Wasthon users:

- **HACL\*** — Apache License 2.0. Bundled with CPython; provides the
  verified C implementations of MD5, SHA-1, SHA-2, SHA-3, BLAKE2, and HMAC
  used by `_md5`, `_sha1`, `_sha2`, `_sha3`, `_blake2`, `_hmac`.
  <https://github.com/hacl-star/hacl-star>
- **libmpdec** — BSD 2-Clause License, (C) Stefan Krah. Bundled with
  CPython; provides the arbitrary-precision decimal arithmetic used by
  `_decimal`. <https://www.bytereef.org/mpdecimal/>
- **libexpat** — MIT/X License, (C) James Clark, Sebastian Pipping and
  contributors. Provides the XML parser used by `pyexpat`.
  <https://libexpat.github.io/>
- **bzip2 1.0.8** — BSD-style license, (C) Julian R. Seward. Provides the
  bzip2 (de)compression used by `_bz2`. <https://sourceware.org/bzip2/>
- **xz utils 5.4.6 (liblzma)** — mostly public domain (some files 0BSD),
  Lasse Collin and contributors. Provides LZMA/XZ (de)compression used by
  `_lzma`. <https://tukaani.org/xz/>
- **Zstandard 1.5.6** — BSD 3-Clause License, (C) Meta Platforms, Inc.
  Provides Zstandard (de)compression used by `_zstd`.
  <https://facebook.github.io/zstd/>
- **zlib** — zlib license, (C) Jean-loup Gailly and Mark Adler. Provided
  by the Emscripten port; used by `_zlib`. <https://zlib.net/>
- **SQLite 3.46.1** — public domain (the SQLite authors explicitly
  disclaim copyright via the SQLite "Blessing"). Provides the embedded
  SQL database engine used by `_sqlite3`. The amalgamation
  `sqlite-amalgamation-3460100.zip` is downloaded at build time.
  <https://www.sqlite.org/>

## Build-time tooling (not redistributed)

- **Emscripten / emsdk** — University of Illinois/NCSA Open Source
  License and MIT. Used to compile C to WebAssembly. Downloaded into
  `./external/emsdk/` on first build but not part of the wasthon
  distribution itself. <https://emscripten.org/>

## Runtime peer (loaded from CDN, not bundled)

- **Brython** — BSD 3-Clause License, (C) Pierre Quentel and contributors.
  The Python-to-JavaScript runtime that wasthon plugs into. Loaded by the
  loader pages from a pinned `cdn.jsdelivr.net` URL; not redistributed in
  this repository. <https://brython.info/>
