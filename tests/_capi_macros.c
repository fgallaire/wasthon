/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_macros — the C-API C code reaches through macros and type structs
 * rather than named functions (tests/test_macros.py): the slots of the
 * builtin types called from C, the Py_UNICODE_* character macros, Py_SIZE and
 * Py_REFCNT, the buffer protocol, module state. Plain C-API: it also builds
 * against CPython, the reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <string.h>

/* ---- slots of the builtin types, called from C ---------------------------- */

static PyObject *long_slots(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "OO", &x, &y)) return NULL;
    PyNumberMethods *nb = PyLong_Type.tp_as_number;
    return Py_BuildValue("NNNNN", nb->nb_multiply(x, y), nb->nb_floor_divide(x, y),
                         nb->nb_lshift(x, y), nb->nb_power(x, y, Py_None), nb->nb_int(x));
}
static PyObject *float_slots(PyObject *m, PyObject *x) {
    PyNumberMethods *nb = PyFloat_Type.tp_as_number;
    return Py_BuildValue("NN", nb->nb_int(x), nb->nb_absolute(x));
}
/* tp_new of tuple, float, str, bytes, each called on one argument */
static PyObject *builtin_new(PyObject *m, PyObject *a) {
    const char *which; PyObject *arg;
    if (!PyArg_ParseTuple(a, "sO", &which, &arg)) return NULL;
    PyTypeObject *t = !strcmp(which, "tuple") ? &PyTuple_Type : !strcmp(which, "float") ? &PyFloat_Type
                    : !strcmp(which, "str") ? &PyUnicode_Type : &PyBytes_Type;
    PyObject *args = PyTuple_Pack(1, arg);
    if (!args) return NULL;
    PyObject *r = t->tp_new(t, args, NULL);
    Py_DECREF(args);
    return r;
}
static PyObject *sequence_slots(PyObject *m, PyObject *a) {
    PyObject *l, *other;
    if (!PyArg_ParseTuple(a, "OO", &l, &other)) return NULL;
    PySequenceMethods *sq = Py_TYPE(l)->tp_as_sequence;
    return Py_BuildValue("NNN", sq->sq_item(l, 0), sq->sq_concat(l, other), sq->sq_repeat(l, 2));
}
static PyObject *mapping_slots(PyObject *m, PyObject *a) {
    PyObject *d, *k;
    if (!PyArg_ParseTuple(a, "OO", &d, &k)) return NULL;
    PyMappingMethods *mp = Py_TYPE(d)->tp_as_mapping;
    return Py_BuildValue("Nn", mp->mp_subscript(d, k), mp->mp_length(d));
}
/* tp_repr, tp_str, tp_hash of o's type; then tp_iter and tp_iternext */
static PyObject *object_slots(PyObject *m, PyObject *o) {
    PyTypeObject *t = Py_TYPE(o);
    PyObject *it = t->tp_iter ? t->tp_iter(o) : NULL;
    PyObject *first = it ? Py_TYPE(it)->tp_iternext(it) : NULL;
    PyObject *r = Py_BuildValue("NNnN", t->tp_repr(o), t->tp_str(o), (Py_ssize_t)t->tp_hash(o),
                                first ? first : Py_NewRef(Py_None));
    Py_XDECREF(it);
    return r;
}

/* the same slots one at a time, so that a failing one hides no other */
static PyObject *one_slot(PyObject *m, PyObject *a) {
    const char *which; PyObject *o;
    if (!PyArg_ParseTuple(a, "sO", &which, &o)) return NULL;
    PyTypeObject *t = Py_TYPE(o);
    if (!strcmp(which, "repr")) return t->tp_repr(o);
    if (!strcmp(which, "str")) return t->tp_str(o);
    if (!strcmp(which, "hash")) return PyLong_FromSsize_t(t->tp_hash(o));
    PyObject *it = t->tp_iter(o);
    if (!it) return NULL;
    PyObject *first = Py_TYPE(it)->tp_iternext(it);
    Py_DECREF(it);
    return first;
}

/* ---- exact type checks, str data, var-sized and GC objects, weakrefs ---------- */

static PyObject *check_exact(PyObject *m, PyObject *o) {
    return Py_BuildValue("(iiiiiii)", PyLong_CheckExact(o), PyFloat_CheckExact(o),
                         PyUnicode_CheckExact(o), PyBytes_CheckExact(o), PyTuple_CheckExact(o),
                         PyList_CheckExact(o), PyDict_CheckExact(o));
}
/* every code point through PyUnicode_2BYTE_DATA or PyUnicode_4BYTE_DATA */
static PyObject *wide_data(PyObject *m, PyObject *s) {
    Py_ssize_t n = PyUnicode_GET_LENGTH(s);
    int k = PyUnicode_KIND(s);
    PyObject *l = PyList_New(n);
    for (Py_ssize_t i = 0; l && i < n; i++) {
        Py_UCS4 c = k == PyUnicode_2BYTE_KIND ? PyUnicode_2BYTE_DATA(s)[i]
                  : k == PyUnicode_4BYTE_KIND ? PyUnicode_4BYTE_DATA(s)[i] : 0;
        PyList_SetItem(l, i, PyLong_FromLong(c));
    }
    return l;
}
static int var_traverse(PyObject *o, visitproc visit, void *arg) { return 0; }
static void var_dealloc(PyObject *o) {
    PyTypeObject *t = Py_TYPE(o);
    PyObject_GC_UnTrack(o);
    PyObject_GC_Del(o);
    Py_DECREF(t);
}
static PyType_Slot var_slots[] = {{Py_tp_traverse, var_traverse}, {Py_tp_dealloc, var_dealloc}, {0, NULL}};
static PyType_Spec var_spec = {"_capi_macros.Var", sizeof(PyVarObject), sizeof(PyObject *),
                               Py_TPFLAGS_DEFAULT | Py_TPFLAGS_HAVE_GC, var_slots};
/* PyObject_GC_NewVar of 3 items, then Py_SET_SIZE to 2: (Py_SIZE before, after) */
static PyObject *gc_new_var(PyObject *m, PyObject *u) {
    PyObject *t = PyType_FromSpec(&var_spec);
    if (!t) return NULL;
    PyVarObject *o = PyObject_GC_NewVar(PyVarObject, (PyTypeObject *)t, 3);
    if (!o) { Py_DECREF(t); return NULL; }
    Py_ssize_t before = Py_SIZE(o);
    Py_SET_SIZE(o, 2);
    PyObject *r = Py_BuildValue("nn", before, Py_SIZE(o));
    Py_DECREF(o);
    Py_DECREF(t);
    return r;
}
static PyType_Slot plainvar_slots[] = {{0, NULL}};
static PyType_Spec plainvar_spec = {"_capi_macros.PlainVar", sizeof(PyVarObject), sizeof(long),
                                    Py_TPFLAGS_DEFAULT, plainvar_slots};
/* _PyObject_NewVar (PyObject_NewVar) and PyObject_InitVar: their Py_SIZE */
static PyObject *new_init_var(PyObject *m, PyObject *u) {
    PyTypeObject *t = (PyTypeObject *)PyType_FromSpec(&plainvar_spec);
    if (!t) return NULL;
    PyVarObject *a = PyObject_NewVar(PyVarObject, t, 4);
    PyVarObject *b = PyObject_Malloc(t->tp_basicsize + 2 * t->tp_itemsize);
    if (!a || !b) { Py_DECREF(t); return PyErr_NoMemory(); }
    PyObject_InitVar(b, t, 2);
    PyObject *r = Py_BuildValue("nn", Py_SIZE(a), Py_SIZE(b));
    Py_DECREF(a);
    Py_DECREF(b);
    Py_DECREF(t);
    return r;
}

/* ---- Py_SIZE, Py_REFCNT, Py_TYPE, Py_IS_TYPE ----------------------------------- */

static PyObject *sizes(PyObject *m, PyObject *o) {
    return Py_BuildValue("nNN", Py_SIZE(o), PyBool_FromLong(Py_REFCNT(o) >= 1),
                         PyBool_FromLong(Py_IS_TYPE(o, Py_TYPE(o))));
}

/* ---- Py_UNICODE_* character macros --------------------------------------------- */

static PyObject *char_class(PyObject *m, PyObject *a) {
    int c;
    if (!PyArg_ParseTuple(a, "i", &c)) return NULL;
    Py_UCS4 ch = (Py_UCS4)c;
    return Py_BuildValue("(iiiiiiiii)(iid)", Py_UNICODE_ISALPHA(ch), Py_UNICODE_ISDIGIT(ch),
                         Py_UNICODE_ISALNUM(ch), Py_UNICODE_ISSPACE(ch), Py_UNICODE_ISDECIMAL(ch),
                         Py_UNICODE_ISLINEBREAK(ch), Py_UNICODE_ISLOWER(ch), Py_UNICODE_ISUPPER(ch),
                         Py_UNICODE_ISNUMERIC(ch), Py_UNICODE_TODECIMAL(ch), Py_UNICODE_TODIGIT(ch),
                         Py_UNICODE_TONUMERIC(ch));
}
static PyObject *char_case(PyObject *m, PyObject *a) {
    int c;
    if (!PyArg_ParseTuple(a, "i", &c)) return NULL;
    return Py_BuildValue("ii", (int)Py_UNICODE_TOLOWER((Py_UCS4)c), (int)Py_UNICODE_TOUPPER((Py_UCS4)c));
}

/* ---- the buffer protocol -------------------------------------------------------- */

/* (CheckBuffer, the bytes, len, readonly, itemsize, C-contiguous) */
static PyObject *buffer(PyObject *m, PyObject *o) {
    if (!PyObject_CheckBuffer(o)) return Py_BuildValue("(N)", PyBool_FromLong(0));
    Py_buffer view;
    if (PyObject_GetBuffer(o, &view, PyBUF_SIMPLE) < 0) return NULL;
    PyObject *r = Py_BuildValue("Ny#nin", PyBool_FromLong(1), (char *)view.buf, view.len, view.len,
                                view.readonly, view.itemsize);
    PyBuffer_Release(&view);
    return r;
}
static PyObject *buffer_contiguous(PyObject *m, PyObject *o) {
    Py_buffer view;
    if (PyObject_GetBuffer(o, &view, PyBUF_FULL_RO) < 0) return NULL;
    int c = PyBuffer_IsContiguous(&view, 'C');
    PyBuffer_Release(&view);
    return PyBool_FromLong(c);
}
static PyObject *writable_buffer(PyObject *m, PyObject *o) {
    Py_buffer view;
    if (PyObject_GetBuffer(o, &view, PyBUF_WRITABLE) < 0) return NULL;
    ((char *)view.buf)[0] = 'Z';
    PyBuffer_Release(&view);
    Py_RETURN_NONE;
}

/* ---- module state, a type's module ----------------------------------------------- */

typedef struct { long counter; } state_t;
static struct PyModuleDef stateful_def = {PyModuleDef_HEAD_INIT, "stateful", NULL, sizeof(state_t), NULL};
static PyType_Slot owned_slots[] = {{0, NULL}};
static PyType_Spec owned_spec = {"stateful.Owned", sizeof(PyObject), 0, Py_TPFLAGS_DEFAULT, owned_slots};
/* a module with state and a type bound to it: (state kept, GetModule, GetModuleState) */
static PyObject *module_state(PyObject *m, PyObject *u) {
    PyObject *mod = PyModule_Create(&stateful_def);
    if (!mod) return NULL;
    state_t *st = PyModule_GetState(mod);
    if (!st) { Py_DECREF(mod); return NULL; }
    st->counter = 41;
    ((state_t *)PyModule_GetState(mod))->counter++;
    PyObject *t = PyType_FromModuleAndSpec(mod, &owned_spec, NULL);
    if (!t) { Py_DECREF(mod); return NULL; }
    PyObject *r = Py_BuildValue("lNN", ((state_t *)PyModule_GetState(mod))->counter,
                                PyBool_FromLong(PyType_GetModule((PyTypeObject *)t) == mod),
                                PyBool_FromLong(PyType_GetModuleState((PyTypeObject *)t) == st));
    Py_DECREF(t);
    Py_DECREF(mod);
    return r;
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
static PyMethodDef methods[] = {
    M(long_slots, METH_VARARGS), M(float_slots, METH_O), M(builtin_new, METH_VARARGS),
    M(sequence_slots, METH_VARARGS), M(mapping_slots, METH_VARARGS), M(object_slots, METH_O),
    M(sizes, METH_O), M(char_class, METH_VARARGS), M(char_case, METH_VARARGS),
    M(buffer, METH_O), M(buffer_contiguous, METH_O), M(writable_buffer, METH_O),
    M(module_state, METH_NOARGS), M(one_slot, METH_VARARGS), M(check_exact, METH_O),
    M(wide_data, METH_O), M(gc_new_var, METH_NOARGS), M(new_init_var, METH_NOARGS),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_macros", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_macros(void) { return PyModule_Create(&def); }
