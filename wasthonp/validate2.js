/* Large-scale bug hunt: round-trip CPython 3.14's FULL stdlib (Lib/**.py)
 * through wasthonp vs Brython. Flags any file where wasthonp fails (parse/build/
 * codegen) while Brython succeeds — those are real bugs. */
const fs = require("fs"), path = require("path");
const $B = require("./bry_boot.js");
globalThis.$B = $B; globalThis._b_ = $B.builtins;
const createWasthonp = require("./build/wasthonp_mod.js");
const WP = require("./wasthonp.js").bind($B);
const { decodePySource } = WP;

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
  const ctl = WP.install(M, {fallback:false});   // wasthonp errors throw (so we count them)

  let ok=0, ident=0, diff=0, wfail=0, bfail=0, bugs=[];
  const N = Math.min(LIMIT, files.length);
  for(let k=0;k<N;k++){
    const f=files[k], rel=path.relative(LIB,f);
    let src; try{ src=decodePySource(fs.readFileSync(f)); }catch(e){ continue; }
    // Brython native first (baseline) — wasthonp disabled
    let jsB; try{ jsB=$B.py2js(src,"m","m").to_js(); }catch(e){ bfail++; continue; }
    // wasthonp
    let jsW, werr=null;
    try{ ctl.enable(); jsW=$B.py2js(src,"m","m").to_js(); }catch(e){ werr=e.message; } finally{ ctl.disable(); }
    if(werr){ wfail++; bugs.push(rel+"  ::  "+werr.slice(0,90)); continue; }
    if(norm(jsW)===norm(jsB)){ ident++; } else { diff++; }
    ok++;
  }
  console.log(`\n=== CPython 3.14 stdlib: ${N} files ===`);
  console.log(`wasthonp OK: ${ok}  (identical ${ident} / diff ${diff})   wasthonp-FAIL: ${wfail}   brython-skipped: ${bfail}`);
  if(bugs.length){ console.log(`\n--- wasthonp failures (Brython compiled these) ---`);
    for(const b of bugs.slice(0,40)) console.log("  ✗ "+b); if(bugs.length>40) console.log(`  …+${bugs.length-40} more`); }
});
