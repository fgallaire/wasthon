/* wasthon stub for pycore_ucnhash.h. Used by unicodedata to expose its
 * name<->codepoint table via a Capsule for `\N{...}` regex support. */
#ifndef WASTHON_PYCORE_UCNHASH_H
#define WASTHON_PYCORE_UCNHASH_H
#include "wasthon.h"

typedef struct {
    int (*getname)(Py_UCS4 code, char *buffer, int buflen, int with_alias_and_seq);
    int (*getcode)(const char *name, int namelen, Py_UCS4 *code, int with_named_seq);
} _PyUnicode_Name_CAPI;

#endif
