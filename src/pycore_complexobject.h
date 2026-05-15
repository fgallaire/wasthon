/* Wasthon shim for CPython's pycore_complexobject.h.
 * Declares the internal arithmetic helpers cmath uses. We provide static
 * inline implementations in pure C so no bridge calls are needed (these
 * are pure arithmetic on the (real, imag) pairs). */
#ifndef Py_INTERNAL_COMPLEXOBJECT_H
#define Py_INTERNAL_COMPLEXOBJECT_H
#ifdef __cplusplus
extern "C" {
#endif

#include "wasthon.h"  /* for Py_complex */

static inline Py_complex _Py_c_neg(Py_complex a) {
    Py_complex r; r.real = -a.real; r.imag = -a.imag; return r;
}
static inline Py_complex _Py_c_sum(Py_complex a, Py_complex b) {
    Py_complex r; r.real = a.real + b.real; r.imag = a.imag + b.imag; return r;
}
static inline Py_complex _Py_c_diff(Py_complex a, Py_complex b) {
    Py_complex r; r.real = a.real - b.real; r.imag = a.imag - b.imag; return r;
}
static inline Py_complex _Py_c_prod(Py_complex a, Py_complex b) {
    Py_complex r;
    r.real = a.real * b.real - a.imag * b.imag;
    r.imag = a.real * b.imag + a.imag * b.real;
    return r;
}
static inline Py_complex _Py_c_quot(Py_complex a, Py_complex b) {
    double d = b.real * b.real + b.imag * b.imag;
    Py_complex r;
    r.real = (a.real * b.real + a.imag * b.imag) / d;
    r.imag = (a.imag * b.real - a.real * b.imag) / d;
    return r;
}
#include <math.h>  /* for hypot */
static inline double _Py_c_abs(Py_complex a) {
    return hypot(a.real, a.imag);
}
static inline Py_complex _Py_cr_sum(Py_complex a, double b) {
    Py_complex r; r.real = a.real + b; r.imag = a.imag; return r;
}
static inline Py_complex _Py_cr_diff(Py_complex a, double b) {
    Py_complex r; r.real = a.real - b; r.imag = a.imag; return r;
}
static inline Py_complex _Py_rc_diff(double a, Py_complex b) {
    Py_complex r; r.real = a - b.real; r.imag = -b.imag; return r;
}
static inline Py_complex _Py_cr_prod(Py_complex a, double b) {
    Py_complex r; r.real = a.real * b; r.imag = a.imag * b; return r;
}
static inline Py_complex _Py_cr_quot(Py_complex a, double b) {
    Py_complex r; r.real = a.real / b; r.imag = a.imag / b; return r;
}
static inline Py_complex _Py_rc_quot(double a, Py_complex b) {
    /* a / (x + yi) = a*(x - yi) / (x² + y²) */
    double d = b.real * b.real + b.imag * b.imag;
    Py_complex r; r.real = a * b.real / d; r.imag = -a * b.imag / d; return r;
}

#ifdef __cplusplus
}
#endif
#endif
