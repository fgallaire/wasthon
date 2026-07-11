/* scipy_compat.h — extra recipe-level shims for scipy's Cython/C output, on
 * top of cython_compat.h. patchlevel.h advertises CPython 3.14, so Cython 3.3
 * emits 3.13/3.14 C-API and type-spec slots the wasthon bridge doesn't provide
 * yet. These are build-recipe shims only (no bridge change). Include AFTER
 * cython_compat.h via -include. */
#ifndef WASTHON_SCIPY_COMPAT_H
#define WASTHON_SCIPY_COMPAT_H
#ifdef __cplusplus
extern "C" {
#endif

/* Present in the bridge (wasthon.js) but undeclared in wasthon.h. */
PyObject *PyThreadState_GetDict(void);

/* 3.13+: strong-ref list getitem. */
#ifndef PyList_GetItemRef
#define PyList_GetItemRef(list, i) Py_XNewRef(PyList_GetItem((list), (i)))
#endif

/* In-place bitwise-or routes to the bridge's binary-or dispatch. */
#ifndef PyNumber_InPlaceOr
#define PyNumber_InPlaceOr(a, b) PyNumber_Or((a), (b))
#endif

/* 3.14: str equality, returns 1 / 0 / -1 like PyObject_RichCompareBool. */
#ifndef PyUnicode_Equal
#define PyUnicode_Equal(a, b) PyObject_RichCompareBool((a), (b), Py_EQ)
#endif

/* Interning is an optional optimisation; a no-op is correct. */
#ifndef PyUnicode_InternInPlace
#define PyUnicode_InternInPlace(p) ((void)0)
#endif

/* Cython kwargs are always str-keyed dicts. */
#ifndef PyArg_ValidateKeywordArguments
#define PyArg_ValidateKeywordArguments(kw) (1)
#endif

/* PEP 3134 handled-exception slot. The bridge keeps no exc_info stack
 * (CYTHON_USE_EXC_INFO_STACK=0); the call steals a reference, so dropping it
 * is refcount-correct. */
#ifndef PyErr_SetHandledException
#define PyErr_SetHandledException(exc) Py_XDECREF(exc)
#endif

/* HasAttr (2-arg, suppresses errors) via the bridge's error-returning form. */
static inline int __wasthon_HasAttr(PyObject *o, PyObject *n) {
    int r = PyObject_HasAttrWithError(o, n);
    if (r < 0) { PyErr_Clear(); return 0; }
    return r;
}
#ifndef PyObject_HasAttr
#define PyObject_HasAttr __wasthon_HasAttr
#endif

/* dict.setdefault */
static inline PyObject *__wasthon_DictSetDefault(PyObject *d, PyObject *k, PyObject *v) {
    PyObject *r = PyDict_GetItemWithError(d, k);
    if (r) return r;
    if (PyErr_Occurred()) return NULL;
    if (PyDict_SetItem(d, k, v) < 0) return NULL;
    return v;
}
#ifndef PyDict_SetDefault
#define PyDict_SetDefault __wasthon_DictSetDefault
#endif

/* __dict__ setter: the bridge has no managed-dict; __dict__ assignment on the
 * affected CyFunction types is unused in the ndimage path. */
static inline int __wasthon_GenericSetDict(PyObject *o, PyObject *v, void *ctx) {
    (void)o; (void)v; (void)ctx; return 0;
}
#ifndef PyObject_GenericSetDict
#define PyObject_GenericSetDict __wasthon_GenericSetDict
#endif

/* 3.12 managed-dict helpers — the bridge stores instance dicts explicitly.
 * VisitManagedDict must be a real function: Cython splits the call name and
 * its argument list across an #if/#endif, and a function-like macro does not
 * expand across the former directive. */
#ifndef PyObject_ClearManagedDict
#define PyObject_ClearManagedDict(o) ((void)0)
#endif
static inline int PyObject_VisitManagedDict(PyObject *o, visitproc v, void *a) {
    (void)o; (void)v; (void)a; return 0;
}
#ifndef Py_TPFLAGS_MANAGED_DICT
#define Py_TPFLAGS_MANAGED_DICT (1UL << 4)
#endif

/* Critical sections (free-threading, 3.13+). wasthon.h defines all four in the
 * expression form ((void)(op)) / ((void)0), but Cython 3.13+ uses them in brace
 * style (BEGIN with no '{', END sometimes with no ';'), which only balances with
 * CPython's default-build brace form. Override all four consistently. Since
 * wasthon.h groups them under one #ifndef Py_BEGIN_CRITICAL_SECTION guard, a
 * later re-include of wasthon.h sees BEGIN defined and skips the block, so these
 * survive. */
#undef Py_BEGIN_CRITICAL_SECTION
#undef Py_BEGIN_CRITICAL_SECTION2
#undef Py_END_CRITICAL_SECTION
#undef Py_END_CRITICAL_SECTION2
#define Py_BEGIN_CRITICAL_SECTION(op) {
#define Py_BEGIN_CRITICAL_SECTION2(a, b) {
#define Py_END_CRITICAL_SECTION() }
#define Py_END_CRITICAL_SECTION2() }

/* Type-spec slot ids omitted by wasthon.h (canonical CPython typeslots.h
 * values; free in the bridge's slot space). */
#ifndef Py_tp_base
#define Py_tp_base 48
#endif
#ifndef Py_tp_bases
#define Py_tp_bases 49
#endif
#ifndef Py_tp_vectorcall
#define Py_tp_vectorcall 82
#endif
#ifndef Py_nb_and
#define Py_nb_and 8            /* wasthon slot id — wasthon.js slotMap wires 8 -> __and__ */
#endif
#ifndef Py_am_send
#define Py_am_send 200         /* not wired js-side: unknown ids are skipped (generators drive tp_iternext) */
#endif
#ifndef Py_TPFLAGS_MANAGED_WEAKREF
#define Py_TPFLAGS_MANAGED_WEAKREF (1UL << 3)
#endif
#ifndef PyRange_Check
#define PyRange_Check(op) PyObject_TypeCheck(op, &PyRange_Type)
#endif

#ifdef __cplusplus
}
#endif

/* 3.10 am_send slot type — Cython 3.3 generator/coroutine code declares
 * am_send tables unconditionally on 3.10+; wasthon.h has PySendResult but no
 * sendfunc. */
typedef PySendResult (*sendfunc)(PyObject *iter, PyObject *value, PyObject **result);
#endif
