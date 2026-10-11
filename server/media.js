/**
 * Proxy HLS.
 *
 * Kenapa ini ada: URL media streamex-api tidak bisa dibuka langsung oleh
 * browser pengunjung. Tiga sebab, semuanya sudah dibuktikan:
 *   - P9 (xpass): host membalas 403 kalau Referer bukan `https://play.xpass.top/`.
 *     Browser tidak boleh memalsukan Referer, jadi hanya server yang bisa.
 *   - P5 (vidbolt/Callisto): butuh Cookie CloudFront yang hanya ikut di respons
 *     server, tidak pernah dikirim ke browser.
 *   - P1 (vsembed): token `?token=` terikat IP server penanda tangan.
 * Kalau URL host media ditanam di iframe, hasilnya selalu gagal putar.
 *
 * Jadi: server yang menarik playlist + segmennya, browser hanya melihat origin
 * kita sendiri. Tidak ada CORS proxy pihak ketiga di jalur ini.
 *
 * Deskriptor sumber (URL + header sensitif) disimpan di memori dan diwakili
 * oleh sebuah token acak pendek, supaya Cookie/Referer tidak ikut nongkrong di
 * URL, log akses, atau riwayat browser. Token mati setelah beberapa menit.
 */

import { createHash } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

// Token berumur pendek: playlist HLS dan cookie CDN-nya memang bertanda tangan
// dan cepat kedaluwarsa, jadi tidak ada gunanya menyimpannya lama.
const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 400

const STORE = new Map()

function sweep() {
  const now = Date.now()
  for (const [k, v] of STORE) {
    if (v.exp < now) STORE.delete(k)
  }
  while (STORE.size > MAX_ENTRIES) {
    const oldest = STORE.keys().next().value
    STORE.delete(oldest)
  }
}

export function storeSource(desc) {
  sweep()
  const key = createHash('sha1')
    .update(JSON.stringify([desc.url, desc.headers || {}, desc.label || '']))
    .digest('hex')
    .slice(0, 20)
  STORE.set(key, { ...desc, exp: Date.now() + TTL_MS })
  return key
}

export function loadSource(token) {
  const hit = STORE.get(token)
  if (!hit) return null
  if (hit.exp < Date.now()) {
    STORE.delete(token)
    return null
  }
  return hit
}

/** Header yang dipakai untuk menyentuh host media, apa pun jenisnya. */
function outboundHeaders(desc, extra = {}) {
  const h = { 'user-agent': UA, accept: '*/*', ...extra }
  for (const [k, v] of Object.entries(desc.headers || {})) {
    if (v) h[k.toLowerCase()] = v
  }
  return h
}

/**
 * Ambil deskriptor sumber dari token yang dipakai /hls/index.m3u8.
 * Token datang sebagai query (?t=...), tapi terima juga path supaya pemanggil
 * tidak harus tahu bentuknya.
 */
export async function resolveSource(params) {
  const token = params && typeof params.get === 'function' ? params.get('t') : params
  const desc = loadSource(token)
  if (!desc) {
    throw Object.assign(
      new Error('token sumber kedaluwarsa, muat ulang halaman tonton'),
      { status: 410 },
    )
  }
  return desc
}

/**
 * Ambil playlist dan tulis ulang semua URL di dalamnya supaya menunjuk
 * kembali ke /hls/seg. URL relatif diselesaikan terhadap URL final
 * (setelah redirect), bukan terhadap URL permintaan.
 */
export async function proxyPlaylist(desc, token) {
  return renderPlaylist(desc, token, desc.url, 0)
}

/**
 * Render satu playlist. Kalau isinya master playlist (URI di dalamnya adalah
 * playlist lain, bukan segmen), URI itu dibungkus lagi lewat /hls/index.m3u8
 * supaya hls.js bisa menuruni varian tanpa pernah keluar dari origin kita.
 * Kedalaman dibatasi: m3u8 sehat paling banyak tiga lapis.
 */
export async function renderPlaylist(desc, token, target, depth = 0) {
  if (depth > 3) {
    throw Object.assign(new Error('playlist terlalu dalam disarangkan'), { status: 502 })
  }
  const res = await fetch(target, { headers: outboundHeaders(desc), redirect: 'follow' })
  if (!res.ok) {
    throw Object.assign(new Error(`playlist upstream menolak (HTTP ${res.status})`), { status: 502 })
  }
  // Base untuk URL relatif adalah URL final setelah redirect, bukan URL asal.
  const base = res.url || target
  const text = await res.text()
  const isMaster = /#EXT-X-STREAM-INF/i.test(text) || /#EXT-X-MEDIA:/i.test(text)

  const lines = text.split(/\r?\n/).map((line) => {
    if (!line) return line
    if (line.startsWith('#')) {
      // Tag yang memuat URI: KEY, MEDIA, MAP, I-FRAME-STREAM-INF, PART.
      return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        const abs = absolutize(uri, base)
        if (!abs) return _m
        // Kunci enkripsi dan peta inisialisasi bukan playlist: lewat segmen.
        if (/^#EXT-X-(KEY|MAP|PART)/i.test(line)) {
          return `URI="/hls/seg?t=${token}&u=${b64url(abs)}"`
        }
        return `URI="${wrapUri(abs, token, isMaster)}"`
      })
    }
    const abs = absolutize(line, base)
    return abs ? wrapUri(abs, token, isMaster) : line
  })
  return lines.join('\n')
}

/** Master playlist menunjuk ke playlist lain; media playlist menunjuk segmen. */
function wrapUri(abs, token, isMaster) {
  const looksLikePlaylist = /\.m3u8?(\?|$)/i.test(abs)
  if (isMaster || looksLikePlaylist) {
    return `/hls/index.m3u8?t=${token}&v=${b64url(abs)}`
  }
  return `/hls/seg?t=${token}&u=${b64url(abs)}`
}

function absolutize(uri, base) {
  if (/^data:/i.test(uri)) return ''
  try {
    return new URL(uri, base).toString()
  } catch {
    return ''
  }
}

/** Teruskan satu segmen, dengan header yang sama seperti playlist. */
export async function proxySegment(params, res) {
  const token = params.get('t')
  const desc = loadSource(token)
  if (!desc) {
    res.writeHead(410, { 'Content-Type': 'text/plain' })
    return res.end('token segmen kedaluwarsa, muat ulang halaman tonton')
  }
  const target = unb64url(params.get('u') || '')
  // Token bisa saja asal-asalan; jangan sampai server jadi SSRF terbuka.
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    return res.end('segmen tidak valid')
  }
  const up = await fetch(target, { headers: outboundHeaders(desc), redirect: 'follow' })
  if (!up.ok) {
    res.writeHead(up.status, { 'Content-Type': 'text/plain' })
    return res.end(`segmen upstream menolak (HTTP ${up.status})`)
  }
  const ctype = up.headers.get('content-type') || 'video/mp2t'
  const clen = up.headers.get('content-length')
  const headers = {
    'Content-Type': ctype,
    'Access-Control-Allow-Origin': '*',
    // Segmen HLS cepat diminta ulang; cache sebentar saja.
    'Cache-Control': 'private, max-age=120',
  }
  if (clen) headers['Content-Length'] = clen
  res.writeHead(200, headers)
  const { Readable } = await import('node:stream')
  const body = Readable.fromWeb(up.body)
  // Koneksi ke host media memang bisa putus di tengah segmen
  // (ERR_HTTP2_STREAM_ERROR / NGHTTP2_PROTOCOL_ERROR sudah pernah terjadi).
  // Tanpa penanganan ini, error tak tertangani itu mematikan seluruh server —
  // satu segmen gagal berarti semua penonton kehilangan gambarnya.
  body.on('error', () => { try { res.destroy() } catch { /* sudah tertutup */ } })
  res.on('close', () => { try { body.destroy() } catch { /* sudah tertutup */ } })
  body.pipe(res)
}

/** Subtitle: sumbernya .srt, browser hanya mau .vtt. */
export async function proxySubtitle(rest, params, res) {
  const token = params.get('t')
  const desc = loadSource(token)
  if (!desc) {
    res.writeHead(410, { 'Content-Type': 'text/plain' })
    return res.end('token subtitle kedaluwarsa')
  }
  const up = await fetch(desc.url, { headers: outboundHeaders(desc), redirect: 'follow' })
  if (!up.ok) {
    res.writeHead(up.status, { 'Content-Type': 'text/plain' })
    return res.end(`subtitle upstream menolak (HTTP ${up.status})`)
  }
  const raw = await up.text()
  const body = /\.vtt(\?|$)/i.test(desc.url) ? raw : srtToVtt(raw)
  const headers = {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=600',
  }
  res.writeHead(200, headers)
  res.end(body)
  void rest
}

export function srtToVtt(srt) {
  const body = String(srt)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${body}`
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url')
}
function unb64url(s) {
  try {
    return Buffer.from(s, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

export { unb64url }
