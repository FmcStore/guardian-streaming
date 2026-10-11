# Guardian (streamex)

Versi Guardian yang **tidak lagi meng-scrape lk21**. Semua katalog dan sumber
tontonan datang dari **streamex-api** (REST API milik sendiri atas streamex.pw),
dan pemutaran ditangani **proxy HLS di server** supaya benar-benar jalan tanpa
CORS proxy pihak ketiga.

Antarmuka React-nya **tidak disentuh sama sekali**. Semua file UI
(`index.html`, `src/`, `vite.config.ts`, `tsconfig*.json`, `package.json`)
disalin apa adanya, byte per byte, dari repo `fmcstore/streaming`.

## Kenapa perlu proxy HLS

URL media streamex tidak bisa dibuka langsung oleh browser pengunjung. Tiga
sebab, semuanya sudah dibuktikan lewat pengujian:

| Player | Kenapa tidak bisa langsung |
|---|---|
| P1 vsembed | token `?token=` terikat IP penanda tangan |
| P5 vidbolt | sebagian butuh Cookie CloudFront dari respons server |
| P9 xpass | balas **403** kalau `Referer` bukan halaman embednya |

Kalau URL host media ditanam di `<iframe>` atau `<video>` milik halaman, hasilnya
selalu gagal putar. Jadi server yang menarik playlist dan segmennya, browser
hanya melihat origin kita sendiri. Tidak ada lagi `uncors.netlify.app`, tidak ada
lagi `/pp/`.

## Cara jalan

```
browser  ->  /api/player?...            (iframe, same-origin)
                |
                +-- /data/sources       server menyelesaikan sumber, uji satu per satu
                |
                +-- /hls/index.m3u8     playlist ditulis ulang, semua URI balik ke sini
                        |
                        +-- /hls/seg     segmen diteruskan dengan header asli
                        +-- /sub/*.vtt   subtitle .srt diubah ke .vtt
```

Deskriptor sumber (URL asli + header sensitif seperti `Referer`/`Cookie`)
disimpan di memori server dan diwakili token acak pendek. Token itu yang muncul
di URL, jadi header rahasia tidak ikut ke riwayat browser atau log akses. Token
mati setelah 10 menit.

## Endpoint UI

```
GET /api/home                          beranda (sections + latest)
GET /api/browse/:path?page=&type=      /populer, /latest, /latest-series,
                                       /rating, /release, /top-movie-today,
                                       /most-commented, /genre/:x,
                                       /country/:x, /year/:x, /quality/:x
GET /api/search?q=&page=
GET /api/genres | /api/countries | /api/years
GET /api/detail?url=movie/550          detail film/series + episode
GET /api/stream?url=movie/550          daftar server yang bisa dipakai
GET /api/player?k=&id=&s=&e=&p=        halaman player (di-embed sebagai iframe)
GET /data/sources?k=&id=&player=       sumber yang sudah lolos uji + playlist
GET /hls/index.m3u8?t=[&v=]            playlist (v = turuni master playlist)
GET /hls/seg?t=&u=                     segmen video
GET /sub/:name.vtt?t=                  subtitle
GET /api/health
```

`GET /api/stream` sengaja **tidak** menyelesaikan stream. Ia hanya bertanya
"server mana yang punya resolver" (milidetik), karena menyelesaikan stream
butuh 10 sampai 150 detik (resolver menyalakan Chromium tanpa kepala).
Penyelesaian dilakukan di dalam iframe, saat player benar-benar dibuka.

## Status player

Dari 12 player streamex, 3 punya resolver dan tampil di UI. Ketiganya sudah
diuji di Chromium sungguhan dan **benar-benar berputar**:

| ID | Nama | Sumber hidup | Hasil uji putar | Catatan |
|---|---|---|---|---|
| 1 | vsembed | 3 / 3 | **YA** | 640x266, 8348 dtk; token di-mint sekali per origin, retry saat 429 |
| 5 | vidbolt | 1 / 11 | **YA** | 640x360, 8352 dtk; fan-out 15 provider, 31 subtitle |
| 9 | xpass | 2 / 6 | **YA** | 640x266, 8348 dtk; perlu header `Referer: https://play.xpass.top/` |

Sisanya (2, 3, 4, 6, 7, 8, 10, 11, 12) belum punya resolver, jadi **tidak
ditampilkan** sebagai tombol. Tombol yang tidak bisa apa-apa lebih buruk daripada
tombol yang tidak ada.

### Kenapa P5 hanya menyisakan 1 dari 11 sumber

10 sumber sisanya **H.265 (HEVC)**, dibuktikan dengan `ffprobe` pada init
segmentnya, bukan disimpulkan dari tag playlist. Chrome tidak punya dekoder
HEVC, jadi mengiklankannya berarti mengirim penonton ke layar hitam. Yang
menjadi jebakan: host Callisto **tidak mencantumkan `CODECS`** di playlist, jadi
penyaringan berbasis tag saja tidak cukup. Karena itu codec ditentukan dari
datanya:

- fMP4: fourcc (`hvc1`/`hev1`/`hvcC`) dibaca dari init segment (`#EXT-X-MAP`)
- MPEG-TS: `stream_type 0x24` dibaca dari tabel PMT di dalam paket

Penyaringan ini juga berjalan sebelum sumber diiklankan, jadi jumlah ini bisa
berubah kalau host mengubah penyandiannya.

## Dua hal yang wajib ada, dan alasannya

**hls.js (`assets/hls.min.js`).** Chrome dan Firefox tidak punya dukungan HLS
native. Dengan `<video src="...m3u8">` polos, hasilnya
`DEMUXER_ERROR_COULD_NOT_PARSE` dan layar hitam untuk hampir semua sumber.
Dengan hls.js, ketiga server berputar. Safari memang bisa native, jadi halaman
player tetap punya jalur cadangan itu. Berkasnya dilayani dari server sendiri,
bukan CDN pihak ketiga, supaya player tetap jalan walau CDN mati dan tidak ada
permintaan keluar yang membocorkan apa yang sedang ditonton.

**Penyaringan sampai segmen pertama.** Playlist yang terbaca belum berarti bisa
diputar. P9 membuktikannya: playlist-nya balas 200, segmennya balas 403. Karena
itu setiap sumber diuji sampai segmen pertama benar-benar datang, dan codecnya
dibaca dari data itu.

## Kejujuran hasil

- Sumber di `/data/sources` **diuji satu per satu** sebelum diiklankan. Yang
  menolak, yang terputus, yang H.265, dan yang segmennya tidak bisa diambil
  dibuang; yang lolos baru dikirim. `deadSources` melaporkan berapa yang dibuang.
- Kalau semua sumber sebuah judul gugur, halaman player mengatakannya apa
  adanya. Tombol server yang tidak bisa apa-apa tidak pernah ditampilkan.
- Satu trek audio/subtitle alternatif yang gagal **tidak** dianggap kegagalan
  putar selama video utamanya berjalan. Ini bukan asumsi: pernah terjadi, dan
  pesan "semua sumber gagal" muncul saat filmnya jelas-jelas berjalan.
- Tidak ada URL host media yang bocor ke browser. Diperiksa otomatis di
  `test-e2e.py` (tidak ada URL `http` mentah di playlist).
- Satu segmen yang koneksinya putus **tidak** mematikan server. Tanpa
  penanganan itu, satu penonton dengan koneksi buruk menjatuhkan seluruh server
  (`NGHTTP2_PROTOCOL_ERROR` sudah pernah terjadi).

## Menjalankan

```bash
# streamex-api harus hidup di :8798 (lihat repo FmcStore/streamex-api)
bun install
bun run build                       # UI, byte-identik dari repo lama
PORT=8801 node server/index.js

# uji
python3 test-e2e.py                 # backend + proxy HLS sungguhan
node test-ui.cjs  http://127.0.0.1:8801   # UI di Chromium
node test-video.cjs http://127.0.0.1:8801 1 5 9   # video benar-benar berjalan
```

Variabel lingkungan:

- `PORT` (default `8787`)
- `STREAMEX_API` (default `http://127.0.0.1:8798`)
- `DIST_DIR` (default `dist`)

## Berkas

```
server/index.js      HTTP, rute UI, halaman player
server/streamex.js   klien streamex-api + penyelesaian sumber
server/media.js      proxy HLS: tolak-ulang playlist, segmen, subtitle
server/player.js     halaman player (di-embed UI sebagai iframe)
test-e2e.py          uji backend end-to-end (termasuk segmen sungguhan)
test-ui.cjs          uji UI di Chromium lewat CDP
test-video.cjs       uji video benar-benar berjalan di tiap server
```
