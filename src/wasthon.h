/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * wasthon.h — C-side header of Wasthon's C-to-Brython bridge.
 *
 * Provides just enough of CPython's `Python.h` to compile selected stdlib
 * extension modules against the Wasthon bridge, with PyObject* implemented
 * as opaque integer handles managed JS-side (Brython object world). The
 * JS-side implementation lives in wasthon.js; this header is the contract
 * between C extension code and the bridge.
 *
 * Many declarations, macros and struct layouts in this file mirror
 * CPython's public C-API by necessity — the bridge exists to receive
 * unmodified CPython source. Function names, slot IDs (Py_nb_multiply=29
 * etc.), member-type codes (Py_T_INT=1 etc.) and PyTypeObject field
 * positions are factual choices dictated by CPython's ABI; the
 * implementations behind them are entirely Wasthon's own (in wasthon.js).
 * CPython is (C) 2001-present Python Software Foundation, licensed under
 * the PSF License v2 — see THIRD_PARTY.md at the repository root.
 *
 * Hard rules (do not relax):
 *   1. Only what targeted modules actually call. Grow on demand.
 *   2. No Python runtime: no PyImport_*, no PyEval_*, no PyCode_*.
 *   3. No internal/private CPython API beyond what specific clinic-generated
 *      glue requires (currently just _PyArg_Parser / _PyArg_UnpackKeywords).
 *   4. PyObject* is opaque. C never inspects PyObject layout.
 *
 * Currently scoped for: sha2module.c (and its clinic glue). Other modules
 * (zlib, _sre, etc.) will extend this surface.
 */

#ifndef WASTHON_H
#define WASTHON_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <assert.h>
#include <string.h>  /* memcpy used by pycore_blocks_output_buffer.h */
#include <limits.h>  /* SHRT_MIN/MAX/INT_MAX etc. used by _struct */
#include <math.h>    /* copysign/fabs/etc. used by _decimal */
#include <wchar.h>   /* wchar_t — _decimal PyUnicode_FromWideChar */
#include <stdarg.h>  /* va_list — _datetime variadic helpers */
#include <time.h>    /* time_t, struct tm — _datetime wallclock */

/* PyThread types — single-threaded WASM, locks are no-ops. Some stdlib
 * modules (e.g. sha1) declare PyThread_type_lock fields directly without
 * pulling in pythread.h, so the type must be visible from Python.h. */
typedef struct { int _unused; } *PyThread_type_lock;

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------- *
 * Fundamental types                                                *
 * ---------------------------------------------------------------- */

/*
 * PyObject is opaque. The C code only ever holds and passes PyObject*.
 * The "pointer" is in fact a handle ID into a JS-side object map; the
 * bridge pretends it is a real pointer so that C semantics work normally.
 */
/* PyObject layout: ob_refcnt at offset 0, matching CPython ABI so that
 * PyObject_HEAD-prefixed instance structs and PyTypeObject all share a
 * refcount slot at the same offset. Phase 1 (2026-05-27): slot present
 * but never modified — Py_INCREF/Py_DECREF macros below stay no-op.
 * sizeof(PyObject) stays 4 bytes (same as the prior `int _opaque` shim),
 * so no struct grows unexpectedly. */
struct _object { intptr_t ob_refcnt; };
typedef struct _object PyObject;

typedef intptr_t Py_ssize_t;

/* PyTypeObject — must hold a real layout in linear memory because some
 * stdlib modules read fields directly:
 *   - sha3module dealloc:      tp->tp_free(self)         (unreachable in our bridge)
 *   - blake2module init exec:  st->bla2_type->tp_dict    (real read at module init)
 *   - zlibmodule new:          type->tp_alloc(type, 0)   (instance allocation)
 *
 * The bridge allocates one such struct per type registered via
 * PyType_FromModuleAndSpec; the type handle IS the struct's WASM pointer.
 * Instances created by PyObject_GC_New stash this same pointer in their
 * __wasthon_type__ slot, so Py_TYPE(self) returns it directly. */
struct PyMethodDef;

/* PyNumberMethods — number protocol slot table. Real CPython has many
 * more entries; we declare the subset _decimal reads
 * (PyLong_Type.tp_as_number->nb_multiply etc.) plus the in-place
 * variants so the offsets match a real-ish layout. Built-in singletons
 * (PyLong_Type, PyFloat_Type) get a populated instance at bridge init. */
typedef struct {
    PyObject *(*nb_add)(PyObject *, PyObject *);
    PyObject *(*nb_subtract)(PyObject *, PyObject *);
    PyObject *(*nb_multiply)(PyObject *, PyObject *);
    PyObject *(*nb_remainder)(PyObject *, PyObject *);
    PyObject *(*nb_divmod)(PyObject *, PyObject *);
    PyObject *(*nb_power)(PyObject *, PyObject *, PyObject *);
    PyObject *(*nb_negative)(PyObject *);
    PyObject *(*nb_positive)(PyObject *);
    PyObject *(*nb_absolute)(PyObject *);
    int       (*nb_bool)(PyObject *);
    PyObject *(*nb_invert)(PyObject *);
    PyObject *(*nb_lshift)(PyObject *, PyObject *);
    PyObject *(*nb_rshift)(PyObject *, PyObject *);
    PyObject *(*nb_and)(PyObject *, PyObject *);
    PyObject *(*nb_xor)(PyObject *, PyObject *);
    PyObject *(*nb_or)(PyObject *, PyObject *);
    PyObject *(*nb_int)(PyObject *);
    void     *nb_reserved;
    PyObject *(*nb_float)(PyObject *);
    PyObject *(*nb_inplace_add)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_subtract)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_multiply)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_remainder)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_power)(PyObject *, PyObject *, PyObject *);
    PyObject *(*nb_inplace_lshift)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_rshift)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_and)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_xor)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_or)(PyObject *, PyObject *);
    PyObject *(*nb_floor_divide)(PyObject *, PyObject *);
    PyObject *(*nb_true_divide)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_floor_divide)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_true_divide)(PyObject *, PyObject *);
    PyObject *(*nb_index)(PyObject *);
    PyObject *(*nb_matrix_multiply)(PyObject *, PyObject *);
    PyObject *(*nb_inplace_matrix_multiply)(PyObject *, PyObject *);
} PyNumberMethods;

struct _typeobject {
    /* ob_refcnt at offset 0 — Phase 1 ABI alignment with CPython. Matches
     * PyObject layout so `Py_INCREF(&PyDict_Type)` (and similar patterns
     * in CPython source code like `_pickle.c:5042`) would touch a real
     * refcount slot, not tp_free. Macros stay no-op in Phase 1; the slot
     * is present so subsequent phases can flip the macros without another
     * struct shift. */
    intptr_t ob_refcnt;                                           /* offset 0  */
    void     (*tp_free)(void *self);                              /* offset 4  */
    PyObject  *tp_dict;                                           /* offset 8  */
    const char *tp_name;                                          /* offset 12 */
    PyObject *(*tp_alloc)(struct _typeobject *type, Py_ssize_t nitems);  /* offset 16 */
    int       (*tp_init)(PyObject *self, PyObject *args, PyObject *kw);  /* offset 20 — CPython's initproc returns int (0 / -1) */
    PyObject *(*tp_iter)(PyObject *self);                         /* offset 24 */
    PyNumberMethods       *tp_as_number;                          /* offset 28 */
    struct PyMethodDef    *tp_methods;                            /* offset 32 */
    int       (*tp_traverse)(PyObject *self, int (*visit)(PyObject *, void *), void *arg);  /* offset 36 */
    void      (*tp_dealloc)(PyObject *self);                      /* offset 40 */
    int       (*tp_clear)(PyObject *self);                        /* offset 44 */
    unsigned int tp_version_tag;                                  /* offset 48 */
    PyObject *(*tp_repr)(PyObject *self);                         /* offset 52 */
    PyObject *(*tp_iternext)(PyObject *self);                     /* offset 56 */
    /* tp_new appended at the end so the historical offsets above don't
     * shift further. Never populated by the bridge (we don't support
     * Python-subclassing C types), so it stays NULL. */
    PyObject *(*tp_new)(struct _typeobject *type, PyObject *args,
                        PyObject *kw);                            /* offset 60 */
    /* --- fields appended for type-defining C modules (pygame). pygame uses
     * DESIGNATED initializers, so field order is irrelevant to correctness;
     * appended here so the historical offsets above (tp_dict@8 read by
     * blake2, etc.) don't shift. The bridge reads these at PyType_Ready.
     * Inline function-pointer types are used where the named typedef is
     * declared further down (e.g. Py_ssize_t stands in for Py_hash_t). */
    Py_ssize_t  tp_basicsize;
    Py_ssize_t  tp_itemsize;
    Py_ssize_t  tp_vectorcall_offset;
    PyObject   *(*tp_getattr)(PyObject *, char *);
    int         (*tp_setattr)(PyObject *, char *, PyObject *);
    void       *tp_as_async;
    struct PySequenceMethods *tp_as_sequence;
    struct PyMappingMethods  *tp_as_mapping;
    Py_ssize_t  (*tp_hash)(PyObject *);
    PyObject   *(*tp_call)(PyObject *, PyObject *, PyObject *);
    PyObject   *(*tp_str)(PyObject *);
    PyObject   *(*tp_getattro)(PyObject *, PyObject *);
    int         (*tp_setattro)(PyObject *, PyObject *, PyObject *);
    struct _wasthon_bufferprocs *tp_as_buffer;
    unsigned long tp_flags;
    const char *tp_doc;
    PyObject   *(*tp_richcompare)(PyObject *, PyObject *, int);
    Py_ssize_t  tp_weaklistoffset;
    struct PyGetSetDef *tp_getset;
    struct _typeobject *tp_base;
    PyObject   *tp_bases;
    PyObject   *tp_mro;
    PyObject   *(*tp_descr_get)(PyObject *, PyObject *, PyObject *);
    int         (*tp_descr_set)(PyObject *, PyObject *, PyObject *);
    Py_ssize_t  tp_dictoffset;
    struct PyMemberDef *tp_members;
    void        (*tp_finalize)(PyObject *);
    /* appended (numpy) — keep at the END: JS-side readers use the offsets
     * of the fields above */
    int         (*tp_is_gc)(PyObject *);
};
typedef struct _typeobject PyTypeObject;

/* PY_LITTLE_ENDIAN — wasm32 is little-endian. */
#ifndef PY_LITTLE_ENDIAN
#define PY_LITTLE_ENDIAN  1
#endif
#ifndef PY_BIG_ENDIAN
#define PY_BIG_ENDIAN     0
#endif

/* PyTupleObject layout — clinic glue (sha3, blake2…) does
 *     _PyTuple_CAST(args)->ob_item
 * to get the C array of PyObject*. Our bridge materializes a fresh
 * struct with `ob_item` populated in linear memory; see
 * wasthon_tuple_view in wasthon.js. The cast is hidden behind a macro. */
typedef struct {
    PyObject **ob_item;
    /* 3.14 tuple hash cache. Appended so ob_item's offset is stable (the
     * bridge's wasthon_tuple_view fills it). No caching here: writers
     * (torch Size resets it to -1) touch scratch; tp_hash recomputes. */
    Py_ssize_t ob_hash;
} PyTupleObject;
PyTupleObject *wasthon_tuple_view(PyObject *t);
#define _PyTuple_CAST(t) wasthon_tuple_view(t)

typedef Py_ssize_t Py_hash_t;
typedef uintptr_t Py_uhash_t;
typedef uint32_t Py_UCS4;
typedef uint16_t Py_UCS2;
typedef uint8_t  Py_UCS1;

/* ASCII char macros — wrap-correct for the 0-127 range _sre cares about. */
#define Py_ISDIGIT(c)   ((c) >= '0' && (c) <= '9')
#define Py_ISALPHA(c)   (((c) >= 'a' && (c) <= 'z') || ((c) >= 'A' && (c) <= 'Z'))
#define Py_ISALNUM(c)   (Py_ISDIGIT(c) || Py_ISALPHA(c))
#define Py_ISSPACE(c)   ((c) == ' ' || (c) == '\t' || (c) == '\n' || \
                         (c) == '\v' || (c) == '\f' || (c) == '\r')
#define Py_ISLOWER(c)   ((c) >= 'a' && (c) <= 'z')
#define Py_ISUPPER(c)   ((c) >= 'A' && (c) <= 'Z')
#define Py_ISXDIGIT(c)  (Py_ISDIGIT(c) || ((c) >= 'a' && (c) <= 'f') || ((c) >= 'A' && (c) <= 'F'))
#define Py_TOLOWER(c)   (Py_ISUPPER(c) ? (c) + 32 : (c))
#define Py_TOUPPER(c)   (Py_ISLOWER(c) ? (c) - 32 : (c))

/* Unicode char macros — for full Unicode support these need Unicode-database
 * lookups. We delegate to JS-side helpers that use the engine's built-in
 * String case-folding (correct for the vast majority of regex use cases). */
unsigned int wasthon_unicode_tolower(unsigned int ch);
unsigned int wasthon_unicode_toupper(unsigned int ch);
int          wasthon_unicode_isalpha(unsigned int ch);
int          wasthon_unicode_isdigit(unsigned int ch);
int          wasthon_unicode_isalnum(unsigned int ch);
int          wasthon_unicode_isspace(unsigned int ch);
int          wasthon_unicode_isdecimal(unsigned int ch);
int          wasthon_unicode_islinebreak(unsigned int ch);
#define Py_UNICODE_TOLOWER(c)     wasthon_unicode_tolower(c)
#define Py_UNICODE_TOUPPER(c)     wasthon_unicode_toupper(c)
/* Py_UNICODE_IS{ALPHA,DIGIT,ALNUM,SPACE,DECIMAL} are defined once, in the
 * UCS4 unicodectype block further down (_PyUnicode_Is*). */
#define Py_UNICODE_ISLINEBREAK(c) wasthon_unicode_islinebreak(c)
#define Py_UNICODE_IS_SURROGATE(c) (0xD800 <= (Py_UCS4)(c) && (Py_UCS4)(c) <= 0xDFFF)
int       PyUnicode_WriteChar(PyObject *unicode, Py_ssize_t index, Py_UCS4 character);
PyObject *PyUnicode_DecodeLocale(const char *str, const char *errors);

/* The real CPython lookups from Objects/unicodectype.c — linked into the
 * unicodedata module's build. The previous JS-side stubs used parseFloat
 * which only handles ASCII digits; this fixes fractions (½), CJK numerals,
 * Roman numerals, circled digits, etc. */
int    _PyUnicode_ToDecimalDigit(Py_UCS4 ch);
int    _PyUnicode_ToDigit(Py_UCS4 ch);
double _PyUnicode_ToNumeric(Py_UCS4 ch);
#define Py_UNICODE_TODECIMAL(c)  _PyUnicode_ToDecimalDigit(c)
#define Py_UNICODE_TODIGIT(c)    _PyUnicode_ToDigit(c)
#define Py_UNICODE_TONUMERIC(c)  _PyUnicode_ToNumeric(c)

/* Read codepoint at index — equivalent to PyUnicode_READ(KIND, DATA, i). */
Py_UCS4 PyUnicode_READ_CHAR(PyObject *unicode, Py_ssize_t index);

int PyModule_Check(PyObject *o);

/* Capsule API for C interop. unicodedata uses PyCapsule to expose its
 * name<->codepoint table via the `ucnhash_CAPI` attribute. */
PyObject *PyCapsule_New(void *pointer, const char *name, void (*destructor)(PyObject *));
void     *PyCapsule_GetPointer(PyObject *capsule, const char *name);
const char *PyCapsule_GetName(PyObject *capsule);
int       PyCapsule_SetPointer(PyObject *capsule, void *pointer);

#define Py_RETURN_TRUE   do { return Py_True; } while (0)
#define Py_RETURN_FALSE  do { return Py_False; } while (0)
#define PyMem_NEW(type, n)  ((type *)PyMem_Malloc((n) * sizeof(type)))

int PyOS_snprintf(char *str, size_t size, const char *format, ...);
int PyOS_strnicmp(const char *s1, const char *s2, size_t n);

/* unicodedata's capsule name (used to expose name<->codepoint API). */
#define PyUnicodeData_CAPSULE_NAME "unicodedata.ucnhash_CAPI"

/* PyUnicode utility — additions for unicodedata. */
int        PyUnicode_Compare(PyObject *a, PyObject *b);
int        PyUnicode_CompareWithASCIIString(PyObject *a, const char *b);
PyObject  *PyUnicode_FromObject(PyObject *obj);
int        PyUnicode_IS_ASCII(PyObject *o);
void       PyUnicode_WRITE(int kind, void *data, Py_ssize_t i, Py_UCS4 ch);
/* The macro form for use in tight loops */
#define PyUnicode_WRITE(kind, data, i, ch) do { \
    if ((kind) == 4) ((Py_UCS4 *)(data))[i] = (ch); \
    else if ((kind) == 2) ((Py_UCS2 *)(data))[i] = (ch); \
    else ((Py_UCS1 *)(data))[i] = (ch); \
} while (0)

/*
 * PyObject_HEAD / PyObject_VAR_HEAD: Phase 1 ABI alignment with CPython.
 *
 * Every module struct that uses these macros gets ob_refcnt at offset 0,
 * matching CPython's PyObject layout. This means Py_INCREF / Py_DECREF on
 * such structs would touch a real refcount slot, not arbitrary leading
 * data. Phase 1 keeps the refcount macros no-op (defined below); the
 * field exists so future phases can enable real refcounting without
 * another struct shift.
 *
 * ob_type (CPython's second field in PyObject) is intentionally omitted —
 * the bridge resolves Py_TYPE() through the JS handle table, never via
 * a struct read. Same for PyObject_VAR_HEAD: we mirror ob_refcnt + ob_size
 * but drop ob_type. Total prefix: 4 bytes (HEAD) or 8 bytes (VAR_HEAD).
 *
 * Modules using these macros must be recompiled when this layout changes.
 */
#define PyObject_HEAD       intptr_t ob_refcnt;
/* PyObject_VAR_HEAD: variable-size objects (array, bytes-like). Modules
 * accessing ob_size via Py_SIZE / Py_SET_SIZE go through the bridge JS
 * helper; direct `((PyVarObject*)x)->ob_size` reads/writes work because
 * the struct field exists in linear memory at offset 4. */
#define PyObject_VAR_HEAD   intptr_t ob_refcnt; Py_ssize_t ob_size;

/* ---------------------------------------------------------------- *
 * Refcounting & object-lifetime macros                             *
 *                                                                  *
 * Refcount lives on the JS side in WasthonRT.refcounts (a Map      *
 * keyed by C-allocated instance pointers). Sentinel handles and    *
 * any other value not in the Map are silent no-ops, so the macros  *
 * are safe to call on anything without a value-range guard.        *
 *                                                                  *
 * Macros NULL-guard before calling wasthon_incref / wasthon_decref *
 * to avoid the JS-bridge cost on the common NULL path.             *
 * ---------------------------------------------------------------- */

extern void wasthon_incref(PyObject *op);
extern void wasthon_decref(PyObject *op);

/* These evaluate `op` exactly once — like CPython's static-inline Py_NewRef.
 * A multiple-evaluation macro is unsafe here because some bridge "lvalue"
 * accessors are non-idempotent: PyList_GET_ITEM expands to
 * wasthon_list_items(list)[i], which re-materialises the list with FRESH
 * handles on every call. `self->literal = Py_NewRef(PyList_GET_ITEM(t, 0))`
 * would then INCREF one fresh handle but STORE a different one (never
 * ref-counted → released → reads back None). _sre's TemplateObject hit this:
 * every group-ref re.sub() template lost its literal. */
static inline void      _wasthon_Xincref(PyObject *op) { if (op) wasthon_incref(op); }
static inline void      _wasthon_Xdecref(PyObject *op) { if (op) wasthon_decref(op); }
static inline PyObject *_wasthon_newref(PyObject *op)  { if (op) wasthon_incref(op); return op; }

#define Py_INCREF(op)       _wasthon_Xincref((PyObject *)(op))
#define Py_DECREF(op)       _wasthon_Xdecref((PyObject *)(op))
#define Py_XINCREF(op)      Py_INCREF(op)
#define Py_XDECREF(op)      Py_DECREF(op)

#define Py_NewRef(op)       _wasthon_newref((PyObject *)(op))
#define Py_XNewRef(op)      Py_NewRef(op)

#define Py_CLEAR(op) do { \
    PyObject *_py_tmp = (PyObject *)(op); \
    if (_py_tmp) { (op) = NULL; wasthon_decref(_py_tmp); } \
} while (0)

#define Py_SETREF(op, op2) do { \
    PyObject *_py_old = (PyObject *)(op); \
    (op) = (op2); \
    if (_py_old) wasthon_decref(_py_old); \
} while (0)
#define Py_XSETREF(op, op2) Py_SETREF(op, op2)

/* Py_VISIT — for tp_traverse cycle walking. No-op until a cycle GC
 * is wired; tp_traverse bodies still compile, their `visit` and `arg`
 * parameters just go unused. */
#define Py_VISIT(op)        ((void)(op))

/* GC tracking macros: no-ops, JS GC handles it */
#define PyObject_GC_Track(op)    ((void)(op))
#define PyObject_GC_UnTrack(op)  ((void)(op))

/* Allocators: PyObject_GC_New(<type>, typeobj) → casts the result of
 * the JS-side wasthon_object_gc_new(typeobj) to a (type *).
 * The basicsize is read from the typeobj's metadata, not the C macro. */
PyObject *wasthon_object_gc_new(PyTypeObject *typeobj);
PyObject *wasthon_object_gc_new_var(PyTypeObject *typeobj, Py_ssize_t n);
void      PyObject_GC_Del(void *op);

#define PyObject_GC_New(type, typeobj)        ((type *)wasthon_object_gc_new(typeobj))
#define PyObject_GC_NewVar(type, typeobj, n)  ((type *)wasthon_object_gc_new_var(typeobj, n))

/* ---------------------------------------------------------------- *
 * Type/instance check macros                                       *
 * ---------------------------------------------------------------- */

PyTypeObject *_wasthon_Py_TYPE(PyObject *op);
int _wasthon_Py_IS_TYPE(PyObject *op, PyTypeObject *t);
/* Live-class identity for TYPE handles vs a builtin (1=str, 2=bytes):
 * `typ == &PyUnicode_Type` C compares miss because wrap(str) is not the
 * extern struct. Used by the numpy recipe's descriptor.c patch. */
int __wasthon_type_is_builtin(PyObject *typ, int tag);

#define Py_TYPE(op)         (_wasthon_Py_TYPE((PyObject*)(op)))
/* Exact-type, like CPython: an object's class must BE `t`, not a subclass.
 * Py_TYPE() returns a subclass instance's parent handle (so the subtype walk
 * in PyObject_TypeCheck still works), so a raw pointer compare here would be
 * loose; _wasthon_Py_IS_TYPE compares the live Brython classes instead. */
#define Py_IS_TYPE(op, t)   (_wasthon_Py_IS_TYPE((PyObject*)(op), (PyTypeObject*)(t)))

/* ---------------------------------------------------------------- *
 * Mutex (single-threaded WASM: all no-ops)                         *
 * ---------------------------------------------------------------- */

typedef struct { uint8_t _unused; } PyMutex;
#define PyMutex_Lock(m)     ((void)(m))
#define PyMutex_Unlock(m)   ((void)(m))
/* Used inside assert() calls in _zstd's compressor/decompressor to check
 * the per-instance lock state. Single-threaded WASM, so always 1. */
#define PyMutex_IsLocked(m) 1

/* GIL macros — also no-ops in single-threaded WASM */
#define Py_BEGIN_ALLOW_THREADS   /* empty */
#define Py_END_ALLOW_THREADS     /* empty */

/* Internal atomics — plain accesses in single-threaded WASM. CPython
 * 3.14.5+ modules call a few of these directly (free-threading safety
 * backports, e.g. _bz2module.c needs_input). */
#define _Py_atomic_store_char_relaxed(P, V)  (*(P) = (V))
#define _Py_atomic_load_char_relaxed(P)      (*(P))

/* ---------------------------------------------------------------- *
 * Type flags and method flags                                      *
 * ---------------------------------------------------------------- */

#define Py_TPFLAGS_DEFAULT                  (1UL << 0)
#define Py_TPFLAGS_BASETYPE                 (1UL << 1)
#define Py_TPFLAGS_HAVE_GC                  (1UL << 2)
#define Py_TPFLAGS_DISALLOW_INSTANTIATION   (1UL << 3)
#define Py_TPFLAGS_IMMUTABLETYPE            (1UL << 4)
#define Py_TPFLAGS_HEAPTYPE                 (1UL << 5)
#define Py_TPFLAGS_READY                    (1UL << 6)
#define Py_TPFLAGS_SEQUENCE                 (1UL << 5)  /* shared with HEAPTYPE — unused by bridge */
#define Py_TPFLAGS_LIST_SUBCLASS            (1UL << 25)
#define Py_TPFLAGS_TUPLE_SUBCLASS           (1UL << 26)
#define Py_TPFLAGS_BYTES_SUBCLASS           (1UL << 27)
#define Py_TPFLAGS_UNICODE_SUBCLASS         (1UL << 28)
#define Py_TPFLAGS_DICT_SUBCLASS            (1UL << 29)
#define Py_TPFLAGS_LONG_SUBCLASS            (1UL << 24)

#define METH_VARARGS    0x0001
#define METH_KEYWORDS   0x0002
#define METH_NOARGS     0x0004
#define METH_O          0x0008
#define METH_FASTCALL   0x0080
#define METH_CLASS      0x0010
#define METH_STATIC     0x0020
#define METH_METHOD     0x0200

/* tp_traverse callback signature */
typedef int (*visitproc)(PyObject *, void *);
typedef int (*traverseproc)(PyObject *, visitproc, void *);

/* PyMember type codes — sha2module uses Py_T_INT, Py_T_PYSSIZET,
   Py_T_BOOL via Py_READONLY. zlibmodule adds Py_T_OBJECT_EX. */
#define Py_T_INT        1
#define Py_T_PYSSIZET   2
#define Py_T_BOOL       3
#define Py_T_OBJECT_EX  4
#define Py_T_STRING     5
#define Py_T_UINT       6
#define Py_T_LONG       7
#define Py_T_ULONG      8
#define Py_T_SHORT      9
#define Py_T_USHORT    10
#define Py_T_BYTE      11
#define Py_T_UBYTE     12
#define Py_T_DOUBLE    13
#define Py_T_FLOAT     14
#define Py_T_CHAR      15
#define Py_T_LONGLONG  16
#define Py_T_ULONGLONG 17
#define _Py_T_OBJECT    Py_T_OBJECT_EX  /* internal alias */
#define Py_READONLY     0x0001

/* ---------------------------------------------------------------- *
 * Generic helpers                                                  *
 * ---------------------------------------------------------------- */

#define Py_UNUSED(x)        x##_unused
#define Py_ARRAY_LENGTH(a)  (sizeof(a) / sizeof((a)[0]))
#define Py_MIN(a, b)        ((a) < (b) ? (a) : (b))
#define Py_STRINGIFY(x)     #x

/* Py_UNREACHABLE — taken in dead branches; trap loudly if hit at runtime. */
#include <stdio.h>
#define Py_UNREACHABLE() do { \
    fprintf(stderr, "wasthon: Py_UNREACHABLE at %s:%d\n", __FILE__, __LINE__); \
    abort(); \
} while (0)

/* Cast macro used in clinic METH_FASTCALL bindings. */
#define _PyCFunction_CAST(f) ((PyCFunction)(void(*)(void))(f))

/* ---------------------------------------------------------------- *
 * Function/method descriptor structs                               *
 * ---------------------------------------------------------------- */

typedef PyObject *(*PyCFunction)(PyObject *self, PyObject *args);
typedef PyObject *(*PyCFunctionFast)(PyObject *self, PyObject *const *args, Py_ssize_t nargs);
typedef PyObject *(*PyCFunctionFastWithKeywords)(PyObject *self, PyObject *const *args,
                                                 Py_ssize_t nargs, PyObject *kwnames);

typedef struct PyMethodDef {
    const char *ml_name;
    /* PyCFunction, as in CPython: C++ TUs (pybind11, torch) initialize this
     * with function pointers, which C++ won't implicitly convert to void*.
     * Same layout (one pointer); the JS bridge reads it by offset. */
    PyCFunction ml_meth;
    int         ml_flags;
    const char *ml_doc;
} PyMethodDef;

/* pybind11 builds every exposed function through PyCFunction_NewEx. */
PyObject *PyCFunction_NewEx(PyMethodDef *ml, PyObject *self, PyObject *module);

typedef PyObject *(*getter)(PyObject *, void *);
typedef int (*setter)(PyObject *, PyObject *, void *);

/* Slot function-pointer typedefs (used by modules that cache method
 * pointers, e.g. _decimal caches PyLong arithmetic ops). */
typedef PyObject *(*unaryfunc)(PyObject *);
typedef PyObject *(*binaryfunc)(PyObject *, PyObject *);
typedef PyObject *(*ternaryfunc)(PyObject *, PyObject *, PyObject *);

#ifndef Py_LOCAL_INLINE
#define Py_LOCAL_INLINE(type) static inline type
#endif

typedef struct PyGetSetDef {
    const char *name;
    getter get;
    setter set;
    const char *doc;
    void *closure;
} PyGetSetDef;

typedef struct PyMemberDef {
    const char *name;
    int type;
    Py_ssize_t offset;
    int flags;
    const char *doc;
} PyMemberDef;

/* ---------------------------------------------------------------- *
 * Type-object protocol surface — for C modules that DEFINE types    *
 * (pygame's Rect/Surface/Color…). cimgui only exposed functions so  *
 * a thin bridge sufficed; a type needs the slot typedefs + protocol *
 * tables below. These let such modules COMPILE; the bridge wires the *
 * populated slots to the engine at PyType_Ready / FromSpec time.     *
 * ---------------------------------------------------------------- */
typedef PyObject *(*reprfunc)(PyObject *);
typedef PyObject *(*getiterfunc)(PyObject *);
typedef PyObject *(*richcmpfunc)(PyObject *, PyObject *, int);
typedef Py_hash_t (*hashfunc)(PyObject *);
typedef PyObject *(*newfunc)(PyTypeObject *, PyObject *, PyObject *);
typedef void       (*freefunc)(void *);
typedef PyObject *(*getattrfunc)(PyObject *, char *);
typedef int        (*setattrfunc)(PyObject *, char *, PyObject *);
typedef PyObject *(*getattrofunc)(PyObject *, PyObject *);
typedef int        (*setattrofunc)(PyObject *, PyObject *, PyObject *);
typedef PyObject *(*descrgetfunc)(PyObject *, PyObject *, PyObject *);
typedef int        (*descrsetfunc)(PyObject *, PyObject *, PyObject *);
typedef int        (*inquiry)(PyObject *);
typedef Py_ssize_t (*lenfunc)(PyObject *);
typedef PyObject *(*ssizeargfunc)(PyObject *, Py_ssize_t);
typedef int        (*ssizeobjargproc)(PyObject *, Py_ssize_t, PyObject *);
typedef int        (*objobjproc)(PyObject *, PyObject *);
typedef int        (*objobjargproc)(PyObject *, PyObject *, PyObject *);
typedef PyObject *(*vectorcallfunc)(PyObject *, PyObject *const *, size_t,
                                    PyObject *);

#ifndef Py_intptr_t
typedef intptr_t  Py_intptr_t;
typedef uintptr_t Py_uintptr_t;
#endif

/* sequence / mapping / async protocol tables — tagged so the tp_as_* pointer
 * fields in _typeobject (above) can forward-reference them. */
typedef struct PySequenceMethods {
    lenfunc sq_length;
    binaryfunc sq_concat;
    ssizeargfunc sq_repeat;
    ssizeargfunc sq_item;
    void *was_reserved_slice;          /* py2 sq_slice — kept for shape */
    ssizeobjargproc sq_ass_item;
    void *was_reserved_ass_slice;
    objobjproc sq_contains;
    binaryfunc sq_inplace_concat;
    ssizeargfunc sq_inplace_repeat;
} PySequenceMethods;

typedef struct PyMappingMethods {
    lenfunc mp_length;
    binaryfunc mp_subscript;
    objobjargproc mp_ass_subscript;
} PyMappingMethods;

typedef struct PyAsyncMethods {
    unaryfunc am_await;
    unaryfunc am_aiter;
    unaryfunc am_anext;
    void *am_send;
} PyAsyncMethods;

/* buffer-protocol table — body defined after Py_buffer (needs its type);
 * forward the typedef so tp_as_buffer can be a pointer. */
typedef struct _wasthon_bufferprocs PyBufferProcs;

/* ---------------------------------------------------------------- *
 * Type-spec API (PyType_FromModuleAndSpec)                         *
 * ---------------------------------------------------------------- */

typedef struct {
    int slot;
    void *pfunc;
} PyType_Slot;

typedef struct {
    const char *name;
    int basicsize;
    int itemsize;
    unsigned int flags;
    PyType_Slot *slots;
} PyType_Spec;

/* tp_* slot identifiers (subset used by sha2module: tp_dealloc, tp_methods,
   tp_getset, tp_traverse, tp_new). Real CPython uses many more — only
   declared as we need them. */
#define Py_tp_dealloc       52
#define Py_tp_methods       64
#define Py_tp_getset        66
#define Py_tp_traverse      71
#define Py_tp_new           65
#define Py_tp_init          61
#define Py_tp_finalize      80
#define Py_tp_str           50
#define Py_tp_repr          51
#define Py_tp_clear         54
#define Py_tp_doc           56
#define Py_tp_alloc         44
#define Py_tp_free          63
#define Py_tp_members       72
#define Py_tp_hash          58
#define Py_tp_richcompare   60
#define Py_mp_subscript     27
#define Py_mp_length        25
#define Py_mp_ass_subscript 26
#define Py_sq_length        29
#define Py_sq_item          32
/* Additional sequence + buffer slots used by arraymodule. Numbering picks
 * unused values in our internal scheme — modules see these values at compile
 * time, the bridge slot-installer reads them at register time. */
#define Py_sq_ass_item        39
#define Py_sq_concat          40
#define Py_sq_contains        41
#define Py_sq_inplace_concat  42
#define Py_sq_inplace_repeat  43
#define Py_sq_repeat          46
#define Py_bf_getbuffer        1
#define Py_bf_releasebuffer    2
#define Py_tp_getattro      57
#define Py_tp_setattro      59
#define Py_tp_iter          62
#define Py_tp_iternext      63

/* Number-protocol slot IDs used by _decimal's arithmetic plug-in.
 * Values from CPython's Include/typeslots.h (CPython 3.14 canonical
 * — _decimal references the values directly). */
#define Py_nb_add           7
#define Py_nb_subtract      36
#define Py_nb_multiply      29
#define Py_nb_remainder     34
#define Py_nb_divmod        10
#define Py_nb_power         33
#define Py_nb_negative      30
#define Py_nb_positive      32
#define Py_nb_absolute      6
#define Py_nb_bool          9
#define Py_nb_int           26
#define Py_nb_float         11
#define Py_nb_floor_divide  12
#define Py_nb_true_divide   37
#define Py_nb_index         13

/* Type-token slot — type identity that survives module reloads.
 * Py_TP_USE_SPEC = NULL means "use the spec address as the token".
 * In our bridge, every PyType_FromModuleAndSpec call already stashes
 * specPtr on the class (cls.__wasthon_type_token__); seeing this slot
 * is a no-op confirmation. */
#define Py_tp_token         83
#define Py_TP_USE_SPEC      ((void *)0)

#define Py_CLEANUP_SUPPORTED  0x20000

/* PyArg_Parse — older-style cleaner; _struct uses for cleanup callback. */
int PyArg_Parse(PyObject *args, const char *fmt, ...);

/* Dict — remaining pieces used by _struct. */
int        PyDict_Clear(PyObject *dict);
int        PyDict_GetItemRef(PyObject *dict, PyObject *key, PyObject **result);

/* Generic setattr counterpart. */
int       PyObject_GenericSetAttr(PyObject *o, PyObject *name, PyObject *value);

/* PyObject_TypeCheck — exact match or subtype, like CPython's
 * (Py_IS_TYPE(ob, type) || PyType_IsSubtype(Py_TYPE(ob), type)).
 * Exact-only "worked" while subclass instances carried their parent's
 * type handle; once Py_TYPE became faithful for subclasses, the
 * sqlite3 cursor/row factory guards needed the real subtype walk. */
#define PyObject_TypeCheck(op, t) \
    (Py_TYPE(op) == (t) || PyType_IsSubtype(Py_TYPE(op), (t)))

/* _PyObject_SIZE — tp_basicsize, reported in CPython-canonical units.
 * The basicsize lives JS-side (the 64-byte C type struct has no
 * tp_basicsize field), and wasthon's PyObject header has no ob_type
 * pointer (the type lives JS-side too), so the compiled struct is one
 * pointer smaller than CPython's layout for the same object; the JS
 * helper adds that pointer back so array.__sizeof__ / _struct.__sizeof__
 * report CPython's numbers. */
extern Py_ssize_t wasthon_basicsize(PyObject *type);
#define _PyObject_SIZE(type)  (wasthon_basicsize((PyObject *)(type)))

/* Py_SAFE_DOWNCAST — checked narrowing cast. We don't actually verify. */
#define Py_SAFE_DOWNCAST(value, from_t, to_t)  ((to_t)(value))

/* Type-slot accessor. */
void *PyType_GetSlot(PyTypeObject *type, int slot);

/* _PyOnceFlag (typedef declared near the bottom) — single-threaded WASM,
 * runs the init function exactly once. */
typedef int _PyOnceFlag;
int _PyOnceFlag_CallOnce(_PyOnceFlag *flag, int (*func)(void *), void *arg);

/* tp_alloc / tp_iter function-pointer typedefs. */
typedef PyObject *(*allocfunc)(PyTypeObject *, Py_ssize_t);

/* Default tp_alloc and tp_iter sentinels. */
PyObject *PyType_GenericAlloc(PyTypeObject *type, Py_ssize_t nitems);
PyObject *PyObject_GenericGetAttr(PyObject *o, PyObject *name);
PyObject *PyObject_SelfIter(PyObject *o);

/* Bytearray API. */
int        PyByteArray_Check(PyObject *o);
int        PyByteArray_CheckExact(PyObject *o);
char      *PyByteArray_AsString(PyObject *o);
Py_ssize_t PyByteArray_Size(PyObject *o);
PyObject  *PyByteArray_FromStringAndSize(const char *s, Py_ssize_t len);
#define PyByteArray_AS_STRING(o)  PyByteArray_AsString((PyObject *)(o))
#define PyByteArray_GET_SIZE(o)   PyByteArray_Size((PyObject *)(o))

/* Set / frozenset constructors. NULL iterable means empty. */
PyObject *PySet_New(PyObject *iterable);
PyObject *PyFrozenSet_New(PyObject *iterable);
int       PySet_Check(PyObject *o);
/* The bridge PySet_Check already accepts set and frozenset. */
#define PyAnySet_Check PySet_Check
PyObject *PyObject_Dir(PyObject *o);
/* _PySet_Update(set, iterable) — add every element of `iterable` into
 * `set`. Returns 0 on success, -1 on error. Used by pickle to restore
 * set values via the SET opcodes. */
int       _PySet_Update(PyObject *set, PyObject *iterable);
/* Py_CHARMASK — mask a value to 8 bits (treat as unsigned char). */
#define Py_CHARMASK(c)  ((unsigned char)((c) & 0xff))

/* Bytes literal escape decode (`\xNN`, `\n`, `\t`, …). pickle protocol 0
 * uses this for the SHORT_BINSTRING / SHORT_BINBYTES paths. `errors`,
 * `unicode`, `recode_encoding` are CPython-API legacy args; the bridge
 * ignores them and decodes in strict bytes mode (what pickle needs). */
PyObject *PyBytes_DecodeEscape(const char *s, Py_ssize_t len,
                               const char *errors, Py_ssize_t unicode,
                               const char *recode_encoding);

/* String → double parser with explicit overflow exception class. Used by
 * pickle protocol 0 float opcode. `*endptr` (if non-NULL) gets the parse-
 * end pointer; on overflow PyErr is set with `overflow_exc`. */
double PyOS_string_to_double(const char *s, char **endptr, PyObject *overflow_exc);

/* Unicode decoders used by pickle protocol 0. */
PyObject *PyUnicode_DecodeRawUnicodeEscape(const char *s, Py_ssize_t size,
                                           const char *errors);
PyObject *PyUnicode_FromEncodedObject(PyObject *obj, const char *encoding,
                                      const char *errors);

/* sys.getsizeof shim. The bridge has no per-object size tracking, so this
 * is a constant-0 stub — pickle uses it only for an output buffer
 * preallocation hint; returning 0 just skips the optimization. */
size_t _PySys_GetSizeOf(PyObject *o);

/* Misc — used by _struct. */
PyObject *PyUnicode_AsASCIIString(PyObject *unicode);
const char *_PyType_Name(PyTypeObject *type);

/* Py_GenericAlias — `__class_getitem__` of generic types. sre puts it
 * in PyMethodDef[] which requires a compile-time constant initializer.
 * We use NULL (the method is exposed but unimplemented; calling it from
 * Python raises). */
#define Py_GenericAlias  ((void *)0)

/* _PyArg_BadArgument — clinic glue uses this for type-mismatch errors. */
int _PyArg_BadArgument(const char *fname, const char *displayname,
                       const char *expected, PyObject *arg);

/* ---------------------------------------------------------------- *
 * Module-spec API                                                  *
 * ---------------------------------------------------------------- */

typedef int (*PyModuleDef_Slot_Func)(PyObject *);

typedef struct PyModuleDef_Slot {
    int slot;
    void *value;
} PyModuleDef_Slot;
typedef PyModuleDef_Slot PyModuleDef_Slot_Entry;  /* legacy alias */

/* Some modules use `.m_base = PyModuleDef_HEAD_INIT`, others omit it.
 * Both must compile. We name the placeholder field `m_base` to match. */
typedef struct PyModuleDef {
    PyObject *m_base;              /* PyModuleDef_HEAD_INIT placeholder */
    const char *m_name;
    const char *m_doc;
    Py_ssize_t m_size;
    PyMethodDef *m_methods;
    PyModuleDef_Slot *m_slots;
    traverseproc m_traverse;
    /* typed (not void*): C++ TUs (torch) initialize these with function
     * pointers, which C++ won't implicitly convert to void*. */
    inquiry m_clear;
    freefunc m_free;
} PyModuleDef;

#define PyModuleDef_HEAD_INIT  NULL
#define Py_mod_exec                   1
#define Py_mod_create                 2
#define Py_mod_multiple_interpreters  3
#define Py_mod_gil                    4

/* Values for Py_mod_multiple_interpreters slot */
#define Py_MOD_MULTIPLE_INTERPRETERS_NOT_SUPPORTED   ((void *)0)
#define Py_MOD_MULTIPLE_INTERPRETERS_SUPPORTED       ((void *)1)
#define Py_MOD_PER_INTERPRETER_GIL_SUPPORTED         ((void *)2)

/* Values for Py_mod_gil slot */
#define Py_MOD_GIL_USED      ((void *)0)
#define Py_MOD_GIL_NOT_USED  ((void *)1)

/* PyMODINIT_FUNC: in real CPython, marks the symbol as exported. With
   Emscripten we use EMSCRIPTEN_KEEPALIVE on the init function instead.
   C++ extensions (Cython cplus, pybind11) need the C linkage CPython's
   definition carries, or the PyInit_* wasm export comes out mangled. */
#ifdef __cplusplus
#define PyMODINIT_FUNC extern "C" PyObject *
#else
#define PyMODINIT_FUNC PyObject *
#endif

/* ---------------------------------------------------------------- *
 * Built-in type singletons. Declared as struct values (not          *
 * pointers) to match upstream CPython: source code expects e.g.    *
 *   PyTuple_Type.tp_iter(t)        (struct-member access)           *
 *   PyObject_CallObject((PyObject*)&PyTuple_Type, args)             *
 * The bridge allocates the struct storage in wasthon.c and populates  *
 * relevant slots at init (currently tp_iter for iteration). Each   *
 * singleton's address is registered with the JS-side handle table  *
 * so that &PyXxx_Type unwraps to the corresponding Brython class.  *
 * ---------------------------------------------------------------- */

extern PyTypeObject PyType_Type;
extern PyTypeObject PyTuple_Type;
extern PyTypeObject PyDict_Type;
extern PyTypeObject PyList_Type;
extern PyTypeObject PyLong_Type;
extern PyTypeObject PyFloat_Type;
extern PyTypeObject PyUnicode_Type;
extern PyTypeObject PyBytes_Type;
extern PyTypeObject PyBool_Type;

/* ---------------------------------------------------------------- *
 * Exception class references (extern, populated by bridge init)      *
 * ---------------------------------------------------------------- */

extern PyObject *PyExc_TypeError;
extern PyObject *PyExc_ValueError;
extern PyObject *PyExc_OverflowError;
extern PyObject *PyExc_RuntimeError;
extern PyObject *PyExc_MemoryError;
extern PyObject *PyExc_SystemError;
extern PyObject *PyExc_IndexError;
extern PyObject *PyExc_RecursionError;
extern PyObject *PyExc_EOFError;
extern PyObject *PyExc_StopIteration;

extern PyObject *Py_None;
extern PyObject *Py_True;
extern PyObject *Py_False;
extern PyObject *Py_NotImplemented;
#define Py_RETURN_NOTIMPLEMENTED  do { return Py_NewRef(Py_NotImplemented); } while (0)
/* Identity checks against the singletons — pure pointer comparison. */
#define Py_IsNone(x)   ((x) == Py_None)
#define Py_IsTrue(x)   ((x) == Py_True)
#define Py_IsFalse(x)  ((x) == Py_False)

/* ---------------------------------------------------------------- *
 * Forward declarations of functions implemented in JS via imports. *
 * Each is tagged with the tier from the analysis (1 = trivial,     *
 * 9 = buffer protocol, 10 = arg parsing).                          *
 * ---------------------------------------------------------------- */

/* Object construction/access */
PyObject *PyBytes_FromStringAndSize(const char *str, Py_ssize_t size);
PyObject *PyUnicode_FromStringAndSize(const char *u, Py_ssize_t size);
PyObject *PyUnicode_FromString(const char *u);
PyObject *PyLong_FromLong(long v);
PyObject *PyLong_FromUInt32(uint32_t v);
PyObject *PyLong_FromUnsignedLong(unsigned long v);
PyObject *PyLong_FromSsize_t(Py_ssize_t v);
PyObject *PyLong_FromVoidPtr(void *p);
PyObject *PyBool_FromLong(long v);
PyObject *PyFloat_FromDouble(double v);
double    PyFloat_AsDouble(PyObject *o);

/* PyTime API — used by _random for seeding from current time. */
typedef int64_t PyTime_t;
int  PyTime_Time(PyTime_t *result);
int  PyTime_Monotonic(PyTime_t *result);

/* List API used by output-buffer helpers and clinic glue.
 *
 * PyListObject is a typedef alias of PyObject in Wasthon — Brython lists
 * don't have a separate C struct, they're plain JS arrays accessed by
 * handle. C-API casts like `(PyListObject *)op` become no-ops. Modules
 * that read `list->ob_item[i]` (heapq) must be patched to use the
 * `_PyList_ITEMS(list)` macro (defined in pycore_list.h). */
typedef PyObject PyListObject;
typedef PyObject PyBytesObject;  /* opaque alias for clinic-generated bytes args */
PyObject  *PyList_New(Py_ssize_t size);
int        PyList_Append(PyObject *list, PyObject *item);
int        PyList_Insert(PyObject *list, Py_ssize_t index, PyObject *item);
PyObject  *PyList_GetItem(PyObject *list, Py_ssize_t i);
int        PyList_SetItem(PyObject *list, Py_ssize_t i, PyObject *item);
int        PyList_SetSlice(PyObject *list, Py_ssize_t low, Py_ssize_t high, PyObject *itemlist);
Py_ssize_t PyList_Size(PyObject *list);
int        PyList_Sort(PyObject *list);

/* Items-array materialisation (parallels _PyTuple_CAST/wasthon_tuple_view).
 * Allocates a fresh PyObject*[N] in linear memory and returns it; used by
 * sre.c's `&PyList_GET_ITEM(list, 0)` to get an addressable array. */
PyObject **wasthon_list_items(PyObject *list);

/* Tuple API. */
PyObject  *PyTuple_New(Py_ssize_t size);
int        PyTuple_SetItem(PyObject *tup, Py_ssize_t i, PyObject *item);
PyObject  *PyTuple_GetItem(PyObject *tup, Py_ssize_t i);
PyObject  *PyTuple_Pack(Py_ssize_t n, ...);
Py_ssize_t PyTuple_Size(PyObject *tup);
#define PyTuple_SET_ITEM(tup, i, item)  ((void)PyTuple_SetItem((PyObject *)(tup), (i), (item)))
#define PyTuple_GET_ITEM(tup, i)        PyTuple_GetItem((tup), (i))

/* Callable / iter protocol. */
int       PyCallable_Check(PyObject *o);
PyObject *PyCallIter_New(PyObject *callable, PyObject *sentinel);
PyObject *PyObject_Vectorcall(PyObject *callable, PyObject *const *args,
                              size_t nargsf, PyObject *kwnames);
/* Vectorcall arg-count helpers — pure macros, no runtime support needed.
 * The high bit of nargsf is the ARGUMENTS_OFFSET flag; NARGS masks it off. */
#define PY_VECTORCALL_ARGUMENTS_OFFSET \
    ((size_t)1 << (8 * sizeof(size_t) - 1))
static inline Py_ssize_t PyVectorcall_NARGS(size_t n) {
    return (Py_ssize_t)(n & ~PY_VECTORCALL_ARGUMENTS_OFFSET);
}
PyObject *PyImport_ImportModuleAttrString(const char *modname, const char *attr);

/* Bytes utilities. */
PyObject *PyBytes_FromObject(PyObject *x);
PyObject *PyBytes_Join(PyObject *sep, PyObject *iterable);

/* PyMem_New — typed allocation macro. */
#define PyMem_New(type, n)  ((type *)PyMem_Malloc((n) * sizeof(type)))

/* Architecture constants. wasm32: pointers are 4 bytes. */
#define SIZEOF_VOID_P    4
#define SIZEOF_LONG      4
#define SIZEOF_INT       4
#define SIZEOF_SIZE_T    4
#define SIZEOF_SHORT     2
#define SIZEOF_LONG_LONG 8
#define SIZEOF_DOUBLE    8
#define SIZEOF_FLOAT     4

/* Misc Py macros & functions. */
PyObject *Py_BuildValue(const char *fmt, ...);
void      _wasthon_Py_SET_SIZE(PyObject *op, Py_ssize_t size);
#define Py_SET_SIZE(op, size)  _wasthon_Py_SET_SIZE((PyObject *)(op), (size))

/* Dict. */
PyObject *PyDict_New(void);
PyObject *PyDict_GetItemWithError(PyObject *dict, PyObject *key);
PyObject *PyDictProxy_New(PyObject *dict);
int       PyDict_SetItem(PyObject *dict, PyObject *key, PyObject *value);
int       PyDict_Contains(PyObject *dict, PyObject *key);
int       PyDict_DelItem(PyObject *dict, PyObject *key);

/* Number protocol. */
int        PyIndex_Check(PyObject *o);
Py_ssize_t PyNumber_AsSsize_t(PyObject *o, PyObject *exc);
PyObject  *_PyLong_GetZero(void);
PyObject  *_PyLong_GetOne(void);
PyObject  *PyNumber_Absolute(PyObject *o);

/* Module-by-def lookup — used by per-type module state pattern. */
PyObject *PyType_GetModuleByDef(PyTypeObject *type, PyModuleDef *def);
PyObject *PyType_GenericNew(PyTypeObject *type, PyObject *args, PyObject *kwds);
void      PyObject_Free(void *op);
PyObject *PyObject_Type(PyObject *o);
int       _PyArg_NoKeywords(const char *fname, PyObject *kwargs);
int       _PyArg_NoPositional(const char *fname, PyObject *args);

/* Sequence. */
PyObject  *PySequence_Fast(PyObject *o, const char *errmsg);
Py_ssize_t PySequence_Fast_GET_SIZE(PyObject *o);
PyObject  *PySequence_Fast_GET_ITEM(PyObject *o, Py_ssize_t i);
PyObject  *PySequence_Repeat(PyObject *o, Py_ssize_t count);
PyObject  *PyMapping_Items(PyObject *mapping);

/* Free-threading atomic loads (no-op in single-threaded WASM). */
#define FT_ATOMIC_LOAD_PTR(p)             (p)
#define FT_ATOMIC_LOAD_PTR_RELAXED(p)     (p)
#define FT_ATOMIC_LOAD_PTR_ACQUIRE(p)     (p)
#define FT_ATOMIC_STORE_PTR(p, v)         ((p) = (v))
#define FT_ATOMIC_STORE_PTR_RELAXED(p,v)  ((p) = (v))
#define FT_ATOMIC_STORE_PTR_RELEASE(p,v)  ((p) = (v))
#define FT_ATOMIC_LOAD_INT(p)             (p)
#define FT_ATOMIC_LOAD_INT_RELAXED(p)     (p)
#define FT_ATOMIC_STORE_INT(p, v)         ((p) = (v))
#define FT_ATOMIC_STORE_INT_RELAXED(p,v)  ((p) = (v))
#define FT_ATOMIC_ADD_SSIZE(p, n)         ((p) += (n))

/* CPython internal singletons. In real CPython, `_Py_STR(empty)` etc.
 * expand to *struct* references (PyASCIIObject, PyBytesObject), so user
 * code does `&_Py_STR(empty)` to get a PyObject*. We mimic this by
 * defining the macros as dereferences of `Py_None`, so `&_Py_STR(x)`
 * yields `Py_None` (the singleton handle). The bridge helpers
 * (`_PyUnicode_JoinArray`, `PyBytes_Join`) recognise Py_None as the
 * "empty separator" sentinel. */
#define _Py_SINGLETON(name)      (*Py_None)
/* _Py_ID(foo) is used like `&_Py_ID(foo)` to obtain a PyObject* for the
 * pre-interned string "foo". Route through a bridge helper that returns
 * a Brython str instance for the given name. */
PyObject *_wasthon_id(const char *name);
#define _Py_ID(name)             (*_wasthon_id(#name))
/* _Py_STR(name): module-local strings declared with _Py_DECLARE_STR(name,
 * literal) must resolve to that *literal* (e.g. _json's raise_errmsg uses
 * &_Py_STR(json_decoder) == "json.decoder" to import JSONDecodeError — when
 * this expanded to Py_None the import silently returned NULL and decode
 * errors surfaced as "tp_call returned NULL"). The predefined global `empty`
 * has no literal of its own and stays Py_None, the empty-separator sentinel
 * that _sre/_io rely on (PyBytes_Join / _PyUnicode_JoinArray special-case it). */
static inline PyObject *_wasthon_str(const char *s) {
    return (s && s[0]) ? _wasthon_id(s) : Py_None;
}
#define _wasthon_strlit_empty    ""
#define _Py_STR(name)            (*_wasthon_str(_wasthon_strlit_##name))

#define _Py_NO_SANITIZE_UNDEFINED   /* attribute, no-op */

/* Comparison op constants for PyObject_RichCompareBool. */
#define Py_LT  0
#define Py_LE  1
#define Py_EQ  2
#define Py_NE  3
#define Py_GT  4
#define Py_GE  5

/* Hash + rich compare. */
Py_hash_t PyObject_Hash(PyObject *o);
int       PyObject_RichCompareBool(PyObject *o1, PyObject *o2, int op);
#define PyList_GET_ITEM(list, i)        PyList_GetItem((list), (i))
#define PyList_SET_ITEM(list, i, item)  ((void)PyList_SetItem((list), (i), (item)))
#define PyList_GET_SIZE(list)           PyList_Size(list)

/* Bytes-accessor macros / fast-paths. */
char      *PyBytes_AsString(PyObject *bytes);
Py_ssize_t PyBytes_Size(PyObject *bytes);
int        _PyBytes_Resize(PyObject **pv, Py_ssize_t newsize);
#define PyBytes_AS_STRING(b)  PyBytes_AsString((PyObject *)(b))
#define PyBytes_GET_SIZE(b)   PyBytes_Size((PyObject *)(b))

/* PyList_GET_ITEM as an addressable lvalue via the materialised array.
 * `&PyList_GET_ITEM(list, 0)` thus yields a real PyObject** suitable for
 * passing to functions like _PyUnicode_JoinArray. The materialised array
 * is per-call (small leak); refresh-on-call to stay correct after edits. */
#undef PyList_GET_ITEM
#define PyList_GET_ITEM(list, i)  (wasthon_list_items((PyObject *)(list))[(i)])

/* Py_SIZE / PY_SSIZE_T_MAX. Defined as a plain integer literal so it can
 * be used in preprocessor expressions (md5module: #if PY_SSIZE_T_MAX > …). */
Py_ssize_t _wasthon_Py_SIZE(PyObject *op);
#define Py_SIZE(op)  _wasthon_Py_SIZE((PyObject *)(op))
#ifndef PY_SSIZE_T_MAX
#define PY_SSIZE_T_MAX  0x7FFFFFFF   /* wasm32: Py_ssize_t == int32_t */
#endif
long      PyLong_AsLong(PyObject *o);
int       PyLong_AsInt(PyObject *o);
int       PyLong_AsUInt32(PyObject *o, uint32_t *value);
unsigned long PyLong_AsUnsignedLong(PyObject *o);
unsigned long PyLong_AsUnsignedLongMask(PyObject *o);
Py_ssize_t PyLong_AsSsize_t(PyObject *o);
size_t    PyLong_AsSize_t(PyObject *o);
long long PyLong_AsLongLong(PyObject *o);
unsigned long long PyLong_AsUnsignedLongLong(PyObject *o);
PyObject *PyLong_FromLongLong(long long v);
PyObject *PyLong_FromInt64(int64_t v);

/* PEP 757 — PyLong Export / Writer API (CPython 3.14). Both structs
 * laid out to match the JS-side bridge implementation. */
typedef struct PyLongLayout {
    uint8_t bits_per_digit;
    uint8_t digit_size;
    int8_t  digits_order;
    int8_t  digit_endianness;
} PyLongLayout;

typedef struct PyLongExport {
    int64_t       value;
    uint8_t       negative;
    Py_ssize_t    ndigits;
    const void   *digits;
    uintptr_t     _reserved;
} PyLongExport;

const PyLongLayout *PyLong_GetNativeLayout(void);
int                 PyLong_Export(PyObject *obj, PyLongExport *out);
void                PyLong_FreeExport(PyLongExport *export_long);

typedef struct PyLongWriter PyLongWriter;
PyLongWriter *PyLongWriter_Create(int negative, Py_ssize_t ndigits, void **digits);
PyObject     *PyLongWriter_Finish(PyLongWriter *writer);
void          PyLongWriter_Discard(PyLongWriter *writer);

PyObject  *PyLong_FromSize_t(size_t v);
PyObject  *_PyLong_GCD(PyObject *a, PyObject *b);
PyObject  *PyFloat_FromString(PyObject *str);
Py_hash_t  PyObject_GenericHash(PyObject *o);

PyObject *PyType_FromMetaclass(PyTypeObject *meta, PyObject *module,
                                PyType_Spec *spec, PyObject *bases);
int       _wasthon_PyType_Check(PyObject *o);
#define   PyType_Check(o)  _wasthon_PyType_Check((PyObject *)(o))
PyObject *PyImport_ImportModule(const char *name);

/* Weak references — single-runtime WASM has no concurrent GC, so all
 * weak refs are effectively strong. PyWeakref_NewRef(obj) returns obj
 * wrapped; PyWeakref_GetRef(ref, *out) writes the referenced object
 * to *out (always non-NULL since we don't drop refs). */
PyObject *PyWeakref_NewRef(PyObject *obj, PyObject *callback);
int PyWeakref_GetRef(PyObject *ref, PyObject **out);

/* PyInterpreterState — opaque in our model. Single-runtime WASM has
 * exactly one pseudo-interp with one dict. Modules cache themselves
 * there (e.g. _datetime stashes its module via weakref). */
typedef struct _is PyInterpreterState;
PyInterpreterState *PyInterpreterState_Get(void);
PyObject *PyInterpreterState_GetDict(PyInterpreterState *interp);

/* Raw allocator hooks — bridge aliases to libc malloc/free. */
void *PyObject_Malloc(size_t size);
void  PyObject_Free(void *ptr);
#define PyObject_Realloc PyMem_Realloc
PyObject *_PyObject_Init(PyObject *op, PyTypeObject *type);

/* CPython 3.12+ raised-exception API. We delegate to the pendingException
 * slot — getter returns the current exc instance (or None), setter stores
 * it. _datetime uses these to chain exceptions. */
PyObject *PyErr_GetRaisedException(void);
void PyErr_SetRaisedException(PyObject *exc);
void PyErr_FormatUnraisable(const char *fmt, ...);

/* GCD helper — _PyLong_GCD already exists; _PyLong_DivmodNear is
 * "round-half-to-even" division. _datetime uses it for tzinfo math. */
PyObject *_PyLong_DivmodNear(PyObject *a, PyObject *b);

/* PyUnicodeWriter — CPython 3.14 string-builder. Bridge holds an array
 * of JS chunks and joins at Finish. Used by _datetime's repr/str paths. */
typedef struct PyUnicodeWriter PyUnicodeWriter;
PyUnicodeWriter *PyUnicodeWriter_Create(Py_ssize_t length);
PyObject        *PyUnicodeWriter_Finish(PyUnicodeWriter *writer);
void             PyUnicodeWriter_Discard(PyUnicodeWriter *writer);
int              PyUnicodeWriter_WriteUTF8(PyUnicodeWriter *writer, const char *str, Py_ssize_t size);
int              PyUnicodeWriter_WriteStr(PyUnicodeWriter *writer, PyObject *obj);
int              PyUnicodeWriter_WriteRepr(PyUnicodeWriter *writer, PyObject *obj);
int              PyUnicodeWriter_WriteSubstring(PyUnicodeWriter *writer, PyObject *str, Py_ssize_t start, Py_ssize_t end);

/* _PyLong_DigitValue[c] — lookup table mapping a char to its digit value
 * (0-9 for '0'-'9', 10-35 for 'a'-'z'/'A'-'Z', 37 for invalid). Used by
 * binascii's unhexlify to parse hex chars. Defined in wasthon.c. */
extern const unsigned char _PyLong_DigitValue[256];

/* _Py_strhex_bytes_with_sep — CPython internal: format bytes as hex string
 * with optional separator every N bytes. Signature mirrors CPython:
 * sep is a single-char bytes/str (or NULL for no sep); positive
 * bytes_per_sep groups from the right (matches `bytes.hex(sep, n)`),
 * negative from the left. Used by binascii.b2a_hex's sep variant. */
PyObject *_Py_strhex_bytes_with_sep(const char *bytes, Py_ssize_t bytes_len,
                                    PyObject *sep, int bytes_per_sep);

/* Misc additions */
PyObject *PySequence_GetItem(PyObject *o, Py_ssize_t i);
int       PySequence_Check(PyObject *o);
Py_ssize_t PySequence_Size(PyObject *o);
#define PySequence_Length(o) PySequence_Size(o)
int PyList_CheckExact(PyObject *o);

/* Clinic helper: convert (int | None) to Py_ssize_t. Returns 1 on success
 * (sets *result), 0 on type error (sets exception). On None, leaves *result
 * untouched (caller's default is preserved). */
int _Py_convert_optional_to_ssize_t(PyObject *obj, Py_ssize_t *result);

/* PyLong → little-endian / native-endian byte buffer (3.13+).
 * Returns the number of bytes written, or -1 on error. */
#define Py_ASNATIVEBYTES_DEFAULTS         0
#define Py_ASNATIVEBYTES_BIG_ENDIAN       1
#define Py_ASNATIVEBYTES_LITTLE_ENDIAN    2
#define Py_ASNATIVEBYTES_NATIVE_ENDIAN    3
#define Py_ASNATIVEBYTES_UNSIGNED_BUFFER  4
#define Py_ASNATIVEBYTES_REJECT_NEGATIVE  8
#define Py_ASNATIVEBYTES_ALLOW_INDEX     16
Py_ssize_t PyLong_AsNativeBytes(PyObject *obj, void *buffer, Py_ssize_t n, int flags);

/* Mapping protocol additions. */
int PyMapping_Check(PyObject *o);
int PyMapping_GetOptionalItemString(PyObject *obj, const char *key, PyObject **result);

/* Dict iteration. pos starts at 0, returns 1 while iterating, 0 at end. */
int PyDict_Next(PyObject *dict, Py_ssize_t *pos, PyObject **key, PyObject **value);
PyObject *PyObject_CallMethodOneArg(PyObject *self, PyObject *name, PyObject *arg);
PyObject *PyObject_Call(PyObject *callable, PyObject *args, PyObject *kwargs);
PyObject *PyNumber_Long(PyObject *o);
PyObject *PyNumber_Add(PyObject *a, PyObject *b);
PyObject *PyNumber_Multiply(PyObject *a, PyObject *b);
PyObject *PyNumber_FloorDivide(PyObject *a, PyObject *b);
PyObject *PyNumber_TrueDivide(PyObject *a, PyObject *b);
PyObject *PyNumber_Remainder(PyObject *a, PyObject *b);
PyObject *PyNumber_And(PyObject *a, PyObject *b);
PyObject *PyNumber_Divmod(PyObject *a, PyObject *b);
PyObject *PyLong_FromDouble(double v);
double    PyLong_AsDouble(PyObject *o);

/* Static-type init macros. Bridge doesn't use static PyTypeObject
 * definitions (we go through PyType_FromModuleAndSpec) but _datetime
 * has at least one static instance — these macros expand to a minimal
 * brace-init that produces a struct of the right shape. */
#define PyObject_HEAD_INIT(type)    {0},
#define PyVarObject_HEAD_INIT(type, size)  {0}, (size),

/* FT_ATOMIC_*_SSIZE_* — free-threading atomic ops; no-op on WASM. */
#define FT_ATOMIC_LOAD_SSIZE_RELAXED(p)    (p)
#define FT_ATOMIC_STORE_SSIZE_RELAXED(p, v) ((p) = (v))

/* _PyTime — wallclock helpers. Bridge uses JS Date for now() and
 * gmtime/localtime; _PyTime_ROUND_FLOOR is a rounding-mode constant
 * we treat as a no-op (always floor). */
typedef int _PyTime_round_t;
#define _PyTime_ROUND_FLOOR 0
int _PyTime_ObjectToTime_t(PyObject *obj, time_t *sec, _PyTime_round_t round);
int _PyTime_localtime(time_t t, struct tm *tm);

Py_ssize_t PyUnicode_GetLength(PyObject *unicode);
Py_UCS4    PyUnicode_ReadChar(PyObject *unicode, Py_ssize_t index);
PyObject  *PyUnicode_AsLatin1String(PyObject *unicode);
PyObject  *PyObject_Str(PyObject *o);
PyObject  *PyObject_CallMethodObjArgs(PyObject *obj, PyObject *name, ...);
PyObject  *PyImport_Import(PyObject *name);
int        PyArg_UnpackTuple(PyObject *args, const char *name, Py_ssize_t min, Py_ssize_t max, ...);
PyObject  *PyDict_Keys(PyObject *dict);
int        PyDict_Pop(PyObject *dict, PyObject *key, PyObject **result);

/* PyObject_GetOptionalAttr — like GetAttr but returns 0 with no error
 * if the attribute is missing. Returns 1 on success (writes to *out),
 * 0 if missing, -1 on error. */
int PyObject_GetOptionalAttr(PyObject *obj, PyObject *attr_name, PyObject **out);

/* _PyObject_GetState — return obj's __dict__ for pickle. Returns
 * Py_None if obj has no state. */
PyObject *_PyObject_GetState(PyObject *obj);
PyObject *PyUnicode_DecodeASCII(const char *str, Py_ssize_t size, const char *errors);
PyObject *PyObject_VectorcallDict(PyObject *callable, PyObject *const *args, Py_ssize_t nargs, PyObject *kwargs);

/* Refcount no-ops — bridge has JS GC, no refs to count. Variants
 * tolerate NULL safely (X = "extended" in CPython parlance). */
#ifndef Py_XINCREF
#define Py_XINCREF(op)  ((void)(op))
#endif
#ifndef Py_INCREF
#define Py_INCREF(op)   ((void)(op))
#endif

/* Iterator protocol + numeric checks */
PyObject  *PyObject_GetIter(PyObject *o);
PyObject  *PyIter_Next(PyObject *iter);
int        PyNumber_Check(PyObject *o);
PyObject  *PyNumber_Float(PyObject *o);

/* PyMem_Resize(ptr, type, n) — realloc to n elements of `type`. */
#include <stdlib.h>
#define PyMem_Resize(ptr, type, n) \
    ((ptr) = (type *)realloc((ptr), (n) * sizeof(type)))
/* Legacy upper-case alias used by arraymodule. */
#define PyMem_RESIZE  PyMem_Resize

/* arraymodule + others need these. */
PyObject *PyObject_RichCompare(PyObject *a, PyObject *b, int op);
int       PyErr_BadArgument(void);
int       PyType_IsSubtype(PyTypeObject *a, PyTypeObject *b);
Py_ssize_t PyUnicode_AsWideChar(PyObject *unicode, wchar_t *buffer, Py_ssize_t n);
Py_UCS4  *PyUnicode_AsUCS4(PyObject *unicode, Py_UCS4 *buffer, Py_ssize_t buflen, int copy_null);
PyObject *PyUnicode_DecodeUTF16(const char *s, Py_ssize_t size, const char *errors, int *byteorder);
PyObject *PyUnicode_DecodeUTF32(const char *s, Py_ssize_t size, const char *errors, int *byteorder);
void      _PyBytes_Repeat(char *dest, Py_ssize_t len_dest, const char *src, Py_ssize_t len_src);
int       _PyEval_SliceIndexNotNone(PyObject *v, Py_ssize_t *pi);
PyObject *_PyEval_GetBuiltin(PyObject *name);  /* declared in pycore_ceval.h shim */

/* No-op audit hook. */
int PySys_Audit(const char *event, const char *format, ...);
wchar_t *PyUnicode_AsWideCharString(PyObject *unicode, Py_ssize_t *size);
Py_UCS4 *PyUnicode_AsUCS4Copy(PyObject *unicode);

/* Py_SET_TYPE — rebind an object's class (numpy's DTypeMeta machinery does
 * Py_SET_TYPE(descr, dtype_class) to promote a descr to its DType class). */
void _wasthon_Py_SET_TYPE(PyObject *op, PyTypeObject *type);
#define Py_SET_TYPE(op, type)  _wasthon_Py_SET_TYPE((PyObject *)(op), (PyTypeObject *)(type))
PyObject *_PyLong_FromByteArray(const unsigned char *bytes, size_t n,
                                 int little_endian, int is_signed);
/* _PyLong_AsByteArray — also declared in pycore_long.h (with void *v). */

/* Slice protocol — used by sequence indexing with slice objects. */
int       PySlice_Check(PyObject *o);
int       PySlice_Unpack(PyObject *slice, Py_ssize_t *start, Py_ssize_t *stop, Py_ssize_t *step);
Py_ssize_t PySlice_AdjustIndices(Py_ssize_t length, Py_ssize_t *start, Py_ssize_t *stop, Py_ssize_t step);

/* PyVarObject — variable-size objects. Layout matches PyObject_VAR_HEAD
 * so `((PyVarObject*)op)->ob_size` reads the same memory as
 * `op->ob_base.ob_size`. ob_refcnt at offset 0, ob_size at offset 4,
 * 8 bytes total. */
typedef struct {
    intptr_t   ob_refcnt;
    Py_ssize_t ob_size;
} PyVarObject;

/* Buffer protocol flags (we don't implement the protocol — see notes in
 * arraymodule's BUFFER_GET, but we need the flag constants to compile). */
#define PyBUF_FORMAT     0x0004
#define PyBUF_ND         0x0008
#define PyBUF_STRIDES   (0x0010 | PyBUF_ND)
#define PyBUF_C_CONTIGUOUS  (0x0020 | PyBUF_STRIDES)
#define PyBUF_F_CONTIGUOUS  (0x0040 | PyBUF_STRIDES)
#define PyBUF_ANY_CONTIGUOUS (0x0080 | PyBUF_STRIDES)
#define PyBUF_INDIRECT  (0x0100 | PyBUF_STRIDES)
#define PyBUF_CONTIG    (PyBUF_ND | 0x0001)
#define PyBUF_CONTIG_RO PyBUF_ND
#define PyBUF_STRIDED   (PyBUF_STRIDES | 0x0001)
#define PyBUF_STRIDED_RO PyBUF_STRIDES
#define PyBUF_RECORDS   (PyBUF_STRIDES | PyBUF_FORMAT | 0x0001)
#define PyBUF_RECORDS_RO (PyBUF_STRIDES | PyBUF_FORMAT)
#define PyBUF_FULL      (PyBUF_INDIRECT | PyBUF_FORMAT | 0x0001)
#define PyBUF_FULL_RO   (PyBUF_INDIRECT | PyBUF_FORMAT)
#define PyBUF_WRITABLE  0x0001
#define PyBUF_READ      0x100
#define PyBUF_WRITE     0x200

/* Legacy T_* aliases for the Py_T_* member-type codes defined earlier
 * (around line 338). Same values as Py_T_* — no redefinition. Nothing
 * actually reads these at runtime, but a few modules reference T_* names
 * in PyMemberDef[] tables. */
#define T_INT         Py_T_INT
#define T_LONG        Py_T_LONG
#define T_ULONG       Py_T_ULONG
#define T_STRING      Py_T_STRING
#define T_BOOL        Py_T_BOOL
#define T_OBJECT_EX   Py_T_OBJECT_EX
#define T_OBJECT      Py_T_OBJECT_EX  /* legacy "any object pointer", aliased */
#define T_DOUBLE      Py_T_DOUBLE
#define T_FLOAT       Py_T_FLOAT
#define T_UINT        Py_T_UINT
#define T_SHORT       Py_T_SHORT
#define T_BYTE        Py_T_BYTE
#define T_CHAR        Py_T_CHAR
#define T_PYSSIZET    Py_T_PYSSIZET
#define T_LONGLONG    Py_T_LONGLONG
#define T_ULONGLONG   Py_T_ULONGLONG
#define T_USHORT      Py_T_USHORT
#define T_UBYTE       Py_T_UBYTE

/* Legacy PyMemberDef flag names (pygame's member tables use READONLY). */
#ifndef READONLY
#define READONLY          Py_READONLY
#define READ_RESTRICTED   2
#define WRITE_RESTRICTED  4
#define RESTRICTED        6
#endif

/* Critical sections — single-threaded WASM. */
#ifndef Py_BEGIN_CRITICAL_SECTION
#define Py_BEGIN_CRITICAL_SECTION(op)    ((void)(op))
#define Py_END_CRITICAL_SECTION()        ((void)0)
#define Py_BEGIN_CRITICAL_SECTION2(a, b) ((void)(a), (void)(b))
#define Py_END_CRITICAL_SECTION2()       ((void)0)
#endif
PyObject *PyObject_CallNoArgs(PyObject *callable);
PyObject *Py_VaBuildValue(const char *format, va_list va);

/* Py_RETURN_RICHCOMPARE — common pattern in tp_richcompare slots:
 * pick the right Py_True/Py_False based on op and the cmp result. */
#define Py_RETURN_RICHCOMPARE(val1, val2, op) do {                  \
    switch (op) {                                                   \
    case Py_LT: return ((val1) <  (val2)) ? Py_NewRef(Py_True) : Py_NewRef(Py_False); \
    case Py_LE: return ((val1) <= (val2)) ? Py_NewRef(Py_True) : Py_NewRef(Py_False); \
    case Py_EQ: return ((val1) == (val2)) ? Py_NewRef(Py_True) : Py_NewRef(Py_False); \
    case Py_NE: return ((val1) != (val2)) ? Py_NewRef(Py_True) : Py_NewRef(Py_False); \
    case Py_GT: return ((val1) >  (val2)) ? Py_NewRef(Py_True) : Py_NewRef(Py_False); \
    case Py_GE: return ((val1) >= (val2)) ? Py_NewRef(Py_True) : Py_NewRef(Py_False); \
    }                                                               \
    Py_RETURN_NOTIMPLEMENTED;                                       \
} while (0)
PyObject *PyObject_CallFunction(PyObject *callable, const char *fmt, ...);
PyObject *PyUnicode_InternFromString(const char *str);
PyObject *PyLong_FromUnsignedLongLong(unsigned long long v);
PyObject *PyComplex_FromDoubles(double real, double imag);

/* Py_complex — pair of doubles. Used by _struct's complex format codes. */
typedef struct { double real; double imag; } Py_complex;
Py_complex PyComplex_AsCComplex(PyObject *o);
PyObject  *PyComplex_FromCComplex(Py_complex c);

void *PyLong_AsVoidPtr(PyObject *o);

/* PyFloat pack/unpack — IEEE 754 helpers used by _struct's `e`, `f`, `d`
 * format codes. Each variant packs/unpacks a 2/4/8-byte float to/from a
 * byte buffer, with explicit endianness. */
int    PyFloat_Pack2(double x, char *p, int le);
int    PyFloat_Pack4(double x, char *p, int le);
int    PyFloat_Pack8(double x, char *p, int le);
double PyFloat_Unpack2(const char *p, int le);
double PyFloat_Unpack4(const char *p, int le);
double PyFloat_Unpack8(const char *p, int le);
PyObject *PyUnicode_FromFormat(const char *fmt, ...);
int       PyObject_IsTrue(PyObject *o);
Py_ssize_t PyTuple_GET_SIZE(PyObject *o);

/* Type-check predicates (used by hashlib.h's GET_BUFFER_VIEW_OR_ERROR) */
int PyUnicode_Check(PyObject *o);
int PyUnicode_CheckExact(PyObject *o);
int PyBytes_CheckExact(PyObject *o);
int PyBytes_Check(PyObject *o);
int PyLong_CheckExact(PyObject *o);
int PyDict_CheckExact(PyObject *o);

/* PEP 393 Unicode introspection. Brython strings are JS strings (UTF-16).
 * Our bridge materialises a Py_UCS4 buffer on demand and caches it on the
 * string object, then reports kind=4. */
#define PyUnicode_1BYTE_KIND  1
#define PyUnicode_2BYTE_KIND  2
#define PyUnicode_4BYTE_KIND  4
#define PyUnicode_WCHAR_KIND  0
Py_ssize_t PyUnicode_GET_LENGTH(PyObject *unicode);
int        PyUnicode_KIND(PyObject *unicode);
void      *PyUnicode_DATA(PyObject *unicode);
Py_ssize_t PyUnicode_FindChar(PyObject *str, Py_UCS4 ch,
                               Py_ssize_t start, Py_ssize_t end, int direction);
PyObject  *PyUnicode_Substring(PyObject *str, Py_ssize_t start, Py_ssize_t end);
PyObject  *PyUnicode_FromKindAndData(int kind, const void *buffer, Py_ssize_t size);
PyObject  *PyUnicode_FromOrdinal(int ordinal);
PyObject  *PyUnicode_AppendAndDel(PyObject **left, PyObject *right);
PyObject  *PyUnicode_Concat(PyObject *left, PyObject *right);
PyObject  *PyUnicode_Join(PyObject *separator, PyObject *seq);
Py_UCS4    PyUnicode_MAX_CHAR_VALUE(PyObject *unicode);
PyObject  *PyUnicode_New(Py_ssize_t size, Py_UCS4 maxchar);
Py_UCS4    PyUnicode_READ(int kind, void *data, Py_ssize_t index);
int        PyErr_CheckSignals(void);
int        PyErr_ExceptionMatches(PyObject *exc);

/* Macro variant — the regex engine reads codepoints in tight loops. */
#define PyUnicode_READ(kind, data, index) \
    ((kind) == 4 ? ((Py_UCS4 *)(data))[index] : \
     (kind) == 2 ? ((Py_UCS2 *)(data))[index] : \
                   ((Py_UCS1 *)(data))[index])
int PyDict_Check(PyObject *o);
int PyTuple_Check(PyObject *o);
int PyTuple_CheckExact(PyObject *o);
int PyFloat_CheckExact(PyObject *o);
int PyObject_SetAttrString(PyObject *o, const char *name, PyObject *v);

#include <math.h>
#ifndef Py_INFINITY
#  define Py_INFINITY  ((double)INFINITY)
#endif
#ifndef Py_NAN
#  define Py_NAN       ((double)NAN)
#endif

/* math module additions. */
PyObject *PyNumber_Index(PyObject *o);
int       _PyLong_IsZero(PyObject *v);
int       _PyLong_IsNegative(PyObject *v);
int       _PyLong_IsPositive(PyObject *v);
PyObject *_PyLong_Rshift(PyObject *a, int64_t shiftby);
PyObject *_PyLong_Lshift(PyObject *a, int64_t shiftby);
typedef PyObject PyLongObject;
#include <stdint.h>
double    _PyLong_Frexp(PyLongObject *a, int64_t *e);  /* CPython 3.14 sig */
long long PyLong_AsLongLongAndOverflow(PyObject *o, int *overflow);
int       PyBool_Check(PyObject *o);

/* Math constants. */
#define   Py_MATH_PI   3.141592653589793238462643383279502884
#define   Py_MATH_E    2.718281828459045235360287471352662498
#define   Py_MATH_TAU  6.283185307179586476925286766559005768
PyObject *PyErr_SetFromErrno(PyObject *exc);
PyObject *_PyObject_MaybeCallSpecialNoArgs(PyObject *obj, PyObject *name);
PyObject *PyNumber_Subtract(PyObject *a, PyObject *b);
int       _Py_bit_length(unsigned long v);
PyObject *PySequence_Tuple(PyObject *o);
typedef   PyObject *(*iternextfunc)(PyObject *);
/* tp_iter, tp_iternext signatures already known; just make iternextfunc */
int PyObject_SetAttr(PyObject *o, PyObject *name, PyObject *v);
int PyType_Freeze(PyTypeObject *type);

/* _pickle-needed additions. */
PyObject *PyMemoryView_FromMemory(char *mem, Py_ssize_t size, int flags);
/* PyMemoryView_FromObject — used by pickle protocol 5's read-only buffer
 * opcode (load_readonly_buffer). The bridge has no full memoryview impl,
 * so this is a stub that fails the path (returns NULL + NotImplementedError).
 * Basic pickle/unpickle of int/str/list/dict/tuple/bytes/etc. never
 * reaches this code path, so the stub is sufficient for the common case.
 * PyMemoryView_GET_BUFFER lives after Py_buffer's struct definition
 * (further down) since it returns a Py_buffer*. */
PyObject  *PyMemoryView_FromObject(PyObject *obj);

/* CPython internals exposed under bridge-friendly names. */
/* _PyInterpreterState_GET — fast inline in CPython, mapped to the public
 * getter here. pickle uses it inside its global-name resolution path. */
#define _PyInterpreterState_GET() PyInterpreterState_Get()
/* _PyUnicode_InternMortal — interning is a memory/perf optimization, not
 * required for correctness. Stub as no-op so pickle's intern attempts
 * are silent. */
static inline void _PyUnicode_InternMortal(PyInterpreterState *_i, PyObject **_p) {
    (void)_i; (void)_p;
}
char     *_PyMem_Strdup(const char *str);
PyObject *PyUnicode_Split(PyObject *s, PyObject *sep, Py_ssize_t maxsplit);
PyObject *_Py_LATIN1_CHR(int ch);
int       _PyUnicode_EqualToASCIIString(PyObject *u, const char *str);
PyObject *PyObject_GetAttr(PyObject *o, PyObject *name);
PyObject *_PySys_GetRequiredAttr(PyObject *name);
PyObject *PyObject_GetItem(PyObject *o, PyObject *key);
void      _PyErr_ChainExceptions1(PyObject *exc);
long      PyLong_AsLongAndOverflow(PyObject *o, int *overflow);
int       PyLong_GetSign(PyObject *v, int *sign);
PyObject *PyObject_Repr(PyObject *o);
double    PyFloat_AS_DOUBLE_(PyObject *o);
#define   PyFloat_AS_DOUBLE(o)  PyFloat_AsDouble((PyObject *)(o))
typedef PyObject PyFloatObject;
char     *PyOS_double_to_string(double val, char format_code, int precision, int flags, int *type);
#define   Py_DTSF_SIGN        0x1
#define   Py_DTSF_ADD_DOT_0   0x2
#define   Py_DTSF_ALT         0x4
PyObject *PyUnicode_DecodeLatin1(const char *s, Py_ssize_t size, const char *errors);
extern PyTypeObject PyByteArray_Type;
extern const char Py_hexdigits[];

/* _json-needed additions. */

/* UTF-16 surrogate helpers — pure C, no bridge call needed. */
#define Py_UNICODE_HIGH_SURROGATE(ch)  (0xD800 - (0x10000 >> 10) + ((ch) >> 10))
#define Py_UNICODE_LOW_SURROGATE(ch)   (0xDC00 + ((ch) & 0x3FF))
#define Py_UNICODE_IS_HIGH_SURROGATE(ch)  (0xD800 <= (ch) && (ch) <= 0xDBFF)
#define Py_UNICODE_IS_LOW_SURROGATE(ch)   (0xDC00 <= (ch) && (ch) <= 0xDFFF)
#define Py_UNICODE_JOIN_SURROGATES(high, low) \
    (0x10000 + (((Py_UCS4)(high) - 0xD800) << 10) + ((Py_UCS4)(low) - 0xDC00))

/* Direct buffer access — returns a pointer to the str's internal UCS storage.
 * For our bridge, strs are JS strings (no internal UCS buffer) — we
 * materialise into a freshly malloc'd buffer per call. */
Py_UCS2 *PyUnicode_2BYTE_DATA_(PyObject *u);
Py_UCS4 *PyUnicode_4BYTE_DATA_(PyObject *u);
#define   PyUnicode_2BYTE_DATA(u)  PyUnicode_2BYTE_DATA_((PyObject *)(u))
#define   PyUnicode_4BYTE_DATA(u)  PyUnicode_4BYTE_DATA_((PyObject *)(u))

/* PyUnicodeWriter API — public in CPython 3.14, used by _json for
 * incremental string building. The struct exposes `pos` so the legacy
 * `_PyUnicodeWriter` field access works; the actual buffer lives JS-side
 * via the opaque _internal handle. */
typedef struct PyUnicodeWriter {
    Py_ssize_t pos;
    void *_internal;
} PyUnicodeWriter;
PyUnicodeWriter *PyUnicodeWriter_Create(Py_ssize_t length);
void             PyUnicodeWriter_Discard(PyUnicodeWriter *writer);
PyObject        *PyUnicodeWriter_Finish(PyUnicodeWriter *writer);
int              PyUnicodeWriter_WriteChar(PyUnicodeWriter *writer, Py_UCS4 ch);
int              PyUnicodeWriter_WriteStr(PyUnicodeWriter *writer, PyObject *str);
int              PyUnicodeWriter_WriteSubstring(PyUnicodeWriter *writer, PyObject *str, Py_ssize_t start, Py_ssize_t end);
int              PyUnicodeWriter_WriteUTF8(PyUnicodeWriter *writer, const char *str, Py_ssize_t size);
int              PyUnicodeWriter_WriteRepr(PyUnicodeWriter *writer, PyObject *obj);
int              PyUnicodeWriter_Format(PyUnicodeWriter *writer, const char *format, ...);

/* PyImport_ImportModuleAttr — new in 3.13: import + getattr in one call. */
PyObject *PyImport_ImportModuleAttr(PyObject *mod_name, PyObject *attr_name);

int       PyUnicodeWriter_WriteASCII(PyUnicodeWriter *writer, const char *str, Py_ssize_t size);

/* PyCFunction_GetFunction — get the C function pointer from a builtin
 * method. For our trampoline-based dispatch, we don't expose the raw C
 * pointer; return NULL so callers fall through to PyObject_Call. */
typedef PyObject *(*PyCFunction)(PyObject *self, PyObject *args);
PyCFunction PyCFunction_GetFunction(PyObject *func);

/* _PyUnicodeWriter — legacy internal API still used in a few code paths.
 * We alias to PyUnicodeWriter for compile-time compatibility. */
typedef PyUnicodeWriter _PyUnicodeWriter;

/* _Py_DECLARE_STR(name, literal) — declares a module-local interned string.
 * Stash the literal in a file/function-static array; &_Py_STR(name) then
 * interns it on demand (see _wasthon_str above). The identifier (`name`) and
 * the literal differ (json_decoder vs "json.decoder"), so unlike _Py_ID we
 * cannot stringify the name — we must keep the literal. */
#define _Py_DECLARE_STR(name, literal) \
    static const char _wasthon_strlit_##name[] = literal;

/* Py_tp_call slot — was missing. CPython slot ID 50 conflicts with our
 * tp_str (50). Use our own unique ID. */
#define Py_tp_call    77

/* Variable-object cast + atomic-load no-ops (single-threaded WASM). */
#define _PyVarObject_CAST(op)         ((PyVarObject *)(op))
#define FT_ATOMIC_LOAD_SSIZE(p)       (p)
typedef PyObject PyDictObject;
PyObject *_PyObject_CallNoArgs(PyObject *callable);
int       Py_ReprEnter(PyObject *o);
void      Py_ReprLeave(PyObject *o);
int       PyDict_Update(PyObject *a, PyObject *b);
PyObject *PySequence_GetSlice(PyObject *o, Py_ssize_t i1, Py_ssize_t i2);
PyObject *_PyType_LookupRef(PyTypeObject *type, PyObject *name);
PyObject *_PyType_Lookup(PyTypeObject *type, PyObject *name);
Py_hash_t _PyObject_HashFast(PyObject *o);
PyObject *_PyDict_GetItem_KnownHash(PyObject *d, PyObject *k, Py_hash_t hash);
int       PyObject_SetItem(PyObject *o, PyObject *key, PyObject *v);
int       PyObject_DelItem(PyObject *o, PyObject *key);
#define   Py_nb_or  39
/* Descriptor protocol slots. NOTE: the natural CPython IDs 56/57 collide here
 * with Py_tp_doc (56) and Py_tp_getattro (57), which the bridge already reads
 * as doc/getattro — so wiring tp_descr_get off slot 56 mis-fired on every C
 * type that carries a docstring (getWasmTableEntry on the doc pointer →
 * "bad Table get address"). Give them free IDs (84/85) that nothing else uses;
 * emitter (Cython/C extension specs) and consumer (bridge slotMap) both read
 * these macros, so the value only has to be internally consistent. */
#define   Py_tp_descr_get  84
#define   Py_tp_descr_set  85
extern PyTypeObject PyODict_Type;

/* More _pickle support. */
PyObject *PyUnicode_AsEncodedString(PyObject *u, const char *enc, const char *err);
PyObject *PySequence_List(PyObject *o);
extern PyTypeObject PySet_Type;
extern PyTypeObject PyFrozenSet_Type;
extern PyTypeObject _PyNone_Type;
extern PyTypeObject PyEllipsis_Type;
extern PyTypeObject _PyNotImplemented_Type;
extern PyObject *Py_Ellipsis;
Py_ssize_t PySet_GET_SIZE(PyObject *s);
int       _PySet_NextEntryRef(PyObject *set, Py_ssize_t *pos, PyObject **key, Py_hash_t *hash);
int       PyIter_Check(PyObject *o);
int       _PyUnicode_Equal(PyObject *a, PyObject *b);
PyObject *PyTuple_GetSlice(PyObject *t, Py_ssize_t low, Py_ssize_t high);

/* pyexpat-needed additions. */
PyObject *PyModule_New(const char *name);
PyObject *PyDescr_NewGetSet(PyTypeObject *type, void *getset);
PyObject *PyDescr_NAME(PyObject *descr);
int PyDict_SetDefaultRef(PyObject *d, PyObject *key, PyObject *default_value, PyObject **result);
PyObject *PyUnicode_Decode(const char *s, Py_ssize_t size, const char *encoding, const char *errors);
#define Py_UNICODE_REPLACEMENT_CHARACTER  0xFFFD
int PyList_Check(PyObject *o);
int PyLong_Check(PyObject *o);
int PyFloat_Check(PyObject *o);

/* Additional exceptions (used by hashlib.h, unicodedata, _struct, …) */
extern PyObject *PyExc_BufferError;
extern PyObject *PyExc_KeyError;
extern PyObject *PyExc_LookupError;
extern PyObject *PyExc_NotImplementedError;
extern PyObject *PyExc_UnicodeError;
extern PyObject *PyExc_UnicodeDecodeError;
extern PyObject *PyExc_UnicodeEncodeError;
extern PyObject *PyExc_ImportError;
extern PyObject *PyExc_ModuleNotFoundError;
extern PyObject *PyExc_GeneratorExit;
extern PyObject *PyExc_UnboundLocalError;
extern PyObject *PyExc_Exception;
extern PyObject *PyExc_OSError;
extern PyObject *PyExc_AttributeError;
extern PyObject *PyExc_ArithmeticError;
extern PyObject *PyExc_DeprecationWarning;
extern PyObject *PyExc_Warning;
extern PyObject *PyExc_ResourceWarning;
extern PyObject *PyExc_ZeroDivisionError;

/* PyType_FromSpec — variant of FromModuleAndSpec with no module association. */
PyObject *PyType_FromSpec(PyType_Spec *spec);

/* Errors */
PyObject *PyErr_NoMemory(void);
void      PyErr_SetString(PyObject *exc, const char *msg);
PyObject *PyErr_Format(PyObject *exc, const char *fmt, ...);
/* _PyErr_FormatFromCause — like PyErr_Format but chains the in-flight
 * exception as __cause__. The bridge has no exception-chaining machinery,
 * so it sets the new error and drops the cause link (acceptable: the
 * message still surfaces; only the __cause__ attribute is lost). */
PyObject *_PyErr_FormatFromCause(PyObject *exc, const char *fmt, ...);
/* PyErr_Print — print the pending exception and clear it. Routed to the
 * JS console; no sys.last_* / traceback object machinery. */
void      PyErr_Print(void);
void      PyErr_Clear(void);
PyObject *PyErr_Occurred(void);
void      PyErr_SetNone(PyObject *exc);
void      PyErr_SetObject(PyObject *exc, PyObject *value);
Py_hash_t PyObject_HashNotImplemented(PyObject *o);
Py_ssize_t PyDict_Size(PyObject *dict);
PyObject *PyObject_CallObject(PyObject *callable, PyObject *args);
PyObject *PyObject_CallFunctionObjArgs(PyObject *callable, ...);
int PyObject_GC_IsTracked(PyObject *o);
PyObject *PyList_AsTuple(PyObject *list);
int PyType_GetBaseByToken(PyTypeObject *type, void *token, PyTypeObject **result);
int PyComplex_Check(PyObject *o);
int PyObject_IsInstance(PyObject *inst, PyObject *cls);
PyObject *PyUnicode_FromWideChar(const wchar_t *buf, Py_ssize_t len);
Py_UCS1 *PyUnicode_1BYTE_DATA(PyObject *str);
PyObject *PyUnicode_AsUTF8String(PyObject *unicode);
PyObject *PyObject_CallMethod(PyObject *obj, const char *name, const char *fmt, ...);
const char *PyUnicode_AsUTF8AndSize(PyObject *unicode, Py_ssize_t *size);
PyObject *PyUnicode_DecodeUTF8(const char *str, Py_ssize_t size, const char *errors);
int PyErr_WarnEx(PyObject *category, const char *msg, Py_ssize_t stacklevel);

/* Old-style arg parsers (legacy non-clinic modules: _decimal, …). The
 * bridge implements just the 'O' / '|' subset. */
int PyArg_ParseTuple(PyObject *args, const char *format, ...);
int PyArg_ParseTupleAndKeywords(PyObject *args, PyObject *kw,
                                 const char *format, char **keywords, ...);

#define Py_RETURN_NONE  do { return Py_None; } while (0)

/* Module/type creation */
PyObject *PyType_FromModuleAndSpec(PyObject *module, PyType_Spec *spec, PyObject *bases);
int       PyModule_AddType(PyObject *module, PyTypeObject *type);
int       PyModule_AddIntConstant(PyObject *module, const char *name, long value);
int       PyModule_AddStringConstant(PyObject *module, const char *name, const char *value);
/* PyModule_AddIntMacro(m, MACRO) → AddIntConstant(m, "MACRO", MACRO). */
#define PyModule_AddIntMacro(m, c) PyModule_AddIntConstant(m, #c, c)
PyObject *PyErr_NewExceptionWithDoc(const char *name, const char *doc,
                                    PyObject *base, PyObject *dict);
int       PyModule_Add(PyObject *module, const char *name, PyObject *value);
int       PyModule_AddObjectRef(PyObject *module, const char *name, PyObject *value);
PyObject *PyModuleDef_Init(PyModuleDef *def);

/* Module state */
void *_PyModule_GetState(PyObject *module);
void *_PyType_GetModuleState(PyTypeObject *type);
void *PyModule_GetState(PyObject *module);          /* public alias */
void *PyType_GetModuleState(PyTypeObject *type);    /* public alias */
PyObject *PyType_GetModule(PyTypeObject *type);

/* Buffer protocol — minimal, BUF_SIMPLE only */
typedef struct {
    void *buf;
    PyObject *obj;
    Py_ssize_t len;
    Py_ssize_t itemsize;
    int readonly;
    int ndim;
    char *format;
    Py_ssize_t *shape;
    Py_ssize_t *strides;
    Py_ssize_t *suboffsets;
    void *internal;
} Py_buffer;

/* buffer-protocol slot typedefs + table body (forward-declared as
 * PyBufferProcs earlier; defined here because it needs Py_buffer). */
typedef int  (*getbufferproc)(PyObject *, Py_buffer *, int);
typedef void (*releasebufferproc)(PyObject *, Py_buffer *);
struct _wasthon_bufferprocs {
    getbufferproc bf_getbuffer;
    releasebufferproc bf_releasebuffer;
};

/* ---------------------------------------------------------------- *
 * Classic C-API surface used by type-defining modules (pygame).     *
 * Prototypes so the module COMPILES; any not yet implemented in the  *
 * bridge surface as LINK errors (implemented then). Thread/frame     *
 * types are opaque no-op stubs — wasthon is single-threaded (no GIL).*
 * ---------------------------------------------------------------- */

/* slot typedefs the type-object block didn't cover */
typedef void (*destructor)(PyObject *);
typedef int  (*initproc)(PyObject *, PyObject *, PyObject *);

/* thread-state / frame: single-threaded; numpy's sub-interpreter guard
 * reads tstate->interp, so the body lives here (pycore_pystate.h shares
 * the typedef). Both sides return the same singleton at runtime. */
typedef struct _ts { struct _is *interp; int gilstate_counter; } PyThreadState;
typedef struct _wasthon_frame PyFrameObject;
typedef struct _wasthon_code  PyCodeObject;
PyThreadState *PyEval_SaveThread(void);
void           PyEval_RestoreThread(PyThreadState *tstate);
PyFrameObject *PyThreadState_GetFrame(PyThreadState *tstate);

/* module lifecycle (single-phase + multi-phase) */
PyObject *PyModule_Create2(PyModuleDef *def, int apiver);
#define   PyModule_Create(def)  PyModule_Create2((def), 1013)
PyObject *PyModule_FromDefAndSpec2(PyModuleDef *def, PyObject *spec, int apiver);
#define   PyModule_FromDefAndSpec(def, spec) \
          PyModule_FromDefAndSpec2((def), (spec), 1013)
int       PyModule_ExecDef(PyObject *module, PyModuleDef *def);
PyObject *PyModule_GetDict(PyObject *module);
int       PyModule_AddObject(PyObject *module, const char *name, PyObject *value);
PyObject *PyState_FindModule(PyModuleDef *def);

/* types / objects */
int       PyType_Ready(PyTypeObject *type);
PyObject *_PyObject_New(PyTypeObject *type);
#define   PyObject_New(type, tp)  ((type *)_PyObject_New(tp))
void      PyObject_ClearWeakRefs(PyObject *object);

/* dict / import / errors */
PyObject *PyDict_GetItemString(PyObject *dp, const char *key);
PyObject *PyImport_GetModuleDict(void);
void      PyErr_Fetch(PyObject **, PyObject **, PyObject **);
void      PyErr_Restore(PyObject *, PyObject *, PyObject *);

/* sequence / object protocol helpers */
#define   PySequence_ITEM(o, i)  PySequence_GetItem((o), (i))
PyObject **PySequence_Fast_ITEMS(PyObject *o);
int        PySequence_DelItem(PyObject *o, Py_ssize_t i);
Py_ssize_t PyObject_Size(PyObject *o);
int        PyObject_IsSubclass(PyObject *derived, PyObject *cls);
PyObject  *PyOS_FSPath(PyObject *path);
int        PyBytes_AsStringAndSize(PyObject *obj, char **buffer, Py_ssize_t *length);
int        PyWeakref_CheckRef(PyObject *ob);
int        PySlice_GetIndicesEx(PyObject *r, Py_ssize_t length,
                                Py_ssize_t *start, Py_ssize_t *stop,
                                Py_ssize_t *step, Py_ssize_t *slicelength);
void       Py_Exit(int status);

/* misc object / number / dict / capsule / unicode helpers */
PyObject  *PySeqIter_New(PyObject *seq);
void       PyObject_Del(void *op);
#define    PyObject_DEL(op)      PyObject_Del(op)
#define    PyObject_Length(o)    PyObject_Size(o)
PyObject  *PyNumber_Power(PyObject *o1, PyObject *o2, PyObject *o3);
PyObject  *PyDict_GetItem(PyObject *mp, PyObject *key);
int        PyCapsule_IsValid(PyObject *capsule, const char *name);
int        PyCapsule_CheckExact(PyObject *p);
PyObject  *PyBytes_FromFormat(const char *format, ...);
Py_ssize_t PyUnicode_Find(PyObject *str, PyObject *substr, Py_ssize_t start,
                          Py_ssize_t end, int direction);
PyCodeObject  *PyFrame_GetCode(PyFrameObject *frame);
PyFrameObject *PyFrame_GetBack(PyFrameObject *frame);

/* float classification (CPython's math.h-free fallbacks) */
#ifndef Py_IS_NAN
#define Py_IS_NAN(X)       ((X) != (X))
#endif
#ifndef Py_IS_INFINITY
#define Py_IS_INFINITY(X)  ((X) && (X) * 0.5 == (X))
#endif

/* common exception singletons (wired to the engine's builtins at init) */
extern PyObject *PyExc_SyntaxError;
extern PyObject *PyExc_RuntimeWarning;
extern PyObject *PyExc_FutureWarning;
extern PyObject *PyExc_FileNotFoundError;
extern PyObject *PyExc_IOError;
extern PyObject *PyExc_BaseException;

#define PyBUF_SIMPLE  0

int  PyObject_GetBuffer(PyObject *obj, Py_buffer *view, int flags);
int  PyBuffer_FillInfo(Py_buffer *view, PyObject *obj, void *buf,
                       Py_ssize_t len, int readonly, int flags);
int  PyObject_CheckBuffer(PyObject *obj);
void PyBuffer_Release(Py_buffer *view);
int  PyBuffer_IsContiguous(const Py_buffer *view, char fortran);

/* PyMemoryView_GET_BUFFER — see comment above PyMemoryView_FromObject.
 * Stub returns a static dummy Py_buffer; reached only on the
 * memoryview path that PyMemoryView_FromObject already rejects, so
 * its contents never matter — non-NULL suffices for the link. */
Py_buffer *PyMemoryView_GET_BUFFER(PyObject *mv);

/* More _pickle support. */
extern PyTypeObject PyPickleBuffer_Type;
extern PyTypeObject PyFunction_Type;
int       PyMapping_GetOptionalItem(PyObject *obj, PyObject *key, PyObject **result);
int       PyCFunction_Check(PyObject *o);
PyObject *PyCFunction_GET_SELF(PyObject *o);
void     *PyCFunction_GET_FUNCTION(PyObject *o);
int       PyUnicode_EqualToUTF8(PyObject *u, const char *s);
PyObject *PyLong_FromString(const char *str, char **pend, int base);
#include <errno.h>  /* _pickle uses errno for strtol overflow */

/* Misc helpers used by clinic-generated glue */
Py_ssize_t PyDict_GET_SIZE(PyObject *dict);
int        PyDict_SetItemString(PyObject *dict, const char *key, PyObject *value);
void PyErr_BadInternalCall(void);
int  _PyLong_UnsignedLong_Converter(PyObject *obj, void *ptr);

/* PyMem allocator family — wraps standard malloc/free in CPython.
 * Our bridge aliases them directly. PyMem_Raw* are identical for us
 * (CPython distinguishes them by arena; WASM has one heap). */
void *PyMem_Malloc(size_t size);
void *PyMem_Calloc(size_t nelem, size_t elsize);
void *PyMem_Realloc(void *ptr, size_t new_size);
void  PyMem_Free(void *ptr);
void *PyMem_RawMalloc(size_t size);
void *PyMem_RawCalloc(size_t nelem, size_t elsize);
void *PyMem_RawRealloc(void *ptr, size_t new_size);
void  PyMem_RawFree(void *ptr);

/* PyThread — single-threaded WASM. Locks are no-ops. */
PyThread_type_lock PyThread_allocate_lock(void);
void PyThread_free_lock(PyThread_type_lock lock);
int  PyThread_acquire_lock(PyThread_type_lock lock, int waitflag);
void PyThread_release_lock(PyThread_type_lock lock);

/* Py_GetConstant — CPython 3.14 API. Returns interned constants like
 * empty bytes, empty str, None. We back this with our sentinels. */
#define Py_CONSTANT_NONE         0
#define Py_CONSTANT_FALSE        1
#define Py_CONSTANT_TRUE         2
#define Py_CONSTANT_ELLIPSIS     3
#define Py_CONSTANT_NOT_IMPLEMENTED 4
#define Py_CONSTANT_ZERO         5
#define Py_CONSTANT_ONE          6
#define Py_CONSTANT_EMPTY_STR    7
#define Py_CONSTANT_EMPTY_BYTES  8
#define Py_CONSTANT_EMPTY_TUPLE  9
PyObject *Py_GetConstant(unsigned int constant_id);

/* Fallthrough annotation — no-op. */
#define _Py_FALLTHROUGH  ((void)0)

/* GIL stubs. Single-threaded WASM — these are no-ops. */
typedef int PyGILState_STATE;
PyGILState_STATE PyGILState_Ensure(void);
void PyGILState_Release(PyGILState_STATE state);
PyThreadState *PyGILState_GetThisThreadState(void);  /* CPython signature; JS returns a non-null sentinel */

/* Single-threaded WASM stubs. There is exactly one thread and the GIL is
 * always "held"; the interpreter never finalizes (Brython owns the
 * lifecycle). _PyWeakref_IsDead reports "alive" since the bridge doesn't
 * implement weakref death — callers that walk weakref'd object lists must
 * not rely on this for correctness (flagged: real weakref support needed). */
#define PyGILState_Check()              (1)
static inline unsigned long PyThread_get_thread_ident(void) { return 1; }
static inline int _Py_IsInterpreterFinalizing(PyInterpreterState *i) {
    (void)i; return 0;
}
static inline int _PyWeakref_IsDead(PyObject *ref) { (void)ref; return 0; }
/* Emit a ResourceWarning through Brython's warnings machinery so an explicit
 * gc.collect() that finalizes an unclosed resource-holder (e.g. a sqlite3
 * Connection via $wasthon_gc_collect) surfaces it, like CPython's del-time
 * finalizer. The %R-style format is collapsed to a fixed message (no
 * PyUnicode_FromFormatV in the bridge); assertWarns only checks the category. */
extern int PyErr_WarnEx(PyObject *category, const char *msg, Py_ssize_t stacklevel);
static inline int PyErr_ResourceWarning(PyObject *source,
                                        Py_ssize_t stack_level,
                                        const char *format, ...) {
    (void)source; (void)format;
    return PyErr_WarnEx(PyExc_ResourceWarning, "unclosed resource", stack_level);
}

/* Object protocol — common functions used by stdlib modules. */
const char *PyUnicode_AsUTF8(PyObject *unicode);
/* _PyUnicode_AsUTF8NoNUL — like PyUnicode_AsUTF8 but rejects strings with
 * embedded NUL bytes (used for paths / SQL where NUL would truncate). */
const char *_PyUnicode_AsUTF8NoNUL(PyObject *unicode);
/* PyUnicode_FSConverter — argument converter (str|bytes -> bytes). On
 * success writes a new bytes ref to *addr and returns 1; 0 on failure.
 * The bridge calls it directly (not via PyArg O&), so plain 1/0 success
 * semantics are sufficient — no Py_CLEANUP_SUPPORTED recursion. */
int       PyUnicode_FSConverter(PyObject *arg, void *addr);
/* PyObject_CallFinalizerFromDealloc — invoked on the tp_dealloc path.
 * The bridge has no tp_dealloc dispatch (Brython owns object lifecycle),
 * so this is a no-op returning 0 ("proceed with dealloc", never
 * resurrected). NOTE: resource-holding types (sqlite Connection)
 * therefore rely on explicit close()/context-manager, not GC finalization. */
int       PyObject_CallFinalizerFromDealloc(PyObject *self);
PyObject *PyObject_CallMethodNoArgs(PyObject *self, PyObject *name);
PyObject *PyObject_CallOneArg(PyObject *func, PyObject *arg);
PyObject *PyObject_GetAttrString(PyObject *o, const char *name);
int       PyObject_HasAttrString(PyObject *o, const char *name);
/* PyObject_HasAttrWithError — like PyObject_HasAttr but returns -1 on
 * genuine getattr error (any non-AttributeError exception). Returns 1
 * if present, 0 if absent. New in CPython 3.13. */
int       PyObject_HasAttrWithError(PyObject *o, PyObject *name);

/* Argument parsing — sha2module's clinic uses these */
typedef struct {
    const char * const *keywords;
    const char *fname;
    const char *custom_msg;
    int initialized;
    int pos;            /* number of positional-only args */
    int min;
    int max;
    PyObject *kwtuple;  /* always NULL when not Py_BUILD_CORE */
    void *next;
} _PyArg_Parser;

PyObject **_PyArg_UnpackKeywords(
    PyObject *const *args,
    Py_ssize_t nargs,
    PyObject *kwargs,
    PyObject *kwnames,
    _PyArg_Parser *parser,
    int minpos,
    int maxpos,
    int minkw,
    int varpos,
    PyObject **buf
);

int _PyArg_CheckPositional(const char *fname, Py_ssize_t nargs,
                            Py_ssize_t min, Py_ssize_t max);

void Py_FatalError(const char *msg);

/* Misc — used by hmacmodule. */
Py_hash_t Py_HashBuffer(const void *src, Py_ssize_t len);
PyObject *PyErr_NewException(const char *name, PyObject *base, PyObject *dict);

/* Doc string macro — produces a static const char[] */
#define PyDoc_STR(s)        s
#define PyDoc_STRVAR(name, s)  static const char name[] = s

/* ---------------------------------------------------------------- *
 * sha2-specific helpers from CPython core (currently provided by   *
 * pycore_strhex.h, pycore_bitutils.h)                              *
 * ---------------------------------------------------------------- */

/* Hex-encode `argbuf` (length argbuflen) into a new Python str. */
PyObject *_Py_strhex(const char *argbuf, Py_ssize_t argbuflen);

/* Expose `_PyBytesWriter` (the bytes-builder used by _pickle, binascii,
 * and other modules that go through CPython's _PyBytesWriter API). The
 * canonical struct + decls live in pycore_bytesobject.h; modules that
 * include it explicitly (like _pickle.c) get it directly, modules that
 * don't (like binascii.c, which expects Python.h to expose it) get it
 * via this re-export. */
#include "pycore_bytesobject.h"

/* Byte swap intrinsic — modules use this for endianness. Trivial impl. */
static inline uint32_t _Py_bswap32(uint32_t v) {
    return ((v & 0xff000000u) >> 24) |
           ((v & 0x00ff0000u) >> 8)  |
           ((v & 0x0000ff00u) << 8)  |
           ((v & 0x000000ffu) << 24);
}

/* ---------------------------------------------------------------- *
 * NULL                                                             *
 * ---------------------------------------------------------------- */

#ifndef NULL
#define NULL ((void*)0)
#endif

/* ------------------------------------------------------------------ */
/* numpy-compat section (2026-07-06, numpy 2.5.1 compile probe).      */
/* Declarations first: everything here compiles numpy's C against the */
/* bridge; the wasthon.js implementations land by batches at link.    */
/* ------------------------------------------------------------------ */

#include "patchlevel.h"

/* CPython 3 still defines this Python-2-era macro; numpy gates on it. */
#ifndef Py_USING_UNICODE
#define Py_USING_UNICODE 1
#endif

/* Legacy upper-case allocator aliases still used by numpy. */
#ifndef PyMem_FREE
#define PyMem_FREE    PyMem_Free
#define PyMem_MALLOC  PyMem_Malloc
#define PyMem_REALLOC PyMem_Realloc
#define PyMem_NEW(type, n) ((type *)PyMem_Malloc((n) * sizeof(type)))
#define PyMem_DEL     PyMem_Free
#endif
#ifndef PyObject_INIT
#define PyObject_INIT(op, typeobj) PyObject_Init((PyObject *)(op), (typeobj))
#endif

/* Allocator domains (pymem.h) — accepted and ignored by the bridge
 * allocator, which is a single dlmalloc heap. */
typedef enum { PYMEM_DOMAIN_RAW = 0, PYMEM_DOMAIN_MEM = 1, PYMEM_DOMAIN_OBJ = 2 } PyMemAllocatorDomain;

/* Alternate spelling used by numpy alongside PyBUF_WRITABLE. */
#ifndef PyBUF_WRITEABLE
#define PyBUF_WRITEABLE PyBUF_WRITABLE
#endif

/* Legacy sequence slot typedefs (pre-ssizeargfunc era, still referenced). */
typedef PyObject *(*ssizessizeargfunc)(PyObject *, Py_ssize_t, Py_ssize_t);
typedef int (*ssizessizeobjargproc)(PyObject *, Py_ssize_t, Py_ssize_t, PyObject *);

/* PyHeapTypeObject — numpy 2.x dtype_api.h EMBEDS it (PyArray_DTypeMeta's
 * `super` field), so the LAYOUT matters to numpy's own struct sizes. Field
 * order mirrors CPython 3.14's. The bridge only ever touches ht_type. */
typedef struct _heaptypeobject {
    PyTypeObject ht_type;
    PyNumberMethods as_number;
    PyMappingMethods as_mapping;
    PySequenceMethods as_sequence;
    PyBufferProcs as_buffer;
    PyObject *ht_name, *ht_slots, *ht_qualname;
    void *ht_cached_keys;
    PyObject *ht_module;
    char *_ht_tpname;
    /* appended (torch/pybind11 ≥2.12: `type->tp_as_async = &heap_type->
     * as_async`); at the END so existing field offsets are stable */
    PyAsyncMethods as_async;
} PyHeapTypeObject;

/* Capsule destructor type (capsule creation exists; context/import below). */
typedef void (*PyCapsule_Destructor)(PyObject *);

/* C-level recursion guard — the bridge runs single-threaded on the JS
 * stack; these are declared for numpy and implemented as counters. */
int  Py_EnterRecursiveCall(const char *where);
void Py_LeaveRecursiveCall(void);

/* Missing-at-link list from the numpy 2.5.1 phase-0/1 inventory
 * (NUMPY.md on the numpy branch): declared here, implemented by batches. */
int PyObject_AsFileDescriptor(PyObject *);
PyObject *PyObject_Bytes(PyObject *);
PyObject *PyObject_Format(PyObject *, PyObject *);
int PyObject_Not(PyObject *);
Py_ssize_t PyObject_LengthHint(PyObject *, Py_ssize_t);
int PyObject_Print(PyObject *, FILE *, int);
PyObject *PyObject_GenericGetDict(PyObject *, void *);
PyObject *PySeqIter_New(PyObject *);
PyObject *PySequence_Concat(PyObject *, PyObject *);
int PySequence_Contains(PyObject *, PyObject *);
PyObject *PySequence_InPlaceConcat(PyObject *, PyObject *);
PyObject *PySequence_InPlaceRepeat(PyObject *, Py_ssize_t);
PyObject *PySlice_New(PyObject *, PyObject *, PyObject *);
PyObject *PyNumber_Invert(PyObject *);
PyObject *PyNumber_Negative(PyObject *);
PyObject *PyNumber_Positive(PyObject *);
PyObject *PyNumber_Lshift(PyObject *, PyObject *);
PyObject *PyNumber_Rshift(PyObject *, PyObject *);
PyObject *PyNumber_Or(PyObject *, PyObject *);
PyObject *PyNumber_Xor(PyObject *, PyObject *);
double PyComplex_RealAsDouble(PyObject *);
double PyComplex_ImagAsDouble(PyObject *);
int PyLong_IsZero(PyObject *);
PyObject *PyLong_FromUnicodeObject(PyObject *, int);
int PyDict_ContainsString(PyObject *, const char *);
PyObject *PyDict_Copy(PyObject *);
int PyDict_DelItemString(PyObject *, const char *);
int PyDict_GetItemStringRef(PyObject *, const char *, PyObject **);
int PyDict_Merge(PyObject *, PyObject *, int);
PyObject *PyDict_Values(PyObject *);
PyObject *PyMapping_GetItemString(PyObject *, const char *);
int PyUnicode_Contains(PyObject *, PyObject *);
PyObject *PyUnicode_Format(PyObject *, PyObject *);
PyObject *PyUnicode_Replace(PyObject *, PyObject *, PyObject *, Py_ssize_t);
Py_ssize_t PyUnicode_Tailmatch(PyObject *, PyObject *, Py_ssize_t, Py_ssize_t, int);
PyObject *PyBytes_FromString(const char *);
int PyErr_GivenExceptionMatches(PyObject *, PyObject *);
void PyErr_NormalizeException(PyObject **, PyObject **, PyObject **);
int PyErr_WarnFormat(PyObject *, Py_ssize_t, const char *, ...);
void PyErr_WriteUnraisable(PyObject *);
void PyException_SetCause(PyObject *, PyObject *);
void PyException_SetContext(PyObject *, PyObject *);
int PyException_SetTraceback(PyObject *, PyObject *);  /* CPython: returns 0/-1 */
PyObject *PyCapsule_Import(const char *, int);
int PyCapsule_IsValid(PyObject *, const char *);
void *PyCapsule_GetContext(PyObject *);
int PyCapsule_SetContext(PyObject *, void *);
int PyCapsule_SetName(PyObject *, const char *);
PyObject *PyEval_GetBuiltins(void);
PyObject *PySys_GetObject(const char *);
PyObject *PyMethod_New(PyObject *, PyObject *);
unsigned long PyType_GetFlags(PyTypeObject *);
void PyType_Modified(PyTypeObject *);
PyObject *PyVectorcall_Call(PyObject *, PyObject *, PyObject *);
PyObject *PyObject_VectorcallMethod(PyObject *, PyObject *const *, size_t, PyObject *);
int PyContextVar_Get(PyObject *, PyObject *, PyObject **);
PyObject *PyContextVar_New(const char *, PyObject *);
PyObject *PyContextVar_Set(PyObject *, PyObject *);
int PyTraceMalloc_Track(unsigned int, uintptr_t, size_t);
int PyTraceMalloc_Untrack(unsigned int, uintptr_t);
int PyUnstable_Object_IsUniquelyReferenced(PyObject *);
int PyUnstable_Object_IsUniqueReferencedTemporary(PyObject *);
void _Py_SetImmortal(PyObject *);
PyObject *PyBytes_FromFormatV(const char *, va_list);
PyObject *PyUnicode_FromFormatV(const char *, va_list);
int Py_IsInitialized(void);
long PyOS_strtol(const char *, char **, int);
unsigned long PyOS_strtoul(const char *, char **, int);
double _Py_HashDouble(PyObject *, double);
extern const unsigned char _Py_ascii_whitespace[];
extern PyTypeObject PyComplex_Type, PyCFunction_Type, PyMemberDescr_Type,
    PyGetSetDescr_Type, PyMethodDescr_Type, PyDictProxy_Type, PySlice_Type,
    PyBaseObject_Type, PyMemoryView_Type, PyCapsule_Type, PyProperty_Type,
    PyRange_Type;
extern PyObject *PyExc_NameError, *PyExc_UserWarning, *PyExc_FloatingPointError,
    *PyExc_ImportWarning, *PyExc_ModuleNotFoundError;
/* Exception-instance class accessor (pyerrors.h) */
#ifndef PyExceptionInstance_Class
#define PyExceptionInstance_Class(x) ((PyObject *)Py_TYPE(x))
#endif

#ifndef PyComplex_CheckExact
#define PyComplex_CheckExact(op) Py_IS_TYPE(op, &PyComplex_Type)
#endif

/* pymacro.h helpers numpy's loops use */
#ifndef Py_MAX
#define Py_MAX(x, y) (((x) > (y)) ? (x) : (y))
#endif
#ifndef Py_ABS
#define Py_ABS(x) ((x) < 0 ? -(x) : (x))
#endif

/* Remaining standard exceptions (numpy's string/assert paths) */
extern PyObject *PyExc_AssertionError, *PyExc_GeneratorExit, *PyExc_KeyboardInterrupt,
    *PyExc_StopAsyncIteration, *PyExc_UnicodeWarning, *PyExc_BytesWarning,
    *PyExc_ConnectionError, *PyExc_BlockingIOError, *PyExc_SystemExit,
    *PyExc_PendingDeprecationWarning, *PyExc_EnvironmentError, *PyExc_TabError,
    *PyExc_UnboundLocalError, *PyExc_UnicodeTranslateError, *PyExc_EncodingWarning;

/* UCS4 character classification (CPython unicodectype) — numpy's string
 * ufuncs call these per code point; JS-side implementations at link. */
int _PyUnicode_IsUppercase(Py_UCS4);
int _PyUnicode_IsLowercase(Py_UCS4);
int _PyUnicode_IsTitlecase(Py_UCS4);
int _PyUnicode_IsDecimalDigit(Py_UCS4);
int _PyUnicode_IsDigit(Py_UCS4);
int _PyUnicode_IsNumeric(Py_UCS4);
int _PyUnicode_IsAlpha(Py_UCS4);
int _PyUnicode_IsWhitespace(Py_UCS4);
#define Py_UNICODE_ISUPPER(ch)   _PyUnicode_IsUppercase(ch)
#define Py_UNICODE_ISLOWER(ch)   _PyUnicode_IsLowercase(ch)
#define Py_UNICODE_ISTITLE(ch)   _PyUnicode_IsTitlecase(ch)
#define Py_UNICODE_ISDECIMAL(ch) _PyUnicode_IsDecimalDigit(ch)
#define Py_UNICODE_ISDIGIT(ch)   _PyUnicode_IsDigit(ch)
#define Py_UNICODE_ISNUMERIC(ch) _PyUnicode_IsNumeric(ch)
#define Py_UNICODE_ISALPHA(ch)   _PyUnicode_IsAlpha(ch)
#define Py_UNICODE_ISSPACE(ch)   _PyUnicode_IsWhitespace(ch)
#define Py_UNICODE_ISALNUM(ch) \
    (Py_UNICODE_ISALPHA(ch) || Py_UNICODE_ISDECIMAL(ch) || \
     Py_UNICODE_ISDIGIT(ch) || Py_UNICODE_ISNUMERIC(ch))

/* Linkage macros — everything is statically linked in the wasm module. */
#ifndef PyAPI_FUNC
#define PyAPI_FUNC(RTYPE) RTYPE
#define PyAPI_DATA(RTYPE) extern RTYPE
#endif
/* The bridge's per-handle count. A handle is NOT a struct pointer: reading
 * ((PyObject*)op)->ob_refcnt dereferenced low heap memory and returned
 * garbage (pybind11's try_incref asserts Py_REFCNT > 0 and aborted). */
Py_ssize_t _wasthon_py_refcnt(PyObject *op);
#ifndef Py_REFCNT
#define Py_REFCNT(op) _wasthon_py_refcnt((PyObject *)(op))
#endif

/* Type flags numpy tests (informational on the bridge side). */
#ifndef Py_TPFLAGS_METHOD_DESCRIPTOR
#define Py_TPFLAGS_METHOD_DESCRIPTOR (1UL << 17)
#endif
#ifndef Py_TPFLAGS_HAVE_VECTORCALL
#define Py_TPFLAGS_HAVE_VECTORCALL (1UL << 11)
#endif
#ifndef _Py_TPFLAGS_HAVE_VECTORCALL
#define _Py_TPFLAGS_HAVE_VECTORCALL Py_TPFLAGS_HAVE_VECTORCALL
#endif

/* C-side views of builtin-method and descriptor objects (CPython-3.14 field
 * shapes): numpy READS m_ml/d_getset/d_member for its doc/introspection
 * paths. RUNTIME NOTE: bridge handles are not these structs — the paths
 * that cast a handle to them must go through materialized shells. */
typedef struct {
    PyObject_HEAD
    PyMethodDef *m_ml;
    PyObject *m_self, *m_module, *m_weakreflist;
    void *vectorcall;
} PyCFunctionObject;
typedef struct {
    PyObject_HEAD
    PyTypeObject *d_type;
    PyObject *d_name, *d_qualname;
} PyDescrObject;
typedef struct { PyDescrObject d_common; PyGetSetDef *d_getset; } PyGetSetDescrObject;
typedef struct { PyDescrObject d_common; PyMemberDef *d_member; } PyMemberDescrObject;
typedef struct { PyDescrObject d_common; PyMethodDef *d_method; void *vectorcall; } PyMethodDescrObject;

/* Unicode object C shapes, CPython-3.14 field-for-field (numpy's unicode
 * SCALAR embeds PyUnicodeObject BY VALUE in arrayscalars.h, and its vendored
 * pythoncapi-compat reads PyASCIIObject->hash). Sizes differ from CPython's
 * because the shim PyObject_HEAD is one word — internally consistent, which
 * is what matters. RUNTIME NOTE: bridge strings are handles, not these
 * structs — paths that cast a handle to them must go through materialized
 * shells (the bytes/cstr pattern). */
typedef struct {
    PyObject_HEAD
    Py_ssize_t length;
    Py_hash_t hash;
    struct {
        unsigned int interned:2;
        unsigned int kind:3;
        unsigned int compact:1;
        unsigned int ascii:1;
        unsigned int statically_allocated:1;
        unsigned int :24;
    } state;
} PyASCIIObject;
typedef struct {
    PyASCIIObject _base;
    Py_ssize_t utf8_length;
    char *utf8;
} PyCompactUnicodeObject;
typedef struct {
    PyCompactUnicodeObject _base;
    void *data;
} PyUnicodeObject;

/* pyport.h attribute helper (pythoncapi-compat declares with it). */
#ifndef Py_GCC_ATTRIBUTE
#define Py_GCC_ATTRIBUTE(x) __attribute__(x)
#endif

#include <ctype.h>   /* CPython's Python.h pulls it in; numpy relies on that */
#ifndef PY_LONG_LONG
#define PY_LONG_LONG long long   /* pyport.h; numpy's FMT/SUFFIX blocks gate on it */
#endif
void Py_SET_REFCNT(PyObject *, Py_ssize_t);
typedef struct _is PyInterpreterState;
PyThreadState *PyThreadState_Get(void);
PyInterpreterState *PyInterpreterState_Main(void);
/* numpy's sub-interpreter guard reads tstate->interp; the bridge is a
 * single runtime: both sides return the same singleton. */
#undef Py_GenericAlias
PyObject *Py_GenericAlias(PyObject *, PyObject *);
#ifndef PyMemoryView_Check
#define PyMemoryView_Check(op) Py_IS_TYPE(op, &PyMemoryView_Type)
#endif
PyObject *PyMemoryView_GET_BASE(PyObject *);
#ifndef _PyObject_VAR_SIZE
#define _PyObject_VAR_SIZE(typeobj, nitems) \
    ((size_t)(typeobj)->tp_basicsize + (size_t)(nitems) * (size_t)(typeobj)->tp_itemsize)
#endif

PyObject *PyObject_Init(PyObject *, PyTypeObject *);
PyVarObject *PyObject_InitVar(PyVarObject *, PyTypeObject *, Py_ssize_t);
PyObject *_PyObject_New(PyTypeObject *);
PyVarObject *_PyObject_NewVar(PyTypeObject *, Py_ssize_t);
int PyArg_VaParseTupleAndKeywords(PyObject *, PyObject *, const char *, char **, va_list);
#ifndef PyObject_NewVar
#define PyObject_NewVar(type, typeobj, n) ((type *)_PyObject_NewVar((typeobj), (n)))
#endif
#ifndef PyObject_FREE
#define PyObject_FREE PyObject_Free
#endif

#ifdef __cplusplus
}
#endif

#endif /* WASTHON_H */
