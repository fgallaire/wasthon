# The module, capsule, argument-parsing, import, function and method object,
# weakref, contextvar, thread-state, OS and other runtime C-API, one test per
# C function: tests/_capi_runtime.c makes each C call. pytest runs this file
# against CPython (tests/cpython.sh), the reference; tests/run.sh runs it
# against the bridge.
import sys

import _capi_runtime as r


def raises(exc, f, *args, **kw):
    try:
        f(*args, **kw)
    except exc:
        return True
    return False


class Spec:
    name = 'multi_made'


class W:
    pass


class P:
    def __fspath__(self):
        return '/a'


# ---- modules

def test_PyModule_New_GetDict_Add_family():
    is_module, d = r.module_add()
    assert is_module and d['__name__'] == 'made'
    assert (d['ref'], d['added'], d['obj'], d['INT'], d['STR']) == (1, 2, 1, 42, 's')
    assert d['int'] is int                       # PyModule_AddType


def test_PyModule_Create2():
    m = r.module_create2()
    assert m.__name__ == 'small' and m.__doc__ == 'small doc'


def test_PyModuleDef_Init_FromDefAndSpec2_ExecDef():
    m = r.module_from_spec(Spec())
    assert m.__name__ == 'multi_made' and m.EXECUTED == 1


def test_PyState_FindModule():
    assert r.state_find_module()


# ---- capsules

def test_PyCapsule_New_GetPointer_GetName_IsValid():
    assert r.capsule_read(r.capsule_new()) == ('_capi_runtime.CAPSULE', 7, True, True)
    assert raises(ValueError, r.capsule_read, 5)


def test_PyCapsule_SetPointer_SetName_SetContext():
    assert r.capsule_set(r.capsule_new()) == ('renamed', 8, True)


def test_PyCapsule_GetPointer_wrong_name():
    assert raises(ValueError, r.capsule_wrong_name, r.capsule_new())


def test_PyCapsule_Import():
    assert r.capsule_import('_capi_runtime.CAPSULE') == 7


# ---- parsing arguments

def test_PyArg_ParseTuple_formats():
    args = (1, 2, 3, 4.5, 's', None, b'y', 'o', [1], 'u', 0, (6, 7))
    assert r.parse_formats(*args) == (1, 2, 3, 4.5, 's', None, b'y', 'o', [1], 'u', 0, 6, 7)
    assert raises(TypeError, r.parse_formats, 1)
    assert raises(TypeError, r.parse_formats, 'x', *args[1:])
    assert raises(TypeError, r.parse_formats, *args[:8], (1,), *args[9:])    # O! list


def test_PyArg_ParseTuple_converter():
    assert r.parse_converter(1.5) == 3.0


def test_PyArg_ParseTupleAndKeywords():
    assert r.parse_keywords(1) == (1, 2, 3)
    assert r.parse_keywords(1, 5, c=9) == (1, 5, 9)
    assert r.parse_keywords(a=4) == (4, 2, 3)
    assert raises(TypeError, r.parse_keywords, 1, 2, 3)          # c is keyword-only
    assert raises(TypeError, r.parse_keywords, a=1, d=2)


def test_PyArg_VaParseTupleAndKeywords():
    assert r.va_parse_keywords(1, b=2) == (1, 2) and r.va_parse_keywords(1) == (1, 5)


def test_PyArg_Parse():
    assert r.parse_single(5) == 5
    assert raises(TypeError, r.parse_single, 'x')


def test_PyArg_UnpackTuple():
    assert r.unpack_tuple(1) == (1, None) and r.unpack_tuple(1, 2) == (1, 2)
    assert raises(TypeError, r.unpack_tuple, 1, 2, 3)


def test_Py_BuildValue_Py_VaBuildValue():
    assert r.build_values() == (1, 'two', [3.5, None], {'k': True}, (4, 5))


# ---- import

def test_PyImport_ImportModule_Import():
    assert r.import_module('json') is sys.modules['json']
    assert r.import_('json') is sys.modules['json']
    assert raises(ModuleNotFoundError, r.import_module, 'no_such_mod')


def test_PyImport_ImportModuleAttr_ImportModuleAttrString():
    import math
    import os.path
    assert r.import_attr('os.path', 'join', 'math', 'pi') == (os.path.join, math.pi)


def test_PyImport_AddModule_GetModuleDict():
    m = r.add_module('brand_new_module')
    assert m.__name__ == 'brand_new_module' and sys.modules['brand_new_module'] is m
    assert r.module_dict() is sys.modules


# ---- functions and methods

def test_PyCFunction_New_accessors():
    assert r.cfunction('SELF', None) == (('SELF', 1), True, True, True, True)


def test_PyCFunction_NewEx():
    assert r.cfunction('SELF', 'modname') == (('SELF', 1), True, True, True, True)


def test_PyMethod_New_Check_GET_FUNCTION():
    def f(self):
        return self * 2
    m, is_method, same = r.method_new(f, 'x')
    assert m() == 'xx' and m.__self__ == 'x' and is_method and same


def test_PyInstanceMethod_New_Check_GET_FUNCTION():
    def f(self):
        return 'im'
    im, is_im, same = r.instancemethod_new(f)
    assert is_im and same
    class K:
        meth = im
    assert K().meth() == 'im'


def test_PyClassMethod_New():
    def f(cls):
        return cls
    class K:
        meth = r.classmethod_new(f)
    assert K.meth() is K and K().meth() is K


def test_PyCallIter_New():
    assert list(r.call_iter(iter([1, 2, 3, 0, 5]).__next__, 0)) == [1, 2, 3]


def test_PyVectorcall_Call():
    assert r.vectorcall_call(max, (1, 5), None) == 5
    assert r.vectorcall_call(sorted, ([3, 1],), {'reverse': True}) == [3, 1]


def test_Py_GenericAlias():
    a = r.generic_alias(list, int)
    assert a == list[int] and a.__origin__ is list and a.__args__ == (int,)


# ---- weakref, contextvar

def test_PyWeakref_NewRef_GetRef_CheckRef():
    w = W()
    assert r.weakref(w) == (True, w)
    assert raises(TypeError, r.weakref, 1)


def test_PyContextVar_New_Get_Set():
    assert r.contextvar('default', 'value') == ('default', 'value')


# ---- interpreter, threads, time, sys

def test_PyEval_GetBuiltins():
    b = r.builtins()
    assert b['len'] is len and b['__name__'] == 'builtins'


def test_thread_state_and_GIL():
    assert r.threads() == (True, True, True, True, True)


def test_PyTime_Time_Monotonic():
    assert r.times() == (True, True)


def test_PySys_GetObject():
    assert r.sys_get_object('maxsize') == sys.maxsize
    assert r.sys_get_object('no_such_attribute') is None


def test_PySys_Audit():
    assert r.sys_audit() is None


# ---- OS helpers

def test_PyOS_FSPath():
    assert r.os_fspath(P()) == '/a' and r.os_fspath('s') == 's'
    assert raises(TypeError, r.os_fspath, 1)


def test_PyOS_string_to_double():
    assert r.os_string_to_double('1.5e3') == (1500.0, 5)
    assert raises(ValueError, r.os_string_to_double, 'abc')


def test_PyOS_double_to_string():
    assert r.os_double_to_string(1.0 / 3, 'r', 0, 0) == '0.3333333333333333'
    assert r.os_double_to_string(2.5, 'f', 3, 0) == '2.500'


def test_PyOS_strtol_strtoul():
    assert r.os_strtol('0x1Fz', 0) == (31, 31, 4)
    assert r.os_strtol('-12', 10)[0] == -12


def test_PyOS_strnicmp_snprintf():
    assert r.os_strnicmp('ABc', 'abd', 2) == 0 and r.os_strnicmp('ABc', 'abd', 3) == -1
    assert r.os_snprintf() == (9, '12-abcd')


# ---- small ones

def test_Py_Is():
    assert r.is_(None, None) and not r.is_([], [])


def test_Py_GetConstant():
    assert r.constants() == (None, True, 0, '', ())


def test_Py_HashBuffer():
    assert r.hash_buffer(b'abc') == hash(b'abc')


def test_Py_IsInitialized():
    assert r.is_initialized()


def test_Py_EnterRecursiveCall_LeaveRecursiveCall():
    assert r.recursive_call() is None


def test_Py_ReprEnter_ReprLeave():
    assert r.repr_enter([]) == (0, 1)


def test_PyUnstable_Object_IsUniquelyReferenced():
    assert r.uniquely_referenced()


def test_PyTraceMalloc_Track_Untrack():
    assert r.tracemalloc() == (-2, -2)          # tracemalloc is not tracing
