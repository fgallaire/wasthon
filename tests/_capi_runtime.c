/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_runtime — the bridge's module, capsule, argument-parsing, import,
 * function and method objects, weakref, contextvar, thread-state, OS and
 * other runtime C-API, one thin fixture per function
 * (tests/test_runtime.py). Plain C-API: it also builds against CPython, the
 * reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <stdarg.h>
#include <string.h>

#ifdef WASTHON_H
/* CPython declares these (some as macros or inline functions, hence only
 * for the bridge); src/wasthon.h lacks them although src/wasthon.js
 * implements them. */
#define PYTHON_API_VERSION 1013
PyObject *PyImport_AddModule(const char *name);
PyObject *PyCFunction_New(PyMethodDef *ml, PyObject *self);
int PyMethod_Check(PyObject *op);
PyObject *PyMethod_GET_FUNCTION(PyObject *meth);
PyObject *PyInstanceMethod_New(PyObject *func);
int PyInstanceMethod_Check(PyObject *op);
PyObject *PyInstanceMethod_GET_FUNCTION(PyObject *im);
PyObject *PyClassMethod_New(PyObject *callable);
PyObject *PyThreadState_GetDict(void);
#endif

/* ---- modules ------------------------------------------------------------------ */

static struct PyModuleDef small_def = {PyModuleDef_HEAD_INIT, "small", "small doc", -1, NULL};

/* PyModule_New + GetDict + the Add* family: the module's dict */
static PyObject *module_add(PyObject *m, PyObject *u) {
    PyObject *mod = PyModule_New("made");
    if (!mod) return NULL;
    PyObject *one = PyLong_FromLong(1);
    if (PyModule_AddObjectRef(mod, "ref", one) < 0
        || PyModule_Add(mod, "added", PyLong_FromLong(2)) < 0
        || PyModule_AddObject(mod, "obj", Py_NewRef(one)) < 0
        || PyModule_AddIntConstant(mod, "INT", 42) < 0
        || PyModule_AddStringConstant(mod, "STR", "s") < 0
        || PyModule_AddType(mod, &PyLong_Type) < 0) {
        Py_DECREF(one); Py_DECREF(mod);
        return NULL;
    }
    Py_DECREF(one);
    PyObject *d = PyModule_GetDict(mod);          /* borrowed */
    PyObject *r = Py_BuildValue("NO", PyBool_FromLong(PyModule_Check(mod)), d);
    Py_DECREF(mod);
    return r;
}
static PyObject *module_create2(PyObject *m, PyObject *u) {
    return PyModule_Create2(&small_def, PYTHON_API_VERSION);
}
static int exec_small(PyObject *mod) { return PyModule_AddIntConstant(mod, "EXECUTED", 1); }
static PyModuleDef_Slot multi_slots[] = {{Py_mod_exec, exec_small}, {0, NULL}};
static struct PyModuleDef multi_def = {PyModuleDef_HEAD_INIT, "multi", NULL, 0, NULL, multi_slots};
/* multi-phase init: PyModuleDef_Init, FromDefAndSpec2, ExecDef */
static PyObject *module_from_spec(PyObject *m, PyObject *spec) {
    if (!PyModuleDef_Init(&multi_def)) return NULL;
    PyObject *mod = PyModule_FromDefAndSpec2(&multi_def, spec, PYTHON_API_VERSION);
    if (!mod) return NULL;
    if (PyModule_ExecDef(mod, &multi_def) < 0) { Py_DECREF(mod); return NULL; }
    return mod;
}
static struct PyModuleDef def;
static PyObject *state_find_module(PyObject *m, PyObject *u) {
    PyObject *r = PyState_FindModule(&def);        /* borrowed */
    return PyBool_FromLong(r == m);
}

/* ---- capsules ------------------------------------------------------------------ */

static int payload = 7, other = 8, context_value;
static PyObject *capsule_new(PyObject *m, PyObject *u) {
    return PyCapsule_New(&payload, "_capi_runtime.CAPSULE", NULL);
}
/* (name, the pointer is &payload, IsValid, CheckExact) */
static PyObject *capsule_read(PyObject *m, PyObject *c) {
    const char *name = PyCapsule_GetName(c);
    if (!name && PyErr_Occurred()) return NULL;
    int *p = PyCapsule_GetPointer(c, name);
    if (!p) return NULL;
    return Py_BuildValue("siNN", name, *p, PyBool_FromLong(PyCapsule_IsValid(c, name)),
                         PyBool_FromLong(PyCapsule_CheckExact(c)));
}
/* SetPointer, SetName, SetContext, then read them back */
static PyObject *capsule_set(PyObject *m, PyObject *c) {
    if (PyCapsule_SetPointer(c, &other) < 0 || PyCapsule_SetName(c, "renamed") < 0
        || PyCapsule_SetContext(c, &context_value) < 0) return NULL;
    int *p = PyCapsule_GetPointer(c, "renamed");
    if (!p) return NULL;
    return Py_BuildValue("siN", PyCapsule_GetName(c), *p,
                         PyBool_FromLong(PyCapsule_GetContext(c) == &context_value));
}
static PyObject *capsule_wrong_name(PyObject *m, PyObject *c) {
    return PyCapsule_GetPointer(c, "wrong") ? Py_NewRef(Py_None) : NULL;
}
static PyObject *capsule_import(PyObject *m, PyObject *a) {
    const char *name;
    if (!PyArg_ParseTuple(a, "s", &name)) return NULL;
    void *p = PyCapsule_Import(name, 0);   /* src/wasthon.h: PyObject *, CPython: void * */
    return p ? PyLong_FromLong(*(int *)p) : NULL;
}

/* ---- parsing arguments ------------------------------------------------------------ */

/* one of each common format: returns what C received */
static PyObject *parse_formats(PyObject *m, PyObject *a) {
    int i; long l; Py_ssize_t n; double d; const char *s, *z; const char *y; Py_ssize_t ylen;
    PyObject *o, *lst, *u; int p; int t1, t2;
    if (!PyArg_ParseTuple(a, "ilndszy#OO!Up(ii):parse_formats", &i, &l, &n, &d, &s, &z, &y,
                          &ylen, &o, &PyList_Type, &lst, &u, &p, &t1, &t2)) return NULL;
    return Py_BuildValue("ilndsNy#OOOiii", i, l, n, d, s,
                         z ? PyUnicode_FromString(z) : Py_NewRef(Py_None), y, ylen, o, lst, u,
                         p, t1, t2);
}
static int as_double_converter(PyObject *o, void *addr) {
    double v = PyFloat_AsDouble(o);
    if (v == -1.0 && PyErr_Occurred()) return 0;
    *(double *)addr = v * 2;
    return 1;
}
static PyObject *parse_converter(PyObject *m, PyObject *a) {
    double v;
    return PyArg_ParseTuple(a, "O&", as_double_converter, &v) ? PyFloat_FromDouble(v) : NULL;
}
/* f(a, b=2, *, c=3) */
static PyObject *parse_keywords(PyObject *m, PyObject *args, PyObject *kw) {
    static char *kwlist[] = {"a", "b", "c", NULL};
    int x, y = 2, z = 3;
    if (!PyArg_ParseTupleAndKeywords(args, kw, "i|i$i:parse_keywords", kwlist, &x, &y, &z)) return NULL;
    return Py_BuildValue("iii", x, y, z);
}
static int va_parse(PyObject *args, PyObject *kw, const char *fmt, char **kwlist, ...) {
    va_list va;
    va_start(va, kwlist);
    int r = PyArg_VaParseTupleAndKeywords(args, kw, fmt, kwlist, va);
    va_end(va);
    return r;
}
static PyObject *va_parse_keywords(PyObject *m, PyObject *args, PyObject *kw) {
    static char *kwlist[] = {"a", "b", NULL};
    int x, y = 5;
    if (!va_parse(args, kw, "i|i", kwlist, &x, &y)) return NULL;
    return Py_BuildValue("ii", x, y);
}
static PyObject *parse_single(PyObject *m, PyObject *o) {
    int v;
    return PyArg_Parse(o, "i", &v) ? PyLong_FromLong(v) : NULL;
}
static PyObject *unpack_tuple(PyObject *m, PyObject *a) {
    PyObject *x, *y = Py_None;
    if (!PyArg_UnpackTuple(a, "unpack_tuple", 1, 2, &x, &y)) return NULL;
    return Py_BuildValue("OO", x, y);
}
static PyObject *va_build(const char *fmt, ...) {
    va_list va;
    va_start(va, fmt);
    PyObject *r = Py_VaBuildValue(fmt, va);
    va_end(va);
    return r;
}
static PyObject *build_values(PyObject *m, PyObject *u) {
    return Py_BuildValue("(i,s,[d,d,z],{s:O},N)", 1, "two", 3.5, 4.0, NULL, "k", Py_True,
                         va_build("(id)", 4, 5.0));
}

/* ---- import --------------------------------------------------------------------------- */

static PyObject *import_module(PyObject *m, PyObject *a) {
    const char *name;
    return PyArg_ParseTuple(a, "s", &name) ? PyImport_ImportModule(name) : NULL;
}
static PyObject *import_(PyObject *m, PyObject *name) { return PyImport_Import(name); }
static PyObject *import_attr(PyObject *m, PyObject *a) {
    const char *mod, *attr; PyObject *modo, *attro;
    if (!PyArg_ParseTuple(a, "ssUU", &mod, &attr, &modo, &attro)) return NULL;
    PyObject *x = PyImport_ImportModuleAttrString(mod, attr);
    if (!x) return NULL;
    return Py_BuildValue("NN", x, PyImport_ImportModuleAttr(modo, attro));
}
static PyObject *add_module(PyObject *m, PyObject *a) {
    const char *name;
    if (!PyArg_ParseTuple(a, "s", &name)) return NULL;
    PyObject *mod = PyImport_AddModule(name);      /* borrowed */
    return mod ? Py_NewRef(mod) : NULL;
}
static PyObject *module_dict(PyObject *m, PyObject *u) { return Py_NewRef(PyImport_GetModuleDict()); }

/* ---- functions and methods --------------------------------------------------------------- */

static PyObject *cfunc_impl(PyObject *self, PyObject *arg) {
    return Py_BuildValue("OO", self ? self : Py_None, arg);
}
static PyMethodDef cfunc_def = {"cfunc", cfunc_impl, METH_O, "a C function"};
/* (f(1), Check, GetFunction is the impl, GET_FUNCTION too, GET_SELF is self) */
static PyObject *cfunction(PyObject *m, PyObject *a) {
    PyObject *self, *mod;
    if (!PyArg_ParseTuple(a, "OO", &self, &mod)) return NULL;
    PyObject *f = mod == Py_None ? PyCFunction_New(&cfunc_def, self)
                                 : PyCFunction_NewEx(&cfunc_def, self, mod);
    if (!f) return NULL;
    PyObject *r = Py_BuildValue("NNNNN", PyObject_CallOneArg(f, PyLong_FromLong(1)),
                                PyBool_FromLong(PyCFunction_Check(f)),
                                PyBool_FromLong(PyCFunction_GetFunction(f) == cfunc_impl),
                                PyBool_FromLong(PyCFunction_GET_FUNCTION(f) == cfunc_impl),
                                PyBool_FromLong(PyCFunction_GET_SELF(f) == self));
    Py_DECREF(f);
    return r;
}
static PyObject *method_new(PyObject *m, PyObject *a) {
    PyObject *f, *self;
    if (!PyArg_ParseTuple(a, "OO", &f, &self)) return NULL;
    PyObject *meth = PyMethod_New(f, self);
    if (!meth) return NULL;
    return Py_BuildValue("NNN", meth, PyBool_FromLong(PyMethod_Check(meth)),
                         PyBool_FromLong(PyMethod_GET_FUNCTION(meth) == f));
}
static PyObject *instancemethod_new(PyObject *m, PyObject *f) {
    PyObject *im = PyInstanceMethod_New(f);
    if (!im) return NULL;
    return Py_BuildValue("NNN", im, PyBool_FromLong(PyInstanceMethod_Check(im)),
                         PyBool_FromLong(PyInstanceMethod_GET_FUNCTION(im) == f));
}
static PyObject *classmethod_new(PyObject *m, PyObject *f) { return PyClassMethod_New(f); }
static PyObject *call_iter(PyObject *m, PyObject *a) {
    PyObject *f, *sentinel;
    return PyArg_ParseTuple(a, "OO", &f, &sentinel) ? PyCallIter_New(f, sentinel) : NULL;
}
static PyObject *vectorcall_call(PyObject *m, PyObject *a) {
    PyObject *f, *args, *kw;
    if (!PyArg_ParseTuple(a, "OOO", &f, &args, &kw)) return NULL;
    return PyVectorcall_Call(f, args, kw == Py_None ? NULL : kw);
}
static PyObject *generic_alias(PyObject *m, PyObject *a) {
    PyObject *origin, *args;
    return PyArg_ParseTuple(a, "OO", &origin, &args) ? Py_GenericAlias(origin, args) : NULL;
}

/* ---- weakref, contextvar ------------------------------------------------------------------ */

/* (CheckRef, the referent through GetRef) */
static PyObject *weakref(PyObject *m, PyObject *o) {
    PyObject *ref = PyWeakref_NewRef(o, NULL), *obj;
    if (!ref) return NULL;
    int r = PyWeakref_GetRef(ref, &obj);
    PyObject *res = r < 0 ? NULL : Py_BuildValue("NN", PyBool_FromLong(PyWeakref_CheckRef(ref)),
                                                  r ? obj : Py_NewRef(Py_None));
    Py_DECREF(ref);
    return res;
}
/* (default before Set, value after Set) */
static PyObject *contextvar(PyObject *m, PyObject *a) {
    PyObject *def, *val, *v1, *v2;
    if (!PyArg_ParseTuple(a, "OO", &def, &val)) return NULL;
    PyObject *var = PyContextVar_New("cv", def);
    if (!var || PyContextVar_Get(var, NULL, &v1) < 0) return NULL;
    PyObject *token = PyContextVar_Set(var, val);
    if (!token || PyContextVar_Get(var, NULL, &v2) < 0) return NULL;
    Py_DECREF(token);
    Py_DECREF(var);
    return Py_BuildValue("NN", v1, v2);
}

/* ---- interpreter, threads, time ------------------------------------------------------------- */

static PyObject *builtins(PyObject *m, PyObject *u) { return Py_NewRef(PyEval_GetBuiltins()); }
/* every call returns what CPython's single-threaded embedding gives */
static PyObject *threads(PyObject *m, PyObject *u) {
    PyThreadState *ts = PyEval_SaveThread();
    PyEval_RestoreThread(ts);
    PyGILState_STATE g = PyGILState_Ensure();
    PyThreadState *this_ts = PyGILState_GetThisThreadState();
    PyGILState_Release(g);
    PyObject *tsdict = PyThreadState_GetDict();
    PyInterpreterState *interp = PyInterpreterState_Get();
    PyObject *idict = PyInterpreterState_GetDict(interp);
    return Py_BuildValue("NNNNN", PyBool_FromLong(PyThreadState_Get() != NULL),
                         PyBool_FromLong(this_ts != NULL), PyBool_FromLong(tsdict && PyDict_Check(tsdict)),
                         PyBool_FromLong(interp == PyInterpreterState_Main()),
                         PyBool_FromLong(idict && PyDict_Check(idict)));
}
static PyObject *times(PyObject *m, PyObject *u) {
    PyTime_t t, mono;
    if (PyTime_Time(&t) < 0 || PyTime_Monotonic(&mono) < 0) return NULL;
    return Py_BuildValue("NN", PyBool_FromLong(t > 0), PyBool_FromLong(mono > 0));
}
static PyObject *sys_get_object(PyObject *m, PyObject *a) {
    const char *name;
    if (!PyArg_ParseTuple(a, "s", &name)) return NULL;
    PyObject *r = PySys_GetObject(name);            /* borrowed */
    return r ? Py_NewRef(r) : Py_NewRef(Py_None);
}
static PyObject *sys_audit(PyObject *m, PyObject *u) {
    return PySys_Audit("_capi_runtime.event", "i", 1) < 0 ? NULL : Py_NewRef(Py_None);
}

/* ---- OS helpers ------------------------------------------------------------------------------ */

static PyObject *os_fspath(PyObject *m, PyObject *o) { return PyOS_FSPath(o); }
/* (value, chars consumed) */
static PyObject *os_string_to_double(PyObject *m, PyObject *a) {
    const char *s; char *end;
    if (!PyArg_ParseTuple(a, "s", &s)) return NULL;
    double v = PyOS_string_to_double(s, &end, NULL);
    if (v == -1.0 && PyErr_Occurred()) return NULL;
    return Py_BuildValue("dn", v, (Py_ssize_t)(end - s));
}
static PyObject *os_double_to_string(PyObject *m, PyObject *a) {
    double v; int code, prec, flags;      /* 'C' writes an int */
    if (!PyArg_ParseTuple(a, "dCii", &v, &code, &prec, &flags)) return NULL;
    int type;
    char *s = PyOS_double_to_string(v, (char)code, prec, flags, &type);
    if (!s) return NULL;
    PyObject *r = Py_BuildValue("si", s, type);
    PyMem_Free(s);
    return r;
}
static PyObject *os_strtol(PyObject *m, PyObject *a) {
    const char *s; int base; char *end;
    if (!PyArg_ParseTuple(a, "si", &s, &base)) return NULL;
    long v = PyOS_strtol(s, &end, base);
    unsigned long u = PyOS_strtoul(s, &end, base);
    return Py_BuildValue("lkn", v, u, (Py_ssize_t)(end - s));
}
static PyObject *os_strnicmp(PyObject *m, PyObject *a) {
    const char *x, *y; Py_ssize_t n;
    if (!PyArg_ParseTuple(a, "ssn", &x, &y, &n)) return NULL;
    int r = PyOS_strnicmp(x, y, n);
    return PyLong_FromLong(r < 0 ? -1 : r > 0);
}
static PyObject *os_snprintf(PyObject *m, PyObject *u) {
    char buf[8];
    int n = PyOS_snprintf(buf, sizeof buf, "%d-%s", 12, "abcdef");
    return Py_BuildValue("is", n, buf);
}

/* ---- small ones ----------------------------------------------------------------------------- */

static PyObject *is_(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    return PyArg_ParseTuple(a, "OO", &x, &y) ? PyBool_FromLong(Py_Is(x, y)) : NULL;
}
static PyObject *constants(PyObject *m, PyObject *u) {
    return Py_BuildValue("NNNNN", Py_GetConstant(Py_CONSTANT_NONE), Py_GetConstant(Py_CONSTANT_TRUE),
                         Py_GetConstant(Py_CONSTANT_ZERO), Py_GetConstant(Py_CONSTANT_EMPTY_STR),
                         Py_GetConstant(Py_CONSTANT_EMPTY_TUPLE));
}
static PyObject *hash_buffer(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t n;
    if (!PyArg_ParseTuple(a, "y#", &s, &n)) return NULL;
    return PyLong_FromSsize_t(Py_HashBuffer(s, n));
}
static PyObject *is_initialized(PyObject *m, PyObject *u) { return PyBool_FromLong(Py_IsInitialized()); }
static PyObject *recursive_call(PyObject *m, PyObject *u) {
    if (Py_EnterRecursiveCall(" in test")) return NULL;
    Py_LeaveRecursiveCall();
    Py_RETURN_NONE;
}
/* Py_ReprEnter twice on the same object: (first, second) */
static PyObject *repr_enter(PyObject *m, PyObject *o) {
    int a = Py_ReprEnter(o), b = Py_ReprEnter(o);
    if (a < 0 || b < 0) return NULL;
    Py_ReprLeave(o);
    return Py_BuildValue("ii", a, b);
}
static PyObject *uniquely_referenced(PyObject *m, PyObject *u) {
    PyObject *fresh = PyList_New(0);
    int r = PyUnstable_Object_IsUniquelyReferenced(fresh);
    Py_DECREF(fresh);
    return PyBool_FromLong(r);
}
static PyObject *tracemalloc(PyObject *m, PyObject *u) {
    static char block[16];
    int t = PyTraceMalloc_Track(0, (uintptr_t)block, sizeof block);
    int v = PyTraceMalloc_Untrack(0, (uintptr_t)block);
    return Py_BuildValue("ii", t, v);
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
#define N(name, fn, flags) {name, (PyCFunction)(void (*)(void))fn, flags, NULL}
static PyMethodDef methods[] = {
    M(module_add, METH_NOARGS), M(module_create2, METH_NOARGS), M(module_from_spec, METH_O),
    M(state_find_module, METH_NOARGS),
    M(capsule_new, METH_NOARGS), M(capsule_read, METH_O), M(capsule_set, METH_O),
    M(capsule_wrong_name, METH_O), M(capsule_import, METH_VARARGS),
    M(parse_formats, METH_VARARGS), M(parse_converter, METH_VARARGS),
    M(parse_keywords, METH_VARARGS | METH_KEYWORDS), M(va_parse_keywords, METH_VARARGS | METH_KEYWORDS),
    M(parse_single, METH_O), M(unpack_tuple, METH_VARARGS), M(build_values, METH_NOARGS),
    M(import_module, METH_VARARGS), N("import_", import_, METH_O), M(import_attr, METH_VARARGS),
    M(add_module, METH_VARARGS), M(module_dict, METH_NOARGS),
    M(cfunction, METH_VARARGS), M(method_new, METH_VARARGS), M(instancemethod_new, METH_O),
    M(classmethod_new, METH_O), M(call_iter, METH_VARARGS), M(vectorcall_call, METH_VARARGS),
    M(generic_alias, METH_VARARGS),
    M(weakref, METH_O), M(contextvar, METH_VARARGS),
    M(builtins, METH_NOARGS), M(threads, METH_NOARGS), M(times, METH_NOARGS),
    M(sys_get_object, METH_VARARGS), M(sys_audit, METH_NOARGS),
    M(os_fspath, METH_O), M(os_string_to_double, METH_VARARGS),
    M(os_double_to_string, METH_VARARGS), M(os_strtol, METH_VARARGS),
    M(os_strnicmp, METH_VARARGS), M(os_snprintf, METH_NOARGS),
    N("is_", is_, METH_VARARGS), M(constants, METH_NOARGS), M(hash_buffer, METH_VARARGS),
    M(is_initialized, METH_NOARGS), M(recursive_call, METH_NOARGS), M(repr_enter, METH_O),
    M(uniquely_referenced, METH_NOARGS), M(tracemalloc, METH_NOARGS),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_runtime", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_runtime(void) {
    PyObject *m = PyModule_Create(&def);
    if (!m) return NULL;
    if (PyModule_Add(m, "CAPSULE", capsule_new(m, NULL)) < 0) { Py_DECREF(m); return NULL; }
    return m;
}
