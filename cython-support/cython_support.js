/* cython_support.js — bridge side of the Cython support layer.
 * The handful of CPython C-API functions Cython-generated modules reference
 * that wasthon.js doesn't already provide. Link alongside wasthon.js:
 *   emcc ... --js-library src/wasthon.js --js-library cython_support.js
 * (Mergeable into wasthon.js later.) */
mergeInto(LibraryManager.library, {
  /* --- traceback/code-object synthesis in __Pyx_AddTraceback. Must be NON-NULL:
   * when CreateCodeObjectForTraceback (which just returns PyCode_NewEmpty) yields
   * NULL, __Pyx_AddTraceback takes its `Py_XDECREF(ptype/pvalue/ptb); goto bad`
   * branch — it DISCARDS the in-flight exception without restoring it, so every
   * exception raised inside a cdef function was dropped as it propagated
   * (numpy.random arg-validation ValueErrors surfaced as "call returned NULL"
   * instead of the real error). The returned object is only stored in Cython's
   * code-object cache, DECREF'd, and passed to PyFrame_New (a no-op); its fields
   * are never read, so a plain None placeholder suffices. --- */
  PyCode_NewEmpty__deps: ['$WasthonRT'],
  PyCode_NewEmpty: function(filenamePtr, funcnamePtr, firstlineno) {
    return WasthonRT.wrapNewRef(WasthonRT._b_.None);
  },

  /* PyUnstable_Code_NewWithPosOnlyArgs(a,p,k,l,s,f, code,consts,names,varnames,
   *   freevars,cellvars, filename,name,qualname, firstlineno, linetable,
   *   exceptiontable) — build a Brython-shaped code object (the co_* record
   *   Cython stores as each def's __code__; the def's real behaviour is driven
   *   by ml_meth, so this is metadata). Must be NON-NULL or InitCachedConstants
   *   aborts. */
  PyUnstable_Code_NewWithPosOnlyArgs__deps: ['$WasthonRT'],
  PyUnstable_Code_NewWithPosOnlyArgs: function(a,p,k,l,s,f,code,c,n,v,fv,cell,fn,name,qualname,fline,lnos,exctable) {
    var rt = WasthonRT;
    function jstr(h){ try { return h ? rt.asJSStr(rt.unwrap(h)) : ""; } catch(_){ return ""; } }
    function jarr(h){ try { var o = h ? rt.unwrap(h) : null; if (Array.isArray(o)) { var r = o.slice(); r.ob_type = rt._b_.tuple; return r; } } catch(_){} var e = []; e.ob_type = rt._b_.tuple; return e; }
    try {
      var co = {
        co_argcount: a|0, co_posonlyargcount: p|0, co_kwonlyargcount: k|0,
        co_nlocals: l|0, co_stacksize: s|0, co_flags: f|0, co_firstlineno: fline|0,
        co_name: jstr(name), co_qualname: jstr(qualname), co_filename: jstr(fn),
        co_varnames: jarr(v), co_names: jarr(n), co_consts: jarr(c),
        co_freevars: jarr(fv), co_cellvars: jarr(cell),
      };
      co.co_positions = function(){ return rt.$B.$list([]); };
      return rt.wrapNewRef(co);
    } catch (e) { return 0; }
  },

  PyFrame_New__deps: ['$WasthonRT'],
  PyFrame_New: function(tstate, code, globals, locals) { return 0; },

  PyTraceBack_Here__deps: ['$WasthonRT'],
  PyTraceBack_Here: function(frame) { return 0; },

  PyInterpreterState_GetID__deps: ['$WasthonRT'],
  PyInterpreterState_GetID: function(interp) { return 0; },

  /* --- real: module + import helpers --- */

  /* PyModule_NewObject(name_str) — like PyModule_New but the name is a str
   * object rather than a C string. */
  PyModule_NewObject__deps: ['$WasthonRT'],
  PyModule_NewObject: function(nameH) {
    var rt = WasthonRT;
    try {
      var name = nameH ? rt.asJSStr(rt.unwrap(nameH)) : "";
      var mod = rt.$B.module.tp_new(rt.$B.module);
      rt.$B.module.tp_init(mod, name || "");
      return rt.wrapNewRef(mod);
    } catch (e) { return 0; }
  },

  /* PyImport_AddModuleRef(name) — return the module `name` from sys.modules,
   * creating an empty one (registered) if absent. New reference. Cython's
   * module-init uses it to fetch the module object being initialised. */
  PyImport_AddModuleRef__deps: ['$WasthonRT'],
  PyImport_AddModuleRef: function(namePtr) {
    var rt = WasthonRT;
    try {
      var name = namePtr ? UTF8ToString(namePtr) : "";
      rt.$B.imported = rt.$B.imported || {};
      var m = rt.$B.imported[name];
      if (m === undefined || m === null) {
        m = rt.$B.module.tp_new(rt.$B.module);
        rt.$B.module.tp_init(m, name);
        rt.$B.imported[name] = m;
      }
      return rt.wrapNewRef(m);
    } catch (e) { return 0; }
  },

  /* PyImport_ImportModuleLevelObject(name, globals, locals, fromlist, level) —
   * the object-arg form of __import__. Delegates to Brython's __import__. */
  PyImport_ImportModuleLevelObject__deps: ['$WasthonRT'],
  PyImport_ImportModuleLevelObject: function(nameH, globalsH, localsH, fromlistH, level) {
    var rt = WasthonRT;
    try {
      var name = nameH ? rt.asJSStr(rt.unwrap(nameH)) : "";
      var globals = globalsH ? rt.unwrap(globalsH) : rt._b_.None;
      var fromlist = fromlistH ? rt.unwrap(fromlistH) : rt._b_.None;
      var lvl = level | 0;
      // Resolve a relative import to an absolute name ourselves: Brython's
      // _b_.__import__ drops the `level` arg, so `from ._pcg64 import PCG64`
      // (level 1) inside numpy.random._generator would look up a bare '_pcg64'
      // and 404. CPython's algorithm: package = the importing module's
      // __package__ (or, for a non-package module, its __name__ minus the last
      // component), then strip level-1 trailing components and append `name`.
      if (lvl > 0) {
        var pkg = null;
        try { var p = rt.$B.$getitem(globals, '__package__'); if (p && p !== rt._b_.None) pkg = rt.asJSStr(p); } catch (e) {}
        if (!pkg) {
          try { var gn = rt.asJSStr(rt.$B.$getitem(globals, '__name__'));
            var gi = gn.lastIndexOf('.'); pkg = (gi >= 0) ? gn.slice(0, gi) : gn; } catch (e) {}
        }
        for (var k = 1; k < lvl && pkg; k++) { var pi = pkg.lastIndexOf('.'); pkg = (pi >= 0) ? pkg.slice(0, pi) : ''; }
        name = pkg ? (name ? pkg + '.' + name : pkg) : name;
        lvl = 0;
      }
      var mod = rt._b_.__import__(name, globals, rt._b_.None, fromlist, lvl);
      return rt.wrapNewRef(mod);
    } catch (e) { rt.forwardError(e, rt._b_.ImportError); return 0; }
  },

  /* _PyObject_GetDictPtr(obj) — CPython returns &obj->__dict__ (a PyObject**).
   * The handle bridge has no such C slot; return NULL so Cython falls back to
   * the generic getattr path. */
  _PyObject_GetDictPtr__deps: ['$WasthonRT'],
  _PyObject_GetDictPtr: function(objH) { return 0; },

  /* PyErr_GetExcInfo / PyErr_SetExcInfo — the "currently handled exception"
   * (sys.exc_info()) that Cython (with -DCYTHON_USE_EXC_INFO_STACK=0) saves and
   * restores around `except` blocks. The bridge tracks the pending (being
   * raised) exception, not a separate handled-exception stack; report "none
   * handled" and accept restores as no-ops. Enough for code that raises fresh
   * exceptions in its error paths (numpy.random arg validation); bare `raise`
   * re-raising an outer handled exception is the only thing this under-serves.
   * Fold into wasthon.js with a real per-frame exc_info if that surfaces. */
  PyErr_GetExcInfo__deps: ['$WasthonRT'],
  PyErr_GetExcInfo: function(pType, pValue, pTb) {
    if (pType)  HEAP32[pType  >> 2] = 0;
    if (pValue) HEAP32[pValue >> 2] = 0;
    if (pTb)    HEAP32[pTb    >> 2] = 0;
  },
  PyErr_SetExcInfo__deps: ['$WasthonRT'],
  PyErr_SetExcInfo: function(typeH, valueH, tbH) { /* no-op: no handled-exc stack */ },

  /* PyImport_GetModule(name) — sys.modules.get(name); NULL if not imported
   * (does NOT import). New ref (or NULL). */
  PyImport_GetModule__deps: ['$WasthonRT'],
  PyImport_GetModule: function(nameH) {
    var rt = WasthonRT;
    try {
      var name = nameH ? rt.asJSStr(rt.unwrap(nameH)) : "";
      rt.$B.imported = rt.$B.imported || {};
      var m = rt.$B.imported[name];
      return (m === undefined || m === null) ? 0 : rt.wrapNewRef(m);
    } catch (e) { return 0; }
  },

  /* PySequence_SetItem(o, i, v) — o[i] = v; 0 / -1. */
  PySequence_SetItem__deps: ['$WasthonRT'],
  PySequence_SetItem: function(oH, i, vH) {
    var rt = WasthonRT;
    try { rt.$B.$setitem(rt.unwrap(oH), i | 0, rt.unwrap(vH)); return 0; }
    catch (e) { rt.forwardError(e, rt._b_.TypeError); return -1; }
  },

  /* PyObject_DelItem(o, key) — del o[key]; 0 / -1 (numpy.random's _sfc64
   * state setter deletes a dict key). */
  PyObject_DelItem__deps: ['$WasthonRT'],
  PyObject_DelItem: function(oH, keyH) {
    var rt = WasthonRT;
    try { rt.$B.$delitem(rt.unwrap(oH), rt.unwrap(keyH)); return 0; }
    catch (e) { rt.forwardError(e, rt._b_.TypeError); return -1; }
  },

  /* PyObject_DelAttr(o, name) — delattr(o, name); 0 / -1. */
  PyObject_DelAttr__deps: ['$WasthonRT'],
  PyObject_DelAttr: function(oH, nameH) {
    var rt = WasthonRT;
    try { rt.$B.$call(rt._b_.delattr, rt.unwrap(oH), rt.unwrap(nameH)); return 0; }
    catch (e) { rt.forwardError(e, rt._b_.AttributeError); return -1; }
  },

  /* PyCFunction_NewEx(ml, self, module) — wrap a single PyMethodDef into a
   * builtin_function_or_method. Cython's View.MemoryView boilerplate uses it
   * for the `__pyx_unpickle_Enum` helper. Reuses the bridge's trampoline maker;
   * PyMethodDef = name(0) meth(4) flags(8) doc(12). */
  PyCFunction_NewEx__deps: ['$WasthonRT', '$__wasthon_make_trampoline'],
  PyCFunction_NewEx: function(mlPtr, selfH, moduleH) {
    var rt = WasthonRT;
    try {
      var name  = UTF8ToString(HEAP32[mlPtr >> 2]);
      var fnPtr = HEAP32[(mlPtr + 4) >> 2];
      var flags = HEAP32[(mlPtr + 8) >> 2];
      var tr = __wasthon_make_trampoline(fnPtr, flags, moduleH || 0, name, true, 0);
      tr.ob_type = rt.$B.builtin_function_or_method;
      return rt.wrap(tr);
    } catch (e) { rt.forwardError(e); return 0; }
  },

  /* PyVectorcall_Function(op) — the callable's vectorcall pointer, or NULL if it
   * has none. Returning NULL makes Cython take the normal tp_call path (always
   * correct, just not the fast one). */
  PyVectorcall_Function__deps: ['$WasthonRT'],
  PyVectorcall_Function: function(opH) { return 0; },

  /* In-place numeric ops → the bridge's non-in-place ops. For the operand types
   * numpy.random's Cython uses these on (Python ints: seed/state arithmetic),
   * in-place and out-of-place produce the same value. */
  PyNumber_InPlaceAdd__deps: ['PyNumber_Add'],
  PyNumber_InPlaceAdd: function(a, b) { return _PyNumber_Add(a, b); },
  PyNumber_InPlaceMultiply__deps: ['PyNumber_Multiply'],
  PyNumber_InPlaceMultiply: function(a, b) { return _PyNumber_Multiply(a, b); },
  PyNumber_InPlaceFloorDivide__deps: ['PyNumber_FloorDivide'],
  PyNumber_InPlaceFloorDivide: function(a, b) { return _PyNumber_FloorDivide(a, b); },
  PyNumber_InPlaceRshift__deps: ['PyNumber_Rshift'],
  PyNumber_InPlaceRshift: function(a, b) { return _PyNumber_Rshift(a, b); },
  PyNumber_InPlacePower__deps: ['PyNumber_Power'],
  PyNumber_InPlacePower: function(a, b, c) { return _PyNumber_Power(a, b, c); },
  PyNumber_InPlaceSubtract__deps: ['PyNumber_Subtract'],
  PyNumber_InPlaceSubtract: function(a, b) { return _PyNumber_Subtract(a, b); },
  PyNumber_InPlaceAnd__deps: ['PyNumber_And'],
  PyNumber_InPlaceAnd: function(a, b) { return _PyNumber_And(a, b); },

  /* PyStaticMethod_New — a real Brython staticmethod wrapper (pandas' Cython
   * class-dict fixups). CPython contract: the staticmethod owns a ref on its
   * callable. Take it for struct-backed callables (Cython class-body
   * functions) — the caller DECREFs its own ref right after (SetNewInClass),
   * and rc->0 would free the struct under the stored wrapper (instance-
   * exempt rule, mirror of PyDict_SetItem). */
  PyStaticMethod_New__deps: ['$WasthonRT'],
  PyStaticMethod_New: function(callableH) {
    var rt = WasthonRT;
    var callable = rt.unwrap(callableH);
    if (callable && callable.__wasthon_ptr__) rt.incref(callableH);
    return rt.wrapNewRef({
      ob_type: rt._b_.staticmethod,
      sm_callable: callable,
      $callable: callable,
    });
  },

  /* Locale codecs — the wasm runtime is single-locale UTF-8, so these are the
   * UTF-8 codecs (exactly what CPython does under an UTF-8 locale). */
  PyUnicode_EncodeLocale__deps: ['PyUnicode_AsUTF8String'],
  PyUnicode_EncodeLocale: function(unicodeH, errorsPtr) {
    return _PyUnicode_AsUTF8String(unicodeH);
  },
  PyUnicode_DecodeLocale__deps: ['PyUnicode_FromString'],
  PyUnicode_DecodeLocale: function(strPtr, errorsPtr) {
    return _PyUnicode_FromString(strPtr);
  },
  PyNumber_InPlaceTrueDivide__deps: ['PyNumber_TrueDivide'],
  PyNumber_InPlaceTrueDivide: function(a, b) { return _PyNumber_TrueDivide(a, b); },

  /* PyNumber_MatrixMultiply(a, b) — a @ b, via the __matmul__ protocol (numpy
   * ndarray). InPlace variant routes to the same (Cython's `@=` on objects). */
  PyNumber_MatrixMultiply__deps: ['$WasthonRT'],
  PyNumber_MatrixMultiply: function(aH, bH) {
    var rt = WasthonRT;
    try { return rt.wrapNewRef(rt.$B.$call(
      rt.$B.$getattr(rt.unwrap(aH), '__matmul__'), rt.unwrap(bH))); }
    catch (e) { rt.forwardError(e); return 0; }
  },
  PyNumber_InPlaceMatrixMultiply__deps: ['PyNumber_MatrixMultiply'],
  PyNumber_InPlaceMatrixMultiply: function(a, b) { return _PyNumber_MatrixMultiply(a, b); },

  /* PyModule_GetName(m) — borrowed const char* of the module's __name__.
   * Cached on the module's JS object so the pointer stays valid. */
  PyModule_GetName__deps: ['$WasthonRT'],
  PyModule_GetName: function(mH) {
    var rt = WasthonRT;
    try {
      var m = rt.unwrap(mH);
      if (m.__wasthon_name_cstr__) return m.__wasthon_name_cstr__;
      var name = rt.asJSStr(rt.$B.$getattr(m, '__name__'));
      var p = stringToNewUTF8(name);
      m.__wasthon_name_cstr__ = p;
      return p;
    } catch (e) { return 0; }
  },

  /* PyObject_GC_IsFinalized — the bridge doesn't resurrect during finalize. */
  PyObject_GC_IsFinalized__deps: ['$WasthonRT'],
  PyObject_GC_IsFinalized: function(opH) { return 0; },

  /* PyUnicode_CopyCharacters(to, to_start, from, from_start, how_many) — copy a
   * run of characters between str objects. Rare (Cython cold string paths);
   * report failure so callers fall back rather than silently corrupt. */
  PyUnicode_CopyCharacters__deps: ['$WasthonRT'],
  PyUnicode_CopyCharacters: function(toH, toStart, fromH, fromStart, howMany) {
    var rt = WasthonRT;
    try { rt.setError(rt.wrap(rt._b_.NotImplementedError), 'PyUnicode_CopyCharacters'); } catch (e) {}
    return -1;
  },

  /* PyUnicode_Resize(&str, newsize) — resize a str in place. Rare cold path. */
  PyUnicode_Resize__deps: ['$WasthonRT'],
  PyUnicode_Resize: function(pStrH, newsize) {
    var rt = WasthonRT;
    try { rt.setError(rt.wrap(rt._b_.NotImplementedError), 'PyUnicode_Resize'); } catch (e) {}
    return -1;
  },

  /* PyCapsule_GetName(cap) — the capsule's name as a const char*. The bridge
   * capsule keeps the name as a JS string; materialize a stable C string
   * (cached on the object) so callers can strcmp it (numpy.random compares the
   * "BitGenerator" capsule name). */
  PyCapsule_GetName__deps: ['$WasthonRT'],
  PyCapsule_GetName: function(capsuleH) {
    var rt = WasthonRT;
    var obj = rt.unwrap(capsuleH);
    if (!obj || obj.__class__ !== 'PyCapsule' || obj.name == null) return 0;
    if (!obj.__name_cstr__) obj.__name_cstr__ = stringToNewUTF8(obj.name);
    return obj.__name_cstr__;
  },

  /* PyException_GetTraceback(exc) — new ref to exc.__traceback__, or NULL. */
  PyException_GetTraceback__deps: ['$WasthonRT'],
  PyException_GetTraceback: function(excH) {
    var rt = WasthonRT;
    try {
      var tb = rt.$B.$getattr(rt.unwrap(excH), '__traceback__');
      return (tb == null || tb === rt._b_.None) ? 0 : rt.wrapNewRef(tb);
    } catch (e) { return 0; }
  },

  /* PyIter_Send / PyRun_String — generator-send and string-exec, from Cython's
   * coroutine support. numpy.random doesn't drive these; stub as error (PYGEN_-
   * ERROR = -1 / NULL) with an exception so any real use fails loudly. */
  PyIter_Send__deps: ['$WasthonRT'],
  PyIter_Send: function(iterH, argH, presult) {
    var rt = WasthonRT;
    if (presult) HEAP32[presult >> 2] = 0;
    try { rt.setError(rt.wrap(rt._b_.NotImplementedError), 'PyIter_Send'); } catch (e) {}
    return -1; /* PYGEN_ERROR */
  },
  PyRun_String__deps: ['$WasthonRT'],
  PyRun_String: function(strPtr, start, globalsH, localsH) {
    var rt = WasthonRT;
    try { rt.setError(rt.wrap(rt._b_.NotImplementedError), 'PyRun_String'); } catch (e) {}
    return 0;
  },

  /* PyThreadState_GetFrame — no real interpreter frames on the bridge. */
  PyThreadState_GetFrame__deps: ['$WasthonRT'],
  PyThreadState_GetFrame: function(tstate) { return 0; },
});
