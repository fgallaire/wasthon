# The two lifetime mechanisms of the bridge, each proved A/B: switched on,
# the table stays flat; switched off, it climbs by the amount the mechanism
# is there to reclaim. (Formerly loader/test-tp-dealloc.html and
# loader/test-scopes.html, which needed a stdlib module to run.)
# bt_* are the runner's builtins (tests/run.mjs).
import _bridgetest

ITERS = 2000
handles, refcounts = bt_handles, bt_refcounts


def check(name, ok, detail):
    print(('PASS ' if ok else 'FAIL ') + name + ' — ' + detail)
    if not ok:
        bt_fail()


# tp_dealloc: a helper object created and dropped from C, once per call.
def dealloc_phase(no_free):
    bt_set_nofree(no_free)
    for _ in range(200):
        _bridgetest.make_drop()
    r0, d0 = refcounts(), _bridgetest.deallocs()
    for _ in range(ITERS):
        _bridgetest.make_drop()
    return refcounts() - r0, _bridgetest.deallocs() - d0

a, a_freed = dealloc_phase(False)
b, b_freed = dealloc_phase(True)
bt_set_nofree(False)
check('tp_dealloc runs when the refcount reaches 0',
      a < ITERS * 0.01 and a_freed == ITERS,
      f'refcounts +{a} over {ITERS} calls, {a_freed} deallocs')
check('without it, one instance leaks per call',
      b > ITERS * 0.5 and b_freed == 0,
      f'refcounts +{b}, {b_freed} deallocs')


# Handle scopes: a C call that wraps tens of objects into temporary handles.
graph = [1, 'hello', {'a': 1, 'b': 2}, (1, 2, 3), b'bytes',
         {'nested': [(i, str(i)) for i in range(10)]}]

def scope_phase(no_scopes):
    bt_set_noscopes(no_scopes)
    for _ in range(100):
        _bridgetest.walk(graph)
    h0 = handles()
    for _ in range(ITERS):
        _bridgetest.walk(graph)
    return handles() - h0

a = scope_phase(False)
b = scope_phase(True)
bt_set_noscopes(False)
check('handle scopes keep the handle table flat',
      a < ITERS * 0.05, f'handles +{a} over {ITERS} calls')
check('without them, every call leaves its temporaries behind',
      b > ITERS * 2, f'handles +{b} (+{b / ITERS:.1f}/call)')
