# The int, float, complex, bool and number-protocol C-API, one test per C
# function: tests/_capi_number.c makes each C call. pytest runs this file
# against CPython (tests/cpython.sh), the reference; tests/run.sh runs it
# against the bridge. C sizes differ between 64-bit CPython and wasm32, so the
# limits come from the C side.
import _capi_number as n


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


SIZES = n.sizes()
LONG_MAX = 2 ** (8 * SIZES['long'] - 1) - 1
ULONG_MAX = 2 ** (8 * SIZES['long']) - 1
SSIZE_MAX = 2 ** (8 * SIZES['ssize_t'] - 1) - 1
BIG = 2 ** 70


# ---- int from C

def test_PyLong_FromLong():
    assert n.from_long(-5) == -5 and n.from_long(LONG_MAX) == LONG_MAX


def test_PyLong_FromUnsignedLong():
    assert n.from_unsigned_long(ULONG_MAX) == ULONG_MAX


def test_PyLong_FromSsize_t_FromSize_t():
    assert n.from_ssize_t(-7) == -7 and n.from_ssize_t(SSIZE_MAX) == SSIZE_MAX
    assert n.from_size_t(SSIZE_MAX) == SSIZE_MAX


def test_PyLong_FromLongLong():
    assert n.from_long_long(-2**63) == -2**63 and n.from_long_long(2**63 - 1) == 2**63 - 1


def test_PyLong_FromUnsignedLongLong():
    assert n.from_unsigned_long_long(2**64 - 1) == 2**64 - 1


def test_PyLong_FromInt64_FromUInt32():
    assert n.from_int64(-2**62) == -2**62
    assert n.from_uint32(2**32 - 1) == 2**32 - 1


def test_PyLong_FromDouble():
    assert n.from_double(-2.7) == -2 and n.from_double(1e20) == 10**20
    assert raises(OverflowError, n.from_double, float('inf'))
    assert raises(ValueError, n.from_double, float('nan'))


def test_PyLong_FromString():
    assert n.from_string(b'  -12  ', 10) == (-12, 7)
    assert n.from_string(b'0x1f', 0) == (31, 4)
    assert n.from_string(b'1_000', 10) == (1000, 5)
    assert raises(ValueError, n.from_string, b'  -12xyz', 10)


def test_PyLong_FromUnicodeObject():
    assert n.from_unicode_object('ff', 16) == 255
    assert n.from_unicode_object('١٢', 10) == 12     # Arabic-Indic digits
    assert raises(ValueError, n.from_unicode_object, 'zz', 10)


def test_PyLong_FromVoidPtr_AsVoidPtr():
    assert n.void_ptr_round_trip()


# ---- int to C

def test_PyLong_AsLong():
    assert n.as_long(-5) == -5 and n.as_long(LONG_MAX) == LONG_MAX
    assert raises(OverflowError, n.as_long, BIG)
    assert raises(TypeError, n.as_long, 'x')


def test_PyLong_AsInt():
    assert n.as_int(2**31 - 1) == 2**31 - 1
    assert raises(OverflowError, n.as_int, 2**40)


def test_PyLong_AsUnsignedLong():
    assert n.as_unsigned_long(ULONG_MAX) == ULONG_MAX
    assert raises(OverflowError, n.as_unsigned_long, -1)


def test_PyLong_AsUnsignedLongMask():
    assert n.as_unsigned_long_mask(-1) == ULONG_MAX
    assert n.as_unsigned_long_mask(ULONG_MAX + 2) == 1


def test_PyLong_AsSsize_t_AsSize_t():
    assert n.as_ssize_t(-3) == -3 and n.as_ssize_t(SSIZE_MAX) == SSIZE_MAX
    assert raises(OverflowError, n.as_ssize_t, BIG)
    assert n.as_size_t(SSIZE_MAX) == SSIZE_MAX
    assert raises(OverflowError, n.as_size_t, -1)


def test_PyLong_AsLongLong():
    assert n.as_long_long(-2**63) == -2**63
    assert raises(OverflowError, n.as_long_long, 2**63)


def test_PyLong_AsUnsignedLongLong():
    assert n.as_unsigned_long_long(2**64 - 1) == 2**64 - 1
    assert raises(OverflowError, n.as_unsigned_long_long, -1)


def test_PyLong_AsUInt32():
    assert n.as_uint32(2**32 - 1) == 2**32 - 1
    assert raises(OverflowError, n.as_uint32, 2**32)


def test_PyLong_AsDouble():
    assert n.as_double(2**53) == 2.0**53
    assert raises(OverflowError, n.as_double, 10**400)


def test_PyLong_AsLongAndOverflow():
    assert n.as_long_and_overflow(7) == (7, 0)
    assert n.as_long_and_overflow(BIG) == (-1, 1)
    assert n.as_long_and_overflow(-BIG) == (-1, -1)


def test_PyLong_AsLongLongAndOverflow():
    assert n.as_long_long_and_overflow(-7) == (-7, 0)
    assert n.as_long_long_and_overflow(BIG) == (-1, 1)


# ---- int bytes, sign, export

def test__PyLong_FromByteArray():
    assert n.from_bytes(b'\x01\x02', 1, 0) == 513
    assert n.from_bytes(b'\x01\x02', 0, 0) == 258
    assert n.from_bytes(b'\xff', 1, 1) == -1


def test_PyLong_AsNativeBytes():
    assert n.as_native_bytes(258, 2, 1) == (2, b'\x02\x01')        # little-endian
    assert n.as_native_bytes(258, 4, 0) == (4, b'\x00\x00\x01\x02')  # big-endian
    assert n.as_native_bytes(-1, 2, 1) == (2, b'\xff\xff')
    assert n.as_native_bytes(2**40, 2, 1)[0] == 6                     # bytes needed


def test__PyLong_GCD():
    assert n.gcd(12, 18) == 6 and n.gcd(-12, 18) == 6 and n.gcd(BIG, 2**65) == 2**65


def test_PyLong_IsZero():
    assert n.is_zero(0) and not n.is_zero(BIG)
    assert raises(TypeError, n.is_zero, 'x')


def test_PyLong_GetSign():
    assert n.get_sign(-5) == -1 and n.get_sign(0) == 0 and n.get_sign(BIG) == 1
    assert raises(TypeError, n.get_sign, 'x')


def test_PyLong_Export_PyLongWriter():
    for v in [0, -3, 2**62, 2**100 + 7, -(2**200)]:
        assert n.export_round_trip(v) == v, v


def test_PyLongWriter_Discard():
    assert n.writer_discard() is None


# ---- float

def test_PyFloat_FromDouble_AsDouble():
    assert n.float_from_double(1.5) == 1.5
    assert n.float_as_double(3) == 3.0 and n.float_as_double(2.5) == 2.5
    assert raises(TypeError, n.float_as_double, 'x')


def test_PyFloat_FromString():
    assert n.float_from_string(' 1.25 ') == 1.25
    assert n.float_from_string('-inf') == float('-inf')
    assert raises(ValueError, n.float_from_string, 'abc')


def test_PyFloat_CheckExact():
    class F(float):
        pass
    assert n.float_check_exact(1.5) and not n.float_check_exact(F(1.5))
    assert not n.float_check_exact(1)


def test_PyFloat_Pack_Unpack():
    assert n.pack(2, 1.5, 1) == (b'\x00>', 1.5)
    assert n.pack(4, -2.0, 0) == (b'\xc0\x00\x00\x00', -2.0)
    assert n.pack(8, 0.1, 1) == (b'\x9a\x99\x99\x99\x99\x99\xb9?', 0.1)
    assert raises(OverflowError, n.pack, 2, 1e10, 1)


# ---- complex, bool

def test_PyComplex_FromDoubles_RealAsDouble_ImagAsDouble():
    z = n.complex_from_doubles(1.5, -2.0)
    assert z == complex(1.5, -2.0) and type(z) is complex
    assert n.complex_parts(z) == (1.5, -2.0)
    assert n.complex_parts(3) == (3.0, 0.0)
    assert raises(TypeError, n.complex_parts, 'x')


def test_PyComplex_AsCComplex_FromCComplex():
    assert n.complex_as_ccomplex(1 + 2j) == (1.0, 2.0)
    assert n.complex_as_ccomplex(1.5) == (1.5, 0.0)
    assert n.complex_from_ccomplex(0.5, 3.0) == 0.5 + 3j


def test_PyComplex_Check():
    assert n.complex_check(1j) and not n.complex_check(1.0)


def test_PyBool_FromLong_Check():
    assert n.bool_from_long(5) is True and n.bool_from_long(0) is False
    assert n.bool_check(True) and not n.bool_check(1)


# ---- number protocol

def test_PyNumber_Check_PyIndex_Check():
    assert n.number_check(1.5) == (True, False)
    assert n.number_check(3) == (True, True)
    assert n.number_check('x') == (False, False)


def test_PyNumber_Index():
    assert n.number_index(True) == 1 and type(n.number_index(True)) is int
    assert raises(TypeError, n.number_index, 1.5)


def test_PyNumber_Long():
    assert n.number_long(2.9) == 2 and n.number_long('12') == 12
    assert raises(ValueError, n.number_long, 'x')


def test_PyNumber_Float():
    assert n.number_float(3) == 3.0 and n.number_float('1.5') == 1.5
    assert raises(TypeError, n.number_float, [])


def test_PyNumber_AsSsize_t():
    assert n.number_as_ssize_t(5, None) == 5
    assert n.number_as_ssize_t(BIG, None) == SSIZE_MAX          # clamped
    assert n.number_as_ssize_t(-BIG, None) == -SSIZE_MAX - 1
    assert raises(OverflowError, n.number_as_ssize_t, BIG, OverflowError)


def test_PyNumber_unary():
    assert n.unop('abs', -3) == 3 and n.unop('neg', 2.5) == -2.5
    assert n.unop('pos', -1) == -1 and n.unop('invert', 5) == -6
    assert raises(TypeError, n.unop, 'neg', 'x')


def test_PyNumber_Add_Subtract_Multiply():
    assert n.binop('add', 1, 2.5) == 3.5 and n.binop('add', 'a', 'b') == 'ab'
    assert n.binop('sub', 5, 7) == -2 and n.binop('mul', 'ab', 2) == 'abab'
    assert raises(TypeError, n.binop, 'add', 1, 'a')


def test_PyNumber_divisions():
    assert n.binop('floordiv', -7, 2) == -4 and n.binop('truediv', 7, 2) == 3.5
    assert n.binop('mod', -7, 2) == 1 and n.binop('divmod', 7, 2) == (3, 1)
    assert raises(ZeroDivisionError, n.binop, 'truediv', 1, 0)


def test_PyNumber_bitwise():
    assert n.binop('lshift', 1, 70) == BIG and n.binop('rshift', BIG, 69) == 2
    assert n.binop('and', 12, 10) == 8 and n.binop('or', 12, 10) == 14
    assert n.binop('xor', 12, 10) == 6


def test_PyNumber_Power():
    assert n.power(3, 4, None) == 81 and n.power(3, 4, 5) == 1
    assert n.power(2, -1, None) == 0.5
