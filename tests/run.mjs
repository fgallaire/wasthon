// Runs the bridge's unit tests in Node: Brython from loader/brython/, the
// _bridgetest module built by run.sh, and each test file given as argument.
// A test file reports through bt_fail(); any failure exits 1.
import fs from 'fs';
globalThis.window = globalThis; globalThis.self = globalThis; globalThis.module = {exports: {}};
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.document = {querySelectorAll: () => [], getElementsByTagName: () => [], addEventListener: () => {},
  createElement: () => ({style: {}, setAttribute() {}, appendChild() {}}),
  location: {href: 'file:///x.html', origin: 'file://', pathname: '/x.html', search: ''},
  head: {appendChild() {}}, body: null, currentScript: {src: 'file:///b.js'}, dispatchEvent() {},
  getElementById() { return null; }};
globalThis.location = document.location;
Object.defineProperty(globalThis, 'navigator', {value: {userAgent: 'node'}, configurable: true});

const B = new URL('../loader/brython/', import.meta.url).pathname;
(0, eval)(fs.readFileSync(B + 'brython.js', 'utf8'));
const $B = globalThis.__BRYTHON__;
globalThis.$B = $B; globalThis._b_ = $B.builtins;   // code Brython evaluates reads them as globals
(0, eval)(fs.readFileSync(B + 'brython_stdlib.js', 'utf8'));
$B.brython({debug: 0});

const factory = (await import(new URL('./build/_bridgetest.mjs', import.meta.url))).default;
const M = await factory();
M._wasthon_init();
const rt = M.wasthon;
$B.imported._bridgetest = rt.handles.get(M._PyInit__bridgetest());

// What the tests read and toggle on the runtime, as builtins: Node has no DOM,
// so neither `browser.window` nor `javascript.this()` reaches the globals.
let failed = 0;
Object.assign($B.builtins, {
  bt_handles: () => rt.handles.size,
  bt_refcounts: () => rt.refcounts.size,
  bt_set_nofree: (v) => { rt.noFree = !!v; },
  bt_set_noscopes: (v) => { rt.noScopeFree = !!v; },
  bt_fail: () => { failed++; },
});

for (const file of process.argv.slice(2)) {
  console.log(`== ${file}`);
  $B.runPythonSource(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), file.replace(/\W/g, '_'));
}
console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
