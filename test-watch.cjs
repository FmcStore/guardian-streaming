#!/usr/bin/env node
/**
 * Uji halaman tonton seperti yang dilihat penonton.
 *
 * Beda dengan test-video.cjs (yang membuka /api/player langsung), uji ini
 * membuka /watch/<judul> di dalam aplikasi lalu memeriksa video di dalam
 * iframe. Ini penting karena halaman tontonlah yang menentukan player mana
 * yang dibuka lebih dulu, dan di situlah penonton melihat "tidak bisa diputar"
 * kalau player defaultnya kosong padahal player lain punya sumber.
 *
 * Pemakaian: node test-watch.cjs <base> <judul-url>
 *   node test-watch.cjs https://x.trycloudflare.com "movie/1175161"
 */
const { spawn } = require('node:child_process')
const http = require('node:http')

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const PORT = 9441
const BASE = (process.argv[2] || 'http://127.0.0.1:8810').replace(/\/$/, '')
const TITLE = process.argv[3] || 'movie/550'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = 0
let bad = 0
function check(name, cond, detail = '') {
  if (cond) { ok++; console.log('  PASS  ' + name.padEnd(52) + ' ' + detail) }
  else { bad++; console.log('  FAIL  ' + name.padEnd(52) + ' ' + detail) }
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' })

  let tab
  for (let i = 0; i < 60; i++) {
    try {
      tab = await new Promise((res, rej) => {
        http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
          let b = ''; r.on('data', (c) => { b += c })
          r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
        }).on('error', rej)
      })
      break
    } catch { await sleep(500) }
  }
  const page = tab.find((t) => t.type === 'page')
  // Node sudah punya WebSocket bawaan; tidak perlu dependensi luar.
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  // Kalau Chrome mati di tengah jalan, setiap panggilan CDP akan menunggu
  // selamanya dan uji diam tanpa kesimpulan. Laporkan, jangan menggantung.
  ws.onclose = () => {
    console.log('  !! koneksi Chrome terputus di tengah uji')
    console.log('\n== ' + ok + ' passed, ' + bad + ' failed (terputus) ==')
    process.exit(2)
  }
  ws.onerror = () => {
    console.log('  !! kesalahan koneksi Chrome')
    console.log('\n== ' + ok + ' passed, ' + bad + ' failed (koneksi gagal) ==')
    process.exit(2)
  }

  let id = 0
  const pending = new Map()
  const failed = []
  const reqs = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      return
    }
    if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, m.params.request.url)
    if (m.method === 'Network.loadingFailed') {
      failed.push(`${m.params.errorText} ${reqs.get(m.params.requestId) || '?'}`)
    }
  }
  const send = (method, params = {}, timeoutMs = 240000) => new Promise((res, rej) => {
    const i = ++id
    const t = setTimeout(() => {
      pending.delete(i)
      rej(new Error(`CDP ${method} melewati batas ${timeoutMs / 1000}s`))
    }, timeoutMs)
    pending.set(i, {
      resolve: (v) => { clearTimeout(t); res(v) },
      reject: (e) => { clearTimeout(t); rej(e) },
    })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable')

  const watchUrl = `${BASE}/watch/${encodeURIComponent(TITLE)}`
  console.log('=== halaman tonton: ' + watchUrl + ' ===')
  await send('Page.navigate', { url: watchUrl })
  await sleep(12000)

  // Tombol server yang ditawarkan UI.
  const servers = await ev(`Array.from(document.querySelectorAll('button'))
    .map((b) => b.textContent.trim())
    .filter((t) => /vsembed|vidbolt|xpass|server/i.test(t))`)
  console.log('  tombol server:', JSON.stringify(servers))

  // Judul benar-benar terbuka?
  const heading = await ev(`(document.querySelector('h1,h2') || {}).textContent || ''`)
  check('judul film terbuka', heading.trim().length > 1, heading.trim().slice(0, 40))

  // Klik tombol tonton kalau belum di halaman player.
  const hasIframe = await ev(`!!document.querySelector('iframe')`)
  if (!hasIframe) {
    const clicked = await ev(`(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find((x) => /tonton|play|nonton/i.test(x.textContent));
      if (b) { b.click(); return b.textContent.trim() }
      return ''
    })()`)
    console.log('  klik tombol:', JSON.stringify(clicked))
    await sleep(12000)
  }

  const frame = await ev(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return { attached: false, reason: 'tidak ada iframe' };
    const d = f.contentDocument;
    return { attached: !!d, url: f.src,
             hasVideo: !!(d && d.querySelector('video')),
             pesan: d ? ((d.querySelector('#msg') || {}).innerText || '') : '' };
  })()`)
  check('iframe player terpasang', !!frame.attached, (frame.url || '').slice(0, 70))
  check('di dalam iframe ada video', !!frame.hasVideo, '')

  if (!frame.hasVideo) {
    console.log('  pesan di iframe:', JSON.stringify(frame.pesan))
    console.log('\n== ' + ok + ' passed, ' + bad + ' failed ==')
    chrome.kill(); process.exit(1)
  }

  // Tunggu video benar-benar berjalan.
  const info = await ev(`(async () => {
    const f = document.querySelector('iframe');
    const d = f.contentDocument;
    const v = d.querySelector('video');
    try { await v.play() } catch (e) {}
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      if (v.readyState >= 2 && v.videoWidth > 0) break;
      if (v.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const before = v.currentTime;
    await new Promise((r) => setTimeout(r, 3000));
    const m = d.querySelector('#msg');
    return { src: v.currentSrc || v.src, readyState: v.readyState,
             width: v.videoWidth, height: v.videoHeight, duration: v.duration,
             before, after: v.currentTime, error: v.error ? v.error.code : null,
             pesan: (m || {}).innerText || '',
             // innerText tetap mengembalikan teks elemen yang disembunyikan,
             // jadi keterlihatan harus dibaca dari computed style.
             pesanTampil: m ? getComputedStyle(m).display !== 'none' : false };
  })()`, true)

  console.log('  video:', JSON.stringify(info))
  check('video punya resolusi nyata', (info.width || 0) > 0, `${info.width}x${info.height} ready=${info.readyState}`)
  check('video benar-benar berjalan', (info.duration || 0) > 0 && (info.after || 0) > (info.before || 0),
        `durasi=${info.duration} ${info.before} -> ${info.after}`)
  check('pesan status tidak menutupi video yang berjalan', info.pesanTampil === false,
        `tampil=${info.pesanTampil} teks=${JSON.stringify((info.pesan || '').slice(0, 40))}`)
  const realFails = failed.filter((f) => !/TMDB|image\.tmdb/i.test(f) && !/ERR_ABORTED/.test(f))
  check('tidak ada permintaan yang gagal', realFails.length === 0, realFails.slice(0, 3).join(' | '))

  console.log('\n== ' + ok + ' passed, ' + bad + ' failed ==')
  chrome.kill()
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
