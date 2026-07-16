/* wasthon stub for pycore_initconfig.h — just the PyStatus surface
 * _datetimemodule.c's one-time state init returns. Single-threaded wasm:
 * a status is only ever inspected for "is it an error". */
#ifndef WASTHON_PYCORE_INITCONFIG_H
#define WASTHON_PYCORE_INITCONFIG_H

typedef struct {
    int _type;              /* 0 = OK, 1 = error, 2 = exit */
    const char *func;
    const char *err_msg;
    int exitcode;
} PyStatus;

#define _PyStatus_OK() \
    (PyStatus){0, NULL, NULL, 0}
#define _PyStatus_ERR(ERR_MSG) \
    (PyStatus){1, __func__, (ERR_MSG), 0}
#define _PyStatus_NO_MEMORY() \
    _PyStatus_ERR("memory allocation failed")
#define _PyStatus_EXCEPTION(status) \
    ((status)._type != 0)

#endif
