/* wasthon stub for pycore_unicodeobject.h — _PyUnicode_Copy + JoinArray. */
#ifndef WASTHON_PYCORE_UNICODEOBJECT_H
#define WASTHON_PYCORE_UNICODEOBJECT_H
#include "wasthon.h"
PyObject *_PyUnicode_Copy(PyObject *unicode);
PyObject *_PyUnicode_JoinArray(PyObject *separator, PyObject *const *items,
                                Py_ssize_t seqlen);
#endif
