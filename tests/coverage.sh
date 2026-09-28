#!/usr/bin/env bash
#
# Copyright (C) 2026 Florent Gallaire <fgallaire@gmail.com>
#
# BSD 3-Clause License
#
# The C-API functions of src/wasthon.js the tests call, measured by V8 itself
# (NODE_V8_COVERAGE): no dependency. Run tests/run.sh first, it builds what
# this runs. With function names as arguments (PyType_Ready ...), also lists
# the blocks of each that the tests never run.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build/coverage
NODE_V8_COVERAGE=build/coverage node run.mjs lifetime.py test_*.py > /dev/null 2>&1 || true
python3 coverage.py build/coverage ../src/wasthon.js "$@"
