/* wasthon stub — weakref machinery not implemented (single-threaded WASM,
 * Brython handles GC). FT_CLEAR_WEAKREFS is a no-op. */
#ifndef WASTHON_PYCORE_WEAKREF_H
#define WASTHON_PYCORE_WEAKREF_H
#include "wasthon.h"
#define FT_CLEAR_WEAKREFS(op, weakreflist) ((void)(op))
#endif
