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
#include <math.h>   /* hypot, isfinite, isinf, isnan, fabs, copysign, NAN, INFINITY */
#include <errno.h>  /* errno, ERANGE, EDOM */

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
    /* CPython 3.14's complex division (Objects/complexobject.c): Smith's
     * algorithm scales by the larger-magnitude part to avoid overflow and
     * divides by the SIGNED denominator so the sign of a zero result survives
     * (the naive a*conj(b)/|b|^2 form divides by the always-positive |b|^2 and
     * loses it, e.g. cmath.log(1, 0.5).real came out +0.0 instead of -0.0),
     * then a C99 end-case block recovers signed infinities/zeros. */
    Py_complex r;
    const double abs_breal = b.real < 0 ? -b.real : b.real;
    const double abs_bimag = b.imag < 0 ? -b.imag : b.imag;
    if (abs_breal >= abs_bimag) {
        if (abs_breal == 0.0) {
            errno = EDOM;
            r.real = r.imag = 0.0;
        } else {
            const double ratio = b.imag / b.real;
            const double denom = b.real + b.imag * ratio;
            r.real = (a.real + a.imag * ratio) / denom;
            r.imag = (a.imag - a.real * ratio) / denom;
        }
    } else if (abs_bimag >= abs_breal) {
        const double ratio = b.real / b.imag;
        const double denom = b.real * ratio + b.imag;
        r.real = (a.real * ratio + a.imag) / denom;
        r.imag = (a.imag * ratio - a.real) / denom;
    } else {
        /* At least one of b.real or b.imag is a NaN */
        r.real = r.imag = NAN;
    }
    if (isnan(r.real) && isnan(r.imag)) {
        if ((isinf(a.real) || isinf(a.imag))
            && isfinite(b.real) && isfinite(b.imag)) {
            const double x = copysign(isinf(a.real) ? 1.0 : 0.0, a.real);
            const double y = copysign(isinf(a.imag) ? 1.0 : 0.0, a.imag);
            r.real = INFINITY * (x * b.real + y * b.imag);
            r.imag = INFINITY * (y * b.real - x * b.imag);
        } else if ((isinf(abs_breal) || isinf(abs_bimag))
                   && isfinite(a.real) && isfinite(a.imag)) {
            const double x = copysign(isinf(b.real) ? 1.0 : 0.0, b.real);
            const double y = copysign(isinf(b.imag) ? 1.0 : 0.0, b.imag);
            r.real = 0.0 * (a.real * x + a.imag * y);
            r.imag = 0.0 * (a.imag * x - a.real * y);
        }
    }
    return r;
}
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
    Py_complex r = a;
    if (b) {
        r.real /= b;
        r.imag /= b;
    } else {
        errno = EDOM;
        r.real = r.imag = 0.0;
    }
    return r;
}
static inline Py_complex _Py_rc_quot(double a, Py_complex b) {
    /* Smith's algorithm for a/(x+yi), specialised for an all-real numerator
     * (CPython 3.14). The old naive a*(x-yi)/(x²+y²) form overflowed on the
     * |b|² and dropped the sign of a zero result, just like _Py_c_quot did. */
    Py_complex r;
    const double abs_breal = b.real < 0 ? -b.real : b.real;
    const double abs_bimag = b.imag < 0 ? -b.imag : b.imag;
    if (abs_breal >= abs_bimag) {
        if (abs_breal == 0.0) {
            errno = EDOM;
            r.real = r.imag = 0.0;
        } else {
            const double ratio = b.imag / b.real;
            const double denom = b.real + b.imag * ratio;
            r.real = a / denom;
            r.imag = (-a * ratio) / denom;
        }
    } else if (abs_bimag >= abs_breal) {
        const double ratio = b.real / b.imag;
        const double denom = b.real * ratio + b.imag;
        r.real = (a * ratio) / denom;
        r.imag = (-a) / denom;
    } else {
        r.real = r.imag = NAN;
    }
    if (isnan(r.real) && isnan(r.imag) && isfinite(a)
        && (isinf(abs_breal) || isinf(abs_bimag))) {
        const double x = copysign(isinf(b.real) ? 1.0 : 0.0, b.real);
        const double y = copysign(isinf(b.imag) ? 1.0 : 0.0, b.imag);
        r.real = 0.0 * (a * x);
        r.imag = 0.0 * (-a * y);
    }
    return r;
}

#ifdef __cplusplus
}
#endif
#endif
