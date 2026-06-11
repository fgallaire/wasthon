/*
 * wasthon-fs-mem.js — a tiny pure-JavaScript in-memory filesystem backing
 * Brython's posix layer, so the writable io stack (wasthon-io-write.js) does
 * real in-browser file I/O with NO wasm. Zero wasthon dependency — generic
 * Brython code (stock Brython, which has no filesystem at all, would gain
 * in-browser writable files from it). Upstream candidate (see BRYTHON_FIX.md).
 *
 * Files live in JS memory only (ephemeral, per page load) — exactly the
 * semantics tempfile/round-trip code expects. Covers Python-level file I/O
 * (open/tempfile/csv/bz2/…); a wasm C extension reading a file at the fd level
 * (e.g. sqlite on a file DB) would not see these — out of scope here.
 *
 * Entry point: installWasthonFSMem(B), B = __BRYTHON__. Sets B.$wasthon_io_hooks
 * and augments posix, then brings up the io stack via installWasthonIOWrite.
 */
(function (global) {
    'use strict';

    function installWasthonFSMem(B) {
        if (!B) return;
        const _b_ = B.builtins;
        const raise = (exc, msg) => B.RAISE(exc, msg);

        function toU8(obj) {
            if (obj == null) return new Uint8Array(0);
            if (obj.source !== undefined) return Uint8Array.from(obj.source);
            if (ArrayBuffer.isView(obj)) {
                return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
            }
            if (Array.isArray(obj)) return Uint8Array.from(obj);
            // Python buffer-protocol objects (e.g. wasthon C arrays,
            // memoryviews): materialize their bytes. Silently writing 0
            // bytes here made f.write(array(...)) a no-op.
            if (obj.ob_type !== undefined || obj.__class__ !== undefined) {
                try {
                    const tb = B.$getattr(obj, 'tobytes', null);
                    const by = tb !== null ? B.$call(tb) : B.$call(_b_.bytes, obj);
                    if (by && by.source !== undefined) return Uint8Array.from(by.source);
                    if (by) return Uint8Array.from(B.$list(_b_.list.$factory(by)));
                } catch (e) {}
            }
            return new Uint8Array(0);
        }
        const toBytes = (u8) => _b_.bytes.$factory(Array.from(u8));

        // --- the store ------------------------------------------------------
        // node: { isDir, data:Uint8Array, size, mtime, ino }   (data cap >= size)
        const nodes = new Map();          // normalized path -> node
        const fds = new Map();            // fd -> { node, pos, readable, writable, append }
        let nextFd = 3, nextIno = 1;

        function norm(p) {
            if (p && typeof p === 'object' && p.charCodeAt === undefined) {
                // os.PathLike (e.g. Brython pathlib.Path reaching os.remove/
                // stat/...): resolve __fspath__ before stringifying, else the
                // key becomes '[object Object]'
                try {
                    const f = B.$getattr(p, '__fspath__', null);
                    if (f !== null && f !== undefined) p = B.$call(f);
                } catch (e) {}
            }
            p = String(p);
            if (p === '') return '.';
            const abs = p[0] === '/';
            const parts = [];
            for (const seg of p.split('/')) {
                if (seg === '' || seg === '.') continue;
                if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); }
                else parts.push(seg);
            }
            return (abs ? '/' : '') + parts.join('/') || (abs ? '/' : '.');
        }
        function mkNode(isDir) {
            return { isDir: isDir, data: new Uint8Array(0), size: 0,
                     mtime: Date.now() / 1000, ino: nextIno++ };
        }
        for (const d of ['/', '/tmp', '/var', '/var/tmp', '/usr', '/usr/tmp', '/home', '/dev', '/proc']) {
            nodes.set(d, mkNode(true));
        }
        function ensureCap(node, need) {
            if (need <= node.data.length) return;
            const cap = Math.max(need, node.data.length * 2 || 64);
            const grown = new Uint8Array(cap);
            grown.set(node.data.subarray(0, node.size));
            node.data = grown;
        }
        const exists = (p) => nodes.has(norm(p));
        const parentDir = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };

        const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 256, O_TRUNC = 512, O_APPEND = 8, O_EXCL = 1024;

        // --- syscall surface (the hook the io stack builds FileIO on) --------
        const sys = {
            open: function (path, flags) {
                try {
                    if (B.$wasthon_io_ensureOpenPatched) B.$wasthon_io_ensureOpenPatched();
                } catch (e) {}
                flags = flags | 0;
                const p = norm(path);
                let node = nodes.get(p);
                if (node && node.isDir) raise(_b_.IsADirectoryError, "Is a directory: '" + path + "'");
                if ((flags & O_CREAT) && (flags & O_EXCL) && node) {
                    raise(_b_.FileExistsError, "File exists: '" + path + "'");
                }
                if (!node) {
                    if (!(flags & O_CREAT)) raise(_b_.FileNotFoundError,
                        "No such file or directory: '" + path + "'");
                    if (!nodes.has(parentDir(p))) raise(_b_.FileNotFoundError,
                        "No such file or directory: '" + path + "'");
                    node = mkNode(false);
                    nodes.set(p, node);
                }
                if (flags & O_TRUNC) { node.data = new Uint8Array(0); node.size = 0; }
                const acc = flags & 3;
                const fd = nextFd++;
                fds.set(fd, { node: node, pos: (flags & O_APPEND) ? node.size : 0,
                    readable: acc !== O_WRONLY, writable: acc !== 0 || (flags & O_APPEND),
                    append: !!(flags & O_APPEND) });
                return fd;
            },
            close: function (fd) { fds.delete(fd); return _b_.None; },
            read: function (fd, n) {
                const f = fds.get(fd);
                const start = f.pos;
                const end = Math.min(start + n, f.node.size);
                const slice = f.node.data.subarray(start, end > start ? end : start);
                f.pos = end > start ? end : start;
                return toBytes(slice);
            },
            write: function (fd, data) {
                const f = fds.get(fd);
                if (f.append) f.pos = f.node.size;
                const u8 = toU8(data);
                ensureCap(f.node, f.pos + u8.length);
                f.node.data.set(u8, f.pos);
                f.pos += u8.length;
                if (f.pos > f.node.size) f.node.size = f.pos;
                f.node.mtime = Date.now() / 1000;
                return u8.length;
            },
            lseek: function (fd, pos, how) {
                const f = fds.get(fd);
                how = how || 0;
                f.pos = how === 0 ? pos : how === 1 ? f.pos + pos : f.node.size + pos;
                return f.pos;
            },
            ftruncate: function (fd, len) {
                const f = fds.get(fd);
                ensureCap(f.node, len);
                if (len > f.node.size) f.node.data.fill(0, f.node.size, len);
                f.node.size = len;
                return _b_.None;
            },
            exists: exists,
        };

        // --- stat_result (captured from Brython's own type) -----------------
        let STAT_T = null;
        function captureStatType(origStat) {
            try {
                B.files = B.files || {};
                const probe = '__wasthon_fs_probe__';
                B.files[probe] = { content: { length: 0 }, ctime: 0, mtime: 0 };
                STAT_T = origStat(probe).ob_type;
                delete B.files[probe];
            } catch (e) { STAT_T = null; }
        }
        function statOf(node) {
            const infos = {
                st_mode: node.isDir ? 0o040755 : 0o100644, st_ino: node.ino, st_dev: 1,
                st_nlink: 1, st_uid: 0, st_gid: 0, st_rdev: 0, st_size: node.size,
                st_blksize: 4096, st_blocks: Math.ceil(node.size / 512),
                st_atime: node.mtime, st_mtime: node.mtime, st_ctime: node.mtime,
                st_atime_ns: node.mtime * 1e9, st_mtime_ns: node.mtime * 1e9,
                st_ctime_ns: node.mtime * 1e9,
            };
            if (!STAT_T) return infos;
            const res = { ob_type: STAT_T };
            B.init_dict(res); B.assign_dict(res, infos);
            return res;
        }

        function augmentPosix(posix) {
            captureStatType(posix.stat);
            posix.open = sys.open;
            posix.close = sys.close;
            posix.read = sys.read;
            posix.write = sys.write;
            posix.lseek = sys.lseek;
            posix.ftruncate = sys.ftruncate;
            posix.fsync = function () { return _b_.None; };
            posix.isatty = function () { return false; };
            posix.fstat = function (fd) {
                const f = fds.get(fd);
                if (!f) raise(_b_.OSError, 'Bad file descriptor');
                return statOf(f.node);
            };
            posix.stat = function (path) {
                const node = nodes.get(norm(path));
                if (!node) raise(_b_.FileNotFoundError, "No such file or directory: '" + path + "'");
                return statOf(node);
            };
            posix.lstat = posix.stat;
            posix.access = function (path) { return exists(path); };
            posix.unlink = function (path) {
                const p = norm(path);
                if (!nodes.has(p)) raise(_b_.FileNotFoundError,
                    "No such file or directory: '" + path + "'");
                nodes.delete(p);   // open fds keep their node ref (unlinked-but-open)
                return _b_.None;
            };
            posix.remove = posix.unlink;
            posix.mkdir = function (path, mode) {
                const p = norm(path);
                if (nodes.has(p)) raise(_b_.FileExistsError, "File exists: '" + path + "'");
                nodes.set(p, mkNode(true));
                return _b_.None;
            };
            posix.rmdir = function (path) {
                const p = norm(path);
                if (!nodes.has(p)) raise(_b_.FileNotFoundError, "No such file or directory: '" + path + "'");
                nodes.delete(p); return _b_.None;
            };
            posix.rename = function (src, dst) {
                const s = norm(src);
                const node = nodes.get(s);
                if (!node) raise(_b_.FileNotFoundError, "No such file or directory: '" + src + "'");
                nodes.delete(s); nodes.set(norm(dst), node); return _b_.None;
            };
            posix.replace = posix.rename;
            posix.listdir = function (path) {
                const p = norm(path);
                const node = nodes.get(p);
                if (!node) raise(_b_.FileNotFoundError, "No such file or directory: '" + path + "'");
                if (!node.isDir) raise(_b_.NotADirectoryError, "Not a directory: '" + path + "'");
                const prefix = p === '/' ? '/' : p + '/';
                const out = [];
                for (const key of nodes.keys()) {
                    if (key === p) continue;
                    if (key.startsWith(prefix)) {
                        const rest = key.slice(prefix.length);
                        if (rest && rest.indexOf('/') === -1) out.push(rest);
                    }
                }
                return _b_.list.$factory(out);
            };
            // NB: do NOT define posix.O_TMPFILE (see wasthon-fs.js).
            return posix;
        }

        if (B.imported && B.imported.posix) augmentPosix(B.imported.posix);
        const origAdd = B.addToImported;
        if (origAdd && !origAdd.$wasthonFSMem) {
            const wrapped = function (name, modobj) {
                if (name === 'posix' && modobj) augmentPosix(modobj);
                return origAdd.call(this, name, modobj);
            };
            wrapped.$wasthonFSMem = true;
            B.addToImported = wrapped;
        }

        B.$wasthon_io_hooks = sys;
        B.$wasthon_fs_mem = { nodes: nodes, fds: fds };
        if (typeof global.installWasthonIOWrite === 'function') {
            try { global.installWasthonIOWrite(B); }
            catch (e) { console.error('[wasthon-fs-mem] io-write install failed:', e); }
        } else {
            console.warn('[wasthon-fs-mem] wasthon-io-write.js not loaded.');
        }
    }

    global.installWasthonFSMem = installWasthonFSMem;
})(window);
