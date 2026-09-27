#!/usr/bin/env bash
#
# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# The bridge's unit tests: build tests/_bridgetest against src/ alone and run
# the test files in Node. Needs emcc and node on PATH (source emsdk_env.sh).
set -euo pipefail
cd "$(dirname "$0")"
S=../src
mkdir -p build
emcc -O2 -c -I "$S" "$S/wasthon.c" -o build/wasthon.o
emcc -O2 -c -I "$S" _bridgetest.c -o build/_bridgetest.o
emcc -O2 build/_bridgetest.o build/wasthon.o --js-library "$S/wasthon.js" \
    -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_PyInit__bridgetest","_wasthon_init","_wasthon_module_create","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32","HEAPF32","HEAPF64","HEAP16","UTF8ToString","stringToUTF8","lengthBytesUTF8","addFunction"]' \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=bridgetest -o build/_bridgetest.mjs
node run.mjs lifetime.py
