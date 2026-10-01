/* CPython 3.14's Include/internal/pycore_hashtable.h, without its
 * Py_BUILD_CORE guard; Python/hashtable.c is in wasthon.c. The JS-Map stub
 * it replaces keyed every table by the key read as a C string, whatever
 * the table's hash and compare functions. */
#ifndef Py_INTERNAL_HASHTABLE_H
#define Py_INTERNAL_HASHTABLE_H
#include "wasthon.h"
#ifdef __cplusplus
extern "C" {
#endif

#ifndef _Py_RVALUE
#  define _Py_RVALUE(EXPR) ((void)0, (EXPR))
#endif

/* Single linked list */

typedef struct _Py_slist_item_s {
    struct _Py_slist_item_s *next;
} _Py_slist_item_t;

typedef struct {
    _Py_slist_item_t *head;
} _Py_slist_t;

#define _Py_SLIST_ITEM_NEXT(ITEM) _Py_RVALUE(((_Py_slist_item_t *)(ITEM))->next)

#define _Py_SLIST_HEAD(SLIST) _Py_RVALUE(((_Py_slist_t *)(SLIST))->head)


/* _Py_hashtable: table entry */

typedef struct {
    /* used by _Py_hashtable_t.buckets to link entries */
    _Py_slist_item_t _Py_slist_item;

    Py_uhash_t key_hash;
    void *key;
    void *value;
} _Py_hashtable_entry_t;


/* _Py_hashtable: prototypes */

/* Forward declaration */
struct _Py_hashtable_t;
typedef struct _Py_hashtable_t _Py_hashtable_t;

typedef Py_uhash_t (*_Py_hashtable_hash_func) (const void *key);
typedef int (*_Py_hashtable_compare_func) (const void *key1, const void *key2);
typedef void (*_Py_hashtable_destroy_func) (void *key);
typedef _Py_hashtable_entry_t* (*_Py_hashtable_get_entry_func)(_Py_hashtable_t *ht,
                                                               const void *key);

typedef struct {
    // Allocate a memory block
    void* (*malloc) (size_t size);

    // Release a memory block
    void (*free) (void *ptr);
} _Py_hashtable_allocator_t;


/* _Py_hashtable: table */
struct _Py_hashtable_t {
    size_t nentries; // Total number of entries in the table
    size_t nbuckets;
    _Py_slist_t *buckets;

    _Py_hashtable_get_entry_func get_entry_func;
    _Py_hashtable_hash_func hash_func;
    _Py_hashtable_compare_func compare_func;
    _Py_hashtable_destroy_func key_destroy_func;
    _Py_hashtable_destroy_func value_destroy_func;
    _Py_hashtable_allocator_t alloc;
};

_Py_hashtable_t * _Py_hashtable_new(
    _Py_hashtable_hash_func hash_func,
    _Py_hashtable_compare_func compare_func);

/* Hash a pointer (void*) */
Py_uhash_t _Py_hashtable_hash_ptr(const void *key);

/* Comparison using memcmp() */
int _Py_hashtable_compare_direct(
    const void *key1,
    const void *key2);

_Py_hashtable_t * _Py_hashtable_new_full(
    _Py_hashtable_hash_func hash_func,
    _Py_hashtable_compare_func compare_func,
    _Py_hashtable_destroy_func key_destroy_func,
    _Py_hashtable_destroy_func value_destroy_func,
    _Py_hashtable_allocator_t *allocator);

void _Py_hashtable_destroy(_Py_hashtable_t *ht);

void _Py_hashtable_clear(_Py_hashtable_t *ht);

typedef int (*_Py_hashtable_foreach_func) (_Py_hashtable_t *ht,
                                           const void *key, const void *value,
                                           void *user_data);

/* Call func() on each entry of the hashtable.
   Iteration stops if func() result is non-zero, in this case it's the result
   of the call. Otherwise, the function returns 0. */
int _Py_hashtable_foreach(
    _Py_hashtable_t *ht,
    _Py_hashtable_foreach_func func,
    void *user_data);

size_t _Py_hashtable_size(const _Py_hashtable_t *ht);
size_t _Py_hashtable_len(const _Py_hashtable_t *ht);

/* Add a new entry to the hash. The key must not be present in the hash table.
   Return 0 on success, -1 on memory error. */
int _Py_hashtable_set(
    _Py_hashtable_t *ht,
    const void *key,
    void *value);


/* Get an entry.
   Return NULL if the key does not exist. */
static inline _Py_hashtable_entry_t *
_Py_hashtable_get_entry(_Py_hashtable_t *ht, const void *key)
{
    return ht->get_entry_func(ht, key);
}


/* Get value from an entry.
   Return NULL if the entry is not found.

   Use _Py_hashtable_get_entry() to distinguish entry value equal to NULL
   and entry not found. */
void* _Py_hashtable_get(_Py_hashtable_t *ht, const void *key);


/* Remove a key and its associated value without calling key and value destroy
   functions.

   Return the removed value if the key was found.
   Return NULL if the key was not found. */
void* _Py_hashtable_steal(
    _Py_hashtable_t *ht,
    const void *key);

Py_uhash_t _Py_HashBytes(const void *src, Py_ssize_t len);

#ifdef __cplusplus
}
#endif
#endif   /* !Py_INTERNAL_HASHTABLE_H */
