#ifndef WP_ERRORS_H
#define WP_ERRORS_H
/* Strategy-C error repatriation: structured parser error captured at the funnel
 * (no Python exception object built — the JS side rebuilds the Brython error). */
typedef struct {
    int set;
    const char *type;                         /* "SyntaxError" (for now) */
    long lineno, col, end_lineno, end_col;    /* byte offsets, as the parser has them */
    char msg[1024];                           /* CPython's exact message wording */
} wp_error_t;
extern wp_error_t wp_error;
void wp_error_reset(void);
#endif
