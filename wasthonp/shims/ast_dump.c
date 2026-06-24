/* wasthonp: walk the parsed mod_ty → JSON aligned with Brython's $B.ast_classes,
 * so the JS side rebuilds the $B.ast tree with ONE generic constructor.
 * No object layer: identifiers via the real minimal str, literals via the
 * source span, positions emitted so Brython codegen matches exactly.
 * Covers the statement + expression + helper node set for real .py files. */
#include "Python.h"
#include "internal/pycore_ast.h"
#include "internal/pycore_pyarena.h"
#include "../Parser/pegen.h"
#include <string.h>
#include <stdio.h>

static char BUF[1 << 24];   /* 16 MB — big real modules produce large JSON */
static int  LEN;
static const char *SRC;
/* line-start byte offsets, so (lineno,col_offset) → global offset (col_offset is
 * a per-line column, not a global index). */
static int LINEOFF[1 << 16];
static int NLINES;
static void build_lineoff(const char *s){ NLINES=0; LINEOFF[NLINES++]=0; for(int i=0; s[i] && NLINES<(1<<16); i++) if(s[i]=='\n') LINEOFF[NLINES++]=i+1; }
static int goff(int lineno, int col){ if(lineno<1) lineno=1; if(lineno>NLINES) lineno=NLINES; return LINEOFF[lineno-1]+col; }

static void raw(const char *s){ while(*s && LEN<(int)sizeof(BUF)-1) BUF[LEN++]=*s++; BUF[LEN]=0; }
static void qstr(const char *s){ raw("\""); for(;*s && LEN<(int)sizeof(BUF)-2;s++){ char c=*s; if(c=='"'||c=='\\') BUF[LEN++]='\\'; BUF[LEN++]=c; } BUF[LEN]=0; raw("\""); }
static void inum(long v){ char t[24]; snprintf(t,sizeof t,"%ld",v); raw(t); }

/* forward */
static void d_expr(expr_ty e);
static void d_stmt(stmt_ty s);
static void d_pattern(pattern_ty p);
static void d_excepthandler(excepthandler_ty h);
static void d_match_case(match_case_ty c);
static void d_type_param(type_param_ty t);
static void f_tpseq(const char *n, asdl_type_param_seq *s);
static void f_handlerseq(const char *n, asdl_excepthandler_seq *s);
static void f_caseseq(const char *n, asdl_match_case_seq *s);

static void open_(const char *type){ raw("{\"_type\":"); qstr(type); }
static void close_(void){ raw("}"); }
/* field helpers (every field is preceded by a comma — _type is always first) */
static void f_str(const char *n, PyObject *s){ raw(",\""); raw(n); raw("\":"); if(s) qstr(PyUnicode_AsUTF8(s)); else raw("null"); }
static void f_int(const char *n, long v){ raw(",\""); raw(n); raw("\":"); inum(v); }
static void f_node_open(const char *n){ raw(",\""); raw(n); raw("\":"); }
static void f_expr(const char *n, expr_ty e){ f_node_open(n); if(e) d_expr(e); else raw("null"); }
static void f_stmt(const char *n, stmt_ty s){ f_node_open(n); if(s) d_stmt(s); else raw("null"); }
static void enum_node(const char *type){ open_(type); close_(); }

#define ESEQ(n,seq) do{ f_node_open(n); raw("["); Py_ssize_t _N=asdl_seq_LEN(seq); for(Py_ssize_t _i=0;_i<_N;_i++){ if(_i) raw(","); d_expr((expr_ty)asdl_seq_GET(seq,_i)); } raw("]"); }while(0)
#define SSEQ(n,seq) do{ f_node_open(n); raw("["); Py_ssize_t _N=asdl_seq_LEN(seq); for(Py_ssize_t _i=0;_i<_N;_i++){ if(_i) raw(","); d_stmt((stmt_ty)asdl_seq_GET(seq,_i)); } raw("]"); }while(0)

static void pos_expr(expr_ty e){ f_int("lineno",e->lineno); f_int("col_offset",e->col_offset); f_int("end_lineno",e->end_lineno); f_int("end_col_offset",e->end_col_offset); }
static void pos_stmt(stmt_ty s){ f_int("lineno",s->lineno); f_int("col_offset",s->col_offset); f_int("end_lineno",s->end_lineno); f_int("end_col_offset",s->end_col_offset); }

static const char *OPN(operator_ty o){ switch(o){case Add:return"Add";case Sub:return"Sub";case Mult:return"Mult";case MatMult:return"MatMult";case Div:return"Div";case Mod:return"Mod";case Pow:return"Pow";case LShift:return"LShift";case RShift:return"RShift";case BitOr:return"BitOr";case BitXor:return"BitXor";case BitAnd:return"BitAnd";case FloorDiv:return"FloorDiv";}return"Add"; }
static const char *BOP(boolop_ty o){ return o==And?"And":"Or"; }
static const char *UOP(unaryop_ty o){ switch(o){case Invert:return"Invert";case Not:return"Not";case UAdd:return"UAdd";case USub:return"USub";}return"Not"; }
static const char *COP(cmpop_ty o){ switch(o){case Eq:return"Eq";case NotEq:return"NotEq";case Lt:return"Lt";case LtE:return"LtE";case Gt:return"Gt";case GtE:return"GtE";case Is:return"Is";case IsNot:return"IsNot";case In:return"In";case NotIn:return"NotIn";}return"Eq"; }
static const char *CTX(expr_context_ty c){ return c==Store?"Store":c==Del?"Del":"Load"; }

static void f_ctx(expr_context_ty c){ f_node_open("ctx"); enum_node(CTX(c)); }
static void f_cmpops(asdl_int_seq *s){ f_node_open("ops"); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); enum_node(COP((cmpop_ty)asdl_seq_GET(s,i))); } raw("]"); }

static void d_arg(arg_ty a){ open_("arg"); f_str("arg",a->arg); f_expr("annotation",a->annotation); f_int("lineno",a->lineno); f_int("col_offset",a->col_offset); f_int("end_lineno",a->end_lineno); f_int("end_col_offset",a->end_col_offset); close_(); }
static void f_argseq(const char *n, asdl_arg_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_arg((arg_ty)asdl_seq_GET(s,i)); } raw("]"); }

static void d_arguments(arguments_ty a){
    open_("arguments");
    f_argseq("posonlyargs", a->posonlyargs);
    f_argseq("args", a->args);
    f_node_open("vararg"); if(a->vararg) d_arg(a->vararg); else raw("null");
    f_argseq("kwonlyargs", a->kwonlyargs);
    ESEQ("kw_defaults", a->kw_defaults);
    f_node_open("kwarg"); if(a->kwarg) d_arg(a->kwarg); else raw("null");
    ESEQ("defaults", a->defaults);
    close_();
}
static void d_keyword(keyword_ty k){ open_("keyword"); f_str("arg",k->arg); f_expr("value",k->value); close_(); }
static void f_kwseq(const char *n, asdl_keyword_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_keyword((keyword_ty)asdl_seq_GET(s,i)); } raw("]"); }
static void d_comp(comprehension_ty c){ open_("comprehension"); f_expr("target",c->target); f_expr("iter",c->iter); ESEQ("ifs",c->ifs); f_int("is_async",c->is_async); close_(); }
static void f_compseq(const char *n, asdl_comprehension_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_comp((comprehension_ty)asdl_seq_GET(s,i)); } raw("]"); }
static void d_alias(alias_ty a){ open_("alias"); f_str("name",a->name); f_str("asname",a->asname); close_(); }
static void f_aliasseq(const char *n, asdl_alias_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_alias((alias_ty)asdl_seq_GET(s,i)); } raw("]"); }
static void d_withitem(withitem_ty w){ open_("withitem"); f_expr("context_expr",w->context_expr); f_expr("optional_vars",w->optional_vars); close_(); }
static void f_withseq(const char *n, asdl_withitem_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_withitem((withitem_ty)asdl_seq_GET(s,i)); } raw("]"); }
/* identifier seq (Global/Nonlocal names) */
static void f_idseq(const char *n, asdl_identifier_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); qstr(PyUnicode_AsUTF8((PyObject*)asdl_seq_GET(s,i))); } raw("]"); }
/* append one char, JSON-escaped (newlines/control chars must survive for
 * multi-line triple-quoted literals — earlier they were flattened to spaces). */
static void json_char(char c){
    if(LEN>=(int)sizeof(BUF)-7) return;
    if(c=='"'||c=='\\'){ BUF[LEN++]='\\'; BUF[LEN++]=c; }
    else if(c=='\n'){ BUF[LEN++]='\\'; BUF[LEN++]='n'; }
    else if(c=='\r'){ BUF[LEN++]='\\'; BUF[LEN++]='r'; }
    else if(c=='\t'){ BUF[LEN++]='\\'; BUF[LEN++]='t'; }
    else if((unsigned char)c<0x20){ char h[8]; snprintf(h,sizeof h,"\\u%04x",(unsigned char)c); for(char*p=h;*p;p++)BUF[LEN++]=*p; }
    else BUF[LEN++]=c;
    BUF[LEN]=0;
}
/* literal text from source span */
static void f_const(expr_ty e){ raw(",\"value\":\""); int a=goff(e->lineno,e->col_offset),b=goff(e->end_lineno,e->end_col_offset); for(int i=a;i<b;i++) json_char(SRC[i]); raw("\""); }

static void d_expr(expr_ty e){
    if(!e){ raw("null"); return; }
    switch(e->kind){
    case Name_kind:     open_("Name"); f_str("id",e->v.Name.id); f_ctx(e->v.Name.ctx); break;
    case Constant_kind: open_("Constant"); f_const(e); break;
    case BinOp_kind:    open_("BinOp"); f_expr("left",e->v.BinOp.left); f_node_open("op"); enum_node(OPN(e->v.BinOp.op)); f_expr("right",e->v.BinOp.right); break;
    case UnaryOp_kind:  open_("UnaryOp"); f_node_open("op"); enum_node(UOP(e->v.UnaryOp.op)); f_expr("operand",e->v.UnaryOp.operand); break;
    case BoolOp_kind:   open_("BoolOp"); f_node_open("op"); enum_node(BOP(e->v.BoolOp.op)); ESEQ("values",e->v.BoolOp.values); break;
    case Compare_kind:  open_("Compare"); f_expr("left",e->v.Compare.left); f_cmpops(e->v.Compare.ops); ESEQ("comparators",e->v.Compare.comparators); break;
    case Call_kind:     open_("Call"); f_expr("func",e->v.Call.func); ESEQ("args",e->v.Call.args); f_kwseq("keywords",e->v.Call.keywords); break;
    case Attribute_kind:open_("Attribute"); f_expr("value",e->v.Attribute.value); f_str("attr",e->v.Attribute.attr); f_ctx(e->v.Attribute.ctx); break;
    case Subscript_kind:open_("Subscript"); f_expr("value",e->v.Subscript.value); f_expr("slice",e->v.Subscript.slice); f_ctx(e->v.Subscript.ctx); break;
    case Starred_kind:  open_("Starred"); f_expr("value",e->v.Starred.value); f_ctx(e->v.Starred.ctx); break;
    case List_kind:     open_("List"); ESEQ("elts",e->v.List.elts); f_ctx(e->v.List.ctx); break;
    case Tuple_kind:    open_("Tuple"); ESEQ("elts",e->v.Tuple.elts); f_ctx(e->v.Tuple.ctx); break;
    case Set_kind:      open_("Set"); ESEQ("elts",e->v.Set.elts); break;
    case Dict_kind:     open_("Dict"); ESEQ("keys",e->v.Dict.keys); ESEQ("values",e->v.Dict.values); break;
    case ListComp_kind: open_("ListComp"); f_expr("elt",e->v.ListComp.elt); f_compseq("generators",e->v.ListComp.generators); break;
    case SetComp_kind:  open_("SetComp"); f_expr("elt",e->v.SetComp.elt); f_compseq("generators",e->v.SetComp.generators); break;
    case GeneratorExp_kind: open_("GeneratorExp"); f_expr("elt",e->v.GeneratorExp.elt); f_compseq("generators",e->v.GeneratorExp.generators); break;
    case DictComp_kind: open_("DictComp"); f_expr("key",e->v.DictComp.key); f_expr("value",e->v.DictComp.value); f_compseq("generators",e->v.DictComp.generators); break;
    case IfExp_kind:    open_("IfExp"); f_expr("test",e->v.IfExp.test); f_expr("body",e->v.IfExp.body); f_expr("orelse",e->v.IfExp.orelse); break;
    case Lambda_kind:   open_("Lambda"); f_node_open("args"); d_arguments(e->v.Lambda.args); f_expr("body",e->v.Lambda.body); break;
    case NamedExpr_kind:open_("NamedExpr"); f_expr("target",e->v.NamedExpr.target); f_expr("value",e->v.NamedExpr.value); break;
    case Slice_kind:    open_("Slice"); f_expr("lower",e->v.Slice.lower); f_expr("upper",e->v.Slice.upper); f_expr("step",e->v.Slice.step); break;
    case JoinedStr_kind: open_("JoinedStr"); ESEQ("values",e->v.JoinedStr.values); break;
    case FormattedValue_kind: open_("FormattedValue"); f_expr("value",e->v.FormattedValue.value); f_int("conversion",e->v.FormattedValue.conversion); f_expr("format_spec",e->v.FormattedValue.format_spec); break;
    case TemplateStr_kind: open_("TemplateStr"); ESEQ("values",e->v.TemplateStr.values); break;
    case Interpolation_kind: open_("Interpolation"); f_expr("value",e->v.Interpolation.value); f_str("str",(PyObject*)e->v.Interpolation.str); f_int("conversion",e->v.Interpolation.conversion); f_expr("format_spec",e->v.Interpolation.format_spec); break;
    case Await_kind:    open_("Await"); f_expr("value",e->v.Await.value); break;
    case Yield_kind:    open_("Yield"); f_expr("value",e->v.Yield.value); break;
    case YieldFrom_kind:open_("YieldFrom"); f_expr("value",e->v.YieldFrom.value); break;
    default: { open_("UNKNOWN_expr"); f_int("kind",e->kind); }
    }
    pos_expr(e); close_();
}

static void d_stmt(stmt_ty s){
    if(!s){ raw("null"); return; }
    switch(s->kind){
    case FunctionDef_kind: open_("FunctionDef"); f_str("name",s->v.FunctionDef.name); f_node_open("args"); d_arguments(s->v.FunctionDef.args); SSEQ("body",s->v.FunctionDef.body); ESEQ("decorator_list",s->v.FunctionDef.decorator_list); f_expr("returns",s->v.FunctionDef.returns); f_tpseq("type_params",s->v.FunctionDef.type_params); break;
    case AsyncFunctionDef_kind: open_("AsyncFunctionDef"); f_str("name",s->v.AsyncFunctionDef.name); f_node_open("args"); d_arguments(s->v.AsyncFunctionDef.args); SSEQ("body",s->v.AsyncFunctionDef.body); ESEQ("decorator_list",s->v.AsyncFunctionDef.decorator_list); f_expr("returns",s->v.AsyncFunctionDef.returns); f_tpseq("type_params",s->v.AsyncFunctionDef.type_params); break;
    case ClassDef_kind: open_("ClassDef"); f_str("name",s->v.ClassDef.name); ESEQ("bases",s->v.ClassDef.bases); f_kwseq("keywords",s->v.ClassDef.keywords); SSEQ("body",s->v.ClassDef.body); ESEQ("decorator_list",s->v.ClassDef.decorator_list); f_tpseq("type_params",s->v.ClassDef.type_params); break;
    case Return_kind: open_("Return"); f_expr("value",s->v.Return.value); break;
    case Delete_kind: open_("Delete"); ESEQ("targets",s->v.Delete.targets); break;
    case Assign_kind: open_("Assign"); ESEQ("targets",s->v.Assign.targets); f_expr("value",s->v.Assign.value); break;
    case AugAssign_kind: open_("AugAssign"); f_expr("target",s->v.AugAssign.target); f_node_open("op"); enum_node(OPN(s->v.AugAssign.op)); f_expr("value",s->v.AugAssign.value); break;
    case AnnAssign_kind: open_("AnnAssign"); f_expr("target",s->v.AnnAssign.target); f_expr("annotation",s->v.AnnAssign.annotation); f_expr("value",s->v.AnnAssign.value); f_int("simple",s->v.AnnAssign.simple); break;
    case For_kind: open_("For"); f_expr("target",s->v.For.target); f_expr("iter",s->v.For.iter); SSEQ("body",s->v.For.body); SSEQ("orelse",s->v.For.orelse); break;
    case AsyncFor_kind: open_("AsyncFor"); f_expr("target",s->v.AsyncFor.target); f_expr("iter",s->v.AsyncFor.iter); SSEQ("body",s->v.AsyncFor.body); SSEQ("orelse",s->v.AsyncFor.orelse); break;
    case While_kind: open_("While"); f_expr("test",s->v.While.test); SSEQ("body",s->v.While.body); SSEQ("orelse",s->v.While.orelse); break;
    case If_kind: open_("If"); f_expr("test",s->v.If.test); SSEQ("body",s->v.If.body); SSEQ("orelse",s->v.If.orelse); break;
    case With_kind: open_("With"); f_withseq("items",s->v.With.items); SSEQ("body",s->v.With.body); break;
    case AsyncWith_kind: open_("AsyncWith"); f_withseq("items",s->v.AsyncWith.items); SSEQ("body",s->v.AsyncWith.body); break;
    case Try_kind: open_("Try"); SSEQ("body",s->v.Try.body); f_handlerseq("handlers",s->v.Try.handlers); SSEQ("orelse",s->v.Try.orelse); SSEQ("finalbody",s->v.Try.finalbody); break;
    case TryStar_kind: open_("TryStar"); SSEQ("body",s->v.TryStar.body); f_handlerseq("handlers",s->v.TryStar.handlers); SSEQ("orelse",s->v.TryStar.orelse); SSEQ("finalbody",s->v.TryStar.finalbody); break;
    case Match_kind: open_("Match"); f_expr("subject",s->v.Match.subject); f_caseseq("cases",s->v.Match.cases); break;
    case TypeAlias_kind: open_("TypeAlias"); f_expr("name",s->v.TypeAlias.name); f_tpseq("type_params",s->v.TypeAlias.type_params); f_expr("value",s->v.TypeAlias.value); break;
    case Raise_kind: open_("Raise"); f_expr("exc",s->v.Raise.exc); f_expr("cause",s->v.Raise.cause); break;
    case Assert_kind: open_("Assert"); f_expr("test",s->v.Assert.test); f_expr("msg",s->v.Assert.msg); break;
    case Import_kind: open_("Import"); f_aliasseq("names",s->v.Import.names); break;
    case ImportFrom_kind: open_("ImportFrom"); f_str("module",s->v.ImportFrom.module); f_aliasseq("names",s->v.ImportFrom.names); f_int("level",s->v.ImportFrom.level); break;
    case Global_kind: open_("Global"); f_idseq("names",s->v.Global.names); break;
    case Nonlocal_kind: open_("Nonlocal"); f_idseq("names",s->v.Nonlocal.names); break;
    case Expr_kind: open_("Expr"); f_expr("value",s->v.Expr.value); break;
    case Pass_kind: open_("Pass"); break;
    case Break_kind: open_("Break"); break;
    case Continue_kind: open_("Continue"); break;
    default: { open_("UNKNOWN_stmt"); f_int("kind",s->kind); }
    }
    pos_stmt(s); close_();
}

/* ---- pattern / excepthandler / match_case / type_param (match, try, PEP 695) ---- */
#define PSEQ(n,seq) do{ f_node_open(n); raw("["); Py_ssize_t _N=asdl_seq_LEN(seq); for(Py_ssize_t _i=0;_i<_N;_i++){ if(_i) raw(","); d_pattern((pattern_ty)asdl_seq_GET(seq,_i)); } raw("]"); }while(0)
static void f_const_pat(pattern_ty p){ raw(",\"value\":\""); int a=goff(p->lineno,p->col_offset),b=goff(p->end_lineno,p->end_col_offset); for(int i=a;i<b;i++) json_char(SRC[i]); raw("\""); }
static void d_pattern(pattern_ty p){
    if(!p){ raw("null"); return; }
    switch(p->kind){
    case MatchValue_kind:     open_("MatchValue"); f_expr("value",p->v.MatchValue.value); break;
    case MatchSingleton_kind: open_("MatchSingleton"); f_const_pat(p); break;
    case MatchSequence_kind:  open_("MatchSequence"); PSEQ("patterns",p->v.MatchSequence.patterns); break;
    case MatchMapping_kind:   open_("MatchMapping"); ESEQ("keys",p->v.MatchMapping.keys); PSEQ("patterns",p->v.MatchMapping.patterns); f_str("rest",p->v.MatchMapping.rest); break;
    case MatchClass_kind:     open_("MatchClass"); f_expr("cls",p->v.MatchClass.cls); PSEQ("patterns",p->v.MatchClass.patterns); f_idseq("kwd_attrs",p->v.MatchClass.kwd_attrs); PSEQ("kwd_patterns",p->v.MatchClass.kwd_patterns); break;
    case MatchStar_kind:      open_("MatchStar"); f_str("name",p->v.MatchStar.name); break;
    case MatchAs_kind:        open_("MatchAs"); f_node_open("pattern"); if(p->v.MatchAs.pattern) d_pattern(p->v.MatchAs.pattern); else raw("null"); f_str("name",p->v.MatchAs.name); break;
    case MatchOr_kind:        open_("MatchOr"); PSEQ("patterns",p->v.MatchOr.patterns); break;
    default: open_("UNKNOWN_pattern"); f_int("kind",p->kind);
    }
    f_int("lineno",p->lineno); f_int("col_offset",p->col_offset); f_int("end_lineno",p->end_lineno); f_int("end_col_offset",p->end_col_offset); close_();
}
static void d_excepthandler(excepthandler_ty h){
    open_("ExceptHandler"); f_expr("type",h->v.ExceptHandler.type); f_str("name",h->v.ExceptHandler.name); SSEQ("body",h->v.ExceptHandler.body);
    f_int("lineno",h->lineno); f_int("col_offset",h->col_offset); f_int("end_lineno",h->end_lineno); f_int("end_col_offset",h->end_col_offset); close_();
}
static void f_handlerseq(const char *n, asdl_excepthandler_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_excepthandler((excepthandler_ty)asdl_seq_GET(s,i)); } raw("]"); }
static void d_match_case(match_case_ty c){ open_("match_case"); f_node_open("pattern"); d_pattern(c->pattern); f_expr("guard",c->guard); SSEQ("body",c->body); /* match_case has no ASDL position; Brython uses the pattern's */ if(c->pattern){ f_int("lineno",c->pattern->lineno); f_int("col_offset",c->pattern->col_offset); f_int("end_lineno",c->pattern->end_lineno); f_int("end_col_offset",c->pattern->end_col_offset); } close_(); }
static void f_caseseq(const char *n, asdl_match_case_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_match_case((match_case_ty)asdl_seq_GET(s,i)); } raw("]"); }
static void d_type_param(type_param_ty t){
    switch(t->kind){
    case TypeVar_kind:      open_("TypeVar"); f_str("name",t->v.TypeVar.name); f_expr("bound",t->v.TypeVar.bound); f_expr("default_value",t->v.TypeVar.default_value); break;
    case ParamSpec_kind:    open_("ParamSpec"); f_str("name",t->v.ParamSpec.name); f_expr("default_value",t->v.ParamSpec.default_value); break;
    case TypeVarTuple_kind: open_("TypeVarTuple"); f_str("name",t->v.TypeVarTuple.name); f_expr("default_value",t->v.TypeVarTuple.default_value); break;
    default: open_("UNKNOWN_type_param"); f_int("kind",t->kind);
    }
    f_int("lineno",t->lineno); f_int("col_offset",t->col_offset); f_int("end_lineno",t->end_lineno); f_int("end_col_offset",t->end_col_offset); close_();
}
static void f_tpseq(const char *n, asdl_type_param_seq *s){ f_node_open(n); raw("["); Py_ssize_t N=asdl_seq_LEN(s); for(Py_ssize_t i=0;i<N;i++){ if(i)raw(","); d_type_param((type_param_ty)asdl_seq_GET(s,i)); } raw("]"); }

int wasthonp_parse_only(const char *src){
    PyArena *arena=_PyArena_New(); if(!arena) return -1;
    PyObject *fn=PyUnicode_FromString("<w>");
    mod_ty mod=_PyPegen_run_parser_from_string(src,Py_file_input,fn,NULL,arena);
    int ok = mod ? mod->kind : 0;
    _PyArena_Free(arena);
    return ok;
}

/* dump a whole module (file input) */
const char *wasthonp_dump_module(const char *src){
    LEN=0; BUF[0]=0; SRC=src; build_lineoff(src);
    PyArena *arena=_PyArena_New(); if(!arena) return "{\"error\":\"arena\"}";
    PyObject *fn=PyUnicode_FromString("<w>");
    mod_ty mod=_PyPegen_run_parser_from_string(src,Py_file_input,fn,NULL,arena);
    if(!mod){ _PyArena_Free(arena); return "{\"error\":\"parse failed\"}"; }
    if(mod->kind==Module_kind){ open_("Module"); SSEQ("body",mod->v.Module.body); raw(",\"type_ignores\":[]"); close_(); }
    else raw("{\"error\":\"not a module\"}");
    _PyArena_Free(arena);
    return BUF;
}

/* expression dump kept for the old demo */
const char *wasthonp_dump(const char *src){
    LEN=0; BUF[0]=0; SRC=src; build_lineoff(src);
    PyArena *arena=_PyArena_New(); if(!arena) return "{\"error\":\"arena\"}";
    PyObject *fn=PyUnicode_FromString("<w>");
    mod_ty mod=_PyPegen_run_parser_from_string(src,Py_eval_input,fn,NULL,arena);
    if(!mod){ _PyArena_Free(arena); return "{\"error\":\"parse failed\"}"; }
    if(mod->kind==Expression_kind) d_expr(mod->v.Expression.body);
    else raw("{\"error\":\"not expr\"}");
    _PyArena_Free(arena);
    return BUF;
}
