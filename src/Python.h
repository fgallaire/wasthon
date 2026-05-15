/*
 * Python.h — wasthon's drop-in for CPython's main public header.
 *
 * sha2module.c (and other ported CPython extension modules) include
 * `<Python.h>` first; with `-I /path/to/wasthon/src` ahead of the
 * CPython include path, this file is found first and pulls in our
 * wasthon.h instead.
 */
#ifndef WASTHON_PYTHON_H
#define WASTHON_PYTHON_H
#include "wasthon.h"
#endif
