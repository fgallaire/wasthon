/* Wasthon shim for CPython's pycore_pymath.h. */
#ifndef Py_INTERNAL_PYMATH_H
#define Py_INTERNAL_PYMATH_H

/* _PY_SHORT_FLOAT_REPR — CPython only uses short repr when supported by
 * the platform. We disable it (no special float-repr path needed for
 * math module functionality). */
#define _PY_SHORT_FLOAT_REPR  0

#endif
