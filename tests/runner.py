# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# Runs a test_*.py file's pytest-style functions on the bridge, in Node
# (tests/run.mjs) and in the browser (loader/test-bridge.html), which append
# this file to the test file's source after three names: _FILE, its name;
# _LINES, its lines; _KNOWN, the cases of tests/bridge_bugs.txt. Each test_*
# runs in definition order, once per value its module's pytest_generate_tests
# gives to metafunc.parametrize, and prints PASS, BUG (a known bridge bug) or
# FAIL.
class _Metafunc:
    def __init__(self, f):
        self.fixturenames = f.__code__.co_varnames[:f.__code__.co_argcount]
        self.cases = [] if self.fixturenames else [('', {})]
    def parametrize(self, name, values, ids):
        self.cases += [(f'[{i}]', {name: v}) for v, i in zip(values, ids)]

def _run_tests():
    for name, f in list(globals().items()):
        if not (name.startswith('test_') and callable(f)):
            continue
        meta = _Metafunc(f)
        if meta.fixturenames:
            pytest_generate_tests(meta)
        for suffix, kwargs in meta.cases:
            case = f'{_FILE}::{name}{suffix}'
            try:
                f(**kwargs)
                print('PASS', case)
            except BaseException as e:
                # the failing line of the test, as pytest shows it
                import traceback
                frames = [t for t in traceback.extract_tb(e.__traceback__) if t.name == name]
                where = f' @ line {frames[-1].lineno}: {_LINES[frames[-1].lineno - 1].strip()}' if frames else ''
                print('BUG' if case in _KNOWN else 'FAIL', case, '-', type(e).__name__, e, where)
                (bt_bug if case in _KNOWN else bt_fail)()
_run_tests()
