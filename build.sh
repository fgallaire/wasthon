#!/usr/bin/env bash
#
# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# Build a wasthon module to .mjs/.wasm
#
# Usage: ./build.sh <command>
#   <module>    build a single module (e.g. _sha2, _zlib, pyexpat)
#   all         build every supported module (~45 s once libs are cached)
#   list        show the known module names
#
# emcc is installed automatically into ./external/emsdk/ on first run.
# Requires: curl or wget (to download sources) and make (used by emmake for xz/zstd).
# External source trees default to ./external/<libname> — override via env
# vars to point at an existing checkout:
#   CPYTHON_SRC=/path/to/Python-3.14.4
#   EXPAT_DIR=/path/to/expat-2.6.4
#   ZSTD_DIR=/path/to/zstd-1.5.6
#   XZ_DIR=/path/to/xz-5.4.6
#   BZIP2_DIR=/path/to/bzip2-1.0.8

set -euo pipefail

# Silence emcc's coloured output where supported (https://no-color.org).
# Emscripten's INFO logs ignore this and stay green; harmless, we accept.
export NO_COLOR=1

usage() {
    cat >&2 <<EOF
Usage: $0 <command>
  <module>    build a single module (e.g. _sha2, _zlib, pyexpat)
  all         build every supported module
  list        show the known module names
EOF
}

if [[ $# -lt 1 ]]; then
    usage
    exit 1
fi
MODULE="$1"

KNOWN_MODULES=(
    _md5 _sha1 _sha2 _sha3 _blake2 _hmac
    _zlib _bz2 _lzma _zstd
    _csv _json _struct _sre unicodedata pyexpat
    _decimal _random _statistics math cmath
    array
)

if [[ "${MODULE}" == "list" ]]; then
    cat <<'EOF'
Known wasthon modules (22):
  hashlib:     _md5  _sha1  _sha2  _sha3  _blake2  _hmac
  compression: _zlib  _bz2  _lzma  _zstd
  text/parse:  _csv  _json  _struct  _sre  unicodedata  pyexpat
  numerics:   _decimal  _random  _statistics  math  cmath
  containers: array
EOF
    exit 0
fi

# Validate up front so a typo doesn't trigger the heavy emsdk install.
if [[ "${MODULE}" != "all" ]]; then
    known=0
    for m in "${KNOWN_MODULES[@]}"; do
        [[ "$m" == "${MODULE}" ]] && known=1 && break
    done
    if [[ $known -eq 0 ]]; then
        echo "Unknown module: ${MODULE}" >&2
        echo "Run \`$0 list\` for the known module names." >&2
        exit 1
    fi
fi

REPO="$(cd "$(dirname "$0")" && pwd)"
BUILD="${REPO}/build"
SRC="${REPO}/src"
EXTERNAL="${REPO}/external"

CPYTHON_SRC="${CPYTHON_SRC:-${EXTERNAL}/Python-3.14.4}"
EXPAT_DIR="${EXPAT_DIR:-${EXTERNAL}/expat-2.6.4}"
ZSTD_DIR="${ZSTD_DIR:-${EXTERNAL}/zstd-1.5.6}"
XZ_DIR="${XZ_DIR:-${EXTERNAL}/xz-5.4.6}"
BZIP2_DIR="${BZIP2_DIR:-${EXTERNAL}/bzip2-1.0.8}"

mkdir -p "${BUILD}/clinic"
cd "${BUILD}"

# fetch <url> <out_path> — uses curl or wget, whichever is on PATH.
fetch() {
    local url="$1" out="$2"
    if command -v curl >/dev/null; then
        curl -fsSL -o "$out" "$url"
    elif command -v wget >/dev/null; then
        wget -q -O "$out" "$url"
    else
        echo "Need curl or wget on PATH to download $url" >&2
        exit 1
    fi
}

EMSDK_DIR="${EMSDK_DIR:-${EXTERNAL}/emsdk}"

# Pinned emscripten compiler version. Bumping this is intentional —
# all 23 module builds have been validated against this version.
EMSCRIPTEN_VERSION="5.0.7"

# Ensure emcc is on PATH for the rest of this script. If emsdk isn't
# installed yet, install it into external/emsdk/. Either way, source its
# environment so subsequent emcc invocations work in this same process —
# the user never has to touch their shell.
if ! command -v emcc >/dev/null; then
    if [[ ! -x "${EMSDK_DIR}/upstream/emscripten/emcc" ]]; then
        echo "=== installing emsdk ${EMSCRIPTEN_VERSION} into ${EMSDK_DIR} (one-time, ~300 MB) ===" >&2
        mkdir -p "${EXTERNAL}"
        # Pull the emsdk bootstrap as a tarball (no git dependency).
        # The emsdk script itself is just a wrapper; pinning emscripten
        # via install/activate <VER> is what makes the toolchain
        # reproducible across user machines.
        tmp="$(mktemp)"
        fetch "https://github.com/emscripten-core/emsdk/archive/refs/heads/main.tar.gz" "$tmp"
        mkdir -p "${EMSDK_DIR}"
        tar -xzf "$tmp" -C "${EMSDK_DIR}" --strip-components=1
        rm -f "$tmp"
        (cd "${EMSDK_DIR}" \
            && ./emsdk install "${EMSCRIPTEN_VERSION}" \
            && ./emsdk activate "${EMSCRIPTEN_VERSION}") >&2
    fi
    # emsdk_env.sh sets PATH/EMSDK/etc. We're a subshell of the caller,
    # so the changes apply for the rest of this script only — the user's
    # interactive shell stays untouched.
    # shellcheck disable=SC1091
    source "${EMSDK_DIR}/emsdk_env.sh" >/dev/null 2>&1
fi

# ensure_src <dir> <url> <strip_components>
# If <dir> does not exist, download the tarball and extract it. Place
# extracted tree at <dir>. <strip_components> is the number of leading
# path elements to strip (1 for tarballs like "foo-1.2/...").
ensure_src() {
    local dir="$1" url="$2" strip="${3:-1}"
    [[ -d "$dir" ]] && return 0
    echo "=== fetching $(basename "$dir") from $url ==="
    mkdir -p "$dir"
    local tmp; tmp="$(mktemp)"
    fetch "$url" "$tmp"
    case "$url" in
        *.tar.xz)  tar -xJf "$tmp" -C "$dir" --strip-components="$strip" ;;
        *.tar.gz|*.tgz)
                    tar -xzf "$tmp" -C "$dir" --strip-components="$strip" ;;
        *) echo "Unknown archive type for $url" >&2; exit 1 ;;
    esac
    rm -f "$tmp"
}

# Per-lib bootstrappers — download source tree if missing.
ensure_cpython()  { ensure_src "${CPYTHON_SRC}" \
    "https://www.python.org/ftp/python/3.14.4/Python-3.14.4.tar.xz"; }
ensure_bzip2()    { ensure_src "${BZIP2_DIR}" \
    "https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz"; }
ensure_expat() {
    ensure_src "${EXPAT_DIR}" \
        "https://github.com/libexpat/libexpat/releases/download/R_2_6_4/expat-2.6.4.tar.xz"
    # Compile the three xml*.c files into .o for direct linking with pyexpat.
    if [[ ! -f "${EXPAT_DIR}/lib/xmlparse.o" ]]; then
        echo "=== building libexpat objects with emcc ==="
        # Make sure expat_config.h exists (created by autoconf normally).
        if [[ ! -f "${EXPAT_DIR}/expat_config.h" ]]; then
            (cd "${EXPAT_DIR}" && emconfigure ./configure \
                --without-docbook --without-examples --without-tests \
                >/dev/null 2>&1)
        fi
        # Configure produces false positives on WASM for OS entropy
        # functions (arc4random_buf, getrandom, /dev/urandom — declared
        # accepts at compile-time, fails at link). Undef them so expat
        # falls back to its built-in pseudo-random hash salt (fine for
        # our use; XML hash salt is DoS-mitigation, not crypto).
        sed -i \
            -e 's|^#define HAVE_ARC4RANDOM_BUF .*|/* #undef HAVE_ARC4RANDOM_BUF */|' \
            -e 's|^#define HAVE_ARC4RANDOM .*|/* #undef HAVE_ARC4RANDOM */|' \
            -e 's|^#define HAVE_GETRANDOM .*|/* #undef HAVE_GETRANDOM */|' \
            -e 's|^#define HAVE_SYSCALL_GETRANDOM .*|/* #undef HAVE_SYSCALL_GETRANDOM */|' \
            -e 's|^#define XML_DEV_URANDOM .*|/* #undef XML_DEV_URANDOM */|' \
            "${EXPAT_DIR}/expat_config.h"
        for f in xmlparse xmlrole xmltok; do
            # -Wno-format: upstream uses an int format for ptrdiff_t in a
            # debug log statement; harmless on wasm32 (long is 32-bit).
            (cd "${EXPAT_DIR}/lib" && emcc -O3 -c \
                -DXML_POOR_ENTROPY=1 -Wno-format \
                -I . -I "${EXPAT_DIR}" "${f}.c" -o "${f}.o")
        done
    fi
}
ensure_xz() {
    ensure_src "${XZ_DIR}" \
        "https://github.com/tukaani-project/xz/releases/download/v5.4.6/xz-5.4.6.tar.xz"
    # Build liblzma.a if missing — autotools project, emconfigure handles it.
    if [[ ! -f "${XZ_DIR}/src/liblzma/.libs/liblzma.a" ]]; then
        echo "=== building liblzma with emcc ==="
        (cd "${XZ_DIR}" && emconfigure ./configure \
            --disable-shared --disable-xz --disable-xzdec --disable-lzmadec \
            --disable-lzmainfo --disable-lzma-links --disable-scripts \
            --disable-doc >/dev/null 2>&1 && emmake make >/dev/null 2>&1)
    fi
}
ensure_zstd() {
    ensure_src "${ZSTD_DIR}" \
        "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz"
    if [[ ! -f "${ZSTD_DIR}/lib/libzstd.a" ]]; then
        echo "=== building libzstd with emcc ==="
        (cd "${ZSTD_DIR}/lib" && emmake make libzstd.a >/dev/null 2>&1)
    fi
}

# Ensure wasthon.o is built and current with the latest wasthon.c/.h.
cp "${SRC}/wasthon.c" .
emcc -O3 -c -I . -I "${SRC}" wasthon.c -o wasthon.o

# Compile a module .c source from CPython's Modules/ into .o.
# Args: <src.c> <flags...>
compile_module_src() {
    local src="$1"; shift
    local base="$(basename "${src%.c}")"
    cp "$src" .
    emcc -O3 -c -I . -I "${SRC}" "$@" "$(basename "$src")" -o "${base}.o"
}

# Link a module: emcc -O2 <objects> --js-library wasthon.js + standard flags.
# Args: <output_name_without_ext> <PyInit_symbol> <export_js_name> <objects...>
link_module() {
    local out="$1" init="$2" export_name="$3"; shift 3
    emcc -O2 "$@" wasthon.o \
        --js-library "${SRC}/wasthon.js" \
        -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 \
        -s EXPORTED_FUNCTIONS="[\"_${init}\",\"_wasthon_init\",\"_wasthon_module_create\",\"_malloc\",\"_free\"]" \
        -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32","HEAPF32","HEAPF64","HEAP16","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
        -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME="${export_name}" \
        -o "${out}.mjs"
    echo "Built: ${out}.mjs + ${out}.wasm"
}

# Compile libmpdec from CPython's bundled sources into build/libmpdec/.
# Cached: skips files whose .o already exists.
build_libmpdec_objects() {
    local src="${CPYTHON_SRC}/Modules/_decimal/libmpdec"
    [[ -d "$src" ]] || { echo "libmpdec sources not found at $src" >&2; exit 1; }
    mkdir -p libmpdec
    for f in basearith constants context convolute crt difradix2 fnt fourstep \
             io mpalloc mpdecimal mpsignal numbertheory sixstep transpose; do
        if [[ ! -f "libmpdec/${f}.o" ]]; then
            cp "${src}/${f}.c" libmpdec/ 2>/dev/null || continue
            cp "${src}/${f}.h" libmpdec/ 2>/dev/null || true
            for h in basearith bits constants convolute crt difradix2 fnt \
                     fourstep io mpalloc mpdecimal numbertheory sixstep \
                     transpose typearith umodarith; do
                cp "${src}/${h}.h" libmpdec/ 2>/dev/null || true
            done
            (cd libmpdec && emcc -O3 -c -DCONFIG_32 -DANSI -I "${SRC}" "${f}.c" -o "${f}.o")
        fi
    done
}

# Compile bzip2 from upstream tarball into build/bzip2/.
build_bzip2_objects() {
    [[ -d "${BZIP2_DIR}" ]] || {
        echo "bzip2 sources not found at ${BZIP2_DIR}. Set BZIP2_DIR." >&2
        exit 1
    }
    mkdir -p bzip2
    for f in blocksort bzlib compress crctable decompress huffman randtable; do
        if [[ ! -f "bzip2/${f}.o" ]]; then
            cp "${BZIP2_DIR}/${f}.c" bzip2/
            cp "${BZIP2_DIR}/bzlib.h"          bzip2/ 2>/dev/null || true
            cp "${BZIP2_DIR}/bzlib_private.h"  bzip2/ 2>/dev/null || true
            (cd bzip2 && emcc -O3 -c "${f}.c" -o "${f}.o")
        fi
    done
}

# HACL crypto objects (shared by _md5, _sha1, _sha2, _sha3, _blake2, _hmac).
build_hacl_objects() {
    local hacl="${CPYTHON_SRC}/Modules/_hacl"
    for f in MD5 SHA1 SHA2 SHA3 Blake2b Blake2s; do
        if [[ ! -f "Hacl_Hash_${f}.o" ]]; then
            emcc -O3 -c -I "$hacl" -I "$hacl/include" -I "$hacl/internal" \
                "$hacl/Hacl_Hash_${f}.c" -o "Hacl_Hash_${f}.o"
        fi
    done
    if [[ ! -f "Lib_Memzero0.o" ]]; then
        # -Wno-#warnings: HACL emits a #warning that no safe memzero is
        # available on WASM. Harmless — we use HACL only for hashing, not
        # for clearing secrets from memory.
        emcc -O3 -c -Wno-\#warnings -I "$hacl" -I "$hacl/include" \
            -I "$hacl/internal" "$hacl/Lib_Memzero0.c" -o "Lib_Memzero0.o"
    fi
    if [[ ! -f "Hacl_HMAC.o" ]]; then
        emcc -O3 -c -I "$hacl" -I "$hacl/include" -I "$hacl/internal" \
            "$hacl/Hacl_HMAC.c" -o "Hacl_HMAC.o"
    fi
    if [[ ! -f "Hacl_Streaming_HMAC.o" ]]; then
        emcc -O3 -c -I "$hacl" -I "$hacl/include" -I "$hacl/internal" \
            "$hacl/Hacl_Streaming_HMAC.c" -o "Hacl_Streaming_HMAC.o"
    fi
}

# Sources for the HACL crypto family that link against the same HACL .o set.
hacl_module_src() {
    case "$1" in
        _md5)    echo "${CPYTHON_SRC}/Modules/md5module.c md5module Hacl_Hash_MD5.o" ;;
        _sha1)   echo "${CPYTHON_SRC}/Modules/sha1module.c sha1module Hacl_Hash_SHA1.o" ;;
        _sha2)   echo "${CPYTHON_SRC}/Modules/sha2module.c sha2module Hacl_Hash_SHA2.o" ;;
        _sha3)   echo "${CPYTHON_SRC}/Modules/sha3module.c sha3module Hacl_Hash_SHA3.o" ;;
        _blake2) echo "${CPYTHON_SRC}/Modules/blake2module.c blake2module Hacl_Hash_Blake2b.o Hacl_Hash_Blake2s.o Lib_Memzero0.o" ;;
    esac
}

# Path of an additional source file relative to CPython tree, copying clinic header if present.
copy_module_and_clinic() {
    local src="$1"
    local base="$(basename "${src%.c}")"
    cp "$src" .
    local clinic="${CPYTHON_SRC}/Modules/clinic/${base}.c.h"
    if [[ -f "$clinic" ]]; then
        mkdir -p clinic && cp "$clinic" clinic/
    fi
}

# Build every supported module. Re-runs are cheap because each per-module
# case re-uses already-built objects (HACL/libmpdec/bzip2 once cached).
if [[ "${MODULE}" == "all" ]]; then
    SELF="${REPO}/build.sh"
    for m in _md5 _sha1 _sha2 _sha3 _blake2 _hmac \
             _zlib _bz2 _lzma _zstd \
             pyexpat _decimal _sre \
             array _csv _json _struct _random _statistics \
             math cmath unicodedata; do
        echo "=== build ${m} ==="
        "${SELF}" "$m"
    done
    exit 0
fi

ensure_cpython   # every module needs CPython sources

case "${MODULE}" in

# --- HACL crypto family: same .o set, one source each --------------------
_md5|_sha1|_sha2|_sha3|_blake2)
    build_hacl_objects
    read -r src init hacl_objs <<<"$(hacl_module_src "${MODULE}")"
    # hacl_module_src returns "src init obj1 obj2 ..."
    set -- $(hacl_module_src "${MODULE}")
    src="$1"; init="$2"; shift 2; hacl_objs="$@"
    copy_module_and_clinic "$src"
    base="$(basename "${src%.c}")"
    emcc -O3 -c -I . -I "${SRC}" \
        -I "${CPYTHON_SRC}/Modules" \
        -I "${CPYTHON_SRC}/Modules/_hacl" \
        -I "${CPYTHON_SRC}/Modules/_hacl/include" \
        "$(basename "$src")" -o "${base}.o"
    link_module "${MODULE}" "PyInit_${MODULE}" "${MODULE#_}_init" \
        "${base}.o" $hacl_objs
    ;;

_hmac)
    build_hacl_objects
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/hmacmodule.c"
    emcc -O3 -c -I . -I "${SRC}" \
        -I "${CPYTHON_SRC}/Modules" \
        -I "${CPYTHON_SRC}/Modules/_hacl" \
        -I "${CPYTHON_SRC}/Modules/_hacl/include" \
        hmacmodule.c -o hmacmodule.o
    link_module "_hmac" "PyInit__hmac" "_hmac_init" \
        hmacmodule.o Hacl_HMAC.o Hacl_Streaming_HMAC.o \
        Hacl_Hash_MD5.o Hacl_Hash_SHA1.o Hacl_Hash_SHA2.o Hacl_Hash_SHA3.o \
        Hacl_Hash_Blake2b.o Hacl_Hash_Blake2s.o Lib_Memzero0.o
    ;;

# --- Compression family ----------------------------------------------------
_zlib)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/zlibmodule.c"
    # -sUSE_ZLIB=1 makes emscripten ship its bundled zlib port — supplies
    # both the header (zlib.h) at compile and the linked .a at link. On a
    # fresh emsdk the port is materialized on first use, then cached.
    emcc -O3 -c -sUSE_ZLIB=1 -I . -I "${SRC}" zlibmodule.c -o zlibmodule.o
    emcc -O2 zlibmodule.o wasthon.o \
        --js-library "${SRC}/wasthon.js" -sUSE_ZLIB=1 \
        -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 \
        -s EXPORTED_FUNCTIONS='["_PyInit_zlib","_wasthon_init","_wasthon_module_create","_malloc","_free"]' \
        -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32","HEAPF32","HEAPF64","HEAP16","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
        -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME='_zlib_init' \
        -o _zlib.mjs
    echo "Built: _zlib.mjs + _zlib.wasm"
    ;;

_bz2)
    ensure_bzip2
    build_bzip2_objects
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/_bz2module.c"
    emcc -O3 -c -I . -I "${SRC}" -I bzip2 _bz2module.c -o _bz2module.o
    link_module "_bz2" "PyInit__bz2" "_bz2_init" _bz2module.o bzip2/*.o
    ;;

_lzma)
    ensure_xz
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/_lzmamodule.c"
    emcc -O3 -c -I . -I "${SRC}" -I "${XZ_DIR}/src/liblzma/api" \
        _lzmamodule.c -o _lzmamodule.o
    link_module "_lzma" "PyInit__lzma" "_lzma_init" \
        _lzmamodule.o "${XZ_DIR}/src/liblzma/.libs/liblzma.a"
    ;;

_zstd)
    ensure_zstd
    for f in _zstdmodule.c compressor.c decompressor.c zstddict.c; do
        cp "${CPYTHON_SRC}/Modules/_zstd/$f" .
        local_clinic="${CPYTHON_SRC}/Modules/_zstd/clinic/${f%.c}.c.h"
        [[ -f "$local_clinic" ]] && cp "$local_clinic" clinic/
    done
    cp "${CPYTHON_SRC}/Modules/_zstd/_zstdmodule.h" .
    cp "${CPYTHON_SRC}/Modules/_zstd/zstddict.h" .
    cp "${CPYTHON_SRC}/Modules/_zstd/buffer.h" . 2>/dev/null || true
    # compressor.c / decompressor.c do `#include "internal/pycore_lock.h"`.
    # Materialize that path inside the (gitignored) build dir so we don't
    # have to keep a lonely src/internal/ committed just for one #include.
    mkdir -p internal
    cp "${SRC}/pycore_lock.h" internal/pycore_lock.h
    for src in _zstdmodule.c compressor.c decompressor.c zstddict.c; do
        emcc -O3 -c -I . -I "${SRC}" -I "${ZSTD_DIR}/lib" \
            "$src" -o "${src%.c}.o"
    done
    link_module "_zstd" "PyInit__zstd" "_zstd_init" \
        _zstdmodule.o compressor.o decompressor.o zstddict.o \
        "${ZSTD_DIR}/lib/libzstd.a"
    ;;

# --- pyexpat ---------------------------------------------------------------
pyexpat)
    ensure_expat
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/pyexpat.c"
    emcc -O3 -c -I . -I "${SRC}" -I "${EXPAT_DIR}" -I "${EXPAT_DIR}/lib" \
        pyexpat.c -o pyexpat.o
    link_module "pyexpat" "PyInit_pyexpat" "pyexpat_init" \
        pyexpat.o "${EXPAT_DIR}/lib/xmlparse.o" \
        "${EXPAT_DIR}/lib/xmlrole.o" "${EXPAT_DIR}/lib/xmltok.o"
    ;;

# --- _decimal: libmpdec under build/libmpdec/, built once ----------------
_decimal)
    build_libmpdec_objects
    cp "${CPYTHON_SRC}/Modules/_decimal/_decimal.c" .
    emcc -O3 -c -DCONFIG_32 -DANSI -I . -I "${SRC}" -I libmpdec \
        -I "${CPYTHON_SRC}/Modules/_decimal" \
        _decimal.c -o _decimal.o
    link_module "_decimal" "PyInit__decimal" "_decimal_init" \
        _decimal.o libmpdec/*.o
    ;;

# --- _sre: regex engine ---------------------------------------------------
_sre)
    cp "${CPYTHON_SRC}/Modules/_sre/sre.c" . 2>/dev/null || \
        cp "${CPYTHON_SRC}/Modules/_sre.c" .
    # _sre's clinic/headers can be tricky — keep simple and rely on whatever
    # is in the source tree's neighbouring files.
    emcc -O3 -c -I . -I "${SRC}" -I "${CPYTHON_SRC}/Modules/_sre" \
        -I "${CPYTHON_SRC}/Modules" sre.c -o sre.o
    link_module "_sre" "PyInit__sre" "_sre_init" sre.o
    ;;

# --- Pure single-source modules (no external lib) -------------------------
array)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/arraymodule.c"
    emcc -O3 -c -I . -I "${SRC}" arraymodule.c -o arraymodule.o
    link_module "array" "PyInit_array" "array_init" arraymodule.o
    ;;

_csv)
    cp "${CPYTHON_SRC}/Modules/_csv.c" .
    cp "${CPYTHON_SRC}/Modules/clinic/_csv.c.h" clinic/ 2>/dev/null || true
    emcc -O3 -c -I . -I "${SRC}" _csv.c -o _csv.o
    link_module "_csv" "PyInit__csv" "_csv_init" _csv.o
    ;;

_json)
    cp "${CPYTHON_SRC}/Modules/_json.c" .
    emcc -O3 -c -I . -I "${SRC}" _json.c -o _json.o
    link_module "_json" "PyInit__json" "_json_init" _json.o
    ;;

_struct)
    cp "${CPYTHON_SRC}/Modules/_struct.c" .
    cp "${CPYTHON_SRC}/Modules/clinic/_struct.c.h" clinic/ 2>/dev/null || true
    emcc -O3 -c -I . -I "${SRC}" _struct.c -o _struct.o
    link_module "_struct" "PyInit__struct" "_struct_init" _struct.o
    ;;

_random)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/_randommodule.c"
    emcc -O3 -c -I . -I "${SRC}" _randommodule.c -o _randommodule.o
    link_module "_random" "PyInit__random" "_random_init" _randommodule.o
    ;;

_statistics)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/_statisticsmodule.c"
    emcc -O3 -c -I . -I "${SRC}" _statisticsmodule.c -o _statisticsmodule.o
    link_module "_statistics" "PyInit__statistics" "_statistics_init" _statisticsmodule.o
    ;;

math)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/mathmodule.c"
    cp "${CPYTHON_SRC}/Modules/_math.h" .
    cp "${CPYTHON_SRC}/Modules/_math.c" . 2>/dev/null || true
    emcc -O3 -c -I . -I "${SRC}" mathmodule.c -o mathmodule.o
    link_module "math" "PyInit_math" "math_init" mathmodule.o
    ;;

cmath)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/cmathmodule.c"
    emcc -O3 -c -I . -I "${SRC}" cmathmodule.c -o cmathmodule.o
    link_module "cmath" "PyInit_cmath" "cmath_init" cmathmodule.o
    ;;

unicodedata)
    copy_module_and_clinic "${CPYTHON_SRC}/Modules/unicodedata.c"
    cp "${CPYTHON_SRC}/Modules/unicodedata_db.h" . 2>/dev/null || true
    cp "${CPYTHON_SRC}/Modules/unicodename_db.h" . 2>/dev/null || true
    # CPython's unicodectype.c provides the real _PyUnicode_To{Numeric,Digit,
    # Decimal,Lowercase,Uppercase} lookups (driven by the generated
    # unicodetype_db.h table). Compiled alongside so unicodedata.numeric()
    # works on Unicode fractions, CJK numerals, etc. — not just ASCII digits.
    cp "${CPYTHON_SRC}/Objects/unicodectype.c" .
    cp "${CPYTHON_SRC}/Objects/unicodetype_db.h" . 2>/dev/null || true
    emcc -O3 -c -I . -I "${SRC}" unicodedata.c    -o unicodedata.o
    emcc -O3 -c -I . -I "${SRC}" unicodectype.c   -o unicodectype.o
    link_module "_unicodedata" "PyInit_unicodedata" "_unicodedata_init" \
        unicodedata.o unicodectype.o
    ;;

# --- Unknown --------------------------------------------------------------
*)
    # Unreachable — KNOWN_MODULES pre-validation rejects unknown names.
    echo "Internal error: case missing for known module ${MODULE}" >&2
    exit 1
    ;;
esac
