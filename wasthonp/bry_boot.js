/* Node boot for Brython's parser/codegen — used by the wasthonp harnesses
   (bench.js, validate2.js, superiority.js, m3b_stmt.js, m3c_exec.js).
   Loads the vendored brython.js with light DOM stubs so $B.Parser /
   $B._PyPegen / $B.py2js / $B.ast are available in node. */
globalThis.__BRYTHON__ = globalThis.__BRYTHON__ || {};
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' };
if (typeof globalThis.addEventListener === 'undefined') globalThis.addEventListener = function(){};
if (typeof globalThis.removeEventListener === 'undefined') globalThis.removeEventListener = function(){};
if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = function(){ this.open=function(){}; this.send=function(){}; };
if (typeof globalThis.location === 'undefined') globalThis.location = { href: 'file:///', search: '', pathname: '/' };
if (typeof globalThis.document === 'undefined') {
  const el = () => ({ style:{}, setAttribute(){}, appendChild(){}, getAttribute(){return null;},
                      addEventListener(){}, attributes:[], children:[] });
  globalThis.document = {
    createElement: el, createTextNode: el,
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(){}, documentElement: el(), body: el(),
    head: { appendChild(){} }, currentScript: { src: 'file:///' },
    location: globalThis.location,
  };
}
require(require('path').join(__dirname, '../loader/brython/brython.js'));
module.exports = globalThis.__BRYTHON__;
