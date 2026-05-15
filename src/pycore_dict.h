/* wasthon stub for pycore_dict.h — _PyDict_Next iterates dict entries. */
#ifndef WASTHON_PYCORE_DICT_H
#define WASTHON_PYCORE_DICT_H
#include "wasthon.h"
int _PyDict_Next(PyObject *dict, Py_ssize_t *ppos,
                 PyObject **pkey, PyObject **pvalue, Py_hash_t *phash);
int _PyDict_SetItem_KnownHash(PyObject *dict, PyObject *key, PyObject *value,
                              Py_hash_t hash);
#endif
