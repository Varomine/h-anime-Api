# Alpha-Hen API & Stream Player (Cloudflare Worker)

A high-performance WordPress scraper, HLS stream proxy, and premium player dashboard for alpha-hen.com, hosted entirely on Cloudflare Workers.

## Features
- **Consolidated Pagination**: Retrieve latest series with query parameter offsets (`/api/latest?page=3`).
- **Paginated Search Scraping**: Real website HTML search query matching (`/api/search?q=query&page=2`) supporting full pagination and retrieving all results.
- **Card Metadata Splits**: Returns clean separated fields (`title`, `score`, `tag`, `episodes`, `status`, `language`) for all list items.
- **Episode Metadata Splits**: Resolves list elements into clean structured keys (`title`, `episode`, `duration`, `type` [SUB/DUB]).
- **Smart HLS Referer Proxy**: Rewrites and pipes Master playlists (`flower.txt`) and Quality segments (`.ts` files) dynamically to bypass origin referer blocks.
- **Root Stream Dashboard**: Access a premium dark-themed HLS streaming player served directly on the root endpoint (`/`).

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
- **Response**:
  ```json
  {
    "currentPage": 2,
    "totalPages": 51,
    "results": [
      {
        "title": "Ookii Onnanoko wa Suki desu ka?",
        "url": "https://www.alpha-hen.com/ookii-onnanoko-wa-suki-desu-ka/",
        "thumbnail": "https://www.alpha-hen.com/wp-content/uploads/2026/04/325424.jpg",
        "score": "6.45",
        "tag": "Hentai",
        "episodes": "8/12",
        "status": "ยังไม่จบ",
        "language": "ซับไทย"
      }
    ]
  }
  ```

### 2. Search Series (Paginated)
Queries the website's search index.
- **Endpoint**: `GET /api/search`
- **Query Parameters**:
  - `q` (required): The search keyword.
  - `page` (optional, default: `1`): The search results page.
- **Example**: `GET /api/search?q=Ooki&page=1`
- **Response**: Same JSON payload structure as `/api/latest`.

### 3. Get Episodes Metadata
Resolves the watchable episode list for a series page.
- **Endpoint**: `GET /api/episodes`
- **Query Parameters**:
  - `url` (required): Absolute URL of the series page.
- **Example**: `GET /api/episodes?url=https://www.alpha-hen.com/ookii-onnanoko-wa-suki-desu-ka/`
- **Response**:
  ```json
  {
    "episodes": [
      {
        "title": "Ookii Onnanoko wa Suki desu ka",
        "url": "https://www.alpha-hen.com/watch/ookii-onnanoko-wa-suki-desu-ka-th-ตอนที่-01/",
        "episode": "ตอนที่ 01",
        "duration": "06:50",
        "type": "SUB"
      }
    ]
  }
  ```

### 4. Resolve Stream Links
Extracts final streaming qualities (manifest URLs) and the required referer header for an episode.
- **Endpoint**: `GET /api/resolve`
- **Query Parameters**:
  - `url` (required): Absolute watch page URL.
- **Example**: `GET /api/resolve?url=https://www.alpha-hen.com/watch/ookii-onnanoko-wa-suki-desu-ka-th-ตอนที่-01/`
- **Response**:
  ```json
  {
    "qualities": {
      "1080p": {
        "url": "https://qqhls1.stream-aph.xyz/media/qHUM4FSbcMO0EWk/1080p.m3u8",
        "resolution": "1920x1080",
        "referer": "https://qqstream.stream-aph.xyz/"
      }
    }
  }
  ```

### 5. Stream Proxy Router (Master & Segments)
Bypasses HTTP referer restrictions for playback.
- **Master Playlist**: `GET /proxy/master.m3u8?url=[flower.txt_url]&referer=[referer]`
- **TS Segment**: `GET /proxy/segment?url=[segment_ts_url]&referer=[referer]`
- **Example direct play URL**:
  ```
  https://alpha-hen-worker.your-subdomain.workers.dev/proxy/master.m3u8?url=https://qqhls1.stream-aph.xyz/media/qHUM4FSbcMO0EWk/1080p.m3u8&referer=https://qqstream.stream-aph.xyz/
  ```
