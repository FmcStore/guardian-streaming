// Frontend API client — talks to the Guardian backend (/api), which proxies lk21 scraper.
import type { HomeData, BrowseData, SearchData, TitleDetail, StreamData, MetaItem } from './data'

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export const fetchHome = () => get<HomeData>('/api/home')
export const fetchBrowse = (path: string, page = 1, type = '') =>
  get<BrowseData>(`/api/browse${path}?page=${page}${type ? `&type=${type}` : ''}`)
export const fetchSearch = (query: string, page = 1) =>
  get<SearchData>(`/api/search?q=${encodeURIComponent(query)}&page=${page}`)
export const fetchGenres = () => get<{ items: MetaItem[] }>('/api/genres')
export const fetchCountries = () => get<{ items: MetaItem[] }>('/api/countries')
export const fetchYears = () => get<{ items: string[] }>('/api/years')
export const fetchDetail = (url: string) => get<TitleDetail>(`/api/detail?url=${encodeURIComponent(url)}`)
export const fetchStream = (url: string) => get<StreamData>(`/api/stream?url=${encodeURIComponent(url)}`)