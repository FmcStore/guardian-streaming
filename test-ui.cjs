/**
 * Uji UI Guardian di Chromium sungguhan lewat CDP.
 *
 * Tujuannya bukan sekadar "tidak ada error", tapi membuktikan alur yang
 * dipakai pengguna benar-benar jalan: home memuat data, kartu bisa diklik,
 * halaman tonton menampilkan iframe player milik server sendiri, dan iframe
 * itu benar-benar memuat video dari /hls/.
 */
const { spawn } = require('node:child_process')
const http = require('node:http')

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const PORT = 9333
const BASE = process.argv[2] || 'http://127.0.0.1:8801'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = 0
let bad = 0
function check(name, cond, extra = '') {
  if (cond) { ok++; console.log('  PASS  ' + name.padEnd(52) + ' ' + extra) }
  else { bad++; console.log('  FAIL  ' + name.padEnd(52) + ' ' + extra) }
}

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' })

  // Tunggu CDP siap.
  let targets = null
  for (let i = 0; i < 60; i++) {
    try { targets = await httpJson('/json/list'); break } catch { await sleep(500) }
  }
  if (!targets) { console.log('chrome tidak mau dibuka'); process.exit(1) }

  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })

  let id = 0
  const pending = new Map()
  const consoleMsgs = []
  const failedRequests = []
  const requestById = new Map()

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      return
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      consoleMsgs.push({ type: m.params.type, text })
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push({
        type: 'exception',
        text: m.params.exceptionDetails.exception?.description
          || m.params.exceptionDetails.text,
      })
    }
    if (m.method === 'Network.requestWillBeSent') {
      requestById.set(m.params.requestId, m.params.request.url)
    }
    if (m.method === 'Network.loadingFailed') {
      // Sertakan URL-nya: tanpa itu, "ada permintaan gagal" tidak bisa
      // ditindaklanjuti karena tidak jelas apa yang gagal.
      const url = requestById.get(m.params.requestId) || '(url tidak diketahui)'
      failedRequests.push(`${m.params.errorText} ${url}`)
    }
  }

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

  await send('Runtime.enable')
  await send('Network.enable')
  await send('Page.enable')

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  async function go(path, waitMs = 2500) {
    await send('Page.navigate', { url: BASE + path })
    await sleep(waitMs)
  }

  // React mengisi halaman setelah bundle-nya selesai; lewat tunnel itu bisa
  // lebih dari 2 detik. Menunggu durasi tetap membuat uji melaporkan halaman
  // kosong padahal cuma belum selesai. Tunggu sampai jumlah elemen berhenti
  // bertambah, lalu periksa.
  async function tungguStabil(minElemen = 20, maksDetik = 30) {
    let prev = -1
    let stabil = 0
    for (let i = 0; i < maksDetik; i++) {
      await sleep(1000)
      const n = await evalJs('document.querySelectorAll("a,button").length')
      if (n >= minElemen && n === prev) { stabil++; if (stabil >= 2) return n }
      else stabil = 0
      prev = n
    }
    return prev
  }

  console.log('=== 1. halaman utama ===')
  await go('/')
  const homeCards = await tungguStabil()
  check('home merender elemen', homeCards > 20, 'elemen=' + homeCards)
  // Poster datang dari TMDB pihak ketiga; beri waktu sebelum menilai.
  await sleep(3000)
  const homeImgs = await evalJs(
    'Array.from(document.querySelectorAll("img")).filter(i=>i.naturalWidth>0).length')
  check('poster TMDB benar-benar termuat', homeImgs > 3, 'gambar=' + homeImgs)
  const homeText = await evalJs('document.body.innerText.slice(0,120).replace(/\\n/g," | ")')
  check('home tidak kosong', homeText.trim().length > 10, homeText.slice(0, 70))

  console.log()
  console.log('=== 2. detail film ===')
  await go('/title/' + encodeURIComponent('movie/550'))
  await sleep(2500)
  const detailTitle = await evalJs('document.querySelector("h1")?.innerText || ""')
  check('judul film muncul', /fight club/i.test(detailTitle), detailTitle)
  const detailCast = await evalJs('document.body.innerText.includes("Brad Pitt")')
  check('cast dari streamex tampil', detailCast === true)

  console.log()
  console.log('=== 3. halaman tonton + iframe player ===')
  await go('/watch/' + encodeURIComponent('movie/550'))
  // Tunggu iframe benar-benar terpasang, jangan menebak durasi tetap.
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const ada = await evalJs('document.querySelectorAll("iframe").length')
    if (ada > 0) break
  }
  const iframes = await evalJs(
    'Array.from(document.querySelectorAll("iframe")).map(f=>f.src)')
  check('ada iframe player', Array.isArray(iframes) && iframes.length > 0,
        JSON.stringify(iframes))
  check('iframe menunjuk ke server sendiri (bukan host media pihak ketiga)',
        (iframes || []).every((s) => s.startsWith(BASE)),
        (iframes || [])[0] || '')
  const servers = await evalJs(
    'Array.from(document.querySelectorAll(".server-select button")).map(b=>b.innerText)')
  check('tombol pemilih server ada', Array.isArray(servers) && servers.length > 0,
        JSON.stringify(servers))

  console.log()
  console.log('=== 4. isi iframe: video benar-benar jalan ===')
  // Tunggu <video> muncul di dalam iframe.
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const ada = await evalJs(
      '!!(document.querySelector("iframe")||{}).contentDocument?.querySelector("video")')
    if (ada) break
  }
  // iframe-nya same-origin, jadi keberadaannya diperiksa lewat contentDocument:
  // kalau dokumennya terbaca, iframe benar-benar terpasang dan bisa diperiksa.
  const frameInfo = await evalJs(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return { attached: false, reason: 'tidak ada iframe' };
    const d = f.contentDocument;
    return { attached: !!d, url: f.src,
             hasVideo: !!(d && d.querySelector('video')),
             text: (d && d.body ? d.body.innerText : '').slice(0, 120) };
  })()`)
  check('iframe terpasang dan isinya terbaca', frameInfo.attached === true,
        JSON.stringify(frameInfo).slice(0, 140))
  check('di dalam iframe ada <video>', frameInfo.hasVideo === true)

  // Video diperiksa di dalam iframe: same-origin, jadi dokumennya bisa dibaca.
  const info = await evalJs(`(async () => {
    const f = document.querySelector('iframe');
    const d = f && f.contentDocument;
    const v = d && d.querySelector('video');
    if (!v) return { err: 'tidak ada <video> di dalam iframe' };
    try { await v.play() } catch (e) { /* autoplay boleh ditolak */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (v.readyState >= 2 && v.videoWidth > 0) break;
      if (v.error) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const before = v.currentTime;
    await new Promise(r => setTimeout(r, 2500));
    return { src: v.currentSrc || v.src, readyState: v.readyState,
             width: v.videoWidth, height: v.videoHeight,
             duration: v.duration, before: before, after: v.currentTime,
             msg: (d.querySelector('#msg') || {}).innerText || '' };
  })()`, true)
    .catch((e) => ({ err: e.message }))

  check('elemen <video> ada di dalam iframe', !info.err, info.err || '')
  check('video punya resolusi nyata (metadata terbaca)',
        (info.width || 0) > 0, `${info.width}x${info.height} readyState=${info.readyState}`)
  check('video benar-benar berjalan (waktu bertambah)',
        (info.duration || 0) > 0 && (info.after || 0) > (info.before || 0),
        'durasi=' + info.duration + ' dtk ' + info.before + ' -> ' + info.after)
  check('playlist lewat origin kita',
        String(info.src || '').includes('/hls/') || String(info.src || '').startsWith('blob:'),
        info.src || '')

  console.log()
  console.log('=== 5. konsol & jaringan ===')
  const errors = consoleMsgs.filter((m) => m.type === 'error' || m.type === 'exception')
  check('tidak ada error JS di konsol', errors.length === 0,
        errors.slice(0, 3).map((e) => e.text.slice(0, 90)).join(' ;; '))
  // Kegagalan jaringan pada poster TMDB pihak ketiga bukan cacat kita.
  // ERR_ABORTED juga muncul untuk permintaan yang sengaja dibatalkan hls.js
  // saat mengganti jalur. Itu pembatalan, bukan permintaan yang ditolak server.
  const realFails = failedRequests.filter((f) =>
    !/TMDB|image\.tmdb/i.test(f) && !/ERR_ABORTED/.test(f))
  check('tidak ada permintaan yang gagal', realFails.length === 0,
        realFails.slice(0, 3).join(' ;; '))
  if (failedRequests.length && !realFails.length) {
    // Selalu tampilkan URL-nya, bukan cuma jumlahnya: menyaring tanpa melihat
    // apa yang disaring itu cara paling mudah menyembunyikan bug nyata.
    console.log('    (diabaikan, pembatalan yang disengaja:',
                failedRequests.length, 'permintaan)')
    failedRequests.slice(0, 5).forEach((f) => console.log('      -', f))
  }

  console.log()
  console.log('== ' + ok + ' passed, ' + bad + ' failed ==')
  ws.close()
  chrome.kill()
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error('GAGAL:', e.message); process.exit(1) })
