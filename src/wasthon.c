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
PyObject *PyExc_Exception             = (PyObject *)0;
PyObject *PyExc_OSError               = (PyObject *)0;
PyObject *PyExc_AttributeError        = (PyObject *)0;
PyObject *PyExc_ArithmeticError       = (PyObject *)0;
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
extern PyObject *wasthon_get_PyExc_LookupError(void);
extern PyObject *wasthon_get_PyExc_NotImplementedError(void);
extern PyObject *wasthon_get_PyExc_UnicodeError(void);
extern PyObject *wasthon_get_PyExc_UnicodeDecodeError(void);
extern PyObject *wasthon_get_PyExc_UnicodeEncodeError(void);
extern PyObject *wasthon_get_PyExc_ImportError(void);
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
/* Shared mapping table for the built-in singletons — C extensions delegate
 * to it (pygame ScancodeWrapper: PyTuple_Type.tp_as_mapping->mp_subscript). */
static PyMappingMethods wasthon_builtin_as_mapping = {
    wasthon_builtin_mp_length,
    wasthon_builtin_mp_subscript,
    0,
};

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
    PyExc_LookupError           = wasthon_get_PyExc_LookupError();
    PyExc_NotImplementedError   = wasthon_get_PyExc_NotImplementedError();
    PyExc_UnicodeError          = wasthon_get_PyExc_UnicodeError();
    PyExc_UnicodeDecodeError    = wasthon_get_PyExc_UnicodeDecodeError();
    PyExc_UnicodeEncodeError    = wasthon_get_PyExc_UnicodeEncodeError();
    PyExc_ImportError           = wasthon_get_PyExc_ImportError();
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

    /* Bind each built-in type singleton's address to its Brython class,
     * and wire tp_iter so member access works (e.g. _decimal calls
     * PyTuple_Type.tp_iter(t) directly). All built-ins share the same
     * generic tp_iter that dispatches to Brython's iter(). */
    PyType_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyTuple_Type.tp_iter   = wasthon_builtin_tp_iter;
    PyDict_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyList_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyLong_Type.tp_iter    = wasthon_builtin_tp_iter;
    PyFloat_Type.tp_iter   = wasthon_builtin_tp_iter;
    PyUnicode_Type.tp_iter = wasthon_builtin_tp_iter;
    PyBytes_Type.tp_iter   = wasthon_builtin_tp_iter;
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

    wasthon_bind_builtin_type(BT_TYPE,    &PyType_Type);
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

    /* Populate tp_as_number for PyLong_Type / PyFloat_Type so _decimal
     * (and other modules that cache nb_* pointers) can read them. */
    extern void wasthon_init_number_protocols(void);
    wasthon_init_number_protocols();
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
int PyUnicode_CheckExact(PyObject *o) { return wasthon_isinstance_of_builtin(o, WT_TAG_UNICODE); }
int PyBytes_Check(PyObject *o)        { return wasthon_isinstance_of_builtin(o, WT_TAG_BYTES);   }
int PyBytes_CheckExact(PyObject *o)   { return wasthon_isinstance_of_builtin(o, WT_TAG_BYTES);   }
int PyDict_Check(PyObject *o)         { return wasthon_isinstance_of_builtin(o, WT_TAG_DICT);    }
int PyDict_CheckExact(PyObject *o)    { return wasthon_isinstance_of_builtin(o, WT_TAG_DICT);    }
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
    (void)flags;  /* PyBUF_SIMPLE only; no flag interpretation yet. */
    if (view == NULL) {
        PyErr_SetString(PyExc_BufferError,
                        "PyObject_GetBuffer: view==NULL argument is obsolete");
        return -1;
    }
    void *buf = NULL;
    Py_ssize_t len = 0;
    int readonly = 1;  /* JS reports the object's real mutability. */

    if (wasthon_get_buffer_data(obj, &buf, &len, &readonly) != 0) {
        /* JS side already set the appropriate exception. */
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

/* _PyOnceFlag — single-threaded WASM. Init runs exactly once. */
int _PyOnceFlag_CallOnce(_PyOnceFlag *flag, int (*func)(void *), void *arg) {
    if (*flag == 0) {
        int r = func(arg);
        *flag = 1;
        return r;
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

/* tp_new for Brython-class type-structs (JS-library). ensureTypeStruct installs
 * this at offset 60 so C code that reconstructs instances from such a struct —
 * e.g. _pickle load_newobj's `cls->tp_new(cls, args, kwargs)` — works. */
extern PyObject *wasthon_brython_tp_new(PyTypeObject *type, PyObject *args, PyObject *kwargs);
EMSCRIPTEN_KEEPALIVE
void *wasthon_get_brython_tp_new(void) {
    return (void *)wasthon_brython_tp_new;
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
extern PyObject *wasthon_long_nb_floor_divide(PyObject *, PyObject *);
extern PyObject *wasthon_long_nb_power(PyObject *, PyObject *, PyObject *);
extern PyObject *wasthon_float_nb_absolute(PyObject *);

/* tp_methods entries the built-in types expose. _decimal walks these via
 * cfunc_noargs(t, "name") looking up by name then stashes the function
 * pointer for later direct invocation. */
extern PyObject *wasthon_long_bit_length(PyObject *, PyObject *);
extern PyObject *wasthon_float_as_integer_ratio(PyObject *, PyObject *);

#define METH_NOARGS  0x0004

static PyNumberMethods wasthon_long_nb;
static PyNumberMethods wasthon_float_nb;

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
    PyLong_Type.tp_as_number = &wasthon_long_nb;
    PyLong_Type.tp_methods   = wasthon_long_methods;

    wasthon_float_nb.nb_absolute = wasthon_float_nb_absolute;
    PyFloat_Type.tp_as_number = &wasthon_float_nb;
    PyFloat_Type.tp_methods   = wasthon_float_methods;
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
 * `_PyArg_BadArgument` and `_PyArg_CheckPositional` are also       *
 * referenced by some clinic outputs; sha2's doesn't use them, so   *
 * they're not implemented yet.                                     *
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
