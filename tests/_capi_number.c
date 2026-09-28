/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_number — the bridge's int, float, complex, bool and number-protocol
 * C-API, one thin fixture per function (tests/test_number.py). Plain C-API:
 * it also builds against CPython, the reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <stdint.h>
#include <string.h>

/* the C sizes, which differ between CPython on 64 bits and wasm32 */
static PyObject *sizes(PyObject *m, PyObject *u) {
    return Py_BuildValue("{sisisi}", "long", (int)sizeof(long),
                         "ssize_t", (int)sizeof(Py_ssize_t), "long long", (int)sizeof(long long));
}

/* ---- int from C ---------------------------------------------------------- */

static PyObject *from_long(PyObject *m, PyObject *a) {
    long v;
    return PyArg_ParseTuple(a, "l", &v) ? PyLong_FromLong(v) : NULL;
}
static PyObject *from_unsigned_long(PyObject *m, PyObject *a) {
    unsigned long v;
    return PyArg_ParseTuple(a, "k", &v) ? PyLong_FromUnsignedLong(v) : NULL;
}
static PyObject *from_ssize_t(PyObject *m, PyObject *a) {
    Py_ssize_t v;
    return PyArg_ParseTuple(a, "n", &v) ? PyLong_FromSsize_t(v) : NULL;
}
static PyObject *from_size_t(PyObject *m, PyObject *a) {
    Py_ssize_t v;
    return PyArg_ParseTuple(a, "n", &v) ? PyLong_FromSize_t((size_t)v) : NULL;
}
static PyObject *from_long_long(PyObject *m, PyObject *a) {
    long long v;
    return PyArg_ParseTuple(a, "L", &v) ? PyLong_FromLongLong(v) : NULL;
}
static PyObject *from_unsigned_long_long(PyObject *m, PyObject *a) {
    unsigned long long v;
    return PyArg_ParseTuple(a, "K", &v) ? PyLong_FromUnsignedLongLong(v) : NULL;
}
static PyObject *from_int64(PyObject *m, PyObject *a) {
    long long v;
    return PyArg_ParseTuple(a, "L", &v) ? PyLong_FromInt64((int64_t)v) : NULL;
}
static PyObject *from_uint32(PyObject *m, PyObject *a) {
    unsigned int v;
    return PyArg_ParseTuple(a, "I", &v) ? PyLong_FromUInt32((uint32_t)v) : NULL;
}
static PyObject *from_double(PyObject *m, PyObject *a) {
    double v;
    return PyArg_ParseTuple(a, "d", &v) ? PyLong_FromDouble(v) : NULL;
}
/* (value, bytes consumed) */
static PyObject *from_string(PyObject *m, PyObject *a) {
    const char *s; int base; char *end;
    if (!PyArg_ParseTuple(a, "yi", &s, &base)) return NULL;
    PyObject *v = PyLong_FromString(s, &end, base);
    return v ? Py_BuildValue("Nn", v, (Py_ssize_t)(end - s)) : NULL;
}
static PyObject *from_unicode_object(PyObject *m, PyObject *a) {
    PyObject *s; int base;
    return PyArg_ParseTuple(a, "Ui", &s, &base) ? PyLong_FromUnicodeObject(s, base) : NULL;
}
static PyObject *void_ptr_round_trip(PyObject *m, PyObject *u) {
    static int anchor;
    PyObject *o = PyLong_FromVoidPtr(&anchor);
    if (!o) return NULL;
    void *p = PyLong_AsVoidPtr(o);
    Py_DECREF(o);
    return PyBool_FromLong(p == &anchor);
}

/* ---- int to C: each returns what C got, or the exception it set ---------- */

#define TO_C(name, ctype, call, back)                                   \
    static PyObject *name(PyObject *m, PyObject *o) {                   \
        ctype v = call(o);                                              \
        if (v == (ctype)-1 && PyErr_Occurred()) return NULL;            \
        return back(v);                                                 \
    }
TO_C(as_long, long, PyLong_AsLong, PyLong_FromLong)
TO_C(as_int, int, PyLong_AsInt, PyLong_FromLong)
TO_C(as_unsigned_long, unsigned long, PyLong_AsUnsignedLong, PyLong_FromUnsignedLong)
TO_C(as_unsigned_long_mask, unsigned long, PyLong_AsUnsignedLongMask, PyLong_FromUnsignedLong)
TO_C(as_ssize_t, Py_ssize_t, PyLong_AsSsize_t, PyLong_FromSsize_t)
TO_C(as_size_t, size_t, PyLong_AsSize_t, PyLong_FromSize_t)
TO_C(as_long_long, long long, PyLong_AsLongLong, PyLong_FromLongLong)
TO_C(as_unsigned_long_long, unsigned long long, PyLong_AsUnsignedLongLong, PyLong_FromUnsignedLongLong)
TO_C(as_double, double, PyLong_AsDouble, PyFloat_FromDouble)

static PyObject *as_uint32(PyObject *m, PyObject *o) {
    uint32_t v;
    return PyLong_AsUInt32(o, &v) < 0 ? NULL : PyLong_FromUnsignedLong(v);
}
static PyObject *as_long_and_overflow(PyObject *m, PyObject *o) {
    int overflow;
    long v = PyLong_AsLongAndOverflow(o, &overflow);
    if (v == -1 && PyErr_Occurred()) return NULL;
    return Py_BuildValue("li", v, overflow);
}
static PyObject *as_long_long_and_overflow(PyObject *m, PyObject *o) {
    int overflow;
    long long v = PyLong_AsLongLongAndOverflow(o, &overflow);
    if (v == -1 && PyErr_Occurred()) return NULL;
    return Py_BuildValue("Li", v, overflow);
}

/* ---- int bits, bytes, sign, export ------------------------------------------ */

static PyObject *from_bytes(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t n; int little, is_signed;
    if (!PyArg_ParseTuple(a, "y#ii", &s, &n, &little, &is_signed)) return NULL;
    return _PyLong_FromByteArray((const unsigned char *)s, n, little, is_signed);
}
/* (bytes needed, the n bytes written) */
static PyObject *as_native_bytes(PyObject *m, PyObject *a) {
    PyObject *o; Py_ssize_t n; int flags;
    if (!PyArg_ParseTuple(a, "Oni", &o, &n, &flags)) return NULL;
    unsigned char buf[64] = {0};
    Py_ssize_t need = PyLong_AsNativeBytes(o, buf, n, flags);
    if (need < 0) return NULL;
    return Py_BuildValue("ny#", need, buf, n);
}
static PyObject *gcd(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    return PyArg_ParseTuple(a, "OO", &x, &y) ? _PyLong_GCD(x, y) : NULL;
}
static PyObject *is_zero(PyObject *m, PyObject *o) {
    int r = PyLong_IsZero(o);
    return r < 0 ? NULL : PyBool_FromLong(r);
}
static PyObject *get_sign(PyObject *m, PyObject *o) {
    int sign;
    return PyLong_GetSign(o, &sign) < 0 ? NULL : PyLong_FromLong(sign);
}
/* PyLong_Export then PyLongWriter back from its digits: the int rebuilt */
static PyObject *export_round_trip(PyObject *m, PyObject *o) {
    PyLongExport e;
    if (PyLong_Export(o, &e) < 0) return NULL;
    if (e.digits == NULL) return PyLong_FromInt64(e.value);
    const PyLongLayout *layout = PyLong_GetNativeLayout();
    void *digits;
    PyLongWriter *w = PyLongWriter_Create(e.negative, e.ndigits, &digits);
    if (!w) { PyLong_FreeExport(&e); return NULL; }
    memcpy(digits, e.digits, (size_t)e.ndigits * layout->digit_size);
    PyLong_FreeExport(&e);
    return PyLongWriter_Finish(w);
}
static PyObject *writer_discard(PyObject *m, PyObject *u) {
    void *digits;
    PyLongWriter *w = PyLongWriter_Create(0, 2, &digits);
    if (!w) return NULL;
    PyLongWriter_Discard(w);
    Py_RETURN_NONE;
}

/* ---- float --------------------------------------------------------------------- */

static PyObject *float_from_double(PyObject *m, PyObject *a) {
    double v;
    return PyArg_ParseTuple(a, "d", &v) ? PyFloat_FromDouble(v) : NULL;
}
static PyObject *float_as_double(PyObject *m, PyObject *o) {
    double v = PyFloat_AsDouble(o);
    return v == -1.0 && PyErr_Occurred() ? NULL : PyFloat_FromDouble(v);
}
static PyObject *float_from_string(PyObject *m, PyObject *s) { return PyFloat_FromString(s); }
static PyObject *float_check_exact(PyObject *m, PyObject *o) {
    return PyBool_FromLong(PyFloat_CheckExact(o));
}
/* PyFloat_PackN then PyFloat_UnpackN: (the bytes, the double read back) */
static PyObject *pack(PyObject *m, PyObject *a) {
    int size, le; double x;
    if (!PyArg_ParseTuple(a, "idi", &size, &x, &le)) return NULL;
    char buf[8];
    int r = size == 2 ? PyFloat_Pack2(x, buf, le) : size == 4 ? PyFloat_Pack4(x, buf, le)
                                                              : PyFloat_Pack8(x, buf, le);
    if (r < 0) return NULL;
    double y = size == 2 ? PyFloat_Unpack2(buf, le) : size == 4 ? PyFloat_Unpack4(buf, le)
                                                                : PyFloat_Unpack8(buf, le);
    if (y == -1.0 && PyErr_Occurred()) return NULL;
    return Py_BuildValue("y#d", buf, (Py_ssize_t)size, y);
}

/* ---- complex, bool ---------------------------------------------------------------- */

static PyObject *complex_from_doubles(PyObject *m, PyObject *a) {
    double r, i;
    return PyArg_ParseTuple(a, "dd", &r, &i) ? PyComplex_FromDoubles(r, i) : NULL;
}
static PyObject *complex_parts(PyObject *m, PyObject *o) {
    double r = PyComplex_RealAsDouble(o);
    if (r == -1.0 && PyErr_Occurred()) return NULL;
    double i = PyComplex_ImagAsDouble(o);
    if (i == -1.0 && PyErr_Occurred()) return NULL;
    return Py_BuildValue("dd", r, i);
}
static PyObject *complex_as_ccomplex(PyObject *m, PyObject *o) {
    Py_complex c = PyComplex_AsCComplex(o);
    if (c.real == -1.0 && PyErr_Occurred()) return NULL;
    return Py_BuildValue("dd", c.real, c.imag);
}
static PyObject *complex_from_ccomplex(PyObject *m, PyObject *a) {
    Py_complex c;
    return PyArg_ParseTuple(a, "dd", &c.real, &c.imag) ? PyComplex_FromCComplex(c) : NULL;
}
static PyObject *complex_check(PyObject *m, PyObject *o) { return PyBool_FromLong(PyComplex_Check(o)); }
static PyObject *bool_from_long(PyObject *m, PyObject *a) {
    long v;
    return PyArg_ParseTuple(a, "l", &v) ? PyBool_FromLong(v) : NULL;
}
static PyObject *bool_check(PyObject *m, PyObject *o) { return PyBool_FromLong(PyBool_Check(o)); }

/* ---- number protocol ------------------------------------------------------------------ */

static PyObject *number_check(PyObject *m, PyObject *o) {
    return Py_BuildValue("NN", PyBool_FromLong(PyNumber_Check(o)), PyBool_FromLong(PyIndex_Check(o)));
}
static PyObject *number_index(PyObject *m, PyObject *o) { return PyNumber_Index(o); }
static PyObject *number_long(PyObject *m, PyObject *o) { return PyNumber_Long(o); }
static PyObject *number_float(PyObject *m, PyObject *o) { return PyNumber_Float(o); }
static PyObject *number_as_ssize_t(PyObject *m, PyObject *a) {
    PyObject *o, *exc;
    if (!PyArg_ParseTuple(a, "OO", &o, &exc)) return NULL;
    Py_ssize_t v = PyNumber_AsSsize_t(o, exc == Py_None ? NULL : exc);
    return v == -1 && PyErr_Occurred() ? NULL : PyLong_FromSsize_t(v);
}

static const struct { const char *name; PyObject *(*f)(PyObject *); } unary_ops[] = {
    {"abs", PyNumber_Absolute}, {"neg", PyNumber_Negative},
    {"pos", PyNumber_Positive}, {"invert", PyNumber_Invert}};
static PyObject *unop(PyObject *m, PyObject *a) {
    const char *op; PyObject *x;
    if (!PyArg_ParseTuple(a, "sO", &op, &x)) return NULL;
    for (size_t i = 0; i < sizeof unary_ops / sizeof *unary_ops; i++)
        if (!strcmp(op, unary_ops[i].name)) return unary_ops[i].f(x);
    PyErr_SetString(PyExc_ValueError, op);
    return NULL;
}
static const struct { const char *name; PyObject *(*f)(PyObject *, PyObject *); } binary_ops[] = {
    {"add", PyNumber_Add}, {"sub", PyNumber_Subtract}, {"mul", PyNumber_Multiply},
    {"floordiv", PyNumber_FloorDivide}, {"truediv", PyNumber_TrueDivide},
    {"mod", PyNumber_Remainder}, {"divmod", PyNumber_Divmod}, {"lshift", PyNumber_Lshift},
    {"rshift", PyNumber_Rshift}, {"and", PyNumber_And}, {"or", PyNumber_Or},
    {"xor", PyNumber_Xor}};
static PyObject *binop(PyObject *m, PyObject *a) {
    const char *op; PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "sOO", &op, &x, &y)) return NULL;
    for (size_t i = 0; i < sizeof binary_ops / sizeof *binary_ops; i++)
        if (!strcmp(op, binary_ops[i].name)) return binary_ops[i].f(x, y);
    PyErr_SetString(PyExc_ValueError, op);
    return NULL;
}
static PyObject *power(PyObject *m, PyObject *a) {
    PyObject *x, *y, *z;
    return PyArg_ParseTuple(a, "OOO", &x, &y, &z) ? PyNumber_Power(x, y, z) : NULL;
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
static PyMethodDef methods[] = {
    M(sizes, METH_NOARGS), M(from_long, METH_VARARGS), M(from_unsigned_long, METH_VARARGS),
    M(from_ssize_t, METH_VARARGS), M(from_size_t, METH_VARARGS),
    M(from_long_long, METH_VARARGS), M(from_unsigned_long_long, METH_VARARGS),
    M(from_int64, METH_VARARGS), M(from_uint32, METH_VARARGS), M(from_double, METH_VARARGS),
    M(from_string, METH_VARARGS), M(from_unicode_object, METH_VARARGS),
    M(void_ptr_round_trip, METH_NOARGS),
    M(as_long, METH_O), M(as_int, METH_O), M(as_unsigned_long, METH_O),
    M(as_unsigned_long_mask, METH_O), M(as_ssize_t, METH_O), M(as_size_t, METH_O),
    M(as_long_long, METH_O), M(as_unsigned_long_long, METH_O), M(as_double, METH_O),
    M(as_uint32, METH_O), M(as_long_and_overflow, METH_O), M(as_long_long_and_overflow, METH_O),
    M(from_bytes, METH_VARARGS),
    M(as_native_bytes, METH_VARARGS), M(gcd, METH_VARARGS), M(is_zero, METH_O),
    M(get_sign, METH_O), M(export_round_trip, METH_O), M(writer_discard, METH_NOARGS),
    M(float_from_double, METH_VARARGS), M(float_as_double, METH_O),
    M(float_from_string, METH_O), M(float_check_exact, METH_O), M(pack, METH_VARARGS),
    M(complex_from_doubles, METH_VARARGS), M(complex_parts, METH_O),
    M(complex_as_ccomplex, METH_O), M(complex_from_ccomplex, METH_VARARGS),
    M(complex_check, METH_O), M(bool_from_long, METH_VARARGS), M(bool_check, METH_O),
    M(number_check, METH_O), M(number_index, METH_O), M(number_long, METH_O),
    M(number_float, METH_O), M(number_as_ssize_t, METH_VARARGS),
    M(unop, METH_VARARGS), M(binop, METH_VARARGS), M(power, METH_VARARGS),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_number", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_number(void) { return PyModule_Create(&def); }
