/**
 * Klien streamex-api.
 *
 * Semua data Guardian datang dari sini, bukan lagi di-scrape dari lk21.
 * Bentuk balikannya sengaja dibuat sama dengan skema yang sudah dipakai UI
 * (`src/data.ts`), jadi komponen React tidak perlu ikut berubah.
 *
 * Satu hal yang perlu diingat soal stream: URL media milik streamex-api hanya
 * bisa diambil dari server, bukan dari browser pengunjung. Sebagian host
 * mengunci lewat Referer (P9), sebagian lewat Cookie CloudFront (P5 Callisto),
 * dan token P1 terikat IP. Karena itu `streamPlayers()` tidak pernah
 * mengembalikan URL host media ke browser; ia mengembalikan alamat player
 * milik server ini sendiri (`/api/player?src=...`) yang tugasnya menarik
 * stream tadi di sisi server lalu menyajikannya sebagai HLS biasa.
 */

const STREAMEX = (process.env.STREAMEX_API || 'http://127.0.0.1:8798').replace(/\/$/, '')
const TMDB_IMG = 'https://image.tmdb.org/t/p'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

// Deskriptor sumber (URL + header sensitif) disimpan di media.js, bukan di
// URL, supaya Cookie/Referer tidak ikut ke browser.
import { storeSource } from './media.js'

// Player streamex yang benar-benar bisa diselesaikan. 1 = vsembed, 5 = vidbolt,
// 9 = xpass. Dipakai untuk mengurutkan server terbaik lebih dulu di UI.
const PLAYER_LABEL = {
  1: 'vsembed',
  5: 'vidbolt',
  9: 'xpass',
}

export class StreamExError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'StreamExError'
    this.status = status || 502
  }
}

async function call(path, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(STREAMEX + path, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    throw new StreamExError(`streamex-api tidak bisa dihubungi (${err.message})`, 502)
  } finally {
    clearTimeout(timer)
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    throw new StreamExError(`respons streamex-api bukan JSON (HTTP ${res.status})`, 502)
  }
  if (!res.ok || body.ok === false) {
    const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`
    throw new StreamExError(msg, res.status)
  }
  return body.data
}

/* ------------------------------------------------------------------ helpers */

const img = (path, size = 'w500') => (path ? `${TMDB_IMG}/${size}${path}` : '')
const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Ubah satu item katalog jadi bentuk yang dipakai UI Guardian.
 * UI hanya butuh: poster, judul, tahun, rating, dan url detail yang bisa
 * diberikan kembali ke backend (`/api/detail?url=`).
 */
export function toTitle(it, typeHint = 'movie') {
  const type = it.mediaType === 'tv' || it.mediaType === 'series' ? 'series' : (typeHint === 'tv' ? 'series' : 'movie')
  const year = String(it.year || (it.releaseDate || '').slice(0, 4) || '').replace(/\D/g, '').slice(0, 4)
  return {
    id: String(it.tmdbId || ''),
    slug: String(it.tmdbId || ''),
    type,
    title: it.title || it.name || '',
    year: year ? parseInt(year, 10) : undefined,
    rating: num(it.rating),
    quality: it.quality || (type === 'series' ? 'SERIES' : 'HD'),
    runtime: it.runtime ? `${it.runtime} min` : '',
    genre: Array.isArray(it.genres) ? it.genres.map((g) => (typeof g === 'string' ? g : g.name)) : [],
    country: Array.isArray(it.country) ? it.country.join(', ') : (it.country || ''),
    synopsis: it.overview || it.synopsis || '',
    poster: it.poster || img(it.posterPath),
    backdrop: it.backdrop || it.poster || img(it.posterPath, 'w1280'),
    accent: '#ee6849',
    episodes: it.episodeCount || undefined,
    // Detail & watch tetap lewat backend ini, bukan langsung ke streamex.
    url: `${type}/${it.tmdbId}`,
  }
}

const listOf = (data) => (data && data.items) || []

/* ------------------------------------------------------------------ catalogue */

export async function home() {
  const d = await call('/api/home')
  const sections = []
  const push = (title, type, items, seeAll) => {
    if (items && items.length) {
      sections.push({ type, title, seeAll: seeAll || '', items: items.map((i) => toTitle(i)) })
    }
  }
  push('Film Populer', 'movie', d.hero)
  push('Trending Film', 'movie-trending', d.trendingMovies, '/browse/popular')
  push('Trending Series', 'tv-trending', d.trendingShows, '/browse/latest-series')
  return { sections, latest: (d.trendingMovies || []).map((i) => toTitle(i)) }
}

export async function browse(path, page = 1, type = '') {
  // path datang dari UI dalam bentuk /populer, /latest-series, /genre/x,
  // /country/x, /year/x, /quality/x — sama seperti waktu masih lk21.
  const seg = String(path || '').split('/').filter(Boolean)
  const head = seg[0] || 'populer'
  const tail = seg[1] || ''

  let media = 'movie'
  const q = new URLSearchParams({ page: String(page) })
  let title = ''

  if (type === 'movie' || type === 'series') media = type === 'series' ? 'tv' : 'movie'

  switch (head) {
    case 'latest':
      media = type === 'series' ? 'tv' : 'movie'
      if (media === 'tv') { q.set('list', 'recent') } else { q.set('list', 'recent') }
      title = 'Film Terbaru'
      break
    case 'latest-series':
      media = 'tv'
      q.set('list', 'recent')
      title = 'Series Terbaru'
      break
    case 'populer':
      q.set('list', 'popular')
      title = 'Populer'
      break
    case 'rating':
      q.set('list', 'top-rated')
      title = 'Rating Tertinggi'
      break
    case 'top-movie-today':
      q.set('list', 'trending')
      title = 'Top Hari Ini'
      break
    case 'release':
      q.set('list', 'recent')
      q.set('year', String(new Date().getFullYear()))
      title = 'Rilis Tahun Ini'
      break
    case 'most-commented':
      q.set('list', 'popular')
      title = 'Paling Banyak Dibicarakan'
      break
    case 'genre':
      if (tail) q.set('genre', tail)
      q.set('list', 'popular')
      title = humanize(tail)
      break
    case 'country':
      if (tail) q.set('country', tail)
      q.set('list', 'popular')
      q.set('lang', 'all')
      title = humanize(tail)
      break
    case 'year':
      if (tail) q.set('year', tail)
      q.set('list', 'popular')
      title = tail || 'Tahun'
      break
    case 'quality':
      q.set('list', 'popular')
      title = tail ? `Kualitas ${tail}` : 'Kualitas'
      break
    default:
      q.set('list', 'popular')
      title = 'Katalog'
  }

  q.set('lang', q.get('lang') || 'all')
  const kind = media === 'tv' ? 'tv' : 'movies'
  const d = await call(`/api/${kind}/${q.get('list') || 'popular'}?${q.toString()}`)
  const totalPages = Math.min(d.totalPages || 1, 500)
  return {
    title,
    page: d.page || page,
    totalPages,
    items: listOf(d).map((i) => toTitle(i, media)),
    path,
    raw: { requested: path },
  }
}

function humanize(slug) {
  if (!slug) return 'Katalog'
  return String(slug).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export async function search(query, page = 1) {
  const d = await call(`/api/search?q=${encodeURIComponent(query)}&page=${page}`)
  return {
    query,
    page: d.page || page,
    totalPages: Math.min(d.totalPages || 1, 500),
    items: listOf(d).map((i) => toTitle(i)).filter((i) => i.id),
  }
}

export async function getGenres() {
  // UI mengharapkan { slug, name }. Untuk genre, slug = nama (server menerima
  // keduanya, lihat genre_id() di streamex-api).
  const d = await call('/api/genres?type=movie')
  return (d.genres || []).map((g) => ({ slug: g.name, name: g.name }))
}

export async function getCountries() {
  const d = await call('/api/countries')
  return (d.items || []).map((c) => ({ slug: c.code, name: c.name }))
}

export async function getYears() {
  const now = new Date().getFullYear()
  const out = []
  for (let y = now + 1; y >= 1950; y--) out.push(String(y))
  return out
}

/* ------------------------------------------------------------------ detail */

export async function detail(url) {
  // url dari UI: "movie/550" atau "tv/1396"
  const [kind, id] = String(url || '').split('/')
  if (!kind || !id) throw new StreamExError('url detail tidak valid', 400)
  const isTv = kind === 'tv' || kind === 'series'
  const d = await call(`/api/${isTv ? 'tv' : 'movies'}/${id}`)

  const cast = (d.cast || []).map((c) => c.name).filter(Boolean)
  const crew = d.crew || []
  const director = (crew.find((c) => /director/i.test(c.job || '')) || {}).name
    || (d.createdBy || [])[0] || ''

  const seasons = {}
  if (isTv && d.seasons) {
    for (const s of d.seasons) {
      // Specials (season 0) tidak ditampilkan, sama seperti sumbernya.
      if (!s.seasonNumber) continue
      const eps = await call(`/api/tv/${id}/season/${s.seasonNumber}`).catch(() => null)
      const list = (eps && eps.episodes) || []
      seasons[String(s.seasonNumber)] = list.map((e) => ({
        episode: e.episodeNumber,
        title: e.name || '',
        slug: `s${e.seasonNumber}e${e.episodeNumber}`,
        url: `tv/${id}?s=${e.seasonNumber}&e=${e.episodeNumber}`,
      }))
    }
  }

  return {
    url,
    type: isTv ? 'series' : 'movie',
    title: d.title || '',
    rating: d.rating ? String(d.rating) : '',
    votes: d.voteCount ? String(d.voteCount) : '',
    genres: (d.genres || []).map((g) => (typeof g === 'string' ? g : g.name)),
    country: (d.productionCountries || []).map((c) => (typeof c === 'string' ? c : c.name || c)).filter(Boolean),
    director,
    cast,
    release: d.releaseDate || d.firstAirDate || '',
    updated: d.status || '',
    synopsis: d.overview || '',
    poster: d.poster || img(d.posterPath),
    trailer: ((d.videos || []).find((v) => /trailer/i.test(v.type || '')) || {}).url || '',
    download: '',
    playAwal: '',
    playTerbaru: '',
    players: [],
    seasons,
    totalEpisodes: d.numberOfEpisodes || Object.values(seasons).reduce((n, e) => n + e.length, 0),
    latestEpisode: '',
    related: (d.recommendations || []).map((i) => toTitle(i)),
    tmdbId: d.tmdbId,
    imdbId: d.imdbId || '',
    tagline: d.tagline || '',
    runtime: d.runtime || null,
  }
}

/* ------------------------------------------------------------------ playback */

/**
 * Daftar "server" yang ditampilkan di halaman tonton.
 *
 * UI meng-embed `players[i].url` sebagai iframe. Yang dikirim ke browser di
 * sini bukan URL host media, melainkan halaman player milik server ini
 * (`/api/player?...`), karena hanya server yang boleh memegang token dan
 * header yang dibutuhkan host media. Lihat server/player.js.
 */
export async function stream(url, base) {
  const [kind, rest] = String(url || '').split('?')
  const [k, id] = String(kind || '').split('/')
  if (!k || !id) throw new StreamExError('url stream tidak valid', 400)
  const isTv = k === 'tv' || k === 'series'
  const params = new URLSearchParams(rest || '')
  const season = params.get('s')
  const episode = params.get('e')

  const q = new URLSearchParams()
  if (season) q.set('season', season)
  if (episode) q.set('episode', episode)

  // Halaman tonton hanya butuh "server mana yang bisa dipakai" — bukan URL
  // medianya. `/api/players` menjawab itu dalam milidetik. Menyelesaikan
  // stream di sini akan memakan satu sampai dua menit (resolver menyalakan
  // browser), jadi itu ditunda sampai player benar-benar dimuat di iframe.
  const kind2 = isTv ? 'tv' : 'movie'
  const [d, meta] = await Promise.all([
    call(`/api/players/${kind2}/${id}?${q.toString()}`),
    call(`/api/${isTv ? 'tv' : 'movies'}/${id}`).catch(() => ({})),
  ])

  // `/api/players` mengembalikan 12 player dengan flag `resolvable`. Hanya yang
  // benar-benar punya resolver yang diiklankan sebagai server di UI — sisanya
  // akan jadi tombol mati kalau ditampilkan.
  const all = d.players || []
  const resolvedIds = all.filter((p) => p.resolvable).map((p) => p.id)
  const players = []
  // UI hanya meng-iframe URL absolut (`^https?://`) atau `/pp/`. Karena itu
  // alamat player di sini WAJIB absolut, kalau tidak iframe-nya tidak muncul
  // sama sekali dan halaman tonton cuma menampilkan "Sumber video perlu dibuka".
  const origin = String(base || '').replace(/\/$/, '')
  for (const pid of resolvedIds) {
    const label = PLAYER_LABEL[pid] || `server ${pid}`
    const link = `${origin}/api/player?k=${isTv ? 'tv' : 'movie'}&id=${id}` +
      (season ? `&s=${season}` : '') + (episode ? `&e=${episode}` : '') +
      `&p=${pid}&embed=1`
    players.push({
      server: label,
      url: link,
      playerId: pid,
      // Bukan URL pihak ketiga: ini player milik server sendiri.
      local: true,
      active: true,
    })
  }

  return {
    url,
    title: meta.title || d.title || '',
    players,
    nav: [],
    // Info diagnostik, tidak dipakai UI tapi berguna saat memeriksa.
    sources: [],
    subtitles: [],
    failedPlayers: all.filter((p) => !p.resolvable).map((p) => ({
      id: p.id, reason: p.unresolvedReason || 'belum ada resolver',
    })),
    mediaType: isTv ? 'tv' : 'movie',
    season: season ? Number(season) : null,
    episode: episode ? Number(episode) : null,
  }
}

/* ------------------------------------------------------------------ resolve */

/**
 * Versi `stream()` untuk halaman player: menyelesaikan satu player saja dan
 * mengembalikan URL playlist yang sudah lewat server ini, plus header yang
 * dibutuhkan host media (disimpan di memori, diwakili token; tidak pernah
 * dikirim ke browser).
 *
 * Hanya sumber yang benar-benar membalas playlist yang dikembalikan — sumber
 * yang menolak ditandai mati, bukan diiklankan sebagai bisa diputar.
 */
export async function resolveSources({ kind, id, season, episode, playerId, baseHeaders }) {
  const isTv = kind === 'tv' || kind === 'series'
  const q = new URLSearchParams({ player: String(playerId || 5) })
  if (season) q.set('season', season)
  if (episode) q.set('episode', episode)

  const d = await call(`/api/streams/${isTv ? 'tv' : 'movie'}/${id}?${q.toString()}`, 240000)

  const subs = (d.subtitles || []).map((s) => ({ label: s.label, language: s.language, url: s.url }))
  const raw = d.sources || []

  // Kandidat unik dulu: URL mentah yang sama tidak perlu diuji dua kali.
  const cand = []
  const seenUrl = new Set()
  for (const s of raw) {
    // Bentuk sumber berbeda antar player, sudah diperiksa satu per satu:
    //   P1 (vsembed) : { raw, token, playable }  -> `playable` = raw + token (string)
    //   P5 (vidbolt) : { url, quality, headers } -> `playable` = true (boolean)
    //   P9 (xpass)   : { raw, headers.Referer }  -> `playable` = true (boolean)
    // Jadi `playable` hanya dipakai kalau ia benar-benar URL.
    const u = (typeof s.playable === 'string' && /^https?:/i.test(s.playable))
      ? s.playable
      : (s.url || s.raw)
    if (!u || seenUrl.has(u)) continue
    seenUrl.add(u)
    cand.push({
      url: u,
      headers: s.headers || {},
      label: s.quality || s.label || 'auto',
      provider: s.providerName || s.provider || '',
      subtitles: subs,
    })
  }

  // Diuji paralel (dengan batas) supaya menunggu sebelas sumber tidak berarti
  // sebelas kali menunggu. Tiap sumber tetap harus lolos sampai segmen pertama,
  // jadi menambah kecepatan tidak mengendurkan pembuktiannya.
  const results = await mapLimit(cand, PROBE_CONCURRENCY, probePlaylist)

  const out = []
  const seenFp = new Set()
  for (let i = 0; i < cand.length; i++) {
    const r = results[i]
    if (!r || !r.ok) continue
    // Sumber yang strukturnya sama persis sama saja bagi penonton. P1 mengirim
    // tiga URL berbeda yang ketiganya master playlist dengan varian identik;
    // tanpa ini muncul tiga tombol "auto" yang harus dicoba satu per satu untuk
    // hasil yang sama.
    const fp = r.fingerprint || cand[i].url
    if (seenFp.has(fp)) continue
    seenFp.add(fp)
    const entry = cand[i]
    const token = storeSource(entry)
    out.push({
      label: r.label || entry.label,
      provider: entry.provider,
      playlist: `/hls/index.m3u8?t=${token}`,
      subtitles: subs.map((sub) => ({
        label: sub.label,
        language: sub.language,
        url: `/sub/${encodeURIComponent(sub.language || 'sub')}.vtt?t=${storeSource({ url: sub.url, headers: {} })}`,
      })),
    })
  }

  return {
    title: d.title || '',
    playerId: Number(playerId || 5),
    playerName: (d.players || []).find((p) => p.id === Number(playerId || 5))?.name || '',
    sources: out,
    deadSources: raw.length - out.length,
  }
}

/** Berapa sumber yang diuji bersamaan. Cukup cepat tanpa membanjiri hostnya. */
const PROBE_CONCURRENCY = 4

/** Jalankan fn atas tiap item, paling banyak `limit` sekaligus, urutan tetap. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = await fn(items[i])
      } catch {
        out[i] = null
      }
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Benar-benar coba sumbernya sampai ke segmen pertama; kalau gagal di titik
 * mana pun, sumber itu tidak boleh diiklankan sebagai bisa diputar.
 *
 * Ini bukan kehati-hatian berlebihan, ini hasil pengujian nyata:
 *   - P5: sebagian master playlist tidak mencantumkan CODECS, dan sebagian lagi
 *     ber-codec H.265 (`hvc1`/`hev1`) yang tidak punya dekoder di Chrome.
 *     Hasilnya `DEMUXER_ERROR_COULD_NOT_PARSE` di <video>.
 *   - P9: playlist-nya terbaca, tapi segmennya balas 403.
 * Playlist yang terbaca belum berarti bisa diputar. Yang membuktikan cuma
 * segmen.
 */
async function probePlaylist(entry) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  const h = { 'user-agent': BROWSER_UA, accept: '*/*', ...(entry.headers || {}) }
  const grab = async (u) => {
    const r = await fetch(u, { headers: h, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) return null
    return { url: r.url || u, text: await r.text() }
  }
  try {
    const top = await grab(entry.url)
    if (!top || !top.text.includes('#EXTM3U')) return { ok: false }

    // Sidik jari isi playlist, tanpa URL (URL selalu berbeda karena bertoken).
    // Dipakai untuk membuang sumber yang bagi penonton sama saja.
    const resList = (top.text.match(/RESOLUTION=(\d+x\d+)/gi) || [])
      .map((s) => s.split('=')[1].toLowerCase())
    const codecList = (top.text.match(/CODECS="([^"]+)"/gi) || [])
      .map((s) => s.slice(8, -1).toLowerCase())

    // Master playlist: turuni varian pertama sampai ketemu daftar segmen.
    let media = top
    if (/#EXT-X-STREAM-INF/i.test(top.text)) {
      const variants = top.text.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
      if (!variants.length) return { ok: false }
      const vurl = safeAbs(variants[0], top.url)
      if (!vurl) return { ok: false }
      const v = await grab(vurl)
      if (!v || !v.text.includes('#EXTM3U')) return { ok: false }
      media = v

      // H.265 dan Dolby Vision tidak bisa didekode Chrome.
      const codecs = (top.text.match(/CODECS="([^"]+)"/gi) || []).join(',')
      if (/hvc1|hev1|dvh1|dvhe/i.test(codecs)) return { ok: false }
    }

    const segs = media.text.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))

    // Bukti terakhir: segmen pertama harus benar-benar datang, dan isinya harus
    // data video (TS diawali 0x47, fMP4 memuat ftyp/styp/moof).
    const seg = segs[0]
    if (!seg) return { ok: false }
    const surl = safeAbs(seg, media.url)
    if (!surl) return { ok: false }
    const r = await fetch(surl, { headers: h, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) return { ok: false }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 1000) return { ok: false }
    const isVideo = buf[0] === 0x47
      || /ftyp|styp|moof/.test(buf.subarray(0, 64).toString('latin1'))
    if (!isVideo) return { ok: false }

    // Codec harus dipastikan dari datanya, bukan dari tag playlist. Sebagian
    // host (Callisto, sudah dibuktikan dengan ffprobe) mengirim H.265 tanpa
    // mencantumkan CODECS sama sekali, jadi tag saja tidak cukup: sumbernya
    // lolos penyaringan, terunduh ratusan segmen, lalu berakhir layar hitam
    // karena Chrome tidak punya dekoder HEVC.
    const mapTag = /#EXT-X-MAP:URI="([^"]+)"/i.exec(media.text)
    if (mapTag) {
      // fMP4: fourcc codec ada di init segment (moov/stsd).
      const iurl = safeAbs(mapTag[1], media.url)
      if (iurl) {
        const ir = await fetch(iurl, { headers: h, signal: ctrl.signal, redirect: 'follow' })
        if (ir.ok) {
          const ibuf = Buffer.from(await ir.arrayBuffer())
          const head = ibuf.subarray(0, 8192).toString('latin1')
          if (/hvc1|hev1|hvcC|dvh1|dvhe/.test(head)) return { ok: false }
        }
      }
    } else if (buf[0] === 0x47) {
      // MPEG-TS: stream_type 0x24 di PMT menandakan HEVC.
      if (tsHasHevc(buf)) return { ok: false }
    }

    // Label yang benar-benar berarti bagi penonton. Tanpa ini, sumber yang tidak
    // mencantumkan `quality` tampil sebagai "auto", padahal playlist-nya memuat
    // 640x266 sampai 1920x800: penonton tidak bisa membedakan tombolnya.
    // Dipakai resolusi varian tertinggi apa adanya, bukan perkiraan kelas.
    let label = entry.label
    if (!label || label === 'auto') {
      const cands = resList
        .map((r) => r.split('x').map(Number))
        .filter(([w, h]) => w > 0 && h > 0)
        .sort((a, b) => b[0] * b[1] - a[0] * a[1])
      if (cands.length) label = `${cands[0][0]}x${cands[0][1]}`
    }

    const fp = [resList.slice().sort().join(','), codecList.slice().sort().join(','),
      segs.length].join('|')
    return { ok: true, fingerprint: fp, label }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cari stream_type HEVC (0x24) di tabel PMT sebuah paket MPEG-TS.
 *
 * PMT ditandai PID dari PAT (table_id 0x02). Untuk keperluan penyaringan ini,
 * memindai seluruh paket sudah cukup: satu paket PMT memuat pasangan
 * stream_type + elementary PID, dan 0x24 hanya muncul untuk HEVC.
 */
function tsHasHevc(buf) {
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue
    // payload_unit_start_indicator + PID
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2]
    const startsUnit = (buf[i + 1] & 0x40) !== 0
    if (!startsUnit) continue
    const pusi = i + 4
    if (buf[pusi] !== 0x02) continue            // table_id PMT
    // Lewati header PMT: section_length(2) + program_number(2) + flags(1) +
    // section_number(1) + last_section_number(1) + PCR_PID(2) + prog_info_len(2)
    const progInfoLen = ((buf[pusi + 10] & 0x0f) << 8) | buf[pusi + 11]
    let p = pusi + 12 + progInfoLen
    const end = Math.min(pusi + 3 + (((buf[pusi + 1] & 0x0f) << 8) | buf[pusi + 2]) - 4, i + 188)
    while (p + 4 < end) {
      if (buf[p] === 0x24) return true            // HEVC
      const esLen = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4]
      p += 5 + esLen
    }
    void pid
  }
  return false
}

function safeAbs(uri, base) {
  if (/^data:/i.test(uri)) return ''
  try {
    return new URL(uri, base).toString()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ sosial */
export async function comments(kind, tmdbId, { page = 1, limit = 20, season, episode } = {}) {
  const q = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (season) q.set('season', season)
  if (episode) q.set('episode', episode)
  const d = await call(`/api/comments/${kind === 'tv' ? 'tv' : 'movie'}/${tmdbId}?${q.toString()}`)
  return d
}

export { STREAMEX }
