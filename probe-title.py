#!/usr/bin/env python3
"""Ringkas: untuk satu judul, player mana yang menghasilkan sumber hidup."""
import json
import sys
import time
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
G = "http://127.0.0.1:8810"
S = "http://127.0.0.1:8798"
mid = sys.argv[1] if len(sys.argv) > 1 else "1175161"


def get(url, timeout=600):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as f:
        return json.load(f)


print(f"=== id={mid} ===")
# /api/detail membalas objek judul secara langsung, tanpa pembungkus `data`.
d = get(f"{G}/api/detail?url=movie%2F{mid}")
print(f"  judul: {d.get('title')}  ({d.get('release') or d.get('year')})")

hidup_total = 0
for pid in (1, 5, 9):
    t0 = time.time()
    try:
        r = get(f"{G}/data/sources?k=movie&id={mid}&player={pid}")
    except Exception as e:
        # Sebagian player memang tidak punya sumber untuk judul tertentu dan
        # membalas 404/502. Itu hasil yang sah, bukan kegagalan uji.
        badan = ""
        if hasattr(e, "read"):
            try:
                badan = e.read().decode("utf-8", "replace")[:110]
            except Exception:
                badan = ""
        print(f"  P{pid}: {time.time() - t0:6.1f}s  KOSONG  {str(e)[:50]}  {badan}")
        continue
    dt = time.time() - t0
    dd = r.get("data") or {}
    srcs = dd.get("sources") or []
    hidup_total += len(srcs)
    print(f"  P{pid}: {dt:6.1f}s  hidup={len(srcs)}  dibuang={dd.get('deadSources')}"
          f"  label={[s['label'] for s in srcs][:4]}")

print(f"  -> total sumber hidup: {hidup_total}")

# Apakah upstream sendiri mengembalikan tmdbId yang benar?
raw = get(f"{S}/api/streams/movie/{mid}?player=5")
print(f"  upstream P5: tmdbId={raw.get('tmdbId')} sumber={len(raw.get('sources') or [])} "
      f"subtitle={len(raw.get('subtitles') or [])}")
