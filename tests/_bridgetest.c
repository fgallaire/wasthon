/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _bridgetest — the bridge's own test module: compiled against src/ alone,
 * no CPython module, no other repository.
 *
 *   Obj              a heap type whose tp_dealloc counts and frees
 *   make_drop()      one Obj created and dropped from C per call, the way a
 *                    C function uses a helper object (_pickle.dumps and its
 *                    Pickler): its refcount reaching 0 must run tp_dealloc
 *   walk(x)          walks a Python object graph from C and takes the repr of
 *                    every node, so each call wraps tens of objects into
 *                    temporary handles that the call's scope must release
 *   deallocs()       how many Obj tp_dealloc has freed
 */
#include "wasthon.h"

static long n_dealloc;
static PyTypeObject *ObjType;

typedef struct { PyObject_HEAD long payload[8]; } Obj;

static PyObject *obj_new(PyTypeObject *t, PyObject *a, PyObject *k) {
    return t->tp_alloc(t, 0);
}
static void obj_dealloc(PyObject *self) {
    PyTypeObject *tp = Py_TYPE(self);
    n_dealloc++;
    tp->tp_free(self);
    Py_DECREF(tp);
}
static PyType_Slot obj_slots[] = {
    {Py_tp_new, obj_new}, {Py_tp_dealloc, obj_dealloc}, {0, NULL}};
static PyType_Spec obj_spec = {"_bridgetest.Obj", sizeof(Obj), 0,
                               Py_TPFLAGS_DEFAULT, obj_slots};

/* Allocated in C (tp_alloc), never seen by Python, as _pickle allocates its
 * Pickler: dropping the only reference must run tp_dealloc. (Created through
 * PyObject_CallNoArgs(type) instead, the object passes through Brython and
 * its wrapper keeps a reference: CPython would free it here, the bridge
 * leaves it to a collection.) */
static PyObject *make_drop(PyObject *m, PyObject *u) {
    PyObject *o = ObjType->tp_alloc(ObjType, 0);
    if (!o) return NULL;
    Py_DECREF(o);
    Py_RETURN_NONE;
}

static int walk_into(PyObject *x, int depth) {
    PyObject *r = PyObject_Repr(x);
    if (!r) return -1;
    Py_DECREF(r);
    if (depth > 8 || PyUnicode_Check(x) || PyBytes_Check(x)) return 0;
    PyObject *it = PyObject_GetIter(x);
    if (!it) { PyErr_Clear(); return 0; }
    PyObject *item;
    while ((item = PyIter_Next(it)) != NULL) {
        int rc = walk_into(item, depth + 1);
        if (PyDict_Check(x) && rc == 0) {
            PyObject *v = PyObject_GetItem(x, item);
            if (v) { rc = walk_into(v, depth + 1); Py_DECREF(v); }
            else rc = -1;
        }
        Py_DECREF(item);
        if (rc < 0) { Py_DECREF(it); return -1; }
    }
    Py_DECREF(it);
    return PyErr_Occurred() ? -1 : 0;
}
static PyObject *walk(PyObject *m, PyObject *x) {
    if (walk_into(x, 0) < 0) return NULL;
    Py_RETURN_NONE;
}

static PyObject *deallocs(PyObject *m, PyObject *u) {
    return PyLong_FromLong(n_dealloc);
}

static PyMethodDef mod_methods[] = {
    {"make_drop", make_drop, METH_NOARGS, NULL},
    {"walk", walk, METH_O, NULL},
    {"deallocs", deallocs, METH_NOARGS, NULL},
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_bridgetest", NULL, -1,
                                 mod_methods};

PyMODINIT_FUNC PyInit__bridgetest(void) {
    PyObject *m = PyModule_Create(&def);
    if (!m) return NULL;
    ObjType = (PyTypeObject *)PyType_FromSpec(&obj_spec);
    if (!ObjType) return NULL;
    Py_INCREF(ObjType);
    PyModule_AddObject(m, "Obj", (PyObject *)ObjType);
    return m;
}
