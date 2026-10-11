#!/usr/bin/env node
/**
 * Periksa halaman utama dengan waktu tunggu yang cukup, sekali saja.
 *
 * Uji UI utama menunggu 2 detik setelah navigasi. Lewat tunnel publik, bundle
 * React + permintaan /api/home kadang belum selesai dalam 2 detik, sehingga uji
 * itu melaporkan "home kosong" padahal hanya belum selesai dimuat. Alat ini
 * menunggu sampai jumlah elemen berhenti bertambah, lalu melaporkan apa adanya.
 *
 * Pemakaian: node probe-home.cjs <base>
 */
const { spawn } = require('node:child_process')
const http = require('node:http')

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const PORT = 9443
const BASE = (process.argv[2] || 'http://127.0.0.1:8810').replace(/\/$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
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
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })

  let id = 0
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text || 'exception')
    }
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  await send('Runtime.enable'); await send('Page.enable')

  console.log('=== halaman utama: ' + BASE + '/ ===')
  await send('Page.navigate', { url: BASE + '/' })

  // Tunggu sampai jumlah elemen berhenti bertambah, maksimum 60 detik.
  let prev = -1
  let stabil = 0
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const n = await ev('document.querySelectorAll("a,button").length')
    if (n === prev && n > 0) { stabil++; if (stabil >= 3) break } else { stabil = 0 }
    prev = n
    process.stdout.write(`  t=${i + 1}s elemen=${n}\n`)
  }

  const hasil = await ev(`({
    elemen: document.querySelectorAll('a,button').length,
    kartu: document.querySelectorAll('a[href*="/watch/"], a[href*="/movie"], a[href*="/tv"]').length,
    imgTotal: document.querySelectorAll('img').length,
    imgTermuat: Array.from(document.querySelectorAll('img')).filter((i) => i.naturalWidth > 0).length,
    judul: Array.from(document.querySelectorAll('a[href*="/watch/"]')).slice(0, 4).map((a) => a.textContent.trim().slice(0, 28)),
  })`)
  console.log('  hasil:', JSON.stringify(hasil))
  console.log('  error JS:', JSON.stringify(consoleErrors.slice(0, 3)))

  chrome.kill()
  process.exit(0)
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
