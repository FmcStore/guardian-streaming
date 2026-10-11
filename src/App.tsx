import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowRight, ChevronLeft, ChevronRight, Clock3, ExternalLink, FileDown, Film, Loader2, Menu,
  Play, Search, Star, Tv, X,
} from 'lucide-react'
import type { MetaItem, Title, TitleDetail, StreamData } from './data'
import { fetchBrowse, fetchCountries, fetchDetail, fetchGenres, fetchHome, fetchSearch, fetchStream, fetchYears } from './api'

type Page =
  | { name: 'home' }
  | { name: 'browse'; path: string; type?: string; query?: string; meta?: 'genre' | 'country' | 'year' }
  | { name: 'detail'; url: string }
  | { name: 'watch'; url: string }

function getRoute(): Page {
  const path = window.location.pathname
  const q = new URLSearchParams(window.location.search)

  if (path === '/' || path === '') return { name: 'home' }

  // /watch/<encoded url>
  if (path.startsWith('/watch/')) return { name: 'watch', url: decodeURIComponent(path.slice(7)) }

  // /title/<encoded url>
  if (path.startsWith('/title/')) return { name: 'detail', url: decodeURIComponent(path.slice(7)) }

  if (path.startsWith('/search')) return { name: 'browse', path: '/latest', query: q.get('q') || '' }

  if (path === '/genre') return { name: 'browse', path: '/latest', meta: 'genre' }
  if (path.startsWith('/genre/')) return { name: 'browse', path: path }
  if (path === '/country') return { name: 'browse', path: '/latest', meta: 'country' }
  if (path.startsWith('/country/')) return { name: 'browse', path: path }
  if (path === '/year') return { name: 'browse', path: '/latest', meta: 'year' }
  if (path.startsWith('/year/')) return { name: 'browse', path: path }

  if (path === '/movies') return { name: 'browse', path: '/latest', type: 'movie' }
  if (path === '/series') return { name: 'browse', path: '/latest-series', type: 'series' }

  // /latest, /latest-series, /populer, /rating, /release, /most-commented, /top-movie-today, /quality/...
  if (path.startsWith('/quality/')) return { name: 'browse', path }
  if (['/latest', '/latest-series', '/populer', '/rating', '/release', '/most-commented', '/top-movie-today'].includes(path)) {
    return { name: 'browse', path }
  }

  return { name: 'browse', path: '/populer' }
}

function go(path: string) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/* ---------- tiny async hook ---------- */
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    fn()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, loading, error }
}

function Loading() {
  return <div className="empty"><Loader2 className="spin" size={30} /><h2>Memuat data…</h2><p>Mengambil data dari server.</p></div>
}
function ErrorBox({ message }: { message: string }) {
  return <div className="empty"><Film size={30} /><h2>Terjadi kesalahan</h2><p>{message}</p></div>
}

/* ---------- Header ---------- */
function Header({ onSearch }: { onSearch: (query: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); if (query.trim()) onSearch(query.trim()) }
  return <header className="header">
    <div className="header-inner">
      <button className="brand" onClick={() => go('/')} aria-label="Guardian home"><span className="brand-mark">G</span><span>GUARDIAN</span></button>
      <nav className={open ? 'nav nav-open' : 'nav'}>
        <button onClick={() => go('/')}>Home</button>
        <button onClick={() => go('/movies')}>Movies</button>
        <button onClick={() => go('/series')}>Series</button>
        <button onClick={() => go('/genre')}>Genre</button>
        <button onClick={() => go('/country')}>Country</button>
        <button onClick={() => go('/year')}>Year</button>
      </nav>
      <div className="header-actions">
        <form className="search" onSubmit={submit}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies, series..." aria-label="Search" /></form>
        <button className="menu-button" onClick={() => setOpen(!open)} aria-label="Open menu">{open ? <X size={21} /> : <Menu size={21} />}</button>
        <button className="avatar">A</button>
      </div>
    </div>
  </header>
}

/* ---------- Poster ---------- */
function PosterCard({ title, onClick }: { title: Title; onClick: () => void }) {
  const pres = (v?: string | number) => (v === undefined || v === '' || v === 0) ? '–' : String(v)
  return <button className="poster-card" onClick={onClick}>
    <div className="poster-wrap">
      <img src={title.poster} alt={title.title} loading="lazy" />
      <div className="poster-overlay"><span className="play-circle"><Play size={17} fill="currentColor" /></span></div>
      {title.quality && <span className="quality">{title.quality}</span>}
      {title.type === 'series' && <span className="type-badge"><Tv size={12} /> SERIES</span>}
    </div>
    <div className="poster-info"><h3>{title.title}</h3><div><span>{pres(title.year)}</span><span className="dot">•</span><span className="rating"><Star size={12} fill="currentColor" /> {pres(title.rating)}</span></div></div>
  </button>
}

function Rail({ title, items, onSeeAll }: { title: string; items: Title[]; onSeeAll?: () => void }) {
  if (!items.length) return null
  return <section className="section"><div className="section-heading"><div><h2>{title}</h2><span className="heading-line" /></div>{onSeeAll && <button className="see-all" onClick={onSeeAll}>See all <ArrowRight size={15} /></button>}</div><div className="rail">{items.map((item) => <PosterCard key={item.id + item.title} title={item} onClick={() => goToDetail(item)} />)}</div></section>
}

const BASE = 'https://tv12.lk21official.cc'
const goToDetail = (item: Title) => go(`/title/${encodeURIComponent(item.url || `${BASE}/${item.slug}`)}`)
const goToWatch = (url: string) => go(`/watch/${encodeURIComponent(url)}`)

/* ---------- Home ---------- */
function Home() {
  const { data, loading, error } = useAsync(fetchHome, [])
  if (loading) return <Loading />
  if (error || !data) return <div className="page-content"><ErrorBox message={error || 'Gagal memuat home.'} /></div>

  const known = [
    'Film Terbaru', 'Series Unggulan', 'Series Update', 'Top Bulan Ini', 'Rekomendasi Untukmu',
    'Nonton Bareng Keluarga', 'Korea Terbaru', 'Drakor Terbaru', 'Maraton Drakor',
  ]

  // Slide hero: prefer "Top Bulan Ini", lalu section pertama, ditambah film terbaru.
  const heroPool = [
    ...(data.sections.find((s) => /top bulan/i.test(s.title))?.items || []),
    ...(data.sections.find((s) => s.items.length)?.items || []),
    ...data.latest,
  ]
  const slides = [...new Map(heroPool.map((i) => [i.id + i.title, i])).values()].slice(0, 5)

  return <>
    {slides.length > 0 && <Hero items={slides} />}
    <main className="page-content">
      {data.sections.filter((s) => known.some((k) => s.title.toLowerCase().includes(k.toLowerCase())) || true).map((s, i) => (
        <Rail key={s.type + i} title={s.title || `Section ${i + 1}`} items={s.items.slice(0, 12)} onSeeAll={s.seeAll ? () => goSeeAll(s.seeAll) : undefined} />
      ))}
      {data.latest.length > 0 && (
        <section className="section"><div className="section-heading"><div><h2>Daftar Lengkap Film Terbaru</h2><span className="heading-line" /></div><button className="see-all" onClick={() => go('/latest')}>See all <ArrowRight size={15} /></button></div><div className="catalog-grid">{data.latest.slice(0, 24).map((item) => <PosterCard key={item.id + item.title} title={item} onClick={() => goToDetail(item)} />)}</div></section>
      )}
    </main>
  </>
}

function goSeeAll(url: string) {
  // seeAll is an absolute lk21 url; convert to our browse routes when possible.
  const path = url.replace(BASE, '').replace(/\/page\/\d+$/, '')
  go(path.startsWith('/') && !path.startsWith('/api') ? path : '/latest')
}

function Hero({ items }: { items: Title[] }) {
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  const count = items.length
  const pres = (v?: string | number) => (v === undefined || v === '' || v === 0) ? '–' : String(v)

  useEffect(() => {
    if (count <= 1 || paused) return
    const t = setInterval(() => setActive((a) => (a + 1) % count), 5000)
    return () => clearInterval(t)
  }, [count, paused])

  const prev = () => setActive((a) => (a - 1 + count) % count)
  const next = () => setActive((a) => (a + 1) % count)

  // Swipe (touch)
  const touchStart = useRef<number | null>(null)
  const onTouchStart = (e: React.TouchEvent) => { touchStart.current = e.touches[0].clientX }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStart.current === null) return
    const dx = e.changedTouches[0].clientX - touchStart.current
    if (Math.abs(dx) > 50) dx < 0 ? next() : prev()
    touchStart.current = null
  }

  return <section className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
    {items.map((title, i) => (
      <div key={title.id + i} className={`hero-slide${i === active ? ' active' : ''}`} style={{ backgroundImage: `linear-gradient(90deg, #090a0f 0%, rgba(9,10,15,.82) 36%, rgba(9,10,15,.14) 100%), linear-gradient(0deg, #090a0f 0%, transparent 36%), url(${title.poster})` }} aria-hidden={i !== active}>
        <div className="hero-content"><span className="eyebrow"><span className="live-dot" /> {title.type === 'series' ? 'FEATURED SERIES' : 'FEATURED MOVIE'}</span><h1>{title.title}</h1><p className="hero-meta"><span>{pres(title.year)}</span><span>•</span><span className="rating"><Star size={14} fill="currentColor" /> {pres(title.rating)}</span><span>•</span><span>{title.quality || title.runtime}</span></p><p className="hero-description">{(title.genre || []).join(' · ') || `${title.quality} ${title.type}`}</p><div className="hero-actions"><button className="primary-button" onClick={() => goToDetail(title)}><Play size={17} fill="currentColor" /> Lihat detail</button><button className="ghost-button" onClick={() => goFile(title)}>Browse <ArrowRight size={16} /></button></div></div>
      </div>
    ))}
    {count > 1 && <>
      <button className="hero-arrow prev" onClick={prev} aria-label="Sebelumnya"><ChevronLeft size={22} /></button>
      <button className="hero-arrow next" onClick={next} aria-label="Berikutnya"><ChevronRight size={22} /></button>
      <div className="hero-dots">{items.map((_, i) => <button key={i} className={`hero-dot${i === active ? ' active' : ''}`} onClick={() => setActive(i)} aria-label={`Slide ${i + 1}`} />)}</div>
    </>}
  </section>
}

function goFile(item: Title) { go(item.type === 'series' ? '/series' : '/movies') }

/* ---------- Browse ---------- */
function Browse({ path, type, query, meta }: { path: string; type?: string; query?: string; meta?: 'genre' | 'country' | 'year' }) {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState(type || '')

  const isMeta = meta === 'genre' || meta === 'country' || meta === 'year'

  if (isMeta) {
    return <MetaBrowse mode={meta} />
  }

  const deps = [path, page, filter, query]
  const { data, loading, error } = useAsync<
    { title: string; page: number; totalPages: number; items: Title[]; query?: string; path?: string }
  >(
    () => query
      ? fetchSearch(query, page).then((d) => ({ title: '', page: d.page, totalPages: d.totalPages, items: d.items, query: d.query }))
      : fetchBrowse(path, page, filter),
    deps,
  )

  if (loading) return <Loading />
  if (error || !data) return <div className="page-content"><ErrorBox message={error || 'Gagal memuat katalog.'} /></div>

  const title = query ? `Hasil pencarian “${data.query}”` : (data.title || humanize(path))
  const items: Title[] = data.items || []

  return <main className="page-content browse-page">
    <div className="page-heading"><div><span className="eyebrow">CATALOG</span><h1>{title}</h1><p>Temukan film dan series favoritmu.</p></div></div>
    {!query && (
      <div className="filters"><div className="filter-scroll">
        {['', 'movie', 'series'].map((f) => <button key={f || 'all'} className={filter === f ? 'filter active' : 'filter'} onClick={() => { setFilter(f); setPage(1) }}>{f ? (f === 'movie' ? 'Movie' : 'Series') : 'All'}</button>)}
      </div></div>
    )}
    {items.length ? (
      <div className="catalog-grid">{items.map((item) => <PosterCard key={item.id + item.title} title={item} onClick={() => goToDetail(item)} />)}</div>
    ) : <div className="empty"><Film size={30} /><h2>Tidak ada hasil</h2><p>Coba kata kunci atau halaman lain.</p></div>}

    {!query && data.totalPages > 1 && (
      <nav className="pagination">
        <button className="page-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={15} /> Sebelumnya</button>
        <span className="page-info">Halaman {data.page} dari {data.totalPages}</span>
        <button className="page-btn" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Berikutnya <ChevronRight size={15} /></button>
      </nav>
    )}
  </main>
}

function humanize(p: string) {
  const seg = decodeURIComponent(p.split('/').filter(Boolean).pop() || '')
  return seg ? seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Katalog'
}

function MetaBrowse({ mode }: { mode: 'genre' | 'country' | 'year' }) {
  const deps = [mode]
  const { data, loading, error } = useAsync<{ items: (MetaItem | string)[] }>(
    () => mode === 'genre'
      ? fetchGenres()
      : mode === 'country'
        ? fetchCountries()
        : fetchYears().then((d) => ({ items: d.items })),
    deps,
  )
  if (loading) return <Loading />
  if (error || !data) return <div className="page-content"><ErrorBox message={error || 'Gagal memuat.'} /></div>

  const label = mode === 'genre' ? 'Genre' : mode === 'country' ? 'Negara' : 'Tahun'
  const items = data.items

  return <main className="page-content browse-page">
    <div className="page-heading"><div><span className="eyebrow">KATALOG</span><h1>Daftar {label}</h1><p>Pilih salah satu untuk menjelajahi konten.</p></div></div>
    <div className="meta-grid">
      {mode === 'year'
        ? items.map((it) => <button key={String(it)} className="meta-chip" onClick={() => go(`/year/${it}`)}>{String(it)}</button>)
        : items.map((it) => {
            const m = it as MetaItem
            return <button key={m.slug} className="meta-chip" onClick={() => go(`/${mode}/${m.slug}`)}>{m.name}</button>
          })}
    </div>
  </main>
}

/* ---------- Detail ---------- */
function Detail({ url }: { url: string }) {
  const { data, loading, error } = useAsync(() => fetchDetail(url), [url])
  if (loading) return <Loading />
  if (error || !data) return <div className="page-content"><ErrorBox message={error || 'Gagal memuat detail.'} /></div>
  return <DetailBody detail={data} />
}

function DetailBody({ detail }: { detail: TitleDetail }) {
  const [season, setSeason] = useState(Object.keys(detail.seasons || {})[0] || '1')
  const episodes = detail.seasons?.[season] || []
  // Movies: stream from the tv12 detail page — it contains #player-list.
  // (detail.playAwal points to the dadadidi download page, which has no players.)
  const watchUrl = detail.type === 'series'
    ? (episodes[0]?.url || detail.playAwal || detail.playTerbaru || detail.url)
    : (detail.url)
  const poster = detail.poster
  const year = (detail.release || '').match(/\d{4}/)?.[0] || ''
  const rating = detail.rating || (detail.votes ? detail.votes : '')

  return <main className="detail-page"><div className="detail-backdrop" style={{ backgroundImage: `linear-gradient(0deg, #090a0f 0%, rgba(9,10,15,.76) 42%, rgba(9,10,15,.25)), url(${poster})` }} /><div className="detail-content"><button className="back-link" onClick={() => go('/')}><ChevronLeft size={17} /> Back to browse</button><div className="detail-grid"><img className="detail-poster" src={poster} alt={detail.title} /><div className="detail-copy"><span className="eyebrow">{detail.type === 'series' ? 'SERIES' : 'MOVIE'} · {(detail.country || []).join(', ').toUpperCase() || 'MOVIE'}</span><h1>{detail.title || 'Judul tidak diketahui'}</h1><div className="detail-meta">{rating && <span className="rating"><Star size={15} fill="currentColor" /> {rating}</span>}{year && <span>{year}</span>}{detail.director && <span>Dir. {detail.director}</span>}<span className="cert">16+</span></div>{detail.synopsis && <p className="detail-synopsis">{detail.synopsis}</p>}{detail.genres?.length > 0 && <div className="tag-list">{detail.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>}<div className="hero-actions"><button className="primary-button" onClick={() => goToWatch(watchUrl)}><Play size={17} fill="currentColor" /> {detail.type === 'series' ? 'Nonton episode 1' : 'Watch now'}</button>{detail.download && <a className="ghost-button" href={detail.download} target="_blank" rel="noreferrer"><FileDown size={16} /> Download</a>}</div></div></div><div className="info-columns"><div><span>Director</span><strong>{detail.director || '–'}</strong></div><div><span>Country</span><strong>{(detail.country || []).join(', ') || '–'}</strong></div><div><span>Release</span><strong>{detail.release || '–'}</strong></div><div><span>Cast</span><strong>{(detail.cast || []).slice(0, 2).join(', ') || '–'}</strong></div></div>{detail.type === 'series' && Object.keys(detail.seasons || {}).length > 0 && <div className="episodes"><div className="section-heading"><div><h2>Episodes</h2><span className="heading-line" /></div><select aria-label="Select season" value={season} onChange={(e) => setSeason(e.target.value)}>{Object.keys(detail.seasons || {}).map((s) => <option key={s} value={s}>Season {s}</option>)}</select></div><div className="episode-list">{episodes.map((ep) => <button key={ep.slug} className="episode" onClick={() => goToWatch(ep.url)}><span className="episode-number">{String(ep.episode).padStart(2, '0')}</span><span className="episode-thumbnail" style={{ backgroundImage: `url(${poster})` }}><Play size={17} fill="white" /></span><span className="episode-name"><strong>Episode {ep.episode}</strong><small>{ep.title || 'Putar episode'}</small></span><span className="episode-duration"><Clock3 size={14} /> stream</span></button>)}</div></div>}{detail.related?.length > 0 && <Rail title="Konten terkait" items={detail.related.slice(0, 6)} />}</div></main>
}

/* ---------- Watch / Stream ---------- */
function Watch({ url }: { url: string }) {
  const { data, loading, error } = useAsync(() => fetchStream(url), [url])
  if (loading) return <Loading />
  if (error || !data) return <div className="watch-page"><div className="page-content"><ErrorBox message={error || 'Gagal memuat stream.'} /></div></div>
  return <WatchBody stream={data} />
}

function WatchBody({ stream }: { stream: StreamData }) {
  const [active, setActive] = useState(0)
  const players = stream.players || []
  const src = players[active]?.url
  // Accept absolute player URLs and our own /pp/ reverse-proxy paths.
  const isIframe = /^(https?:\/\/|\/pp\/)/.test(src || '')

  return <main className="watch-page"><div className="player">{isIframe ? <iframe className="player-embed" src={src} referrerPolicy="no-referrer" allow="autoplay; fullscreen; encrypted-media" allowFullScreen title="Player" /> : <div className="player-content"><span className="play-circle large"><Play size={28} fill="currentColor" /></span><p>{src ? 'Sumber video perlu dibuka' : 'Tidak ada server streaming'}</p><small>{src ? `URL: ${src}` : 'Server streaming tidak tersedia untuk konten ini.'}</small></div>}</div><div className="watch-info"><button className="back-link" onClick={() => go('/')}><ChevronLeft size={17} /> Back to browse</button><div className="watch-title"><div><span className="eyebrow">NOW WATCHING</span><h1>{stream.title || 'Streaming'}</h1><p>{players.length > 1 ? 'Pilih server untuk memutar konten.' : (players[0]?.server ? `Memutar via ${players[0].server}.` : 'Memutar konten.')}</p></div>{players.length > 1 && <div className="server-select"><span>Source</span>{players.map((p, i) => <button key={i} className={i === active ? 'server active' : 'server'} onClick={() => setActive(i)}>{p.server || `Server ${i + 1}`}</button>)}</div>}</div>{src && <div className="watch-fallback"><ExternalLink size={15} /><span>Player tidak muncul? Buka di tab baru:</span><a href={src} target="_blank" rel="noreferrer">{src}</a></div>}{stream.nav?.length > 0 && <div className="watch-nav"><h2>Navigasi Episode</h2><div>{stream.nav.map((n, i) => <button key={i} className="server" onClick={() => goToWatch(n.url)}>{n.text}</button>)}</div></div>}</div></main>
}

/* ---------- App ---------- */
export default function App() {
  const [, setRoute] = useState(getRoute())
  const route = getRoute()
  const refresh = () => setRoute(getRoute())
  useEffect(() => {
    window.onpopstate = refresh
    return () => { window.onpopstate = null }
  }, [])

  const search = (query: string) => { go(`/search?q=${encodeURIComponent(query)}`) }

  return <>
    <Header onSearch={search} />
    {route.name === 'home' && <Home />}
    {route.name === 'browse' && <Browse path={route.path} type={route.type} query={route.query} meta={route.meta} />}
    {route.name === 'detail' && <Detail url={route.url} />}
    {route.name === 'watch' && <Watch url={route.url} />}
  </>
}