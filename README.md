# Alpha-Hen API & Stream Player (Cloudflare Worker)

A high-performance WordPress scraper, HLS stream proxy, and premium player dashboard for alpha-hen.com, hosted entirely on Cloudflare Workers.

## Features
- **Upcoming Anime Schedule**: Scrape monthly release schedules directly from the site (`/api/schedule`) and view upcoming release dates/episodes in a dedicated UI tab.
- **Combined Search & Advanced Filters**: Run text queries alongside multiple filters (`genres`, `years`, `status`, `sort`) in a single aggregated search route (`/api/search`).
- **Resolve Speed Optimization**: Stream links resolution (`/api/resolve`) has been optimized to bypass redundant manifest network calls and is cached at the CDN Edge for 1 hour.
- **Root Stream Dashboard**: Access a premium dark-themed HLS streaming player served directly on the root endpoint (`/`).
- **Consolidated Pagination**: Retrieve latest series with query parameter offsets (`/api/latest?page=3`).
- **Card Metadata Splits**: Returns clean separated fields (`title`, `score`, `tag`, `episodes`, `status`, `language`) for all list items.
- **Episode Metadata Splits**: Resolves list elements into clean structured keys (`title`, `episode`, `duration`, `type` [SUB/DUB]).
- **Smart HLS Referer Proxy**: Rewrites and pipes Master playlists (`flower.txt`) and Quality segments (`.ts` files) dynamically to bypass origin referer blocks.

---

## Deployment

To deploy this project to your own Cloudflare account:

1. Install dependencies:
   ```bash
   npm install
   ```
2. Log into your Cloudflare account via wrangler:
   ```bash
   npx wrangler login
   ```
3. Deploy:
   ```bash
   npm run deploy
   ```

---

## API Reference

### 1. Get Latest Series (Paginated)
Fetches recent release cards from the main list.
- **Endpoint**: `GET /api/latest`
- **Query Parameters**:
  - `page` (optional, default: `1`): The page number.
- **Example**: `GET /api/latest?page=2`

### 2. Search & Filter Series (Paginated)
Queries the website's index. Supports combining keyword search with multiple filters.
- **Endpoint**: `GET /api/search`
- **Query Parameters**:
  - `q` (optional): Search query keyword.
  - `genres` (optional): Filter by genre(s). Can be multiple parameters or comma-separated.
  - `years` (optional): Filter by release year(s). Can be multiple parameters or comma-separated.
  - `status` (optional): Filter by airing status (`จบแล้ว` or `ยังไม่จบ`).
  - `sort` (optional, default: `latest`): Sorting order (`latest` or `title`).
  - `page` (optional, default: `1`): The search results page.
- **Example**: `GET /api/search?q=Suki&genres=Uncensored อันเซ็นเซอร์&page=1`

### 3. Get Upcoming Anime Update Schedule
Fetches upcoming anime releases grouped by month.
- **Endpoint**: `GET /api/schedule`
- **Query Parameters**: None
- **Example**: `GET /api/schedule`

### 4. Get Episodes Metadata
Resolves the watchable episode list for a series page.
- **Endpoint**: `GET /api/episodes`
- **Query Parameters**:
  - `url` (required): Absolute URL of the series page.
- **Example**: `GET /api/episodes?url=https://www.alpha-hen.com/ookii-onnanoko-wa-suki-desu-ka/`

### 5. Resolve Stream Links (CDN Cached)
Extracts final streaming qualities (manifest URLs) and the required referer header for an episode. Responses are cached at the CDN Edge for 1 hour.
- **Endpoint**: `GET /api/resolve`
- **Query Parameters**:
  - `url` (required): Absolute watch page URL.
- **Example**: `GET /api/resolve?url=https://www.alpha-hen.com/watch/ookii-onnanoko-wa-suki-desu-ka-th-ตอนที่-01/`

### 6. Get Available Filter Values
Returns genres, years, and statuses list for dropdown rendering.
- **Endpoint**: `GET /api/filters`
- **Query Parameters**: None
- **Example**: `GET /api/filters`

### 7. Stream Proxy Router (Master & Segments)
Bypasses HTTP referer restrictions for playback.
- **Master Playlist**: `GET /proxy/master.m3u8?url=[flower.txt_url]&referer=[referer]`
- **TS Segment**: `GET /proxy/segment?url=[segment_ts_url]&referer=[referer]`
- **Example direct play URL**:
  ```
  https://alpha-hen-worker.sapis.workers.dev/proxy/master.m3u8?url=https://qqhls1.stream-aph.xyz/media/qHUM4FSbcMO0EWk/1080p.m3u8&referer=https://qqstream.stream-aph.xyz/
  ```
