/**
 * Uji menentukan: apakah video di dalam iframe player benar-benar berjalan,
 * untuk tiap server. iframe-nya same-origin, jadi isinya bisa dibaca langsung.
 *
 * Pemakaian: node test-video.cjs <base> [player ...]
 */
const { spawn } = require('node:child_process')
const http = require('node:http')

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const PORT = 9336
const BASE = process.argv[2] || 'http://127.0.0.1:8801'
const PLAYERS = process.argv.slice(3).length ? process.argv.slice(3) : ['1', '5', '9']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' })

  let list = null
  for (let i = 0; i < 60; i++) {
    try { list = await httpJson('/json/list'); break } catch { await sleep(500) }
  }
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })

  let id = 0
  const pending = new Map()
  let netLog = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      return
    }
    if (m.method === 'Network.responseReceived') {
      const u = m.params.response.url
      if (u.includes('/hls/')) netLog.push(m.params.response.status + ' ' + u.split('?')[0])
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable')

  const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text || JSON.stringify(r.exceptionDetails) }
    return r.result.value
  }

  const results = []
  for (const player of PLAYERS) {
    console.log('=== server p=' + player + ' ===')
    netLog = []
    const url = BASE + '/api/player?k=movie&id=550&p=' + player + '&embed=1'
    await send('Page.navigate', { url })
    await sleep(2000)

    const info = await ev(`(async () => {
      const v = document.querySelector('video');
      if (!v) return { err: 'tidak ada <video>' };
      // Tunggu sumber disetel halaman player (resolver jalan di sisi server).
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        if (v.currentSrc && v.readyState >= 1) break;
        if (v.error) break;
        await new Promise(r => setTimeout(r, 500));
      }
      try { await v.play(); } catch (e) {}
      const t1 = Date.now();
      while (Date.now() - t1 < 45000) {
        if (v.readyState >= 2 && v.videoWidth > 0) break;
        if (v.error) break;
        await new Promise(r => setTimeout(r, 500));
      }
      const before = v.currentTime;
      await new Promise(r => setTimeout(r, 3000));
      const after = v.currentTime;
      const msg = document.querySelector('#msg');
      const label = document.querySelector('#label');
      return {
        src: (v.currentSrc || v.src || '').slice(0, 90),
        readyState: v.readyState,
        width: v.videoWidth, height: v.videoHeight,
        duration: Math.round((v.duration || 0) * 10) / 10,
        before: Math.round(before * 100) / 100,
        after: Math.round(after * 100) / 100,
        error: v.error ? (v.error.code + ' ' + v.error.message) : null,
        msg: msg && msg.style.display !== 'none' ? msg.innerText.slice(0, 150) : '',
        title: label ? label.innerText : '',
        picks: Array.from(document.querySelectorAll('#picks button')).map(b => b.innerText),
      };
    })()`, true)

    const segOk = netLog.filter((l) => l.startsWith('200') && l.includes('/seg')).length
    const playing = !info.err && info.width > 0 && info.after > info.before && segOk > 0
    console.log('  video   :', JSON.stringify({
      err: info.err, src: info.src, ready: info.readyState,
      res: info.width + 'x' + info.height, durasi: info.duration,
      maju: info.before + ' -> ' + info.after, error: info.error,
      judul: info.title, sumber: info.picks, pesan: info.msg,
    }, null, 0))
    console.log('  segmen 200:', segOk, 'dari', netLog.length, 'permintaan /hls/')
    console.log('  PUTAR   :', playing ? 'YA' : 'tidak')
    console.log()
    results.push({ player, playing, res: info.width + 'x' + info.height, seg: segOk, err: info.error || info.err || '' })
    void url
  }

  console.log('== ringkasan ==')
  results.forEach((r) => console.log('  p=' + r.player + '  putar=' + (r.playing ? 'YA' : 'tidak') +
    '  ' + r.res + '  segmen=' + r.seg + (r.err ? '  err=' + r.err : '')))

  ws.close(); chrome.kill()
  process.exit(results.some((r) => r.playing) ? 0 : 1)
}
main().catch((e) => { console.error('GAGAL:', e.message); process.exit(1) })
