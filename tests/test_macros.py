# The C-API C code reaches through macros and type structs rather than named
# functions: tests/_capi_macros.c makes each C call. pytest runs this file
# against CPython (tests/cpython.sh), the reference; tests/run.sh runs it
# against the bridge.
import _capi_macros as x
import _capi_number

# Py_hash_t is a Py_ssize_t: 32 bits on wasm32, where Brython's hash() is
# wider (CPython's never is). A hash as C holds it:
HASH_BITS = 8 * _capi_number.sizes()['ssize_t']


def c_hash(o):
    h = hash(o) & (2 ** HASH_BITS - 1)
    h = h - 2 ** HASH_BITS if h >= 2 ** (HASH_BITS - 1) else h
    return -2 if h == -1 else h


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


# ---- slots of the builtin types, called from C

def test_PyLong_Type_number_slots():
    assert x.long_slots(3, 2) == (6, 1, 12, 9, 3)
    assert x.long_slots(2**40, 3) == (3 * 2**40, 2**40 // 3, 2**43, 2**120, 2**40)


def test_PyFloat_Type_number_slots():
    assert x.float_slots(-2.7) == (-2, 2.7)


# every number slot of int and float, one call each: (slot, x, y, result)
INT_SLOTS = [('add', 7, 2, 9), ('subtract', 7, 2, 5), ('multiply', 7, 2, 14),
             ('remainder', 7, 2, 1), ('divmod', 7, 2, (3, 1)), ('floor_divide', 7, 2, 3),
             ('true_divide', 7, 2, 3.5), ('power', 7, 2, 49), ('lshift', 7, 2, 28),
             ('rshift', 7, 2, 1), ('and', 7, 2, 2), ('xor', 7, 2, 5), ('or', 7, 2, 7),
             ('negative', 7, None, -7), ('positive', 7, None, 7), ('absolute', -7, None, 7),
             ('invert', 7, None, -8), ('int', 7, None, 7), ('float', 7, None, 7.0),
             ('index', 7, None, 7), ('bool', 0, None, False)]
FLOAT_SLOTS = [('add', 7.5, 2.0, 9.5), ('subtract', 7.5, 2.0, 5.5), ('multiply', 7.5, 2.0, 15.0),
               ('remainder', 7.5, 2.0, 1.5), ('divmod', 7.5, 2.0, (3.0, 1.5)),
               ('floor_divide', 7.5, 2.0, 3.0), ('true_divide', 7.5, 2.0, 3.75),
               ('power', 1.5, 2.0, 2.25), ('negative', 7.5, None, -7.5),
               ('positive', 7.5, None, 7.5), ('absolute', -7.5, None, 7.5), ('int', 7.5, None, 7),
               ('float', 7.5, None, 7.5), ('bool', 0.0, None, False)]


def test_builtin_number_slots_all():
    for t, slots in (('int', INT_SLOTS), ('float', FLOAT_SLOTS)):
        for name, a, b, want in slots:
            got = x.number_slot(t, name, a) if b is None else x.number_slot(t, name, a, b)
            assert got == want and type(got) is type(want), (t, name, got)


def test_builtin_tp_new():
    assert x.builtin_new('tuple', [1, 2]) == (1, 2)
    assert x.builtin_new('float', '1.5') == 1.5
    assert x.builtin_new('str', 5) == '5'
    assert x.builtin_new('bytes', [65]) == b'A'


def test_builtin_sequence_slots():
    assert x.sequence_slots([1, 2], [3]) == (1, [1, 2, 3], [1, 2, 1, 2])
    assert x.sequence_slots((1,), (2,)) == (1, (1, 2), (1, 1))


def test_builtin_mapping_slots():
    assert x.mapping_slots({'a': 1}, 'a') == (1, 1)
    assert raises(KeyError, x.mapping_slots, {}, 'a')


def test_builtin_repr_str_hash_iter_slots():
    assert x.object_slots('ab') == ("'ab'", 'ab', c_hash('ab'), 'a')
    assert x.object_slots((7,)) == ('(7,)', '(7,)', c_hash((7,)), 7)


# ---- Py_SIZE, Py_REFCNT, Py_IS_TYPE

def test_Py_SIZE_Py_REFCNT_Py_IS_TYPE():
    assert x.sizes((1, 2, 3)) == (3, True, True)
    assert x.sizes([1]) == (1, True, True)
    assert x.sizes(b'ab') == (2, True, True)


# ---- Py_UNICODE_* character macros: (ISALPHA ISDIGIT ISALNUM ISSPACE
# ISDECIMAL ISLINEBREAK ISLOWER ISUPPER ISNUMERIC), (TODECIMAL TODIGIT TONUMERIC)

def test_Py_UNICODE_classes():
    assert x.char_class(ord('A')) == ((1, 0, 1, 0, 0, 0, 0, 1, 0), (-1, -1, -1.0))
    assert x.char_class(ord('z')) == ((1, 0, 1, 0, 0, 0, 1, 0, 0), (-1, -1, -1.0))
    assert x.char_class(ord('5')) == ((0, 1, 1, 0, 1, 0, 0, 0, 1), (5, 5, 5.0))
    assert x.char_class(0x663) == ((0, 1, 1, 0, 1, 0, 0, 0, 1), (3, 3, 3.0))     # Arabic-Indic 3
    assert x.char_class(ord(' ')) == ((0, 0, 0, 1, 0, 0, 0, 0, 0), (-1, -1, -1.0))
    assert x.char_class(ord('\n')) == ((0, 0, 0, 1, 0, 1, 0, 0, 0), (-1, -1, -1.0))
    assert x.char_class(0xbd) == ((0, 0, 1, 0, 0, 0, 0, 0, 1), (-1, -1, 0.5))    # 1/2
    assert x.char_class(0x2168) == ((0, 0, 1, 0, 0, 0, 0, 1, 1), (-1, -1, 9.0))  # Roman IX


def test_Py_UNICODE_TOLOWER_TOUPPER():
    assert x.char_case(ord('A')) == (97, 65) and x.char_case(ord('z')) == (122, 90)
    assert x.char_case(0x2168) == (0x2178, 0x2168)
    assert x.char_case(ord('5')) == (53, 53)


# ---- the buffer protocol

def test_PyObject_CheckBuffer_GetBuffer_Release():
    assert x.buffer(b'ab') == (True, b'ab', 2, 1, 1)
    assert x.buffer(bytearray(b'cd')) == (True, b'cd', 2, 0, 1)
    assert x.buffer(memoryview(b'ef')) == (True, b'ef', 2, 1, 1)
    assert x.buffer('str') == (False,)


def test_PyBuffer_IsContiguous():
    assert x.buffer_contiguous(b'ab')
    assert not x.buffer_contiguous(memoryview(b'abcd')[::2])


def test_PyObject_GetBuffer_writable():
    b = bytearray(b'ab')
    x.writable_buffer(b)
    assert b == bytearray(b'Zb')
    assert raises(BufferError, x.writable_buffer, b'ab')


# ---- module state

def test_PyModule_GetState_PyType_GetModule_GetModuleState():
    assert x.module_state() == (42, True, True)


# ---- the builtin slots one at a time

def test_builtin_tp_repr_tp_str():
    assert x.one_slot('repr', 'ab') == "'ab'" and x.one_slot('str', 'ab') == 'ab'


def test_builtin_tp_hash():
    assert x.one_slot('hash', 'ab') == c_hash('ab') and x.one_slot('hash', (7,)) == c_hash((7,))
    assert x.one_slot('hash', 2.5) == c_hash(2.5)


def test_builtin_tp_iter_tp_iternext():
    assert x.one_slot('iter', 'ab') == 'a' and x.one_slot('iter', (7,)) == 7


# ---- exact type checks: (long float str bytes tuple list dict)

def test_CheckExact_macros():
    assert x.check_exact(1) == (1, 0, 0, 0, 0, 0, 0)
    assert x.check_exact(True) == (0, 0, 0, 0, 0, 0, 0)          # bool is not exactly int
    assert x.check_exact({}) == (0, 0, 0, 0, 0, 0, 1)
    assert x.check_exact('s') == (0, 0, 1, 0, 0, 0, 0)


def test_PyUnicode_2BYTE_DATA_4BYTE_DATA():
    assert x.wide_data('€') == [0x20ac]
    assert x.wide_data('a€\U0001F600') == [0x61, 0x20ac, 0x1F600]


def test_PyObject_GC_NewVar_Py_SET_SIZE():
    assert x.gc_new_var() == (3, 2)


def test_PyObject_NewVar_InitVar():
    assert x.new_init_var() == (4, 2)
