/* Wasthon shim for CPython's pycore_import.h. */
#ifndef Py_INTERNAL_IMPORT_H
#define Py_INTERNAL_IMPORT_H
#ifdef __cplusplus
extern "C" {
#endif

int _PyImport_SetModule(PyObject *name, PyObject *module);

#ifdef __cplusplus
}
#endif
#endif
