const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Enable CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/') {
        return new Response(getIndexHtml(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
        });
      }

      if (path === '/api/latest') {
        const { series, totalPages } = await parsePage('https://www.alpha-hen.com/');
        return new Response(JSON.stringify({ currentPage: 1, totalPages, results: series }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/page') {
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const fetchUrl = page > 1 ? `https://www.alpha-hen.com/page/${page}/` : 'https://www.alpha-hen.com/';
        const { series, totalPages } = await parsePage(fetchUrl);
        return new Response(JSON.stringify({ currentPage: page, totalPages, results: series }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/search') {
        const q = url.searchParams.get('q') || '';
        if (!q) {
          return new Response(JSON.stringify({ results: [] }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const searchUrl = `https://www.alpha-hen.com/wp-json/alphahen/v1/search?q=${encodeURIComponent(q)}`;
        const res = await fetch(searchUrl, { headers: HEADERS });
        const data = await res.json();
        
        const formatted = (data.results || []).map(item => ({
          title: item.title || '',
          url: item.url || '',
          thumbnail: item.thumb || '',
          info: `Episodes: ${item.ep || '?'} | Score: ${item.score || '?'}`
        }));

        return new Response(JSON.stringify({ results: formatted }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/episodes') {
        const seriesUrl = url.searchParams.get('url') || '';
        if (!seriesUrl) {
          return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const episodes = await parseEpisodes(seriesUrl);
        return new Response(JSON.stringify({ episodes }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/resolve') {
        const epUrl = url.searchParams.get('url') || '';
        if (!epUrl) {
          return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const qualities = await resolveStreamLinks(epUrl);
        if (!qualities) {
          return new Response(JSON.stringify({ error: 'Could not resolve stream links' }), {
            status: 404,
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify({ qualities }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // HLS Playlist Proxy (Smart Master and Quality Playlist router)
      if (path === '/proxy/master.m3u8') {
        const targetUrl = url.searchParams.get('url') || '';
        const referer = url.searchParams.get('referer') || '';
        if (!targetUrl || !referer) {
          return new Response('Missing parameters', { status: 400, headers: corsHeaders });
        }

        const res = await fetch(targetUrl, {
          headers: { ...HEADERS, Referer: referer },
        });
        if (!res.ok) return new Response('Proxy request failed', { status: res.status, headers: corsHeaders });
        
        const manifest = await res.text();
        const lines = manifest.split('\n');
        const rewritten = [];
        
        const isQualityPlaylist = manifest.includes('#EXTINF');

        for (let line of lines) {
          line = line.trim();
          if (line && !line.startsWith('#')) {
            // Resolve relative path to absolute URL
            const absUrl = new URL(line, targetUrl).toString();
            let proxyUrl = '';
            if (isQualityPlaylist) {
              // Redirect TS chunks to local proxy segment endpoint
              proxyUrl = `${url.origin}/proxy/segment?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
            } else {
              // Recursive proxy for HLS sub-playlists
              proxyUrl = `${url.origin}/proxy/master.m3u8?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
            }
            rewritten.push(proxyUrl);
          } else {
            rewritten.push(line);
          }
        }

        return new Response(rewritten.join('\n'), {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            ...corsHeaders,
          },
        });
      }

      // Segment Proxy (streams TS chunks with Referer)
      if (path === '/proxy/segment') {
        const targetUrl = url.searchParams.get('url') || '';
        const referer = url.searchParams.get('referer') || '';
        if (!targetUrl || !referer) {
          return new Response('Missing parameters', { status: 400, headers: corsHeaders });
        }

        const res = await fetch(targetUrl, {
          headers: { ...HEADERS, Referer: referer },
        });
        if (!res.ok) return new Response('Proxy segment failed', { status: res.status, headers: corsHeaders });

        // Pipe/stream response directly back to player
        return new Response(res.body, {
          headers: {
            'Content-Type': 'video/MP2T',
            ...corsHeaders,
          },
        });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};

// --- SCRAPER HELPER FUNCTIONS ---

function safeQuoteUrl(url) {
  if (!url) return url;
  const decoded = decodeURIComponent(url);
  const parsed = new URL(decoded);
  parsed.pathname = parsed.pathname.split('/').map(p => encodeURIComponent(p)).join('/');
  return parsed.toString();
}

async function parsePage(pageUrl) {
  const cleanUrl = safeQuoteUrl(pageUrl);
  const res = await fetch(cleanUrl, { headers: HEADERS });
  const html = await res.text();

  const series = [];
  // Regex to extract main series links on the page
  const regex = /<a[^>]+href=["'](https:\/\/www\.alpha-hen\.com\/([^"'/]+)\/)["'][^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = match[1];
    const slug = decodeURIComponent(match[2]);
    const title = match[3].replace(/<[^>]*>/g, '').trim();

    const excluded = ['filter', 'contact', 'dmca', 'lang', 'category', 'tag', 'watch', 'page', 'years', 'air', 'studio', 'letter', 'หมวดหมู่ทั้งหมด', 'ตารางอัพเดทอนิเมะ'];
    if (title && !excluded.includes(slug) && !series.some(s => s.url === url)) {
      series.push({
        title: title.replace(/\s+/g, ' '),
        url: url
      });
    }
  }

  // Parse total pages
  let totalPages = 1;
  const pageRegex = /\/page\/(\d+)\/?/g;
  let pageMatch;
  while ((pageMatch = pageRegex.exec(html)) !== null) {
    const p = parseInt(pageMatch[1], 10);
    if (p > totalPages) totalPages = p;
  }

  return { series, totalPages };
}

async function parseEpisodes(seriesUrl) {
  const cleanUrl = safeQuoteUrl(seriesUrl);
  const res = await fetch(cleanUrl, { headers: HEADERS });
  const html = await res.text();

  const episodes = [];
  const regex = /<a[^>]+href=["'](https:\/\/www\.alpha-hen\.com\/watch\/([^"'\s>]+)\/)["'][^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = match[1];
    const title = match[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!episodes.some(ep => ep.url === url)) {
      episodes.push({ title: title || `Episode ${episodes.length + 1}`, url });
    }
  }
  return episodes;
}

async function resolveStreamLinks(episodeUrl) {
  const cleanUrl = safeQuoteUrl(episodeUrl);
  
  // Step 1: Get watch page
  const res1 = await fetch(cleanUrl, { headers: HEADERS });
  const html1 = await res1.text();

  // Find local watch video iframe
  const iframeRegex = /iframe[^>]+src=["'](https?:\/\/[^"']+\/watch_video\/[^"']+)["']/i;
  const iframeMatch = html1.match(iframeRegex);
  if (!iframeMatch) return null;
  const iframeSrc = iframeMatch[1];

  // Step 2: Fetch watch video iframe, passing watch page as Referer
  const res2 = await fetch(safeQuoteUrl(iframeSrc), {
    headers: { ...HEADERS, Referer: cleanUrl }
  });
  const html2 = await res2.text();

  // Parse redirect target in JavaScript
  const redirectRegex = /location\.replace\s*\(\s*["'](https?:\/\/[^"']+)["']\s*\)/i;
  const redirMatch = html2.match(redirectRegex) || html2.match(/window\.location\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  if (!redirMatch) return null;
  const redirectUrl = redirMatch[1];

  // Step 3: Fetch external player page, passing alpha-hen.com as Referer
  const res3 = await fetch(safeQuoteUrl(redirectUrl), {
    headers: { ...HEADERS, Referer: 'https://www.alpha-hen.com/' }
  });
  const html3 = await res3.text();

  // Find master HLS manifest link (flower.txt or m3u8)
  const hlsRegex = /["']file["']\s*:\s*["'](https?:\/\/[^"'\s]+flower\.txt[^"'\s]*)["']/i;
  let hlsMatch = html3.match(hlsRegex) || html3.match(/(https?:\/\/[^\s'"<>\\]+\/(?:flower\.txt|\w+\.m3u8))/i);
  if (!hlsMatch) return null;
  const masterManifestUrl = hlsMatch[1];

  // Step 4: Fetch master manifest (flower.txt) with player page as Referer
  const playerDomain = new URL(redirectUrl).hostname;
  const manifestReferer = `https://${playerDomain}/`;

  const res4 = await fetch(safeQuoteUrl(masterManifestUrl), {
    headers: { ...HEADERS, Referer: manifestReferer }
  });
  const manifestContent = await res4.text();

  // Parse manifest qualities
  const lines = manifestContent.split('\n');
  const qualities = {};
  let currentResolution = '';

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      if (resMatch) currentResolution = resMatch[1];
    } else if (line && !line.startsWith('#')) {
      const absUrl = new URL(line, masterManifestUrl).toString();
      let label = 'unknown';
      if (line.includes('1080') || (currentResolution && currentResolution.includes('1080'))) {
        label = '1080p';
      } else if (line.includes('720') || (currentResolution && currentResolution.includes('720'))) {
        label = '720p';
      } else if (line.includes('360') || (currentResolution && currentResolution.includes('360'))) {
        label = '360p';
      } else if (currentResolution) {
        label = currentResolution.split('x')[1] + 'p';
      } else {
        label = line.split('.')[0];
      }

      qualities[label] = {
        url: absUrl,
        resolution: currentResolution || 'Unknown',
        referer: manifestReferer
      };
      currentResolution = '';
    }
  }

  return qualities;
}

// Serves the beautifulOutfit/Inter dark-mode HTML player/docs interface
function getIndexHtml() {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Alpha-Hen Premium Dashboard & HLS Player</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css" />
      <style>
          :root {
              --bg-main: #0a0a0f;
              --bg-card: #13131f;
              --bg-glass: rgba(19, 19, 31, 0.7);
              --border-color: rgba(255, 255, 255, 0.08);
              --text-primary: #f0f0f5;
              --text-secondary: #a0a0b8;
              --accent-pink: #ff2e93;
              --accent-orange: #ff8a00;
              --accent-purple: #9000ff;
              --accent-green: #00ffaa;
              --gradient-primary: linear-gradient(135deg, var(--accent-pink), var(--accent-orange));
              --gradient-glow: linear-gradient(135deg, rgba(255, 46, 147, 0.3), rgba(255, 138, 0, 0.3));
              --font-display: 'Outfit', sans-serif;
              --font-body: 'Inter', sans-serif;
              --font-code: 'Fira Code', monospace;
          }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background-color: var(--bg-main); color: var(--text-primary); font-family: var(--font-body); line-height: 1.6; overflow-x: hidden; }
          header { background: linear-gradient(180deg, rgba(10, 10, 15, 1) 0%, rgba(10, 10, 15, 0) 100%); padding: 30px 5% 15px 5%; display: flex; flex-direction: column; align-items: center; gap: 20px; border-bottom: 1px solid var(--border-color); }
          .logo { font-family: var(--font-display); font-weight: 800; font-size: 2.5rem; background: var(--gradient-primary); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-shadow: 0px 4px 15px rgba(255, 46, 147, 0.2); letter-spacing: -1px; }
          .search-container { display: flex; width: 100%; max-width: 600px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 50px; padding: 5px 5px 5px 25px; align-items: center; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); }
          .search-container:focus-within { border-color: var(--accent-pink); box-shadow: 0 0 20px rgba(255, 46, 147, 0.2); transform: scale(1.02); }
          .search-input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-size: 1rem; font-family: var(--font-body); }
          .search-btn { background: var(--gradient-primary); border: none; outline: none; color: #fff; font-family: var(--font-display); font-weight: 600; padding: 12px 28px; border-radius: 50px; cursor: pointer; transition: all 0.2s; }
          .search-btn:hover { transform: translateY(-1px); box-shadow: 0 5px 15px rgba(255, 46, 147, 0.4); }
          .tabs-nav { display: flex; gap: 15px; margin-top: 10px; }
          .tab-btn { background: transparent; border: 1px solid transparent; border-radius: 30px; padding: 10px 24px; color: var(--text-secondary); font-family: var(--font-display); font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: all 0.25s; }
          .tab-btn:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.04); }
          .tab-btn.active { background: rgba(255, 46, 147, 0.1); color: var(--accent-pink); border-color: rgba(255, 46, 147, 0.3); }
          main { max-width: 1400px; margin: 0 auto; padding: 40px 5%; }
          .section-title { font-family: var(--font-display); font-size: 1.8rem; margin-bottom: 30px; display: flex; align-items: center; gap: 12px; font-weight: 700; }
          .section-title::before { content: ''; display: inline-block; width: 6px; height: 24px; background: var(--gradient-primary); border-radius: 3px; }
          .player-section { display: none; margin-bottom: 50px; background: var(--bg-card); border-radius: 20px; border: 1px solid var(--border-color); padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); animation: slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
          .player-container { position: relative; width: 100%; border-radius: 12px; overflow: hidden; background: #000; }
          .player-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
          .player-title { font-family: var(--font-display); font-size: 1.3rem; font-weight: 600; }
          .close-player-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); border-radius: 50%; width: 36px; height: 36px; color: var(--text-primary); font-size: 1.2rem; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
          .close-player-btn:hover { background: rgba(255, 46, 147, 0.2); border-color: var(--accent-pink); color: var(--accent-pink); }
          .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 30px; margin-bottom: 40px; }
          .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 16px; overflow: hidden; cursor: pointer; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column; position: relative; }
          .card:hover { transform: translateY(-8px) scale(1.02); border-color: rgba(255, 46, 147, 0.4); box-shadow: 0 15px 35px rgba(0, 0, 0, 0.4), 0 0 25px rgba(255, 46, 147, 0.1); }
          .card-img-container { width: 100%; aspect-ratio: 16/10; background: linear-gradient(135deg, #131326, #0e0e14); position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
          .card-img-placeholder { font-family: var(--font-display); font-size: 2.5rem; background: var(--gradient-primary); -webkit-background-clip: text; -webkit-text-fill-color: transparent; opacity: 0.25; }
          .card-img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.5s; }
          .card:hover .card-img { transform: scale(1.08); }
          .card-content { padding: 20px; display: flex; flex-direction: column; flex: 1; }
          .card-title { font-family: var(--font-display); font-weight: 600; font-size: 1.1rem; margin-bottom: 10px; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; }
          .card-meta { margin-top: auto; font-size: 0.85rem; color: var(--text-secondary); display: flex; justify-content: space-between; align-items: center; }
          .card-badge { background: rgba(255, 46, 147, 0.12); color: var(--accent-pink); padding: 4px 10px; border-radius: 20px; font-weight: 500; font-size: 0.75rem; border: 1px solid rgba(255, 46, 147, 0.2); }
          .episodes-section { display: none; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 20px; padding: 30px; margin-bottom: 40px; animation: slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
          .episodes-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 1px solid var(--border-color); padding-bottom: 15px; }
          .ep_list { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 15px; }
          .ep-btn { background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 15px; color: var(--text-primary); font-family: var(--font-display); font-weight: 500; font-size: 0.95rem; text-align: center; cursor: pointer; transition: all 0.2s; }
          .ep-btn:hover { background: var(--gradient-primary); border-color: transparent; transform: translateY(-2px); box-shadow: 0 5px 15px rgba(255, 46, 147, 0.3); }
          .pagination { display: flex; justify-content: center; align-items: center; gap: 20px; margin-top: 40px; }
          .page-btn { background: var(--bg-card); border: 1px solid var(--border-color); color: var(--text-primary); padding: 12px 25px; border-radius: 30px; font-family: var(--font-display); font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
          .page-btn:hover:not(:disabled) { border-color: var(--accent-pink); color: var(--accent-pink); background: rgba(255, 46, 147, 0.05); }
          .page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
          .page-info { font-family: var(--font-display); font-weight: 500; color: var(--text-secondary); }
          .loader { display: none; justify-content: center; align-items: center; margin: 50px 0; }
          .spinner { width: 50px; height: 50px; border: 3px solid rgba(255, 46, 147, 0.1); border-radius: 50%; border-top-color: var(--accent-pink); animation: spin 0.8s linear infinite; }
          .docs-container { display: none; animation: slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
          .doc-card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 20px; padding: 30px; margin-bottom: 30px; }
          .doc-endpoint { display: flex; align-items: center; gap: 15px; margin-bottom: 15px; flex-wrap: wrap; }
          .method-badge { font-family: var(--font-display); font-weight: 800; font-size: 0.85rem; padding: 6px 14px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
          .method-badge.get { background: rgba(0, 255, 170, 0.12); color: var(--accent-green); border: 1px solid rgba(0, 255, 170, 0.25); }
          .endpoint-path { font-family: var(--font-code); font-size: 1.2rem; color: var(--text-primary); font-weight: 500; }
          .doc-desc { color: var(--text-secondary); font-size: 0.95rem; margin-bottom: 20px; border-left: 3px solid var(--accent-pink); padding-left: 12px; }
          .doc-card-body { display: grid; grid-template-columns: 1.2fr 1fr; gap: 40px; }
          @media (max-width: 1024px) { .doc-card-body { grid-template-columns: 1fr; gap: 20px; } }
          .doc-left { display: flex; flex-direction: column; justify-content: flex-start; }
          .doc-right { display: flex; flex-direction: column; }
          .ex-header { font-family: var(--font-display); font-weight: 600; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
          .ex-header::before { content: ''; display: inline-block; width: 6px; height: 6px; background-color: var(--accent-green); border-radius: 50%; box-shadow: 0 0 8px var(--accent-green); }
          .params-title { font-family: var(--font-display); font-weight: 600; color: var(--text-primary); font-size: 0.95rem; margin-bottom: 10px; }
          .params-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          .params-table th, .params-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid var(--border-color); }
          .params-table th { font-family: var(--font-display); font-weight: 600; color: var(--text-secondary); font-size: 0.8rem; text-transform: uppercase; }
          .params-table td { font-size: 0.9rem; }
          .param-name { font-family: var(--font-code); color: var(--accent-pink); }
          .param-type { font-family: var(--font-code); color: var(--accent-purple); font-size: 0.8rem; }
          .code-block { background: #060609; border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; overflow-x: auto; font-family: var(--font-code); font-size: 0.85rem; color: #e0e0e0; line-height: 1.5; flex: 1; }
          .json-key { color: var(--accent-pink); }
          .json-string { color: var(--accent-orange); }
          .json-number { color: var(--accent-green); }
          .json-boolean { color: var(--accent-purple); }
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
          @media (max-width: 768px) { header { padding: 20px 5%; } .logo { font-size: 2rem; } .grid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); } }
      </style>
  </head>
  <body>
      <header>
          <div class="logo">ALPHA-HEN STREAM & API</div>
          <div class="tabs-nav">
              <button class="tab-btn active" id="btnPlayerTab" onclick="switchTab('player')">Stream Player</button>
              <button class="tab-btn" id="btnDocsTab" onclick="switchTab('docs')">API Documentation</button>
          </div>
          <div class="search-container" id="headerSearchBox">
              <input type="text" class="search-input" placeholder="Search Hentai / H-Anime..." id="searchInput">
              <button class="search-btn" onclick="performSearch()">Search</button>
          </div>
      </header>
      <main>
          <!-- ================= PLAYER TAB CONTENT ================= -->
          <div id="playerTabContent">
              <section class="player-section" id="playerSection">
                  <div class="player-header">
                      <div class="player-title" id="playerTitle">Episode Title</div>
                      <button class="close-player-btn" onclick="closePlayer()">&times;</button>
                  </div>
                  <div class="player-container">
                      <video id="videoPlayer" controls crossorigin playsinline></video>
                  </div>
              </section>
              <section class="episodes-section" id="episodesSection">
                  <div class="episodes-header">
                      <div class="section-title" id="episodesTitle">Episodes</div>
                      <button class="close-player-btn" onclick="document.getElementById('episodesSection').style.display='none'">&times;</button>
                  </div>
                  <div class="ep_list" id="episodesList"></div>
              </section>
              <section>
                  <div class="section-title" id="gridTitle">Latest H-Anime</div>
                  <div class="loader" id="loader"><div class="spinner"></div></div>
                  <div class="grid" id="seriesGrid"></div>
                  <div class="pagination" id="paginationControls">
                      <button class="page-btn" id="prevBtn" onclick="changePage(-1)">&larr; Prev</button>
                      <span class="page-info" id="pageInfo">Page 1 of 1</span>
                      <button class="page-btn" id="nextBtn" onclick="changePage(1)">Next &rarr;</button>
                  </div>
              </section>
          </div>
          <!-- ================= API DOCS TAB CONTENT ================= -->
          <div id="docsTabContent" class="docs-container">
              <div class="section-title">Developer Reference</div>
              <!-- Latest Endpoint -->
              <div class="doc-card">
                  <div class="doc-endpoint">
                      <span class="method-badge get">GET</span>
                      <span class="endpoint-path">/api/latest</span>
                  </div>
                  <div class="doc-desc">Fetch the list of latest releases from the main page.</div>
                  <div class="doc-card-body">
                      <div class="doc-left"><div class="params-title">No parameters required.</div></div>
                      <div class="doc-right">
                          <div class="ex-header">Example Response</div>
                          <div class="code-block">
{
<span class="json-key">"currentPage"</span>: 1,
<span class="json-key">"totalPages"</span>: 51,
<span class="json-key">"results"</span>: [
  {
    <span class="json-key">"title"</span>: <span class="json-string">"Ookii Onnanoko wa Suki desu ka? 8/12"</span>,
    <span class="json-key">"url"</span>: <span class="json-string">"https://www.alpha-hen.com/ookii-onnanoko-wa-suki-desu-ka/"</span>
  }
]
}
                          </div>
                      </div>
                  </div>
              </div>
              <!-- Page Endpoint -->
              <div class="doc-card">
                  <div class="doc-endpoint">
                      <span class="method-badge get">GET</span>
                      <span class="endpoint-path">/api/page</span>
                  </div>
                  <div class="doc-desc">Fetch paginated series releases.</div>
                  <div class="doc-card-body">
                      <div class="doc-left">
                          <div class="params-title">Query Parameters</div>
                          <table class="params-table">
                              <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
                              <tbody><tr><td class="param-name">page</td><td class="param-type">integer</td><td>No (default: 1)</td><td>The page offset to load</td></tr></tbody>
                          </table>
                      </div>
                      <div class="doc-right">
                          <div class="ex-header">Example Response</div>
                          <div class="code-block">
{
<span class="json-key">"currentPage"</span>: 2,
<span class="json-key">"totalPages"</span>: 51,
<span class="json-key">"results"</span>: [...]
}
                          </div>
                      </div>
                  </div>
              </div>
              <!-- Search Endpoint -->
              <div class="doc-card">
                  <div class="doc-endpoint">
                      <span class="method-badge get">GET</span>
                      <span class="endpoint-path">/api/search</span>
                  </div>
                  <div class="doc-desc">Query and search the database for specific H-Anime.</div>
                  <div class="doc-card-body">
                      <div class="doc-left">
                          <div class="params-title">Query Parameters</div>
                          <table class="params-table">
                              <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
                              <tbody><tr><td class="param-name">q</td><td class="param-type">string</td><td>Yes</td><td>Search query string (e.g. "ookii")</td></tr></tbody>
                          </table>
                      </div>
                      <div class="doc-right">
                          <div class="ex-header">Example Response</div>
                          <div class="code-block">
{
<span class="json-key">"results"</span>: [
  {
    <span class="json-key">"title"</span>: <span class="json-string">"Ookii Onnanoko wa Suki desu ka?"</span>,
    <span class="json-key">"url"</span>: <span class="json-string">"https://www.alpha-hen.com/ookii-onnanoko-wa-suki-desu-ka/"</span>,
    <span class="json-key">"thumbnail"</span>: <span class="json-string">"https://www.alpha-hen.com/wp-content/uploads/2026/04/325424-150x150.jpg"</span>,
    <span class="json-key">"info"</span>: <span class="json-string">"Episodes: 8/12 | Score: 6.45"</span>
  }
]
}
                          </div>
                      </div>
                  </div>
              </div>
              <!-- Episodes Endpoint -->
              <div class="doc-card">
                  <div class="doc-endpoint">
                      <span class="method-badge get">GET</span>
                      <span class="endpoint-path">/api/episodes</span>
                  </div>
                  <div class="doc-desc">Extract all watchable episodes from a series page.</div>
                  <div class="doc-card-body">
                      <div class="doc-left">
                          <div class="params-title">Query Parameters</div>
                          <table class="params-table">
                              <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
                              <tbody><tr><td class="param-name">url</td><td class="param-type">string</td><td>Yes</td><td>Absolute URL of the series page</td></tr></tbody>
                          </table>
                      </div>
                      <div class="doc-right">
                          <div class="ex-header">Example Response</div>
                          <div class="code-block">
{
<span class="json-key">"episodes"</span>: [
  {
    <span class="json-key">"title"</span>: <span class="json-string">"Ookii Onnanoko wa Suki desu ka TH ตอนที่ 01"</span>,
    <span class="json-key">"url"</span>: <span class="json-string">"https://www.alpha-hen.com/watch/ookii-onnanoko-wa-suki-desu-ka-th-ตอนที่-01/"</span>
  }
]
}
                          </div>
                      </div>
                  </div>
              </div>
              <!-- Resolve Endpoint -->
              <div class="doc-card">
                  <div class="doc-endpoint">
                      <span class="method-badge get">GET</span>
                      <span class="endpoint-path">/api/resolve</span>
                  </div>
                  <div class="doc-desc">Resolves streaming options (HLS m3u8 manifests) for a watch page.</div>
                  <div class="doc-card-body">
                      <div class="doc-left">
                          <div class="params-title">Query Parameters</div>
                          <table class="params-table">
                              <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
                              <tbody><tr><td class="param-name">url</td><td class="param-type">string</td><td>Yes</td><td>Absolute URL of the watch page</td></tr></tbody>
                          </table>
                      </div>
                      <div class="doc-right">
                          <div class="ex-header">Example Response</div>
                          <div class="code-block">
{
<span class="json-key">"qualities"</span>: {
  <span class="json-key">"1080p"</span>: {
    <span class="json-key">"url"</span>: <span class="json-string">"https://qqhls1.stream-aph.xyz/media/oviyznECjMP0zxv/1080p.m3u8"</span>,
    <span class="json-key">"resolution"</span>: <span class="json-string">"1920x1080"</span>,
    <span class="json-key">"referer"</span>: <span class="json-string">"https://qqstream.stream-aph.xyz/"</span>
  }
}
}
                          </div>
                      </div>
                  </div>
              </div>
              <!-- HLS Stream Proxy -->
              <div class="doc-card">
                  <div class="doc-endpoint">
                      <span class="method-badge get">GET</span>
                      <span class="endpoint-path">/proxy/master.m3u8</span>
                  </div>
                  <div class="doc-desc">Unblocked stream router. **Supports both master (.txt) and quality (.m3u8) playlists**! It automatically parses files and redirects requests locally to bypass referer filters.</div>
                  <div class="doc-card-body">
                      <div class="doc-left">
                          <div class="params-title">Query Parameters</div>
                          <table class="params-table">
                              <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
                              <tbody>
                                  <tr><td class="param-name">url</td><td class="param-type">string</td><td>Yes</td><td>Remote master (flower.txt) or quality (1080p.m3u8) URL</td></tr>
                                  <tr><td class="param-name">referer</td><td class="param-type">string</td><td>Yes</td><td>Required origin referer header</td></tr>
                              </tbody>
                          </table>
                      </div>
                      <div class="doc-right">
                          <div class="ex-header">Direct Stream Play Example (.m3u8)</div>
                          <div class="code-block" style="word-break: break-all;">
http://localhost:8000/proxy/master.m3u8?url=https://qqhls1.stream-aph.xyz/media/qHUM4FSbcMO0EWk/1080p.m3u8&referer=https://qqstream.stream-aph.xyz/
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      </main>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
      <script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.min.js"></script>
      <script>
          let currentPage = 1;
          let totalPages = 1;
          let currentView = 'latest';
          let searchQuery = '';
          let activePlayer = null;
          let hlsInstance = null;

          function switchTab(tab) {
              const btnPlayer = document.getElementById('btnPlayerTab');
              const btnDocs = document.getElementById('btnDocsTab');
              const contentPlayer = document.getElementById('playerTabContent');
              const contentDocs = document.getElementById('docsTabContent');
              const searchBox = document.getElementById('headerSearchBox');
              if (tab === 'player') {
                  btnPlayer.classList.add('active');
                  btnDocs.classList.remove('active');
                  contentPlayer.style.display = 'block';
                  contentDocs.style.display = 'none';
                  searchBox.style.display = 'flex';
              } else {
                  btnPlayer.classList.remove('active');
                  btnDocs.classList.add('active');
                  contentPlayer.style.display = 'none';
                  contentDocs.style.display = 'block';
                  searchBox.style.display = 'none';
              }
          }

          document.addEventListener('DOMContentLoaded', () => {
              loadPage(1);
              document.getElementById('searchInput').addEventListener('keypress', (e) => {
                  if (e.key === 'Enter') performSearch();
              });
          });

          function showLoader(show) {
              document.getElementById('loader').style.display = show ? 'flex' : 'none';
              document.getElementById('seriesGrid').style.display = show ? 'none' : 'grid';
          }

          async function loadPage(page) {
              showLoader(true);
              currentView = 'page';
              currentPage = page;
              try {
                  const response = await fetch(`/api/page?page=${page}`);
                  const data = await response.json();
                  totalPages = data.totalPages;
                  renderGrid(data.results);
                  updatePagination();
                  document.getElementById('gridTitle').textContent = `Browse H-Anime (Page ${page})`;
              } catch (error) {
                  console.error("Error loading page:", error);
                  alert("Failed to load content.");
              } finally {
                  showLoader(false);
              }
          }

          async function performSearch() {
              const query = document.getElementById('searchInput').value.trim();
              if (!query) { loadPage(1); return; }
              showLoader(true);
              currentView = 'search';
              searchQuery = query;
              try {
                  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
                  const data = await response.json();
                  renderGrid(data.results);
                  document.getElementById('paginationControls').style.display = 'none';
                  document.getElementById('gridTitle').textContent = `Search Results for: "${query}"`;
              } catch (error) {
                  console.error("Search failed:", error);
                  alert("Search failed.");
              } finally {
                  showLoader(false);
              }
          }

          function renderGrid(results) {
              const grid = document.getElementById('seriesGrid');
              grid.innerHTML = '';
              if (results.length === 0) {
                  grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 50px 0;">No results found.</div>';
                  return;
              }
              results.forEach(item => {
                  const card = document.createElement('div');
                  card.className = 'card';
                  card.onclick = () => showEpisodes(item.title, item.url);
                  const cleanTitle = item.title.replace(/\d+\.\d+Hentai/i, '').replace(/จบแล้ว/i, ' [End]').replace(/ยังไม่จบ/i, ' [Airing]');
                  let imgHtml = `<div class="card-img-placeholder">AH</div>`;
                  if (item.thumbnail) {
                      imgHtml = `<img src="${item.thumbnail}" class="card-img" alt="${cleanTitle}" onerror="this.style.display='none';">`;
                  }
                  card.innerHTML = `
                      <div class="card-img-container">${imgHtml}</div>
                      <div class="card-content">
                          <div class="card-title">${cleanTitle}</div>
                          <div class="card-meta">
                              <span class="card-badge">Sub Thai</span>
                              <span>${item.info || 'H-Anime'}</span>
                          </div>
                      </div>
                  `;
                  grid.appendChild(card);
              });
          }

          function updatePagination() {
              document.getElementById('paginationControls').style.display = 'flex';
              document.getElementById('prevBtn').disabled = currentPage <= 1;
              document.getElementById('nextBtn').disabled = currentPage >= totalPages;
              document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
          }

          function changePage(direction) {
              const targetPage = currentPage + direction;
              if (targetPage >= 1 && targetPage <= totalPages) {
                  loadPage(targetPage);
              }
          }

          async function showEpisodes(seriesTitle, seriesUrl) {
              document.getElementById('episodesSection').style.display = 'block';
              document.getElementById('episodesTitle').textContent = `Episodes for: ${seriesTitle}`;
              const listContainer = document.getElementById('episodesList');
              listContainer.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary);">Loading episodes...</div>';
              document.getElementById('episodesSection').scrollIntoView({ behavior: 'smooth' });
              try {
                  const response = await fetch(`/api/episodes?url=${encodeURIComponent(seriesUrl)}`);
                  const data = await response.json();
                  listContainer.innerHTML = '';
                  if (data.episodes.length === 0) {
                      listContainer.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary);">No episodes available.</div>';
                      return;
                  }
                  data.episodes.forEach(ep => {
                      const btn = document.createElement('button');
                      btn.className = 'ep-btn';
                      btn.textContent = ep.title;
                      btn.onclick = () => playEpisode(ep.title, ep.url);
                      listContainer.appendChild(btn);
                  });
              } catch (error) {
                  console.error("Failed to load episodes:", error);
                  listContainer.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: red;">Failed to load episodes.</div>';
              }
          }

          async function playEpisode(epTitle, epUrl) {
              const playerSection = document.getElementById('playerSection');
              playerSection.style.display = 'block';
              document.getElementById('playerTitle').textContent = `Playing: ${epTitle}`;
              playerSection.scrollIntoView({ behavior: 'smooth' });
              if (activePlayer) { activePlayer.destroy(); activePlayer = null; }
              if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
              const video = document.getElementById('videoPlayer');
              try {
                  const res = await fetch(`/api/resolve?url=${encodeURIComponent(epUrl)}`);
                  const data = await res.json();
                  if (!data.qualities) { alert("Could not load streaming links."); return; }
                  let selectedQualityKey = '1080p';
                  if (!data.qualities[selectedQualityKey]) {
                      selectedQualityKey = data.qualities['720p'] ? '720p' : (data.qualities['360p'] ? '360p' : Object.keys(data.qualities)[0]);
                  }
                  const qualityInfo = data.qualities[selectedQualityKey];
                  const masterManifestUrl = qualityInfo.url.substring(0, qualityInfo.url.lastIndexOf('/')) + '/flower.txt';
                  // Call our proxied master manifest
                  const proxyPlayUrl = `/proxy/master.m3u8?url=${encodeURIComponent(masterManifestUrl)}&referer=${encodeURIComponent(qualityInfo.referer)}`;
                  console.log("Loading stream proxy URL:", proxyPlayUrl);
                  if (Hls.isSupported()) {
                      hlsInstance = new Hls({ maxMaxBufferLength: 30 });
                      hlsInstance.loadSource(proxyPlayUrl);
                      hlsInstance.attachMedia(video);
                      hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
                          activePlayer = new Plyr(video, { captions: { active: true, update: true, language: 'en' } });
                          video.play();
                      });
                  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                      video.src = proxyPlayUrl;
                      activePlayer = new Plyr(video);
                      video.play();
                  } else {
                      alert("HLS playback is not supported in this browser.");
                  }
              } catch (error) {
                  console.error("Error playing video:", error);
                  alert("Error launching player.");
              }
          }

          function closePlayer() {
              if (activePlayer) { activePlayer.destroy(); activePlayer = null; }
              if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
              document.getElementById('playerSection').style.display = 'none';
          }
      </script>
  </body>
  </html>`;
}
