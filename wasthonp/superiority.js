/* "wasthonp > Brython?" — for every stdlib file Brython's OWN parser rejects,
 * check whether wasthonp parses it (= wasthonp handles 3.14 grammar Brython's
 * hand-written parser chokes on). */
const fs=require("fs"), path=require("path");
const $B=require("./bry_boot.js"); globalThis.$B=$B; globalThis._b_=$B.builtins;
const createWasthonp=require("./build/wasthonp_mod.js");
const WP=require("./wasthonp.js").bind($B);
const { decodePySource } = WP;

const LIB=require("path").join(__dirname,"../external/Python-3.14.6/Lib");
const files=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory()){if(e.name!=="__pycache__")w(p);} else if(e.name.endsWith(".py"))files.push(p);}})(LIB); files.sort();

createWasthonp().then(M=>{
  const ctl = WP.install(M);            // dormant hook; we use its raw handles directly
  const dumpMod = ctl.dumpMod, orig = ctl.origRun;

  const em = e => ((e&&e.message)||String(e)||"").slice(0,55);
  function brythonParses(src){ try{ const p=new $B.Parser(src,"<b>","file"); orig.call($B._PyPegen,p); return true; }catch(e){ return em(e); } }
  function wasthonpParses(src){ try{ const j=dumpMod(src); return j.startsWith('{"error') ? j.slice(0,40) : true; }catch(e){ return em(e); } }

  const cat = e => /XMLHttpRequest|fetch|readyState/.test(e) ? "env(XHR)"
                 : /is not defined|undefined|\[object Object\]|Cannot read/.test(e) ? "brython-internal"
                 : "SyntaxError";
  let env=0, internal=0, syn=0, both=0;
  for(const f of files){
    let src; try{ src=decodePySource(fs.readFileSync(f)); }catch(e){ continue; }
    const bp = brythonParses(src);
    if(bp===true) continue;
    const rel=path.relative(LIB,f), wres=wasthonpParses(src), c=cat(bp);
    if(wres!==true){ both++; continue; }   // both fail (e.g. badsyntax fixtures)
    if(c==="env(XHR)") env++;
    else if(c==="brython-internal"){ internal++; console.log(`⚠ brython-internal  ${rel}  :: ${bp}`); }
    else { syn++; console.log(`✅ GENUINE: Brython parser SyntaxError, wasthonp OK  ${rel}\n     ${bp}`); }
  }
  console.log(`\n--- of the files Brython's parser rejects but wasthonp parses ---`);
  console.log(`env-noise (XHR in node, not a parser gap): ${env}`);
  console.log(`brython-internal errors (Brython parser bugs): ${internal}`);
  console.log(`genuine Brython SyntaxError (wasthonp > Brython): ${syn}`);
  console.log(`both parsers fail (e.g. deliberate badsyntax fixtures): ${both}`);
});
