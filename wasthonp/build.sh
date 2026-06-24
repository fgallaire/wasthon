#!/usr/bin/env bash
#
# Build wasthonp — CPython's parser frontend (tokenizer + PEG → AST) to WASM,
# a drop-in for Brython's JS parser. Strategy C: the parser keeps its own
# minimal ABI-correct str/bytes (shims/) and carries literals as source spans;
# the JS side rebuilds Brython AST objects. No eval loop, no object layer.
#
# Output: build/wasthonp_mod.{js,wasm} (CommonJS, EXPORT_NAME=createWasthonp) —
# used by the node harnesses (bench/validate/...) and loader/wasthonp.html.
#
# Reuses the wasthon checkout's emsdk + CPython source under ../external.
# The cross pyconfig.h is committed (cpy-build/pyconfig.h); regenerate via the
# emconfigure dance in BUILD_NOTES.md only if bumping the CPython version.
set -uo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
W4="$(cd "${REPO}/.." && pwd)"
CPY="${CPYTHON_SRC:-${W4}/external/Python-3.14.6}"
EMSDK="${EMSDK:-${W4}/external/emsdk}"
OUT="${REPO}/build"
mkdir -p "${OUT}"
source "${EMSDK}/emsdk_env.sh" >/dev/null 2>&1

INC="-I ${REPO}/cpy-build -I ${CPY}/Include -I ${CPY}/Include/internal -I ${CPY}/Include/internal/mimalloc -I ${CPY} -I ${CPY}/Parser"
CF="-O2 -DPy_BUILD_CORE -fno-strict-aliasing ${INC}"

# CPython parser frontend translation units (frontend only — no interpreter).
PARSER_TUS=(
  Parser/pegen.c Parser/parser.c Parser/pegen_errors.c Parser/string_parser.c
  Parser/action_helpers.c Parser/token.c
  Parser/lexer/lexer.c Parser/lexer/buffer.c Parser/lexer/state.c
  Parser/tokenizer/string_tokenizer.c Parser/tokenizer/utf8_tokenizer.c Parser/tokenizer/helpers.c
  Python/Python-ast.c Python/asdl.c Python/pyarena.c Python/pyctype.c
)

echo "=== compile parser TUs ==="
for tu in "${PARSER_TUS[@]}"; do
  b="$(basename "${tu}" .c)"
  emcc ${CF} -c "${CPY}/${tu}" -o "${OUT}/${b}.o" 2>>"${OUT}/compile.log" \
    && echo "  ok  ${tu}" || { echo "  FAIL ${tu}"; tail -8 "${OUT}/compile.log"; exit 1; }
done

echo "=== compile shims (Strategy C: minimal POD object layer + AST→JSON + errors) ==="
for s in pod_real pod_stubs ast_dump wp_errors; do
  emcc ${CF} -c "${REPO}/shims/${s}.c" -o "${OUT}/${s}.o" 2>>"${OUT}/compile.log" \
    && echo "  ok  shims/${s}.c" || { echo "  FAIL shims/${s}.c"; tail -12 "${OUT}/compile.log"; exit 1; }
done

echo "=== link build/wasthonp_mod.js (CommonJS) ==="
OBJS="$(ls "${OUT}"/*.o)"
EXP='-s EXPORTED_FUNCTIONS=["_wasthonp_dump","_wasthonp_dump_module","_wasthonp_parse_only","_malloc","_free"] -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8"]'
emcc -O2 ${OBJS} -Wl,--wrap=_PyPegen_raise_error_known_location \
     -s ALLOW_MEMORY_GROWTH=1 -s STACK_SIZE=8MB -s MODULARIZE=1 \
     -s EXPORT_NAME=createWasthonp -s INVOKE_RUN=0 ${EXP} \
     -o "${OUT}/wasthonp_mod.js" 2>"${OUT}/link.log" \
  && echo "Built: build/wasthonp_mod.{js,wasm}  ($(stat -c%s "${OUT}/wasthonp_mod.wasm") B wasm)" \
  || { echo "LINK FAIL"; tail -20 "${OUT}/link.log"; exit 1; }
