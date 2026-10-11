// Shared data types for Guardian. Data itself now comes from the backend (/api),
// which proxies the lk21 scraper — see src/api.ts and server/.

export type TitleType = 'movie' | 'series'

export type Title = {
  id: string
  slug: string
  type: TitleType
  title: string
  year?: number
  rating: number
  quality: string
  runtime: string
  genre: string[]
  country: string
  synopsis: string
  poster: string
  backdrop: string
  accent: string
  featured?: boolean
  episodes?: number
  url: string
}

export type HomeSection = {
  type: string
  title: string
  seeAll: string
  items: Title[]
}

export type HomeData = {
  sections: HomeSection[]
  latest: Title[]
}

export type BrowseData = {
  title: string
  page: number
  totalPages: number
  items: Title[]
  path: string
  query?: string
}

export type SearchData = {
  query: string
  page: number
  totalPages: number
  items: Title[]
}

export type MetaItem = { slug: string; name: string }

export type PlayerItem = { server?: string; url: string; active?: boolean }

export type SeasonEpisode = { episode: number; title: string; slug: string; url: string }

export type TitleDetail = {
  url: string
  type: TitleType
  title: string
  rating: string
  votes: string
  genres: string[]
  country: string[]
  director: string
  cast: string[]
  release: string
  updated: string
  synopsis: string
  poster: string
  trailer: string
  download: string
  playAwal: string
  playTerbaru: string
  players: PlayerItem[]
  seasons: Record<string, SeasonEpisode[]>
  totalEpisodes: number
  latestEpisode: string
  related: Title[]
}

export type StreamData = {
  url: string
  title: string
  players: PlayerItem[]
  nav: { text: string; url: string }[]
}