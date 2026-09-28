#!/usr/bin/env bash
#
# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# The bridge's unit tests: build the test modules (tests/_*.c) against src/
# alone into one wasm and run the test files in Node. Needs emcc (source
# emsdk_env.sh) and Node 24 or later on PATH, before the emsdk's Node 22.
# tests/cpython.sh runs test_*.py on CPython.
set -euo pipefail
cd "$(dirname "$0")"
S=../src
mkdir -p build
emcc -O2 -c -I "$S" "$S/wasthon.c" -o build/wasthon.o
objs=() exports='"_wasthon_init","_wasthon_module_create","_malloc","_free"'
for c in _*.c; do
    m=${c%.c}
    emcc -O2 -c -I "$S" "$c" -o "build/$m.o"
    objs+=("build/$m.o") exports+=",\"_PyInit_$m\""
done
emcc -O2 "${objs[@]}" build/wasthon.o --js-library "$S/wasthon.js" \
    -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 \
    -s EXPORTED_FUNCTIONS="[$exports]" \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32","HEAPF32","HEAPF64","HEAP16","UTF8ToString","stringToUTF8","lengthBytesUTF8","addFunction"]' \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=bridgetest -o build/_bridgetest.mjs
ls test_*.py > build/tests.txt      # what loader/test-bridge.html runs after lifetime.py
node run.mjs lifetime.py test_*.py
