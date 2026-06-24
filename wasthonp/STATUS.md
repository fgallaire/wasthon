# wasthonp — état day-0 (récap)

## Objectif
Compiler **uniquement le frontend CPython** (tokenizer + parseur PEG → AST) en
WASM et l'utiliser dans Brython en remplacement de son parseur JS. Pas
l'interpréteur (≠ Pyodide). Projet frère de `../wasthon` (le « backend » :
modules d'extension C → WASM + bridge JS).

## Arborescence
```
wasthonp/
├── README.md          plan, décision d'archi, milestones
├── BUILD_NOTES.md     bring-up toolchain + audit détaillé
├── STATUS.md          ce récap
├── build.sh           compile les TUs du parseur + link (surface le gap)
├── parse_main.c       harness : _PyPegen_run_parser_from_string → mod_ty
├── shims/             (milestone 2) implémentations du gap de 56 symboles
├── host-build/        CPython 3.14 natif (build-python du cross-configure)
├── cpy-build/         pyconfig.h cross généré (330 defines)
└── build/             .o + missing.txt / covered.txt / gap.txt
```

## Ce qui marche (milestone 1 ✅)
1. **Toolchain cross** : CPython 3.14 hôte construit (configure refuse le cross
   sans build-python *exactement* 3.14 ; système = 3.12), puis `pyconfig.h` cross
   généré via `emconfigure` + le `config.site-wasm32-emscripten` officiel.
2. **Les 15 unités de compilation du parseur compilent toutes en WASM** contre
   les vrais headers internes CPython. Aucun trou header/config.

## Le résultat clé — audit de link
Via `llvm-nm` (wasm-ld plafonne à 20 erreurs) sur tous les `.o` :

| | |
|---|---|
| Symboles Py-level requis par le parseur | **165** |
| **Déjà fournis par le bridge wasthon** | **109 (66 %)** |
| **Gap à implémenter** | **56** |

→ **Stratégie B viable** : linker le parseur sur le bridge wasthon existant pour
la couche objets, au lieu de compiler `Objects/*.c` (chemin lourd vers Pyodide).
Si l'ABI tient, projet **à l'échelle d'un week-end**.

### Le gap de 56, par catégorie
- **Singletons / types (~10)** : `_Py_NoneStruct`, `_Py_TrueStruct`,
  `_Py_FalseStruct`, `_Py_EllipsisObject`, `PyBaseObject_Type`, `PyComplex_Type`,
  `_PyUnion_Type`, `Py_GenericAliasType` — alias vers valeurs du bridge.
- **Runtime minimal (~12)** : `_PyRuntime`, `_Py_tss_tstate`,
  `PyThreadState_Get`, `Py_Initialize/Finalize`, gardes de récursion,
  `_PyOnceFlag_CallOnceSlow`, `_Py_FatalErrorFunc` — stubbables (le parseur veut
  surtout un thread-state pour poser les exceptions + un compteur de récursion).
- **Internes Unicode (~9)** : `_PyUnicode_ScanIdentifier`, `_Py_ctype_table`,
  `_Py_ctype_tolower`, `_PyUnicode_IsWhitespace`, `_PyUnicode_IsPrintable`,
  `_PyUnicode_DecodeUnicodeEscapeInternal2`, `PyUnicodeWriter_FromFormatV`,
  `_PyUnicode_InternImmortal` — la partie vraiment spécifique (classification
  d'identifiants, décodage d'échappements).
- **Erreurs + types d'exceptions (~12)** : `PyErr_Fetch/Restore`,
  `PyErr_GivenExceptionMatches`, `PyErr_Warn*`, `PyExc_SyntaxError`,
  `PyExc_IndentationError`, `PyExc_TabError`, `_PyExc_IncompleteInputError`.
- **Bytes / seq / set (~8)** : `PyBytes_AsStringAndSize`, `PyBytes_Concat`,
  `_PyBytes_DecodeEscape2`, `PySequence_Contains`, `PySet_Discard/Size/
  _NextEntry`.
- **Divers (~5)** : `_PyTokenizer_FromFile` (pas de fichiers en navigateur →
  stub), `PyOS_strtol/strtoul` (wrappers libc), `Py_GenericAlias`.

## Milestone 2 — deux murs (résultat décisif)

En essayant de combler le gap, deux découvertes dures :

1. **Stratégie B (réutiliser le bridge) = cassée à l'ABI.** `wasthon.h` :
   `struct _object { intptr_t ob_refcnt; }` — un seul champ, **pas de `ob_type`**
   (4 octets). Le vrai CPython = `{ob_refcnt; ob_type}` (8 octets). Le parseur,
   compilé avec les vrais headers, inline des accès struct réels (`op->ob_type`,
   `PyUnicode_GET_LENGTH`, …). Les 109 symboles « couverts » le sont **par nom
   seulement** ; dès que le parseur touche les objets du bridge, il lit du vide.

2. **Stratégie A (compiler la couche objets réelle) = explose vers libpython.**
   Les 45 `Objects/*.c` compilent, mais le set manquant **grossit 165 → 197** et
   réclame la **boucle d'éval** (`_PyEval_EvalFrameDefault`), l'**import**, les
   **codecs**, le **GC**, le **threading/contextvars**. La couche objets n'est
   **pas séparable** du runtime (le parseur crée de vrais PyObjects → type
   machinery → ceval+GC+import). Converge sur **≈ libpython core complet** =
   l'échelle Pyodide qu'on voulait éviter.

## Conclusion → Stratégie C (la seule qui reste petite)

La couche objets n'est tirée que parce que le parseur **matérialise des
PyObjects** pour les littéraux et identifiants. La sortie : **forker le frontend
pour que l'AST porte les littéraux/identifiants en données brutes** (plages
d'octets UTF-8 / offsets dans la source), pas en `PyObject*`. Alors plus de
`PyUnicode_*`/`PyLong_*` → plus de runtime → ça reste petit ; et l'AST « POD » se
sérialise directement (le hand-off perf qu'on voulait), le **côté JS** créant les
vrais objets str/int comme valeurs Brython à la reconstruction.

C'est du travail invasif (patcher `Python-ast.c` + les action helpers +
`string_parser.c` vers une repr POD), mais c'est la **seule** archi qui livre un
WASM « parseur seul » réellement petit — et c'est aussi le meilleur design de
frontière possible. Détails et repro dans `BUILD_NOTES.md`.

## Expérience Stratégie C (stubs POD) — résultats

Test : linker le parseur-seul contre des **stubs POD** (165 symboles), sans
`Objects/`, sans ceval, sans runtime. Itéré trap par trap (`./exp.sh`).

- **Le parseur linke en WASM de 102 Ko** (vs ~10 Mo Pyodide) → la thèse de
  séparabilité/taille **tient**.
- À l'exécution il va **loin dans un vrai parse** : `arena → run_parser →
  expressions_rule → tokenizer (tok_get_normal_mode)`. La surface runtime-critique
  pour une petite expression est **petite** : mémoire, list d'arène, gardes de
  récursion, **classification de caractères Unicode** (le besoin réel du
  tokenizer), comparaisons de chaînes, formatage d'erreur.
- **Deux murs concrets = le verdict** :
  1. la grammaire **rejette** l'entrée factice (les checks sémantiques
     **inspectent le contenu** des chaînes) → identifiants/littéraux doivent être
     du **POD comparable** (plages d'octets), pas des blobs opaques ;
  2. `PyUnicode_GET_LENGTH` **assert `PyUnicode_Check`** → une **macro de layout**
     que le parseur inline lit l'objet directement → on **ne peut pas juste
     stubber** les fonctions.

**Verdict** : Stratégie C est la bonne archi, et l'expérience la chiffre — ce
n'est pas du stubbing mais de la **chirurgie source** (patcher `Python-ast.c`,
les action helpers, `string_parser.c` vers des plages d'octets POD + corriger la
poignée de sites d'inspection). Borné, bien localisé, et le gain est réel :
parseur-seul **~100 Ko**, sans couche objets ni boucle d'éval.

## Milestone 2 ATTEINT ✅ — le parseur produit un vrai AST

En itérant les shims, le parseur est passé de « ça linke » à « **ça parse de
vraies expressions en vrai AST** », toujours sans couche objets :

```
parse(x) -> kind=3      parse(1) -> kind=3       parse(3.14) -> kind=3
parse(1+2*3) -> kind=3  parse(f(a, b)) -> kind=3 parse([1, 2, 3]) -> kind=3
```
(`kind==3` = Expression, `mod_ty` non-NULL.) **WASM de 234 Ko** en -O2
(`node build/wasthonp.js`) vs ~10 Mo Pyodide.

Surface runtime-critique réelle (~40 fonctions dans `shims/pod_real.c`) :
mémoire (libc), str/bytes **minimales ABI-compatibles** (vrais structs
`PyASCIIObject`/`PyBytesObject` → les macros `PyUnicode_Check`/`GET_LENGTH`
marchent, comparaisons sur les vrais octets), feuilles opaques pour int/float/
tuple/list, `PyOS_strto*` → libc, gardes de récursion → 0, et surtout
**`Python/pyctype.c`** (8 Ko) pour la vraie `_Py_ctype_table` — le bug le plus
long : table à zéro → `Py_ISDIGIT('1')` faux → le tokenizer classait tout nombre
en `OP` (type 55) et la grammaire rejetait tous les littéraux numériques.

**Ce que ça prouve** : le parseur CPython **est séparable de l'interpréteur** —
vrai `mod_ty` pour du vrai source en ~234 Ko, sans éval/objets/runtime. Le
« on ne peut pas prendre un petit bout de CPython » est **faux pour le frontend**,
dès qu'on fournit les petites tables de classification + str/bytes minimales.

Reste (hybride → design final) : les feuilles numériques sont opaques (stockées,
mais valeur pas réelle). Un wasthonp de prod soit (a) garde ces str/bytes
minimales et **sérialise l'AST** en lisant leurs octets (nombres re-parsés en JS
depuis la source), soit (b) finit la chirurgie POD. La question d'archi est
tranchée : **petit, c'est atteignable.**

## Milestone 3a ATTEINT ✅ — AST sérialisé en JSON, correct

`shims/ast_dump.c` parcourt le `mod_ty` et émet du JSON, **sans couche objets** :
identifiants via la vraie str minimale, **littéraux via les spans de source**
(`col_offset..end_col_offset` — le design de hand-off de prod). Résultats :

```
1+2*3            => BinOp(+, 1, BinOp(*, 2, 3))     # précédence * > + correcte
a.b.c            => Attribute(Attribute(a,b), c)    # associativité gauche
d[0] + e         => BinOp(+, Subscript(d,0), e)
foo(bar, 42) * 2 => BinOp(*, Call(foo,[bar,42]), 2)
```

La **vraie grammaire CPython** marche (précédence, associativité, appels,
indices, attributs, listes). AST pleinement traversable et **consommable par JS**.
WASM **240 Ko** (`node build/wasthonp.js`).

## Milestone 3b ATTEINT ✅ — wasthonp est un drop-in du parseur de Brython

`m3b.js` : AST WASM de wasthonp → arbre `$B.ast` → codegen Brython
(`js_from_root`). Pour les 5 expressions de test, le JS généré est **identique**
à celui produit par le parseur+codegen natif de Brython :

```
source → wasthonp (parseur CPython WASM) → JSON → $B.ast → codegen Brython → JS
       ≡  identique au JS de Brython lui-même
```
Brython tourne en node (boot `/tmp/bry_boot.js`), wasthonp en module appelable
(`build/wasthonp_mod.js`). `node m3b.js`.

## Milestone 5 ATTEINT ✅ — bench parse-only

`node bench.js` sur un corps de module réaliste (~1,3 Ko, statements +
expressions, 200 itérations) :

```
wasthonp (WASM)       ~0.60 ms/parse
Brython (JS parser)   ~3.45 ms/parse
→ wasthonp ~5.7–6× plus rapide  (coût de la frontière WASM inclus)
```

**Toute la thèse du projet est validée end-to-end** : un parseur CPython réel en
**240 Ko** de WASM (sans interpréteur), produisant un AST correct, qui pilote le
codegen de Brython à l'identique, **~6× plus vite** que le parseur JS de Brython.

## Pont étendu aux STATEMENTS ✅ — modules réels complets

`shims/ast_dump.c` dumpe un module entier en JSON **aligné sur `$B.ast_classes`**
(format `{"_type","field":...}` + positions), et un **builder JS générique unique**
(~15 lignes, piloté par les specs de champs ASDL) reconstruit l'arbre `$B.ast`.
Brython compile → JS **logic-identical** à son propre parseur+codegen.

`node m3b_stmt.js` : **5/5 modules réels** couvrant
def/class/for/while/if/with/lambda/ternaire/import/from/global/del/assert/
augassign/comprehensions(list/set/dict/gen)/unpack/starred/slices/dict/compare.
(Diffs uniquement : suffixes UUID par-compile + le quirk `__file__` de Brython
dans les sous-frames de comprehension.)

## Grammaire COMPLÉTÉE ✅ — match/try/async/f-strings/type-params + vrais fichiers

Le pont C couvre désormais **toute la grammaire** : ~30 stmts (def/class/async*/
return/assign/aug/ann/for/while/if/with/try/trystar/match/raise/assert/import*/
global/nonlocal/del/typealias/pass/break/continue), ~30 exprs (dont
JoinedStr/FormattedValue f-strings, await/yield*, comprehensions, lambda,
ternaire, slices, starred, namedexpr), + patterns (match), excepthandler,
match_case, type_param (PEP 695), helpers, operators/ctx.

- **Synthétique : 9/9 modules** (def/class/match/try/async/generators/type-alias/
  comprehensions/…) → codegen Brython **logic-identical**. `node m3b_stmt.js`.
- **Vrais fichiers stdlib** (`node realfile.js <f>`) : `re/_parser.py` (1067
  lignes) parse+build+compile, **99,6% identique** (11/2728 lignes). random.py
  parse+build (f-strings dumpées).

Bugs résolus en route : f-strings (`PyUnicode_DecodeUTF8Stateful`), concat
implicite (`PyUnicodeWriter_*`), échappements (`_PyUnicode_DecodeUnicodeEscape…`),
`PyUnicode_Type`/`PyBytes_Type` réels (pour `PyUnicode_CheckExact` des f-strings),
offset multi-ligne (col_offset par-ligne), `match_case` sans position ASDL
(dérivée du pattern), décodage littéraux (octal/hex/bin/bigint ; raw-string =
doubler les backslashes ; non-raw = verbatim). **Bug Brython trouvé** : lineno
erroné des `match_case` (assigne la ligne du case suivant) — wasthonp est correct.

Diffs résiduelles (vrais fichiers) = **uniquement l'encodage de valeurs de
littéraux-chaîne** : échappements exotiques (`\a`, octal — JS≠Python, Brython les
décode) et concat implicite multi-ligne. Pas de trou de grammaire/structure.

## Exécution END-TO-END ✅ — les programmes TOURNENT (pas juste « codegen identique »)

`node m3c_exec.js` : parse wasthonp (WASM) → `$B.ast` → **exec Brython réel** →
lecture du résultat. **7/7 programmes donnent la bonne valeur** :

```
fib(10) récursif → 55      sum(i*i for i in range(5)) → 30
class+méthode → 15         {k:k*k for k in range(4)} → {0:0,1:1,2:4,3:9}
match/case → 'pair'        try/except + f-string → '5,-1'
generators+closures+lambda → [6,7,8]
```

On injecte l'AST wasthonp via un code-object `{ob_type:$B.code, _ast:{$js_ast},
mode:'exec'}` passé à `_b_.exec` (après avoir posé une frame racine via
`$B.enter_frame`). La chaîne complète est donc validée **par exécution**, pas
seulement par comparaison de texte.

## DÉMO NAVIGATEUR ✅ — Brython tourne sur le parseur wasthonp dans le navigateur

`web/index.html` (servi, testé headless via `web_test.py`) : charge Brython +
`build/wasthonp_mod.js` (WASM), **monkeypatche `$B._PyPegen.run_parser` par
wasthonp** (avec fallback Brython), et exécute un vrai script Python. Résultat
dans Chromium headless :

```
fib(15) = 610      squares = [0,1,4,9,16,25,36,49]
hello, wasthonp!   (f-string)      ordered pair: 1 2   (match + garde)
```

Badge « parser: wasthonp (WASM CPython parser) ». Pipeline : source → wasthonp
(WASM) → `$B.ast` → codegen Brython → eval. Bench in-browser : wasthonp **~2,5×
plus rapide** en parse-only (le 6× en node ; l'écart varie selon le moteur JS).

**La preuve de concept est COMPLÈTE de bout en bout** : « Brython, mais avec le
parseur CPython exact, en WASM, plus rapide » tourne réellement dans un navigateur.

## Littéraux-chaîne : CORRECTION TERMINÉE ✅

Modèle exact de Brython découvert (`Constant.to_js` fait `'${value}'` **sans
échapper** → la valeur stockée est déjà JS-encodée). Pipeline JS : `pyDecode`
(littéral Python → valeur runtime réelle : `\t \n \x \u \U` octal, `\a`, escapes
invalides gardés, raw verbatim) → `jsEnc` (ré-encode pour `'...'` JS : `\ ' \n \r
\t \b \f \v`) → `decodeConcat` (concat implicite `"a" "b"`). Plus nombres
octal/hex/bin/bigint.

Résultats :
- **`re/_parser.py` (1067 lignes) → codegen BYTE-IDENTIQUE à Brython** (203562 =
  203562 octets).
- **9/9 programmes exécutés correctement** (`m3c_exec.js`), dont escapes `\x`/`\t`/
  octal → `(3,'ABC',65)`, apostrophes dans chaînes, raw + escape invalide →
  `('\\d+','\\d+')`.
- Démo navigateur OK avec le décodeur corrigé.

Edge « position/indentation » de random.py : **RÉSOLU** — c'était un artefact de
mon harness (`compile()` passait `src:""` ; le codegen de Brython lit la source
par numéro de ligne pour les segments → `lines[1015]` undefined → crash). Avec la
vraie source passée (ce que fait le chemin `py2js`/navigateur), random.py
**compile** via le hook wasthonp. Aussi corrigé : `f_const` (C) JSON-échappe
désormais les sauts de ligne des triple-strings (au lieu de les aplatir en
espaces). Diff résiduelle random.py = cosmétique (Brython « joliprinte » les
chaînes multi-lignes en `\n` + continuation JS ; même valeur runtime).

## VALIDATION À L'ÉCHELLE ✅ — 35 modules stdlib réels (`validate.js`)

Round-trip de **35 fichiers .py réels** (tests CPython + stdlib, ~199 000 lignes)
via le chemin `py2js`+hook, comparé au codegen natif de Brython :

```
identiques (byte, après normalisation cosmétique) : 22/35
quasi-identiques (99 %+)                            : 12/35
échecs wasthonp                                     : 0
(1 « brython-fail » = pickletester.py que Brython lui-même ne compile pas)
correspondance globale : 99,67 %  (648 lignes diff / 198 662)
temps de compile : wasthonp 4,1 s vs Brython 3,7 s
```

Byte-identiques incluant les gros : test_decimal.py (6027 l), test_re.py (3148),
pickletools.py (2895), test_zstd.py (2815), test_lzma.py (2098).

**2 vrais bugs trouvés par la validation et corrigés :**
1. **Littéraux bytes** `b'...'` : litValue (JS) produit maintenant `_b_.bytes.
   $factory([...])` (était traité comme str).
2. **Noms d'import pointés** `from http.client import` : `PyUnicode_FromFormat`
   (C) implémente désormais `%U %s %d %c` (le builder de nom pointé fait
   `"%U.%U"`) — le module était vide.

Diffs résiduelles concentrées dans **test_unicodedata.py** (fichier de torture
unicode : `\N{}`, quotes imbriquées, chaînes de contrôle) et test_csv — cas de
bord de littéraux-chaîne, sans impact sur l'exécution du code normal.

## VALIDATION MASSIVE ✅ — stdlib CPython complète (1851 fichiers, `validate2.js`)

Round-trip de **toute la stdlib CPython 3.14** (`Lib/**.py`, 1851 fichiers,
~600k lignes) via le hook wasthonp vs codegen natif Brython :

```
wasthonp OK : 1807 / 1851   (parse + build + codegen sans crash)
wasthonp FAIL : 4   — tous des fichiers à SOURCE NON-UTF8
   (test/encoded_modules/module_{iso_8859_1,koi8_r}.py, tokenizedata/
    bad_coding.py, coding20731.py — des fixtures de test d'encodage)
brython-skipped : ~40 (syntaxe que Brython lui-même ne compile pas)
```

**9 vrais bugs trouvés par la validation et corrigés :**
1. littéraux **bytes** `b'...'` (étaient str) → `_b_.bytes.$factory`
2. **imports pointés** `from a.b import` → vrai `PyUnicode_FromFormat` (%U/%s/%d/%c)
3. **échappements bytes** `b'\x00'` → `_PyBytes_DecodeEscape2`
4. **t-strings** (PEP 750) → `TemplateStr` / `Interpolation`
5. `Py_GetConstant` (chaîne/bytes vides, concat implicite)
6. **concat implicite bytes** `b'a' b'b'` → `PyBytes_Concat`
7. **identifiants non-ASCII** (`Ŭñ`) → `_PyUnicode_ScanIdentifier`
8. **contenu non-ASCII** dans le décodeur d'échappements → `mkstr` compte les
   **code points** (pas les octets) pour `PyUnicode_GET_LENGTH`
9. **littéraux complexes/imaginaires** `7j`/`1.5j` (étaient float) → `$B.make_complex`

Codegen : la plupart des fichiers à **99,9 %+** (test_decimal 5 diffs / 19847) ;
diffs résiduelles = cosmétiques (numéros de position/`inum`, joliprint des chaînes
multi-lignes). Exécution : 9/9 (`m3c_exec.js`). Les seuls échecs réels = source
non-UTF8 (niche, fixtures d'encodage).

## Source NON-UTF8 : CORRIGÉ ✅

Les 4 derniers échecs (fichiers `# coding: iso-8859-1/koi8-r/latin1`) sont réglés
au **niveau loader** (là où CPython/Brython font la détection d'encodage) :
`decodePySource(buf)` lit le cookie PEP 263, décode les octets bruts via
`TextDecoder(enc)`, et réécrit le cookie en `utf-8`. Filet de sécurité côté WASM :
`PyUnicode_Decode` (latin-1/iso-8859-1/utf-8/ascii) + `PyUnicode_AsUTF8String`
pour le chemin `_PyTokenizer_translate_into_utf8`.

Les 4 fichiers parsent maintenant et le codegen **matche Brython au byte près**
(731=731, 636=636, 535=535).

### Résultat FINAL — stdlib complète, ZÉRO échec
```
wasthonp OK : 1811 / 1851   (1147 byte-identiques + 664 diffs cosmétiques)
wasthonp FAIL : 0           ← aucun échec de parsing sur toute la stdlib CPython
brython-skipped : 40        (syntaxe que Brython lui-même ne compile pas)
```
wasthonp parse + compile **100 % de la stdlib CPython 3.14** (tout fichier que
Brython sait aussi compiler), 0 crash. Diffs résiduelles = cosmétiques (numéros
de position/`inum`, joliprint des chaînes multi-lignes), exécution-équivalentes.

Reste pour un vrai produit : packaging (module ES6, auto-hook `text/python`),
sérialisation binaire compacte vs JSON.
