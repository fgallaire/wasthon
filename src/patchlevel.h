/* patchlevel.h — wasthon: version macros for CPython-header compatibility.
 * numpy's vendored pythoncapi-compat (and other ecosystem headers) gate on
 * PY_VERSION_HEX; without it they fall back to Python-2-era code paths. */
#ifndef WASTHON_PATCHLEVEL_H
#define WASTHON_PATCHLEVEL_H
#define PY_MAJOR_VERSION        3
#define PY_MINOR_VERSION        14
#define PY_MICRO_VERSION        4
#define PY_RELEASE_LEVEL        0xF
#define PY_RELEASE_SERIAL       0
#define PY_VERSION              "3.14.4"
#define PY_VERSION_HEX  ((PY_MAJOR_VERSION << 24) | (PY_MINOR_VERSION << 16) | \
                         (PY_MICRO_VERSION << 8) | (PY_RELEASE_LEVEL << 4) |   \
                         (PY_RELEASE_SERIAL << 0))
#endif
