#!/usr/bin/env python3
"""
test.py — drive loader/test-all.html headlessly via Playwright.

Boots a `python3 -m http.server` in background, opens Chromium via Playwright,
navigates to test-all.html, waits for the canonical `#summary` to settle
(either `✓ N/M pages passed` for success, or something containing "failed"
or "timed out" for failure), prints a recap, exits 0 on success / 1 on
failure / 2 on harness error.

Designed for both local dev (`python3 test.py`) and CI
(`.github/workflows/test.yml`). Assumes the wasthon artifacts under
`build/` already exist — run `./build.sh all && ./build.sh wasthon &&
./build.sh wasthon-full` first.
"""

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT = 8765
HOST = "127.0.0.1"
TOTAL_BUDGET_MS = 6 * 60 * 1000  # 6 min: 5 for test-all + 1 margin

REPO_ROOT = Path(__file__).resolve().parent


def wait_for_server(url, timeout_s=10):
    """Poll the URL until it responds (or raises after `timeout_s`)."""
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                # Any HTTP reply means the server is up; 404 on this exact
                # URL is also "up" — we just want to know it's listening.
                if resp.status in (200, 404):
                    return
        except Exception as e:
            last_err = e
        time.sleep(0.2)
    raise RuntimeError(f"server not ready at {url} after {timeout_s}s (last err: {last_err})")


def main():
    print(f"spawning http.server on {HOST}:{PORT} (cwd={REPO_ROOT})")
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT), "--bind", HOST],
        cwd=REPO_ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        wait_for_server(f"http://{HOST}:{PORT}/loader/index.html", timeout_s=10)
        print("server ready, launching Chromium headless")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            # Surface browser errors/warnings in CI logs so failed runs are
            # diagnosable without rerunning locally.
            def _on_console(msg):
                if msg.type in ("error", "warning"):
                    print(f"  [browser {msg.type}] {msg.text}")
            page.on("console", _on_console)

            url = f"http://{HOST}:{PORT}/loader/test-all.html"
            print(f"navigating to {url}")
            page.goto(url, wait_until="domcontentloaded")

            # Wait for the runner's summary marker. test-all.html writes
            # either "✓ N/M pages passed" (success) or a line containing
            # "K failed" / "timed out" (failure).
            print("waiting for summary…")
            page.wait_for_function(
                """() => {
                    const el = document.getElementById('summary');
                    if (!el) return false;
                    const txt = el.textContent || '';
                    return txt.startsWith('✓') ||
                           /\\d+ failed/.test(txt) ||
                           /timed out/.test(txt);
                }""",
                timeout=TOTAL_BUDGET_MS,
            )

            summary_text = (page.locator("#summary").text_content() or "").strip()
            rows = page.locator("#results tbody tr").evaluate_all(
                """trs => trs.map(tr => ({
                    page:     tr.children[0].textContent.trim(),
                    status:   tr.children[1].textContent.trim(),
                    duration: tr.children[2].textContent.trim(),
                }))"""
            )

            print("\n=== test-all results ===")
            for r in rows:
                print(f"  {r['status']:<14} {r['page']:<30} {r['duration']}")
            print(f"\n=== summary ===\n  {summary_text}\n")

            browser.close()

            ok = summary_text.startswith("✓")  # ✓
            sys.exit(0 if ok else 1)

    except Exception as e:
        print(f"harness error: {e}", file=sys.stderr)
        sys.exit(2)
    finally:
        server.terminate()
        try:
            server.wait(timeout=2)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    main()
