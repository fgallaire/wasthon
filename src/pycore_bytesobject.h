/* wasthon stub — _PyBytesWriter is a writable bytes builder. */
#ifndef WASTHON_PYCORE_BYTESOBJECT_H
#define WASTHON_PYCORE_BYTESOBJECT_H
#include "wasthon.h"

typedef struct {
    PyObject *buffer;
    Py_ssize_t allocated;
    Py_ssize_t min_size;
    int overallocate;
    int use_small_buffer;
    char small_buffer[512];
} _PyBytesWriter;

void  _PyBytesWriter_Init(_PyBytesWriter *writer);
void *_PyBytesWriter_Alloc(_PyBytesWriter *writer, Py_ssize_t size);
void *_PyBytesWriter_Prepare(_PyBytesWriter *writer, void *str, Py_ssize_t size);
void *_PyBytesWriter_Resize(_PyBytesWriter *writer, void *str, Py_ssize_t size);
PyObject *_PyBytesWriter_Finish(_PyBytesWriter *writer, void *str);
void  _PyBytesWriter_Dealloc(_PyBytesWriter *writer);

#endif
