/* Round-trip a REAL stdlib file through wasthonp → $B.ast → Brython codegen,
 * compared to Brython's own parser+codegen. The ultimate scale test. */
const fs = require("fs");
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");
const ast = $B.ast;
// proper Python literal → JS value (the "rebuild from source" step)
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
  return v.replace(/[\\'\n\r\t\b\f\v]/g, c=>m[c]); }  // → correct runtime value; Brython's multi-line pretty-print (\n + line-cont) is cosmetic
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
function compile(mod,src){ const fn="<string>",fu=$B.future_features(mod,fn),st=$B._PySymtable_Build(mod,fn,fu); return $B.js_from_root({ast:mod,symtable:st,filename:fn,src:src||""}).js; }
function logic(js){ return js.replace(/([A-Za-z_])\d{4,}/g,"$1N").replace(/'<string>'/g,"'F'").replace(/'undefined'/g,"'F'").replace(/set_lineno\(frame, \d+\)/g,"set_lineno(frame, L)").split("\n").map(l=>l.trim()).filter(Boolean).join("\n"); }

const path = process.argv[2] || "loader/cpython-tests/re/_parser.py";
const SRC = fs.readFileSync(require("path").join(__dirname,"..",path), "utf8");

createWasthonp().then(M => {
  const dumpMod = M.cwrap("wasthonp_dump_module","string",["string"]);
  console.log(`file: ${path}  (${SRC.length} chars, ${SRC.split("\n").length} lines)`);
  const t0=process.hrtime.bigint();
  const json = dumpMod(SRC);
  const t1=process.hrtime.bigint();
  if (json.startsWith('{"error')) { console.log("wasthonp:", json); return; }
  const tree = JSON.parse(json);
  console.log(`wasthonp parsed → ${tree.body.length} top-level stmts, ${json.length} bytes JSON, ${(Number(t1-t0)/1e6).toFixed(1)}ms`);
  let mod, jsA, jsB;
  try { mod = build(tree); } catch(e){ console.log("BUILD ERROR:", e.message); return; }
  try { jsA = compile(mod, SRC); } catch(e){ console.log("CODEGEN(wasthonp) ERROR:", e.message); return; }
  try { jsB = $B.py2js(SRC, "t", "t").to_js(); } catch(e){ console.log("Brython couldn't compile it either:", e.message); return; }
  const norm = s => s.replace(/([A-Za-z_])\d{4,}/g,"$1N").replace(/'<string>'/g,"'F'").replace(/'undefined'/g,"'F'").replace(/set_lineno\(frame, \d+\)/g,"set_lineno(frame, L)");
  const ok = norm(jsA) === norm(jsB);
  console.log("codegen identical to Brython (whole-string):", ok ? "YES ✅" : "no", `(${jsA.length} vs ${jsB.length} bytes)`);
  if (!ok){ const A=logic(jsA).split("\n"),B=logic(jsB).split("\n"); let diffs=0;
    for(let i=0;i<Math.max(A.length,B.length);i++) if(A[i]!==B[i]){ if(diffs<2) console.log(`  @${i}\n   A: ${A[i]}\n   B: ${B[i]}`); diffs++; }
    console.log("  total differing lines:", diffs, "/", Math.max(A.length,B.length)); }
});
