#!/usr/bin/env python3
"""Reliable narrow check for the recurring bug class: a SCREAMING_CASE lookup
table used as NAME[...] but never declared. No cleaning, no parsing — a raw
substring test for the declaration, which cannot produce false negatives."""
import re, sys
src = open(__import__('os').path.join(__import__('os').path.dirname(__file__),'..','apps','web','src','App.jsx')).read()
used = set(re.findall(r'\b([A-Z][A-Z0-9_]{2,})\s*\[', src))
missing = sorted(n for n in used
                 if not re.search(r'\b(?:const|let|var)\s+' + n + r'\b', src)
                 and not re.search(r'\b' + n + r'\s*[:,]', src))
if missing:
    print("UNDEFINED LOOKUP TABLES:", ", ".join(missing)); sys.exit(1)
print(f"symbol check: clean ({len(used)} lookup tables verified)")

# The artifact runner evaluates App.jsx as a plain script, where import.meta is
# a parse error. Keep it out permanently.
import re as _re
_src = open("apps/web/src/App.jsx", encoding="utf-8").read()
_code = _re.sub(r"/\*[\s\S]*?\*/", "", _src)
_code = _re.sub(r"(?m)//.*$", "", _code)
if "import.meta" in _code:
    print("FAIL: import.meta is not allowed in App.jsx (breaks script-mode artifact rendering)")
    raise SystemExit(1)
print("script-mode check: no import.meta")

# The Tailwind CDN script warns in the console, ships the whole engine to every
# visitor and cannot be cached or versioned. The app compiles its own CSS.
_html = open("apps/web/index.html", encoding="utf-8").read()
if "cdn.tailwindcss.com" in _html:
    print("FAIL: apps/web/index.html loads Tailwind from the CDN; build it instead")
    raise SystemExit(1)
if "index.css" not in open("apps/web/src/main.jsx", encoding="utf-8").read():
    print("FAIL: main.jsx does not import the compiled stylesheet")
    raise SystemExit(1)
print("stylesheet check: Tailwind is compiled, not CDN")
