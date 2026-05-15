/* Wasthon shim for CPython's pycore_ceval.h.
 * Only `_PyEval_GetBuiltin` is needed by the array module — it looks up a
 * builtin (like `iter`) by str. Route through the public builtins. */
#ifndef Py_INTERNAL_CEVAL_H
#define Py_INTERNAL_CEVAL_H
#ifdef __cplusplus
extern "C" {
#endif

PyObject *_PyEval_GetBuiltin(PyObject *name);

/* Recursion guard — single-threaded WASM, never overflows in practice;
 * return 0 (success/no overflow). */
#define _Py_EnterRecursiveCall(where) (0)
#define _Py_LeaveRecursiveCall()      ((void)0)
#define Py_EnterRecursiveCall(where)  (0)
#define Py_LeaveRecursiveCall()       ((void)0)

#ifdef __cplusplus
}
#endif
#endif
