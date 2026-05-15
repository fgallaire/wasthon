/* Wasthon shim for CPython's pycore_pyhash.h.
 * pyexpat reads `_Py_HashSecret.expat.hashsalt` to mix expat-internal
 * randomization. We expose a fixed-seed secret struct — single-threaded
 * WASM has no thread safety concerns. */
#ifndef Py_INTERNAL_PYHASH_H
#define Py_INTERNAL_PYHASH_H
#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    unsigned char prefix[8];
    unsigned char suffix[8];
} _Py_HashSecret_SipHash_t;

typedef struct {
    unsigned char padding[16];
    unsigned long hashsalt;
} _Py_HashSecret_Expat_t;

typedef union {
    unsigned char uc[24];
    _Py_HashSecret_SipHash_t siphash;
    _Py_HashSecret_Expat_t expat;
} _Py_HashSecret_t;

extern _Py_HashSecret_t _Py_HashSecret;

#ifdef __cplusplus
}
#endif
#endif
