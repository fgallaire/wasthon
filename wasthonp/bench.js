/* parse-only benchmark: wasthonp (WASM CPython parser) vs Brython's JS parser. */
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");

// a realistic-ish module body (statements + expressions)
const SRC = `
def fib(n):
    if n < 2:
        return n
    a, b = 0, 1
    for i in range(2, n + 1):
        a, b = b, a + b
    return b

class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y
    def dist(self, other):
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5

data = [fib(i) for i in range(20) if i % 2 == 0]
total = sum(d * 2 for d in data) + len(data)
result = {k: v for k, v in zip(data, total) }
`.repeat(3);

function bench(name, fn, iters){
  fn(); // warmup
  const t0 = process.hrtime.bigint();
  for (let i=0;i<iters;i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(`  ${name.padEnd(22)} ${ (ms/iters).toFixed(3) } ms/parse   (${iters}x ${ms.toFixed(0)}ms)`);
  return ms/iters;
}

createWasthonp().then(M => {
  const parseW = M.cwrap("wasthonp_parse_only","number",["string"]);
  if (parseW(SRC) <= 0) { console.log("wasthonp failed to parse the bench source!"); return; }

  const N = 200;
  console.log(`\nparse-only benchmark — ${SRC.length} chars, ${N} iterations\n`);
  const w = bench("wasthonp (WASM)", () => parseW(SRC), N);
  const b = bench("Brython (JS parser)", () => {
      const p = new $B.Parser(SRC, "<b>", "file");
      $B._PyPegen.run_parser(p);
    }, N);
  console.log(`\n  → wasthonp is ${(b/w).toFixed(2)}x ${b>w?"faster":"slower"} than Brython's parser on this input`);
});
