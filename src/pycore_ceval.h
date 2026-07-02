/* Wasthon shim for CPython's pycore_ceval.h.
 * Only `_PyEval_GetBuiltin` is needed by the array module — it looks up a
 * builtin (like `iter`) by str. Route through the public builtins. */
#ifndef Py_INTERNAL_CEVAL_H
#define Py_INTERNAL_CEVAL_H
#ifdef __cplusplus
extern "C" {
#endif

PyObject *_PyEval_GetBuiltin(PyObject *name);

/* Recursion guard — a real depth counter in the bridge. The wasm stack is
 * a fixed 4 MB reservation and a blown stack is an uncatchable trap, so
 * the C recursion of _json/_pickle must convert depth into RecursionError
 * like CPython (500k-deep JSON nesting killed the page instead of
 * raising). Cap in the bridge ≈ Py_C_RECURSION_LIMIT. */
int wasthon_enter_recursive_call(const char *where);
void wasthon_leave_recursive_call(void);
#define _Py_EnterRecursiveCall(where) (wasthon_enter_recursive_call(where))
#define _Py_LeaveRecursiveCall()      (wasthon_leave_recursive_call())
#define Py_EnterRecursiveCall(where)  (wasthon_enter_recursive_call(where))
#define Py_LeaveRecursiveCall()       (wasthon_leave_recursive_call())

#ifdef __cplusplus
}
#endif
#endif
