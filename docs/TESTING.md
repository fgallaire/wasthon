# Testing and measurement — the validation system

How Wasthon's numbers are produced, and the rules that make them
trustworthy. The headline claim (21 CPython suites, zero fail) is only as
good as this machinery — treat the discipline section as part of the
codebase.

## The CPython suite harness

The ported modules are validated against **CPython's own test suites**,
run unmodified in a real browser:

- `loader/test-cpython.html` — runs one suite (`?test=test_zlib`) against
  the wasm bundle + vendored Brython. The suite's Python source is served
  as-is; a small shim maps `unittest` output to a scoreboard the driver
  scrapes.
- `loader/test-cpython-all.html` — the dashboard: every suite, per-suite
  bars and the aggregate line.
- **`driver-par.py`** — the reference runner: N headless Firefox workers
  over a local HTTP server (port 8780), suites scheduled **longest-first**
  (LPT — `test_pickle` ~8 min dominates the makespan; everything else
  packs around it). Usage:

  ```sh
  python3 driver-par.py --jobs 8 --deadline 840        # full 21-suite sweep, ~8 min
  python3 driver-par.py --deadline 900 test_pickle     # one suite
  ```

  Run **one** sweep per machine: the deadline must exceed the longest
  suite (≥ 900 s when pickle is included), and fast + slow suites go in
  the *same* invocation — never a separate "quick" pass followed by the
  long one.
- `driver-firefox.py --detail` — single suite with per-test failure
  detail, for diagnosis.

## The gating metric

Per-suite score = **`pass / (pass + fail)` — skips excluded** from the
denominator. Skips are deliberate no-paths (OpenSSL absent by design,
threads/GIL, documented architectural limits of Brython), not failures to
fix; counting them punishes exactly the modules that declare their limits
honestly. Corollary: a metric that gets *worse* when the system gets
*better* is broken — suspect the metric before the work.

A suite that ERRORs or times out is **not countable**: fix the blocker
first, then measure. Totals computed over a broken suite are noise.

## Measurement discipline

These rules exist because every one of them was violated once and cost a
session:

- **One fix = one commit = one isolated measurement.** The commit message
  states the measured **+N** (new PASSes in parent-test units — never
  skips, never "X→Y" ranges, never a predicted number). Measure in the
  exact state a puller would get.
- **Bridge and vendored-Brython changes are separate commits** — they
  have different test surfaces (a bridge change needs every `.mjs`
  relinked; a vendored change is live on reload) and different logs
  (`CHANGELOG.md` vs `BRYTHON_FIX.md`). The doc entry belongs *in* the
  commit it documents.
- **Core-type changes sweep the numeric suites.** Anything touching
  int/float/str/bytes comparison, formatting or hashing runs
  `test_math`, `test_cmath`, `test_statistics`, `test_decimal`,
  `test_json`, `test_pickle` before commit — these suites are the
  sensitive detectors for semantic drift.
- **Count with the driver, never by grepping logs.** The driver's own
  scoreboard is the source of truth; log-grepping double-counts subtests
  and misses errors.
- **"Flaky" is not a diagnosis.** A test that changes verdict between
  runs has a cause (two harnesses colliding, a stale cache, a real
  order-dependence) — find it.

## Browser and selenium hygiene

- **Never run two selenium harnesses in parallel.** Verdicts from
  concurrent runs are polluted in both directions (shared ports, shared
  geckodriver, CPU starvation masquerading as timeouts) and both runs are
  wasted.
- Cleanup is `pkill -x geckodriver` **only** — never firefox itself, and
  never while another run is active.
- Browsers cache `.mjs` modules aggressively by URL: after a relink,
  hard-refresh (Ctrl+Shift+R) or cache-bust the dynamic import
  (`…/bundle.mjs?t=' + Date.now()`). To verify a bridge change survived
  the build at all: `grep` the built `.mjs` for it.

## Targeted regression pages

Beyond the suites, a few pages lock specific invariants:

- `loader/test-scopes.html` — handle-table flatness per call (the
  handle-scope lifetime model; see `docs/BRIDGE.md`).
- `loader/test-tp-dealloc.html` — A/B reclaimed-vs-leaked memory bench
  (`rt.noFree` switch); acceptance for any dealloc change = "the relevant
  size stays flat over a loop".
- `loader/test-debug.html` — attribute-lookup symmetry on wasthon heap
  types (the 4 lookup paths + 2 call paths that once silently diverged).

## The scientific stack

numpy / pandas / scipy / matplotlib / seaborn are validated the same way
(the upstream projects' own test suites, in-browser dashboards) but live
in the **NumBry** repo — see its `docs/BUILD.md` for the build/relink
rules and its per-package docs for the suites each dashboard covers.
