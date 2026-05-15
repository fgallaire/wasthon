/* Wasthon shim for CPython's pycore_pyerrors.h. */
#ifndef Py_INTERNAL_PYERRORS_H
#define Py_INTERNAL_PYERRORS_H
#ifdef __cplusplus
extern "C" {
#endif

/* _PyErr_FormatNote — append a note to the current exception. We don't
 * track exception chaining in the bridge; no-op the side effect but
 * preserve the variadic API for callers. */
int _PyErr_FormatNote(const char *format, ...);

#ifdef __cplusplus
}
#endif
#endif
