/**
 * Video Sniffer · 分层解析引擎
 * ------------------------------------------------------------------
 * 策略优先级：内置直连 → RC 全平台解析 → 自定义解析 API → Cobalt 实例 → 本地 yt-dlp 桥
 * 每一层失败都会记录到 trace 并自动降级，不因单点失效而整体失败。
 * 本文件为 ES module，仅由 background.js (service worker) 引入。
 */

export const DEFAULT_SETTINGS = {
  useBuiltin: true,
  useRcuts: true,            // 与 macOS/iOS 快捷指令同源的全平台解析通道
  rcutsConfig: 'https://i.rcuts.com/update/247',
  rcutsClient: 'ios-shortcut-247',
  useCustom: false,
  useCobalt: false,
  useYtdlp: false,
  customApi: '',                 // e.g. https://api.example.com/parse?url={url}
  customMethod: 'GET',
  customBody: '{"url":"{url}"}',
  cobaltUrl: '',                 // e.g. http://localhost:9000
  cobaltQuality: '1080',
  downloadDir: 'VideoSniffer',
  useNativeDownload: true, // 已授权本机桥接时优先用本机下载（可设完整 UA/Referer）
  quickDownload: true,   // 右键 / 快捷键解析成功后自动下载推荐画质
  autoPaste: true,        // 打开面板时自动读取剪贴板链接并解析
  historyLimit: 20,
  nativeHost: 'com.vsniffer.ytdlp'
};

export const CHANNEL_LABELS = {
  builtin: '内置直连解析',
  rcuts: 'RC 全平台解析',
  custom: '自定义解析 API',
  cobalt: 'Cobalt 实例',
  ytdlp: '本地 yt-dlp'
};

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

export function extractUrl(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const m = raw.match(/https?:\/\/[^\s<>"'\u3000\uff09\u3011\uff5d\]]+/i);
  if (!m) return '';
  return m[0].replace(/[，。、；！？,.]+$/, '');
}

async function request(url, opts = {}) {
  const { headers = {}, method = 'GET', body, timeout = 15000, ua, redirect = 'follow' } = opts;
  const h = { Accept: '*/*', ...headers };
  if (ua) h['User-Agent'] = ua; // 浏览器可能忽略该头，接口不强制依赖 UA
  const res = await fetch(url, {
    method,
    headers: h,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect,
    signal: AbortSignal.timeout(timeout)
  });
  return res;
}

async function getText(url, opts = {}) {
  const r = await request(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { text: await r.text(), finalUrl: r.url };
}

async function getJson(url, opts = {}) {
  const r = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { json: await r.json(), finalUrl: r.url };
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/&#x2F;/gi, '/');
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function extOf(url) {
  const clean = String(url).split('?')[0].toLowerCase();
  if (clean.endsWith('.m3u8')) return 'm3u8';
  if (clean.endsWith('.webm')) return 'webm';
  if (clean.endsWith('.mov')) return 'mov';
  if (clean.endsWith('.m4a') || clean.endsWith('.mp3')) return 'm4a';
  if (clean.endsWith('.flv')) return 'flv';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.png') || clean.endsWith('.webp')) return 'jpg';
  return 'mp4';
}

/** 规范化解析结果：去重、补标签、保证 formats 可用 */
function normalize(result) {
  if (!result) return null;
  const seen = new Set();
  const formats = (result.formats || [])
    .filter(f => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
    .map(f => {
      const url = f.url.replace(/&amp;/g, '&');
      if (seen.has(url)) return null;
      seen.add(url);
      return {
        label: f.label || guessLabel(url),
        url,
        ext: f.ext || extOf(url),
        headers: f.headers || [],
        cover: f.cover || '',
        note: f.note || ''
      };
    })
    .filter(Boolean);
  if (!formats.length && !(result.extras || []).length) return null;
  return {
    ok: true,
    source: result.source || 'unknown',
    sourceLabel: result.sourceLabel || result.source || '未知来源',
    title: (result.title || '').trim() || '未命名视频',
    author: result.author || '',
    cover: result.cover || '',
    pageUrl: result.pageUrl || '',
    formats,
    extras: result.extras || [],
    notes: result.notes || [],
    weak: !!result.weak,
    trace: result.trace || []
  };
}

function guessLabel(url) {
  const m = url.match(/[/_-](\d{3,4})x(\d{3,4})/);
  if (m) return `${m[1]}×${m[2]}`;
  const b = url.match(/(\d{3,5})kbps/i);
  if (b) return `${Math.round(+b[1] / 1000 * 10) / 10} Mbps`;
  if (/\.m3u8/i.test(url)) return 'HLS 流 (需 yt-dlp/ffmpeg)';
  return '默认画质';
}

/** 从任意 JSON 中递归找出看起来像视频直链的字符串 */
export function harvestMediaUrls(node, out = [], depth = 0) {
  if (!node || depth > 8 || out.length >= 40) return out;
  if (typeof node === 'string') {
    const s = unescapeHtml(node);
    if (/^https?:\/\//i.test(s) && /\.(mp4|m4v|webm|mov|m3u8|flv)(\?|$)|\/video\.twimg\.com\/|\/aweme\/v1\/play\/|\/tweet_video\//i.test(s)) {
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) harvestMediaUrls(v, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // 跳过明显的元数据字段，减少误判
      if (/^(avatar|cover|thumbnail|poster|icon|logo|qrcode)$/i.test(k)) continue;
      harvestMediaUrls(v, out, depth + 1);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 内置直连解析器                                                       */
/* ------------------------------------------------------------------ */

/** 0. 链接本身就是媒体文件 */
async function directMedia(url) {
  if (!/\.(mp4|m4v|webm|mov|m3u8|flv)(\?|$)/i.test(url)) return null;
  return {
    source: 'direct-media', sourceLabel: '直链媒体',
    title: decodeURIComponent(url.split('/').pop().split('?')[0]) || '视频',
    pageUrl: url,
    formats: [{ label: '原始文件', url, ext: extOf(url) }]
  };
}

/** 1. X / Twitter —— 走 fxTwitter 公共只读 API（无需鉴权） */
async function parseX(url) {
  const u = new URL(url);
  const idm = u.pathname.match(/(?:status|statuses)\/(\d+)/) || u.pathname.match(/\/(\d{8,})/);
  if (!idm) throw new Error('无法从链接中提取推文 ID');
  const id = idm[1];
  const user = (u.pathname.match(/^\/([^/]+)\/status\//) || [])[1] || 'i';
  const endpoints = [
    `https://api.fxtwitter.com/${user}/status/${id}`,
    `https://api.fxtwitter.com/status/${id}`,
    `https://api.vxtwitter.com/${user}/status/${id}`
  ];
  let lastErr;
  for (const ep of endpoints) {
    try {
      const { json } = await getJson(ep, { timeout: 12000 });
      const t = json.tweet;
      if (!t || json.code === 404 || t.type === 'tombstone') throw new Error('推文不可用/已删除/仅粉丝可见');
      const videos = t.media?.videos || [];
      const all = t.media?.all || [];
      const items = videos.length ? videos : all.filter(v => v.type === 'video');
      const formats = [];
      for (const v of items) {
        const variants = [...(v.variants || []), ...(v.formats || [])];
        const candidates = variants.length ? variants : [{ url: v.url }];
        for (const c of candidates) {
          const cu = c.url || c.src;
          if (!cu || !/^https?:/.test(cu)) continue;
          const dim = cu.match(/[/_-](\d{3,4})x(\d{3,4})/);
          const label = c.bitrate ? `${Math.round(c.bitrate / 1000)} kbps` :
            dim ? `${dim[1]}×${dim[2]}` :
            (c.quality || c.type || guessLabel(cu));
          formats.push({ label: `${label}${formats.length ? '' : ' · 推荐'}`, url: cu, ext: extOf(cu) });
        }
        if (!variants.length && v.url) formats.push({ label: '最高画质', url: v.url, ext: extOf(v.url), cover: v.thumbnail_url });
      }
      if (!formats.length) {
        // 兜底：d.fxtwitter.com 会 302 到最高码率 mp4
        formats.push({
          label: '最高画质 (重定向)',
          url: `https://d.fxtwitter.com/${user}/status/${id}`,
          ext: 'mp4', note: '由 fxTwitter 重定向到 CDN 直链'
        });
      }
      const photos = (t.media?.photos || []).map(p => p.url).filter(Boolean);
      return {
        source: ep.includes('vxtwitter') ? 'x-vxtwitter' : 'x-fxtwitter',
        sourceLabel: ep.includes('vxtwitter') ? 'X · vxTwitter 公共 API' : 'X · fxTwitter 公共 API',
        title: (t.text || '').replace(/\s+/g, ' ').slice(0, 80) || `X 推文 ${id}`,
        author: t.author?.screen_name ? `@${t.author.screen_name}` : '',
        cover: t.media?.photos?.[0]?.url || items[0]?.thumbnail_url || '',
        pageUrl: t.url || url,
        formats,
        extras: photos.map((p, i) => ({ type: 'image', label: `图片 ${i + 1}`, url: p })),
        notes: ['仅支持公开推文；登录/年龄限制内容需使用 yt-dlp 配合 Cookie。']
      };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`X 解析失败：${lastErr?.message || '公共 API 不可用'}`);
}

/** 2. 抖音 —— 短链跳转 + 官方分享页 _ROUTER_DATA / iteminfo 双通道 */
async function parseDouyin(url) {
  let page = url;
  let id = (url.match(/\/video\/(\d+)/) || url.match(/\/note\/(\d+)/) || url.match(/[?&]modal_id=(\d+)/) || [])[1];
  // 短链 v.douyin.com 需要跟随重定向拿真实 ID
  if (/v\.douyin\.com/i.test(url) || !id) {
    try {
      const r = await request(url, { timeout: 12000, ua: UA_MOBILE, redirect: 'follow' });
      page = r.url || url;
      id = id || (page.match(/\/video\/(\d+)/) || page.match(/\/note\/(\d+)/) || page.match(/modal_id=(\d+)/) || [])[1];
      try { await r.text(); } catch { /* 释放响应体 */ }
    } catch { /* 继续用原链接尝试 */ }
  }
  if (!id) id = (url.match(/(\d{15,20})/) || [])[1];
  if (!id) throw new Error('无法提取抖音作品 ID');

  let item = null;
  const errors = [];

  // 通道 A：老版公开 iteminfo（无需签名）
  try {
    const { json } = await getJson(
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${id}`,
      { timeout: 12000, ua: UA_MOBILE, headers: { Referer: 'https://www.iesdouyin.com/' } }
    );
    item = json?.item_list?.[0] || null;
  } catch (e) { errors.push(`iteminfo: ${e.message}`); }

  // 通道 B：分享页 SSR 数据 window._ROUTER_DATA
  if (!item) {
    try {
      const { text } = await getText(`https://www.iesdouyin.com/share/video/${id}/`, {
        timeout: 12000, ua: UA_MOBILE, headers: { Referer: 'https://www.iesdouyin.com/' }
      });
      const m = text.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/) ||
                text.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?/);
      if (m) {
        const data = JSON.parse(m[1]);
        const ld = data.loaderData || {};
        const pageData = ld[`video_(id)/page`] || ld[`note_(id)/page`] ||
          Object.values(ld).find(v => v && v.videoInfoRes);
        item = pageData?.videoInfoRes?.item_list?.[0] || null;
      }
    } catch (e) { errors.push(`share page: ${e.message}`); }
  }

  if (!item) throw new Error(`抖音解析失败（${errors.join(' | ') || '接口未返回数据'}），建议接入自定义解析 API 或 yt-dlp`);

  const video = item.video || {};
  const raw = [
    ...(video.bit_rate || []).map(b => ({ list: b.play_addr?.url_list || [], label: b.quality_name || `${Math.round((b.bit_rate || 0) / 1000)}k` })),
    { list: video.play_addr?.url_list || [], label: '默认画质' },
    { list: video.play_addr_h264?.url_list || [], label: 'H264' },
    { list: video.download_addr?.url_list || [], label: '下载源' }
  ];
  const formats = [];
  for (const entry of raw) {
    for (const u of entry.list) {
      if (!/^https?:/.test(u)) continue;
      // playwm → play 是抖音官方 CDN 提供的无水印流路径
      formats.push({ label: `${entry.label} · 无水印`, url: u.replace(/playwm/gi, 'play'), ext: 'mp4' });
      if (u !== u.replace(/playwm/gi, 'play')) formats.push({ label: `${entry.label} · 原流`, url: u, ext: 'mp4' });
    }
  }
  if (!formats.length && video.play_addr?.uri) {
    formats.push({ label: '官方播放地址', url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${video.play_addr.uri}&ratio=720p&line=0`, ext: 'mp4' });
  }
  const images = (item.images || []).map((im, i) => ({ type: 'image', label: `图集 ${i + 1}`, url: (im.url_list || [])[0] })).filter(x => x.url);
  return {
    source: 'douyin', sourceLabel: '抖音 · 官方分享页直连',
    title: (item.desc || '').replace(/\s+/g, ' ').slice(0, 80) || `抖音作品 ${id}`,
    author: item.author?.nickname || '',
    cover: video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || '',
    pageUrl: page,
    formats,
    extras: images,
    notes: ['抖音接口常调整签名策略；若失败请在设置中启用「自定义解析 API」或「yt-dlp」。']
  };
}

/** 3. B 站 —— 公开 view + playurl 接口 */
async function parseBilibili(url) {
  let page = url;
  if (/b23\.tv/i.test(url)) {
    const r = await request(url, { timeout: 10000, redirect: 'follow' });
    page = r.url || url;
    try { await r.text(); } catch { /* ignore */ }
  }
  const bv = (page.match(/\/(BV[0-9A-Za-z]{10})/) || [])[1];
  const av = (page.match(/\/av(\d+)/i) || [])[1];
  if (!bv && !av) throw new Error('无法提取 BV/AV 号');
  const q = bv ? `bvid=${bv}` : `aid=${av}`;
  const view = (await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`, {
    timeout: 12000, headers: { Referer: 'https://www.bilibili.com/' }
  })).json;
  if (view.code !== 0 || !view.data) throw new Error(view.message || 'B 站接口返回异常');
  const d = view.data;
  const cid = d.cid || d.pages?.[0]?.cid;
  const referer = `https://www.bilibili.com/video/${bv || 'av' + av}`;
  const hdr = [{ name: 'Referer', value: referer }, { name: 'Origin', value: 'https://www.bilibili.com' }];
  const formats = [];
  for (const qn of [80, 64, 32, 16]) {
    try {
      const p = (await getJson(`https://api.bilibili.com/x/player/playurl?${q}&cid=${cid}&qn=${qn}&fnval=0&fnver=0&fourk=1`, {
        timeout: 12000, headers: { Referer: referer }
      })).json;
      const durl = p.data?.durl || [];
      const label = { 80: '1080P', 64: '720P', 32: '480P', 16: '360P' }[qn];
      for (const [i, seg] of durl.entries()) {
        formats.push({ label: `${label}${durl.length > 1 ? ` · 分段${i + 1}` : ''} (含音频)`, url: seg.url, ext: 'mp4', headers: hdr });
      }
      if (durl.length) break;
    } catch { /* 降一档重试 */ }
  }
  if (!formats.length) {
    // 回退 DASH：只有画面轨，需要本地合并
    const p = (await getJson(`https://api.bilibili.com/x/player/playurl?${q}&cid=${cid}&fnval=16&fourk=1`, {
      timeout: 12000, headers: { Referer: referer }
    })).json;
    for (const v of p.data?.dash?.video || []) {
      formats.push({ label: `${v.height}P · DASH 纯画面`, url: v.baseUrl, ext: 'm4s', headers: hdr, note: '无音轨，建议使用 yt-dlp 合并' });
    }
  }
  return {
    source: 'bilibili', sourceLabel: 'B站 · 公开播放接口',
    title: d.title, author: d.owner?.name || '', cover: d.pic || '', pageUrl: page,
    formats, notes: ['下载需携带 Referer，插件已自动加上；若被 403 请改用 yt-dlp。']
  };
}

/** 4. 微博 —— 移动端公开 statuses/show 接口 */
async function parseWeibo(url) {
  const id = (url.match(/\/(?:status|detail|show)\/([A-Za-z0-9]+)/) || url.match(/[?&]mid=(\d+)/) || [])[1];
  if (!id) throw new Error('无法提取微博 ID');
  const { json } = await getJson(`https://m.weibo.cn/statuses/show?id=${id}`, {
    timeout: 12000, ua: UA_MOBILE, headers: { Referer: 'https://m.weibo.cn/' }
  });
  const mi = json?.data?.page_info?.media_info || {};
  const candidates = [
    ['最高画质', mi.stream_url_hd], ['高清', mi.mp4_720p_mp4], ['标清', mi.mp4_ld_mp4],
    ['流畅', mi.stream_url], ['原始', json?.data?.page_info?.stream_url]
  ].filter(x => x[1]);
  return {
    source: 'weibo', sourceLabel: '微博 · 移动端公开接口',
    title: (json?.data?.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 80) || `微博 ${id}`,
    author: json?.data?.user?.screen_name || '',
    cover: json?.data?.page_info?.page_pic?.url || '',
    pageUrl: url,
    formats: candidates.map(([label, u]) => ({ label, url: u, ext: extOf(u) })),
    extras: (json?.data?.pics || []).map((p, i) => ({ type: 'image', label: `图片 ${i + 1}`, url: p.large?.url || p.url })).filter(x => x.url)
  };
}

/** 5. 通用网页嗅探 —— og:video / <video> / 页面内嵌 mp4、m3u8 */
/**
 * 抖音等 SPA 页面里存在大量「长得像媒体」的静态资源：
 *   https://lf3-static.bytednsdoc.com/obj/eden-cn/.../*.mp4
 * 它们是页面装饰/占位素材，不是用户要的视频。一旦被当成解析结果返回，
 * 就会抢在真正可用的解析通道前面，造成「解析成功但下载不到视频」。
 */
const STATIC_ASSET = /bytednsdoc\.com|byteimg\.com|\/obj\/eden-cn\/|\/obj\/ies-music\/|\/assets\/|\.(?:js|css|png|jpe?g|gif|svg|webp|ico)(?:\?|$)/i;

async function parseGenericHtml(url) {
  const { text } = await getText(url, { timeout: 12000, ua: UA_DESKTOP });
  const clean = unescapeHtml(text);
  const found = [];
  const push = (u, label) => {
    if (!u) return;
    const full = u.startsWith('//') ? 'https:' + u : u.startsWith('http') ? u : null;
    if (!full || !/^https?:\/\//.test(full)) return;
    if (STATIC_ASSET.test(full)) return;
    if (!found.some(f => f.url === full)) found.push({ label, url: full, ext: extOf(full) });
  };
  const metas = /<meta[^>]+(?:property|name)=["'](?:og:video(?::url|:secure_url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
  let m;
  while ((m = metas.exec(clean))) push(m[1], '页面声明的视频');
  const metas2 = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::url|:secure_url)?|twitter:player:stream)["']/gi;
  while ((m = metas2.exec(clean))) push(m[1], '页面声明的视频');
  const tags = /<video[^>]+src=["']([^"']+)["']|<source[^>]+src=["']([^"']+)["']/gi;
  while ((m = tags.exec(clean))) push(m[1] || m[2], '页面 <video> 标签');
  const urls = /https?:\/\/[^"'\s<>]+\.(?:mp4|m4v|webm|mov|m3u8)(?:\?[^"'\s<>]*)?/gi;
  while ((m = urls.exec(clean)) && found.length < 8) push(m[0], '页面内嵌媒体');
  if (!found.length) throw new Error('页面里没有找到可直接下载的媒体地址（多为 JS 动态加载 / HLS 加密）');
  const titleM = clean.match(/<title[^>]*>([^<]+)<\/title>/i) || clean.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const coverM = clean.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return {
    source: 'generic-html', sourceLabel: '通用网页嗅探',
    title: titleM ? titleM[1].trim().slice(0, 80) : safeHost(url),
    cover: coverM ? coverM[1] : '',
    pageUrl: url, formats: found,
    notes: ['通用嗅探只能拿到页面里出现的直链；需要登录/加密/分离音视频的站点请用 Cobalt 或 yt-dlp。']
  };
}

/**
 * 已知的重度 SPA / 加密站点不做通用 HTML 嗅探。
 * 必须用「后缀」匹配而不是 ^ 锚点，否则 v.douyin.com、www.iesdouyin.com、
 * m.weibo.cn 这类带子域的短链会漏进来，被通用嗅探抓到一堆静态资源。
 */
const NO_GENERIC = /(^|\.)(x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|youtube|youtu|instagram|tiktok|douyin|iesdouyin|amemv|bilibili|b23|weibo|sina|facebook|reddit|kuaishou|xhs|xiaohongshu)\.(com|be|cn|tv)$/i;

/** 内置专用解析器（不含通用嗅探；通用嗅探降级为最后兜底） */
const BUILTIN = [
  { id: 'direct-media', test: u => /\.(mp4|m4v|webm|mov|m3u8|flv)(\?|$)/i.test(u), run: directMedia, label: '直链媒体' },
  { id: 'x', test: u => /^(x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com$/.test(safeHost(u)) || /^(www\.)?(x|twitter)\.com$/.test(safeHost(u)), run: parseX, label: 'X / Twitter' },
  { id: 'douyin', test: u => /(^|\.)(douyin|iesdouyin|amemv)\.com$/.test(safeHost(u)) || /douyin\.com/.test(safeHost(u)), run: parseDouyin, label: '抖音' },
  { id: 'bilibili', test: u => /(^|\.)(bilibili|b23)\.(com|tv)$/.test(safeHost(u)), run: parseBilibili, label: 'B 站' },
  { id: 'weibo', test: u => /(^|\.)weibo\.(com|cn)$/.test(safeHost(u)), run: parseWeibo, label: '微博' }
];

/** 内置专用解析器：任一成功即返回强结果（直链媒体已在 resolve 里先试过） */
async function runBuiltin(url, trace) {
  for (const p of BUILTIN) {
    if (p.id === 'direct-media') continue;
    if (!p.test(url)) continue;
    const t0 = Date.now();
    try {
      const r = normalize(await p.run(url));
      trace.push({ channel: 'builtin', parser: p.id, label: p.label, ok: !!r, ms: Date.now() - t0 });
      if (r) return { ...r, trace };
    } catch (e) {
      trace.push({ channel: 'builtin', parser: p.id, label: p.label, ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  return null;
}

/**
 * 通用网页嗅探 —— 只作为「所有强通道都失败」时的最后兜底。
 * 结果标记 weak:true，界面会明确提示这可能只是页面里的静态素材，
 * 避免用户误以为拿到了无水印视频。
 */
async function runGeneric(url, trace) {
  if (NO_GENERIC.test(safeHost(url))) return null;
  const t0 = Date.now();
  try {
    const r = normalize(await parseGenericHtml(url));
    trace.push({ channel: 'builtin', parser: 'generic-html', label: '通用网页嗅探', ok: !!r, ms: Date.now() - t0 });
    if (!r) return null;
    return {
      ...r, weak: true, trace,
      notes: [
        '⚠️ 这是「通用网页嗅探」的兜底结果，很可能只是页面里的静态素材，不是目标视频。',
        '建议在设置页确认已开启「RC 全平台解析」，或改用自定义 API / 本地 yt-dlp。',
        ...(r.notes || [])
      ]
    };
  } catch (e) {
    trace.push({ channel: 'builtin', parser: 'generic-html', label: '通用网页嗅探', ok: false, ms: Date.now() - t0, error: e.message });
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 外部解析通道                                                         */
/* ------------------------------------------------------------------ */

/**
 * RC 全平台解析 —— 与本机「抖音解析 无水印」等快捷指令同源。
 *
 * 快捷指令并不把接口写死：先 GET https://i.rcuts.com/update/247 拿配置，
 * 取其中 parse 字段作为解析端点，再 POST JSON：
 *   {"url":"<分享链接>","sv":"1","client":"ios-shortcut-247","quality":"all"}
 * 返回 data.urls（直链数组）、data.labels（画质标签）、data.d_headers（CDN 请求头）。
 * 配置端点可随时换域名，所以这里也做动态读取 + 缓存 + 内置兜底。
 */
const RCUTS_FALLBACK = {
  configUrl: 'https://i.rcuts.com/update/247',
  endpoint: 'https://parse.rcuts.com:8443/v1/parse',
  client: 'ios-shortcut-247'
};
let rcutsCache = { at: 0, config: null };

async function getRcutsConfig(s) {
  if (rcutsCache.config && Date.now() - rcutsCache.at < 6 * 3600 * 1000) return rcutsCache.config;
  try {
    const { json } = await getJson(s.rcutsConfig || RCUTS_FALLBACK.configUrl, { timeout: 10000 });
    rcutsCache = { at: Date.now(), config: json || {} };
  } catch {
    rcutsCache = { at: Date.now(), config: {} }; // 配置挂了仍可用内置兜底端点
  }
  return rcutsCache.config;
}

/** d_headers 形如 {a:{n:"Referer",v:"..."}, b:{n:"User-Agent",v:"..."}} */
function rcutsHeaders(dh) {
  const out = [];
  const seen = new Set();
  if (!dh || typeof dh !== 'object') return out;
  for (const key of Object.keys(dh).sort()) {
    const item = dh[key];
    if (!item || typeof item.n !== 'string' || !item.n || item.v == null) continue;
    const name = String(item.n);
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue; // 接口常把 dnt 重复填在 a~e 里，下载 API 不接受重复头
    seen.add(lower);
    out.push({ name, value: String(item.v) });
  }
  return out;
}

/** 按平台 / CDN 域名推断站点 Referer，供下载兼容模式使用 */
function guessReferer(platform, items, pageUrl) {
  const p = String(platform || '').toLowerCase();
  const map = [
    ['douyin', 'https://www.douyin.com/'], ['aweme', 'https://www.douyin.com/'],
    ['bili', 'https://www.bilibili.com/'], ['weibo', 'https://weibo.com/'],
    ['kuaishou', 'https://www.kuaishou.com/'], ['xhs', 'https://www.xiaohongshu.com/'],
    ['xiaohongshu', 'https://www.xiaohongshu.com/'], ['tiktok', 'https://www.tiktok.com/'],
    ['twitter', 'https://x.com/'], ['youtube', 'https://www.youtube.com/'],
    ['instagram', 'https://www.instagram.com/']
  ];
  for (const [k, v] of map) if (p.includes(k)) return v;
  const host = String((items[0] && items[0].url) || '').match(/^https?:\/\/([^/]+)/i)?.[1] || '';
  if (/douyin|aweme|bytecdn|ixigua/i.test(host)) return 'https://www.douyin.com/';
  if (/bilivideo|bilibili|upos|hdslb/i.test(host)) return 'https://www.bilibili.com/';
  if (/weibo|sina/i.test(host)) return 'https://weibo.com/';
  if (/^https?:\/\//.test(pageUrl || '')) return String(pageUrl).match(/^https?:\/\/[^/]+\/?/i)?.[0] || '';
  return '';
}

/**
 * 把 data 里的直链整理成 { videos, extras }。
 * 新版接口在 data.medias[] 里给出完整的多画质结构（label/quality/size/ext/filename），
 * 而 data.urls 往往只放最高画质 1 条、labels 却是全部 3 条 —— 旧逻辑会把音频
 * 混进画质列表、且只能靠去重凑出画质。这里优先用 medias，并把音频/图片分流到 extras。
 */
function rcutsMedia(data) {
  const videos = [];
  const extras = [];
  const seen = new Set();

  const addVideo = (u, label, ext, extra) => {
    if (!u || typeof u !== 'string') return;
    const s = unescapeHtml(u.trim());
    if (!/^https?:\/\//i.test(s) || seen.has(s)) return;
    seen.add(s);
    videos.push({ url: s, label: label || guessLabel(s), ext: ext || extOf(s), extra: extra || {} });
  };
  const addExtra = (u, label, type) => {
    if (!u || typeof u !== 'string') return;
    const s = unescapeHtml(u.trim());
    if (!/^https?:\/\//i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    extras.push({ type: type || 'file', label: label || '素材', url: s,
      ext: (s.split('?')[0].match(/\.(mp3|m4a|jpe?g|png|webp)$/i) || [])[1] || 'mp3' });
  };

  const medias = Array.isArray(data.medias) ? data.medias : [];
  for (const m of medias) {
    if (typeof m === 'string') { addVideo(m, '媒体'); continue; }
    if (!m || typeof m !== 'object') continue;
    const type = String(m.type || '').toLowerCase();
    const u = m.url || m.video_url || m.link || m.src || m.play;
    if (type === 'audio') { addExtra(u, m.label || '音频', 'audio'); continue; }
    if (type === 'image') { addExtra(m.image_url || u, m.label || '图片', 'image'); continue; }
    addVideo(u, m.label || m.quality || '', m.ext, {
      size: m.sizep || '', filename: m.filename || '', watermark: m.watermark
    });
    if (m.image_url) addExtra(m.image_url, '封面', 'image');
  }

  // 兜底：老版接口只有 urls/labels。仅当两者等长时才按下标配对，
  // 否则 labels 是「画质清单」而非 URL 标签，强行配对会贴错。
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const rawUrls = Array.isArray(data.urls) ? data.urls : Object.values(data.urls || {});
  const paired = rawUrls.length === labels.length;
  rawUrls.forEach((u, i) => {
    if (typeof u === 'string') addVideo(u, paired ? labels[i] : (i === 0 ? labels[0] || data.quality : ''));
    else if (u && typeof u === 'object') {
      addVideo(u.url || u.link || u.download || u.play || u.src,
        u.label || u.quality || u.name || (paired ? labels[i] : ''));
    }
  });
  addVideo(data.video, data.quality || '主视频');
  addExtra(data.audio, '音频', 'audio');
  const musicUrl = data.music && typeof data.music === 'object' ? data.music.url : '';
  addExtra(musicUrl, '配乐', 'audio');
  if (!videos.length && !extras.length) {
    for (const u of harvestMediaUrls(data)) addVideo(u, '');
  }
  return { videos, extras };
}

async function runRcuts(url, s, trace) {
  if (!s.useRcuts) return null;
  const t0 = Date.now();
  try {
    const cfg = await getRcutsConfig(s);
    const endpoint = cfg.parse || RCUTS_FALLBACK.endpoint;
    const payload = {
      url,
      sv: '1',
      client: s.rcutsClient || RCUTS_FALLBACK.client,
      quality: 'all'
    };
    const r = await request(endpoint, {
      method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`返回不是 JSON：${text.slice(0, 100)}`); }
    if (String(json.code) !== '0') {
      throw new Error(`${json.msg || '解析失败'}（code ${json.code}）`);
    }
    const data = json.data || {};
    const { videos, extras } = rcutsMedia(data);
    if (!videos.length && !extras.length) throw new Error('解析成功但响应里没有视频地址');
    const headers = rcutsHeaders(data.d_headers);
    // 服务端没下发 d_headers 时，按平台 / CDN 域名补一个站点 Referer
    if (!headers.some(h => /^referer$/i.test(h.name))) {
      const ref = guessReferer(data.platform, videos, url);
      if (ref) headers.push({ name: 'Referer', value: ref });
    }
    const res = normalize({
      source: 'rcuts',
      sourceLabel: `RC 全平台解析 · ${data.platform || '通用'}`,
      title: String(data.title || data.desc || '').slice(0, 80) || '视频',
      author: (data.author && data.author.name) || '',
      cover: data.cover || (extras.find(x => x.type === 'image') || {}).url || '',
      pageUrl: url,
      formats: videos.map((it, i) => ({
        label: it.label || (i === 0 ? '推荐画质' : `候选 ${i + 1}`),
        url: it.url,
        ext: it.ext || extOf(it.url),
        headers,
        note: it.extra?.size || (i === 0 && data.quality_hd ? '高画质' : '')
      })),
      extras: extras.map(x => ({ type: x.type === 'image' ? 'image' : 'file', label: x.label, url: x.url })),
      notes: [`${videos.length} 个画质 · ${data.watermark === false ? '无水印' : '已解析'}`, '直链有时效，若下载失败请重新解析一次。']
    });
    trace.push({ channel: 'rcuts', ok: !!res, ms: Date.now() - t0, label: CHANNEL_LABELS.rcuts, detail: `code=${json.code} platform=${data.platform || ''}` });
    return res ? { ...res, trace } : null;
  } catch (e) {
    trace.push({ channel: 'rcuts', ok: false, ms: Date.now() - t0, label: CHANNEL_LABELS.rcuts, error: e.message });
    return null;
  }
}

/** 自定义解析 API：兼容 iOS 快捷指令常用的各类私有接口 */
async function runCustom(url, s, trace) {
  if (!s.useCustom || !s.customApi) return null;
  const t0 = Date.now();
  try {
    const api = s.customApi.replace(/\{url\}/g, encodeURIComponent(url));
    const isPost = s.customMethod === 'POST';
    const opts = {
      method: s.customMethod,
      timeout: 20000,
      headers: { Accept: 'application/json, text/plain, */*' },
      ...(isPost ? {
        body: (s.customBody || '{"url":"{url}"}').replace(/\{url\}/g, url),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' }
      } : {})
    };
    const r = await request(api, opts);
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 120)}`);
    let urls = [];
    let title = '';
    try {
      const json = JSON.parse(body);
      urls = harvestMediaUrls(json);
      const d = json.data || json;
      title = d.desc || d.title || d.text || json.title || '';
    } catch {
      if (/^https?:\/\//.test(body.trim())) urls = [body.trim()];
    }
    if (!urls.length) throw new Error('接口返回中没有找到视频地址');
    const res = normalize({
      source: 'custom-api', sourceLabel: '自定义解析 API',
      title: String(title).slice(0, 80) || '自定义接口解析结果',
      pageUrl: url,
      formats: urls.slice(0, 12).map((u, i) => ({ label: i === 0 ? '接口返回 · 推荐' : `候选 ${i + 1}`, url: u, ext: extOf(u) }))
    });
    trace.push({ channel: 'custom', ok: !!res, ms: Date.now() - t0, label: CHANNEL_LABELS.custom });
    return res ? { ...res, trace } : null;
  } catch (e) {
    trace.push({ channel: 'custom', ok: false, ms: Date.now() - t0, label: CHANNEL_LABELS.custom, error: e.message });
    return null;
  }
}

/** Cobalt 实例：兼容 v11 (POST /) 与 v10 (POST /api/json) 两套 API */
async function runCobalt(url, s, trace) {
  if (!s.useCobalt || !s.cobaltUrl) return null;
  const t0 = Date.now();
  const base = s.cobaltUrl.replace(/\/+$/, '');
  const attempts = [
    {
      ep: base, label: 'v11',
      body: { url, videoQuality: s.cobaltQuality || '1080', downloadMode: 'auto', youtubeVideoCodec: 'h264', filenameStyle: 'pretty' }
    },
    {
      ep: `${base}/`, ep2: `${base}/api/json`, label: 'v10',
      body: { url, vQuality: s.cobaltQuality || '720' }
    }
  ];
  let lastErr = '';
  for (const a of attempts) {
    for (const ep of [a.ep, a.ep2].filter(Boolean)) {
      try {
        const r = await request(ep, {
          method: 'POST', timeout: 30000,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(a.body)
        });
        const txt = await r.text();
        if (!r.ok) { lastErr = `HTTP ${r.status} ${txt.slice(0, 100)}`; continue; }
        const j = JSON.parse(txt);
        if (j.status === 'error') { lastErr = j.error?.code || j.text || 'error'; continue; }
        const urls = [];
        if (['tunnel', 'redirect', 'stream', 'success'].includes(j.status) && j.url) urls.push(j.url);
        for (const p of j.picker || []) if (p.url) urls.push(p.url);
        for (const p of j.tunnel || []) if (typeof p === 'string') urls.push(p);
        urls.push(...harvestMediaUrls(j));
        if (!urls.length) { lastErr = `status=${j.status}，无可用直链`; continue; }
        const res = normalize({
          source: 'cobalt', sourceLabel: `Cobalt 实例 (${safeHost(base)})`,
          title: j.filename || j.output?.filename || 'Cobalt 解析结果',
          pageUrl: url,
          formats: urls.slice(0, 12).map((u, i) => ({ label: i === 0 ? (j.filename ? 'Cobalt · 推荐' : 'Cobalt · 推荐') : `候选 ${i + 1}`, url: u, ext: extOf(u) })),
          notes: ['tunnel/redirect 直链通常有时效，请尽快下载。']
        });
        trace.push({ channel: 'cobalt', ok: !!res, ms: Date.now() - t0, label: `${CHANNEL_LABELS.cobalt} · ${a.label}` });
        if (res) return { ...res, trace };
      } catch (e) { lastErr = e.message; }
    }
  }
  trace.push({ channel: 'cobalt', ok: false, ms: Date.now() - t0, label: CHANNEL_LABELS.cobalt, error: lastErr || '实例不可用' });
  return null;
}

/** 本地 yt-dlp：通过 Native Messaging bridge 拿到 format 列表 */
async function runYtdlp(url, s, trace) {
  if (!s.useYtdlp) return null;
  const t0 = Date.now();
  try {
    const allowed = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
    if (!allowed) throw new Error('尚未授予 nativeMessaging 权限（在设置页点「启用本地 yt-dlp」）');
    const reply = await chrome.runtime.sendNativeMessage(s.nativeHost || DEFAULT_SETTINGS.nativeHost, {
      action: 'resolve', url, timeout: 90
    });
    if (!reply?.ok) throw new Error(reply?.error || '本地 yt-dlp 未返回结果');
    const formats = (reply.formats || []).map(f => ({
      label: f.label || `${f.height || '?'}P`,
      url: f.url,
      ext: f.ext || extOf(f.url),
      headers: f.headers || [],
      note: f.note || ''
    }));
    const res = normalize({
      source: 'ytdlp', sourceLabel: '本地 yt-dlp (全站支持)',
      title: reply.title || 'yt-dlp 解析结果', author: reply.author || '',
      cover: reply.cover || '', pageUrl: url, formats,
      notes: reply.note ? [reply.note] : []
    });
    trace.push({ channel: 'ytdlp', ok: !!res, ms: Date.now() - t0, label: CHANNEL_LABELS.ytdlp });
    return res ? { ...res, trace } : null;
  } catch (e) {
    trace.push({ channel: 'ytdlp', ok: false, ms: Date.now() - t0, label: CHANNEL_LABELS.ytdlp, error: e.message });
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                           */
/* ------------------------------------------------------------------ */

export async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

/**
 * 这些平台的内置专用解析器要么已失效（抖音 iteminfo / _ROUTER_DATA 已下线并加风控），
 * 要么根本没有专用解析器。让外部解析通道（尤其与快捷指令同源的 RC 通道）优先执行，
 * 避免白等 1~2 秒再降级，也避免通用嗅探抢跑返回假结果。
 */
const EXTERNAL_FIRST = /(^|\.)(douyin|iesdouyin|amemv|kuaishou|xhs|xiaohongshu|tiktok|instagram|youtube|youtu|facebook)\.(com|be|cn|tv)$/i;

/** 直链媒体（.mp4 等）不需要任何解析，永远最先判断 */
async function runDirect(url, trace) {
  const p = BUILTIN[0];
  if (!p.test(url)) return null;
  const t0 = Date.now();
  try {
    const r = normalize(await p.run(url));
    trace.push({ channel: 'builtin', parser: p.id, label: p.label, ok: !!r, ms: Date.now() - t0 });
    return r ? { ...r, trace } : null;
  } catch (e) {
    trace.push({ channel: 'builtin', parser: p.id, label: p.label, ok: false, ms: Date.now() - t0, error: e.message });
    return null;
  }
}

export async function resolve(rawUrl, settings) {
  const url = extractUrl(rawUrl);
  if (!url) return { ok: false, error: '没有找到有效的 http(s) 链接' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: '链接格式不正确' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '仅支持 http/https 链接' };

  const s = settings || await getSettings();
  const trace = [];

  // ① 链接本身就是媒体文件
  if (s.useBuiltin) {
    const r = await runDirect(url, trace);
    if (r) return r;
  }

  const externalFirst = EXTERNAL_FIRST.test(safeHost(url));
  const runExternal = async () => {
    for (const fn of [runRcuts, runCustom, runCobalt, runYtdlp]) {
      const r = await fn(url, s, trace);
      if (r) return r;
    }
    return null;
  };

  // ② 已知「内置解析不可靠」的平台 → 外部通道（RC 优先）先上
  if (externalFirst) {
    const r = await runExternal();
    if (r) return r;
  }

  // ③ 内置专用解析器（跳过已试过的直链）
  if (s.useBuiltin) {
    const r = await runBuiltin(url, trace);
    if (r) return r;
  }

  // ④ 其余外部通道
  if (!externalFirst) {
    const r = await runExternal();
    if (r) return r;
  }

  // ⑤ 全部失败 → 通用网页嗅探兜底（弱结果，界面会明确警示）
  if (s.useBuiltin) {
    const r = await runGeneric(url, trace);
    if (r) return r;
  }

  const enabled = ['builtin', 'rcuts', 'custom', 'cobalt', 'ytdlp'].filter(c => s[`use${c[0].toUpperCase()}${c.slice(1)}`]);
  const rcHint = externalFirst && !s.useRcuts
    ? '检测到这是「RC 全平台解析」支持的平台，但设置里该通道被关闭了 —— 请在设置页开启它（与 iOS/macOS 快捷指令同源）。'
    : '';
  return {
    ok: false,
    error: rcHint || (enabled.length
      ? `所有已启用的解析通道都失败了（${enabled.map(c => CHANNEL_LABELS[c]).join(' → ')}）。可在设置页接入自定义解析 API 或本地 yt-dlp。`
      : '当前没有启用任何解析通道，请在设置页至少开启一项。'),
    trace
  };
}
