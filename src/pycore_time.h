/* wasthon stub for pycore_time.h — the time helpers _datetimemodule.c needs.
 * _PyTime_round_t/_PyTime_ROUND_FLOOR and the two bridge-backed functions
 * (_PyTime_ObjectToTime_t, _PyTime_localtime — JS-library: localtime must see
 * the BROWSER's timezone via Date, not musl's TZ-less UTC) come from
 * wasthon.h; this header adds the remaining rounding modes and the pure
 * numeric/UTC helpers implemented in wasthon.c. */
#ifndef WASTHON_PYCORE_TIME_H
#define WASTHON_PYCORE_TIME_H
#include <time.h>
#include "wasthon.h"

#define _PyTime_ROUND_CEILING   1
#define _PyTime_ROUND_HALF_EVEN 2
#define _PyTime_ROUND_UP        3
#define _PyTime_ROUND_TIMEOUT   _PyTime_ROUND_UP

PyObject *_PyLong_FromTime_t(time_t sec);
time_t    _PyLong_AsTime_t(PyObject *obj);
int       _PyTime_ObjectToTimeval(PyObject *obj, time_t *sec, long *usec,
                                  _PyTime_round_t round);
int       _PyTime_AsTimevalTime_t(PyTime_t t, time_t *secs, int *us,
                                  _PyTime_round_t round);
int       _PyTime_gmtime(time_t t, struct tm *tm);

#endif
