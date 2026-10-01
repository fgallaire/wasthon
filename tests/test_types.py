# Types built by the two paths of the bridge: tests/_capi.c defines each type
# once by PyType_FromSpec and once as a static PyTypeObject + PyType_Ready,
# from the same C functions, and every test runs on both.
# pytest runs this file against CPython (tests/cpython.sh), the reference;
# tests/run.sh runs it against the bridge.
import operator

import _capi

PARAMS = {
    'T': [_capi.SpecObj, _capi.StaticObj],
    'S': [_capi.SubSpec, _capi.SubStatic],        # C subclasses of each
    'F': [_capi.FinalSpec, _capi.FinalStatic],    # no Py_TPFLAGS_BASETYPE
}


def pytest_generate_tests(metafunc):
    for name, values in PARAMS.items():
        if name in metafunc.fixturenames:
            metafunc.parametrize(name, values, ids=[v.__name__ for v in values])


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


def test_new_and_init(T):
    assert T().value == 0
    assert T(3).value == 3
    assert T(value=4).value == 4
    assert raises(TypeError, T, 'x')


def test_names_and_doc(T):
    name = 'SpecObj' if T is _capi.SpecObj else 'StaticObj'
    assert T.__name__ == name
    assert T.__qualname__ == name
    assert T.__module__ == '_capi'
    assert T.__doc__ == "Obj(value=0): the bridge's test object"


def test_heaptype_flag(T):
    assert _capi.is_heaptype(T) == (T is _capi.SpecObj)


def test_repr_and_str(T):
    assert repr(T(3)) == f'_capi.{T.__name__}(3)'
    assert str(T(3)) == 'value=3'


def test_hash(T):
    assert hash(T(5)) == 5
    assert hash(T(-1)) == -2


def test_richcompare(T):
    assert T(2) < T(3) and T(3) >= T(3) and T(2) != T(3)
    assert T(2) == 2 and 3 > T(2)
    assert [o.value for o in sorted([T(3), T(1), T(2)])] == [1, 2, 3]


def test_iter(T):
    o = T(3)
    assert iter(o) is o
    assert list(T(3)) == [0, 1, 2]


def test_call(T):
    assert T(5)(2) == 7


def test_getset(T):
    o = T(1)
    o.value = 6
    assert o.value == 6 and o.doubled == 12
    assert raises(TypeError, setattr, o, 'value', 'x')
    assert raises(TypeError, delattr, o, 'value')
    assert raises(AttributeError, setattr, o, 'doubled', 1)


def test_members(T):
    o = T(2)
    assert raises(AttributeError, getattr, o, 'tag')
    o.tag = 'x'
    assert o.tag == 'x'
    list(o)
    assert o.pos == 2
    assert raises(AttributeError, setattr, o, 'pos', 0)


def test_methods(T):
    o = T(2)
    assert o.get() == 2
    assert o.add(3).value == 5
    assert o.total(1, 2, 3) == 8
    assert o.scaled(3) == 6 and o.scaled(3, offset=1) == 7
    assert o.count(1, 2, 3) == 3
    assert type(T.make(7)) is T and T.make(7).value == 7
    assert T.twice(4) == 8 and o.twice(4) == 8


def test_add_subtract(T):
    assert (T(2) + 3).value == 5 and (3 + T(2)).value == 5
    assert (T(5) - 2).value == 3 and (5 - T(2)).value == 3


def test_multiply(T):
    assert (T(2) * 3).value == 6
    assert (T(2) * T(4)).value == 8


def test_unary(T):
    assert (-T(2)).value == -2
    assert (+T(2)).value == 2
    assert not T(0) and T(1)


def test_index_int_float(T):
    assert [10, 20, 30][T(1)] == 20 and operator.index(T(4)) == 4
    assert int(T(4)) == 4 and float(T(4)) == 4.0


def test_inplace_add(T):
    o = p = T(1)
    o += 3
    assert o is p and p.value == 4


def test_sequence(T):
    o = T(3)
    assert len(o) == 3
    assert o[1] == 10
    assert o[-1] == 20
    assert raises(IndexError, operator.getitem, o, 5)
    assert 2 in o and 5 not in o


def test_python_subclass(T):
    class P(T):
        def triple(self):
            return 3 * self.value
    p = P(2)
    assert isinstance(p, T) and p.triple() == 6
    assert p.get() == 2 and len(p) == 2
    assert type(p + 1) is P
    assert repr(p) == 'P(2)'


def test_python_subclass_overrides_a_slot(T):
    class Q(T):
        def __add__(self, other):
            return 'Q.__add__'
    assert Q(1) + 1 == 'Q.__add__'
    assert (Q(1) - 1).value == 0


def test_c_subclass(S):
    assert issubclass(S, S.__base__) and S.__base__ in (_capi.SpecObj, _capi.StaticObj)
    s = S(3)
    assert s.extra() == 300 and s.get() == 3
    assert type(s + 1) is S
    assert repr(S(2)) == f'_capi.{S.__name__}(2)'


def test_final_type_cannot_be_subclassed(F):
    assert type(F()) is F
    assert raises(TypeError, type, 'P', (F,), {})


def test_immutable_type():
    assert raises(TypeError, setattr, _capi.ImmutableSpec, 'x', 1)


def test_uninstantiable_type():
    assert raises(TypeError, _capi.UninstantiableSpec)


def test_tp_iter_raises():
    assert raises(ValueError, iter, _capi.RaisingIterStatic())


def test_sequence_flag():
    match _capi.SequenceStatic(3):
        case [a, b, c]:
            assert (a, b, c) == (0, 10, 20)
        case _:
            assert False, 'not matched as a sequence'


def test_dealloc_from_c(T):
    d0 = _capi.deallocs()
    _capi.alloc_drop(T)
    assert _capi.deallocs() == d0 + 1


# ---- the rest of the type and allocation API

def test_PyType_GetSlot(T):
    assert _capi.get_slot(T) == (True, True)


def test_PyType_GetModuleByDef():
    assert _capi.module_by_def(_capi.SubSpec)
    assert raises(TypeError, _capi.module_by_def, _capi.SpecObj)


def test_PyType_GenericNew_GenericAlloc(T):
    assert type(_capi.generic_new(T)) is T and _capi.generic_new(T).value == 0
    assert type(_capi.generic_alloc(T)) is T


def test_PyType_Modified(T):
    assert _capi.modified(T) is None


def test_PyType_Freeze():
    assert _capi.freeze()


def test_PyType_FromMetaclass():
    M = _capi.from_metaclass(_capi.SpecObj)
    assert M.__name__ == 'SubSpec' and M.__base__ is _capi.SpecObj


def test_PyObject_New_Del_Malloc_Init(T):
    ok, o = _capi.object_new_init(T)
    assert ok and type(o) is T and o.value == 9


def test_PyObject_GenericHash():
    class W:
        pass
    w = W()
    assert _capi.generic_hash(w) == object.__hash__(w)


def test_PySeqIter_New():
    class S:
        def __getitem__(self, i):
            if i < 3:
                return i * 10
            raise IndexError
    assert list(_capi.seq_iter(S())) == [0, 10, 20]


def test_PyDescr_NewGetSet(T):
    assert _capi.descr_getset(T, T(2)) == 6


def test_PyDescr_NewClassMethod(T):
    assert _capi.descr_classmethod(T) == T.__name__


def test_PyErr_WarnExplicit():
    import warnings
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        _capi.warn_explicit()
    assert [(x.category, str(x.message), x.filename, x.lineno) for x in w] == [
        (UserWarning, 'explicit', 'somefile.py', 12)]


def test_PyObject_Print():
    assert _capi.object_print('a', 0) == "'a'"      # repr
    assert _capi.object_print('a', 1) == 'a'        # Py_PRINT_RAW: str


def test_PyErr_PrintEx():
    import io
    import sys
    err, sys.stderr = sys.stderr, io.StringIO()
    try:
        still_set = _capi.print_ex()
        out = sys.stderr.getvalue()
    finally:
        sys.stderr = err
    assert still_set is False and "KeyError: 'printed'" in out
