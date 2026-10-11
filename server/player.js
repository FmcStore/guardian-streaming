/**
 * Halaman player yang di-embed UI di halaman tonton.
 *
 * UI meng-embed `players[i].url` sebagai iframe, dan URL itu menunjuk ke sini
 * (bukan ke host media pihak ketiga). Halaman ini meminta daftar sumber ke
 * `/data/sources` — di sisi server, sumber itu sudah diuji sampai segmen
 * pertama, dan playlist-nya sudah dibungkus `/hls/index.m3u8` milik server ini.
 * Jadi browser tidak pernah memegang token, Referer, atau Cookie host media.
 *
 * Pemutarannya lewat hls.js, bukan `<video src="...m3u8">`. Ini bukan pilihan
 * gaya: Chrome dan Firefox tidak punya dukungan HLS native, jadi <video> polos
 * menghasilkan `DEMUXER_ERROR_COULD_NOT_PARSE` dan layar hitam. Safari memang
 * bisa native, jadi kalau hls.js tidak termuat kita jatuh ke jalur native itu.
 *
 * Kalau satu sumber gagal, halaman mencoba sumber berikutnya sendiri. Sumber
 * yang sudah gugur di sisi server tidak pernah sampai ke sini.
 */

export function renderPlayerPage({ kind, id, season, episode, playerId, embed, playerIds }) {
  const cfg = {
    kind: kind === 'tv' || kind === 'series' ? 'tv' : 'movie',
    id: String(id || ''),
    season: season ? String(season) : '',
    episode: episode ? String(episode) : '',
    playerId: String(playerId || '5'),
    embed: !!embed,
  }
  // Urutan player yang dicoba kalau yang diminta tidak punya sumber. Dikirim
  // dari server supaya daftarnya hanya ada di satu tempat, bukan disalin ke
  // halaman ini dan perlahan jadi tidak cocok dengan registri aslinya.
  const urutan = Array.isArray(playerIds) && playerIds.length
    ? playerIds.map(String)
    : [cfg.playerId]

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Player</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d13; color: #f2f3f7;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { height: 100%; display: flex; flex-direction: column; }
  .stage { position: relative; flex: 1; min-height: 0; background: #000; }
  video { width: 100%; height: 100%; background: #000; object-fit: contain; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 9px;
    padding: 9px 13px; border-top: 1px solid rgba(255,255,255,.08); }
  .bar strong { font-weight: 600; margin-right: auto; font-size: 13px; max-width: 42%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button, select { font: inherit; color: inherit; background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 6px 10px;
    cursor: pointer; }
  button:hover { background: rgba(255,255,255,.12); }
  button.on { background: #ee6849; border-color: #ee6849; color: #fff; }
  .msg { position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 11px; text-align: center;
    padding: 26px; }
  .msg p { margin: 0; max-width: 48ch; color: #b9bcc9; }
  .msg .err { color: #ffb4a6; }
  .spin { width: 24px; height: 24px; border: 3px solid rgba(255,255,255,.18);
    border-top-color: #ee6849; border-radius: 50%; animation: r 1s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="stage">
    <video id="v" playsinline controls crossorigin="anonymous"></video>
    <div class="msg" id="msg"><span class="spin"></span><p>Menyelesaikan sumber…</p></div>
  </div>
  <div class="bar">
    <strong id="label">Memuat…</strong>
    <span id="picks"></span>
    <select id="subs" style="display:none"></select>
  </div>
</div>
<script src="/assets/hls.min.js"></script>
<script>
const CFG = ${JSON.stringify(cfg)};
const DAFTAR_PLAYER = ${JSON.stringify(urutan)};
const v = document.getElementById('v');
const msg = document.getElementById('msg');
const picks = document.getElementById('picks');
const subsSel = document.getElementById('subs');
const label = document.getElementById('label');
let list = [];
let active = 0;
let hls = null;
// Sekali gambar pertama benar-benar datang, jangan diganggu lagi.
let started = false;

function say(text, isError) {
  msg.style.display = 'flex';
  msg.innerHTML = (isError ? '' : '<span class="spin"></span>') +
    '<p class="' + (isError ? 'err' : '') + '">' + text + '</p>';
}
function hide() { msg.style.display = 'none'; }

async function load() {
  // Player yang resolvernya tidak menghasilkan apa-apa bukan tempat berhenti.
  // Kejadian nyata: untuk satu judul, P1 balas 404 dan P9 balas 502, sementara
  // P5 justru punya sumber hidup. Kalau iframe menyerah di player pertama,
  // penonton melihat "gagal" padahal tontonannya ada di tab sebelah.
  //
  // Urutan player datang dari server (nextPlayers), jadi tidak ada daftar
  // salinan di sini yang bisa perlahan tidak cocok dengan registri aslinya.
  let antre = [CFG.playerId];
  const sudah = [];
  const alasan = [];

  while (antre.length) {
    const pid = antre.shift();
    sudah.push(pid);
    try {
      const q = new URLSearchParams({ k: CFG.kind, id: CFG.id, player: pid });
      if (CFG.season) q.set('season', CFG.season);
      if (CFG.episode) q.set('episode', CFG.episode);
      // Player yang sudah dicoba dikirim balik supaya tidak diulang.
      if (sudah.length > 1) q.set('p', sudah.join(','));
      say('Menyelesaikan sumber…');
      const r = await fetch('/data/sources?' + q.toString());
      const j = await r.json();
      if (!j.ok) {
        // Hati-hati membedakan dua hal yang sama-sama 404:
        //   - parameter salah          -> tidak ada gunanya coba player lain
        //   - "player ini tidak punya  -> justru alasan untuk pindah ke player
        //      sumber untuk judul ini"     berikutnya, judulnya sendiri ada
        // Kejadian nyata: P1 balas 404 "tidak ada sumber stream untuk movie
        // 1175161" sementara P5 punya sumber yang bisa diputar. Menganggapnya
        // "judul tidak ditemukan" membuat penonton kehilangan tontonannya.
        if (r.status === 400) {
          return say('Permintaan ini tidak valid (' + (j.error || '') + ').', true);
        }
        alasan.push('server ' + pid + ': ' + (j.error || 'gagal'));
        if (Array.isArray(j.nextPlayers) && j.nextPlayers.length) {
          antre = j.nextPlayers.map(String);
        }
        continue;
      }
      const found = (j.data && j.data.sources) || [];
      if (j.data && j.data.title) label.textContent = j.data.title;
      if (!found.length) {
        alasan.push('server ' + pid + ' tidak punya sumber hidup');
        if (Array.isArray(j.nextPlayers)) antre = j.nextPlayers.map(String);
        continue;
      }
      list = found;
      renderPicks();
      play(0);
      return;
    } catch (err) {
      alasan.push('server ' + pid + ': ' + err.message);
    }
  }
  say('Tidak ada sumber untuk judul ini yang bisa diputar di browser. ' +
      'Sudah dicoba: ' + alasan.join('; ') + '. Coba server lain di halaman tonton.', true);
}

function renderPicks() {
  picks.innerHTML = '';
  if (list.length < 2) return;
  list.forEach(function (s, i) {
    const b = document.createElement('button');
    b.textContent = s.label || ('Sumber ' + (i + 1));
    b.className = i === active ? 'on' : '';
    b.addEventListener('click', function () { started = false; play(i); });
    picks.appendChild(b);
  });
}

function destroyPlayer() {
  if (hls) { try { hls.destroy(); } catch (e) { /* sudah dibuang */ } hls = null; }
  Array.from(v.querySelectorAll('track')).forEach(function (t) { t.remove(); });
}

function play(i) {
  active = i;
  const s = list[i];
  if (!s) return;
  say('Memuat ' + (s.label || 'sumber') + '…');
  renderPicks();
  destroyPlayer();
  v.removeAttribute('src');
  v.load();

  if (window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
    hls.on(window.Hls.Events.ERROR, function (_e, data) {
      if (!data.fatal) return;
      const why = data.details || data.type || 'kesalahan tidak dikenal';
      // Trek audio atau subtitle alternatif yang gagal tidak menghentikan
      // video utama. Menampilkan "semua sumber gagal" saat filmnya jelas
      // berjalan itu menyesatkan, dan sudah pernah terjadi.
      if (/TrackLoadError/i.test(why)) return;
      // Sudah ada gambar berjalan: jangan diganggu.
      if (v.currentTime > 0) return;
      // Satu sumber gagal bukan alasan menyerah: coba sumber berikutnya.
      if (active + 1 < list.length) {
        say('Sumber ' + (s.label || '') + ' gagal (' + why + '). Mencoba berikutnya…');
        play(active + 1);
      } else {
        say('Semua sumber gagal diputar di browser ini. Terakhir: ' + why +
            '. Coba server lain di halaman tonton.', true);
      }
    });
    hls.loadSource(s.playlist);
    hls.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari: HLS native, tidak butuh hls.js.
    v.src = s.playlist;
    v.load();
  } else {
    say('Browser ini tidak bisa memutar HLS. Coba Chrome, Edge, atau Safari terbaru.', true);
    return;
  }

  const p = v.play();
  if (p && p.catch) p.catch(function () { /* autoplay boleh ditolak browser */ });
  renderSubs();
}

function renderSubs() {
  const s = list[active];
  const subs = (s && s.subtitles) || [];
  subsSel.innerHTML = '';
  if (!subs.length) { subsSel.style.display = 'none'; return; }
  const off = document.createElement('option');
  off.value = '-1';
  off.textContent = 'Subtitle: mati';
  subsSel.appendChild(off);
  subs.forEach(function (sub, i) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = sub.label || sub.language || ('Sub ' + (i + 1));
    subsSel.appendChild(o);
  });
  subsSel.style.display = '';
  subsSel.onchange = function () {
    Array.from(v.querySelectorAll('track')).forEach(function (t) { t.remove(); });
    const idx = parseInt(subsSel.value, 10);
    if (idx < 0) return;
    const sub = subs[idx];
    if (!sub) return;
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = sub.label || sub.language || 'Sub';
    t.src = sub.url;
    t.default = true;
    v.appendChild(t);
    const track = v.textTracks[v.textTracks.length - 1];
    if (track) track.mode = 'showing';
  };
}

// Pesan "Memuat …" harus hilang begitu gambar benar-benar datang. Tanpa
// timeupdate di sini, penggantian sumber (mis. pindah player) meninggalkan
// pesan itu di layar atas video yang sudah berjalan.
v.addEventListener('timeupdate', function () {
  if (v.currentTime > 0 && v.readyState >= 2) hide();
});
v.addEventListener('loadeddata', function () { started = true; hide(); });
v.addEventListener('playing', hide);
v.addEventListener('error', function () {
  // Jalur native (Safari) melaporkan lewat sini. Jalur hls.js melaporkan lewat
  // event ERROR miliknya sendiri, jadi jangan dobel.
  if (hls || started || !v.src) return;
  say('Sumber ini tidak bisa diputar di browser ini. Coba sumber lain di bawah.', true);
});

load();
</script>
</body>
</html>`
}
