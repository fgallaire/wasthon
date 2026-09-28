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
// every test module run.sh linked: _PyInit__capi registers _capi
for (const k of Object.keys(M).filter(k => k.startsWith('_PyInit_'))) {
  $B.imported[k.slice(8)] = rt.handles.get(M[k]());
}

// What the tests read and toggle on the runtime, as builtins: Node has no DOM,
// so neither `browser.window` nor `javascript.this()` reaches the globals.
let failed = 0, bugs = 0, passed = 0, unit = false;
// the PASS lines of the unit tests (test_*.py, not lifetime.py), counted as
// they print (loader/test-bridge.html counts them too)
const print = console.log;
console.log = (...a) => { if (unit && a.join(' ').startsWith('PASS ')) passed++; print(...a); };
Object.assign($B.builtins, {
  bt_handles: () => rt.handles.size,
  bt_refcounts: () => rt.refcounts.size,
  bt_set_nofree: (v) => { rt.noFree = !!v; },
  bt_set_noscopes: (v) => { rt.noScopeFree = !!v; },
  bt_fail: () => { failed++; },
  bt_bug: () => { bugs++; },
  bt_reclaim: () => { $B.$wasthon_reclaim(); },
  bt_sample: () => {},        // lifetime.py's growth samples, drawn by the page only
});

// A test_*.py file holds pytest-style functions, the ones tests/cpython.sh
// runs with pytest: tests/runner.py, appended to it, runs them.
const RUN_TESTS = fs.readFileSync(new URL('runner.py', import.meta.url), 'utf8');

// tests/bridge_bugs.txt: the cases known to fail on the bridge, one per line
// as pytest names them (test_types.py::test_multiply[SpecObj]). They report
// BUG without failing the run.
const KNOWN = fs.readFileSync(new URL('bridge_bugs.txt', import.meta.url), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

for (const file of process.argv.slice(2)) {
  console.log(`== ${file}`);
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  // a JSON array of strings is also a Python list literal
  const base = file.split('/').pop();
  unit = base.startsWith('test_');
  const tests = unit
    ? `\n_LINES = ${JSON.stringify(src.split('\n'))}\n_FILE = ${JSON.stringify(base)}\n` +
      `_KNOWN = set(${JSON.stringify(KNOWN)})\n` + RUN_TESTS : '';
  $B.runPythonSource(src + tests, file.replace(/\W/g, '_'));
}
console.log(`${passed} passed, ${bugs} known bridge bugs, ${failed} failed`);
process.exit(failed ? 1 : 0);
