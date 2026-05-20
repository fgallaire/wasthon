/* wasthon stub — single-threaded WASM. The PyThread_type_lock type and
 * PyThread_* lock primitives are already declared in wasthon.h (locks are
 * no-ops). Some stdlib headers (e.g. _sqlite's connection.h) #include
 * "pythread.h" directly, so redirect it here. */
#ifndef WASTHON_PYTHREAD_H
#define WASTHON_PYTHREAD_H
#include "wasthon.h"
#endif
