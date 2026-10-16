#!/usr/bin/env python3
"""Build conversion_model_lab.html (single self-contained file) from src/.

    python3 build.py

The app is authored as separate sources for maintainability — styles, the analytical
engine (Web Worker) and the app modules — and shipped as one HTML file.
"""
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "conversion_model_lab.html"


def main() -> None:
    template = (SRC / "index.html").read_text()
    styles = (SRC / "styles.css").read_text()
    worker = (SRC / "worker.js").read_text()
    modules = sorted((SRC / "app").glob("*.js"))
    app = "\n".join(f"/* ---- {m.name} ---- */\n{m.read_text()}" for m in modules)
    for name, body in (("worker", worker), ("app", app)):
        if "</script" in body.lower():
            raise SystemExit(f"{name} source contains '</script', which would end the inline script early")
    html = (template.replace("/*__STYLES__*/", styles)
                    .replace("/*__WORKER__*/", worker)
                    .replace("/*__APP__*/", app))
    OUT.write_text(html)
    print(f"wrote {OUT.name}: {len(html) / 1024:.0f} KB from {len(modules)} modules")


if __name__ == "__main__":
    main()
