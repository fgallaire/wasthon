/*
 * hashlib.h — wasthon's stand-in for CPython's Modules/hashlib.h.
 *
 * Provides the macros that sha2module.c, md5module.c, sha1module.c, etc.
 * rely on, expressed in terms of our wasthon.h bridge. Differs from CPython's
 * version by stubbing the GIL-release dance (wasthon is single-threaded).
 */
#ifndef WASTHON_HASHLIB_H
#define WASTHON_HASHLIB_H

#include "wasthon.h"

#define GET_BUFFER_VIEW_OR_ERROR(obj, viewp, erraction) do { \
        if (PyUnicode_Check((obj))) { \
            PyErr_SetString(PyExc_TypeError, \
                "Strings must be encoded before hashing"); \
            erraction; \
        } \
        if (!PyObject_CheckBuffer((obj))) { \
            PyErr_SetString(PyExc_TypeError, \
                "object supporting the buffer API required"); \
            erraction; \
        } \
        if (PyObject_GetBuffer((obj), (viewp), PyBUF_SIMPLE) == -1) { \
            erraction; \
        } \
        if ((viewp)->ndim > 1) { \
            PyErr_SetString(PyExc_BufferError, \
                "Buffer must be single dimension"); \
            PyBuffer_Release((viewp)); \
            erraction; \
        } \
    } while (0)

#define GET_BUFFER_VIEW_OR_ERROUT(obj, viewp) \
    GET_BUFFER_VIEW_OR_ERROR(obj, viewp, return NULL)

/* Single-threaded WASM: lock acquisitions are no-ops. */
#define ENTER_HASHLIB(obj)  ((void)(obj))
#define LEAVE_HASHLIB(obj)  ((void)(obj))

#define HASHLIB_INIT_MUTEX(obj) do { \
    (obj)->mutex = (PyMutex){0}; \
    (obj)->use_mutex = false; \
} while (0)

#define HASHLIB_GIL_MINSIZE 2048

/* `_Py_hashlib_data_argument` — back-compat bridge for the deprecated
 * `string` keyword. sha2module uses it to merge `data` and `string` into
 * a single effective input. Mirrors CPython's Modules/hashlib.h exactly
 * (return value and error text). */
static inline int
_Py_hashlib_data_argument(PyObject **res, PyObject *data, PyObject *string) {
    if (data != NULL && string == NULL) {
        // called as H(data) or H(data=...)
        *res = data;
        return 1;
    }
    else if (data == NULL && string != NULL) {
        // called as H(string=...)
        *res = string;
        return 1;
    }
    else if (data == NULL && string == NULL) {
        // fast path when no data is given
        *res = NULL;
        return 0;
    }
    else {
        // called as H(data=..., string)
        *res = NULL;
        PyErr_SetString(PyExc_TypeError,
                        "'data' and 'string' are mutually exclusive "
                        "and support for 'string' keyword parameter "
                        "is slated for removal in a future version.");
        return -1;
    }
}

#endif
