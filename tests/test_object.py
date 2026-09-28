# The exception and object-protocol C-API, one test per C function:
# tests/_capi_object.c makes each C call. pytest runs this file against
# CPython (tests/cpython.sh), the reference; tests/run.sh runs it against the
# bridge.
import io
import sys
import warnings

import _capi_object as o


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


def error(f, *args):
    """The exception f(*args) raises: (type name, str)."""
    try:
        f(*args)
    except BaseException as e:
        return type(e).__name__, str(e)
    return None


class C:
    x = 1

    def m(self, *args, **kw):
        return ('m', args, kw)


# ---- raising

def test_PyErr_SetString():
    assert error(o.set_string, KeyError, 'k') == ('KeyError', "'k'")
    assert error(o.set_string, ValueError, 'bad') == ('ValueError', 'bad')


def test_PyErr_SetNone():
    assert error(o.set_none, StopIteration) == ('StopIteration', '')


def test_PyErr_SetObject():
    assert error(o.set_object, KeyError, (1, 2)) == ('KeyError', '(1, 2)')
    assert error(o.set_object, ValueError, 'v') == ('ValueError', 'v')


def test_PyErr_Format():
    assert error(o.format, 'x', 3) == ('ValueError', 'bad x: 3')


def test_PyErr_NoMemory():
    assert raises(MemoryError, o.no_memory)


def test_PyErr_BadArgument():
    assert error(o.bad_argument) == ('TypeError', 'bad argument type for built-in operation')


def test_PyErr_BadInternalCall():
    assert raises(SystemError, o.bad_internal_call)


def test_PyErr_SetFromErrno():
    e = error(o.set_from_errno)
    assert e and e[0] == 'FileNotFoundError', e


# ---- the current exception

def test_PyErr_Occurred_ExceptionMatches():
    assert o.occurred_matches(KeyError, LookupError, ValueError) == (True, True, False)
    assert o.occurred_matches(KeyError, (ValueError, KeyError), IndexError) == (True, True, False)


def test_PyErr_GivenExceptionMatches():
    assert o.given_matches(KeyError, LookupError)
    assert o.given_matches(KeyError('k'), KeyError)
    assert not o.given_matches(KeyError, ValueError)


def test_PyErr_Clear():
    assert o.clear() is False


def test_PyErr_GetRaisedException():
    e = o.get_raised(KeyError, 'k')
    assert type(e) is KeyError and e.args == ('k',)


def test_PyErr_SetRaisedException():
    assert error(o.set_raised, ValueError('mine')) == ('ValueError', 'mine')


def test_PyErr_Fetch_Restore():
    assert error(o.fetch_restore, IndexError) == ('IndexError', 'fetched')


def test_PyErr_NormalizeException():
    t, v = o.normalize(KeyError)
    assert t is KeyError and type(v) is KeyError and v.args == ('raw',)


def test_PyErr_CheckSignals():
    assert o.check_signals() == 0


# ---- exception objects and types

def test_PyException_SetCause_SetContext():
    e, cause, ctx = ValueError('e'), KeyError('cause'), IndexError('ctx')
    o.set_cause_context(e, cause, ctx)
    assert e.__cause__ is cause and e.__context__ is ctx and e.__suppress_context__


def test_PyException_SetTraceback():
    try:
        raise KeyError('k')
    except KeyError as k:
        tb = k.__traceback__
    e = ValueError('e')
    o.set_traceback(e, tb)
    assert e.__traceback__ is tb
    assert raises(TypeError, o.set_traceback, e, 'not a traceback')


def test_PyErr_NewException():
    E = o.new_exception('mod.MyErr', None, None)
    assert E.__name__ == 'MyErr' and E.__module__ == 'mod'
    assert E.__mro__[1:] == (Exception, BaseException, object)
    F = o.new_exception('mod.F', KeyError, {'extra': 1})
    assert issubclass(F, KeyError) and F.extra == 1


def test_PyErr_NewExceptionWithDoc():
    D = o.new_exception_with_doc('mod.Doc', 'the doc', ValueError)
    assert D.__doc__ == 'the doc' and issubclass(D, ValueError)


# ---- warnings, unraisable, printing

def test_PyErr_WarnEx_WarnFormat():
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        o.warn_ex(UserWarning, 'careful')
        o.warn_format(DeprecationWarning, 7)
    assert [(x.category, str(x.message)) for x in w] == [
        (UserWarning, 'careful'), (DeprecationWarning, 'warned 7')]


def test_PyErr_WarnEx_as_error():
    with warnings.catch_warnings():
        warnings.simplefilter('error')
        assert error(o.warn_ex, UserWarning, 'careful') == ('UserWarning', 'careful')


def test_PyErr_WriteUnraisable_FormatUnraisable():
    seen = []
    hook, sys.unraisablehook = sys.unraisablehook, seen.append
    try:
        assert o.write_unraisable('OBJ') is False
        assert o.format_unraisable() is False
    finally:
        sys.unraisablehook = hook
    assert [(type(u.exc_value), str(u.exc_value)) for u in seen] == [
        (RuntimeError, 'unraisable'), (RuntimeError, 'unraisable')]
    assert seen[0].object == 'OBJ' and seen[1].err_msg == 'while testing 42'


def test_PyErr_Print():
    err, sys.stderr = sys.stderr, io.StringIO()
    try:
        still_set = o.print()
        out = sys.stderr.getvalue()
    finally:
        sys.stderr = err
    assert still_set is False and "KeyError: 'printed'" in out


# ---- attributes

def test_PyObject_GetAttr_GetAttrString():
    assert o.getattr(C(), 'x') == 1 and o.getattr_string(C(), 'x') == 1
    assert raises(AttributeError, o.getattr, C(), 'nope')
    assert raises(TypeError, o.getattr, C(), 1)


def test_PyObject_SetAttr_SetAttrString():
    c = C()
    o.setattr(c, 'y', 2)
    o.setattr_string(c, 'z', 3)
    assert (c.y, c.z) == (2, 3)
    o.setattr(c, 'y', None)          # a NULL value deletes
    assert not hasattr(c, 'y')
    assert raises(AttributeError, o.setattr_string, 1, 'real', 2)


def test_PyObject_HasAttrWithError_HasAttrString():
    assert o.hasattr(C(), 'x') == (True, True)
    assert o.hasattr(C(), 'nope') == (False, False)


def test_PyObject_GetOptionalAttr():
    assert o.get_optional_attr(C(), 'x') == (1, 1)
    assert o.get_optional_attr(C(), 'nope') == (0, None)


def test_PyObject_GenericGetAttr_SetAttr_GetDict():
    c = C()
    o.generic_setattr(c, 'g', 5)
    assert o.generic_getattr(c, 'g') == 5 and o.generic_getattr(c, 'x') == 1
    assert o.generic_get_dict(c) == {'g': 5}


def test_PyObject_Dir():
    assert 'm' in o.dir(C()) and 'x' in o.dir(C())


# ---- conversions, hashing, truth, comparison

def test_PyObject_Repr_Str():
    assert o.repr('a') == "'a'" and o.str('a') == 'a' and o.repr([1]) == '[1]'


def test_PyObject_Bytes():
    assert o.bytes([65]) == b'A' and o.bytes(b'x') == b'x'
    assert raises(TypeError, o.bytes, 'x')


def test_PyObject_Format():
    assert o.format_spec(3.14159, '.2f') == '3.14' and o.format_spec(5, '>3') == '  5'


def test_PyObject_Hash():
    assert o.hash(5) == 5 and o.hash('a') == hash('a')
    assert raises(TypeError, o.hash, [])


def test_PyObject_HashNotImplemented():
    assert raises(TypeError, o.hash_not_implemented, 1)


def test_PyObject_IsTrue_Not():
    assert o.truth([]) == (0, 1) and o.truth([0]) == (1, 0)


def test_PyObject_RichCompare_RichCompareBool():
    assert o.richcompare(1, 2, 0) == (True, 1)       # Py_LT
    assert o.richcompare(2, 2, 2) == (True, 1)       # Py_EQ
    assert o.richcompare('a', 'b', 4) == (False, 0)  # Py_GT
    assert raises(TypeError, o.richcompare, 1, 'a', 0)


def test_PyObject_IsInstance_IsSubclass():
    assert o.isinstance(True, int) and not o.isinstance(1, str)
    assert o.isinstance(1, (str, int))
    assert o.issubclass(bool, int) and not o.issubclass(int, bool)
    assert raises(TypeError, o.issubclass, 1, int)


def test_PyObject_Type():
    assert o.type(1.5) is float and o.type(C()) is C


# ---- size, items, iteration

def test_PyObject_Size():
    assert o.size([1, 2]) == 2 and o.size('abc') == 3 and o.size({1: 2}) == 1
    assert raises(TypeError, o.size, 5)


def test_PyObject_LengthHint():
    assert o.length_hint(iter([1, 2, 3]), 9) == 3
    assert o.length_hint((x for x in []), 9) == 9


def test_PyObject_GetItem_SetItem_DelItem():
    d = {'a': 1}
    assert o.getitem(d, 'a') == 1 and o.getitem([10, 20], 1) == 20
    o.setitem(d, 'b', 2)
    o.delitem(d, 'a')
    assert d == {'b': 2}
    assert raises(KeyError, o.getitem, d, 'zz')
    assert raises(TypeError, o.getitem, 5, 0)


def test_PyObject_GetIter_PyIter_Next():
    assert o.iterate([1, 2]) == [1, 2] and o.iterate('ab') == ['a', 'b']
    assert o.iterate(x * 2 for x in range(3)) == [0, 2, 4]
    assert raises(TypeError, o.iterate, 5)


def test_PyIter_Check_PyObject_SelfIter():
    assert o.iter_check(iter([])) and not o.iter_check([])
    assert o.self_iter(5) == 5


# ---- calling

def test_PyCallable_Check():
    assert o.callable_check(len) and o.callable_check(C) and not o.callable_check(1)


def test_PyObject_Call():
    assert o.call(C().m, (1, 2), {'k': 3}) == ('m', (1, 2), {'k': 3})
    assert o.call(C().m, (), None) == ('m', (), {})
    assert raises(TypeError, o.call, 1, (), None)


def test_PyObject_CallObject_CallNoArgs_CallOneArg():
    assert o.call_object(C().m, None) == ('m', (), {})
    assert o.call_object(C().m, (1,)) == ('m', (1,), {})
    assert o.call_no_args(list) == []
    assert o.call_one_arg(len, 'abc') == 3


def test_PyObject_CallFunction_CallFunctionObjArgs():
    assert o.call_function(lambda *a: a) == (1, 'two', None)
    assert o.call_function_obj_args(C().m, 'a', 'b') == ('m', ('a', 'b'), {})


def test_PyObject_CallMethod_variants():
    c = C()
    assert o.call_method(c, 'm') == ('m', (3,), {})
    assert o.call_method_obj_args(c, 'm', 7) == ('m', (7,), {})
    assert o.call_method_no_args(c, 'm') == ('m', (), {})
    assert o.call_method_one_arg(c, 'm', 8) == ('m', (8,), {})
    assert raises(AttributeError, o.call_method_no_args, c, 'nope')


def test_PyObject_Vectorcall():
    assert o.vectorcall(C().m, (1,), {'k': 2}) == ('m', (1,), {'k': 2})
    assert o.vectorcall(max, (3, 9, 4), {}) == 9


def test_PyObject_VectorcallDict():
    assert o.vectorcall_dict(C().m, (1,), {'k': 3}) == ('m', (1,), {'k': 3})
    assert o.vectorcall_dict(C().m, (), None) == ('m', (), {})


def test_PyObject_VectorcallMethod():
    assert o.vectorcall_method(C(), 'm', 5) == ('m', (5,), {})


# ---- odds and ends

def test_PyObject_AsFileDescriptor():
    assert o.as_file_descriptor(5) == 5
    assert raises(TypeError, o.as_file_descriptor, 'x')


def test_PyObject_GC_IsTracked():
    assert o.gc_is_tracked([]) and not o.gc_is_tracked(1)


def test_PyObject_Malloc_Free():
    assert o.malloc_free(3) == b'xxx'
