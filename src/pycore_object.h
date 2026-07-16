/* pycore_object.h — Wasthon stub. Real CPython contents are not needed; the
 * bridge supplies the symbols inline. */
#ifndef WASTHON_PYCORE_OBJECT_H
#define WASTHON_PYCORE_OBJECT_H
#include "wasthon.h"

/* _datetimemodule.c (static types): the type dict is at tp_dict (offset 8,
 * wired by the bridge's PyType_Ready), and "init a static type for an
 * extension" is exactly PyType_Ready under the bridge (interp ignored —
 * single-interpreter wasm). _PyObject_Init is already in wasthon.h. */
static inline PyObject *_PyType_GetDict(PyTypeObject *type) {
    return type->tp_dict;
}
static inline int _PyStaticType_InitForExtension(void *interp, PyTypeObject *type) {
    (void)interp;
    return PyType_Ready(type);
}
#endif
