/* Wasthon shim for CPython's pycore_call.h.
 *
 * _PyObject_CallMethod is the internal variant of PyObject_CallMethod that
 * accepts a Python str object as the method name rather than a C string.
 * Used by bisect with pre-interned `state->str_insert`. We bridge it by
 * converting the str via PyUnicode_AsUTF8 and dispatching through the
 * public PyObject_CallMethod. */
#ifndef Py_INTERNAL_CALL_H
#define Py_INTERNAL_CALL_H
#ifdef __cplusplus
extern "C" {
#endif

PyObject *PyObject_CallMethod(PyObject *obj, const char *name, const char *fmt, ...);
const char *PyUnicode_AsUTF8(PyObject *unicode);

#define _PyObject_CallMethod(obj, name_obj, fmt, ...) \
    PyObject_CallMethod((obj), PyUnicode_AsUTF8((PyObject *)(name_obj)), (fmt), ##__VA_ARGS__)

#ifdef __cplusplus
}
#endif
#endif
