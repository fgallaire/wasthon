/* wasthon stub for pycore_typeobject.h — _PyType_GetModuleState is in wasthon.h. */
#ifndef WASTHON_PYCORE_TYPEOBJECT_H
#define WASTHON_PYCORE_TYPEOBJECT_H
#include "wasthon.h"

/* _datetimemodule.c (static types): the type dict is at tp_dict (offset 8,
 * wired by the bridge's PyType_Ready), and "init a static type for an
 * extension" is exactly PyType_Ready under the bridge (interp ignored —
 * single-interpreter wasm). */
static inline PyObject *_PyType_GetDict(PyTypeObject *type) {
    return type->tp_dict;
}
static inline int _PyStaticType_InitForExtension(void *interp, PyTypeObject *type) {
    (void)interp;
    return PyType_Ready(type);
}
#endif
