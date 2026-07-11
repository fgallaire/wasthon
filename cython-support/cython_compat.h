/* cython_compat.h — minimal shim so Cython-generated C compiles against
 * wasthon.h. Feasibility probe: types/macros to satisfy the compiler +
 * prototypes for the handful of C-API funcs the bridge would implement.
 * Include BEFORE the Cython C (via -include). */
#ifndef WASTHON_CYTHON_COMPAT_H
#define WASTHON_CYTHON_COMPAT_H
#include <stdint.h>
#include "wasthon.h"
#ifdef __cplusplus
extern "C" {
#endif
#ifndef Py_Version
#define Py_Version 0x030E00F0UL
#endif

/* --- trivial typedefs/macros --- */
#ifndef PY_INT64_T
typedef int64_t PY_INT64_T;
#endif
#ifndef PY_SSIZE_T_MIN
#define PY_SSIZE_T_MIN (-PY_SSIZE_T_MAX - 1)
#endif
#ifndef CO_OPTIMIZED
#define CO_OPTIMIZED 0x0001
#endif
#ifndef CO_NEWLOCALS
#define CO_NEWLOCALS 0x0002
#endif
#ifndef CO_VARARGS
#define CO_VARARGS 0x0004
#endif
#ifndef CO_VARKEYWORDS
#define CO_VARKEYWORDS 0x0008
#endif
typedef uint32_t Py_UNICODE;
typedef PyObject *(*PyCFunctionWithKeywords)(PyObject *, PyObject *, PyObject *);
typedef PyObject *(*PyCMethod)(PyObject *, PyTypeObject *, PyObject *const *, size_t, PyObject *);

/* legacy unicode macros Cython still references on some paths (cosmetic here) */
#ifndef PyUnicode_GET_SIZE
#define PyUnicode_GET_SIZE(u) PyUnicode_GetLength(u)
#endif
#ifndef PyUnicode_AS_UNICODE
#define PyUnicode_AS_UNICODE(u) ((Py_UNICODE *)0)
#endif

/* exception-check macros → bridge helpers */
#ifndef PyExceptionClass_Check
#define PyExceptionClass_Check(x) PyType_Check(x)
#endif
#ifndef PyExceptionInstance_Check
#define PyExceptionInstance_Check(x) (!PyType_Check(x))
#endif
#ifndef PyTraceBack_Check
#define PyTraceBack_Check(x) 0
#endif

/* struct stubs: Cython pokes fields on these only for tuple fast-paths,
 * exception normalisation and traceback synthesis — give it the fields so
 * it compiles; the bridge routes the real behaviour through the handle map. */
/* PyListObject stays wasthon's alias (PyObject, no ob_item) — the list
 * fast-path __Pyx_PyList_FromArray is rewritten by the post-cythonize patch
 * to use PyList_SET_ITEM instead of poking ob_item. */
typedef struct { PyObject_HEAD PyObject *args; PyObject *traceback;
                 PyObject *context; PyObject *cause; } PyBaseExceptionObject;
typedef struct { PyBaseExceptionObject base; PyObject *value; } PyStopIterationObject;
typedef struct { PyObject_HEAD long hash; } _cy_hashcarrier;
struct _wasthon_code { PyObject_HEAD int co_flags; };  /* complete PyCodeObject */
struct _wasthon_frame { PyObject_HEAD struct _wasthon_frame *f_back; int f_lineno; };  /* complete PyFrameObject */
typedef struct { PyObject_HEAD } PyGenObject;  /* opaque: only used as a pointer */
typedef struct _PyTracebackObject { PyObject_HEAD struct _PyTracebackObject *tb_next;
                 struct _wasthon_frame *tb_frame; int tb_lasti; int tb_lineno; } PyTracebackObject;
/* PyCMethodObject embeds PyCFunctionObject as its FIRST member (CPython
 * layout). Cython's __pyx_CyFunctionObject starts with `PyCMethodObject func`
 * and reaches m_ml/m_self/vectorcall via `((PyCFunctionObject*)cyfunc)->...`,
 * so the embedded PyCFunctionObject (from wasthon.h) must be first or every
 * field offset (m_ml, vectorcall) is wrong → tp_call reads garbage. */
typedef struct { PyCFunctionObject func; PyTypeObject *mm_class; } PyCMethodObject;

/* traceback synthesis in __Pyx_AddTraceback (cosmetic): declared so it compiles;
 * the bridge stubs PyCode_NewEmpty/PyFrame_New → NULL so the block bails via
 * `goto bad` and simply adds no synthetic frame. */
#define PyThreadState_GET() PyThreadState_Get()
extern PyCodeObject *PyCode_NewEmpty(const char *, const char *, int);
extern PyFrameObject *PyFrame_New(PyThreadState *, PyCodeObject *, PyObject *, PyObject *);
extern int PyTraceBack_Here(PyFrameObject *);

/* 3.13 native-bytes int construction — REAL functionality (byteswap uses it to
 * build the int result from raw bytes). Implemented in wasthon.js. */
extern PyObject *PyLong_FromNativeBytes(const void *, size_t, int);
extern PyObject *PyLong_FromUnsignedNativeBytes(const void *, size_t, int);

/* newer / internal C-API funcs the bridge would provide (link-time contract) */
extern PyObject *PyImport_AddModuleRef(const char *);
extern PyObject *PyImport_ImportModuleLevelObject(PyObject *, PyObject *, PyObject *, PyObject *, int);
extern PyObject *PyModule_NewObject(PyObject *);
extern PyObject **_PyObject_GetDictPtr(PyObject *);
extern PyObject *PyUnstable_Code_NewWithPosOnlyArgs(int, int, int, int, int, int, PyObject *, PyObject *, PyObject *, PyObject *, PyObject *, PyObject *, PyObject *, PyObject *, PyObject *, int, PyObject *, PyObject *);
extern int64_t PyInterpreterState_GetID(void *);

/* except-block exception state (Cython with -DCYTHON_USE_EXC_INFO_STACK=0 uses
 * the public save/restore API around `except` blocks). */
extern void PyErr_GetExcInfo(PyObject **, PyObject **, PyObject **);
extern void PyErr_SetExcInfo(PyObject *, PyObject *, PyObject *);

/* --- type feature flags / helpers Cython references --- */
#ifndef Py_TPFLAGS_HAVE_VERSION_TAG
#define Py_TPFLAGS_HAVE_VERSION_TAG (1UL << 18)
#endif
/* Route through the bridge's PyType_GetFlags (correct for bridge types, whose
 * compact type struct is NOT a full _typeobject — reading (t)->tp_flags in C
 * would be out of bounds). Mirrors Cython's own __Pyx_PyType_HasFeature. */
#ifndef PyType_HasFeature
#define PyType_HasFeature(t, f) ((PyType_GetFlags(t) & (unsigned long)(f)) != 0)
#endif

/* C-API funcs Cython emits that the bridge lacked (impls in cython_support.js) */
extern PyObject *PyImport_GetModule(PyObject *);
extern int PySequence_SetItem(PyObject *, Py_ssize_t, PyObject *);
extern int PyObject_DelItem(PyObject *, PyObject *);
extern int PyObject_DelAttr(PyObject *, PyObject *);
extern PyObject *PyCFunction_NewEx(PyMethodDef *, PyObject *, PyObject *);
extern void *PyVectorcall_Function(PyObject *);

/* --- extras hit by numpy.random's Cython (_common / bit_generator) --- */
/* FP-exception guards: no-ops on modern CPython. */
#ifndef PyFPE_START_PROTECT
#define PyFPE_START_PROTECT(err_string, leave_stmt)
#endif
#ifndef PyFPE_END_PROTECT
#define PyFPE_END_PROTECT(v)
#endif
#ifndef METH_COEXIST
#define METH_COEXIST 0x0040
#endif
#ifndef Py_TPFLAGS_IS_ABSTRACT
#define Py_TPFLAGS_IS_ABSTRACT (1UL << 20)
#endif
#ifndef PyType_IS_GC
#define PyType_IS_GC(t) PyType_HasFeature((t), Py_TPFLAGS_HAVE_GC)
#endif
#ifndef PyUnicode_CHECK_INTERNED
#define PyUnicode_CHECK_INTERNED(op) 0
#endif
/* complex object view: Cython's cpython.complex reads ->cval.real / .imag. */
typedef struct { PyObject_HEAD Py_complex cval; } PyComplexObject;

extern const char *PyModule_GetName(PyObject *);
extern int PyObject_GC_IsFinalized(PyObject *);
extern Py_ssize_t PyUnicode_CopyCharacters(PyObject *, Py_ssize_t, PyObject *, Py_ssize_t, Py_ssize_t);
extern int PyUnicode_Resize(PyObject **, Py_ssize_t);
extern PyObject *PyNumber_InPlaceAdd(PyObject *, PyObject *);
extern PyObject *PyNumber_InPlaceMultiply(PyObject *, PyObject *);
extern PyObject *PyNumber_InPlaceFloorDivide(PyObject *, PyObject *);
extern PyObject *PyNumber_InPlaceRshift(PyObject *, PyObject *);
extern PyObject *PyNumber_InPlacePower(PyObject *, PyObject *, PyObject *);
extern PyObject *PyNumber_InPlaceSubtract(PyObject *, PyObject *);
extern PyObject *PyNumber_InPlaceTrueDivide(PyObject *, PyObject *);
extern PyObject *PyNumber_MatrixMultiply(PyObject *, PyObject *);
extern PyObject *PyNumber_InPlaceMatrixMultiply(PyObject *, PyObject *);
extern PyObject *PyException_GetTraceback(PyObject *);
extern const char *PyCapsule_GetName(PyObject *);

/* generator/coroutine machinery Cython's cpython.* cimports pull in (cold) */
#ifndef Py_file_input
#define Py_file_input 257
#endif
#ifndef PyGen_CheckExact
#define PyGen_CheckExact(op) 0
#endif
#ifndef PyAsyncGen_CheckExact
#define PyAsyncGen_CheckExact(op) 0
#endif
typedef enum { PYGEN_RETURN = 0, PYGEN_ERROR = -1, PYGEN_NEXT = 1 } PySendResult;
extern PySendResult PyIter_Send(PyObject *, PyObject *, PyObject **);
extern PyObject *PyRun_String(const char *, int, PyObject *, PyObject *);
extern PyFrameObject *PyThreadState_GetFrame(PyThreadState *);

/* ---- pandas._libs long tail (set API, locale codecs, misc) ---- */
extern int PySet_Add(PyObject *set, PyObject *key);
extern int PySet_Contains(PyObject *set, PyObject *key);
extern Py_ssize_t PySet_Size(PyObject *set);
extern PyObject *PySet_Pop(PyObject *set);
extern int PySet_Discard(PyObject *set, PyObject *key);
#ifndef PyFrozenSet_CheckExact
#define PyFrozenSet_CheckExact(op) PyObject_TypeCheck((PyObject *)(op), &PyFrozenSet_Type)
#endif
extern PyTypeObject PyFrozenSet_Type;
extern PyObject *PyCFunction_New(PyMethodDef *ml, PyObject *self);
extern void PyErr_PrintEx(int set_sys_last_vars);
extern PyObject *PyUnicode_EncodeLocale(PyObject *unicode, const char *errors);
extern PyObject *PyUnicode_DecodeLocale(const char *str, const char *errors);
extern PyObject *PyUnicode_FromUnicode(const void *u, Py_ssize_t size);
extern PyObject *PyStaticMethod_New(PyObject *callable);
extern PyObject *PyNumber_InPlaceAnd(PyObject *, PyObject *);
#ifndef Py_HUGE_VAL
#define Py_HUGE_VAL HUGE_VAL
#endif
extern PyObject *PyClassMethod_New(PyObject *callable);
extern int PyMethod_Check(PyObject *op);
extern PyObject *PyMethod_GET_FUNCTION(PyObject *meth);
extern PyObject *PyNumber_InPlaceRemainder(PyObject *, PyObject *);
/* Slice struct shape for Cython's direct field reads (start/stop/step are
 * PyObject* in CPython's sliceobject.h; the bridge object is a handle, so
 * a direct read is garbage). Code that DOES run them (pandas internals.pyx
 * slice_canonize) gets rerouted by the build recipe onto these GetAttr
 * helpers (one small leaked ref per read, bounded by call volume). */
typedef struct { PyObject_HEAD PyObject *start, *stop, *step; } PySliceObject;
static inline PyObject *__wasthon_slice_start(PyObject *s) { return PyObject_GetAttrString(s, "start"); }
static inline PyObject *__wasthon_slice_stop(PyObject *s)  { return PyObject_GetAttrString(s, "stop"); }
static inline PyObject *__wasthon_slice_step(PyObject *s)  { return PyObject_GetAttrString(s, "step"); }
/* wrapper descriptors (some generated TUs use these without including
 * descrobject.h — which redeclares them under the same guard) */
#ifndef WASTHON_WRAPPERBASE_DEFINED
#define WASTHON_WRAPPERBASE_DEFINED
typedef PyObject *(*wrapperfunc)(PyObject *self, PyObject *args, void *wrapped);
struct wrapperbase {
    const char *name;
    int offset;
    void *function;
    wrapperfunc wrapper;
    const char *doc;
    int flags;
    PyObject **name_strobj;
};
typedef struct {
    PyDescrObject d_common;
    struct wrapperbase *d_base;
    void *d_wrapped;
} PyWrapperDescrObject;
extern PyTypeObject PyWrapperDescr_Type;
extern PyObject *PyDescr_NewMember(PyTypeObject *type, PyMemberDef *member);
extern PyObject *PyDescr_NewClassMethod(PyTypeObject *type, PyMethodDef *method);
extern int PyDescr_IsData(PyObject *descr);
#endif

/* Cython gates its PEP-393 unicode paths on defined(PyUnicode_KIND) —
 * wasthon.h declares these as functions, invisible to the preprocessor
 * feature-test, so every module doing `ch in str` fell into the
 * Python-2-era wstr code. Mirror them as self-macros (CPython's own
 * pattern for function-also-macro APIs). */
#define PyUnicode_KIND PyUnicode_KIND
#define PyUnicode_DATA PyUnicode_DATA
/* CPython 3.12 removed the wchar_t legacy representation; with these still
 * visible, Cython keeps its dead wstr fallback branch compiled in. */
#undef PyUnicode_WCHAR_KIND
#undef PyUnicode_AS_UNICODE
#include <inttypes.h>
#ifndef CO_GENERATOR
#define CO_GENERATOR 0x0020
#endif
#ifndef PyType_CheckExact
#define PyType_CheckExact(op) (Py_TYPE(op) == &PyType_Type)
#endif

#ifdef __cplusplus
}
#endif

#endif
