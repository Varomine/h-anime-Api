import htmlContent from './index.html';

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
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const fetchUrl = page > 1 ? `https://www.alpha-hen.com/page/${page}/` : 'https://www.alpha-hen.com/';
        const { series, totalPages } = await parsePage(fetchUrl);
        return new Response(JSON.stringify({ currentPage: page, totalPages, results: series }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/search') {
        const q = url.searchParams.get('q') || '';
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        if (!q) {
          return new Response(JSON.stringify({ currentPage: page, totalPages: 1, results: [] }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const searchUrl = page > 1 ? `https://www.alpha-hen.com/page/${page}/?s=${encodeURIComponent(q)}` : `https://www.alpha-hen.com/?s=${encodeURIComponent(q)}`;
        const { series, totalPages } = await parsePage(searchUrl);
        return new Response(JSON.stringify({ currentPage: page, totalPages, results: series }), {
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

      if (path === '/api/filters') {
        const options = await parseFilterOptions();
        return new Response(JSON.stringify(options), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/filter') {
        const genres = url.searchParams.getAll('genres');
        const years = url.searchParams.getAll('years');
        const status = url.searchParams.getAll('status');
        const sort = url.searchParams.get('sort') || 'latest';
        const page = parseInt(url.searchParams.get('page') || '1', 10);

        const cleanParam = (paramArray) => {
          const cleaned = [];
          for (const val of paramArray) {
            if (val.includes(',')) {
              cleaned.push(...val.split(',').map(s => s.trim()).filter(Boolean));
            } else if (val.trim()) {
              cleaned.push(val.trim());
            }
          }
          return cleaned;
        };

        const categoryList = cleanParam(genres);
        const yearsList = cleanParam(years);
        const airList = cleanParam(status);

        const queryParts = [];
        queryParts.push(`q=${encodeURIComponent('')}`);
        queryParts.push(`sort=${encodeURIComponent(sort)}`);

        for (const cat of categoryList) {
          queryParts.push(`category%5B%5D=${encodeURIComponent(cat)}`);
        }
        for (const yr of yearsList) {
          queryParts.push(`years%5B%5D=${encodeURIComponent(yr)}`);
        }
        for (const st of airList) {
          queryParts.push(`air%5B%5D=${encodeURIComponent(st)}`);
        }
        if (page > 1) {
          queryParts.push(`pages=${page}`);
        }
        const queryStr = queryParts.join('&');

        const filterUrl = `https://www.alpha-hen.com/filter/?${queryStr}`;


        const { series, totalPages } = await parsePage(filterUrl);
        return new Response(JSON.stringify({ currentPage: page, totalPages, results: series }), {
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
  try {
    let decoded = url;
    while (decoded.includes('%')) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return new URL(decoded).toString();
  } catch (e) {
    return url;
  }
}

async function parsePage(pageUrl) {
  const cleanUrl = safeQuoteUrl(pageUrl);
  const res = await fetch(cleanUrl, { headers: HEADERS });
  const html = await res.text();

  const series = [];
  const articleRegex = /<article[^>]*class="[^"]*ez-card[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let articleMatch;

  while ((articleMatch = articleRegex.exec(html)) !== null) {
    const content = articleMatch[1];

    // Find link
    const linkMatch = content.match(/<a[^>]*class="[^"]*ez-card-link[^"]*"[^>]*href="([^"]*)"/i) || content.match(/href="([^"]*)"/i);
    if (!linkMatch) continue;
    const url = linkMatch[1].trim();

    if (series.some(s => s.url === url)) continue;

    // Get thumbnail img
    const imgMatch = content.match(/<img[^>]*class="[^"]*wp-post-image[^"]*"[^>]*src="([^"]*)"/i) ||
                     content.match(/<img[^>]*src="([^"]*)"/i) ||
                     content.match(/data-src="([^"]*)"/i);
    const thumbnail = imgMatch ? imgMatch[1].trim() : '';

    // Get score
    const scoreMatch = content.match(/class="[^"]*ez-card-score[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const score = scoreMatch ? scoreMatch[1].replace(/<[^>]*>/g, '').trim() : '';

    // Get title & main tag
    const titleHeaderMatch = content.match(/<h2[^>]*class="[^"]*ez-card-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
    let title = '';
    let tag = '';
    if (titleHeaderMatch) {
      const headerContent = titleHeaderMatch[1];
      const tagMatch = headerContent.match(/<span[^>]*class="[^"]*al-ez-index-tag[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      if (tagMatch) {
        tag = tagMatch[1].replace(/<[^>]*>/g, '').trim();
        title = headerContent.replace(tagMatch[0], '').replace(/<[^>]*>/g, '').trim();
      } else {
        title = headerContent.replace(/<[^>]*>/g, '').trim();
      }
    }

    title = title.replace(/\s+/g, ' ');

    // Get metadata badges
    const epMatch = content.match(/class="[^"]*eit-bg1[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const statusMatch = content.match(/class="[^"]*eit-bg2[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const langMatch = content.match(/class="[^"]*eit-bg3[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

    const episodes = epMatch ? epMatch[1].replace(/<[^>]*>/g, '').trim() : '';
    const status = statusMatch ? statusMatch[1].replace(/<[^>]*>/g, '').trim() : '';
    const language = langMatch ? langMatch[1].replace(/<[^>]*>/g, '').trim() : '';

    series.push({
      title,
      url,
      thumbnail,
      score,
      tag,
      episodes,
      status,
      language
    });
  }

  // Parse total pages
  let totalPages = 1;
  const pageRegex = /\/page\/(\d+)\/?|[?&]pages?=(\d+)/g;
  let pageMatch;
  while ((pageMatch = pageRegex.exec(html)) !== null) {
    const p = parseInt(pageMatch[1] || pageMatch[2], 10);
    if (p > totalPages) totalPages = p;
  }


  return { series, totalPages };
}

async function parseEpisodes(seriesUrl) {
  const cleanUrl = safeQuoteUrl(seriesUrl);
  const res = await fetch(cleanUrl, { headers: HEADERS });
  const html = await res.text();

  const episodes = [];
  const epLinkRegex = /<a[^>]+href=["'](https:\/\/www\.alpha-hen\.com\/watch\/([^"'\s>]+)\/)["'][^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = epLinkRegex.exec(html)) !== null) {
    const url = match[1];
    const innerHtml = match[3];

    if (innerHtml.includes('class="ep-content"') || innerHtml.includes("class='ep-content'")) {
      const ytaMatch = innerHtml.match(/class="[^"]*y-t-a[^"]*"[^>]*>([^<]*)<\/span>/i);
      const ytbMatch = innerHtml.match(/class="[^"]*y-t-b[^"]*"[^>]*>([^<]*)<\/span>/i);
      const clockMatch = innerHtml.match(/class="[^"]*yt-clock[^"]*"[^>]*>([^<]*)<\/span>/i);

      const rawTitle = ytaMatch ? ytaMatch[1].trim() : "";
      const epText = ytbMatch ? ytbMatch[1].trim() : "";
      const duration = clockMatch ? clockMatch[1].trim() : "";

      let cleanTitle = rawTitle;
      let subDubType = "DUB";
      if (rawTitle.toUpperCase().endsWith("TH")) {
        cleanTitle = rawTitle.slice(0, -2).trim();
        subDubType = "SUB";
      } else if (/\bTH\b/i.test(rawTitle)) {
        cleanTitle = rawTitle.replace(/\bTH\b/ig, '').trim();
        subDubType = "SUB";
      }

      if (!episodes.some(ep => ep.url === url)) {
        episodes.push({
          title: cleanTitle || rawTitle || `Episode ${episodes.length + 1}`,
          url,
          episode: epText,
          duration,
          type: subDubType
        });
      }
    } else {
      let text = innerHtml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (text && !episodes.some(ep => ep.url === url)) {
        let subDubType = "DUB";
        if (text.toUpperCase().includes('TH')) {
          subDubType = "SUB";
        }
        episodes.push({
          title: text,
          url,
          episode: '',
          duration: '',
          type: subDubType
        });
      }
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

let cachedFilters = null;

async function parseFilterOptions() {
  if (cachedFilters) {
    return cachedFilters;
  }

  const fallback = {
    genres: [
      "Hentai เฮ็นไต", "Big Breasts หน้าอกใหญ่", "Blow Job การอม", "Censored เซ็นเซอร์",
      "Creampie การหลั่งใน", "Paizuri ใช้ร่องนม", "Student นักเรียน", "School Girl นักเรียนหญิง",
      "Cunnilingus ใช้ปาก", "Virginity เปิดซิง", "Hand Job ใช้มือช่วย", "Group กลุ่ม",
      "Anal ประตูหลัง", "Rape ข่มขืน", "Ahegao สีหน้าฟิน", "Masturbation การช่วยตัวเอง",
      "Stockings ถุงน่อง", "Forced ฝืนใจ", "Gangbang การข่มขืนหมู่", "Doujin โดจิน",
      "Bondage มัดด้วยเชือก", "Harem ฮาเร็ม", "Double Penetration หน้าหลังพร้อมกัน",
      "Incest ญาติ", "Yuri หญิง หญิง", "Doggy Style ท่าหมา", "Small Breasts หน้าอกเล็ก",
      "Dildo ดิลโด้", "Uncensored อันเซ็นเซอร์", "Teacher ครู", "House Wife แม่บ้าน",
      "Netorare/NTR ถูกแย่งแฟน", "Romance โรแมนติก", "Lolicon โลลิคอน", "Dark Skin ผิวเข้ม",
      "Swimsuit ชุดว่ายน้ำ", "BDSM ซาดิส", "Maid สาวใช้", "Filming ถ่ายหนัง", "Glasses แว่น",
      "Sex Toys ของเล่นผู้ใหญ่", "Lactation การหลั่งน้ำนม", "Foot Job ใช้เท้าช่วย",
      "Cheating นอกใจ", "Milf สาวรุ่นใหญ่", "Humiliation ความน่าอาย", "Tentacles หนวด",
      "Cosplay คอสเพลย์", "Garter belt เข็มขัดแขวนถุงน่อง", "Bath อาบน้ำ", "Fantasy แฟนตาซี",
      "Blindfold ผ้าปิดตา", "Triple Penetration โดน 3 ทางพร้อมกัน",
      "Shibari ใช้เชือกและแขวนคนให้ลอย", "Blackmail แบล็กเมล์", "Demons ปีศาจ",
      "Futanari เป็นผู้หญิงที่มีทั้ง 2 เพศ", "Femdom ผู้หญิงที่เป็นฝ่ายเหนือ", "Apron ผ้ากันเปื้อน",
      "Unusual Pupils ม่านตาเป็นรูปหัวใจ", "Rimjob เลียประตูหลัง", "Domination ครอบงำ",
      "Tsundere สึนเดเระ", "Bloomers ชุดกีฬาผู้หญิง", "Shota โชตะ", "Spanking การตี",
      "Pregnant ตั้งท้อง", "Bikini บิกีนี", "Huge Breasts หน้าอกใหญ่มาก", "Tan lines รอยเกรียมของผิว",
      "Chikan ลวนลามบนรถไฟ", "Exhibitionism ที่สาธารณะ", "Inflation ท้องป่อง",
      "School โรงเรียน", "Mind Break ใจสลาย", "Mind Control สะกดจิต", "Nurse พยาบาล",
      "Urination ฉี่", "Collar ปลอกคอ", "Big Ass ก้นใหญ่", "Gigantic Breasts หน้าอกใหญ่มหึมา",
      "Dilf ผู้ชายวัยทำงาน", "Fingering การใช้นิ้วมือ", "Sleeping ลักหลับ",
      "Supernatural เหนือธรรมชาติ", "Succubus ซักคิวบัส", "Bukkake ราดหน้า", "Gal สาวแกล",
      "Gag ปิดปาก", "Comedy ตลก", "Mother แม่", "BBM ชายร่างใหญ่", "Elf เอลฟ์",
      "Idol ไอดอล", "Bunny Girl สาวหูกระต่าย", "Monster Girl สาวมอนสเตอร์", "Prostitution ขายตัว",
      "Facesitting นั่งทับหน้า", "Body Writing เขียนตามร่างกาย", "Condom ถุงยาง",
      "Cheerleader เชียร์ลีดเดอร์", "Pantyhose ถุงน่องคลุม กกน.", "Bodysuit ชุดรัดรูป",
      "Impregnation ทำให้ท้อง", "Magical Girl สาวน้อยเวทมนต์", "Drama ดราม่า",
      "Office ออฟฟิศ", "Action แอคชั่น", "Tail plug หางเสียบประตูหลัง", "Monster มอนสเตอร์",
      "Nipple Fuck การอี๊บที่หัวนม", "BBW สาวร่างใหญ่", "Tomboy ทอม",
      "Crossdressing พวกที่แต่งตัวเป็นอีกเพศนึง", "Sisters พี่สาว น้องสาว", "Horror สยองขวัญ",
      "Waitress สาวเสิร์ฟ", "Deep Throat อมสุดคอหอย", "Sport กีฬา", "Sweating เหงื่อ",
      "Miko หญิงรับใช้ศาลเจ้า", "Large Insertions การสอดใส่ของขนาดใหญ่", "Fisting การใช้มือยัด",
      "Yaoi ชาย ชาย", "Gokkun กลืนน้ำกาม", "3D สามมิติ", "Big Nipples หัวนมใหญ่",
      "Cat Girl สาวหูแมว", "Nose Hook เกี่ยวจมูกเหมือนหมู", "Game เกม",
      "Breast Expansion การขยายเต้านม", "Adventure ผจญภัย", "Drugs ใช้ยา", "Slave ทาส",
      "Ponytail ผมหางม้า", "Double Vaginal ประตูหน้า 2 อันพร้อมกัน", "Twintails ทวินเทล",
      "Hair Job ใช้ผม", "Gothic lolita โกธิค โลลิต้า", "Angel นางฟ้า", "Human Pet สัตว์เลี้ยง",
      "Kissing การจูบ", "Mystery ความลึกลับ", "Birth การคลอด", "Milking การรีดนม",
      "Piercing เจาะร่างกาย", "Gender Bender แนวเปลี่ยนเพศ", "Twins ฝาแฝด",
      "Schoolgirl Uniform ชุดนักเรียนหญิง", "Inseki ญาติสมรส", "Drunk เมา", "House บ้าน",
      "Ghost ผี", "Martial Arts ศิลปะการต่อสู้", "Transformation การเปลี่ยนร่าง",
      "Armpit Sex รักแร้", "Tiara รัดเกล้า", "Tall Girl ผู้หญิงตัวสูง", "Vampires แวมไพร์",
      "Urethra Insertion การสอดใส่ท่อปัสสาวะ", "Super Power พลังพิเศษ",
      "Latex ชุดยางรัดรูป", "Hairy ขน", "Snuff เนื้อเรื่องโหดร้ายมาก",
      "School Swimsuit ชุดว่ายน้ำของโรงเรียน", "Bestiality สมสู่กับสัตว์", "Wings ปีก",
      "Family ครอบครัว", "Widow แม่หม้าย", "Sci-Fi ไซไฟ", "Kimono กิโมโน",
      "Historical ประวัติศาสตร์", "Kunoichi นินจาหญิง", "Daughter ลูกสาว",
      "Thigh High Boots รองเท้าบูทยาว ส้นสูง", "Mature เป็นผู้ใหญ่", "Leotard ชุดแนบเนื้อ",
      "Double Anal ประตูหลัง 2 อันพร้อมกัน", "Horns เขา", "Prison คุก", "Oni โอนิ",
      "Guro ระทึกขวัญ", "Corset ชุดคอร์เซ็ท", "FFM Threesome หญิง หญิง ชาย",
      "Mecha หุ่นยนต์", "Public Use ของใช้สาธารณะ", "Witch แม่มด",
      "Shimapan กางเกงในลายทาง", "Hot Pants กางเกงขาสั้น", "Doctor หมอ",
      "Hairy Armpits ขนรักแร้", "Giantess คนที่มีขนาดยักษ์", "Males Only ผู้ชายเท่านั้น",
      "Lingerie ชุดชั้นใน", "Eyepatch ผ้าปิดตาข้างเดียว", "Vaginal Sticker พลาสเตอร์ปิดโยนี",
      "Business suit ชุดทำงาน", "Emotionless Sex หน้าตายไร้อารมณ์"
    ],
    years: [
      "2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018", "2017",
      "2016", "2015", "2014", "2013", "2012", "2011", "2010", "2009", "2008", "2007",
      "2006", "2005", "2004", "2003", "2002", "2001", "2000", "1999", "1998", "1997"
    ],
    status: ["จบแล้ว", "ยังไม่จบ"],
    sort: ["latest", "title"]
  };

  try {
    const res = await fetch("https://www.alpha-hen.com/filter/", { headers: HEADERS });
    if (!res.ok) {
      cachedFilters = fallback;
      return fallback;
    }
    const html = await res.text();

    const genres = [];
    const years = [];
    const status = [];

    const inputRegex = /<input([^>]+)>/g;
    let match;
    while ((match = inputRegex.exec(html)) !== null) {
      const attrs = match[1];
      const nameMatch = attrs.match(/name=["']([^"']+)["']/);
      const valueMatch = attrs.match(/value=["']([^"']+)["']/);
      if (nameMatch && valueMatch) {
        const name = nameMatch[1];
        const value = valueMatch[1];
        const decodedValue = value.replace(/&amp;/g, '&')
                                  .replace(/&quot;/g, '"')
                                  .replace(/&#039;/g, "'")
                                  .replace(/&lt;/g, '<')
                                  .replace(/&gt;/g, '>');
        if (name === 'category[]') {
          genres.push(decodedValue);
        } else if (name === 'years[]') {
          years.push(decodedValue);
        } else if (name === 'air[]') {
          status.push(decodedValue);
        }
      }
    }

    const result = {
      genres: genres.length > 0 ? genres : fallback.genres,
      years: years.length > 0 ? years : fallback.years,
      status: status.length > 0 ? status : fallback.status,
      sort: ["latest", "title"]
    };
    cachedFilters = result;
    return result;
  } catch (e) {
    cachedFilters = fallback;
    return fallback;
  }
}

function getIndexHtml() {
  return htmlContent;
}

