/* wasthon stub for pycore_hashtable.h. hmacmodule uses an internal
 * _Py_hashtable_t for mapping algo name → entry. We don't reimplement
 * the full data structure; the consumer code only ever does
 * size==0 paths in init and one create+set+get cycle. We provide a
 * minimal JS-object-backed hashtable that matches the API surface. */
#ifndef WASTHON_PYCORE_HASHTABLE_H
#define WASTHON_PYCORE_HASHTABLE_H
#include "wasthon.h"

typedef struct _Py_hashtable_t _Py_hashtable_t;
typedef struct {
    const void *key;
    void *value;
} _Py_hashtable_entry_t;

typedef Py_uhash_t (*_Py_hashtable_hash_func)(const void *key);
typedef int (*_Py_hashtable_compare_func)(const void *key1, const void *key2);
typedef void (*_Py_hashtable_destroy_func)(void *key);
typedef void *(*_Py_hashtable_get_entry_func)(_Py_hashtable_t *ht, const void *key);

typedef struct {
    void *(*malloc)(size_t size);
    void  (*free)(void *p);
} _Py_hashtable_allocator_t;

_Py_hashtable_t *_Py_hashtable_new_full(
    _Py_hashtable_hash_func hash_func,
    _Py_hashtable_compare_func compare_func,
    _Py_hashtable_destroy_func key_destroy_func,
    _Py_hashtable_destroy_func value_destroy_func,
    _Py_hashtable_allocator_t *allocator);

void _Py_hashtable_destroy(_Py_hashtable_t *ht);
int  _Py_hashtable_set(_Py_hashtable_t *ht, const void *key, void *value);
void *_Py_hashtable_get(_Py_hashtable_t *ht, const void *key);
_Py_hashtable_entry_t *_Py_hashtable_get_entry(_Py_hashtable_t *ht, const void *key);

Py_uhash_t _Py_HashBytes(const void *src, Py_ssize_t len);

#endif
