import axios from 'axios';
import { year, getCurrentSeason, getNextSeason } from '../index';
import type { Episode } from './animeInterface';

// Utility function to ensure URL ends with a slash
function ensureUrlEndsWithSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

// Adjusting environment variables to ensure they end with a slash
const BASE_URL = ensureUrlEndsWithSlash(
  import.meta.env.VITE_BACKEND_URL as string,
);
const SKIP_TIMES = ensureUrlEndsWithSlash(
  import.meta.env.VITE_SKIP_TIMES as string,
);
let PROXY_URL = import.meta.env.VITE_PROXY_URL; // Default to an empty string if no proxy URL is provided
// Check if the proxy URL is provided and ensure it ends with a slash
if (PROXY_URL) {
  PROXY_URL = ensureUrlEndsWithSlash(import.meta.env.VITE_PROXY_URL as string);
}

const API_KEY = import.meta.env.VITE_API_KEY as string;

// Axios instance
const axiosInstance = axios.create({
  baseURL: PROXY_URL || undefined,
  timeout: 10000,
  headers: {
    'X-API-Key': API_KEY, // Assuming your API expects the key in this header
  },
});

// ---- Local Miruro-API integration -------------------------------------
// Self-hosted walterwhite-69/Miruro-API instance serving consumet-style
// /episodes and /watch routes. Runs locally on port 8000 during development;
// override with VITE_MIRURO_API for a deployed instance.
const MIRURO_API = ensureUrlEndsWithSlash(
  import.meta.env.VITE_MIRURO_API || 'http://localhost:8000/',
);

const miruroInstance = axios.create({
  baseURL: MIRURO_API,
  timeout: 30000,
  headers: { Accept: 'application/json' },
});

// Provider preference order: verified-working sources first, known-dead
// scrapers last (fallback in fetchAnimeStreamingLinks retries on failure).
const MIRURO_PROVIDER_ORDER = [
  'moo',
  'pewe',
  'kiwi',
  'hop',
  'ally',
  'bee',
  'bonk',
];

// Miruro-API episode id: watch/{provider}/{anilistId}/{category}/{slug}
interface MiruroEpisode {
  id: string;
  number: number;
  title?: string;
  description?: string | null;
  image?: string | null;
  airDate?: string | null;
}

interface MiruroEpisodesResponse {
  providers?: Record<
    string,
    { episodes?: Record<string, MiruroEpisode[] | undefined> }
  >;
}

// Frontend episode id: {anilistId}-{provider}-{category}-{slug}-episode-{number}
// Watch.tsx derives `number` via split('-episode-')[1].match(/^\d+/) and
// rebuilds the id as `{prefix}-episode-{number}` for deep links, so the
// suffix must be exactly `-episode-{number}`.
// Player.tsx derives the episode number via split('-').pop().
function buildEpisodeId(
  anilistId: string,
  provider: string,
  category: string,
  slug: string,
  number: number,
): string {
  return `${anilistId}-${provider}-${category}-${slug}-episode-${number}`;
}

interface ParsedEpisodeId {
  anilistId: string;
  provider: string;
  category: string;
  slug: string;
  number: string;
}

function parseEpisodeId(episodeId: string): ParsedEpisodeId | null {
  const match = episodeId.match(
    /^(\d+)-([^-]+)-(sub|dub|es)-(.+)-episode-(\d+(?:-\d+)?)$/,
  );
  if (!match) return null;
  const [, anilistId, provider, category, slug, number] = match;
  return { anilistId, provider, category, slug, number };
}

// Order providers by MIRURO_PROVIDER_ORDER, appending any unknown providers.
function orderProviderNames(names: string[]): string[] {
  const known = MIRURO_PROVIDER_ORDER.filter((name) => names.includes(name));
  const unknown = names.filter((name) => !MIRURO_PROVIDER_ORDER.includes(name));
  return [...known, ...unknown];
}

// Error handling function
// Function to handle errors and throw appropriately
function handleError(error: unknown, context: string): never {
  let errorMessage = 'An error occurred';
  const err = error as {
    message?: string;
    response?: { status?: number; data?: { message?: string } };
  };

  // Handling CORS errors (Note: This is a simplification. Real CORS errors are hard to catch in JS)
  if (err.message && err.message.includes('Access-Control-Allow-Origin')) {
    errorMessage = 'A CORS error occurred';
  }

  switch (context) {
    case 'data':
      errorMessage = 'Error fetching data';
      break;
    case 'anime episodes':
      errorMessage = 'Error fetching anime episodes';
      break;
    // Extend with other cases as needed
  }

  if (err.response) {
    // Extend with more nuanced handling based on HTTP status codes
    const status = err.response.status;
    if (status !== undefined && status >= 500) {
      errorMessage += ': Server error';
    } else if (status !== undefined && status >= 400) {
      errorMessage += ': Client error';
    }
    // Include server-provided error message if available
    errorMessage += `: ${err.response.data?.message || 'Unknown error'}`;
  } else if (err.message) {
    errorMessage += `: ${err.message}`;
  }

  console.error(`${errorMessage}`, error);
  throw new Error(errorMessage);
}

// Cache key generator
// Function to generate cache key from arguments
function generateCacheKey(...args: string[]) {
  return args.join('-');
}

interface CacheItem {
  value: unknown;
  timestamp: number;
}

// Session storage cache creation
// Function to create a cache in session storage
function createOptimizedSessionStorageCache(
  maxSize: number,
  maxAge: number,
  cacheKey: string,
) {
  const cache = new Map<string, CacheItem>(
    JSON.parse(sessionStorage.getItem(cacheKey) || '[]'),
  );
  const keys = new Set<string>(cache.keys());

  function isItemExpired(item: CacheItem) {
    return Date.now() - item.timestamp > maxAge;
  }

  function updateSessionStorage() {
    sessionStorage.setItem(
      cacheKey,
      JSON.stringify(Array.from(cache.entries())),
    );
  }

  return {
    get(key: string) {
      if (cache.has(key)) {
        const item = cache.get(key);
        if (!isItemExpired(item!)) {
          keys.delete(key);
          keys.add(key);
          return item!.value;
        }
        cache.delete(key);
        keys.delete(key);
      }
      return undefined;
    },
    set(key: string, value: unknown) {
      if (cache.size >= maxSize) {
        const oldestKey = keys.values().next().value;
        cache.delete(oldestKey);
        keys.delete(oldestKey);
      }
      keys.add(key);
      cache.set(key, { value, timestamp: Date.now() });
      updateSessionStorage();
    },
  };
}

// Constants for cache configuration
// Cache size and max age constants
const CACHE_SIZE = 20;
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Factory function for cache creation
// Function to create cache with given cache key
function createCache(cacheKey: string) {
  return createOptimizedSessionStorageCache(
    CACHE_SIZE,
    CACHE_MAX_AGE,
    cacheKey,
  );
}

interface FetchOptions {
  type?: string;
  season?: string;
  format?: string;
  sort?: string[];
  genres?: string[];
  id?: string;
  year?: string;
  status?: string;
}

// Individual caches for different types of data
// Creating caches for anime data, anime info, and video sources
const advancedSearchCache = createCache('Advanced Search');
const animeDataCache = createCache('Data');
const animeInfoCache = createCache('Info');
const animeEpisodesCache = createCache('Episodes');
const fetchAnimeEmbeddedEpisodesCache = createCache('Video Embedded Sources');
const videoSourcesCache = createCache('Video Sources 2');

// Fetch data from proxy with caching
// Function to fetch data from proxy with caching
async function fetchFromProxy(
  url: string,
  cache: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  },
  cacheKey: string,
) {
  try {
    // Attempt to retrieve the cached response using the cacheKey
    const cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
      return cachedResponse; // Return the cached response if available
    }

    // Adjust request parameters based on PROXY_URL's availability
    const requestConfig = PROXY_URL
      ? { params: { url } } // If PROXY_URL is defined, send the original URL as a parameter
      : {}; // If PROXY_URL is not defined, make a direct request

    // Proceed with the network request
    const response = await axiosInstance.get(
      PROXY_URL ? '' : url,
      requestConfig,
    );

    // After obtaining the response, verify it for errors or empty data
    if (
      response.status !== 200 ||
      (response.data.statusCode && response.data.statusCode >= 400)
    ) {
      const errorMessage = response.data.message || 'Unknown server error';
      throw new Error(
        `Server error: ${
          response.data.statusCode || response.status
        } ${errorMessage}`,
      );
    }

    // Assuming response data is valid, store it in the cache
    cache.set(cacheKey, response.data);

    return response.data; // Return the newly fetched data
  } catch (error) {
    handleError(error, 'data');
    throw error; // Rethrow the error for the caller to handle
  }
}

// Function to fetch anime data
export async function fetchAdvancedSearch(
  searchQuery: string = '',
  page: number = 1,
  perPage: number = 20,
  options: FetchOptions = {},
) {
  const queryParams = new URLSearchParams({
    ...(searchQuery && { query: searchQuery }),
    page: page.toString(),
    perPage: perPage.toString(),
    type: options.type ?? 'ANIME',
    ...(options.season && { season: options.season }),
    ...(options.format && { format: options.format }),
    ...(options.id && { id: options.id }),
    ...(options.year && { year: options.year }),
    ...(options.status && { status: options.status }),
    ...(options.sort && { sort: JSON.stringify(options.sort) }),
  });

  if (options.genres && options.genres.length > 0) {
    // Correctly encode genres as a JSON array
    queryParams.set('genres', JSON.stringify(options.genres));
  }
  const url = `${BASE_URL}meta/anilist/advanced-search?${queryParams.toString()}`;
  const cacheKey = generateCacheKey('advancedSearch', queryParams.toString());

  return fetchFromProxy(url, advancedSearchCache, cacheKey);
}

// Fetch Anime DATA Function
export async function fetchAnimeData(
  animeId: string,
  provider: string = 'gogoanime',
) {
  const params = new URLSearchParams({ provider });
  const url = `${BASE_URL}meta/anilist/data/${animeId}?${params.toString()}`;
  const cacheKey = generateCacheKey('animeData', animeId, provider);

  return fetchFromProxy(url, animeDataCache, cacheKey);
}

// Fetch Anime INFO Function
export async function fetchAnimeInfo(
  animeId: string,
  provider: string = 'gogoanime',
) {
  const params = new URLSearchParams({ provider });
  const url = `${BASE_URL}meta/anilist/info/${animeId}?${params.toString()}`;
  const cacheKey = generateCacheKey('animeInfo', animeId, provider);

  return fetchFromProxy(url, animeInfoCache, cacheKey);
}

// Function to fetch list of anime based on type (TopRated, Trending, Popular)
async function fetchList(
  type: string,
  page: number = 1,
  perPage: number = 16,
  options: FetchOptions = {},
) {
  let cacheKey: string;
  let url: string;
  const params = new URLSearchParams({
    page: page.toString(),
    perPage: perPage.toString(),
  });

  if (
    ['TopRated', 'Trending', 'Popular', 'TopAiring', 'Upcoming'].includes(type)
  ) {
    cacheKey = generateCacheKey(
      `${type}Anime`,
      page.toString(),
      perPage.toString(),
    );
    url = `${BASE_URL}meta/anilist/${type.toLowerCase()}`;

    if (type === 'TopRated') {
      options = {
        type: 'ANIME',
        sort: ['["SCORE_DESC"]'],
      };
      url = `${BASE_URL}meta/anilist/advanced-search?type=${options.type}&sort=${options.sort}&`;
    } else if (type === 'Popular') {
      options = {
        type: 'ANIME',
        sort: ['["POPULARITY_DESC"]'],
      };
      url = `${BASE_URL}meta/anilist/advanced-search?type=${options.type}&sort=${options.sort}&`;
    } else if (type === 'Upcoming') {
      const season = getNextSeason(); // This will set the season based on the current month
      options = {
        type: 'ANIME',
        season: season,
        year: year.toString(),
        status: 'NOT_YET_RELEASED',
        sort: ['["POPULARITY_DESC"]'],
      };
      url = `${BASE_URL}meta/anilist/advanced-search?type=${options.type}&status=${options.status}&sort=${options.sort}&season=${options.season}&year=${options.year}&`;
    } else if (type === 'TopAiring') {
      const season = getCurrentSeason(); // This will set the season based on the current month
      options = {
        type: 'ANIME',
        season: season,
        year: year.toString(),
        status: 'RELEASING',
        sort: ['["POPULARITY_DESC"]'],
      };
      url = `${BASE_URL}meta/anilist/advanced-search?type=${options.type}&status=${options.status}&sort=${options.sort}&season=${options.season}&year=${options.year}&`;
    }
  } else {
    cacheKey = generateCacheKey(
      `${type}Anime`,
      page.toString(),
      perPage.toString(),
    );
    url = `${BASE_URL}meta/anilist/${type.toLowerCase()}`;
    // params already defined above
  }

  const specificCache = createCache(`${type}`);
  return fetchFromProxy(`${url}?${params.toString()}`, specificCache, cacheKey);
}

// Functions to fetch top, trending, and popular anime
export const fetchTopAnime = (page: number, perPage: number) =>
  fetchList('TopRated', page, perPage);
export const fetchTrendingAnime = (page: number, perPage: number) =>
  fetchList('Trending', page, perPage);
export const fetchPopularAnime = (page: number, perPage: number) =>
  fetchList('Popular', page, perPage);
export const fetchTopAiringAnime = (page: number, perPage: number) =>
  fetchList('TopAiring', page, perPage);
export const fetchUpcomingSeasons = (page: number, perPage: number) =>
  fetchList('Upcoming', page, perPage);

// Fetch Anime Episodes Function
// Mirrors the consumet episode shape expected by Watch.tsx, sourced from the
// local Miruro-API instead of the (dead) consumet backend.
export async function fetchAnimeEpisodes(
  animeId: string,
  provider: string = 'gogoanime',
  dub: boolean = false,
): Promise<Episode[]> {
  const category = dub ? 'dub' : 'sub';
  const cacheKey = generateCacheKey(
    'animeEpisodes',
    animeId,
    provider,
    category,
  );

  try {
    const cached = animeEpisodesCache.get(cacheKey) as Episode[] | undefined;
    if (cached) return cached;

    const { data } = await miruroInstance.get<MiruroEpisodesResponse>(
      `episodes/${animeId}`,
    );
    const providers = data?.providers ?? {};
    const providerNames = orderProviderNames(Object.keys(providers));
    const episodesOf = (name: string, cat: string) =>
      providers[name]?.episodes?.[cat] ?? [];

    // Prefer the requested category; if no provider has it (e.g. no dubs),
    // fall back to sub so the page isn't a dead end.
    let sourceProvider = providerNames.find(
      (name) => episodesOf(name, category).length > 0,
    );
    let sourceCategory = category;
    if (!sourceProvider && category !== 'sub') {
      sourceProvider = providerNames.find(
        (name) => episodesOf(name, 'sub').length > 0,
      );
      sourceCategory = 'sub';
    }
    if (!sourceProvider) {
      animeEpisodesCache.set(cacheKey, []);
      return [];
    }

    // Backfill image/description/airDate per episode number from any
    // provider (most only populate these for some sources).
    const metaByNumber = new Map<number, MiruroEpisode>();
    for (const name of providerNames) {
      for (const episodes of Object.values(providers[name]?.episodes ?? {})) {
        for (const ep of episodes ?? []) {
          if (!metaByNumber.has(ep.number)) metaByNumber.set(ep.number, ep);
        }
      }
    }

    const episodes = episodesOf(sourceProvider, sourceCategory)
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((ep) => {
        const slug = ep.id.split('/').pop() ?? '';
        const meta = metaByNumber.get(ep.number);
        return {
          id: buildEpisodeId(
            animeId,
            sourceProvider!,
            sourceCategory,
            slug,
            ep.number,
          ),
          title: ep.title ?? `Episode ${ep.number}`,
          description: ep.description ?? meta?.description ?? null,
          number: ep.number,
          image: ep.image ?? meta?.image ?? '',
          imageHash: '',
          airDate: ep.airDate ?? meta?.airDate ?? null,
        };
      });

    animeEpisodesCache.set(cacheKey, episodes);
    return episodes;
  } catch (error) {
    return handleError(error, 'anime episodes');
  }
}

// Fetch Embedded Anime Episodes Servers
export async function fetchAnimeEmbeddedEpisodes(episodeId: string) {
  const url = `${BASE_URL}meta/anilist/servers/${episodeId}`;
  const cacheKey = generateCacheKey('animeEmbeddedServers', episodeId);

  return fetchFromProxy(url, fetchAnimeEmbeddedEpisodesCache, cacheKey);
}

// Function to fetch anime streaming links
// Parses our composite episode id, asks the local Miruro-API for streams,
// and falls back to other providers for the same episode when one is dead.
export async function fetchAnimeStreamingLinks(
  episodeId: string,
): Promise<WatchResponse> {
  const cacheKey = generateCacheKey('animeStreamingLinks', episodeId);

  try {
    const cached = videoSourcesCache.get(cacheKey) as WatchResponse | undefined;
    if (cached) return cached;

    const parsed = parseEpisodeId(episodeId);
    if (!parsed) {
      throw new Error(`Unrecognized episode id: ${episodeId}`);
    }
    const { anilistId, provider, category, slug, number } = parsed;

    // Same episode, other providers (fresh slugs), in preference order.
    const attempts = [{ provider, slug }];
    try {
      const { data } = await miruroInstance.get<MiruroEpisodesResponse>(
        `episodes/${anilistId}`,
      );
      const providers = data?.providers ?? {};
      for (const name of orderProviderNames(Object.keys(providers))) {
        if (name === provider) continue;
        const ep = (providers[name]?.episodes?.[category] ?? []).find(
          (candidate) => String(candidate.number) === number,
        );
        const fallbackSlug = ep?.id.split('/').pop();
        if (fallbackSlug) {
          attempts.push({ provider: name, slug: fallbackSlug });
        }
      }
    } catch {
      // Episode re-resolution is best-effort; the primary attempt still runs.
    }

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const { data } = await miruroInstance.get(
          `watch/${attempt.provider}/${anilistId}/${category}/${attempt.slug}`,
        );
        const response = transformMiruroWatchResponse(data);
        videoSourcesCache.set(cacheKey, response);
        return response;
      } catch (error) {
        lastError = error; // dead upstream (444/5xx) → try the next provider
      }
    }

    console.error('All providers failed for streaming links', lastError);
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to fetch streaming links');
  } catch (error) {
    return handleError(error, 'anime episodes');
  }
}

// Reshape Miruro-API /watch payload into the consumet watch shape Player.tsx
// expects: { sources: [{ quality, url }], download }. Exactly one source is
// marked 'default' (Player picks that one).
interface MiruroStream {
  url?: string;
  type?: string;
  quality?: string | number;
  server?: string;
  default?: boolean;
  referer?: string;
}

interface MiruroWatchResponse {
  streams?: MiruroStream[];
  download?: string;
}

interface WatchResponse {
  sources: { quality: string; url: string; type?: string }[];
  download: string;
}

// Route every stream through the Miruro-API /media proxy: provider CDNs
// (e.g. vidcache behind animegg) 500 unless the Referer is their embed page,
// which the browser can never send. The proxy forwards the embed referer and
// the Range header, so seeking still returns 206.
function viaMediaProxy(url: string, referer?: string): string {
  const params = new URLSearchParams({ url });
  if (referer) params.set('referer', referer);
  return `${MIRURO_API}media?${params.toString()}`;
}

function transformMiruroWatchResponse(data: MiruroWatchResponse) {
  const streams = (data.streams ?? []).filter(
    (stream) =>
      typeof stream.url === 'string' &&
      (stream.type === 'hls' || stream.type === 'mp4'),
  );

  if (streams.length === 0) {
    throw new Error('No playable streams returned');
  }

  const sources = streams.map((stream, index) => ({
    quality: stream.default
      ? 'default'
      : String(stream.quality ?? stream.server ?? index),
    url: viaMediaProxy(stream.url as string, stream.referer),
    type: stream.type,
  }));

  if (!sources.some((source) => source.quality === 'default')) {
    sources[0].quality = 'default';
  }

  const response: WatchResponse = {
    sources,
    download: data.download || sources[0].url,
  };
  return response;
}

// Function to fetch skip times for an anime episode
interface FetchSkipTimesParams {
  malId: string;
  episodeNumber: string;
  episodeLength?: string;
}

// Function to fetch skip times for an anime episode
export async function fetchSkipTimes({
  malId,
  episodeNumber,
  episodeLength = '0',
}: FetchSkipTimesParams) {
  // Constructing the URL with query parameters
  const types = ['ed', 'mixed-ed', 'mixed-op', 'op', 'recap'];
  const url = new URL(`${SKIP_TIMES}v2/skip-times/${malId}/${episodeNumber}`);
  url.searchParams.append('episodeLength', episodeLength.toString());
  types.forEach((type) => url.searchParams.append('types[]', type));

  const cacheKey = generateCacheKey(
    'skipTimes',
    malId,
    episodeNumber,
    episodeLength || '',
  );

  // Use the fetchFromProxy function to make the request and handle caching
  return fetchFromProxy(url.toString(), createCache('SkipTimes'), cacheKey);
}

// Fetch Recent Anime Episodes Function
export async function fetchRecentEpisodes(
  page: number = 1,
  perPage: number = 18,
  provider: string = 'gogoanime',
) {
  // Construct the URL with query parameters for fetching recent episodes
  const params = new URLSearchParams({
    page: page.toString(),
    perPage: perPage.toString(),
    provider: provider, // Default to 'gogoanime' if no provider is specified
  });

  // Using the BASE_URL defined at the top of your file
  const url = `${BASE_URL}meta/anilist/recent-episodes?${params.toString()}`;
  const cacheKey = generateCacheKey(
    'recentEpisodes',
    page.toString(),
    perPage.toString(),
    provider,
  );

  // Utilize the existing fetchFromProxy function to handle the request and caching logic
  return fetchFromProxy(url, createCache('RecentEpisodes'), cacheKey);
}
