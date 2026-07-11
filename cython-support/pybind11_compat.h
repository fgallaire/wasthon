/*
 * pybind11_compat.h — wasthon support layer for pybind11 (2.13.6) modules.
 *
 * Force-included (via -include) when compiling pybind11-based extensions
 * (matplotlib, contourpy, kiwisolver). Same role as cython_compat.h for
 * Cython: a bounded batch of C-API symbols pybind11 needs that wasthon.h
 * doesn't expose. Everything here is either a trivial macro over an
 * existing bridge function, a mono-thread stub, or an extern resolved by
 * the bridge at link time.
 *
 * Pairs with a small set of surgical seds on the pybind11 headers (raw
 * `ob_type` field reads, the traceback-walk block in error_string) — see
 * mplbuild.sh.
 */
#ifndef WASTHON_PYBIND11_COMPAT_H
#define WASTHON_PYBIND11_COMPAT_H

#include "Python.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- single-thread TLS (pybind11 internals / loader_life_support) ---- */
typedef struct { void *value; int initialized; } Py_tss_t;
#define Py_tss_NEEDS_INIT {0, 0}
static inline int   PyThread_tss_create(Py_tss_t *key) { key->initialized = 1; return 0; }
static inline int   PyThread_tss_is_created(Py_tss_t *key) { return key->initialized; }
static inline void *PyThread_tss_get(Py_tss_t *key) { return key->value; }
static inline int   PyThread_tss_set(Py_tss_t *key, void *value) { key->value = value; return 0; }
static inline void  PyThread_tss_delete(Py_tss_t *key) { key->value = NULL; }
static inline Py_tss_t *PyThread_tss_alloc(void) { return (Py_tss_t *)calloc(1, sizeof(Py_tss_t)); }
static inline void  PyThread_tss_free(Py_tss_t *key) { free(key); }

/* ---- thread-state stubs (single-threaded wasm) ---- */
static inline PyThreadState *PyThreadState_New(void *interp) { (void)interp; return PyThreadState_Get(); }
static inline PyThreadState *PyThreadState_GetUnchecked(void) { return PyThreadState_Get(); }
static inline void PyThreadState_Clear(PyThreadState *ts) { (void)ts; }
static inline void PyThreadState_DeleteCurrent(void) {}
static inline void PyEval_AcquireThread(PyThreadState *ts) { (void)ts; }
static inline void PyEval_ReleaseThread(PyThreadState *ts) { (void)ts; }

/* ---- trivial macros over existing bridge functions ---- */
#define PyWeakref_Check(o) PyWeakref_CheckRef(o)
#define PySet_Size(s) PySet_GET_SIZE(s)
static inline int PyObject_HasAttr(PyObject *o, PyObject *n) { return PyObject_HasAttrWithError(o, n) == 1; }
#define PyFrozenSet_Check(o) (Py_TYPE(o) == &PyFrozenSet_Type)
#define PyAnySet_Check(o) (PyFrozenSet_Check(o) || Py_TYPE(o) == &PySet_Type)
static inline int PyType_HasFeature(PyTypeObject *t, unsigned long f) { return (t->tp_flags & f) != 0; }
static inline const char *Py_GetVersion(void) { return "3.14.0 (wasthon)"; }
static inline PyObject *PyMemoryView_FromBuffer(const Py_buffer *v)
    { return PyMemoryView_FromMemory((char *)v->buf, v->len, v->readonly ? PyBUF_READ : PyBUF_WRITE); }
static inline int PyObject_DelAttr(PyObject *o, PyObject *n) { return PyObject_SetAttr(o, n, NULL); }
static inline int PyObject_DelAttrString(PyObject *o, const char *n) { return PyObject_SetAttrString(o, n, NULL); }
static inline PyObject *PyByteArray_FromObject(PyObject *o)
    { return PyObject_CallFunctionObjArgs((PyObject *)&PyByteArray_Type, o, NULL); }
static inline int PySet_Clear(PyObject *s)
    { PyObject *r = PyObject_CallMethod(s, "clear", NULL); if (!r) return -1; Py_DECREF(r); return 0; }

/* ---- managed dict: the flag is never set bridge-side, checks are false ---- */
#ifndef Py_TPFLAGS_MANAGED_DICT
#define Py_TPFLAGS_MANAGED_DICT (1UL << 4)
#endif
static inline int  PyObject_VisitManagedDict(PyObject *o, visitproc v, void *a) { (void)o; (void)v; (void)a; return 0; }
static inline void PyObject_ClearManagedDict(PyObject *o) { (void)o; }
static inline PyObject **_PyObject_GetDictPtr(PyObject *o) { (void)o; return NULL; }
static inline int PyObject_GenericSetDict(PyObject *o, PyObject *v, void *ctx)
    { (void)ctx; return PyObject_SetAttrString(o, "__dict__", v); }

/* ---- in-place number ops: dispatch to the bridge's rich-op path.
 * Brython's operators fall back to __op__ when no __iop__ exists, and
 * pybind11 only reaches these through py::object arithmetic. ---- */
#define PyNumber_InPlaceAdd         PyNumber_Add
#define PyNumber_InPlaceSubtract    PyNumber_Subtract
#define PyNumber_InPlaceMultiply    PyNumber_Multiply
#define PyNumber_InPlaceTrueDivide  PyNumber_TrueDivide
#define PyNumber_InPlaceFloorDivide PyNumber_FloorDivide
#define PyNumber_InPlaceRemainder   PyNumber_Remainder
#define PyNumber_InPlaceLshift      PyNumber_Lshift
#define PyNumber_InPlaceRshift      PyNumber_Rshift
#define PyNumber_InPlaceAnd         PyNumber_And
#define PyNumber_InPlaceOr          PyNumber_Or
#define PyNumber_InPlaceXor         PyNumber_Xor

/* ---- method objects. Bridge C-function objects placed in class dicts
 * already bind as methods (tp_descr_get saga, e73a254); pybind11's
 * instancemethod wrapper is therefore the identity. ---- */
static inline PyObject *PyInstanceMethod_New(PyObject *func) { Py_INCREF(func); return func; }
static inline int PyInstanceMethod_Check(PyObject *o) { (void)o; return 0; }
#define PyInstanceMethod_GET_FUNCTION(o) (o)
static inline int PyMethod_Check(PyObject *o) { (void)o; return 0; }
#define PyMethod_GET_FUNCTION(o) (o)

/* ---- declared here until a module actually links them (the bridge
 * provides PyProperty_Type / PyCapsule_GetName / PyCapsule_SetPointer /
 * PyCFunction_NewEx since the pybind11 layer landed) ---- */
extern PyTypeObject PyStaticMethod_Type;
PyObject   *PyStaticMethod_New(PyObject *callable);
const char *PyModule_GetName(PyObject *module);
PyObject   *PyImport_AddModule(const char *name);
static inline PyObject *PyImport_ReloadModule(PyObject *m) { Py_INCREF(m); return m; }

/* ---- frame/code introspection: only reached from pybind11's
 * error_string() trace formatter, which mplbuild.sh disables at runtime
 * (`if (m_trace && 0)`). Complete the code struct so the dead block
 * still compiles. ---- */
struct _wasthon_code { PyObject *co_filename; PyObject *co_name; int co_argcount; };
static inline int PyFrame_GetLineNumber(PyFrameObject *f) { (void)f; return 0; }
static inline PyObject *PyEval_GetFrameLocals(void) { return NULL; }
static inline PyObject *PyEval_GetFrameGlobals(void) { return NULL; }
static inline PyObject *PyCode_GetVarnames(PyCodeObject *co) { (void)co; return NULL; }

/* Traceback layout for the runtime-disabled walk (pytypes.h sed swaps
 * PyTracebackObject for this). */
typedef struct __wasthon_tb_s { struct __wasthon_tb_s *tb_next; PyFrameObject *tb_frame; } __wasthon_tb;

#ifdef __cplusplus
}
#endif

#endif /* WASTHON_PYBIND11_COMPAT_H */
