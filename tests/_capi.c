/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi — the bridge's C-API tests (tests/test_types.py). Every type is built
 * twice from the SAME C functions: by PyType_FromSpec (slots) and as a static
 * PyTypeObject passed to PyType_Ready. The bridge has one path for each, so
 * any difference between the two is a bug in one of them.
 *
 * Plain C-API only: it also builds against CPython, the reference
 * (tests/cpython.sh). A test that fails there is a wrong test.
 *
 *   SpecObj / StaticObj      Obj(value): repr, str, hash, richcompare, iter,
 *                            call, getsets, members, methods, number and
 *                            sequence protocols; Py_nb_multiply next to
 *                            Py_sq_length, Py_nb_positive next to Py_sq_item
 *   SubSpec / SubStatic      a C subclass of each, adding one method
 *   FinalSpec / FinalStatic  no Py_TPFLAGS_BASETYPE: cannot be subclassed
 *   ImmutableSpec            Py_TPFLAGS_IMMUTABLETYPE: no class attribute set
 *   UninstantiableSpec       Py_TPFLAGS_DISALLOW_INSTANTIATION: no instance
 *   SequenceStatic           Py_TPFLAGS_SEQUENCE: matches a sequence pattern
 *   alloc_drop(T)            one T allocated and dropped in C
 *   deallocs()               how many Obj tp_dealloc has freed
 *   is_heaptype(T)           Py_TPFLAGS_HEAPTYPE in PyType_GetFlags(T)
 */
#include "Python.h"
#include "structmember.h"
#include <stddef.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    PyObject_HEAD
    long value;
    long pos;           /* iteration cursor */
    PyObject *tag;      /* a member, NULL until set */
} Obj;

static long n_dealloc;
static PyTypeObject *SpecObj;
static PyTypeObject StaticObj;

static int is_obj(PyObject *o) {
    return PyObject_TypeCheck(o, SpecObj) || PyObject_TypeCheck(o, &StaticObj);
}

/* an Obj's value or an int's, for the binary slots and richcompare */
static int as_long(PyObject *o, long *v) {
    if (is_obj(o)) { *v = ((Obj *)o)->value; return 1; }
    if (PyLong_Check(o)) { *v = PyLong_AsLong(o); return !PyErr_Occurred(); }
    return 0;
}

static PyObject *make(PyTypeObject *type, long value) {
    Obj *o = (Obj *)type->tp_alloc(type, 0);
    if (o) o->value = value;
    return (PyObject *)o;
}

static PyObject *obj_new(PyTypeObject *type, PyObject *args, PyObject *kw) {
    return make(type, 0);
}

static int obj_init(PyObject *self, PyObject *args, PyObject *kw) {
    static char *kwlist[] = {"value", NULL};
    long v = 0;
    if (!PyArg_ParseTupleAndKeywords(args, kw, "|l", kwlist, &v)) return -1;
    ((Obj *)self)->value = v;
    return 0;
}

static void obj_free(PyObject *self) {
    n_dealloc++;
    Py_CLEAR(((Obj *)self)->tag);
    Py_TYPE(self)->tp_free(self);
}
/* A heap type's instances own a reference to it, a static type's do not:
 * the only place the two types need different code. */
static void spec_dealloc(PyObject *self) {
    PyTypeObject *tp = Py_TYPE(self);
    obj_free(self);
    Py_DECREF(tp);
}
static void static_dealloc(PyObject *self) { obj_free(self); }

static PyObject *obj_repr(PyObject *self) {
    return PyUnicode_FromFormat("%s(%ld)", Py_TYPE(self)->tp_name, ((Obj *)self)->value);
}
static PyObject *obj_str(PyObject *self) {
    return PyUnicode_FromFormat("value=%ld", ((Obj *)self)->value);
}
static Py_hash_t obj_hash(PyObject *self) {
    long v = ((Obj *)self)->value;
    return v == -1 ? -2 : v;
}
static PyObject *obj_richcompare(PyObject *a, PyObject *b, int op) {
    long x, y;
    if (!as_long(a, &x) || !as_long(b, &y)) Py_RETURN_NOTIMPLEMENTED;
    Py_RETURN_RICHCOMPARE(x, y, op);
}
static PyObject *obj_iter(PyObject *self) {
    ((Obj *)self)->pos = 0;
    return Py_NewRef(self);
}
static PyObject *obj_iternext(PyObject *self) {
    Obj *o = (Obj *)self;
    return o->pos < o->value ? PyLong_FromLong(o->pos++) : NULL;
}
static PyObject *obj_call(PyObject *self, PyObject *args, PyObject *kw) {
    long x;
    if (!PyArg_ParseTuple(args, "l", &x)) return NULL;
    return PyLong_FromLong(((Obj *)self)->value + x);
}

static PyObject *get_value(PyObject *self, void *c) {
    return PyLong_FromLong(((Obj *)self)->value);
}
static int set_value(PyObject *self, PyObject *v, void *c) {
    if (v == NULL) {
        PyErr_SetString(PyExc_TypeError, "cannot delete value");
        return -1;
    }
    if (!PyLong_Check(v)) {
        PyErr_SetString(PyExc_TypeError, "value must be an int");
        return -1;
    }
    ((Obj *)self)->value = PyLong_AsLong(v);
    return PyErr_Occurred() ? -1 : 0;
}
static PyObject *get_doubled(PyObject *self, void *c) {
    return PyLong_FromLong(2 * ((Obj *)self)->value);
}
static PyGetSetDef obj_getset[] = {
    {"value", get_value, set_value, "the value", NULL},
    {"doubled", get_doubled, NULL, "twice the value", NULL},
    {NULL}};

static PyMemberDef obj_members[] = {
    {"tag", Py_T_OBJECT_EX, offsetof(Obj, tag), 0, NULL},
    {"pos", Py_T_LONG, offsetof(Obj, pos), Py_READONLY, NULL},
    {NULL}};

static PyObject *m_get(PyObject *self, PyObject *unused) {
    return PyLong_FromLong(((Obj *)self)->value);
}
static PyObject *m_add(PyObject *self, PyObject *x) {
    long v = PyLong_AsLong(x);
    if (v == -1 && PyErr_Occurred()) return NULL;
    return make(Py_TYPE(self), ((Obj *)self)->value + v);
}
static PyObject *m_total(PyObject *self, PyObject *args) {
    long s = ((Obj *)self)->value;
    for (Py_ssize_t i = 0; i < PyTuple_Size(args); i++) {
        long v = PyLong_AsLong(PyTuple_GetItem(args, i));
        if (v == -1 && PyErr_Occurred()) return NULL;
        s += v;
    }
    return PyLong_FromLong(s);
}
static PyObject *m_scaled(PyObject *self, PyObject *args, PyObject *kw) {
    static char *kwlist[] = {"factor", "offset", NULL};
    long factor, offset = 0;
    if (!PyArg_ParseTupleAndKeywords(args, kw, "l|l", kwlist, &factor, &offset))
        return NULL;
    return PyLong_FromLong(((Obj *)self)->value * factor + offset);
}
static PyObject *m_count(PyObject *self, PyObject *const *args, Py_ssize_t nargs) {
    return PyLong_FromSsize_t(nargs);
}
static PyObject *m_make(PyObject *cls, PyObject *x) {
    long v = PyLong_AsLong(x);
    if (v == -1 && PyErr_Occurred()) return NULL;
    return make((PyTypeObject *)cls, v);
}
static PyObject *m_twice(PyObject *unused, PyObject *x) {
    long v = PyLong_AsLong(x);
    if (v == -1 && PyErr_Occurred()) return NULL;
    return PyLong_FromLong(2 * v);
}
static PyMethodDef obj_methods[] = {
    {"get", m_get, METH_NOARGS, "the value"},
    {"add", m_add, METH_O, NULL},
    {"total", m_total, METH_VARARGS, NULL},
    {"scaled", (PyCFunction)(void (*)(void))m_scaled, METH_VARARGS | METH_KEYWORDS, NULL},
    {"count", (PyCFunction)(void (*)(void))m_count, METH_FASTCALL, NULL},
    {"make", m_make, METH_O | METH_CLASS, NULL},
    {"twice", m_twice, METH_O | METH_STATIC, NULL},
    {NULL}};

#define BINARY(name, expr)                                                  \
    static PyObject *name(PyObject *a, PyObject *b) {                       \
        long x, y;                                                          \
        if (!as_long(a, &x) || !as_long(b, &y)) Py_RETURN_NOTIMPLEMENTED;   \
        return make(is_obj(a) ? Py_TYPE(a) : Py_TYPE(b), expr);             \
    }
BINARY(nb_add, x + y)
BINARY(nb_subtract, x - y)
BINARY(nb_multiply, x * y)

static PyObject *nb_negative(PyObject *a) { return make(Py_TYPE(a), -((Obj *)a)->value); }
static PyObject *nb_positive(PyObject *a) { return make(Py_TYPE(a), ((Obj *)a)->value); }
static int nb_bool(PyObject *a) { return ((Obj *)a)->value != 0; }
static PyObject *nb_index(PyObject *a) { return PyLong_FromLong(((Obj *)a)->value); }
static PyObject *nb_float(PyObject *a) { return PyFloat_FromDouble(((Obj *)a)->value); }
static PyObject *nb_inplace_add(PyObject *a, PyObject *b) {
    long y;
    if (!is_obj(a) || !as_long(b, &y)) Py_RETURN_NOTIMPLEMENTED;
    ((Obj *)a)->value += y;
    return Py_NewRef(a);
}

static Py_ssize_t sq_length(PyObject *a) { return ((Obj *)a)->value; }
static PyObject *sq_item(PyObject *a, Py_ssize_t i) {
    if (i < 0 || i >= ((Obj *)a)->value) {
        PyErr_SetString(PyExc_IndexError, "Obj index out of range");
        return NULL;
    }
    return PyLong_FromSsize_t(10 * i);
}
static int sq_contains(PyObject *a, PyObject *x) {
    long v;
    if (!as_long(x, &v)) return 0;
    return 0 <= v && v < ((Obj *)a)->value;
}

#define OBJ_DOC "Obj(value=0): the bridge's test object"

static PyType_Slot obj_slots[] = {
    {Py_tp_new, obj_new}, {Py_tp_init, obj_init}, {Py_tp_dealloc, spec_dealloc},
    {Py_tp_repr, obj_repr}, {Py_tp_str, obj_str}, {Py_tp_hash, obj_hash},
    {Py_tp_richcompare, obj_richcompare}, {Py_tp_iter, obj_iter},
    {Py_tp_iternext, obj_iternext}, {Py_tp_call, obj_call},
    {Py_tp_getset, obj_getset}, {Py_tp_members, obj_members},
    {Py_tp_methods, obj_methods}, {Py_tp_doc, OBJ_DOC},
    {Py_nb_add, nb_add}, {Py_nb_subtract, nb_subtract}, {Py_nb_multiply, nb_multiply},
    {Py_nb_negative, nb_negative}, {Py_nb_positive, nb_positive}, {Py_nb_bool, nb_bool},
    {Py_nb_index, nb_index}, {Py_nb_int, nb_index}, {Py_nb_float, nb_float},
#ifdef Py_nb_inplace_add
    {Py_nb_inplace_add, nb_inplace_add},
#endif
    {Py_sq_length, sq_length}, {Py_sq_item, sq_item}, {Py_sq_contains, sq_contains},
    {0, NULL}};
static PyType_Spec obj_spec = {"_capi.SpecObj", sizeof(Obj), 0,
                               Py_TPFLAGS_DEFAULT | Py_TPFLAGS_BASETYPE, obj_slots};

static PyNumberMethods obj_as_number = {
    .nb_add = nb_add, .nb_subtract = nb_subtract, .nb_multiply = nb_multiply,
    .nb_negative = nb_negative, .nb_positive = nb_positive, .nb_bool = nb_bool,
    .nb_index = nb_index, .nb_int = nb_index, .nb_float = nb_float,
    .nb_inplace_add = nb_inplace_add};
static PySequenceMethods obj_as_sequence = {
    .sq_length = sq_length, .sq_item = sq_item, .sq_contains = sq_contains};

static PyTypeObject StaticObj = {
    PyVarObject_HEAD_INIT(NULL, 0)
    .tp_name = "_capi.StaticObj", .tp_basicsize = sizeof(Obj),
    .tp_flags = Py_TPFLAGS_DEFAULT | Py_TPFLAGS_BASETYPE, .tp_doc = OBJ_DOC,
    .tp_new = obj_new, .tp_init = obj_init, .tp_dealloc = static_dealloc,
    .tp_repr = obj_repr, .tp_str = obj_str, .tp_hash = obj_hash,
    .tp_richcompare = obj_richcompare, .tp_iter = obj_iter,
    .tp_iternext = obj_iternext, .tp_call = obj_call,
    .tp_getset = obj_getset, .tp_members = obj_members, .tp_methods = obj_methods,
    .tp_as_number = &obj_as_number, .tp_as_sequence = &obj_as_sequence};

/* A C subclass of each: inherits everything, adds extra(). */
static PyObject *m_extra(PyObject *self, PyObject *unused) {
    return PyLong_FromLong(100 * ((Obj *)self)->value);
}
static PyMethodDef sub_methods[] = {{"extra", m_extra, METH_NOARGS, NULL}, {NULL}};
static PyType_Slot sub_slots[] = {{Py_tp_methods, sub_methods}, {0, NULL}};
static PyType_Spec sub_spec = {"_capi.SubSpec", sizeof(Obj), 0, Py_TPFLAGS_DEFAULT, sub_slots};
static PyTypeObject SubStatic = {
    PyVarObject_HEAD_INIT(NULL, 0)
    .tp_name = "_capi.SubStatic", .tp_basicsize = sizeof(Obj),
    .tp_flags = Py_TPFLAGS_DEFAULT, .tp_base = &StaticObj, .tp_methods = sub_methods};

/* Without Py_TPFLAGS_BASETYPE. */
static PyType_Slot final_slots[] = {{Py_tp_new, obj_new}, {0, NULL}};
static PyType_Spec final_spec = {"_capi.FinalSpec", sizeof(Obj), 0, Py_TPFLAGS_DEFAULT, final_slots};
static PyTypeObject FinalStatic = {
    PyVarObject_HEAD_INIT(NULL, 0)
    .tp_name = "_capi.FinalStatic", .tp_basicsize = sizeof(Obj),
    .tp_flags = Py_TPFLAGS_DEFAULT, .tp_new = obj_new};

/* the other flags the bridge acts on, one type each */
static PyType_Slot flag_slots[] = {{0, NULL}};
static PyType_Spec immutable_spec = {"_capi.ImmutableSpec", sizeof(PyObject), 0,
                                     Py_TPFLAGS_DEFAULT | Py_TPFLAGS_IMMUTABLETYPE, flag_slots};
static PyType_Spec uninstantiable_spec = {"_capi.UninstantiableSpec", sizeof(PyObject), 0,
                                          Py_TPFLAGS_DEFAULT | Py_TPFLAGS_DISALLOW_INSTANTIATION,
                                          flag_slots};
static PyTypeObject SequenceStatic = {
    PyVarObject_HEAD_INIT(NULL, 0)
    .tp_name = "_capi.SequenceStatic", .tp_basicsize = sizeof(Obj),
    .tp_flags = Py_TPFLAGS_DEFAULT | Py_TPFLAGS_SEQUENCE,
    .tp_new = obj_new, .tp_init = obj_init, .tp_dealloc = static_dealloc,
    .tp_as_sequence = &obj_as_sequence};

/* ---- the rest of the type and allocation API ---------------------------- */

#ifdef WASTHON_H
/* implemented by src/wasthon.js, not declared in src/wasthon.h */
void PyErr_PrintEx(int set_sys_last_vars);
PyObject *PyDescr_NewClassMethod(PyTypeObject *type, PyMethodDef *method);
#endif

/* (tp_repr is obj_repr, nb_add is nb_add) as PyType_GetSlot reads them */
static PyObject *get_slot(PyObject *m, PyObject *type) {
    PyTypeObject *t = (PyTypeObject *)type;
    return Py_BuildValue("NN", PyBool_FromLong(PyType_GetSlot(t, Py_tp_repr) == (void *)obj_repr),
                         PyBool_FromLong(PyType_GetSlot(t, Py_nb_add) == (void *)nb_add));
}
static struct PyModuleDef def;
static PyObject *module_by_def(PyObject *m, PyObject *type) {
    PyObject *mod = PyType_GetModuleByDef((PyTypeObject *)type, &def);   /* borrowed */
    return mod ? PyBool_FromLong(mod == m) : NULL;
}
static PyObject *generic_new(PyObject *m, PyObject *type) {
    return PyType_GenericNew((PyTypeObject *)type, NULL, NULL);
}
static PyObject *generic_alloc(PyObject *m, PyObject *type) {
    return PyType_GenericAlloc((PyTypeObject *)type, 0);
}
static PyObject *modified(PyObject *m, PyObject *type) {
    PyType_Modified((PyTypeObject *)type);
    Py_RETURN_NONE;
}
static PyType_Slot plain_slots[] = {{0, NULL}};
static PyType_Spec plain_spec = {"_capi.Plain", sizeof(PyObject), 0, Py_TPFLAGS_DEFAULT, plain_slots};
/* a fresh heap type, frozen: (setting an attribute on it raises TypeError) */
static PyObject *freeze(PyObject *m, PyObject *u) {
    PyObject *t = PyType_FromSpec(&plain_spec);
    if (!t) return NULL;
    if (PyType_Freeze((PyTypeObject *)t) < 0) { Py_DECREF(t); return NULL; }
    int r = PyObject_SetAttrString(t, "x", Py_None);
    int raised = r < 0 && PyErr_ExceptionMatches(PyExc_TypeError);
    PyErr_Clear();
    Py_DECREF(t);
    return PyBool_FromLong(raised);
}
static PyObject *from_metaclass(PyObject *m, PyObject *base) {
    return PyType_FromMetaclass(NULL, m, &sub_spec, base);
}
/* PyObject_New, PyObject_Del; PyObject_Malloc + PyObject_Init */
static PyObject *object_new_init(PyObject *m, PyObject *type) {
    PyTypeObject *t = (PyTypeObject *)type;
    Obj *a = PyObject_New(Obj, t);
    if (!a) return NULL;
    int ok = Py_TYPE(a) == t;
    if (t->tp_flags & Py_TPFLAGS_HEAPTYPE) Py_DECREF(t);   /* PyObject_New took one */
    PyObject_Del(a);
    Obj *b = PyObject_Malloc(sizeof(Obj));
    if (!b) return PyErr_NoMemory();
    memset(b, 0, sizeof(Obj));
    PyObject *o = PyObject_Init((PyObject *)b, t);
    b->value = 9;
    return Py_BuildValue("NN", PyBool_FromLong(ok), o);
}
static PyObject *generic_hash(PyObject *m, PyObject *o) {
    return PyLong_FromSsize_t(PyObject_GenericHash(o));
}
static PyObject *seq_iter(PyObject *m, PyObject *seq) { return PySeqIter_New(seq); }
static PyGetSetDef extra_getset = {"triple", NULL, NULL, NULL, NULL};
static PyObject *get_triple(PyObject *self, void *c) {
    return PyLong_FromLong(3 * ((Obj *)self)->value);
}
/* a getset descriptor made at run time: its value on an instance of T */
static PyObject *descr_getset(PyObject *m, PyObject *a) {
    PyObject *type, *inst;
    if (!PyArg_ParseTuple(a, "OO", &type, &inst)) return NULL;
    extra_getset.get = get_triple;
    PyObject *d = PyDescr_NewGetSet((PyTypeObject *)type, &extra_getset);
    if (!d) return NULL;
    PyObject *r = PyObject_CallMethod(d, "__get__", "O", inst);
    Py_DECREF(d);
    return r;
}
static PyObject *cls_name(PyObject *cls, PyObject *u) { return PyObject_GetAttrString(cls, "__name__"); }
static PyMethodDef cls_name_def = {"cls_name", cls_name, METH_NOARGS | METH_CLASS, NULL};
/* a classmethod descriptor made at run time, called on T */
static PyObject *descr_classmethod(PyObject *m, PyObject *type) {
    PyObject *d = PyDescr_NewClassMethod((PyTypeObject *)type, &cls_name_def);
    if (!d) return NULL;
    PyObject *bound = PyObject_CallMethod(d, "__get__", "OO", Py_None, type);
    Py_DECREF(d);
    if (!bound) return NULL;
    PyObject *r = PyObject_CallNoArgs(bound);
    Py_DECREF(bound);
    return r;
}
static PyObject *warn_explicit(PyObject *m, PyObject *u) {
    return PyErr_WarnExplicit(PyExc_UserWarning, "explicit", "somefile.py", 12, "somemod", NULL) < 0
        ? NULL : Py_NewRef(Py_None);
}
/* PyObject_Print to a temporary FILE*, read back */
static PyObject *object_print(PyObject *m, PyObject *a) {
    PyObject *o; int flags;
    if (!PyArg_ParseTuple(a, "Oi", &o, &flags)) return NULL;
    FILE *f = tmpfile();
    if (!f) return PyErr_SetFromErrno(PyExc_OSError);
    if (PyObject_Print(o, f, flags) < 0) { fclose(f); return NULL; }
    char buf[256];
    size_t n = (size_t)ftell(f);
    rewind(f);
    n = fread(buf, 1, n < sizeof buf ? n : sizeof buf, f);
    fclose(f);
    return PyUnicode_FromStringAndSize(buf, (Py_ssize_t)n);
}
static PyObject *print_ex(PyObject *m, PyObject *u) {
    PyErr_SetString(PyExc_KeyError, "printed");
    PyErr_PrintEx(0);
    return PyBool_FromLong(PyErr_Occurred() != NULL);
}

static PyObject *alloc_drop(PyObject *m, PyObject *type) {
    PyObject *o = make((PyTypeObject *)type, 1);
    if (!o) return NULL;
    Py_DECREF(o);
    Py_RETURN_NONE;
}
static PyObject *deallocs(PyObject *m, PyObject *unused) {
    return PyLong_FromLong(n_dealloc);
}
static PyObject *is_heaptype(PyObject *m, PyObject *type) {
    return PyBool_FromLong(PyType_GetFlags((PyTypeObject *)type) & Py_TPFLAGS_HEAPTYPE);
}
static PyMethodDef mod_methods[] = {
    {"alloc_drop", alloc_drop, METH_O, NULL},
    {"deallocs", deallocs, METH_NOARGS, NULL},
    {"is_heaptype", is_heaptype, METH_O, NULL},
    {"get_slot", get_slot, METH_O, NULL},
    {"module_by_def", module_by_def, METH_O, NULL},
    {"generic_new", generic_new, METH_O, NULL},
    {"generic_alloc", generic_alloc, METH_O, NULL},
    {"modified", modified, METH_O, NULL},
    {"freeze", freeze, METH_NOARGS, NULL},
    {"from_metaclass", from_metaclass, METH_O, NULL},
    {"object_new_init", object_new_init, METH_O, NULL},
    {"generic_hash", generic_hash, METH_O, NULL},
    {"seq_iter", seq_iter, METH_O, NULL},
    {"descr_getset", descr_getset, METH_VARARGS, NULL},
    {"descr_classmethod", descr_classmethod, METH_O, NULL},
    {"warn_explicit", warn_explicit, METH_NOARGS, NULL},
    {"object_print", object_print, METH_VARARGS, NULL},
    {"print_ex", print_ex, METH_NOARGS, NULL},
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi", NULL, -1, mod_methods};

static int add(PyObject *m, const char *name, PyObject *type) {
    return type ? PyModule_AddObjectRef(m, name, type) : -1;
}

PyMODINIT_FUNC PyInit__capi(void) {
    PyObject *m = PyModule_Create(&def);
    if (!m) return NULL;
    SpecObj = (PyTypeObject *)PyType_FromSpec(&obj_spec);
    if (add(m, "SpecObj", (PyObject *)SpecObj) < 0
        || add(m, "SubSpec", PyType_FromModuleAndSpec(m, &sub_spec, (PyObject *)SpecObj)) < 0
        || add(m, "FinalSpec", PyType_FromSpec(&final_spec)) < 0
        || PyType_Ready(&StaticObj) < 0 || add(m, "StaticObj", (PyObject *)&StaticObj) < 0
        || PyType_Ready(&SubStatic) < 0 || add(m, "SubStatic", (PyObject *)&SubStatic) < 0
        || PyType_Ready(&FinalStatic) < 0 || add(m, "FinalStatic", (PyObject *)&FinalStatic) < 0
        || add(m, "ImmutableSpec", PyType_FromSpec(&immutable_spec)) < 0
        || add(m, "UninstantiableSpec", PyType_FromSpec(&uninstantiable_spec)) < 0
        || PyType_Ready(&SequenceStatic) < 0
        || add(m, "SequenceStatic", (PyObject *)&SequenceStatic) < 0) {
        Py_DECREF(m);
        return NULL;
    }
    return m;
}
