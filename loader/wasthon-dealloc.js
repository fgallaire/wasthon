/*
 * wasthon-dealloc.js — deterministic free of heavy wasthon C resources at
 * close()/with-exit points.
 *
 * Brython is GC, not refcount, and during a synchronous test run the event loop
 * never yields, so neither a FinalizationRegistry nor __del__ ever fires — a
 * transient C object (e.g. an LZMACompressor with a ~94 MB lzma context) never
 * reaches refcount 0, never runs tp_dealloc, and the context leaks until OOM.
 * The C free itself works (decref → tp_dealloc → lzma_end → free → reused); the
 * only thing missing is a deterministic trigger.
 *
 * The compression file objects (lzma.LZMAFile / bz2.BZ2File) DO have a
 * deterministic close()/__exit__ (the tests use `with LZMAFile(...)`). So here
 * we wrap their close() to explicitly decref the compressor/decompressor they
 * drop — freeing the context immediately instead of waiting on a GC that never
 * comes. Patching happens synchronously when the module imports (we wrap
 * $B.$import), so it is in place before the suite runs.
 *
 * Entry point: installWasthonDealloc(M), M = the Emscripten module (rt=M.wasthon).
 */
(function (global) {
    'use strict';

    function installWasthonDealloc(M) {
        const B = global.__BRYTHON__;
        const rt = M && M.wasthon;
        if (!B || !rt || !B.$import) return;

        const freeObj = (o) => {
            if (o && o.__wasthon_ptr__ && rt.refcounts && rt.refcounts.has(o.__wasthon_ptr__)) {
                try { rt.decref(o.__wasthon_ptr__); } catch (e) {}
            }
        };
        const get = (o, name) => {
            try { return B.$getattr(o, name); } catch (e) { return undefined; }
        };

        function patchFileClose(cls) {
            if (!cls || cls.$wasthon_dealloc_patched) return;
            let orig;
            try { orig = B.$getattr(cls, 'close'); } catch (e) { return; }
            if (typeof orig !== 'function') return;
            cls.$wasthon_dealloc_patched = true;
            const wrapped = function () {
                const self = arguments[0];
                // grab the heavy C objects BEFORE close() nulls them out
                const comp = get(self, '_compressor');
                const decomp = get(self, '_decompressor');
                const buf = get(self, '_buffer');           // read path: BufferedReader
                const rawReader = buf ? get(buf, 'raw') : undefined;  // DecompressReader
                const rawDecomp = rawReader ? get(rawReader, '_decompressor') : undefined;
                const r = orig.apply(this, arguments);      // real close (flush, set None)
                freeObj(comp); freeObj(decomp); freeObj(rawDecomp);
                return r;
            };
            try { B.$setattr(cls, 'close', wrapped); } catch (e) { /* leave original */ }
        }

        function patchModule(modName, clsName) {
            const mod = B.imported && B.imported[modName];
            if (!mod) return;
            const cls = get(mod, clsName);
            if (cls) patchFileClose(cls);
        }

        // One-shot helpers (lzma.compress / decompress, bz2.*, zstd.*) build a
        // throwaway compressor/decompressor whose heavy C context (~94 MB for an
        // LZMA encoder) never reaches refcount 0 — Brython is GC, not refcount,
        // so the local is dropped but never decref'd, and a tight comparison
        // loop OOMs. We call the real helper (it owns all the arg/format logic),
        // then decref every instance of the relevant types that it created and
        // left behind — firing tp_dealloc on exactly the leaked transients.
        function wrapHelperFree(modName, fnName, typeNames) {
            const mod = B.imported && B.imported[modName];
            if (!mod) return;
            const flag = '$wasthon_helper_' + fnName + '_patched';
            if (mod[flag]) return;
            const orig = get(mod, fnName);
            if (typeof orig !== 'function') return;
            const types = typeNames.map((n) => get(mod, n)).filter(Boolean);
            if (!types.length || !rt.refcounts) return;
            mod[flag] = true;
            const wrapped = function () {
                const rc = rt.refcounts;
                const before = new Set(rc.keys());
                try {
                    return orig.apply(this, arguments);
                } finally {
                    for (const h of Array.from(rc.keys())) {
                        if (before.has(h)) continue;
                        const obj = rt.handles.get(h);
                        if (obj && types.indexOf(obj.ob_type) !== -1) {
                            try { rt.decref(h); } catch (e) {}
                        }
                    }
                }
            };
            try { B.$setattr(mod, fnName, wrapped); } catch (e) { mod[flag] = false; }
        }

        const origImport = B.$import;
        if (origImport.$wasthonDealloc) return;
        const wrapped = function () {
            const result = origImport.apply(this, arguments);
            try { patchAll(); } catch (e) {}
            return result;
        };
        wrapped.$wasthonDealloc = true;
        B.$import = wrapped;

        function patchAll() {
            patchModule('lzma', 'LZMAFile');               // ~94 MB lzma context
            patchModule('bz2', 'BZ2File');
            patchModule('compression.zstd', 'ZstdFile');   // ZSTD_C/DCtx
            // free the transient compressor/decompressor of the one-shot helpers
            wrapHelperFree('lzma', 'compress', ['LZMACompressor']);
            wrapHelperFree('lzma', 'decompress', ['LZMADecompressor']);
            wrapHelperFree('bz2', 'compress', ['BZ2Compressor']);
            wrapHelperFree('bz2', 'decompress', ['BZ2Decompressor']);
            wrapHelperFree('compression.zstd', 'compress', ['ZstdCompressor']);
            wrapHelperFree('compression.zstd', 'decompress', ['ZstdDecompressor']);
        }
        // also catch modules already imported
        try { patchAll(); } catch (e) {}

        B.$wasthon_free = freeObj;   // expose for ad-hoc use
    }

    global.installWasthonDealloc = installWasthonDealloc;
})(window);
