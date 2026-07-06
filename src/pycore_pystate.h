/*
 * pycore_pystate.h — wasthon stub
 *
 * Single-threaded WASM: there is one "thread state" and one per-state dict.
 * Modules use this to stash per-call-stack state (e.g. _decimal contexts).
 * We model it as a single singleton state with a dict allocated lazily.
 */
#ifndef WASTHON_PYCORE_PYSTATE_H
#define WASTHON_PYCORE_PYSTATE_H

#include "wasthon.h"

#ifdef __cplusplus
extern "C" {
#endif

/* struct _ts body lives in wasthon.h (numpy reads tstate->interp). */

/* Implemented JS-side in wasthon.js — returns the singleton tstate handle. */
extern PyThreadState *_PyThreadState_GET(void);
extern PyObject *_PyThreadState_GetDict(PyThreadState *ts);
extern PyObject *PyThreadState_GetDict(void);

/* PyInterpreterState declared in wasthon.h (single-runtime stub). */

#ifdef __cplusplus
}
#endif

#endif
