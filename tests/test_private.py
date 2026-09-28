# The private C-API (_Py*) CPython exports for its own extension modules and
# the bridge implements for them: tests/_capi_private.c makes each C call.
# pytest runs this file against CPython (tests/cpython.sh), the reference;
# tests/run.sh runs it against the bridge.
import sys

import _capi_private as p


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


def error(f, *args):
    try:
        f(*args)
    except BaseException as e:
        return type(e).__name__, str(e)
    return None


# ---- argument helpers

def test__PyArg_BadArgument():
    assert error(p.bad_argument, 'x') == ('TypeError', 'f() argument 1 must be int, not str')


def test__PyArg_NoKeywords_NoPositional():
    assert p.no_keywords({}) and p.no_keywords(None)
    assert error(p.no_keywords, {'a': 1}) == ('TypeError', 'f() takes no keyword arguments')
    assert p.no_positional(())
    assert error(p.no_positional, (1,)) == ('TypeError', 'f() takes no positional arguments')


def test__PyArg_CheckPositional():
    assert p.check_positional(2, 1, 3)
    assert error(p.check_positional, 5, 1, 3) == ('TypeError', 'f expected at most 3 arguments, got 5')
    assert error(p.check_positional, 0, 1, 3) == ('TypeError', 'f expected at least 1 argument, got 0')


def test__PyLong_UInt32_Converter():
    assert p.converter('uint32', 5) == 5
    assert raises(OverflowError, p.converter, 'uint32', 2**32)
    assert raises(ValueError, p.converter, 'uint32', -1)


def test__PyLong_UInt64_UnsignedLong_UnsignedLongLong_Converter():
    assert p.converter('uint64', 2**64 - 1) == 2**64 - 1
    assert p.converter('ulong', 7) == 7
    assert raises(ValueError, p.converter, 'ulonglong', -1)


def test__Py_convert_optional_to_ssize_t():
    assert p.converter('ssize', None) == -7 and p.converter('ssize', 5) == 5
    assert raises(TypeError, p.converter, 'ssize', 'x')


# ---- str, dict, set

def test__PyUnicode_Copy():
    assert p.unicode_copy('abc') == ('abc', True)


def test__PyUnicode_JoinArray():
    assert p.unicode_join_array('-', ('a', 'b')) == 'a-b'


def test__PyUnicode_AsUTF8NoNUL():
    assert p.unicode_as_utf8_no_nul('ab') == b'ab'
    assert raises(ValueError, p.unicode_as_utf8_no_nul, 'a\0b')


def test__PyUnicode_Equal_EqualToASCIIString():
    assert p.unicode_equal('abc', 'abc', 'abc') == (1, 1)
    assert p.unicode_equal('abc', 'abd', 'abd') == (0, 0)


def test__PyDict_SetItem_KnownHash_GetItem_KnownHash():
    d = {}
    assert p.dict_known_hash(d, 'k', 1) == 1 and d == {'k': 1}


def test__PySet_Update_NextEntryRef():
    assert sorted(p.set_update_walk({1}, [2, 3])) == [1, 2, 3]


# ---- types, objects, attribute lookup

def test__PyType_Name():
    assert p.type_name(int) == 'int' and p.type_name(type(len)) == 'builtin_function_or_method'


def test__PyType_Lookup_LookupRef():
    assert p.type_lookup(int, 'bit_length') == (int.bit_length, int.bit_length)
    assert p.type_lookup(int, 'nope') == (None, None)


def test__PyObject_MaybeCallSpecialNoArgs():
    class L:
        def __length_hint__(self):
            return 5
    assert p.maybe_call_special(L(), '__length_hint__') == 5
    assert p.maybe_call_special(L(), '__nope__') is Ellipsis


def test__PyObject_GetState():
    class S:
        pass
    s = S()
    s.a = 1
    assert p.get_state(s) == {'a': 1}


def test__PyNumber_Index():
    assert p.number_index(True) is True and p.number_index(3) == 3
    assert raises(TypeError, p.number_index, 1.5)


def test__PyEval_GetBuiltin():
    assert p.eval_builtin('len') is len


def test__PyEval_SliceIndexNotNone():
    assert p.slice_index(5) == 5
    assert raises(TypeError, p.slice_index, None)


def test__PySys_GetSizeOf():
    assert p.sys_sizeof('ab') == sys.getsizeof('ab')


def test__PySys_GetRequiredAttr():
    assert p.sys_required('maxsize') == sys.maxsize
    assert raises(RuntimeError, p.sys_required, 'nope')


# ---- int internals: (_PyLong_DivmodNear, _Frexp mantissa, exponent,
# _Lshift, _Rshift, _NumBits, _AsByteArray 4 bytes little-endian signed)

def test__PyLong_internals():
    assert p.long_internals(7, 2, 3) == ((4, -1), 0.875, 3, 56, 0, 3, b'\x07\x00\x00\x00')
    assert raises(OverflowError, p.long_internals, -2**70, 3, 5)


# ---- errors

def test__PyErr_FormatFromCause():
    try:
        p.format_from_cause()
    except ValueError as e:
        assert str(e) == 'wrapped 7'
        assert type(e.__cause__) is KeyError and e.__context__ is e.__cause__
    else:
        raise AssertionError('no exception')


def test__PyErr_FormatNote():
    try:
        p.format_note()
    except KeyError as e:
        assert e.__notes__ == ['note 3']
    else:
        raise AssertionError('no exception')


def test__PyErr_ChainExceptions1():
    try:
        p.chain_exceptions(KeyError('inner'))
    except KeyError as e:
        assert type(e.__context__) is ValueError and str(e.__context__) == 'outer'
    else:
        raise AssertionError('no exception')


# ---- bytes, hex, memory, time, hashes, random

def test__PyBytes_Repeat():
    assert p.bytes_repeat(b'ab', 3) == b'ababab'


def test__Py_strhex_strhex_bytes_with_sep():
    assert p.strhex(b'\x01\xff\x10', ':', 1) == ('01ff10', b'01:ff:10')
    assert p.strhex(b'\x01\xff\x10', b'-', 2) == ('01ff10', b'01-ff10')


def test__PyMem_Strdup():
    assert p.mem_strdup('xyz') == ('xyz', True)


def test__PyTime_ObjectToTime_t_localtime():
    day = 86400
    assert p.time_convert(2.5 * day + 0.7, 0) == (2 * day + day // 2, 1970)   # floor
    assert p.time_convert(2.5 * day + 0.7, 1) == (2 * day + day // 2 + 1, 1970)  # ceiling
    assert raises(TypeError, p.time_convert, 'x', 0)


def test__Py_HashDouble():
    assert p.hash_double(1.5) == hash(1.5) and p.hash_double(3.0) == 3


def test__PyOS_URandomNonblock():
    assert len(p.urandom(8)) == 8


def test__Py_hashtable():
    assert p.hashtable() == [10, 20, 30, 0]
