/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_private — the private C-API (_Py*) CPython exports for its own
 * extension modules, which the bridge implements for them
 * (tests/test_private.py). CPython's installed headers keep these behind
 * Py_BUILD_CORE, so the declarations are here, with CPython's signatures;
 * it builds against CPython, the reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <stdint.h>
#include <string.h>
#include <time.h>

#ifndef WASTHON_H
PyAPI_FUNC(void) _PyArg_BadArgument(const char *, const char *, const char *, PyObject *);
PyAPI_FUNC(int) _PyArg_NoKeywords(const char *, PyObject *);
PyAPI_FUNC(int) _PyArg_NoPositional(const char *, PyObject *);
PyAPI_FUNC(int) _PyArg_CheckPositional(const char *, Py_ssize_t, Py_ssize_t, Py_ssize_t);
PyAPI_FUNC(int) _PyLong_UnsignedLong_Converter(PyObject *, void *);
PyAPI_FUNC(const char *) _PyUnicode_AsUTF8NoNUL(PyObject *);
PyAPI_FUNC(int) _PyUnicode_Equal(PyObject *, PyObject *);
PyAPI_FUNC(int) _PyUnicode_EqualToASCIIString(PyObject *, const char *);
PyAPI_FUNC(PyObject *) _PyDict_GetItem_KnownHash(PyObject *, PyObject *, Py_hash_t);
PyAPI_FUNC(int) _PySet_NextEntryRef(PyObject *, Py_ssize_t *, PyObject **, Py_hash_t *);
PyAPI_FUNC(int) _PySet_Update(PyObject *, PyObject *);
PyAPI_FUNC(const char *) _PyType_Name(PyTypeObject *);
PyAPI_FUNC(PyObject *) _PyType_Lookup(PyTypeObject *, PyObject *);
PyAPI_FUNC(PyObject *) _PyType_LookupRef(PyTypeObject *, PyObject *);
PyAPI_FUNC(PyObject *) _Py_strhex(const char *, const Py_ssize_t);
PyAPI_FUNC(PyObject *) _Py_strhex_bytes_with_sep(const char *, const Py_ssize_t, PyObject *, const int);
PyAPI_FUNC(int) _Py_convert_optional_to_ssize_t(PyObject *, void *);
PyAPI_FUNC(Py_hash_t) _Py_HashDouble(PyObject *, double);
PyAPI_FUNC(PyObject *) _PyObject_GetState(PyObject *);
PyAPI_FUNC(int) _PyTime_ObjectToTime_t(PyObject *, time_t *, int);
PyAPI_FUNC(int) _PyTime_localtime(time_t, struct tm *);
PyAPI_FUNC(PyObject *) _PyLong_DivmodNear(PyObject *, PyObject *);
PyAPI_FUNC(double) _PyLong_Frexp(PyLongObject *, int64_t *);
PyAPI_FUNC(PyObject *) _PyLong_Lshift(PyObject *, int64_t);
PyAPI_FUNC(PyObject *) _PyLong_Rshift(PyObject *, int64_t);
PyAPI_FUNC(PyObject *) _PyErr_FormatFromCause(PyObject *, const char *, ...);
PyAPI_FUNC(void) _PyErr_ChainExceptions1(PyObject *);
PyAPI_FUNC(PyObject *) _PyObject_MaybeCallSpecialNoArgs(PyObject *, PyObject *);
PyAPI_FUNC(PyObject *) _PyEval_GetBuiltin(PyObject *);
PyAPI_FUNC(void) _PyBytes_Repeat(char *, Py_ssize_t, const char *, Py_ssize_t);
PyAPI_FUNC(int) _PyEval_SliceIndexNotNone(PyObject *, Py_ssize_t *);
PyAPI_FUNC(size_t) _PySys_GetSizeOf(PyObject *);
PyAPI_FUNC(PyObject *) _PySys_GetRequiredAttr(PyObject *);
PyAPI_FUNC(char *) _PyMem_Strdup(const char *);
#endif

#ifdef WASTHON_H
/* implemented by src/wasthon.js, not declared in src/wasthon.h */
#define _Py_HashDouble(inst, v) ((Py_hash_t)_Py_HashDouble((inst), (v)))   /* declared double there */
#endif
PyAPI_FUNC(int) _PyOS_URandomNonblock(void *, Py_ssize_t);
PyAPI_FUNC(int) _PyLong_UInt64_Converter(PyObject *, void *);
PyAPI_FUNC(int) _PyLong_UInt32_Converter(PyObject *, void *);
PyAPI_FUNC(int) _PyLong_UnsignedLongLong_Converter(PyObject *, void *);
PyAPI_FUNC(PyObject *) _PyUnicode_Copy(PyObject *);
PyAPI_FUNC(PyObject *) _PyUnicode_JoinArray(PyObject *, PyObject *const *, Py_ssize_t);
PyAPI_FUNC(int) _PyDict_SetItem_KnownHash(PyObject *, PyObject *, PyObject *, Py_hash_t);
PyAPI_FUNC(void) _PyErr_FormatNote(const char *, ...);
PyAPI_FUNC(PyObject *) _PyNumber_Index(PyObject *);
PyAPI_FUNC(int64_t) _PyLong_NumBits(PyObject *);
PyAPI_FUNC(int) _PyLong_AsByteArray(PyLongObject *, unsigned char *, size_t, int, int, int);
typedef struct _Py_hashtable_t _Py_hashtable_t;
PyAPI_FUNC(_Py_hashtable_t *) _Py_hashtable_new_full(Py_uhash_t (*)(const void *),
    int (*)(const void *, const void *), void (*)(void *), void (*)(void *), void *);
PyAPI_FUNC(int) _Py_hashtable_set(_Py_hashtable_t *, const void *, void *);
PyAPI_FUNC(void *) _Py_hashtable_get(_Py_hashtable_t *, const void *);
PyAPI_FUNC(void) _Py_hashtable_destroy(_Py_hashtable_t *);

/* ---- argument helpers --------------------------------------------------------- */

static PyObject *bad_argument(PyObject *m, PyObject *arg) {
    _PyArg_BadArgument("f", "argument 1", "int", arg);
    return NULL;
}
static PyObject *no_keywords(PyObject *m, PyObject *kw) {
    return _PyArg_NoKeywords("f", kw == Py_None ? NULL : kw) ? Py_NewRef(Py_True) : NULL;
}
static PyObject *no_positional(PyObject *m, PyObject *args) {
    return _PyArg_NoPositional("f", args == Py_None ? NULL : args) ? Py_NewRef(Py_True) : NULL;
}
static PyObject *check_positional(PyObject *m, PyObject *a) {
    Py_ssize_t n, lo, hi;
    if (!PyArg_ParseTuple(a, "nnn", &n, &lo, &hi)) return NULL;
    return _PyArg_CheckPositional("f", n, lo, hi) ? Py_NewRef(Py_True) : NULL;
}
/* one converter by name, on o: the C value, as an int */
static PyObject *converter(PyObject *m, PyObject *a) {
    const char *which; PyObject *o;
    if (!PyArg_ParseTuple(a, "sO", &which, &o)) return NULL;
    if (!strcmp(which, "uint32")) {
        uint32_t v; return _PyLong_UInt32_Converter(o, &v) ? PyLong_FromUnsignedLong(v) : NULL;
    }
    if (!strcmp(which, "uint64")) {
        uint64_t v; return _PyLong_UInt64_Converter(o, &v) ? PyLong_FromUnsignedLongLong(v) : NULL;
    }
    if (!strcmp(which, "ulong")) {
        unsigned long v; return _PyLong_UnsignedLong_Converter(o, &v) ? PyLong_FromUnsignedLong(v) : NULL;
    }
    if (!strcmp(which, "ssize")) {
        Py_ssize_t v = -7;
        return _Py_convert_optional_to_ssize_t(o, &v) ? PyLong_FromSsize_t(v) : NULL;
    }
    unsigned long long v;
    return _PyLong_UnsignedLongLong_Converter(o, &v) ? PyLong_FromUnsignedLongLong(v) : NULL;
}

/* ---- str, dict, set --------------------------------------------------------------- */

static PyObject *unicode_copy(PyObject *m, PyObject *s) {
    PyObject *c = _PyUnicode_Copy(s);
    return c ? Py_BuildValue("NN", c, PyBool_FromLong(c != s)) : NULL;
}
static PyObject *unicode_join_array(PyObject *m, PyObject *a) {
    PyObject *sep, *items;
    if (!PyArg_ParseTuple(a, "OO!", &sep, &PyTuple_Type, &items)) return NULL;
    PyObject *arr[8];
    Py_ssize_t n = PyTuple_Size(items);
    for (Py_ssize_t i = 0; i < n; i++) arr[i] = PyTuple_GetItem(items, i);
    return _PyUnicode_JoinArray(sep, arr, n);
}
static PyObject *unicode_as_utf8_no_nul(PyObject *m, PyObject *s) {
    const char *p = _PyUnicode_AsUTF8NoNUL(s);
    return p ? PyBytes_FromString(p) : NULL;
}
static PyObject *unicode_equal(PyObject *m, PyObject *a) {
    PyObject *x, *y; const char *ascii;
    if (!PyArg_ParseTuple(a, "UUs", &x, &y, &ascii)) return NULL;
    return Py_BuildValue("ii", _PyUnicode_Equal(x, y), _PyUnicode_EqualToASCIIString(x, ascii));
}
static PyObject *dict_known_hash(PyObject *m, PyObject *a) {
    PyObject *d, *k, *v;
    if (!PyArg_ParseTuple(a, "OOO", &d, &k, &v)) return NULL;
    Py_hash_t h = PyObject_Hash(k);
    if (h == -1 || _PyDict_SetItem_KnownHash(d, k, v, h) < 0) return NULL;
    PyObject *r = _PyDict_GetItem_KnownHash(d, k, h);      /* borrowed */
    return r ? Py_NewRef(r) : NULL;
}
/* _PySet_Update then the keys _PySet_NextEntryRef walks, sorted by the test */
static PyObject *set_update_walk(PyObject *m, PyObject *a) {
    PyObject *s, *it;
    if (!PyArg_ParseTuple(a, "OO", &s, &it)) return NULL;
    if (_PySet_Update(s, it) < 0) return NULL;
    PyObject *l = PyList_New(0), *key;
    Py_ssize_t pos = 0; Py_hash_t h;
    while (_PySet_NextEntryRef(s, &pos, &key, &h)) {
        int ok = h == PyObject_Hash(key);
        PyList_Append(l, ok ? key : Py_None);
        Py_DECREF(key);
    }
    return l;
}

/* ---- types, objects, attribute lookup ---------------------------------------------- */

static PyObject *type_name(PyObject *m, PyObject *t) { return PyUnicode_FromString(_PyType_Name((PyTypeObject *)t)); }
static PyObject *type_lookup(PyObject *m, PyObject *a) {
    PyObject *t, *name;
    if (!PyArg_ParseTuple(a, "OU", &t, &name)) return NULL;
    PyObject *x = _PyType_Lookup((PyTypeObject *)t, name);           /* borrowed */
    PyObject *y = _PyType_LookupRef((PyTypeObject *)t, name);        /* new */
    return Py_BuildValue("ON", x ? x : Py_None, y ? y : Py_NewRef(Py_None));
}
static PyObject *maybe_call_special(PyObject *m, PyObject *a) {
    PyObject *o, *name;
    if (!PyArg_ParseTuple(a, "OU", &o, &name)) return NULL;
    PyObject *r = _PyObject_MaybeCallSpecialNoArgs(o, name);
    if (!r && PyErr_Occurred()) return NULL;
    return r ? r : Py_NewRef(Py_Ellipsis);
}
static PyObject *get_state(PyObject *m, PyObject *o) { return _PyObject_GetState(o); }
static PyObject *number_index(PyObject *m, PyObject *o) { return _PyNumber_Index(o); }
static PyObject *eval_builtin(PyObject *m, PyObject *name) { return _PyEval_GetBuiltin(name); }
static PyObject *slice_index(PyObject *m, PyObject *o) {
    Py_ssize_t i = -1;
    return _PyEval_SliceIndexNotNone(o, &i) ? PyLong_FromSsize_t(i) : NULL;
}
static PyObject *sys_sizeof(PyObject *m, PyObject *o) {
    size_t n = _PySys_GetSizeOf(o);
    return n == (size_t)-1 && PyErr_Occurred() ? NULL : PyLong_FromSize_t(n);
}
static PyObject *sys_required(PyObject *m, PyObject *name) { return _PySys_GetRequiredAttr(name); }

/* ---- int internals --------------------------------------------------------------------- */

static PyObject *long_internals(PyObject *m, PyObject *a) {
    PyObject *x, *y; long long k;
    if (!PyArg_ParseTuple(a, "OOL", &x, &y, &k)) return NULL;
    int64_t e;
    double mant = _PyLong_Frexp((PyLongObject *)x, &e);
    unsigned char buf[16];
    if (_PyLong_AsByteArray((PyLongObject *)x, buf, 4, 1, 1, 1) < 0) return NULL;
    return Py_BuildValue("NdLNNLy#", _PyLong_DivmodNear(x, y), mant, (long long)e,
                         _PyLong_Lshift(x, k), _PyLong_Rshift(x, k), (long long)_PyLong_NumBits(x),
                         (const char *)buf, (Py_ssize_t)4);
}

/* ---- errors -------------------------------------------------------------------------- */

/* KeyError('k') raised, then _PyErr_FormatFromCause(ValueError, ...) */
static PyObject *format_from_cause(PyObject *m, PyObject *u) {
    PyErr_SetString(PyExc_KeyError, "k");
    return _PyErr_FormatFromCause(PyExc_ValueError, "wrapped %d", 7);
}
static PyObject *format_note(PyObject *m, PyObject *u) {
    PyErr_SetString(PyExc_KeyError, "k");
    _PyErr_FormatNote("note %d", 3);
    return NULL;
}
/* exc is chained under a new ValueError('outer') as its __context__ */
static PyObject *chain_exceptions(PyObject *m, PyObject *exc) {
    PyErr_SetString(PyExc_ValueError, "outer");
    PyObject *outer = PyErr_GetRaisedException();
    PyErr_SetRaisedException(Py_NewRef(exc));
    _PyErr_ChainExceptions1(outer);
    return NULL;
}

/* ---- bytes, hex, memory, time, hashes, random ---------------------------------------------- */

static PyObject *bytes_repeat(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t n; Py_ssize_t times;
    if (!PyArg_ParseTuple(a, "y#n", &s, &n, &times)) return NULL;
    char out[64];
    _PyBytes_Repeat(out, n * times, s, n);
    return PyBytes_FromStringAndSize(out, n * times);
}
static PyObject *strhex(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t n; PyObject *sep; int group;
    if (!PyArg_ParseTuple(a, "y#Oi", &s, &n, &sep, &group)) return NULL;
    return Py_BuildValue("NN", _Py_strhex(s, n), _Py_strhex_bytes_with_sep(s, n, sep, group));
}
static PyObject *mem_strdup(PyObject *m, PyObject *a) {
    const char *s;
    if (!PyArg_ParseTuple(a, "s", &s)) return NULL;
    char *d = _PyMem_Strdup(s);
    if (!d) return PyErr_NoMemory();
    PyObject *r = Py_BuildValue("sN", d, PyBool_FromLong(d != s));
    PyMem_Free(d);
    return r;
}
static PyObject *time_convert(PyObject *m, PyObject *a) {
    PyObject *o; int round;
    if (!PyArg_ParseTuple(a, "Oi", &o, &round)) return NULL;
    time_t sec;
    if (_PyTime_ObjectToTime_t(o, &sec, round) < 0) return NULL;
    struct tm tm;
    if (_PyTime_localtime(sec, &tm) < 0) return NULL;
    return Py_BuildValue("Li", (long long)sec, tm.tm_year + 1900);
}
static PyObject *hash_double(PyObject *m, PyObject *a) {
    double v;
    return PyArg_ParseTuple(a, "d", &v) ? PyLong_FromSsize_t(_Py_HashDouble(Py_None, v)) : NULL;
}
static PyObject *urandom(PyObject *m, PyObject *a) {
    Py_ssize_t n;
    if (!PyArg_ParseTuple(a, "n", &n)) return NULL;
    char buf[64];
    if (_PyOS_URandomNonblock(buf, n) < 0) return NULL;
    return PyBytes_FromStringAndSize(buf, n);
}
static Py_uhash_t int_hash(const void *key) { return (Py_uhash_t)(uintptr_t)key; }
static int int_compare(const void *a, const void *b) { return a == b; }
/* keys 1..3 mapped to 10..30, then the values found for 1..4 (0 when absent) */
static PyObject *hashtable(PyObject *m, PyObject *u) {
    _Py_hashtable_t *ht = _Py_hashtable_new_full(int_hash, int_compare, NULL, NULL, NULL);
    if (!ht) return PyErr_NoMemory();
    for (uintptr_t k = 1; k <= 3; k++) _Py_hashtable_set(ht, (void *)k, (void *)(k * 10));
    PyObject *l = PyList_New(0);
    for (uintptr_t k = 1; k <= 4; k++) {
        PyObject *v = PyLong_FromSize_t((size_t)(uintptr_t)_Py_hashtable_get(ht, (void *)k));
        PyList_Append(l, v);
        Py_DECREF(v);
    }
    _Py_hashtable_destroy(ht);
    return l;
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
static PyMethodDef methods[] = {
    M(bad_argument, METH_O), M(no_keywords, METH_O), M(no_positional, METH_O),
    M(check_positional, METH_VARARGS), M(converter, METH_VARARGS),
    M(unicode_copy, METH_O), M(unicode_join_array, METH_VARARGS), M(unicode_as_utf8_no_nul, METH_O),
    M(unicode_equal, METH_VARARGS), M(dict_known_hash, METH_VARARGS), M(set_update_walk, METH_VARARGS),
    M(type_name, METH_O), M(type_lookup, METH_VARARGS), M(maybe_call_special, METH_VARARGS),
    M(get_state, METH_O), M(number_index, METH_O), M(eval_builtin, METH_O), M(slice_index, METH_O),
    M(sys_sizeof, METH_O), M(sys_required, METH_O), M(long_internals, METH_VARARGS),
    M(format_from_cause, METH_NOARGS), M(format_note, METH_NOARGS), M(chain_exceptions, METH_O),
    M(bytes_repeat, METH_VARARGS), M(strhex, METH_VARARGS), M(mem_strdup, METH_VARARGS),
    M(time_convert, METH_VARARGS), M(hash_double, METH_VARARGS), M(urandom, METH_VARARGS),
    M(hashtable, METH_NOARGS),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_private", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_private(void) { return PyModule_Create(&def); }
