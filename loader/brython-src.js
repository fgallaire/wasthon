// Brython source switch for the test / bench pages.
//
// Default: the VENDORED, patched Brython in ./brython/ — the build whose extra
// fixes (over stock 3.14.1) are tracked in ../BRYTHON_FIX.md, pending upstream.
// This is what GitHub Pages shows.
//
//   ?brython=cdn   loads the stock published Brython from the CDN instead.
//
// Having both lets us compare the two: confirm the vendored and CDN results
// converge as fixes land upstream, or catch a re-divergence later. A small
// fixed badge (added on DOMContentLoaded) flips the mode without hand-editing
// the URL. (Synchronous document.write so Brython is in place before the
// page's wasthon-loader / brython() call runs.)
(function () {
    var params = new URLSearchParams(location.search);
    var cdn = params.get('brython') === 'cdn';
    var base = cdn ? 'https://cdn.jsdelivr.net/npm/brython@3.14.3/' : './brython/';
    var core = cdn ? 'brython.min.js' : 'brython.js';
    document.write('<script src="' + base + core + '"><\/script>');
    document.write('<script src="' + base + 'brython_stdlib.js"><\/script>');

    document.addEventListener('DOMContentLoaded', function () {
        var target = new URLSearchParams(location.search);
        if (cdn) { target.delete('brython'); } else { target.set('brython', 'cdn'); }
        var qs = target.toString();
        var href = location.pathname + (qs ? '?' + qs : '');
        var el = document.createElement('div');
        el.title = 'Brython source — click to switch (reloads the page)';
        el.style.cssText = 'position:fixed;top:4px;right:4px;z-index:99999;' +
            'font:12px/1.4 system-ui,sans-serif;background:' + (cdn ? '#fde8ef' : '#e8f0fd') +
            ';border:1px solid #99a;border-radius:4px;padding:2px 7px;box-shadow:0 1px 3px #0003;';
        el.innerHTML = 'Brython: <b>' + (cdn ? 'CDN stock' : 'vendored') + '</b> &middot; ' +
            '<a href="' + href + '">→ ' + (cdn ? 'vendored' : 'CDN') + '</a>';
        document.body.appendChild(el);
    });
})();
