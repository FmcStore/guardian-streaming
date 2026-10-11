/**
 * Guardian — backend JSON di atas streamex-api.
 *
 * Tugasnya dua:
 *  1. Menjembatani UI Guardian (yang dulu bicara ke scraper lk21) ke
 *     streamex-api, tanpa mengubah satu baris pun di frontend.
 *  2. Menjadi satu-satunya pihak yang menyentuh host media: menarik playlist
 *     HLS dari streamex-api beserta header yang dibutuhkannya, lalu
 *     menyajikannya kembali ke browser. Browser tidak pernah memegang token,
 *     Referer, atau Cookie milik host media, dan tidak ada lagi ketergantungan
 *     ke CORS proxy pihak ketiga.
 *
 * Jalankan: `npm run server`  (default http://localhost:8787)
 * Kalau ada build di ../dist, SPA-nya ikut disajikan.
 */

import * as http from 'node:http'
import { URL } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  home, browse, search, getGenres, getCountries, getYears, detail, stream,
  resolveSources, resolvablePlayerIds, StreamExError,
} from './streamex.js'
import { resolveSource, renderPlaylist, proxySegment, proxySubtitle, unb64url } from './media.js'
import { renderPlayerPage } from './player.js'

const PORT = process.env.PORT || 8787
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.join(__dirname, '..', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.aac': 'audio/aac',
}

/* ------------------------------------------------------------------ helpers */

function setJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

/**
 * Origin publik tempat halaman ini dilayani. Dipakai untuk menyusun URL player
 * yang absolut, karena UI hanya meng-iframe URL absolut atau `/pp/`.
 * DI BELAKANG PROXY: `x-forwarded-proto` dan `x-forwarded-host` dihormati
 * supaya URL tetap benar saat diakses lewat tunnel HTTPS.
 */
function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`)
    .split(',')[0].trim()
  return `${proto}://${host}`
}

function fail(res, err) {
  // StreamExError membawa status dari API hulu. Proxy HLS juga melempar Error
  // biasa dengan `.status` sendiri (410 token kedaluwarsa, 502 hulu menolak),
  // jadi keduanya dihormati di sini.
  const status = err instanceof StreamExError ? err.status : (err.status || 500)
  return setJson(res, status || 500, {
    error: err.message || 'terjadi kesalahan',
    path: undefined,
  })
}

/* ------------------------------------------------------------------ SPA */

function serveStatic(req, res) {
  if (!fs.existsSync(DIST_DIR)) return false
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  let file = path.normalize(path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath))
  if (!file.startsWith(DIST_DIR)) file = path.join(DIST_DIR, 'index.html')
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
    return true
  }
  if (urlPath.startsWith('/api') || urlPath.startsWith('/hls') || urlPath.startsWith('/player')) return false
  const indexFile = path.join(DIST_DIR, 'index.html')
  if (fs.existsSync(indexFile)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    fs.createReadStream(indexFile).pipe(res)
    return true
  }
  return false
}

/* ------------------------------------------------------------------ routes */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname
  const q = url.searchParams
  const page = parseInt(q.get('page')) || 1
  const type = q.get('type') || ''

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' })
      return res.end()
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return setJson(res, 405, { error: 'hanya GET' })
    }

    if (p === '/api/health') {
      return setJson(res, 200, { ok: true, upstream: 'streamex-api' })
    }

    /* ---------- katalog ---------- */

    if (p === '/api/home') {
      const raw = await home()
      return setJson(res, 200, {
        sections: raw.sections.map((s) => ({
          type: s.type, title: s.title, seeAll: s.seeAll, items: s.items,
        })),
        latest: raw.latest,
      })
    }

    if (p.startsWith('/api/browse')) {
      const rest = p.replace(/^\/api\/browse/, '') || '/populer'
      const raw = await browse(rest, page, type)
      return setJson(res, 200, {
        title: raw.title,
        page: raw.page,
        totalPages: raw.totalPages,
        items: raw.items,
        path: raw.path,
      })
    }

    if (p === '/api/genres') {
      const items = await getGenres()
      return setJson(res, 200, { items, total: items.length })
    }
    if (p === '/api/countries') {
      const items = await getCountries()
      return setJson(res, 200, { items, total: items.length })
    }
    if (p === '/api/years') {
      const items = await getYears()
      return setJson(res, 200, { items, total: items.length })
    }

    if (p === '/api/search') {
      const raw = await search(q.get('q') || '', page)
      return setJson(res, 200, {
        query: raw.query, page: raw.page, totalPages: raw.totalPages, items: raw.items,
      })
    }

    if (p === '/api/detail') {
      const target = q.get('url') || ''
      if (!target) return setJson(res, 400, { error: 'url required' })
      return setJson(res, 200, await detail(target))
    }

    /* ---------- playback ---------- */

    if (p === '/api/stream') {
      const target = q.get('url') || ''
      if (!target) return setJson(res, 400, { error: 'url required' })
      const raw = await stream(target, requestOrigin(req))
      return setJson(res, 200, {
        url: raw.url,
        title: raw.title,
        players: raw.players,
        nav: raw.nav,
        subtitles: raw.subtitles,
        failedPlayers: raw.failedPlayers,
        mediaType: raw.mediaType,
        season: raw.season,
        episode: raw.episode,
      })
    }

    // Halaman player yang di-embed UI. Semua yang dibutuhkan player ada di
    // query string, jadi tidak ada state di server.
    if (p === '/api/player') {
      const html = renderPlayerPage({
        kind: q.get('k') || 'movie',
        id: q.get('id') || '',
        season: q.get('s') || '',
        episode: q.get('e') || '',
        playerId: q.get('p') || '5',
        embed: q.get('embed') === '1',
        // Registri player yang punya resolver, dipakai halaman player untuk
        // mencoba player lain kalau yang diminta tidak punya sumber hidup.
        playerIds: resolvablePlayerIds(),
      })
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      return res.end(html)
    }

    // Playlist HLS hasil normalisasi. Semua URL di dalamnya sudah menunjuk
    // kembali ke /hls/... sehingga browser tidak pernah keluar dari origin ini.
    if (p === '/hls/index.m3u8') {
      const st = await resolveSource(q)
      // `v` dipakai untuk menuruni master playlist (varian) tanpa keluar origin.
      const variant = q.get('v') ? unb64url(q.get('v')) : ''
      // Hanya boleh http(s); mencegah token palsu mengubah server jadi SSRF.
      const target = /^https?:\/\//i.test(variant) ? variant : st.url
      const body = await renderPlaylist(st, q.get('t'), target)
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      return res.end(body)
    }

    // Dipakai halaman player (/api/player) untuk mengambil daftar sumber yang
    // sudah lewat server, lengkap dengan playlist per sumber.
    if (p === '/data/sources') {
      // Player yang sudah dicoba (dari pemanggil) tidak perlu diulang lagi.
      const sudah = new Set((q.get('p') || '').split(',').filter(Boolean))
      const playerId = q.get('player') || '5'
      sudah.add(String(playerId))
      const sisa = resolvablePlayerIds().filter((n) => !sudah.has(String(n)))
      try {
        const data = await resolveSources({
          kind: q.get('k') || 'movie',
          id: q.get('id') || '',
          season: q.get('season') || '',
          episode: q.get('episode') || '',
          playerId,
        })
        return setJson(res, 200, {
          ok: true,
          data,
          nextPlayers: sisa,
          triedPlayers: [...sudah],
        })
      } catch (err) {
        // Sertakan juga saat GAGAL: halaman player perlu tahu ada player lain
        // yang layak dicoba, dan mana saja yang sudah dicoba. Tanpa ini,
        // kegagalan satu player terlihat seperti judulnya yang tidak ada.
        return setJson(res, Number(err.status) || 502, {
          ok: false,
          error: err.message,
          nextPlayers: sisa,
          triedPlayers: [...sudah],
        })
      }
    }

    if (p === '/hls/seg') {
      return proxySegment(q, res)
    }

    // Subtitle: sumbernya .srt, browser hanya mau .vtt.
    if (p.startsWith('/sub/')) {
      return proxySubtitle(p.slice('/sub/'.length), q, res)
    }

    // hls.js dilayani dari sini sendiri, bukan CDN pihak ketiga: halaman player
    // harus tetap jalan walau CDN mati, dan tidak ada permintaan keluar yang
    // membocorkan apa yang sedang ditonton.
    if (p === '/assets/hls.min.js') {
      const file = path.join(__dirname, '..', 'assets', 'hls.min.js')
      if (!fs.existsSync(file)) return setJson(res, 404, { error: 'hls.min.js tidak ada' })
      const body = fs.readFileSync(file)
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': body.length,
        // Versi dipatok supaya cache aman.
        'Cache-Control': 'public, max-age=604800, immutable',
      })
      return res.end(body)
    }

    if (serveStatic(req, res)) return
    return setJson(res, 404, { error: 'not found', path: p })
  } catch (err) {
    if (!res.headersSent) return fail(res, err)
    try { res.end() } catch { /* sudah ditutup */ }
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) fail(res, err)
  })
})

// Satu penonton dengan koneksi buruk tidak boleh menjatuhkan server untuk
// semua orang. Log, jangan mati.
server.on('clientError', (err, socket) => {
  try { socket.destroy() } catch { /* sudah tertutup */ }
  void err
})
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err && err.message ? err.message : err)
})
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err && err.message ? err.message : err)
})

server.listen(PORT, () => {
  console.log(`Guardian backend (streamex-api) listening on http://localhost:${PORT}`)
})
