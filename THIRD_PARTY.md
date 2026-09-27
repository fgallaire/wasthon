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

### Brython — BSD 3-Clause License

- `loader/brython/` — a vendored Brython build (stock release plus the
  fixes tracked in `BRYTHON_FIX.md`, pending upstream), the
  Python-to-JavaScript runtime the bridge plugs into. (C) Pierre Quentel and
  contributors. <https://brython.info/>

The C libraries compiled into CPython's standard-library modules (HACL\*,
libmpdec, libexpat, bzip2, liblzma, Zstandard, zlib, SQLite) are listed in
[Wastdlib](https://github.com/fgallaire/wastdlib)'s `THIRD_PARTY.md`.

## Build-time tooling (not redistributed)

- **Emscripten / emsdk** — University of Illinois/NCSA Open Source
  License and MIT. Used to compile C to WebAssembly (the bridge's unit tests,
  and every repository built on the bridge); not part of the wasthon
  distribution itself. <https://emscripten.org/>
