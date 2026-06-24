/* Large-scale bug hunt: round-trip CPython 3.14's FULL stdlib (Lib/**.py)
 * through wasthonp vs Brython. Flags any file where wasthonp fails (parse/build/
 * codegen) while Brython succeeds — those are real bugs. */
const fs = require("fs"), path = require("path");
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");
const ast = $B.ast;
const rf = fs.readFileSync("realfile.js","utf8");
eval(rf.slice(rf.indexOf("// 1) decode"), rf.indexOf("function compile")));

/* Loader-level encoding handling (CPython/Brython do this before parsing):
 * detect the PEP 263 coding cookie, decode the raw bytes with TextDecoder, and
 * neutralize the cookie to utf-8 so the parser treats the text as UTF-8. */
function decodePySource(buf){
  const head = buf.slice(0, 200).toString("latin1");
  const m = head.match(/coding[:=]\s*([-\w.]+)/);
  let enc = m ? m[1].toLowerCase() : "utf-8";
  if (enc==="utf-8"||enc==="utf8"||enc==="ascii"||enc==="us-ascii")
    return buf.toString("utf-8");
  let text;
  try { text = new TextDecoder(enc).decode(buf); }
  catch(e){ text = buf.toString("latin1"); }   // unknown codec → latin-1 fallback
  // rewrite the cookie so the parser doesn't try to re-decode
  return text.replace(/(coding[:=]\s*)([-\w.]+)/, "$1utf-8");
}

const LIB = require("path").join(__dirname,"../external/Python-3.14.6/Lib");
const files = [];
(function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p = path.join(d,e.name);
  if(e.isDirectory()){ if(e.name!=="__pycache__") walk(p); }
  else if(e.name.endsWith(".py")) files.push(p);
}})(LIB);
files.sort();
const LIMIT = parseInt(process.argv[2]||files.length);

const norm = s => s.replace(/\\\n/g,"").replace(/([A-Za-z_])\d{4,}/g,"$1N")
  .replace(/set_lineno\(frame, \d+\)/g,"set_lineno(frame, L)").replace(/, \d+\)/g,", N)");

createWasthonp().then(M => {
  const dumpMod = M.cwrap("wasthonp_dump_module","string",["string"]);
  const dumpExpr= M.cwrap("wasthonp_dump","string",["string"]);
  const orig = $B._PyPegen.run_parser;
  let useW=false, lastErr="";
  $B._PyPegen.run_parser = function(p){
    if(useW && (p.mode==="file"||p.mode==="eval")){
      const j = p.mode==="eval" ? dumpExpr(p.src) : dumpMod(p.src);
      if(j.startsWith('{"error')){ lastErr="wasthonp parse: "+j; throw new Error(lastErr); }
      const t=JSON.parse(j);
      return p.mode==="eval" ? setpos(new ast.Expression(build(t)),t) : build(t);
    }
    return orig.apply(this,arguments);
  };

  let ok=0, ident=0, diff=0, wfail=0, bfail=0, bugs=[];
  const N = Math.min(LIMIT, files.length);
  for(let k=0;k<N;k++){
    const f=files[k], rel=path.relative(LIB,f);
    let src; try{ src=decodePySource(fs.readFileSync(f)); }catch(e){ continue; }
    // Brython native first (baseline)
    let jsB; try{ jsB=$B.py2js(src,"m","m").to_js(); }catch(e){ bfail++; continue; }
    // wasthonp
    let jsW, werr=null;
    try{ useW=true; jsW=$B.py2js(src,"m","m").to_js(); }catch(e){ werr=(lastErr||e.message); } finally{ useW=false; }
    if(werr){ wfail++; bugs.push(rel+"  ::  "+werr.slice(0,90)); continue; }
    if(norm(jsW)===norm(jsB)){ ident++; } else { diff++; }
    ok++;
  }
  console.log(`\n=== CPython 3.14 stdlib: ${N} files ===`);
  console.log(`wasthonp OK: ${ok}  (identical ${ident} / diff ${diff})   wasthonp-FAIL: ${wfail}   brython-skipped: ${bfail}`);
  if(bugs.length){ console.log(`\n--- wasthonp failures (Brython compiled these) ---`);
    for(const b of bugs.slice(0,40)) console.log("  ✗ "+b); if(bugs.length>40) console.log(`  …+${bugs.length-40} more`); }
});
