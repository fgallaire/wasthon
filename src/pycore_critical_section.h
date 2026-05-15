/* wasthon stub — single-threaded WASM, critical sections are no-ops. */
#ifndef WASTHON_PYCORE_CRITICAL_SECTION_H
#define WASTHON_PYCORE_CRITICAL_SECTION_H
#include "wasthon.h"
#define Py_BEGIN_CRITICAL_SECTION(op)         ((void)(op))
#define Py_END_CRITICAL_SECTION()             ((void)0)
#define Py_BEGIN_CRITICAL_SECTION2(a, b)      ((void)(a), (void)(b))
#define Py_END_CRITICAL_SECTION2()            ((void)0)
#endif
