/* wasthonp.js — canonical drop-in glue between the wasthonp WASM parser and
 * Brython. Converts wasthonp's JSON AST to a $B.ast tree and hooks
 * $B._PyPegen.run_parser so Brython parses Python with wasthonp.
 *
 * Environment-agnostic (UMD): require() in node, <script src> global in the
 * browser (exposes `window.wasthonp`).
 *
 *   const wp = wasthonp.bind($B);          // bind to a Brython instance
 *   const M  = await createWasthonp();     // the wasthonp WASM module
 *   const ctl = wp.install(M);             // patch $B._PyPegen.run_parser
 *   ctl.enable();  ...run Python...  ctl.disable();
 *   wp.build(jsonAst)                      // JSON node → $B.ast node
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.wasthonp = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- decode a single Python string literal → its REAL runtime value ---
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
  // re-encode a runtime string for JS embedding (Brython's Constant.to_js emits
  // `'${value}'` with NO escaping, so the stored value must already be JS-ready).
  function jsEnc(v){ const m={"\\":"\\\\","'":"\\'","\n":"\\n","\r":"\\r","\t":"\\t","\b":"\\b","\f":"\\f","\v":"\\v"};
    return v.replace(/[\\'\n\r\t\b\f\v]/g, c=>m[c]); }
  // implicit string concatenation: a Constant span may hold adjacent literals
  // ("a" "b") — scan, decode each, concat.
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

  // PEP 263 coding-cookie source decode (loader-level; node Buffer input).
  function decodePySource(buf){
    const head = buf.slice(0, 200).toString("latin1");
    const m = head.match(/coding[:=]\s*([-\w.]+)/);
    let enc = m ? m[1].toLowerCase() : "utf-8";
    if(enc==="utf-8"||enc==="utf8"||enc==="ascii"||enc==="us-ascii") return buf.toString("utf-8");
    let text;
    try { text = new TextDecoder(enc).decode(buf); }
    catch(e){ text = buf.toString("latin1"); }
    return text.replace(/(coding[:=]\s*)([-\w.]+)/, "$1utf-8");
  }

  // Bind the glue to a specific Brython instance ($B).
  function bind($B){
    const _b_ = $B.builtins, ast = $B.ast;

    function litValue(t){
      if (/^[0-9][0-9_]*$/.test(t)){ const v=parseInt(t.replace(/_/g,''),10); return Number.isSafeInteger(v)?v:BigInt(t.replace(/_/g,'')); }
      if (/^0[xX][0-9a-fA-F_]+$/.test(t)){ const s='0x'+t.replace(/_/g,'').slice(2); const v=Number(s); return Number.isSafeInteger(v)?v:BigInt(s); }
      if (/^0[oO][0-7_]+$/.test(t)){ return parseInt(t.replace(/_/g,'').slice(2),8); }
      if (/^0[bB][01_]+$/.test(t)){ return parseInt(t.replace(/_/g,'').slice(2),2); }
      if (/^[0-9][0-9_.eE]*[jJ]$/.test(t)) return $B.make_complex(0, parseFloat(t.slice(0,-1).replace(/_/g,'')));
      if (/[.eE]/.test(t) && /^[0-9]/.test(t)) return $B.fast_float(parseFloat(t));
      if (t==="True") return true; if (t==="False") return false; if (t==="None") return _b_.None;
      if (/^[rbfuRBFU]*['"]/.test(t)){ const pfx=(t.match(/^[rbfuRBFU]*/)[0]||'').toLowerCase(); const v=decodeConcat(t); if(pfx.includes('b')){ const a=[]; for(let i=0;i<v.length;i++)a.push(v.charCodeAt(i)&255); return _b_.bytes.$factory($B.$list(a)); } return jsEnc(v); }
      return t;
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

    // Patch $B._PyPegen.run_parser to parse with wasthonp module M.
    //   opts.fallback (default true): on a wasthonp parse error, fall back to
    //   Brython's parser; if false, the error is thrown (used by validators).
    // Returns a controller: { enable(), disable(), lastParser, origRun,
    //                         dumpMod, dumpExpr }.
    function install(M, opts){
      opts = opts || {};
      const fallback = opts.fallback !== false;
      const dumpMod  = M.cwrap("wasthonp_dump_module","string",["string"]);
      const dumpExpr = M.cwrap("wasthonp_dump","string",["string"]);
      const origRun = $B._PyPegen.run_parser;
      const ctl = { enabled:false, lastParser:"", origRun, dumpMod, dumpExpr };
      $B._PyPegen.run_parser = function(parser){
        if(ctl.enabled && (parser.mode==='file'||parser.mode==='eval')){
          let json = null;
          try{ json = parser.mode==='eval' ? dumpExpr(parser.src) : dumpMod(parser.src); }
          catch(e){ if(!fallback) throw e; }   // wasm crash → fall back to Brython
          if(json !== null){
            if(!json.startsWith('{"error')){
              ctl.lastParser = "wasthonp (WASM CPython parser)";
              const tree = JSON.parse(json);
              return parser.mode==='eval' ? setpos(new ast.Expression(build(tree)), tree) : build(tree);
            }
            // wasthonp returned an error
            let parsed = null; try{ parsed = JSON.parse(json); }catch(_){}
            if(parsed && parsed.error && typeof parsed.error === 'object'){
              // a real SyntaxError caught by the CPython parser — raise the
              // faithful Brython exception (message+position from C); propagates.
              ctl.lastParser = "wasthonp (WASM CPython parser)";
              const e = parsed.error;
              const line = (parser.src.split('\n')[e.lineno-1]) || "";
              // C errtype reads NULL (stubbed) → infer the subclass from CPython's
              // exact message wording (TabError's "inconsistent use of tabs"
              // contains "indent", so test it first).
              const et = /inconsistent use of tabs/.test(e.msg) ? _b_.TabError
                       : /indent/.test(e.msg) ? _b_.IndentationError : _b_.SyntaxError;
              // Brython's raiser adds 1 to col_offset for display; the captured
              // offsets are already 1-based-equivalent, so pass them −1.
              const col = e.offset - 1;
              const endcol = (e.end_offset > 0 ? e.end_offset : e.offset) - 1;
              $B.raise_error_known_location(et, parser.filename, e.lineno, col,
                  e.end_lineno > 0 ? e.end_lineno : e.lineno, endcol, line, e.msg);
            }
            // a wasthonp internal limitation (not a syntax error) → fall back
            if(!fallback) throw new Error("wasthonp parse: "+json.slice(0,90));
          }
        }
        ctl.lastParser = "Brython (JS parser)";
        return origRun.apply(this, arguments);
      };
      ctl.enable  = function(){ ctl.enabled = true;  return ctl; };
      ctl.disable = function(){ ctl.enabled = false; return ctl; };
      return ctl;
    }

    return { litValue, setpos, build, install, pyDecode, jsEnc, decodeConcat, decodePySource };
  }

  return { bind, pyDecode, jsEnc, decodeConcat, decodePySource };
}));
