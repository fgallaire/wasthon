/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_object — the bridge's exception and object-protocol C-API, one thin
 * fixture per function (tests/test_object.py). Plain C-API: it also builds
 * against CPython, the reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <errno.h>
#include <string.h>

/* ---- raising ------------------------------------------------------------- */

static PyObject *set_string(PyObject *m, PyObject *a) {
    PyObject *exc; const char *msg;
    if (!PyArg_ParseTuple(a, "Os", &exc, &msg)) return NULL;
    PyErr_SetString(exc, msg);
    return NULL;
}
static PyObject *set_none(PyObject *m, PyObject *exc) {
    PyErr_SetNone(exc);
    return NULL;
}
static PyObject *set_object(PyObject *m, PyObject *a) {
    PyObject *exc, *value;
    if (!PyArg_ParseTuple(a, "OO", &exc, &value)) return NULL;
    PyErr_SetObject(exc, value);
    return NULL;
}
static PyObject *format(PyObject *m, PyObject *a) {
    const char *s; int i;
    if (!PyArg_ParseTuple(a, "si", &s, &i)) return NULL;
    return PyErr_Format(PyExc_ValueError, "bad %s: %d", s, i);
}
static PyObject *no_memory(PyObject *m, PyObject *u) { return PyErr_NoMemory(); }
static PyObject *bad_argument(PyObject *m, PyObject *u) {
    PyErr_BadArgument();
    return NULL;
}
static PyObject *bad_internal_call(PyObject *m, PyObject *u) {
    PyErr_BadInternalCall();
    return NULL;
}
static PyObject *set_from_errno(PyObject *m, PyObject *u) {
    errno = ENOENT;
    return PyErr_SetFromErrno(PyExc_OSError);
}

/* ---- inspecting and clearing the current exception ------------------------- */

/* raises exc, then reports what C sees: (occurred, matches(match), matches(other)) */
static PyObject *occurred_matches(PyObject *m, PyObject *a) {
    PyObject *exc, *match, *other;
    if (!PyArg_ParseTuple(a, "OOO", &exc, &match, &other)) return NULL;
    PyErr_SetString(exc, "x");
    PyObject *r = Py_BuildValue("NNN", PyBool_FromLong(PyErr_Occurred() != NULL),
                                PyBool_FromLong(PyErr_ExceptionMatches(match)),
                                PyBool_FromLong(PyErr_ExceptionMatches(other)));
    PyErr_Clear();
    return r;
}
static PyObject *given_matches(PyObject *m, PyObject *a) {
    PyObject *given, *exc;
    if (!PyArg_ParseTuple(a, "OO", &given, &exc)) return NULL;
    return PyBool_FromLong(PyErr_GivenExceptionMatches(given, exc));
}
static PyObject *clear(PyObject *m, PyObject *u) {
    PyErr_SetString(PyExc_KeyError, "x");
    PyErr_Clear();
    return PyBool_FromLong(PyErr_Occurred() != NULL);
}
/* raises, takes the exception out with GetRaisedException, returns it */
static PyObject *get_raised(PyObject *m, PyObject *a) {
    PyObject *exc; const char *msg;
    if (!PyArg_ParseTuple(a, "Os", &exc, &msg)) return NULL;
    PyErr_SetString(exc, msg);
    PyObject *e = PyErr_GetRaisedException();
    if (PyErr_Occurred()) { Py_XDECREF(e); return NULL; }
    return e;
}
static PyObject *set_raised(PyObject *m, PyObject *e) {
    Py_INCREF(e);
    PyErr_SetRaisedException(e);
    return NULL;
}
/* PyErr_Fetch then PyErr_Restore: the exception comes back out unchanged */
static PyObject *fetch_restore(PyObject *m, PyObject *exc) {
    PyErr_SetString(exc, "fetched");
    PyObject *t, *v, *tb;
    PyErr_Fetch(&t, &v, &tb);
    if (PyErr_Occurred()) return NULL;
    PyErr_Restore(t, v, tb);
    return NULL;
}
/* PyErr_Fetch, NormalizeException: (type, value) where value is an instance */
static PyObject *normalize(PyObject *m, PyObject *exc) {
    PyErr_SetString(exc, "raw");
    PyObject *t, *v, *tb;
    PyErr_Fetch(&t, &v, &tb);
    PyErr_NormalizeException(&t, &v, &tb);
    PyObject *r = Py_BuildValue("OO", t, v);
    Py_XDECREF(t); Py_XDECREF(v); Py_XDECREF(tb);
    return r;
}
static PyObject *check_signals(PyObject *m, PyObject *u) { return PyLong_FromLong(PyErr_CheckSignals()); }

/* ---- exception objects, new exception types --------------------------------- */

static PyObject *set_cause_context(PyObject *m, PyObject *a) {
    PyObject *e, *cause, *ctx;
    if (!PyArg_ParseTuple(a, "OOO", &e, &cause, &ctx)) return NULL;
    PyException_SetCause(e, Py_NewRef(cause));      /* both steal */
    PyException_SetContext(e, Py_NewRef(ctx));
    Py_RETURN_NONE;
}
static PyObject *set_traceback(PyObject *m, PyObject *a) {
    PyObject *e, *tb;
    if (!PyArg_ParseTuple(a, "OO", &e, &tb)) return NULL;
    return PyException_SetTraceback(e, tb) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *new_exception(PyObject *m, PyObject *a) {
    const char *name; PyObject *base, *dict;
    if (!PyArg_ParseTuple(a, "sOO", &name, &base, &dict)) return NULL;
    return PyErr_NewException(name, base == Py_None ? NULL : base, dict == Py_None ? NULL : dict);
}
static PyObject *new_exception_with_doc(PyObject *m, PyObject *a) {
    const char *name, *doc; PyObject *base;
    if (!PyArg_ParseTuple(a, "szO", &name, &doc, &base)) return NULL;
    return PyErr_NewExceptionWithDoc(name, doc, base == Py_None ? NULL : base, NULL);
}

/* ---- warnings, unraisable, printing ----------------------------------------- */

static PyObject *warn_ex(PyObject *m, PyObject *a) {
    PyObject *cat; const char *msg;
    if (!PyArg_ParseTuple(a, "Os", &cat, &msg)) return NULL;
    return PyErr_WarnEx(cat, msg, 1) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *warn_format(PyObject *m, PyObject *a) {
    PyObject *cat; int i;
    if (!PyArg_ParseTuple(a, "Oi", &cat, &i)) return NULL;
    return PyErr_WarnFormat(cat, 1, "warned %d", i) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *write_unraisable(PyObject *m, PyObject *obj) {
    PyErr_SetString(PyExc_RuntimeError, "unraisable");
    PyErr_WriteUnraisable(obj);
    return PyBool_FromLong(PyErr_Occurred() != NULL);
}
static PyObject *format_unraisable(PyObject *m, PyObject *u) {
    PyErr_SetString(PyExc_RuntimeError, "unraisable");
    PyErr_FormatUnraisable("while testing %d", 42);
    return PyBool_FromLong(PyErr_Occurred() != NULL);
}
static PyObject *print_(PyObject *m, PyObject *u) {
    PyErr_SetString(PyExc_KeyError, "printed");
    PyErr_Print();
    return PyBool_FromLong(PyErr_Occurred() != NULL);
}

/* ---- attributes -------------------------------------------------------------- */

static PyObject *getattr(PyObject *m, PyObject *a) {
    PyObject *o, *name;
    return PyArg_ParseTuple(a, "OO", &o, &name) ? PyObject_GetAttr(o, name) : NULL;
}
static PyObject *getattr_string(PyObject *m, PyObject *a) {
    PyObject *o; const char *name;
    return PyArg_ParseTuple(a, "Os", &o, &name) ? PyObject_GetAttrString(o, name) : NULL;
}
static PyObject *setattr(PyObject *m, PyObject *a) {
    PyObject *o, *name, *v;
    if (!PyArg_ParseTuple(a, "OOO", &o, &name, &v)) return NULL;
    return PyObject_SetAttr(o, name, v == Py_None ? NULL : v) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *setattr_string(PyObject *m, PyObject *a) {
    PyObject *o, *v; const char *name;
    if (!PyArg_ParseTuple(a, "OsO", &o, &name, &v)) return NULL;
    return PyObject_SetAttrString(o, name, v) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *hasattr(PyObject *m, PyObject *a) {
    PyObject *o, *name;
    if (!PyArg_ParseTuple(a, "OO", &o, &name)) return NULL;
    int r = PyObject_HasAttrWithError(o, name);
    return r < 0 ? NULL : Py_BuildValue("NN", PyBool_FromLong(r),
                                         PyBool_FromLong(PyObject_HasAttrString(o, PyUnicode_AsUTF8(name))));
}
/* (found, value or None) */
static PyObject *get_optional_attr(PyObject *m, PyObject *a) {
    PyObject *o, *name, *v;
    if (!PyArg_ParseTuple(a, "OO", &o, &name)) return NULL;
    int r = PyObject_GetOptionalAttr(o, name, &v);
    if (r < 0) return NULL;
    return Py_BuildValue("iN", r, r ? v : Py_NewRef(Py_None));
}
static PyObject *generic_getattr(PyObject *m, PyObject *a) {
    PyObject *o, *name;
    return PyArg_ParseTuple(a, "OO", &o, &name) ? PyObject_GenericGetAttr(o, name) : NULL;
}
static PyObject *generic_setattr(PyObject *m, PyObject *a) {
    PyObject *o, *name, *v;
    if (!PyArg_ParseTuple(a, "OOO", &o, &name, &v)) return NULL;
    return PyObject_GenericSetAttr(o, name, v) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *generic_get_dict(PyObject *m, PyObject *o) { return PyObject_GenericGetDict(o, NULL); }
static PyObject *dir_(PyObject *m, PyObject *o) { return PyObject_Dir(o); }

/* ---- conversions, hashing, truth, comparison ------------------------------------ */

static PyObject *repr(PyObject *m, PyObject *o) { return PyObject_Repr(o); }
static PyObject *str(PyObject *m, PyObject *o) { return PyObject_Str(o); }
static PyObject *bytes(PyObject *m, PyObject *o) { return PyObject_Bytes(o); }
static PyObject *format_(PyObject *m, PyObject *a) {
    PyObject *o, *spec;
    return PyArg_ParseTuple(a, "OO", &o, &spec) ? PyObject_Format(o, spec) : NULL;
}
static PyObject *hash(PyObject *m, PyObject *o) {
    Py_hash_t h = PyObject_Hash(o);
    return h == -1 && PyErr_Occurred() ? NULL : PyLong_FromSsize_t(h);
}
static PyObject *hash_not_implemented(PyObject *m, PyObject *o) {
    Py_hash_t h = PyObject_HashNotImplemented(o);
    return h == -1 && PyErr_Occurred() ? NULL : PyLong_FromSsize_t(h);
}
static PyObject *truth(PyObject *m, PyObject *o) {
    int t = PyObject_IsTrue(o), n = PyObject_Not(o);
    return t < 0 || n < 0 ? NULL : Py_BuildValue("ii", t, n);
}
static PyObject *richcompare(PyObject *m, PyObject *a) {
    PyObject *x, *y; int op;
    if (!PyArg_ParseTuple(a, "OOi", &x, &y, &op)) return NULL;
    PyObject *r = PyObject_RichCompare(x, y, op);
    if (!r) return NULL;
    int b = PyObject_RichCompareBool(x, y, op);
    return b < 0 ? NULL : Py_BuildValue("Ni", r, b);
}
static PyObject *isinstance(PyObject *m, PyObject *a) {
    PyObject *o, *cls;
    if (!PyArg_ParseTuple(a, "OO", &o, &cls)) return NULL;
    int r = PyObject_IsInstance(o, cls);
    return r < 0 ? NULL : PyBool_FromLong(r);
}
static PyObject *issubclass(PyObject *m, PyObject *a) {
    PyObject *d, *cls;
    if (!PyArg_ParseTuple(a, "OO", &d, &cls)) return NULL;
    int r = PyObject_IsSubclass(d, cls);
    return r < 0 ? NULL : PyBool_FromLong(r);
}
static PyObject *type(PyObject *m, PyObject *o) { return PyObject_Type(o); }

/* ---- containers: size, items, iteration ----------------------------------------- */

static PyObject *size(PyObject *m, PyObject *o) {
    Py_ssize_t n = PyObject_Size(o);
    return n < 0 ? NULL : PyLong_FromSsize_t(n);
}
static PyObject *length_hint(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t d;
    if (!PyArg_ParseTuple(a, "On", &o, &d)) return NULL;
    Py_ssize_t n = PyObject_LengthHint(o, d);
    return n < 0 ? NULL : PyLong_FromSsize_t(n);
}
static PyObject *getitem(PyObject *m, PyObject *a) {
    PyObject *o, *k;
    return PyArg_ParseTuple(a, "OO", &o, &k) ? PyObject_GetItem(o, k) : NULL;
}
static PyObject *setitem(PyObject *m, PyObject *a) {
    PyObject *o, *k, *v;
    if (!PyArg_ParseTuple(a, "OOO", &o, &k, &v)) return NULL;
    return PyObject_SetItem(o, k, v) < 0 ? NULL : Py_NewRef(Py_None);
}
static PyObject *delitem(PyObject *m, PyObject *a) {
    PyObject *o, *k;
    if (!PyArg_ParseTuple(a, "OO", &o, &k)) return NULL;
    return PyObject_DelItem(o, k) < 0 ? NULL : Py_NewRef(Py_None);
}
/* PyObject_GetIter then PyIter_Next to the end: the items as a list */
static PyObject *iterate(PyObject *m, PyObject *o) {
    PyObject *it = PyObject_GetIter(o);
    if (!it) return NULL;
    PyObject *l = PyList_New(0), *item;
    while ((item = PyIter_Next(it)) != NULL) {
        PyList_Append(l, item);
        Py_DECREF(item);
    }
    Py_DECREF(it);
    if (PyErr_Occurred()) { Py_DECREF(l); return NULL; }
    return l;
}
static PyObject *iter_check(PyObject *m, PyObject *o) { return PyBool_FromLong(PyIter_Check(o)); }
static PyObject *self_iter(PyObject *m, PyObject *o) { return PyObject_SelfIter(o); }

/* ---- calling ------------------------------------------------------------------- */

static PyObject *callable_check(PyObject *m, PyObject *o) { return PyBool_FromLong(PyCallable_Check(o)); }
static PyObject *call(PyObject *m, PyObject *a) {
    PyObject *f, *args, *kw;
    if (!PyArg_ParseTuple(a, "OOO", &f, &args, &kw)) return NULL;
    return PyObject_Call(f, args, kw == Py_None ? NULL : kw);
}
static PyObject *call_object(PyObject *m, PyObject *a) {
    PyObject *f, *args;
    if (!PyArg_ParseTuple(a, "OO", &f, &args)) return NULL;
    return PyObject_CallObject(f, args == Py_None ? NULL : args);
}
static PyObject *call_no_args(PyObject *m, PyObject *f) { return PyObject_CallNoArgs(f); }
static PyObject *call_one_arg(PyObject *m, PyObject *a) {
    PyObject *f, *x;
    return PyArg_ParseTuple(a, "OO", &f, &x) ? PyObject_CallOneArg(f, x) : NULL;
}
static PyObject *call_function(PyObject *m, PyObject *f) {
    return PyObject_CallFunction(f, "isOd", 1, "two", Py_None, 2.0);
}
static PyObject *call_function_obj_args(PyObject *m, PyObject *a) {
    PyObject *f, *x, *y;
    if (!PyArg_ParseTuple(a, "OOO", &f, &x, &y)) return NULL;
    return PyObject_CallFunctionObjArgs(f, x, y, NULL);
}
static PyObject *call_method(PyObject *m, PyObject *a) {
    PyObject *o; const char *name;
    if (!PyArg_ParseTuple(a, "Os", &o, &name)) return NULL;
    return PyObject_CallMethod(o, name, "id", 3, 2.0);
}
static PyObject *call_method_obj_args(PyObject *m, PyObject *a) {
    PyObject *o, *name, *x;
    if (!PyArg_ParseTuple(a, "OOO", &o, &name, &x)) return NULL;
    return PyObject_CallMethodObjArgs(o, name, x, NULL);
}
static PyObject *call_method_no_args(PyObject *m, PyObject *a) {
    PyObject *o, *name;
    return PyArg_ParseTuple(a, "OO", &o, &name) ? PyObject_CallMethodNoArgs(o, name) : NULL;
}
static PyObject *call_method_one_arg(PyObject *m, PyObject *a) {
    PyObject *o, *name, *x;
    return PyArg_ParseTuple(a, "OOO", &o, &name, &x) ? PyObject_CallMethodOneArg(o, name, x) : NULL;
}
/* f(*args, **kw) through PyObject_Vectorcall with kwnames */
static PyObject *vectorcall(PyObject *m, PyObject *a) {
    PyObject *f, *args, *kw;
    if (!PyArg_ParseTuple(a, "OO!O!", &f, &PyTuple_Type, &args, &PyDict_Type, &kw)) return NULL;
    Py_ssize_t na = PyTuple_Size(args), nk = PyDict_Size(kw);
    PyObject *stack[16], *kwnames = nk ? PyTuple_New(nk) : NULL, *k, *v;
    for (Py_ssize_t i = 0; i < na; i++) stack[i] = PyTuple_GetItem(args, i);
    Py_ssize_t pos = 0, j = 0;
    while (PyDict_Next(kw, &pos, &k, &v)) {
        stack[na + j] = v;
        PyTuple_SetItem(kwnames, j++, Py_NewRef(k));
    }
    PyObject *r = PyObject_Vectorcall(f, stack, na, kwnames);
    Py_XDECREF(kwnames);
    return r;
}
static PyObject *vectorcall_dict(PyObject *m, PyObject *a) {
    PyObject *f, *args, *kw;
    if (!PyArg_ParseTuple(a, "OO!O", &f, &PyTuple_Type, &args, &kw)) return NULL;
    PyObject *stack[16];
    Py_ssize_t na = PyTuple_Size(args);
    for (Py_ssize_t i = 0; i < na; i++) stack[i] = PyTuple_GetItem(args, i);
    return PyObject_VectorcallDict(f, stack, na, kw == Py_None ? NULL : kw);
}
/* o.name(x) through PyObject_VectorcallMethod: self is args[0] */
static PyObject *vectorcall_method(PyObject *m, PyObject *a) {
    PyObject *o, *name, *x;
    if (!PyArg_ParseTuple(a, "OOO", &o, &name, &x)) return NULL;
    PyObject *stack[2] = {o, x};
    return PyObject_VectorcallMethod(name, stack, 2, NULL);
}

/* ---- odds and ends --------------------------------------------------------------- */

static PyObject *as_file_descriptor(PyObject *m, PyObject *o) {
    int fd = PyObject_AsFileDescriptor(o);
    return fd < 0 ? NULL : PyLong_FromLong(fd);
}
static PyObject *gc_is_tracked(PyObject *m, PyObject *o) { return PyBool_FromLong(PyObject_GC_IsTracked(o)); }
static PyObject *malloc_free(PyObject *m, PyObject *a) {
    Py_ssize_t n;
    if (!PyArg_ParseTuple(a, "n", &n)) return NULL;
    char *p = PyObject_Malloc(n);
    if (!p) return PyErr_NoMemory();
    memset(p, 'x', n);
    PyObject *r = PyBytes_FromStringAndSize(p, n);
    PyObject_Free(p);
    return r;
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
#define N(name, fn, flags) {name, (PyCFunction)(void (*)(void))fn, flags, NULL}
static PyMethodDef methods[] = {
    M(set_string, METH_VARARGS), M(set_none, METH_O), M(set_object, METH_VARARGS),
    M(format, METH_VARARGS), M(no_memory, METH_NOARGS), M(bad_argument, METH_NOARGS),
    M(bad_internal_call, METH_NOARGS), M(set_from_errno, METH_NOARGS),
    M(occurred_matches, METH_VARARGS), M(given_matches, METH_VARARGS), M(clear, METH_NOARGS),
    M(get_raised, METH_VARARGS), M(set_raised, METH_O), M(fetch_restore, METH_O),
    M(normalize, METH_O), M(check_signals, METH_NOARGS),
    M(set_cause_context, METH_VARARGS), M(set_traceback, METH_VARARGS),
    M(new_exception, METH_VARARGS), M(new_exception_with_doc, METH_VARARGS),
    M(warn_ex, METH_VARARGS), M(warn_format, METH_VARARGS), M(write_unraisable, METH_O),
    M(format_unraisable, METH_NOARGS), N("print", print_, METH_NOARGS),
    M(getattr, METH_VARARGS), M(getattr_string, METH_VARARGS), M(setattr, METH_VARARGS),
    M(setattr_string, METH_VARARGS), M(hasattr, METH_VARARGS), M(get_optional_attr, METH_VARARGS),
    M(generic_getattr, METH_VARARGS), M(generic_setattr, METH_VARARGS),
    M(generic_get_dict, METH_O), N("dir", dir_, METH_O),
    M(repr, METH_O), M(str, METH_O), M(bytes, METH_O), N("format_spec", format_, METH_VARARGS),
    M(hash, METH_O), M(hash_not_implemented, METH_O), M(truth, METH_O),
    M(richcompare, METH_VARARGS), M(isinstance, METH_VARARGS), M(issubclass, METH_VARARGS),
    M(type, METH_O), M(size, METH_O), M(length_hint, METH_VARARGS), M(getitem, METH_VARARGS),
    M(setitem, METH_VARARGS), M(delitem, METH_VARARGS), M(iterate, METH_O),
    M(iter_check, METH_O), M(self_iter, METH_O),
    M(callable_check, METH_O), M(call, METH_VARARGS), M(call_object, METH_VARARGS),
    M(call_no_args, METH_O), M(call_one_arg, METH_VARARGS), M(call_function, METH_O),
    M(call_function_obj_args, METH_VARARGS), M(call_method, METH_VARARGS),
    M(call_method_obj_args, METH_VARARGS), M(call_method_no_args, METH_VARARGS),
    M(call_method_one_arg, METH_VARARGS), M(vectorcall, METH_VARARGS),
    M(vectorcall_dict, METH_VARARGS), M(vectorcall_method, METH_VARARGS),
    M(as_file_descriptor, METH_O), M(gc_is_tracked, METH_O), M(malloc_free, METH_VARARGS),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_object", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_object(void) { return PyModule_Create(&def); }
