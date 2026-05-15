/* wasthon stub for CPython's pyconfig.h.
 * blake2module includes it for SIMD/word-size autodetection.
 * In WASM we have a fixed 32-bit address space, no SIMD by default,
 * and we don't need any of the autoconf-style HAVE_* macros. */
#ifndef WASTHON_PYCONFIG_H
#define WASTHON_PYCONFIG_H

/* WASM is little-endian. */
#define PY_LITTLE_ENDIAN  1
#define PY_BIG_ENDIAN     0

/* No native long-double support in WASM by default. */
#define HAVE_GCC_ASM_FOR_X64 0
#define HAVE_GCC_ASM_FOR_X87 0

/* No SIMD intrinsics. blake2module probes these. */
#define HAVE_LIBB2 0

/* Hash modulus parameters — _decimal computes its hash mod (2^N - 1)
 * where N matches CPython's _PyHASH_BITS. On 32-bit builds N = 31. */
#define _PyHASH_BITS  31
#define _PyHASH_MODULUS  ((Py_hash_t)((1UL << _PyHASH_BITS) - 1))

#endif
