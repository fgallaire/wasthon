/*
 * wasthon-io-write.js — give Brython's read-only _io stack a writable, seekable,
 * fd-backed implementation, built on the os/posix syscall layer (open/read/
 * write/lseek/ftruncate/close), exactly like CPython's io is layered on fds.
 *
 * This is a BRYTHON gap fix, independent of wasthon: stock Brython's _io is
 * read-only (FileIO does an XHR GET, there is no BufferedWriter/BufferedRandom,
 * TextIOWrapper has no write). It has NO knowledge of any backing store — it
 * does I/O through an injected syscall surface, B.$wasthon_io_hooks =
 * { open, close, read, write, lseek, ftruncate, exists }. Whoever provides that
 * (here: the pure-JS in-memory FS in wasthon-fs-mem.js) makes these classes do
 * real I/O. Candidate for upstreaming into Brython (see BRYTHON_FIX.md).
 *
 * Entry point: installWasthonIOWrite(B), B = __BRYTHON__. Idempotent.
 * Without the hooks the classes are inert (no backing) — exactly stock Brython.
 */
(function (global) {
    'use strict';

    // (re)install methods from cls.tp_funcs into the type dict as
    // method_descriptors — mirrors $B.finalize_type's tp_methods loop. Needed
    // both for methods we ADD and ones we OVERRIDE (the existing descriptor
    // captured the old function, so attribute lookup would miss our version).
    function installTypeMethods(B, cls, names, module) {
        for (const name of names) {
            const method = cls.tp_funcs[name];
            if (typeof method !== 'function') continue;
            B.add_function_infos(cls.tp_funcs, name, module,
                (cls.tp_name || '') + '.' + name);
            method.ob_type = B.builtin_method;
            B.set_to_dict(cls, name, {
                ob_type: B.method_descriptor, method: method, d_name: name, d_type: cls,
            });
            if (cls.tp_methods && cls.tp_methods.indexOf(name) === -1) {
                cls.tp_methods.push(name);
            }
        }
    }

    function installWasthonIOWrite(B) {
        if (!B || B.$wasthon_io_installed) return;
        const _b_ = B.builtins;
        const FileIO = B._FileIO;
        if (!FileIO) { console.warn('[wasthon-io] $B._FileIO missing'); return; }
        B.$wasthon_io_installed = true;

        // the syscall surface (open/read/write/lseek/ftruncate/close/exists),
        // injected by whoever backs the filesystem (wasthon: the MEMFS shim in
        // wasthon-fs.js). Without it these classes can't do I/O.
        const sys = () => B.$wasthon_io_hooks || {};
        const exists = (p) => {
            const h = B.$wasthon_io_hooks;
            return (typeof p === 'string' && h && h.exists) ? !!h.exists(p) : false;
        };

        const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2,
            O_CREAT = 256, O_TRUNC = 512, O_APPEND = 8, O_EXCL = 1024;

        // mode string ('r','w+','xb'…, b/t already stripped to rawmode) → flags
        function modeToFlags(mode) {
            let flags = 0, w = 0, plus = 0;
            for (const c of mode) {
                if (c === 'r') {}
                else if (c === 'w') { w = 1; flags |= O_CREAT | O_TRUNC; }
                else if (c === 'a') { w = 1; flags |= O_CREAT | O_APPEND; }
                else if (c === 'x') { w = 1; flags |= O_CREAT | O_EXCL; }
                else if (c === '+') { plus = 1; }
            }
            if (plus) flags |= O_RDWR;
            else if (w) flags |= O_WRONLY;
            else flags |= O_RDONLY;
            return flags;
        }

        // ---- open() interception -------------------------------------------
        // resolve os.PathLike (anything with __fspath__) to a str path
        function toPath(file) {
            if (typeof file === 'string' || typeof file === 'number') return file;
            try {
                const fs = B.$getattr(file, '__fspath__', null);
                if (fs) return B.$call(fs);
            } catch (e) {}
            return file;
        }
        function makeDispatch(orig) {
            return function () {
                const $ = B.args('open', 8,
                    { file: null, mode: null, buffering: null, encoding: null,
                      errors: null, newline: null, closefd: null, opener: null },
                    arguments, { mode: 'r', buffering: -1, encoding: _b_.None,
                      errors: _b_.None, newline: _b_.None, closefd: true,
                      opener: _b_.None });
                const file = toPath($.file), mode = $.mode || 'r';
                const isFd = (typeof file === 'number');
                const writable = /[wax+]/.test(mode);
                const hasOpener = $.opener && $.opener !== _b_.None;
                const inFs = !isFd && !hasOpener && exists(file);
                if (isFd || writable || hasOpener || inFs) {
                    return wasthonOpen(file, mode, $.encoding, $.errors,
                        $.newline, $.closefd, $.opener);
                }
                if (orig) return orig.apply(this, arguments);   // legacy read
                return wasthonOpen(file, mode, $.encoding, $.errors,
                    $.newline, $.closefd, $.opener);
            };
        }
        // Brython's _io.open (== io.open) builds raw → BufferedRandom →
        // TextIOWrapper, but the buffered layer is a stub that drops the raw and
        // the text layer is read-only. We replace io.open / _io.open with our own
        // that goes raw FileIO → text wrapper directly (no buffered middle).
        // io/_io are imported lazily; in every file flow os.open() fires before
        // io.open(), so the posix shim triggers this on the first open (below).
        let openPatched = false;
        function ensureOpenPatched() {
            if (openPatched) return;
            const imp = B.imported;
            if (!imp) return;
            const targets = [imp.io, imp._io].filter(Boolean);
            if (targets.length === 0) return;
            openPatched = true;
            const getO = (m) => { try { return B.$getattr(m, 'open'); } catch (e) { return m.open; } };
            const setO = (m, fn) => {
                try { B.$setattr(m, 'open', fn); } catch (e) {}
                m.open = fn;
                if (m.$dict) m.$dict.open = fn;
            };
            for (const mod of targets) setO(mod, makeDispatch(getO(mod)));
            // Also builtins.open: bz2/lzma do builtins.open(name, mode); its
            // native _io.open wraps a READ in $B._BufferedReader, which slices
            // raw.$bytes (the whole-file model) — undefined for our fd-backed
            // FileIO. Routing it through our dispatch returns the raw fd object
            // directly. Lazy (only after the first os.open) — patching it
            // eagerly at load intercepts early reads and breaks test_math.
            if (_b_.open && !_b_.open.$wasthonOpen) {
                const bd = makeDispatch(_b_.open);
                bd.$wasthonOpen = true;
                _b_.open = bd;
            }
        }
        B.$wasthon_io_ensureOpenPatched = ensureOpenPatched;

        // build raw FileIO → (text) directly, skipping the broken buffered layer
        function wasthonOpen(file, mode, encoding, errors, newline, closefd, opener) {
            const binary = /b/.test(mode);
            let rawmode = '';
            for (const c of mode) if ('xrwa+'.indexOf(c) !== -1) rawmode += c;
            if (rawmode === '') rawmode = 'r';
            const raw = B.$call(B._FileIO, file, rawmode,
                closefd === false ? false : true,
                opener === undefined ? _b_.None : opener);
            if (binary) return raw;
            const wrapper = B.$call(B._TextIOWrapper, raw,
                encoding === undefined ? _b_.None : encoding,
                errors === undefined ? _b_.None : errors,
                newline === undefined ? _b_.None : newline, _b_.False);
            try { B.$setattr(wrapper, 'mode', mode); } catch (e) {}
            return wrapper;
        }

        // ---- FileIO: fd-backed over os.* syscalls --------------------------
        const origInit = FileIO.tp_init;
        FileIO.tp_init = function () {
            const $ = B.args('__init__', 5,
                { self: null, name: null, mode: null, closefd: null, opener: null },
                arguments, { mode: 'r', closefd: true, opener: _b_.None });
            const self = $.self, name = toPath($.name), mode = $.mode || 'r';
            const opener = $.opener;
            const hasOpener = opener && opener !== _b_.None;
            const isFd = (typeof name === 'number');
            const writable = /[wax+]/.test(mode);
            // a plain read of a path that exists in the os filesystem (e.g. a
            // temp file we wrote earlier and reopen by name) goes fd-backed too;
            // anything else (bundled .py, a URL) keeps Brython's legacy XHR read.
            const inFs = !isFd && !hasOpener && exists(name);

            if (!isFd && !writable && !hasOpener && !inFs) {
                return origInit.apply(this, arguments);   // legacy read path
            }
            const flags = modeToFlags(mode);
            // honor a custom opener (file, flags) → fd, as CPython open() does
            // (tempfile passes one that mkstemp()s the real fd; `name` is a dir)
            const fd = hasOpener ? B.$call(opener, name, flags)
                : isFd ? name : sys().open(name, flags, 0o600);
            self.$wfs = true;
            self.$wfd = fd;
            self.fd = fd;                       // >=0 so the "closed" guards pass
            self.$closefd = $.closefd !== false;
            self.$name = name;
            self.readable = /[r+]/.test(mode) ? 1 : 0;
            self.writable = /[wax+]/.test(mode) ? 1 : 0;
            self.appending = /a/.test(mode) ? 1 : 0;
            self.seekable = 1;
            self.closed = false;
            if (self.appending) { try { sys().lseek(fd, 0, 2); } catch (e) {} }
            return _b_.None;
        };

        const F = FileIO.tp_funcs;
        const origReadinto = F.readinto, origReadable = F.readable,
            origWritable = F.writable, origSeekable = F.seekable;
        const checkOpen = (self) => {
            if (self.closed) B.RAISE(_b_.ValueError, 'I/O operation on closed file');
        };

        F.readinto = function (self, buffer) {
            if (!self.$wfs) return origReadinto.call(this, self, buffer);
            checkOpen(self);
            const data = sys().read(self.$wfd, _b_.len(buffer));
            const src = data.source || [];
            for (let i = 0; i < src.length; i++) buffer.source[i] = src[i];
            buffer.source.length = src.length;
            return src.length;
        };
        F.read = function (self, size) {
            if (!self.$wfs) {
                const ba = _b_.bytearray.$factory();
                F.readinto(self, ba); ba.ob_type = _b_.bytes; return ba;
            }
            checkOpen(self);
            const fd = self.$wfd;
            let n;
            if (size === undefined || size === _b_.None || size < 0) {
                // remaining = end - cur, via lseek (works on unlinked-but-open
                // fds, the TemporaryFile case)
                const cur = sys().lseek(fd, 0, 1);
                const end = sys().lseek(fd, 0, 2);
                sys().lseek(fd, cur, 0);
                n = end - cur;
            } else { n = size; }
            if (n < 0) n = 0;
            return sys().read(fd, n);
        };
        F.readall = function (self) {
            if (!self.$wfs) {
                const ba = _b_.bytearray.$factory();
                origReadinto.call(this, self, ba); ba.ob_type = _b_.bytes; return ba;
            }
            return F.read(self, -1);
        };
        F.write = function (self, b) {
            checkOpen(self);
            return sys().write(self.$wfd, b);
        };
        F.seek = function (self, pos, whence) {
            checkOpen(self);
            return sys().lseek(self.$wfd, pos, whence === undefined ? 0 : whence);
        };
        F.tell = function (self) {
            checkOpen(self);
            return sys().lseek(self.$wfd, 0, 1);
        };
        F.truncate = function (self, size) {
            checkOpen(self);
            const n = (size === undefined || size === _b_.None)
                ? sys().lseek(self.$wfd, 0, 1) : size;
            sys().ftruncate(self.$wfd, n);
            return n;
        };
        F.flush = function (self) { return _b_.None; };
        F.close = function (self) {
            if (self.closed) return _b_.None;
            if (self.$wfs && self.$closefd !== false) {
                try { sys().close(self.$wfd); } catch (e) {}
            }
            self.closed = true; self.fd = -1;
            return _b_.None;
        };
        F.fileno = function (self) { checkOpen(self); return self.$wfd; };
        F.readable = function (self) {
            return self.$wfs ? B.$bool(self.readable) : origReadable.call(this, self);
        };
        F.writable = function (self) {
            return self.$wfs ? B.$bool(self.writable) : origWritable.call(this, self);
        };
        F.seekable = function (self) {
            return self.$wfs ? B.$bool(self.seekable) : origSeekable.call(this, self);
        };

        installTypeMethods(B, FileIO, ['readinto', 'readall', 'read', 'write',
            'seek', 'tell', 'truncate', 'flush', 'close', 'fileno',
            'readable', 'writable', 'seekable'], '_io');

        // Brython has no BufferedWriter/Random and _io.open wraps the raw in one.
        // For fd-backed raws a pass-through is enough (FileIO is already
        // seekable/buffered by the FS); define them as thin identity callables.
        function passThrough(raw) { return raw; }
        if (!B._BufferedWriter) B._BufferedWriter = passThrough;
        if (!B._BufferedRandom) B._BufferedRandom = passThrough;

        installTextIO(B, FileIO);
    }

    // ---- TextIOWrapper: writable, fd-backed text over a raw FileIO ----------
    function installTextIO(B, FileIO) {
        const _b_ = B.builtins;
        const T = B._TextIOWrapper;
        if (!T) { console.warn('[wasthon-io] $B._TextIOWrapper missing'); return; }
        const RF = FileIO.tp_funcs;
        const origFactory = T.$factory;

        T.$factory = function () {
            const $ = B.args('TextIOWrapper', 6,
                { buffer: null, encoding: null, errors: null, newline: null,
                  line_buffering: null, write_through: null }, arguments,
                { encoding: 'utf-8', errors: _b_.None, newline: _b_.None,
                  line_buffering: _b_.False, write_through: _b_.False });
            const buf = $.buffer;
            if (!buf || !buf.$wfs) return origFactory.apply(this, arguments);
            const enc = ($.encoding === _b_.None) ? 'utf-8' : $.encoding;
            const res = {
                ob_type: T, $wfs: true, $raw: buf, $buffer: buf, $encoding: enc,
                $errors: ($.errors === _b_.None) ? 'strict' : $.errors,
                $newline: ($.newline === _b_.None) ? null : $.newline,
                $text: undefined, $text_pos: 0, $cache_start: 0, closed: false,
            };
            B.init_dict(res);
            return res;
        };

        const checkOpen = (s) => {
            if (s.closed) B.RAISE(_b_.ValueError, 'I/O operation on closed file');
        };
        // pull the whole tail of the underlying file into a decoded string cache
        function ensureText(s) {
            if (s.$text !== undefined) return;
            s.$cache_start = RF.tell(s.$raw);
            const bytesObj = RF.read(s.$raw, -1);
            let txt = B.$getattr(bytesObj, 'decode')(s.$encoding, s.$errors);
            if (s.$newline === null) {                 // universal newlines
                txt = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            }
            s.$text = txt;
            s.$text_pos = 0;
        }
        function bytelen(s, str) {
            if (str.length === 0) return 0;
            return _b_.len(B.$getattr(str, 'encode')(s.$encoding, s.$errors));
        }

        const G = T.tp_funcs;
        const origRead = G.read, origReadline = G.readline, origSeek = G.seek;
        const origWrite = G.write, origFlush = G.flush;

        G.read = function () {
            const $ = B.args('read', 2, { self: null, size: null }, arguments, { size: -1 });
            const s = $.self;
            if (!s.$wfs) return origRead.apply(this, arguments);
            checkOpen(s);
            ensureText(s);
            const size = ($.size === _b_.None) ? -1 : $.size;
            let res;
            if (size < 0) { res = s.$text.slice(s.$text_pos); s.$text_pos = s.$text.length; }
            else { res = s.$text.slice(s.$text_pos, s.$text_pos + size); s.$text_pos += res.length; }
            return B.String(res);
        };
        G.readline = function () {
            const $ = B.args('readline', 2, { self: null, size: null }, arguments, { size: -1 });
            const s = $.self;
            if (!s.$wfs) return origReadline.apply(this, arguments);
            checkOpen(s);
            ensureText(s);
            if (s.$text_pos >= s.$text.length) return B.String('');
            // line split depends on the newline mode (CPython TextIOWrapper):
            // null (=None) → text was translated in ensureText, split on '\n';
            // ''           → untranslated universal: \r\n, \r or \n, kept;
            // explicit     → split only on that exact terminator.
            const t = s.$text;
            let end;
            if (s.$newline === null || s.$newline === '\n') {
                const nl = t.indexOf('\n', s.$text_pos);
                end = (nl === -1) ? t.length : nl + 1;
            } else if (s.$newline === '') {
                const cr = t.indexOf('\r', s.$text_pos);
                const lf = t.indexOf('\n', s.$text_pos);
                if (cr === -1 && lf === -1) end = t.length;
                else if (cr === -1 || (lf !== -1 && lf < cr)) end = lf + 1;
                else end = (t[cr + 1] === '\n') ? cr + 2 : cr + 1;
            } else {
                const nl = t.indexOf(s.$newline, s.$text_pos);
                end = (nl === -1) ? t.length : nl + s.$newline.length;
            }
            const res = t.slice(s.$text_pos, end);
            s.$text_pos = end;
            return B.String(res);
        };
        G.__next__ = function (s) {
            const line = G.readline(s);
            if (line === '' || (line && line.length === 0)) B.RAISE(_b_.StopIteration, '');
            return line;
        };
        G.__iter__ = function (s) { return s; };
        G.write = function (s, txt) {
            checkOpen(s);
            if (!s.$wfs) {
                // not an fd-backed text file (e.g. text over a compression
                // file): delegate to the base wrapper's write
                if (origWrite) return origWrite.call(this, s, txt);
                B.RAISE(_b_.OSError, 'not writable');
            }
            if (s.$text !== undefined) {           // switch read→write: resync raw pos
                RF.seek(s.$raw, s.$cache_start + bytelen(s, s.$text.slice(0, s.$text_pos)), 0);
                s.$text = undefined;
            }
            RF.write(s.$raw, B.$getattr(txt, 'encode')(s.$encoding, s.$errors));
            return _b_.len(txt);
        };
        G.seek = function (s, offset, whence) {
            if (!s.$wfs) return origSeek.call(this, s, offset, whence);
            checkOpen(s);
            RF.seek(s.$raw, offset, whence === undefined ? 0 : whence);
            s.$text = undefined; s.$text_pos = 0;
            return offset;
        };
        G.tell = function (s) {
            checkOpen(s);
            if (s.$text === undefined) return RF.tell(s.$raw);
            return s.$cache_start + bytelen(s, s.$text.slice(0, s.$text_pos));
        };
        G.flush = function (s) {
            if (s.$wfs) { RF.flush(s.$raw); return _b_.None; }
            if (origFlush) return origFlush.call(this, s);
            return _b_.None;
        };
        G.truncate = function (s, size) {
            checkOpen(s);
            return s.$wfs ? RF.truncate(s.$raw, size) : _b_.None;
        };
        G.close = function (s) {
            if (s.closed) return _b_.None;
            if (s.$wfs) RF.close(s.$raw);
            else if (s.$buffer !== undefined) {
                // text over a non-fd binary buffer (e.g. compression file):
                // close it — that's what flushes the compressor's output
                const c = B.$getattr(s.$buffer, 'close', null);
                if (c !== null) B.$call(c);
            }
            s.closed = true; return _b_.None;
        };
        G.fileno = function (s) { return s.$wfs ? RF.fileno(s.$raw) : -1; };
        G.readable = function (s) { return s.$wfs ? B.$bool(s.$raw.readable) : B.$bool(1); };
        G.writable = function (s) {
            if (s.$wfs) return B.$bool(s.$raw.writable);
            const w = B.$getattr(s.$buffer, 'writable', null);
            return w !== null ? B.$call(w) : B.$bool(0);
        };
        G.seekable = function (s) { return B.$bool(1); };
        G.__enter__ = function (s) { return s; };
        G.__exit__ = function (s) { G.close(s); return _b_.False; };

        installTypeMethods(B, T, ['read', 'readline', 'seek', 'write', 'tell',
            'truncate', 'flush', 'close', 'fileno', 'readable', 'writable',
            'seekable', '__next__', '__iter__', '__enter__', '__exit__'], '_io');
        T.tp_iter = function (s) { return s; };
        T.tp_iternext = function (s) {
            const line = G.readline(s);
            if (!line || line.length === 0) return null;   // Brython: null → StopIteration
            return line;
        };
    }

    global.installWasthonIOWrite = installWasthonIOWrite;
})(window);
