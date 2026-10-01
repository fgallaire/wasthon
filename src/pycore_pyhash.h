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
    /* 16 bytes for XML_SetHashSalt16Bytes (expat >= 2.8), as CPython's
     * pycore_pyhash.h lays it out. */
    unsigned char hashsalt16[16];
    /* 4/8 bytes for legacy XML_SetHashSalt */
    unsigned long hashsalt;
} _Py_HashSecret_Expat_t;

typedef union {
    unsigned char uc[24];
    _Py_HashSecret_SipHash_t siphash;
    _Py_HashSecret_Expat_t expat;
} _Py_HashSecret_t;

extern _Py_HashSecret_t _Py_HashSecret;

// Similar to Py_HashPointer(), but don't replace -1 with -2.
static inline Py_hash_t
_Py_HashPointerRaw(const void *ptr)
{
    uintptr_t x = (uintptr_t)ptr;

    // Bottom 3 or 4 bits are likely to be 0; rotate x by 4 to the right
    // to avoid excessive hash collisions for dicts and sets.
    x = (x >> 4) | (x << (8 * sizeof(uintptr_t) - 4));

    return (Py_hash_t)x;
}

#ifdef __cplusplus
}
#endif
#endif
