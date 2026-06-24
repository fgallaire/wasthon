/* wasthonp END-TO-END EXECUTION: parse with wasthonp (WASM) → $B.ast →
 * Brython's exec → read the result. Proves programs actually RUN correctly via
 * wasthonp's parser, not just that the codegen text matches. */
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");
const ast = $B.ast;

// 1) decode a single Python string literal → its REAL runtime value
function pyDecode(t){
  let i=0, raw=false;
  while(i<t.length && /[rbfuRBFU]/.test(t[i])){ if(t[i].toLowerCase()==='r') raw=true; i++; }
  let body=t.slice(i);
  let q = (body.slice(0,3)==='"""'||body.slice(0,3)==="'''") ? body.slice(0,3) : body[0];
  body = body.slice(q.length, body.length-q.length);
  if(raw) return body;
  let out="", k=0, S={n:"\n",t:"\t",r:"\r","\\":"\\","'":"'",'"':'"',a:"\x07",b:"\b",f:"\f",v:"\v"};
  while(k<body.length){
    let c=body[k++];
    if(c!=="\\"){ out+=c; continue; }
    let e=body[k++];
    if(e in S) out+=S[e];
    else if(e>="0"&&e<="7"){ let o=e; while(o.length<3 && body[k]>="0"&&body[k]<="7") o+=body[k++]; out+=String.fromCharCode(parseInt(o,8)); }
    else if(e==="x"){ out+=String.fromCharCode(parseInt(body.substr(k,2),16)); k+=2; }
    else if(e==="u"){ out+=String.fromCharCode(parseInt(body.substr(k,4),16)); k+=4; }
    else if(e==="U"){ out+=String.fromCodePoint(parseInt(body.substr(k,8),16)||0); k+=8; }
    else if(e==="\n"){ /* line continuation */ }
    else if(e==="N" && body[k]==="{"){ let j=body.indexOf("}",k); out+="\\N"+body.slice(k,j+1); k=j+1; }
    else out+="\\"+e; // invalid escape: Python keeps the backslash
  }
  return out;
}
// 2) re-encode a runtime string for JS embedding (Brython's Constant.to_js does
//    `'${value}'` with NO escaping, so the stored value must already be JS-ready).
function jsEnc(v){ const m={"\\":"\\\\","'":"\\'","\n":"\\n","\r":"\\r","\t":"\\t","\b":"\\b","\f":"\\f","\v":"\\v"};
  return v.replace(/[\\'\n\r\t\b\f\v]/g, c=>m[c]); }  // JS named escapes only; other control chars stay raw (matches Brython)
function litValue(t){
  if (/^[0-9][0-9_]*$/.test(t)){ const v=parseInt(t.replace(/_/g,''),10); return Number.isSafeInteger(v)?v:BigInt(t.replace(/_/g,'')); }
  if (/^0[xX][0-9a-fA-F_]+$/.test(t)){ const s='0x'+t.replace(/_/g,'').slice(2); const v=Number(s); return Number.isSafeInteger(v)?v:BigInt(s); }
  if (/^0[oO][0-7_]+$/.test(t)){ return parseInt(t.replace(/_/g,'').slice(2),8); }
  if (/^0[bB][01_]+$/.test(t)){ return parseInt(t.replace(/_/g,'').slice(2),2); }
  if (/^[0-9][0-9_.eE]*[jJ]$/.test(t)) return $B.make_complex(0, parseFloat(t.slice(0,-1).replace(/_/g,'')));
  if (/[.eE]/.test(t) && /^[0-9]/.test(t)) return $B.fast_float(parseFloat(t));
  if (t==="True") return true; if (t==="False") return false; if (t==="None") return _b_.None;
  if (/^[rbfuRBFU]*['"]/.test(t)){ const pfx=(t.match(/^[rbfuRBFU]*/)[0]||'').toLowerCase(); const v=decodeConcat(t); if(pfx.includes('b')){ const a=[]; for(let i=0;i<v.length;i++)a.push(v.charCodeAt(i)&255); return _b_.bytes.$factory($B.$list(a)); } return jsEnc(v); }  // runtime value, JS-encoded for Brython's to_js
  return t;
}
// implicit string concatenation: a Constant's source span may hold several
// adjacent string literals ("a" "b") — scan, decode each (→ runtime), concat.
function decodeConcat(s){
  let out="", i=0;
  while(i<s.length){
    while(i<s.length && /\s/.test(s[i])) i++;
    if(i>=s.length) break;
    let start=i;
    while(i<s.length && /[rbfuRBFU]/.test(s[i])) i++;
    let q = (s.substr(i,3)==='"""'||s.substr(i,3)==="'''") ? s.substr(i,3)
          : (s[i]==='"'||s[i]==="'") ? s[i] : null;
    if(q===null) break;
    let raw = s.slice(start,i).toLowerCase().includes('r');
    i+=q.length;
    while(i<s.length){
      if(!raw && s[i]==='\\'){ i+=2; continue; }
      if(s.substr(i,q.length)===q) break;
      i++;
    }
    i+=q.length;
    out += pyDecode(s.slice(start,i));
  }
  return out;
}


function setpos(n,j){ for(const p of ["lineno","col_offset","end_lineno","end_col_offset"]) if(j[p]!==undefined) n[p]=j[p]; return n; }
function build(j){
  if (j===null||j===undefined) return undefined;
  if (Array.isArray(j)) return $B.$list(j.map(build));
  if (typeof j!=="object") return j;
  if (j._type==="Constant") return setpos(new ast.Constant(litValue(j.value), undefined), j);
  const spec=$B.ast_classes[j._type];
  if (spec===undefined) throw new Error("unknown node "+j._type);
  if (spec==="") return setpos(new ast[j._type](), j);
  const fields=spec.split(",").map(f=>f.replace(/[*?]/g,""));
  return setpos(new ast[j._type](...fields.map(f=>build(j[f]))), j);
}

createWasthonp().then(M => {
  const dumpMod = M.cwrap("wasthonp_dump_module","string",["string"]);
  // establish a root Brython frame (no module is running in node)
  const rootns = { __name__: "__main__", __builtins__: _b_.__builtins__ };
  $B.enter_frame(["__main__", rootns, "__main__", rootns], "<root>", 1);

  function run(src, resultVar){
    const tree = build(JSON.parse(dumpMod(src)));         // wasthonp WASM → $B.ast
    const code = { ob_type: $B.code, mode:"exec", filename:"<wasthonp>", src, _ast:{ $js_ast: tree } };
    const G = $B.empty_dict();
    _b_.exec(code, G, _b_.None);                          // Brython runs it
    const v = $B.$getitem(G, resultVar);                  // read the result var
    return _b_.repr(v);
  }

  const CASES = [
    ["fib(10) via recursion", `
def fib(n):
    if n < 2:
        return n
    return fib(n-1) + fib(n-2)
result = fib(10)`, "result", "55"],
    ["list comprehension + sum", `result = sum(i*i for i in range(5))`, "result", "30"],
    ["class + method", `
class Counter:
    def __init__(self):
        self.n = 0
    def add(self, k):
        self.n += k
        return self.n
c = Counter()
c.add(10)
result = c.add(5)`, "result", "15"],
    ["dict/set/comprehension", `result = {k: k*k for k in range(4)}`, "result", "{0: 0, 1: 1, 2: 4, 3: 9}"],
    ["match statement", `
def kind(x):
    match x:
        case 0:
            return "zero"
        case [a, b]:
            return "pair"
        case _:
            return "other"
result = kind([1, 2])`, "result", "'pair'"],
    ["try/except + f-string", `
def safe(x):
    try:
        return 10 // x
    except ZeroDivisionError:
        return -1
result = f"{safe(2)},{safe(0)}"`, "result", "'5,-1'"],
    ["generators + closures", `
def adder(n):
    return lambda x: x + n
add5 = adder(5)
result = list(map(add5, [1, 2, 3]))`, "result", "[6, 7, 8]"],
    ["string escapes (\\x \\t octal)", `result = len("A\\tB"), "A\\x42C", ord("\\101")`, "result", "(3, 'ABC', 65)"],
    ["raw string + invalid escape", `result = (r"\\d+", "\\d+")`, "result", "('\\\\d+', '\\\\d+')"],
  ];

  let pass=0;
  for (const [name, src, rv, expect] of CASES){
    let got;
    try { got = run(src, rv); } catch(e){ console.log(`✗ ${name}: ${e.message}`); continue; }
    const ok = got === expect;
    console.log(`${ok?"✅":"✗"} ${name}  → ${rv} = ${got}${ok?"":"  (expected "+expect+")"}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${CASES.length} programs RAN correctly via wasthonp's parser → Brython exec`);
});
