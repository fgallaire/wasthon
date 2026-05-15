/* wasthon stub for pycore_long.h — converters used by clinic-generated glue. */
#ifndef WASTHON_PYCORE_LONG_H
#define WASTHON_PYCORE_LONG_H
#include "wasthon.h"
int _PyLong_UnsignedLong_Converter(PyObject *obj, void *ptr);
int _PyLong_UnsignedLongLong_Converter(PyObject *obj, void *ptr);
int _PyLong_UInt64_Converter(PyObject *obj, void *ptr);
int _PyLong_UInt32_Converter(PyObject *obj, void *ptr);
size_t     _PyLong_NumBits(PyObject *vv);
int        _PyLong_AsByteArray(void *v, unsigned char *bytes, size_t n,
                                int little_endian, int is_signed, int with_exceptions);
PyObject  *_PyLong_FromByteArray(const unsigned char *bytes, size_t n,
                                 int little_endian, int is_signed);
PyObject  *PyLong_FromSize_t(size_t v);

typedef PyObject PyLongObject;
#endif
