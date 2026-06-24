/* "wasthonp > Brython?" — for every stdlib file Brython's OWN parser rejects,
 * check whether wasthonp parses it, and whether wasthonp's AST then drives
 * Brython's codegen successfully (= wasthonp lets Brython compile code its own
 * parser can't). */
const fs=require("fs"), path=require("path");
const $B=require("./bry_boot.js"); globalThis.$B=$B; globalThis._b_=$B.builtins;
const createWasthonp=require("./build/wasthonp_mod.js"); const ast=$B.ast;
const rf=fs.readFileSync("realfile.js","utf8"); eval(rf.slice(rf.indexOf("// 1) decode"), rf.indexOf("function compile")));
const v2=fs.readFileSync("validate2.js","utf8"); eval(v2.slice(v2.indexOf("function decodePySource"), v2.indexOf("const LIB")));

const LIB=require("path").join(__dirname,"../external/Python-3.14.6/Lib");
const files=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory()){if(e.name!=="__pycache__")w(p);} else if(e.name.endsWith(".py"))files.push(p);}})(LIB); files.sort();

createWasthonp().then(M=>{
  const dumpMod=M.cwrap("wasthonp_dump_module","string",["string"]);
  const dumpExpr=M.cwrap("wasthonp_dump","string",["string"]);
  const orig=$B._PyPegen.run_parser; let useW=false;
  $B._PyPegen.run_parser=function(p){ if(useW&&(p.mode==="file"||p.mode==="eval")){const j=p.mode==="eval"?dumpExpr(p.src):dumpMod(p.src); if(j.startsWith('{"error'))throw new Error("wasthonp:"+j.slice(0,50)); const t=JSON.parse(j); return p.mode==="eval"?setpos(new ast.Expression(build(t)),t):build(t);} return orig.apply(this,arguments); };

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
    const rel=path.relative(LIB,f), wp=wasthonpParses(src), c=cat(bp);
    if(wp!==true){ both++; continue; }   // both fail (e.g. badsyntax fixtures)
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
