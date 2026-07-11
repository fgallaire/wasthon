#!/usr/bin/env bash
# Cython support-layer build: cythonize a .pyx, apply the generic post-cythonize
# patches, compile to .o against wasthon.h. Usage: cybuild.sh <pyx> <modname> <outdir>
# Cython 3.0.x must be importable by python3 (pip install cython, or point
# CYTHON_PYTHONPATH at a directory holding the Cython package).
set -e
PYX="$1"; MOD="$2"; OUT="$3"
CS="$(cd "$(dirname "$0")" && pwd)"; ROOT="$CS/.."
SRC="$ROOT/src"
C="$OUT/$(basename ${MOD//./_}).c"
rm -f "$C"; PYTHONPATH="${CYTHON_PYTHONPATH:-}" python3 -m cython -3 --module-name "$MOD" "$PYX" -o "$C"
# --- generic post-cythonize patches (the "recipe" for Cython on the handle bridge) ---
# P1: ml_meth is void* in wasthon.h -> cast the direct calls to PyCFunction
sed -i 's/def->ml_meth(/((PyCFunction)def->ml_meth)(/g' "$C"
# P2: list fast-path pokes ob_item (absent: list=handle) -> use PyList_SET_ITEM loop
perl -0pi -e 's/__Pyx_copy_object_array\(src, \(\(PyListObject\*\)res\)->ob_item, n\);/{ Py_ssize_t _i; for(_i=0;_i<n;_i++){ Py_INCREF(src[_i]); PyList_SET_ITEM(res,_i,src[_i]); } }/g' "$C"
# P3: type-size checks. Bridge types have no CPython memory layout (field access
# goes through the handle map), so a cimported type's runtime tp_basicsize is
# meaningless and trips "size changed" / "wrong size" errors. Neutralise the
# fatal comparisons — every Cython module that cimports typed numpy types (and
# every 2nd module that shares Cython's CyFunctionType) needs this.
#   P3a __Pyx_ImportType: force basicsize to the expected size.
sed -i 's/basicsize = PyLong_AsSsize_t(py_basicsize);/basicsize = PyLong_AsSsize_t(py_basicsize); basicsize = (Py_ssize_t)size;/' "$C"
#   P3b __Pyx_ImportType: neutralise the fatal size comparison outright.
perl -0pi -e 's/\(\(size_t\)\(basicsize \+ itemsize\) < size\)/(0)/g' "$C"
#   P3c __Pyx_VerifyCachedType (shared CyFunctionType across modules): drop the
#       basicsize-equality gate.
perl -0pi -e 's/if \(basicsize != expected_basicsize\) \{/if (0) {/g' "$C"
# P4: CYTHON_COMPILING_IN_CPYTHON=0 — the blessed setting for a handle-based,
# non-layout-compatible runtime (same route as PyPy/GraalPy). With 1, fast
# paths like __Pyx_PyObject_FastCallDict deref ((PyCFunctionObject*)f)->m_ml
# on objects that are Brython JS values (handle != struct ptr) -> hard trap.
# 0 routes every call through the generic C-API. Only the FIRST matching line
# is the config block (later matches sit inside #if branches, untouched).
L=$(grep -n "^  #define CYTHON_COMPILING_IN_CPYTHON 1$" "$C" | head -1 | cut -d: -f1)
if [ -n "$L" ]; then
  sed -i "${L}s/#define CYTHON_COMPILING_IN_CPYTHON 1/#define CYTHON_COMPILING_IN_CPYTHON 0/" "$C"
else
  echo "WARN: no CYTHON_COMPILING_IN_CPYTHON line found in $C"
fi
# --- compile ---
# CYTHON_USE_TYPE_SPECS=1: build Cython's own heap types (CyFunctionType, …) via
# PyType_Spec + slot IDs (Py_tp_call=77 …) which the bridge maps by ID, instead
# of the static positional PyTypeObject initializer (whose field order must match
# wasthon.h's PyTypeObject exactly, or tp_call lands on the wrong slot).
# Py_OptimizeFlag=0: the one symbol the IN_CPYTHON=0 route still references.
PP="-DCYTHON_USE_TYPE_SPECS=1 -DCYTHON_USE_MODULE_STATE=0 -DCYTHON_FAST_THREAD_STATE=0 -DCYTHON_USE_EXC_INFO_STACK=0 -DCYTHON_USE_TYPE_SLOTS=0 -DCYTHON_USE_PYTYPE_LOOKUP=0 -DCYTHON_USE_UNICODE_INTERNALS=0 -DCYTHON_USE_PYLONG_INTERNALS=0 -DCYTHON_USE_PYLIST_INTERNALS=0 -DCYTHON_ASSUME_SAFE_MACROS=0 -DCYTHON_UNPACK_METHODS=0 -DCYTHON_AVOID_BORROWED_REFS=1 -DPy_OptimizeFlag=0"
command -v emcc >/dev/null 2>&1 || source "$ROOT/external/emsdk/emsdk_env.sh" 2>/dev/null
emcc -O1 -c -DNDEBUG -DPy_PYTHON_H $PP -Wno-macro-redefined -Wno-int-conversion -Wno-incompatible-pointer-types \
  -include "$CS/cython_compat.h" -I "$SRC" -I "$CS" "$C" -o "$OUT/$(basename ${MOD//./_}).o" 2>"$OUT/$(basename ${MOD//./_})_err.txt"
echo "compile exit=$?  errors=$(grep -c 'error:' "$OUT/$(basename ${MOD//./_})_err.txt")"
grep 'error:' "$OUT/$(basename ${MOD//./_})_err.txt" | head
