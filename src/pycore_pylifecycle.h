/* wasthon stub for pycore_pylifecycle.h — _PyOS_URandom* used by _random
 * to seed the Mersenne Twister. In browser context we use the WebCrypto
 * RNG via crypto.getRandomValues which is non-blocking. */
#ifndef WASTHON_PYCORE_PYLIFECYCLE_H
#define WASTHON_PYCORE_PYLIFECYCLE_H
#include "wasthon.h"
int _PyOS_URandom(void *buffer, Py_ssize_t size);
int _PyOS_URandomNonblock(void *buffer, Py_ssize_t size);
#endif
