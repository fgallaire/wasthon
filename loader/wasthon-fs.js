/*
 * wasthon-fs.js — OPTIONAL MEMFS backing (not the default).
 *
 * Backs Brython's posix layer with the Emscripten in-memory filesystem (MEMFS)
 * of the wasthon WASM bundle, instead of the pure-JS store in wasthon-fs-mem.js
 * (which is the default and what ships). Same syscall hook + posix surface;
 * the writable io stack on top (wasthon-io-write.js) is unchanged.
 *
 * The ONE thing this gives over the JS store: files are shared with C code in
 * the wasm (e.g. sqlite opening a file DB sees what Python wrote). It costs
 * +~44 KB on the light bundle though, and benchmarks identical to the JS store
 * for Python-level I/O — so it is opt-in, for the day Python<->C file sharing
 * is actually needed.
 *
 * REQUIRES a bundle rebuilt with -sFORCE_FILESYSTEM=1 and "FS" in
 * EXPORTED_RUNTIME_METHODS (NOT in build.sh by default — add it scoped to
 * wasthon-full). Without that M.FS is undefined and this is a no-op.
 * Entry point: installWasthonFS(M).
 */
(function (global) {
    'use strict';

    function installWasthonFS(M) {
        const B = global.__BRYTHON__;
        if (!B || !M || !M.FS) {
            if (B && M && !M.FS) {
                console.warn('[wasthon-fs] M.FS not exported — rebuild with ' +
                    'FORCE_FILESYSTEM=1 + "FS" in EXPORTED_RUNTIME_METHODS.');
            }
            return;
        }
        const FS = M.FS;
        const _b_ = B.builtins;
        const raise = (exc, msg) => B.RAISE(exc, msg);

        // Emscripten MEMFS caps open fds at FS.MAX_OPEN_FDS (4096). Brython is a
        // tracing GC with no prompt finalization, so a file opened and dropped
        // without close() (e.g. test_bz2's testOpenDel does `o = BZ2File(f);
        // del o` 10000×) never releases its fd — on CPython the refcount-0 GC
        // closes it. The pure-JS store tolerated the leak (its handle table is
        // unbounded); raise the MEMFS cap so it behaves the same instead of
        // hitting EMFILE mid-suite and cascading every later file test to fail.
        try { if (typeof FS.MAX_OPEN_FDS === 'number') FS.MAX_OPEN_FDS = 1 << 22; } catch (e) {}

        // --- byte marshaling between Brython bytes/bytearray and Uint8Array ---
        function toU8(obj) {
            if (obj == null) return new Uint8Array(0);
            if (obj.source !== undefined) return Uint8Array.from(obj.source);
            if (ArrayBuffer.isView(obj)) {
                return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
            }
            if (Array.isArray(obj)) return Uint8Array.from(obj);
            // Buffer-protocol object with no .source (array.array, memoryview):
            // f.write(an_array) reaches here, so extract its bytes via tobytes()
            // — without this the write silently puts 0 bytes (test_array
            // test_filewrite: tofile then fromfile read too few bytes).
            try {
                var tb = B.$getattr(obj, 'tobytes', null);
                if (tb) {
                    var by = B.$call(tb);
                    if (by && by.source !== undefined) return Uint8Array.from(by.source);
                }
            } catch (e) {}
            return new Uint8Array(0);
        }
        const toBytes = (u8) => _b_.bytes.$factory(Array.from(u8));

        // Brython's posix O_* constants are the msvcrt values:
        //   O_RDONLY=0 O_WRONLY=1 O_RDWR=2 O_APPEND=8 O_CREAT=256 O_TRUNC=512 O_EXCL=1024
        // Emscripten FS.open wants a fopen-style mode string; translate.
        function flagsToMode(flags) {
            flags = flags | 0;
            const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 256, O_TRUNC = 512, O_APPEND = 8;
            const acc = flags & 3;
            if (flags & O_APPEND) return acc === O_RDWR ? 'a+' : 'a';
            if (acc === 0) return 'r';                                   // O_RDONLY
            if (acc === O_WRONLY) return 'w';                            // create/trunc write
            if (acc === O_RDWR) return (flags & (O_CREAT | O_TRUNC)) ? 'w+' : 'r+';
            return 'r';
        }
        // Normalize a Python path argument to a JS string before it reaches the
        // Emscripten FS: an os.PathLike (e.g. pathlib.Path, FakePath) resolves
        // via __fspath__, and bytes decode (utf-8). Without this, FS.stat/open
        // get the raw object and key it as '[object Object]' (test_zstd's
        // pathlib.Path filename tests). Mirrors wasthon-fs-mem.js's norm().
        const toPath = (p) => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object') {
                if (p.source !== undefined && p.charCodeAt === undefined) {
                    try { return new TextDecoder('utf-8').decode(Uint8Array.from(p.source)); }
                    catch (e) {}
                }
                try {
                    const f = B.$getattr(p, '__fspath__', null);
                    if (f !== null && f !== undefined) return toPath(B.$call(f));
                } catch (e) {}
            }
            return String(p);
        };
        const exists = (path) => {
            try { FS.stat(toPath(path)); return true; } catch (e) { return false; }
        };

        // the real posix.stat_result type — captured from the ORIGINAL Brython
        // stat (which builds it via $B.files) before we replace posix.stat.
        // Returning a plain object instead breaks str()/repr() of os.stat()
        // results across the stdlib (and os.path.exists's try/except OSError).
        let STAT_T = null;
        function statResult(infos) {
            if (!STAT_T) return infos;
            const res = { ob_type: STAT_T };
            B.init_dict(res);
            B.assign_dict(res, infos);
            return res;
        }
        function captureStatType(origStat) {
            if (STAT_T) return;
            try {
                B.files = B.files || {};
                const probe = '__wasthon_fs_probe__';
                B.files[probe] = { content: { length: 0 }, ctime: 0, mtime: 0 };
                STAT_T = origStat(probe).ob_type;
                delete B.files[probe];
            } catch (e) { STAT_T = null; }
        }
        function makeStat(s) {
            const sec = (x) => x == null ? 0
                : (x instanceof Date ? Math.floor(x.getTime() / 1000) : Math.floor(x));
            return statResult({
                st_mode: s.mode, st_ino: s.ino, st_dev: s.dev, st_nlink: s.nlink,
                st_uid: s.uid, st_gid: s.gid, st_rdev: s.rdev || 0, st_size: s.size,
                st_blksize: s.blksize || 4096, st_blocks: s.blocks || 0,
                st_atime: sec(s.atime), st_mtime: sec(s.mtime), st_ctime: sec(s.ctime),
                st_atime_ns: sec(s.atime) * 1e9, st_mtime_ns: sec(s.mtime) * 1e9,
                st_ctime_ns: sec(s.ctime) * 1e9,
            });
        }

        // --- FS-backed syscalls, shared by posix.* (Python os) and the io
        //     hook that wasthon-io-write.js builds FileIO on top of -----------
        const O_CREAT = 256, O_EXCL = 1024;
        const sys = {
            open: function (path, flags, mode) {
                // io.open patching is lazy; in every file flow os.open() fires
                // before io.open(), so install it here on first use.
                try {
                    if (B.$wasthon_io_ensureOpenPatched) B.$wasthon_io_ensureOpenPatched();
                } catch (e) {}
                path = toPath(path);
                flags = flags | 0;
                const there = exists(path);
                if ((flags & O_CREAT) && (flags & O_EXCL) && there) {
                    raise(_b_.FileExistsError, "File exists: '" + path + "'");
                }
                if (!(flags & O_CREAT) && !there) {
                    raise(_b_.FileNotFoundError, "No such file or directory: '" + path + "'");
                }
                return FS.open(path, flagsToMode(flags),
                    mode === undefined ? 0o666 : mode).fd;
            },
            close: function (fd) { FS.close(FS.getStream(fd)); return _b_.None; },
            read: function (fd, n) {
                const buf = new Uint8Array(n);
                const got = FS.read(FS.getStream(fd), buf, 0, n);
                return toBytes(buf.subarray(0, got));
            },
            write: function (fd, data) {
                const u8 = toU8(data);
                return FS.write(FS.getStream(fd), u8, 0, u8.length);
            },
            lseek: function (fd, pos, how) {
                const st = FS.getStream(fd);
                if (!st) raise(_b_.OSError, 'bad file descriptor: ' + fd);
                /* `how` arrives as a sentinel OBJECT when Python omitted the
                 * whence argument (f.seek(0)) — `how || 0` kept the object
                 * (truthy) and MEMFS rejected it with EINVAL, so the single
                 * most common seek in existence failed. Coerce to a number,
                 * defaulting to SEEK_SET. */
                let w = typeof how === 'number' ? how : Number(how);
                if (!Number.isFinite(w)) w = 0;
                try {
                    return FS.llseek(st, pos, w);
                } catch (e) {
                    /* Emscripten throws a bare ErrnoError object; letting it
                     * escape surfaces as a JavascriptError whose own str()
                     * fails ("<exception str() failed>"). Translate. */
                    raise(_b_.OSError, 'lseek(fd=' + fd + ', pos=' + pos +
                          ', whence=' + w + ') failed: errno=' +
                          (e && e.errno) + ' ' + (e && (e.message || e.name || e)));
                }
            },
            ftruncate: function (fd, len) { FS.ftruncate(fd, len); return _b_.None; },
            // dup: a fresh fd on the same node at the same position — numpy's
            // longdouble TestFileBased reaches it through the tempfile/io
            // machinery. Emscripten MEMFS has no dup; reopen the stream's
            // path with its original flags and seek to the current offset.
            dup: function (fd) {
                const st = FS.getStream(fd);
                if (!st) raise(_b_.OSError, 'bad file descriptor: ' + fd);
                const st2 = FS.open(st.path, st.flags, 0o666);
                try { FS.llseek(st2, st.position, 0); } catch (e) {}
                return st2.fd;
            },
            exists: exists,
        };

        // --- fd-level posix functions, backed by MEMFS ----------------------
        function augmentPosix(posix) {
            captureStatType(posix.stat);   // grab stat_result type before override

            posix.open = sys.open;
            // Brython's getcwd returns $B.brython_path (a page URL), so
            // os.path.abspath turns every relative filename into a URL and
            // importlib's spec_from_file_location bypasses MEMFS entirely.
            // With a real FS mounted the honest cwd is the FS one ('/').
            posix.getcwd = function () { return FS.cwd(); };
            posix.close = sys.close;
            posix.read = sys.read;
            posix.write = sys.write;
            posix.lseek = sys.lseek;
            posix.ftruncate = sys.ftruncate;
            posix.dup = sys.dup;
            posix.fstat = function (fd) {
                // FS.stat(stream.path) fails on unlinked-but-open fds; fall back
                // to the live node when the path is gone.
                const st = FS.getStream(fd);
                let raw;
                try { raw = FS.stat(st.path); }
                catch (e) { raw = { mode: 0, ino: st.node ? st.node.id : 0, dev: 1, nlink: 1,
                    uid: 0, gid: 0, size: st.node ? st.node.usedBytes || 0 : 0, blksize: 4096 }; }
                return makeStat(raw);
            };
            posix.fsync = function () { return _b_.None; };
            // no real tty in the browser: returning true sends interactive code
            // paths waiting for input and hangs the suite.
            posix.isatty = function () { return false; };
            posix.unlink = function (path) {
                path = toPath(path);
                if (!exists(path)) raise(_b_.FileNotFoundError,
                    "No such file or directory: '" + path + "'");
                FS.unlink(path); return _b_.None;
            };
            posix.remove = posix.unlink;
            posix.mkdir = function (path, mode) {
                FS.mkdir(toPath(path), mode === undefined ? 0o777 : mode); return _b_.None;
            };
            posix.rmdir = function (path) { FS.rmdir(toPath(path)); return _b_.None; };
            // torch.serialization chmod's saved checkpoints (mirror_to_file);
            // MEMFS tracks modes natively
            posix.chmod = function (path, mode) { FS.chmod(toPath(path), mode); return _b_.None; };
            posix.rename = function (src, dst) { FS.rename(toPath(src), toPath(dst)); return _b_.None; };
            posix.replace = posix.rename;
            posix.stat = function (path) {
                path = toPath(path);
                if (!exists(path)) raise(_b_.FileNotFoundError,
                    "No such file or directory: '" + path + "'");
                return makeStat(FS.stat(path));
            };
            posix.lstat = function (path) {
                path = toPath(path);
                if (!exists(path)) raise(_b_.FileNotFoundError,
                    "No such file or directory: '" + path + "'");
                return makeStat(FS.lstat(path));
            };
            posix.access = function (path) { return exists(path); };
            posix.utime = function (path, times) {
                path = toPath(path);
                if (!exists(path)) raise(_b_.FileNotFoundError,
                    "No such file or directory: '" + path + "'");
                let at, mt;
                if (times === undefined || times === _b_.None) {
                    at = mt = Date.now();
                } else {   // (atime, mtime) in seconds
                    at = Number(times[0]) * 1000; mt = Number(times[1]) * 1000;
                }
                FS.utime(path, at, mt); return _b_.None;
            };
            posix.listdir = function (path) {
                path = toPath(path);
                if (!exists(path)) raise(_b_.FileNotFoundError,
                    "No such file or directory: '" + path + "'");
                let names;
                try { names = FS.readdir(path || '.'); }
                catch (e) { raise(_b_.NotADirectoryError, "Not a directory: '" + path + "'"); }
                return _b_.list.$factory(names.filter((n) => n !== '.' && n !== '..'));
            };
            // NB: deliberately do NOT define posix.O_TMPFILE — its mere presence
            // makes tempfile take an opener path that bit-ors an undefined flag.
            return posix;
        }

        // posix is a JS module registered via $B.addToImported('posix', module).
        // Augment it whether already imported or not, BEFORE the original
        // addToImported runs (so it stamps $infos on our functions — otherwise
        // bound-method __name__/__qualname__ crash).
        if (B.imported && B.imported.posix) augmentPosix(B.imported.posix);
        const origAdd = B.addToImported;
        if (origAdd && !origAdd.$wasthonFS) {
            const wrapped = function (name, modobj) {
                if (name === 'posix' && modobj) augmentPosix(modobj);
                return origAdd.call(this, name, modobj);
            };
            wrapped.$wasthonFS = true;
            B.addToImported = wrapped;
        }

        // hand the io layer the syscall surface it builds FileIO on (and the
        // existence check that lets it reopen a written file by name), then
        // bring up the writable io stack.
        B.$wasthon_io_hooks = sys;          // { open, close, read, write, lseek, ftruncate, exists }
        B.$wasthon_fs = { FS: FS, toU8: toU8, toBytes: toBytes };
        if (typeof global.installWasthonIOWrite === 'function') {
            try { global.installWasthonIOWrite(B); }
            catch (e) { console.error('[wasthon-fs] io-write install failed:', e); }
        } else {
            console.warn('[wasthon-fs] wasthon-io-write.js not loaded — ' +
                'writable file I/O unavailable.');
        }
    }

    global.installWasthonFS = installWasthonFS;
})(window);
