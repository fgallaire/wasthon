/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_container — the bridge's list, tuple, dict, set, sequence, mapping,
 * slice, bytearray and memoryview C-API, one thin fixture per function
 * (tests/test_container.py). Plain C-API: it also builds against CPython,
 * the reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <string.h>

/* CPython's declarations, which src/wasthon.h lacks although src/wasthon.js
 * implements them (identical to CPython's, so harmless there). */
PyAPI_FUNC(int) PySet_Add(PyObject *set, PyObject *key);
PyAPI_FUNC(int) PySet_Discard(PyObject *set, PyObject *key);
PyAPI_FUNC(Py_ssize_t) PySet_Size(PyObject *anyset);
PyAPI_FUNC(int) PySet_Contains(PyObject *anyset, PyObject *key);
PyAPI_FUNC(PyObject *) PySet_Pop(PyObject *set);

/* ---- list ------------------------------------------------------------------ */

/* PyList_New, SetItem, Append, Insert: [a, b] then append c, insert d at 0 */
static PyObject *list_build(PyObject *m, PyObject *a) {
    PyObject *x, *y, *c, *d;
    if (!PyArg_ParseTuple(a, "OOOO", &x, &y, &c, &d)) return NULL;
    PyObject *l = PyList_New(2);
    if (!l) return NULL;
    PyList_SetItem(l, 0, Py_NewRef(x));
    PyList_SetItem(l, 1, Py_NewRef(y));
    if (PyList_Append(l, c) < 0 || PyList_Insert(l, 0, d) < 0) { Py_DECREF(l); return NULL; }
    return l;
}
static PyObject *list_get_item(PyObject *m, PyObject *a) {
    PyObject *l; Py_ssize_t i;
    if (!PyArg_ParseTuple(a, "On", &l, &i)) return NULL;
    PyObject *r = PyList_GetItem(l, i);          /* borrowed */
    return r ? Py_NewRef(r) : NULL;
}
static PyObject *list_size(PyObject *m, PyObject *l) {
    Py_ssize_t n = PyList_Size(l);
    return n < 0 ? NULL : PyLong_FromSsize_t(n);
}
static PyObject *list_sort(PyObject *m, PyObject *l) {
    return PyList_Sort(l) < 0 ? NULL : Py_NewRef(l);
}
static PyObject *list_set_slice(PyObject *m, PyObject *a) {
    PyObject *l, *v; Py_ssize_t lo, hi;
    if (!PyArg_ParseTuple(a, "OnnO", &l, &lo, &hi, &v)) return NULL;
    return PyList_SetSlice(l, lo, hi, v == Py_None ? NULL : v) < 0 ? NULL : Py_NewRef(l);
}
static PyObject *list_as_tuple(PyObject *m, PyObject *l) { return PyList_AsTuple(l); }
static PyObject *list_check_exact(PyObject *m, PyObject *o) { return PyBool_FromLong(PyList_CheckExact(o)); }

/* ---- tuple ------------------------------------------------------------------ */

static PyObject *tuple_build(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "OO", &x, &y)) return NULL;
    PyObject *t = PyTuple_New(2);
    if (!t) return NULL;
    PyTuple_SetItem(t, 0, Py_NewRef(x));
    PyTuple_SetItem(t, 1, Py_NewRef(y));
    return t;
}
static PyObject *tuple_pack(PyObject *m, PyObject *a) {
    PyObject *x, *y, *z;
    return PyArg_ParseTuple(a, "OOO", &x, &y, &z) ? PyTuple_Pack(3, x, y, z) : NULL;
}
static PyObject *tuple_get_item(PyObject *m, PyObject *a) {
    PyObject *t; Py_ssize_t i;
    if (!PyArg_ParseTuple(a, "On", &t, &i)) return NULL;
    PyObject *r = PyTuple_GetItem(t, i);
    return r ? Py_NewRef(r) : NULL;
}
static PyObject *tuple_size(PyObject *m, PyObject *t) {
    Py_ssize_t n = PyTuple_Size(t);
    return n < 0 ? NULL : Py_BuildValue("nn", n, PyTuple_Check(t) ? PyTuple_GET_SIZE(t) : -1);
}
static PyObject *tuple_get_slice(PyObject *m, PyObject *a) {
    PyObject *t; Py_ssize_t lo, hi;
    return PyArg_ParseTuple(a, "Onn", &t, &lo, &hi) ? PyTuple_GetSlice(t, lo, hi) : NULL;
}
static PyObject *tuple_check_exact(PyObject *m, PyObject *o) { return PyBool_FromLong(PyTuple_CheckExact(o)); }

/* ---- dict --------------------------------------------------------------------- */

static PyObject *dict_build(PyObject *m, PyObject *a) {
    PyObject *k, *v;
    if (!PyArg_ParseTuple(a, "OO", &k, &v)) return NULL;
    PyObject *d = PyDict_New();
    if (!d) return NULL;
    if (PyDict_SetItem(d, k, v) < 0 || PyDict_SetItemString(d, "s", v) < 0) { Py_DECREF(d); return NULL; }
    return d;
}
/* (GetItem, GetItemWithError, GetItemString) — None where C got NULL */
static PyObject *dict_get(PyObject *m, PyObject *a) {
    PyObject *d, *k;
    if (!PyArg_ParseTuple(a, "OO", &d, &k)) return NULL;
    PyObject *x = PyDict_GetItem(d, k);
    PyObject *y = PyDict_GetItemWithError(d, k);
    if (!y && PyErr_Occurred()) return NULL;
    PyObject *z = PyUnicode_Check(k) ? PyDict_GetItemString(d, PyUnicode_AsUTF8(k)) : NULL;
    return Py_BuildValue("OOO", x ? x : Py_None, y ? y : Py_None, z ? z : Py_None);
}
/* (GetItemRef result, value), (GetItemStringRef result, value) */
static PyObject *dict_get_ref(PyObject *m, PyObject *a) {
    PyObject *d, *k, *v, *w;
    const char *s;
    if (!PyArg_ParseTuple(a, "OOs", &d, &k, &s)) return NULL;
    int r = PyDict_GetItemRef(d, k, &v);
    if (r < 0) return NULL;
    int q = PyDict_GetItemStringRef(d, s, &w);
    if (q < 0) { Py_XDECREF(v); return NULL; }
    return Py_BuildValue("iNiN", r, r ? v : Py_NewRef(Py_None), q, q ? w : Py_NewRef(Py_None));
}
static PyObject *dict_contains(PyObject *m, PyObject *a) {
    PyObject *d, *k;
    if (!PyArg_ParseTuple(a, "OO", &d, &k)) return NULL;
    int r = PyDict_Contains(d, k);
    if (r < 0) return NULL;
    int s = PyUnicode_Check(k) ? PyDict_ContainsString(d, PyUnicode_AsUTF8(k)) : r;
    return s < 0 ? NULL : Py_BuildValue("ii", r, s);
}
static PyObject *dict_del(PyObject *m, PyObject *a) {
    PyObject *d, *k, *s;
    if (!PyArg_ParseTuple(a, "OOU", &d, &k, &s)) return NULL;
    if (PyDict_DelItem(d, k) < 0 || PyDict_DelItemString(d, PyUnicode_AsUTF8(s)) < 0) return NULL;
    return Py_NewRef(d);
}
/* (Size, GET_SIZE, Keys, Values, Items via PyMapping_Items) */
static PyObject *dict_views(PyObject *m, PyObject *d) {
    return Py_BuildValue("nnNNN", PyDict_Size(d), PyDict_GET_SIZE(d), PyDict_Keys(d),
                         PyDict_Values(d), PyMapping_Items(d));
}
static PyObject *dict_clear(PyObject *m, PyObject *d) {
    PyDict_Clear(d);
    return Py_NewRef(d);
}
static PyObject *dict_copy(PyObject *m, PyObject *d) { return PyDict_Copy(d); }
static PyObject *dict_update(PyObject *m, PyObject *a) {
    PyObject *d, *other;
    if (!PyArg_ParseTuple(a, "OO", &d, &other)) return NULL;
    return PyDict_Update(d, other) < 0 ? NULL : Py_NewRef(d);
}
static PyObject *dict_merge(PyObject *m, PyObject *a) {
    PyObject *d, *other; int override;
    if (!PyArg_ParseTuple(a, "OOi", &d, &other, &override)) return NULL;
    return PyDict_Merge(d, other, override) < 0 ? NULL : Py_NewRef(d);
}
/* the (key, value) pairs PyDict_Next walks */
static PyObject *dict_next(PyObject *m, PyObject *d) {
    PyObject *l = PyList_New(0), *k, *v;
    Py_ssize_t pos = 0;
    while (PyDict_Next(d, &pos, &k, &v)) {
        PyObject *p = PyTuple_Pack(2, k, v);
        PyList_Append(l, p);
        Py_DECREF(p);
    }
    return l;
}
/* (Pop result, popped value) */
static PyObject *dict_pop(PyObject *m, PyObject *a) {
    PyObject *d, *k, *v;
    if (!PyArg_ParseTuple(a, "OO", &d, &k)) return NULL;
    int r = PyDict_Pop(d, k, &v);
    if (r < 0) return NULL;
    return Py_BuildValue("iN", r, r ? v : Py_NewRef(Py_None));
}
/* (SetDefaultRef result, the value now in d) */
static PyObject *dict_setdefault(PyObject *m, PyObject *a) {
    PyObject *d, *k, *def, *v;
    if (!PyArg_ParseTuple(a, "OOO", &d, &k, &def)) return NULL;
    int r = PyDict_SetDefaultRef(d, k, def, &v);
    return r < 0 ? NULL : Py_BuildValue("iN", r, v);
}
static PyObject *dict_check(PyObject *m, PyObject *o) {
    return Py_BuildValue("NN", PyBool_FromLong(PyDict_Check(o)), PyBool_FromLong(PyDict_CheckExact(o)));
}
static PyObject *dictproxy_new(PyObject *m, PyObject *d) { return PyDictProxy_New(d); }

/* ---- set ------------------------------------------------------------------------ */

static PyObject *set_new(PyObject *m, PyObject *it) { return PySet_New(it == Py_None ? NULL : it); }
static PyObject *frozenset_new(PyObject *m, PyObject *it) { return PyFrozenSet_New(it == Py_None ? NULL : it); }
/* add x, discard y: (the set, Size, GET_SIZE, Contains(x), discard result) */
static PyObject *set_ops(PyObject *m, PyObject *a) {
    PyObject *s, *x, *y;
    if (!PyArg_ParseTuple(a, "OOO", &s, &x, &y)) return NULL;
    if (PySet_Add(s, x) < 0) return NULL;
    int d = PySet_Discard(s, y);
    if (d < 0) return NULL;
    return Py_BuildValue("OnniN", s, PySet_Size(s), PySet_GET_SIZE(s), PySet_Contains(s, x),
                         PyBool_FromLong(d));
}
static PyObject *set_pop(PyObject *m, PyObject *s) { return PySet_Pop(s); }
static PyObject *set_check(PyObject *m, PyObject *o) { return PyBool_FromLong(PySet_Check(o)); }

/* ---- sequence protocol ------------------------------------------------------------ */

static PyObject *seq_check(PyObject *m, PyObject *o) {
    return Py_BuildValue("NN", PyBool_FromLong(PySequence_Check(o)), PyBool_FromLong(PyMapping_Check(o)));
}
static PyObject *seq_size(PyObject *m, PyObject *o) {
    Py_ssize_t n = PySequence_Size(o);
    return n < 0 ? NULL : PyLong_FromSsize_t(n);
}
static PyObject *seq_get_item(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t i;
    return PyArg_ParseTuple(a, "On", &o, &i) ? PySequence_GetItem(o, i) : NULL;
}
static PyObject *seq_get_slice(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t lo, hi;
    return PyArg_ParseTuple(a, "Onn", &o, &lo, &hi) ? PySequence_GetSlice(o, lo, hi) : NULL;
}
static PyObject *seq_del_item(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t i;
    if (!PyArg_ParseTuple(a, "On", &o, &i)) return NULL;
    return PySequence_DelItem(o, i) < 0 ? NULL : Py_NewRef(o);
}
static PyObject *seq_contains(PyObject *m, PyObject *a) {
    PyObject *o, *x;
    if (!PyArg_ParseTuple(a, "OO", &o, &x)) return NULL;
    int r = PySequence_Contains(o, x);
    return r < 0 ? NULL : PyBool_FromLong(r);
}
static PyObject *seq_concat(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    return PyArg_ParseTuple(a, "OO", &x, &y) ? PySequence_Concat(x, y) : NULL;
}
static PyObject *seq_repeat(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t n;
    return PyArg_ParseTuple(a, "On", &o, &n) ? PySequence_Repeat(o, n) : NULL;
}
/* (result, result is x): an in-place concat of a list changes the list itself */
static PyObject *seq_inplace_concat(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "OO", &x, &y)) return NULL;
    PyObject *r = PySequence_InPlaceConcat(x, y);
    return r ? Py_BuildValue("NN", r, PyBool_FromLong(r == x)) : NULL;
}
static PyObject *seq_inplace_repeat(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t n;
    if (!PyArg_ParseTuple(a, "On", &o, &n)) return NULL;
    PyObject *r = PySequence_InPlaceRepeat(o, n);
    return r ? Py_BuildValue("NN", r, PyBool_FromLong(r == o)) : NULL;
}
static PyObject *seq_list(PyObject *m, PyObject *o) { return PySequence_List(o); }
static PyObject *seq_tuple(PyObject *m, PyObject *o) { return PySequence_Tuple(o); }
/* PySequence_Fast: (size, items read with Fast_GET_ITEM, the same with Fast_ITEMS) */
static PyObject *seq_fast(PyObject *m, PyObject *o) {
    PyObject *f = PySequence_Fast(o, "not a sequence");
    if (!f) return NULL;
    Py_ssize_t n = PySequence_Fast_GET_SIZE(f);
    PyObject **items = PySequence_Fast_ITEMS(f);
    PyObject *a = PyList_New(n), *b = PyList_New(n);
    for (Py_ssize_t i = 0; i < n; i++) {
        PyList_SetItem(a, i, Py_NewRef(PySequence_Fast_GET_ITEM(f, i)));
        PyList_SetItem(b, i, Py_NewRef(items[i]));
    }
    Py_DECREF(f);
    return Py_BuildValue("nNN", n, a, b);
}

/* ---- mapping protocol --------------------------------------------------------------- */

static PyObject *mapping_get_item_string(PyObject *m, PyObject *a) {
    PyObject *o; const char *k;
    return PyArg_ParseTuple(a, "Os", &o, &k) ? PyMapping_GetItemString(o, k) : NULL;
}
/* (GetOptionalItem result, value), (GetOptionalItemString result, value) */
static PyObject *mapping_get_optional(PyObject *m, PyObject *a) {
    PyObject *o, *k, *v, *w;
    if (!PyArg_ParseTuple(a, "OU", &o, &k)) return NULL;
    int r = PyMapping_GetOptionalItem(o, k, &v);
    if (r < 0) return NULL;
    int q = PyMapping_GetOptionalItemString(o, PyUnicode_AsUTF8(k), &w);
    if (q < 0) { Py_XDECREF(v); return NULL; }
    return Py_BuildValue("iNiN", r, r ? v : Py_NewRef(Py_None), q, q ? w : Py_NewRef(Py_None));
}

/* ---- slice ----------------------------------------------------------------------------- */

static PyObject *slice_new(PyObject *m, PyObject *a) {
    PyObject *start, *stop, *step;
    if (!PyArg_ParseTuple(a, "OOO", &start, &stop, &step)) return NULL;
    return PySlice_New(start, stop, step);
}
static PyObject *slice_check(PyObject *m, PyObject *o) { return PyBool_FromLong(PySlice_Check(o)); }
/* PySlice_GetIndicesEx: (start, stop, step, slicelength) */
static PyObject *slice_indices_ex(PyObject *m, PyObject *a) {
    PyObject *s; Py_ssize_t len, start, stop, step, n;
    if (!PyArg_ParseTuple(a, "On", &s, &len)) return NULL;
    if (PySlice_GetIndicesEx(s, len, &start, &stop, &step, &n) < 0) return NULL;
    return Py_BuildValue("nnnn", start, stop, step, n);
}
/* PySlice_Unpack then PySlice_AdjustIndices: (start, stop, step, slicelength) */
static PyObject *slice_unpack_adjust(PyObject *m, PyObject *a) {
    PyObject *s; Py_ssize_t len, start, stop, step;
    if (!PyArg_ParseTuple(a, "On", &s, &len)) return NULL;
    if (PySlice_Unpack(s, &start, &stop, &step) < 0) return NULL;
    Py_ssize_t n = PySlice_AdjustIndices(len, &start, &stop, step);
    return Py_BuildValue("nnnn", start, stop, step, n);
}

/* ---- bytearray, memoryview ---------------------------------------------------------------- */

static PyObject *bytearray_from(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t n;
    return PyArg_ParseTuple(a, "y#", &s, &n) ? PyByteArray_FromStringAndSize(s, n) : NULL;
}
/* (Check, CheckExact, Size, the bytes AsString points to) */
static PyObject *bytearray_access(PyObject *m, PyObject *o) {
    int check = PyByteArray_Check(o);
    if (!check) return Py_BuildValue("iiOO", 0, PyByteArray_CheckExact(o), Py_None, Py_None);
    Py_ssize_t n = PyByteArray_Size(o);
    return Py_BuildValue("iiny#", check, PyByteArray_CheckExact(o), n, PyByteArray_AsString(o), n);
}
static char memory[] = "abcdef";
/* a memoryview over a C buffer: (its bytes, readonly) */
static PyObject *memoryview_from_memory(PyObject *m, PyObject *a) {
    int flags;
    if (!PyArg_ParseTuple(a, "i", &flags)) return NULL;
    PyObject *mv = PyMemoryView_FromMemory(memory, 6, flags);
    if (!mv) return NULL;
    Py_buffer *b = PyMemoryView_GET_BUFFER(mv);
    PyObject *r = Py_BuildValue("y#i", (char *)b->buf, b->len, b->readonly);
    Py_DECREF(mv);
    return r;
}
/* (bytes(mv), mv's base is the object) */
static PyObject *memoryview_from_object(PyObject *m, PyObject *o) {
    PyObject *mv = PyMemoryView_FromObject(o);
    if (!mv) return NULL;
    PyObject *r = Py_BuildValue("NN", PyObject_Bytes(mv), PyBool_FromLong(PyMemoryView_GET_BASE(mv) == o));
    Py_DECREF(mv);
    return r;
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
static PyMethodDef methods[] = {
    M(list_build, METH_VARARGS), M(list_get_item, METH_VARARGS), M(list_size, METH_O),
    M(list_sort, METH_O), M(list_set_slice, METH_VARARGS), M(list_as_tuple, METH_O),
    M(list_check_exact, METH_O),
    M(tuple_build, METH_VARARGS), M(tuple_pack, METH_VARARGS), M(tuple_get_item, METH_VARARGS),
    M(tuple_size, METH_O), M(tuple_get_slice, METH_VARARGS), M(tuple_check_exact, METH_O),
    M(dict_build, METH_VARARGS), M(dict_get, METH_VARARGS), M(dict_get_ref, METH_VARARGS),
    M(dict_contains, METH_VARARGS), M(dict_del, METH_VARARGS), M(dict_views, METH_O),
    M(dict_clear, METH_O), M(dict_copy, METH_O), M(dict_update, METH_VARARGS),
    M(dict_merge, METH_VARARGS), M(dict_next, METH_O), M(dict_pop, METH_VARARGS),
    M(dict_setdefault, METH_VARARGS), M(dict_check, METH_O), M(dictproxy_new, METH_O),
    M(set_new, METH_O), M(frozenset_new, METH_O), M(set_ops, METH_VARARGS), M(set_pop, METH_O),
    M(set_check, METH_O),
    M(seq_check, METH_O), M(seq_size, METH_O), M(seq_get_item, METH_VARARGS),
    M(seq_get_slice, METH_VARARGS), M(seq_del_item, METH_VARARGS), M(seq_contains, METH_VARARGS),
    M(seq_concat, METH_VARARGS), M(seq_repeat, METH_VARARGS), M(seq_inplace_concat, METH_VARARGS),
    M(seq_inplace_repeat, METH_VARARGS), M(seq_list, METH_O), M(seq_tuple, METH_O),
    M(seq_fast, METH_O),
    M(mapping_get_item_string, METH_VARARGS), M(mapping_get_optional, METH_VARARGS),
    M(slice_new, METH_VARARGS), M(slice_check, METH_O), M(slice_indices_ex, METH_VARARGS),
    M(slice_unpack_adjust, METH_VARARGS),
    M(bytearray_from, METH_VARARGS), M(bytearray_access, METH_O),
    M(memoryview_from_memory, METH_VARARGS), M(memoryview_from_object, METH_O),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_container", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_container(void) { return PyModule_Create(&def); }
