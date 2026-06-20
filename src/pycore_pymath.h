/* Wasthon shim for CPython's pycore_pymath.h. */
#ifndef Py_INTERNAL_PYMATH_H
#define Py_INTERNAL_PYMATH_H

/* _PY_SHORT_FLOAT_REPR — CPython only uses short repr when supported by
 * the platform. We disable it (no special float-repr path needed for
 * math module functionality). */
#define _PY_SHORT_FLOAT_REPR  0

/* emscripten/musl's fma is correctly fused but loses the sign of a zero
 * result when the product x*y underflows to zero and the addend z is zero:
 * fma(1e-300, -1e-300, 0.0) returns +0.0 where IEEE/CPython give -0.0 (the
 * rounded zero takes the sign of the underflowed product). Patch only that
 * case — the fused value is otherwise correct. math.fma is the user
 * (test_fma_zero_result). __builtin_fma keeps the real fused call (no macro
 * recursion). */
#include <math.h>
static inline double wasthon_fma(double x, double y, double z) {
    double r = __builtin_fma(x, y, z);
    if (r == 0.0 && z == 0.0 && x != 0.0 && y != 0.0 &&
        !isinf(x) && !isinf(y)) {
        r = copysign(0.0, copysign(1.0, x) * copysign(1.0, y));
    }
    return r;
}
#define fma(x, y, z) wasthon_fma((x), (y), (z))

#endif
