# The str and bytes C-API, one test per C function: tests/_capi_unicode.c
# makes each C call. pytest runs this file against CPython (tests/cpython.sh),
# the reference; tests/run.sh runs it against the bridge.
import _capi_unicode as u


def raises(exc, f, *args):
    try:
        f(*args)
    except exc:
        return True
    return False


S = 'h\xe9llo € \U0001F600'       # latin-1, BMP and astral code points


# ---- creating a str

def test_PyUnicode_FromString():
    assert u.from_string('h\xe9llo'.encode()) == 'h\xe9llo'
    assert u.from_string(S.encode()) == S
    assert raises(UnicodeDecodeError, u.from_string, b'\xff')


def test_PyUnicode_FromStringAndSize():
    assert u.from_string_and_size(b'abcdef', 3) == 'abc'
    assert u.from_string_and_size(b'a\0b', 3) == 'a\0b'


def test_PyUnicode_InternFromString():
    assert u.intern_from_string(b'abc') == 'abc'


def test_PyUnicode_FromFormat_numbers():
    assert u.from_format_numbers() == 'abc|-5|123456789|42|Z|%|ff|7'


def test_PyUnicode_FromFormat_width():
    assert u.from_format_width() == '[   42][ab   ][xy][00007]'


def test_PyUnicode_FromFormat_objects():
    assert u.from_format_objects('s\xe9', [1, 'a']) == "s\xe9|[1, 'a']|[1, 'a']|s\xe9"


def test_PyUnicode_FromFormatV():
    assert u.from_format_v(2, 3) == '2+3'


def test_PyUnicode_FromOrdinal():
    assert u.from_ordinal(0x41) == 'A'
    assert u.from_ordinal(0x1F600) == '\U0001F600'
    assert raises(ValueError, u.from_ordinal, 0x110000)


def test_PyUnicode_FromKindAndData():
    assert u.from_kind_and_data(1, b'abc') == 'abc'
    assert u.from_kind_and_data(2, '\xe9€'.encode('utf-16-le')) == '\xe9€'
    assert u.from_kind_and_data(4, '\U0001F600!'.encode('utf-32-le')) == '\U0001F600!'


def test_PyUnicode_FromObject():
    class Sub(str):
        pass
    r = u.from_object(Sub('abc'))
    assert r == 'abc' and type(r) is str
    assert raises(TypeError, u.from_object, 42)


def test_PyUnicode_FromEncodedObject():
    assert u.from_encoded_object(S.encode(), 'utf-8', 'strict') == S
    assert u.from_encoded_object(b'\xe9', 'latin-1', None) == '\xe9'
    assert raises(TypeError, u.from_encoded_object, 'already str', 'utf-8', None)


def test_PyUnicode_New_WriteChar():
    assert u.new_and_write([0x61, 0x62], 0x7f) == 'ab'
    assert u.new_and_write([0xe9, 0x20ac, 0x1F600], 0x10ffff) == '\xe9€\U0001F600'


def test_PyUnicode_AsWideCharString_FromWideChar():
    assert u.wide_char_round_trip('abc') == 'abc'
    assert u.wide_char_round_trip(S) == S


def test_PyUnicode_AsWideChar():
    assert u.as_wide_char('abc', 10) == (3, 'abc')
    assert u.as_wide_char('abcdef', 3) == (3, 'abc')


# ---- decoding

def test_PyUnicode_Decode():
    assert u.decode(S.encode(), 'utf-8', 'strict') == S
    assert u.decode(b'a\xffb', 'utf-8', 'replace') == 'a�b'
    assert raises(UnicodeDecodeError, u.decode, b'a\xffb', 'utf-8', 'strict')
    assert raises(LookupError, u.decode, b'a', 'no-such-codec', None)


def test_PyUnicode_Decode_latin1():
    assert u.decode(b'caf\xe9', 'latin-1', None) == 'caf\xe9'


def test_PyUnicode_DecodeUTF8():
    assert u.decode_utf8(S.encode(), None) == S
    assert raises(UnicodeDecodeError, u.decode_utf8, b'a\xffb', None)


def test_PyUnicode_DecodeUTF8_errors():
    assert u.decode_utf8(b'a\xffb', 'ignore') == 'ab'
    assert u.decode_utf8(b'a\xffb', 'replace') == 'a�b'


def test_PyUnicode_DecodeASCII():
    assert u.decode_ascii(b'abc', None) == 'abc'
    assert raises(UnicodeDecodeError, u.decode_ascii, b'\xe9', None)


def test_PyUnicode_DecodeLatin1():
    assert u.decode_latin1(b'caf\xe9', None) == 'caf\xe9'


def test_PyUnicode_DecodeRawUnicodeEscape():
    assert u.decode_raw_unicode_escape(b'\\u0041b\\x', None) == 'Ab\\x'


def test_PyUnicode_DecodeLocale():
    assert u.decode_locale(b'abc') == 'abc'


def test_PyUnicode_DecodeUTF16():
    assert u.decode_utf16(b'\x00A', 1) == ('A', 1)
    assert u.decode_utf16(b'\xff\xfeA\x00', 0) == ('A', -1)


def test_PyUnicode_DecodeUTF32():
    assert u.decode_utf32(b'\x00\x00\x00A', 1) == ('A', 1)
    assert u.decode_utf32(b'\xff\xfe\x00\x00A\x00\x00\x00', 0) == ('A', -1)


# ---- encoding and exporting

def test_PyUnicode_AsUTF8():
    assert u.as_utf8('caf\xe9') == 'caf\xe9'.encode()
    assert u.as_utf8(S) == S.encode()
    assert raises(TypeError, u.as_utf8, b'bytes')


def test_PyUnicode_AsUTF8AndSize():
    assert u.as_utf8_and_size('a\0b\xe9') == (b'a\0b\xc3\xa9', 5)


def test_PyUnicode_AsUTF8String():
    assert u.as_utf8_string(S) == S.encode()


def test_PyUnicode_AsASCIIString():
    assert u.as_ascii_string('abc') == b'abc'
    assert raises(UnicodeEncodeError, u.as_ascii_string, '\xe9')


def test_PyUnicode_AsLatin1String():
    assert u.as_latin1_string('caf\xe9') == b'caf\xe9'
    assert raises(UnicodeEncodeError, u.as_latin1_string, '€')


def test_PyUnicode_AsEncodedString():
    assert u.as_encoded_string(S, 'utf-16-le', None) == S.encode('utf-16-le')
    assert u.as_encoded_string('a€', 'ascii', 'replace') == b'a?'


def test_PyUnicode_AsUCS4Copy():
    assert u.as_ucs4_copy('ab') == [0x61, 0x62, 0]
    assert u.as_ucs4_copy('a\U0001F600') == [0x61, 0x1F600, 0]


def test_PyUnicode_AsUCS4():
    assert u.as_ucs4('ab', 3, 1) == [0x61, 0x62, 0]
    assert raises(SystemError, u.as_ucs4, 'abc', 2, 0)


def test_PyUnicode_FSConverter():
    assert u.fs_converter('abc') == b'abc'
    assert u.fs_converter(b'raw') == b'raw'
    assert raises(TypeError, u.fs_converter, 42)


# ---- inspecting

def test_PyUnicode_GetLength():
    assert u.get_length('caf\xe9') == (4, 4)
    assert u.get_length(S) == (len(S), len(S))


def test_PyUnicode_KIND_MAX_CHAR_VALUE_IS_ASCII():
    assert u.kind('abc') == (1, 0x7f, True)
    assert u.kind('caf\xe9') == (1, 0xff, False)
    assert u.kind('€') == (2, 0xffff, False)
    assert u.kind('\U0001F600') == (4, 0x10ffff, False)


def test_PyUnicode_DATA_READ_CHAR_ReadChar():
    for s in ['abc', 'caf\xe9', 'a€', S]:
        assert u.read_chars(s) == [ord(c) for c in s], s


def test_PyUnicode_1BYTE_DATA():
    assert u.one_byte_data('caf\xe9') == b'caf\xe9'


def test_PyUnicode_FindChar():
    assert u.find_char('abcabc', ord('c'), 0, 6, 1) == 2
    assert u.find_char('abcabc', ord('c'), 0, 6, -1) == 5
    assert u.find_char('abc', ord('z'), 0, 3, 1) == -1


def test_PyUnicode_Substring():
    assert u.substring('abcdef', 1, 4) == 'bcd'
    assert u.substring('abc', 1, 10) == 'bc'
    assert u.substring(S, 1, 4) == S[1:4]


# ---- operations

def test_PyUnicode_Concat():
    assert u.concat('ab', 'c€') == 'abc€'
    assert raises(TypeError, u.concat, 'a', 1)


def test_PyUnicode_AppendAndDel():
    assert u.append_and_del('ab', 'cd') == 'abcd'


def test_PyUnicode_Join():
    assert u.join('-', ['a', 'b', '\xe9']) == 'a-b-\xe9'
    assert u.join('', ('x', 'y')) == 'xy'
    assert raises(TypeError, u.join, '-', ['a', 1])


def test_PyUnicode_Split():
    assert u.split('a b  c', None, -1) == ['a', 'b', 'c']
    assert u.split('a,b,c', ',', 1) == ['a', 'b,c']


def test_PyUnicode_Replace():
    assert u.replace('aaaa', 'a', 'b', 2) == 'bbaa'
    assert u.replace('aaaa', 'a', 'b', -1) == 'bbbb'


def test_PyUnicode_Contains():
    assert u.contains('hello', 'ell') and not u.contains('hello', 'z')
    assert raises(TypeError, u.contains, 'hello', 1)


def test_PyUnicode_Tailmatch():
    assert u.tailmatch('hello', 'he', 0, 5, -1) == 1
    assert u.tailmatch('hello', 'lo', 0, 5, 1) == 1
    assert u.tailmatch('hello', 'he', 0, 5, 1) == 0


def test_PyUnicode_Find():
    assert u.find('abcabc', 'bc', 0, 6, 1) == 1
    assert u.find('abcabc', 'bc', 0, 6, -1) == 4
    assert u.find('abc', 'z', 0, 3, 1) == -1


def test_PyUnicode_Compare():
    assert u.compare('a', 'b') == -1 and u.compare('b', 'a') == 1 and u.compare('a', 'a') == 0


def test_PyUnicode_CompareWithASCIIString():
    assert u.compare_with_ascii('abc', b'abc') == 0
    assert u.compare_with_ascii('abd', b'abc') == 1


def test_PyUnicode_EqualToUTF8():
    assert u.equal_to_utf8('caf\xe9', 'caf\xe9'.encode())
    assert not u.equal_to_utf8('caf\xe9', b'cafe')


def test_PyUnicode_Format():
    assert u.format('%s-%d', ('a', 3)) == 'a-3'
    assert u.format('%(x)s', {'x': 1}) == '1'
    assert raises(TypeError, u.format, '%d', ('a',))


def test_PyUnicodeWriter():
    assert u.writer('abcd', 42) == "[h\xe9llo-42'abcd'bc50%]"


def test_PyUnicodeWriter_WriteChar():
    assert u.writer_one('char', 0x20ac) == '€'


def test_PyUnicodeWriter_WriteUTF8():
    assert u.writer_one('utf8', 'h\xe9'.encode()) == 'h\xe9'


def test_PyUnicodeWriter_WriteASCII():
    assert u.writer_one('ascii', b'abc') == 'abc'


def test_PyUnicodeWriter_WriteStr():
    assert u.writer_one('str', 'abc') == 'abc'
    assert u.writer_one('str', 42) == '42'


def test_PyUnicodeWriter_WriteRepr():
    assert u.writer_one('repr', 'a') == "'a'"


def test_PyUnicodeWriter_WriteSubstring():
    assert u.writer_one('substring', 'abcd') == 'bc'


def test_PyUnicodeWriter_Format():
    assert u.writer_one('format', 50) == '50%'


def test_PyUnicodeWriter_Discard():
    assert u.writer_discard() is None


# ---- bytes

def test_PyBytes_FromString():
    assert u.bytes_from_string(b'abc') == b'abc'


def test_PyBytes_FromStringAndSize():
    assert u.bytes_from_string_and_size(b'abcdef', 2) == b'ab'


def test_PyBytes_FromObject():
    assert u.bytes_from_object([97, 98]) == b'ab'
    assert u.bytes_from_object(bytearray(b'xy')) == b'xy'
    assert raises(TypeError, u.bytes_from_object, 'str')


def test_PyBytes_AsString_Size():
    assert u.bytes_as_string(b'ab\0cd') == (b'ab', 5, 5)
    assert raises(TypeError, u.bytes_as_string, 'str')


def test_PyBytes_AsStringAndSize():
    assert u.bytes_as_string_and_size(b'ab\xff') == (b'ab\xff', 3)


def test_PyBytes_Join():
    assert u.bytes_join(b'-', [b'a', b'b']) == b'a-b'
    assert raises(TypeError, u.bytes_join, b'-', ['a'])


def test_PyBytes_DecodeEscape():
    assert u.bytes_decode_escape(b'a\\nb\\x41') == b'a\nbA'


def test__PyBytes_Resize():
    assert u.bytes_resize(b'abcdef', 3) == b'abc'
