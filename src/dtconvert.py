# _datetimemodule.c CPython -> wasthon: mechanical preparation at copy time.
# 1. datetime.h -> datetime_real.h (the REAL packed-struct header; wasthon's
#    datetime.h routes field macros through bridged attribute reads, which is
#    for CONSUMERS without the C module).
# 2. positional PyTypeObject initializers -> designated (via the canonical
#    /* tp_xxx */ comments; wasthon's struct _typeobject field ORDER differs).
# 3. inject _PyDateTime_InitTypes (CPython runs it at interp init) and the
#    Py_SET_TYPE registration of the two static singletons (our PyObject has
#    no ob_type field; the bridge's _cType side-table serves Py_TYPE).
import re, sys
src_path, out_path = sys.argv[1], sys.argv[2]
src = open(src_path).read()
src = src.replace('#include "datetime.h"', '#include "datetime_real.h"')

anchor = '    /* We actually set the "current" module right before a successful return. */'
assert src.count(anchor) == 1
src = src.replace(anchor, anchor + '''

    /* wasthon: ready the static types now (CPython does this at interp
       init), then register the static singletons with the bridge: their
       ob_type lives inside the struct in CPython, but wasthon's PyObject
       has no ob_type field (the type lives JS-side). */
    Py_SET_TYPE((PyObject *)&zero_delta, &PyDateTime_DeltaType);
    Py_SET_TYPE((PyObject *)&utc_timezone, &PyDateTime_TimeZoneType);
    if (_PyStatus_EXCEPTION(_PyDateTime_InitTypes(NULL))) {
        goto error;
    }''')

out, pos, converted = [], 0, 0
pat = re.compile(r'static PyTypeObject (\w+) = \{')
while True:
    m = pat.search(src, pos)
    if not m:
        out.append(src[pos:])
        break
    end = src.index('\n};', m.end())
    body = src[m.end():end]
    newlines = []
    for ln in body.split('\n'):
        m2 = re.match(r'^(\s*)(.*?),?\s*/\* (tp_\w+) \*/\s*$', ln)
        if m2 and m2.group(2).strip():
            indent, expr, field = m2.groups()
            newlines.append('%s.%s = %s,' % (indent, field, expr.rstrip(',').strip()))
            converted += 1
        else:
            newlines.append(ln)
    out.append(src[pos:m.end()])
    out.append('\n'.join(newlines))
    pos = end
open(out_path, 'w').write(''.join(out))
assert converted == 227, converted
print('converted:', converted)
