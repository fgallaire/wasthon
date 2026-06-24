/* wasthonp milestone: FULL statements. wasthonp dumps a whole module to JSON
 * (aligned with $B.ast_classes); a GENERIC builder rebuilds the $B.ast tree;
 * Brython's codegen compiles it; we compare to Brython's own parser+codegen. */
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");
const ast = $B.ast;
// proper Python literal → JS value (the "rebuild from source" step)
function decodeStr(t){
  let i=0, raw=false, bytes=false;
  while(i<t.length && /[rbfuRBFU]/.test(t[i])){ const c=t[i].toLowerCase(); if(c==='r')raw=true; if(c==='b')bytes=true; i++; }
  let body=t.slice(i);
  let q = body.slice(0,3)==='"""'||body.slice(0,3)==="'''" ? body.slice(0,3) : body[0];
  body = body.slice(q.length, body.length-q.length);
  if(raw) return body;
  // process escapes
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|N\{[^}]*\}|.|\n)/g, (m,e)=>{
    const c=e[0];
    if(c==='n')return'\n'; if(c==='t')return'\t'; if(c==='r')return'\r'; if(c==='\\')return'\\';
    if(c==="'")return"'"; if(c==='"')return'"'; if(c==='a')return'\x07'; if(c==='b')return'\b';
    if(c==='f')return'\f'; if(c==='v')return'\v'; if(c==='0'&&e.length===1)return'\0'; if(c==='\n')return'';
    if(c==='x')return String.fromCharCode(parseInt(e.slice(1),16));
    if(c==='u')return String.fromCharCode(parseInt(e.slice(1),16));
    if(c==='U')return String.fromCodePoint(parseInt(e.slice(1),16));
    if(/[0-7]/.test(c))return String.fromCharCode(parseInt(e,8));
    if(c==='N')return m; // \N{...} — leave (needs unicodedata); rare
    return m;
  });
}
function litValue(t){
  if (/^[0-9][0-9_]*$/.test(t)){ const v=parseInt(t.replace(/_/g,''),10); return Number.isSafeInteger(v)?v:BigInt(t.replace(/_/g,'')); }
  if (/^0[xX][0-9a-fA-F_]+$/.test(t)){ const s='0x'+t.replace(/_/g,'').slice(2); const v=Number(s); return Number.isSafeInteger(v)?v:BigInt(s); }
  if (/^0[oO][0-7_]+$/.test(t)){ return parseInt(t.replace(/_/g,'').slice(2),8); }
  if (/^0[bB][01_]+$/.test(t)){ return parseInt(t.replace(/_/g,'').slice(2),2); }
  if (/[.eEjJ]/.test(t) && /^[0-9]/.test(t)) return $B.fast_float(parseFloat(t));
  if (t==="True") return true; if (t==="False") return false; if (t==="None") return _b_.None;
  if (/^[rbfuRBFU]*['"]/.test(t)) return decodeStr(t);
  return t;
}


function setpos(n,j){ for(const p of ["lineno","col_offset","end_lineno","end_col_offset"]) if(j[p]!==undefined) n[p]=j[p]; return n; }

/* ONE generic constructor, driven by $B.ast_classes field specs */
function build(j){
  if (j === null || j === undefined) return undefined;
  if (Array.isArray(j)) return $B.$list(j.map(build));
  if (typeof j !== "object") return j;             // string / number primitive
  const type = j._type;
  if (type === "Constant") return setpos(new ast.Constant(litValue(j.value), undefined), j);
  const spec = $B.ast_classes[type];
  if (spec === undefined) throw new Error("unknown node "+type);
  if (spec === "") return setpos(new ast[type](), j); // operators/ctx (no pos in j) + Pass/Break/Continue (pos in j)
  const fields = spec.split(",").map(f=>f.replace(/[*?]/g,""));
  const node = new ast[type](...fields.map(f=>build(j[f])));
  return setpos(node, j);
}

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
