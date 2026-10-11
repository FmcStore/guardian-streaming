"""Uji end-to-end backend Guardian baru lewat HTTP, seperti browser."""
import json
import re
import urllib.request

import os
BASE = os.environ.get("BASE", "http://127.0.0.1:8801")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
ok = 0
bad = 0


def check(name, cond, extra=""):
    global ok, bad
    if cond:
        ok += 1
        print("  PASS  %-46s %s" % (name, extra))
    else:
        bad += 1
        print("  FAIL  %-46s %s" % (name, extra))


def get(path, timeout=200):
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(), dict(r.headers)


print("=== 1. katalog ===")
st, body, _ = get("/api/health")
check("health 200", st == 200)
d = json.loads(get("/api/home")[1])
check("home sections > 0", len(d["sections"]) > 0, "sections=%d" % len(d["sections"]))
check("home latest > 0", len(d["latest"]) > 0, "latest=%d" % len(d["latest"]))
first = d["latest"][0]
check("item punya field UI (poster/title/url)",
      all(k in first for k in ("poster", "title", "rating", "url")), str(first.get("url")))

d = json.loads(get("/api/browse/populer?page=1")[1])
check("browse items", len(d["items"]) > 0, "n=%d pages=%s" % (len(d["items"]), d["totalPages"]))

d = json.loads(get("/api/browse/latest-series?page=1")[1])
types = {i["type"] for i in d["items"]}
check("latest-series hanya series", types == {"series"}, str(types))

d = json.loads(get("/api/browse/genre/Action?page=1")[1])
check("browse genre Action", len(d["items"]) > 0, "n=%d" % len(d["items"]))

d = json.loads(get("/api/browse/country/KR?page=1")[1])
check("browse country KR", len(d["items"]) > 0, "n=%d" % len(d["items"]))

d = json.loads(get("/api/browse/year/1999?page=1")[1])
years = {i.get("year") for i in d["items"]}
check("browse year 1999", years <= {1999}, str(years))

d = json.loads(get("/api/search?q=matrix&page=1")[1])
check("search matrix", len(d["items"]) > 0, "n=%d" % len(d["items"]))

d = json.loads(get("/api/genres")[1])
check("genres", len(d["items"]) > 0, "n=%d" % len(d["items"]))
d = json.loads(get("/api/countries")[1])
check("countries", len(d["items"]) > 0, "n=%d" % len(d["items"]))
d = json.loads(get("/api/years")[1])
check("years", len(d["items"]) > 0, "n=%d contoh=%s" % (len(d["items"]), d["items"][:3]))

print()
print("=== 2. detail ===")
d = json.loads(get("/api/detail?url=" + urllib.parse.quote("movie/550"))[1])
check("detail movie title", d["title"] == "Fight Club", d["title"])
check("detail movie cast", len(d["cast"]) > 0, "cast=%d" % len(d["cast"]))
check("detail movie related", len(d["related"]) > 0, "rel=%d" % len(d["related"]))
check("detail movie genres", len(d["genres"]) > 0, str(d["genres"][:3]))
check("detail movie type", d["type"] == "movie")

d = json.loads(get("/api/detail?url=" + urllib.parse.quote("tv/1396"), 300)[1])
check("detail tv title", d["title"] == "Breaking Bad", d["title"])
seasons = sorted(d["seasons"].keys(), key=int)
check("detail tv seasons", len(seasons) >= 4, "seasons=%s" % seasons[:6])
ep = d["seasons"].get(seasons[1], [])
check("detail tv episode punya url internal",
      bool(ep) and ep[0]["url"].startswith("tv/1396?s="), str(ep[0]["url"] if ep else None))

print()
print("=== 3. stream (players) ===")
d = json.loads(get("/api/stream?url=" + urllib.parse.quote("movie/550"), 400)[1])
check("stream players > 0", len(d["players"]) > 0, "n=%d" % len(d["players"]))
check("player url absolut (syarat iframe UI)",
      all(p["url"].startswith("http://") or p["url"].startswith("https://")
          for p in d["players"]),
      ", ".join(p["server"] for p in d["players"]))
check("tidak ada URL host media yang bocor ke browser",
      all("/api/player?" in p["url"] for p in d["players"]),
      (d["players"][0]["url"] if d["players"] else ""))

print()
print("=== 4. halaman player + sumber ===")
st, body, _ = get("/api/player?k=movie&id=550&p=5&embed=1")
check("halaman player 200 html", st == 200 and b"<video" in body)

st, body, _ = get("/data/sources?k=movie&id=550&player=5", 400)
ds = json.loads(body)
check("data/sources ok", ds.get("ok") is True, "sources=%d" % len(ds["data"]["sources"]))
srcs = ds["data"]["sources"]
check("ada minimal satu sumber hidup", len(srcs) > 0,
      "hidup=%d mati=%s" % (len(srcs), ds["data"].get("deadSources")))
check("playlist menunjuk ke /hls server ini",
      all(s["playlist"].startswith("/hls/index.m3u8?t=") for s in srcs))

if srcs:
    print()
    print("=== 5. proxy HLS sungguhan ===")
    pl = srcs[0]["playlist"]

    # Telusuri playlist: master -> varian -> segmen. hls.js melakukan ini
    # sendiri lewat URL yang kita tulis ulang, jadi uji juga jalur itu.
    cur_url = pl
    body_text = ""
    segs = []
    for depth in range(4):
        st, body, hdr = get(cur_url, 90)
        body_text = body.decode("utf8", "replace")
        check("playlist 200 + m3u8" + (" (varian %d)" % depth if depth else ""),
              st == 200 and body_text.lstrip().startswith("#EXTM3U"),
              "ctype=%s" % hdr.get("Content-Type"))
        leaks = [l for l in body_text.splitlines() if l.strip().startswith("http")]
        check("tidak ada URL http mentah" + (" (varian %d)" % depth if depth else ""),
              not leaks, "bocor=%d" % len(leaks))
        uris = [l.strip() for l in body_text.splitlines()
                if l.strip() and not l.startswith("#")]
        check("URI menunjuk balik ke /hls/" + (" (varian %d)" % depth if depth else ""),
              bool(uris) and all(u.startswith("/hls/") for u in uris),
              "n=%d" % len(uris))
        if not uris:
            break
        if "/hls/seg?" in uris[0]:
            segs = uris
            break
        cur_url = uris[0]  # ini varian playlist, turun satu lapis
        check("master playlist punya banyak varian", len(uris) >= 1,
              "varian=%d" % len(uris))

    check("sampai ke level segmen", bool(segs), "segmen=%d" % len(segs))
    if segs:
        st, seg, h2 = get(segs[0], 90)
        check("segmen pertama 200", st == 200,
              "ctype=%s bytes=%d" % (h2.get("Content-Type"), len(seg)))
        # TS diawali 0x47; fMP4 memuat ftyp/moof. Nilai lain berarti bukan video.
        check("segmen benar-benar data video",
              len(seg) > 1000 and (seg[:1] == b"\x47" or b"ftyp" in seg[:64]
                                   or b"moof" in seg[:64] or b"styp" in seg[:64]),
              "magic=%r bytes=%d" % (seg[:8], len(seg)))

    # subtitle
    subs = srcs[0].get("subtitles") or []
    if subs:
        st, sub, h3 = get(subs[0]["url"], 60)
        check("subtitle jadi VTT", st == 200 and sub.startswith(b"WEBVTT"),
              "ctype=%s" % h3.get("Content-Type"))

print()
print("=== 6. error handling ===")
try:
    get("/api/detail?url=" + urllib.parse.quote("movie/999999999"))
    check("detail id ngawur -> 4xx", False, "tidak error")
except urllib.error.HTTPError as e:
    check("detail id ngawur -> 4xx", 400 <= e.code < 500, "HTTP %d" % e.code)
try:
    get("/hls/index.m3u8?t=tidakada")
    check("token hls ngawur -> 410", False, "tidak error")
except urllib.error.HTTPError as e:
    check("token hls ngawur -> 410", e.code == 410, "HTTP %d" % e.code)
try:
    get("/api/nonexistent")
    check("route ngawur -> 404", False)
except urllib.error.HTTPError as e:
    check("route ngawur -> 404", e.code == 404, "HTTP %d" % e.code)

print()
print("== %d passed, %d failed ==" % (ok, bad))
