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
#include <math.h>   /* for hypot, isfinite, isinf, fabs */
#include <errno.h>  /* for errno, ERANGE */
static inline double _Py_c_abs(Py_complex z) {
    /* Faithful to CPython's complexobject.c: sets errno = ERANGE on
     * overflow (otherwise errno = 0) — cmath.polar/exp/... read errno to
     * raise OverflowError. The old stub returned bare hypot(), so
     * cmath.polar(complex(1.4e308, 1.4e308)) yielded inf instead of raising. */
    double result;
    if (!isfinite(z.real) || !isfinite(z.imag)) {
        /* C99: an infinite part gives infinity even if the other is NaN. */
        if (isinf(z.real)) { errno = 0; return fabs(z.real); }
        if (isinf(z.imag)) { errno = 0; return fabs(z.imag); }
        return NAN;  /* a NaN part, neither infinite */
    }
    result = hypot(z.real, z.imag);
    errno = isfinite(result) ? 0 : ERANGE;
    return result;
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
