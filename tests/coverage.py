# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# Which C-API functions of src/wasthon.js the tests call, from the coverage V8
# writes when NODE_V8_COVERAGE is set (tests/coverage.sh). emcc copies into
# build/_bridgetest.mjs only the functions the linked C refers to, so the list
# of functions comes from src/wasthon.js itself: one never called counts as
# uncovered, whether it was linked or not.
#
#   coverage.py DIR WASTHON_JS            the functions called, by family
#   coverage.py DIR WASTHON_JS NAME...    and the blocks of NAME never run
import collections
import glob
import json
import re
import sys

cov_dir, wasthon_js, wanted = sys.argv[1], sys.argv[2], sys.argv[3:]
src = open(wasthon_js).read()
api = [m.group(1) for m in
       re.finditer(r'^    ([A-Za-z_][A-Za-z0-9_]*)\s*:\s*function\b', src, re.M)]
emitted = {'_' + name: name for name in api}   # emcc prefixes C symbols with _

called = {}                                     # name -> its V8 coverage entry
script = ''
for path in glob.glob(cov_dir + '/*.json'):
    for s in json.load(open(path))['result']:
        if not s['url'].endswith('/_bridgetest.mjs'):
            continue
        script = open(s['url'].removeprefix('file://')).read()
        for fn in s['functions']:
            name = emitted.get(fn['functionName'])
            if name and fn['ranges'][0]['count'] > 0:
                called[name] = fn


def family(name):
    m = re.match(r'_*(Py[A-Z][a-z]*|[a-z]+)', name)
    return m.group(1) if m else name


total, hit = collections.Counter(map(family, api)), collections.Counter(map(family, called))
print(f'{len(called)}/{len(api)} C-API functions called '
      f'({100 * len(called) / len(api):.1f} %)')
for fam, n in total.most_common():
    print(f'  {fam:16s} {hit[fam]:4d}/{n}')

for name in wanted:
    fn = called.get(name)
    if fn is None:
        print(f'\n{name}: never called')
        continue
    # V8 lists, after the function's own range, the blocks whose count
    # differs from the enclosing one: count 0 is a block the tests never ran.
    unrun = [r for r in fn['ranges'][1:] if r['count'] == 0]
    print(f'\n{name}: {len(unrun)} blocks never run')
    for r in unrun:
        text = ' '.join(script[r['startOffset']:r['endOffset']].split())
        print('  ' + (text if len(text) <= 110 else text[:107] + '...'))
