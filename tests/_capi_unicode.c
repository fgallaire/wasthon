/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * _capi_unicode — the bridge's str and bytes C-API, one thin fixture per
 * function (tests/test_unicode.py): each takes Python arguments, makes the
 * C call, and returns what C got back. Plain C-API: it also builds against
 * CPython, the reference (tests/cpython.sh).
 */
#define PY_SSIZE_T_CLEAN
#include "Python.h"
#include <stdarg.h>
#include <string.h>
#include <wchar.h>

/* ---- creating a str ---------------------------------------------------- */

static PyObject *from_string(PyObject *m, PyObject *a) {
    const char *s;
    if (!PyArg_ParseTuple(a, "y", &s)) return NULL;
    return PyUnicode_FromString(s);
}
static PyObject *from_string_and_size(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t len, n;
    if (!PyArg_ParseTuple(a, "y#n", &s, &len, &n)) return NULL;
    return PyUnicode_FromStringAndSize(s, n);
}
static PyObject *intern_from_string(PyObject *m, PyObject *a) {
    const char *s;
    if (!PyArg_ParseTuple(a, "y", &s)) return NULL;
    return PyUnicode_InternFromString(s);
}
static PyObject *from_format_numbers(PyObject *m, PyObject *u) {
    return PyUnicode_FromFormat("%s|%d|%ld|%zd|%c|%%|%x|%u", "abc", -5, 123456789L,
                                (Py_ssize_t)42, 'Z', 255, 7u);
}
static PyObject *from_format_width(PyObject *m, PyObject *u) {
    return PyUnicode_FromFormat("[%5d][%-5s][%.2s][%05ld]", 42, "ab", "xyz", 7L);
}
static PyObject *from_format_objects(PyObject *m, PyObject *a) {
    PyObject *s, *o;
    if (!PyArg_ParseTuple(a, "UO", &s, &o)) return NULL;
    return PyUnicode_FromFormat("%U|%R|%S|%V", s, o, o, s, "unused");
}
static PyObject *format_v(const char *fmt, ...) {
    va_list va;
    va_start(va, fmt);
    PyObject *r = PyUnicode_FromFormatV(fmt, va);
    va_end(va);
    return r;
}
static PyObject *from_format_v(PyObject *m, PyObject *a) {
    int x, y;
    if (!PyArg_ParseTuple(a, "ii", &x, &y)) return NULL;
    return format_v("%d+%d", x, y);
}
static PyObject *from_ordinal(PyObject *m, PyObject *a) {
    int c;
    if (!PyArg_ParseTuple(a, "i", &c)) return NULL;
    return PyUnicode_FromOrdinal(c);
}
static PyObject *from_kind_and_data(PyObject *m, PyObject *a) {
    int kind; const char *data; Py_ssize_t len;
    if (!PyArg_ParseTuple(a, "iy#", &kind, &data, &len)) return NULL;
    return PyUnicode_FromKindAndData(kind, data, len / kind);
}
static PyObject *from_object(PyObject *m, PyObject *o) { return PyUnicode_FromObject(o); }
static PyObject *from_encoded_object(PyObject *m, PyObject *a) {
    PyObject *o; const char *enc, *err;
    if (!PyArg_ParseTuple(a, "Ozz", &o, &enc, &err)) return NULL;
    return PyUnicode_FromEncodedObject(o, enc, err);
}
/* PyUnicode_New then PyUnicode_WriteChar, one code point of a list each */
static PyObject *new_and_write(PyObject *m, PyObject *a) {
    PyObject *chars; int maxchar;
    if (!PyArg_ParseTuple(a, "Oi", &chars, &maxchar)) return NULL;
    Py_ssize_t n = PyList_Size(chars);
    PyObject *u = PyUnicode_New(n, maxchar);
    if (!u) return NULL;
    for (Py_ssize_t i = 0; i < n; i++) {
        if (PyUnicode_WriteChar(u, i, (Py_UCS4)PyLong_AsLong(PyList_GetItem(chars, i))) < 0) {
            Py_DECREF(u);
            return NULL;
        }
    }
    return u;
}
/* PyUnicode_AsWideCharString then PyUnicode_FromWideChar */
static PyObject *wide_char_round_trip(PyObject *m, PyObject *s) {
    Py_ssize_t n;
    wchar_t *w = PyUnicode_AsWideCharString(s, &n);
    if (!w) return NULL;
    PyObject *r = PyUnicode_FromWideChar(w, n);
    PyMem_Free(w);
    return r;
}
/* PyUnicode_AsWideChar into a buffer: (chars copied, str rebuilt from them) */
static PyObject *as_wide_char(PyObject *m, PyObject *a) {
    PyObject *s; Py_ssize_t size;
    if (!PyArg_ParseTuple(a, "Un", &s, &size)) return NULL;
    wchar_t buf[64];
    Py_ssize_t n = PyUnicode_AsWideChar(s, buf, size);
    if (n < 0) return NULL;
    return Py_BuildValue("nN", n, PyUnicode_FromWideChar(buf, n < size ? n : size));
}

/* ---- decoding ------------------------------------------------------------ */

static PyObject *decode(PyObject *m, PyObject *a) {
    const char *s, *enc, *err; Py_ssize_t len;
    if (!PyArg_ParseTuple(a, "y#zz", &s, &len, &enc, &err)) return NULL;
    return PyUnicode_Decode(s, len, enc, err);
}
#define DECODER(name, call)                                             \
    static PyObject *name(PyObject *m, PyObject *a) {                   \
        const char *s, *err; Py_ssize_t len;                            \
        if (!PyArg_ParseTuple(a, "y#z", &s, &len, &err)) return NULL;   \
        return call(s, len, err);                                       \
    }
DECODER(decode_utf8, PyUnicode_DecodeUTF8)
DECODER(decode_ascii, PyUnicode_DecodeASCII)
DECODER(decode_latin1, PyUnicode_DecodeLatin1)
DECODER(decode_raw_unicode_escape, PyUnicode_DecodeRawUnicodeEscape)
/* (str, byteorder after the call) */
static PyObject *decode_utf16(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t len; int bo;
    if (!PyArg_ParseTuple(a, "y#i", &s, &len, &bo)) return NULL;
    PyObject *r = PyUnicode_DecodeUTF16(s, len, NULL, &bo);
    return r ? Py_BuildValue("Ni", r, bo) : NULL;
}
static PyObject *decode_utf32(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t len; int bo;
    if (!PyArg_ParseTuple(a, "y#i", &s, &len, &bo)) return NULL;
    PyObject *r = PyUnicode_DecodeUTF32(s, len, NULL, &bo);
    return r ? Py_BuildValue("Ni", r, bo) : NULL;
}
static PyObject *decode_locale(PyObject *m, PyObject *a) {
    const char *s;
    if (!PyArg_ParseTuple(a, "y", &s)) return NULL;
    return PyUnicode_DecodeLocale(s, NULL);
}

/* ---- encoding and exporting ---------------------------------------------- */

static PyObject *as_utf8(PyObject *m, PyObject *s) {
    const char *p = PyUnicode_AsUTF8(s);
    return p ? PyBytes_FromString(p) : NULL;
}
static PyObject *as_utf8_and_size(PyObject *m, PyObject *s) {
    Py_ssize_t n;
    const char *p = PyUnicode_AsUTF8AndSize(s, &n);
    return p ? Py_BuildValue("y#n", p, n, n) : NULL;
}
static PyObject *as_utf8_string(PyObject *m, PyObject *s) { return PyUnicode_AsUTF8String(s); }
static PyObject *as_ascii_string(PyObject *m, PyObject *s) { return PyUnicode_AsASCIIString(s); }
static PyObject *as_latin1_string(PyObject *m, PyObject *s) { return PyUnicode_AsLatin1String(s); }
static PyObject *as_encoded_string(PyObject *m, PyObject *a) {
    PyObject *s; const char *enc, *err;
    if (!PyArg_ParseTuple(a, "Uzz", &s, &enc, &err)) return NULL;
    return PyUnicode_AsEncodedString(s, enc, err);
}
static PyObject *ucs4_list(Py_UCS4 *p, Py_ssize_t n) {
    PyObject *l = PyList_New(n);
    for (Py_ssize_t i = 0; l && i < n; i++) PyList_SetItem(l, i, PyLong_FromLong(p[i]));
    return l;
}
static PyObject *as_ucs4_copy(PyObject *m, PyObject *s) {
    Py_UCS4 *p = PyUnicode_AsUCS4Copy(s);
    if (!p) return NULL;
    PyObject *l = ucs4_list(p, PyUnicode_GetLength(s) + 1);   /* with the NUL */
    PyMem_Free(p);
    return l;
}
static PyObject *as_ucs4(PyObject *m, PyObject *a) {
    PyObject *s; Py_ssize_t size; int copy_null;
    if (!PyArg_ParseTuple(a, "Uni", &s, &size, &copy_null)) return NULL;
    Py_UCS4 buf[64] = {0};
    if (!PyUnicode_AsUCS4(s, buf, size, copy_null)) return NULL;
    return ucs4_list(buf, size);
}
static PyObject *fs_converter(PyObject *m, PyObject *o) {
    PyObject *out = NULL;
    if (!PyUnicode_FSConverter(o, &out)) return NULL;
    return out;
}

/* ---- inspecting ------------------------------------------------------------ */

static PyObject *get_length(PyObject *m, PyObject *s) {
    return Py_BuildValue("nn", PyUnicode_GetLength(s), PyUnicode_GET_LENGTH(s));
}
static PyObject *kind(PyObject *m, PyObject *s) {
    return Py_BuildValue("ikN", (int)PyUnicode_KIND(s),
                         (unsigned long)PyUnicode_MAX_CHAR_VALUE(s),
                         PyBool_FromLong(PyUnicode_IS_ASCII(s)));
}
/* every code point read three ways: PyUnicode_READ on DATA, READ_CHAR, ReadChar */
static PyObject *read_chars(PyObject *m, PyObject *s) {
    Py_ssize_t n = PyUnicode_GET_LENGTH(s);
    int k = PyUnicode_KIND(s);
    const void *data = PyUnicode_DATA(s);
    PyObject *l = PyList_New(n);
    for (Py_ssize_t i = 0; l && i < n; i++) {
        Py_UCS4 a = PyUnicode_READ(k, data, i), b = PyUnicode_READ_CHAR(s, i),
                c = PyUnicode_ReadChar(s, i);
        PyList_SetItem(l, i, a == b && b == c ? PyLong_FromLong(a) : PyUnicode_FromString("mismatch"));
    }
    return l;
}
static PyObject *one_byte_data(PyObject *m, PyObject *s) {
    return PyBytes_FromStringAndSize((const char *)PyUnicode_1BYTE_DATA(s), PyUnicode_GET_LENGTH(s));
}
static PyObject *find_char(PyObject *m, PyObject *a) {
    PyObject *s; int ch, dir; Py_ssize_t start, end;
    if (!PyArg_ParseTuple(a, "Uinni", &s, &ch, &start, &end, &dir)) return NULL;
    return PyLong_FromSsize_t(PyUnicode_FindChar(s, ch, start, end, dir));
}
static PyObject *substring(PyObject *m, PyObject *a) {
    PyObject *s; Py_ssize_t start, end;
    if (!PyArg_ParseTuple(a, "Unn", &s, &start, &end)) return NULL;
    return PyUnicode_Substring(s, start, end);
}

/* ---- operations ------------------------------------------------------------ */

static PyObject *concat(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "OO", &x, &y)) return NULL;
    return PyUnicode_Concat(x, y);
}
static PyObject *append_and_del(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "UU", &x, &y)) return NULL;
    Py_INCREF(x);
    Py_INCREF(y);                        /* AppendAndDel steals it */
    PyUnicode_AppendAndDel(&x, y);
    return x;
}
static PyObject *join(PyObject *m, PyObject *a) {
    PyObject *sep, *seq;
    if (!PyArg_ParseTuple(a, "OO", &sep, &seq)) return NULL;
    return PyUnicode_Join(sep, seq);
}
static PyObject *split(PyObject *m, PyObject *a) {
    PyObject *s, *sep; Py_ssize_t max;
    if (!PyArg_ParseTuple(a, "UOn", &s, &sep, &max)) return NULL;
    return PyUnicode_Split(s, sep == Py_None ? NULL : sep, max);
}
static PyObject *replace(PyObject *m, PyObject *a) {
    PyObject *s, *sub, *repl; Py_ssize_t max;
    if (!PyArg_ParseTuple(a, "UUUn", &s, &sub, &repl, &max)) return NULL;
    return PyUnicode_Replace(s, sub, repl, max);
}
static PyObject *contains(PyObject *m, PyObject *a) {
    PyObject *s, *sub;
    if (!PyArg_ParseTuple(a, "OO", &s, &sub)) return NULL;
    int r = PyUnicode_Contains(s, sub);
    return r < 0 ? NULL : PyBool_FromLong(r);
}
static PyObject *tailmatch(PyObject *m, PyObject *a) {
    PyObject *s, *sub; Py_ssize_t start, end; int dir;
    if (!PyArg_ParseTuple(a, "UUnni", &s, &sub, &start, &end, &dir)) return NULL;
    Py_ssize_t r = PyUnicode_Tailmatch(s, sub, start, end, dir);
    return r < 0 ? NULL : PyLong_FromSsize_t(r);
}
static PyObject *find(PyObject *m, PyObject *a) {
    PyObject *s, *sub; Py_ssize_t start, end; int dir;
    if (!PyArg_ParseTuple(a, "UUnni", &s, &sub, &start, &end, &dir)) return NULL;
    Py_ssize_t r = PyUnicode_Find(s, sub, start, end, dir);
    return r == -2 ? NULL : PyLong_FromSsize_t(r);
}
static PyObject *compare(PyObject *m, PyObject *a) {
    PyObject *x, *y;
    if (!PyArg_ParseTuple(a, "UU", &x, &y)) return NULL;
    int r = PyUnicode_Compare(x, y);
    return PyErr_Occurred() ? NULL : PyLong_FromLong(r < 0 ? -1 : r > 0);
}
static PyObject *compare_with_ascii(PyObject *m, PyObject *a) {
    PyObject *s; const char *b;
    if (!PyArg_ParseTuple(a, "Uy", &s, &b)) return NULL;
    int r = PyUnicode_CompareWithASCIIString(s, b);
    return PyLong_FromLong(r < 0 ? -1 : r > 0);
}
static PyObject *equal_to_utf8(PyObject *m, PyObject *a) {
    PyObject *s; const char *b;
    if (!PyArg_ParseTuple(a, "Uy", &s, &b)) return NULL;
    return PyBool_FromLong(PyUnicode_EqualToUTF8(s, b));
}
static PyObject *format(PyObject *m, PyObject *a) {
    PyObject *fmt, *args;
    if (!PyArg_ParseTuple(a, "UO", &fmt, &args)) return NULL;
    return PyUnicode_Format(fmt, args);
}

/* ---- PyUnicodeWriter ------------------------------------------------------- */

static PyObject *writer(PyObject *m, PyObject *a) {
    PyObject *s, *o;
    if (!PyArg_ParseTuple(a, "UO", &s, &o)) return NULL;
    PyUnicodeWriter *w = PyUnicodeWriter_Create(0);
    if (!w) return NULL;
    if (PyUnicodeWriter_WriteChar(w, '[') < 0
        || PyUnicodeWriter_WriteUTF8(w, "h\xc3\xa9llo", -1) < 0
        || PyUnicodeWriter_WriteASCII(w, "-", 1) < 0
        || PyUnicodeWriter_WriteStr(w, o) < 0
        || PyUnicodeWriter_WriteRepr(w, s) < 0
        || PyUnicodeWriter_WriteSubstring(w, s, 1, 3) < 0
        || PyUnicodeWriter_Format(w, "%d%%", 50) < 0
        || PyUnicodeWriter_WriteChar(w, ']') < 0) {
        PyUnicodeWriter_Discard(w);
        return NULL;
    }
    return PyUnicodeWriter_Finish(w);
}
/* one write between PyUnicodeWriter_Create and _Finish */
static PyObject *writer_one(PyObject *m, PyObject *a) {
    const char *op; PyObject *arg;
    if (!PyArg_ParseTuple(a, "sO", &op, &arg)) return NULL;
    PyUnicodeWriter *w = PyUnicodeWriter_Create(0);
    if (!w) return NULL;
    int r = -1;
    if (!strcmp(op, "char")) r = PyUnicodeWriter_WriteChar(w, (Py_UCS4)PyLong_AsLong(arg));
    else if (!strcmp(op, "utf8")) r = PyUnicodeWriter_WriteUTF8(w, PyBytes_AsString(arg), -1);
    else if (!strcmp(op, "ascii")) r = PyUnicodeWriter_WriteASCII(w, PyBytes_AsString(arg), PyBytes_Size(arg));
    else if (!strcmp(op, "str")) r = PyUnicodeWriter_WriteStr(w, arg);
    else if (!strcmp(op, "repr")) r = PyUnicodeWriter_WriteRepr(w, arg);
    else if (!strcmp(op, "substring")) r = PyUnicodeWriter_WriteSubstring(w, arg, 1, 3);
    else if (!strcmp(op, "format")) r = PyUnicodeWriter_Format(w, "%d%%", (int)PyLong_AsLong(arg));
    if (r < 0) {
        PyUnicodeWriter_Discard(w);
        return NULL;
    }
    return PyUnicodeWriter_Finish(w);
}
static PyObject *writer_discard(PyObject *m, PyObject *u) {
    PyUnicodeWriter *w = PyUnicodeWriter_Create(8);
    if (!w) return NULL;
    PyUnicodeWriter_WriteChar(w, 'x');
    PyUnicodeWriter_Discard(w);
    Py_RETURN_NONE;
}

/* ---- bytes ------------------------------------------------------------------ */

static PyObject *bytes_from_string(PyObject *m, PyObject *a) {
    const char *s;
    if (!PyArg_ParseTuple(a, "y", &s)) return NULL;
    return PyBytes_FromString(s);
}
static PyObject *bytes_from_string_and_size(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t len, n;
    if (!PyArg_ParseTuple(a, "y#n", &s, &len, &n)) return NULL;
    return PyBytes_FromStringAndSize(s, n);
}
static PyObject *bytes_from_object(PyObject *m, PyObject *o) { return PyBytes_FromObject(o); }
/* (bytes up to the first NUL, PyBytes_Size, PyBytes_GET_SIZE) */
static PyObject *bytes_as_string(PyObject *m, PyObject *b) {
    char *p = PyBytes_AsString(b);
    if (!p) return NULL;
    return Py_BuildValue("ynn", p, PyBytes_Size(b), PyBytes_GET_SIZE(b));
}
static PyObject *bytes_as_string_and_size(PyObject *m, PyObject *b) {
    char *p; Py_ssize_t n;
    if (PyBytes_AsStringAndSize(b, &p, &n) < 0) return NULL;
    return Py_BuildValue("y#n", p, n, n);
}
static PyObject *bytes_join(PyObject *m, PyObject *a) {
    PyObject *sep, *seq;
    if (!PyArg_ParseTuple(a, "OO", &sep, &seq)) return NULL;
    return PyBytes_Join(sep, seq);
}
static PyObject *bytes_decode_escape(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t len;
    if (!PyArg_ParseTuple(a, "y#", &s, &len)) return NULL;
    return PyBytes_DecodeEscape(s, len, NULL, 0, NULL);
}
/* a new bytes filled with the argument, then _PyBytes_Resize to n */
static PyObject *bytes_resize(PyObject *m, PyObject *a) {
    const char *s; Py_ssize_t len, n;
    if (!PyArg_ParseTuple(a, "y#n", &s, &len, &n)) return NULL;
    PyObject *b = PyBytes_FromStringAndSize(s, len);
    if (!b || _PyBytes_Resize(&b, n) < 0) return NULL;
    return b;
}

#define M(name, flags) {#name, (PyCFunction)(void (*)(void))name, flags, NULL}
static PyMethodDef methods[] = {
    M(from_string, METH_VARARGS), M(from_string_and_size, METH_VARARGS),
    M(intern_from_string, METH_VARARGS), M(from_format_numbers, METH_NOARGS),
    M(from_format_width, METH_NOARGS), M(from_format_objects, METH_VARARGS),
    M(from_format_v, METH_VARARGS), M(from_ordinal, METH_VARARGS),
    M(from_kind_and_data, METH_VARARGS), M(from_object, METH_O),
    M(from_encoded_object, METH_VARARGS), M(new_and_write, METH_VARARGS),
    M(wide_char_round_trip, METH_O), M(as_wide_char, METH_VARARGS),
    M(decode, METH_VARARGS), M(decode_utf8, METH_VARARGS), M(decode_ascii, METH_VARARGS),
    M(decode_latin1, METH_VARARGS), M(decode_raw_unicode_escape, METH_VARARGS),
    M(decode_utf16, METH_VARARGS), M(decode_utf32, METH_VARARGS),
    M(decode_locale, METH_VARARGS),
    M(as_utf8, METH_O), M(as_utf8_and_size, METH_O), M(as_utf8_string, METH_O),
    M(as_ascii_string, METH_O), M(as_latin1_string, METH_O),
    M(as_encoded_string, METH_VARARGS), M(as_ucs4_copy, METH_O), M(as_ucs4, METH_VARARGS),
    M(fs_converter, METH_O),
    M(get_length, METH_O), M(kind, METH_O), M(read_chars, METH_O), M(one_byte_data, METH_O),
    M(find_char, METH_VARARGS), M(substring, METH_VARARGS),
    M(concat, METH_VARARGS), M(append_and_del, METH_VARARGS), M(join, METH_VARARGS),
    M(split, METH_VARARGS), M(replace, METH_VARARGS), M(contains, METH_VARARGS),
    M(tailmatch, METH_VARARGS), M(find, METH_VARARGS), M(compare, METH_VARARGS),
    M(compare_with_ascii, METH_VARARGS), M(equal_to_utf8, METH_VARARGS),
    M(format, METH_VARARGS),
    M(writer, METH_VARARGS), M(writer_one, METH_VARARGS), M(writer_discard, METH_NOARGS),
    M(bytes_from_string, METH_VARARGS), M(bytes_from_string_and_size, METH_VARARGS),
    M(bytes_from_object, METH_O), M(bytes_as_string, METH_O),
    M(bytes_as_string_and_size, METH_O), M(bytes_join, METH_VARARGS),
    M(bytes_decode_escape, METH_VARARGS), M(bytes_resize, METH_VARARGS),
    {NULL}};
static struct PyModuleDef def = {PyModuleDef_HEAD_INIT, "_capi_unicode", NULL, -1, methods};

PyMODINIT_FUNC PyInit__capi_unicode(void) { return PyModule_Create(&def); }
