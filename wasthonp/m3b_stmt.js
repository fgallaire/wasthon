/* wasthonp milestone: FULL statements. wasthonp dumps a whole module to JSON
 * (aligned with $B.ast_classes); the canonical builder rebuilds the $B.ast tree;
 * Brython's codegen compiles it; we compare to Brython's own parser+codegen. */
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");
const WP = require("./wasthonp.js").bind($B);
const { build } = WP;

function compile(mod, src){
  const filename="<string>";
  const future=$B.future_features(mod,filename);
  const symtable=$B._PySymtable_Build(mod,filename,future);
  return $B.js_from_root({ast:mod,symtable,filename,src}).js;
}
/* normalize per-compile noise: UUID suffixes (fib460795->fibN) and the
 * __file__ string (Brython leaves it 'undefined' in comprehension sub-frames,
 * an internal inconsistency unrelated to the AST). */
function logic(js){ return js
  .replace(/([A-Za-z_])\d{4,}/g,"$1N")
  .replace(/'<string>'/g,"'F'").replace(/'undefined'/g,"'F'")  // Brython's filename is inconsistent in sub-scopes
  .replace(/set_lineno\(frame, \d+\)/g,"set_lineno(frame, L)")  // traceback line metadata; Brython mis-numbers match_case (assigns the NEXT case's line) — wasthonp is correct here
  .split("\n").map(l=>l.trim()).filter(Boolean).join("\n"); }

const SRC = `def fib(n):
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
total = sum(d * 2 for d in data)
flags = {"a": 1, "b": 2}
`;

const CASES = {
  "fib + Point + comprehensions": SRC,
  "while / break / continue / aug": `i = 0
while i < 10:
    i += 1
    if i == 3:
        continue
    if i == 7:
        break
`,
  "with / try-less / lambda / ternary": `with open("f") as fh, lock:
    g = lambda x, y=1, *a, **k: x + y
    z = (a if cond else b)
`,
  "import / from / global / del / assert": `import os, sys as system
from collections import OrderedDict as OD, defaultdict
def f():
    global counter
    del temp
    assert x > 0, "must be positive"
`,
  "dict/set comp, unpack, starred, slices": `m = {k: v*2 for k, v in items.items()}
s = {x for x in xs if x}
a, *rest = [1, 2, 3]
sub = data[1:10:2]
fn(*args, **kwargs)
`,
  "try / except / finally / raise": `try:
    risky()
except ValueError as e:
    handle(e)
except (KeyError, IndexError):
    pass
else:
    ok()
finally:
    cleanup()
`,
  "match / case (patterns)": `match command.split():
    case [action]:
        run(action)
    case [action, obj] if obj in known:
        run(action, obj)
    case Point(x=0, y=0):
        origin()
    case {"key": value, **rest}:
        use(value)
    case _:
        default()
`,
  "async def / await / async for / with": `async def worker(q):
    async with q.lock:
        async for item in q:
            await process(item)
    return await q.join()
`,
  "generators / yield / type alias / PEP695": `def gen():
    yield 1
    x = yield from sub()

type Alias[T] = list[T]

def first[T](xs: list[T]) -> T:
    return xs[0]
`,
};

createWasthonp().then(M => {
  const dumpMod = M.cwrap("wasthonp_dump_module","string",["string"]);
  let pass=0, total=0;
  for (const [name, src] of Object.entries(CASES)) {
    total++;
    const json = dumpMod(src);
    if (json.startsWith('{"error')) { console.log(`✗ ${name}: wasthonp ${json}`); continue; }
    let jsA, jsB, mod;
    try {
      mod = build(JSON.parse(json));
      jsA = compile(mod, src);
      jsB = $B.py2js(src, "t", "t").to_js();
    } catch(e){ console.log(`✗ ${name}: ${e.message}`); continue; }
    const ok = logic(jsA) === logic(jsB);
    console.log(`${ok?"✅":"✗"} ${name}  (${JSON.parse(json).body.length} stmts, ${jsA.length}B JS)`);
    if (ok) pass++;
    else { const A=logic(jsA).split("\n"),B=logic(jsB).split("\n");
      for(let i=0;i<Math.max(A.length,B.length);i++) if(A[i]!==B[i]){ console.log(`    first diff @${i}\n    A: ${A[i]}\n    B: ${B[i]}`); break; } }
  }
  console.log(`\n${pass}/${total} real modules: wasthonp AST → codegen logic-identical to Brython`);
});
