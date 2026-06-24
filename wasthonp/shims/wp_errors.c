/* wasthonp v2 — error repatriation. CPython's parser funnels every syntax error
 * through _PyPegen_raise_error_known_location, which (1) formats the message via
 * PyUnicode_FromFormatV and (2) builds a SyntaxError object. Building the object
 * would pull in the exception/type/ceval machinery (the monolith we avoid). So
 * we --wrap that funnel: capture the message + position into a struct, set the
 * parser's error_indicator, and let wasthonp_dump serialize it as JSON. The JS
 * side rebuilds Brython's SyntaxError — same Strategy-C trick as the AST. */
#include "Python.h"
#include "internal/pycore_ast.h"
#include "internal/pycore_pyarena.h"
#include "../Parser/pegen.h"
#include "wp_errors.h"
#include <string.h>
#include <stdarg.h>

wp_error_t wp_error;
void wp_error_reset(void){ wp_error.set = 0; wp_error.msg[0] = 0; }

/* Linked via -Wl,--wrap=_PyPegen_raise_error_known_location. */
PyObject *__wrap__PyPegen_raise_error_known_location(
    Parser *p, PyObject *errtype,
    Py_ssize_t lineno, Py_ssize_t col_offset,
    Py_ssize_t end_lineno, Py_ssize_t end_col_offset,
    const char *errmsg, va_list va)
{
    (void)errtype;   /* all PyExc_* stubs read as NULL — type left "SyntaxError" */
    if(!wp_error.set){
        PyObject *s = PyUnicode_FromFormatV(errmsg, va);
        const char *m = s ? PyUnicode_AsUTF8(s) : errmsg;
        if(!m) m = "";
        strncpy(wp_error.msg, m, sizeof(wp_error.msg)-1);
        wp_error.msg[sizeof(wp_error.msg)-1] = 0;
        wp_error.type       = "SyntaxError";
        wp_error.lineno     = (long)lineno;
        wp_error.col        = (long)col_offset;
        wp_error.end_lineno = (long)end_lineno;
        wp_error.end_col    = (long)end_col_offset;
        wp_error.set = 1;
    }
    if(p) p->error_indicator = 1;
    return NULL;
}
