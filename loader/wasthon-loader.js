/*
 * Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
 *
 * BSD 3-Clause License
 *
 * wasthon-loader.js — Brython-side loader for Wasthon modules.
 *
 * Usage (in browser, after brython.js is loaded but before brython() runs):
 *
 *     await wasthonLoad('_sha2', './_sha2.mjs');
 *     brython({debug: 1});
 *
 * After this, `import _sha2` from Brython code finds the module
 * pre-registered in $B.imported and skips the import-engine path.
 *
 * Each Wasthon module is an Emscripten ES6 module exporting a default
 * factory (per `-s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=...`).
 * The factory returns a Promise<EmscriptenModule>. We:
 *   1. await it
 *   2. call _wasthon_init() once per WASM instance (populates
 *      C-side extern globals: Py_None, PyExc_*, PyType_*…)
 *   3. call _PyInit_<name>()  →  PyModuleDef* handle
 *   4. call _wasthon_module_create(defHandle)  →  module handle (runs
 *      mod_exec slots, registers types, etc.)
 *   5. resolve module handle via Module.wasthon (the runtime) to get
 *      the actual JS module object
 *   6. install into __BRYTHON__.imported[name]
 */

(function (global) {
    'use strict';

    if (!global.__BRYTHON__) {
        // Brython not loaded yet — that's fine, register a placeholder
        // and let the caller order things. We require Brython at *load*
        // time because the bridge's WasthonRT.init() needs $B.builtins.
        throw new Error(
            "wasthon-loader: __BRYTHON__ not found. " +
            "Load brython.js (and brython_stdlib.js if needed) before " +
            "loading wasthon-loader.js."
        );
    }

    /**
     * Load a Wasthon WASM module and register it in Brython's import cache.
     *
     *   name           — name the module is registered as in __BRYTHON__.imported.
     *                    Defaults to also being the C-side PyInit_<name> symbol
     *                    name; pass `initName` separately if they differ (useful
     *                    when registering a Wasthon module alongside Brython's
     *                    own implementation of the same module, for benchmarks).
     *   mjsUrl         — URL of the Emscripten ES6 wrapper.
     *   opts.initName  — override of the C-side PyInit_<initName> symbol.
     */
    async function wasthonLoad(name, mjsUrl, opts) {
        opts = opts || {};
        const cInitName = opts.initName || name;

        const factoryModule = await import(mjsUrl);
        const factory = factoryModule.default;
        if (typeof factory !== 'function') {
            throw new Error(
                `wasthon: '${mjsUrl}' must export a default factory ` +
                `(emcc -s MODULARIZE=1 -s EXPORT_ES6=1).`
            );
        }
        const M = await factory();

        // Bootstrap the C-side runtime.
        M._wasthon_init();

        const initName = '_PyInit_' + cInitName;
        const initFn = M[initName];
        if (typeof initFn !== 'function') {
            throw new Error(
                `wasthon: ${initName} not found in '${mjsUrl}'. ` +
                `Did you export it via EXPORTED_FUNCTIONS?`
            );
        }
        const defHandle = initFn();
        if (defHandle === 0) {
            throw new Error(`wasthon: ${initName}() returned 0 (init failed)`);
        }

        const modHandle = M._wasthon_module_create(defHandle);
        if (modHandle === 0) {
            const exc = M.wasthon && M.wasthon.pendingException;
            throw new Error(
                `wasthon: wasthon_module_create() returned 0` +
                (exc ? ` — ${exc.msg}` : '')
            );
        }

        const rt = M.wasthon;
        const modObj = rt.handles.get(modHandle);
        if (!modObj) {
            throw new Error(
                `wasthon: module handle ${modHandle} did not resolve.`
            );
        }

        // Stash for inspection / unloading.
        global.__BRYTHON__.imported[name] = modObj;
        global.__BRYTHON__.wasthon_modules = global.__BRYTHON__.wasthon_modules || {};
        global.__BRYTHON__.wasthon_modules[name] = { module: M, runtime: rt, obj: modObj };

        return modObj;
    }

    global.wasthonLoad = wasthonLoad;
})(window);
