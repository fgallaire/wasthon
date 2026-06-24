/* wasthonp Strategy-C: real-signature shims for the C-API surface actually
 * exercised while parsing a simple expression. Backed by libc malloc with a
 * pinned-high refcount so the parser's Py_INCREF/DECREF are harmless — no real
 * CPython object layer, no eval loop, no runtime. This is the experiment that
 * shows the parser is structurally separable from the object layer. */
#include "Python.h"
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

/* --- memory: the arena genuinely needs these --- */
void *PyMem_Malloc(size_t n)            { return malloc(n ? n : 1); }
void *PyMem_Calloc(size_t n, size_t s)  { return calloc(n ? n : 1, s ? s : 1); }
void *PyMem_Realloc(void *p, size_t n)  { return realloc(p, n ? n : 1); }
void  PyMem_Free(void *p)               { free(p); }

/* --- a fake PyObject: ob_refcnt at offset 0 (CPython ABI), pinned high so
 *     Py_DECREF never reaches 0 → never calls _Py_Dealloc. Used for non-string
 *     leaves (numbers, tuples, lists) the parser only stores, never inspects. */
static PyObject *mkobj(void) {
    Py_ssize_t *o = (Py_ssize_t*)calloc(1, 64);
    o[0] = (Py_ssize_t)1 << 30;   /* ob_refcnt */
    return (PyObject*)o;
}

/* --- a REAL-layout compact-ASCII str. Built from the genuine PyASCIIObject
 *     struct (so PyUnicode_Check / PyUnicode_GET_LENGTH / PyUnicode_DATA all
 *     read correct offsets) carrying a str type object whose tp_flags has
 *     Py_TPFLAGS_UNICODE_SUBCLASS — WITHOUT compiling unicodeobject.c. The
 *     bytes live right after the struct (compact form). --- */
/* the REAL PyUnicode_Type symbol so PyUnicode_CheckExact (Py_TYPE==&PyUnicode_Type)
 * passes — needed by f-string decoding (_PyPegen_decode_fstring_part). */
PyTypeObject PyUnicode_Type = {
    .ob_base = { .ob_base = { .ob_refcnt = (Py_ssize_t)1 << 30, .ob_type = NULL },
                 .ob_size = 0 },
    .tp_name = "str",
    .tp_flags = Py_TPFLAGS_DEFAULT | Py_TPFLAGS_UNICODE_SUBCLASS,
};
#define wasthonp_str_type PyUnicode_Type
static PyObject *mkstr(const char *s, Py_ssize_t n) {
    if (n < 0) n = s ? (Py_ssize_t)strlen(s) : 0;
    PyASCIIObject *o = (PyASCIIObject*)calloc(1, sizeof(PyASCIIObject) + n + 1);
    o->ob_base.ob_refcnt = (Py_ssize_t)1 << 30;
    o->ob_base.ob_type   = &wasthonp_str_type;
    /* length must be the CODE-POINT count (not byte count) so PyUnicode_GET_LENGTH
     * is right; the escape decoder sizes its buffer from it (byte count would
     * overflow for non-ASCII content). Data stays the UTF-8 bytes. */
    { Py_ssize_t cp=0; if(s){ for(Py_ssize_t i=0;i<n;i++){ if(((unsigned char)s[i]&0xC0)!=0x80) cp++; } } else { cp=n; } o->length = cp; }
    o->hash = -1;
    o->state.kind = 1;       /* PyUnicode_1BYTE_KIND */
    o->state.compact = 1;
    o->state.ascii = 1;
    o->state.interned = 0;
    char *data = (char*)(o + 1);
    if (s && n) memcpy(data, s, n);
    data[n] = 0;
    return (PyObject*)o;
}
static const char *str_data(PyObject *o){ return (const char*)((PyASCIIObject*)o + 1); }

/* --- a REAL-layout bytes object: token text is carried as PyBytes and read
 *     back with PyBytes_AsString during number/string literal parsing. --- */
PyTypeObject PyBytes_Type = {
    .ob_base = { .ob_base = { .ob_refcnt = (Py_ssize_t)1 << 30, .ob_type = NULL },
                 .ob_size = 0 },
    .tp_name = "bytes",
    .tp_flags = Py_TPFLAGS_DEFAULT | Py_TPFLAGS_BYTES_SUBCLASS,
};
#define wasthonp_bytes_type PyBytes_Type
static PyObject *mkbytes(const char *s, Py_ssize_t n) {
    if (n < 0) n = s ? (Py_ssize_t)strlen(s) : 0;
    PyBytesObject *o = (PyBytesObject*)calloc(1, sizeof(PyBytesObject) + n + 1);
    o->ob_base.ob_base.ob_refcnt = (Py_ssize_t)1 << 30;
    o->ob_base.ob_base.ob_type   = &wasthonp_bytes_type;
    o->ob_base.ob_size = n;
    o->ob_shash = -1;
    if (s && n) memcpy(o->ob_sval, s, n);
    o->ob_sval[n] = 0;
    return (PyObject*)o;
}

/* --- object creators --- */
PyObject *PyUnicode_FromString(const char *s)                 { return mkstr(s, -1); }
PyObject *PyUnicode_FromStringAndSize(const char *s, Py_ssize_t n){ return mkstr(s, n); }
PyObject *PyUnicode_DecodeUTF8(const char *s, Py_ssize_t n, const char *e){ (void)e; return mkstr(s, n); }
PyObject *PyUnicode_DecodeUTF8Stateful(const char *s, Py_ssize_t n, const char *e, Py_ssize_t *consumed){ (void)e; if(consumed)*consumed=n; return mkstr(s, n); }
/* Decode source bytes per a coding-cookie encoding → a str holding UTF-8 bytes.
 * Handles utf-8/ascii (passthrough) and latin-1/iso-8859-1 (1 byte → 1 code
 * point → UTF-8). Other 8-bit encodings fall back to latin-1 (no crash; exact
 * chars may differ — rare). Used by the tokenizer's non-UTF8 source path. */
static int enc_is(const char *e, const char *name){ /* case-insensitive contains */
    for(const char *p=e; *p; p++){ const char *a=p,*b=name; while(*b && *a && ((*a|32)==(*b|32))){a++;b++;} if(!*b) return 1; } return 0;
}
PyObject *PyUnicode_Decode(const char *s, Py_ssize_t n, const char *enc, const char *e){
    (void)e;
    if(!enc || enc_is(enc,"utf-8") || enc_is(enc,"utf8") || enc_is(enc,"ascii"))
        return mkstr(s, n);
    /* latin-1 family (and fallback): each byte is a code point 0..255 → UTF-8 */
    char *buf=(char*)malloc(n*2+1); int j=0;
    for(Py_ssize_t i=0;i<n;i++){ unsigned char b=(unsigned char)s[i];
        if(b<0x80) buf[j++]=(char)b;
        else { buf[j++]=(char)(0xC0|(b>>6)); buf[j++]=(char)(0x80|(b&0x3F)); } }
    buf[j]=0; PyObject *r=mkstr(buf,j); free(buf); return r;
}
PyObject *PyUnicode_AsUTF8String(PyObject *u){ const char *d=str_data(u); return mkbytes(d,(Py_ssize_t)strlen(d)); }
/* string-literal escape decoding: the dumper reads the source span, so the
 * decoded object's exact value is unused — just don't trap, report no errors. */
PyObject *_PyUnicode_DecodeUnicodeEscapeInternal2(const char *s, Py_ssize_t n, const char *e, Py_ssize_t *consumed, int *fbad, const char **fbadp){ (void)e; if(consumed)*consumed=n; if(fbad)*fbad=-1; if(fbadp)*fbadp=(const char*)0; return mkstr(s, n); }
/* bytes-literal escape decoding (b'\x00' …) — dumper uses the source span, so
 * the decoded value is unused; just don't trap and report no bad escape. */
PyObject *_PyBytes_DecodeEscape2(const char *s, Py_ssize_t n, const char *e, int *fbad, const char **fbadp){ (void)e; if(fbad)*fbad=-1; if(fbadp)*fbadp=(const char*)0; return mkbytes(s, n); }
PyObject *PyUnicode_InternFromString(const char *s)           { return mkstr(s, -1); }
void _PyUnicode_InternImmortal(PyInterpreterState *i, PyObject **p){ (void)i;(void)p; }
void _PyUnicode_InternMortal(PyInterpreterState *i, PyObject **p){ (void)i;(void)p; }
PyObject *PyLong_FromString(const char *s, char **pe, int b)  { if(pe)*pe=(char*)s; (void)b; return mkobj(); }
PyObject *PyLong_FromLong(long v)                             { (void)v; return mkobj(); }
PyObject *PyFloat_FromDouble(double v)                        { (void)v; return mkobj(); }
PyObject *PyComplex_FromCComplex(Py_complex c)               { (void)c; return mkobj(); }
/* numeric literal scanning — back onto libc */
long PyOS_strtol(const char *s, char **e, int b)            { return strtol(s, e, b); }
unsigned long PyOS_strtoul(const char *s, char **e, int b)  { return strtoul(s, e, b); }
double PyOS_string_to_double(const char *s, char **e, PyObject *ex){ (void)ex; return strtod(s, e); }
PyObject *PyBytes_FromStringAndSize(const char *s, Py_ssize_t n){ return mkbytes(s, n); }
char *PyBytes_AsString(PyObject *o)                          { return ((PyBytesObject*)o)->ob_sval; }
Py_ssize_t PyBytes_Size(PyObject *o)                        { return ((PyBytesObject*)o)->ob_base.ob_size; }
int PyBytes_AsStringAndSize(PyObject *o, char **s, Py_ssize_t *n){ if(s)*s=((PyBytesObject*)o)->ob_sval; if(n)*n=((PyBytesObject*)o)->ob_base.ob_size; return 0; }
/* in-place bytes concat (implicit b'..' b'..') */
void PyBytes_Concat(PyObject **pv, PyObject *w){
    if(!pv||!*pv) return;
    PyBytesObject *a=(PyBytesObject*)*pv; Py_ssize_t la=a->ob_base.ob_size;
    Py_ssize_t lb = w ? ((PyBytesObject*)w)->ob_base.ob_size : 0;
    PyBytesObject *o=(PyBytesObject*)calloc(1,sizeof(PyBytesObject)+la+lb+1);
    o->ob_base.ob_base.ob_refcnt=(Py_ssize_t)1<<30; o->ob_base.ob_base.ob_type=&PyBytes_Type; o->ob_base.ob_size=la+lb; o->ob_shash=-1;
    memcpy(o->ob_sval,a->ob_sval,la); if(w) memcpy(o->ob_sval+la,((PyBytesObject*)w)->ob_sval,lb); o->ob_sval[la+lb]=0;
    *pv=(PyObject*)o;
}
PyObject *PyTuple_New(Py_ssize_t n)                          { (void)n; return mkobj(); }
PyObject *Py_BuildValue(const char *fmt, ...)               { (void)fmt; return mkobj(); }
/* cached constants (_PyPegen_concatenate_strings uses EMPTY_STR for ""). */
PyObject *Py_GetConstant(unsigned int id){
    switch(id){ case 7: return mkstr("",0); case 8: return mkbytes("",0);
                default: return mkobj(); }
}
PyObject *Py_GetConstantBorrowed(unsigned int id){ return Py_GetConstant(id); }

/* --- arena's object-tracking list: minimal but real signatures --- */
PyObject *PyList_New(Py_ssize_t n)                          { (void)n; return mkobj(); }
int PyList_Append(PyObject *l, PyObject *o)                 { (void)l;(void)o; return 0; }
int PyList_Sort(PyObject *l)                                { (void)l; return 0; }

/* --- minimal PyUnicodeWriter (implicit string concatenation "a" "b") ---
 * Accumulates bytes into a growable buffer; Finish returns a real minimal str.
 * The dumper reads the source span anyway, so exact content is non-critical. */
typedef struct { char *buf; size_t len, cap; } PodWriter;
static void pw_put(PodWriter *w, const char *s, size_t n){ if(w->len+n+1>w->cap){ w->cap=(w->len+n+1)*2; w->buf=realloc(w->buf,w->cap); } memcpy(w->buf+w->len,s,n); w->len+=n; w->buf[w->len]=0; }
PyUnicodeWriter *PyUnicodeWriter_Create(Py_ssize_t hint){ (void)hint; PodWriter *w=calloc(1,sizeof(PodWriter)); w->cap=64; w->buf=calloc(1,w->cap); return (PyUnicodeWriter*)w; }
void PyUnicodeWriter_Discard(PyUnicodeWriter *w){ if(w){ free(((PodWriter*)w)->buf); free(w); } }
PyObject *PyUnicodeWriter_Finish(PyUnicodeWriter *w){ PodWriter *p=(PodWriter*)w; PyObject *r=mkstr(p->buf?p->buf:"", p->len); free(p->buf); free(p); return r; }
int PyUnicodeWriter_WriteStr(PyUnicodeWriter *w, PyObject *o){ const char *d=str_data(o); pw_put((PodWriter*)w,d,strlen(d)); return 0; }
int PyUnicodeWriter_WriteUTF8(PyUnicodeWriter *w, const char *s, Py_ssize_t n){ pw_put((PodWriter*)w,s,n<0?strlen(s):(size_t)n); return 0; }
int PyUnicodeWriter_WriteASCII(PyUnicodeWriter *w, const char *s, Py_ssize_t n){ pw_put((PodWriter*)w,s,n<0?strlen(s):(size_t)n); return 0; }
int PyUnicodeWriter_WriteChar(PyUnicodeWriter *w, Py_UCS4 c){ char b=(char)(c&0x7f); pw_put((PodWriter*)w,&b,1); return 0; }
int PyUnicodeWriter_WriteSubstring(PyUnicodeWriter *w, PyObject *o, Py_ssize_t a, Py_ssize_t b){ const char *d=str_data(o); if(b>a) pw_put((PodWriter*)w,d+a,(size_t)(b-a)); return 0; }
int PyUnicodeWriter_WriteRepr(PyUnicodeWriter *w, PyObject *o){ (void)o; pw_put((PodWriter*)w,"<repr>",6); return 0; }

/* --- error state: no error so the parser stays on the happy path --- */
PyObject *PyErr_Occurred(void)                              { return NULL; }
int PyErr_ExceptionMatches(PyObject *e)                    { (void)e; return 0; }

/* --- string comparisons: "not equal" by default. All our fake str objects are
 *     opaque, so the grammar's soft-keyword / name equality checks must NOT
 *     false-match (returning 0 == "equal" made every name look like a keyword
 *     and the grammar rejected plain expressions). Real Strategy C compares the
 *     POD byte ranges here. --- */
int PyUnicode_CompareWithASCIIString(PyObject *u, const char *s){ return strcmp(str_data(u), s); }
int _PyUnicode_EqualToASCIIString(PyObject *u, const char *s)  { return strcmp(str_data(u), s) == 0; }
PyObject *PyUnicode_Substring(PyObject *u, Py_ssize_t a, Py_ssize_t b){ return mkstr(str_data(u)+a, b-a); }
const char *PyUnicode_AsUTF8(PyObject *u)                  { return str_data(u); }

/* --- recursion guards: 0 == ok / limit-not-reached --- */
int Py_EnterRecursiveCall(const char *w)                   { (void)w; return 0; }
void Py_LeaveRecursiveCall(void)                           { }
int _Py_ReachedRecursionLimitWithMargin(PyThreadState *t, int n){ (void)t;(void)n; return 0; }
int _Py_CheckRecursiveCall(PyThreadState *t, const char *w){ (void)t;(void)w; return 0; }

/* --- Unicode character classification (the tokenizer's real need). ASCII-
 *     correct; non-ASCII approximated — enough for the experiment. Real
 *     Strategy C would compile Objects/unicodectype.c (~7KB, self-contained). --- */
int _PyUnicode_IsPrintable(Py_UCS4 ch)   { return !(ch < 0x20 || ch == 0x7f); }
int _PyUnicode_IsWhitespace(Py_UCS4 ch)  { return ch==' '||ch=='\t'||ch=='\n'||ch=='\r'||ch=='\f'||ch==0x0b; }
int _PyUnicode_IsXidStart(Py_UCS4 ch)    { return (ch=='_')||(ch>='a'&&ch<='z')||(ch>='A'&&ch<='Z')||ch>=128; }
int _PyUnicode_IsXidContinue(Py_UCS4 ch) { return _PyUnicode_IsXidStart(ch)||(ch>='0'&&ch<='9'); }
int _PyUnicode_IsLinebreak(Py_UCS4 ch)   { return ch=='\n'||ch=='\r'||ch==0x0b||ch==0x0c; }
/* tokenizer's non-ASCII identifier check: return the length (treat as a valid
 * identifier — the dumper reads the name's bytes verbatim anyway). */
Py_ssize_t _PyUnicode_ScanIdentifier(PyObject *self){ return ((PyASCIIObject*)self)->length; }

/* --- error-reporting path: correct signatures so it completes (rather than
 *     traps) when the grammar rejects our deliberately-opaque fake tokens. --- */
/* Real %-format: needed for dotted import names (_PyPegen_join_names_with_dot
 * builds "a.b" via "%U.%U"), SyntaxError messages (FromFormatV at the error
 * funnel) and assorted messages. Handles %U %s %d/%i %c %%. */
static int wp_vformat(char *buf, const char *f, va_list ap){
    int n=0;
    for(const char *p=f; *p && n<8100; p++){
        if(*p!='%'){ buf[n++]=*p; continue; }
        p++;
        const char *fs=p; while(*p && strchr("0123456789.-+ #lzt",*p)) p++;
        int fl=(int)(p-fs); if(fl>12) fl=12;   /* width/flags, e.g. the 04 in %04X */
        if(*p=='U'){ PyObject*o=va_arg(ap,PyObject*); const char*s=o?str_data(o):""; while(*s&&n<8100)buf[n++]=*s++; }
        else if(*p=='s'){ const char*s=va_arg(ap,const char*); if(!s)s=""; while(*s&&n<8100)buf[n++]=*s++; }
        else if(*p=='d'||*p=='i'||*p=='u'||*p=='x'||*p=='X'){
            char sp[16]; sp[0]='%'; memcpy(sp+1,fs,fl); sp[1+fl]=(*p=='i'?'d':*p); sp[2+fl]=0;
            if(*p=='d'||*p=='i'){ int v=va_arg(ap,int); n+=snprintf(buf+n,8192-n,sp,v); }
            else { unsigned v=va_arg(ap,unsigned); n+=snprintf(buf+n,8192-n,sp,v); } }
        else if(*p=='c'){ int v=va_arg(ap,int); buf[n++]=(char)v; }
        else if(*p=='R'||*p=='A'||*p=='V'||*p=='S'){ va_arg(ap,void*); }   /* skip object */
        else if(*p=='%'){ buf[n++]='%'; }
        else { buf[n++]='%'; if(*p) buf[n++]=*p; }
    }
    buf[n]=0; return n;
}
PyObject *PyUnicode_FromFormat(const char *f, ...){
    char buf[8192]; va_list ap; va_start(ap,f); int n=wp_vformat(buf,f,ap); va_end(ap); return mkstr(buf,n);
}
PyObject *PyUnicode_FromFormatV(const char *f, va_list v){
    char buf[8192]; va_list ap; va_copy(ap,v); int n=wp_vformat(buf,f,ap); va_end(ap); return mkstr(buf,n);
}
PyObject *PyTuple_Pack(Py_ssize_t n, ...)                  { (void)n; return mkobj(); }
void PyErr_SetObject(PyObject *t, PyObject *v)             { (void)t;(void)v; }
void PyErr_SetString(PyObject *t, const char *m)          { (void)t;(void)m; }
PyObject *PyErr_Format(PyObject *t, const char *f, ...)    { (void)t;(void)f; return NULL; }
void PyErr_Clear(void)                                     { }
void PyErr_Fetch(PyObject **a, PyObject **b, PyObject **c){ if(a)*a=NULL; if(b)*b=NULL; if(c)*c=NULL; }
void PyErr_Restore(PyObject *a, PyObject *b, PyObject *c) { (void)a;(void)b;(void)c; }
PyObject *PyErr_GetRaisedException(void)                   { return NULL; }
void PyErr_SetRaisedException(PyObject *e)                 { (void)e; }
int PyErr_GivenExceptionMatches(PyObject *a, PyObject *b) { (void)a;(void)b; return 0; }

/* --- never actually reached (refcounts pinned high) but must exist --- */
void _Py_Dealloc(PyObject *op)                             { (void)op; }
