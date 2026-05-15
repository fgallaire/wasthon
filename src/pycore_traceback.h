/* Wasthon shim for CPython's pycore_traceback.h. */
#ifndef Py_INTERNAL_TRACEBACK_H
#define Py_INTERNAL_TRACEBACK_H
#ifdef __cplusplus
extern "C" {
#endif

int _PyTraceback_Add(const char *funcname, const char *filename, int lineno);

#ifdef __cplusplus
}
#endif
#endif
