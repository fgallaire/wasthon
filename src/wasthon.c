/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * wasthon.c — definitions for the extern variables declared in wasthon.h
 *
 * The bridge treats `Py_None`, `PyExc_TypeError`, `PyType_Type`, etc. as
 * regular C extern variables (matching CPython source semantics, so that
 * unmodified `sha2module.c` etc. compile and link against this header).
 *
 * At runtime, before any of the ported modules are used, the host
 * (Brython side) must call `wasthon_init()`. That populates each
 * extern variable with a handle obtained from JS via the `wasthon_get_*`
 * accessors implemented in wasthon.js.
 */

#include "wasthon.h"

/* Weak fallback implementations of _PyUnicode_To{Decimal,Digit,Numeric}.
 * The real CPython versions (in Objects/unicodectype.c) are only linked
 * into the `unicodedata` module's build — when present, the linker picks
 * them over these weak stubs. For other modules (e.g. `_decimal`) that
 * reference the macros via wasthon.h but don't link the full Unicode
 * tables, these stubs keep the linker happy with an ASCII-only behaviour.
 * Anything outside ASCII returns -1 / -1.0 ("not a digit / not numeric"),
 * which is the safe answer for modules whose code paths don't depend on
 * Unicode digit recognition beyond ASCII. */
__attribute__((weak)) int _PyUnicode_ToDecimalDigit(unsigned int ch) {
    if (ch >= '0' && ch <= '9') return (int)(ch - '0');
    return -1;
}
__attribute__((weak)) int _PyUnicode_ToDigit(unsigned int ch) {
    if (ch >= '0' && ch <= '9') return (int)(ch - '0');
    return -1;
}
__attribute__((weak)) double _PyUnicode_ToNumeric(unsigned int ch) {
    if (ch >= '0' && ch <= '9') return (double)(ch - '0');
    return -1.0;
}

/* ---- Unicode str support ------------------------------------------ *
 * CPython's real case/predicate tables (Objects/unicodectype.c + the
 * 281 KB unicodetype_db.h) are linked into bundles that ship the
 * `unicodedata` module (wasthon-full). Expose them so Brython's str
 * methods can be CPython-exact (test_unicodedata test_method_checksum:
 * Brython's own Unicode tables diverge on ~2400 codepoints).
 *
 * Weak ASCII fallbacks keep bundles WITHOUT the table linkable; the
 * strong unicodectype.o definitions win when present. The shim
 * wasthon_uc_flags packs every predicate into one int so the JS side
 * crosses the boundary once per codepoint. */
extern int _PyUnicode_IsAlpha(unsigned int ch);
extern int _PyUnicode_IsDecimalDigit(unsigned int ch);
extern int _PyUnicode_IsDigit(unsigned int ch);
extern int _PyUnicode_IsNumeric(unsigned int ch);
extern int _PyUnicode_IsLowercase(unsigned int ch);
extern int _PyUnicode_IsUppercase(unsigned int ch);
extern int _PyUnicode_IsTitlecase(unsigned int ch);
extern int _PyUnicode_IsWhitespace(unsigned int ch);
extern int _PyUnicode_IsPrintable(unsigned int ch);
extern int _PyUnicode_IsCased(unsigned int ch);
extern int _PyUnicode_IsCaseIgnorable(unsigned int ch);
extern int _PyUnicode_ToLowerFull(unsigned int ch, unsigned int *res);
extern int _PyUnicode_ToUpperFull(unsigned int ch, unsigned int *res);
extern int _PyUnicode_ToTitleFull(unsigned int ch, unsigned int *res);
extern int _PyUnicode_ToFoldedFull(unsigned int ch, unsigned int *res);

__attribute__((weak)) int _PyUnicode_IsAlpha(unsigned int ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
__attribute__((weak)) int _PyUnicode_IsDecimalDigit(unsigned int ch) { return ch >= '0' && ch <= '9'; }
__attribute__((weak)) int _PyUnicode_IsDigit(unsigned int ch) { return ch >= '0' && ch <= '9'; }
__attribute__((weak)) int _PyUnicode_IsNumeric(unsigned int ch) { return ch >= '0' && ch <= '9'; }
__attribute__((weak)) int _PyUnicode_IsLowercase(unsigned int ch) { return ch >= 'a' && ch <= 'z'; }
__attribute__((weak)) int _PyUnicode_IsUppercase(unsigned int ch) { return ch >= 'A' && ch <= 'Z'; }
__attribute__((weak)) int _PyUnicode_IsTitlecase(unsigned int ch) { return 0; }
__attribute__((weak)) int _PyUnicode_IsWhitespace(unsigned int ch) {
    return ch == ' ' || (ch >= 0x09 && ch <= 0x0d);
}
__attribute__((weak)) int _PyUnicode_IsPrintable(unsigned int ch) { return ch >= 0x20 && ch < 0x7f; }
__attribute__((weak)) int _PyUnicode_IsCased(unsigned int ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
__attribute__((weak)) int _PyUnicode_IsCaseIgnorable(unsigned int ch) { return 0; }
__attribute__((weak)) int _PyUnicode_ToLowerFull(unsigned int ch, unsigned int *res) {
    res[0] = (ch >= 'A' && ch <= 'Z') ? ch + 32 : ch; return 1;
}
__attribute__((weak)) int _PyUnicode_ToUpperFull(unsigned int ch, unsigned int *res) {
    res[0] = (ch >= 'a' && ch <= 'z') ? ch - 32 : ch; return 1;
}
__attribute__((weak)) int _PyUnicode_ToTitleFull(unsigned int ch, unsigned int *res) {
    res[0] = (ch >= 'a' && ch <= 'z') ? ch - 32 : ch; return 1;
}
__attribute__((weak)) int _PyUnicode_ToFoldedFull(unsigned int ch, unsigned int *res) {
    res[0] = (ch >= 'A' && ch <= 'Z') ? ch + 32 : ch; return 1;
}

/* One call per codepoint returns all str predicates, bit-packed. */
int wasthon_uc_flags(unsigned int ch) {
    int f = 0;
    if (_PyUnicode_IsAlpha(ch))        f |= 1;
    if (_PyUnicode_IsDecimalDigit(ch)) f |= 2;
    if (_PyUnicode_IsDigit(ch))        f |= 4;
    if (_PyUnicode_IsNumeric(ch))      f |= 8;
    if (_PyUnicode_IsLowercase(ch))    f |= 16;
    if (_PyUnicode_IsUppercase(ch))    f |= 32;
    if (_PyUnicode_IsTitlecase(ch))    f |= 64;
    if (_PyUnicode_IsWhitespace(ch))   f |= 128;
    if (_PyUnicode_IsPrintable(ch))    f |= 256;
    if (_PyUnicode_IsCased(ch))        f |= 512;
    if (_PyUnicode_IsCaseIgnorable(ch)) f |= 1024;
    return f;
}
/* Full case mappings: write up to 3 codepoints to res[], return the count. */
int wasthon_uc_upper(unsigned int ch, unsigned int *res) { return _PyUnicode_ToUpperFull(ch, res); }
int wasthon_uc_lower(unsigned int ch, unsigned int *res) { return _PyUnicode_ToLowerFull(ch, res); }
int wasthon_uc_title(unsigned int ch, unsigned int *res) { return _PyUnicode_ToTitleFull(ch, res); }
int wasthon_uc_fold(unsigned int ch, unsigned int *res)  { return _PyUnicode_ToFoldedFull(ch, res); }

/* ---- Built-in type sentinels ---- */
/* Built-in type singletons: struct storage in BSS. Fields populated
 * by wasthon_init() from JS-side helpers. The address of each
 * struct is registered in the JS handle table at init so that
 * `(PyObject *)&PyTuple_Type` unwraps to Brython's `tuple` class. */
PyTypeObject PyType_Type    = {0};
PyTypeObject PyTuple_Type   = {0};
PyTypeObject PyDict_Type    = {0};
PyTypeObject PyList_Type    = {0};
PyTypeObject PyLong_Type    = {0};
PyTypeObject PyFloat_Type   = {0};
PyTypeObject PyUnicode_Type = {0};
PyTypeObject PyBytes_Type   = {0};
PyTypeObject PyByteArray_Type   = {0};
PyTypeObject PySet_Type         = {0};
PyTypeObject PyFrozenSet_Type   = {0};
PyTypeObject PyFunction_Type    = {0};
PyTypeObject PyPickleBuffer_Type = {0};
PyTypeObject PyWrapperDescr_Type = {0};   /* slot-wrapper descriptors (pandas' Cython method unpacking type-checks against it; never instantiated bridge-side) */
PyTypeObject _PyNone_Type        = {0};
PyTypeObject PyEllipsis_Type     = {0};
PyTypeObject _PyNotImplemented_Type = {0};
PyObject *Py_Ellipsis = (PyObject *)0;
PyTypeObject PyBool_Type    = {0};

/* ---- Exception class references ---- */
PyObject *PyExc_TypeError       = (PyObject *)0;
PyObject *PyExc_ValueError      = (PyObject *)0;
PyObject *PyExc_OverflowError   = (PyObject *)0;
PyObject *PyExc_RuntimeError    = (PyObject *)0;
PyObject *PyExc_MemoryError     = (PyObject *)0;
PyObject *PyExc_SystemError     = (PyObject *)0;
PyObject *PyExc_IndexError      = (PyObject *)0;
PyObject *PyExc_RecursionError  = (PyObject *)0;
PyObject *PyExc_EOFError        = (PyObject *)0;
PyObject *PyExc_StopIteration   = (PyObject *)0;
PyObject *PyExc_BufferError     = (PyObject *)0;
/* added for pygame (a type-defining C module) */
PyObject *PyExc_BaseException     = (PyObject *)0;
PyObject *PyExc_SyntaxError       = (PyObject *)0;
PyObject *PyExc_RuntimeWarning    = (PyObject *)0;
PyObject *PyExc_FutureWarning     = (PyObject *)0;
PyObject *PyExc_FileNotFoundError = (PyObject *)0;
PyObject *PyExc_IOError           = (PyObject *)0;
PyObject *PyExc_KeyError              = (PyObject *)0;
PyObject *PyExc_LookupError           = (PyObject *)0;
PyObject *PyExc_NotImplementedError   = (PyObject *)0;
PyObject *PyExc_UnicodeError          = (PyObject *)0;
PyObject *PyExc_UnicodeDecodeError    = (PyObject *)0;
PyObject *PyExc_UnicodeEncodeError    = (PyObject *)0;
PyObject *PyExc_ImportError           = (PyObject *)0;
PyObject *PyExc_ModuleNotFoundError   = (PyObject *)0;
PyObject *PyExc_GeneratorExit         = (PyObject *)0;
PyObject *PyExc_UnboundLocalError     = (PyObject *)0;
PyObject *PyExc_Exception             = (PyObject *)0;
PyObject *PyExc_OSError               = (PyObject *)0;
PyObject *PyExc_AttributeError        = (PyObject *)0;
PyObject *PyExc_ArithmeticError       = (PyObject *)0;
PyObject *PyExc_AssertionError        = (PyObject *)0;
PyObject *PyExc_DeprecationWarning    = (PyObject *)0;
PyObject *PyExc_Warning               = (PyObject *)0;
PyObject *PyExc_ResourceWarning       = (PyObject *)0;
PyObject *PyExc_ZeroDivisionError     = (PyObject *)0;
/* added for numpy 2.5.1 */
PyObject *PyExc_NameError             = (PyObject *)0;
PyObject *PyExc_UserWarning           = (PyObject *)0;
PyObject *PyExc_FloatingPointError    = (PyObject *)0;
PyObject *PyExc_ImportWarning         = (PyObject *)0;

/* ---- Type objects numpy identity-checks / subtypes (bound to Brython
 * classes in wasthon_init, same mechanism as PyLong_Type etc.) ---- */
PyTypeObject PyComplex_Type      = {0};
PyTypeObject PySlice_Type        = {0};
PyTypeObject PyBaseObject_Type   = {0};
PyTypeObject PyMemoryView_Type   = {0};
PyTypeObject PyDictProxy_Type    = {0};
PyTypeObject PyCFunction_Type    = {0};
PyTypeObject PyGetSetDescr_Type  = {0};
PyTypeObject PyMemberDescr_Type  = {0};
PyTypeObject PyMethodDescr_Type  = {0};
/* pybind11: base class of pybind11_static_property */
PyTypeObject PyProperty_Type     = {0};
PyTypeObject PyRange_Type        = {0};

/* ---- Singleton object handles ---- */
PyObject *Py_None  = (PyObject *)0;
PyObject *Py_True  = (PyObject *)0;
PyObject *Py_False = (PyObject *)0;
PyObject *Py_NotImplemented = (PyObject *)0;

/* ---- _PyLong_DigitValue lookup (used by binascii.unhexlify) ----
 * Mirror of CPython's table in Objects/longobject.c: char -> digit value
 * for bases 2-36, with 37 = "not a valid digit". */
const unsigned char _PyLong_DigitValue[256] = {
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
     0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 37, 37, 37, 37, 37, 37,
    37, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 37, 37, 37, 37,
    37, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
    37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37, 37,
};

/* ---- Accessors implemented JS-side in wasthon.js ---- */
extern PyObject *wasthon_get_PyExc_TypeError(void);
extern PyObject *wasthon_get_PyExc_ValueError(void);
extern PyObject *wasthon_get_PyExc_OverflowError(void);
extern PyObject *wasthon_get_PyExc_RuntimeError(void);
extern PyObject *wasthon_get_PyExc_MemoryError(void);
extern PyObject *wasthon_get_PyExc_SystemError(void);
extern PyObject *wasthon_get_PyExc_IndexError(void);
extern PyObject *wasthon_get_PyExc_RecursionError(void);
extern PyObject *wasthon_get_PyExc_EOFError(void);
extern PyObject *wasthon_get_PyExc_StopIteration(void);
extern PyObject *wasthon_get_PyExc_BufferError(void);
extern PyObject *wasthon_get_PyExc_BaseException(void);
extern PyObject *wasthon_get_PyExc_SyntaxError(void);
extern PyObject *wasthon_get_PyExc_RuntimeWarning(void);
extern PyObject *wasthon_get_PyExc_FutureWarning(void);
extern PyObject *wasthon_get_PyExc_FileNotFoundError(void);
extern PyObject *wasthon_get_PyExc_IOError(void);
extern PyObject *wasthon_get_PyExc_KeyError(void);
extern PyObject *wasthon_get_PyExc_AssertionError(void);
extern PyObject *wasthon_get_PyExc_LookupError(void);
extern PyObject *wasthon_get_PyExc_NotImplementedError(void);
extern PyObject *wasthon_get_PyExc_UnicodeError(void);
extern PyObject *wasthon_get_PyExc_UnicodeDecodeError(void);
extern PyObject *wasthon_get_PyExc_UnicodeEncodeError(void);
extern PyObject *wasthon_get_PyExc_ImportError(void);
extern PyObject *wasthon_get_PyExc_ModuleNotFoundError(void);
extern PyObject *wasthon_get_PyExc_GeneratorExit(void);
extern PyObject *wasthon_get_PyExc_UnboundLocalError(void);
extern PyObject *wasthon_get_PyExc_Exception(void);
extern PyObject *wasthon_get_PyExc_OSError(void);
extern PyObject *wasthon_get_PyExc_AttributeError(void);
extern PyObject *wasthon_get_PyExc_ArithmeticError(void);
extern PyObject *wasthon_get_PyExc_DeprecationWarning(void);
extern PyObject *wasthon_get_PyExc_Warning(void);
extern PyObject *wasthon_get_PyExc_ResourceWarning(void);
extern PyObject *wasthon_get_PyExc_ZeroDivisionError(void);
extern PyObject *wasthon_get_PyExc_NameError(void);
extern PyObject *wasthon_get_PyExc_UserWarning(void);
extern PyObject *wasthon_get_PyExc_FloatingPointError(void);
extern PyObject *wasthon_get_PyExc_ImportWarning(void);

extern PyObject *wasthon_get_Py_None(void);
extern PyObject *wasthon_get_Py_True(void);
extern PyObject *wasthon_get_Py_False(void);
extern PyObject *wasthon_get_Py_NotImplemented(void);
extern PyObject *wasthon_get_Py_Ellipsis(void);

/* JS-side helper: binds the struct address of each built-in type singleton
 * to the corresponding Brython class so unwrap(&PyTuple_Type) == _b_.tuple,
 * and provides a generic tp_iter that wraps PyObject_GetIter(). */
extern void wasthon_bind_builtin_type(int tag, PyTypeObject *type);
extern PyObject *wasthon_builtin_tp_iter(PyObject *self);
extern PyObject *wasthon_builtin_mp_subscript(PyObject *self, PyObject *key);
extern Py_ssize_t wasthon_builtin_mp_length(PyObject *self);
extern PyObject *wasthon_builtin_tuple_tp_new(PyTypeObject *type,
                                              PyObject *args, PyObject *kw);
extern PyObject *wasthon_builtin_float_tp_new(PyTypeObject *type,
                                              PyObject *args, PyObject *kw);
extern PyObject *wasthon_builtin_unicode_tp_new(PyTypeObject *type,
                                                PyObject *args, PyObject *kw);
extern PyObject *wasthon_builtin_bytes_tp_new(PyTypeObject *type,
                                              PyObject *args, PyObject *kw);
/* Shared mapping table for the built-in singletons — C extensions delegate
 * to it (pygame ScancodeWrapper: PyTuple_Type.tp_as_mapping->mp_subscript). */
static PyMappingMethods wasthon_builtin_as_mapping = {
    wasthon_builtin_mp_length,
    wasthon_builtin_mp_subscript,
    0,
};

/* Shared sequence table + hash: torch's THPSize captures
 * PyTuple_Type.tp_as_sequence->sq_repeat / mp_subscript into namespace-scope
 * statics and calls PyTuple_Type.tp_hash at runtime. RAW semantics
 * (no virtual re-dispatch), same rule as the mapping table. */
extern PyObject *wasthon_builtin_sq_concat(PyObject *, PyObject *);
extern PyObject *wasthon_builtin_sq_repeat(PyObject *, Py_ssize_t);
extern PyObject *wasthon_builtin_sq_item(PyObject *, Py_ssize_t);
extern Py_hash_t wasthon_builtin_tp_hash(PyObject *);
static PySequenceMethods wasthon_builtin_as_sequence = {
    .sq_length = wasthon_builtin_mp_length,
    .sq_concat = wasthon_builtin_sq_concat,
    .sq_repeat = wasthon_builtin_sq_repeat,
    .sq_item   = wasthon_builtin_sq_item,
};

/* Slot/table wiring for the built-in type singletons. MUST run before C++
 * static initializers: extension code captures these pointers at
 * namespace-scope init (torch THPSize: mp_subscript = PyTuple_Type.
 * tp_as_mapping->mp_subscript, sq_repeat likewise; pybind11 reads
 * PyType_Type.tp_alloc). Priority 101 orders this ctor ahead of every
 * default-priority (C++) initializer in __wasm_call_ctors. Pure pointer
 * stores only — no JS calls are legal this early. */
void wasthon_init_number_protocols(void);
__attribute__((constructor(101)))
static void wasthon_prime_builtin_slot_tables(void) {
    /* tp_as_number of int and float: _decimal and other modules cache their
     * nb_* pointers, a C++ static initializer as early as THPSize's */
    wasthon_init_number_protocols();
    PyType_Type.tp_iter    = wasthon_builtin_tp_iter;
    /* pybind11's get_internals() calls PyType_Type.tp_alloc(&PyType_Type, 0)
     * to build its 3 internal heap types by hand; hand back raw
     * PyHeapTypeObject memory (see wasthon_type_tp_alloc). */
    { extern PyObject *wasthon_type_tp_alloc(PyTypeObject *, Py_ssize_t);
      PyType_Type.tp_alloc = wasthon_type_tp_alloc; }
    PyTuple_Type.tp_iter   = wasthon_builtin_tp_iter;
    PyDict_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyList_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyLong_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyFloat_Type.tp_iter   = wasthon_builtin_tp_iter;
    PyFloat_Type.tp_new    = wasthon_builtin_float_tp_new;
    PyUnicode_Type.tp_iter = wasthon_builtin_tp_iter;
    PyUnicode_Type.tp_new  = wasthon_builtin_unicode_tp_new;
    PyBytes_Type.tp_iter   = wasthon_builtin_tp_iter;
    PyBytes_Type.tp_new    = wasthon_builtin_bytes_tp_new;
    PyByteArray_Type.tp_iter = wasthon_builtin_tp_iter;
    PySet_Type.tp_iter       = wasthon_builtin_tp_iter;
    PyFrozenSet_Type.tp_iter = wasthon_builtin_tp_iter;
    PyBool_Type.tp_iter    = wasthon_builtin_tp_iter;

    /* Protocol tables + tp_new on the sequence/mapping singletons: C code
     * delegates to them directly (pygame's ScancodeWrapper subscript and
     * tp_new go through PyTuple_Type) — NULL fields were indirect calls
     * to null. Generic shims dispatch to Brython. */
    PyTuple_Type.tp_as_mapping   = &wasthon_builtin_as_mapping;
    PyList_Type.tp_as_mapping    = &wasthon_builtin_as_mapping;
    PyDict_Type.tp_as_mapping    = &wasthon_builtin_as_mapping;
    PyUnicode_Type.tp_as_mapping = &wasthon_builtin_as_mapping;
    PyTuple_Type.tp_new = wasthon_builtin_tuple_tp_new;
    PyTuple_Type.tp_as_sequence = &wasthon_builtin_as_sequence;
    PyList_Type.tp_as_sequence  = &wasthon_builtin_as_sequence;
    PyTuple_Type.tp_hash = wasthon_builtin_tp_hash;
}

#define BT_TYPE     0
#define BT_TUPLE    1
#define BT_DICT     2
#define BT_LIST     3
#define BT_LONG     4
#define BT_FLOAT    5
#define BT_UNICODE  6
#define BT_BYTES    7
#define BT_BOOL     8
#define BT_BYTEARRAY 9
#define BT_SET      10
#define BT_FROZENSET 11
#define BT_FUNCTION 12
#define BT_PICKLEBUFFER 13
#define BT_NONETYPE 14
#define BT_ELLIPSIS 15
#define BT_NOTIMPLEMENTED 16
/* numpy 2.5.1 */
#define BT_COMPLEX      17
#define BT_SLICE        18
#define BT_OBJECT       19
#define BT_MEMORYVIEW   20
#define BT_MAPPINGPROXY 21
#define BT_CFUNCTION    22
#define BT_GETSETDESCR  23
#define BT_MEMBERDESCR  24
#define BT_METHODDESCR  25
/* pybind11 */
#define BT_PROPERTY     26
/* Cython 3.3 codegen calls range() through the static type */
#define BT_RANGE        27

/*
 * Called once after the WASM module is instantiated and before any
 * C-side code reads the externs above. Exposed via EMSCRIPTEN_KEEPALIVE
 * so the Brython-side loader can invoke it.
 */
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE
void wasthon_init(void) {
    Py_None  = wasthon_get_Py_None();
    Py_True  = wasthon_get_Py_True();
    Py_False = wasthon_get_Py_False();
    Py_NotImplemented = wasthon_get_Py_NotImplemented();
    Py_Ellipsis = wasthon_get_Py_Ellipsis();

    PyExc_TypeError      = wasthon_get_PyExc_TypeError();
    PyExc_ValueError     = wasthon_get_PyExc_ValueError();
    PyExc_OverflowError  = wasthon_get_PyExc_OverflowError();
    PyExc_RuntimeError   = wasthon_get_PyExc_RuntimeError();
    PyExc_MemoryError    = wasthon_get_PyExc_MemoryError();
    PyExc_SystemError    = wasthon_get_PyExc_SystemError();
    PyExc_IndexError     = wasthon_get_PyExc_IndexError();
    PyExc_RecursionError = wasthon_get_PyExc_RecursionError();
    PyExc_EOFError       = wasthon_get_PyExc_EOFError();
    PyExc_StopIteration  = wasthon_get_PyExc_StopIteration();
    PyExc_BufferError    = wasthon_get_PyExc_BufferError();
    PyExc_BaseException     = wasthon_get_PyExc_BaseException();
    PyExc_SyntaxError       = wasthon_get_PyExc_SyntaxError();
    PyExc_RuntimeWarning    = wasthon_get_PyExc_RuntimeWarning();
    PyExc_FutureWarning     = wasthon_get_PyExc_FutureWarning();
    PyExc_FileNotFoundError = wasthon_get_PyExc_FileNotFoundError();
    PyExc_IOError           = wasthon_get_PyExc_IOError();
    PyExc_KeyError              = wasthon_get_PyExc_KeyError();
    PyExc_AssertionError        = wasthon_get_PyExc_AssertionError();
    PyExc_LookupError           = wasthon_get_PyExc_LookupError();
    PyExc_NotImplementedError   = wasthon_get_PyExc_NotImplementedError();
    PyExc_UnicodeError          = wasthon_get_PyExc_UnicodeError();
    PyExc_UnicodeDecodeError    = wasthon_get_PyExc_UnicodeDecodeError();
    PyExc_UnicodeEncodeError    = wasthon_get_PyExc_UnicodeEncodeError();
    PyExc_ImportError           = wasthon_get_PyExc_ImportError();
    PyExc_ModuleNotFoundError   = wasthon_get_PyExc_ModuleNotFoundError();
    PyExc_GeneratorExit         = wasthon_get_PyExc_GeneratorExit();
    PyExc_UnboundLocalError     = wasthon_get_PyExc_UnboundLocalError();
    PyExc_Exception             = wasthon_get_PyExc_Exception();
    PyExc_OSError               = wasthon_get_PyExc_OSError();
    PyExc_AttributeError        = wasthon_get_PyExc_AttributeError();
    PyExc_ArithmeticError       = wasthon_get_PyExc_ArithmeticError();
    PyExc_DeprecationWarning    = wasthon_get_PyExc_DeprecationWarning();
    PyExc_Warning               = wasthon_get_PyExc_Warning();
    PyExc_ResourceWarning       = wasthon_get_PyExc_ResourceWarning();
    PyExc_ZeroDivisionError     = wasthon_get_PyExc_ZeroDivisionError();
    PyExc_NameError             = wasthon_get_PyExc_NameError();
    PyExc_UserWarning           = wasthon_get_PyExc_UserWarning();
    PyExc_FloatingPointError    = wasthon_get_PyExc_FloatingPointError();
    PyExc_ImportWarning         = wasthon_get_PyExc_ImportWarning();

    /* Bind each built-in type singleton's address to its Brython class.
     * The slot/table wiring itself lives in
     * wasthon_prime_builtin_slot_tables() — a ctor, NOT here: C++
     * namespace-scope initializers run during __wasm_call_ctors, before
     * any JS-driven init, and they CAPTURE these pointers (torch THPSize:
     * mp_subscript/sq_repeat grabbed at static init were still NULL →
     * every Size[i] was an indirect call to null). */
    wasthon_bind_builtin_type(BT_TYPE,    &PyType_Type);
    wasthon_bind_builtin_type(BT_RANGE,   &PyRange_Type);
    wasthon_bind_builtin_type(BT_TUPLE,   &PyTuple_Type);
    /* PyODict_Type — Brython has no separate OrderedDict at C-type level;
     * alias to dict so PyModule_AddType(&PyODict_Type) finds something.
     * MUST be bound BEFORE PyDict_Type: the JS bind keys
     * builtinTypeForClass on the Brython class, so a later bind for the
     * same class overwrites the earlier struct-pointer. PyDict_Type must
     * win because pickle's `type == &PyDict_Type` dispatch is what makes
     * Py_TYPE(dict_instance) reach save_dict. */
    wasthon_bind_builtin_type(BT_DICT,    &PyODict_Type);
    wasthon_bind_builtin_type(BT_DICT,    &PyDict_Type);
    wasthon_bind_builtin_type(BT_LIST,    &PyList_Type);
    wasthon_bind_builtin_type(BT_LONG,    &PyLong_Type);
    wasthon_bind_builtin_type(BT_FLOAT,   &PyFloat_Type);
    wasthon_bind_builtin_type(BT_UNICODE, &PyUnicode_Type);
    wasthon_bind_builtin_type(BT_BYTES,       &PyBytes_Type);
    wasthon_bind_builtin_type(BT_BYTEARRAY,   &PyByteArray_Type);
    wasthon_bind_builtin_type(BT_SET,         &PySet_Type);
    wasthon_bind_builtin_type(BT_FROZENSET,   &PyFrozenSet_Type);
    wasthon_bind_builtin_type(BT_FUNCTION,    &PyFunction_Type);
    wasthon_bind_builtin_type(BT_PICKLEBUFFER, &PyPickleBuffer_Type);
    wasthon_bind_builtin_type(BT_BOOL,        &PyBool_Type);
    /* Singleton types — _pickle's save_type compares the type object against
     * these externs (`obj == &_PyNone_Type`) to emit (type, (None,)) etc.;
     * without the binding it falls to save_global → unpicklable builtins.NoneType. */
    wasthon_bind_builtin_type(BT_NONETYPE,        &_PyNone_Type);
    wasthon_bind_builtin_type(BT_ELLIPSIS,        &PyEllipsis_Type);
    wasthon_bind_builtin_type(BT_NOTIMPLEMENTED,  &_PyNotImplemented_Type);
    wasthon_bind_builtin_type(BT_COMPLEX,      &PyComplex_Type);
    wasthon_bind_builtin_type(BT_SLICE,        &PySlice_Type);
    wasthon_bind_builtin_type(BT_OBJECT,       &PyBaseObject_Type);
    wasthon_bind_builtin_type(BT_MEMORYVIEW,   &PyMemoryView_Type);
    wasthon_bind_builtin_type(BT_MAPPINGPROXY, &PyDictProxy_Type);
    wasthon_bind_builtin_type(BT_CFUNCTION,    &PyCFunction_Type);
    wasthon_bind_builtin_type(BT_GETSETDESCR,  &PyGetSetDescr_Type);
    wasthon_bind_builtin_type(BT_MEMBERDESCR,  &PyMemberDescr_Type);
    wasthon_bind_builtin_type(BT_METHODDESCR,  &PyMethodDescr_Type);
    /* PyProperty_Type is deliberately NOT bound here. Binding it in the shared
     * wasthon_init shifts the CPython bundle's wasm layout just enough to expose
     * a latent out-of-bounds wasm-table call in sqlite3's user-function GC
     * destructor (test_sqlite3 test_function_destructor_via_gc regressed 473→472
     * the moment ba03bb2 added this call — the binding itself is inert, ANY code
     * added to wasthon_init retriggers it). Nothing in the CPython bundle uses
     * property↔&PyProperty_Type; it exists only for pybind11 (matplotlib, a
     * separate module). When that port resumes, re-establish it there without
     * touching wasthon_init, and fix the real uninitialized-fn-pointer read the
     * layout shift exposes. */
}

/*
 * Implementation of Py_TYPE: Brython-side lookup of an object's class.
 * Declared in wasthon.h as _wasthon_Py_TYPE.
 */
extern PyTypeObject *wasthon_get_type_of(PyObject *op);

PyTypeObject *_wasthon_Py_TYPE(PyObject *op) {
    return wasthon_get_type_of(op);
}

/* Strict exact-type test backing Py_IS_TYPE — see wasthon_is_exact_type
 * (wasthon.js). Py_TYPE() returns a subclass instance's PARENT handle, so a
 * raw Py_TYPE(op) == t compare would be loose; this compares Brython classes. */
extern int wasthon_is_exact_type(PyObject *op, PyTypeObject *t);

int _wasthon_Py_IS_TYPE(PyObject *op, PyTypeObject *t) {
    return wasthon_is_exact_type(op, t);
}

/* ---- Type-check predicates: thin wrappers around JS-side helpers ---- */
extern int wasthon_isinstance_of_builtin(PyObject *op, int builtinTag);
extern int wasthon_exacttype_of_builtin(PyObject *op, int builtinTag);

#define WT_TAG_UNICODE  1
#define WT_TAG_BYTES    2
#define WT_TAG_DICT     3
#define WT_TAG_TUPLE    4
#define WT_TAG_LIST     5
#define WT_TAG_LONG     6
#define WT_TAG_FLOAT    7

int PyUnicode_Check(PyObject *o)      { return wasthon_isinstance_of_builtin(o, WT_TAG_UNICODE); }
int PyUnicode_CheckExact(PyObject *o) { return wasthon_exacttype_of_builtin(o, WT_TAG_UNICODE); }
int PyBytes_Check(PyObject *o)        { return wasthon_isinstance_of_builtin(o, WT_TAG_BYTES);   }
int PyBytes_CheckExact(PyObject *o)   { return wasthon_exacttype_of_builtin(o, WT_TAG_BYTES);   }
int PyDict_Check(PyObject *o)         { return wasthon_isinstance_of_builtin(o, WT_TAG_DICT);    }
int PyDict_CheckExact(PyObject *o)    { return wasthon_exacttype_of_builtin(o, WT_TAG_DICT);    }
int PyTuple_Check(PyObject *o)        { return wasthon_isinstance_of_builtin(o, WT_TAG_TUPLE);   }
int PyList_Check(PyObject *o)         { return wasthon_isinstance_of_builtin(o, WT_TAG_LIST);    }
int PyLong_Check(PyObject *o)         { return wasthon_isinstance_of_builtin(o, WT_TAG_LONG);    }
int PyLong_CheckExact(PyObject *o)    { return wasthon_exacttype_of_builtin(o, WT_TAG_LONG);    }
int PyFloat_Check(PyObject *o)        { return wasthon_isinstance_of_builtin(o, WT_TAG_FLOAT);   }

/* ---------------------------------------------------------------- *
 * Buffer protocol                                                  *
 *                                                                  *
 * Strategy: the JS side handles the data marshalling (copy from a  *
 * Brython bytes/bytearray into WASM linear memory) and returns the *
 * raw pointer + length. The C side fills the Py_buffer struct,     *
 * including shape/strides pointers (which point inside the struct  *
 * itself for 1-D buffers, the standard CPython idiom).             *
 * ---------------------------------------------------------------- */

#include <stdlib.h>

extern int wasthon_get_buffer_data(PyObject *obj,
                                   void **out_buf,
                                   Py_ssize_t *out_len,
                                   int *out_readonly);

int PyObject_GetBuffer(PyObject *obj, Py_buffer *view, int flags) {
    if (view == NULL) {
        PyErr_SetString(PyExc_BufferError,
                        "PyObject_GetBuffer: view==NULL argument is obsolete");
        return -1;
    }

    /* numpy ndarray (or any __array_interface__ exporter): expose the real
     * typed, writable buffer aliasing the array's own linear-memory storage,
     * so Cython typed memoryviews (np.ndarray[np.uint32]) validate and mutate
     * in place. Returns 1 when obj is not such an array → generic path below. */
    extern int wasthon_fill_array_buffer(PyObject *obj, Py_buffer *view, int flags);
    int arr = wasthon_fill_array_buffer(obj, view, flags);
    if (arr == 0) return 0;
    if (arr < 0) return -1;

    extern int wasthon_call_bf_getbuffer(PyObject *obj, Py_buffer *view, int flags);

    /* generic path: only PyBUF_WRITABLE is interpreted (below). */
    void *buf = NULL;
    Py_ssize_t len = 0;
    int readonly = 1;  /* JS reports the object's real mutability. */

    if (wasthon_get_buffer_data(obj, &buf, &len, &readonly) != 0) {
        /* Last resort: a C type exporting a real Py_bf_getbuffer slot
         * (Cython's _memoryviewslice — libjoin builds memoryviews over
         * slices). Kept BEHIND the generic path: fronting it regressed
         * binascii/re (array.array's C slot vs the calibrated JS path). */
        int bf = wasthon_call_bf_getbuffer(obj, view, flags);
        if (bf == 0) { PyErr_Clear(); return 0; }
        /* JS side already set the appropriate exception. */
        view->buf = NULL;
        view->obj = NULL;
        return -1;
    }

    /* Honour PyBUF_WRITABLE: CPython's bytes/str exporters refuse a
     * writable request. numpy's PyArray_FromBuffer probes with
     * WRITABLE|SIMPLE to decide the array's writeable flag — always
     * succeeding made np.frombuffer(b"...") writable and the
     * output-not-writeable ValueError in _simple_strided_call never fired. */
    if ((flags & PyBUF_WRITABLE) && readonly) {
        PyErr_SetString(PyExc_BufferError, "Object is not writable.");
        view->buf = NULL;
        view->obj = NULL;
        return -1;
    }
    view->buf       = buf;
    view->obj       = obj;       /* No refcount: handle stays alive in JS. */
    view->len       = len;
    view->itemsize  = 1;
    view->readonly  = readonly;
    view->ndim      = 1;
    view->format    = (char *)"B";
    view->shape     = &view->len;
    view->strides   = &view->itemsize;
    view->suboffsets = NULL;
    view->internal  = NULL;
    return 0;
}

int PyBuffer_FillInfo(Py_buffer *view, PyObject *obj, void *buf,
                      Py_ssize_t len, int readonly, int flags) {
    (void)flags;  /* PyBUF_SIMPLE only, like PyObject_GetBuffer above. */
    if (view == NULL) {
        PyErr_SetString(PyExc_BufferError, "PyBuffer_FillInfo: view is NULL");
        return -1;
    }
    /* Honour PyBUF_WRITABLE: CPython's bytes/str exporters refuse a
     * writable request. numpy's PyArray_FromBuffer probes with
     * WRITABLE|SIMPLE to decide the array's writeable flag — always
     * succeeding made np.frombuffer(b"...") writable and the
     * output-not-writeable ValueError in _simple_strided_call never fired. */
    if ((flags & PyBUF_WRITABLE) && readonly) {
        PyErr_SetString(PyExc_BufferError, "Object is not writable.");
        view->buf = NULL;
        view->obj = NULL;
        return -1;
    }
    view->buf       = buf;
    view->obj       = obj;       /* No refcount: handle stays alive in JS. */
    view->len       = len;
    view->itemsize  = 1;
    view->readonly  = readonly;
    view->ndim      = 1;
    view->format    = (char *)"B";
    view->shape     = &view->len;
    view->strides   = &view->itemsize;
    view->suboffsets = NULL;
    view->internal  = NULL;
    return 0;
}

extern void wasthon_buffer_release(Py_buffer *view);

void PyBuffer_Release(Py_buffer *view) {
    if (view == NULL || view->buf == NULL) {
        return;
    }
    /* JS side handles two cases: read-only buffers (just free), and
     * writable buffers from PyArg_Parse('w*') which copy linear-mem
     * back into the source Brython object before freeing. */
    wasthon_buffer_release(view);
    view->buf = NULL;
    view->obj = NULL;
}

int PyObject_CheckBuffer(PyObject *obj) {
    extern int wasthon_object_check_buffer(PyObject *obj);
    return wasthon_object_check_buffer(obj);
}

/* ---------------------------------------------------------------- *
 * Module state                                                    *
 *                                                                  *
 * In CPython, modules can carry per-module state (a malloc'd struct *
 * whose size is declared in PyModuleDef.m_size). Types created via *
 * PyType_FromModuleAndSpec remember the module they belong to.     *
 *                                                                  *
 * Implementation: a JS-side WeakMap-like registry mapping module   *
 * handles to state pointers, and type handles to their module.     *
 * The state itself lives in WASM linear memory (allocated by C     *
 * code or by the bridge during module creation).                   *
 * ---------------------------------------------------------------- */

extern void *wasthon_module_get_state(PyObject *module);
extern PyObject *wasthon_type_get_module(PyTypeObject *type);

void *_PyModule_GetState(PyObject *module) {
    return wasthon_module_get_state(module);
}

PyObject *PyType_GetModule(PyTypeObject *type) {
    return wasthon_type_get_module(type);
}

void *_PyType_GetModuleState(PyTypeObject *type) {
    PyObject *mod = wasthon_type_get_module(type);
    if (mod == NULL) return NULL;
    return wasthon_module_get_state(mod);
}

/* Public-API aliases (no leading underscore). md5module.c calls these
 * directly; sha2 used the internal forms. Same semantics. */
void *PyModule_GetState(PyObject *module) {
    return wasthon_module_get_state(module);
}

void *PyType_GetModuleState(PyTypeObject *type) {
    PyObject *mod = wasthon_type_get_module(type);
    if (mod == NULL) return NULL;
    return wasthon_module_get_state(mod);
}

/* PyMem allocator — straight aliases to libc malloc/free. CPython's
 * PyMem_Malloc historically went through a custom arena allocator;
 * we don't bother (single linear memory, JS-side GC). */
#include <stdlib.h>
#include <string.h>

void *PyMem_Malloc(size_t size)  { return malloc(size); }
void *PyMem_Calloc(size_t n, size_t s) { return calloc(n, s); }
void *PyMem_Realloc(void *p, size_t s) { return realloc(p, s); }
void  PyMem_Free(void *p)         { free(p); }
void *PyMem_RawMalloc(size_t size) { return malloc(size); }
void *PyMem_RawCalloc(size_t n, size_t s) { return calloc(n, s); }
void *PyMem_RawRealloc(void *p, size_t s) { return realloc(p, s); }
void  PyMem_RawFree(void *p)      { free(p); }

/* _PyOnceFlag — single-threaded WASM. Init runs once it succeeds: a failed
 * run (-1) leaves the flag unset, so the next call tries again, as
 * CPython's unlock_once does. */
int _PyOnceFlag_CallOnce(_PyOnceFlag *flag, int (*func)(void *), void *arg) {
    if (*flag == 0) {
        if (func(arg) < 0) return -1;
        *flag = 1;
    }
    return 0;
}

/* Default tp_alloc — delegates to wasthon_object_gc_new which reads the
 * type's basicsize from the JS-side type registry. Variable-length types
 * (nitems > 0) use wasthon_object_gc_new_var. */
extern PyObject *wasthon_object_gc_new(PyTypeObject *type);
extern PyObject *wasthon_object_gc_new_var(PyTypeObject *type, Py_ssize_t n);

PyObject *wasthon_default_tp_alloc(PyTypeObject *type, Py_ssize_t nitems) {
    if (nitems > 0) return wasthon_object_gc_new_var(type, nitems);
    return wasthon_object_gc_new(type);
}

/* Metatype tp_alloc — PyType_Type.tp_alloc(&PyType_Type, 0). pybind11's
 * get_internals() builds its 3 internal types (static_property_type,
 * default_metaclass, object_base_type) the CPython way: alloc a raw
 * PyHeapTypeObject, fill ht_type.tp_* by hand (at wasthon.h offsets — it
 * compiled against our headers), then PyType_Ready() it. So tp_alloc must
 * hand back zeroed PyHeapTypeObject-sized memory (ht_type at offset 0 →
 * &heap->ht_type == heap, tp_name@12/tp_base@140/... land where
 * PyType_Ready reads them). NOT a Brython-backed instance: pybind11 pokes
 * C fields before the type exists Brython-side. */
#include <stdlib.h>
PyObject *wasthon_type_tp_alloc(PyTypeObject *metatype, Py_ssize_t nitems) {
    (void)metatype; (void)nitems;
    PyHeapTypeObject *ht = (PyHeapTypeObject *)calloc(1, sizeof(PyHeapTypeObject));
    if (!ht) return (PyObject *)0;
    ((PyObject *)ht)->ob_refcnt = 1;
    return (PyObject *)ht;
}

/* Accessor so the JS bridge can read the function pointer (table index)
 * for wasthon_default_tp_alloc and install it into newly-created type
 * structs at offset 12 (tp_alloc). */
#include <emscripten.h>
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_default_tp_alloc(void) {
    return (void *)wasthon_default_tp_alloc;
}

/* Same shape for tp_iter — returns the WASM table index of the JS-side
 * wasthon_builtin_tp_iter library function so the bridge can install it
 * at offset 20 of newly-created type structs. */
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_builtin_tp_iter(void) {
    return (void *)wasthon_builtin_tp_iter;
}

/* Same shape for tp_iternext — ensureTypeStruct installs this at offset 56
 * so C code that reads Py_TYPE(it)->tp_iternext and calls it directly gets a
 * real function pointer, not a NULL slot. math.sumprod caches
 * `p_next = *Py_TYPE(p_it)->tp_iternext; p_i = p_next(p_it);`; with a zeroed
 * slot that was an indirect call to null (every sumprod call trapped). */
extern PyObject *wasthon_builtin_tp_iternext(PyObject *self);
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_builtin_tp_iternext(void) {
    return (void *)wasthon_builtin_tp_iternext;
}

/* tp_repr for the builtin type-structs. wasthon_bind_builtin_type installs
 * this at offset 52 so C code that calls a builtin's tp_repr directly — e.g.
 * _json's encoder does `PyLong_Type.tp_repr(obj)` / `PyFloat_Type.tp_repr(obj)`
 * to stringify ints/floats — gets a real function pointer, not a NULL slot
 * (which trapped as an indirect call to null). */
extern PyObject *wasthon_builtin_tp_repr(PyObject *self);
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_builtin_tp_repr(void) {
    return (void *)wasthon_builtin_tp_repr;
}

/* tp_str for the builtin type-structs, same shape as tp_repr above (offset
 * 104). numpy's unicodetype_str/repr strip trailing NULs then delegate to
 * `PyUnicode_Type.tp_str(new)` — a NULL slot trapped on every str(np.str_). */
extern PyObject *wasthon_builtin_tp_str(PyObject *self);
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_builtin_tp_str(void) {
    return (void *)wasthon_builtin_tp_str;
}

/* tp_hash for the builtin type-structs (offset 96), same shape: a C caller
 * of Py_TYPE(o)->tp_hash on a str called a NULL slot. */
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_builtin_tp_hash(void) {
    return (void *)wasthon_builtin_tp_hash;
}

/* tp_dealloc for the builtin type-structs (offset 40). A C subclass dealloc
 * delegates up — numpy's unicode_arrtype_dealloc ends with
 * `PyUnicode_Type.tp_dealloc(v)` — and the NULL slot trapped (silently: the
 * decref dispatcher's defensive catch ate it), so the gc_new struct behind
 * every reclaimed str_ scalar leaked. The base behaviour in the bridge model
 * is exactly PyObject_GC_Del: unbind the handle, free the struct. */
void wasthon_builtin_tp_dealloc(PyObject *self) {
    PyObject_GC_Del(self);
}
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_builtin_tp_dealloc(void) {
    return (void *)wasthon_builtin_tp_dealloc;
}

/* tp_new for Brython-class type-structs (JS-library). ensureTypeStruct installs
 * this at offset 60 so C code that reconstructs instances from such a struct —
 * e.g. _pickle load_newobj's `cls->tp_new(cls, args, kwargs)` — works. */
extern PyObject *wasthon_brython_tp_new(PyTypeObject *type, PyObject *args, PyObject *kwargs);
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_brython_tp_new(void) {
    return (void *)wasthon_brython_tp_new;
}

/* ---- pycore_time.h stubs (for _datetimemodule.c) ----------------------
 * Numeric/UTC-only helpers, with the CPython pytime.c rounding semantics
 * (fromtimestamp uses HALF_EVEN). _PyTime_ObjectToTime_t and
 * _PyTime_localtime stay JS-library (wasthon.js): localtime must reflect
 * the BROWSER timezone via Date, not musl's TZ-less UTC. PyTime_t is int64
 * nanoseconds, as in wasthon.h. */
#include <math.h>
#include "pycore_time.h"

PyObject *_PyLong_FromTime_t(time_t sec) { return PyLong_FromLongLong((long long)sec); }

time_t _PyLong_AsTime_t(PyObject *obj) {
    long long v = PyLong_AsLongLong(obj);
    if (v == -1 && PyErr_Occurred()) return (time_t)-1;
    return (time_t)v;
}

static double wasthon_time_round(double x, _PyTime_round_t round) {
    switch (round) {
        case _PyTime_ROUND_HALF_EVEN: return rint(x);
        case _PyTime_ROUND_CEILING:
        case _PyTime_ROUND_UP:        return ceil(x);
        default:                      return floor(x);
    }
}

int _PyTime_ObjectToTimeval(PyObject *obj, time_t *sec, long *usec,
                            _PyTime_round_t round) {
    /* Take the float path for anything that is not an exact int:
     * PyFloat_Check can miss a boxed Brython float, and the int path
     * then wrapped 1e200 silently into a bogus time_t (year-1 dates)
     * instead of CPython's OverflowError. */
    if (!PyLong_Check(obj)) {
        double d = PyFloat_AsDouble(obj);
        if (d == -1.0 && PyErr_Occurred()) return -1;
        if (isnan(d)) {
            PyErr_SetString(PyExc_ValueError, "Invalid value NaN (not a number)");
            return -1;
        }
        /* Explicit time_t bounds — a double->int64 cast out of range is
         * not trustworthy (saturating or trapping depending on codegen). */
        if (d < -9223372036854775808.0 || d >= 9223372036854775808.0) {
            PyErr_SetString(PyExc_OverflowError, "timestamp out of range for platform time_t");
            return -1;
        }
        double intpart;
        double floatpart = modf(d, &intpart) * 1e6;
        floatpart = wasthon_time_round(floatpart, round);
        if (floatpart >= 1e6) { floatpart -= 1e6; intpart += 1.0; }
        else if (floatpart < 0) { floatpart += 1e6; intpart -= 1.0; }
        *sec = (time_t)intpart;
        *usec = (long)floatpart;
        if ((double)*sec != intpart) {
            PyErr_SetString(PyExc_OverflowError, "timestamp out of range for platform time_t");
            return -1;
        }
        return 0;
    }
    *sec = _PyLong_AsTime_t(obj);
    *usec = 0;
    if (*sec == (time_t)-1 && PyErr_Occurred()) return -1;
    return 0;
}

int _PyTime_AsTimevalTime_t(PyTime_t t, time_t *secs, int *us,
                            _PyTime_round_t round) {
    /* t is int64 nanoseconds; us must land in [0, 999999]. */
    long long sec = t / 1000000000LL;
    long long nsec = t % 1000000000LL;
    if (nsec < 0) { nsec += 1000000000LL; sec -= 1; }
    long long usec;
    if (round == _PyTime_ROUND_HALF_EVEN) {
        double r = rint((double)nsec / 1000.0);
        usec = (long long)r;
    } else if (round == _PyTime_ROUND_CEILING || round == _PyTime_ROUND_UP) {
        usec = (nsec + 999) / 1000;
    } else {
        usec = nsec / 1000;
    }
    if (usec >= 1000000) { usec -= 1000000; sec += 1; }
    *secs = (time_t)sec;
    *us = (int)usec;
    return 0;
}

int _PyTime_gmtime(time_t t, struct tm *tm) {
    if (gmtime_r(&t, tm) == NULL) {
        PyErr_SetString(PyExc_OSError, "gmtime argument out of range");
        return -1;
    }
    return 0;
}

/* Default tp_free — CPython tp_dealloc bodies end with
 * `Py_TYPE(self)->tp_free(self)`, so every type struct needs a non-NULL
 * tp_free. The bridge installs this (PyObject_GC_Del) unless the module
 * ships its own Py_tp_free slot. */
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_default_tp_free(void) {
    return (void *)PyObject_GC_Del;
}


/* Number-protocol slot dispatchers for built-in PyLong/PyFloat. _decimal
 * caches function pointers from PyLong_Type.tp_as_number->nb_multiply etc.
 * and calls them later — these implementations forward to Brython. */
extern PyObject *wasthon_long_nb_multiply(PyObject *, PyObject *);
extern PyObject *wasthon_long_nb_int(PyObject *);
extern PyObject *wasthon_long_nb_floor_divide(PyObject *, PyObject *);
extern PyObject *wasthon_long_nb_power(PyObject *, PyObject *, PyObject *);
extern PyObject *wasthon_long_nb_lshift(PyObject *, PyObject *);
extern PyObject *wasthon_float_nb_absolute(PyObject *);
extern PyObject *wasthon_float_nb_int(PyObject *);

/* tp_methods entries the built-in types expose. _decimal walks these via
 * cfunc_noargs(t, "name") looking up by name then stashes the function
 * pointer for later direct invocation. */
extern PyObject *wasthon_long_bit_length(PyObject *, PyObject *);
extern PyObject *wasthon_float_as_integer_ratio(PyObject *, PyObject *);

#define METH_NOARGS  0x0004

static PyNumberMethods wasthon_long_nb;
static PyNumberMethods wasthon_float_nb;

/* The rest of int's and float's number slots, generic: each calls the
 * class's own dunder through Brython (int.__add__(a, b), or the reflected
 * one when only the right operand is of the class), so a C subclass that
 * delegates to PyLong_Type.tp_as_number does not re-enter its override.
 * The op numbers index the dunder lists of src/wasthon.js. */
extern PyObject *wasthon_builtin_nb_binary(int is_float, int op, PyObject *a, PyObject *b);
extern PyObject *wasthon_builtin_nb_unary(int is_float, int op, PyObject *a);
extern PyObject *wasthon_builtin_nb_power(int is_float, PyObject *a, PyObject *b, PyObject *c);
extern int wasthon_builtin_nb_bool(int is_float, PyObject *a);
#define NB_BINARY(T, F, NAME, OP) static PyObject *nb_##T##_##NAME(PyObject *a, PyObject *b) \
    { return wasthon_builtin_nb_binary(F, OP, a, b); }
#define NB_UNARY(T, F, NAME, OP) static PyObject *nb_##T##_##NAME(PyObject *a) \
    { return wasthon_builtin_nb_unary(F, OP, a); }
NB_BINARY(long, 0, add, 0)          NB_BINARY(float, 1, add, 0)
NB_BINARY(long, 0, subtract, 1)     NB_BINARY(float, 1, subtract, 1)
NB_BINARY(float, 1, multiply, 2)
NB_BINARY(long, 0, remainder, 3)    NB_BINARY(float, 1, remainder, 3)
NB_BINARY(long, 0, divmod, 4)       NB_BINARY(float, 1, divmod, 4)
NB_BINARY(float, 1, floor_divide, 5)
NB_BINARY(long, 0, true_divide, 6)  NB_BINARY(float, 1, true_divide, 6)
NB_BINARY(long, 0, rshift, 8)
NB_BINARY(long, 0, and, 9)
NB_BINARY(long, 0, xor, 10)
NB_BINARY(long, 0, or, 11)
NB_UNARY(long, 0, negative, 0)      NB_UNARY(float, 1, negative, 0)
NB_UNARY(long, 0, positive, 1)      NB_UNARY(float, 1, positive, 1)
NB_UNARY(long, 0, absolute, 2)
NB_UNARY(long, 0, invert, 3)
NB_UNARY(long, 0, float, 5)         NB_UNARY(float, 1, float, 5)
static PyObject *nb_float_power(PyObject *a, PyObject *b, PyObject *c)
    { return wasthon_builtin_nb_power(1, a, b, c); }
static int nb_long_bool(PyObject *a) { return wasthon_builtin_nb_bool(0, a); }
static int nb_float_bool(PyObject *a) { return wasthon_builtin_nb_bool(1, a); }

static struct PyMethodDef wasthon_long_methods[] = {
    {"bit_length", (void *)wasthon_long_bit_length, METH_NOARGS, 0},
    {0, 0, 0, 0},
};

static struct PyMethodDef wasthon_float_methods[] = {
    {"as_integer_ratio", (void *)wasthon_float_as_integer_ratio, METH_NOARGS, 0},
    {0, 0, 0, 0},
};

void wasthon_init_number_protocols(void) {
    wasthon_long_nb.nb_multiply     = wasthon_long_nb_multiply;
    wasthon_long_nb.nb_floor_divide = wasthon_long_nb_floor_divide;
    wasthon_long_nb.nb_power        = wasthon_long_nb_power;
    wasthon_long_nb.nb_lshift       = wasthon_long_nb_lshift;
    /* numpy's void_arrtype_new calls Py_TYPE(obj)->tp_as_number->nb_int(obj)
     * directly on a Brython int — NULL here was an indirect call to null
     * (np.void(5)). nb_index is the same function, as for CPython's long. */
    wasthon_long_nb.nb_int          = wasthon_long_nb_int;
    wasthon_long_nb.nb_index        = wasthon_long_nb_int;
    wasthon_long_nb.nb_add          = nb_long_add;
    wasthon_long_nb.nb_subtract     = nb_long_subtract;
    wasthon_long_nb.nb_remainder    = nb_long_remainder;
    wasthon_long_nb.nb_divmod       = nb_long_divmod;
    wasthon_long_nb.nb_true_divide  = nb_long_true_divide;
    wasthon_long_nb.nb_rshift       = nb_long_rshift;
    wasthon_long_nb.nb_and          = nb_long_and;
    wasthon_long_nb.nb_xor          = nb_long_xor;
    wasthon_long_nb.nb_or           = nb_long_or;
    wasthon_long_nb.nb_negative     = nb_long_negative;
    wasthon_long_nb.nb_positive     = nb_long_positive;
    wasthon_long_nb.nb_absolute     = nb_long_absolute;
    wasthon_long_nb.nb_invert       = nb_long_invert;
    wasthon_long_nb.nb_float        = nb_long_float;
    wasthon_long_nb.nb_bool         = nb_long_bool;
    PyLong_Type.tp_as_number = &wasthon_long_nb;
    PyLong_Type.tp_methods   = wasthon_long_methods;

    wasthon_float_nb.nb_absolute = wasthon_float_nb_absolute;
    /* nb_int: math.trunc's CheckExact fast path calls
     * PyFloat_Type.tp_as_number->nb_int(x) directly — NULL trapped once
     * PyFloat_CheckExact learned to recognize Brython's Float box. */
    wasthon_float_nb.nb_int = wasthon_float_nb_int;
    wasthon_float_nb.nb_add          = nb_float_add;
    wasthon_float_nb.nb_subtract     = nb_float_subtract;
    wasthon_float_nb.nb_multiply     = nb_float_multiply;
    wasthon_float_nb.nb_remainder    = nb_float_remainder;
    wasthon_float_nb.nb_divmod       = nb_float_divmod;
    wasthon_float_nb.nb_floor_divide = nb_float_floor_divide;
    wasthon_float_nb.nb_true_divide  = nb_float_true_divide;
    wasthon_float_nb.nb_power        = nb_float_power;
    wasthon_float_nb.nb_negative     = nb_float_negative;
    wasthon_float_nb.nb_positive     = nb_float_positive;
    wasthon_float_nb.nb_float        = nb_float_float;
    wasthon_float_nb.nb_bool         = nb_float_bool;
    PyFloat_Type.tp_as_number = &wasthon_float_nb;
    PyFloat_Type.tp_methods   = wasthon_float_methods;
}

/* errno accessors for the JS bridge. PyOS_string_to_double must report
 * overflow as errno=ERANGE with NO exception (CPython contract when
 * overflow_exception==NULL); writing through the JS-side
 * ___errno_location export landed in a DIFFERENT slot than the one
 * numpy's C reads (it read a stale 31/EMLINK) — set it from C instead,
 * whatever location this compilation unit resolves errno to. */
#include <errno.h>
EMSCRIPTEN_KEEPALIVE
void wasthon_set_errno(int v) { errno = v; }
/* WASI numbering differs from Linux (ERANGE is 68, not 34 — 34 is EMLINK,
 * which is why the overflow path kept reading "Too many links"): let the C
 * side supply ITS OWN ERANGE. */
EMSCRIPTEN_KEEPALIVE
void wasthon_set_errno_erange(void) { errno = ERANGE; }
EMSCRIPTEN_KEEPALIVE
int wasthon_get_errno(void) { return errno; }

/* _Py_hashtable — Python/hashtable.c. The JS-Map stub keyed every table by
 * the key read as a C string, whatever its hash and compare functions:
 * integer or pointer keys read memory at their address. */
#include <string.h>
#include "pycore_hashtable.h"
#include "pycore_pyhash.h"

#define HASHTABLE_MIN_SIZE 16
#define HASHTABLE_HIGH 0.50
#define HASHTABLE_LOW 0.10
#define HASHTABLE_REHASH_FACTOR 2.0 / (HASHTABLE_LOW + HASHTABLE_HIGH)

#define BUCKETS_HEAD(SLIST) \
        ((_Py_hashtable_entry_t *)_Py_SLIST_HEAD(&(SLIST)))
#define TABLE_HEAD(HT, BUCKET) \
        ((_Py_hashtable_entry_t *)_Py_SLIST_HEAD(&(HT)->buckets[BUCKET]))
#define ENTRY_NEXT(ENTRY) \
        ((_Py_hashtable_entry_t *)_Py_SLIST_ITEM_NEXT(ENTRY))

/* Forward declaration */
static int hashtable_rehash(_Py_hashtable_t *ht);

static void
_Py_slist_init(_Py_slist_t *list)
{
    list->head = NULL;
}


static void
_Py_slist_prepend(_Py_slist_t *list, _Py_slist_item_t *item)
{
    item->next = list->head;
    list->head = item;
}


static void
_Py_slist_remove(_Py_slist_t *list, _Py_slist_item_t *previous,
                 _Py_slist_item_t *item)
{
    if (previous != NULL)
        previous->next = item->next;
    else
        list->head = item->next;
}


Py_uhash_t
_Py_hashtable_hash_ptr(const void *key)
{
    return (Py_uhash_t)_Py_HashPointerRaw(key);
}


int
_Py_hashtable_compare_direct(const void *key1, const void *key2)
{
    return (key1 == key2);
}


/* makes sure the real size of the buckets array is a power of 2 */
static size_t
round_size(size_t s)
{
    size_t i;
    if (s < HASHTABLE_MIN_SIZE)
        return HASHTABLE_MIN_SIZE;
    i = 1;
    while (i < s)
        i <<= 1;
    return i;
}


size_t
_Py_hashtable_size(const _Py_hashtable_t *ht)
{
    size_t size = sizeof(_Py_hashtable_t);
    /* buckets */
    size += ht->nbuckets * sizeof(_Py_hashtable_entry_t *);
    /* entries */
    size += ht->nentries * sizeof(_Py_hashtable_entry_t);
    return size;
}


size_t
_Py_hashtable_len(const _Py_hashtable_t *ht)
{
    return ht->nentries;
}


_Py_hashtable_entry_t *
_Py_hashtable_get_entry_generic(_Py_hashtable_t *ht, const void *key)
{
    Py_uhash_t key_hash = ht->hash_func(key);
    size_t index = key_hash & (ht->nbuckets - 1);
    _Py_hashtable_entry_t *entry = TABLE_HEAD(ht, index);
    while (1) {
        if (entry == NULL) {
            return NULL;
        }
        if (entry->key_hash == key_hash && ht->compare_func(key, entry->key)) {
            break;
        }
        entry = ENTRY_NEXT(entry);
    }
    return entry;
}


// Specialized for:
// hash_func == _Py_hashtable_hash_ptr
// compare_func == _Py_hashtable_compare_direct
static _Py_hashtable_entry_t *
_Py_hashtable_get_entry_ptr(_Py_hashtable_t *ht, const void *key)
{
    Py_uhash_t key_hash = _Py_hashtable_hash_ptr(key);
    size_t index = key_hash & (ht->nbuckets - 1);
    _Py_hashtable_entry_t *entry = TABLE_HEAD(ht, index);
    while (1) {
        if (entry == NULL) {
            return NULL;
        }
        // Compare directly keys (ignore entry->key_hash)
        if (entry->key == key) {
            break;
        }
        entry = ENTRY_NEXT(entry);
    }
    return entry;
}


void*
_Py_hashtable_steal(_Py_hashtable_t *ht, const void *key)
{
    Py_uhash_t key_hash = ht->hash_func(key);
    size_t index = key_hash & (ht->nbuckets - 1);

    _Py_hashtable_entry_t *entry = TABLE_HEAD(ht, index);
    _Py_hashtable_entry_t *previous = NULL;
    while (1) {
        if (entry == NULL) {
            // not found
            return NULL;
        }
        if (entry->key_hash == key_hash && ht->compare_func(key, entry->key)) {
            break;
        }
        previous = entry;
        entry = ENTRY_NEXT(entry);
    }

    _Py_slist_remove(&ht->buckets[index], (_Py_slist_item_t *)previous,
                     (_Py_slist_item_t *)entry);
    ht->nentries--;

    void *value = entry->value;
    ht->alloc.free(entry);

    if ((float)ht->nentries / (float)ht->nbuckets < HASHTABLE_LOW) {
        // Ignore failure: error cannot be reported to the caller
        hashtable_rehash(ht);
    }
    return value;
}


int
_Py_hashtable_set(_Py_hashtable_t *ht, const void *key, void *value)
{
    _Py_hashtable_entry_t *entry;

#ifndef NDEBUG
    /* Don't write the assertion on a single line because it is interesting
       to know the duplicated entry if the assertion failed. The entry can
       be read using a debugger. */
    entry = ht->get_entry_func(ht, key);
    assert(entry == NULL);
#endif

    entry = ht->alloc.malloc(sizeof(_Py_hashtable_entry_t));
    if (entry == NULL) {
        /* memory allocation failed */
        return -1;
    }

    entry->key_hash = ht->hash_func(key);
    entry->key = (void *)key;
    entry->value = value;

    ht->nentries++;
    if ((float)ht->nentries / (float)ht->nbuckets > HASHTABLE_HIGH) {
        if (hashtable_rehash(ht) < 0) {
            ht->nentries--;
            ht->alloc.free(entry);
            return -1;
        }
    }

    size_t index = entry->key_hash & (ht->nbuckets - 1);
    _Py_slist_prepend(&ht->buckets[index], (_Py_slist_item_t*)entry);
    return 0;
}


void*
_Py_hashtable_get(_Py_hashtable_t *ht, const void *key)
{
    _Py_hashtable_entry_t *entry = ht->get_entry_func(ht, key);
    if (entry != NULL) {
        return entry->value;
    }
    else {
        return NULL;
    }
}


int
_Py_hashtable_foreach(_Py_hashtable_t *ht,
                      _Py_hashtable_foreach_func func,
                      void *user_data)
{
    for (size_t hv = 0; hv < ht->nbuckets; hv++) {
        _Py_hashtable_entry_t *entry = TABLE_HEAD(ht, hv);
        while (entry != NULL) {
            int res = func(ht, entry->key, entry->value, user_data);
            if (res) {
                return res;
            }
            entry = ENTRY_NEXT(entry);
        }
    }
    return 0;
}


static int
hashtable_rehash(_Py_hashtable_t *ht)
{
    size_t new_size = round_size((size_t)(ht->nentries * HASHTABLE_REHASH_FACTOR));
    if (new_size == ht->nbuckets) {
        return 0;
    }

    size_t buckets_size = new_size * sizeof(ht->buckets[0]);
    _Py_slist_t *new_buckets = ht->alloc.malloc(buckets_size);
    if (new_buckets == NULL) {
        /* memory allocation failed */
        return -1;
    }
    memset(new_buckets, 0, buckets_size);

    for (size_t bucket = 0; bucket < ht->nbuckets; bucket++) {
        _Py_hashtable_entry_t *entry = BUCKETS_HEAD(ht->buckets[bucket]);
        while (entry != NULL) {
            assert(ht->hash_func(entry->key) == entry->key_hash);
            _Py_hashtable_entry_t *next = ENTRY_NEXT(entry);
            size_t entry_index = entry->key_hash & (new_size - 1);

            _Py_slist_prepend(&new_buckets[entry_index], (_Py_slist_item_t*)entry);

            entry = next;
        }
    }

    ht->alloc.free(ht->buckets);
    ht->nbuckets = new_size;
    ht->buckets = new_buckets;
    return 0;
}


_Py_hashtable_t *
_Py_hashtable_new_full(_Py_hashtable_hash_func hash_func,
                       _Py_hashtable_compare_func compare_func,
                       _Py_hashtable_destroy_func key_destroy_func,
                       _Py_hashtable_destroy_func value_destroy_func,
                       _Py_hashtable_allocator_t *allocator)
{
    _Py_hashtable_allocator_t alloc;
    if (allocator == NULL) {
        alloc.malloc = PyMem_Malloc;
        alloc.free = PyMem_Free;
    }
    else {
        alloc = *allocator;
    }

    _Py_hashtable_t *ht = (_Py_hashtable_t *)alloc.malloc(sizeof(_Py_hashtable_t));
    if (ht == NULL) {
        return ht;
    }

    ht->nbuckets = HASHTABLE_MIN_SIZE;
    ht->nentries = 0;

    size_t buckets_size = ht->nbuckets * sizeof(ht->buckets[0]);
    ht->buckets = alloc.malloc(buckets_size);
    if (ht->buckets == NULL) {
        alloc.free(ht);
        return NULL;
    }
    memset(ht->buckets, 0, buckets_size);

    ht->get_entry_func = _Py_hashtable_get_entry_generic;
    ht->hash_func = hash_func;
    ht->compare_func = compare_func;
    ht->key_destroy_func = key_destroy_func;
    ht->value_destroy_func = value_destroy_func;
    ht->alloc = alloc;
    if (ht->hash_func == _Py_hashtable_hash_ptr
        && ht->compare_func == _Py_hashtable_compare_direct)
    {
        ht->get_entry_func = _Py_hashtable_get_entry_ptr;
    }
    return ht;
}


_Py_hashtable_t *
_Py_hashtable_new(_Py_hashtable_hash_func hash_func,
                  _Py_hashtable_compare_func compare_func)
{
    return _Py_hashtable_new_full(hash_func, compare_func,
                                  NULL, NULL, NULL);
}


static void
_Py_hashtable_destroy_entry(_Py_hashtable_t *ht, _Py_hashtable_entry_t *entry)
{
    if (ht->key_destroy_func) {
        ht->key_destroy_func(entry->key);
    }
    if (ht->value_destroy_func) {
        ht->value_destroy_func(entry->value);
    }
    ht->alloc.free(entry);
}


void
_Py_hashtable_clear(_Py_hashtable_t *ht)
{
    for (size_t i=0; i < ht->nbuckets; i++) {
        _Py_hashtable_entry_t *entry = TABLE_HEAD(ht, i);
        while (entry != NULL) {
            _Py_hashtable_entry_t *next = ENTRY_NEXT(entry);
            _Py_hashtable_destroy_entry(ht, entry);
            entry = next;
        }
        _Py_slist_init(&ht->buckets[i]);
    }
    ht->nentries = 0;
    // Ignore failure: clear function is not expected to fail
    // because of a memory allocation failure.
    (void)hashtable_rehash(ht);
}


void
_Py_hashtable_destroy(_Py_hashtable_t *ht)
{
    for (size_t i = 0; i < ht->nbuckets; i++) {
        _Py_hashtable_entry_t *entry = TABLE_HEAD(ht, i);
        while (entry) {
            _Py_hashtable_entry_t *entry_next = ENTRY_NEXT(entry);
            _Py_hashtable_destroy_entry(ht, entry);
            entry = entry_next;
        }
    }

    ht->alloc.free(ht->buckets);
    ht->alloc.free(ht);
}

/* PyOS_snprintf / PyOS_vsnprintf — Python/mysnprintf.c: libc's vsnprintf,
 * returning the length the output would have. The JS version was a
 * printf subset returning the count written (7 for "%d-%s" into 8 bytes
 * where CPython says 9), %g through toPrecision, 64-bit %lld read as 32. */
#include <limits.h>
int
PyOS_vsnprintf(char *str, size_t size, const char  *format, va_list va)
{
    int len;  /* # bytes written, excluding \0 */
    /* We take a size_t as input but return an int.  Sanity check
     * our input so that it won't cause an overflow in the
     * vsnprintf return value.  */
    if (size > INT_MAX - 1) {
        len = -666;
        goto Done;
    }

    len = vsnprintf(str, size, format, va);

Done:
    if (size > 0) {
        str[size-1] = '\0';
    }
    return len;
}

int
PyOS_snprintf(char *str, size_t size, const  char  *format, ...)
{
    int rc;
    va_list va;

    va_start(va, format);
    rc = PyOS_vsnprintf(str, size, format, va);
    va_end(va);
    return rc;
}

/* PyOS_strtoul / PyOS_strtol — Python/mystrtoul.c, long being 4 bytes on
 * wasm32. The JS versions went through parseInt: no 0x/0o/0b prefix
 * under base 0, an end pointer past any alphanumeric run, and no
 * overflow (a wrapped value, errno never ERANGE). */
#include <limits.h>
static const unsigned long smallmax[] = {
    0, /* bases 0 and 1 are invalid */
    0,
    ULONG_MAX / 2,
    ULONG_MAX / 3,
    ULONG_MAX / 4,
    ULONG_MAX / 5,
    ULONG_MAX / 6,
    ULONG_MAX / 7,
    ULONG_MAX / 8,
    ULONG_MAX / 9,
    ULONG_MAX / 10,
    ULONG_MAX / 11,
    ULONG_MAX / 12,
    ULONG_MAX / 13,
    ULONG_MAX / 14,
    ULONG_MAX / 15,
    ULONG_MAX / 16,
    ULONG_MAX / 17,
    ULONG_MAX / 18,
    ULONG_MAX / 19,
    ULONG_MAX / 20,
    ULONG_MAX / 21,
    ULONG_MAX / 22,
    ULONG_MAX / 23,
    ULONG_MAX / 24,
    ULONG_MAX / 25,
    ULONG_MAX / 26,
    ULONG_MAX / 27,
    ULONG_MAX / 28,
    ULONG_MAX / 29,
    ULONG_MAX / 30,
    ULONG_MAX / 31,
    ULONG_MAX / 32,
    ULONG_MAX / 33,
    ULONG_MAX / 34,
    ULONG_MAX / 35,
    ULONG_MAX / 36,
};

/* maximum digits that can't ever overflow for bases 2 through 36,
 * calculated by [int(math.floor(math.log(2**32, i))) for i in range(2, 37)].
 */
static const int digitlimit[] = {
    0,  0, 32, 20, 16, 13, 12, 11, 10, 10,  /*  0 -  9 */
    9,  9,  8,  8,  8,  8,  8,  7,  7,  7,  /* 10 - 19 */
    7,  7,  7,  7,  6,  6,  6,  6,  6,  6,  /* 20 - 29 */
    6,  6,  6,  6,  6,  6,  6};             /* 30 - 36 */

unsigned long
PyOS_strtoul(const char *str, char **ptr, int base)
{
    unsigned long result = 0; /* return value of the function */
    int c;             /* current input character */
    int ovlimit;       /* required digits to overflow */

    /* skip leading white space */
    while (*str && Py_ISSPACE(*str))
        ++str;

    /* check for leading 0b, 0o or 0x for auto-base or base 16 */
    switch (base) {
    case 0:             /* look for leading 0b, 0o or 0x */
        if (*str == '0') {
            ++str;
            if (*str == 'x' || *str == 'X') {
                /* there must be at least one digit after 0x */
                if (_PyLong_DigitValue[Py_CHARMASK(str[1])] >= 16) {
                    if (ptr)
                        *ptr = (char *)str;
                    return 0;
                }
                ++str;
                base = 16;
            } else if (*str == 'o' || *str == 'O') {
                /* there must be at least one digit after 0o */
                if (_PyLong_DigitValue[Py_CHARMASK(str[1])] >= 8) {
                    if (ptr)
                        *ptr = (char *)str;
                    return 0;
                }
                ++str;
                base = 8;
            } else if (*str == 'b' || *str == 'B') {
                /* there must be at least one digit after 0b */
                if (_PyLong_DigitValue[Py_CHARMASK(str[1])] >= 2) {
                    if (ptr)
                        *ptr = (char *)str;
                    return 0;
                }
                ++str;
                base = 2;
            } else {
                /* skip all zeroes... */
                while (*str == '0')
                    ++str;
                while (Py_ISSPACE(*str))
                    ++str;
                if (ptr)
                    *ptr = (char *)str;
                return 0;
            }
        }
        else
            base = 10;
        break;

    /* even with explicit base, skip leading 0? prefix */
    case 16:
        if (*str == '0') {
            ++str;
            if (*str == 'x' || *str == 'X') {
                /* there must be at least one digit after 0x */
                if (_PyLong_DigitValue[Py_CHARMASK(str[1])] >= 16) {
                    if (ptr)
                        *ptr = (char *)str;
                    return 0;
                }
                ++str;
            }
        }
        break;
    case 8:
        if (*str == '0') {
            ++str;
            if (*str == 'o' || *str == 'O') {
                /* there must be at least one digit after 0o */
                if (_PyLong_DigitValue[Py_CHARMASK(str[1])] >= 8) {
                    if (ptr)
                        *ptr = (char *)str;
                    return 0;
                }
                ++str;
            }
        }
        break;
    case 2:
        if(*str == '0') {
            ++str;
            if (*str == 'b' || *str == 'B') {
                /* there must be at least one digit after 0b */
                if (_PyLong_DigitValue[Py_CHARMASK(str[1])] >= 2) {
                    if (ptr)
                        *ptr = (char *)str;
                    return 0;
                }
                ++str;
            }
        }
        break;
    }

    /* catch silly bases */
    if (base < 2 || base > 36) {
        if (ptr)
            *ptr = (char *)str;
        return 0;
    }

    /* skip leading zeroes */
    while (*str == '0')
        ++str;

    /* base is guaranteed to be in [2, 36] at this point */
    ovlimit = digitlimit[base];

    /* do the conversion until non-digit character encountered */
    while ((c = _PyLong_DigitValue[Py_CHARMASK(*str)]) < base) {
        if (ovlimit > 0) /* no overflow check required */
            result = result * base + c;
        else { /* requires overflow check */
            unsigned long temp_result;

            if (ovlimit < 0) /* guaranteed overflow */
                goto overflowed;

            /* there could be an overflow */
            /* check overflow just from shifting */
            if (result > smallmax[base])
                goto overflowed;

            result *= base;

            /* check overflow from the digit's value */
            temp_result = result + c;
            if (temp_result < result)
                goto overflowed;

            result = temp_result;
        }

        ++str;
        --ovlimit;
    }

    /* set pointer to point to the last character scanned */
    if (ptr)
        *ptr = (char *)str;

    return result;

overflowed:
    if (ptr) {
        /* spool through remaining digit characters */
        while (_PyLong_DigitValue[Py_CHARMASK(*str)] < base)
            ++str;
        *ptr = (char *)str;
    }
    errno = ERANGE;
    return (unsigned long)-1;
}

/* Checking for overflow in PyOS_strtol is a PITA; see comments
 * about PY_ABS_LONG_MIN in longobject.c.
 */
#define PY_ABS_LONG_MIN         (0-(unsigned long)LONG_MIN)

long
PyOS_strtol(const char *str, char **ptr, int base)
{
    long result;
    unsigned long uresult;
    char sign;

    while (*str && Py_ISSPACE(*str))
        str++;

    sign = *str;
    if (sign == '+' || sign == '-')
        str++;

    uresult = PyOS_strtoul(str, ptr, base);

    if (uresult <= (unsigned long)LONG_MAX) {
        result = (long)uresult;
        if (sign == '-')
            result = -result;
    }
    else if (sign == '-' && uresult == PY_ABS_LONG_MIN) {
        result = LONG_MIN;
    }
    else {
        errno = ERANGE;
        result = LONG_MAX;
    }
    return result;
}

/* PyType_GetSlot of a static type (PyType_Ready over a C struct) —
 * Objects/typeobject.c over Objects/typeslots.inc, with wasthon.h's
 * layout: {sub-struct field offset or -1, PyTypeObject field offset}.
 * tp_del, tp_vectorcall and the heap type's ht_token have no field here
 * ({-1, -1}: NULL). The JS side keeps the spec types' slot map. */
#include <stddef.h>
static const struct { int subslot_offset, slot_offset; } wasthon_slot_offsets[] = {
    {0, 0},
    {offsetof(PyBufferProcs, bf_getbuffer), offsetof(PyTypeObject, tp_as_buffer)},
    {offsetof(PyBufferProcs, bf_releasebuffer), offsetof(PyTypeObject, tp_as_buffer)},
    {offsetof(PyMappingMethods, mp_ass_subscript), offsetof(PyTypeObject, tp_as_mapping)},
    {offsetof(PyMappingMethods, mp_length), offsetof(PyTypeObject, tp_as_mapping)},
    {offsetof(PyMappingMethods, mp_subscript), offsetof(PyTypeObject, tp_as_mapping)},
    {offsetof(PyNumberMethods, nb_absolute), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_add), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_and), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_bool), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_divmod), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_float), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_floor_divide), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_index), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_add), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_and), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_floor_divide), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_lshift), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_multiply), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_or), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_power), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_remainder), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_rshift), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_subtract), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_true_divide), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_xor), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_int), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_invert), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_lshift), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_multiply), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_negative), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_or), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_positive), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_power), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_remainder), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_rshift), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_subtract), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_true_divide), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_xor), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PySequenceMethods, sq_ass_item), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_concat), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_contains), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_inplace_concat), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_inplace_repeat), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_item), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_length), offsetof(PyTypeObject, tp_as_sequence)},
    {offsetof(PySequenceMethods, sq_repeat), offsetof(PyTypeObject, tp_as_sequence)},
    {-1, offsetof(PyTypeObject, tp_alloc)},
    {-1, offsetof(PyTypeObject, tp_base)},
    {-1, offsetof(PyTypeObject, tp_bases)},
    {-1, offsetof(PyTypeObject, tp_call)},
    {-1, offsetof(PyTypeObject, tp_clear)},
    {-1, offsetof(PyTypeObject, tp_dealloc)},
    {-1, -1 /* tp_del */},
    {-1, offsetof(PyTypeObject, tp_descr_get)},
    {-1, offsetof(PyTypeObject, tp_descr_set)},
    {-1, offsetof(PyTypeObject, tp_doc)},
    {-1, offsetof(PyTypeObject, tp_getattr)},
    {-1, offsetof(PyTypeObject, tp_getattro)},
    {-1, offsetof(PyTypeObject, tp_hash)},
    {-1, offsetof(PyTypeObject, tp_init)},
    {-1, offsetof(PyTypeObject, tp_is_gc)},
    {-1, offsetof(PyTypeObject, tp_iter)},
    {-1, offsetof(PyTypeObject, tp_iternext)},
    {-1, offsetof(PyTypeObject, tp_methods)},
    {-1, offsetof(PyTypeObject, tp_new)},
    {-1, offsetof(PyTypeObject, tp_repr)},
    {-1, offsetof(PyTypeObject, tp_richcompare)},
    {-1, offsetof(PyTypeObject, tp_setattr)},
    {-1, offsetof(PyTypeObject, tp_setattro)},
    {-1, offsetof(PyTypeObject, tp_str)},
    {-1, offsetof(PyTypeObject, tp_traverse)},
    {-1, offsetof(PyTypeObject, tp_members)},
    {-1, offsetof(PyTypeObject, tp_getset)},
    {-1, offsetof(PyTypeObject, tp_free)},
    {offsetof(PyNumberMethods, nb_matrix_multiply), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyNumberMethods, nb_inplace_matrix_multiply), offsetof(PyTypeObject, tp_as_number)},
    {offsetof(PyAsyncMethods, am_await), offsetof(PyTypeObject, tp_as_async)},
    {offsetof(PyAsyncMethods, am_aiter), offsetof(PyTypeObject, tp_as_async)},
    {offsetof(PyAsyncMethods, am_anext), offsetof(PyTypeObject, tp_as_async)},
    {-1, offsetof(PyTypeObject, tp_finalize)},
    {offsetof(PyAsyncMethods, am_send), offsetof(PyTypeObject, tp_as_async)},
    {-1, -1 /* tp_vectorcall */},
    {-1, -1 /* ht_token */},
};
EMSCRIPTEN_KEEPALIVE
void *wasthon_static_type_slot(PyTypeObject *type, int slot) {
    int slots_len = (int)(sizeof wasthon_slot_offsets / sizeof wasthon_slot_offsets[0]);
    if (slot <= 0 || slot >= slots_len) {
        PyErr_BadInternalCall();
        return NULL;
    }
    int slot_offset = wasthon_slot_offsets[slot].slot_offset;
    if (slot_offset < 0) return NULL;
    void *parent_slot = *(void **)((char *)type + slot_offset);
    if (parent_slot == NULL) return NULL;
    if (wasthon_slot_offsets[slot].subslot_offset == -1) return parent_slot;
    return *(void **)((char *)parent_slot + wasthon_slot_offsets[slot].subslot_offset);
}

/* PyObject_Print — Objects/object.c, without its signal and recursion
 * checks: the repr (str under Py_PRINT_RAW) written to fp. The JS version
 * logged the repr to the console and never wrote the file. */
int PyObject_Print(PyObject *op, FILE *fp, int flags) {
    int ret = 0;
    int write_error = 0;
    clearerr(fp);
    if (op == NULL) {
        fprintf(fp, "<nil>");
    }
    else {
        if (Py_REFCNT(op) <= 0) {
            fprintf(fp, "<refcnt %zd at %p>", Py_REFCNT(op), (void *)op);
        }
        else {
            PyObject *s;
            if (flags & Py_PRINT_RAW)
                s = PyObject_Str(op);
            else
                s = PyObject_Repr(op);
            if (s == NULL) {
                ret = -1;
            }
            else {
                const char *t;
                Py_ssize_t len;
                t = PyUnicode_AsUTF8AndSize(s, &len);
                if (t == NULL) {
                    ret = -1;
                }
                else {
                    if (fwrite(t, 1, len, fp) != (size_t)len) {
                        write_error = 1;
                    }
                }
                Py_DECREF(s);
            }
        }
    }
    if (ret == 0) {
        if (write_error || ferror(fp)) {
            PyErr_SetFromErrno(PyExc_OSError);
            clearerr(fp);
            ret = -1;
        }
    }
    return ret;
}

/* PyThread stubs — single-threaded WASM. Locks always "succeed". We
 * return a non-zero sentinel so callers don't think allocation failed. */
PyThread_type_lock PyThread_allocate_lock(void) {
    static struct { int _x; } sentinel;
    return (PyThread_type_lock)&sentinel;
}
void PyThread_free_lock(PyThread_type_lock lock)             { (void)lock; }
int  PyThread_acquire_lock(PyThread_type_lock l, int wait)   { (void)l; (void)wait; return 1; }
void PyThread_release_lock(PyThread_type_lock lock)          { (void)lock; }

/* ---------------------------------------------------------------- *
 * Argument parsing                                                 *
 *                                                                  *
 * `_PyArg_UnpackKeywords` is what clinic-generated glue calls to   *
 * dispatch positional+keyword args for METH_FASTCALL|METH_KEYWORDS.*
 * We delegate to the JS bridge which reads the parser struct fields, *
 * the NULL-terminated `_keywords` C-string array, and the kwnames  *
 * tuple, then fills `buf` slot-by-slot. Returns `buf` on success,  *
 * NULL on error (with the appropriate exception set).              *
 *                                                                  *
 * Note: `kwargs` (the dict-style param for older calling conv) is  *
 * always NULL for FASTCALL|KEYWORDS — we accept it but ignore it.  *
 * ---------------------------------------------------------------- */

extern PyObject **wasthon_unpack_keywords(
    PyObject *const *args, Py_ssize_t nargs,
    PyObject *kwargs, PyObject *kwnames,
    _PyArg_Parser *parser,
    int minpos, int maxpos, int minkw, int varpos,
    PyObject **buf);

PyObject **_PyArg_UnpackKeywords(
    PyObject *const *args, Py_ssize_t nargs,
    PyObject *kwargs, PyObject *kwnames,
    _PyArg_Parser *parser,
    int minpos, int maxpos, int minkw, int varpos,
    PyObject **buf)
{
    return wasthon_unpack_keywords(args, nargs, kwargs, kwnames, parser,
                                    minpos, maxpos, minkw, varpos, buf);
}

/* _PyArg_CheckPositional — Python/getargs.c. The JS version wrote its own
 * message ("f() takes 1 to 3 positional arguments but 5 were given"). */
int
_PyArg_CheckPositional(const char *name, Py_ssize_t nargs,
                       Py_ssize_t min, Py_ssize_t max)
{
    if (nargs < min) {
        if (name != NULL)
            PyErr_Format(
                PyExc_TypeError,
                "%.200s expected %s%zd argument%s, got %zd",
                name, (min == max ? "" : "at least "), min, min == 1 ? "" : "s", nargs);
        else
            PyErr_Format(
                PyExc_TypeError,
                "unpacked tuple should have %s%zd element%s,"
                " but has %zd",
                (min == max ? "" : "at least "), min, min == 1 ? "" : "s", nargs);
        return 0;
    }

    if (nargs == 0) {
        return 1;
    }

    if (nargs > max) {
        if (name != NULL)
            PyErr_Format(
                PyExc_TypeError,
                "%.200s expected %s%zd argument%s, got %zd",
                name, (min == max ? "" : "at most "), max, max == 1 ? "" : "s", nargs);
        else
            PyErr_Format(
                PyExc_TypeError,
                "unpacked tuple should have %s%zd element%s,"
                " but has %zd",
                (min == max ? "" : "at most "), max, max == 1 ? "" : "s", nargs);
        return 0;
    }

    return 1;
}

/* ---- pyexpat shims ---- */
/* _Py_HashSecret — hash randomization seed. Fixed value is fine: we don't
 * need cryptographic randomization in a single-page browser context. The
 * 16-byte salt (XML_SetHashSalt16Bytes, expat >= 2.8) is a fixed non-zero
 * pattern so expat never takes an "invalid salt" path. */
#include "pycore_pyhash.h"
_Py_HashSecret_t _Py_HashSecret = { .expat = {
    .hashsalt16 = { 0x77, 0x61, 0x73, 0x74, 0x68, 0x6f, 0x6e, 0x2d,
                    0x65, 0x78, 0x70, 0x61, 0x74, 0x2d, 0x31, 0x36 },
    .hashsalt = 0x77617374UL } };

/* _PyImport_SetModule — register a module under sys.modules[name].
 * pyexpat uses this for its `errors` and `model` submodules. No-op
 * keeps the parser working; submodule access via `from xml.parsers.expat
 * import errors` would need additional plumbing. */
int _PyImport_SetModule(PyObject *name, PyObject *module) {
    (void)name; (void)module;
    return 0;
}

/* _PyTraceback_Add — append a synthetic frame to the traceback.
 * No-op: we don't maintain a Python-side traceback. */
int _PyTraceback_Add(const char *funcname, const char *filename, int lineno) {
    (void)funcname; (void)filename; (void)lineno;
    return 0;
}

/* Py_hexdigits — used by _json for hex-encoding ASCII escape sequences. */
const char Py_hexdigits[] = "0123456789abcdef";

/* PyODict_Type — C-level base type of CPython's OrderedDict. Brython has no
 * separate OrderedDict at type-object level (Python 3.7+ dicts preserve
 * insertion order anyway). Alias to PyDict_Type so the C-level inheritance
 * resolves; the user-facing OrderedDict will behave like a plain dict for
 * iteration order (the same in practice) and miss move_to_end semantics. */
PyTypeObject PyODict_Type;  /* populated at wasthon_init time */
