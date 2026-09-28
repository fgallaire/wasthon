#!/usr/bin/env bash
#
# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# The same tests against CPython, the reference: the C-API test modules
# (tests/_capi*.c) built as CPython extensions, tests/test_*.py run by pytest.
# A test that fails here is a wrong test, not a bridge bug. Needs a C
# compiler, python3-config, pytest.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/cpython
for c in _capi*.c; do
    cc -shared -fPIC -O2 $(python3-config --includes) "$c" \
        -o "build/cpython/${c%.c}$(python3-config --extension-suffix)"
done
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=build/cpython${PYTHONPATH:+:$PYTHONPATH} python3 -m pytest -q -p no:cacheprovider test_*.py
