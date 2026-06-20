/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * wasthon.js — JS-side implementation of wasthon.h.
 *
 * This is the C-to-Brython bridge: C extension code compiled to WASM
 * calls into CPython C-API functions (declared in wasthon.h), and those
 * calls are routed here to be served by Brython's JS runtime. The bridge
 * crosses both a language boundary (C ↔ JS) and a runtime boundary
 * (WASM ↔ V8/SpiderMonkey).
 *
 * Loaded into WASM modules built with `emcc --js-library wasthon.js`.
 * Provides the JS implementation of every prototype declared in wasthon.h.
 *
 * PyObject* values are 32-bit integer handles into a JS-side handle table
 * holding strong references to Brython objects. This is the only object-
 * lifetime mechanism: refcounting in C is a no-op, JS GC keeps Brython
 * objects alive while a handle references them, and freed handles release
 * the reference.
 *
 * Coverage in this file: tiers 4 (built-in constructors/accessors),
 * 5 (errors), 6 (helpers). Other tiers will be added incrementally.
 */

mergeInto(LibraryManager.library, {

    /* --------------------------------------------------------------- *
     * $WasthonRT — runtime: handle table, sentinels, exception state. *
     * Everything that needs persistent state goes here.               *
     * --------------------------------------------------------------- */

    $WasthonRT__postset: 'WasthonRT.init(); Module["wasthon"] = WasthonRT;',
    $WasthonRT: {
        _b_: null,
        $B: null,

        // Handle table — a Map keyed by an integer "handle ID" returning
        // the corresponding Brython/JS object. Two handle ranges:
        //   • Sentinels & non-instance handles: small auto-incremented IDs
        //     (1, 2, 3, …). They never alias real WASM pointers because
        //     the C heap doesn't return such low addresses.
        //   • Instance handles (for types created via PyType_FromModuleAndSpec):
        //     the real WASM pointer to the C-allocated struct, also stored
        //     in this map so JS can retrieve the Brython wrapper.
        handles: null,           // Map<int, object>
        sentinelByObj: null,     // WeakMap<object, int> — identity interning (reverse of handles)
        nextHandleId: 5,         // 1-4 reserved for sentinels
        freeList: [],

        // Handle scopes — the third handle lifetime, between "immortal"
        // (no scope active: module init, loader-time) and "refcounted"
        // (instances + sentinels C explicitly owns via Py_INCREF / a
        // new-reference API). Every JS→C entry point (method trampoline,
        // slot dispatch, tp_new/tp_init/tp_call, getset) pushes a scope;
        // sentinel handles allocated while it is active are owned by it
        // and released at pop — the JNI local-reference model. A handle
        // escapes its scope by acquiring a refcount (wrapNewRef / C-side
        // Py_INCREF / a no-steal store API), in which case the pop hands
        // ownership to the refcount and the handle lives until it drops
        // to zero. This kills the borrowed-wrap accumulation (~67 handle
        // map entries per pickle.dumps) that tp_dealloc structurally
        // couldn't touch.
        scopes: [],              // stack of arrays of handle ids
        scopeOf: null,           // Map<handle, scopeArr> — owning scope of a live sentinel
        internPool: null,        // Map<string, handle> — pinned interned strings (content-keyed)
        noScopeFree: false,      // A/B harness switch: true = pre-scope behaviour (leak)

        // Sentinel handle IDs (filled at init).
        SLOT_NONE: 1,
        SLOT_TRUE: 2,
        SLOT_FALSE: 3,
        SLOT_NOTIMPLEMENTED: 4,

        // Pending exception, or null.
        pendingException: null,

        // Module/type registries.
        // moduleDefs:  Map<defPtr,    {def, name, size, methods, slots, traverse, clear, free}>
        // modules:     Map<moduleH,   {def, statePtr, name, dict, types: []}>
        // types:       Map<typeH,     {basicsize, itemsize, flags, slots, methods, getset, brythonClass, moduleH}>
        moduleDefs: null,
        modules: null,
        types: null,

        // refcounts: per-instance refcount table. Populated by
        // wasthon_object_gc_new, never holds sentinels. Macros Py_INCREF /
        // Py_DECREF route through wasthon_incref / wasthon_decref which
        // touch this Map; for any handle not in the Map (sentinels, NULL,
        // built-in singletons), they are no-ops. Discrimination by Map
        // membership avoids value-range tricks and never reads handle
        // memory, so sentinels remain safe even when intermixed with
        // pointer values in the low address range.
        refcounts: null,

        // Internal incref/decref helpers — used by both the C-callable
        // wasthon_incref / wasthon_decref library functions and by JS-side
        // library bridges that must take ownership of a value (e.g. the
        // "no-steal" APIs PyModule_AddObjectRef, PyDict_SetItem, etc.).
        //
        // Counting eligibility: a handle is countable iff it is currently
        // scope-owned (scopeOf) or already counted (refcounts). Everything
        // else — singletons, type structs, immortal init-era sentinels —
        // stays a no-op, preserving the old "tolerant" behaviour exactly
        // where strict accounting hasn't been established.
        incref: function(handle) {
            var rc = this.refcounts;
            if (rc.has(handle)) { rc.set(handle, rc.get(handle) + 1); return; }
            // First C-owned reference on a scope-owned sentinel: count it.
            // The owning scope keeps the binding — pop transfers ownership
            // to the refcount instead of releasing (see popScope) — so a
            // balanced INCREF/DECREF by a nested call never steals a handle
            // out from under the scope that created it.
            if (this.scopeOf.has(handle)) rc.set(handle, 1);
        },
        // Wrap a value as a "new reference" (the convention of most C-API
        // returns: constructors, PyObject_Call / Vectorcall results, …).
        // The C caller owns one reference and is expected to either DECREF
        // it (handle dies with the scope, or earlier) or keep it — e.g.
        // `self->write = PyObject_GetAttr(file, ...)` stores the new ref in
        // a C struct with no further INCREF, so the handle must survive the
        // creating scope. Seeding refcount 1 makes both work.
        wrapNewRef: function(value) {
            var h = this.wrap(value);
            this.incref(h);
            return h;
        },
        decref: function(handle) {
            var rc = this.refcounts;
            if (!rc.has(handle)) return;
            var n = rc.get(handle) - 1;
            if (n > 0) { rc.set(handle, n); return; }
            // A/B harness switch: when set, the reference reaches zero but the
            // instance is neither dispatched to tp_dealloc nor freed — it stays
            // pinned in handles/refcounts forever. This reproduces the bridge's
            // behaviour before tp_dealloc existed, so test-tp-dealloc.html can
            // contrast reclaimed vs leaked memory on the exact same workload.
            if (this.noFree) { rc.set(handle, 0); return; }
            rc.delete(handle);
            var inst = this.handles.get(handle);
            if (!inst || !inst.__wasthon_type__) {
                // Sentinel reached zero: C no longer owns it. If a scope
                // still owns it, leave it — the pop releases it. Otherwise
                // (created in a scope that already popped, ownership was
                // transferred to the refcount) hand it to the current scope
                // so it stays valid for the remainder of the enclosing
                // call, or release immediately if none is active.
                if (!this.scopeOf.has(handle)) {
                    var sc = this.scopes.length ?
                             this.scopes[this.scopes.length - 1] : null;
                    if (sc) { sc.push(handle); this.scopeOf.set(handle, sc); }
                    else this.releaseSentinel(handle);
                }
                return;
            }
            var tp_dealloc = HEAP32[(inst.__wasthon_type__ + 40) >> 2];
            if (!tp_dealloc) return;
            // The C dealloc body may create handles (Py_CLEAR recursion,
            // error formatting); scope them like any other C entry.
            this.pushScope();
            try { getWasmTableEntry(tp_dealloc)(handle); }
            catch (e) { /* defensive */ }
            finally { this.popScope(); }
        },

        /* ---- Handle scopes (see field comment above) ---- */
        pushScope: function() {
            var s = [];
            this.scopes.push(s);
            return s;
        },
        popScope: function() {
            var s = this.scopes.pop();
            if (!s) return;
            var so = this.scopeOf;
            for (var i = 0; i < s.length; i++) {
                var h = s[i];
                if (so.get(h) !== s) continue;      // promoted away or duplicate
                so.delete(h);
                // C still owns references — ownership transfers to the
                // refcount; the handle dies when it drops to zero.
                if (this.refcounts.has(h)) continue;
                this.releaseSentinel(h);
            }
        },
        // Release one sentinel handle: drop the table entry, the identity-
        // interning entry, and recycle the id.
        releaseSentinel: function(h) {
            var obj = this.handles.get(h);
            this.handles.delete(h);
            if (obj !== undefined &&
                    (typeof obj === 'object' || typeof obj === 'function')) {
                if (this.sentinelByObj.get(obj) === h) this.sentinelByObj.delete(obj);
            }
            if (h < 0x10000) this.freeList.push(h);
        },
        // Record a freshly allocated sentinel id in the current scope.
        // No scope active (module init, loader-time) → immortal, exactly
        // the pre-scope behaviour.
        _scopeTrack: function(h) {
            if (this.noScopeFree) return;
            var s = this.scopes.length ? this.scopes[this.scopes.length - 1] : null;
            if (s) { s.push(h); this.scopeOf.set(h, s); }
        },
        // Wrap a JS function (a JS→C entry point called from Brython) so
        // its whole execution runs under a fresh handle scope.
        // The wrapper inherits fn's `name`: Brython's method machinery
        // derives __name__/__qualname__ from the JS function name (the
        // slot closures get "dispatch" by inference from their `var`
        // assignment), and an anonymous wrapper turns explicit dunder
        // access (`a.__add__`) into a nameless JavascriptFunction whose
        // __qualname__ read raises AttributeError — took test_array from
        // 90% to 77%.
        scoped: function(fn) {
            var rt = this;
            var wrapper = function() {
                rt.pushScope();
                try { return fn.apply(this, arguments); }
                finally { rt.popScope(); }
            };
            if (fn.name) {
                try {
                    Object.defineProperty(wrapper, 'name',
                        { value: fn.name, configurable: true });
                } catch (_) {}
            }
            return wrapper;
        },
        // Wrap an object whose handle is stored in C linear memory for
        // cross-call use by the bridge itself (type-struct tp_dict,
        // T_OBJECT member writes): lift it out of any owning scope so it
        // is never released.
        wrapPinned: function(obj) {
            var h = this.wrap(obj);
            this.scopeOf.delete(h);
            return h;
        },
        // Consume the reference a C function's return value hands to its
        // caller (CPython contract: the caller owns the result and must
        // release it). The JS dispatchers are that caller — once the
        // result is unwrapped to a JS object, the handle ref is dropped.
        // Instances are exempt: their refcount-1 belongs to the Brython
        // wrapper that now holds the struct pointer.
        consumeResultRef: function(h) {
            if (!h) return;
            var o = this.handles.get(h);
            if (o && o.__wasthon_ptr__) return;
            this.decref(h);
        },
        unwrapResult: function(h) {
            var v = this.unwrap(h);
            this.consumeResultRef(h);
            this.syncCstrBytes(v);
            return v;
        },

        // Fold a C-written linear-memory buffer back into a bytes object's JS
        // `.source` array. PyBytes_FromStringAndSize(NULL, n) hands C a writable
        // buffer (__wasthon_cstr__) while .source stays zero-filled; the C
        // producer writes the buffer in place (e.g. sqlite3_blob_read into
        // PyBytes_AS_STRING), so any result crossing back to Brython must sync.
        // The tp_methods trampoline did this (syncBytes) but slot returns
        // (mp_subscript/sq_item — Blob[slice]) did not, so blob reads were all
        // zeros. Idempotent for read-only AsString buffers (a copy of .source).
        syncCstrBytes: function(v) {
            if (!v || typeof v !== 'object') return;
            var ptr = v.__wasthon_cstr__;
            if (!ptr) return;
            var src = v.source;
            if (!src || src.length === undefined) return;
            var n = src.length;
            for (var i = 0; i < n; i++) src[i] = HEAPU8[ptr + i];
        },

        init: function() {
            var B = globalThis.__BRYTHON__;
            if (!B) {
                throw new Error("Wasthon bridge: __BRYTHON__ global not found. " +
                    "Brython must be loaded before instantiating a Wasthon module.");
            }
            this.$B = B;
            this._b_ = B.builtins;
            this.handles = new Map();
            // WeakMap: a released sentinel whose handle was re-bound (e.g.
            // unicode placeholder materialization) leaves a stale entry —
            // let it die with the object instead of accumulating.
            this.sentinelByObj = new WeakMap();
            this.moduleDefs = new Map();
            this.modules = new Map();
            this.types = new Map();
            this.refcounts = new Map();
            this.scopes = [];
            this.scopeOf = new Map();
            this.internPool = new Map();

            this.handles.set(this.SLOT_NONE,  this._b_.None);
            this.handles.set(this.SLOT_TRUE,  this._b_.True);
            this.handles.set(this.SLOT_FALSE, this._b_.False);
            this.handles.set(this.SLOT_NOTIMPLEMENTED, this._b_.NotImplemented);
        },

        _allocSentinelId: function() {
            if (this.freeList.length > 0) return this.freeList.pop();
            // Sentinel IDs and malloc-derived struct-pointer handles share
            // the same key space in `handles`. After ~tens of thousands of
            // allocations, nextHandleId can collide with a real type-struct
            // pointer (e.g. Dialect_Type = 73112) and overwrite the binding.
            // Skip past any in-use slot.
            while (this.handles.has(this.nextHandleId)) this.nextHandleId++;
            return this.nextHandleId++;
        },

        // Public: wrap a Brython/JS object as a PyObject* handle. Allocates
        // a fresh sentinel-range ID. For *instances* (allocated via
        // PyObject_GC_New), use bindInstance instead.
        wrap: function(obj) {
            if (obj === undefined || obj === null) return 0;
            if (obj === this._b_.None)  return this.SLOT_NONE;
            if (obj === this._b_.True)  return this.SLOT_TRUE;
            if (obj === this._b_.False) return this.SLOT_FALSE;
            if (obj === this._b_.NotImplemented) return this.SLOT_NOTIMPLEMENTED;
            // Instances allocated by wasthon_object_gc_new carry their
            // C-side pointer as __wasthon_ptr__. The handle IS that pointer
            // so C-side `self->field` dereferences hit the right linear
            // memory. Round-tripping the same instance through wrap/unwrap
            // (e.g. when a dict caches a struct instance and another call
            // reads it back) must preserve this pointer-handle identity —
            // otherwise we get a fresh sentinel id, the C code casts it
            // as if it were a struct pointer, and dereferences garbage.
            if (obj.__wasthon_ptr__) {
                if (!this.handles.has(obj.__wasthon_ptr__)) {
                    this.handles.set(obj.__wasthon_ptr__, obj);
                }
                return obj.__wasthon_ptr__;
            }
            // Types get the canonical struct-backed handle (the same one
            // ensureTypeStruct / wrapMaybeType return), so C-level pointer
            // identity holds whether a class arrives as a type or as a plain
            // object — e.g. _pickle's __newobj__ (`obj_class != cls`) and
            // save_global (`actual != global`) identity checks. The metaclass
            // test is one ref compare, instantly false for non-type wraps.
            if (obj.__wasthon_type_handle__) return obj.__wasthon_type_handle__;
            if (obj.ob_type === this._b_.type) return this.ensureTypeStruct(obj);
            // Other Brython objects (functions, ptr-less instances): intern by
            // identity so re-wrapping the same object yields the same handle.
            if (typeof obj === 'object' || typeof obj === 'function') {
                var ex = this.sentinelByObj.get(obj);
                if (ex !== undefined && this.handles.get(ex) === obj) return ex;
                var nid = this._allocSentinelId();
                this.handles.set(nid, obj);
                this.sentinelByObj.set(obj, nid);
                this._scopeTrack(nid);
                return nid;
            }
            var id = this._allocSentinelId();
            this.handles.set(id, obj);
            this._scopeTrack(id);
            return id;
        },

        unwrap: function(handle) {
            // Treat handle 0 as Python NULL pointer; everything else looks
            // up the table by exact presence. Falsy *values* (0, "", false)
            // are valid Python objects — we must NOT coalesce them to null.
            if (handle === 0) return null;
            return this.handles.has(handle) ? this.handles.get(handle) : null;
        },

        // Bind a Brython instance to a real WASM pointer. The handle == ptr.
        bindInstance: function(ptr, brythonInstance) {
            this.handles.set(ptr, brythonInstance);
        },

        release: function(handle) {
            if (handle === 0) return;
            if (handle === this.SLOT_NONE ||
                handle === this.SLOT_TRUE ||
                handle === this.SLOT_FALSE ||
                handle === this.SLOT_NOTIMPLEMENTED) return;
            this.handles.delete(handle);
            // Only sentinel-range IDs (small ints) are recycled; pointer
            // handles aren't (their memory is freed by the dealloc path).
            if (handle < 0x10000) this.freeList.push(handle);
        },

        /* Flatten a Brython $kw payload to [[name, value], ...] pairs.
         *
         * Brython 3.14 represents keyword args as `{$kw: src}` where src is
         * either a single map or an Array of maps. Per pmp-p / Pierre:
         *   f(x=1, y=2)              → {$kw: [{x:1, y:2}]}
         *   f(**d1, **d2, **d3)      → {$kw: [{}, d1, d2, d3]}
         *   f(x=1, **d1, **d2)       → {$kw: [{x:1}, d1, d2]}
         * Element 0 is a plain JS object (the explicit name=value pairs).
         * Elements 1+ are the mappings from `**d` expansions and ARE real
         * Brython dicts — their entries live in Symbol-keyed hash storage,
         * NOT as enumerable own properties. So `Object.keys` / `for...in`
         * silently skip them. We need .items() for those.
         *
         * Returns: array of [name, value] pairs (later duplicate keys win,
         * matching CPython's left-to-right ** evaluation). */
        flattenKwArray: function(src) {
            var out = [];
            if (src === null || src === undefined) return out;
            var maps = Array.isArray(src) ? src : [src];
            for (var mi = 0; mi < maps.length; mi++) {
                var m = maps[mi];
                if (!m || typeof m !== 'object') continue;
                // Brython 3.14 instances use `ob_type` (PyTypeObject mirror)
                // rather than `__class__`. Accept both shapes for the
                // detection; fall back to $isinstance for subclasses.
                var isBrythonDict = (m.ob_type === this._b_.dict) ||
                    (m.__class__ && m.__class__ === this._b_.dict) ||
                    (this.$B.$isinstance && this.$B.$isinstance(m, this._b_.dict));
                if (isBrythonDict) {
                    // Walk via .items() — same canonical pattern as
                    // PyDict_Next snapshotting (see line ~1700).
                    try {
                        var items_view = this.$B.$call(this.$B.$getattr(m, 'items'));
                        var items_list = this.$B.$call(this._b_.list, items_view);
                        var n = this._b_.len(items_list);
                        for (var i = 0; i < n; i++) {
                            var pair = this.$B.$getitem(items_list, i);
                            var k = this.$B.$getitem(pair, 0);
                            var v = this.$B.$getitem(pair, 1);
                            if (k === '$kw' || k === '$nat') continue;
                            out.push([k, v]);
                        }
                    } catch (_) { /* ignore — bad dict, skip */ }
                } else {
                    // Plain JS object (the first $kw element with explicit
                    // name=value kwargs). Own enumerable string keys.
                    var ks = Object.keys(m);
                    for (var kj = 0; kj < ks.length; kj++) {
                        var nm = ks[kj];
                        if (nm === '$kw' || nm === '$nat') continue;
                        out.push([nm, m[nm]]);
                    }
                }
            }
            return out;
        },

        lastCall: null,
        trace: function(name, info) {
            this.lastCall = name + (info ? '(' + info + ')' : '');
            // Uncomment for verbose: console.log('[wasthon trace]', this.lastCall);
        },
        /* Lazily back a Brython type class with a real PyTypeObject struct
         * in linear memory, so C code can dereference cls->tp_dict, etc.
         * Used for types that arrive via call-Python-and-get-a-type-back
         * paths (namedtuple, PyObject_GetAttrString, ...) — they don't go
         * through PyType_FromModuleAndSpec, so they have no struct otherwise.
         * Idempotent: caches the struct pointer on the class as
         * __wasthon_type_handle__. Returns the handle (struct pointer). */
        ensureTypeStruct: function(cls) {
            if (!cls) return 0;
            if (cls.__wasthon_type_handle__) return cls.__wasthon_type_handle__;
            if (!this._defaultTpAlloc) this._defaultTpAlloc = _wasthon_get_default_tp_alloc();
            if (!this._builtinTpIter)  this._builtinTpIter  = _wasthon_get_builtin_tp_iter();
            if (!this._builtinTpIternext) this._builtinTpIternext = _wasthon_get_builtin_tp_iternext();
            if (!this._brythonTpNew)   this._brythonTpNew   = _wasthon_get_brython_tp_new();
            // PyTypeObject layout (Phase 1, 64 bytes): offset 0 = ob_refcnt,
            // 4 = tp_free, 8 = tp_dict, 12 = tp_name, 16 = tp_alloc,
            // 20 = tp_init, 24 = tp_iter, 28 = tp_as_number, 32 = tp_methods,
            // 36 = tp_traverse, 40 = tp_dealloc, 44 = tp_clear,
            // 48 = tp_version_tag, 52 = tp_repr, 56 = tp_iternext, 60 = tp_new.
            var typeStructPtr = _malloc(64);
            HEAPU8.fill(0, typeStructPtr, typeStructPtr + 64);
            // tp_dict at offset 8: ensure the class has a dict, then wrap.
            var dictObj = this.$B.get_dict(cls);
            if (!dictObj) {
                this.$B.init_dict(cls);
                dictObj = this.$B.get_dict(cls);
            }
            // Pinned: the handle lives in the type struct for the type's
            // whole life — a scope must never release it.
            HEAP32[(typeStructPtr +  8) >> 2] = this.wrapPinned(dictObj);
            // tp_name (offset 12): leaving 0 (NULL) is fine for callers
            // that don't read it.
            HEAP32[(typeStructPtr + 16) >> 2] = this._defaultTpAlloc;  // tp_alloc
            HEAP32[(typeStructPtr + 24) >> 2] = this._builtinTpIter;   // tp_iter
            // tp_iternext (offset 56): C code that reads Py_TYPE(it)->tp_iternext
            // and calls it directly (math.sumprod) needs a non-NULL slot —
            // otherwise an indirect call to null. Installed for every struct
            // for symmetry with tp_iter above; the trampoline raises the right
            // TypeError if the object isn't actually an iterator.
            HEAP32[(typeStructPtr + 56) >> 2] = this._builtinTpIternext;  // tp_iternext
            // tp_new (offset 60): C code that reconstructs instances from a
            // type struct (e.g. _pickle load_newobj `cls->tp_new(cls,args)`)
            // needs a non-NULL tp_new. wasthon_brython_tp_new does
            // cls.__new__(cls, *args) via Brython.
            HEAP32[(typeStructPtr + 60) >> 2] = this._brythonTpNew;     // tp_new
            cls.__wasthon_type_handle__ = typeStructPtr;
            this.handles.set(typeStructPtr, cls);
            // Register a minimal types-map entry so callers that look up
            // via rt.types.get(handle) (PyModule_AddType, etc.) succeed.
            // The full PyType_FromModuleAndSpec entry would also have
            // basicsize/itemsize/flags/slots/methods/getset — for Brython-
            // originating classes those fields are inapplicable.
            /* tp_name is conventionally "module.qualname.LeafName" (dotted).
             * PyModule_AddType wants only the leaf name as the attribute,
             * so split on the last dot here. */
            var fullName = cls.tp_name || (cls.$infos && cls.$infos.__name__) || '<type>';
            var leafIdx = fullName.lastIndexOf('.');
            var shortName = leafIdx >= 0 ? fullName.slice(leafIdx + 1) : fullName;
            // tp_name (offset 12): a C string, so paths that read tp_name
            // (e.g. _pickle's "%.200s" on a class in errors) don't see NULL.
            try {
                var nlen = lengthBytesUTF8(fullName) + 1;
                var nptr = _malloc(nlen);
                stringToUTF8(fullName, nptr, nlen);
                HEAP32[(typeStructPtr + 12) >> 2] = nptr;
            } catch (e) {}
            this.types.set(typeStructPtr, {
                brythonClass: cls,
                shortName: shortName,
                fullName: fullName,
            });
            return typeStructPtr;
        },

        /* Wrap a Brython object as a handle, but if it's a type class give
         * it a struct-backed handle so C code can dereference its fields.
         * Every caller is a new-reference API (PyObject_Call*, GetAttr*),
         * so the non-type fallback seeds a refcount — C code may store the
         * result in a struct with no further INCREF (ownership transfer). */
        wrapMaybeType: function(obj) {
            if (obj && this.$B && this._b_ && this._b_.type) {
                try {
                    if (this.$B.$isinstance(obj, this._b_.type)) {
                        return this.ensureTypeStruct(obj);
                    }
                } catch (_) {}
            }
            return this.wrapNewRef(obj);
        },

        setError: function(excHandle, msg, value) {
            // `value` (optional) is the actual exception INSTANCE. When C built
            // the exception object and set custom attributes on it (pyexpat's
            // ExpatError.code/lineno/offset, OSError.errno, …), we must throw
            // that very object, not a freshly-reconstructed exc(msg) that drops
            // them. pendingExc() returns it when present.
            this.pendingException = { exc: excHandle, msg: msg, value: value || null };
        },

        /* Materialize the pending exception as a throwable Brython object.
         * Prefers the preserved instance (attributes intact); otherwise
         * reconstructs exc(msg). `fallbackExc`, when supplied by a call site
         * that already unwrapped pe.exc, avoids a second unwrap. */
        pendingExc: function(pe, fallbackExc) {
            if (pe && pe.value) return pe.value;
            var exc = fallbackExc || this.unwrap(pe.exc) || this._b_.Exception;
            return this.$B.$call(exc, typeof pe.msg === 'string' ? pe.msg : String(pe.msg));
        },

        /* Coerce obj to a JS number-or-bigint primitive, honoring Python's
         * `__int__`/`__index__` protocol. Returns undefined if the object
         * cannot be converted to an integer. Used by all PyLong_As*
         * variants — without this fallback, instances of int subclasses
         * (IntEnum, IntFlag, user-defined `class X(int)`) fail to convert
         * because they reach C-side as Brython objects, not JS primitives.
         * Mirrors CPython's PyLong_AsLong which dispatches through nb_int. */
        coerceInt: function(obj) {
            if (typeof obj === 'number' || typeof obj === 'bigint') return obj;
            try {
                var n = this._b_.int.$factory(obj);
                if (typeof n === 'number' || typeof n === 'bigint') return n;
            } catch (_) {}
            return undefined;
        },

        /* Forward a caught JS value as the pending Python exception,
         * preserving the original Brython exception class + message
         * instead of flattening everything to RuntimeError/"[object
         * Object]". `e` may be a Brython exception object (has
         * __class__/args), a JS Error, or anything. `fallbackCls` is the
         * Brython class to use when `e` carries no usable class. */
        forwardError: function(e, fallbackCls) {
            var rt = this;
            var cls = fallbackCls || rt._b_.RuntimeError;
            var msg;
            var inst = null;
            try {
                if (e && (e.__class__ || (e.ob_type && e.args !== undefined))) {
                    cls = e.__class__ || rt.$B.get_class(e) || cls;
                    if (e.args && e.args.length > 0) {
                        msg = String(e.args[0]);
                    } else {
                        try { msg = rt.$B.class_name(e); } catch (_) { msg = ''; }
                    }
                    // Preserve the original exception INSTANCE so its attributes
                    // survive the C boundary — pendingExc() re-raises this very
                    // object instead of reconstructing cls(msg). A Python
                    // exception raised across a C call (e.g. re._parser raising
                    // re.PatternError through _sre's compile_template) carries
                    // .msg/.pos/.pattern; reconstructing cls(msg) refed the
                    // already-formatted "msg at position N" string as the
                    // constructor's first arg, so err.msg kept the suffix and
                    // err.pos became None (test_re symbolic_refs/numeric_escape).
                    try {
                        if (rt.$B.$isinstance(e, rt._b_.BaseException)) inst = e;
                    } catch (_) {}
                } else if (e && typeof e.message === 'string') {
                    msg = e.message;
                } else {
                    msg = String(e);
                }
            } catch (_) {
                msg = 'error';
            }
            this.pendingException = { exc: rt.wrap(cls), msg: msg, value: inst };
        },

        // Normalise any Brython str-like to a primitive JS string.
        // Brython represents BMP strings as primitives, but astral-plane
        // strings (codepoints > U+FFFF) and certain str-subclass instances
        // arrive as boxed String wrappers or Brython str objects whose
        // toString gives the codepoint sequence. typeof of those is "object",
        // so a naive `typeof obj === 'string'` check rejects them.
        asJSStr: function(obj) {
            if (typeof obj === 'string') return obj;
            if (obj instanceof String) return obj.valueOf();
            // Brython str-like: has a __class__ of _b_.str and toString/valueOf.
            if (obj && obj.__class__ === this._b_.str) {
                if (typeof obj.valueOf === 'function') {
                    var v = obj.valueOf();
                    if (typeof v === 'string') return v;
                }
                return String(obj);
            }
            // PyUnicode_New placeholder: linear-memory buffer waiting for
            // PyUnicode_1BYTE_DATA + memcpy to populate. Materialize once
            // and cache on the placeholder itself.
            if (obj && obj.__wasthon_unicode_buf__) {
                if (obj.__wasthon_unicode_cached__ !== undefined) {
                    return obj.__wasthon_unicode_cached__;
                }
                var buf = obj.__wasthon_unicode_buf__;
                var size = obj.__wasthon_unicode_size__;
                var kind = obj.__wasthon_unicode_kind__;
                var chars = new Array(size);
                for (var i = 0; i < size; i++) {
                    if (kind === 4)      chars[i] = String.fromCodePoint(HEAPU32[(buf + i * 4) >> 2]);
                    else if (kind === 2) chars[i] = String.fromCodePoint(HEAPU16[(buf + i * 2) >> 1]);
                    else                 chars[i] = String.fromCharCode(HEAPU8[buf + i]);
                }
                obj.__wasthon_unicode_cached__ = chars.join('');
                return obj.__wasthon_unicode_cached__;
            }
            // Brython str-subclass instance (`class S(str)`): the primitive
            // string is boxed in `$brython_value` and `__class__` is the
            // subclass, so the exact check above misses it. CPython's
            // PyUnicode_AsUTF8 accepts str subclasses — a sqlite3
            // `con.isolation_level = CustomStr("DEFERRED")` (test_set_/
            // del_isolation_level) reaches _PyUnicode_AsUTF8NoNUL with one.
            if (obj && obj.$brython_value !== undefined &&
                    this.$B.$isinstance && this.$B.$isinstance(obj, this._b_.str)) {
                var sv = obj.$brython_value;
                if (typeof sv === 'string') return sv;
                if (sv instanceof String) return sv.valueOf();
            }
            return null;
        },

        // Encode a JS string to UTF-8 bytes (Uint8Array). A valid high+low
        // surrogate pair always encodes as the 4-byte astral form. A *lone*
        // surrogate: with surrogatepass=true it becomes its 3-byte CESU
        // sequence (ed a0-bf ..) so it round-trips (pickle's "surrogatepass"
        // handler, paired with DecodeUTF8's CESU path); with
        // surrogatepass=false (CPython's strict default — PyUnicode_AsUTF8,
        // sqlite3 bind) the function returns null so the caller raises
        // UnicodeEncodeError. Pure-BMP strings take the TextEncoder fast path.
        encodeUTF8: function(s, surrogatepass) {
            if (!/[\uD800-\uDFFF]/.test(s)) return new TextEncoder().encode(s);
            var out = [];
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                if (c < 0x80) { out.push(c); }
                else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
                else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
                         s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
                    var c2 = s.charCodeAt(++i);
                    var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
                    out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                             0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
                } else if (c >= 0xD800 && c <= 0xDFFF) {
                    // Lone surrogate.
                    if (!surrogatepass) return null;
                    out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                } else {
                    out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                }
            }
            return new Uint8Array(out);
        },

        // Split a JS string into Unicode codepoints (one entry per astral
        // surrogate pair). wchar_t / Py_UCS4 are 4 bytes, so the materializers
        // want one element per codepoint, not per UTF-16 unit — shared by
        // PyUnicode_AsWideChar / AsWideCharString / AsUCS4 / AsUCS4Copy /
        // 4BYTE_DATA (was copy-pasted five times).
        strCodePoints: function(s) {
            var cps = [];
            for (var i = 0; i < s.length;) {
                var cp = s.codePointAt(i);
                cps.push(cp);
                i += cp > 0xFFFF ? 2 : 1;
            }
            return cps;
        },

        // malloc a NUL-terminated UCS4 buffer holding `cps`; caller owns it.
        mallocUCS4: function(cps) {
            var len = cps.length;
            var ptr = _malloc((len + 1) * 4);
            for (var i = 0; i < len; i++) {
                HEAP32[(ptr + i * 4) >> 2] = cps[i];
            }
            HEAP32[(ptr + len * 4) >> 2] = 0;
            return ptr;
        },

        // Argument crossing C→Brython through a call primitive: a PyUnicode
        // placeholder (linear-memory buffer from PyUnicode_New, populated by
        // C memcpy) is opaque to Python code — _pydecimal.Decimal(u) saw
        // "<Javascript object: [object Object]>". Materialize it to a real
        // JS string; everything else passes through.
        toBrythonArg: function(obj) {
            if (obj && obj.__wasthon_unicode_buf__) {
                var s = this.asJSStr(obj);
                if (s !== null) return s;
            }
            return obj;
        },
    },

    /* --------------------------------------------------------------- *
     * Built-in type constructors & accessors                          *
     * --------------------------------------------------------------- */

    PyBytes_FromStringAndSize__deps: ['$WasthonRT'],
    PyBytes_FromStringAndSize: function(strPtr, size) {
        var rt = WasthonRT;
        if (strPtr === 0) {
            // Writable buffer path (decompressors, codec output, etc.).
            // Back the bytes object directly with linear memory so that
            // PyBytes_AsString returns its pointer without a malloc+copy,
            // and the producer (C) writes straight into the memory the
            // bytes object owns. _PyBytes_Resize materializes the final
            // source array from this buffer in one pass. Net cost on the
            // output path drops from 4 O(n) passes to 3.
            var ptr = _malloc((size | 0) + 1);
            if (ptr === 0) {
                rt.setError(rt.wrap(rt._b_.MemoryError),
                    "PyBytes_FromStringAndSize");
                return 0;
            }
            HEAPU8.fill(0, ptr, ptr + size + 1);
            var src = new Array(size);
            for (var i = 0; i < size; i++) src[i] = 0;
            var bytesObj = rt._b_.bytes.$factory(src);
            bytesObj.__wasthon_cstr__ = ptr;
            bytesObj.__wasthon_cstr_size__ = size;
            return rt.wrapNewRef(bytesObj);
        }
        // Initial-content path: copy from C buffer to JS Array in one pass
        // (skips the Uint8Array → Array.from intermediate).
        var arr = new Array(size);
        for (var i = 0; i < size; i++) arr[i] = HEAPU8[strPtr + i];
        return rt.wrapNewRef(rt._b_.bytes.$factory(arr));
    },

    PyUnicode_FromStringAndSize__deps: ['$WasthonRT'],
    PyUnicode_FromStringAndSize: function(uPtr, size) {
        var rt = WasthonRT;
        if (uPtr === 0) {
            return rt.wrapNewRef("");
        }
        // Decode exactly `size` bytes as UTF-8. UTF8ToString stops at the first
        // embedded NUL even with a size bound (C-string semantics), which
        // truncated text values carrying a '\0' — e.g. sqlite3 returned 'a' for
        // 'a\x00b'. Decode the explicit slice instead; ignoreBOM keeps a leading
        // U+FEFF as data. (size < 0 means NUL-terminated, the old behaviour.)
        if (size < 0) {
            return rt.wrapNewRef(UTF8ToString(uPtr));
        }
        var bytes = HEAPU8.subarray(uPtr, uPtr + size);
        return rt.wrapNewRef(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
    },

    /* PyUnicode_AsUTF8String — encode a str as UTF-8 bytes. Returns a new
     * bytes object. */
    PyUnicode_AsUTF8String__deps: ['$WasthonRT'],
    PyUnicode_AsUTF8String: function(sH) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(sH));
        if (s === null) {
            rt.setError(rt.wrap(rt._b_.TypeError), "PyUnicode_AsUTF8String: not a str");
            return 0;
        }
        var bytes = new TextEncoder().encode(s);
        return rt.wrapNewRef(rt._b_.bytes.$factory(Array.from(bytes)));
    },

    /* PyUnicode_AsUTF8AndSize(s, *size_out) — same as PyUnicode_AsUTF8 but
     * also writes the byte length to *size_out (if non-NULL). The pointer
     * is cached on the string so the call is idempotent. */
    PyUnicode_AsUTF8AndSize__deps: ['$WasthonRT', 'PyUnicode_AsUTF8'],
    PyUnicode_AsUTF8AndSize: function(handle, sizePtr) {
        var rt = WasthonRT;
        var ptr = _PyUnicode_AsUTF8(handle);
        if (ptr === 0) return 0;
        if (sizePtr !== 0) {
            // Read back the cached length: re-encode to compute it (cheap;
            // the JS string is small and we already cached the pointer).
            var s = rt.asJSStr(rt.unwrap(handle));
            HEAP32[sizePtr >> 2] = new TextEncoder().encode(s).length;
        }
        return ptr;
    },

    /* PyUnicode_DecodeUTF8(buf, size, errors) — decode UTF-8 bytes to a
     * Python str. We ignore the errors argument (strict-mode behaviour). */
    PyUnicode_DecodeUTF8__deps: ['$WasthonRT'],
    PyUnicode_DecodeUTF8: function(strPtr, size, errorsPtr) {
        if (strPtr === 0) return WasthonRT.wrapNewRef("");
        /* UTF8ToString stops at the first NUL even with a size bound
         * (C-string semantics) — pickle's BINUNICODE payloads may embed
         * NULs ('\u20ac\x00' lost its tail). Decode the exact slice.
         * surrogatepass: CESU sequences (ed a0-bf ..) must round-trip as
         * lone surrogates, TextDecoder replaces them — slow path only when
         * an 0xED lead byte is present. */
        var sl = HEAPU8.subarray(strPtr, strPtr + size);
        var hasED = false;
        for (var di = 0; di < sl.length; di++) {
            if (sl[di] === 0xED) { hasED = true; break; }
        }
        if (!hasED) {
            // ignoreBOM: true — a leading U+FEFF is data, not a byte-order mark.
            // TextDecoder defaults to stripping it, so a string starting with
            // '﻿' decoded to '' (pickle round-trip of array('u',
            // '...﻿') lost the char). CPython's UTF-8 codec never strips it.
            return WasthonRT.wrapNewRef(
                new TextDecoder('utf-8', { ignoreBOM: true }).decode(sl));
        }
        var chars = [];
        for (var p = 0; p < sl.length;) {
            var b = sl[p];
            if (b < 0x80) { chars.push(b); p += 1; }
            else if ((b & 0xE0) === 0xC0) {
                chars.push(((b & 31) << 6) | (sl[p+1] & 63)); p += 2;
            } else if ((b & 0xF0) === 0xE0) {
                chars.push(((b & 15) << 12) | ((sl[p+1] & 63) << 6) | (sl[p+2] & 63)); p += 3;
            } else {
                var cp = ((b & 7) << 18) | ((sl[p+1] & 63) << 12) |
                         ((sl[p+2] & 63) << 6) | (sl[p+3] & 63);
                cp -= 0x10000;
                chars.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023)); p += 4;
            }
        }
        var parts = [];
        for (var k = 0; k < chars.length; k += 16384) {
            parts.push(String.fromCharCode.apply(null, chars.slice(k, k + 16384)));
        }
        return WasthonRT.wrapNewRef(parts.join(''));
    },

    /* PyUnicode_DecodeASCII — same as UTF8 decode for 0x00-0x7F. */
    PyUnicode_DecodeASCII__deps: ['$WasthonRT'],
    PyUnicode_DecodeASCII: function(strPtr, size, errorsPtr) {
        if (strPtr === 0) return WasthonRT.wrapNewRef("");
        var s = "";
        for (var i = 0; i < size; i++) s += String.fromCharCode(HEAPU8[strPtr + i]);
        return WasthonRT.wrapNewRef(s);
    },

    /* PyUnicode_DecodeLatin1 — each byte maps to its codepoint 1:1. Same
     * shape as DecodeASCII but no 0x7F upper bound — bytes 0x80-0xFF
     * become U+0080..U+00FF, exactly Latin-1. pickle protocol 0 uses
     * this when the Unpickler's `encoding` is 'latin-1'. */
    PyUnicode_DecodeLatin1__deps: ['$WasthonRT'],
    PyUnicode_DecodeLatin1: function(strPtr, size, errorsPtr) {
        if (strPtr === 0) return WasthonRT.wrapNewRef("");
        var s = "";
        for (var i = 0; i < size; i++) s += String.fromCharCode(HEAPU8[strPtr + i]);
        return WasthonRT.wrapNewRef(s);
    },

    /* PyUnicode_AsEncodedString(s, encoding, errors) — encode str via the
     * named codec (utf-8, ascii, latin-1, ...). Delegates to Brython's
     * str.encode which routes through its codec registry. NULL encoding
     * defaults to utf-8 (CPython convention). */
    PyUnicode_AsEncodedString__deps: ['$WasthonRT', 'PyUnicode_AsUTF8String'],
    PyUnicode_AsEncodedString: function(sH, encPtr, errPtr) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(sH));
        if (s === null) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyUnicode_AsEncodedString: not a str");
            return 0;
        }
        var enc = encPtr === 0 ? "utf-8" : UTF8ToString(encPtr);
        var errors = errPtr === 0 ? "strict" : UTF8ToString(errPtr);
        var encNorm = enc.toLowerCase().replace(/_/g, '-');
        if (encNorm === 'utf-8' || encNorm === 'utf8') {
            // Honor the error handler for lone surrogates: "surrogatepass"
            // (and "surrogateescape") CESU-encode them so they round-trip —
            // this is pickle's fallback after the strict PyUnicode_AsUTF8
            // returns NULL. "strict" (default) raises UnicodeEncodeError.
            var sp = (errors === 'surrogatepass' || errors === 'surrogateescape');
            var bytes = rt.encodeUTF8(s, sp);
            if (bytes === null) {
                rt.setError(rt.wrap(rt._b_.UnicodeEncodeError),
                    "'utf-8' codec can't encode character: surrogates not allowed");
                return 0;
            }
            return rt.wrapNewRef(rt._b_.bytes.$factory(Array.from(bytes)));
        }
        try {
            return rt.wrapNewRef(rt.$B.$call(rt.$B.$getattr(s, 'encode'),
                                       enc, errors));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.UnicodeEncodeError),
                "encode " + enc + " failed: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyUnicode_DecodeRawUnicodeEscape(s, size, errors) — decode raw-unicode-
     * escape (CPython 'raw_unicode_escape' codec): only \uXXXX and \UXXXXXXXX
     * sequences are recognised, everything else passes through as Latin-1.
     * pickle protocol 0 uses it for STRING / UNICODE opcodes. */
    PyUnicode_DecodeRawUnicodeEscape__deps: ['$WasthonRT'],
    PyUnicode_DecodeRawUnicodeEscape: function(strPtr, size, errorsPtr) {
        var rt = WasthonRT;
        if (strPtr === 0) return rt.wrapNewRef("");
        var n = size | 0, out = "";
        for (var i = 0; i < n; i++) {
            var c = HEAPU8[strPtr + i];
            if (c === 0x5C /* '\' */ && i + 1 < n) {
                var d = HEAPU8[strPtr + i + 1];
                if (d === 0x75 /* 'u' */ && i + 5 < n) {
                    var hex = "";
                    for (var k = 0; k < 4; k++) hex += String.fromCharCode(HEAPU8[strPtr + i + 2 + k]);
                    var cp = parseInt(hex, 16);
                    if (!isNaN(cp)) { out += String.fromCodePoint(cp); i += 5; continue; }
                } else if (d === 0x55 /* 'U' */ && i + 9 < n) {
                    var hex2 = "";
                    for (var k = 0; k < 8; k++) hex2 += String.fromCharCode(HEAPU8[strPtr + i + 2 + k]);
                    var cp2 = parseInt(hex2, 16);
                    if (!isNaN(cp2) && cp2 <= 0x10FFFF) {
                        out += String.fromCodePoint(cp2); i += 9; continue;
                    }
                }
            }
            // Latin-1 pass-through (including any unmatched backslash).
            out += String.fromCharCode(c);
        }
        return rt.wrapNewRef(out);
    },

    /* PyUnicode_FromEncodedObject(obj, encoding, errors) — decode bytes via
     * the named codec. pickle protocol 0 uses utf-8 by default but the
     * Unpickler accepts custom encoding/errors. Routes through Brython's
     * bytes.decode for codec support beyond utf-8 / ascii / latin-1. */
    PyUnicode_FromEncodedObject__deps: ['$WasthonRT'],
    PyUnicode_FromEncodedObject: function(objH, encPtr, errPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyUnicode_FromEncodedObject: NULL");
            return 0;
        }
        var enc = encPtr === 0 ? "utf-8" : UTF8ToString(encPtr);
        var errors = errPtr === 0 ? "strict" : UTF8ToString(errPtr);
        try {
            return rt.wrapNewRef(rt.$B.$call(rt.$B.$getattr(obj, 'decode'),
                                       enc, errors));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.UnicodeDecodeError),
                "decode " + enc + " failed: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyBytes_DecodeEscape(s, len, errors, unicode, recode_enc) — decode
     * Python bytes string-escape sequences (\xNN, \n, \t, \\, \", \', \r,
     * \a, \b, \f, \v, \0-9 octals). pickle protocol 0 uses this for
     * SHORT_BINSTRING / SHORT_BINBYTES. `errors`/`unicode`/`recode_enc`
     * are CPython-API legacy slots we don't need here — strict mode,
     * bytes output. */
    PyBytes_DecodeEscape__deps: ['$WasthonRT'],
    PyBytes_DecodeEscape: function(strPtr, size, errorsPtr, unicodeFlag, recodePtr) {
        var rt = WasthonRT;
        var n = size | 0;
        var out = [];
        for (var i = 0; i < n; i++) {
            var c = HEAPU8[strPtr + i];
            if (c !== 0x5C /* '\' */) { out.push(c); continue; }
            if (++i >= n) { out.push(0x5C); break; }   // trailing backslash
            var d = HEAPU8[strPtr + i];
            switch (d) {
                case 0x6E: out.push(0x0A); break;       // \n
                case 0x74: out.push(0x09); break;       // \t
                case 0x72: out.push(0x0D); break;       // \r
                case 0x62: out.push(0x08); break;       // \b
                case 0x66: out.push(0x0C); break;       // \f
                case 0x61: out.push(0x07); break;       // \a
                case 0x76: out.push(0x0B); break;       // \v
                case 0x30: case 0x31: case 0x32: case 0x33:
                case 0x34: case 0x35: case 0x36: case 0x37: {
                    // octal: up to 3 digits
                    var v = d - 0x30;
                    for (var k = 0; k < 2 && i + 1 < n; k++) {
                        var nx = HEAPU8[strPtr + i + 1];
                        if (nx >= 0x30 && nx <= 0x37) { v = v * 8 + (nx - 0x30); i++; }
                        else break;
                    }
                    out.push(v & 0xFF);
                    break;
                }
                case 0x78: {                           // \xNN
                    if (i + 2 < n) {
                        var h = String.fromCharCode(HEAPU8[strPtr + i + 1],
                                                    HEAPU8[strPtr + i + 2]);
                        var v2 = parseInt(h, 16);
                        if (!isNaN(v2)) { out.push(v2 & 0xFF); i += 2; break; }
                    }
                    rt.setError(rt.wrap(rt._b_.ValueError),
                        "invalid \\x escape at position " + i);
                    return 0;
                }
                case 0x5C: case 0x27: case 0x22:        // \\ \' \"
                    out.push(d); break;
                default:
                    /* Unknown escape: per CPython, keep the backslash
                     * and the char (`\X` → `\\X`). */
                    out.push(0x5C); out.push(d); break;
            }
        }
        return rt.wrapNewRef(rt._b_.bytes.$factory(out));
    },

    /* PyObject_GetIter(o) — iter(o). */
    PyObject_GetIter__deps: ['$WasthonRT'],
    PyObject_GetIter: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null) return 0;
        try { return rt.wrapNewRef(rt._b_.iter(obj)); }
        catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* PyIter_Next(iter) — next(iter) or NULL at StopIteration. */
    PyIter_Next__deps: ['$WasthonRT'],
    PyIter_Next: function(iterH) {
        var rt = WasthonRT;
        var iter = rt.unwrap(iterH);
        if (iter === null) return 0;
        try { return rt.wrapNewRef(rt._b_.next(iter)); }
        catch (e) {
            // StopIteration: return NULL with NO exception set (CPython contract).
            // Brython's $B.is_exc handles all the type-check edge cases.
            try {
                if (rt.$B.is_exc && rt.$B.is_exc(e, rt._b_.StopIteration)) return 0;
            } catch (_) {}
            // Other exceptions: forward the ORIGINAL exception. forwardError
            // recovers the class via get_class when `__class__` is absent on
            // the raised object (a bare `e.__class__` check fell back to
            // RuntimeError — so an error from a Python iterator's __next__,
            // e.g. array(tc, BadIter()), surfaced as RuntimeError instead of
            // the real type; test_constructor_with_iterable_argument asserts
            // the original error propagates).
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyNumber_Check(o) — int/float/Decimal/etc.? */
    PyNumber_Check__deps: ['$WasthonRT'],
    PyNumber_Check: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (typeof obj === 'number' || typeof obj === 'bigint') return 1;
        if (obj === null || obj === undefined) return 0;
        try {
            return (rt.$B.$isinstance(obj, rt._b_.int) ||
                    rt.$B.$isinstance(obj, rt._b_.float) ||
                    rt.$B.$isinstance(obj, rt._b_.complex)) ? 1 : 0;
        } catch (e) { return 0; }
    },

    /* PyNumber_Float(o) — float(o) coercion. */
    PyNumber_Float__deps: ['$WasthonRT'],
    PyNumber_Float: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        try { return rt.wrapNewRef(rt._b_.float.$factory(obj)); }
        catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* PyObject_VectorcallDict(callable, args, nargs, kwargs) — call with
     * positional args from a contiguous PyObject** buffer + kwargs dict. */
    PyObject_VectorcallDict__deps: ['$WasthonRT'],
    PyObject_VectorcallDict: function(fnH, argsPtr, nargs, kwargsH) {
        var rt = WasthonRT;
        var fn = rt.unwrap(fnH);
        if (!fn) return 0;
        var args = [];
        for (var i = 0; i < nargs; i++) {
            args.push(rt.unwrap(HEAP32[(argsPtr + i * 4) >> 2]));
        }
        // Brython 3.14 expects kwargs in `{$kw: [plain JS map, ...starred]}`
        // form. Passing a Brython dict as the $kw element (the previous
        // shape) made $call drop the kwargs silently (the inner dict was
        // not iterated as a map). Walk our kwDict via .items() to build a
        // plain JS map. Affects e.g. _csv.reader(iter, delimiter='\t')
        // routed through _call_dialect → PyObject_VectorcallDict.
        var kw = kwargsH === 0 ? null : rt.unwrap(kwargsH);
        if (kw) {
            var flat = {};
            try {
                var items_view = rt.$B.$call(rt.$B.$getattr(kw, 'items'));
                var items_list = rt.$B.$call(rt._b_.list, items_view);
                var n = rt._b_.len(items_list);
                for (var i = 0; i < n; i++) {
                    var pair = rt.$B.$getitem(items_list, i);
                    flat[rt.$B.$getitem(pair, 0)] = rt.$B.$getitem(pair, 1);
                }
            } catch (_) { /* empty / unusable dict — pass nothing */ }
            args.push({ $kw: [flat] });
        }
        try { return rt.wrapMaybeType(rt.$B.$call.apply(null, [fn].concat(args))); }
        catch (e) {
            // forwardError, not the bare `e.__class__` read: a Brython
            // exception raised through $B.$call carries ob_type (not
            // __class__), so the bare read flattened every C-raised
            // TypeError to RuntimeError (csv dialect validation et al.).
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyErr_WarnEx — emit a runtime warning through Brython's warnings
     * machinery so assertWarns/catch_warnings actually see it. Returns -1
     * with the exception set when a warnings filter turns it into an
     * error (CPython semantics). */
    PyErr_WarnEx__deps: ['$WasthonRT'],
    PyErr_WarnEx: function(categoryH, msgPtr, stacklevel) {
        var rt = WasthonRT;
        try {
            var msg = UTF8ToString(msgPtr);
            var cat = categoryH ? rt.unwrap(categoryH) : rt._b_.RuntimeWarning;
            var w = rt.$B.imported && rt.$B.imported.warnings;
            if (!w) {
                w = rt.$B.$call(rt._b_.__import__, 'warnings');
            }
            rt.$B.$call(rt.$B.$getattr(w, 'warn'), msg, cat);
            return 0;
        } catch (e) {
            rt.forwardError(e);
            return -1;
        }
    },

    PyUnicode_FromString__deps: ['$WasthonRT'],
    /* PyUnicode_InternFromString — like FromString, but the result is
     * interned: a real content-keyed pool of pinned handles. Interned
     * strings are immortal in CPython 3.12+, and C code stores the result
     * in lazy statics (`static PyObject *str_x`) with no INCREF — so the
     * handle must never be scope-released, and re-interning the same
     * content must not allocate a fresh handle each call. */
    PyUnicode_InternFromString__deps: ['$WasthonRT'],
    PyUnicode_InternFromString: function(uPtr) {
        if (uPtr === 0) return 0;
        var rt = WasthonRT;
        var s = UTF8ToString(uPtr);
        var pool = rt.internPool;
        var h = pool.get(s);
        if (h !== undefined && rt.handles.get(h) === s) return h;
        h = rt.wrapPinned(s);
        pool.set(s, h);
        return h;
    },

    PyUnicode_FromString__deps: ['$WasthonRT'],
    PyUnicode_FromString: function(uPtr) {
        if (uPtr === 0) return 0;
        return WasthonRT.wrapNewRef(UTF8ToString(uPtr));
    },

    PyLong_FromLong__deps: ['$WasthonRT'],
    PyLong_FromLong: function(v) {
        // Brython ints are JS numbers (or BigInt for long). For sha2-scale
        // values, plain JS number is correct.
        return WasthonRT.wrapNewRef(v | 0);
    },

    PyLong_FromUInt32__deps: ['$WasthonRT'],
    PyLong_FromUInt32: function(v) { return WasthonRT.wrapNewRef(v >>> 0); },

    PyLong_FromVoidPtr__deps: ['$WasthonRT'],
    PyLong_FromVoidPtr: function(p) { return WasthonRT.wrapNewRef(p >>> 0); },

    PyBool_FromLong__deps: ['$WasthonRT'],
    PyBool_FromLong: function(v) { return v ? WasthonRT.SLOT_TRUE : WasthonRT.SLOT_FALSE; },

    PyFloat_FromDouble__deps: ['$WasthonRT'],
    PyFloat_FromDouble: function(v) {
        var rt = WasthonRT;
        /* Brython distinguishes int from float at the type level. A JS
         * Number that happens to equal an integer (e.g. 1.0) round-trips
         * as a Python int, which is wrong for math.sqrt(1) etc. Wrap as
         * an explicit _b_.float instance so format strings like `:.6f`
         * find a proper Python float to dispatch on. */
        if (rt._b_ && rt._b_.float && rt._b_.float.$factory) {
            var f = rt._b_.float.$factory(v);
            // Brython 3.14 migrated float to a PyTypeObject mirror (like
            // slice / bool / dict): `$factory` only sets `ob_type`, not
            // `__class__`. But some builtins still look up
            // `obj.__class__.__mro__` (e.g. the `float()` builtin) and
            // crash on undefined. Patch __class__ to point at the same
            // type so both lookup paths work.
            if (f && !f.__class__ && f.ob_type) f.__class__ = f.ob_type;
            return rt.wrapNewRef(f);
        }
        return rt.wrapNewRef(v);
    },

    PyFloat_AsDouble__deps: ['$WasthonRT'],
    PyFloat_AsDouble: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (typeof obj === 'number') return obj;
        if (obj && typeof obj.value === 'number') return obj.value;
        /* Coerce non-floats via Brython's float() constructor — mirrors
         * CPython's PyFloat_AsDouble which calls nb_float / __float__
         * (and falls back to __index__) on non-float operands. Used by
         * math.floor(IntEnum), math.hypot(decimal.Decimal, ...), etc.
         * Same pattern as coerceInt for PyLong_As*. Discovered
         * 2026-05-26 chasing 6 testCeil/Dist/Floor/Hypot/Log1p/ulp fails. */
        try {
            var f = rt._b_.float.$factory(obj);
            if (typeof f === 'number') return f;
            if (f && typeof f.value === 'number') return f.value;
        } catch (e) {
            /* fall through to TypeError below */
        }
        rt.setError(rt.wrap(rt._b_.TypeError),
            "PyFloat_AsDouble: argument is not a float");
        return -1;
    },

    /* PyTime — _random uses this for seeding. Store nanoseconds as i64. */
    PyTime_Time__deps: ['$WasthonRT'],
    PyTime_Time: function(resultPtr) {
        // Date.now() is ms since epoch; nanoseconds = ms * 1e6
        var ms = Date.now();
        var ns = BigInt(ms) * 1000000n;
        HEAP32[ resultPtr      >> 2] = Number(ns & 0xFFFFFFFFn);
        HEAP32[(resultPtr + 4) >> 2] = Number((ns >> 32n) & 0xFFFFFFFFn);
        return 0;
    },

    PyTime_Monotonic__deps: ['$WasthonRT'],
    PyTime_Monotonic: function(resultPtr) {
        var ns = BigInt(Math.floor(performance.now() * 1000000));
        HEAP32[ resultPtr      >> 2] = Number(ns & 0xFFFFFFFFn);
        HEAP32[(resultPtr + 4) >> 2] = Number((ns >> 32n) & 0xFFFFFFFFn);
        return 0;
    },

    /* Random seeding — _random falls back to PyOS_URandomNonblock when no
     * explicit seed is given. Use the WebCrypto RNG. */
    _PyOS_URandom__deps: ['$WasthonRT'],
    _PyOS_URandom: function(bufPtr, size) {
        var view = HEAPU8.subarray(bufPtr, bufPtr + size);
        var CHUNK = 65536;  // crypto.getRandomValues cap
        for (var off = 0; off < size; off += CHUNK) {
            var n = Math.min(CHUNK, size - off);
            crypto.getRandomValues(view.subarray(off, off + n));
        }
        return 0;
    },
    // Declare _PyOS_URandom as a dep so emcc keeps it in the link when
    // only _PyOS_URandomNonblock is referenced from wasm. Without this,
    // tree-shaking drops _PyOS_URandom and the JS-to-JS call below hits
    // `__PyOS_URandom is not defined` at runtime (broke _random.Random()
    // with no explicit seed).
    _PyOS_URandomNonblock__deps: ['$WasthonRT', '_PyOS_URandom'],
    _PyOS_URandomNonblock: function(bufPtr, size) {
        return __PyOS_URandom(bufPtr, size);
    },

    /* 64-bit unsigned converter — _random uses this for seed values. */
    _PyLong_UInt64_Converter__deps: ['$WasthonRT'],
    _PyLong_UInt64_Converter: function(handle, ptr) {
        var obj = WasthonRT.unwrap(handle);
        var bv;
        if (typeof obj === 'number') {
            if (obj < 0) {
                // CPython's clinic UInt converters raise ValueError here
                WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.ValueError),
                    "Cannot convert negative int");
                return 0;
            }
            bv = BigInt(Math.trunc(obj));
        } else if (typeof obj === 'bigint') {
            if (obj < 0n) {
                // CPython's clinic UInt converters raise ValueError here
                WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.ValueError),
                    "Cannot convert negative int");
                return 0;
            }
            bv = obj;
        } else {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.TypeError),
                "an integer is required");
            return 0;
        }
        if (bv > 0xFFFFFFFFFFFFFFFFn) {
            // CPython's _PyLong_UInt64_Converter raises OverflowError rather
            // than truncating; without it getrandbits(2**100) silently used
            // k = low-64-bits = 0 and returned 0 instead of raising.
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.OverflowError),
                "Python int too large to convert to C unsigned long long");
            return 0;
        }
        HEAPU32[ ptr        >> 2] = Number(bv & 0xFFFFFFFFn);
        HEAPU32[(ptr + 4)   >> 2] = Number((bv >> 32n) & 0xFFFFFFFFn);
        return 1;
    },

    _PyLong_UInt32_Converter__deps: ['$WasthonRT'],
    _PyLong_UInt32_Converter: function(handle, ptr) {
        var obj = WasthonRT.unwrap(handle);
        var v;
        if (typeof obj === 'number') v = obj;
        else if (typeof obj === 'bigint') v = Number(obj);
        else {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.TypeError),
                "an integer is required");
            return 0;
        }
        if (v < 0) {
            // CPython's clinic UInt converters raise ValueError here
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.ValueError),
                "Cannot convert negative int");
            return 0;
        }
        if (v > 0xFFFFFFFF) {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.OverflowError),
                "value is too large");
            return 0;
        }
        HEAPU32[ptr >> 2] = v >>> 0;
        return 1;
    },

    _PyArg_BadArgument__deps: ['$WasthonRT'],
    _PyArg_BadArgument: function(fnPtr, dispPtr, expPtr, argH) {
        var rt = WasthonRT;
        var fname = fnPtr ? UTF8ToString(fnPtr) : "function";
        var disp  = dispPtr ? UTF8ToString(dispPtr) : "argument";
        var exp   = expPtr ? UTF8ToString(expPtr) : "?";
        // CPython appends ", not <type>" — "None" for Py_None, else tp_name.
        // Without it, clinic type errors read "… must be str or None" and miss
        // the actual type (test_pyexpat's namespace_separator=int, …).
        var arg = argH ? rt.unwrap(argH) : null;
        var tname;
        if (arg === null || arg === undefined || arg === rt._b_.None) {
            tname = "None";
        } else {
            try { tname = rt.$B.class_name(arg); } catch (_) { tname = "object"; }
        }
        rt.setError(rt.wrap(rt._b_.TypeError),
            fname + "() " + disp + " must be " + exp + ", not " + tname);
        return 0;
    },

    /* List API — Brython list is a JS Array with __class__ = _b_.list. */
    PyList_New__deps: ['$WasthonRT'],
    PyList_New: function(size) {
        var arr = new Array(size | 0);
        for (var i = 0; i < size; i++) arr[i] = WasthonRT._b_.None;
        // Tag as a Brython list: get_class short-circuits Array.isArray
        // BEFORE reading __class__; native lists carry the OB_TYPE Symbol.
        arr[WasthonRT.$B.OB_TYPE] = WasthonRT._b_.list;
        arr.__class__ = WasthonRT._b_.list;
        return WasthonRT.wrapNewRef(arr);
    },

    PyList_Append__deps: ['$WasthonRT'],
    PyList_Append: function(listHandle, itemHandle) {
        var arr = WasthonRT.unwrap(listHandle);
        if (!Array.isArray(arr)) return -1;
        arr.push(WasthonRT.unwrap(itemHandle));
        WasthonRT.incref(itemHandle);  // no-steal: list takes its own ref
        return 0;
    },

    PyList_GetItem__deps: ['$WasthonRT'],
    PyList_GetItem: function(listHandle, i) {
        var arr = WasthonRT.unwrap(listHandle);
        if (!Array.isArray(arr) || i < 0 || i >= arr.length) return 0;
        return WasthonRT.wrap(arr[i]);
    },

    PyList_SetItem__deps: ['$WasthonRT'],
    PyList_SetItem: function(listHandle, i, itemHandle) {
        var arr = WasthonRT.unwrap(listHandle);
        if (!Array.isArray(arr)) return -1;
        arr[i] = WasthonRT.unwrap(itemHandle);
        // Steals the item reference: the JS array now holds the object, the
        // consumed handle ref is dropped (dies with its scope once unowned).
        // Instance-exempt (consumeResultRef): a C instance's refcount-1 now
        // belongs to the container — decref'ing it would fire tp_dealloc.
        WasthonRT.consumeResultRef(itemHandle);
        return 0;
    },

    PyList_Size__deps: ['$WasthonRT'],
    PyList_Size: function(listHandle) {
        var arr = WasthonRT.unwrap(listHandle);
        return Array.isArray(arr) ? arr.length : 0;
    },

    PyList_Sort__deps: ['$WasthonRT'],
    PyList_Sort: function(listHandle) {
        var rt = WasthonRT;
        var arr = rt.unwrap(listHandle);
        if (!Array.isArray(arr)) {
            rt.setError(rt.wrap(rt._b_.TypeError), "PyList_Sort: not a list");
            return -1;
        }
        // Sort with Python's __lt__, not JS's default arr.sort() — the latter
        // stringifies elements lexicographically (wrong for ints/tuples) and
        // throws on Brython objects with no usable toString. _json's encoder
        // sorts a list of (key, value) tuples here under sort_keys=True; the
        // bare arr.sort() produced a corrupt order or threw, surfacing as
        // "tp_call returned NULL" out of the C encoder. A raised TypeError
        // (e.g. unorderable mixed keys) is the faithful CPython behaviour.
        try {
            arr.sort(function (a, b) {
                if (rt.$B.rich_comp('__lt__', a, b)) return -1;
                if (rt.$B.rich_comp('__lt__', b, a)) return 1;
                return 0;
            });
            return 0;
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return -1;
        }
    },

    PyList_Insert__deps: ['$WasthonRT'],
    PyList_Insert: function(listHandle, index, itemHandle) {
        var arr = WasthonRT.unwrap(listHandle);
        if (!Array.isArray(arr)) return -1;
        var n = arr.length;
        var i = index | 0;
        if (i < 0) i = Math.max(0, n + i);
        if (i > n) i = n;
        arr.splice(i, 0, WasthonRT.unwrap(itemHandle));
        WasthonRT.incref(itemHandle);  // no-steal: list takes its own ref
        return 0;
    },

    /* PyList_SetSlice — assigns itemlist (or NULL/empty for deletion) to
     * list[low:high]. Used by heapq.heappop to drop the last element. */
    PyList_SetSlice__deps: ['$WasthonRT'],
    PyList_SetSlice: function(listHandle, low, high, itemHandle) {
        var rt = WasthonRT;
        var arr = rt.unwrap(listHandle);
        if (!Array.isArray(arr)) return -1;
        var n = arr.length;
        var lo = low | 0, hi = high | 0;
        if (lo < 0) lo = Math.max(0, n + lo);
        if (hi < 0) hi = Math.max(0, n + hi);
        lo = Math.min(lo, n);
        hi = Math.min(Math.max(hi, lo), n);
        var src = (itemHandle === 0) ? [] : rt.unwrap(itemHandle);
        if (!Array.isArray(src)) {
            try { src = Array.from(src); } catch (e) { src = []; }
        }
        arr.splice.apply(arr, [lo, hi - lo].concat(src));
        return 0;
    },

    /* Tuple — Brython tuple is a JS array with __class__ = _b_.tuple. */
    PyTuple_New__deps: ['$WasthonRT'],
    PyTuple_New: function(size) {
        /* Brython tuples aren't bare tagged JS Arrays — they go through
         * tuple.$factory which sets up the right repr / equality / hash
         * machinery. Pre-fill with None placeholders that PyTuple_SetItem
         * will overwrite while the C-side builder populates the slots. */
        var rt = WasthonRT;
        var arr = new Array(size | 0);
        for (var i = 0; i < (size | 0); i++) arr[i] = rt._b_.None;
        return rt.wrapNewRef(rt._b_.tuple.$factory(arr));
    },

    PyTuple_SetItem__deps: ['$WasthonRT'],
    PyTuple_SetItem: function(tupH, i, itemH) {
        var rt = WasthonRT;
        var t = rt.unwrap(tupH);
        if (!t) return -1;
        /* Brython tuples store items either directly as JS Array elements
         * (Array.isArray true with .__class__ === tuple) or via an
         * internal field — handle both. */
        var item = rt.unwrap(itemH);
        // Steals the item reference (see PyList_SetItem — instance-exempt).
        if (Array.isArray(t)) { t[i] = item; rt.consumeResultRef(itemH); return 0; }
        if (t[i] !== undefined) { t[i] = item; rt.consumeResultRef(itemH); return 0; }
        return -1;
    },

    PyTuple_GetItem__deps: ['$WasthonRT'],
    PyTuple_GetItem: function(tupH, i) {
        var rt = WasthonRT;
        var t = rt.unwrap(tupH);
        if (!t) return 0;
        try {
            var v = rt.$B.$getitem(t, i);
            return rt.wrap(v);
        } catch (e) {
            // CPython's PyTuple_GetItem sets IndexError ("tuple index out of
            // range") on an out-of-range index. The bridge swallowed it and
            // returned NULL with no pending exception, so a C caller that
            // returns that NULL straight through (sqlite3 row_subscript /
            // row_item) produced `row[bad_index]` with no error raised
            // (test_row_getitem, test_sqlite_row_index). Forward it.
            rt.forwardError(e, rt._b_.IndexError);
            return 0;
        }
    },

    PyTuple_Size__deps: ['$WasthonRT'],
    PyTuple_Size: function(handle) {
        var arr = WasthonRT.unwrap(handle);
        return Array.isArray(arr) ? arr.length : 0;
    },

    /* PyTuple_Pack(n, o1, o2, ..., oN) — varargs tuple constructor. emcc
     * lays out the variadic PyObject* args contiguously after `n` as
     * 4-byte slots. We pull n handles starting at the varargs pointer. */
    PyTuple_Pack__deps: ['$WasthonRT'],
    PyTuple_Pack: function(n, varargs) {
        var rt = WasthonRT;
        var arr = new Array(n);
        for (var i = 0; i < n; i++) {
            var itemH = HEAP32[(varargs + i * 4) >> 2];
            arr[i] = rt.unwrap(itemH);
            rt.incref(itemH);  // no-steal: tuple takes its own ref on each item
        }
        return rt.wrapNewRef(rt._b_.tuple.$factory(arr));
    },

    /* Callable check + call iter. */
    PyCallable_Check__deps: ['$WasthonRT'],
    PyCallable_Check: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        if (typeof obj === 'function' || obj.$is_func) return 1;
        // Brython classes (callable → instantiate), bound methods, and any
        // object exposing __call__ are callable too — defer to callable().
        try { return rt._b_.callable(obj) ? 1 : 0; }
        catch (e) { return 0; }
    },

    PyCallIter_New__deps: ['$WasthonRT'],
    PyCallIter_New: function(callableH, sentinelH) {
        var rt = WasthonRT;
        var fn = rt.unwrap(callableH);
        var sentinel = rt.unwrap(sentinelH);
        if (!fn) return 0;
        // Brython's callable_iterator(fn, sentinel) — emulate with a generator.
        function* gen() {
            while (true) {
                var v = rt.$B.$call(fn);
                if (v === sentinel) return;
                yield v;
            }
        }
        return rt.wrapNewRef(gen());
    },

    /* PyObject_Vectorcall — call with fastcall ABI from C. We translate to
     * a Brython call with the unwrapped args. */
    PyObject_Vectorcall__deps: ['$WasthonRT'],
    PyObject_Vectorcall: function(callableH, argsPtr, nargsf, kwnamesH) {
        var rt = WasthonRT;
        var fn = rt.unwrap(callableH);
        if (fn === null) return 0;
        var nargs = nargsf & 0x7FFFFFFF;  // PY_VECTORCALL_ARGUMENTS_OFFSET mask
        var args = [];
        for (var i = 0; i < nargs; i++) {
            args.push(rt.unwrap(HEAP32[(argsPtr + i * 4) >> 2]));
        }
        // kwnames: a tuple of keyword names whose matching values sit in the
        // args buffer right after the positionals. Forward them through
        // Brython's `$kw` marker so the callee binds them (sqlite3.connect
        // forwards isolation_level=… to the Connection factory this way —
        // dropping kwnames silently skipped the isolation_level validation).
        var kwnames = kwnamesH ? rt.unwrap(kwnamesH) : null;
        if (kwnames && kwnames.length) {
            var kwMap = {};
            for (var k = 0; k < kwnames.length; k++) {
                var nm = rt.asJSStr(kwnames[k]);
                if (nm === null) nm = String(kwnames[k]);
                kwMap[nm] = rt.unwrap(HEAP32[(argsPtr + (nargs + k) * 4) >> 2]);
            }
            args.push({ $kw: [kwMap] });
        }
        try {
            return rt.wrapNewRef(rt.$B.$call.apply(rt.$B, [fn].concat(args)));
        } catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyImport_ImportModuleAttrString — import `modname` then return getattr(mod, attr).
     * For dotted modules (e.g. "collections.abc"), Brython's __import__ without
     * fromlist returns the TOP package ("collections"), not the leaf. Pass the
     * leaf via fromlist so we get the submodule directly. */
    PyImport_ImportModuleAttrString__deps: ['$WasthonRT'],
    PyImport_ImportModuleAttrString: function(modnamePtr, attrPtr) {
        var rt = WasthonRT;
        var modname = UTF8ToString(modnamePtr);
        var attr = UTF8ToString(attrPtr);
        try {
            var imp = rt._b_.__import__;
            var mod;
            if (modname.indexOf('.') !== -1) {
                var parts = modname.split('.');
                var leaf = parts[parts.length - 1];
                mod = imp(modname, rt._b_.None, rt._b_.None,
                          rt._b_.tuple.$factory([leaf]));
                if (mod && mod.__name__ !== modname) {
                    for (var i = 1; i < parts.length; i++) {
                        var sub = rt.$B.$getattr(mod, parts[i], rt._b_.None);
                        if (sub && sub !== rt._b_.None) mod = sub;
                    }
                }
            } else {
                mod = imp(modname);
            }
            return rt.wrapNewRef(rt.$B.$getattr(mod, attr));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.ImportError),
                "wasthon: failed to import " + modname + "." + attr + ": " + (e.message || e));
            return 0;
        }
    },

    /* Bytes — FromObject converts a buffer-like to bytes, Join concatenates. */
    PyBytes_FromObject__deps: ['$WasthonRT'],
    PyBytes_FromObject: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try {
            return rt.wrapNewRef(rt._b_.bytes.$factory(obj));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyBytes_FromObject: cannot convert");
            return 0;
        }
    },

    /* Dict — Brython _b_.dict is a Symbol-keyed object. We use its public
     * functions (str_dict_set / $setitem / $contains / $delitem). */
    PyDict_New__deps: ['$WasthonRT'],
    PyDict_New: function() {
        return WasthonRT.wrapNewRef(WasthonRT.$B.empty_dict());
    },

    PyDict_GetItemWithError__deps: ['$WasthonRT'],
    PyDict_GetItemWithError: function(dictH, keyH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        var k = rt.unwrap(keyH);
        if (!d) return 0;
        try {
            var v = rt._b_.dict.$getitem(d, k);
            return v === undefined ? 0 : rt.wrap(v);
        } catch (e) {
            // KeyError → return NULL with NO exception (per CPython contract).
            return 0;
        }
    },

    PyDict_SetItem__deps: ['$WasthonRT'],
    PyDict_SetItem: function(dictH, keyH, valueH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        var k = rt.unwrap(keyH);
        var v = rt.unwrap(valueH);
        if (!d) return -1;
        try {
            rt._b_.dict.$setitem(d, k, v);
            // CPython contract: SetItem does NOT steal — the dict takes its
            // own ref on key and value. INCREF so a caller's later DECREF
            // doesn't free a value the dict still holds. (No-op for the
            // common sentinel keys/values not tracked in refcounts.)
            rt.incref(keyH);
            rt.incref(valueH);
            return 0;
        } catch (e) {
            // CPython's PyDict_SetItem returns -1 AND sets the exception
            // (e.g. TypeError "unhashable type" for an unhashable key). The
            // bridge swallowed it to a bare -1, so a C caller returning that
            // NULL (sqlite3 register_adapter({}, ...) -> microprotocols_add ->
            // SetItem with a dict in the key tuple) produced no error
            // (test_register_adapter). Forward it.
            rt.forwardError(e, rt._b_.TypeError);
            return -1;
        }
    },

    PyDict_Contains__deps: ['$WasthonRT'],
    PyDict_Contains: function(dictH, keyH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        var k = rt.unwrap(keyH);
        try { return rt._b_.dict.$contains(d, k) ? 1 : 0; } catch (e) { return 0; }
    },

    PyDict_DelItem__deps: ['$WasthonRT'],
    PyDict_DelItem: function(dictH, keyH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        var k = rt.unwrap(keyH);
        // dict.$delitem (the internal primitive, like $setitem/$contains) —
        // dict.__delitem__ is NOT a direct attribute (Brython keeps it in slots),
        // so the old call was `undefined(d,k)` → always -1. _json's encoder bailed
        // on the circular-ref marker cleanup → "tp_call returned NULL" on dumps.
        try { rt._b_.dict.$delitem(d, k); return 0; } catch (e) { return -1; }
    },

    PyDict_Clear__deps: ['$WasthonRT'],
    PyDict_Clear: function(dictH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        if (d === null) return -1;
        try { rt._b_.dict.clear(d); return 0; } catch (e) { return -1; }
    },

    PyDict_Size__deps: ['$WasthonRT'],
    PyDict_Size: function(dictH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        if (d === null) return -1;
        try { return rt._b_.dict.mp_length(d) | 0; } catch (e) { return -1; }
    },

    PyDict_Keys__deps: ['$WasthonRT'],
    PyDict_Keys: function(dictH) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        if (d === null) return 0;
        // Brython 3.14: _b_.dict only exposes a subset of $-prefixed
        // internal methods ($getitem, $setitem, $contains, $factory, …)
        // — the top-level `keys` method isn't there. Go through
        // $getattr to find it via the MRO / type descriptor, same
        // pattern as flattenKwArray uses for `.items()`.
        try {
            var keys_view = rt.$B.$call(rt.$B.$getattr(d, 'keys'));
            return rt.wrapNewRef(rt.$B.$call(rt._b_.list, keys_view));
        }
        catch (e) { return 0; }
    },

    /* PyDict_Pop(dict, key, *result) — remove key, write removed value
     * to *result. Returns 1 on success, 0 if key absent, -1 on error. */
    PyDict_Pop__deps: ['$WasthonRT'],
    PyDict_Pop: function(dictH, keyH, resultPtr) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        var k = rt.unwrap(keyH);
        if (d === null) return -1;
        try {
            if (rt._b_.dict.$contains_string(d, k)) {
                var v = rt._b_.dict.$getitem(d, k);
                rt._b_.dict.$delitem(d, k);
                // The popped value is a new reference handed to the caller.
                if (resultPtr !== 0) HEAP32[resultPtr >> 2] = rt.wrapNewRef(v);
                return 1;
            }
            if (resultPtr !== 0) HEAP32[resultPtr >> 2] = 0;
            return 0;
        } catch (e) {
            if (resultPtr !== 0) HEAP32[resultPtr >> 2] = 0;
            return -1;
        }
    },

    /* PyDict_GetItemRef — like GetItem but with refcount semantics.
     * For us refcount is a no-op; just write the result handle into *result. */
    PyDict_GetItemRef__deps: ['$WasthonRT'],
    PyDict_GetItemRef: function(dictH, keyH, resultPtr) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        var k = rt.unwrap(keyH);
        if (!d) { HEAP32[resultPtr >> 2] = 0; return -1; }
        try {
            var v = rt._b_.dict.$getitem(d, k);
            if (v === undefined) { HEAP32[resultPtr >> 2] = 0; return 0; }
            var h = rt.wrap(v);
            HEAP32[resultPtr >> 2] = h;
            rt.incref(h);  // *Ref API returns a NEW reference (caller DECREFs)
            return 1;
        } catch (e) {
            HEAP32[resultPtr >> 2] = 0;
            return 0;  // not present
        }
    },

    PyObject_GenericSetAttr__deps: ['$WasthonRT'],
    PyObject_GenericSetAttr: function(objH, nameH, valueH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.unwrap(nameH);
        var v = rt.unwrap(valueH);
        try {
            rt._b_.setattr(obj, name, v);
            rt.incref(valueH);  // no-steal: attribute slot takes its own ref
            return 0;
        } catch (e) { return -1; }
    },

    /* PyType_GetSlot — read a slot off a type at runtime. */
    PyType_GetSlot__deps: ['$WasthonRT'],
    PyType_GetSlot: function(typeHandle, slotId) {
        var rt = WasthonRT;
        var info = rt.types.get(typeHandle);
        if (!info || !info.slots) return 0;
        return info.slots[slotId] || 0;
    },

    /* PyType_GetBaseByToken(type, token, *result) — CPython 3.14 stable
     * way to identify "is this object's type a subclass of one I created
     * via PyType_Spec spec X". We stash the spec pointer on each Brython
     * class at PyType_FromModuleAndSpec time as __wasthon_type_token__;
     * here we walk the MRO and pointer-compare. Returns:
     *   1  match found, *result set to that base's type handle (if non-NULL)
     *   0  no match, *result set to 0 (if non-NULL)
     *  -1  error (token == NULL — CPython contract: TypeError)
     */
    PyType_GetBaseByToken__deps: ['$WasthonRT'],
    PyType_GetBaseByToken: function(typeH, token, resultPtr) {
        var rt = WasthonRT;
        if (token === 0) {
            rt.setError(rt.wrap(rt._b_.TypeError), "PyType_GetBaseByToken called with token=NULL");
            if (resultPtr !== 0) HEAP32[resultPtr >> 2] = 0;
            return -1;
        }
        var cls = rt.unwrap(typeH);
        if (cls === null) {
            if (resultPtr !== 0) HEAP32[resultPtr >> 2] = 0;
            return 0;
        }
        // Walk MRO. Brython 3.14 stores it as cls.tp_mro (classes built by
        // make_class / type()); __mro__ only exists on a few legacy builtins
        // ($B.get_mro reads tp_mro ?? __mro__). Reading only __mro__ made the
        // walk a no-op for every Python-defined subclass of a C type.
        var mro = cls.tp_mro || cls.__mro__;
        if (mro) {
            // Include cls itself first.
            if (cls.__wasthon_type_token__ === token) {
                if (resultPtr !== 0) HEAP32[resultPtr >> 2] = cls.__wasthon_type_handle__ || 0;
                return 1;
            }
            for (var i = 0; i < mro.length; i++) {
                var base = mro[i];
                if (base && base.__wasthon_type_token__ === token) {
                    if (resultPtr !== 0) HEAP32[resultPtr >> 2] = base.__wasthon_type_handle__ || 0;
                    return 1;
                }
            }
        } else if (cls.__wasthon_type_token__ === token) {
            if (resultPtr !== 0) HEAP32[resultPtr >> 2] = cls.__wasthon_type_handle__ || 0;
            return 1;
        }
        if (resultPtr !== 0) HEAP32[resultPtr >> 2] = 0;
        return 0;
    },

    /* PyArg_Parse(arg, fmt, &out) — parse ONE object against a format
     * char, write into *out. Critical for arraymodule's per-item type
     * conversion (b_setitem, h_setitem, ... each call PyArg_Parse to coerce
     * an iterable's value into the typed slot before storing it). */
    PyArg_Parse__deps: ['$WasthonRT', 'PyUnicode_AsUTF8', 'PyUnicode_AsUTF8AndSize'],
    PyArg_Parse: function(argH, fmtPtr, varargs) {
        var rt = WasthonRT;
        var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
        var sep = fmt.search(/[:;]/);
        if (sep >= 0) fmt = fmt.slice(0, sep);
        if (fmt.length === 0) return 1;
        var c = fmt[0];
        var arg = rt.unwrap(argH);
        var outPtr = HEAP32[varargs >> 2];
        if (outPtr === 0) return 1;

        if (c === 'O') {
            HEAP32[outPtr >> 2] = argH;
            return 1;
        }
        if (c === 'C') {
            var s = rt.asJSStr(arg);
            if (s === null || s.length !== 1) {
                rt.setError(rt.wrap(rt._b_.TypeError), "expected single char str");
                return 0;
            }
            HEAP32[outPtr >> 2] = s.codePointAt(0) || s.charCodeAt(0);
            return 1;
        }
        if (c === 'w' && fmt[1] === '*') {
            // 'w*' — writable buffer view. Used by _struct.pack_into, whose
            // canonical target is `memoryview(array.array('b', b' '*100))`.
            var vp = outPtr;                                        // &Py_buffer

            // A memoryview is the usual pack_into target; Brython keeps the real
            // object in `.obj`. Unwrap to it. A non-contiguous view (e.g.
            // writable_buf[::2]) cannot host a linear write — reject it, matching
            // CPython's getbuffer(PyBUF_WRITABLE) "not C-contiguous" TypeError.
            var target = arg, targetH = argH;
            if (arg && (arg.ob_type === rt._b_.memoryview ||
                        arg.__class__ === rt._b_.memoryview)) {
                if (arg.contiguous === false || arg.c_contiguous === false) {
                    rt.setError(rt.wrap(rt._b_.TypeError),
                        "memoryview: underlying buffer is not C-contiguous");
                    return 0;
                }
                target = arg.obj;
                targetH = rt.wrap(target);
            }

            // (a) A wasthon buffer-protocol C object (array.array) already keeps
            // its storage in WASM linear memory, so point the Py_buffer straight
            // at ob_item — C writes land in the real array, with no copy and no
            // write-back. wasthon arrayobject keeps ob_item just past VAR_HEAD,
            // at offset 8 (verified by dumping the struct). The exported byte
            // length is len()*itemsize (== CPython array_buffer_getbuf view->len).
            if (target && target.__wasthon_ptr__) {
                var wk = target.__class__;
                var wbuf = wk && (wk.$buffer_protocol || (wk.__mro__ &&
                    wk.__mro__.some(function(b){ return b && b.$buffer_protocol; })));
                if (wbuf) {
                    var aptr = target.__wasthon_ptr__;
                    var obItem = HEAP32[(aptr + 8) >> 2];          // ob_item @ 8
                    // Byte length from Python len()*itemsize (== view->len in
                    // array_buffer_getbuf); avoids reading the raw ob_size word.
                    var nel = rt._b_.len(target);
                    nel = (typeof nel === 'bigint') ? Number(nel)
                        : (nel && nel.value !== undefined ? nel.value : Number(nel));
                    var itsz = rt.$B.$getattr(target, 'itemsize');
                    itsz = (typeof itsz === 'bigint') ? Number(itsz)
                         : (itsz && itsz.value !== undefined ? itsz.value : Number(itsz));
                    HEAP32[(vp +  0) >> 2] = obItem;               // buf (borrowed)
                    HEAP32[(vp +  4) >> 2] = targetH;              // obj
                    HEAP32[(vp +  8) >> 2] = nel * itsz;           // len
                    HEAP32[(vp + 12) >> 2] = 1;                    // itemsize
                    HEAP32[(vp + 16) >> 2] = 0;                    // readonly (writable)
                    HEAP32[(vp + 20) >> 2] = 1;                    // ndim
                    HEAP32[(vp + 24) >> 2] = 0;                    // format
                    HEAP32[(vp + 28) >> 2] = 0;                    // shape
                    HEAP32[(vp + 32) >> 2] = 0;                    // strides
                    HEAP32[(vp + 36) >> 2] = 0;                    // suboffsets
                    HEAP32[(vp + 40) >> 2] = 0;                    // internal
                    // Mark the view borrowed so PyBuffer_Release neither copies
                    // back nor frees ob_item (it belongs to the array).
                    (rt._wasthonBorrowedViews ||
                        (rt._wasthonBorrowedViews = new Set())).add(vp);
                    return 1;
                }
            }

            // (b) A Brython bytearray (writable) or raw Uint8Array: materialize
            // its bytes into linear memory (where C can write); paired with
            // PyBuffer_Release for write-back. A writable buffer is anything
            // exposing `.source` EXCEPT immutable bytes; str / list / None have
            // no `.source`. (Identity vs rt._b_.bytearray is unreliable across
            // realms — compare the class NAME.) Py_buffer = 48 bytes.
            var tn = "?"; try {
                tn = rt.$B.class_name ? rt.$B.class_name(target) :
                     (target && target.__class__ && target.__class__.__name__);
            } catch (e) {}
            var src = null;
            if (target && target.source !== undefined &&
                    target.source !== null && tn !== 'bytes') {
                src = target.source;
            } else if (target instanceof Uint8Array) {
                src = target;
            }
            if (!src) {
                rt.setError(rt.wrap(rt._b_.TypeError),
                    "argument must be read-write bytes-like object, not " +
                    (target === null || target === undefined ? 'None' : tn));
                return 0;
            }
            var blen = src.length;
            var bbuf = _malloc(blen || 1);
            if (bbuf === 0 && blen > 0) {
                rt.setError(rt.wrap(rt._b_.MemoryError), "w* alloc failed");
                return 0;
            }
            try {
                HEAPU8.set(src, bbuf);
            } catch (e) {
                // BigInt elements (see buffer-marshal comment)
                for (var wi = 0; wi < blen; wi++) HEAPU8[bbuf + wi] = Number(src[wi]) & 0xff;
            }
            HEAP32[(vp +  0) >> 2] = bbuf;                          // buf
            HEAP32[(vp +  4) >> 2] = targetH;                      // obj (handle)
            HEAP32[(vp +  8) >> 2] = blen;                          // len
            HEAP32[(vp + 12) >> 2] = 1;                             // itemsize
            HEAP32[(vp + 16) >> 2] = 0;                             // readonly (writable)
            HEAP32[(vp + 20) >> 2] = 1;                             // ndim
            HEAP32[(vp + 24) >> 2] = 0;                             // format
            HEAP32[(vp + 28) >> 2] = 0;                             // shape
            HEAP32[(vp + 32) >> 2] = 0;                             // strides
            HEAP32[(vp + 36) >> 2] = 0;                             // suboffsets
            HEAP32[(vp + 40) >> 2] = 0;                             // internal
            return 1;
        }
        if (c === 's') {
            // 's' — `const char *` from a Python str (UTF-8). The pointer
            // stays valid for the str's lifetime via PyUnicode_AsUTF8's
            // string-keyed cache.
            // 's#' — same, plus byte length written to a second out slot.
            //   unicodedata.lookup uses this: PyArg_Parse(arg, "s#:lookup",
            //   &name, &name_length).
            if (rt.asJSStr(arg) === null) {
                rt.setError(rt.wrap(rt._b_.TypeError),
                    "PyArg_Parse: 's' format expects str (got " + (typeof arg) + ")");
                return 0;
            }
            if (fmt[1] === '#') {
                var lenPtr = HEAP32[(varargs + 4) >> 2];
                HEAP32[outPtr >> 2] = _PyUnicode_AsUTF8AndSize(argH, lenPtr);
            } else {
                HEAP32[outPtr >> 2] = _PyUnicode_AsUTF8(argH);
            }
            return 1;
        }

        // CPython getargs: the INTEGER formats coerce via __index__ only — a
        // float (which has __float__/__int__ but no __index__) is rejected with
        // "'float' object cannot be interpreted as an integer" (array('i')
        // .append(42.0) must raise TypeError). Only the FLOAT formats f/d accept
        // a float / __float__. Brython boxes a Python float as {value:<number>},
        // so the old `.value` fast-path silently truncated floats into int arrays.
        var isFloatFmt = (c === 'f' || c === 'd');
        var n;
        if (typeof arg === 'number')      n = arg;
        else if (typeof arg === 'bigint') n = arg;
        else if (arg === true)            n = 1;
        else if (arg === false)           n = 0;
        else {
            try {
                // $call (not idxFn()): a Brython bound method needs Brython's
                // calling convention; a bare call throws.
                var idxFn = rt.$B.$getattr(arg, '__index__', null);
                if (idxFn) {
                    var iv = rt.$B.$call(idxFn);
                    n = (typeof iv === 'bigint') ? iv :
                        (iv && typeof iv.value === 'number') ? iv.value : Number(iv);
                } else if (isFloatFmt) {
                    if (arg && typeof arg.value === 'number') {
                        n = arg.value;
                    } else {
                        var fFn = rt.$B.$getattr(arg, '__float__', null);
                        if (fFn) {
                            var fv = rt.$B.$call(fFn);
                            n = (fv && typeof fv.value === 'number') ? fv.value : Number(fv);
                        } else {
                            // last-resort coercion: a NaN here means it failed
                            // (e.g. arg was a non-numeric object), NOT a real
                            // float('nan') — a genuine float arrives boxed above.
                            n = Number(arg);
                            if (isNaN(n)) throw new Error("coercion gave NaN");
                        }
                    }
                } else {
                    var cn = "?";
                    try { cn = rt.$B.class_name(arg); } catch (_) {}
                    rt.setError(rt.wrap(rt._b_.TypeError),
                        "'" + cn + "' object cannot be interpreted as an integer");
                    return 0;
                }
                if (typeof n !== 'number' && typeof n !== 'bigint') {
                    throw new Error("coercion produced " + typeof n);
                }
            } catch (e) {
                if (rt.pendingException) return 0;
                rt.setError(rt.wrap(rt._b_.TypeError),
                    "PyArg_Parse: cannot convert (got " + (typeof arg) + ")");
                return 0;
            }
        }

        var num = (typeof n === 'bigint') ? Number(n) : n;
        // CPython getargs.c range-checks the SIGNED integer formats and raises
        // OverflowError; the unsigned/bitfield formats (B,H,I,k,K,n) mask. array's
        // h/i/l/q/B setitems rely on this — e.g. array('i').append(2**31) must
        // raise OverflowError (test_array test_overflow). `n` is the exact value
        // (possibly a bigint), so compare it, not the masked store.
        var oflow = function() {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "PyArg_Parse: integer out of range for format '" + c + "'");
            return 0;
        };
        switch (c) {
            case 'B':
                HEAPU8[outPtr] = num & 0xff;
                break;
            case 'b':   // getargs 'b' == unsigned char [0, UCHAR_MAX]
                if (num < 0 || num > 255) return oflow();
                HEAPU8[outPtr] = num & 0xff;
                break;
            case 'H':
                HEAP16[outPtr >> 1] = num & 0xffff;
                break;
            case 'h':   // signed short
                if (num < -32768 || num > 32767) return oflow();
                HEAP16[outPtr >> 1] = num & 0xffff;
                break;
            case 'I': case 'k': case 'n':
                HEAP32[outPtr >> 2] = num | 0;
                break;
            case 'i': case 'l':   // signed int / long (long is 32-bit on wasm32)
                if (num < -2147483648 || num > 2147483647) return oflow();
                HEAP32[outPtr >> 2] = num | 0;
                break;
            case 'K': case 'q': case 'Q': {
                var bigU = (typeof n === 'bigint') ? n : BigInt(Math.trunc(num));
                if (bigU < 0n) bigU = (1n << 64n) + bigU;
                HEAP32[outPtr >> 2] = Number(bigU & 0xffffffffn);
                HEAP32[(outPtr + 4) >> 2] = Number((bigU >> 32n) & 0xffffffffn);
                break;
            }
            case 'L': {   // signed long long [-2**63, 2**63-1]
                var big = (typeof n === 'bigint') ? n : BigInt(Math.trunc(num));
                if (big < -(1n << 63n) || big > (1n << 63n) - 1n) return oflow();
                if (big < 0n) big = (1n << 64n) + big;
                HEAP32[outPtr >> 2] = Number(big & 0xffffffffn);
                HEAP32[(outPtr + 4) >> 2] = Number((big >> 32n) & 0xffffffffn);
                break;
            }
            case 'f': HEAPF32[outPtr >> 2] = num; break;
            case 'd': HEAPF64[outPtr >> 3] = num; break;
            default:
                rt.setError(rt.wrap(rt._b_.SystemError),
                    "PyArg_Parse: format char '" + c + "' not implemented");
                return 0;
        }
        return 1;
    },

    /* _PyBytesWriter — incremental bytes builder used by _struct for pack.
     * Struct layout (from pycore_bytesobject.h):
     *   +0   PyObject *buffer       (repurposed as raw WASM ptr)
     *   +4   Py_ssize_t allocated
     *   +8   Py_ssize_t min_size
     *   +12  int overallocate
     *   +16  int use_small_buffer  (we ignore — always heap-allocate)
     */
    _PyBytesWriter_Init: function(writerPtr) {
        for (var i = 0; i < 20; i += 4) HEAP32[(writerPtr + i) >> 2] = 0;
    },

    _PyBytesWriter_Alloc: function(writerPtr, size) {
        var alloc = Math.max(64, size | 0);
        var buf = _malloc(alloc);
        HEAP32[ writerPtr      >> 2] = buf;
        HEAP32[(writerPtr + 4) >> 2] = alloc;
        HEAP32[(writerPtr + 8) >> 2] = size | 0;
        return buf;
    },

    _PyBytesWriter_Prepare: function(writerPtr, strPtr, size) {
        var buf  = HEAP32[ writerPtr      >> 2];
        var alloc = HEAP32[(writerPtr + 4) >> 2];
        var written = strPtr - buf;
        var needed = written + (size | 0);
        if (needed <= alloc) return strPtr;
        var newAlloc = Math.max(needed, alloc * 2);
        var newBuf = _malloc(newAlloc);
        HEAPU8.set(HEAPU8.subarray(buf, buf + written), newBuf);
        _free(buf);
        HEAP32[ writerPtr      >> 2] = newBuf;
        HEAP32[(writerPtr + 4) >> 2] = newAlloc;
        return newBuf + written;
    },

    _PyBytesWriter_Resize__deps: ['_PyBytesWriter_Prepare'],
    _PyBytesWriter_Resize: function(writerPtr, strPtr, size) {
        return __PyBytesWriter_Prepare(writerPtr, strPtr,
            (size | 0) - (strPtr - HEAP32[writerPtr >> 2]));
    },

    _PyBytesWriter_Finish__deps: ['$WasthonRT'],
    _PyBytesWriter_Finish: function(writerPtr, strPtr) {
        var rt = WasthonRT;
        var buf = HEAP32[writerPtr >> 2];
        var len = strPtr - buf;
        var arr = Array.from(HEAPU8.subarray(buf, buf + len));
        var bytesObj = rt._b_.bytes.$factory(arr);
        _free(buf);
        HEAP32[writerPtr >> 2] = 0;
        return rt.wrapNewRef(bytesObj);
    },

    _PyBytesWriter_Dealloc: function(writerPtr) {
        var buf = HEAP32[writerPtr >> 2];
        if (buf) {
            _free(buf);
            HEAP32[writerPtr >> 2] = 0;
        }
    },

    PyDictProxy_New__deps: ['$WasthonRT'],
    PyDictProxy_New: function(dictH) {
        // mappingproxy in Brython
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        if (d === null) return 0;
        try { return rt.wrapNewRef(rt.$B.mappingproxy.tp_new(rt.$B.mappingproxy, [d])); }
        catch (e) { return 0; }
    },

    /* PyIndex_Check / PyNumber_AsSsize_t — accept ints */
    PyIndex_Check__deps: ['$WasthonRT'],
    PyIndex_Check: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if ((typeof obj === 'number' && Number.isInteger(obj)) ||
            typeof obj === 'bigint') {
            return 1;
        }
        // A Python object whose type defines __index__ (CPython checks
        // nb_index). The old check only recognized raw JS ints, so
        // struct.pack('i', obj_with___index__) raised "not an integer".
        // Mirror PyNumber_AsSsize_t's __index__ detection below.
        var idx = null;
        try { idx = rt.$B.$getattr(obj, '__index__', null); } catch (e) { idx = null; }
        return idx ? 1 : 0;
    },

    PyNumber_AsSsize_t__deps: ['$WasthonRT'],
    PyNumber_AsSsize_t: function(handle, excH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        // Mirror CPython's PyNumber_AsSsize_t(o, exc): coerce via __index__,
        // then range-check against Py_ssize_t. On overflow, raise `exc` if the
        // caller supplied one (struct.pack_into passes IndexError), else
        // OverflowError. An object WITHOUT __index__ (None, float, str) is a
        // TypeError regardless of `exc` — not the overflow path.
        var big;
        if (typeof obj === 'number' && Number.isInteger(obj)) {
            big = BigInt(obj);
        } else if (typeof obj === 'bigint') {
            big = obj;
        } else {
            var idx = null;
            try { idx = rt.$B.$getattr(obj, '__index__', null); } catch (e) { idx = null; }
            if (!idx) {
                var nm = "?"; try {
                    nm = rt.$B.class_name ? rt.$B.class_name(obj) : typeof obj;
                } catch (e) {}
                rt.setError(rt.wrap(rt._b_.TypeError),
                    "'" + nm + "' object cannot be interpreted as an integer");
                return -1;
            }
            try {
                var iv = rt.$B.$call(idx);
                big = (typeof iv === 'bigint') ? iv
                    : (iv && iv.value !== undefined) ? BigInt(iv.value) : BigInt(iv);
            } catch (e) {
                if (rt.forwardError) rt.forwardError(e, rt._b_.TypeError);
                else rt.setError(rt.wrap(rt._b_.TypeError), "__index__ returned non-int");
                return -1;
            }
        }
        // Py_ssize_t is 32-bit on wasm32 (intptr_t).
        if (big < -2147483648n || big > 2147483647n) {
            if (excH) rt.setError(excH,
                "cannot fit 'int' into an index-sized integer");
            else rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C ssize_t");
            return -1;
        }
        return Number(big);
    },

    _PyLong_GetZero__deps: ['$WasthonRT'],
    _PyLong_GetZero: function() { return WasthonRT.wrap(0); },
    _PyLong_GetOne__deps: ['$WasthonRT'],
    _PyLong_GetOne: function() { return WasthonRT.wrap(1); },

    PyNumber_Absolute__deps: ['$WasthonRT'],
    PyNumber_Absolute: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (typeof obj === 'number') return rt.wrapNewRef(Math.abs(obj));
        if (typeof obj === 'bigint') return rt.wrapNewRef(obj < 0n ? -obj : obj);
        try { return rt.wrapNewRef(rt.$B.$call(rt._b_.abs, obj)); }
        catch (e) { return 0; }
    },

    /* PyType_GetModuleByDef — looks up the module that owns a type, given
     * a module def. Used in the per-module state pattern. We already track
     * type→module via __wasthon_module__; def matching is loose. CPython
     * walks tp_mro — a Python SUBCLASS of a C type (test_decimal subclasses
     * Decimal/Context everywhere) has no __wasthon_module__ of its own, so
     * without the walk get_module_state_by_def(Py_TYPE(self)) returned NULL
     * and _decimal's `assert(mod != NULL)` aborted the whole suite. */
    PyType_GetModuleByDef__deps: ['$WasthonRT'],
    PyType_GetModuleByDef: function(typeHandle, defHandle) {
        var rt = WasthonRT;
        var t = rt.unwrap(typeHandle);
        if (!t) return 0;
        if (t.__wasthon_module__) return t.__wasthon_module__;
        var mro = t.tp_mro || t.__mro__;
        if (mro) {
            for (var i = 0; i < mro.length; i++) {
                if (mro[i] && mro[i].__wasthon_module__) {
                    return mro[i].__wasthon_module__;
                }
            }
        }
        return 0;
    },

    /* PyType_GenericNew — default tp_new that allocates via tp_alloc. */
    PyType_GenericNew__deps: ['$WasthonRT'],
    PyType_GenericNew: function(typeHandle, argsHandle, kwdsHandle) {
        return _wasthon_object_gc_new(typeHandle);
    },

    /* PyObject_Type — return the class of an object. */
    PyObject_Type__deps: ['$WasthonRT'],
    PyObject_Type: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        if (obj.__wasthon_type__) return obj.__wasthon_type__;
        var cls = obj.__class__ || rt.$B.get_class(obj);
        return rt.wrap(cls);
    },

    /* _PyArg_NoKeywords — error if kwargs non-empty. */
    _PyArg_NoKeywords__deps: ['$WasthonRT'],
    _PyArg_NoKeywords: function(fnamePtr, kwHandle) {
        var rt = WasthonRT;
        if (!kwHandle) return 1;
        var kw = rt.unwrap(kwHandle);
        if (kw === null) return 1;
        try {
            if (rt._b_.dict.mp_length(kw) === 0) return 1;
        } catch (e) {}
        var fname = fnamePtr ? UTF8ToString(fnamePtr) : "function";
        rt.setError(rt.wrap(rt._b_.TypeError),
            fname + "() takes no keyword arguments");
        return 0;
    },

    /* _PyArg_NoPositional — error if args has any positional arg. */
    _PyArg_NoPositional__deps: ['$WasthonRT'],
    _PyArg_NoPositional: function(fnamePtr, argsHandle) {
        var rt = WasthonRT;
        if (!argsHandle) return 1;
        var args = rt.unwrap(argsHandle);
        if (args === null || args === undefined) return 1;
        var n = Array.isArray(args) ? args.length :
                (args.length !== undefined ? args.length : 0);
        if (n === 0) return 1;
        var fname = fnamePtr ? UTF8ToString(fnamePtr) : "function";
        rt.setError(rt.wrap(rt._b_.TypeError),
            fname + "() takes no positional arguments");
        return 0;
    },

    _wasthon_Py_SET_SIZE__deps: ['$WasthonRT'],
    _wasthon_Py_SET_SIZE: function(op, size) {
        var rt = WasthonRT;
        var obj = rt.unwrap(op);
        if (obj && obj.__wasthon_ptr__ === op) {
            HEAP32[op >> 2] = size | 0;
            return;
        }
        if (Array.isArray(obj)) {
            // Flush writes made via `&PyList_GET_ITEM(list,0)` (a materialised C
            // buffer disjoint from the Brython array) back into the array before
            // a reader sees it — _sre expand_template's bytes branch fills `out`
            // then `Py_SET_SIZE(list,count); PyBytes_Join(sep,list)`.
            var lb = rt._lastListItems;
            if (lb && lb.arr === obj) {
                var m = Math.min(size | 0, lb.n);
                for (var i = 0; i < m; i++) {
                    obj[i] = rt.unwrap(HEAP32[(lb.ptr + i * 4) >> 2]);
                }
                rt._lastListItems = null;
            }
            if (size < obj.length) obj.length = size;
        }
    },

    /* Py_BuildValue(fmt, ...) — build a Python object from a format string.
     *
     * Each format char consumes one (or two for 64-bit / double) varargs
     * slots. Emscripten passes the trailing `...` as a pointer to a stack
     * buffer (the va_list) in the first arg after fmtPtr; the slot layout
     * follows wasm32 ABI: every arg is 4 bytes, with doubles/L taking 8
     * aligned to 8.
     *
     * Grouping: `(items)` → tuple, `[items]` → list, `{k:v,...}` → dict. */
    Py_BuildValue__deps: ['$WasthonRT'],
    Py_BuildValue: function(fmtPtr, va) {
        var rt = WasthonRT;
        var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
        if (fmt === "" || fmt === "None") return rt.SLOT_NONE;

        var p = va;
        function readInt()    { var v = HEAP32[p >> 2] | 0; p += 4; return v; }
        function readUInt()   { var v = HEAPU8[p] | (HEAPU8[p+1] << 8) | (HEAPU8[p+2] << 16) | (HEAPU8[p+3] << 24); p += 4; return v >>> 0; }
        function readPtr()    { var v = HEAP32[p >> 2] >>> 0; p += 4; return v; }
        function readDouble() { p = (p + 7) & ~7; var v = HEAPF64[p >> 3]; p += 8; return v; }
        function readLong64() { p = (p + 7) & ~7; var lo = HEAP32[p >> 2] >>> 0; var hi = HEAP32[(p+4) >> 2] | 0; p += 8; return BigInt(hi) * 0x100000000n + BigInt(lo); }

        function readOne(i) {
            var c = fmt[i];
            switch (c) {
                case 'O': case 'N': case 'S': {
                    // 'O&' — converter callback: PyObject *conv(void *arg).
                    // Read fn pointer + arg pointer, call conv(arg), use
                    // the returned PyObject* handle. pyexpat's
                    // ProcessingInstruction / Comment handlers use this:
                    // Py_BuildValue("(NO&)", name, conv_string_to_unicode_void, data).
                    if (c === 'O' && fmt[i+1] === '&') {
                        var fnPtr = readPtr();
                        var arg   = readPtr();
                        var resH  = getWasmTableEntry(fnPtr)(arg);
                        var convV = rt.unwrap(resH);
                        rt.consumeResultRef(resH);  // new ref consumed (instance-exempt)
                        return [convV, i+2];
                    }
                    var h = readPtr();
                    var v = rt.unwrap(h);
                    // 'N' steals the reference ('O'/'S' don't). Instance-exempt.
                    if (c === 'N') rt.consumeResultRef(h);
                    return [v, i+1];
                }
                case 's': case 'z': case 'U': {
                    var ptr = readPtr();
                    if (ptr === 0) return [rt._b_.None, i+1];
                    return [UTF8ToString(ptr), i+1];
                }
                case 'y': {
                    var ptr = readPtr();
                    if (ptr === 0) return [rt._b_.None, i+1];
                    return [rt._b_.bytes.$factory(UTF8ToString(ptr)), i+1];
                }
                case 'C':
                    // C int → one-character Python str (Unicode ordinal).
                    return [String.fromCodePoint(readInt()), i+1];
                case 'i': case 'h': case 'b': case 'l':
                    return [readInt(), i+1];
                case 'I': case 'H': case 'B': case 'k':
                    return [readUInt(), i+1];
                case 'L': case 'K': {
                    var big = readLong64();
                    if (big >= -2147483648n && big <= 2147483647n) return [Number(big), i+1];
                    return [big, i+1];
                }
                case 'n':
                    return [readInt(), i+1];
                case 'd': case 'f':
                    return [readDouble(), i+1];
                case '(': case '[': case '{': {
                    var close = c === '(' ? ')' : (c === '[' ? ']' : '}');
                    var items = [];
                    var j = i + 1;
                    while (j < fmt.length && fmt[j] !== close) {
                        var r = readOne(j);
                        items.push(r[0]); j = r[1];
                    }
                    var coll;
                    if (c === '(') coll = rt._b_.tuple.$factory(items);
                    else if (c === '[') coll = items;  /* JS array == Brython list */
                    else {
                        coll = rt.$B.empty_dict ? rt.$B.empty_dict() : rt._b_.dict.$factory();
                        for (var k = 0; k + 1 < items.length; k += 2) {
                            try {
                                if (rt._b_.dict && rt._b_.dict.$setitem)
                                    rt._b_.dict.$setitem(coll, items[k], items[k+1]);
                                else coll[items[k]] = items[k+1];
                            } catch (_) {}
                        }
                    }
                    return [coll, j+1];
                }
                case ',': case ' ': case ':':
                    return [null, i+1];  /* separator, ignored */
                default:
                    throw new Error("Py_BuildValue: unsupported format '" + c + "'");
            }
        }

        try {
            var results = [];
            var i = 0;
            while (i < fmt.length) {
                var r = readOne(i);
                if (r[0] !== null) results.push(r[0]);
                i = r[1];
            }
            if (results.length === 1) return rt.wrapNewRef(results[0]);
            return rt.wrapNewRef(rt._b_.tuple.$factory(results));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "Py_BuildValue(\"" + fmt + "\"): " + (e.message || String(e)));
            return 0;
        }
    },

    /* Sequence access. */
    PySequence_Fast__deps: ['$WasthonRT'],
    PySequence_Fast: function(handle, errmsgPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        // If it's already a list or tuple, pass through. Otherwise build a list.
        if (Array.isArray(obj)) return handle;
        try {
            var arr = rt._b_.list.$factory(obj);
            return rt.wrapNewRef(arr);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                errmsgPtr ? UTF8ToString(errmsgPtr) : "expected a sequence");
            return 0;
        }
    },

    PySequence_Fast_GET_SIZE__deps: ['$WasthonRT'],
    PySequence_Fast_GET_SIZE: function(handle) {
        var arr = WasthonRT.unwrap(handle);
        return Array.isArray(arr) ? arr.length : 0;
    },

    PySequence_Fast_GET_ITEM__deps: ['$WasthonRT'],
    PySequence_Fast_GET_ITEM: function(handle, i) {
        var arr = WasthonRT.unwrap(handle);
        if (!Array.isArray(arr) || i < 0 || i >= arr.length) return 0;
        return WasthonRT.wrap(arr[i]);
    },

    PySequence_Repeat__deps: ['$WasthonRT'],
    PySequence_Repeat: function(handle, count) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        try {
            if (Array.isArray(obj)) {
                var out = [];
                for (var i = 0; i < count; i++) out = out.concat(obj);
                if (obj.__class__) out.__class__ = obj.__class__;
                return rt.wrapNewRef(out);
            }
            if (typeof obj === 'string') return rt.wrapNewRef(obj.repeat(count));
            return 0;
        } catch (e) { return 0; }
    },

    PyObject_Hash__deps: ['$WasthonRT'],
    PyObject_Hash: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try { return rt.$B.$hash(obj) | 0; } catch (e) { return -1; }
    },

    /* PyObject_GenericHash — default tp_hash slot. Same as PyObject_Hash
     * for our purposes (delegate to Brython). */
    PyObject_GenericHash__deps: ['$WasthonRT', 'PyObject_Hash'],
    PyObject_GenericHash: function(handle) { return _PyObject_Hash(handle); },

    PyObject_RichCompareBool__deps: ['$WasthonRT'],
    PyObject_RichCompareBool: function(o1H, o2H, op) {
        var rt = WasthonRT;
        var a = rt.unwrap(o1H);
        var b = rt.unwrap(o2H);
        // Brython 3.14 exposes equality / comparison via $B.rich_comp(op,
        // x, y) where op is a dunder name string. The older $B.$eq is
        // gone — calling it raises "is not a function" and silently
        // breaks any C-side caller (array.__contains__, list.remove,
        // PyDict key lookup, etc.). Identity shortcut still applies for
        // eq/ne since Brython does it internally too.
        try {
            switch (op) {
                case 0: return rt.$B.rich_comp('__lt__', a, b) ? 1 : 0;
                case 1: return rt.$B.rich_comp('__le__', a, b) ? 1 : 0;
                case 2: return (a === b || rt.$B.rich_comp('__eq__', a, b)) ? 1 : 0;
                case 3: return (a !== b && !rt.$B.rich_comp('__eq__', a, b)) ? 1 : 0;
                case 4: return rt.$B.rich_comp('__gt__', a, b) ? 1 : 0;
                case 5: return rt.$B.rich_comp('__ge__', a, b) ? 1 : 0;
                default: return -1;
            }
        } catch (e) {
            return -1;
        }
    },

    /* Internal helpers exposed via pycore_*.h headers. _sre needs these. */
    _PyUnicode_Copy__deps: ['$WasthonRT'],
    _PyUnicode_Copy: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        return (typeof obj === 'string') ? WasthonRT.wrap(obj) : 0;
    },

    _PyUnicode_JoinArray__deps: ['$WasthonRT'],
    _PyUnicode_JoinArray: function(sepH, itemsPtr, count) {
        var rt = WasthonRT;
        var sep = rt.unwrap(sepH);
        // sep may be Py_None (our _Py_STR(empty) sentinel) → use ""
        if (sep === rt._b_.None || typeof sep !== 'string') sep = "";
        var parts = [];
        for (var i = 0; i < count; i++) {
            var h = HEAP32[(itemsPtr + i * 4) >> 2];
            var v = rt.unwrap(h);
            parts.push(typeof v === 'string' ? v : String(v));
        }
        return rt.wrapNewRef(parts.join(sep));
    },

    /* Public PyDict_Next is the 4-arg subset; just forward. */
    PyDict_Next__deps: ['$WasthonRT', '_PyDict_Next'],
    PyDict_Next: function(dictH, pposPtr, pkeyPtr, pvaluePtr) {
        return __PyDict_Next(dictH, pposPtr, pkeyPtr, pvaluePtr, 0);
    },

    _PyDict_Next__deps: ['$WasthonRT'],
    _PyDict_Next: function(dictH, pposPtr, pkeyPtr, pvaluePtr, phashPtr) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictH);
        if (d === null) return 0;
        /* Cache a snapshot of (key, value) pairs on the dict itself so
         * repeated calls iterate consistently. Built via keys+getitem
         * rather than items()-view of-iteration — the view format isn't
         * portable across Brython internals, and pickle's save_dict
         * uses PyDict_Next to walk every item: a bad snapshot means
         * dump-then-load of `{'a':1}` round-trips as `{}`. */
        /* Snapshot cache held in a WeakMap rather than as a property on
         * the dict — keeps the dict's own __dict__ clean so equality
         * comparisons (e.g. round-tripped pickle output) aren't perturbed
         * by leftover iteration state. */
        if (!rt._dictNextSnap) rt._dictNextSnap = new WeakMap();
        var snap = rt._dictNextSnap.get(d);
        if (!snap) {
            snap = [];
            try {
                var items_view = rt.$B.$call(rt.$B.$getattr(d, 'items'));
                var items_list = rt.$B.$call(rt._b_.list, items_view);
                var n = rt._b_.len(items_list);
                for (var i = 0; i < n; i++) {
                    var pair = rt.$B.$getitem(items_list, i);
                    var k = rt.$B.$getitem(pair, 0);
                    var v = rt.$B.$getitem(pair, 1);
                    snap.push([k, v]);
                }
            } catch (e) { return 0; }
            rt._dictNextSnap.set(d, snap);
        }
        var pos = HEAP32[pposPtr >> 2];
        if (pos < 0 || pos >= snap.length) {
            rt._dictNextSnap.delete(d);
            return 0;
        }
        var pair = snap[pos];
        if (pkeyPtr)   HEAP32[pkeyPtr   >> 2] = rt.wrap(pair[0]);
        if (pvaluePtr) HEAP32[pvaluePtr >> 2] = rt.wrap(pair[1]);
        if (phashPtr)  HEAP32[phashPtr  >> 2] = 0;
        HEAP32[pposPtr >> 2] = pos + 1;
        return 1;
    },

    _PyDict_SetItem_KnownHash__deps: ['$WasthonRT'],
    _PyDict_SetItem_KnownHash: function(dictH, keyH, valueH, hash) {
        // Just delegate to regular SetItem — we don't use the hash hint.
        return _PyDict_SetItem(dictH, keyH, valueH);
    },

    PyMapping_Items__deps: ['$WasthonRT'],
    PyMapping_Items: function(handle) {
        var rt = WasthonRT;
        var d = rt.unwrap(handle);
        if (d === null) return 0;
        try {
            // d.items() via Brython attribute lookup. dict.items is NOT a
            // direct JS property on _b_.dict (Brython keeps it in the type's
            // method table, like __delitem__/__mul__), so `rt._b_.dict.items`
            // was undefined → "is not a function" → caught → silent NULL. The
            // C encoder's PyMapping_Items(dct) under sort_keys / for non-exact
            // dicts then returned NULL → "tp_call returned NULL". (OrderedDict
            // happened to work: its pure-Python class exposes items directly.)
            var view = rt.$B.$call(rt.$B.$getattr(d, 'items'));
            return rt.wrapNewRef(rt._b_.list.$factory(view));
        } catch (e) { rt.forwardError(e, rt._b_.RuntimeError); return 0; }
    },

    PyBytes_Join__deps: ['$WasthonRT'],
    PyBytes_Join: function(sepH, seqH) {
        var rt = WasthonRT;
        var sep = rt.unwrap(sepH);
        var seq = rt.unwrap(seqH);
        // _Py_SINGLETON(bytes_empty) maps to Py_None in the bridge — treat it
        // as the empty-bytes separator (mirrors _PyUnicode_JoinArray).
        if (sep === rt._b_.None) sep = rt._b_.bytes.$factory();
        if (!sep || !seq) return 0;
        try {
            var out = sep.join ? sep.join(seq) :
                      rt.$B.$getattr(sep, 'join')(seq);
            return rt.wrapNewRef(out);
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* Bytes accessors. Brython bytes objects store their data in .source as
     * Array<int>. PyBytes_AsString needs to return a C-side pointer; we
     * allocate linear memory once per bytes-object and cache. */
    PyBytes_AsString__deps: ['$WasthonRT'],
    PyBytes_AsString: function(bytesHandle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(bytesHandle);
        if (obj === null) return 0;
        if (obj.__wasthon_cstr__) return obj.__wasthon_cstr__;
        var src = obj.source || obj;
        var len = src.length;
        var ptr = _malloc(len + 1);
        if (src instanceof Uint8Array) HEAPU8.set(src, ptr);
        else for (var i = 0; i < len; i++) {
            // Number() first: a BigInt element makes `x & 0xff` throw
            HEAPU8[ptr + i] = Number(src[i]) & 0xff;
        }
        HEAPU8[ptr + len] = 0;
        try { obj.__wasthon_cstr__ = ptr; } catch (_) {}
        return ptr;
    },

    PyBytes_Size__deps: ['$WasthonRT'],
    PyBytes_Size: function(bytesHandle) {
        var obj = WasthonRT.unwrap(bytesHandle);
        if (obj === null) return 0;
        if (obj.source) return obj.source.length;
        if (obj.length !== undefined) return obj.length;
        return 0;
    },

    /* List items materialisation — used by sre's `&PyList_GET_ITEM(list, 0)`.
     * Allocates a PyObject*[N] in linear memory each call (per-call leak). */
    wasthon_list_items__deps: ['$WasthonRT'],
    wasthon_list_items: function(handle) {
        var rt = WasthonRT;
        var arr = rt.unwrap(handle);
        if (!Array.isArray(arr)) return 0;
        var n = arr.length;
        var ptr = _malloc(Math.max(4, n * 4));
        for (var i = 0; i < n; i++) {
            HEAP32[(ptr + i * 4) >> 2] = rt.wrap(arr[i]);
        }
        // Remember this materialisation so Py_SET_SIZE can flush writes made
        // through `&PyList_GET_ITEM(list,0)` back into the Brython list before
        // it is read (_sre expand_template's bytes path fills `out` then joins
        // the list, not the C buffer).
        rt._lastListItems = { arr: arr, ptr: ptr, n: n };
        return ptr;
    },

    /* Tracked list-items snapshot — used by heapq.
     *
     * Single-slot cache: only the most-recent tracked buffer is retained.
     * Heapq only ever operates on one heap inside a single C-level call,
     * so the latest snapshot is always the active one. On track:
     *   - If the cached (handle, size) match, reuse the buffer as-is. Writes
     *     stay synchronized because `wasthon_list_items_store` updates both
     *     the WASM buffer slot and the Brython list slot in lockstep, so a
     *     same-size buffer for the same handle is always consistent.
     *   - Otherwise free the old buffer (avoiding a leak across calls with
     *     different list handles), malloc a fresh one, and refill it from
     *     the Brython list.
     *
     * Using one slot avoids two pitfalls of a per-handle Map: (1) stale
     * entries accumulating across many calls with different handles, and
     * (2) freed-and-reused `base` addresses colliding with cached entries,
     * which would cause writes to land in the wrong list. */
    wasthon_list_items_track__deps: ['$WasthonRT'],
    wasthon_list_items_track: function(handle) {
        var rt = WasthonRT;
        var arr = rt.unwrap(handle);
        if (!Array.isArray(arr)) return 0;
        var n = arr.length;

        var cached = rt._listTrackCur;
        if (cached && cached.handle === handle) {
            if (cached.size === n) {
                cached.list = arr;
                return cached.base;
            }
            if (n < cached.size) {
                /* Trim (heappop drops the tail). No copy needed: surviving
                 * slots already hold the correct values from prior writes. */
                cached.size = n;
                cached.list = arr;
                return cached.base;
            }
            if (n <= cached.cap) {
                /* Append within current capacity: copy only the new tail
                 * slots from the Brython list. This is the hot path for
                 * heappush: amortised O(1) per growth instead of O(N). */
                for (var i = cached.size; i < n; i++) {
                    HEAP32[(cached.base + i * 4) >> 2] = rt.wrap(arr[i]);
                }
                cached.size = n;
                cached.list = arr;
                return cached.base;
            }
            _free(cached.base);
        } else if (cached) {
            _free(cached.base);
        }

        /* Cold path: allocate with growth headroom to amortise future appends. */
        var cap = Math.max(16, n + (n >> 1) + 8);
        var ptr = _malloc(cap * 4);
        for (var i = 0; i < n; i++) {
            HEAP32[(ptr + i * 4) >> 2] = rt.wrap(arr[i]);
        }
        rt._listTrackCur = { handle: handle, list: arr, base: ptr, size: n, cap: cap };
        return ptr;
    },

    /* Commit a single slot write back to the Brython list.
     *
     * Looks at the single-slot cache, computes the slot index from the
     * pointer offset, and propagates the write to the Brython list. Called
     * from the FT_ATOMIC_STORE_PTR_RELAXED override in pycore_list.h. The
     * WASM buffer slot is also updated so reads from `arr[i]` later in the
     * same C function see the latest value. */
    wasthon_list_items_store__deps: ['$WasthonRT'],
    wasthon_list_items_store: function(slot_ptr, value) {
        var rt = WasthonRT;
        var reg = rt._listTrackCur;
        if (!reg) return;
        var off = slot_ptr - reg.base;
        if (off >= 0 && off < reg.size * 4 && (off & 3) === 0) {
            var idx = off >> 2;
            reg.list[idx] = rt.unwrap(value);
            HEAP32[slot_ptr >> 2] = value;
        }
    },

    /* Py_SIZE — for struct-backed objects (PyObject_VAR_HEAD declares
     * `Py_ssize_t ob_size;` at offset 0) reads the field in linear memory.
     * For JS-side handles (Brython bytes, list, etc.), falls back to the
     * JS-level length. */
    _wasthon_Py_SIZE__deps: ['$WasthonRT'],
    _wasthon_Py_SIZE: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj && obj.__wasthon_ptr__ === handle) {
            return HEAP32[handle >> 2] | 0;
        }
        if (obj === null) return 0;
        if (Array.isArray(obj)) return obj.length;
        if (obj.source) return obj.source.length;
        if (obj.length !== undefined) return obj.length;
        return 0;
    },

    PyLong_FromUnsignedLong__deps: ['$WasthonRT'],
    PyLong_FromUnsignedLong: function(v) { return WasthonRT.wrapNewRef(v >>> 0); },

    PyLong_FromSsize_t__deps: ['$WasthonRT'],
    PyLong_FromSsize_t: function(v) { return WasthonRT.wrapNewRef(v | 0); },

    PyLong_FromSize_t__deps: ['$WasthonRT'],
    PyLong_FromSize_t: function(v) { return WasthonRT.wrapNewRef(v >>> 0); },

    /* _PyLong_GCD(a, b) — Greatest common divisor of two PyLongs.
     * Uses Euclid's algorithm on BigInts. */
    _PyLong_GCD__deps: ['$WasthonRT'],
    _PyLong_GCD: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var b = rt.unwrap(bH);
        function toBig(x) {
            if (typeof x === 'bigint') return x < 0n ? -x : x;
            if (typeof x === 'number') return BigInt(Math.abs(Math.trunc(x)));
            return 0n;
        }
        var aa = toBig(a), bb = toBig(b);
        while (bb !== 0n) { var t = bb; bb = aa % bb; aa = t; }
        var n = Number(aa);
        if (BigInt(n) === aa && Number.isSafeInteger(n)) return rt.wrapNewRef(n);
        return rt.wrapNewRef(aa);
    },

    /* PyFloat_FromString — parse a string into a float. */
    PyFloat_FromString__deps: ['$WasthonRT', 'PyFloat_FromDouble'],
    PyFloat_FromString: function(sH) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(sH));
        if (s === null) {
            rt.setError(rt.wrap(rt._b_.TypeError), "PyFloat_FromString: not a str");
            return 0;
        }
        var v = parseFloat(s);
        if (Number.isNaN(v) && s.trim().toLowerCase() !== 'nan') {
            rt.setError(rt.wrap(rt._b_.ValueError),
                "could not convert string to float: '" + s + "'");
            return 0;
        }
        // Route through PyFloat_FromDouble so the result is wrapped as
        // a proper _b_.float (with both ob_type and __class__) — otherwise
        // Brython sees a raw JS number as a JSObject and `float()` /
        // type() lookups go wrong (e.g. Decimal.__float__ via
        // PyDec_AsFloat → PyFloat_FromString).
        return _PyFloat_FromDouble(v);
    },

    /* _PyLong_NumBits — number of bits required to represent abs(v). */
    _PyLong_NumBits__deps: ['$WasthonRT'],
    _PyLong_NumBits: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        var n;
        if (typeof obj === 'number') n = BigInt(Math.trunc(Math.abs(obj)));
        else if (typeof obj === 'bigint') n = obj < 0n ? -obj : obj;
        else return 0;
        if (n === 0n) return 0;
        var bits = 0;
        while (n > 0n) { n >>= 1n; bits++; }
        return bits;
    },

    /* _PyLong_AsByteArray — serialize an int into an n-byte buffer (two's
     * complement). Used by _struct's standard-mode pack ('<q'/'>q'/…) and by
     * _random's seed array. Raises/returns -1 on a value that doesn't fit in
     * n bytes — the old code (and a duplicate definition that shadowed it)
     * masked silently, so struct.pack('>q', 2**64) wrote a wrapped value
     * instead of raising (test_struct.test_integers). */
    _PyLong_AsByteArray__deps: ['$WasthonRT'],
    _PyLong_AsByteArray: function(handle, bytesPtr, n, littleEndian, isSigned, withExc) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        var v;
        if (typeof obj === 'number') v = BigInt(Math.trunc(obj));
        else if (typeof obj === 'bigint') v = obj;
        else return -1;
        var bits = BigInt(n * 8);
        if (isSigned) {
            var lo = -(1n << (bits - 1n)), hi = (1n << (bits - 1n)) - 1n;
            if (v < lo || v > hi) {
                if (withExc) rt.setError(rt.wrap(rt._b_.OverflowError),
                    "int too big to convert");
                return -1;
            }
            if (v < 0n) v = (1n << bits) + v;   // two's complement
        } else {
            if (v < 0n) {
                if (withExc) rt.setError(rt.wrap(rt._b_.OverflowError),
                    "can't convert negative int to unsigned");
                return -1;
            }
            if (v >= (1n << bits)) {
                if (withExc) rt.setError(rt.wrap(rt._b_.OverflowError),
                    "int too big to convert");
                return -1;
            }
        }
        for (var i = 0; i < n; i++) {
            var byte = Number(v & 0xFFn);
            var off  = littleEndian ? i : (n - 1 - i);
            HEAPU8[bytesPtr + off] = byte;
            v >>= 8n;
        }
        return 0;
    },

    /* PyUnicode_FromFormat — minimal subset. CPython supports a large
     * format vocabulary (%s, %d, %U, %p, etc.). We implement what
     * hmacmodule actually uses: %U (PyObject* as str), %p (pointer). */
    PyUnicode_FromFormat__deps: ['$WasthonRT'],
    /* PyUnicode_FromFormat(fmt, ...) — printf-style format with Python
     * extensions. Variadic args reach us via emcc's va_list ABI: the
     * second formal arg `va` points into linear memory where each
     * variadic value is laid out in order. Read with HEAP32[p>>2] etc.,
     * advancing p by the value's size. WASM ABI promotes char/short to
     * int (4 bytes); long long and double need 8-byte alignment.
     *
     * Supported conversions (covers CPython stdlib usage we've seen):
     *   %s            char* C string (UTF-8)
     *   %d %i         int
     *   %u            unsigned int
     *   %ld %li       long (== int on wasm32)
     *   %lu           unsigned long
     *   %lld %lli     long long
     *   %llu          unsigned long long
     *   %zd %zi       Py_ssize_t (== int on wasm32)
     *   %zu           size_t
     *   %x %X         hex int (lower / upper case)
     *   %lx %zx       hex long / size_t
     *   %c            char (single Unicode codepoint, passed as int)
     *   %p            pointer (rendered as 0x..)
     *   %R            PyObject* -> repr()
     *   %S            PyObject* -> str()
     *   %U %V         PyObject* (Unicode object, used as-is)
     *   %%            literal %
     *
     * Flags / width / precision: minimal — supports `%5d`, `%05d`,
     * `%-5s`, `%.20s`. Long form `%.*s` (precision from int arg) and
     * leading zero padding for ints are honored.
     */
    PyUnicode_FromFormat__deps: ['$WasthonRT'],
    PyUnicode_FromFormat: function(fmtPtr, va) {
        var rt = WasthonRT;
        var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
        var p = va | 0;
        function readInt32()   { var v = HEAP32[p >> 2] | 0; p += 4; return v; }
        function readUInt32()  { var v = HEAP32[p >> 2] >>> 0; p += 4; return v; }
        function readPtr()     { var v = HEAP32[p >> 2] >>> 0; p += 4; return v; }
        function readInt64()   {
            p = (p + 7) & ~7;
            var lo = HEAP32[p >> 2] >>> 0;
            var hi = HEAP32[(p+4) >> 2] | 0;
            p += 8;
            return BigInt(hi) * 0x100000000n + BigInt(lo);
        }
        function readUInt64()  {
            p = (p + 7) & ~7;
            var lo = HEAP32[p >> 2] >>> 0;
            var hi = HEAP32[(p+4) >> 2] >>> 0;
            p += 8;
            return BigInt(hi) * 0x100000000n + BigInt(lo);
        }
        function pad(s, width, leftAlign, zero) {
            if (width <= s.length) return s;
            var fill = zero ? '0' : ' ';
            var padding = fill.repeat(width - s.length);
            return leftAlign ? (s + padding) : (padding + s);
        }
        var out = '';
        var i = 0;
        while (i < fmt.length) {
            var c = fmt.charAt(i);
            if (c !== '%') { out += c; i++; continue; }
            i++; // consume %
            if (i >= fmt.length) { out += '%'; break; }
            // Parse flags
            var leftAlign = false, zero = false;
            while (i < fmt.length) {
                var f = fmt.charAt(i);
                if (f === '-') { leftAlign = true; i++; }
                else if (f === '0') { zero = true; i++; }
                else break;
            }
            // Parse width (digits or *)
            var width = 0;
            while (i < fmt.length && fmt.charAt(i) >= '0' && fmt.charAt(i) <= '9') {
                width = width * 10 + (fmt.charCodeAt(i) - 48);
                i++;
            }
            // Parse precision: . then digits or *
            var precision = -1;
            if (i < fmt.length && fmt.charAt(i) === '.') {
                i++;
                if (fmt.charAt(i) === '*') {
                    precision = readInt32();
                    i++;
                } else {
                    precision = 0;
                    while (i < fmt.length && fmt.charAt(i) >= '0' && fmt.charAt(i) <= '9') {
                        precision = precision * 10 + (fmt.charCodeAt(i) - 48);
                        i++;
                    }
                }
            }
            // Parse length modifier: l, ll, z
            var len = '';
            if (fmt.charAt(i) === 'l') {
                len = 'l'; i++;
                if (fmt.charAt(i) === 'l') { len = 'll'; i++; }
            } else if (fmt.charAt(i) === 'z') {
                len = 'z'; i++;
            }
            // Conversion char
            var conv = fmt.charAt(i); i++;
            var piece = '';
            switch (conv) {
                case '%': piece = '%'; break;
                case 's': {
                    var sp = readPtr();
                    piece = sp === 0 ? '<NULL>' : UTF8ToString(sp);
                    if (precision >= 0 && piece.length > precision) {
                        piece = piece.substring(0, precision);
                    }
                    break;
                }
                case 'd': case 'i': {
                    var iv = (len === 'll') ? readInt64() : readInt32();
                    piece = iv.toString();
                    break;
                }
                case 'u': {
                    var uv = (len === 'll') ? readUInt64() : readUInt32();
                    piece = uv.toString();
                    break;
                }
                case 'x': {
                    var xv = (len === 'll') ? readUInt64() : readUInt32();
                    piece = xv.toString(16);
                    break;
                }
                case 'X': {
                    var xV = (len === 'll') ? readUInt64() : readUInt32();
                    piece = xV.toString(16).toUpperCase();
                    break;
                }
                case 'c': {
                    var cv = readInt32();
                    piece = String.fromCodePoint(cv & 0xFFFFFFFF);
                    break;
                }
                case 'p': {
                    var pv = readPtr();
                    piece = '0x' + pv.toString(16);
                    break;
                }
                case 'R': {
                    var oh = readPtr();
                    var obj = rt.unwrap(oh);
                    try { piece = String(rt._b_.repr(obj)); }
                    catch (e) { piece = '<repr-err>'; }
                    break;
                }
                case 'S': {
                    var oh2 = readPtr();
                    var obj2 = rt.unwrap(oh2);
                    try { piece = String(rt._b_.str.$factory(obj2)); }
                    catch (e) { piece = '<str-err>'; }
                    break;
                }
                case 'U': case 'V': {
                    var oh3 = readPtr();
                    var obj3 = rt.unwrap(oh3);
                    piece = (obj3 == null) ? '' : (typeof obj3 === 'string' ? obj3 : String(obj3));
                    break;
                }
                case 'T': case 'N': {
                    // %T → fully-qualified type name (CPython 3.13+, e.g. "tuple"
                    // or "module.Class"). %N → same but for a PyTypeObject*
                    // argument directly. Used heavily by `_pickle` ("must be
                    // callable, not %T"). Without this, `%T` was emitted
                    // verbatim in error messages — confusing to debug and
                    // breaking ~290 pickle tests that assert on the message.
                    var oh4 = readPtr();
                    var obj4 = rt.unwrap(oh4);
                    var nm;
                    if (conv === 'N') {
                        nm = obj4 && (obj4.tp_name || obj4.__name__);
                    } else {
                        try { nm = rt.$B.class_name(obj4); }
                        catch (e) { nm = null; }
                    }
                    // Coerce to a plain string — `tp_name` is sometimes a
                    // Brython str object (with `__class__`), not a JS primitive,
                    // which `out += piece` stringifies as `[object Object]`.
                    piece = (typeof nm === 'string') ? nm
                          : (nm && typeof nm.valueOf === 'function' && typeof nm.valueOf() === 'string') ? nm.valueOf()
                          : (nm ? String(nm) : '<type>');
                    break;
                }
                default:
                    // Unknown conversion: emit it raw so we notice in tests
                    piece = '%' + conv;
                    break;
            }
            // Apply width (padding) for short pieces. Don't truncate.
            if (width > piece.length) {
                // For string types %s/%R/%S/%U we ignore the zero flag (CPython
                // does too — zero only applies to numerics).
                var useZero = zero && (conv === 'd' || conv === 'i' ||
                                       conv === 'u' || conv === 'x' ||
                                       conv === 'X');
                piece = pad(piece, width, leftAlign, useZero);
            }
            out += piece;
        }
        return rt.wrapNewRef(out);
    },

    PyLong_AsLong__deps: ['$WasthonRT'],
    PyLong_AsLong: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        // CPython's PyLong_AsLong goes through __index__, which floats lack — a
        // float raises TypeError, never a silent truncation. coerceInt would
        // accept it via __int__, so reject floats explicitly (the conversion an
        // INT_HANDLER return like pyexpat's NotStandaloneHandler runs through).
        if (rt.$B.$isinstance(obj, rt._b_.float)) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "'float' object cannot be interpreted as an integer");
            return -1;
        }
        var n = rt.coerceInt(obj);
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return -1;
        }
        // C long is 32-bit on wasm32. The old `| 0` silently truncated, so
        // overflow was undetectable — struct.pack('i'/'l', 2**32) returned 0
        // instead of raising (test_struct.test_integers). Raise OverflowError
        // like CPython, faithful to PyLong_AsUInt32 above.
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < -2147483648n || b > 2147483647n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C long");
            return -1;
        }
        return Number(b);
    },

    PyLong_AsInt__deps: ['$WasthonRT'],
    PyLong_AsInt: function(handle) {
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return -1;
        }
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < -2147483648n || b > 2147483647n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C int");
            return -1;
        }
        return Number(b);
    },

    /* PyLong_AsUInt32(obj, *value) — 0 on success (writes uint32 to
     * *value), -1 on error (TypeError if not int, OverflowError if out of
     * range). New in CPython 3.14; used by cursor.arraysize setter. */
    PyLong_AsUInt32__deps: ['$WasthonRT'],
    PyLong_AsUInt32: function(handle, valuePtr) {
        var rt = WasthonRT;
        var coerced = rt.coerceInt(rt.unwrap(handle));
        if (coerced === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return -1;
        }
        var n = typeof coerced === 'bigint' ? Number(coerced) : coerced;
        if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFFFF) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C uint32_t");
            return -1;
        }
        HEAPU32[valuePtr >> 2] = n >>> 0;
        return 0;
    },

    PyLong_AsUnsignedLong__deps: ['$WasthonRT'],
    PyLong_AsUnsignedLong: function(handle) {
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return 0xFFFFFFFF;
        }
        // CPython raises OverflowError for negative or > ULONG_MAX (the masking
        // variant is PyLong_AsUnsignedLongMask). array's II/LL_setitem and
        // struct rely on this to reject out-of-range unsigned items.
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < 0n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "can't convert negative value to unsigned int");
            return 0xFFFFFFFF;
        }
        if (b > 0xFFFFFFFFn) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C unsigned long");
            return 0xFFFFFFFF;
        }
        return Number(b) >>> 0;
    },

    PyLong_AsUnsignedLongMask__deps: ['$WasthonRT'],
    PyLong_AsUnsignedLongMask: function(handle) {
        // Wrap-around semantics — no error path.
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) return 0;
        if (typeof n === 'bigint') return Number(n & 0xFFFFFFFFn) >>> 0;
        return n >>> 0;
    },

    PyLong_AsSsize_t__deps: ['$WasthonRT'],
    PyLong_AsSsize_t: function(handle) {
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return -1;
        }
        // Py_ssize_t is 32-bit on wasm32. CPython raises OverflowError on a
        // value outside ±2**31; the old code CLAMPED, which masked struct's
        // 'n' overflow (test_struct.test_integers). sys.maxsize is now the
        // faithful PY_SSIZE_T_MAX (2**31-1), so zlib.decompress(data,
        // sys.maxsize) still passes a value that fits — no clamp needed.
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < -2147483648n || b > 2147483647n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C ssize_t");
            return -1;
        }
        return Number(b);
    },

    PyLong_AsSize_t__deps: ['$WasthonRT'],
    PyLong_AsSize_t: function(handle) {
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return 0;
        }
        // size_t is 32-bit unsigned on wasm32: [0, 2**32-1]. Raise on negative
        // or overflow like CPython (was a silent `>>> 0` mask → struct 'N'
        // overflow undetectable).
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < 0n || b > 4294967295n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                b < 0n ? "can't convert negative value to size_t"
                       : "Python int too large to convert to C size_t");
            return 0;
        }
        return Number(b);
    },

    /* PyLong long-long variants. wasm has i64 emulated via i32 pairs at the
     * ABI level — emcc handles this so the JS side sees standard numbers. */
    PyLong_AsLongLong__deps: ['$WasthonRT'],
    PyLong_AsLongLong: function(handle) {
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return 0n;
        }
        // C long long is 64-bit signed. No range check before meant
        // struct.pack('q'/'<q', 2**64) returned a wrapped value instead of
        // raising OverflowError (test_struct.test_integers).
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < -9223372036854775808n || b > 9223372036854775807n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "Python int too large to convert to C long long");
            return 0n;
        }
        return b;
    },

    PyLong_AsUnsignedLongLong__deps: ['$WasthonRT'],
    PyLong_AsUnsignedLongLong: function(handle) {
        var rt = WasthonRT;
        var n = rt.coerceInt(rt.unwrap(handle));
        if (n === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "an integer is required");
            return 0xFFFFFFFFFFFFFFFFn;
        }
        // CPython raises OverflowError for negative or > ULLONG_MAX (the prior
        // code clamped negatives to 0 and abs()'d — wrong). array QQ_setitem
        // relies on this to reject out-of-range unsigned long long items.
        var b = (typeof n === 'bigint') ? n : BigInt(Math.trunc(n));
        if (b < 0n) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "can't convert negative value to unsigned long long");
            return 0xFFFFFFFFFFFFFFFFn;
        }
        if (b > 0xFFFFFFFFFFFFFFFFn) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "int too large to convert to C unsigned long long");
            return 0xFFFFFFFFFFFFFFFFn;
        }
        return b;
    },

    PyLong_FromLongLong__deps: ['$WasthonRT'],
    PyLong_FromLongLong: function(v) {
        // v is a BigInt at the JS boundary. Coalesce to Number only if
        // it's within the safe-integer range (Number conversion of a huge
        // BigInt yields Infinity, and BigInt(Infinity) throws).
        if (typeof v === 'bigint') {
            if (v < -9007199254740992n || v > 9007199254740992n) {
                return WasthonRT.wrapNewRef(v);
            }
            return WasthonRT.wrapNewRef(Number(v));
        }
        return WasthonRT.wrapNewRef(v);
    },

    /* PyLong_FromInt64 — CPython 3.14 explicit-width alias of FromLongLong. */
    PyLong_FromInt64__deps: ['$WasthonRT', 'PyLong_FromLongLong'],
    PyLong_FromInt64: function(v) { return _PyLong_FromLongLong(v); },

    /* ----------------------------------------------------------------
     * PEP 757 — PyLong Export / Writer API (CPython 3.14)
     *
     * Native digit layout chosen for wasm32:
     *   bits_per_digit  = 15
     *   digit_size      = 2  (uint16_t)
     *   digits_order    = -1 (least-significant digit first)
     *   digit_endianness= -1 (little-endian per digit; wasm32 is LE)
     *
     * Matches CPython's 32-bit build, which is what libmpdec's
     * mpd_qimport_u16 / mpd_qexport_u16 path is calibrated for.
     *
     * PyLongExport layout (24 bytes, 8-byte aligned):
     *   +0   int64_t  value       (used when digits == NULL)
     *   +8   uint8_t  negative
     *   +12  Py_ssize_t ndigits
     *   +16  void    *digits      (NULL if value fits in int64)
     *   +20  uintptr_t _reserved  (we stash the malloc ptr here for free)
     *
     * PyLongLayout layout (4 bytes):
     *   +0   uint8_t bits_per_digit
     *   +1   uint8_t digit_size
     *   +2   int8_t  digits_order
     *   +3   int8_t  digit_endianness
     * ---------------------------------------------------------------- */
    PyLong_GetNativeLayout__deps: ['$WasthonRT'],
    PyLong_GetNativeLayout: function() {
        var rt = WasthonRT;
        if (!rt._pyLongLayoutPtr) {
            rt._pyLongLayoutPtr = _malloc(4);
            HEAPU8[rt._pyLongLayoutPtr    ] = 15;  // bits_per_digit
            HEAPU8[rt._pyLongLayoutPtr + 1] =  2;  // digit_size
            HEAP8 [rt._pyLongLayoutPtr + 2] = -1;  // digits_order (LSB-first)
            HEAP8 [rt._pyLongLayoutPtr + 3] = -1;  // digit_endianness (LE)
        }
        return rt._pyLongLayoutPtr;
    },

    PyLong_Export__deps: ['$WasthonRT'],
    PyLong_Export: function(objH, exportPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        // Coerce to BigInt.
        var v;
        if (typeof obj === 'bigint') v = obj;
        else if (typeof obj === 'number') {
            if (!Number.isFinite(obj) || !Number.isSafeInteger(obj)) {
                rt.setError(rt.wrap(rt._b_.TypeError),
                            "PyLong_Export: not an integer");
                return -1;
            }
            v = BigInt(obj);
        } else if (obj === true)  v = 1n;
        else   if (obj === false) v = 0n;
        else {
            rt.setError(rt.wrap(rt._b_.TypeError),
                        "PyLong_Export: not an int");
            return -1;
        }

        // Zero the 24-byte struct first.
        HEAPU8.fill(0, exportPtr, exportPtr + 24);

        var INT64_MAX = 0x7FFFFFFFFFFFFFFFn;
        var INT64_MIN = -(0x8000000000000000n);
        if (v >= INT64_MIN && v <= INT64_MAX) {
            // Fits in int64 — write value, leave digits NULL.
            var asU = v < 0n ? (v + 0x10000000000000000n) : v;
            var lo = Number(asU & 0xFFFFFFFFn);
            var hi = Number((asU >> 32n) & 0xFFFFFFFFn);
            HEAP32[ exportPtr       >> 2] = lo | 0;
            HEAP32[(exportPtr + 4)  >> 2] = hi | 0;
            return 0;
        }

        // Doesn't fit — allocate uint16_t digit buffer, little-endian
        // 15-bit per digit. Sign goes in the `negative` field.
        var neg = v < 0n;
        var n = neg ? -v : v;
        var digits = [];
        while (n > 0n) {
            digits.push(Number(n & 0x7FFFn));
            n >>= 15n;
        }
        if (digits.length === 0) digits.push(0);  // shouldn't happen (fits int64)
        var bufPtr = _malloc(digits.length * 2);
        for (var i = 0; i < digits.length; i++) {
            HEAPU16[(bufPtr + i * 2) >> 1] = digits[i];
        }
        HEAPU8 [exportPtr + 8 ]      = neg ? 1 : 0;
        HEAP32[(exportPtr + 12) >> 2] = digits.length;
        HEAP32[(exportPtr + 16) >> 2] = bufPtr;
        HEAP32[(exportPtr + 20) >> 2] = bufPtr;  // _reserved = same ptr for free
        return 0;
    },

    PyLong_FreeExport__deps: ['$WasthonRT'],
    PyLong_FreeExport: function(exportPtr) {
        var freePtr = HEAP32[(exportPtr + 20) >> 2];
        if (freePtr !== 0) _free(freePtr);
        HEAP32[(exportPtr + 16) >> 2] = 0;
        HEAP32[(exportPtr + 20) >> 2] = 0;
    },

    /* PyLongWriter — caller-driven inverse. Create yields a digit buffer
     * the caller fills; Finish builds the BigInt; Discard aborts.
     *
     * Writer-state layout in linear memory (12 bytes):
     *   +0   void *digits
     *   +4   Py_ssize_t ndigits
     *   +8   int negative
     */
    PyLongWriter_Create__deps: ['$WasthonRT'],
    PyLongWriter_Create: function(negative, ndigits, digitsOutPtr) {
        if (ndigits < 0) return 0;
        var bufPtr = ndigits > 0 ? _malloc(ndigits * 2) : 0;
        if (bufPtr !== 0) HEAPU8.fill(0, bufPtr, bufPtr + ndigits * 2);
        var writer = _malloc(12);
        HEAP32[ writer       >> 2] = bufPtr;
        HEAP32[(writer + 4)  >> 2] = ndigits;
        HEAP32[(writer + 8)  >> 2] = negative ? 1 : 0;
        if (digitsOutPtr !== 0) HEAP32[digitsOutPtr >> 2] = bufPtr;
        return writer;
    },

    PyLongWriter_Finish__deps: ['$WasthonRT'],
    PyLongWriter_Finish: function(writer) {
        var rt = WasthonRT;
        var bufPtr  = HEAP32[ writer       >> 2];
        var ndigits = HEAP32[(writer + 4)  >> 2];
        var negative= HEAP32[(writer + 8)  >> 2];
        // Reconstruct BigInt from little-endian 15-bit digits.
        var n = 0n;
        for (var i = ndigits - 1; i >= 0; i--) {
            n = (n << 15n) | BigInt(HEAPU16[(bufPtr + i * 2) >> 1]);
        }
        if (negative) n = -n;
        if (bufPtr !== 0) _free(bufPtr);
        _free(writer);
        // Coalesce to Number if it fits.
        var asNum = Number(n);
        if (BigInt(asNum) === n && Number.isSafeInteger(asNum)) return rt.wrapNewRef(asNum);
        return rt.wrapNewRef(n);
    },

    PyLongWriter_Discard__deps: ['$WasthonRT'],
    PyLongWriter_Discard: function(writer) {
        var bufPtr = HEAP32[writer >> 2];
        if (bufPtr !== 0) _free(bufPtr);
        _free(writer);
    },

    PyLong_FromUnsignedLongLong__deps: ['$WasthonRT'],
    PyLong_FromUnsignedLongLong: function(v) {
        if (typeof v === 'bigint') {
            // emcc's wasm i64 ABI converts to BigInt with SIGNED
            // interpretation, so values with the high bit set come over
            // as negative. This entry point is explicitly the
            // "from unsigned" one — reinterpret in the [0, 2^64) range.
            if (v < 0n) v = (1n << 64n) + v;
            if (v > 9007199254740992n) return WasthonRT.wrapNewRef(v);
            return WasthonRT.wrapNewRef(Number(v));
        }
        return WasthonRT.wrapNewRef(v);
    },

    PyComplex_FromDoubles__deps: ['$WasthonRT'],
    PyComplex_FromDoubles: function(real, imag) {
        var rt = WasthonRT;
        var c = (rt.$B && rt.$B.make_complex) ? rt.$B.make_complex(real, imag)
                                              : { real: real, imag: imag, __class__: rt._b_.complex };
        return rt.wrapNewRef(c);
    },

    /* PyComplex_FromCComplex(c) — emcc wasm32 ABI passes a struct-by-value
     * via a hidden pointer (sret pattern). The first arg is a pointer to
     * the Py_complex struct (8 bytes: 2 doubles), the second is unused.
     * Read the real/imag doubles from linear memory. */
    PyComplex_FromCComplex__deps: ['$WasthonRT'],
    PyComplex_FromCComplex: function(structPtr) {
        var rt = WasthonRT;
        var real = HEAPF64[(structPtr) >> 3];
        var imag = HEAPF64[(structPtr + 8) >> 3];
        var c = (rt.$B && rt.$B.make_complex) ? rt.$B.make_complex(real, imag)
                                              : { real: real, imag: imag, __class__: rt._b_.complex };
        return rt.wrapNewRef(c);
    },

    PyComplex_Check__deps: ['$WasthonRT'],
    PyComplex_Check: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        if (obj.__class__ === rt._b_.complex) return 1;
        try { return rt.$B.$isinstance(obj, rt._b_.complex) ? 1 : 0; }
        catch (e) { return 0; }
    },

    /* PyObject_IsInstance(o, cls) — Python isinstance(). Returns 1/0/-1. */
    PyObject_IsInstance__deps: ['$WasthonRT'],
    PyObject_IsInstance: function(objH, clsH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var cls = rt.unwrap(clsH);
        if (cls === null) return -1;
        try { return rt.$B.$isinstance(obj, cls) ? 1 : 0; }
        catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return -1;
        }
    },

    /* PyComplex_AsCComplex — extract (real, imag) into a Py_complex struct
     * returned via a hidden pointer in emcc's struct-return ABI. The actual
     * calling convention is: first arg is `ret*`, then `self`. */
    PyComplex_AsCComplex__deps: ['$WasthonRT'],
    PyComplex_AsCComplex: function(retPtr, handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        var real = 0, imag = 0;
        function asNum(v) {
            if (typeof v === 'number') return v;
            if (typeof v === 'bigint') return Number(v);
            if (v && typeof v.value === 'number') return v.value;  /* Brython float */
            if (v && typeof v.value === 'bigint') return Number(v.value);
            return Number(v);
        }
        if (obj && obj.real !== undefined && obj.imag !== undefined) {
            /* Brython complex object: {real: <float wrapper>, imag: <float wrapper>} */
            real = asNum(obj.real);
            imag = asNum(obj.imag);
        } else if (typeof obj === 'number' || typeof obj === 'bigint') {
            real = Number(obj);
        } else if (obj && (typeof obj.value === 'number' || typeof obj.value === 'bigint')) {
            real = Number(obj.value);  /* Brython float */
        } else {
            /* CPython coerces via __complex__, then __float__/__index__; a value
               with none (e.g. a str) raises TypeError instead of silently 0. */
            var m = rt.$B.$getattr(obj, '__complex__', null);
            if (m !== null) {
                var c = rt.$B.$call(m);
                if (! rt.$B.$isinstance(c, rt._b_.complex)) {
                    rt.setError(rt.wrap(rt._b_.TypeError),
                        "__complex__ should return a complex object");
                    real = -1;
                } else {
                    real = asNum(c.real);
                    imag = asNum(c.imag);
                }
            } else {
                m = rt.$B.$getattr(obj, '__float__', null);
                if (m === null) { m = rt.$B.$getattr(obj, '__index__', null); }
                if (m === null) {
                    rt.setError(rt.wrap(rt._b_.TypeError),
                        "must be real number, not " + rt.$B.class_name(obj));
                    real = -1;
                } else {
                    real = asNum(rt.$B.$call(m));
                }
            }
        }
        // Py_complex layout: double real (offset 0), double imag (offset 8)
        var buf = new ArrayBuffer(16);
        var dv = new DataView(buf);
        dv.setFloat64(0, real, true);
        dv.setFloat64(8, imag, true);
        HEAPU8.set(new Uint8Array(buf), retPtr);
    },

    PyLong_AsVoidPtr__deps: ['$WasthonRT'],
    PyLong_AsVoidPtr: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (typeof obj === 'number') return obj >>> 0;
        if (typeof obj === 'bigint') return Number(obj) >>> 0;
        return 0;
    },

    /* Bytearray — Brython _b_.bytearray. */
    PyByteArray_Check__deps: ['$WasthonRT'],
    PyByteArray_Check: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj === null) return 0;
        try { return WasthonRT.$B.$isinstance(obj, WasthonRT._b_.bytearray) ? 1 : 0; }
        catch (e) { return 0; }
    },

    /* PyByteArray_CheckExact — exactly bytearray, not a subclass. Brython
     * doesn't subclass bytearray internally, so this matches Check. */
    PyByteArray_CheckExact__deps: ['$WasthonRT'],
    PyByteArray_CheckExact: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try {
            return (obj.__class__ === rt._b_.bytearray ||
                    rt.$B.$isinstance(obj, rt._b_.bytearray)) ? 1 : 0;
        } catch (e) { return 0; }
    },

    PyByteArray_AsString__deps: ['$WasthonRT'],
    PyByteArray_AsString: function(handle) {
        // Same caching as PyBytes_AsString.
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        if (obj.__wasthon_cstr__) return obj.__wasthon_cstr__;
        var src = obj.source || obj;
        var len = src.length;
        var ptr = _malloc(len + 1);
        if (src instanceof Uint8Array) HEAPU8.set(src, ptr);
        else for (var i = 0; i < len; i++) {
            // Number() first: a BigInt element makes `x & 0xff` throw
            HEAPU8[ptr + i] = Number(src[i]) & 0xff;
        }
        HEAPU8[ptr + len] = 0;
        try { obj.__wasthon_cstr__ = ptr; } catch (_) {}
        return ptr;
    },

    PyByteArray_Size__deps: ['$WasthonRT'],
    PyByteArray_Size: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj === null) return 0;
        if (obj.source) return obj.source.length;
        if (obj.length !== undefined) return obj.length;
        return 0;
    },

    /* PyByteArray_FromStringAndSize(buf, len) — new bytearray from C buffer.
     * NULL buf allocates a zero-filled bytearray of `len` bytes. */
    PyByteArray_FromStringAndSize__deps: ['$WasthonRT'],
    PyByteArray_FromStringAndSize: function(strPtr, size) {
        var rt = WasthonRT;
        var n = size | 0;
        var arr = new Array(n);
        if (strPtr === 0) { for (var i = 0; i < n; i++) arr[i] = 0; }
        else { for (var i = 0; i < n; i++) arr[i] = HEAPU8[strPtr + i]; }
        return rt.wrapNewRef(rt._b_.bytearray.$factory(arr));
    },

    /* PySet_New(iterable) / PyFrozenSet_New(iterable) — NULL means empty. */
    PySet_New__deps: ['$WasthonRT'],
    PySet_New: function(iterableH) {
        var rt = WasthonRT;
        var it = iterableH === 0 ? [] : rt.unwrap(iterableH);
        try { return rt.wrapNewRef(rt._b_.set.$factory(it === null ? [] : it)); }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PySet_New: " + (e.message || String(e)));
            return 0;
        }
    },
    PyFrozenSet_New__deps: ['$WasthonRT'],
    PyFrozenSet_New: function(iterableH) {
        var rt = WasthonRT;
        var it = iterableH === 0 ? [] : rt.unwrap(iterableH);
        try { return rt.wrapNewRef(rt._b_.frozenset.$factory(it === null ? [] : it)); }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyFrozenSet_New: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PySet_Check(o) — isinstance(o, (set, frozenset)). */
    PySet_Check__deps: ['$WasthonRT'],
    PySet_Check: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null) return 0;
        try {
            return rt.$B.$isinstance(obj, [rt._b_.set, rt._b_.frozenset]) ? 1 : 0;
        } catch (e) { return 0; }
    },

    /* PySet_GET_SIZE(s) — count of elements. In CPython this is a macro
     * reading a struct field; here we delegate to len(). */
    PySet_GET_SIZE__deps: ['$WasthonRT'],
    PySet_GET_SIZE: function(setH) {
        var rt = WasthonRT;
        var s = rt.unwrap(setH);
        if (s === null) return 0;
        try { return rt._b_.len(s) | 0; }
        catch (e) { return 0; }
    },

    /* _PySet_NextEntryRef(set, *pos, *key, *hash) — iterate `set` lazily.
     * On entry *pos must be 0; we materialize an iterator cached on the
     * set under __wasthon_iter__ and advance one step per call. Writes
     * the current key handle to *key and a placeholder hash to *hash.
     * Returns 1 if a value was emitted, 0 when exhausted, -1 on error.
     * Used by pickle to serialize set elements deterministically. */
    _PySet_NextEntryRef__deps: ['$WasthonRT'],
    _PySet_NextEntryRef: function(setH, posPtr, keyPtr, hashPtr) {
        var rt = WasthonRT;
        var s = rt.unwrap(setH);
        if (s === null) return -1;
        try {
            /* Brython sets aren't directly index-iterable, so we cache a
             * materialized list of items on the set keyed on the C
             * iteration "session" (any pos == 0 starts fresh). */
            var pos = HEAP32[posPtr >> 2] | 0;
            if (pos === 0) {
                s.__wasthon_iter_items__ = Array.from(s);
            }
            var items = s.__wasthon_iter_items__ || [];
            if (pos >= items.length) {
                s.__wasthon_iter_items__ = null;
                return 0;
            }
            var v = items[pos];
            HEAP32[keyPtr >> 2] = rt.wrapNewRef(v);
            /* Hash: pickle uses it only as an opaque ordering token. */
            if (hashPtr !== 0) HEAP32[hashPtr >> 2] = pos;
            HEAP32[posPtr >> 2] = pos + 1;
            return 1;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "_PySet_NextEntryRef: " + (e.message || String(e)));
            return -1;
        }
    },

    /* _PySet_Update(set, iterable) — set.update(iterable). Returns 0/-1. */
    _PySet_Update__deps: ['$WasthonRT'],
    _PySet_Update: function(setH, iterableH) {
        var rt = WasthonRT;
        var s = rt.unwrap(setH);
        var it = rt.unwrap(iterableH);
        if (s === null) {
            rt.setError(rt.wrap(rt._b_.SystemError), "_PySet_Update: NULL set");
            return -1;
        }
        try {
            rt.$B.$call(rt.$B.$getattr(s, 'update'), it);
            return 0;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "_PySet_Update: " + (e.message || String(e)));
            return -1;
        }
    },

    /* PyType_GenericAlloc / PyObject_GenericGetAttr / PyObject_SelfIter —
     * default slot implementations. We expose C function pointers so they
     * can be installed into PyType_Slot[] arrays at compile time. */
    PyType_GenericAlloc__deps: ['$WasthonRT'],
    PyType_GenericAlloc: function(typeHandle, nitems) {
        return _wasthon_object_gc_new(typeHandle);
    },

    PyObject_GenericGetAttr__deps: ['$WasthonRT'],
    PyObject_GenericGetAttr: function(objH, nameH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.unwrap(nameH);
        // CPython contract: a NULL return must leave the exception set. Forward
        // the real one ($getattr raises AttributeError on a genuine miss, but a
        // descriptor getter may raise anything — e.g. _struct's s_get_format
        // raises RuntimeError on an uninitialized Struct). Swallowing it and
        // returning a bare NULL made the caller (the tp_getattro wrapper)
        // synthesize a generic AttributeError, masking the real exception.
        try { return rt.wrapNewRef(rt.$B.$getattr(obj, name)); }
        catch (e) { rt.forwardError(e, rt._b_.AttributeError); return 0; }
    },

    PyObject_SelfIter__deps: ['$WasthonRT'],
    PyObject_SelfIter: function(handle) { return handle; },

    /* _PyType_Name — return the short name of a type. */
    _PyType_Name__deps: ['$WasthonRT'],
    _PyType_Name: function(typeHandle) {
        var rt = WasthonRT;
        var t = rt.unwrap(typeHandle);
        if (!t || !t.tp_name) return 0;
        // Returns a C string pointer — cache one per type.
        if (t.__wasthon_name_cstr__) return t.__wasthon_name_cstr__;
        var bytes = new TextEncoder().encode(t.tp_name);
        var ptr = _malloc(bytes.length + 1);
        HEAPU8.set(bytes, ptr);
        HEAPU8[ptr + bytes.length] = 0;
        t.__wasthon_name_cstr__ = ptr;
        return ptr;
    },

    /* PyUnicode_AsASCIIString — encode str to bytes, ASCII-only. */
    PyUnicode_AsASCIIString__deps: ['$WasthonRT'],
    PyUnicode_AsASCIIString: function(handle) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(handle));
        if (s === null) {
            rt.setError(rt.wrap(rt._b_.TypeError), "expected str");
            return 0;
        }
        var arr = [];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c > 0x7F) {
                rt.setError(rt.wrap(rt._b_.UnicodeEncodeError),
                    "non-ASCII character at index " + i);
                return 0;
            }
            arr.push(c);
        }
        return rt.wrapNewRef(rt._b_.bytes.$factory(arr));
    },

    /* IEEE 754 pack/unpack — DataView handles 32/64 bit natively; 16-bit
     * half-precision is done manually. _struct's e/f/d format codes. */
    PyFloat_Pack4__deps: ['$WasthonRT'],
    PyFloat_Pack4: function(x, ptr, le) {
        // CPython raises OverflowError when a finite value rounds to inf in
        // float32 (test_struct.test_705836). Math.fround rounds to float32.
        if (!isFinite(Math.fround(x)) && isFinite(x)) {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.OverflowError),
                "float too large to pack with f format");
            return -1;
        }
        var buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, x, !!le);
        HEAPU8.set(new Uint8Array(buf), ptr);
        return 0;
    },
    PyFloat_Pack8__deps: ['$WasthonRT'],
    PyFloat_Pack8: function(x, ptr, le) {
        var buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, x, !!le);
        HEAPU8.set(new Uint8Array(buf), ptr);
        return 0;
    },
    PyFloat_Unpack4__deps: ['$WasthonRT'],
    PyFloat_Unpack4: function(ptr, le) {
        var buf = new ArrayBuffer(4);
        new Uint8Array(buf).set(HEAPU8.subarray(ptr, ptr + 4));
        return new DataView(buf).getFloat32(0, !!le);
    },
    PyFloat_Unpack8__deps: ['$WasthonRT'],
    PyFloat_Unpack8: function(ptr, le) {
        var buf = new ArrayBuffer(8);
        new Uint8Array(buf).set(HEAPU8.subarray(ptr, ptr + 8));
        return new DataView(buf).getFloat64(0, !!le);
    },
    /* Half-precision (IEEE 754 binary16). Direct double→binary16 with
     * round-half-to-even, faithful to CPython's _PyFloat_Pack2 (validated
     * bit-exact on 4024 differential cases). The old code went via float32
     * (double-rounding), flushed every subnormal to zero, and never raised on
     * overflow — test_struct.test_half_float + test_705836's 'e' asserts.
     * Divisions/multiplications by powers of two are exact in fp, so the
     * round-to-even sees exact values (no spurious ties). */
    PyFloat_Pack2__deps: ['$WasthonRT'],
    PyFloat_Pack2: function(x, ptr, le) {
        var rt = WasthonRT;
        function roundHalfEven(v) {
            var fl = Math.floor(v), d = v - fl;
            if (d < 0.5) return fl;
            if (d > 0.5) return fl + 1;
            return (fl % 2 === 0) ? fl : fl + 1;   // tie → even
        }
        var sign = (x < 0 || Object.is(x, -0)) ? 0x8000 : 0;
        var half;
        if (x !== x) {                                   // NaN
            half = sign | 0x7E00;
        } else {
            var ax = Math.abs(x);
            if (ax === Infinity) {                       // inf packs as inf
                half = sign | 0x7C00;
            } else if (ax === 0) {
                half = sign;
            } else {
                var e = Math.floor(Math.log2(ax));
                while (Math.pow(2, e) > ax) e--;         // refine log2 imprecision
                while (Math.pow(2, e + 1) <= ax) e++;
                if (e < -14) {                           // subnormal range
                    var r = roundHalfEven(ax / Math.pow(2, -24));
                    half = (r >= 1024) ? (sign | (1 << 10)) : (sign | r);
                } else if (e <= 15) {                    // normal range
                    var m = roundHalfEven((ax / Math.pow(2, e) - 1) * 1024);
                    if (m === 1024) { m = 0; e += 1; }   // mantissa carry
                    if (e > 15) {
                        rt.setError(rt.wrap(rt._b_.OverflowError),
                            "float too large to pack with e format");
                        return -1;
                    }
                    half = sign | ((e + 15) << 10) | m;
                } else {                                 // overflow
                    rt.setError(rt.wrap(rt._b_.OverflowError),
                        "float too large to pack with e format");
                    return -1;
                }
            }
        }
        HEAPU8[ptr + (le ? 0 : 1)] = half & 0xFF;
        HEAPU8[ptr + (le ? 1 : 0)] = (half >> 8) & 0xFF;
        return 0;
    },
    PyFloat_Unpack2__deps: ['$WasthonRT'],
    PyFloat_Unpack2: function(ptr, le) {
        var b0 = HEAPU8[ptr + (le ? 0 : 1)];
        var b1 = HEAPU8[ptr + (le ? 1 : 0)];
        var half = (b1 << 8) | b0;
        var sign = (half & 0x8000) ? -1 : 1;
        var exp = (half >> 10) & 0x1F;
        var mant = half & 0x3FF;
        if (exp === 0x1F) return mant ? NaN : sign * Infinity;
        if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024);
        return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
    },

    /* Clinic-generated glue (e.g. sha3module) uses this converter to
     * read an unsigned-long argument into a C variable. Signature:
     *     int _PyLong_UnsignedLong_Converter(PyObject *obj, void *ptr);
     * Returns 1 on success (stores u32 at *ptr), 0 on failure (sets exc). */
    _PyLong_UnsignedLong_Converter__deps: ['$WasthonRT'],
    _PyLong_UnsignedLong_Converter: function(handle, ptr) {
        var obj = WasthonRT.unwrap(handle);
        var v;
        if (typeof obj === 'number') v = obj;
        else if (typeof obj === 'bigint') v = Number(obj);
        else {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.TypeError),
                "an integer is required");
            return 0;
        }
        if (v < 0) {
            // pycore's _PyLong_Unsigned*_Converter raises ValueError for
            // negatives ("value must be positive"), NOT OverflowError.
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.ValueError),
                "value must be positive");
            return 0;
        }
        if (v > 0xFFFFFFFF) {
            // PyLong_AsUnsignedLong overflow (unsigned long = u32 on wasm32);
            // silently truncating let blake2 leaf_size=1<<32 through as 0.
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.OverflowError),
                "Python int too large to convert to C unsigned long");
            return 0;
        }
        HEAPU32[ptr >> 2] = v >>> 0;
        return 1;
    },

    /* Positional argument count check used by clinic glue for fixed-arity
     * functions. Returns 1 if min ≤ nargs ≤ max, else sets TypeError and
     * returns 0. */
    _PyArg_CheckPositional__deps: ['$WasthonRT'],
    _PyArg_CheckPositional: function(fnamePtr, nargs, min, max) {
        var rt = WasthonRT;
        if (nargs < min || nargs > max) {
            var fname = fnamePtr ? UTF8ToString(fnamePtr) : "function";
            var expected = (min === max) ? min : (min + " to " + max);
            rt.setError(rt.wrap(rt._b_.TypeError),
                fname + "() takes " + expected + " positional arguments but " + nargs + " were given");
            return 0;
        }
        return 1;
    },

    /* Py_GetConstant — returns interned singletons. CPython 3.14 API. */
    Py_GetConstant__deps: ['$WasthonRT'],
    Py_GetConstant: function(id) {
        var rt = WasthonRT;
        switch (id) {
            case 0: return rt.SLOT_NONE;
            case 1: return rt.SLOT_FALSE;
            case 2: return rt.SLOT_TRUE;
            case 3: return rt.wrapNewRef(rt._b_.Ellipsis);
            case 4: return rt.wrapNewRef(rt._b_.NotImplemented);
            case 5: return rt.wrapNewRef(0);
            case 6: return rt.wrapNewRef(1);
            case 7: return rt.wrapNewRef("");
            case 8: return rt.wrapNewRef(rt._b_.bytes.$factory([]));
            case 9: return rt.wrapNewRef([]);  // empty tuple
            default: return 0;
        }
    },

    /* Py_FatalError — irrecoverable. Log loudly and abort. */
    Py_FatalError__deps: ['$WasthonRT'],
    Py_FatalError: function(msgPtr) {
        var msg = msgPtr ? UTF8ToString(msgPtr) : "(no message)";
        console.error("[wasthon] Py_FatalError:", msg);
        throw new Error("Py_FatalError: " + msg);
    },

    /* Py_HashBuffer — simple FNV-like hash for keying _Py_hashtable_t entries. */
    Py_HashBuffer__deps: ['$WasthonRT'],
    Py_HashBuffer: function(ptr, len) {
        var h = 2166136261 >>> 0;
        for (var i = 0; i < len; i++) {
            h = Math.imul(h ^ HEAPU8[ptr + i], 16777619) >>> 0;
        }
        return h | 0;  // signed for Py_hash_t
    },

    /* PyErr_NewExceptionWithDoc — same as PyErr_NewException, doc ignored. */
    PyErr_NewExceptionWithDoc__deps: ['$WasthonRT', 'PyErr_NewException'],
    PyErr_NewExceptionWithDoc: function(namePtr, docPtr, baseHandle, dictHandle) {
        return _PyErr_NewException(namePtr, baseHandle, dictHandle);
    },

    /* PyErr_NewException — create a Brython subclass of `base`. */
    PyErr_NewException__deps: ['$WasthonRT'],
    PyErr_NewException: function(namePtr, baseHandle, dictHandle) {
        var rt = WasthonRT;
        var name = UTF8ToString(namePtr);
        rt.trace('PyErr_NewException', name);
        var dotIdx = name.lastIndexOf('.');
        var shortName = dotIdx >= 0 ? name.slice(dotIdx + 1) : name;
        var base = baseHandle ? rt.unwrap(baseHandle) : rt._b_.Exception;
        // `base` may be a single class or a tuple/array of classes. Brython's
        // make_builtin_class expects a flat array of classes; flatten if
        // the caller passed a tuple of bases (PyTuple_Pack pattern).
        var bases;
        if (Array.isArray(base)) {
            bases = base;
        } else if (base && base.__class__ === rt._b_.tuple) {
            bases = Array.from(base);
        } else {
            bases = [base];
        }
        var cls = rt.$B.make_builtin_class(shortName, bases);
        /* CPython: type(e).__name__ is the SHORT name; the module prefix
         * lives in __module__. make_builtin_class already set tp_name =
         * shortName — don't overwrite with the dotted name. */
        if (dotIdx >= 0) cls.__module__ = name.slice(0, dotIdx);

        /* Rebuild a full MRO from the primary base's tp_mro. make_builtin_class
         * builds a naive 3-element MRO [cls, base, object] that drops the
         * base's own ancestors — `except Exception` then misses leaf
         * exceptions in a deep hierarchy like
         * PicklingError <- PickleError <- Exception. */
        (function() {
            var primary = bases[0];
            if (!primary) return;
            var baseMro = primary.tp_mro ||
                (primary.__mro__ ? [primary].concat(primary.__mro__)
                                 : [primary, rt._b_.object]);
            var mro = [cls];
            for (var k = 0; k < baseMro.length; k++) {
                if (mro.indexOf(baseMro[k]) === -1) mro.push(baseMro[k]);
            }
            if (mro.indexOf(rt._b_.object) === -1) mro.push(rt._b_.object);
            cls.tp_mro = mro;
            cls.tp_bases = bases;
            cls.tp_base = primary;
        })();

        /* Attribute machinery: make_builtin_class skips it, so PyObject_
         * SetAttr / GetAttr / hasattr would all fail on the exception
         * (e.g. when sqlite/pickle attach metadata to the raised one). */
        if (!cls.tp_setattro) cls.tp_setattro = rt._b_.object.tp_setattro;
        if (!cls.tp_getattro) cls.tp_getattro = rt._b_.object.tp_getattro;
        if (!cls.$getattribute) cls.$getattribute = rt._b_.object.tp_getattro;

        /* Brython's type instantiation reads cls.tp_new and then
         * unconditionally touches new_func.$is_slot — so an `undefined`
         * tp_new throws "$is_slot of undefined" before even reaching the
         * intended exception. Inherit tp_new from the MRO (ends at
         * BaseException). Same for tp_init: Brython does
         *   if (init_func !== NULL && init_func !== object.tp_init)
         *       init_func.call(...);
         * so an undefined tp_init crashes on `.call`. */
        if (cls.tp_new === undefined) {
            var mro = cls.tp_mro || bases || [];
            for (var bi = 0; bi < mro.length; bi++) {
                if (mro[bi] && mro[bi].tp_new !== undefined) {
                    cls.tp_new = mro[bi].tp_new; break;
                }
            }
            if (cls.tp_new === undefined) {
                cls.tp_new = (rt._b_.BaseException &&
                              rt._b_.BaseException.tp_new) ||
                             rt._b_.object.tp_new;
            }
        }
        if (cls.tp_init === undefined) {
            var mroI = cls.tp_mro || bases || [];
            for (var bj = 0; bj < mroI.length; bj++) {
                if (mroI[bj] && mroI[bj].tp_init !== undefined) {
                    cls.tp_init = mroI[bj].tp_init; break;
                }
            }
            if (cls.tp_init === undefined) {
                cls.tp_init = (rt._b_.BaseException &&
                               rt._b_.BaseException.tp_init) ||
                              rt._b_.object.tp_init;
            }
        }
        // The result may be used both as PyObject* (PyErr_SetString etc.) and
        // as a PyTypeObject* (PyModule_AddType). Back it with a struct so
        // both consumers work.
        return rt.ensureTypeStruct(cls);
    },

    /* _Py_hashtable_t — JS-Map-backed minimal implementation. Used by
     * hmacmodule to map algo-name → entry. We attach the Map directly to
     * the handle via a JS WeakMap-style registry. */
    $WasthonHashtables__deps: ['$WasthonRT'],
    $WasthonHashtables: null,

    _Py_hashtable_new_full__deps: ['$WasthonRT', '$WasthonHashtables'],
    _Py_hashtable_new_full: function(_hash, _cmp, _kdtor, _vdtor, _alloc) {
        if (!WasthonHashtables) WasthonHashtables = new Map();
        var id = _malloc(4);  // unique handle; the 4-byte slot is unused
        WasthonHashtables.set(id, new Map());
        return id;
    },

    _Py_hashtable_destroy__deps: ['$WasthonHashtables'],
    _Py_hashtable_destroy: function(ht) {
        if (WasthonHashtables) WasthonHashtables.delete(ht);
        _free(ht);
    },

    /* The only user (hmacmodule) keys this table by algorithm NAME (a C
     * string): it `set`s with static string literals (`e->name`) and `get`s
     * with `PyUnicode_AsUTF8(name)` — a different pointer for the same text.
     * So we must key the Map by string CONTENT, not the raw pointer, or every
     * lookup misses (→ "unsupported hash type"). */
    _Py_hashtable_set__deps: ['$WasthonHashtables'],
    _Py_hashtable_set: function(ht, key, value) {
        var m = WasthonHashtables && WasthonHashtables.get(ht);
        if (!m) return -1;
        m.set(key ? UTF8ToString(key) : key, value);
        return 0;
    },

    _Py_hashtable_get__deps: ['$WasthonHashtables'],
    _Py_hashtable_get: function(ht, key) {
        var m = WasthonHashtables && WasthonHashtables.get(ht);
        var k = key ? UTF8ToString(key) : key;
        return (m && m.has(k)) ? m.get(k) : 0;
    },

    /* `_Py_hashtable_get_entry` returns a pointer to the entry struct or NULL.
     * We allocate a 1-entry struct (key + value) per get call; minor leak. */
    _Py_hashtable_get_entry__deps: ['$WasthonHashtables'],
    _Py_hashtable_get_entry: function(ht, key) {
        var m = WasthonHashtables && WasthonHashtables.get(ht);
        var k = key ? UTF8ToString(key) : key;
        if (!m || !m.has(k)) return 0;
        var entryPtr = _malloc(8);
        HEAP32[ entryPtr      >> 2] = key;
        HEAP32[(entryPtr + 4) >> 2] = m.get(k);
        return entryPtr;
    },

    /* GIL stubs (single-threaded WASM) */
    PyGILState_Ensure: function() { return 1; },
    PyGILState_Release: function(_s) {},
    PyGILState_GetThisThreadState: function() { return 1; },  // non-null sentinel

    /* Object protocol */
    PyUnicode_AsUTF8__deps: ['$WasthonRT'],
    PyUnicode_AsUTF8: function(handle) {
        var rt = WasthonRT;
        var obj = rt.asJSStr(rt.unwrap(handle));
        if (obj === null) {
            rt.setError(rt.wrap(rt._b_.TypeError), "str expected");
            return 0;
        }
        // Cache UTF-8 conversion on the JS string so the returned pointer
        // remains valid until the object is GC'd. We allocate in linear
        // memory and never free (CPython's PyUnicode_AsUTF8 also returns
        // an internal pointer that stays alive with the str).
        if (!rt._utf8Cache) rt._utf8Cache = new WeakMap();
        // Strings aren't weak-keyable. Use a small Map keyed by string content.
        if (!rt._utf8CacheStr) rt._utf8CacheStr = new Map();
        if (rt._utf8CacheStr.has(obj)) return rt._utf8CacheStr.get(obj);
        /* CPython's PyUnicode_AsUTF8 is strict: a lone surrogate raises
         * UnicodeEncodeError (returns NULL). pickle's write_unicode_binary
         * catches that NULL and retries via PyUnicode_AsEncodedString(...,
         * "surrogatepass") (CESU, which our DecodeUTF8 round-trips); sqlite3
         * bind lets it propagate (test_*_surrogates). A valid surrogate pair
         * (astral char) still encodes fine. */
        var bytes = rt.encodeUTF8(obj, /*surrogatepass=*/false);
        if (bytes === null) {
            rt.setError(rt.wrap(rt._b_.UnicodeEncodeError),
                "'utf-8' codec can't encode character: surrogates not allowed");
            return 0;
        }
        var ptr = _malloc(bytes.length + 1);
        HEAPU8.set(bytes, ptr);
        HEAPU8[ptr + bytes.length] = 0;
        rt._utf8CacheStr.set(obj, ptr);
        return ptr;
    },

    /* _PyUnicode_AsUTF8NoNUL — PyUnicode_AsUTF8 but rejects embedded NUL.
     * Used where a NUL would silently truncate (paths, SQL text). */
    _PyUnicode_AsUTF8NoNUL__deps: ['$WasthonRT', 'PyUnicode_AsUTF8'],
    _PyUnicode_AsUTF8NoNUL: function(handle) {
        var rt = WasthonRT;
        var ptr = _PyUnicode_AsUTF8(handle);
        if (ptr === 0) return 0;
        var s = rt.asJSStr(rt.unwrap(handle));
        if (typeof s === 'string' && s.indexOf('\0') !== -1) {
            rt.setError(rt.wrap(rt._b_.ValueError),
                "embedded null character");
            return 0;
        }
        return ptr;
    },

    /* PyUnicode_FSConverter(arg, *addr) — str|bytes -> bytes. Writes a new
     * bytes handle to *addr, returns 1; 0 + sets error on failure. The
     * bridge calls this directly (not via PyArg O&), so plain success
     * semantics (1) suffice — no Py_CLEANUP_SUPPORTED cleanup pass. */
    PyUnicode_FSConverter__deps: ['$WasthonRT'],
    PyUnicode_FSConverter: function(argHandle, addrPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(argHandle);
        var bytesObj;
        try {
            if (rt.$B.$isinstance(obj, rt._b_.bytes)) {
                bytesObj = obj;
            } else {
                var s = rt.asJSStr(obj);
                if (typeof s !== 'string') {
                    rt.setError(rt.wrap(rt._b_.TypeError),
                        "expected str, bytes or os.PathLike object");
                    return 0;
                }
                if (s.indexOf('\0') !== -1) {
                    rt.setError(rt.wrap(rt._b_.ValueError),
                        "embedded null byte");
                    return 0;
                }
                var enc = new TextEncoder().encode(s);
                bytesObj = rt._b_.bytes.$factory(Array.from(enc));
            }
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "expected str, bytes or os.PathLike object");
            return 0;
        }
        HEAP32[addrPtr >> 2] = rt.wrap(bytesObj);
        return 1;
    },

    PyObject_CallMethodNoArgs__deps: ['$WasthonRT'],
    PyObject_CallMethodNoArgs: function(selfHandle, nameHandle) {
        var rt = WasthonRT;
        var self = rt.unwrap(selfHandle);
        var name = rt.unwrap(nameHandle);
        if (self === null || typeof name !== 'string') {
            rt.setError(rt.wrap(rt._b_.TypeError), "PyObject_CallMethodNoArgs");
            return 0;
        }
        try {
            var method = rt.$B.$getattr(self, name);
            return rt.wrapNewRef(rt.$B.$call(method));
        } catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    PyObject_CallOneArg__deps: ['$WasthonRT'],
    PyObject_CallOneArg: function(fnHandle, argHandle) {
        var rt = WasthonRT;
        var fn = rt.unwrap(fnHandle);
        var arg = rt.toBrythonArg(rt.unwrap(argHandle));
        if (!fn) return 0;
        try { return rt.wrapNewRef(rt.$B.$call(fn, arg)); }
        catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyObject_CallMethod(obj, name, fmt, ...) — call obj.name(args), where
     * args are unpacked from varargs according to a minimal Py_BuildValue-
     * style format string. Supports just what _decimal needs:
     *   O    PyObject*    (consumes 4 bytes from varargs)
     *   s    const char*  (consumes 4 bytes — pointer to NUL-terminated str)
     *   i    int          (consumes 4 bytes)
     *   d    double       (consumes 8 bytes — double is naturally aligned)
     * Surrounding '(', ')', ',', and spaces are ignored: "(OO)", "(O)",
     * "(ss)" all parse like "OO", "O", "ss" respectively. */
    PyObject_CallMethod__deps: ['$WasthonRT'],
    PyObject_CallMethod: function(objH, namePtr, fmtPtr, varargs) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (!obj) {
            rt.setError(rt.wrap(rt._b_.SystemError), "PyObject_CallMethod: NULL obj");
            return 0;
        }
        var name = UTF8ToString(namePtr);
        var fmt = fmtPtr === 0 ? "" : UTF8ToString(fmtPtr);
        rt.trace('PyObject_CallMethod', name + ' fmt="' + fmt + '"');
        var method;
        try { method = rt.$B.$getattr(obj, name); }
        catch (e) {
            rt.forwardError(e, rt._b_.AttributeError);
            return 0;
        }
        var args = [], p = varargs;
        for (var i = 0; i < fmt.length; i++) {
            var c = fmt[i];
            if (c === '(' || c === ')' || c === ',' || c === ' ') continue;
            if (c === 'O') {
                args.push(rt.toBrythonArg(rt.unwrap(HEAP32[p >> 2])));
                p += 4;
            } else if (c === 's') {
                var sp = HEAP32[p >> 2];
                args.push(sp === 0 ? null : UTF8ToString(sp));
                p += 4;
            } else if (c === 'i' || c === 'n' || c === 'l' || c === 'k' || c === 'I') {
                // 32-bit integer in wasm32 (int / long / Py_ssize_t / size_t).
                // Without 'n' here, array_fromfile's read("n", nbytes) dropped
                // the size arg → f.read() slurped the whole file → EOFError.
                args.push(HEAP32[p >> 2]);
                p += 4;
            } else if (c === 'L' || c === 'K') {
                // 64-bit integer (long long): low + high 32-bit halves.
                var lo = HEAP32[p >> 2] >>> 0, hi = HEAP32[(p + 4) >> 2];
                args.push(hi * 0x100000000 + lo);
                p += 8;
            } else if (c === 'd' || c === 'f') {
                // Doubles in varargs must be 8-byte aligned.
                if (p & 7) p = (p + 7) & ~7;
                args.push(HEAPF64[p >> 3]);
                p += 8;
            }
        }
        try { return rt.wrapMaybeType(rt.$B.$call.apply(null, [method].concat(args))); }
        catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyObject_CallObject(callable, args_tuple_or_NULL) — generic call with
     * args supplied as a tuple (or NULL/None for no args). */
    PyObject_CallObject__deps: ['$WasthonRT'],
    PyObject_CallObject: function(fnHandle, argsHandle) {
        var rt = WasthonRT;
        var fn = rt.unwrap(fnHandle);
        rt.trace('PyObject_CallObject', 'fnH=' + fnHandle);
        if (!fn) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyObject_CallObject: NULL callable (handle " + fnHandle + ")");
            return 0;
        }
        var args = argsHandle === 0 ? [] : rt.unwrap(argsHandle);
        if (args === null) args = [];
        // Fold any C-written linear-memory buffer (__wasthon_cstr__) into the
        // arg's .source BEFORE the Brython callee reads it: pickle's proto-5
        // load_reduce calls a Python reconstructor with a bytearray filled by
        // _Unpickler_ReadInto (content in __wasthon_cstr__, .source still the
        // zero placeholder) — the post-call syncBytes pass is too late, the
        // callee (e.g. ZeroCopyBytes._reconstruct -> memoryview(obj).obj) reads
        // .source and rebuilt all-zero bytes. Idempotent for read-only buffers.
        for (var i = 0; i < args.length; i++) rt.syncCstrBytes(args[i]);
        try { return rt.wrapMaybeType(rt.$B.$call.apply(null, [fn].concat(args))); }
        catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyObject_GC_IsTracked: in our bridge there is no separate GC tracking
     * (JS GC owns lifetime). _decimal uses this only inside assert()s. */
    PyObject_GC_IsTracked__deps: ['$WasthonRT'],
    PyObject_GC_IsTracked: function(handle) {
        return handle === 0 ? 0 : 1;
    },

    /* ----------------------------------------------------------------
     * Thread state (single-threaded WASM): one process-wide pseudo-
     * tstate, with one process-wide per-state dict. _decimal stashes
     * its module-level decimal-context here. The tstate "handle" is
     * a fixed sentinel small int — never dereferenced as a struct. */
    _PyThreadState_GET__deps: ['$WasthonRT'],
    _PyThreadState_GET: function() {
        var rt = WasthonRT;
        if (!rt._tstateHandle) {
            // Allocate one sentinel that survives forever.
            rt._tstateHandle = rt._allocSentinelId();
            rt.handles.set(rt._tstateHandle, { __wasthon_tstate__: true });
        }
        return rt._tstateHandle;
    },

    _PyThreadState_GetDict__deps: ['$WasthonRT'],
    _PyThreadState_GetDict: function(tsH) {
        var rt = WasthonRT;
        if (!rt._tstateDict) {
            rt._tstateDict = rt._b_.dict.$factory();
            // Pinned: cached in a JS field and reused across calls — a
            // scope-tracked handle here goes stale at the creating call's
            // return (broke _decimal: getcontext() then setcontext()).
            rt._tstateDictHandle = rt.wrapPinned(rt._tstateDict);
        }
        return rt._tstateDictHandle;
    },

    PyThreadState_GetDict__deps: ['$WasthonRT', '_PyThreadState_GetDict'],
    PyThreadState_GetDict: function() {
        return __PyThreadState_GetDict(0);
    },

    /* Interpreter state — single-runtime WASM, one process-wide pseudo-
     * interp with one dict (where _datetime caches its module). */
    PyInterpreterState_Get__deps: ['$WasthonRT'],
    PyInterpreterState_Get: function() {
        var rt = WasthonRT;
        if (!rt._interpHandle) {
            rt._interpHandle = rt._allocSentinelId();
            rt.handles.set(rt._interpHandle, { __wasthon_interp__: true });
        }
        return rt._interpHandle;
    },
    PyInterpreterState_GetDict__deps: ['$WasthonRT'],
    PyInterpreterState_GetDict: function(interpH) {
        var rt = WasthonRT;
        if (!rt._interpDict) {
            rt._interpDict = rt._b_.dict.$factory();
            rt._interpDictHandle = rt.wrapPinned(rt._interpDict);  // pinned: JS-cached (see tstate dict)
        }
        return rt._interpDictHandle;
    },

    /* PyWeakref_NewRef(obj, callback) — returns a "weak ref" that's
     * actually a strong ref in our model. Callback is ignored (no GC). */
    PyWeakref_NewRef__deps: ['$WasthonRT'],
    PyWeakref_NewRef: function(objH, callbackH) {
        // Just return obj wrapped — strong-ref semantics suffice.
        var rt = WasthonRT;
        return rt.wrapNewRef(rt.unwrap(objH));
    },

    /* PyWeakref_GetRef(ref, *out) — write referenced obj to *out and
     * return 1. Returns 0 if ref is None, -1 on error. */
    PyWeakref_GetRef__deps: ['$WasthonRT'],
    PyWeakref_GetRef: function(refH, outPtr) {
        var rt = WasthonRT;
        var ref = rt.unwrap(refH);
        if (ref === null || ref === rt._b_.None) {
            HEAP32[outPtr >> 2] = 0;
            return 0;
        }
        var h = rt.wrap(ref);
        HEAP32[outPtr >> 2] = h;
        rt.incref(h);  // *Ref API returns a NEW reference (caller DECREFs)
        return 1;
    },

    /* Raw object allocator — alias to malloc. _datetime uses
     * PyObject_Malloc to allocate small Decimal-like structs. */
    PyObject_Malloc__deps: ['$WasthonRT'],
    PyObject_Malloc: function(size) { return _malloc(size); },
    PyObject_Free__deps: ['$WasthonRT'],
    PyObject_Free: function(ptr) { if (ptr !== 0) _free(ptr); },

    /* _PyObject_Init(op, type) — set ob_type. Returns op. */
    _PyObject_Init__deps: ['$WasthonRT'],
    _PyObject_Init: function(opH, typeH) {
        // op is typically a freshly-allocated struct ptr. Bind it.
        var rt = WasthonRT;
        var t = rt.unwrap(typeH);
        if (t) rt.handles.set(opH, { __wasthon_ptr__: opH, __class__: t, ob_type: t });
        return opH;
    },

    /* Raised-exception API. We use the pendingException slot for both. */
    PyErr_GetRaisedException__deps: ['$WasthonRT'],
    PyErr_GetRaisedException: function() {
        var rt = WasthonRT;
        if (!rt.pendingException) return rt.SLOT_NONE;
        var pe = rt.pendingException;
        rt.pendingException = null;
        // Materialize the preserved instance (attrs intact) or reconstruct.
        try {
            return rt.wrapNewRef(rt.pendingExc(pe));
        } catch (e) { return rt.SLOT_NONE; }
    },
    PyErr_SetRaisedException__deps: ['$WasthonRT'],
    PyErr_SetRaisedException: function(excH) {
        var rt = WasthonRT;
        if (excH === 0 || excH === rt.SLOT_NONE) {
            rt.pendingException = null;
            return;
        }
        var exc = rt.unwrap(excH);
        // exc is an exception INSTANCE; preserve it so its attributes survive.
        rt.setError(rt.wrap(exc && exc.__class__ ? exc.__class__ : rt._b_.Exception),
                    String(exc), exc);
    },
    PyErr_FormatUnraisable__deps: ['$WasthonRT'],
    PyErr_FormatUnraisable: function(fmtPtr, va) {
        // CPython routes the pending (unraisable) exception to sys.unraisablehook
        // with a formatted err_msg. Forward it to the harness helper so
        // test.support.catch_unraisable_exception can capture exc_type/err_msg
        // (sqlite3 callback exceptions). Without a hook we just drop it, as
        // before. Must never raise.
        var rt = WasthonRT;
        var pe = rt.pendingException;
        rt.pendingException = null;
        var fn = (typeof globalThis !== 'undefined') ? globalThis.__wasthon_unraisable : null;
        if (!pe || !fn) return;
        try {
            var excVal = pe.value;
            if (!excVal && pe.exc) {
                try { excVal = rt.$B.$call(rt.unwrap(pe.exc),
                        typeof pe.msg === 'string' ? pe.msg : ''); }
                catch (_) { excVal = null; }
            }
            var excType = null;
            if (excVal) { try { excType = rt.$B.get_class(excVal); } catch (_) {} }
            if (!excType && pe.exc) excType = rt.unwrap(pe.exc);
            // Expand the printf-style format (sqlite3 uses %R with the callable),
            // reading varargs from the wasm32 va pointer like Py_BuildValue.
            var msg = "";
            var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
            var p = va || 0;
            for (var i = 0; i < fmt.length; i++) {
                var ch = fmt[i];
                if (ch !== '%' || i + 1 >= fmt.length) { msg += ch; continue; }
                var c = fmt[++i];
                if (c === 'R' || c === 'S' || c === 'A') {
                    var h = p ? HEAP32[p >> 2] : 0; p += 4;
                    var o = rt.unwrap(h);
                    try { msg += (c === 'R') ? String(rt._b_.repr(o))
                                             : String(rt._b_.str.$factory(o)); }
                    catch (_) { msg += '<?>'; }
                } else if (c === 's') {
                    var sp = p ? HEAP32[p >> 2] : 0; p += 4;
                    msg += sp ? UTF8ToString(sp) : '';
                } else if (c === 'd' || c === 'i' || c === 'u') {
                    msg += String(p ? (HEAP32[p >> 2] | 0) : 0); p += 4;
                } else if (c === '%') { msg += '%'; }
                else { msg += '%' + c; }
            }
            rt.$B.$call(fn, excType, excVal, msg);
        } catch (e) { /* the unraisable hook must never raise */ }
    },

    /* PyUnicodeWriter — the implementation lives further down (the
     * `_writers` id-keyed set: Create/Finish/Discard/WriteUTF8/WriteStr/
     * WriteChar/WriteASCII/WriteRepr/WriteSubstring/Format). An earlier
     * `__wasthon_writer__`-sentinel duplicate set used to sit here but was
     * fully shadowed (object-literal last-key-wins) and is removed. */

    /* _Py_strhex_bytes_with_sep — format `bytes_len` bytes from C buffer
     * as a hex BYTES object (CPython naming convention: the `bytes_`
     * infix indicates the return type, not the input type — there's
     * a paired `_Py_strhex_with_sep` returning str). `sep` may be NULL
     * (no separator) or a 1-char bytes/str object inserted every
     * |bytes_per_sep| bytes; positive bytes_per_sep groups from the
     * right (matches bytes.hex(sep, n)), negative groups from the
     * left. Used by binascii.b2a_hex / binascii.hexlify. */
    _Py_strhex_bytes_with_sep__deps: ['$WasthonRT'],
    _Py_strhex_bytes_with_sep: function(bufPtr, bytesLen, sepHandle, bytesPerSep) {
        var rt = WasthonRT;
        var hex = '0123456789abcdef';
        var raw = '';
        for (var i = 0; i < bytesLen; i++) {
            var b = HEAPU8[bufPtr + i];
            raw += hex[b >> 4] + hex[b & 0xf];
        }
        var out;
        if (sepHandle === 0 || bytesPerSep === 0) {
            out = raw;
        } else {
            var sep = rt.unwrap(sepHandle);
            var sepStr = '';
            if (typeof sep === 'string') sepStr = sep;
            else if (sep && sep.source) sepStr = String.fromCharCode(sep.source[0] & 0xff);
            else sepStr = String(sep);
            var groupChars = Math.abs(bytesPerSep) * 2;
            var groupFromRight = bytesPerSep > 0;
            out = '';
            if (groupFromRight) {
                var first = raw.length % groupChars;
                var idx = 0;
                if (first > 0) { out = raw.substr(0, first); idx = first; }
                while (idx < raw.length) {
                    if (out.length > 0) out += sepStr;
                    out += raw.substr(idx, groupChars);
                    idx += groupChars;
                }
            } else {
                for (var j = 0; j < raw.length; j += groupChars) {
                    if (j > 0) out += sepStr;
                    out += raw.substr(j, groupChars);
                }
            }
        }
        // Encode as ASCII bytes — hex chars and the separator are all
        // single-byte. (If a user passes a multi-byte unicode sep, this
        // would truncate; binascii's caller passes a single ASCII char.)
        var arr = new Array(out.length);
        for (var k = 0; k < out.length; k++) arr[k] = out.charCodeAt(k) & 0xff;
        return rt.wrapNewRef(rt._b_.bytes.$factory(arr));
    },

    /* PySequence_Check(o) — does o support the sequence protocol? True for
     * list/tuple/str/bytes/bytearray and anything with __getitem__ that
     * isn't a mapping (dict). Mirrors CPython: a dict is not a sequence. */
    PySequence_Check__deps: ['$WasthonRT'],
    PySequence_Check: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null || obj === undefined) return 0;
        if (Array.isArray(obj) || typeof obj === 'string') return 1;
        try {
            if (rt.$B.$isinstance(obj, rt._b_.dict)) return 0;
            if (rt.$B.$isinstance(obj, [rt._b_.list, rt._b_.tuple,
                    rt._b_.str, rt._b_.bytes, rt._b_.bytearray])) return 1;
            var cls = obj.__class__ || (rt._b_.type && rt.$B.get_class(obj));
            return (cls && rt.$B.$getattr(cls, '__getitem__', null)) ? 1 : 0;
        } catch (e) { return 0; }
    },

    /* PySequence_GetItem(o, i) — o[i]. */
    PySequence_GetItem__deps: ['$WasthonRT'],
    PySequence_GetItem: function(objH, i) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null) return 0;
        try { return rt.wrapNewRef(rt.$B.$getitem(obj, i)); }
        catch (e) {
            rt.forwardError(e, rt._b_.IndexError);
            return 0;
        }
    },

    /* PySequence_Size(o) — len(o) treated as a sequence. Returns -1 on err. */
    PySequence_Size__deps: ['$WasthonRT'],
    PySequence_Size: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null || obj === undefined) return -1;
        if (Array.isArray(obj)) return obj.length;
        if (typeof obj === 'string') return obj.length;
        // CPython's PySequence_Size needs the sequence protocol (sq_length); a
        // mapping such as dict has only mp_length and raises "is not a sequence"
        // (e.g. lzma.decompress(filters={}) must be TypeError, not LZMAError).
        if (rt.$B.$isinstance(obj, rt._b_.dict)) {
            var tname;
            try { tname = rt.$B.class_name(obj); } catch (_) { tname = 'object'; }
            rt.setError(rt.wrap(rt._b_.TypeError), tname + " is not a sequence");
            return -1;
        }
        try { return rt._b_.len(obj) | 0; }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "object has no len()");
            return -1;
        }
    },

    /* PyList_CheckExact(o) — is exactly a list (not a subclass). */
    PyList_CheckExact__deps: ['$WasthonRT'],
    PyList_CheckExact: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        return Array.isArray(obj) ? 1 : 0;
    },

    /* PyLong_AsNativeBytes(obj, buf, n, flags) — convert PyLong to bytes.
     * Returns number of bytes actually used, or -1 on error. Implements
     * native-endian and little/big-endian; we ignore the ALLOW_INDEX and
     * UNSIGNED_BUFFER flags (we always accept ints, and our value-checking
     * is the same in both modes for n ≤ 8). */
    PyLong_AsNativeBytes__deps: ['$WasthonRT'],
    PyLong_AsNativeBytes: function(objH, bufPtr, n, flags) {
        var rt = WasthonRT;
        var v = rt.unwrap(objH);
        var big;
        if (typeof v === 'bigint') big = v;
        else if (typeof v === 'number') big = BigInt(Math.trunc(v));
        else if (v && typeof v.valueOf === 'function') {
            try { big = BigInt(v.valueOf()); }
            catch (e) {
                rt.setError(rt.wrap(rt._b_.TypeError),
                    "an integer is required");
                return -1;
            }
        } else {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "an integer is required");
            return -1;
        }

        var negative = big < 0n;
        if (negative && (flags & 8)) {
            rt.setError(rt.wrap(rt._b_.OverflowError),
                "can't convert negative int");
            return -1;
        }

        // Endian: bit0 = big, bit1 = little, both = native (little for our env)
        var endian = flags & 3;
        var bigEndian = (endian === 1);  // native is little for wasm

        // For negative numbers, use two's complement representation in n bytes.
        var modValue = big;
        if (negative) {
            modValue = (1n << BigInt(n * 8)) + big;
        }

        // Write bytes
        for (var i = 0; i < n; i++) {
            var byte = Number(modValue & 0xffn);
            modValue >>= 8n;
            var off = bigEndian ? (n - 1 - i) : i;
            HEAPU8[bufPtr + off] = byte;
        }

        // Compute minimal byte count needed to represent the value
        var test = negative ? ~big : big;
        if (test < 0n) test = -test;
        var bitsNeeded = 0;
        var t = test;
        while (t > 0n) { bitsNeeded++; t >>= 1n; }
        var bytesNeeded = Math.max(1, Math.ceil((bitsNeeded + (negative ? 1 : 0)) / 8));
        return bytesNeeded;
    },

    /* PyMapping_Check(o) — does o support __getitem__? Conservative true
     * for dict, list, tuple, str. */
    PyMapping_Check__deps: ['$WasthonRT'],
    PyMapping_Check: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null || obj === undefined) return 0;
        if (Array.isArray(obj)) return 1;
        // Brython dicts identify via $B.is_dict (OB_TYPE + DICT_SUBCLASS flag),
        // NOT obj.__class__ === _b_.dict (which is undefined on dict instances).
        if (rt.$B.is_dict(obj) || obj instanceof Map) return 1;
        if (typeof obj === 'string') return 1;
        try {
            // $B.$hasattr does not exist; the bug made this throw → return 0,
            // so _lzma's lzma_filter_converter rejected every filter dict with
            // "Filter specifier must be a dict or dict-like object". Use the
            // 3-arg $getattr-with-default presence check instead.
            return rt.$B.$getattr(obj, '__getitem__', undefined) !== undefined ? 1 : 0;
        } catch (e) { return 0; }
    },

    /* PyMapping_GetOptionalItemString(obj, key, *out) — like __getitem__
     * but returns 0 (and *out=NULL) if key is missing, rather than raising
     * KeyError. Returns 1 on success, 0 if missing, -1 on error. */
    PyMapping_GetOptionalItemString__deps: ['$WasthonRT'],
    PyMapping_GetOptionalItemString: function(objH, keyPtr, outPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var key = keyPtr ? UTF8ToString(keyPtr) : "";
        try {
            var val;
            if (obj && obj.__class__ === rt._b_.dict) {
                if (!rt.$B.$dict_contains(obj, key)) {
                    HEAP32[outPtr >> 2] = 0;
                    return 0;
                }
                val = rt.$B.$dict_get(obj, key);
            } else if (obj instanceof Map) {
                if (!obj.has(key)) {
                    HEAP32[outPtr >> 2] = 0;
                    return 0;
                }
                val = obj.get(key);
            } else {
                try {
                    val = rt.$B.$getitem(obj, key);
                } catch (e) {
                    if (rt.$B.is_exc(e, rt._b_.KeyError) ||
                        rt.$B.is_exc(e, rt._b_.IndexError)) {
                        HEAP32[outPtr >> 2] = 0;
                        return 0;
                    }
                    throw e;
                }
            }
            HEAP32[outPtr >> 2] = rt.wrapNewRef(val);
            return 1;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                e.args ? String(e.args[0]) : (e.message || String(e)));
            return -1;
        }
    },

    /* PyMapping_GetOptionalItem(obj, key, *result) — like obj[key] but
     * returns 0 (and *result=NULL) if key is missing rather than raising.
     * Returns 1 on success, 0 if missing, -1 on error. Difference from
     * the *String variant: key is a PyObject*, not a C string. */
    PyMapping_GetOptionalItem__deps: ['$WasthonRT'],
    PyMapping_GetOptionalItem: function(objH, keyH, outPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var key = rt.unwrap(keyH);
        if (obj === null) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyMapping_GetOptionalItem: NULL obj");
            return -1;
        }
        try {
            var val = rt.$B.$getitem(obj, key);
            HEAP32[outPtr >> 2] = rt.wrapNewRef(val);
            return 1;
        } catch (e) {
            try {
                if (rt.$B.is_exc(e, rt._b_.KeyError) ||
                    rt.$B.is_exc(e, rt._b_.IndexError)) {
                    HEAP32[outPtr >> 2] = 0;
                    return 0;
                }
            } catch (_) {}
            rt.setError(rt.wrap(rt._b_.TypeError),
                e.args ? String(e.args[0]) : (e.message || String(e)));
            return -1;
        }
    },

    /* _Py_convert_optional_to_ssize_t — clinic converter for ssize_t|None.
     * Returns 1 on success (sets *result), 0 on type error. None leaves
     * *result untouched, preserving the caller-provided default. */
    _Py_convert_optional_to_ssize_t__deps: ['$WasthonRT'],
    _Py_convert_optional_to_ssize_t: function(objH, resultPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === rt._b_.None || obj === null || obj === undefined) {
            return 1;
        }
        if (typeof obj === 'number') {
            HEAP32[resultPtr >> 2] = obj | 0;
            return 1;
        }
        if (typeof obj === 'bigint') {
            HEAP32[resultPtr >> 2] = Number(obj) | 0;
            return 1;
        }
        rt.setError(rt.wrap(rt._b_.TypeError),
            "argument must be int or None");
        return 0;
    },

    /* PyObject_CallMethodOneArg(self, name, arg) — self.name(arg). */
    PyObject_CallMethodOneArg__deps: ['$WasthonRT'],
    PyObject_CallMethodOneArg: function(selfH, nameH, argH) {
        var rt = WasthonRT;
        var self = rt.unwrap(selfH);
        var name = rt.asJSStr(rt.unwrap(nameH));
        var arg = rt.unwrap(argH);
        if (!self || name === null) return 0;
        try {
            var m = rt.$B.$getattr(self, name);
            return rt.wrapNewRef(rt.$B.$call(m, arg));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.AttributeError), name + ": " + (e.message || e));
            return 0;
        }
    },

    /* PyObject_Call(callable, args_tuple, kwargs_dict) — generic call. */
    PyObject_Call__deps: ['$WasthonRT'],
    PyObject_Call: function(fnH, argsH, kwargsH) {
        var rt = WasthonRT;
        var fn = rt.unwrap(fnH);
        if (!fn) return 0;
        var args = argsH === 0 ? [] : rt.unwrap(argsH);
        if (args === null) args = [];
        args = Array.from(args);
        try {
            // Forward keyword args via Brython's $kw marker — same as
            // PyObject_Vectorcall. Dropping kwargsH silently skipped EVERY
            // keyword for any C code that forwards a (args, kwargs) call
            // through PyObject_Call (e.g. sqlite3.connect(..., kw) -> factory).
            var kwargs = kwargsH === 0 ? null : rt.unwrap(kwargsH);
            if (kwargs) {
                var kwMap = {};
                var items = rt._b_.list.$factory(
                    rt.$B.$call(rt.$B.$getattr(kwargs, 'items')));
                for (var p = 0; p < items.length; p++) {
                    var nm = rt.asJSStr(items[p][0]);
                    if (nm === null) nm = String(items[p][0]);
                    kwMap[nm] = items[p][1];
                }
                args.push({ $kw: [kwMap] });
            }
            return rt.wrapNewRef(rt.$B.$call.apply(null, [fn].concat(args)));
        } catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyNumber_Long(o) — int(o) coercion. */
    PyNumber_Long__deps: ['$WasthonRT'],
    PyNumber_Long: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        try { return rt.wrapNewRef(rt._b_.int.$factory(obj)); }
        catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* PyNumber_* binary ops — handle the (number, number), (bigint, *) and
     * (*, bigint) combinations natively, fall through to Brython's __op__
     * dispatch otherwise. The BigInt branch is essential for math.factorial
     * and similar that build up arbitrary-precision ints in a tight C loop. */
    PyNumber_Add__deps: ['$WasthonRT'],
    PyNumber_Add: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try {
            if (typeof a === 'number' && typeof b === 'number' &&
                Number.isInteger(a) && Number.isInteger(b)) {
                var sum = a + b;
                if (Number.isFinite(sum) && Number.isSafeInteger(sum)) return rt.wrapNewRef(sum);
                /* Overflow into BigInt land. */
                return rt.wrapNewRef(BigInt(a) + BigInt(b));
            }
            if (typeof a === 'number' && typeof b === 'number') return rt.wrapNewRef(a + b);
            if (typeof a === 'bigint' || typeof b === 'bigint') {
                var ba = typeof a === 'bigint' ? a : BigInt(Math.trunc(Number(a)));
                var bb = typeof b === 'bigint' ? b : BigInt(Math.trunc(Number(b)));
                var r = ba + bb;
                if (r >= -2147483648n && r <= 2147483647n) return rt.wrapNewRef(Number(r));
                return rt.wrapNewRef(r);
            }
            /* General case: Brython's binary-op protocol (tries a.__add__(b),
             * then the reflected b.__radd__(a) on NotImplemented, else raises
             * TypeError). A bare a.__add__(b) returned NotImplemented for
             * int(0)+float — math.sumprod's float path then failed with
             * "'NotImplementedType' has no attribute '__add__'". */
            return rt.wrapNewRef(rt.$B.rich_op1('__add__', a, b));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },
    PyNumber_Multiply__deps: ['$WasthonRT'],
    PyNumber_Multiply: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try {
            if (typeof a === 'number' && typeof b === 'number' &&
                Number.isInteger(a) && Number.isInteger(b)) {
                var prod = a * b;
                if (Number.isFinite(prod) && Number.isSafeInteger(prod)) return rt.wrapNewRef(prod);
                /* Overflow into BigInt land. */
                return rt.wrapNewRef(BigInt(a) * BigInt(b));
            }
            if (typeof a === 'number' && typeof b === 'number') return rt.wrapNewRef(a * b);
            if (typeof a === 'bigint' || typeof b === 'bigint') {
                var ba = typeof a === 'bigint' ? a : BigInt(Math.trunc(Number(a)));
                var bb = typeof b === 'bigint' ? b : BigInt(Math.trunc(Number(b)));
                var r = ba * bb;
                if (r >= -2147483648n && r <= 2147483647n) return rt.wrapNewRef(Number(r));
                return rt.wrapNewRef(r);
            }
            return rt.wrapNewRef(rt.$B.rich_op1('__mul__', a, b));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },
    PyNumber_FloorDivide__deps: ['$WasthonRT'],
    PyNumber_FloorDivide: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try { return rt.wrapNewRef(rt.$B.rich_op1('__floordiv__', a, b)); }
        catch (e) { rt.forwardError(e, rt._b_.TypeError); return 0; }
    },
    PyNumber_TrueDivide__deps: ['$WasthonRT'],
    PyNumber_TrueDivide: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try { return rt.wrapNewRef(rt.$B.rich_op1('__truediv__', a, b)); }
        catch (e) { rt.forwardError(e, rt._b_.TypeError); return 0; }
    },
    PyNumber_Remainder__deps: ['$WasthonRT'],
    PyNumber_Remainder: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try { return rt.wrapNewRef(rt.$B.rich_op1('__mod__', a, b)); }
        catch (e) { rt.forwardError(e, rt._b_.TypeError); return 0; }
    },
    PyNumber_And__deps: ['$WasthonRT'],
    PyNumber_And: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try { return rt.wrapNewRef(rt.$B.rich_op1('__and__', a, b)); }
        catch (e) { rt.forwardError(e, rt._b_.TypeError); return 0; }
    },

    /* PyUnicode helpers */
    PyUnicode_GetLength__deps: ['$WasthonRT'],
    PyUnicode_GetLength: function(handle) {
        var s = WasthonRT.asJSStr(WasthonRT.unwrap(handle));
        return s === null ? -1 : s.length;
    },
    PyUnicode_AsLatin1String__deps: ['$WasthonRT'],
    PyUnicode_AsLatin1String: function(handle) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(handle));
        if (s === null) { rt.setError(rt.wrap(rt._b_.TypeError), "str expected"); return 0; }
        var arr = new Array(s.length);
        for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xFF;
        return rt.wrapNewRef(rt._b_.bytes.$factory(arr));
    },

    /* PyObject_GetOptionalAttr — like GetAttr but missing attr is OK.
     * Returns 1 with *out set on success, 0 if missing, -1 on error. */
    PyObject_GetOptionalAttr__deps: ['$WasthonRT'],
    PyObject_GetOptionalAttr: function(objH, attrNameH, outPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.asJSStr(rt.unwrap(attrNameH));
        if (obj === null || name === null) { HEAP32[outPtr >> 2] = 0; return 0; }
        try {
            // 2-arg $getattr: the 3-arg default form can return a raw
            // getset_descriptor unresolved (function.__qualname__ — broke
            // _pickle's save_global for every module-level function);
            // missing attr raises AttributeError, handled below.
            var v = rt.$B.$getattr(obj, name);
            if (v === undefined || v === null) { HEAP32[outPtr >> 2] = 0; return 0; }
            // $getattr can hand back a RAW getset_descriptor for some
            // instance/attribute combinations. An unresolved descriptor
            // must never cross into C — invoke its getter.
            if (v.ob_type === rt.$B.getset_descriptor) {
                v = rt.$B.getset_descriptor.tp_descr_get(v, obj);
            }
            var h = rt.wrap(v);
            HEAP32[outPtr >> 2] = h;
            rt.incref(h);  // *Optional* API returns a NEW reference (caller DECREFs)
            return 1;
        } catch (e) {
            HEAP32[outPtr >> 2] = 0;
            // Only a MISSING attribute is the 0 case; any other exception
            // (e.g. a `write` property raising OSError — csv.writer's
            // BadWriter test) must propagate as -1 with the real type, per
            // CPython's PyObject_GetOptionalAttr contract.
            var ae = rt._b_.AttributeError;
            var isAttr = false;
            try {
                if (e && (e.__class__ === ae || e.ob_type === ae ||
                          (rt.$B.$isinstance && rt.$B.$isinstance(e, ae)))) {
                    isAttr = true;
                }
            } catch (_) {}
            if (isAttr) return 0;
            rt.forwardError(e, rt._b_.RuntimeError);
            return -1;
        }
    },

    /* _PyObject_GetState — return obj.__dict__ if present, else None.
     * Used by pickle protocol. */
    _PyObject_GetState__deps: ['$WasthonRT'],
    _PyObject_GetState: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (!obj) return rt.SLOT_NONE;
        var d = rt.$B.get_dict(obj);
        if (!d) return rt.SLOT_NONE;
        return rt.wrapNewRef(d);
    },

    /* PyObject_Str(o) — str(o). */
    PyObject_Str__deps: ['$WasthonRT'],
    PyObject_Str: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        try { return rt.wrapNewRef(rt._b_.str.$factory(obj)); }
        catch (e) { rt.forwardError(e, rt._b_.TypeError); return 0; }
    },

    /* PyObject_CallMethodObjArgs(obj, name, arg1, ..., NULL) */
    PyObject_CallMethodObjArgs__deps: ['$WasthonRT'],
    PyObject_CallMethodObjArgs: function(objH, nameH, varargs) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (!obj || name === null) return 0;
        var args = [];
        for (var p = varargs; ; p += 4) {
            var h = HEAP32[p >> 2];
            if (h === 0) break;
            args.push(rt.unwrap(h));
        }
        try {
            var m = rt.$B.$getattr(obj, name);
            return rt.wrapNewRef(rt.$B.$call.apply(null, [m].concat(args)));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.AttributeError), name + ": " + (e.message || e));
            return 0;
        }
    },

    /* PyImport_Import(name_str) — like PyImport_ImportModule but takes a
     * PyObject* str instead of const char*. */
    PyImport_Import__deps: ['$WasthonRT'],
    PyImport_Import: function(nameH) {
        var rt = WasthonRT;
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (name === null) return 0;
        // Pinned: module singleton (see PyImport_ImportModule).
        try { return rt.wrapPinned(rt._b_.__import__(name)); }
        catch (e) {
            rt.forwardError(e, rt._b_.ImportError);
            return 0;
        }
    },

    /* PyArg_UnpackTuple(args, name, min, max, &v1, &v2, ...) — extract
     * positional args from a tuple into out pointers. */
    PyArg_UnpackTuple__deps: ['$WasthonRT'],
    PyArg_UnpackTuple: function(argsH, namePtr, min, max, varargs) {
        var rt = WasthonRT;
        var args = rt.unwrap(argsH);
        var arr;
        if (Array.isArray(args)) arr = args;
        else if (args && typeof args.length === 'number') arr = Array.from(args);
        else arr = [];
        if (arr.length < min || arr.length > max) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                (namePtr ? UTF8ToString(namePtr) : "function") +
                "() takes " + min + " to " + max + " arguments, got " + arr.length);
            return 0;
        }
        var p = varargs;
        for (var i = 0; i < max; i++) {
            var outPtr = HEAP32[p >> 2];
            if (outPtr !== 0 && i < arr.length) {
                HEAP32[outPtr >> 2] = rt.wrap(arr[i]);
            }
            p += 4;
        }
        return 1;
    },

    /* _PyTime — JS Date-backed time helpers. */
    _PyTime_ObjectToTime_t__deps: ['$WasthonRT'],
    _PyTime_ObjectToTime_t: function(objH, secOutPtr, _round) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var sec;
        if (typeof obj === 'number') sec = Math.floor(obj);
        else if (typeof obj === 'bigint') sec = Number(obj);
        else { rt.setError(rt.wrap(rt._b_.TypeError), "expected number"); return -1; }
        // time_t is 8 bytes on wasm32 (it's typedef'd to int64_t in emscripten).
        var asU = sec < 0 ? (BigInt(sec) + 0x10000000000000000n) : BigInt(sec);
        HEAP32[ secOutPtr      >> 2] = Number(asU & 0xFFFFFFFFn) | 0;
        HEAP32[(secOutPtr + 4) >> 2] = Number((asU >> 32n) & 0xFFFFFFFFn) | 0;
        return 0;
    },
    _PyTime_localtime__deps: ['$WasthonRT'],
    _PyTime_localtime: function(t_lo, t_hi, tmPtr) {
        // t is int64 split as two 32-bit args by emcc i64 ABI.
        var sec = (t_hi * 0x100000000) + (t_lo >>> 0);
        var d = new Date(sec * 1000);
        // struct tm layout (per emscripten):
        //   +0  tm_sec     int
        //   +4  tm_min     int
        //   +8  tm_hour    int
        //   +12 tm_mday    int
        //   +16 tm_mon     int (0-11)
        //   +20 tm_year    int (year - 1900)
        //   +24 tm_wday    int
        //   +28 tm_yday    int
        //   +32 tm_isdst   int
        HEAP32[(tmPtr +  0) >> 2] = d.getSeconds();
        HEAP32[(tmPtr +  4) >> 2] = d.getMinutes();
        HEAP32[(tmPtr +  8) >> 2] = d.getHours();
        HEAP32[(tmPtr + 12) >> 2] = d.getDate();
        HEAP32[(tmPtr + 16) >> 2] = d.getMonth();
        HEAP32[(tmPtr + 20) >> 2] = d.getFullYear() - 1900;
        HEAP32[(tmPtr + 24) >> 2] = d.getDay();
        // tm_yday — compute day of year
        var start = new Date(d.getFullYear(), 0, 0);
        HEAP32[(tmPtr + 28) >> 2] = Math.floor((d - start) / 86400000);
        HEAP32[(tmPtr + 32) >> 2] = 0;  // tm_isdst — leave 0
        return 0;
    },

    /* PyLong from/to double */
    PyLong_FromDouble__deps: ['$WasthonRT'],
    PyLong_FromDouble: function(v) {
        return WasthonRT.wrapNewRef(Math.trunc(v));
    },
    PyLong_AsDouble__deps: ['$WasthonRT'],
    PyLong_AsDouble: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (typeof obj === 'number') return obj;
        // bool is an int subclass — PyLong_AsDouble(True) == 1.0 in CPython.
        // math.fsum's ASSIGN_DOUBLE routes a bool here (via PyLong_CheckExact),
        // so without this fsum([True, False, …]) summed every bool as 0.0
        // (statistics.fmean over booleans returned 0.0 instead of 0.6).
        if (typeof obj === 'boolean') return obj ? 1 : 0;
        if (typeof obj === 'bigint') {
            // CPython raises OverflowError when the integer is too large for a
            // double (returns -1.0 with the error set) — math.log/log10/log2's
            // loghelper relies on exactly this to fall back to _PyLong_Frexp.
            // Number(huge_bigint) silently yields Infinity, so log(10**1000)
            // computed log(inf) = inf instead.
            var d = Number(obj);
            if (!isFinite(d)) {
                rt.setError(rt.wrap(rt._b_.OverflowError),
                    "int too large to convert to float");
                return -1;
            }
            return d;
        }
        return 0;
    },
    PyNumber_Divmod__deps: ['$WasthonRT'],
    PyNumber_Divmod: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        try { return rt.wrapNewRef(rt._b_.divmod(a, b)); }
        catch (e) { rt.forwardError(e, rt._b_.TypeError); return 0; }
    },

    /* PyObject_CallNoArgs(callable) — callable(). */
    PyObject_CallNoArgs__deps: ['$WasthonRT'],
    PyObject_CallNoArgs: function(fnH) {
        var rt = WasthonRT;
        var fn = rt.unwrap(fnH);
        if (!fn) return 0;
        try { return rt.wrapMaybeType(rt.$B.$call(fn)); }
        catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* Py_VaBuildValue — variadic value builder. Same grammar as PyObject_CallFunction. */
    Py_VaBuildValue__deps: ['$WasthonRT'],
    Py_VaBuildValue: function(fmtPtr, va) {
        var rt = WasthonRT;
        var fmt = fmtPtr === 0 ? "" : UTF8ToString(fmtPtr);
        var p = va, i = 0;
        function takeScalar(c) {
            if (c === 'O') { var v = rt.unwrap(HEAP32[p >> 2]); p += 4; return v; }
            if (c === 's') { var sp = HEAP32[p >> 2]; p += 4;
                             return sp === 0 ? null : UTF8ToString(sp); }
            if (c === 'i') { var v = HEAP32[p >> 2]; p += 4; return v; }
            if (c === 'd') { if (p & 7) p = (p + 7) & ~7;
                             var v = HEAPF64[p >> 3]; p += 8; return v; }
            return undefined;
        }
        function parse(endChar) {
            var out = [];
            while (i < fmt.length) {
                var c = fmt[i];
                if (c === endChar) { i++; return out; }
                if (c === ',' || c === ' ' || c === ':') { i++; continue; }
                if (c === '(') { i++; out.push(rt._b_.tuple.$factory(parse(')'))); continue; }
                if (c === '[') { i++; out.push(parse(']')); continue; }
                if (c === '{') {
                    i++;
                    while (i < fmt.length && fmt[i] !== '}') i++;
                    if (fmt[i] === '}') i++;
                    out.push(rt._b_.dict.$factory());
                    continue;
                }
                i++;
                var v = takeScalar(c);
                if (v !== undefined) out.push(v);
            }
            return out;
        }
        var args = parse(undefined);
        // Py_VaBuildValue returns a single value if format yields one,
        // else a tuple of values. (Matches CPython.)
        if (args.length === 1) return rt.wrapNewRef(args[0]);
        return rt.wrapNewRef(rt._b_.tuple.$factory(args));
    },

    /* _PyLong_DivmodNear(a, b) — round-half-to-even integer divmod.
     * Returns a 2-tuple (quotient, remainder). */
    _PyLong_DivmodNear__deps: ['$WasthonRT'],
    _PyLong_DivmodNear: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH), b = rt.unwrap(bH);
        var aBI = typeof a === 'bigint' ? a : BigInt(Math.trunc(a));
        var bBI = typeof b === 'bigint' ? b : BigInt(Math.trunc(b));
        if (bBI === 0n) {
            rt.setError(rt.wrap(rt._b_.ZeroDivisionError), "integer division or modulo by zero");
            return 0;
        }
        // Python divmod-with-rounding-half-to-even, mimicking CPython.
        var q = aBI / bBI;
        var r = aBI - q * bBI;
        // Round half to even.
        var twoR = r * 2n;
        var absTwoR = twoR < 0n ? -twoR : twoR;
        var absB = bBI < 0n ? -bBI : bBI;
        if (absTwoR > absB || (absTwoR === absB && (q & 1n) === 1n)) {
            if ((r < 0n) === (bBI < 0n)) q += 1n;
            else q -= 1n;
            r = aBI - q * bBI;
        }
        var qN = Number(q), rN = Number(r);
        var qOut = (BigInt(qN) === q && Number.isSafeInteger(qN)) ? qN : q;
        var rOut = (BigInt(rN) === r && Number.isSafeInteger(rN)) ? rN : r;
        return rt.wrapNewRef(rt._b_.tuple.$factory([qOut, rOut]));
    },

    /* PyObject_CallFunctionObjArgs(callable, arg1, ..., NULL) — variadic call
     * with a NULL-terminated arg list. C calling convention puts the NULL
     * sentinel on the stack as a 0 handle, so we walk varargs reading 32-bit
     * handle slots until we hit 0. We collect into a JS array and dispatch
     * via Brython's $call. */
    PyObject_CallFunctionObjArgs__sig: 'iii',
    PyObject_CallFunctionObjArgs__deps: ['$WasthonRT'],
    PyObject_CallFunctionObjArgs: function(callableH, varargs) {
        var rt = WasthonRT;
        var fn = rt.unwrap(callableH);
        if (!fn) return 0;
        var args = [];
        for (var p = varargs; ; p += 4) {
            var h = HEAP32[p >> 2];
            if (h === 0) break;
            args.push(rt.toBrythonArg(rt.unwrap(h)));
        }
        try { return rt.wrapNewRef(rt.$B.$call.apply(null, [fn].concat(args))); }
        catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyList_AsTuple — coerce a list into a tuple. */
    PyList_AsTuple__deps: ['$WasthonRT'],
    PyList_AsTuple: function(listH) {
        var rt = WasthonRT;
        var l = rt.unwrap(listH);
        if (l === null) return 0;
        try { return rt.wrapNewRef(rt._b_.tuple.$factory(l)); }
        catch (e) { return 0; }
    },

    PyObject_GetAttrString__deps: ['$WasthonRT'],
    PyObject_GetAttrString: function(objHandle, namePtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objHandle);
        if (namePtr === 0) {
            rt.setError(rt.wrap(rt._b_.SystemError), "PyObject_GetAttrString: NULL name");
            return 0;
        }
        var name = UTF8ToString(namePtr);
        rt.trace('PyObject_GetAttrString', name);
        if (!obj) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyObject_GetAttrString: obj handle " + objHandle + " did not resolve (name=" + name + ")");
            return 0;
        }
        try {
            var v = rt.$B.$getattr(obj, name);
            if (v === undefined || v === null) {
                rt.setError(rt.wrap(rt._b_.AttributeError), "no attribute '" + name + "'");
                return 0;
            }
            return rt.wrapMaybeType(v);
        }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.AttributeError),
                "PyObject_GetAttrString: '" + name + "' (" + (e.message || e) + ")");
            return 0;
        }
    },

    /* PyObject_SetAttrString — set attribute by C string name. */
    PyObject_SetAttrString__deps: ['$WasthonRT'],
    PyObject_SetAttrString: function(objHandle, namePtr, valueHandle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objHandle);
        var name = namePtr ? UTF8ToString(namePtr) : null;
        if (!obj || name === null) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyObject_SetAttrString: invalid args");
            return -1;
        }
        try {
            rt._b_.setattr(obj, name, rt.unwrap(valueHandle));
            rt.incref(valueHandle);  // no-steal: attribute slot takes its own ref
            return 0;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.AttributeError),
                "set '" + name + "' failed: " + (e.message || String(e)));
            return -1;
        }
    },

    /* PyTuple_CheckExact — exactly a tuple. */
    PyTuple_CheckExact__deps: ['$WasthonRT'],
    PyTuple_CheckExact: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        // ob_type first: Brython 3.14 tuples (fast_tuple) carry ob_type,
        // not an own __class__ — the old test rejected every real tuple,
        // killing e.g. zstd's (ZstdDict, type) dict-form parsing.
        return (obj && (obj.ob_type === rt._b_.tuple ||
                        obj.__class__ === rt._b_.tuple)) ? 1 : 0;
    },

    /* PyDict_Check / PyDict_CheckExact — declared in wasthon.h but had no
     * JS impl, so emcc left the symbols undefined and pickle's runtime
     * checks (PyDict_CheckExact in save_dict's fast-path gate) silently
     * returned 0 → falling through to the reduce path that expects an
     * iterator at __reduce__()[4]. Adding them as proper predicates makes
     * pickle take the dict-specialised path. */
    PyDict_Check__deps: ['$WasthonRT'],
    PyDict_Check: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (!obj) return 0;
        try { return rt.$B.$isinstance(obj, rt._b_.dict) ? 1 : 0; }
        catch (e) { return 0; }
    },
    PyDict_CheckExact__deps: ['$WasthonRT'],
    PyDict_CheckExact: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (!obj) return 0;
        if (obj.__class__ === rt._b_.dict) return 1;
        try {
            if (rt.$B.$isinstance(obj, rt._b_.dict) &&
                rt.$B.get_class(obj) === rt._b_.dict) return 1;
        } catch (_) {}
        return 0;
    },

    /* PyType_Freeze — new in 3.14. Single-threaded WASM has no benefit; no-op. */
    PyType_Freeze: function(typeH) { return 0; },

    /* PyObject_SetAttr — set attribute by str name PyObject. */
    PyObject_SetAttr__deps: ['$WasthonRT'],
    PyObject_SetAttr: function(objH, nameH, valueH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (!obj || name === null) {
            rt.setError(rt.wrap(rt._b_.SystemError), "PyObject_SetAttr: invalid args");
            return -1;
        }
        try {
            rt._b_.setattr(obj, name, rt.unwrap(valueH));
            rt.incref(valueH);  // no-steal: attribute slot takes its own ref
            return 0;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.AttributeError),
                "set '" + name + "': " + (e.message || String(e)));
            return -1;
        }
    },

    /* PyModule_New(name) — create a new empty module object. */
    PyModule_New__deps: ['$WasthonRT'],
    PyModule_New: function(namePtr) {
        var rt = WasthonRT;
        var name = namePtr ? UTF8ToString(namePtr) : "";
        try {
            var mod = rt.$B.module.tp_new(rt.$B.module);
            rt.$B.module.tp_init(mod, name);
            return rt.wrapNewRef(mod);
        } catch (e) { return 0; }
    },

    /* PyDescr_NewGetSet — build a Brython property descriptor that wraps
     * a C-side PyGetSetDef. Same wiring as __wasthon_install_getsets but
     * for a single dynamic descriptor (pyexpat creates these at module
     * exec time for each XML handler). */
    PyDescr_NewGetSet__deps: ['$WasthonRT'],
    PyDescr_NewGetSet: function(typeH, getsetPtr) {
        var rt = WasthonRT;
        if (!getsetPtr) return 0;
        var namePtr   = HEAP32[ getsetPtr        >> 2];
        var getPtr    = HEAP32[(getsetPtr +  4)  >> 2];
        var setPtr    = HEAP32[(getsetPtr +  8)  >> 2];
        var closurePtr = HEAP32[(getsetPtr + 16) >> 2];
        var name      = namePtr ? UTF8ToString(namePtr) : "";

        var capGet = getPtr, capSet = setPtr, capClosure = closurePtr;

        var fget = capGet ? (function(getP, closP) {
            return rt.scoped(function(self) {
                var selfH = (self && self.__wasthon_ptr__) ? self.__wasthon_ptr__ : rt.wrap(self);
                rt.pendingException = null;
                var resH = getWasmTableEntry(getP)(selfH, closP);
                if (rt.pendingException) {
                    var pe = rt.pendingException; rt.pendingException = null;
                    var exc = rt.unwrap(pe.exc) || rt._b_.Exception;
                    throw rt.pendingExc(pe, exc);
                }
                return rt.unwrapResult(resH);
            });
        })(capGet, capClosure) : rt._b_.None;

        var fset = capSet ? (function(setP, closP) {
            return rt.scoped(function(self, value) {
                var selfH = (self && self.__wasthon_ptr__) ? self.__wasthon_ptr__ : rt.wrap(self);
                var valH = rt.wrap(value);
                rt.pendingException = null;
                var rc = getWasmTableEntry(setP)(selfH, valH, closP);
                if (rt.pendingException) {
                    var pe = rt.pendingException; rt.pendingException = null;
                    var exc = rt.unwrap(pe.exc) || rt._b_.Exception;
                    throw rt.pendingExc(pe, exc);
                }
                return rc;
            });
        })(capSet, capClosure) : rt._b_.None;

        var prop = rt._b_.property.$factory(fget, fset);
        prop.__name__ = name;
        prop.__wasthon_getset__ = getsetPtr;
        return rt.wrapNewRef(prop);
    },

    /* PyDescr_NAME — read the descriptor's __name__ field. */
    PyDescr_NAME__deps: ['$WasthonRT'],
    PyDescr_NAME: function(descrH) {
        var rt = WasthonRT;
        var d = rt.unwrap(descrH);
        return rt.wrap((d && d.__name__) || "");
    },

    /* PyDict_SetDefaultRef — set d[key]=default if missing, write back the
     * existing or new value into *result. Returns 1 if key existed, 0 if
     * default was set, -1 on error. */
    PyDict_SetDefaultRef__deps: ['$WasthonRT'],
    PyDict_SetDefaultRef: function(dH, kH, defH, resultPtr) {
        var rt = WasthonRT;
        var d = rt.unwrap(dH);
        var k = rt.unwrap(kH);
        try {
            if (rt._b_.dict.$contains(d, k)) {
                var v = rt._b_.dict.$getitem(d, k);
                // *result is a strong reference (CPython 3.13 contract).
                if (resultPtr) HEAP32[resultPtr >> 2] = rt.wrapNewRef(v);
                return 1;
            }
            var dv = rt.unwrap(defH);
            rt._b_.dict.$setitem(d, k, dv);
            rt.incref(defH);                      // dict takes its own ref (no-steal)
            if (resultPtr) {
                HEAP32[resultPtr >> 2] = defH;
                rt.incref(defH);                  // *result strong reference
            }
            return 0;
        } catch (e) { return -1; }
    },

    /* PyUnicode_Decode(bytes, n, encoding, errors) — generic decoder. */
    PyUnicode_Decode__deps: ['$WasthonRT'],
    PyUnicode_Decode: function(sPtr, size, encodingPtr, errorsPtr) {
        var rt = WasthonRT;
        var enc = encodingPtr ? UTF8ToString(encodingPtr).toLowerCase() : 'utf-8';
        // Python encoding names are not WHATWG TextDecoder labels: pyexpat
        // hands us 'iso8859' (a CPython alias of latin-1), Python spells
        // others with underscores. Normalize before TextDecoder.
        var encMap = {
            'iso8859': 'iso-8859-1', 'latin': 'iso-8859-1',
            'latin1': 'iso-8859-1', 'latin_1': 'iso-8859-1',
            'l1': 'iso-8859-1', 'cp819': 'iso-8859-1', '8859': 'iso-8859-1',
            'us_ascii': 'ascii', 'utf_8': 'utf-8', 'utf8': 'utf-8',
            'utf_16': 'utf-16', 'utf_16_le': 'utf-16le', 'utf_16_be': 'utf-16be',
        };
        enc = encMap[enc] || enc.replace(/_/g, '-');
        try {
            var bytes = HEAPU8.slice(sPtr, sPtr + size);
            // ignoreBOM only for utf-8: a leading U+FEFF is data there (CPython
            // keeps it), whereas utf-16/utf-32 legitimately consume it as the
            // byte-order mark. TextDecoder strips it by default otherwise.
            var s = new TextDecoder(enc,
                { fatal: false, ignoreBOM: enc === 'utf-8' }).decode(bytes);
            return rt.wrapNewRef(s);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.UnicodeDecodeError),
                "decode " + enc + " failed: " + (e.message || String(e)));
            return 0;
        }
    },

    PyObject_HasAttrString__deps: ['$WasthonRT'],
    /* PyObject_HasAttrWithError — like PyObject_HasAttr but returns -1 on
     * genuine getattr error (any non-AttributeError exception). Returns 1
     * if present, 0 if absent. New in CPython 3.13. */
    PyObject_HasAttrWithError__deps: ['$WasthonRT'],
    PyObject_HasAttrWithError: function(objH, nameH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.unwrap(nameH);
        if (!obj || name === null || name === undefined) return 0;
        try { rt.$B.$getattr(obj, name); return 1; }
        catch (e) {
            /* The bridge's $getattr raises Brython exception instances on
             * miss. AttributeError → absent (return 0); anything else →
             * propagate as -1. Several detection strategies because the
             * incoming `e` can be a Brython exc instance, a JS Error, or a
             * builtin AttributeError with $factory. */
            var ae = rt._b_.AttributeError;
            var isAttr = false;
            try {
                if (e && (e.__class__ === ae ||
                          (e.ob_type && e.ob_type === ae) ||
                          (rt.$B.$isinstance && rt.$B.$isinstance(e, ae)))) {
                    isAttr = true;
                }
            } catch (_) {}
            if (isAttr) return 0;
            rt.forwardError(e, rt._b_.RuntimeError);
            return -1;
        }
    },

    PyObject_HasAttrString: function(objHandle, namePtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objHandle);
        if (!obj || !namePtr) return 0;
        var name = UTF8ToString(namePtr);
        try { rt.$B.$getattr(obj, name); return 1; }
        catch (e) { return 0; }
    },

    /* 64-bit variant. blake2module's clinic uses this for fanout/depth/
     * leaf_length/node_offset/etc. We store as a pair of u32 (lo, hi). */
    _PyLong_UnsignedLongLong_Converter__deps: ['$WasthonRT'],
    _PyLong_UnsignedLongLong_Converter: function(handle, ptr) {
        var obj = WasthonRT.unwrap(handle);
        var bv;
        if (typeof obj === 'number') {
            if (obj < 0) {
                // pycore converter: ValueError for negatives
                WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.ValueError),
                    "value must be positive");
                return 0;
            }
            bv = BigInt(obj);
        } else if (typeof obj === 'bigint') {
            if (obj < 0n) {
                // pycore converter: ValueError for negatives
                WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.ValueError),
                    "value must be positive");
                return 0;
            }
            bv = obj;
        } else {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.TypeError),
                "an integer is required");
            return 0;
        }
        if (bv > 0xFFFFFFFFFFFFFFFFn) {
            // PyLong_AsUnsignedLongLong overflow; silently masking let
            // blake2 node_offset=2**64 through as 0.
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.OverflowError),
                "Python int too large to convert to C unsigned long long");
            return 0;
        }
        // Store little-endian u64 as two u32s.
        HEAPU32[ ptr        >> 2] = Number(bv & 0xFFFFFFFFn);
        HEAPU32[(ptr + 4)   >> 2] = Number((bv >> 32n) & 0xFFFFFFFFn);
        return 1;
    },

    PyObject_IsTrue__deps: ['$WasthonRT'],
    PyObject_IsTrue: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null || obj === undefined) return 0;
        // Use Brython's truth semantics.
        try {
            return rt.$B.$bool(obj) ? 1 : 0;
        } catch (e) {
            // Propagate __bool__'s own exception (e.g. struct.pack('?',
            // ExplodingBool()) must raise the OSError __bool__ raised, not a
            // masked TypeError — test_struct.test_bool). -1 per the contract.
            if (rt.forwardError) rt.forwardError(e, rt._b_.TypeError);
            else rt.setError(rt.wrap(rt._b_.TypeError),
                e.message || "PyObject_IsTrue failed");
            return -1;
        }
    },

    /* Set a key in a Brython dict. blake2module uses this to populate
     * tp_dict with module constants (SALT_SIZE, PERSON_SIZE, etc.). */
    PyDict_SetItemString__deps: ['$WasthonRT'],
    PyDict_SetItemString: function(dictHandle, namePtr, valueHandle) {
        var rt = WasthonRT;
        var d = rt.unwrap(dictHandle);
        if (namePtr === 0) {
            rt.setError(rt.wrap(rt._b_.SystemError), "PyDict_SetItemString: NULL name");
            return -1;
        }
        var name = UTF8ToString(namePtr);
        rt.trace('PyDict_SetItemString', name);
        if (!d) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyDict_SetItemString: dict handle " + dictHandle + " did not resolve (name=" + name + ")");
            return -1;
        }
        var v = rt.unwrap(valueHandle);
        try {
            rt.$B.str_dict_set(d, name, v);
            rt.incref(valueHandle);  // no-steal: dict takes its own ref
            return 0;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.RuntimeError),
                "PyDict_SetItemString: " + (e.message || e));
            return -1;
        }
    },

    /* Dict size — clinic glue uses this to count kwargs. */
    PyDict_GET_SIZE__deps: ['$WasthonRT'],
    PyDict_GET_SIZE: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj === null) return 0;
        // Brython dicts: prefer .__len__ if a Python dict; else JS object key count.
        if (obj && typeof obj.size === 'number') return obj.size;
        if (obj && obj.$jsobj) return Object.keys(obj.$jsobj).length;
        if (Array.isArray(obj)) return obj.length;
        // Symbol-keyed Brython dict: walk own keys.
        if (typeof obj === 'object') {
            var n = 0;
            for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) n++;
            try {
                if (WasthonRT.$B.get_class(obj) === WasthonRT._b_.dict) {
                    var KS = WasthonRT.$B.DICT_KEYS;
                    var kt = KS ? obj[KS] : null;
                    if (kt) {
                        for (var ki = 0; ki < kt.length; ki++) {
                            if (kt[ki] !== undefined) n++;
                        }
                    }
                }
            } catch (_e) {}
            return n;
        }
        return 0;
    },

    /* sha3 dealloc + various: PyErr_BadInternalCall sets SystemError. */
    PyErr_BadInternalCall__deps: ['$WasthonRT'],
    PyErr_BadInternalCall: function() {
        WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.SystemError),
            "bad argument to internal function");
    },

    /* _PyTuple_CAST(t)->ob_item — materialize a C-side struct
     * { PyObject **ob_item; } in linear memory whose ob_item points
     * to a freshly built PyObject*[N] array of handles. Leaks per call
     * (one alloc per factory invocation), acceptable for now. */
    wasthon_tuple_view__deps: ['$WasthonRT'],
    wasthon_tuple_view: function(handle) {
        var rt = WasthonRT;
        var arr = rt.unwrap(handle);
        if (!Array.isArray(arr)) {
            // Brython tuples are JS arrays; defensively handle bytes/etc.
            arr = arr ? [arr] : [];
        }
        var n = arr.length;
        // 4 bytes (ob_item ptr) + 4*n (handles)
        var structPtr = _malloc(4 + 4 * n);
        if (structPtr === 0) return 0;
        var itemsPtr = structPtr + 4;
        HEAP32[structPtr >> 2] = itemsPtr;
        for (var i = 0; i < n; i++) {
            HEAP32[(itemsPtr + i*4) >> 2] = rt.wrap(arr[i]);
        }
        return structPtr;
    },

    PyTuple_GET_SIZE__deps: ['$WasthonRT'],
    PyTuple_GET_SIZE: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj === null) return 0;
        // Brython tuples are arrays with __class__ = _b_.tuple.
        return obj.length || 0;
    },

    /* --------------------------------------------------------------- *
     * Exception state                                                 *
     * --------------------------------------------------------------- */

    PyErr_NoMemory__deps: ['$WasthonRT'],
    PyErr_NoMemory: function() {
        var rt = WasthonRT;
        rt.setError(rt.wrap(rt._b_.MemoryError), "out of memory");
        return 0;  // NULL
    },

    PyErr_SetString__deps: ['$WasthonRT'],
    PyErr_SetString: function(excHandle, msgPtr) {
        var msg = msgPtr === 0 ? "" : UTF8ToString(msgPtr);
        WasthonRT.setError(excHandle, msg);
    },

    /* PyErr_Format(exc, fmt, ...) — set the pending exception with a
     * formatted message. We interpret a subset of CPython's printf-style
     * codes: %s, %d, %ld, %u, %zd, %p, %R/%S (str-of). Other codes copy
     * the format char verbatim so the message still gives a useful hint. */
    PyErr_Format__deps: ['$WasthonRT'],
    PyErr_Format: function(excHandle, fmtPtr, varargs) {
        var rt = WasthonRT;
        var fmt = fmtPtr === 0 ? "" : UTF8ToString(fmtPtr);
        var out = "", p = varargs;
        for (var i = 0; i < fmt.length; i++) {
            if (fmt[i] !== '%') { out += fmt[i]; continue; }
            // Parse [flags][width][.precision][length]conversion — matches the
            // PyOS_snprintf parser. Without precision, `PyErr_Format(..,
            // "Error %d %s: %.200s", ...)` (zlib.error et al.) kept `%.200s`
            // verbatim in the message.
            var rawStart = i;
            var leftAlign = false, zeroPad = false;
            while (i + 1 < fmt.length && "-+0 #".indexOf(fmt[i+1]) !== -1) {
                if (fmt[i+1] === '-') leftAlign = true;
                else if (fmt[i+1] === '0') zeroPad = true;
                i++;
            }
            var width = 0;
            while (i + 1 < fmt.length && fmt[i+1] >= '0' && fmt[i+1] <= '9') {
                width = width * 10 + (fmt[++i].charCodeAt(0) - 48);
            }
            var precision = -1;
            if (i + 1 < fmt.length && fmt[i+1] === '.') {
                i++; precision = 0;
                while (i + 1 < fmt.length && fmt[i+1] >= '0' && fmt[i+1] <= '9') {
                    precision = precision * 10 + (fmt[++i].charCodeAt(0) - 48);
                }
            }
            while (i + 1 < fmt.length && "lhzj".indexOf(fmt[i+1]) !== -1) { i++; }
            var c = fmt[++i];
            var piece = null;
            if (c === 's') {
                var sp = HEAP32[p >> 2]; p += 4;
                piece = (sp === 0) ? "(null)" : UTF8ToString(sp);
                if (precision >= 0) piece = piece.slice(0, precision);
            } else if (c === 'd' || c === 'i') {
                piece = String(HEAP32[p >> 2] | 0); p += 4;
            } else if (c === 'u') {
                piece = String(HEAPU32[p >> 2] >>> 0); p += 4;
            } else if (c === 'x') {
                piece = (HEAPU32[p >> 2] >>> 0).toString(16); p += 4;
            } else if (c === 'X') {
                piece = (HEAPU32[p >> 2] >>> 0).toString(16).toUpperCase(); p += 4;
            } else if (c === 'p') {
                piece = "0x" + (HEAPU32[p >> 2] >>> 0).toString(16); p += 4;
            } else if (c === 'R' || c === 'S' || c === 'A') {
                // %R → repr(obj), %S → str(obj), %A → ascii(obj). Was naive
                // `String(obj)` which stringifies Brython objects as
                // `[object Object]`. _pickle relies on a real repr for class
                // names, e.g. "must be %R, not %R" → "<class 'int'>".
                var h = HEAP32[p >> 2]; p += 4;
                var obj = rt.unwrap(h);
                try {
                    if (c === 'R')      piece = String(rt._b_.repr(obj));
                    else if (c === 'A') piece = String(rt._b_.ascii(obj));
                    else                piece = String(rt._b_.str.$factory(obj));
                } catch (_) { piece = "<obj>"; }
            } else if (c === 'T' || c === 'N') {
                // %T = type name of instance; %N = type name of PyTypeObject*.
                // Used by _pickle's error formatting (CPython 3.13+).
                var th = HEAP32[p >> 2]; p += 4;
                var tobj = rt.unwrap(th);
                if (c === 'N') {
                    piece = (tobj && tobj.__name__) ? tobj.__name__ : '<type>';
                } else {
                    try { piece = rt.$B.class_name(tobj); }
                    catch (e) { piece = '<type-err>'; }
                }
            } else if (c === '%') {
                piece = '%';
            } else {
                out += fmt.slice(rawStart, i + 1);  // unknown — leave as-is
                continue;
            }
            if (width > piece.length) {
                var pad = (zeroPad && !leftAlign && c !== 's' && c !== 'R'
                            && c !== 'S' && c !== 'A')
                    ? '0' : ' ';
                var fill = pad.repeat(width - piece.length);
                piece = leftAlign ? (piece + fill) : (fill + piece);
            }
            out += piece;
        }
        rt.setError(excHandle, out);
        return 0;
    },

    PyErr_Clear__deps: ['$WasthonRT'],
    PyErr_Clear: function() {
        WasthonRT.pendingException = null;
    },

    /* _PyErr_FormatFromCause(exc, fmt, ...) — set a new formatted error,
     * conceptually chaining the in-flight one as __cause__. The bridge has
     * no chaining machinery, so we drop the prior exception and set the
     * new one (message still surfaces; __cause__ link is lost). Reuses
     * PyErr_Format's printf-subset formatter. */
    _PyErr_FormatFromCause__deps: ['$WasthonRT', 'PyErr_Format'],
    _PyErr_FormatFromCause: function(excHandle, fmtPtr, varargs) {
        WasthonRT.pendingException = null;
        return _PyErr_Format(excHandle, fmtPtr, varargs);
    },

    /* PyErr_Print — emit the pending exception to the JS console and clear
     * it. No sys.last_*, no traceback object (the bridge has no traceback
     * machinery); the message is what callers care about here. */
    PyErr_Print__deps: ['$WasthonRT'],
    PyErr_Print: function() {
        var rt = WasthonRT;
        var e = rt.pendingException;
        if (e) {
            var name = "Exception";
            try { name = rt.unwrap(e.exc).__name__ || name; } catch (_) {}
            console.error("[wasthon] " + name + ": " + (e.msg || ""));
        }
        rt.pendingException = null;
    },

    /* PyObject_CallFinalizerFromDealloc — tp_dealloc-path finalizer hook.
     * No-op: the bridge has no tp_dealloc dispatch (Brython owns object
     * lifecycle). Resource types must expose explicit close()/__exit__. */
    PyObject_CallFinalizerFromDealloc: function(_self) { return 0; },

    PyErr_Occurred__deps: ['$WasthonRT'],
    PyErr_Occurred: function() {
        return WasthonRT.pendingException ? WasthonRT.pendingException.exc : 0;
    },

    PyErr_SetNone__deps: ['$WasthonRT'],
    PyErr_SetNone: function(excHandle) {
        WasthonRT.setError(excHandle, "");
    },

    /* PyErr_SetObject(exc, value): like PyErr_SetString but value is any
     * Python object (not just a C string). _decimal uses this to pass a
     * list/tuple of signal flags as the exception value. The throw site
     * does `exc.$factory(pe.msg)` — so storing the Python value in `msg`
     * works directly: Brython exception classes accept any args as their
     * .args tuple. */
    PyErr_SetObject__deps: ['$WasthonRT'],
    PyErr_SetObject: function(excHandle, valueHandle) {
        var rt = WasthonRT;
        var v = rt.unwrap(valueHandle);
        var msg = "";
        if (v === null || v === undefined) {
            msg = "";
        } else if (typeof v === 'string') {
            msg = v;
        } else if (v && (v.__class__ || (v.ob_type && v.args !== undefined))) {
            try {
                if (v.args && v.args.length > 0) msg = String(v.args[0]);
                else msg = rt.$B.class_name(v);
            } catch (_) { msg = ""; }
            // Preserve v ONLY when it is a genuine exception instance, so any
            // attributes C set on it (ExpatError.code/lineno/offset, …) survive
            // instead of being lost to a reconstructed exc(msg). _decimal passes
            // a *list* of signal flags as the value here — that must build
            // exc(flags), not be thrown as-is, so it falls through to reconstruct.
            var isExc = false;
            try { isExc = rt.$B.$isinstance(v, rt._b_.BaseException); } catch (_) {}
            if (isExc) {
                rt.setError(excHandle, msg, v);
                return;
            }
        } else if (typeof v === 'number' || typeof v === 'bigint') {
            // A primitive numeric value: CPython does exc(value), keeping the
            // value's type as the single arg. _json's raise_stop_iteration sets
            // StopIteration(idx) with an int; String(v) used to coerce it to a
            // str, so StopIteration(5).value came back "5" and json's decoder
            // ("Expecting value" -> JSONDecodeError(msg, doc, err.value)) then
            // fed a str pos to doc.count('\\n', 0, pos) ("'str' object cannot be
            // interpreted as an integer"). Build the instance here and preserve
            // it (pendingExc returns it as-is) so .value keeps the int.
            try {
                rt.setError(excHandle, "", rt.$B.$call(rt.unwrap(excHandle), v));
                return;
            } catch (_) {
                try { msg = String(v); } catch (_2) { msg = ""; }
            }
        } else {
            try { msg = String(v); } catch (_) { msg = ""; }
        }
        rt.setError(excHandle, msg);
    },

    /* PyObject_HashNotImplemented: used as a tp_hash slot to declare a type
     * unhashable. CPython sets TypeError and returns -1. */
    PyObject_HashNotImplemented__deps: ['$WasthonRT'],
    PyObject_HashNotImplemented: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        var name = (obj && obj.__class__ && obj.__class__.$infos &&
                    obj.__class__.$infos.__name__) || "object";
        rt.setError(rt.wrap(rt._b_.TypeError), "unhashable type: '" + name + "'");
        return -1;
    },

    /* _PyBytes_Resize — resize a bytes object in place (conceptually; we
     * actually create a new one). If the bytes has a cached linear-memory
     * pointer (because PyBytes_AS_STRING was called and C may have
     * written into the buffer), read from the live pointer rather than
     * from .source which can be stale. This is the path zlib uses to
     * finalize a compressed output. */
    _PyBytes_Resize__deps: ['$WasthonRT'],
    _PyBytes_Resize: function(pvPtr, newsize) {
        var rt = WasthonRT;
        var handle = HEAP32[pvPtr >> 2];
        var b = rt.unwrap(handle);
        if (b === null) return -1;
        var newArr = new Array(newsize);
        if (b.__wasthon_cstr__) {
            // Live data lives in linear memory.
            var ptr = b.__wasthon_cstr__;
            for (var i = 0; i < newsize; i++) newArr[i] = HEAPU8[ptr + i];
        } else {
            var src = b.source || [];
            var oldLen = src.length;
            for (var i = 0; i < newsize; i++) newArr[i] = i < oldLen ? (src[i] & 0xff) : 0;
        }
        var newBytes = rt._b_.bytes.$factory(newArr);
        // CPython contract: the reference in *pv is consumed and replaced
        // by a new one. Without the decref the original placeholder
        // (refcount 1 from PyBytes_FromStringAndSize) leaks on every
        // resize — one pinned handle per pickle.dumps().
        var newHandle = rt.wrapNewRef(newBytes);
        HEAP32[pvPtr >> 2] = newHandle;
        rt.decref(handle);
        return 0;
    },

    /* _PyNumber_Index — operator.index semantics: coerce via __index__ ONLY,
     * never __int__. The old code used int.$factory (== int(obj)), which falls
     * back to __int__ when __index__ raises — so struct.pack of an object whose
     * __index__ raises but __int__ returns an int silently packed the __int__
     * value (test_struct.test_integers BadIndex). Mirrors PyNumber_AsSsize_t. */
    _PyNumber_Index__deps: ['$WasthonRT'],
    _PyNumber_Index: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if ((typeof obj === 'number' && Number.isInteger(obj)) ||
            typeof obj === 'bigint') {
            return handle;
        }
        var idx = null;
        try { idx = rt.$B.$getattr(obj, '__index__', null); } catch (e) { idx = null; }
        if (!idx) {
            var nm = "?"; try { nm = rt.$B.class_name(obj); } catch (e) {}
            rt.setError(rt.wrap(rt._b_.TypeError),
                "'" + nm + "' object cannot be interpreted as an integer");
            return 0;
        }
        var iv;
        try {
            iv = rt.$B.$call(idx);
        } catch (e) {
            // __index__ raised — propagate it; do NOT fall back to __int__.
            if (rt.forwardError) rt.forwardError(e, rt._b_.TypeError);
            else rt.setError(rt.wrap(rt._b_.TypeError), "__index__ raised");
            return 0;
        }
        if (!rt._b_.isinstance(iv, rt._b_.int)) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "__index__ returned non-int (type " +
                (rt.$B.class_name ? rt.$B.class_name(iv) : typeof iv) + ")");
            return 0;
        }
        return rt.wrapNewRef(iv);
    },

    /* PyArg_ParseTuple / PyArg_ParseTupleAndKeywords — legacy varargs
     * parsers. _decimal uses ONLY the 'O' (PyObject*) format with '|'
     * for optional args — no 'i', 's', 'y*', etc. We implement that
     * narrow subset. If a future module needs more codes, extend here.
     *
     * Format scan rules:
     *   'O'  consume one PyObject** from varargs; bind to next arg
     *   '|'  separator: everything after is optional
     *
     * Conventions:
     *   - args: positional tuple/list of supplied values (may be empty)
     *   - kwds: keyword dict, or NULL/0 if none
     *   - kwlist: NULL-terminated array of (char *) names matching format slots
     *   - varargs: PyObject** out pointers, one per non-'|' slot
     *
     * Returns 1 on success, 0 on failure (with TypeError set). Out pointers
     * for absent optional args are left as-is (caller initializes them).
     */
    PyArg_ParseTupleAndKeywords__deps: ['$WasthonRT', 'PyUnicode_AsUTF8', 'PyFloat_AsDouble'],
    PyArg_ParseTupleAndKeywords: function(argsH, kwdsH, formatPtr, kwlistPtr, varargs) {
        var rt = WasthonRT;
        var args = rt.unwrap(argsH);
        var kwds = kwdsH === 0 ? null : rt.unwrap(kwdsH);
        var format = formatPtr === 0 ? "" : UTF8ToString(formatPtr);

        /* Strip trailing function name marker (":fname" or ";errmsg") which
         * is the standard PyArg_ParseTuple convention for embedding a name
         * to use in error messages. */
        var fname = '';
        var sep = format.search(/[:;]/);
        if (sep >= 0) {
            if (format[sep] === ':') fname = format.slice(sep + 1);
            format = format.slice(0, sep);
        }

        // Count slots (non-'|' chars).
        var totalSlots = 0;
        for (var i = 0; i < format.length; i++) {
            if (format[i] !== '|') totalSlots++;
        }

        // Read kwlist names.
        var kwlist = [];
        if (kwlistPtr !== 0) {
            for (var i = 0; i < totalSlots; i++) {
                var namePtr = HEAP32[(kwlistPtr + i * 4) >> 2];
                if (namePtr === 0) break;
                kwlist.push(UTF8ToString(namePtr));
            }
        }

        // CPython's PyArg_ParseTupleAndKeywords rejects keyword arguments
        // not named in kwlist. This parser silently dropped them, so e.g.
        // csv.reader([], bad_attr=0) / register_dialect(n, badargument=None)
        // succeeded instead of raising TypeError. (The clinic-side
        // _PyArg_UnpackKeywords got this check earlier; this legacy parser
        // was left out.)
        if (kwds) {
            try {
                var kwkeys = rt.$B.$call(rt._b_.list,
                    rt.$B.$call(rt.$B.$getattr(kwds, 'keys')));
                for (var ki = 0; ki < kwkeys.length; ki++) {
                    var kname = rt.asJSStr(kwkeys[ki]);
                    if (kname !== null && kwlist.indexOf(kname) < 0) {
                        rt.setError(rt.wrap(rt._b_.TypeError),
                            "'" + kname +
                            "' is an invalid keyword argument for this function");
                        return 0;
                    }
                }
            } catch (_) { /* unusable mapping — let the slot loop handle it */ }
        }

        // Normalise args to a JS array of positional values.
        var posArgs;
        if (Array.isArray(args)) posArgs = args;
        else if (args && typeof args.length === 'number') posArgs = Array.from(args);
        else if (args === null || args === undefined) posArgs = [];
        else posArgs = [];

        // CPython rejects more positional args than format slots; this
        // parser silently ignored the extras, so e.g.
        // zlib._ZlibDecompressor(-15, b"x", 5) succeeded instead of raising.
        if (posArgs.length > totalSlots) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                (fname || 'function') + "() takes at most " + totalSlots +
                " arguments (" + posArgs.length + " given)");
            return 0;
        }

        // Walk format, populating out pointers.
        var slotIdx = 0;
        var p = varargs;
        var seenPipe = false;
        for (var i = 0; i < format.length; i++) {
            var c = format[i];
            if (c === '|') { seenPipe = true; continue; }
            /* 'X&' converter form (e.g. 'O&'): the varargs supply a converter
             * function pointer followed by its output address; the converter
             * does the conversion+validation itself. _lzma's filter-spec parse
             * leans on it heavily ('|OOO&O&O&...'). */
            var isConv = (i + 1 < format.length && format[i + 1] === '&');
            if (isConv) { i++; }
            else if (c !== 'O' && c !== 'i' && c !== 'I' && c !== 'k' &&
                c !== 'l' && c !== 'L' && c !== 'K' && c !== 'n' &&
                c !== 'b' && c !== 'B' && c !== 'h' && c !== 'H' &&
                c !== 'p' && c !== 'C' && c !== 'U' &&
                c !== 's' && c !== 'z' && c !== 'f' && c !== 'd') {
                rt.setError(rt.wrap(rt._b_.SystemError),
                    "PyArg_ParseTuple[AndKeywords]: format char '" + c + "' not implemented");
                return 0;
            }

            var value = undefined;
            if (slotIdx < posArgs.length) {
                value = posArgs[slotIdx];
            } else if (kwds && kwlist[slotIdx]) {
                try {
                    var got = rt.$B.$getattr(kwds, 'get');
                    value = got(kwlist[slotIdx]);
                    if (value === rt._b_.None) value = undefined;
                } catch (_) { value = undefined; }
                if (value === undefined) {
                    try {
                        if (rt._b_.dict.$contains_string(kwds, kwlist[slotIdx])) {
                            value = rt._b_.dict.$getitem(kwds, kwlist[slotIdx]);
                        }
                    } catch (_) {}
                }
            }

            if (value !== undefined && isConv) {
                /* Converter slot: varargs = [converter fn ptr, output addr].
                 * Call converter(PyObject* value, void* addr) -> int (0=fail).
                 * On failure leave the converter's error set and bail. */
                var convPtr = HEAP32[p >> 2];
                var convOut = HEAP32[(p + 4) >> 2];
                var convFn = getWasmTableEntry(convPtr);
                var convOk = convFn(rt.wrap(value), convOut);
                if (!convOk) {
                    if (!rt.pendingException) {
                        rt.setError(rt.wrap(rt._b_.TypeError),
                            "invalid value for argument '" +
                            (kwlist[slotIdx] || ('#' + slotIdx)) + "'");
                    }
                    return 0;
                }
            } else if (value !== undefined) {
                /* The varargs slot at p contains a *pointer* (&v); we
                 * write the converted value to *p. The width and signedness
                 * of the store depend on the format char. */
                var outPtr = HEAP32[p >> 2];
                if (outPtr !== 0) {
                    if (c === 'O') {
                        HEAP32[outPtr >> 2] = rt.wrap(value);
                    } else if (c === 'U') {
                        /* Unicode object: must be a str; store the handle. */
                        if (rt.asJSStr(value) === null) {
                            rt.setError(rt.wrap(rt._b_.TypeError),
                                "argument must be str");
                            return 0;
                        }
                        HEAP32[outPtr >> 2] = rt.wrap(value);
                    } else if (c === 'p') {
                        /* predicate: store a full int 0/1. CPython's 'p' writes
                         * an int* (4 bytes); writing only the low byte (HEAPU8)
                         * left the high 3 bytes of the C int uninitialized, so a
                         * False predicate could read back as a garbage-nonzero
                         * int — _json's make_encoder(allow_nan=False) then saw
                         * allow_nan as true and never rejected nan/inf.
                         * (_b_.bool.$factory: Brython 3.14 made _b_.bool a
                         * PyTypeObject mirror, no longer callable directly.) */
                        HEAP32[outPtr >> 2] = rt._b_.bool.$factory(value) ? 1 : 0;
                    } else if (c === 'C') {
                        /* single Python str char as C int (codepoint) */
                        var s = rt.asJSStr(value);
                        if (s === null || s.length !== 1) {
                            rt.setError(rt.wrap(rt._b_.TypeError),
                                "expected a single character str");
                            return 0;
                        }
                        HEAP32[outPtr >> 2] = s.codePointAt(0) || s.charCodeAt(0);
                    } else if (c === 's' || c === 'z') {
                        /* str -> C UTF-8 string (reuses PyUnicode_AsUTF8: cached
                         * and kept alive with the str). 'z' accepts None->NULL. */
                        if (c === 'z' && value === rt._b_.None) {
                            HEAP32[outPtr >> 2] = 0;
                        } else {
                            var sp = _PyUnicode_AsUTF8(rt.wrap(value));
                            if (sp === 0) return 0;   /* str-expected TypeError set */
                            HEAP32[outPtr >> 2] = sp;
                        }
                    } else if (c === 'f' || c === 'd') {
                        /* float ('f') / double ('d'): reuse PyFloat_AsDouble
                         * (handles int/float/bool & __float__, sets TypeError
                         * on a bad operand). */
                        var dv = _PyFloat_AsDouble(rt.wrap(value));
                        if (dv === -1 && rt.pendingException) return 0;
                        if (c === 'f') HEAPF32[outPtr >> 2] = dv;
                        else HEAPF64[outPtr >> 3] = dv;
                    } else {
                        /* numeric (all remaining codes are integer formats):
                         * CPython getargs accepts int/bool/__index__ and
                         * rejects str/float/None with TypeError. The old
                         * Number(value)||0 parsed _ZlibDecompressor("ASDA")
                         * as wbits=0. */
                        var n;
                        if (typeof value === 'number' && Number.isInteger(value)) {
                            n = value;
                        } else if (typeof value === 'bigint') {
                            n = Number(value);
                        } else if (value === true) {
                            n = 1;
                        } else if (value === false) {
                            n = 0;
                        } else {
                            var idxFn = null;
                            try { idxFn = rt.$B.$getattr(value, '__index__', null); }
                            catch (_) { idxFn = null; }
                            if (idxFn) {
                                try {
                                    var iv = rt.$B.$call(idxFn);
                                    n = (typeof iv === 'bigint') ? Number(iv)
                                      : (iv && iv.value !== undefined ? iv.value
                                                                      : Number(iv));
                                } catch (e) {
                                    rt.forwardError(e, rt._b_.TypeError);
                                    return 0;
                                }
                            } else {
                                var tn;
                                try { tn = rt.$B.class_name ? rt.$B.class_name(value) : typeof value; }
                                catch (_) { tn = typeof value; }
                                rt.setError(rt.wrap(rt._b_.TypeError),
                                    "'" + tn + "' object cannot be interpreted as an integer");
                                return 0;
                            }
                        }
                        switch (c) {
                            case 'i': case 'I': case 'l':
                                HEAP32[outPtr >> 2] = n | 0; break;
                            case 'k': case 'L': case 'K':
                                /* 64-bit slot: write low 32, zero high 32 */
                                HEAP32[outPtr >> 2] = n | 0;
                                HEAP32[(outPtr + 4) >> 2] = ((n / 0x100000000) | 0);
                                break;
                            case 'n':  /* Py_ssize_t: 32-bit in wasm32 */
                                HEAP32[outPtr >> 2] = n | 0; break;
                            case 'h': case 'H':
                                HEAP16[outPtr >> 1] = n & 0xffff; break;
                            case 'b': case 'B':
                                HEAPU8[outPtr] = n & 0xff; break;
                        }
                    }
                }
            } else if (!seenPipe) {
                rt.setError(rt.wrap(rt._b_.TypeError),
                    "missing required argument '" +
                    (kwlist[slotIdx] || ('#' + slotIdx)) + "'");
                return 0;
            }
            /* A converter slot consumes two varargs entries (fn ptr + addr). */
            p += isConv ? 8 : 4;
            slotIdx++;
        }

        return 1;
    },

    PyArg_ParseTuple__deps: ['$WasthonRT', 'PyArg_ParseTupleAndKeywords'],
    PyArg_ParseTuple: function(argsH, formatPtr, varargs) {
        return _PyArg_ParseTupleAndKeywords(argsH, 0, formatPtr, 0, varargs);
    },

    /* --------------------------------------------------------------- *
     * Helpers                                                         *
     * --------------------------------------------------------------- */

    _Py_strhex__deps: ['$WasthonRT'],
    _Py_strhex: function(argbufPtr, argbuflen) {
        // Hex-encode bytes to a lowercase string. Equivalent to
        // CPython's _Py_strhex(buf, len) -> str.
        var hex = "";
        var hexChars = "0123456789abcdef";
        for (var i = 0; i < argbuflen; i++) {
            var b = HEAPU8[argbufPtr + i];
            hex += hexChars[b >> 4] + hexChars[b & 0x0f];
        }
        return WasthonRT.wrapNewRef(hex);
    },

    /* --------------------------------------------------------------- *
     * Sentinel accessors (called by wasthon_init)              *
     *                                                                 *
     * wasthon.c declares the externs (Py_None, PyExc_TypeError,        *
     * PyType_Type, etc.) as PyObject * / PyTypeObject * variables and *
     * fills them at module init by invoking these accessors. From     *
     * then on, C code reads the externs directly with no JS round     *
     * trip per access.                                                *
     * --------------------------------------------------------------- */

    /* ---- Singletons ---- */
    wasthon_get_Py_None__deps:  ['$WasthonRT'],
    wasthon_get_Py_None:        function() { return WasthonRT.SLOT_NONE;  },
    wasthon_get_Py_True__deps:  ['$WasthonRT'],
    wasthon_get_Py_True:        function() { return WasthonRT.SLOT_TRUE;  },
    wasthon_get_Py_False__deps: ['$WasthonRT'],
    wasthon_get_Py_False:       function() { return WasthonRT.SLOT_FALSE; },
    wasthon_get_Py_NotImplemented__deps: ['$WasthonRT'],
    wasthon_get_Py_NotImplemented: function() { return WasthonRT.SLOT_NOTIMPLEMENTED; },
    wasthon_get_Py_Ellipsis__deps: ['$WasthonRT'],
    wasthon_get_Py_Ellipsis: function() { return WasthonRT.wrap(WasthonRT._b_.Ellipsis); },

    /* ---- Exception classes ---- */
    wasthon_get_PyExc_TypeError__deps:      ['$WasthonRT'],
    wasthon_get_PyExc_TypeError:            function() { return WasthonRT.wrap(WasthonRT._b_.TypeError); },
    wasthon_get_PyExc_ValueError__deps:     ['$WasthonRT'],
    wasthon_get_PyExc_ValueError:           function() { return WasthonRT.wrap(WasthonRT._b_.ValueError); },
    wasthon_get_PyExc_OverflowError__deps:  ['$WasthonRT'],
    wasthon_get_PyExc_OverflowError:        function() { return WasthonRT.wrap(WasthonRT._b_.OverflowError); },
    wasthon_get_PyExc_RuntimeError__deps:   ['$WasthonRT'],
    wasthon_get_PyExc_RuntimeError:         function() { return WasthonRT.wrap(WasthonRT._b_.RuntimeError); },
    wasthon_get_PyExc_MemoryError__deps:    ['$WasthonRT'],
    wasthon_get_PyExc_MemoryError:          function() { return WasthonRT.wrap(WasthonRT._b_.MemoryError); },
    wasthon_get_PyExc_SystemError__deps:    ['$WasthonRT'],
    wasthon_get_PyExc_SystemError:          function() { return WasthonRT.wrap(WasthonRT._b_.SystemError); },
    wasthon_get_PyExc_IndexError__deps:     ['$WasthonRT'],
    wasthon_get_PyExc_IndexError:           function() { return WasthonRT.wrap(WasthonRT._b_.IndexError); },
    wasthon_get_PyExc_RecursionError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_RecursionError:       function() { return WasthonRT.wrap(WasthonRT._b_.RecursionError); },
    wasthon_get_PyExc_EOFError__deps:       ['$WasthonRT'],
    wasthon_get_PyExc_EOFError:             function() { return WasthonRT.wrap(WasthonRT._b_.EOFError); },
    wasthon_get_PyExc_StopIteration__deps:  ['$WasthonRT'],
    wasthon_get_PyExc_StopIteration:        function() { return WasthonRT.wrap(WasthonRT._b_.StopIteration); },
    wasthon_get_PyExc_BufferError__deps:    ['$WasthonRT'],
    wasthon_get_PyExc_BufferError:          function() { return WasthonRT.wrap(WasthonRT._b_.BufferError); },
    wasthon_get_PyExc_KeyError__deps:       ['$WasthonRT'],
    wasthon_get_PyExc_KeyError:             function() { return WasthonRT.wrap(WasthonRT._b_.KeyError); },
    wasthon_get_PyExc_LookupError__deps:    ['$WasthonRT'],
    wasthon_get_PyExc_LookupError:          function() { return WasthonRT.wrap(WasthonRT._b_.LookupError); },
    wasthon_get_PyExc_NotImplementedError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_NotImplementedError:  function() { return WasthonRT.wrap(WasthonRT._b_.NotImplementedError); },
    wasthon_get_PyExc_UnicodeError__deps:   ['$WasthonRT'],
    wasthon_get_PyExc_UnicodeError:         function() { return WasthonRT.wrap(WasthonRT._b_.UnicodeError); },
    wasthon_get_PyExc_UnicodeDecodeError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_UnicodeDecodeError:   function() { return WasthonRT.wrap(WasthonRT._b_.UnicodeDecodeError); },
    wasthon_get_PyExc_UnicodeEncodeError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_UnicodeEncodeError:   function() { return WasthonRT.wrap(WasthonRT._b_.UnicodeEncodeError); },
    wasthon_get_PyExc_ImportError__deps:    ['$WasthonRT'],
    wasthon_get_PyExc_ImportError:          function() { return WasthonRT.wrap(WasthonRT._b_.ImportError); },
    wasthon_get_PyExc_Exception__deps:      ['$WasthonRT'],
    wasthon_get_PyExc_Exception:            function() { return WasthonRT.wrap(WasthonRT._b_.Exception); },
    wasthon_get_PyExc_OSError__deps:        ['$WasthonRT'],
    wasthon_get_PyExc_OSError:              function() { return WasthonRT.wrap(WasthonRT._b_.OSError); },
    wasthon_get_PyExc_AttributeError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_AttributeError:       function() { return WasthonRT.wrap(WasthonRT._b_.AttributeError); },
    wasthon_get_PyExc_ArithmeticError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_ArithmeticError:      function() { return WasthonRT.wrap(WasthonRT._b_.ArithmeticError); },
    wasthon_get_PyExc_DeprecationWarning__deps: ['$WasthonRT'],
    wasthon_get_PyExc_DeprecationWarning:   function() { return WasthonRT.wrap(WasthonRT._b_.DeprecationWarning); },
    wasthon_get_PyExc_Warning__deps:        ['$WasthonRT'],
    wasthon_get_PyExc_Warning:              function() { return WasthonRT.wrap(WasthonRT._b_.Warning); },
    wasthon_get_PyExc_ZeroDivisionError__deps: ['$WasthonRT'],
    wasthon_get_PyExc_ZeroDivisionError:    function() { return WasthonRT.wrap(WasthonRT._b_.ZeroDivisionError); },

    /* PyType_FromSpec — like PyType_FromModuleAndSpec but no module. The
     * __deps clause keeps PyType_FromModuleAndSpec preserved so Emscripten
     * doesn't tree-shake it; calls through `_<name>` as the C-export name. */
    PyType_FromSpec__deps: ['$WasthonRT', 'PyType_FromModuleAndSpec'],
    PyType_FromSpec: function(specPtr) {
        return _PyType_FromModuleAndSpec(0, specPtr, 0);
    },

    /* PyType_FromMetaclass(metaclass, module, spec, bases) — CPython 3.12+
     * generalisation of FromModuleAndSpec. We ignore the metaclass argument
     * (no metaclass support in our bridge) and delegate the rest. */
    PyType_FromMetaclass__deps: ['$WasthonRT', 'PyType_FromModuleAndSpec'],
    PyType_FromMetaclass: function(metaH, moduleH, specPtr, basesH) {
        return _PyType_FromModuleAndSpec(moduleH, specPtr, basesH);
    },

    /* PyType_Check(obj) — is obj a type (or type subclass) ?
     * Macro in wasthon.h forwards `(PyObject*)x` to here so callers can
     * pass either PyObject* or PyTypeObject*. */
    _wasthon_PyType_Check__deps: ['$WasthonRT'],
    _wasthon_PyType_Check: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try { return rt.$B.$isinstance(obj, rt._b_.type) ? 1 : 0; }
        catch (e) { return 0; }
    },

    /* PyType_IsSubtype(a, b) — is a a subtype of b? */
    PyType_IsSubtype__deps: ['$WasthonRT'],
    PyType_IsSubtype: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var b = rt.unwrap(bH);
        if (a === b) return 1;
        try { return rt._b_.issubclass(a, b) ? 1 : 0; }
        catch (e) { return 0; }
    },

    /* PyObject_RichCompare(a, b, op) — public richcompare returning PyObject*. */
    PyObject_RichCompare__deps: ['$WasthonRT'],
    PyObject_RichCompare: function(aH, bH, op) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var b = rt.unwrap(bH);
        var ops = ['__lt__', '__le__', '__eq__', '__ne__', '__gt__', '__ge__'];
        // Delegate to Brython's full rich-comparison protocol ($B.rich_comp:
        // call op, try the reflected op on NotImplemented, identity fallback for
        // ==/!=, raise TypeError for unorderable). The old code called the bound
        // method as a bare `fn(b)` — which throws for Brython methods needing
        // $call's frame setup (e.g. float.__lt__), so comparing two distinct
        // float/double arrays element-wise died with "unorderable types"
        // (test_array test_cmp / test_nan).
        try {
            return rt.wrapNewRef(rt.$B.rich_comp(ops[op], a, b));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    PyErr_BadArgument: function() {
        var rt = WasthonRT;
        rt.setError(rt.wrap(rt._b_.TypeError), "bad argument type for built-in operation");
        return 0;
    },

    /* PyCFunction_Check — is obj a builtin C function ? In our bridge,
     * we use trampolines wrapped in Brython builtin_method ob_type. */
    PyCFunction_Check__deps: ['$WasthonRT'],
    PyCFunction_Check: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        return (obj && obj.ob_type === WasthonRT.$B.builtin_method) ? 1 : 0;
    },

    /* PyCFunction_GetFunction — return the C function pointer behind a
     * builtin method. Our trampolines don't expose the raw fn pointer; we
     * return NULL so callers fall back to PyObject_Call. */
    PyCFunction_GetFunction: function(handle) { return 0; },

    /* _PyErr_FormatNote(format, ...) — format a message and append it to the
     * currently-raised exception's __notes__ (PEP 678). _json's encoder calls
     * it as it unwinds a failed serialization ("when serializing %T item %R")
     * so the exception carries a breadcrumb trail; test_json asserts on
     * `exc.__notes__`. Was a no-op, so __notes__ never got created -> the
     * tests hit AttributeError. Minimal printf subset (%T/%R/%S/%d/%s, with z/l
     * length modifiers) — the only codes _json uses. */
    _PyErr_FormatNote__deps: ['$WasthonRT'],
    _PyErr_FormatNote: function(fmtPtr, va) {
        var rt = WasthonRT;
        var pe = rt.pendingException;
        if (!pe) return 0;
        // The note attaches to the live exception instance; reconstruct one
        // from the pending exc+msg if a bare error was set (and keep it, so
        // successive notes during the unwind land on the same object).
        var exc = pe.value || (pe.value = rt.pendingExc(pe));
        if (!exc) return 0;
        var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
        var p = va | 0, msg = "", i = 0;
        function readPtr() { var v = HEAP32[p >> 2] >>> 0; p += 4; return v; }
        while (i < fmt.length) {
            var c = fmt[i++];
            if (c !== '%') { msg += c; continue; }
            while (i < fmt.length && 'zl'.indexOf(fmt[i]) >= 0) i++;  // length mod
            var code = fmt[i++];
            if (code === 'T' || code === 'N') {
                try { msg += rt.$B.class_name(rt.unwrap(readPtr())); }
                catch (e) { msg += '<type>'; }
            } else if (code === 'R') {
                try { msg += String(rt._b_.repr(rt.unwrap(readPtr()))); }
                catch (e) { msg += '<repr>'; }
            } else if (code === 'S' || code === 'U' || code === 'V') {
                try { msg += String(rt._b_.str.$factory(rt.unwrap(readPtr()))); }
                catch (e) { msg += '<str>'; }
            } else if (code === 'd' || code === 'i' || code === 'u') {
                msg += (HEAP32[p >> 2] | 0).toString(); p += 4;
            } else if (code === 's') {
                var sp = readPtr(); msg += sp === 0 ? '<NULL>' : UTF8ToString(sp);
            } else if (code === '%') {
                msg += '%';
            }
        }
        // Append to exc.__notes__ (create the list if absent) — same shape as
        // BaseException.add_note in py_exceptions.js.
        try {
            var NULL = rt.$B.NULL;
            var notes = rt.$B.get_from_dict(exc, '__notes__', NULL);
            if (notes !== NULL) { notes.push(msg); }
            else { rt.$B.set_to_dict(exc, '__notes__', rt.$B.$list([msg])); }
        } catch (e) {}
        return 0;
    },

    /* PyObject_Repr(o) — repr(o). */
    PyObject_Repr__deps: ['$WasthonRT'],
    PyObject_Repr: function(handle) {
        var rt = WasthonRT;
        try { return rt.wrapNewRef(String(rt._b_.repr(rt.unwrap(handle)))); }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "repr failed: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyObject_GetAttr(o, name) — getattr by str-PyObject name. Falls back
     * to walking cls.tp_funcs (where __wasthon_install_methods registers
     * C-installed methods) so PyObject_GetAttr can see them — Brython's
     * own $getattr only consults the class dict via object_getattribute
     * and never sees tp_funcs, which would otherwise make pickle's
     * `PyObject_GetAttr(self, "persistent_id")` fail. */
    PyObject_GetAttr__deps: ['$WasthonRT'],
    PyObject_GetAttr: function(objH, nameH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (!obj || name === null) return 0;
        try {
            var v = rt.$B.$getattr(obj, name);
            if (v && v.ob_type === rt.$B.getset_descriptor) {
                v = rt.$B.getset_descriptor.tp_descr_get(v, obj);
            }
            return rt.wrapMaybeType(v);
        }
        catch (e) {
            /* tp_funcs fallback: look up the method in the class chain
             * and synthesize a bound-method-like callable. */
            try {
                var cls = obj.__class__ || rt.$B.get_class(obj);
                var chain = cls && cls.tp_mro ? cls.tp_mro
                          : cls && cls.__mro__ ? [cls].concat(cls.__mro__)
                          : (cls ? [cls] : []);
                for (var i = 0; i < chain.length; i++) {
                    var c = chain[i];
                    if (c && c.tp_funcs && Object.prototype.hasOwnProperty.call(c.tp_funcs, name)) {
                        var fn = c.tp_funcs[name];
                        /* Return a bound callable: pre-applies obj as self. */
                        var bound = function() {
                            return fn.apply(null, [obj].concat(Array.from(arguments)));
                        };
                        bound.ob_type = rt.$B.builtin_method;
                        bound.__self__ = obj;
                        return rt.wrapNewRef(bound);
                    }
                }
            } catch (_) {}
            rt.setError(rt.wrap(rt._b_.AttributeError), "no attribute '" + name + "'");
            return 0;
        }
    },

    /* PyObject_SetItem(o, key, v) — o[key] = v. */
    PyObject_SetItem__deps: ['$WasthonRT'],
    PyObject_SetItem: function(objH, keyH, valH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var key = rt.unwrap(keyH);
        var val = rt.unwrap(valH);
        try {
            rt.$B.$setitem(obj, key, val);
            // no-steal: the container takes its own refs on key and value.
            rt.incref(keyH);
            rt.incref(valH);
            return 0;
        }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "setitem failed: " + (e.message || String(e)));
            return -1;
        }
    },

    /* PySequence_List(o) — list(o). */
    PySequence_List__deps: ['$WasthonRT'],
    PySequence_List: function(handle) {
        var rt = WasthonRT;
        try { return rt.wrapNewRef(rt._b_.list.$factory(rt.unwrap(handle))); }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "list() failed");
            return 0;
        }
    },

    /* PySequence_GetSlice(o, low, high) — o[low:high]. */
    PySequence_GetSlice__deps: ['$WasthonRT'],
    PySequence_GetSlice: function(handle, low, high) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        try {
            if (Array.isArray(obj)) return rt.wrapNewRef(obj.slice(low, high));
            if (typeof obj === 'string') return rt.wrapNewRef(obj.slice(low, high));
            var slice = rt._b_.slice.$factory(low, high);
            return rt.wrapNewRef(rt.$B.$getitem(obj, slice));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "slice failed");
            return 0;
        }
    },

    /* _PyObject_CallNoArgs(callable) — callable(). */
    _PyObject_CallNoArgs__deps: ['$WasthonRT'],
    _PyObject_CallNoArgs: function(handle) {
        var rt = WasthonRT;
        var fn = rt.unwrap(handle);
        try { return rt.wrapNewRef(rt.$B.$call(fn)); }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "call failed: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyDict_Update(a, b) — a.update(b). */
    PyDict_Update__deps: ['$WasthonRT'],
    PyDict_Update: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var b = rt.unwrap(bH);
        try { rt._b_.dict.update(a, b); return 0; }
        catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "dict.update failed");
            return -1;
        }
    },

    /* _PyObject_HashFast(o) — same as hash(o). */
    _PyObject_HashFast__deps: ['$WasthonRT'],
    _PyObject_HashFast: function(handle) {
        var rt = WasthonRT;
        try { return rt._b_.hash(rt.unwrap(handle)) | 0; }
        catch (e) { return -1; }
    },

    /* _PyDict_GetItem_KnownHash(d, k, hash) — same as PyDict_GetItem, hash hint ignored. */
    _PyDict_GetItem_KnownHash__deps: ['$WasthonRT'],
    _PyDict_GetItem_KnownHash: function(dH, kH, hash) {
        var rt = WasthonRT;
        var d = rt.unwrap(dH);
        var k = rt.unwrap(kH);
        try {
            if (rt._b_.dict.$contains(d, k)) return rt.wrap(rt._b_.dict.$getitem(d, k));
            return 0;
        } catch (e) { return 0; }
    },

    /* _PyType_Lookup / _PyType_LookupRef — walk the MRO for an attribute,
     * return without calling __getattr__. */
    _PyType_Lookup__deps: ['$WasthonRT'],
    _PyType_Lookup: function(typeH, nameH) {
        var rt = WasthonRT;
        var type = rt.unwrap(typeH);
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (!type || name === null) return 0;
        try {
            /* $B.search_in_mro is the canonical no-fallback MRO walk. */
            if (rt.$B.search_in_mro) {
                var v = rt.$B.search_in_mro(type, name, rt.$B.NULL);
                if (v === rt.$B.NULL) return 0;
                return rt.wrap(v);
            }
            return rt.wrap(rt.$B.$getattr(type, name));
        } catch (e) { return 0; }
    },

    _PyType_LookupRef__deps: ['$WasthonRT', '_PyType_Lookup'],
    _PyType_LookupRef: function(typeH, nameH) {
        return __PyType_Lookup(typeH, nameH);
    },

    /* Py_ReprEnter / Py_ReprLeave — recursion guard for self-referencing
     * repr (e.g. d = []; d.append(d); repr(d)). We track a single Set of
     * "currently being repr'd" handles. */
    Py_ReprEnter__deps: ['$WasthonRT'],
    Py_ReprEnter: function(handle) {
        var rt = WasthonRT;
        if (!rt._reprStack) rt._reprStack = new Set();
        if (rt._reprStack.has(handle)) return 1;
        rt._reprStack.add(handle);
        return 0;
    },

    Py_ReprLeave__deps: ['$WasthonRT'],
    Py_ReprLeave: function(handle) {
        var rt = WasthonRT;
        if (rt._reprStack) rt._reprStack.delete(handle);
    },

    /* math module additions. */

    _Py_bit_length: function(v) {
        v = v >>> 0;
        var n = 0;
        while (v > 0) { n++; v = v >>> 1; }
        return n;
    },

    PyFloat_CheckExact__deps: ['$WasthonRT'],
    PyFloat_CheckExact: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        return (typeof obj === 'number' && !Number.isInteger(obj)) ||
               (obj && obj.__class__ === WasthonRT._b_.float) ? 1 : 0;
    },

    PyLong_AsLongAndOverflow__deps: ['$WasthonRT'],
    PyLong_AsLongAndOverflow: function(objH, overflowPtr) {
        var rt = WasthonRT;
        // CPython requires an int or an object with __index__ — a float, str or
        // Decimal has none, so math.factorial(5.0)/(5.2)/("5") must raise
        // TypeError rather than truncate/parse (coerceInt was too lenient, and
        // a bare BigInt(1.5) threw a raw JS error). Brython gives int.__index__
        // but not float.__index__, so this distinguishes 5 from 5.0.
        var obj = rt.unwrap(objH);
        var idx = rt.$B.$getattr(obj, '__index__', null);
        if (idx === null || idx === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "'" + rt.$B.class_name(obj) + "' object cannot be interpreted as an integer");
            if (overflowPtr) HEAP32[overflowPtr >> 2] = 0;
            return -1;
        }
        var n = rt.$B.$call(idx);
        var v = (typeof n === 'bigint') ? n : BigInt(Math.trunc(Number(n)));
        if (overflowPtr) {
            HEAP32[overflowPtr >> 2] = (v > 2147483647n) ? 1 :
                                       (v < -2147483648n) ? -1 : 0;
        }
        if (v > 2147483647n) return 2147483647;
        if (v < -2147483648n) return -2147483648;
        return Number(v) | 0;
    },

    /* _PyLong_Lshift(a, shift) — shift is int64_t at the emcc boundary,
     * so arrives as a BigInt. */
    _PyLong_Lshift__deps: ['$WasthonRT'],
    _PyLong_Lshift: function(aH, shift) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var bi = (typeof a === 'bigint') ? a :
                 (typeof a === 'number') ? BigInt(Math.trunc(a)) : 0n;
        var s = typeof shift === 'bigint' ? shift : BigInt(shift | 0);
        var result = bi << s;
        if (result >= -2147483648n && result <= 2147483647n) return rt.wrapNewRef(Number(result));
        return rt.wrapNewRef(result);
    },

    _PyObject_MaybeCallSpecialNoArgs__deps: ['$WasthonRT'],
    _PyObject_MaybeCallSpecialNoArgs: function(objH, nameH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (!obj || name === null) return 0;
        // Absence of the special method = NULL with NO error (the "Maybe": the
        // C caller, e.g. math_floor, then tries PyFloat_AsDouble). But if the
        // method IS present and RAISES, the exception must propagate — the
        // caller checks PyErr_Occurred() right after a NULL. The old bare
        // catch swallowed it, so math.floor(Decimal('NaN')) returned None
        // instead of raising ValueError. Forward the real exception.
        var m = rt.$B.$getattr(obj, name, null);
        if (m === null || m === undefined) return 0;
        try {
            return rt.wrapNewRef(rt.$B.$call(m));
        } catch (e) {
            rt.forwardError(e);
            return 0;
        }
    },

    PyOS_double_to_string__deps: ['$WasthonRT'],
    PyOS_double_to_string: function(val, formatCode, precision, flags, typePtr) {
        var rt = WasthonRT;
        var fc = String.fromCharCode(formatCode);
        var s;
        if (fc === 'r') s = val.toString();
        else if (fc === 'g') s = val.toPrecision(precision || 6);
        else if (fc === 'e') s = val.toExponential(precision);
        else if (fc === 'f') s = val.toFixed(precision);
        else s = val.toString();
        /* If ADD_DOT_0 flag and string lacks "." and "e", append ".0". */
        if ((flags & 2) && s.indexOf('.') === -1 && s.indexOf('e') === -1 &&
            isFinite(val)) s += '.0';
        var len = lengthBytesUTF8(s);
        var ptr = _malloc(len + 1);
        stringToUTF8(s, ptr, len + 1);
        if (typePtr) HEAP32[typePtr >> 2] = 0;
        return ptr;
    },

    PySequence_Tuple__deps: ['$WasthonRT'],
    PySequence_Tuple: function(handle) {
        var rt = WasthonRT;
        try {
            var arr = rt._b_.list.$factory(rt.unwrap(handle));
            return rt.wrapNewRef(rt._b_.tuple.$factory(arr));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "tuple() failed");
            return 0;
        }
    },

    PyBool_Check__deps: ['$WasthonRT'],
    PyBool_Check: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        return (obj === true || obj === false ||
                obj === WasthonRT._b_.True || obj === WasthonRT._b_.False) ? 1 : 0;
    },

    PyErr_SetFromErrno__deps: ['$WasthonRT'],
    PyErr_SetFromErrno: function(excH) {
        var rt = WasthonRT;
        rt.setError(excH ? excH : rt.wrap(rt._b_.OSError), "system error");
        return 0;
    },

    PyLong_AsLongLongAndOverflow__deps: ['$WasthonRT'],
    PyLong_AsLongLongAndOverflow: function(objH, overflowPtr) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var bi = (typeof obj === 'bigint') ? obj :
                 (typeof obj === 'number') ? BigInt(Math.trunc(obj)) : 0n;
        var max = 9223372036854775807n, min = -9223372036854775808n;
        if (bi > max) {
            if (overflowPtr) HEAP32[overflowPtr >> 2] = 1;
            return 0n;  /* return BigInt 0 so emcc's i64 conversion doesn't see Infinity */
        }
        if (bi < min) {
            if (overflowPtr) HEAP32[overflowPtr >> 2] = -1;
            return 0n;
        }
        if (overflowPtr) HEAP32[overflowPtr >> 2] = 0;
        return bi;  /* return as BigInt directly — emcc handles i64 returns natively */
    },

    /* _PyLong_Frexp(v, *e) — like frexp() but on arbitrary-precision PyLong.
     * Returns mantissa in [0.5, 1) and writes exponent into *e. */
    _PyLong_Frexp__deps: ['$WasthonRT'],
    _PyLong_Frexp: function(vH, ePtr) {
        var rt = WasthonRT;
        var v = rt.unwrap(vH);
        var bi = (typeof v === 'bigint') ? v :
                 (typeof v === 'number') ? BigInt(Math.trunc(v)) : 0n;
        var neg = bi < 0n;
        if (neg) bi = -bi;
        if (bi === 0n) {
            if (ePtr) { HEAP32[ePtr >> 2] = 0; HEAP32[(ePtr + 4) >> 2] = 0; }
            return 0;
        }
        /* Compute bit length. */
        var bits = 0;
        var t = bi;
        while (t > 0n) { bits++; t >>= 1n; }
        /* Mantissa = bi / 2^bits, in [0.5, 1). */
        var shift = bits - 53;
        var top;
        if (shift > 0) top = Number(bi >> BigInt(shift));
        else top = Number(bi) * Math.pow(2, -shift);
        var mantissa = top / Math.pow(2, 53);
        if (ePtr) {
            HEAP32[ePtr >> 2] = bits | 0;
            HEAP32[(ePtr + 4) >> 2] = 0;  /* high 32 — bits fits in 32 */
        }
        return neg ? -mantissa : mantissa;
    },

    _PyLong_IsNegative__deps: ['$WasthonRT'],
    _PyLong_IsNegative: function(vH) {
        var v = WasthonRT.unwrap(vH);
        if (typeof v === 'bigint') return v < 0n ? 1 : 0;
        if (typeof v === 'number') return v < 0 ? 1 : 0;
        return 0;
    },

    _PyLong_IsPositive__deps: ['$WasthonRT'],
    _PyLong_IsPositive: function(vH) {
        var v = WasthonRT.unwrap(vH);
        if (typeof v === 'bigint') return v > 0n ? 1 : 0;
        if (typeof v === 'number') return v > 0 ? 1 : 0;
        return 0;
    },

    _PyLong_IsZero__deps: ['$WasthonRT'],
    _PyLong_IsZero: function(vH) {
        var v = WasthonRT.unwrap(vH);
        if (typeof v === 'bigint') return v === 0n ? 1 : 0;
        if (typeof v === 'number') return v === 0 ? 1 : 0;
        return 0;
    },

    /* _PyLong_Rshift(a, shift) — shift is int64_t at the emcc boundary. */
    _PyLong_Rshift__deps: ['$WasthonRT'],
    _PyLong_Rshift: function(aH, shift) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var bi = (typeof a === 'bigint') ? a :
                 (typeof a === 'number') ? BigInt(Math.trunc(a)) : 0n;
        var s = typeof shift === 'bigint' ? shift : BigInt(shift | 0);
        var result = bi >> s;
        if (result >= -2147483648n && result <= 2147483647n) return rt.wrapNewRef(Number(result));
        return rt.wrapNewRef(result);
    },

    PyNumber_Index__deps: ['$WasthonRT'],
    PyNumber_Index: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (typeof obj === 'number' && Number.isInteger(obj)) return objH;
        if (typeof obj === 'bigint') return objH;
        try {
            var v = rt.$B.$call(rt.$B.$getattr(obj, '__index__'));
            return rt.wrapNewRef(v);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "object cannot be interpreted as an integer");
            return 0;
        }
    },

    PyNumber_Subtract__deps: ['$WasthonRT'],
    PyNumber_Subtract: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var b = rt.unwrap(bH);
        /* Coerce Brython int/float wrappers to plain JS number / bigint
         * before doing any arithmetic. */
        function toNum(v) {
            if (typeof v === 'number' || typeof v === 'bigint') return v;
            if (v && typeof v.value !== 'undefined') return v.value;
            if (v === true) return 1;
            if (v === false) return 0;
            return Number(v);
        }
        try {
            var na = toNum(a), nb = toNum(b);
            if (typeof na === 'bigint' || typeof nb === 'bigint') {
                var ba = typeof na === 'bigint' ? na : BigInt(Math.trunc(na));
                var bb = typeof nb === 'bigint' ? nb : BigInt(Math.trunc(nb));
                var r = ba - bb;
                if (r >= -2147483648n && r <= 2147483647n) return rt.wrapNewRef(Number(r));
                return rt.wrapNewRef(r);
            }
            return rt.wrapNewRef(na - nb);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError), "subtract failed: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyLong_FromString — parse C string as int. */
    PyLong_FromString__deps: ['$WasthonRT'],
    PyLong_FromString: function(strPtr, pendPtr, base) {
        var rt = WasthonRT;
        var s = strPtr ? UTF8ToString(strPtr) : "";
        /* Digit-at-a-time BigInt parse. The old BigInt(parseInt(s, base))
         * round-tripped through a DOUBLE (2^53 precision) and silently
         * corrupted big literals; and BigInt('123\n') threw, so valid
         * literals with a trailing newline (pickle's proto-0 LONG lines)
         * raised "invalid literal". */
        var p = 0, sign = 1n;
        while (p < s.length && s.charCodeAt(p) <= 32) p++;   // leading space
        if (s[p] === '+') p++;
        else if (s[p] === '-') { sign = -1n; p++; }
        var b = base | 0;
        var pfx = s.slice(p, p + 2).toLowerCase();
        if ((b === 0 || b === 16) && pfx === '0x') { b = 16; p += 2; }
        else if ((b === 0 || b === 8) && pfx === '0o') { b = 8; p += 2; }
        else if ((b === 0 || b === 2) && pfx === '0b') { b = 2; p += 2; }
        else if (b === 0) b = 10;
        var B = BigInt(b), v = 0n, ndigits = 0;
        for (; p < s.length; p++) {
            var c = s.charCodeAt(p), d;
            if (c === 95) continue;                          // '_' separator
            if (c >= 48 && c <= 57) d = c - 48;
            else if (c >= 97 && c <= 122) d = c - 87;
            else if (c >= 65 && c <= 90) d = c - 55;
            else break;
            if (d >= b) break;
            v = v * B + BigInt(d);
            ndigits++;
        }
        var rest = p;
        while (rest < s.length && s.charCodeAt(rest) <= 32) rest++;
        if (ndigits === 0 || (!pendPtr && rest < s.length)) {
            rt.setError(rt.wrap(rt._b_.ValueError),
                "invalid literal for int() with base " + b + ": '" + s + "'");
            return 0;
        }
        if (pendPtr) HEAP32[pendPtr >> 2] = strPtr + p;
        v = sign * v;
        if (v >= -2147483648n && v <= 2147483647n) return rt.wrapNewRef(Number(v));
        return rt.wrapNewRef(v);
    },


    /* Py_hexdigits is defined as a real C global in wasthon.c. */

    /* PyImport_ImportModuleAttr — new in 3.13: import then getattr. */
    PyImport_ImportModuleAttr__deps: ['$WasthonRT'],
    PyImport_ImportModuleAttr: function(modNameH, attrNameH) {
        var rt = WasthonRT;
        var modName = rt.asJSStr(rt.unwrap(modNameH));
        var attrName = rt.asJSStr(rt.unwrap(attrNameH));
        if (modName === null || attrName === null) return 0;
        try {
            var imp = rt._b_.__import__;
            var mod;
            if (modName.indexOf('.') !== -1) {
                var parts = modName.split('.');
                var leaf = parts[parts.length - 1];
                mod = imp(modName, rt._b_.None, rt._b_.None,
                          rt._b_.tuple.$factory([leaf]));
            } else {
                mod = imp(modName);
            }
            return rt.wrapNewRef(rt.$B.$getattr(mod, attrName));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.ImportError),
                "PyImport_ImportModuleAttr: " + modName + "." + attrName +
                ": " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyUnicode_2BYTE_DATA_ / 4BYTE_DATA_ — materialise the str's UCS2/UCS4
     * buffer into linear memory. Caller assumes the pointer is valid for
     * the str's lifetime; we allocate a fresh buffer per call (leaks, but
     * _json calls these once per string at encode time).
     *
     * In practice _json uses 2BYTE_DATA when the str's max codepoint is
     * <= 0xFFFF and 4BYTE_DATA otherwise. We always return a fresh buffer
     * with the codepoints. */
    PyUnicode_2BYTE_DATA___deps: ['$WasthonRT'],
    PyUnicode_2BYTE_DATA_: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        /* PyUnicode_New placeholder — return its underlying WASM buffer
         * directly so C-side writes land in the real string. */
        if (obj && obj.__wasthon_unicode_buf__) return obj.__wasthon_unicode_buf__;
        /* Fallback: existing JS string — materialise into a fresh buffer
         * (read-only use case). */
        var s = rt.asJSStr(obj);
        if (s === null) return 0;
        var len = s.length;
        var ptr = _malloc((len + 1) * 2);
        for (var i = 0; i < len; i++) {
            HEAP16[(ptr + i*2) >> 1] = s.charCodeAt(i);
        }
        HEAP16[(ptr + len*2) >> 1] = 0;
        return ptr;
    },

    PyUnicode_4BYTE_DATA___deps: ['$WasthonRT'],
    PyUnicode_4BYTE_DATA_: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj && obj.__wasthon_unicode_buf__) return obj.__wasthon_unicode_buf__;
        var s = rt.asJSStr(obj);
        if (s === null) return 0;
        // one codepoint per 4-byte element (PEP 393 UCS4), matching GET_LENGTH.
        return rt.mallocUCS4(rt.strCodePoints(s));
    },

    /* PyUnicodeWriter API — public in 3.14. Each writer is a struct in
     * linear memory with a `pos` field and an opaque `_internal` slot.
     * We use _internal to hold a JS-side handle into a Map of writer-id
     * → string chunks array. Finish concatenates the chunks into a final
     * Brython str. */
    PyUnicodeWriter_Create__deps: ['$WasthonRT'],
    PyUnicodeWriter_Create: function(initialLength) {
        var rt = WasthonRT;
        if (!rt._writers) { rt._writers = new Map(); rt._writerNextId = 1; }
        var ptr = _malloc(8);
        HEAP32[ptr >> 2] = 0;             /* pos */
        var id = rt._writerNextId++;
        HEAP32[(ptr + 4) >> 2] = id;      /* _internal — JS-side id */
        rt._writers.set(id, []);
        return ptr;
    },

    PyUnicodeWriter_Discard__deps: ['$WasthonRT'],
    PyUnicodeWriter_Discard: function(writerPtr) {
        var rt = WasthonRT;
        if (writerPtr === 0) return;
        var id = HEAP32[(writerPtr + 4) >> 2];
        if (rt._writers) rt._writers.delete(id);
        _free(writerPtr);
    },

    PyUnicodeWriter_Finish__deps: ['$WasthonRT'],
    PyUnicodeWriter_Finish: function(writerPtr) {
        var rt = WasthonRT;
        if (writerPtr === 0) return 0;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers ? rt._writers.get(id) : null;
        rt._writers.delete(id);
        _free(writerPtr);
        if (!chunks) return 0;
        return rt.wrapNewRef(chunks.join(''));
    },

    PyUnicodeWriter_WriteChar__deps: ['$WasthonRT'],
    PyUnicodeWriter_WriteChar: function(writerPtr, ch) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        chunks.push(String.fromCodePoint(ch >>> 0));
        HEAP32[writerPtr >> 2] += 1;
        return 0;
    },

    PyUnicodeWriter_WriteStr__deps: ['$WasthonRT'],
    PyUnicodeWriter_WriteStr: function(writerPtr, strH) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        var s = rt.asJSStr(rt.unwrap(strH));
        if (s === null) {
            rt.setError(rt.wrap(rt._b_.TypeError), "expected str");
            return -1;
        }
        chunks.push(s);
        HEAP32[writerPtr >> 2] += s.length;
        return 0;
    },

    PyUnicodeWriter_WriteSubstring__deps: ['$WasthonRT'],
    PyUnicodeWriter_WriteSubstring: function(writerPtr, strH, start, end) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        var s = rt.asJSStr(rt.unwrap(strH));
        if (s === null) return -1;
        var sub = s.slice(start, end);
        chunks.push(sub);
        HEAP32[writerPtr >> 2] += sub.length;
        return 0;
    },

    PyUnicodeWriter_WriteUTF8__deps: ['$WasthonRT'],
    PyUnicodeWriter_WriteUTF8: function(writerPtr, strPtr, size) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        var s;
        if (size < 0) s = UTF8ToString(strPtr);
        else {
            var bytes = HEAPU8.slice(strPtr, strPtr + size);
            s = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
        }
        chunks.push(s);
        HEAP32[writerPtr >> 2] += s.length;
        return 0;
    },

    PyUnicodeWriter_WriteASCII__deps: ['$WasthonRT'],
    PyUnicodeWriter_WriteASCII: function(writerPtr, strPtr, size) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        var s;
        if (size < 0) s = UTF8ToString(strPtr);
        else {
            var buf = "";
            for (var i = 0; i < size; i++) buf += String.fromCharCode(HEAPU8[strPtr + i]);
            s = buf;
        }
        chunks.push(s);
        HEAP32[writerPtr >> 2] += s.length;
        return 0;
    },

    PyUnicodeWriter_WriteRepr__deps: ['$WasthonRT'],
    PyUnicodeWriter_WriteRepr: function(writerPtr, objH) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        try {
            var s = rt._b_.repr(rt.unwrap(objH));
            chunks.push(String(s));
            HEAP32[writerPtr >> 2] += String(s).length;
            return 0;
        } catch (e) { return -1; }
    },

    PyUnicodeWriter_Format__deps: ['$WasthonRT'],
    PyUnicodeWriter_Format: function(writerPtr, fmtPtr, varargs) {
        var rt = WasthonRT;
        var id = HEAP32[(writerPtr + 4) >> 2];
        var chunks = rt._writers.get(id);
        if (!chunks) return -1;
        /* Minimal: just append the format string with %s/%d resolved best-
         * effort. _json only uses Format with literal strings; this is
         * sufficient for the current call sites. */
        var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
        chunks.push(fmt);
        HEAP32[writerPtr >> 2] += fmt.length;
        return 0;
    },

    /* _wasthon_id(name_cstr) — return a Brython str handle for "name".
     * Backs the _Py_ID(name) macro that some C code uses as a stand-in for
     * pre-interned identifiers. Routes through the intern pool: _Py_ID
     * strings are immortal in CPython and compared by pointer, so the
     * handle must be stable across calls and never scope-released. */
    _wasthon_id__deps: ['$WasthonRT', 'PyUnicode_InternFromString'],
    _wasthon_id: function(namePtr) {
        return _PyUnicode_InternFromString(namePtr);
    },

    /* _PyEval_GetBuiltin(name) — look up a builtin by name (str object). */
    _PyEval_GetBuiltin__deps: ['$WasthonRT'],
    _PyEval_GetBuiltin: function(nameH) {
        var rt = WasthonRT;
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (name === null) return 0;
        var v = rt._b_[name];
        if (v === undefined) {
            rt.setError(rt.wrap(rt._b_.AttributeError), "no builtin '" + name + "'");
            return 0;
        }
        return rt.wrap(v);
    },

    /* _PyBytes_Repeat(dst, dst_len, src, src_len) — fill dst by repeating src. */
    _PyBytes_Repeat: function(dst, dstLen, src, srcLen) {
        if (srcLen <= 0 || dstLen <= 0) return;
        for (var off = 0; off < dstLen; off += srcLen) {
            var chunk = Math.min(srcLen, dstLen - off);
            HEAPU8.copyWithin(dst + off, src, src + chunk);
        }
    },

    /* PySys_Audit(event, format, ...) — no-op in the bridge. */
    PySys_Audit: function(eventPtr, formatPtr) { return 0; },

    /* PyUnicode_AsWideChar(unicode, buf, n) — copies the unicode's code
     * points as wchar_t into buf, up to n (excluding a trailing NUL). Returns
     * the number of chars copied. When buf is NULL it instead returns the size
     * required to store the contents INCLUDING the trailing NUL (i.e. len + 1)
     * — CPython's buffer-sizing query. array's u_setitem relies on this:
     * `AsWideChar(v, NULL, 0) != 2` rejects non-single-char items, and
     * array_fromunicode sizes the copy as `AsWideChar(ustr, NULL, 0) - 1`.
     * Returning len here dropped the trailing-NUL count → u.append(ch) raised
     * "cannot be converted to a single wchar_t character" and
     * u.fromunicode('foo') stored 'fo'. */
    PyUnicode_AsWideChar__deps: ['$WasthonRT'],
    PyUnicode_AsWideChar: function(uH, bufPtr, n) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(uH));
        if (s === null) return -1;
        // wchar_t is 4-byte UCS4: one codepoint per wchar (rt.strCodePoints),
        // not one UTF-16 unit — else an astral char stored a surrogate pair and
        // didn't match a UTF-32 / frombytes reconstruction (test_array.test_unicode).
        var cps = rt.strCodePoints(s);
        var len = cps.length;
        if (bufPtr === 0) return len + 1;
        var copy = Math.min(len, n);
        for (var i = 0; i < copy; i++) {
            HEAP32[(bufPtr + i*4) >> 2] = cps[i];
        }
        if (copy < n) HEAP32[(bufPtr + copy*4) >> 2] = 0;
        return copy;
    },

    /* PyUnicode_AsWideCharString — malloc + copy. Returns wchar_t*. */
    PyUnicode_AsWideCharString__deps: ['$WasthonRT'],
    PyUnicode_AsWideCharString: function(uH, sizePtr) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(uH));
        if (s === null) return 0;
        // array('u', string) goes through here; one codepoint per 4-byte wchar.
        var cps = rt.strCodePoints(s);
        if (sizePtr) HEAP32[sizePtr >> 2] = cps.length;
        return rt.mallocUCS4(cps);
    },

    PyUnicode_AsUCS4__deps: ['$WasthonRT'],
    PyUnicode_AsUCS4: function(uH, bufPtr, n, copyNull) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(uH));
        if (s === null) return 0;
        // one codepoint per UCS4 element (array('w', '…𠌊𠍇') stored a stray
        // low surrogate before, test_array.test_unicode).
        var cps = rt.strCodePoints(s);
        var len = cps.length;
        if (n < len + (copyNull ? 1 : 0)) {
            rt.setError(rt.wrap(rt._b_.SystemError), "buffer too small");
            return 0;
        }
        for (var i = 0; i < len; i++) {
            HEAP32[(bufPtr + i*4) >> 2] = cps[i];
        }
        if (copyNull) HEAP32[(bufPtr + len*4) >> 2] = 0;
        return bufPtr;
    },

    PyUnicode_AsUCS4Copy__deps: ['$WasthonRT'],
    PyUnicode_AsUCS4Copy: function(uH) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(uH));
        if (s === null) return 0;
        return rt.mallocUCS4(rt.strCodePoints(s));
    },

    /* PyUnicode_DecodeUTF16 / UTF32 — decode raw bytes to str. */
    PyUnicode_DecodeUTF16__deps: ['$WasthonRT'],
    PyUnicode_DecodeUTF16: function(sPtr, size, errorsPtr, byteorderPtr) {
        try {
            var bo = byteorderPtr ? (HEAP32[byteorderPtr >> 2] | 0) : 0;
            var label = bo < 0 ? 'utf-16le' : (bo > 0 ? 'utf-16be' : 'utf-16');
            var bytes = HEAPU8.slice(sPtr, sPtr + size);
            var s = new TextDecoder(label).decode(bytes);
            return WasthonRT.wrapNewRef(s);
        } catch (e) {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.UnicodeDecodeError),
                "utf-16 decode failed: " + (e.message || e));
            return 0;
        }
    },

    PyUnicode_DecodeUTF32__deps: ['$WasthonRT'],
    PyUnicode_DecodeUTF32: function(sPtr, size, errorsPtr, byteorderPtr) {
        var rt = WasthonRT;
        try {
            var bo = byteorderPtr ? (HEAP32[byteorderPtr >> 2] | 0) : 0;
            /* TextDecoder doesn't ship UTF-32 natively. Decode manually. */
            var n = size >> 2;
            var chars = [];
            for (var i = 0; i < n; i++) {
                var b0 = HEAPU8[sPtr + i*4];
                var b1 = HEAPU8[sPtr + i*4 + 1];
                var b2 = HEAPU8[sPtr + i*4 + 2];
                var b3 = HEAPU8[sPtr + i*4 + 3];
                var cp = bo > 0
                    ? (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
                    : (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
                chars.push(String.fromCodePoint(cp));
            }
            return rt.wrapNewRef(chars.join(''));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.UnicodeDecodeError),
                "utf-32 decode failed: " + (e.message || e));
            return 0;
        }
    },

    /* Slice protocol. */
    PySlice_Check__deps: ['$WasthonRT'],
    PySlice_Check: function(handle) {
        // Brython 3.14 represents slice instances with `ob_type` pointing
        // to the PyTypeObject-mirror at _b_.slice; the old `__class__`
        // attribute is no longer set. Accept either shape so this works
        // against both Brython versions.
        var obj = WasthonRT.unwrap(handle);
        if (!obj) return 0;
        if (obj.ob_type === WasthonRT._b_.slice) return 1;
        if (obj.__class__ === WasthonRT._b_.slice) return 1;
        return 0;
    },

    PySlice_Unpack__deps: ['$WasthonRT'],
    PySlice_Unpack: function(sliceH, startPtr, stopPtr, stepPtr) {
        var rt = WasthonRT;
        var s = rt.unwrap(sliceH);
        if (!s) return -1;
        var start = s.start === rt._b_.None ? null :
                    (typeof s.start === 'number' ? s.start :
                     (typeof s.start === 'bigint' ? Number(s.start) : 0));
        var stop  = s.stop === rt._b_.None ? null :
                    (typeof s.stop === 'number' ? s.stop :
                     (typeof s.stop === 'bigint' ? Number(s.stop) : 0));
        var step  = s.step === rt._b_.None ? 1 :
                    (typeof s.step === 'number' ? s.step :
                     (typeof s.step === 'bigint' ? Number(s.step) : 1));
        var PY_SSIZE_T_MAX = 0x7fffffff;
        HEAP32[startPtr >> 2] = start === null ? (step < 0 ? PY_SSIZE_T_MAX : 0) : (start | 0);
        HEAP32[stopPtr  >> 2] = stop  === null ? (step < 0 ? (-PY_SSIZE_T_MAX-1) : PY_SSIZE_T_MAX) : (stop | 0);
        HEAP32[stepPtr  >> 2] = step | 0;
        return 0;
    },

    /* PySlice_AdjustIndices(length, *start, *stop, step) — clamps start/stop
     * to valid range, returns the slice length. */
    PySlice_AdjustIndices: function(length, startPtr, stopPtr, step) {
        var start = HEAP32[startPtr >> 2] | 0;
        var stop  = HEAP32[stopPtr  >> 2] | 0;
        if (start < 0) { start += length; if (start < 0) start = (step < 0) ? -1 : 0; }
        else if (start >= length) start = (step < 0) ? length - 1 : length;
        if (stop < 0)  { stop += length;  if (stop < 0)  stop  = (step < 0) ? -1 : 0; }
        else if (stop >= length)  stop  = (step < 0) ? length - 1 : length;
        HEAP32[startPtr >> 2] = start;
        HEAP32[stopPtr  >> 2] = stop;
        var len;
        if (step < 0) len = (stop < start) ? Math.floor((start - stop - 1) / (-step)) + 1 : 0;
        else          len = (start < stop) ? Math.floor((stop - start - 1) / step)  + 1 : 0;
        return len;
    },

    /* _PyEval_SliceIndexNotNone — clinic helper: convert PyObject to ssize_t,
     * rejecting None (use 0/PY_SSIZE_T_MAX defaults instead). */
    _PyEval_SliceIndexNotNone__deps: ['$WasthonRT'],
    _PyEval_SliceIndexNotNone: function(vH, piPtr) {
        var rt = WasthonRT;
        var v = rt.unwrap(vH);
        if (v === rt._b_.None) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "slice indices must be integers or have an __index__ method");
            return 0;
        }
        var n = (typeof v === 'number') ? v
              : (typeof v === 'bigint') ? Number(v)
              : Number(v);
        HEAP32[piPtr >> 2] = n | 0;
        return 1;
    },

    /* _PyLong_FromByteArray(bytes, n, little_endian, is_signed). */
    _PyLong_FromByteArray__deps: ['$WasthonRT'],
    _PyLong_FromByteArray: function(bytesPtr, n, littleEndian, isSigned) {
        var rt = WasthonRT;
        if (n === 0) return rt.wrapNewRef(0);
        var v = 0n;
        if (littleEndian) {
            for (var i = n - 1; i >= 0; i--) {
                v = (v << 8n) | BigInt(HEAPU8[bytesPtr + i]);
            }
        } else {
            for (var i = 0; i < n; i++) {
                v = (v << 8n) | BigInt(HEAPU8[bytesPtr + i]);
            }
        }
        if (isSigned) {
            /* Top bit set? Treat as two's complement negative. */
            var top = littleEndian ? HEAPU8[bytesPtr + n - 1] : HEAPU8[bytesPtr];
            if (top & 0x80) v -= (1n << BigInt(n * 8));
        }
        if (v >= -2147483648n && v <= 2147483647n) return rt.wrapNewRef(Number(v));
        return rt.wrapNewRef(v);
    },

    /* PyImport_ImportModule(name) — runtime import. Routes through
     * Brython's __import__ which handles both standard library modules
     * and modules we've pre-registered in $B.imported (e.g. wasthon
     * modules loaded before Brython boots). */
    PyImport_ImportModule__deps: ['$WasthonRT'],
    PyImport_ImportModule: function(namePtr) {
        var rt = WasthonRT;
        if (namePtr === 0) return 0;
        var name = UTF8ToString(namePtr);
        rt.trace('PyImport_ImportModule', name);
        try {
            // Brython's __import__ takes (name, globals, locals, fromlist, level).
            // For dotted names, CPython's PyImport_ImportModule returns the
            // leaf module — passing `fromlist=[leaf]` forces __import__ to
            // both load and return the submodule.
            var imp = rt._b_.__import__;
            var mod;
            if (name.indexOf('.') !== -1) {
                var parts = name.split('.');
                var leaf = parts[parts.length - 1];
                mod = imp(name, rt._b_.None, rt._b_.None,
                          rt._b_.tuple.$factory([leaf]));
                // imp with fromlist returns the deepest module already.
                if (mod && mod.__name__ !== name) {
                    // Some import paths still return top-level; walk manually.
                    for (var i = 1; i < parts.length; i++) {
                        var sub = rt.$B.$getattr(mod, parts[i], rt._b_.None);
                        if (sub && sub !== rt._b_.None) mod = sub;
                    }
                }
            } else {
                mod = imp(name);
            }
            // Modules are singletons C code caches in lazy statics with no
            // INCREF — pin the handle (bounded by the set of modules).
            return rt.wrapPinned(mod);
        } catch (e) {
            rt.forwardError(e, rt._b_.ImportError);
            return 0;
        }
    },

    /* PyObject_CallFunction(callable, fmt, ...) — like PyObject_CallMethod
     * but no method-name step. Same minimal format-string parser.
     * Returns struct-backed handle if result is a type. */
    PyObject_CallFunction__deps: ['$WasthonRT'],
    PyObject_CallFunction: function(callableH, fmtPtr, varargs) {
        var rt = WasthonRT;
        var fn = rt.unwrap(callableH);
        var fmt = fmtPtr === 0 ? "" : UTF8ToString(fmtPtr);
        rt.trace('PyObject_CallFunction', 'fmt="' + fmt + '"');
        if (!fn) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyObject_CallFunction: callable handle " + callableH + " did not resolve");
            return 0;
        }
        // Mini Py_BuildValue parser:
        //   O/s/i/d   scalar
        //   (...)     tuple of inner values
        //   [...]     list of inner values
        //   {}        empty dict (k:v pairs not supported)
        var p = varargs, i = 0;
        function takeScalar(c, hasLen) {
            // Every recognised code MUST advance p by the vararg's width —
            // an unhandled code that leaves p put misaligns every following
            // argument. e.g. raise_errmsg's PyObject_CallFunction(
            // JSONDecodeError, "(zOn)", msg, s, end): without 'z'/'n' the msg
            // and end slots were skipped, so 'O' read the char* msg as a
            // handle and `pos` arrived wrong → JSONDecodeError construction
            // failed ("tp_call returned NULL") or got a str pos ("str object
            // cannot be interpreted as an integer").
            switch (c) {
                case 'O': case 'N': case 'S':
                    { var vo = rt.unwrap(HEAP32[p >> 2]); p += 4; return vo; }
                case 's': case 'z': case 'U':
                    // 's#'/'z#'/'U#' take a trailing Py_ssize_t length vararg.
                    { var sp = HEAP32[p >> 2]; p += 4;
                      var slen;
                      if (hasLen) { slen = HEAP32[p >> 2]; p += 4; }
                      if (sp === 0) return null;
                      return hasLen ? UTF8ToString(sp, slen) : UTF8ToString(sp); }
                case 'y':
                    // 'y'/'y#' build a bytes object from raw bytes (NOT a str
                    // via UTF8ToString) — sqlite3's _pysqlite_fetch_one_row
                    // does CallFunction(text_factory, "y#", text, nbytes) for a
                    // custom/bytes text_factory; it must receive bytes, and the
                    // data may contain embedded NULs ("a\x00b"). Length is the
                    // explicit '#' vararg, or strlen for bare 'y'.
                    { var yp = HEAP32[p >> 2]; p += 4;
                      var ylen;
                      if (hasLen) { ylen = HEAP32[p >> 2]; p += 4; }
                      if (yp === 0) return null;
                      if (ylen === undefined) { ylen = 0; while (HEAPU8[yp + ylen] !== 0) ylen++; }
                      var ybuf = new Array(ylen);
                      for (var yk = 0; yk < ylen; yk++) ybuf[yk] = HEAPU8[yp + yk];
                      return rt._b_.bytes.$factory(ybuf); }
                case 'i': case 'b': case 'h': case 'l': case 'n': case 'c':
                    { var vi = HEAP32[p >> 2]; p += 4; return vi; }
                case 'I': case 'k': case 'B': case 'H':
                    { var vu = HEAPU32[p >> 2]; p += 4; return vu; }
                case 'L': case 'K':
                    { if (p & 7) p = (p + 7) & ~7;
                      var lo = HEAPU32[p >> 2], hi = HEAP32[(p + 4) >> 2];
                      p += 8; return hi * 4294967296 + lo; }
                case 'd': case 'f':
                    { if (p & 7) p = (p + 7) & ~7;
                      var vd = HEAPF64[p >> 3]; p += 8; return vd; }
            }
            return undefined;
        }
        function parse(endChar) {
            var out = [];
            while (i < fmt.length) {
                var c = fmt[i];
                if (c === endChar) { i++; return out; }
                if (c === ',' || c === ' ' || c === ':') { i++; continue; }
                if (c === '(') { i++; out.push(rt._b_.tuple.$factory(parse(')'))); continue; }
                if (c === '[') { i++; out.push(parse(']')); continue; }
                if (c === '{') {
                    i++;
                    while (i < fmt.length && fmt[i] !== '}') i++;
                    if (fmt[i] === '}') i++;
                    out.push(rt._b_.dict.$factory());
                    continue;
                }
                i++;
                // A trailing '#' (e.g. "y#", "s#") signals an explicit
                // Py_ssize_t length vararg after the pointer.
                var hasLen = (fmt[i] === '#');
                if (hasLen) i++;
                var v = takeScalar(c, hasLen);
                if (v !== undefined) out.push(v);
            }
            return out;
        }
        var args = parse(undefined);
        try { return rt.wrapMaybeType(rt.$B.$call.apply(null, [fn].concat(args))); }
        catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* ---- Built-in type singletons ----
     * Pre C-side singletons live as struct storage in linear memory
     * (PyTypeObject PyTuple_Type, etc.). At init, the C side calls
     * wasthon_bind_builtin_type(tag, &PyXxx_Type) to wire each struct
     * address to the corresponding Brython class. From then on,
     * unwrap(&PyTuple_Type) returns _b_.tuple, and member access like
     * PyTuple_Type.tp_iter works because the struct is real memory. */
    wasthon_bind_builtin_type__deps: ['$WasthonRT'],
    wasthon_bind_builtin_type: function(tag, structPtr) {
        var rt = WasthonRT;
        var cls;
        switch (tag) {
            case 0: cls = rt._b_.type;   break;
            case 1: cls = rt._b_.tuple;  break;
            case 2: cls = rt._b_.dict;   break;
            case 3: cls = rt._b_.list;   break;
            case 4: cls = rt._b_.int;    break;
            case 5: cls = rt._b_.float;  break;
            case 6: cls = rt._b_.str;    break;
            case 7: cls = rt._b_.bytes;  break;
            case 8: cls = rt._b_.bool;   break;
            case 9: cls = rt._b_.bytearray; break;
            case 10: cls = rt._b_.set;       break;
            case 11: cls = rt._b_.frozenset; break;
            case 12:
                // Brython's Python-function class lives at $B.function
                // (NOT _b_.function, which doesn't exist — the binding was
                // mapping `undefined`, so Py_TYPE(some_python_function)
                // never equaled &PyFunction_Type and _pickle's
                // `type == &PyFunction_Type` save_global branch was dead:
                // every module-level function was unpicklable).
                cls = rt.$B.function || rt._b_.function;
                break;
            /* PickleBuffer has no Brython equivalent (protocol 5 only,
             * unsupported here). Bind to a sentinel object so the type
             * pointer is non-NULL but no instance ever matches. The
             * `tp_name`/`__name__` matter: `PyModule_AddType(m, &PyPickleBuffer_Type)`
             * uses them as the attribute name on the _pickle module, so
             * `from _pickle import PickleBuffer` (in Brython's pickle.py)
             * actually finds it. Without the name, it landed as
             * `_pickle.<type>` → ImportError → `pickle.py` set
             * `_HAVE_PICKLE_BUFFER = False` → 109 test_pickle entries that
             * reference `pickle.PickleBuffer` fail with AttributeError. */
            case 13: {
                // Minimal PickleBuffer stub: a Brython type built via
                // make_type so `from _pickle import PickleBuffer` sees a
                // real class (a bare JS object failed Brython's import
                // checks). Callable: `PickleBuffer(buf)` returns an
                // instance carrying the underlying buffer object on `.obj`.
                // Protocol-5 path (out-of-band) isn't implemented —
                // `pickle.py` uses the simple in-band fallback here.
                cls = rt.$B.make_type('PickleBuffer');
                cls.__module__ = '_pickle';
                cls.__wasthon_picklebuffer__ = true;
                cls.$factory = function(buf){
                    return { ob_type: cls, obj: buf };
                };
                cls.tp_new = function(cls_, args, kw){
                    return { ob_type: cls_, obj: (args && args[0]) || null };
                };
                var pb_funcs = cls.tp_funcs = {};
                pb_funcs.raw = function(self){ return self.obj; };
                pb_funcs.release = function(self){ self.obj = null; return rt._b_.None; };
                cls.tp_methods = ['raw', 'release'];
                try { rt.$B.set_func_names(cls, '_pickle'); } catch (_) {}
                try { rt.$B.finalize_type(cls); } catch (_) {}
                break;
            }
            default: return;
        }
        rt.handles.set(structPtr, cls);
        rt.builtinTypeForClass = rt.builtinTypeForClass || new Map();
        rt.builtinTypeForClass.set(cls, structPtr);
        // Wire tp_repr (offset 52) on the C-allocated struct so direct slot
        // calls like _json's `PyLong_Type.tp_repr(obj)` / `PyFloat_Type.tp_repr`
        // don't trap on a NULL pointer. Only-if-zero: never clobber a real
        // C-provided tp_repr. (tp_iternext at offset 56 is installed lazily by
        // ensureTypeStruct for on-demand structs; the builtin singletons skip
        // that path, so they need it set here.)
        if (rt._builtinTpRepr === undefined) {
            rt._builtinTpRepr = _wasthon_get_builtin_tp_repr();
        }
        if (HEAP32[(structPtr + 52) >> 2] === 0) {
            HEAP32[(structPtr + 52) >> 2] = rt._builtinTpRepr;
        }
        // tp_name (offset 12): a C string. Error messages format it with
        // %.200s — e.g. _json's "keys must be ... not %.100s" / make_encoder's
        // "argument 1 must be dict or None, not %.200s" read Py_TYPE(x)->tp_name.
        // Left NULL it printed "(null)" instead of "int"/"tuple"/etc. Builtin
        // classes keep __name__ in a slot, not as a direct JS property, so
        // `cls.__name__`/`cls.$infos.__name__` read undefined for int/tuple/… —
        // resolve through Brython's attribute machinery instead. Force-set
        // (not only-if-zero): the Brython class name is authoritative; the
        // static C struct's offset 12 under the bridge layout is unreliable.
        var bname;
        try { bname = rt.$B.$getattr(cls, '__name__'); } catch (e) {}
        if (typeof bname !== 'string' || !bname) {
            bname = (cls.$infos && cls.$infos.__name__) || cls.__name__ || cls.tp_name;
        }
        if (bname) {
            try {
                var blen = lengthBytesUTF8(bname) + 1;
                var bptr = _malloc(blen);
                stringToUTF8(bname, bptr, blen);
                HEAP32[(structPtr + 12) >> 2] = bptr;
            } catch (e) {}
        }
    },

    /* Generic tp_iter for built-in type singletons. Called via member
     * access like PyTuple_Type.tp_iter(t). Dispatches to Brython's iter()
     * regardless of which built-in type's slot was used — for the basic
     * sequence/mapping types, that's the right behaviour. */
    wasthon_builtin_tp_iter__deps: ['$WasthonRT'],
    wasthon_builtin_tp_iter: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try { return rt.wrapNewRef(rt._b_.iter(obj)); }
        catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* Generic tp_iternext for Brython-backed iterator type-structs (offset 56).
     * C code that reads Py_TYPE(it)->tp_iternext and calls it directly — e.g.
     * math.sumprod's `p_next = *Py_TYPE(p_it)->tp_iternext` — needs a real
     * function pointer here; ensureTypeStruct otherwise leaves the slot NULL
     * and the call traps ("indirect call to null"). Mirrors PyIter_Next:
     * next(it), returning NULL with NO exception at StopIteration — the
     * faithful built-in-iterator contract (CPython's listiter_next returns
     * NULL without setting an exception on clean exhaustion), which sumprod's
     * `if (p_i == NULL) { if (PyErr_Occurred()) ...; p_stopped = true; }`
     * loop handles directly. */
    wasthon_builtin_tp_iternext__deps: ['$WasthonRT'],
    wasthon_builtin_tp_iternext: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try { return rt.wrapNewRef(rt._b_.next(obj)); }
        catch (e) {
            try {
                if (rt.$B.is_exc && rt.$B.is_exc(e, rt._b_.StopIteration)) return 0;
            } catch (_) {}
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* Generic tp_repr for the builtin type-structs (offset 52). C code that
     * calls a builtin type's tp_repr directly — e.g. _json's encoder does
     * `PyLong_Type.tp_repr(obj)` / `PyFloat_Type.tp_repr(obj)` to stringify
     * int/float values and dict keys — needs a real function pointer here;
     * wasthon_bind_builtin_type otherwise leaves the C-allocated struct slot
     * NULL and the call traps ("indirect call to null"). A builtin type's
     * tp_repr reflects the BASE type, ignoring a subclass __repr__ override —
     * CPython's PyLong_Type.tp_repr(x) is int.__repr__(x), not
     * type(x).__repr__(x). _json's encoder calls PyLong_Type.tp_repr /
     * PyFloat_Type.tp_repr on int/float subclasses (IntEnum, IntFlag, float
     * enums); a plain repr(obj) returned the enum repr ("<BigNum.small: 1>")
     * instead of the value ("1"), so route int/float through the base type's
     * __repr__. Plain int/float are unaffected (same string). */
    wasthon_builtin_tp_repr__deps: ['$WasthonRT'],
    wasthon_builtin_tp_repr: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        try {
            var base = null;
            if (rt.$B.$isinstance(obj, rt._b_.int) && !rt.$B.$isinstance(obj, rt._b_.bool)) {
                base = rt._b_.int;
            } else if (rt.$B.$isinstance(obj, rt._b_.float)) {
                base = rt._b_.float;
            }
            if (base !== null) {
                return rt.wrapNewRef(rt.$B.$call(rt.$B.$getattr(base, '__repr__'), obj));
            }
            return rt.wrapNewRef(rt.$B.$call(rt._b_.repr, obj));
        } catch (e) { rt.forwardError(e, rt._b_.RuntimeError); return 0; }
    },

    /* tp_new for the Brython-class type-structs that ensureTypeStruct builds.
     * C code that reconstructs an instance from such a struct calls
     * cls->tp_new(cls, args, kwargs); for a Brython class that is
     * cls.__new__(cls, *args). Used by _pickle's load_newobj (NEWOBJ). */
    wasthon_brython_tp_new__deps: ['$WasthonRT'],
    wasthon_brython_tp_new: function(typeHandle, argsHandle, kwargsHandle) {
        var rt = WasthonRT;
        var cls = rt.unwrap(typeHandle);
        if (cls === null) return 0;
        var args = argsHandle ? rt.unwrap(argsHandle) : null;
        var callArgs = [cls];
        if (Array.isArray(args)) {
            for (var i = 0; i < args.length; i++) callArgs.push(args[i]);
        }
        try {
            // Forward keyword args via Brython's $kw marker: NEWOBJ_EX
            // reconstructs as cls.__new__(cls, *args, **kwargs); dropping them
            // made e.g. an int subclass pickled via __getnewargs_ex__ rebuild
            // with the default base 10 (int('FACE') -> ValueError).
            var kwargs = kwargsHandle ? rt.unwrap(kwargsHandle) : null;
            if (kwargs) {
                var kwMap = {};
                var items = rt._b_.list.$factory(
                    rt.$B.$call(rt.$B.$getattr(kwargs, 'items')));
                for (var p = 0; p < items.length; p++) {
                    var nm = rt.asJSStr(items[p][0]);
                    if (nm === null) nm = String(items[p][0]);
                    kwMap[nm] = items[p][1];
                }
                callArgs.push({ $kw: [kwMap] });
            }
            var newm = rt.$B.$getattr(cls, '__new__');
            var inst = rt.$B.$call.apply(rt.$B, [newm].concat(callArgs));
            return rt.wrapNewRef(inst);
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* ----------------------------------------------------------------
     * Number-protocol slots for built-in PyLong_Type / PyFloat_Type.
     * _decimal caches these function pointers at init from
     *   PyLong_Type.tp_as_number->nb_multiply  (and friends)
     * and calls them in its arithmetic hot path. Each function is a
     * thin dispatcher to Brython's int.__op__ / float.__op__. They use
     * the standard CPython binaryfunc / unaryfunc / ternaryfunc ABI.
     * ---------------------------------------------------------------- */
    wasthon_long_nb_multiply__deps: ['$WasthonRT'],
    wasthon_long_nb_multiply: function(aH, bH) {
        var rt = WasthonRT;
        try {
            var a = rt.unwrap(aH), b = rt.unwrap(bH);
            return rt.wrapNewRef(rt.$B.$call(rt.$B.$getattr(rt._b_.int, '__mul__'), a, b));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    wasthon_long_nb_floor_divide__deps: ['$WasthonRT'],
    wasthon_long_nb_floor_divide: function(aH, bH) {
        var rt = WasthonRT;
        try {
            var a = rt.unwrap(aH), b = rt.unwrap(bH);
            return rt.wrapNewRef(rt.$B.$call(rt.$B.$getattr(rt._b_.int, '__floordiv__'), a, b));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* ternaryfunc: nb_power(a, b, c). c is None for binary pow. */
    wasthon_long_nb_power__deps: ['$WasthonRT'],
    wasthon_long_nb_power: function(aH, bH, cH) {
        var rt = WasthonRT;
        try {
            var a = rt.unwrap(aH), b = rt.unwrap(bH), c = rt.unwrap(cH);
            if (c === null || c === rt._b_.None) {
                return rt.wrapNewRef(rt.$B.$call(rt.$B.$getattr(rt._b_.int, '__pow__'), a, b));
            }
            return rt.wrapNewRef(rt._b_.pow(a, b, c));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    wasthon_float_nb_absolute__deps: ['$WasthonRT'],
    wasthon_float_nb_absolute: function(handle) {
        var rt = WasthonRT;
        try {
            var x = rt.unwrap(handle);
            // Brython floats come in two shapes: a raw JS number (literals,
            // many fast paths) or a boxed {ob_type: float, value: …} object
            // (results of rich_op1 division, random.expovariate, …). Number()
            // of the boxed object is NaN, so abs() of any computed float was
            // NaN — _decimal's Decimal(float) calls this (_py_float_abs) before
            // as_integer_ratio, so Decimal(expovariate result) blew up with
            // "cannot convert NaN to integer ratio". Read .value like
            // PyFloat_AsDouble does.
            var d = (typeof x === 'number') ? x
                  : (x && typeof x.value === 'number') ? x.value
                  : Number(x);
            return rt.wrapNewRef(Math.abs(d));
        } catch (e) {
            rt.forwardError(e, rt._b_.TypeError);
            return 0;
        }
    },

    /* int.bit_length — number of bits required for binary representation
     * of abs(self), excluding sign and leading zeros. METH_NOARGS so the
     * second arg is unused. _decimal looks this up via tp_methods. */
    wasthon_long_bit_length__deps: ['$WasthonRT'],
    wasthon_long_bit_length: function(selfH, unusedH) {
        var rt = WasthonRT;
        var x = rt.unwrap(selfH);
        var n;
        if (typeof x === 'bigint') {
            n = x < 0n ? -x : x;
        } else if (typeof x === 'number') {
            n = BigInt(Math.abs(Math.trunc(x)));
        } else {
            try { n = BigInt(rt.$B.$call(rt._b_.int, x) | 0); } catch (e) { n = 0n; }
            if (n < 0n) n = -n;
        }
        var bits = 0;
        while (n > 0n) { bits++; n >>= 1n; }
        return rt.wrapNewRef(bits);
    },

    /* float.as_integer_ratio — returns (numerator, denominator). */
    wasthon_float_as_integer_ratio__deps: ['$WasthonRT'],
    wasthon_float_as_integer_ratio: function(selfH, unusedH) {
        var rt = WasthonRT;
        try {
            var x = rt.unwrap(selfH);
            // Same boxed-vs-raw split as nb_absolute: a boxed float carries its
            // double in .value, and Number({…}) is NaN. Without the .value read
            // a boxed operand would falsely raise "cannot convert NaN…" below.
            var asNum = (typeof x === 'number') ? x
                      : (x && typeof x.value === 'number') ? x.value
                      : Number(x);
            if (!isFinite(asNum)) {
                rt.setError(rt.wrap(rt._b_.OverflowError),
                    "cannot convert " + asNum + " to integer ratio");
                return 0;
            }
            // Brython exposes float.as_integer_ratio via _b_.float. Its float
            // funcs expect a BOXED float ({value: x}); a raw JS number makes
            // isnan() read `raw.value` = undefined → isNaN(undefined) = true →
            // bogus "Cannot pass NaN to float.as_integer_ratio" for ANY value
            // (this broke every float→Decimal conversion).
            var fn = rt.$B.$getattr(rt._b_.float, 'as_integer_ratio');
            return rt.wrapNewRef(rt.$B.$call(fn, rt.$B.fast_float(asNum)));
        } catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* ---- Helper called by _wasthon_Py_TYPE in wasthon.c ----
     * For wasthon-allocated instances we stashed the type-struct pointer
     * in __wasthon_type__ at GC_New time; return that directly so C can
     * dereference tp->tp_dict / tp->tp_free. For other objects we fall
     * back to wrapping the Brython class as a fresh handle (won't be
     * dereferenceable, but no caller needs that for non-instances). */
    wasthon_get_type_of__deps: ['$WasthonRT'],
    wasthon_get_type_of: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        if (obj.__wasthon_type__) return obj.__wasthon_type__;
        var cls = obj.__class__ || (rt.$B.get_class && rt.$B.get_class(obj));
        /* Built-in types: return the singleton struct address so that
         * Py_TYPE(x) == &PyTuple_Type comparisons work (otherwise wrap()
         * allocates a fresh handle each call and the comparison fails). */
        if (rt.builtinTypeForClass && rt.builtinTypeForClass.has(cls)) {
            return rt.builtinTypeForClass.get(cls);
        }
        return rt.wrap(cls);
    },

    /* ---- PyUnicode introspection: materialize a Py_UCS4 buffer in linear
     * memory, cache it on the string object. The regex engine's hot loop
     * indexes PyUnicode_READ(kind, data, i) directly from this buffer, so
     * the JS↔WASM boundary is crossed once per string, not per character. */
    PyUnicode_GET_LENGTH__deps: ['$WasthonRT'],
    PyUnicode_GET_LENGTH: function(handle) {
        var rt = WasthonRT;
        var obj = rt.asJSStr(rt.unwrap(handle));
        if (obj === null) return 0;
        // Count codepoints (not UTF-16 units). For BMP-only strings the
        // two coincide; astral chars (>U+FFFF) take 2 units but 1 codepoint.
        var n = 0;
        for (var i = 0; i < obj.length;) {
            var c = obj.codePointAt(i);
            i += c > 0xFFFF ? 2 : 1;
            n++;
        }
        return n;
    },

    PyUnicode_KIND__deps: ['$WasthonRT'],
    PyUnicode_KIND: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        /* PyUnicode_New placeholder: return the kind the buffer was
         * allocated with. */
        if (obj && obj.__wasthon_unicode_kind__) return obj.__wasthon_unicode_kind__;
        /* Existing JS string: compute the minimum kind needed (CPython's
         * PEP 393 contract). This MUST match what PyUnicode_DATA returns
         * — readers expect (kind, data, i) to satisfy stride consistency
         * across input/output buffers. */
        var s = rt.asJSStr(obj);
        if (s === null) return 1;
        var max = 0;
        for (var i = 0; i < s.length;) {
            var c = s.codePointAt(i);
            if (c > max) max = c;
            i += c > 0xFFFF ? 2 : 1;
            if (max > 0xFFFF) break;
        }
        return (max < 0x100) ? 1 : (max < 0x10000 ? 2 : 4);
    },

    PyUnicode_DATA__deps: ['$WasthonRT'],
    PyUnicode_DATA: function(handle) {
        var rt = WasthonRT;
        var raw = rt.unwrap(handle);
        /* PyUnicode_New placeholder — return its buffer directly. */
        if (raw && raw.__wasthon_unicode_buf__) return raw.__wasthon_unicode_buf__;

        var obj = rt.asJSStr(raw);
        if (obj === null) return 0;

        /* Compute the kind PEP 393 would assign (must match PyUnicode_KIND). */
        var codepoints = [];
        var max = 0;
        for (var i = 0; i < obj.length;) {
            var c = obj.codePointAt(i);
            codepoints.push(c);
            if (c > max) max = c;
            i += c > 0xFFFF ? 2 : 1;
        }
        var kind = (max < 0x100) ? 1 : (max < 0x10000 ? 2 : 4);
        var len = codepoints.length;

        /* Cache buffer keyed by (string, kind). */
        if (!rt._ucsCache) rt._ucsCache = new Map();
        var perStr = rt._ucsCache.get(obj);
        if (!perStr) { perStr = new Map(); rt._ucsCache.set(obj, perStr); }
        var cached = perStr.get(kind);
        if (cached) return cached;

        var ptr = _malloc(Math.max(kind, len * kind));
        for (var j = 0; j < len; j++) {
            if (kind === 4)      HEAPU32[(ptr + j * 4) >> 2] = codepoints[j];
            else if (kind === 2) HEAPU16[(ptr + j * 2) >> 1] = codepoints[j];
            else                 HEAPU8[ptr + j] = codepoints[j];
        }
        perStr.set(kind, ptr);
        return ptr;
    },

    PyUnicode_FindChar__deps: ['$WasthonRT'],
    PyUnicode_FindChar: function(handle, ch, start, end, dir) {
        var rt = WasthonRT;
        var obj = rt.asJSStr(rt.unwrap(handle));
        if (obj === null) return -1;
        // Iterate codepoints between start and end (exclusive) looking for ch.
        var cps = [];
        for (var i = 0; i < obj.length;) {
            var c = obj.codePointAt(i);
            cps.push(c);
            i += c > 0xFFFF ? 2 : 1;
        }
        if (end > cps.length) end = cps.length;
        if (dir > 0) {
            for (var k = start; k < end; k++) if (cps[k] === ch) return k;
        } else {
            for (var k = end - 1; k >= start; k--) if (cps[k] === ch) return k;
        }
        return -1;
    },

    PyUnicode_Substring__deps: ['$WasthonRT'],
    PyUnicode_Substring: function(handle, start, end) {
        var rt = WasthonRT;
        var obj = rt.asJSStr(rt.unwrap(handle));
        if (obj === null) return 0;
        // Codepoint-aware slice.
        var cps = [];
        for (var i = 0; i < obj.length;) {
            var c = obj.codePointAt(i);
            cps.push(c);
            i += c > 0xFFFF ? 2 : 1;
        }
        if (end > cps.length) end = cps.length;
        if (start < 0) start = 0;
        var chunk = cps.slice(start, end).map(function(c) {
            return String.fromCodePoint(c);
        }).join('');
        return rt.wrapNewRef(chunk);
    },

    PyUnicode_FromKindAndData__deps: ['$WasthonRT'],
    PyUnicode_FromKindAndData: function(kind, dataPtr, size) {
        var rt = WasthonRT;
        var chars = [];
        for (var i = 0; i < size; i++) {
            var c;
            if (kind === 4) c = HEAPU32[(dataPtr + i * 4) >> 2];
            else if (kind === 2) c = HEAPU16[(dataPtr + i * 2) >> 1];
            else c = HEAPU8[dataPtr + i];
            chars.push(String.fromCodePoint(c));
        }
        return rt.wrapNewRef(chars.join(''));
    },

    PyUnicode_FromOrdinal__deps: ['$WasthonRT'],
    PyUnicode_FromOrdinal: function(ordinal) {
        var rt = WasthonRT;
        // String.fromCodePoint throws a JS RangeError for an out-of-range value
        // (> 0x10FFFF) — e.g. a 'u'/'w' array holding a corrupt item read as
        // 0xFFFFFFFF (test_array.test_issue17223: str(array('u', b'\\xff'*4))).
        // CPython raises ValueError; forward one instead of leaking a
        // JavascriptError.
        try {
            return rt.wrapNewRef(String.fromCodePoint(ordinal >>> 0));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.ValueError),
                "character not in range(0x110000)");
            return 0;
        }
    },

    /* PyUnicode_FromWideChar(buf, len) — buf is a wchar_t* (32-bit on
     * wasm32), each element a Unicode codepoint. len < 0 means C-string
     * (NUL-terminated); _decimal always passes an explicit length. */
    PyUnicode_FromWideChar__deps: ['$WasthonRT'],
    PyUnicode_FromWideChar: function(bufPtr, len) {
        var rt = WasthonRT;
        if (bufPtr === 0) return rt.wrapNewRef("");
        if (len < 0) {
            // NUL-terminated.
            len = 0;
            while (HEAPU32[(bufPtr + len * 4) >> 2] !== 0) len++;
        }
        var chars = [];
        try {
            for (var i = 0; i < len; i++) {
                chars.push(String.fromCodePoint(HEAPU32[(bufPtr + i * 4) >> 2]));
            }
        } catch (e) {
            // an out-of-range wchar (corrupt 'u'/'w' array item) -> ValueError,
            // not a leaked JS RangeError (test_array.test_issue17223:
            // array('u', b'\\xff'*4).tounicode()).
            rt.setError(rt.wrap(rt._b_.ValueError),
                "character not in range(0x110000)");
            return 0;
        }
        return rt.wrapNewRef(chars.join(''));
    },

    PyUnicode_AppendAndDel__deps: ['$WasthonRT'],
    PyUnicode_AppendAndDel: function(leftPtrPtr, rightHandle) {
        var rt = WasthonRT;
        var leftH = HEAP32[leftPtrPtr >> 2];
        var left = rt.unwrap(leftH);
        var right = rt.unwrap(rightHandle);
        if (typeof left !== 'string' || typeof right !== 'string') return -1;
        HEAP32[leftPtrPtr >> 2] = rt.wrap(left + right);
        return 0;
    },

    PyUnicode_Concat__deps: ['$WasthonRT'],
    PyUnicode_Concat: function(leftH, rightH) {
        var rt = WasthonRT;
        var l = rt.unwrap(leftH);
        var r = rt.unwrap(rightH);
        if (typeof l !== 'string' || typeof r !== 'string') return 0;
        return rt.wrapNewRef(l + r);
    },

    PyUnicode_Join__deps: ['$WasthonRT'],
    PyUnicode_Join: function(sepH, seqH) {
        var rt = WasthonRT;
        var sep = rt.unwrap(sepH);
        var seq = rt.unwrap(seqH);
        if (typeof sep !== 'string' || !Array.isArray(seq)) return 0;
        try { return rt.wrapNewRef(seq.join(sep)); } catch (e) { return 0; }
    },

    PyUnicode_MAX_CHAR_VALUE__deps: ['$WasthonRT'],
    PyUnicode_MAX_CHAR_VALUE: function(handle) {
        var obj = WasthonRT.asJSStr(WasthonRT.unwrap(handle));
        if (obj === null) return 0x10FFFF;
        var max = 0;
        for (var i = 0; i < obj.length;) {
            var c = obj.codePointAt(i);
            if (c > max) max = c;
            i += c > 0xFFFF ? 2 : 1;
        }
        return max;
    },

    /* PyUnicode_New(size, maxchar) — allocate a fresh str of `size` chars.
     * Two consumption patterns:
     *  (1) sre uses the writer APIs (PyUnicode_AppendAndDel etc.) and never
     *      touches the underlying buffer — for it, an empty placeholder is
     *      fine (writer APIs replace the handle's value).
     *  (2) _decimal pairs this with PyUnicode_1BYTE_DATA + memcpy to write
     *      a Latin-1 buffer in linear memory, then returns the result. For
     *      this path the placeholder must own a linear-memory buffer; the
     *      string is materialized lazily (asJSStr handles the placeholder
     *      format) and by the trampoline finalize step. */
    PyUnicode_New__deps: ['$WasthonRT'],
    PyUnicode_New: function(size, maxchar) {
        var rt = WasthonRT;
        if (size === 0) return rt.wrapNewRef("");
        // Choose kind matching CPython's PEP 393: 1 byte for maxchar < 0x100,
        // 2 bytes for < 0x10000, 4 bytes otherwise. _decimal always uses 127.
        var kind = (maxchar < 0x100) ? 1 : (maxchar < 0x10000 ? 2 : 4);
        var bufPtr = _malloc(size * kind);
        HEAPU8.fill(0, bufPtr, bufPtr + size * kind);
        var placeholder = {
            __wasthon_unicode_buf__:  bufPtr,
            __wasthon_unicode_size__: size,
            __wasthon_unicode_kind__: kind,
        };
        return rt.wrapNewRef(placeholder);
    },

    /* PyUnicode_1BYTE_DATA(str) — returns the pointer to the Latin-1
     * data buffer for a 1-byte-kind PEP 393 string. Only valid on
     * placeholders allocated by PyUnicode_New with maxchar < 0x100. */
    PyUnicode_1BYTE_DATA__deps: ['$WasthonRT', 'PyUnicode_DATA'],
    PyUnicode_1BYTE_DATA: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj && obj.__wasthon_unicode_buf__) return obj.__wasthon_unicode_buf__;
        // A real JS string (not a PyUnicode_New placeholder): materialize the
        // Latin-1 byte buffer, exactly as PyUnicode_DATA does for a 1-byte-kind
        // string. Returning NULL (the old behavior) made binascii's
        // ascii_buffer_converter set buf->buf = address 0, so a2b_*(str) read
        // garbage from the heap base (test_binascii.test_unicode_a2b).
        return _PyUnicode_DATA(handle);
    },

    /* PyErr_CheckSignals — no signals in WASM, always returns 0 (no pending). */
    PyErr_CheckSignals: function() { return 0; },

    /* PyErr_ExceptionMatches — check whether current pending exception is
     * an instance of the given exception class (or its subclass). */
    PyErr_ExceptionMatches__deps: ['$WasthonRT'],
    PyErr_ExceptionMatches: function(excHandle) {
        var rt = WasthonRT;
        if (!rt.pendingException) return 0;
        var current = rt.unwrap(rt.pendingException.exc);
        var target = rt.unwrap(excHandle);
        if (!current || !target) return 0;
        try {
            return rt.$B.$issubclass(current, target) ? 1 : 0;
        } catch (e) {
            return current === target ? 1 : 0;
        }
    },

    /* ---- Unicode char predicates — delegate to JS's String prototype.
     * String.fromCodePoint(ch).toLowerCase() handles Unicode case folding
     * via the engine's built-in tables (browser's ICU). For regex usage
     * this is sufficient. CPython's full unicodedb isn't replicated. */
    wasthon_unicode_tolower: function(ch) {
        return String.fromCodePoint(ch).toLowerCase().codePointAt(0);
    },
    wasthon_unicode_toupper: function(ch) {
        return String.fromCodePoint(ch).toUpperCase().codePointAt(0);
    },
    wasthon_unicode_isalpha: function(ch) {
        return /\p{L}/u.test(String.fromCodePoint(ch)) ? 1 : 0;
    },
    wasthon_unicode_isdigit: function(ch) {
        return /\p{Nd}/u.test(String.fromCodePoint(ch)) ? 1 : 0;
    },
    wasthon_unicode_isalnum: function(ch) {
        return /[\p{L}\p{N}]/u.test(String.fromCodePoint(ch)) ? 1 : 0;
    },
    wasthon_unicode_isspace: function(ch) {
        return /\s/u.test(String.fromCodePoint(ch)) ? 1 : 0;
    },
    wasthon_unicode_isdecimal: function(ch) {
        return /\p{Nd}/u.test(String.fromCodePoint(ch)) ? 1 : 0;
    },
    wasthon_unicode_todecimal: function(ch) {
        var s = String.fromCodePoint(ch);
        if (!/\p{Nd}/u.test(s)) return -1;
        // JS string number parsing for decimal digits
        return parseInt(s);
    },
    wasthon_unicode_todigit: function(ch) {
        var s = String.fromCodePoint(ch);
        if (!/\p{Nd}/u.test(s)) return -1;
        return parseInt(s);
    },
    wasthon_unicode_tonumeric: function(ch) {
        var s = String.fromCodePoint(ch);
        var n = parseFloat(s);
        return isNaN(n) ? -1.0 : n;
    },

    PyUnicode_READ_CHAR__deps: ['$WasthonRT'],
    PyUnicode_READ_CHAR: function(handle, index) {
        var obj = WasthonRT.asJSStr(WasthonRT.unwrap(handle));
        if (obj === null) return 0;
        // Codepoint-indexed access.
        var seen = 0;
        for (var i = 0; i < obj.length;) {
            var c = obj.codePointAt(i);
            if (seen === index) return c;
            seen++;
            i += c > 0xFFFF ? 2 : 1;
        }
        return 0;
    },

    PyModule_Check__deps: ['$WasthonRT'],
    PyModule_Check: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        return (obj && obj.__class__ === WasthonRT._b_.module) ? 1 : 0;
    },

    /* PyCapsule — opaque C-pointer wrapper. unicodedata uses it for its
     * name-API table. We back it with a JS object holding the raw ptr. */
    PyCapsule_New__deps: ['$WasthonRT'],
    PyCapsule_New: function(ptr, namePtr, dtor) {
        var rt = WasthonRT;
        var name = namePtr ? UTF8ToString(namePtr) : null;
        return rt.wrapNewRef({ __class__: 'PyCapsule', ptr: ptr, name: name });
    },

    PyCapsule_GetPointer__deps: ['$WasthonRT'],
    PyCapsule_GetPointer: function(capsuleHandle, namePtr) {
        var obj = WasthonRT.unwrap(capsuleHandle);
        if (!obj || obj.__class__ !== 'PyCapsule') return 0;
        return obj.ptr;
    },

    /* PyOS_string_to_double(s, *endptr, overflow_exc) — parse a C string
     * as a double. *endptr (if non-NULL) gets the address right after the
     * parsed prefix; on overflow we set overflow_exc and return -1.0.
     * pickle protocol 0 uses this for the FLOAT opcode. */
    PyOS_string_to_double__deps: ['$WasthonRT'],
    PyOS_string_to_double: function(strPtr, endptrPtr, overflowExcH) {
        var rt = WasthonRT;
        if (strPtr === 0) {
            rt.setError(rt.wrap(rt._b_.ValueError), "NULL string");
            return -1.0;
        }
        var s = UTF8ToString(strPtr);
        /* Find the longest numeric prefix JS can parse. parseFloat handles
         * leading whitespace, +/-, exponent. */
        var m = s.match(/^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
        if (!m) {
            rt.setError(rt.wrap(rt._b_.ValueError),
                "could not convert string to float");
            return -1.0;
        }
        var v = parseFloat(m[0]);
        if (!isFinite(v)) {
            var exc = overflowExcH !== 0 ? rt.unwrap(overflowExcH)
                                         : rt._b_.OverflowError;
            rt.setError(rt.wrap(exc || rt._b_.OverflowError),
                "float overflow");
            return -1.0;
        }
        if (endptrPtr !== 0) {
            /* Compute char-offset in s, then translate back to a pointer
             * within the linear-memory buffer. UTF-8 here is ASCII so
             * char count == byte count. */
            HEAP32[endptrPtr >> 2] = strPtr + m[0].length;
        }
        return v;
    },

    /* _PySys_GetSizeOf(obj) — stub. The bridge has no per-object size
     * tracking. pickle uses this only as an output-buffer preallocation
     * hint; returning 0 just skips the optimization. */
    _PySys_GetSizeOf: function(_obj) { return 0; },

    /* PyBuffer_IsContiguous — minimal buffer impl is always contiguous. */
    PyBuffer_IsContiguous: function(_view, _order) { return 1; },

    /* PyCFunction_GET_SELF / PyCFunction_GET_FUNCTION — pickle inspects
     * C-method objects to pickle bound methods. The bridge wraps C
     * methods as JS trampolines tagged with `ob_type = builtin_method`
     * (see __wasthon_install_methods). For pickle's purposes we expose
     * `__self__` / `__func__` analogues if present, NULL otherwise. */
    PyCFunction_GET_SELF__deps: ['$WasthonRT'],
    PyCFunction_GET_SELF: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (!obj) return 0;
        var self = obj.__self__ !== undefined ? obj.__self__ : null;
        return self === null ? 0 : rt.wrap(self);
    },
    PyCFunction_GET_FUNCTION__deps: ['$WasthonRT'],
    PyCFunction_GET_FUNCTION: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (!obj) return 0;
        /* Return the C function pointer if available, else 0 — pickle
         * uses this only as an opaque identity comparison key. */
        return obj.__wasthon_fnptr__ || 0;
    },

    /* PyLong_GetSign(v, *sign) — write -1/0/+1 into *sign, return 0/-1. */
    PyLong_GetSign__deps: ['$WasthonRT'],
    PyLong_GetSign: function(vH, signPtr) {
        var rt = WasthonRT;
        var v = rt.unwrap(vH);
        if (v === null || v === undefined) {
            rt.setError(rt.wrap(rt._b_.TypeError), "PyLong_GetSign: NULL");
            return -1;
        }
        var n = (typeof v === 'bigint') ? Number(v > 0n ? 1n : v < 0n ? -1n : 0n)
              : (typeof v === 'number') ? (v > 0 ? 1 : v < 0 ? -1 : 0)
              : 0;
        HEAP32[signPtr >> 2] = n;
        return 0;
    },

    /* PyObject_GetItem(o, key) — o[key], raises KeyError/IndexError. */
    PyObject_GetItem__deps: ['$WasthonRT'],
    PyObject_GetItem: function(objH, keyH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        var key = rt.unwrap(keyH);
        try { return rt.wrapNewRef(rt.$B.$getitem(obj, key)); }
        catch (e) {
            var excCls = (e && e.__class__) ? e.__class__ : rt._b_.KeyError;
            rt.setError(rt.wrap(excCls),
                (e && e.args && e.args.length) ? String(e.args[0])
                                               : (e && e.message) || String(e));
            return 0;
        }
    },

    /* _PyErr_ChainExceptions1(exc) — CPython: with a currently-set
     * exception, `exc` becomes its __context__; with none, `exc` is
     * re-raised. The bridge keeps a single pending slot and no chaining, so
     * a currently-pending exception still wins (as before) — but when
     * NOTHING is pending we must re-raise `exc`, else it is silently lost.
     * sqlite3's bind_parameters relies on this: a failed bind grabs the
     * Python error via PyErr_GetRaisedException, calls set_error_from_db
     * (which sets nothing when the DB error is SQLITE_OK — a pure Python
     * failure such as a surrogate UnicodeEncodeError), then
     * _PyErr_ChainExceptions1 to re-raise it. As a no-op the error was
     * dropped and the parameter bound NULL (test_string_with_surrogates,
     * test_param_surrogates, test_surrogates, test_bind_mutating_list). */
    _PyErr_ChainExceptions1__deps: ['$WasthonRT'],
    _PyErr_ChainExceptions1: function(excH) {
        var rt = WasthonRT;
        if (excH === 0 || excH === rt.SLOT_NONE) return;
        if (rt.pendingException) return;
        var exc = rt.unwrap(excH);
        if (!exc) return;
        rt.setError(rt.wrap(exc.__class__ ? exc.__class__ : rt._b_.Exception),
                    String(exc), exc);
    },

    /* PyIter_Check(o) — has __next__? */
    PyIter_Check__deps: ['$WasthonRT'],
    PyIter_Check: function(objH) {
        var rt = WasthonRT;
        var obj = rt.unwrap(objH);
        if (obj === null || obj === undefined) return 0;
        try {
            var cls = obj.__class__ || rt.$B.get_class(obj);
            return (cls && rt.$B.$getattr(cls, '__next__', null)) ? 1 : 0;
        } catch (e) { return 0; }
    },

    /* _PyUnicode_Equal(a, b) — string equality between two PyObject*. */
    _PyUnicode_Equal__deps: ['$WasthonRT'],
    _PyUnicode_Equal: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.asJSStr(rt.unwrap(aH));
        var b = rt.asJSStr(rt.unwrap(bH));
        if (a === null || b === null) return 0;
        return a === b ? 1 : 0;
    },

    /* PyTuple_GetSlice(t, low, high) — t[low:high] for a tuple. */
    PyTuple_GetSlice__deps: ['$WasthonRT'],
    PyTuple_GetSlice: function(tH, low, high) {
        var rt = WasthonRT;
        var t = rt.unwrap(tH);
        if (t === null) return 0;
        try {
            var sliced = rt._b_.tuple.$factory(Array.from(t).slice(low, high));
            return rt.wrapNewRef(sliced);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyTuple_GetSlice: " + (e.message || String(e)));
            return 0;
        }
    },

    /* PyMemoryView_FromMemory(mem, size, flags) — stub. Wraps a linear-
     * memory range as a memoryview. Bridge has no real memoryview impl;
     * returning NULL with NotImplementedError keeps the link satisfied
     * while signalling unsupported when actually called. */
    PyMemoryView_FromMemory__deps: ['$WasthonRT'],
    PyMemoryView_FromMemory: function(memPtr, size, flags) {
        var rt = WasthonRT;
        try {
            /* Read-only view: copy the C buffer into a Brython bytes and
             * wrap it in a real memoryview. Write-through (PyBUF_WRITE)
             * would need borrowed linear-memory backing — no caller in the
             * bundled modules needs it (pickle's BINBYTES readers are
             * read-only consumers). */
            var bytes = rt.$B.fast_bytes(
                Array.from(HEAPU8.subarray(memPtr, memPtr + size)));
            var mv = rt.$B.$call(rt._b_.memoryview, bytes);
            return rt.wrapNewRef(mv);
        } catch (e) {
            rt.forwardError(e, rt._b_.RuntimeError);
            return 0;
        }
    },

    /* PyUnicode_EqualToUTF8(u, c_str) — like _PyUnicode_EqualToASCIIString
     * but caller passes UTF-8 (not necessarily ASCII). Same semantics
     * here since asJSStr already returns a proper JS string and
     * UTF8ToString decodes the c_str. */
    PyUnicode_EqualToUTF8__deps: ['$WasthonRT'],
    PyUnicode_EqualToUTF8: function(uH, cstrPtr) {
        var rt = WasthonRT;
        var u = rt.asJSStr(rt.unwrap(uH));
        if (u === null || cstrPtr === 0) return 0;
        return (u === UTF8ToString(cstrPtr)) ? 1 : 0;
    },

    /* _Py_LATIN1_CHR(ch) — return the 1-char str for codepoint `ch`. */
    _Py_LATIN1_CHR__deps: ['$WasthonRT'],
    _Py_LATIN1_CHR: function(ch) {
        return WasthonRT.wrap(String.fromCharCode(ch & 0xFF));
    },

    /* PyUnicode_Split(s, sep, maxsplit) — s.split(sep, maxsplit). NULL sep
     * means whitespace split. Returns a Python list. */
    PyUnicode_Split__deps: ['$WasthonRT'],
    PyUnicode_Split: function(sH, sepH, maxsplit) {
        var rt = WasthonRT;
        var s = rt.asJSStr(rt.unwrap(sH));
        if (s === null) {
            var so = rt.unwrap(sH); var sc = '?';
            try { sc = rt.$B.class_name ? rt.$B.class_name(so) : typeof so; } catch (_) {}
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyUnicode_Split: not a str (got " + sc + ")");
            return 0;
        }
        var sep = sepH === 0 ? null : rt.asJSStr(rt.unwrap(sepH));
        try {
            var parts = sep === null
                ? rt.$B.$call(rt.$B.$getattr(s, 'split'))
                : (maxsplit < 0
                    ? rt.$B.$call(rt.$B.$getattr(s, 'split'), sep)
                    : rt.$B.$call(rt.$B.$getattr(s, 'split'), sep, maxsplit));
            return rt.wrapNewRef(parts);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.TypeError),
                "PyUnicode_Split: " + (e.message || String(e)));
            return 0;
        }
    },

    /* _PyUnicode_EqualToASCIIString(u, c_str) — u == c_str, byte-wise. */
    _PyUnicode_EqualToASCIIString__deps: ['$WasthonRT'],
    _PyUnicode_EqualToASCIIString: function(uH, cstrPtr) {
        var rt = WasthonRT;
        var u = rt.asJSStr(rt.unwrap(uH));
        if (u === null || cstrPtr === 0) return 0;
        return (u === UTF8ToString(cstrPtr)) ? 1 : 0;
    },

    /* _PySys_GetRequiredAttr(name) — sys.<name>, or NULL + error on absence.
     * The bridge has no real sys module; route via Brython's sys. */
    _PySys_GetRequiredAttr__deps: ['$WasthonRT'],
    _PySys_GetRequiredAttr: function(nameH) {
        var rt = WasthonRT;
        var name = rt.asJSStr(rt.unwrap(nameH));
        if (name === null) return 0;
        try {
            var sys = rt.$B.imported.sys;
            if (!sys) {
                rt.setError(rt.wrap(rt._b_.RuntimeError),
                    "sys module not loaded");
                return 0;
            }
            return rt.wrapNewRef(rt.$B.$getattr(sys, name));
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.AttributeError),
                "sys." + name + ": " + (e.message || String(e)));
            return 0;
        }
    },

    /* _PyMem_Strdup — strdup via malloc; caller frees. */
    _PyMem_Strdup: function(strPtr) {
        if (strPtr === 0) return 0;
        var len = 0;
        while (HEAPU8[strPtr + len] !== 0) len++;
        var p = _malloc(len + 1);
        if (p === 0) return 0;
        for (var i = 0; i <= len; i++) HEAPU8[p + i] = HEAPU8[strPtr + i];
        return p;
    },

    /* PyMemoryView_FromObject — stub. Pickle protocol 5's
     * load_readonly_buffer is the sole bridge consumer; basic
     * pickle/unpickle of int/str/list/dict/tuple/bytes never reaches
     * it, so failing this path is safe for the common case. */
    PyMemoryView_FromObject__deps: ['$WasthonRT'],
    PyMemoryView_FromObject: function(_objH) {
        var rt = WasthonRT;
        rt.setError(rt.wrap(rt._b_.NotImplementedError),
            "PyMemoryView_FromObject: memoryview not supported in bridge");
        return 0;
    },

    /* PyMemoryView_GET_BUFFER — returns a pointer to a Py_buffer struct.
     * In CPython it's a macro into the memoryview's internal storage; here
     * we keep a tiny static buffer reused per call. The only caller
     * (pickle's load_readonly_buffer) never reaches us because
     * PyMemoryView_FromObject above returns NULL first, so the contents
     * never matter — we just need a valid non-NULL pointer for the link
     * not to dangle. */
    PyMemoryView_GET_BUFFER__deps: ['$WasthonRT'],
    PyMemoryView_GET_BUFFER: function(_mvH) {
        var rt = WasthonRT;
        if (!rt._dummyPyBuffer) {
            /* sizeof(Py_buffer) = 12 fields * 4 bytes on wasm32. */
            rt._dummyPyBuffer = _malloc(48);
            HEAPU8.fill(0, rt._dummyPyBuffer, rt._dummyPyBuffer + 48);
        }
        return rt._dummyPyBuffer;
    },

    /* PyOS_snprintf — minimal printf-style. unicodedata uses it to format
     * a name buffer like "U+XXXX". Implement %s/%d/%X/%lx via JS join. */
    /* PyOS_strnicmp — case-insensitive strncmp (ASCII). */
    PyOS_strnicmp: function(s1Ptr, s2Ptr, n) {
        for (var i = 0; i < n; i++) {
            var a = HEAPU8[s1Ptr + i] | 0;
            var b = HEAPU8[s2Ptr + i] | 0;
            // ASCII tolower
            if (a >= 65 && a <= 90) a += 32;
            if (b >= 65 && b <= 90) b += 32;
            if (a !== b) return a - b;
            if (a === 0) return 0;
        }
        return 0;
    },

    PyOS_snprintf__deps: ['$WasthonRT'],
    PyOS_snprintf: function(strPtr, size, fmtPtr, varargs) {
        // Variadic args arrive via emcc's va_list ABI (same pattern as
        // PyErr_Format / PyUnicode_FromFormat): `varargs` points into
        // linear memory where each value is laid out in order. Supported
        // codes mirror the subset needed by stdlib callers: %s %d/%i %u
        // %x/%X %p %c %% with l/ll/z/h/j length qualifiers (all 32-bit
        // on wasm32 except %lld/%llu/%zd-where-Py_ssize_t is 64-bit;
        // currently Py_ssize_t == int on wasm32 so %zd reads 32-bit).
        // Pickle protocol 0 emits ints via `%zd\n` here — leaving the
        // token unsubstituted produced `'%zd'` in the pickle stream.
        var fmt = fmtPtr ? UTF8ToString(fmtPtr) : "";
        var p = varargs | 0;
        var out = "";
        for (var i = 0; i < fmt.length; i++) {
            if (fmt[i] !== '%') { out += fmt[i]; continue; }
            // Parse the spec: [flags][width][.precision][length]conversion.
            // Width matters for unicodedata's `%04X` (zero-padded hex codepoint).
            var rawStart = i;
            var leftAlign = false, zeroPad = false;
            while (i + 1 < fmt.length && "-+0 #".indexOf(fmt[i+1]) !== -1) {
                if (fmt[i+1] === '-') leftAlign = true;
                else if (fmt[i+1] === '0') zeroPad = true;
                i++;
            }
            var width = 0;
            while (i + 1 < fmt.length && fmt[i+1] >= '0' && fmt[i+1] <= '9') {
                width = width * 10 + (fmt[++i].charCodeAt(0) - 48);
            }
            var precision = -1;
            if (i + 1 < fmt.length && fmt[i+1] === '.') {
                i++; precision = 0;
                while (i + 1 < fmt.length && fmt[i+1] >= '0' && fmt[i+1] <= '9') {
                    precision = precision * 10 + (fmt[++i].charCodeAt(0) - 48);
                }
            }
            while (i + 1 < fmt.length && "lhzj".indexOf(fmt[i+1]) !== -1) { i++; }
            var c = fmt[++i];
            var piece = null;
            if (c === 's') {
                var sp = HEAP32[p >> 2]; p += 4;
                piece = (sp === 0) ? "(null)" : UTF8ToString(sp);
                if (precision >= 0) piece = piece.slice(0, precision);
            } else if (c === 'd' || c === 'i') {
                piece = String(HEAP32[p >> 2] | 0); p += 4;
            } else if (c === 'u') {
                piece = String(HEAPU32[p >> 2] >>> 0); p += 4;
            } else if (c === 'x') {
                piece = (HEAPU32[p >> 2] >>> 0).toString(16); p += 4;
            } else if (c === 'X') {
                piece = (HEAPU32[p >> 2] >>> 0).toString(16).toUpperCase(); p += 4;
            } else if (c === 'p') {
                piece = "0x" + (HEAPU32[p >> 2] >>> 0).toString(16); p += 4;
            } else if (c === 'c') {
                piece = String.fromCharCode(HEAP32[p >> 2] & 0xff); p += 4;
            } else if (c === '%') {
                piece = '%';
            } else {
                out += fmt.slice(rawStart, i + 1);  // unknown — leave as-is
                continue;
            }
            if (width > piece.length) {
                var pad = (zeroPad && !leftAlign && c !== 's' && c !== 'c')
                    ? '0' : ' ';
                var fill = pad.repeat(width - piece.length);
                piece = leftAlign ? (piece + fill) : (fill + piece);
            }
            out += piece;
        }
        var bytes = new TextEncoder().encode(out);
        var n = Math.min(bytes.length, size - 1);
        for (var i = 0; i < n; i++) HEAPU8[strPtr + i] = bytes[i];
        HEAPU8[strPtr + n] = 0;
        return n;
    },

    PyUnicode_Compare__deps: ['$WasthonRT'],
    PyUnicode_Compare: function(aH, bH) {
        var rt = WasthonRT;
        var a = rt.asJSStr(rt.unwrap(aH)); var b = rt.asJSStr(rt.unwrap(bH));
        if (a === null || b === null) return -1;
        return a < b ? -1 : (a > b ? 1 : 0);
    },

    PyUnicode_CompareWithASCIIString__deps: ['$WasthonRT'],
    PyUnicode_CompareWithASCIIString: function(aH, bPtr) {
        var rt = WasthonRT;
        var a = rt.unwrap(aH);
        var b = bPtr ? UTF8ToString(bPtr) : "";
        if (typeof a !== 'string') return -1;
        return a < b ? -1 : (a > b ? 1 : 0);
    },

    PyUnicode_FromObject__deps: ['$WasthonRT'],
    PyUnicode_FromObject: function(handle) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (typeof obj === 'string') return handle;
        try { return rt.wrapNewRef(rt._b_.str.$factory(obj)); }
        catch (e) { return 0; }
    },

    PyUnicode_IS_ASCII__deps: ['$WasthonRT'],
    PyUnicode_IS_ASCII: function(handle) {
        var obj = WasthonRT.asJSStr(WasthonRT.unwrap(handle));
        if (obj === null) return 0;
        for (var i = 0; i < obj.length; i++) {
            if (obj.charCodeAt(i) > 0x7F) return 0;
        }
        return 1;
    },

    wasthon_unicode_islinebreak: function(ch) {
        // Python's Py_UNICODE_ISLINEBREAK: \n \r \v \f \x1c-\x1e \x85 U+2028 U+2029
        return (ch === 0x0a || ch === 0x0b || ch === 0x0c || ch === 0x0d ||
                ch === 0x1c || ch === 0x1d || ch === 0x1e || ch === 0x85 ||
                ch === 0x2028 || ch === 0x2029) ? 1 : 0;
    },

    /* ---- Type-check predicates (called from PyUnicode_Check, etc.) ---- */
    wasthon_isinstance_of_builtin__deps: ['$WasthonRT'],
    wasthon_isinstance_of_builtin: function(handle, tag) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        // tag values must match WT_TAG_* in wasthon.c
        var target;
        switch (tag) {
            case 1: target = rt._b_.str;   break;  // UNICODE
            case 2: target = rt._b_.bytes; break;  // BYTES
            case 3: target = rt._b_.dict;  break;  // DICT
            case 4: target = rt._b_.tuple; break;  // TUPLE
            case 5: target = rt._b_.list;  break;  // LIST
            case 6: target = rt._b_.int;   break;  // LONG
            case 7: target = rt._b_.float; break;  // FLOAT
            default: return 0;
        }
        // Direct match plus instanceof for primitives.
        if (obj.__class__ === target) return 1;
        if (target === rt._b_.str   && typeof obj === 'string')  return 1;
        if (target === rt._b_.int   && (typeof obj === 'number' && Number.isInteger(obj))) return 1;
        if (target === rt._b_.float && typeof obj === 'number')  return 1;
        if (target === rt._b_.tuple && Array.isArray(obj))       return 1;
        // Subclass check via Brython's $isinstance.
        try { return rt.$B.$isinstance(obj, target) ? 1 : 0; }
        catch (e) { return 0; }
    },

    /* Like wasthon_isinstance_of_builtin but EXACT — no subclass match.
     * Used by the *_CheckExact slots (CPython's PyLong_CheckExact etc. are
     * `Py_TYPE(o) == &PyXxx_Type`, NOT isinstance). An exact int is an
     * unboxed JS number/bigint; a bool / IntEnum / int subclass is boxed
     * with its own __class__ and is NOT exact. */
    wasthon_exacttype_of_builtin__deps: ['$WasthonRT'],
    wasthon_exacttype_of_builtin: function(handle, tag) {
        var rt = WasthonRT;
        var obj = rt.unwrap(handle);
        if (obj === null) return 0;
        var target;
        switch (tag) {
            case 1: target = rt._b_.str;   break;
            case 2: target = rt._b_.bytes; break;
            case 3: target = rt._b_.dict;  break;
            case 4: target = rt._b_.tuple; break;
            case 5: target = rt._b_.list;  break;
            case 6: target = rt._b_.int;   break;
            case 7: target = rt._b_.float; break;
            default: return 0;
        }
        if (obj.__class__ === target) return 1;
        if (target === rt._b_.str && typeof obj === 'string') return 1;
        if (target === rt._b_.int &&
                ((typeof obj === 'number' && Number.isInteger(obj)) ||
                 typeof obj === 'bigint')) return 1;
        if (target === rt._b_.float && typeof obj === 'number' &&
                !Number.isInteger(obj)) return 1;
        if (target === rt._b_.tuple && Array.isArray(obj)) return 1;
        return 0;
    },

    /* --------------------------------------------------------------- *
     * Buffer protocol                                                 *
     *                                                                 *
     * Read raw bytes from a Brython bytes/bytearray/memoryview into   *
     * a fresh WASM linear-memory allocation, returning ptr + length.  *
     * The C side (PyObject_GetBuffer) wraps these into a Py_buffer.   *
     * --------------------------------------------------------------- */

    wasthon_get_buffer_data__deps: ['$WasthonRT'],
    wasthon_get_buffer_data: function(handle, outBufPtrPtr, outLenPtr) {
        /* PickleBuffer stub (binding case 13): the instance carries its
         * underlying buffer on `.obj` — recurse on that, so proto-5
         * save_picklebuffer's PyObject_GetBuffer works in-band. */
        var _o = WasthonRT.unwrap(handle);
        if (_o && _o.ob_type && _o.ob_type.__wasthon_picklebuffer__ && _o.obj) {
            return _wasthon_get_buffer_data(
                WasthonRT.wrap(_o.obj), outBufPtrPtr, outLenPtr);
        }

        var obj = WasthonRT.unwrap(handle);
        if (obj === null || obj === undefined) {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.TypeError),
                "a bytes-like object is required, not 'NoneType'");
            return -1;
        }

        // A non-contiguous memoryview (e.g. m[::-2]) cannot be exposed as a
        // simple C-contiguous buffer. PyObject_GetBuffer here only honors
        // PyBUF_SIMPLE, so reject it with BufferError as CPython does, instead
        // of silently materializing it via tobytes() below
        // (test_binascii.test_c_contiguity). Brython sets c_contiguous on
        // every memoryview (false for a strided slice).
        if ((obj.ob_type === WasthonRT._b_.memoryview ||
             obj.__class__ === WasthonRT._b_.memoryview) &&
            obj.c_contiguous !== undefined && !obj.c_contiguous) {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.BufferError),
                "underlying buffer is not C-contiguous");
            return -1;
        }

        // A bytes from PyBytes_FromStringAndSize(NULL,n) is a writable C
        // buffer: a producer writes content straight into __wasthon_cstr__
        // while .source stays the zero placeholder until the post-call
        // syncBytes pass folds it. The buffer protocol can run DURING that C
        // call (e.g. pickle's _Unpickler_ReadInto fills the buffer, then
        // array._array_reconstructor reads its `items` Py_buffer in the SAME
        // load) — before syncBytes — so reading .source returned zeros and
        // unpickled arrays came back all-0. Expose the live buffer instead.
        // __wasthon_cstr_size__ is set ONLY on this producer path, so it
        // precisely selects the case where __wasthon_cstr__ is authoritative;
        // _PyBytes_Resize/syncBytes clear __wasthon_cstr__ once folded, so a
        // truthy pointer is always live. bytearray excluded (w* writeback).
        if (obj.__wasthon_cstr__ &&
                obj.__wasthon_cstr_size__ !== undefined &&
                obj.__wasthon_cstr_size__ !== null &&
                obj.__class__ !== WasthonRT._b_.bytearray) {
            var clen = obj.__wasthon_cstr_size__;
            var cbuf = _malloc(clen || 1);
            if (cbuf === 0 && clen !== 0) {
                WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.MemoryError),
                    "buffer allocation failed");
                return -1;
            }
            if (clen) HEAPU8.copyWithin(cbuf, obj.__wasthon_cstr__, obj.__wasthon_cstr__ + clen);
            HEAP32[outBufPtrPtr >> 2] = cbuf;
            HEAP32[outLenPtr >> 2] = clen;
            return 0;
        }

        // Source of bytes: Brython bytes/bytearray store an Array<int> in .source;
        // memoryview wraps another buffer-protocol object; raw Uint8Array is
        // accepted for completeness (e.g. when called from JS-side helpers).
        var src = null;
        if (obj.source !== undefined && obj.source !== null) {
            src = obj.source;
        } else if (obj instanceof Uint8Array) {
            src = obj;
        } else if (Array.isArray(obj) && obj.ob_type === undefined) {
            // Raw JS array (JS-side helper) only — NOT a Brython list/tuple
            // (those carry ob_type). A list/tuple is not bytes-like, so e.g.
            // zlib.adler32([]) / crc32(()) must raise TypeError, not treat the
            // sequence as a buffer.
            src = obj;
        } else {
            // Other buffer-protocol objects (memoryview, array.array, …) don't
            // expose .source; pull their raw bytes via tobytes() — the byte
            // image CPython's buffer protocol would hand back. (Read path only;
            // write-back via w* propagates only to bytes/bytearray .source.)
            try {
                var tb = WasthonRT.$B.$getattr(obj, 'tobytes', null);
                if (tb) {
                    var b = WasthonRT.$B.$call(tb);
                    if (b && b.source !== undefined && b.source !== null) src = b.source;
                }
            } catch (e) { /* fall through to the type error */ }
        }
        if (src === null) {
            var className = WasthonRT.$B.class_name ? WasthonRT.$B.class_name(obj) : typeof obj;
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.TypeError),
                "a bytes-like object is required, not '" + className + "'");
            return -1;
        }

        var len = src.length;
        var buf = _malloc(len);
        if (buf === 0 && len !== 0) {
            WasthonRT.setError(WasthonRT.wrap(WasthonRT._b_.MemoryError),
                "buffer allocation failed");
            return -1;
        }

        // Copy into linear memory. TypedArray.set accepts both Uint8Array
        // (intrinsic memcpy) and Array<int> (engine-vectorized bulk copy).
        // Both vastly outperform a JS-level byte-by-byte loop, which is
        // the bottleneck for buffer marshalling on large payloads.
        // Brython's random.randbytes can leave BigInt ELEMENTS in a bytes
        // .source (value-dependent, hence flaky): TypedArray.set throws
        // "can't convert BigInt to number". Fall back to a converting loop.
        try {
            HEAPU8.set(src, buf);
        } catch (e) {
            for (var bi = 0; bi < len; bi++) HEAPU8[buf + bi] = Number(src[bi]) & 0xff;
        }

        // Write back: outBufPtrPtr points to a void*, outLenPtr to Py_ssize_t.
        // wasm32: pointer = 4 bytes, Py_ssize_t (intptr_t) = 4 bytes.
        HEAP32[outBufPtrPtr >> 2] = buf;
        HEAP32[outLenPtr >> 2] = len;
        return 0;
    },

    /* Called from C-side PyBuffer_Release. For writable buffers acquired
     * via PyArg_Parse('w*'), copies linear-mem bytes back into the source
     * (Brython bytearray's .source array) so Python sees the mutations.
     * Then frees the linear-mem buffer. Read-only buffers skip the
     * copy-back and just free. */
    wasthon_buffer_release__deps: ['$WasthonRT'],
    wasthon_buffer_release: function(viewPtr) {
        if (viewPtr === 0) return;
        // A view borrowed from a wasthon buffer object's own storage
        // (array.array ob_item, via the 'w*' path): C wrote straight into the
        // array, so there is nothing to copy back and the pointer is owned by
        // the array — it must not be freed.
        if (WasthonRT._wasthonBorrowedViews &&
                WasthonRT._wasthonBorrowedViews.has(viewPtr)) {
            WasthonRT._wasthonBorrowedViews.delete(viewPtr);
            return;
        }
        var bufPtr   = HEAP32[viewPtr >> 2];
        var objH     = HEAP32[(viewPtr + 4) >> 2];
        var len      = HEAP32[(viewPtr + 8) >> 2];
        var readonly = HEAP32[(viewPtr + 16) >> 2];
        if (bufPtr === 0) return;
        if (!readonly && objH !== 0) {
            var obj = WasthonRT.unwrap(objH);
            var src = obj && (obj.source ||
                              (obj instanceof Uint8Array ? obj : null));
            if (src) {
                for (var i = 0; i < len; i++) src[i] = HEAPU8[bufPtr + i];
            }
        }
        _free(bufPtr);
    },

    wasthon_object_check_buffer__deps: ['$WasthonRT'],
    wasthon_object_check_buffer: function(handle) {
        var obj = WasthonRT.unwrap(handle);
        if (obj === null || obj === undefined) return 0;
        if (obj.source !== undefined) return 1;          // bytes/bytearray
        if (obj instanceof Uint8Array) return 1;
        // memoryview / array.array / other buffer-protocol objects expose
        // tobytes() — treat that as "is a buffer" (matches wasthon_get_buffer_data).
        try { if (WasthonRT.$B.$getattr(obj, 'tobytes', null)) return 1; }
        catch (e) { /* not buffer-like */ }
        return 0;
    },

    /* --------------------------------------------------------------- *
     * Module state                                                    *
     *                                                                 *
     * Each PyObject* module handle is associated with a state pointer *
     * (allocated in WASM linear memory by tier-7 module-creation      *
     * code) and each PyTypeObject* type with the module that owns it. *
     * Both relations are tracked in JS-side maps keyed by handle.     *
     * --------------------------------------------------------------- */

    $WasthonRT_module_state__deps: ['$WasthonRT'],
    $WasthonRT_module_state: {},  // populated at tier-7 module creation

    wasthon_module_set_state__deps: ['$WasthonRT', '$WasthonRT_module_state'],
    wasthon_module_set_state: function(moduleHandle, statePtr) {
        WasthonRT_module_state[moduleHandle] = { state: statePtr, types: [] };
    },

    wasthon_module_get_state__deps: ['$WasthonRT', '$WasthonRT_module_state'],
    wasthon_module_get_state: function(moduleHandle) {
        var entry = WasthonRT_module_state[moduleHandle];
        return entry ? entry.state : 0;
    },

    wasthon_type_set_module__deps: ['$WasthonRT', '$WasthonRT_module_state'],
    wasthon_type_set_module: function(typeHandle, moduleHandle) {
        var entry = WasthonRT_module_state[moduleHandle];
        if (entry) entry.types.push(typeHandle);
        // Reverse map: store on the type itself for O(1) lookup.
        var t = WasthonRT.unwrap(typeHandle);
        if (t) t.__wasthon_module__ = moduleHandle;
    },

    wasthon_type_get_module__deps: ['$WasthonRT'],
    wasthon_type_get_module: function(typeHandle) {
        // Same MRO walk as PyType_GetModuleByDef (this one backs C's
        // PyType_GetModule / _PyType_GetModuleState): a Python subclass of a
        // C type carries no __wasthon_module__ of its own.
        var t = WasthonRT.unwrap(typeHandle);
        if (!t) return 0;
        if (t.__wasthon_module__) return t.__wasthon_module__;
        var mro = t.tp_mro || t.__mro__;
        if (mro) {
            for (var i = 0; i < mro.length; i++) {
                if (mro[i] && mro[i].__wasthon_module__) {
                    return mro[i].__wasthon_module__;
                }
            }
        }
        return 0;
    },

    /* --------------------------------------------------------------- *
     * Module and type creation                                        *
     *                                                                 *
     * The biggest single piece. Builds Brython modules and classes    *
     * from C-side `PyModuleDef` and `PyType_Spec` structures, and     *
     * provides instance allocation (`PyObject_GC_New`) plus the C↔JS  *
     * method-dispatch trampolines.                                    *
     *                                                                 *
     * Layout reminders (must match wasthon.h):                         *
     *                                                                 *
     *   PyModuleDef:                                                  *
     *     +0   PyObject *m_base_unused                                *
     *     +4   const char *m_name                                     *
     *     +8   const char *m_doc                                      *
     *     +12  Py_ssize_t  m_size                                     *
     *     +16  PyMethodDef *m_methods                                 *
     *     +20  PyModuleDef_Slot_Entry *m_slots                        *
     *     +24  void *m_traverse                                       *
     *     +28  void *m_clear                                          *
     *     +32  void *m_free                                           *
     *                                                                 *
     *   PyMethodDef (24 bytes):                                       *
     *     +0   const char *ml_name                                    *
     *     +4   void       *ml_meth                                    *
     *     +8   int         ml_flags                                   *
     *     +12  const char *ml_doc                                     *
     *                                                                 *
     *   PyType_Spec:                                                  *
     *     +0   const char *name                                       *
     *     +4   int basicsize                                          *
     *     +8   int itemsize                                           *
     *     +12  unsigned int flags                                     *
     *     +16  PyType_Slot *slots                                     *
     *                                                                 *
     *   PyType_Slot (8 bytes):                                        *
     *     +0   int slot                                               *
     *     +4   void *pfunc                                            *
     *                                                                 *
     *   PyModuleDef_Slot_Entry (8 bytes):                             *
     *     +0   int slot                                               *
     *     +4   void *value                                            *
     * --------------------------------------------------------------- */

    /* (PyModuleDef_Init is defined in the module-creation section below — registers a module def
     *  in the runtime registry and returns the def pointer cast to a handle.) */

    /* ---- wasthon_module_create: invoked by the Brython-side loader      *
     *      after PyInit_<name>() returns a moduleDef handle. Creates the *
     *      actual Brython module object, allocates state, runs Py_mod_exec*
     *      slots, and returns the module handle (== a sentinel ID).      */
    wasthon_module_create__deps: ['$WasthonRT', '$WasthonRT_module_state', '$__wasthon_install_methods'],
    wasthon_module_create: function(defHandle) {
        var rt = WasthonRT;
        var defInfo = rt.moduleDefs.get(defHandle);
        if (!defInfo) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "wasthon_module_create: unknown module def");
            return 0;
        }

        // Create a Brython module via canonical $B.module.tp_new + tp_init.
        // Using the official path ensures attribute access goes through the
        // module dict (otherwise getattr returns the raw JS value wrapped as
        // a JSObj, which breaks Python semantics).
        var modObj = rt.$B.module.tp_new(rt.$B.module);
        rt.$B.module.tp_init(modObj, defInfo.name,
                             defInfo.doc || rt._b_.None);
        // Pinned: the module handle lives in registries and C module-state
        // for the whole session.
        var modHandle = rt.wrapPinned(modObj);

        // Allocate per-module state (m_size bytes) and register it.
        var statePtr = 0;
        if (defInfo.size > 0) {
            statePtr = _malloc(defInfo.size);
            // Zero-init: callers expect calloc'd state.
            HEAPU8.fill(0, statePtr, statePtr + defInfo.size);
        }
        rt.modules.set(modHandle, {
            def: defInfo,
            statePtr: statePtr,
            name: defInfo.name,
            obj: modObj,
            types: [],
        });
        // Mirror to the tier-8 module_state map.
        WasthonRT_module_state[modHandle] = { state: statePtr, types: [] };

        // Register module-level methods (m_methods array).
        if (defInfo.methods !== 0) {
            __wasthon_install_methods(modObj, defInfo.methods, modHandle, /*moduleScope=*/true);
        }

        // Run Py_mod_exec slots in order. Some module init paths recurse
        // into Brython (PyImport_ImportModule, class registration via
        // numbers.Number.register, etc.) — Brython expects a current
        // frame on $B.frame_obj (for globals() etc.) and crashes if it's
        // null. We push a synthetic frame around the exec call:
        //   frame = [name, locals_dict, name, globals_dict]
        // and pop it after, even on error.
        if (defInfo.slots !== 0) {
            var modDict = rt.$B.get_dict(modObj);
            var modName = defInfo.name || '<wasthon>';
            var frame = [modName, modDict, modName, modDict];
            rt.$B.enter_frame(frame, '<wasthon>', 0);
            try {
                for (var sp = defInfo.slots; ; sp += 8) {
                    var slot = HEAP32[sp >> 2];
                    if (slot === 0) break;
                    var value = HEAP32[(sp + 4) >> 2];
                    if (slot === 1 /* Py_mod_exec */) {
                        // Slot value is a function pointer with signature int(PyObject*).
                        var rc = getWasmTableEntry(value)(modHandle);
                        if (rc !== 0) {
                            if (!rt.pendingException) {
                                rt.setError(rt.wrap(rt._b_.SystemError),
                                    "module exec slot returned " + rc + " without setting an exception");
                            }
                            return 0;
                        }
                    }
                    // Other slots (Py_mod_create, gil flags) are ignored for now.
                }
            } finally {
                rt.$B.leave_frame();
            }
        }
        return modHandle;
    },

    /* ---- PyType_FromModuleAndSpec ----                                  */
    PyType_FromModuleAndSpec__deps: ['$WasthonRT', '$WasthonRT_module_state', '$__wasthon_install_methods', '$__wasthon_install_getsets', '$__wasthon_install_members'],
    PyType_FromModuleAndSpec: function(moduleHandle, specPtr, basesHandle) {
        var rt = WasthonRT;
        rt.trace('PyType_FromModuleAndSpec', 'specPtr=' + specPtr);
        var namePtr   = HEAP32[ specPtr        >> 2];
        var basicsize = HEAP32[(specPtr +  4)  >> 2];
        var itemsize  = HEAP32[(specPtr +  8)  >> 2];
        var flags     = HEAPU32[(specPtr + 12) >> 2];
        var slotsPtr  = HEAP32[(specPtr + 16)  >> 2];

        var fullName = namePtr ? UTF8ToString(namePtr) : "<wasthon type>";
        // Strip module prefix for the class name (CPython convention).
        var dotIdx = fullName.lastIndexOf('.');
        var shortName = (dotIdx >= 0) ? fullName.slice(dotIdx + 1) : fullName;

        // Walk slots, collecting them into a JS object keyed by slot ID.
        var slotMap = {};
        var methodsPtr = 0, getsetPtr = 0, membersPtr = 0;
        if (slotsPtr !== 0) {
            for (var sp = slotsPtr; ; sp += 8) {
                var sid = HEAP32[sp >> 2];
                if (sid === 0) break;
                var pfunc = HEAP32[(sp + 4) >> 2];
                slotMap[sid] = pfunc;
                if (sid === 64 /* Py_tp_methods */) methodsPtr = pfunc;
                if (sid === 66 /* Py_tp_getset  */) getsetPtr  = pfunc;
                if (sid === 72 /* Py_tp_members */) membersPtr = pfunc;
            }
        }

        // Create a Brython class. make_builtin_class doesn't init_dict;
        // we do it explicitly so tp_dict has a real Brython dict that
        // PyDict_SetItemString (used by blake2module to install class-level
        // constants like SALT_SIZE) can write to.
        var cls = rt.$B.make_builtin_class(shortName);
        rt.$B.init_dict(cls);
        /* Py_TPFLAGS_IMMUTABLETYPE (wasthon.h: 1<<4): mark the Brython class
         * so type.tp_setattro refuses Python-level writes ("cannot set ...
         * attribute of immutable type ..."), as CPython does. Bridge-side
         * installs (tp_dict descriptors, class constants via
         * PyDict_SetItemString) go through set_to_dict and are unaffected. */
        if (flags & 0x10) {
            cls.tp_flags = (cls.tp_flags || 0) | rt.$B.TPFLAGS.IMMUTABLETYPE;
        }
        /* __module__ from the dotted spec name prefix (CPython's
         * PyType_FromMetaclass sets tp_dict['__module__'] = name[:lastdot]),
         * else the module's __name__. Without the dotted form, types like
         * `array.array` got __module__='builtins' and pickle couldn't locate
         * them ("not found as builtins.array"). Set it BOTH as a JS property
         * (read by add_function_infos for bound-method __module__) AND in the
         * type's tp_dict — `type.__module__`'s getter reads get_from_dict and
         * falls back to 'builtins' when the key is absent. */
        var moduleName = (dotIdx >= 0) ? fullName.slice(0, dotIdx)
            : (rt.unwrap(moduleHandle) ? rt.unwrap(moduleHandle).__name__ : "");
        cls.__module__ = moduleName;
        rt.$B.set_to_dict(cls, '__module__', moduleName);
        /* Honor the `bases` tuple (3rd arg of PyType_FromModuleAndSpec).
         * make_builtin_class defaulted tp_bases to [object]; without applying
         * the real bases, a C-module exception type built via
         * PyType_FromModuleAndSpec(module, spec, PyTuple_Pack(1, PyExc_Exception))
         * — e.g. _csv.Error — ends up inheriting only `object`, so
         * issubclass(Error, BaseException) is False and unittest's assertRaises
         * rejects it ("arg 1 must be an exception type"). Set the bases and
         * recompute the MRO via C3 (make_mro needs tp_bases set first) so
         * BaseException lands in tp_mro. PyType_FromSpec passes basesHandle=0,
         * so this is a no-op there. */
        if (basesHandle) {
            var baseTuple = rt.unwrap(basesHandle);
            if (baseTuple && baseTuple.length) {
                cls.tp_bases = Array.prototype.slice.call(baseTuple);
                cls.tp_base  = cls.tp_bases[0];
                cls.tp_mro   = rt.$B.make_mro(cls);
            }
        }
        /* make_builtin_class doesn't wire tp_setattro / tp_getattro to
         * object's defaults; without them, $B.$setattr finds undefined and
         * calls it as a function — boom. Inherit from object explicitly. */
        if (!cls.tp_setattro) cls.tp_setattro = rt._b_.object.tp_setattro;
        if (!cls.tp_getattro) cls.tp_getattro = rt._b_.object.tp_getattro;
        /* Brython 3.14's object_getattribute only engages the tp_funcs
         * fast path when `cls.$getattribute === object.tp_getattro`.
         * Without this, getattr() on instances misses C-installed methods
         * (e.g. pickle's `persistent_id` lookup on Pickler) and pickle
         * fails at dump-time with `AttributeError: persistent_id`. */
        if (!cls.$getattribute) cls.$getattribute = rt._b_.object.tp_getattro;
        /* Brython's type_getattribute (py_type.js:1318) reads
         * `cls.tp_descr_get` and checks `if (local_get !== $B.NULL)`. If we
         * leave it `undefined`, the condition is truthy → Brython calls
         * `undefined(...)` → "local_get is not a function" crash. This
         * surfaces when a wasthon instance is used as a class attribute on
         * a Python subclass (`class T: db = wasthon_obj`) — discovered
         * 2026-05-26 fishing test_unicodedata's `Unicode_3_2_0_FunctionsTest`
         * cluster (18 `getter is not a function` fails) and is also
         * suspected to underlie similar `*_get is not a function` patterns
         * across modules. Default to NULL; descr-type classes override. */
        if (cls.tp_descr_get === undefined) cls.tp_descr_get = rt.$B.NULL;
        if (cls.tp_descr_set === undefined) cls.tp_descr_set = rt.$B.NULL;

        // Allocate the C-side PyTypeObject. Layout (matches wasthon.h):
        //   +0   tp_free (no-op, NULL)
        //   +4   tp_dict (handle to the class dict)
        // PyTypeObject layout (64 bytes, ABI-aligned with CPython for the
        // refcount slot at offset 0):
        //    +0   ob_refcnt (immortal-ish for runtime types; not manipulated)
        //    +4   tp_free   (PyObject_GC_Del default; module Py_tp_free wins)
        //    +8   tp_dict
        //   +12   tp_name
        //   +16   tp_alloc
        //   +20   tp_init   (populated below if Py_tp_init slot present)
        //   +24   tp_iter
        //   +28   tp_as_number
        //   +32   tp_methods
        //   +36   tp_traverse (NULL — no cycle GC)
        //   +40   tp_dealloc  (from Py_tp_dealloc slot; drives JS-side
        //                      wasthon_decref dispatch on refcount=0)
        if (!rt._defaultTpAlloc) rt._defaultTpAlloc = _wasthon_get_default_tp_alloc();
        if (!rt._builtinTpIter)  rt._builtinTpIter  = _wasthon_get_builtin_tp_iter();
        if (!rt._defaultTpFree)  rt._defaultTpFree  = _wasthon_get_default_tp_free();
        var typeStructPtr = _malloc(64);
        HEAPU8.fill(0, typeStructPtr, typeStructPtr + 64);
        var dictObj = rt.$B.get_dict(cls);
        // Pinned: stored in the malloc'd type struct (tp_dict), read by C
        // for the type's whole life (same as ensureTypeStruct's pin).
        var dictHandle = rt.wrapPinned(dictObj);
        HEAP32[(typeStructPtr +  4) >> 2] = slotMap[63 /* Py_tp_free */] || rt._defaultTpFree;  // tp_free
        HEAP32[(typeStructPtr +  8) >> 2] = dictHandle;     // tp_dict
        HEAP32[(typeStructPtr + 12) >> 2] = namePtr;        // tp_name
        HEAP32[(typeStructPtr + 16) >> 2] = rt._defaultTpAlloc;  // tp_alloc
        HEAP32[(typeStructPtr + 24) >> 2] = rt._builtinTpIter;   // tp_iter
        HEAP32[(typeStructPtr + 32) >> 2] = methodsPtr;     // tp_methods
        HEAP32[(typeStructPtr + 40) >> 2] = slotMap[52 /* Py_tp_dealloc */] || 0;  // tp_dealloc
        var typeHandle = typeStructPtr;
        rt.bindInstance(typeHandle, cls);
        cls.__wasthon_type_handle__ = typeHandle;
        cls.__wasthon_type_token__  = specPtr;
        rt.types.set(typeHandle, {
            basicsize: basicsize,
            itemsize:  itemsize,
            flags:     flags,
            slots:     slotMap,
            methods:   methodsPtr,
            getset:    getsetPtr,
            brythonClass: cls,
            moduleHandle: moduleHandle,
            shortName: shortName,
            fullName: fullName,
        });
        // Reverse link for PyType_GetModule.
        cls.__wasthon_module__ = moduleHandle;

        // Install methods listed in PyMethodDef[].
        if (methodsPtr !== 0) {
            __wasthon_install_methods(cls, methodsPtr, moduleHandle, /*moduleScope=*/false);
        }

        // Install getset descriptors (typecode, itemsize, etc.).
        if (getsetPtr !== 0) {
            __wasthon_install_getsets(cls, getsetPtr);
        }

        // Install member descriptors — fields exposed by C struct offset
        // via PyMemberDef (re.Match.string, sqlite Connection.in_transaction,
        // etc.). Without this, instance attributes declared via tp_members
        // silently disappear.
        if (membersPtr !== 0) {
            __wasthon_install_members(cls, membersPtr);
        }

        // Signal the buffer protocol to Brython: types that declared a
        // Py_bf_getbuffer slot (id 1) get `$buffer_protocol = true` so
        // Brython's `memoryview()` constructor accepts them. Without this,
        // `memoryview(wasthon_array)` raises `TypeError: memoryview: a
        // bytes-like object is required, not 'array'`, which blocked
        // `struct.pack_into` against array.array writable buffers.
        if (slotMap[1 /* Py_bf_getbuffer */]) {
            cls.$buffer_protocol = true;
            // Buffer-export safety: the C struct tracks `ob_exports` (count of
            // live exported buffers); its resize ops raise BufferError when it's
            // > 0. Brython's memoryview() bumps a disconnected JS `obj.exports`
            // instead, so the C field stays 0 and mutations never raise. Record
            // the field's struct offset so the method trampoline can re-sync it
            // from a live-memoryview frame scan (see make_trampoline). array is
            // the only wasthon C type exporting a buffer; ob_exports sits after
            // VAR_HEAD(8) + ob_item + allocated + ob_descr + weakreflist = 24.
            cls.$wasthon_buf_exports_off = 24;
        }

        // Wire Py_tp_new (slot id 65) so Brython can instantiate the type.
        // Brython's _b_.type.tp_call reads cls.tp_new and, if .$is_slot is
        // set, calls new_func(cls, args, kw) — exactly the CPython tp_new
        // ABI. The C function signature is:
        //   PyObject *tp_new(PyTypeObject *cls, PyObject *args, PyObject *kw);
        var tpNewPtr = slotMap[65 /* Py_tp_new */];
        if ((flags & 0x8) && !tpNewPtr) {
            // Py_TPFLAGS_DISALLOW_INSTANTIATION (wasthon.h: 1<<3): no public
            // constructor — calling the type raises TypeError, as CPython
            // does. _struct.unpack_iterator uses this (no tp_new slot)
            // (test_struct.test_uninstantiable). A spec that DOES provide a
            // tp_new slot keeps it (the branch below).
            cls.tp_new = function() {
                rt.$B.RAISE(rt._b_.TypeError,
                    "cannot create '" + shortName + "' instances");
            };
            cls.tp_new.$is_slot = true;
        } else if (tpNewPtr) {
            cls.tp_new = rt.scoped(function(brythonCls, args, kw) {
                var argsH = rt.wrap(args || []);
                // For a Python subclass of a C-type, don't forward kwargs to the
                // C tp_new. CPython's array_new (and most C tp_new) only reject
                // kwargs when `type` is the exact base
                // (`if (type == state->ArrayType && !_PyArg_NoKeywords(...))`),
                // letting a subtype's __init__ consume them. We always invoke the
                // C tp_new with the parent typeHandle (the instance identity is
                // patched to brythonCls afterwards, below), so that base-only
                // guard would wrongly fire on a subclass — strip the kwargs here;
                // Brython still delivers them to the subclass __init__/tp_init.
                // Fixes array test_subclass_with_kwargs (ArraySubclassWithKwargs
                // 'b', newarg=1) across all typecodes; base instantiation
                // (brythonCls === cls) still forwards kwargs so
                // `array.array(spam=42)` keeps raising TypeError.
                var isSubclass = brythonCls && brythonCls !== cls;
                var kwH   = (!isSubclass && kw && rt._b_.dict.mp_length(kw) > 0) ? rt.wrap(kw) : 0;
                rt.pendingException = null;
                var resultH = getWasmTableEntry(tpNewPtr)(typeHandle, argsH, kwH);
                if (rt.pendingException) {
                    var pe = rt.pendingException;
                    rt.pendingException = null;
                    var exc = rt.unwrap(pe.exc) || rt._b_.Exception;
                    // Brython exception classes don't all expose $factory;
                    // $B.$call is the generic dispatch that handles both.
                    throw rt.pendingExc(pe, exc);
                }
                var inst = rt.unwrapResult(resultH);
                /* Honor Python subclasses. The C tp_new received `typeHandle`
                 * (our parent C-type, captured in closure), so the instance
                 * comes back with ob_type pointing to the parent. If Brython
                 * is instantiating a Python subclass (`class MyR(_random.Random):
                 * ...`), brythonCls is the subclass — override ob_type so
                 * `type(MyR())` returns MyR (not _random.Random) and Python
                 * attribute lookup hits the subclass dict. Mirrors what
                 * CPython's tp_new does naturally via tp_alloc(type, 0)
                 * honoring the `type` argument. Discovered 2026-05-26 when
                 * Brython's random.py:894 (`uniform=_inst.uniform` on a
                 * Random(_random.Random) subclass) crashed with
                 * AttributeError: 'Random' object has no attribute 'uniform'.
                 * NB: __wasthon_type__ stays the parent C-type so Py_TYPE
                 * and PyObject_TypeCheck on the C side still work. */
                if (inst && brythonCls && brythonCls !== cls) {
                    inst.ob_type = brythonCls;
                    inst.__class__ = brythonCls;
                    /* Attach an instance __dict__ so Python user code can
                     * `self.foo = bar` on the subclass instance. CPython
                     * does this automatically for subclasses of C-types via
                     * PyType_Ready adding a __dict__ slot (tp_dictoffset);
                     * Brython's object.$new (py_object.js:130) does it
                     * unconditionally for cls !== object. Without this,
                     * Brython's random.py:171 `self.gauss_next = None` on
                     * a Random(_random.Random) subclass crashes with
                     * "no __dict__ for setting new attributes".
                     * Use init_dict (stores a real empty_dict), NOT
                     * obj_dict({}): $B.obj_dict is the identity function
                     * (returns the raw JS object), so self.__dict__ came back
                     * as a bare JSObject — unpicklable. pickle's reduce embeds
                     * __dict__ as the instance state, so
                     * `pickle.dumps(ArraySubclass(...))` died with "cannot
                     * pickle 'JSObject' object". empty_dict matches Brython's
                     * canonical object.tp_new (py_object.js:2297). Fixes
                     * array's subclass pickle cluster (test_pickle /
                     * test_pickle_for_empty_array across typecodes).
                     * Only when the subclass has no __slots__ — matching the
                     * canonical object.tp_new, so a `__slots__`-only subclass
                     * (test_subclassing's ExaggeratingArray) gets NO __dict__
                     * and `setattr(a, 'color')` raises AttributeError. */
                    if (rt.$B.get_from_dict(brythonCls, '__slots__', rt.$B.NULL) === rt.$B.NULL) {
                        rt.$B.init_dict(inst);
                    }
                }
                return inst;
            });
            cls.tp_new.$is_slot = true;
            // Expose the C tp_new as __new__ in the class dict so an explicit
            // `Type.__new__(cls, *args)` (e.g. test_subclassing's
            // `array.array.__new__(cls, typecode, data)`) dispatches to it
            // instead of inheriting object.__new__, which rejects the extra
            // args ("object.__new__() takes exactly one argument"). Mirrors
            // Brython's make_new (finalize_builtin_types).
            var newFunc = function() {
                var na = rt.$B.args('__new__', 1, {cls: null}, arguments, null, 'args', 'kw');
                return cls.tp_new(na.cls, na.args, na.kw);
            };
            newFunc.ob_type = rt.$B.builtin_function_or_method;
            newFunc.m_self = cls;
            newFunc.ml = { ml_name: '__new__' };
            rt.$B.set_function_infos(newFunc, { __name__: '__new__', __qualname__: '__new__' });
            rt.$B.set_to_dict(cls, '__new__', newFunc);
        } else if (cls.tp_mro && cls.tp_mro.indexOf(rt._b_.BaseException) > -1) {
            // Exception subclass built with exception bases (e.g. _csv.Error =
            // PyType_FromModuleAndSpec(..., PyTuple_Pack(1, PyExc_Exception)))
            // but with no own Py_tp_new slot. Construct it like a normal Python
            // Exception subclass so instances get `.args`; otherwise
            // `raise Error('x')` crashes ("args is undefined") and
            // assertRaises(Error, ...) can't match the raised instance. Inherit
            // tp_new/tp_init from the MRO — BaseException.tp_new is marked
            // $is_slot (brython.js make_new), so type.tp_call invokes it with
            // the (cls, args, kw) convention. Only reached when the bases tuple
            // put BaseException in the MRO (FromSpec / non-exception types fall
            // through to the raw-alloc default below — no regression).
            for (var _mi = 1; _mi < cls.tp_mro.length; _mi++) {
                if (cls.tp_mro[_mi].tp_new) { cls.tp_new = cls.tp_mro[_mi].tp_new; break; }
            }
            for (var _mj = 1; _mj < cls.tp_mro.length; _mj++) {
                if (cls.tp_mro[_mj].tp_init) { cls.tp_init = cls.tp_mro[_mj].tp_init; break; }
            }
        } else {
            // No Py_tp_new in spec. CPython falls back to object.__new__,
            // which allocates `type->tp_basicsize` raw bytes. We replicate
            // that so a C-style tp_init on the result sees a real struct,
            // not a sentinel. Subclasses created via type(name,bases,dict)
            // inherit through MRO walk — find the first ancestor with a
            // known basicsize and allocate that many bytes. Without this,
            // _decimal's SignalDict() (subclass of SignalDictMixin) ends
            // up with a sentinel handle that signaldict_init dereferences
            // as a garbage pointer.
            cls.tp_new = function(brythonCls /*, args, kw */) {
                var size = 0;
                var chain = [brythonCls];
                // Brython exposes MRO as either tp_mro (built-in classes
                // created via make_builtin_class) or __mro__ (Python-side).
                if (brythonCls.tp_mro) chain = chain.concat(brythonCls.tp_mro);
                else if (brythonCls.__mro__) chain = chain.concat(brythonCls.__mro__);
                var typeStructForInst = 0;
                for (var i = 0; i < chain.length; i++) {
                    var c = chain[i];
                    if (c && c.__wasthon_basicsize__ > 0) {
                        size = c.__wasthon_basicsize__;
                        typeStructForInst = c.__wasthon_type_handle__ || 0;
                        break;
                    }
                }
                if (size === 0) {
                    // No Wasthon ancestor — fall through to Brython default.
                    return rt._b_.object.tp_new(brythonCls);
                }
                var instancePtr = _malloc(size);
                HEAPU8.fill(0, instancePtr, instancePtr + size);
                /* Py_TYPE(inst) must be the INSTANTIATED class, not the
                 * ancestor that supplied the layout — CPython's object_new
                 * calls tp_alloc(type, 0) with the subtype. _decimal's
                 * SignalDict = type('SignalDict', (MutableMapping,
                 * SignalDictMixin), {}) is exact-type-checked
                 * (Py_IS_TYPE(v, state->PyDecSignalDict_Type)) in
                 * signaldict_richcompare; with the Mixin's handle here the
                 * assert aborted on every flags/traps comparison. For the
                 * defining class itself this is the same handle as before
                 * (its own type struct). PyObject_TypeCheck (sqlite3 Cursor
                 * clinic guards, etc.) still passes via its subtype walk. */
                var inst = {
                    __class__: brythonCls,
                    ob_type: brythonCls,
                    __wasthon_ptr__: instancePtr,
                    __wasthon_type__: brythonCls.__wasthon_type_handle__ ||
                                      rt.ensureTypeStruct(brythonCls) ||
                                      typeStructForInst || typeHandle,
                };
                rt.bindInstance(instancePtr, inst);
                return inst;
            };
            cls.tp_new.$is_slot = true;
        }
        // Record basicsize on the class so the MRO walk in subclass tp_new
        // can find it. Type creations via type(name, bases, dict) don't
        // call our PyType_FromModuleAndSpec — they go through Brython's
        // make_class, which doesn't copy __wasthon_basicsize__. That's OK:
        // we look it up via __mro__.
        cls.__wasthon_basicsize__ = basicsize;

        // CPython's object.__getstate__ (3.11+) raises TypeError ("cannot
        // pickle 'X' object") for an instance whose C struct holds opaque
        // state (tp_basicsize beyond PyObject) with no instance __dict__ —
        // that's what makes pickling zlib._ZlibDecompressor & co fail. Our
        // instances fell through to Brython's default (state=None) and
        // pickled as empty shells. Install the guard when the type defines
        // no pickling protocol of its own; a Python SUBCLASS instance has an
        // instance __dict__ (we init_dict it) and stays picklable, as in
        // CPython.
        (function() {
            var tf = cls.tp_funcs || {};
            // Exception types excluded: BaseException's own reduce protocol
            // (args-based) must stay in charge — and the raise/except path
            // exercises it (the guard on LZMAError broke LZMAFile tests).
            var isExc = cls.tp_mro && cls.tp_mro.indexOf(rt._b_.BaseException) > -1;
            if (!isExc && basicsize > 0 && !tf.__reduce__ && !tf.__reduce_ex__ &&
                    !tf.__getstate__ && !tf.__getnewargs__ &&
                    !tf.__getnewargs_ex__) {
                var unpicklable = function(self) {
                    var d = null;
                    try { d = rt.$B.get_dict(self); } catch (_) {}
                    if (d) return d;
                    throw rt.$B.$call(rt._b_.TypeError,
                        "cannot pickle '" + (cls.tp_name || 'object') +
                        "' object");
                };
                try { rt.$B.set_to_dict(cls, '__getstate__', unpicklable); }
                catch (_) {}
                cls.tp_funcs = cls.tp_funcs || {};
                cls.tp_funcs.__getstate__ = unpicklable;
            }
        })();

        // Wire number/repr/hash slots to Brython __dunder__ methods so
        // class-level ops resolve to the C slot. Maps slot ID → Brython
        // method name + dispatch shape (b=binary, t=ternary, u=unary,
        // i=inquiry returning int, r=unary returning PyObject*).
        // Brython uses C-slot-named methods on the class (nb_add, tp_repr, ...)
        // but Python user code accesses via __dunder__. We install BOTH names
        // pointing to the same dispatch function so either lookup path works.
        // Format: slotID → [brythonSlotName, [dunderNames], shape]
        // (b=binary, t=ternary, r=unary->obj, i=inquiry->int).
        // wasthon.h has slot ID collisions: Py_sq_length=29 == Py_nb_multiply=29
        // and Py_sq_item=32 == Py_nb_positive=32. Whether a given pfunc at
        // slot 29/32 means sq_* or nb_* can't be told from the ID alone.
        // Disambiguate by other slots: if the type has Py_sq_ass_item (39)
        // OR Py_sq_contains (41) — both unambiguous markers — it's a
        // sequence, so 29/32 belong to sq_length/sq_item. Otherwise they're
        // nb_multiply/nb_positive. (None of our currently-ported modules
        // mix sequence and numeric protocols in the same type.)
        var isSequence = !!(slotMap[39] || slotMap[41]);
        var slotDispatch = {
            7:  ['nb_add',                    ['__add__'],           'b'],
            36: ['nb_subtract',               ['__sub__'],           'b'],
            29: ['nb_multiply',               ['__mul__'],           'b'],
            34: ['nb_remainder',              ['__mod__'],           'b'],
            10: ['nb_divmod',                 ['__divmod__'],        'b'],
            12: ['nb_floor_divide',           ['__floordiv__'],      'b'],
            37: ['nb_true_divide',            ['__truediv__'],       'b'],
            28: ['nb_lshift',                 ['__lshift__'],        'b'],
            35: ['nb_rshift',                 ['__rshift__'],        'b'],
            8:  ['nb_and',                    ['__and__'],           'b'],
            38: ['nb_xor',                    ['__xor__'],           'b'],
            31: ['nb_or',                     ['__or__'],            'b'],
            14: ['nb_inplace_add',            ['__iadd__'],          'b'],
            23: ['nb_inplace_subtract',       ['__isub__'],          'b'],
            18: ['nb_inplace_multiply',       ['__imul__'],          'b'],
            21: ['nb_inplace_remainder',      ['__imod__'],          'b'],
            16: ['nb_inplace_floor_divide',   ['__ifloordiv__'],     'b'],
            24: ['nb_inplace_true_divide',    ['__itruediv__'],      'b'],
            33: ['nb_power',                  ['__pow__'],           't'],
            30: ['nb_negative',               ['__neg__'],           'r'],
            32: ['nb_positive',               ['__pos__'],           'r'],
            6:  ['nb_absolute',               ['__abs__'],           'r'],
            25: ['mp_length',                 ['__len__'],           'i'],
            27: ['mp_subscript',              ['__getitem__'],       'b'],
            11: ['nb_float',                  ['__float__'],         'r'],
            26: ['nb_int',                    ['__int__'],           'r'],
            13: ['nb_index',                  ['__index__'],         'r'],
            /* tp_str / tp_repr / tp_hash — use OUR header's slot IDs
             * (wasthon.h), which differ from CPython canonical values. */
            51: ['tp_repr',                   ['__repr__'],          'r'],
            50: ['tp_str',                    ['__str__'],           'r'],
            58: ['tp_hash',                   ['__hash__'],          'i'],
            9:  ['nb_bool',                   ['__bool__'],          'i'],
            /* Iterator protocol — tp_iter returns iterator, tp_iternext
             * advances. NULL return from tp_iternext == StopIteration. */
            62: ['tp_iter',                   ['__iter__'],          'r'],
            63: ['tp_iternext',               ['__next__'],          'n'],
            /* richcompare: single C slot, 6 Python dunders. The 'c' shape
             * is handled specially below — one slotPtr → 6 dispatch funcs
             * each calling slot(self, other, op) with a different op. */
            60: ['tp_richcompare',            null,                  'c'],
            /* Sequence protocol slot IDs (wasthon.h numbering — same as
             * CPython's for 39/40/41/42/43/46, but NOT for sq_length / sq_item
             * which collide with nb_multiply/nb_positive at 29/32. Those are
             * patched in below when isSequence is true). */
            39: ['sq_ass_item',               ['__setitem__', '__delitem__'], 'sis'],
            40: ['sq_concat',                 ['__add__'],           'b'],
            41: ['sq_contains',               ['__contains__'],      'bi'],
            46: ['sq_repeat',                 ['__mul__','__rmul__'], 'si'],
            42: ['sq_inplace_concat',         ['__iadd__'],          'b'],
            43: ['sq_inplace_repeat',         ['__imul__'],          'si'],
        };
        // Patch the colliding entries for sequence types. wasthon.h reuses
        // these slot IDs for both numeric and sequence operations:
        //   29: Py_nb_multiply == Py_sq_length
        //   32: Py_nb_positive == Py_sq_item
        // Disambiguate via the unambiguous Py_sq_ass_item=39 / Py_sq_contains=41
        // markers; if either is present, treat 29/32 as sq_* not nb_*.
        if (isSequence) {
            slotDispatch[29] = ['sq_length',    ['__len__'],     'i'];
            slotDispatch[32] = ['sq_item',      ['__getitem__'], 'si'];
        }
        // wasthon.h reuses id 26 for BOTH Py_nb_int and Py_mp_ass_subscript.
        // A type with mp_subscript (27) is a mapping/sequence, so its slot-26
        // is the slice-capable assignment slot (array_ass_subscr), not __int__.
        // Without this, `a[i:j] = x` / `del a[i:j]` dispatch through the
        // int-only sq_ass_item and raise "array indices must be integers".
        if (slotMap[27 /* mp_subscript */]) {
            slotDispatch[26] = ['mp_ass_subscript', ['__setitem__', '__delitem__'], 'mas'];
        }
        Object.keys(slotDispatch).forEach(function(sidStr) {
            var sid = sidStr | 0;
            var slotPtr = slotMap[sid];
            if (!slotPtr) return;
            var info = slotDispatch[sid];
            var brythonName = info[0], dunders = info[1], shape = info[2];
            var dispatch;
            if (shape === 'b') {
                dispatch = function(self, other) {
                    var selfH  = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    var otherH = other && other.__wasthon_ptr__ ? other.__wasthon_ptr__ : rt.wrap(other);
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(slotPtr)(selfH, otherH);
                    if (resH === 0 || rt.pendingException) {
                        if (rt.pendingException) {
                            var pe = rt.pendingException; rt.pendingException = null;
                            throw rt.pendingExc(pe);
                        }
                        return rt._b_.NotImplemented;
                    }
                    return rt.unwrapResult(resH);
                };
            } else if (shape === 'bi') {
                /* binary returning int (0/1, -1 on error) — used by
                 * sq_contains. Returning the int as a handle and
                 * unwrap()-ing it (the 'b' shape's behaviour) produces
                 * junk: `99 in arr` would come back truthy because the
                 * raw `0` got the resH-is-0 → NotImplemented branch and
                 * Brython treated NotImplemented as truthy. */
                dispatch = function(self, other) {
                    var selfH  = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    var otherH = other && other.__wasthon_ptr__ ? other.__wasthon_ptr__ : rt.wrap(other);
                    rt.pendingException = null;
                    var rc = getWasmTableEntry(slotPtr)(selfH, otherH);
                    if (rc < 0 && rt.pendingException) {
                        var pe = rt.pendingException; rt.pendingException = null;
                        throw rt.pendingExc(pe);
                    }
                    return rc ? true : false;
                };
            } else if (shape === 't') {
                dispatch = function(self, other, modulo) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    var otherH = other && other.__wasthon_ptr__ ? other.__wasthon_ptr__ : rt.wrap(other);
                    var modH = (modulo === undefined || modulo === rt._b_.None) ?
                               rt.SLOT_NONE :
                               (modulo && modulo.__wasthon_ptr__ ? modulo.__wasthon_ptr__ : rt.wrap(modulo));
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(slotPtr)(selfH, otherH, modH);
                    if (resH === 0 || rt.pendingException) {
                        if (rt.pendingException) {
                            var pe = rt.pendingException; rt.pendingException = null;
                            throw rt.pendingExc(pe);
                        }
                        return rt._b_.NotImplemented;
                    }
                    return rt.unwrapResult(resH);
                };
            } else if (shape === 'r') {
                var isStringy = (brythonName === 'tp_str' || brythonName === 'tp_repr');
                dispatch = function(self) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(slotPtr)(selfH);
                    if (resH === 0 || rt.pendingException) {
                        if (rt.pendingException) {
                            var pe = rt.pendingException; rt.pendingException = null;
                            throw rt.pendingExc(pe);
                        }
                        return rt._b_.None;
                    }
                    var obj = rt.unwrapResult(resH);
                    if (isStringy) {
                        // C side returns a PyUnicode_New placeholder; materialize.
                        var s = rt.asJSStr(obj);
                        if (s !== null) return s;
                    }
                    return obj;
                };
            } else if (shape === 'i') {
                dispatch = function(self) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    rt.pendingException = null;
                    var rc = getWasmTableEntry(slotPtr)(selfH);
                    if (rc < 0 && rt.pendingException) {
                        var pe = rt.pendingException; rt.pendingException = null;
                        throw rt.pendingExc(pe);
                    }
                    /* Length-style slots (sq_length, mp_length) return the
                     * count directly; tp_hash and nb_bool return rc to be
                     * coerced. We can't distinguish here; if rc looks like
                     * a count (any value not -1), return it directly. */
                    if (brythonName === 'sq_length' || brythonName === 'mp_length' ||
                        brythonName === 'tp_hash') return rc | 0;
                    return rc ? true : false;
                };
            } else if (shape === 'si') {
                /* sq_item / sq_repeat: takes self + ssize_t. Returns PyObject*.
                 * Brython will call this as `instance[i]` or `instance * n`.
                 * Reject non-numeric arguments — naive `Number("bad")` is NaN
                 * which becomes 0 after `|0`, silently succeeding when
                 * `a * "bad"` should raise TypeError. CPython's sq_repeat
                 * raises TypeError on non-int via `PyNumber_AsSsize_t`. */
                dispatch = function(self, idx) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    var i;
                    if (typeof idx === 'number') i = idx | 0;
                    else if (typeof idx === 'bigint') i = Number(idx) | 0;
                    else if (typeof idx === 'boolean') i = idx ? 1 : 0;
                    else if (typeof idx === 'string') {
                        // CPython rejects "5" — caller must pass an int.
                        throw rt.$B.$call(rt._b_.TypeError,
                            "can't multiply sequence by non-int of type 'str'");
                    } else {
                        // Try __index__ on objects (PyIndex_Check path).
                        var idxFn = idx && (idx.__index__ ||
                            (idx.ob_type && idx.ob_type.tp_funcs &&
                             idx.ob_type.tp_funcs.__index__));
                        if (typeof idxFn === 'function') {
                            try { i = Number(idxFn(idx)) | 0; }
                            catch (e) { throw e; }
                        } else {
                            var n = Number(idx);
                            if (isNaN(n)) {
                                throw rt.$B.$call(rt._b_.TypeError,
                                    "an integer is required (got type " +
                                    (idx && idx.ob_type && idx.ob_type.tp_name ?
                                        idx.ob_type.tp_name : typeof idx) + ")");
                            }
                            i = n | 0;
                        }
                    }
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(slotPtr)(selfH, i);
                    if (rt.pendingException) {
                        var pe = rt.pendingException; rt.pendingException = null;
                        throw rt.pendingExc(pe);
                    }
                    if (resH === 0) {
                        throw rt.$B.$call(rt._b_.IndexError, "index out of range");
                    }
                    return rt.unwrapResult(resH);
                };
            } else if (shape === 'sis') {
                /* sq_ass_item: self + ssize_t + value. Returns int rc.
                 * value === $B.NULL signals "delete this item" in the
                 * Brython-dispatch convention (Brython's $delitem walks
                 * through sq_ass_item with $B.NULL). Pass 0/NULL through
                 * to C, where the slot impl detects NULL and routes to
                 * the delete-item path.
                 *
                 * CPython's PyObject_SetItem fixes negative indices before
                 * calling sq_ass_item (the slot itself expects 0 ≤ i < len).
                 * `array_ass_item` raises `array assignment index out of
                 * range` for any negative i — so `a[-1] = x` always fails.
                 * Normalise here using the type's sq_length slot. */
                dispatch = function(self, idx, value) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    // Strict-type check (same as sq_repeat path above):
                    // `a["str"] = X` must raise TypeError, not silently
                    // coerce to 0. CPython's sq_ass_item path goes through
                    // PyNumber_AsSsize_t which rejects non-int.
                    var i;
                    if (typeof idx === 'number') i = idx | 0;
                    else if (typeof idx === 'bigint') i = Number(idx) | 0;
                    else if (typeof idx === 'boolean') i = idx ? 1 : 0;
                    else {
                        var idxFn = idx && (idx.__index__ ||
                            (idx.ob_type && idx.ob_type.tp_funcs &&
                             idx.ob_type.tp_funcs.__index__));
                        if (typeof idxFn === 'function') {
                            i = Number(idxFn(idx)) | 0;
                        } else {
                            throw rt.$B.$call(rt._b_.TypeError,
                                "array indices must be integers");
                        }
                    }
                    if (i < 0) {
                        var clsObj = self && self.ob_type;
                        var sqLen = clsObj && clsObj.sq_length;
                        if (typeof sqLen === 'function') {
                            try {
                                var len = sqLen(self) | 0;
                                if (len > 0) i += len;
                            } catch (_) {}
                        }
                    }
                    var valH = (value === undefined || value === null || value === rt.$B.NULL) ? 0 :
                               (value && value.__wasthon_ptr__ ? value.__wasthon_ptr__ : rt.wrap(value));
                    rt.pendingException = null;
                    var rc = getWasmTableEntry(slotPtr)(selfH, i, valH);
                    if (rt.pendingException) {
                        var pe = rt.pendingException; rt.pendingException = null;
                        throw rt.pendingExc(pe);
                    }
                    return rc;
                };
            } else if (shape === 'mas') {
                /* mp_ass_subscript: self + item (PyObject) + value → int rc.
                 * Unlike sq_ass_item ('sis'), the item is passed as a real
                 * PyObject — so a slice reaches array_ass_subscr's
                 * PySlice_Check instead of being rejected as a non-integer
                 * index. value === undefined / null / $B.NULL means delete
                 * (Brython's __delitem__ path), passed through as NULL so the
                 * C slot routes to its delete branch. Mirror of mp_subscript
                 * ('b') for the assignment side. */
                dispatch = function(self, item, value) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    var itemH = item && item.__wasthon_ptr__ ? item.__wasthon_ptr__ : rt.wrap(item);
                    var valH = (value === undefined || value === null || value === rt.$B.NULL) ? 0 :
                               (value && value.__wasthon_ptr__ ? value.__wasthon_ptr__ : rt.wrap(value));
                    rt.pendingException = null;
                    var rc = getWasmTableEntry(slotPtr)(selfH, itemH, valH);
                    if (rt.pendingException) {
                        var pe = rt.pendingException; rt.pendingException = null;
                        throw rt.pendingExc(pe);
                    }
                    return rc;
                };
            } else if (shape === 'n') {
                // tp_iternext: returns next value, or NULL (no exception)
                // for StopIteration. Translate NULL → StopIteration throw
                // so Brython's iterator protocol sees it.
                dispatch = function(self) {
                    var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(slotPtr)(selfH);
                    if (rt.pendingException) {
                        var pe = rt.pendingException; rt.pendingException = null;
                        throw rt.pendingExc(pe);
                    }
                    if (resH === 0) throw rt.$B.$call(rt._b_.StopIteration);
                    return rt.unwrapResult(resH);
                };
            } else if (shape === 'c') {
                // richcompare: install 6 dunder methods sharing one C slot.
                var compares = [
                    ['__lt__', 0], ['__le__', 1], ['__eq__', 2],
                    ['__ne__', 3], ['__gt__', 4], ['__ge__', 5],
                ];
                var makeCmp = function(op) {
                    return function(self, other) {
                        var selfH  = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                        var otherH = other && other.__wasthon_ptr__ ? other.__wasthon_ptr__ : rt.wrap(other);
                        rt.pendingException = null;
                        var resH = getWasmTableEntry(slotPtr)(selfH, otherH, op);
                        if (resH === 0 || rt.pendingException) {
                            if (rt.pendingException) {
                                var pe = rt.pendingException; rt.pendingException = null;
                                throw rt.pendingExc(pe);
                            }
                            return rt._b_.NotImplemented;
                        }
                        return rt.unwrapResult(resH);
                    };
                };
                cls.tp_funcs = cls.tp_funcs || {};
                for (var ci = 0; ci < compares.length; ci++) {
                    var name = compares[ci][0], op = compares[ci][1];
                    var fn = rt.scoped(makeCmp(op));
                    cls[name] = fn;
                    cls.tp_funcs[name] = fn;
                    try { rt.$B.set_to_dict(cls, name, fn); } catch (_) {}
                }
                return;  // skip the generic install below
            }
            dispatch = rt.scoped(dispatch);
            cls[brythonName] = dispatch;
            cls.tp_funcs = cls.tp_funcs || {};
            cls.tp_funcs[brythonName] = dispatch;
            for (var di = 0; di < dunders.length; di++) {
                cls[dunders[di]] = dispatch;
                cls.tp_funcs[dunders[di]] = dispatch;
                // Also install in the class's __dict__ so search_in_mro
                // (which Brython's rich_op1 uses via $getattr) finds it.
                try { rt.$B.set_to_dict(cls, dunders[di], dispatch); }
                catch (_) {}
            }

            // Reflected dunders for the numeric binary slots. CPython has ONE
            // slot per op, tried for both operands with the arguments in the
            // ORIGINAL order — the slot impl (e.g. dec_add) converts whichever
            // side isn't its own type. Brython instead looks up __radd__ & co
            // on the right operand, so without these `5 + Decimal(2)` raised
            // "unsupported operand type(s) for +: 'int' and 'Decimal'".
            // __rOP__(self, other) == slot(other, self) — original order.
            var reflectedOf = {
                '__add__': '__radd__',       '__sub__': '__rsub__',
                '__mul__': '__rmul__',       '__mod__': '__rmod__',
                '__divmod__': '__rdivmod__', '__floordiv__': '__rfloordiv__',
                '__truediv__': '__rtruediv__', '__lshift__': '__rlshift__',
                '__rshift__': '__rrshift__', '__and__': '__rand__',
                '__xor__': '__rxor__',       '__or__': '__ror__',
                '__pow__': '__rpow__',
            };
            if (brythonName.indexOf('nb_') === 0 &&
                    brythonName.indexOf('inplace') < 0 &&
                    (shape === 'b' || shape === 't')) {
                var refl = reflectedOf[dunders[0]];
                if (refl) {
                    var rdispatch = (shape === 't')
                        ? function(self, other, modulo) {
                              return dispatch(other, self, modulo);
                          }
                        : function(self, other) {
                              return dispatch(other, self);
                          };
                    cls[refl] = rdispatch;
                    cls.tp_funcs[refl] = rdispatch;
                    try { rt.$B.set_to_dict(cls, refl, rdispatch); }
                    catch (_) {}
                }
            }
        });

        // Wire __getitem__ from mp_subscript whenever it's defined. Mirrors
        // CPython's PyObject_GetItem precedence: mp_subscript first
        // (accepts slice + arbitrary key), sq_item as fallback (int-only).
        if (cls.mp_subscript) {
            cls.__getitem__ = cls.mp_subscript;
            cls.tp_funcs = cls.tp_funcs || {};
            cls.tp_funcs.__getitem__ = cls.mp_subscript;
            try { rt.$B.set_to_dict(cls, '__getitem__', cls.mp_subscript); }
            catch (_) {}
        }

        // Symmetric to the above: wire __setitem__/__delitem__ from
        // mp_ass_subscript (slice-capable) over sq_ass_item (int-only), so
        // `a[i:j] = x` and `del a[i:j]` reach the C ass-subscript slot. The
        // forEach loop processes id 26 before id 39, so sq_ass_item would
        // otherwise win — re-assert mp_ass_subscript here.
        if (cls.mp_ass_subscript) {
            cls.__setitem__ = cls.mp_ass_subscript;
            cls.__delitem__ = cls.mp_ass_subscript;
            cls.tp_funcs = cls.tp_funcs || {};
            cls.tp_funcs.__setitem__ = cls.mp_ass_subscript;
            cls.tp_funcs.__delitem__ = cls.mp_ass_subscript;
            try { rt.$B.set_to_dict(cls, '__setitem__', cls.mp_ass_subscript); } catch (_) {}
            try { rt.$B.set_to_dict(cls, '__delitem__', cls.mp_ass_subscript); } catch (_) {}
        }

        // Wire Py_tp_init (slot id 61) if the type defines one. The C
        // init slot has signature `int (*)(PyObject *self, PyObject *args,
        // PyObject *kw)` and returns 0 on success, -1 on error. Some
        // modules (_struct: Struct) put state initialization in tp_init,
        // not tp_new, so skipping it leaves the instance unusable.
        //
        // If the type does NOT define tp_init, we alias to object's default
        // so Brython's type.tp_call (which checks `init_func !== _b_.object.tp_init`)
        // skips the init step.
        var tpInitPtr = slotMap[61 /* Py_tp_init */];
        if (tpInitPtr) {
            cls.tp_init = rt.scoped(function(self) {
                // Brython call sig: tp_init(self, ...args, kwarg)
                // CPython sig:      tp_init(self, args_tuple, kwargs_dict)
                var jsArgs = Array.from(arguments).slice(1);
                // Brython 3.14 packs keywords as a trailing {$kw:[...]}
                // object — Array of: a plain-JS map at index 0 (explicit
                // name=value pairs) then real Brython dicts at 1+ (each
                // `**d` expansion). The bridge's outbound convention
                // (PyObject_VectorcallDict) is {$nat:'kw',$kw:obj}. Detect
                // either shape and flatten via rt.flattenKwArray, which
                // handles BOTH plain-JS-obj and Brython-dict element types
                // — the previous inline version only iterated plain own
                // properties, so `Context(**d)` silently lost every key.
                var kwPairs = null;
                if (jsArgs.length > 0) {
                    var last = jsArgs[jsArgs.length - 1];
                    if (last && (last.$kw !== undefined || last.$nat === 'kw')) {
                        var src = last.$kw !== undefined ? last.$kw : last;
                        kwPairs = rt.flattenKwArray(src);
                        jsArgs.pop();
                    }
                }
                var selfH = self && self.__wasthon_ptr__ ? self.__wasthon_ptr__ : rt.wrap(self);
                var argsH = rt.wrap(jsArgs);
                // Build a real Brython dict (same primitives PyDict_SetItem
                // uses) so PyArg_ParseTupleAndKeywords' dict.get / $getitem
                // lookups land in real hash storage.
                var kwH = 0;
                if (kwPairs && kwPairs.length > 0) {
                    var kwDict = rt.$B.empty_dict();
                    for (var ki = 0; ki < kwPairs.length; ki++) {
                        rt._b_.dict.$setitem(kwDict, kwPairs[ki][0], kwPairs[ki][1]);
                    }
                    kwH = rt.wrap(kwDict);
                }
                rt.pendingException = null;
                var rc = getWasmTableEntry(tpInitPtr)(selfH, argsH, kwH);
                if (rc !== 0 || rt.pendingException) {
                    var pe = rt.pendingException;
                    rt.pendingException = null;
                    if (pe) throw rt.pendingExc(pe, rt.unwrap(pe.exc) || rt._b_.Exception);
                    throw rt.$B.$call(rt._b_.Exception, "tp_init failed");
                }
            });
            // Expose the C tp_init as the __init__ attribute, so an explicit
            // `inst.__init__(args)` (Struct reinit `s.__init__('>hh')`) and a
            // subclass's `super().__init__(args)` dispatch to it instead of
            // falling through to object.__init__, which rejects the extra args
            // ("object.__init__() takes exactly one argument"). Mirrors Brython's
            // wrap('__init__') in finalize_builtin_types.
            rt.$B.set_to_dict(cls, '__init__', rt.$B.wrapper_descriptor.$factory(
                cls, '__init__', cls.tp_init));
        } else if (tpNewPtr) {
            // tp_new fully initialised; alias to object so Brython skips init.
            cls.tp_init = rt._b_.object.tp_init;
        }

        // Wire Py_tp_call (slot 77, wasthon.h numbering) as cls.tp_call so
        // Brython's $call() treats instances as callable. CPython sig:
        //   PyObject *tp_call(PyObject *self, PyObject *args, PyObject *kw)
        // Brython invokes it as call_method(self, ...args[, $kw]).
        // sqlite3 relies on this: statement_cache = lru_cache(n)(connection)
        // then cache(sql) calls connection(sql) -> pysqlite_connection_call.
        var tpCallPtr = slotMap[77 /* Py_tp_call */];
        if (tpCallPtr) {
            var _tpCallWrap;
            cls.tp_call = _tpCallWrap = rt.scoped(function(self) {
                var jsArgs = Array.from(arguments).slice(1);
                var kw = null;
                // Brython's kw marker is any trailing {$kw: ...} payload; the
                // $nat tag is not always present (a bare call through $B.$call
                // appends {$kw:[{}]}). Counted as positional, it made
                // connection(sql) arrive as 2 args — latent while the arg
                // parser ignored extras, fatal once it validates the count.
                if (jsArgs.length > 0 && jsArgs[jsArgs.length - 1] &&
                        jsArgs[jsArgs.length - 1].$kw !== undefined) {
                    kw = jsArgs.pop();
                }
                var selfH = self && self.__wasthon_ptr__
                    ? self.__wasthon_ptr__ : rt.wrap(self);
                var argsH = rt.wrap(jsArgs);
                // Flatten the marker to a real dict; an empty payload (the
                // common bare-call case) must arrive as NULL — C callables
                // like connection_call reject any non-NULL kwargs.
                var kwH = 0;
                if (kw) {
                    var kwPairs = rt.flattenKwArray(kw.$kw);
                    if (kwPairs.length > 0) {
                        var kwDict = rt.$B.empty_dict();
                        for (var ki = 0; ki < kwPairs.length; ki++) {
                            rt._b_.dict.$setitem(kwDict, kwPairs[ki][0], kwPairs[ki][1]);
                        }
                        kwH = rt.wrap(kwDict);
                    }
                }
                rt.pendingException = null;
                var resH = getWasmTableEntry(tpCallPtr)(selfH, argsH, kwH);
                if (resH === 0 || rt.pendingException) {
                    var pe = rt.pendingException;
                    rt.pendingException = null;
                    if (pe) {
                        var exc = rt.unwrap(pe.exc) || rt._b_.Exception;
                        throw rt.pendingExc(pe, exc);
                    }
                    throw rt.$B.$call(rt._b_.RuntimeError,
                        "tp_call returned NULL");
                }
                return rt.unwrapResult(resH);
            });
            // Also expose as __call__ so Brython's `callable(obj)` builtin
            // (and `obj(...)` syntax via $call) finds it. Without this,
            // tp_call is wired at the C level but callable() returns False
            // and _json.make_encoder's encoder, _decimal Context, etc.
            // aren't seen as callable from Python.
            cls.__call__ = _tpCallWrap;
            cls.tp_funcs = cls.tp_funcs || {};
            cls.tp_funcs.__call__ = _tpCallWrap;
            try { rt.$B.set_to_dict(cls, '__call__', _tpCallWrap); } catch (_) {}
        }

        // Wire Py_tp_getattro (slot 57 per wasthon.h numbering) using a
        // try-default-then-fallback strategy. The C-side custom getattr
        // (e.g. _decimal Context's context_getattr) intercepts specific
        // names like `traps`/`flags` that live on the C struct (not in
        // any Brython dict / MRO). Hooking $getattribute directly (the
        // morning attempt) caused recursion: C falls through to
        // PyObject_GenericGetAttr → $B.$getattr → cls.$getattribute → us
        // again. Instead: first run the default object.tp_getattro
        // (handles all normal attrs without entering our wrapper); on
        // AttributeError, call the C function for the custom intercepts.
        // Re-entry guard for the case where C also falls through and the
        // bridge GenericGetAttr re-invokes us on the same name.
        var tpGetattroPtr = slotMap[57 /* Py_tp_getattro */];
        if (tpGetattroPtr) {
            var _objGetattr = rt._b_.object.tp_getattro;
            cls.tp_getattro = cls.$getattribute = rt.scoped(function(self, name) {
                // Re-entry guard: when C falls through to PyObject_GenericGetAttr
                // → $B.$getattr → us again, break out to the default tp_getattro
                // so normal descriptor lookup terminates the cycle.
                if (self && self.__wasthon_in_getattro__ === name) {
                    return _objGetattr(self, name);
                }
                // C-first: invoke the C-side custom getattr. For its
                // hard-coded interceptions (e.g. _decimal Context's
                // `traps`/`flags`) it returns a real PyObject* directly.
                // For everything else it falls through to
                // PyObject_GenericGetAttr, which (with the re-entry guard)
                // ends up in the default _objGetattr above.
                if (self) self.__wasthon_in_getattro__ = name;
                try {
                    var selfH = self && self.__wasthon_ptr__
                        ? self.__wasthon_ptr__ : rt.wrap(self);
                    var nameH = rt.wrap(name);
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(tpGetattroPtr)(selfH, nameH);
                    if (resH !== 0 && !rt.pendingException) {
                        return rt.unwrapResult(resH);
                    }
                    var pe = rt.pendingException;
                    rt.pendingException = null;
                    if (pe) {
                        var exc = rt.unwrap(pe.exc) || rt._b_.AttributeError;
                        throw rt.pendingExc(pe, exc);
                    }
                    // C returned NULL without setting an exception — final
                    // miss. Surface a clean AttributeError.
                    throw rt.$B.$call(rt._b_.AttributeError,
                        "'" + (cls.tp_name || 'object') + "' object has no attribute '" + name + "'");
                } finally {
                    if (self) delete self.__wasthon_in_getattro__;
                }
            });
        }

        // Install dealloc hook so that when Brython GCs an instance we
        // free the WASM-side struct. We attach a finalizer registry to
        // each instance at GC_New time; see __wasthon_object_gc_new.

        return typeHandle;
    },

    /* ---- PyModule_AddType: sets module.<short_name> = type ----         */
    PyModule_AddType__deps: ['$WasthonRT'],
    PyModule_AddType: function(moduleHandle, typeHandle) {
        var rt = WasthonRT;
        rt.trace('PyModule_AddType', 'typeHandle=' + typeHandle);
        var modObj = rt.unwrap(moduleHandle);
        var typeInfo = rt.types.get(typeHandle);
        if (!modObj) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyModule_AddType: module handle " + moduleHandle + " did not resolve");
            return -1;
        }
        if (!typeInfo) {
            /* Fallback: handle points to a built-in type struct registered
             * via wasthon_bind_builtin_type (in rt.handles but not rt.types).
             * Unwrap, use the Brython class's __name__ as attribute. */
            var cls = rt.handles.get(typeHandle);
            if (cls) {
                var nm = (cls.$infos && cls.$infos.__name__) || cls.tp_name || '<type>';
                try {
                    rt.$B.module_setattr(modObj, nm, cls);
                    return 0;
                } catch (e) {
                    rt.setError(rt.wrap(rt._b_.SystemError),
                        "PyModule_AddType: setattr failed for builtin: " + (e.message || e));
                    return -1;
                }
            }
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyModule_AddType: type handle " + typeHandle + " not in types map");
            return -1;
        }
        try {
            rt.$B.module_setattr(modObj, typeInfo.shortName, typeInfo.brythonClass);
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyModule_AddType: module_setattr threw: " + (e.message || e));
            return -1;
        }
        var modEntry = rt.modules.get(moduleHandle);
        if (modEntry) modEntry.types.push(typeHandle);
        return 0;
    },

    PyModule_AddIntConstant__deps: ['$WasthonRT'],
    PyModule_AddIntConstant: function(moduleHandle, namePtr, value) {
        var rt = WasthonRT;
        var modObj = rt.unwrap(moduleHandle);
        if (!modObj || namePtr === 0) return -1;
        rt.$B.module_setattr(modObj, UTF8ToString(namePtr), value | 0);
        return 0;
    },

    PyModule_AddStringConstant__deps: ['$WasthonRT'],
    PyModule_AddStringConstant: function(moduleHandle, namePtr, valuePtr) {
        var rt = WasthonRT;
        var modObj = rt.unwrap(moduleHandle);
        if (!modObj || namePtr === 0) return -1;
        var s = valuePtr === 0 ? "" : UTF8ToString(valuePtr);
        rt.$B.module_setattr(modObj, UTF8ToString(namePtr), s);
        return 0;
    },

    PyModule_Add__deps: ['$WasthonRT'],
    PyModule_Add: function(moduleHandle, namePtr, valueHandle) {
        var rt = WasthonRT;
        var modObj = rt.unwrap(moduleHandle);
        if (!modObj || namePtr === 0) { rt.consumeResultRef(valueHandle); return -1; }
        rt.$B.module_setattr(modObj, UTF8ToString(namePtr), rt.unwrap(valueHandle));
        // Steals the value reference, even on failure (CPython contract).
        // Instance-exempt: unicodedata's `ucd_3_2_0` (a C UCD instance) is
        // PyModule_Add'ed at exec — a raw decref would tp_dealloc it live.
        rt.consumeResultRef(valueHandle);
        return 0;
    },

    /* PyModule_AddObjectRef — CPython spec: does NOT steal the value
     * reference. Caller passes a "new ref" (refcount=1) and is expected
     * to Py_DECREF after this call returns. We must INCREF the value so
     * the module attribute survives the caller's release. */
    PyModule_AddObjectRef__deps: ['$WasthonRT'],
    PyModule_AddObjectRef: function(moduleHandle, namePtr, valueHandle) {
        var rt = WasthonRT;
        var modObj = rt.unwrap(moduleHandle);
        if (!modObj || namePtr === 0) return -1;
        var name = UTF8ToString(namePtr);
        rt.trace('PyModule_AddObjectRef', name);
        try {
            rt.$B.module_setattr(modObj, name, rt.unwrap(valueHandle));
            rt.incref(valueHandle);
            return 0;
        } catch (e) {
            rt.setError(rt.wrap(rt._b_.RuntimeError),
                "PyModule_AddObjectRef: '" + name + "' failed: " + (e.message || String(e)));
            return -1;
        }
    },

    /* PyModuleDef_Init: registers the PyModuleDef* in the runtime and
     * returns the same pointer cast to a PyObject* handle. Called by
     * a module's PyInit_<name>() at the start of multi-phase init. */
    PyModuleDef_Init__deps: ['$WasthonRT'],
    PyModuleDef_Init: function(defPtr) {
        var rt = WasthonRT;
        if (rt.moduleDefs.has(defPtr)) return defPtr;  // idempotent
        var namePtr = HEAP32[(defPtr +  4) >> 2];
        var docPtr  = HEAP32[(defPtr +  8) >> 2];
        var size    = HEAP32[(defPtr + 12) >> 2];
        var methods = HEAP32[(defPtr + 16) >> 2];
        var slots   = HEAP32[(defPtr + 20) >> 2];
        rt.moduleDefs.set(defPtr, {
            defPtr: defPtr,
            name:    namePtr ? UTF8ToString(namePtr) : "",
            doc:     docPtr  ? UTF8ToString(docPtr)  : "",
            size:    size,
            methods: methods,
            slots:   slots,
        });
        return defPtr;
    },

    /* ---- wasthon_incref / wasthon_decref: refcount on wasthon-allocated *
     * instances. Sentinels and any handle not in the refcounts Map are    *
     * silent no-ops — discrimination by Map membership keeps the path     *
     * safe regardless of the handle's numeric value.                      *
     *                                                                     *
     * The Map is empty unless wasthon_object_gc_new has populated it for  *
     * a given pointer (Phase 3 work). With the Map empty (Phase 2 state), *
     * both functions are silent no-ops and the harness sees no behaviour  *
     * change from the macros being wired up.                              */
    wasthon_incref__deps: ['$WasthonRT'],
    wasthon_incref: function(handle) { WasthonRT.incref(handle); },

    wasthon_decref__deps: ['$WasthonRT'],
    wasthon_decref: function(handle) { WasthonRT.decref(handle); },

    /* ---- wasthon_object_gc_new: allocate a new C-side instance.         *
     * Called from C through the PyObject_GC_New(type, typeobj) macro      *
     * defined in wasthon.h (which expands to wasthon_object_gc_new(typeobj)). *
     * The size comes from the type's basicsize. The result handle == ptr  *
     * (so C can dereference its own struct fields) and is bound to a      *
     * Brython instance side-by-side in the runtime handle table.          */
    wasthon_object_gc_new__deps: ['$WasthonRT'],
    wasthon_object_gc_new: function(typeHandle) {
        var rt = WasthonRT;
        var typeInfo = rt.types.get(typeHandle);
        if (!typeInfo) {
            rt.setError(rt.wrap(rt._b_.SystemError),
                "PyObject_GC_New: unknown type");
            return 0;
        }
        var size = typeInfo.basicsize;
        var ptr = _malloc(size);
        if (ptr === 0) {
            rt.setError(rt.wrap(rt._b_.MemoryError), "PyObject_GC_New");
            return 0;
        }
        HEAPU8.fill(0, ptr, ptr + size);
        var instance = {
            ob_type: typeInfo.brythonClass,
            __class__: typeInfo.brythonClass,
            __wasthon_ptr__: ptr,
            __wasthon_type__: typeHandle,
        };
        rt.bindInstance(ptr, instance);
        rt.refcounts.set(ptr, 1);  // CPython convention: fresh object starts at 1
        return ptr;
    },

    wasthon_object_gc_new_var__deps: ['$WasthonRT'],
    wasthon_object_gc_new_var: function(typeHandle, n) {
        var rt = WasthonRT;
        var typeInfo = rt.types.get(typeHandle);
        if (!typeInfo) return 0;
        var size = typeInfo.basicsize + n * typeInfo.itemsize;
        var ptr = _malloc(size);
        if (ptr === 0) {
            rt.setError(rt.wrap(rt._b_.MemoryError), "PyObject_GC_NewVar");
            return 0;
        }
        HEAPU8.fill(0, ptr, ptr + size);
        // CPython's PyObject_GC_NewVar sets ob_size = nitems; mirror it so
        // Py_SIZE() reports the item count (_wasthon_Py_SIZE / _SET_SIZE keep
        // ob_size at offset 0). Without this, var-objects whose logic gates on
        // Py_SIZE see 0 — e.g. _sre's TemplateObject made every group-ref
        // re.sub() template look empty (Py_SIZE 0 → treated as a bare literal).
        HEAP32[ptr >> 2] = n | 0;
        var instance = {
            ob_type: typeInfo.brythonClass,
            __class__: typeInfo.brythonClass,
            __wasthon_ptr__: ptr,
            __wasthon_type__: typeHandle,
        };
        rt.bindInstance(ptr, instance);
        rt.refcounts.set(ptr, 1);  // CPython convention: fresh object starts at 1
        return ptr;
    },

    PyObject_GC_Del__deps: ['$WasthonRT'],
    PyObject_GC_Del: function(ptr) {
        if (ptr === 0) return;
        var rt = WasthonRT;
        rt.handles.delete(ptr);
        rt.refcounts.delete(ptr);
        _free(ptr);
    },

    /* ---- $WasthonInstall: install C methods onto a JS object as Python  *
     *      methods that, when called from Brython, marshal arguments and  *
     *      invoke the corresponding C function via dynCall.              */
    /* Install PyGetSetDef entries as Brython properties on the class.
     * Each entry is 20 bytes: name(4) + get(4) + set(4) + doc(4) + closure(4).
     * For each entry with a getter, we register a property on the class
     * whose __get__ calls the C function with (self_handle, closure_ptr). */
    $__wasthon_install_getsets__deps: ['$WasthonRT'],
    $__wasthon_install_getsets: function(cls, getsetPtr) {
        if (!getsetPtr) return;
        var rt = WasthonRT;
        for (var gp = getsetPtr; ; gp += 20) {
            var namePtr   = HEAP32[ gp        >> 2];
            if (namePtr === 0) break;
            var getPtr    = HEAP32[(gp +  4)  >> 2];
            var setPtr    = HEAP32[(gp +  8)  >> 2];
            var closurePtr = HEAP32[(gp + 16) >> 2];
            var name      = UTF8ToString(namePtr);

            var capGet = getPtr, capSet = setPtr, capClosure = closurePtr;

            var fget = capGet ? (function(getP, closP) {
                return rt.scoped(function(self) {
                    var selfH = (self && self.__wasthon_ptr__) ? self.__wasthon_ptr__ : rt.wrap(self);
                    rt.pendingException = null;
                    var resH = getWasmTableEntry(getP)(selfH, closP);
                    if (rt.pendingException) {
                        var pe = rt.pendingException;
                        rt.pendingException = null;
                        var exc = rt.unwrap(pe.exc) || rt._b_.Exception;
                        throw rt.pendingExc(pe, exc);
                    }
                    return rt.unwrapResult(resH);
                });
            })(capGet, capClosure) : rt._b_.None;

            var fset = capSet ? (function(setP, closP) {
                return rt.scoped(function(self, value) {
                    var selfH = (self && self.__wasthon_ptr__) ? self.__wasthon_ptr__ : rt.wrap(self);
                    var valH = rt.wrap(value);
                    rt.pendingException = null;
                    var rc = getWasmTableEntry(setP)(selfH, valH, closP);
                    if (rt.pendingException) {
                        var pe = rt.pendingException;
                        rt.pendingException = null;
                        var exc = rt.unwrap(pe.exc) || rt._b_.Exception;
                        throw rt.pendingExc(pe, exc);
                    }
                    return rc;
                });
            })(capSet, capClosure) : rt._b_.None;

            try {
                /* Build a Brython-native getset_descriptor (not a Python
                 * `property`). Brython's $B.$getattr() fast path checks
                 * func.ob_type in a switch (brython.js:4525-4541): a
                 * `property` falls through every case and yields
                 * AttributeError, whereas a getset_descriptor matches the
                 * `case $B.getset_descriptor: return func.getter(obj)`
                 * arm and is properly invoked. Symmetric shape to
                 * $B.getset_descriptor.$factory at brython.js:3409. */
                var descriptor = {
                    ob_type: rt.$B.getset_descriptor,
                    __doc__: rt._b_.None,
                    d_type: cls,
                    d_name: name,
                    getter: fget,
                    setter: fset,
                };
                /* Set in the class's tp_dict — where $B.get_from_dict()
                 * looks for the descriptor. */
                try {
                    var dictObj = rt.$B.get_dict(cls);
                    if (!dictObj) {
                        /* The class might not have an explicit dict yet —
                         * init one so str_dict_set has a target. */
                        rt.$B.init_dict(cls);
                        dictObj = rt.$B.get_dict(cls);
                    }
                    if (dictObj) rt.$B.str_dict_set(dictObj, name, descriptor);
                } catch (_) {}
                /* Also expose via cls.tp_funcs[name+'_get'] / [name+'_set']
                 * — Brython's getset_descriptor convention (see brython.js
                 * line 3422 for the metatype example). Some attribute
                 * resolution paths look here directly. */
                cls.tp_funcs = cls.tp_funcs || {};
                if (capGet) cls.tp_funcs[name + '_get'] = fget;
                if (capSet) cls.tp_funcs[name + '_set'] = fset;
                /* Also expose as JS attribute (some Brython paths fall
                 * through to direct property access). Use defineProperty
                 * with configurable:true to override Function.name and
                 * similar non-writable JS Function built-ins — without
                 * this, `cls.name = descriptor` silently fails because
                 * Brython class objects are JS functions. */
                try {
                    Object.defineProperty(cls, name, {
                        value: descriptor, writable: true,
                        configurable: true, enumerable: true,
                    });
                } catch (_) {
                    cls[name] = descriptor;
                }
            } catch (e) {
                /* Fall back to a plain getter function on the class. */
                if (capGet) {
                    try {
                        Object.defineProperty(cls, name, {
                            value: fget, writable: true,
                            configurable: true, enumerable: true,
                        });
                    } catch (_) { cls[name] = fget; }
                }
            }
        }
    },

    /* __wasthon_install_members — install PyMemberDef[] entries on `cls`
     * as property descriptors. Each member exposes a C struct field at a
     * fixed byte offset within the instance (inst.__wasthon_ptr__ + offset),
     * interpreted according to its type code (Py_T_INT, Py_T_OBJECT_EX,
     * etc., see wasthon.h:366-378). The getter reads linear memory; the
     * setter writes it (skipped when Py_READONLY flag is set). Used by
     * modules like _sre (Match.string/pos/endpos), sqlite (Connection
     * members), _struct, etc. */
    $__wasthon_install_members__deps: ['$WasthonRT'],
    $__wasthon_install_members: function(cls, membersPtr) {
        if (!membersPtr) return;
        var rt = WasthonRT;
        /* PyMemberDef on wasm32 = 20 bytes:
         *   +0  char *name
         *   +4  int   type
         *   +8  Py_ssize_t offset
         *   +12 int   flags  (bit 0 = Py_READONLY)
         *   +16 char *doc */
        for (var mp = membersPtr; ; mp += 20) {
            var namePtr = HEAP32[mp >> 2];
            if (namePtr === 0) break;
            var type    = HEAP32[(mp +  4) >> 2];
            var offset  = HEAP32[(mp +  8) >> 2];
            var flags   = HEAP32[(mp + 12) >> 2];
            var name    = UTF8ToString(namePtr);
            var readonly = (flags & 1) !== 0;

            /* Capture loop vars into closure scope. */
            var T = type, O = offset, N = name;

            var fget = (function(t, off, n) {
                return function(self) {
                    var instPtr = self && self.__wasthon_ptr__;
                    if (!instPtr) {
                        throw rt.$B.$call(rt._b_.AttributeError, n);
                    }
                    var addr = instPtr + off;
                    switch (t) {
                        case 1:  return HEAP32[addr >> 2] | 0;                 /* Py_T_INT */
                        case 2:  return HEAP32[addr >> 2] | 0;                 /* Py_T_PYSSIZET */
                        case 3:  return HEAPU8[addr] !== 0;                    /* Py_T_BOOL */
                        case 4: {                                              /* Py_T_OBJECT_EX */
                            var h = HEAP32[addr >> 2];
                            if (h === 0) {
                                throw rt.$B.$call(rt._b_.AttributeError, n);
                            }
                            var v = rt.unwrap(h);
                            // A bytes member filled C-side (PyBytes_FromStringAndSize(NULL,n)
                            // + memcpy, e.g. zlib's unused_data in save_unconsumed_input) is
                            // a writable placeholder: content lives in linear memory while
                            // .source still holds the zero fill. The post-call syncBytes pass
                            // only folds RETURN values, not struct members read later through
                            // this descriptor — dco.unused_data came back as b'\x00' * n.
                            // Fold here; PyBytes_AsString re-allocates from .source if C
                            // touches the bytes again.
                            if (v && v.__wasthon_cstr__ && v.source &&
                                    typeof v.source.length === 'number') {
                                var bsrc = v.source, bptr = v.__wasthon_cstr__;
                                for (var bi = 0, blen = bsrc.length; bi < blen; bi++) {
                                    bsrc[bi] = HEAPU8[bptr + bi];
                                }
                                _free(bptr);
                                v.__wasthon_cstr__ = 0;
                            }
                            return v;
                        }
                        case 5: {                                              /* Py_T_STRING */
                            var sp = HEAP32[addr >> 2];
                            return sp === 0 ? rt._b_.None : UTF8ToString(sp);
                        }
                        case 6:  return HEAPU32[addr >> 2] >>> 0;              /* Py_T_UINT */
                        case 7:  return HEAP32[addr >> 2] | 0;                 /* Py_T_LONG */
                        case 8:  return HEAPU32[addr >> 2] >>> 0;              /* Py_T_ULONG */
                        case 9:  return (HEAP16[addr >> 1] << 16) >> 16;       /* Py_T_SHORT */
                        case 10: return HEAPU16[addr >> 1];                    /* Py_T_USHORT */
                        case 11: return (HEAP8[addr] << 24) >> 24;             /* Py_T_BYTE */
                        case 12: return HEAPU8[addr];                          /* Py_T_UBYTE */
                        default:
                            throw rt.$B.$call(rt._b_.SystemError,
                                "unsupported PyMemberDef type: " + t);
                    }
                };
            })(T, O, N);

            var fset = readonly ? rt._b_.None : (function(t, off, n) {
                return function(self, value) {
                    var instPtr = self && self.__wasthon_ptr__;
                    if (!instPtr) {
                        throw rt.$B.$call(rt._b_.AttributeError, n);
                    }
                    var addr = instPtr + off;
                    var iv;  // coerced int value, used by integer cases
                    switch (t) {
                        case 1: case 2: case 7:
                            iv = rt.coerceInt(value);
                            HEAP32[addr >> 2] = (iv === undefined ? 0 : iv) | 0;
                            break;
                        case 6: case 8:
                            iv = rt.coerceInt(value);
                            HEAPU32[addr >> 2] = (iv === undefined ? 0 : iv) >>> 0;
                            break;
                        case 3:
                            HEAPU8[addr] = rt._b_.bool.$factory(value) ? 1 : 0;
                            break;
                        case 4:
                            // T_OBJECT member write into the instance struct:
                            // C reads it back on later calls — pin the handle.
                            HEAP32[addr >> 2] = rt.wrapPinned(value);
                            break;
                        case 9:
                            iv = rt.coerceInt(value);
                            HEAP16[addr >> 1] = (iv === undefined ? 0 : iv) & 0xffff;
                            break;
                        case 10:
                            iv = rt.coerceInt(value);
                            HEAPU16[addr >> 1] = (iv === undefined ? 0 : iv) & 0xffff;
                            break;
                        case 11:
                            iv = rt.coerceInt(value);
                            HEAP8[addr] = (iv === undefined ? 0 : iv) & 0xff;
                            break;
                        case 12:
                            iv = rt.coerceInt(value);
                            HEAPU8[addr] = (iv === undefined ? 0 : iv) & 0xff;
                            break;
                        /* Py_T_STRING (5) is read-only in CPython too; no setter. */
                    }
                };
            })(T, O, N);

            try {
                var prop = rt._b_.property.$factory(fget, fset);
                cls[name] = prop;
                try {
                    var dictObj = rt.$B.get_dict(cls);
                    if (dictObj) rt.$B.str_dict_set(dictObj, name, prop);
                } catch (_) {}
            } catch (e) {
                cls[name] = fget;
            }
        }
    },

    $__wasthon_install_methods__deps: ['$WasthonRT', '$__wasthon_make_trampoline'],
    $__wasthon_install_methods: function(target, methodsPtr, moduleHandle, moduleScope) {
        var rt = WasthonRT;
        /* For class methods, capture the class handle so trampoline can
         * pass it as the `cls` arg when METH_METHOD is set. */
        var classHandle = (!moduleScope && target.__wasthon_type_handle__)
            ? target.__wasthon_type_handle__ : 0;
        // Each entry is 16 bytes: name(4) + meth(4) + flags(4) + doc(4)
        for (var mp = methodsPtr; ; mp += 16) {
            var namePtr = HEAP32[ mp        >> 2];
            if (namePtr === 0) break;
            var fnPtr   = HEAP32[(mp +  4)  >> 2];
            var flags   = HEAP32[(mp +  8)  >> 2];
            var name    = UTF8ToString(namePtr);

            var trampoline = __wasthon_make_trampoline(fnPtr, flags, moduleHandle, name, moduleScope, classHandle);
            if (moduleScope) {
                // Mark module-scope trampolines as `builtin_function_or_method`
                // — CPython's C-level module functions behave this way, and
                // crucially do NOT auto-bind when assigned as class attributes
                // (no `tp_descr_get`). Without this, `class T: f = math.isclose`
                // then `self.f(a, b)` re-injects self → `isclose(self, a, b)`
                // (3 positional, raises). Affects every test that exercises
                // `class T: helper = somemodule.somefunc`.
                trampoline.ob_type = rt.$B.builtin_function_or_method;
                rt.$B.module_setattr(target, name, trampoline);
            } else if (flags & 0x0010 /* METH_CLASS */) {
                // C classmethod (Decimal.from_float, …): install a real
                // Brython classmethod descriptor so the CLASS is bound as
                // the first argument. It was installed as a plain method, so
                // `Decimal.from_float(2.5)` reached the trampoline with the
                // FLOAT as `self` → the C function cast it to PyTypeObject*
                // → get_module_state_by_def asserted (mod != NULL) and the
                // value arg was NULL.
                target.tp_funcs = target.tp_funcs || {};
                target.tp_funcs[name] = trampoline;
                trampoline.ob_type = rt.$B.builtin_method;
                try {
                    var cmDict = rt.$B.get_dict(target);
                    if (cmDict) {
                        rt.$B.str_dict_set(cmDict, name, {
                            ob_type: rt._b_.classmethod,
                            cm_callable: trampoline,
                        });
                    }
                } catch (_) {}
            } else {
                target.tp_funcs = target.tp_funcs || {};
                target.tp_funcs[name] = trampoline;
                trampoline.ob_type = rt.$B.builtin_method;
                /* Also install a method_descriptor wrapper in the class's
                 * tp_dict — mirrors Brython's own finalize_builtin_types.js
                 * lines 309-325 for native types (dict, list, range, str…).
                 * Without this wrapper, Brython's $B.$getattr fast path
                 * (py_builtin_functions.js:789, case $B.builtin_method)
                 * returns a bare anonymous function missing m_self / ml /
                 * $function_infos — which crashes the next repr(), __name__
                 * access, or any path through builtin_function_or_method's
                 * tp_repr. The method_descriptor.tp_descr_get builds the
                 * proper bound wrapper with all required fields. CPython
                 * equivalent: PyDescr_NewMethod populating tp_dict from
                 * PyType_Ready. Discovered 2026-05-26 fishing pattern.match. */
                try {
                    var dictObj = rt.$B.get_dict(target);
                    if (dictObj) {
                        var descr = {
                            ob_type: rt.$B.method_descriptor,
                            method: trampoline,
                            d_name: name,
                            d_type: target,
                        };
                        rt.$B.str_dict_set(dictObj, name, descr);
                        /* Cross-ref: Brython native install does
                         * `method.self = $B.get_from_dict(cls, descr)`
                         * (finalize_builtin_types.js:323). */
                        trampoline.self = descr;
                    }
                } catch (_) {}
            }
        }
    },

    /* ---- $__wasthon_make_trampoline: build a JS function that, when     *
     *      called from Brython with positional+kwargs, marshals the args  *
     *      into a C `args[]` array (PyObject* handles), packs kwnames,    *
     *      invokes the C function via getWasmTableEntry, returns result. */
    $__wasthon_make_trampoline__deps: ['$WasthonRT'],
    $__wasthon_make_trampoline: function(fnPtr, flags, moduleHandle, methName, moduleScope, classHandle) {
        var rt = WasthonRT;
        var FASTCALL = 0x0080, KEYWORDS = 0x0002, NOARGS = 0x0004, METH_O_ = 0x0008, METH_METHOD = 0x0200, METH_CLASS = 0x0010, METH_STATIC = 0x0020;

        var tramp = function() {
            // Collect args + kw the way Brython conveys them. Brython
            // method calls pass `self` as args[0] for instance methods,
            // and positional args follow. Module-scope functions don't
            // have a self.
            var jsArgs = Array.from(arguments);
            // Brython kwargs convention: last arg is sometimes a {$kw:[...]}
            // marker. Per Pierre / Brython ast_to_js: $kw is an Array whose
            // element 0 is a plain JS object (explicit name=value pairs)
            // and elements 1+ are real Brython dicts (each `**d` expansion).
            // Brython dicts store entries under Symbol keys in hash storage,
            // not as enumerable own properties — `Object.keys`/`for...in`
            // silently skip them. flattenKwArray dispatches per element
            // type and handles both cases.
            //
            // Examples:
            //   f(x=1, y=2)         → {$kw: [{x:1, y:2}]}
            //   f(**d1, **d2)       → {$kw: [{}, d1, d2]}
            //   f(x=1, **d1, **d2)  → {$kw: [{x:1}, d1, d2]}
            var kw = null;
            if (jsArgs.length > 0) {
                var last = jsArgs[jsArgs.length - 1];
                if (last && (last.$kw !== undefined || last.$nat === 'kw')) {
                    var kwSrc = last.$kw !== undefined ? last.$kw : last;
                    var kwPairs = rt.flattenKwArray(kwSrc);
                    if (kwPairs.length > 0) {
                        kw = {};
                        // Later wins (matches CPython's left-to-right ** eval).
                        for (var pi = 0; pi < kwPairs.length; pi++) {
                            kw[kwPairs[pi][0]] = kwPairs[pi][1];
                        }
                    }
                    jsArgs = jsArgs.slice(0, -1);
                }
            }

            // selfHandle is moduleHandle for module-scope, or the instance
            // pointer for instance methods (first arg is self).
            var selfHandle, posArgs;
            if (moduleScope) {
                selfHandle = moduleHandle;
                posArgs = jsArgs;
            } else {
                var self = jsArgs[0];
                if (self && self.__wasthon_ptr__) {
                    selfHandle = self.__wasthon_ptr__;
                    // Buffer-export safety (array): sync the C struct's
                    // ob_exports from a live-memoryview scan before the C method
                    // runs, so resize ops (append/extend/pop/imul/setitem/
                    // delitem…) raise BufferError while a memoryview is alive and
                    // succeed once it leaves scope. Mirrors Brython's own
                    // check_exports (frame-locals scan — no GC needed). Gated to
                    // types that recorded an ob_exports offset; the scan only
                    // runs once memoryview() has bumped self.exports.
                    // Brython's memoryview() keeps a net export count on the
                    // source object — obj.exports++ on create (py_buffer.js
                    // memoryview.$factory) and --on release / __exit__
                    // (memoryview_funcs.release). Sync it into the C struct so
                    // array's resize ops raise BufferError exactly while a
                    // memoryview is live (`m = memoryview(a)` AND
                    // `with memoryview(a):`) and succeed once it is released.
                    var bufOff = self.ob_type && self.ob_type.$wasthon_buf_exports_off;
                    if (bufOff !== undefined && typeof self.exports === 'number') {
                        HEAP32[(self.__wasthon_ptr__ + bufOff) >> 2] = self.exports;
                    }
                } else {
                    selfHandle = rt.wrap(self);
                }
                posArgs = jsArgs.slice(1);
            }

            // Marshal positional + kw values into a flat args[] array of
            // PyObject* handles (per FASTCALL convention).
            var nargs = posArgs.length;
            var kwNames = kw ? Object.keys(kw).filter(function(k) { return k !== '$kw' && k !== '$nat'; }) : [];
            var totalArgs = nargs + kwNames.length;
            var argsBufPtr = totalArgs > 0 ? _malloc(totalArgs * 4) : 0;
            for (var i = 0; i < nargs; i++) {
                HEAP32[(argsBufPtr + i*4) >> 2] = rt.wrap(posArgs[i]);
            }
            for (var i = 0; i < kwNames.length; i++) {
                HEAP32[(argsBufPtr + (nargs + i)*4) >> 2] = rt.wrap(kw[kwNames[i]]);
            }
            // kwnames is a Python tuple of strings. We just expose the JS
            // array, marked as a tuple so unpacker reads its length.
            var kwnamesHandle = kwNames.length > 0 ? rt.wrap(kwNames) : 0;

            rt.pendingException = null;
            var resultHandle = 0;
            try {
                var fn = getWasmTableEntry(fnPtr);
                if ((flags & METH_METHOD) && (flags & FASTCALL) && (flags & KEYWORDS)) {
                    /* METH_METHOD: signature is (self, cls, args, nargs, kwnames).
                     * classHandle is the type's struct pointer captured at
                     * install time. */
                    resultHandle = fn(selfHandle, classHandle || 0, argsBufPtr, nargs, kwnamesHandle);
                } else if ((flags & FASTCALL) && (flags & KEYWORDS)) {
                    resultHandle = fn(selfHandle, argsBufPtr, nargs, kwnamesHandle);
                } else if (flags & FASTCALL) {
                    resultHandle = fn(selfHandle, argsBufPtr, nargs);
                } else if (flags & NOARGS) {
                    // METH_NOARGS: CPython rejects any positional arg.
                    if (nargs > 0) throw rt.$B.$call(rt._b_.TypeError,
                        methName + "() takes no arguments (" + nargs + " given)");
                    resultHandle = fn(selfHandle, 0);
                } else if (flags & METH_O_) {
                    // METH_O: exactly one positional argument. CPython
                    // raises TypeError on 0 or >1 positional args.
                    // (METH_CLASS is bound via a real classmethod descriptor
                    // at install time, so `cls` arrives as `self` and the
                    // value as the single positional — no exemption needed.)
                    if (nargs !== 1 || kwNames.length > 0) {
                        throw rt.$B.$call(rt._b_.TypeError,
                            methName + "() takes exactly one argument (" +
                            (nargs + kwNames.length) + " given)");
                    }
                    resultHandle = fn(selfHandle, rt.wrap(posArgs[0]));
                } else if (flags & KEYWORDS) {
                    // METH_VARARGS | METH_KEYWORDS (legacy):
                    //   fn(self, args_tuple, kwargs_dict)
                    // Use $B.empty_dict + dict.$setitem (the proven
                    // PyDict_SetItem primitives) so the entries land in
                    // Brython's real hash storage. The earlier
                    // str_dict_set / kwDict[k]=v fallback dropped every
                    // entry — same bug as tp_init's kwarg path before
                    // we centralized on $setitem. e.g. _csv.reader([...],
                    // delimiter='\t') saw delimiter ignored.
                    var argsTuple = rt._b_.tuple.$factory(posArgs);
                    var kwDict = null;
                    if (kwNames.length > 0) {
                        kwDict = rt.$B.empty_dict();
                        for (var i = 0; i < kwNames.length; i++) {
                            rt._b_.dict.$setitem(kwDict, kwNames[i],
                                                 kw[kwNames[i]]);
                        }
                    }
                    resultHandle = fn(selfHandle, rt.wrap(argsTuple),
                                      kwDict ? rt.wrap(kwDict) : 0);
                } else {
                    // METH_VARARGS plain — fn(self, args_tuple)
                    resultHandle = fn(selfHandle, rt.wrap(posArgs));
                }
            } finally {
                if (argsBufPtr !== 0) _free(argsBufPtr);
            }

            // Check exception flag; raise into Brython.
            if (rt.pendingException) {
                var pe = rt.pendingException;
                rt.pendingException = null;
                throw rt.pendingExc(pe, rt.unwrap(pe.exc) || rt._b_.RuntimeError);
            }
            if (resultHandle === 0) {
                // No exception set but NULL returned — generic error.
                throw rt.$B.$call(rt._b_.RuntimeError, methName + ": call returned NULL");
            }
            var result = rt.unwrapResult(resultHandle);
            /* Sync bytes-like objects whose backing was a C-side linear-
             * memory buffer (e.g. zlib.compress output, pickle.loads bytes
             * written into __wasthon_cstr__). Walks recursively into
             * containers (tuple/list/dict) so bytes nested inside also
             * sync — pickle returns tuples that hold bytes written via
             * PyBytes_FromStringAndSize(NULL,n) + _Unpickler_ReadInto,
             * and without this descent the bytes still read as the
             * initial zero fill from .source. */
            (function syncBytes(v, seen) {
                if (!v || typeof v !== 'object') return;
                if (seen.has(v)) return;
                seen.add(v);
                if (v.__wasthon_cstr__ && v.source &&
                        typeof v.source.length === 'number') {
                    var src = v.source, ptr = v.__wasthon_cstr__;
                    for (var i = 0, len = src.length; i < len; i++) {
                        src[i] = HEAPU8[ptr + i];
                    }
                    // The C buffer is now redundant — its content lives in
                    // .source. Reclaim it; PyBytes_AsString re-allocates from
                    // .source on demand if C touches the bytes again later.
                    _free(ptr);
                    v.__wasthon_cstr__ = 0;
                }
                /* tuple / list — iterable JS array-shaped object with
                 * .length, and Brython tuple/list expose elements at
                 * numeric indices. */
                if (typeof v.length === 'number') {
                    for (var j = 0; j < v.length; j++) syncBytes(v[j], seen);
                }
                /* dict — walk values (keys are rarely bytes; if needed
                 * users hit a separate fix). Brython dicts store entries
                 * in a $version-keyed structure; len()+items() is the
                 * portable read. */
                try {
                    if (v.__class__ === rt._b_.dict ||
                        (rt.$B.$isinstance && rt.$B.$isinstance(v, rt._b_.dict))) {
                        var items = rt.$B.$call(rt._b_.list,
                            rt.$B.$call(rt.$B.$getattr(v, 'values')));
                        for (var k = 0, n = rt._b_.len(items); k < n; k++) {
                            syncBytes(rt.$B.$getitem(items, k), seen);
                        }
                    }
                } catch (_) {}
            })(result, new WeakSet());
            // Materialize PyUnicode_New placeholders into actual JS strings
            // and replace the handle's value so callers see a real str.
            if (result && result.__wasthon_unicode_buf__) {
                var s = rt.asJSStr(result);
                rt.handles.set(resultHandle, s);
                result = s;
            }
            /* Subclass-aware pickle reduce. A C-type's __reduce__/__reduce_ex__
             * embeds Py_TYPE(self) as the reconstruction class, but for a
             * Brython subclass instance Py_TYPE (the C struct's ob_type) is the
             * PARENT C-type — the bridge keeps __wasthon_type__ = parent so the
             * C side's PyObject_TypeCheck works. So the reduce names the BASE
             * class; unpickling then rebuilds a base instance, losing the
             * subclass identity and its __dict__ state ("'array' object has no
             * attribute '__dict__'"). Patch the result to name the instance's
             * actual class (self.ob_type) wherever it currently names a strict
             * base of it — both the (cls, args, state) shape (proto 0-2) and the
             * (reconstructor, (cls, ...), state) shape (proto 3+). The load side
             * already accepts the subclass (PyType_IsSubtype → $issubclass). */
            if (!moduleScope && result &&
                    (methName === '__reduce_ex__' || methName === '__reduce__')) {
                var rself = jsArgs[0];
                var subcls = rself && rself.ob_type;
                if (subcls && typeof result.length === 'number' && result.length >= 2) {
                    var isStrictBase = function(t) {
                        return t && t !== subcls && rt.$B.is_type && rt.$B.is_type(t) &&
                               rt._b_.issubclass(subcls, t);
                    };
                    if (isStrictBase(result[0])) {
                        result[0] = subcls;                 // proto 0-2: cls is the callable
                    } else {
                        var rargs = result[1];
                        if (rargs && typeof rargs.length === 'number' && isStrictBase(rargs[0])) {
                            // Reconstructor-function form. The plain swap
                            // (rargs[0]=subcls) is right when the reconstructor can
                            // build a subtype (copyreg.__newobj__ →
                            // subcls.__new__(subcls)). But a binary C reconstructor
                            // (array._array_reconstructor) cannot allocate a Brython
                            // subtype on the C side ("index out of bounds"). For
                            // protocol >= 3, fall back to the type's own protocol-2
                            // reduce — the constructor form — which reconstructs by
                            // CALLING the class through the bridge tp_new path (it
                            // honours subtypes). Only at proto >= 3: proto <= 2 uses
                            // the constructor form via the branch above, so the
                            // recursive proto-2 call cannot re-enter here → no loop.
                            var cur = (methName === '__reduce_ex__' && posArgs.length > 0)
                                      ? posArgs[0] : 0;
                            var done = false;
                            if (cur >= 3) {
                                try {
                                    var alt = rt.$B.$call(rt.$B.$getattr(rself, '__reduce_ex__'), 2);
                                    if (alt && typeof alt.length === 'number' &&
                                            alt.length >= 2 && rt.$B.is_type(alt[0])) {
                                        result = alt;   // already subclass-aware (recursion swapped it)
                                        done = true;
                                    }
                                } catch (e) {}
                            }
                            if (!done) rargs[0] = subcls;
                        }
                    }
                }
            }
            return result;
        };
        // Every trampoline call runs under a fresh handle scope: sentinel
        // handles wrapped during the C call (args, temporaries, borrowed
        // wraps) are released at return unless C took a reference.
        tramp = rt.scoped(tramp);
        // Brython reads $function_infos for a function's __module__/__name__/
        // __qualname__ and in repr/coroutine paths; native builtins carry it
        // as [module, name, qualname] (finalize_builtin_types). Trampolines
        // must too, or any such access crashes on `$function_infos[i]` of
        // undefined.
        var modName = 'builtins';
        try {
            var modObj = moduleHandle ? rt.handles.get(moduleHandle) : null;
            if (modObj) {
                // Brython modules keep __name__ in their dict (module_setattr),
                // NOT as a raw JS property — reading modObj.__name__ directly
                // gave undefined, so every C-module function got
                // __module__='builtins' and pickle couldn't locate it
                // (e.g. array._array_reconstructor → "not found as
                // builtins._array_reconstructor"). Read it from the dict.
                var nm = rt.$B.get_from_dict(modObj, '__name__', rt.$B.NULL);
                if (nm !== rt.$B.NULL && nm) modName = nm;
                else if (modObj.__name__) modName = modObj.__name__;
            }
        } catch (_) {}
        var qn = methName || '';
        tramp.$function_infos = [modName, qn, qn];
        tramp.m_module = modName;
        /* Mark the trampoline as an already-built Python object. Without this,
         * Brython's jsobj2pyobj (run by tuple/list/dict $factory on every
         * element) sees a bare JS function, fails to recognise it, and wraps
         * it in a fresh JavascriptFunction named after the JS function
         * ('tramp') with __module__='builtins' — losing identity and the real
         * name. That broke pickling of any C function placed in a reduce
         * tuple: array.__reduce_ex__(>=3) embeds array._array_reconstructor,
         * which became an unpicklable '<JavascriptFunction>' instead of the
         * builtin. PYOBJ makes jsobj2pyobj return the trampoline unchanged. */
        try { tramp[rt.$B.PYOBJ] = tramp; } catch (_) {}
        return tramp;
    },

    /* --------------------------------------------------------------- *
     * _PyArg_UnpackKeywords                                           *
     *                                                                 *
     * Dispatcher for METH_FASTCALL|METH_KEYWORDS calls.               *
     *                                                                 *
     * Layout of `_PyArg_Parser` (must match wasthon.h):                *
     *   offset  0  const char * const *keywords                       *
     *   offset  4  const char *fname                                  *
     *   offset  8  const char *custom_msg                             *
     *   offset 12  int initialized                                    *
     *   offset 16  int pos                                            *
     *   offset 20  int min                                            *
     *   offset 24  int max                                            *
     *   offset 28  PyObject *kwtuple                                  *
     *   offset 32  void *next                                         *
     *                                                                 *
     * args[0..nargs-1]                  positional values             *
     * args[nargs..nargs+|kwnames|-1]    values for kwnames entries    *
     * kwnames                           Python tuple of str names     *
     *                                                                 *
     * Returns buf (non-zero) on success, 0 on error.                  *
     * --------------------------------------------------------------- */

    wasthon_unpack_keywords__deps: ['$WasthonRT'],
    wasthon_unpack_keywords: function(argsPtr, nargs, kwargs, kwnames,
                                       parserPtr, minpos, maxpos,
                                       minkw, varpos, bufPtr) {
        // ---- Read parser fields ----
        var keywordsArrPtr = HEAP32[ parserPtr        >> 2];
        var fnamePtr       = HEAP32[(parserPtr +  4)  >> 2];
        var fname          = fnamePtr ? UTF8ToString(fnamePtr) : "function";

        // ---- Read keyword names from the NULL-terminated C array ----
        var keywords = [];
        for (var kp = keywordsArrPtr; ; kp += 4) {
            var sptr = HEAP32[kp >> 2];
            if (sptr === 0) break;
            keywords.push(UTF8ToString(sptr));
        }
        var totalKw = keywords.length;

        // ---- CPython _PyArg_UnpackKeywords (Python/getargs.c), faithfully:
        // fill positional then keyword slots; on leftover keywords report
        // "given by name and position" before "unexpected keyword", matching
        // clinic's error ordering. ----
        var rt = WasthonRT;
        var TE = rt.wrap(rt._b_.TypeError);
        var posonly = HEAP32[(parserPtr + 16) >> 2] || 0;   // parser->pos
        var maxargs = totalKw;
        var minposonly = Math.min(posonly, minpos);
        var reqlimit = minkw ? (maxpos + minkw) : minpos;

        // Supplied keywords arrive either as a FASTCALL kwnames tuple (values
        // at args[nargs + j]) or as a legacy kwargs dict.
        var kwnamesObj = kwnames !== 0 ? rt.unwrap(kwnames) : null;
        var kwDict = kwargs !== 0 ? rt.unwrap(kwargs) : null;
        if (kwDict === rt._b_.None) kwDict = null;
        var nkwargs = kwDict ? rt._b_.len(kwDict)
                             : (kwnamesObj ? (kwnamesObj.length || 0) : 0);

        // findKw(name) -> {f: supplied?, v: value handle (0 if absent)}.
        function findKw(name) {
            if (kwnamesObj) {
                for (var j = 0; j < kwnamesObj.length; j++) {
                    var nm = kwnamesObj[j];
                    if ((typeof nm === 'string' ? nm : String(nm)) === name) {
                        return { f: true, v: HEAP32[(argsPtr + (nargs + j)*4) >> 2] };
                    }
                }
                return { f: false, v: 0 };
            }
            if (kwDict) {
                var has = false;
                try { has = rt._b_.dict.$contains_string(kwDict, name); }
                catch (_) { has = false; }
                if (!has) return { f: false, v: 0 };
                var value;
                try { value = rt._b_.dict.$getitem(kwDict, name); }
                catch (_) { return { f: false, v: 0 }; }
                return { f: true, v: rt.wrap(value) };
            }
            return { f: false, v: 0 };
        }
        // A name is a legal keyword parameter iff it is one of the kwtuple
        // slots keywords[posonly..] (positional-only slots are left blank).
        function isKwName(name) {
            for (var k = posonly; k < totalKw; k++) {
                if (keywords[k] === name) return true;
            }
            return false;
        }
        // Enumerate a legacy kwargs dict's keys (only needed to name an
        // unexpected keyword, so it stays off the common path).
        function dictKeyNames() {
            var out = [];
            try {
                var kl = rt.$B.$call(rt._b_.list,
                    rt.$B.$call(rt.$B.$getattr(kwDict, 'keys')));
                for (var k = 0, n = rt._b_.len(kl); k < n; k++) {
                    var kk = rt.$B.$getitem(kl, k);
                    out.push(typeof kk === 'string' ? kk : String(kk));
                }
            } catch (_) {}
            return out;
        }

        // ---- Positional-count validation (CPython order). ----
        if (!varpos && (nargs + nkwargs) > maxargs) {
            rt.setError(TE, fname + "() takes at most " + maxargs + " " +
                (nargs === 0 ? "keyword " : "") + "argument" +
                (maxargs === 1 ? "" : "s") + " (" + (nargs + nkwargs) + " given)");
            return 0;
        }
        if (!varpos && nargs > maxpos) {
            if (maxpos === 0) {
                rt.setError(TE, fname + "() takes no positional arguments");
            } else {
                rt.setError(TE, fname + "() takes " +
                    (minpos < maxpos ? "at most" : "exactly") + " " + maxpos +
                    " positional argument" + (maxpos === 1 ? "" : "s") +
                    " (" + nargs + " given)");
            }
            return 0;
        }
        if (nargs < minposonly) {
            rt.setError(TE, fname + "() takes " +
                ((varpos || minposonly < maxpos) ? "at least" : "exactly") + " " +
                minposonly + " positional argument" + (minposonly === 1 ? "" : "s") +
                " (" + nargs + " given)");
            return 0;
        }

        // ---- Initialize buf, then place positional args. ----
        for (var i = 0; i < totalKw; i++) HEAP32[(bufPtr + i*4) >> 2] = 0;
        var nposCopy = Math.min(nargs, maxpos);
        for (var i = 0; i < nposCopy; i++) {
            HEAP32[(bufPtr + i*4) >> 2] = HEAP32[(argsPtr + i*4) >> 2];
        }

        // ---- Fill keyword slots, driven by the kwtuple. ----
        var remaining = nkwargs;
        for (var i = Math.max(nposCopy, posonly); i < maxargs; i++) {
            var got;
            if (remaining) {
                got = findKw(keywords[i]);
            } else if (i >= reqlimit) {
                break;
            } else {
                got = { f: false, v: 0 };
            }
            HEAP32[(bufPtr + i*4) >> 2] = got.v;
            if (got.f) {
                remaining--;
            } else if (i < minpos || (maxpos <= i && i < reqlimit)) {
                rt.setError(TE, fname + "() missing required argument '" +
                    keywords[i] + "' (pos " + (i + 1) + ")");
                return 0;
            }
        }

        // ---- Leftover keywords: duplicates-by-position, then unexpected. ----
        if (remaining > 0) {
            for (var i = posonly; i < nposCopy; i++) {
                if (findKw(keywords[i]).f) {
                    rt.setError(TE, "argument for " + fname +
                        "() given by name ('" + keywords[i] +
                        "') and position (" + (i + 1) + ")");
                    return 0;
                }
            }
            var supplied = kwnamesObj
                ? kwnamesObj.map(function(nm) {
                      return typeof nm === 'string' ? nm : String(nm); })
                : (kwDict ? dictKeyNames() : []);
            var bad = '';
            for (var j = 0; j < supplied.length; j++) {
                if (!isKwName(supplied[j])) { bad = supplied[j]; break; }
            }
            rt.setError(TE, fname +
                "() got an unexpected keyword argument '" + bad + "'");
            return 0;
        }

        return bufPtr;
    },
});
