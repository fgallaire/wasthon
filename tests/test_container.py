# The list, tuple, dict, set, sequence, mapping, slice, bytearray and
# memoryview C-API, one test per C function: tests/_capi_container.c makes
# each C call. pytest runs this file against CPython (tests/cpython.sh), the
# reference; tests/run.sh runs it against the bridge.
import operator

import _capi_container as c


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


# ---- list

def test_PyList_New_SetItem_Append_Insert():
    assert c.list_build(1, 2, 3, 0) == [0, 1, 2, 3]


def test_PyList_GetItem():
    assert c.list_get_item([1, 2], 1) == 2
    assert raises(IndexError, c.list_get_item, [1], 5)


def test_PyList_Size():
    assert c.list_size([1, 2, 3]) == 3
    assert raises(SystemError, c.list_size, (1,))


def test_PyList_Sort():
    assert c.list_sort([3, 1, 2]) == [1, 2, 3]


def test_PyList_SetSlice():
    assert c.list_set_slice([1, 2, 3, 4], 1, 3, ['x']) == [1, 'x', 4]
    assert c.list_set_slice([1, 2, 3], 0, 2, None) == [3]


def test_PyList_AsTuple_CheckExact():
    assert c.list_as_tuple([1, 2]) == (1, 2)
    class L(list):
        pass
    assert c.list_check_exact([]) and not c.list_check_exact(L())


# ---- tuple

def test_PyTuple_New_SetItem():
    assert c.tuple_build('a', 1) == ('a', 1)


def test_PyTuple_Pack():
    assert c.tuple_pack(1, 'b', None) == (1, 'b', None)


def test_PyTuple_GetItem():
    assert c.tuple_get_item((1, 2), 0) == 1
    assert raises(IndexError, c.tuple_get_item, (1,), 3)


def test_PyTuple_Size_GET_SIZE():
    assert c.tuple_size((1, 2)) == (2, 2)
    assert raises(SystemError, c.tuple_size, [1])


def test_PyTuple_GetSlice_CheckExact():
    assert c.tuple_get_slice((1, 2, 3, 4), 1, 3) == (2, 3)
    assert c.tuple_check_exact(()) and not c.tuple_check_exact([])


# ---- dict

def test_PyDict_New_SetItem_SetItemString():
    assert c.dict_build('k', 1) == {'k': 1, 's': 1}


def test_PyDict_GetItem_WithError_String():
    d = {'k': 1, 's': 2}
    assert c.dict_get(d, 'k') == (1, 1, 1)
    assert c.dict_get(d, 'zz') == (None, None, None)
    assert c.dict_get({5: 'five'}, 5) == ('five', 'five', None)


def test_PyDict_GetItemRef_GetItemStringRef():
    d = {'k': 1, 's': 2}
    assert c.dict_get_ref(d, 'k', 's') == (1, 1, 1, 2)
    assert c.dict_get_ref(d, 'z', 'zz') == (0, None, 0, None)
    assert raises(TypeError, c.dict_get_ref, d, [], 's')


def test_PyDict_Contains_ContainsString():
    assert c.dict_contains({'s': 1}, 's') == (1, 1)
    assert c.dict_contains({'s': 1}, 'x') == (0, 0)
    assert raises(TypeError, c.dict_contains, {}, [])


def test_PyDict_DelItem_DelItemString():
    assert c.dict_del({'a': 1, 'b': 2, 'c': 3}, 'a', 'b') == {'c': 3}
    assert raises(KeyError, c.dict_del, {}, 'a', 'b')


def test_PyDict_Size_Keys_Values_PyMapping_Items():
    assert c.dict_views({'a': 1, 'b': 2}) == (2, 2, ['a', 'b'], [1, 2], [('a', 1), ('b', 2)])


def test_PyDict_Clear():
    assert c.dict_clear({'a': 1}) == {}


def test_PyDict_Copy():
    d = {'a': [1]}
    e = c.dict_copy(d)
    assert e == d and e is not d and e['a'] is d['a']


def test_PyDict_Update():
    assert c.dict_update({'a': 1}, {'a': 2, 'b': 3}) == {'a': 2, 'b': 3}


def test_PyDict_Merge():
    assert c.dict_merge({'a': 1}, {'a': 2, 'b': 3}, 0) == {'a': 1, 'b': 3}
    assert c.dict_merge({'a': 1}, {'a': 2}, 1) == {'a': 2}


def test_PyDict_Next():
    assert c.dict_next({'a': 1, 'b': 2}) == [('a', 1), ('b', 2)]
    assert c.dict_next({}) == []


def test_PyDict_Pop():
    assert c.dict_pop({'a': 1}, 'a') == (1, 1)
    assert c.dict_pop({}, 'a') == (0, None)


def test_PyDict_SetDefaultRef():
    assert c.dict_setdefault({'a': 1}, 'a', 5) == (1, 1)
    assert c.dict_setdefault({}, 'a', 5) == (0, 5)


def test_PyDict_Check_CheckExact():
    class D(dict):
        pass
    assert c.dict_check({}) == (True, True) and c.dict_check(D()) == (True, False)
    assert c.dict_check([]) == (False, False)


def test_PyDictProxy_New():
    p = c.dictproxy_new({'a': 1})
    assert p['a'] == 1 and type(p).__name__ == 'mappingproxy'
    assert raises(TypeError, operator.setitem, p, 'b', 2)


# ---- set

def test_PySet_New_PyFrozenSet_New():
    assert c.set_new([1, 1, 2]) == {1, 2} and type(c.set_new(None)) is set
    assert c.frozenset_new([1]) == frozenset([1]) and c.frozenset_new(None) == frozenset()


def test_PySet_Add_Discard_Size_Contains():
    assert c.set_ops({1, 2}, 3, 2) == ({1, 3}, 2, 2, 1, True)
    assert c.set_ops({1}, 1, 9) == ({1}, 1, 1, 1, False)
    assert raises(TypeError, c.set_ops, {1}, [], 1)


def test_PySet_Pop():
    assert c.set_pop({7}) == 7
    assert raises(KeyError, c.set_pop, set())


def test_PySet_Check():
    assert c.set_check(set()) and not c.set_check([])


# ---- sequence protocol

def test_PySequence_Check_PyMapping_Check():
    assert c.seq_check([]) == (True, True) and c.seq_check({}) == (False, True)
    assert c.seq_check(5) == (False, False)


def test_PySequence_Size():
    assert c.seq_size('abc') == 3 and c.seq_size((1,)) == 1
    assert raises(TypeError, c.seq_size, 5)


def test_PySequence_GetItem():
    assert c.seq_get_item((1, 2, 3), -1) == 3 and c.seq_get_item('abc', 1) == 'b'
    assert raises(IndexError, c.seq_get_item, [], 0)


def test_PySequence_GetSlice():
    assert c.seq_get_slice([1, 2, 3, 4], 1, 3) == [2, 3] and c.seq_get_slice('abcd', 0, 2) == 'ab'


def test_PySequence_DelItem():
    assert c.seq_del_item([1, 2, 3], -1) == [1, 2]
    assert raises(TypeError, c.seq_del_item, (1, 2), 0)


def test_PySequence_Contains():
    assert c.seq_contains([1, 2], 2) and not c.seq_contains('abc', 'z')


def test_PySequence_Concat_Repeat():
    assert c.seq_concat([1], [2]) == [1, 2] and c.seq_concat('a', 'b') == 'ab'
    assert c.seq_repeat((1,), 3) == (1, 1, 1)
    assert raises(TypeError, c.seq_concat, [1], (2,))


def test_PySequence_InPlaceConcat_InPlaceRepeat():
    assert c.seq_inplace_concat([1], [2]) == ([1, 2], True)
    assert c.seq_inplace_concat((1,), (2,)) == ((1, 2), False)
    assert c.seq_inplace_repeat([1], 3) == ([1, 1, 1], True)


def test_PySequence_List_Tuple():
    assert c.seq_list((1, 2)) == [1, 2] and c.seq_tuple([1, 2]) == (1, 2)
    assert c.seq_tuple('ab') == ('a', 'b')
    assert raises(TypeError, c.seq_list, 5)


def test_PySequence_Fast():
    assert c.seq_fast((1, 2)) == (2, [1, 2], [1, 2])
    assert c.seq_fast(x for x in 'ab') == (2, ['a', 'b'], ['a', 'b'])
    assert raises(TypeError, c.seq_fast, 5)


# ---- mapping protocol

def test_PyMapping_GetItemString():
    assert c.mapping_get_item_string({'a': 1}, 'a') == 1
    assert raises(KeyError, c.mapping_get_item_string, {}, 'a')


def test_PyMapping_GetOptionalItem_GetOptionalItemString():
    assert c.mapping_get_optional({'a': 1}, 'a') == (1, 1, 1, 1)
    assert c.mapping_get_optional({}, 'a') == (0, None, 0, None)


# ---- slice

def test_PySlice_New_Check():
    s = c.slice_new(1, None, 2)
    assert s == slice(1, None, 2) and c.slice_check(s) and not c.slice_check(1)


def test_PySlice_GetIndicesEx():
    assert c.slice_indices_ex(slice(None, None, -1), 5) == (4, -1, -1, 5)
    assert c.slice_indices_ex(slice(1, 10, 2), 5) == (1, 5, 2, 2)
    assert raises(ValueError, c.slice_indices_ex, slice(0, 10, 0), 5)


def test_PySlice_Unpack_AdjustIndices():
    assert c.slice_unpack_adjust(slice(-3, None), 5) == (2, 5, 1, 3)


# ---- bytearray, memoryview

def test_PyByteArray_FromStringAndSize():
    b = c.bytearray_from(b'a\0b')
    assert b == bytearray(b'a\0b') and type(b) is bytearray


def test_PyByteArray_Check_CheckExact_Size_AsString():
    assert c.bytearray_access(bytearray(b'ab')) == (1, 1, 2, b'ab')
    assert c.bytearray_access(b'ab') == (0, 0, None, None)


def test_PyMemoryView_FromMemory():
    assert c.memoryview_from_memory(0x100) == (b'abcdef', 1)     # PyBUF_READ
    assert c.memoryview_from_memory(0x200) == (b'abcdef', 0)     # PyBUF_WRITE


def test_PyMemoryView_FromObject():
    assert c.memoryview_from_object(b'xy') == (b'xy', True)
    assert raises(TypeError, c.memoryview_from_object, 1)
