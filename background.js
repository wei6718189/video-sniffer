/**
 * Video Sniffer · Service Worker (MV3)
 * 负责：消息路由、右键菜单、快捷键、下载、历史记录、通知。
 */
import { resolve, getSettings, DEFAULT_SETTINGS, extractUrl } from './parsers.js';

const ICON = 'icons/icon48.png';

/* ----------------------------- 工具 ----------------------------- */

function sanitizeFilename(name) {
  let s = String(name || 'video.mp4')
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
  if (!/\.[a-z0-9]{2,5}$/i.test(s)) s += '.mp4';
  return s || 'video.mp4';
}

function extFromFormat(f) {
  const e = String((f && f.ext) || 'mp4').toLowerCase();
  return ['mp4', 'm4v', 'webm', 'mov', 'm3u8', 'flv', 'jpg', 'png', 'webp', 'm4a', 'mp3'].includes(e) ? e : 'mp4';
}

function buildFilename(result, format) {
  const bits = [result.title];
  if (format?.label && !/推荐|默认|候选/.test(format.label)) {
    bits.push(format.label.replace(/[·\/\\]/g, '-').trim());
  }
  if (result.author) bits.push(result.author.replace('@', ''));
  return sanitizeFilename(bits.filter(Boolean).join(' - ') + '.' + extFromFormat(format));
}

/* ----------------------------- 下载 ----------------------------- */
/**
 * chrome.downloads.download 的 headers「受 XHR 允许的头约束」：
 * User-Agent / Referer / Cookie / DNT 等一律传不进去。实测 CDN 会因此返回
 * 403 的 text/html，Chrome 把文件存成 .html 并提示「无法从网站上提取文件」。
 *
 * 下载链：
 *   ① 剥离 forbidden 头，让请求恢复浏览器原生 UA（实测 CDN 主要校验 UA）
 *   ② 用 Range: bytes=0-0 预检，确认原生下载会不会被拒
 *   ③ 预检失败 → offscreen 页面 fetch（可合法带 referrer）→ Blob → 下载
 *   ④ 下载完若发现存的是 HTML 错误页，自动删除并用 ③ 重来一次
 */
const FORBIDDEN_HEADER = /^(user-agent|referer|referrer|host|cookie|cookie2|origin|content-length|connection|accept-charset|accept-encoding|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via|set-cookie|proxy-|sec-|access-control-)/i;

function splitHeaders(headers) {
  const legal = [];
  const seen = new Set();
  let referrer = '';
  for (const h of headers || []) {
    if (!h || !h.name || h.value == null) continue;
    const name = String(h.name).trim();
    const value = String(h.value);
    const low = name.toLowerCase();
    if (low === 'referer' || low === 'referrer') { if (!referrer) referrer = value; continue; }
    if (!name || FORBIDDEN_HEADER.test(name) || seen.has(low)) continue;
    seen.add(low);
    legal.push({ name, value });
  }
  return { legal, referrer };
}

function headerObject(list) {
  const out = {};
  for (const h of list || []) out[h.name] = h.value;
  return out;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时（${ms / 1000} 秒）`)), ms);
  });
  try { return await Promise.race([promise, guard]); }
  finally { clearTimeout(timer); }
}

async function probeDirect(url, legal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', ...headerObject(legal) },
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      signal: ctrl.signal
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const ok = res.ok && !/text\/html|application\/json|text\/plain|text\/xml/.test(ct);
    try { await res.body?.cancel(); } catch { /* 忽略 */ }
    return { ok, status: res.status, ct };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

let offscreenOpening = null;
async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx && ctx.length) return;
  }
  if (offscreenOpening) return offscreenOpening;
  offscreenOpening = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: '带站点 Referer 取回受防盗链保护的视频并生成 Blob URL 供下载'
  }).finally(() => { offscreenOpening = null; });
  try {
    await offscreenOpening;
  } catch (e) {
    if (!/already|exists/i.test(String(e.message))) throw e; // 已存在则忽略
  }
}

async function blobDownload({ url, filename, legal, referrer, saveAs }) {
  await withTimeout(ensureOffscreen(), 15000, '创建下载辅助页面');
  const payload = {
    target: 'offscreen', type: 'fetchBlobDownload',
    url, filename, headers: legal, referrer, saveAs: !!saveAs
  };
  const call = () => chrome.runtime.sendMessage(payload);
  let r;
  try { r = await withTimeout(call(), 120000, '兼容下载'); }
  catch {
    await new Promise(res => setTimeout(res, 300));
    r = await withTimeout(call(), 120000, '兼容下载');
  }
  if (!r || !r.ok) throw new Error(r?.error || '兼容下载未返回结果');

  if (r.objectUrl) {
    // offscreen 中不暴露 downloads 时的兜底：由 service worker 发起下载
    const id = await chrome.downloads.download({
      url: r.objectUrl, filename: r.filename || filename,
      conflictAction: 'uniquify', saveAs: !!saveAs
    });
    return { downloadId: id, mode: 'blob', size: r.size };
  }
  return { downloadId: r.downloadId, mode: 'blob', size: r.size };
}

/* ------------------ 本机直链下载（最可靠） ------------------ */
/**
 * 浏览器扩展无法设置 User-Agent（downloads API 与 fetch 都不允许），而视频 CDN
 * 恰恰按 UA 防盗链。把直链连同解析服务返回的完整请求头交给本机 Python 下载，
 * 就能像 macOS/iOS 快捷指令一样取回视频 —— 两者都是「原生进程自由设头」。
 */
async function nativeReady() {
  try { return await chrome.permissions.contains({ permissions: ['nativeMessaging'] }); }
  catch { return false; }
}

async function nativeFetchDownload({ url, filename, headers, referrer, dir }) {
  const s = await getSettings();
  const reply = await chrome.runtime.sendNativeMessage(s.nativeHost || 'com.vsniffer.ytdlp', {
    action: 'fetch', url, filename,
    headers: headers || [], referer: referrer || '', dir: dir || 'VideoSniffer'
  });
  if (!reply || !reply.ok) throw new Error(reply?.error || '本机下载未返回结果');
  return { mode: 'native', path: reply.path, size: reply.size };
}

// 记录直连下载，用于「存成了 HTML 错误页」时自动补救。
// 同时写入 chrome.storage.session：大文件下载期间 SW 可能被回收，内存 Map 会丢。
const pendingDownloads = new Map();
const FALLBACK_KEY = 'downloadFallback';

async function rememberDownload(id, item) {
  pendingDownloads.set(id, item);
  try {
    const store = await chrome.storage.session.get(FALLBACK_KEY);
    const all = store[FALLBACK_KEY] || {};
    const now = Date.now();
    for (const k of Object.keys(all)) {
      if (!all[k] || now - (all[k].ts || 0) > 10 * 60 * 1000) delete all[k];
    }
    all[id] = { ...item, ts: now };
    await chrome.storage.session.set({ [FALLBACK_KEY]: all });
  } catch { /* 存储不可用时至少还有内存版本 */ }
}

async function peekDownload(id) {
  if (pendingDownloads.has(id)) return pendingDownloads.get(id);
  try {
    const store = await chrome.storage.session.get(FALLBACK_KEY);
    return (store[FALLBACK_KEY] || {})[id] || null;
  } catch { return null; }
}

async function takeDownload(id) {
  pendingDownloads.delete(id);
  try {
    const store = await chrome.storage.session.get(FALLBACK_KEY);
    const all = store[FALLBACK_KEY] || {};
    const item = all[id] || null;
    if (item) { delete all[id]; await chrome.storage.session.set({ [FALLBACK_KEY]: all }); }
    return item;
  } catch { return null; }
}

async function downloadOne({ url, filename, headers = [], saveAs = false }) {
  const s = await getSettings();
  const dir = String(s.downloadDir || 'VideoSniffer').replace(/^[\/\\]+/g, '').replace(/\.\./g, '').trim();
  const finalName = (dir ? dir + '/' : '') + sanitizeFilename(filename);
  const bareName = sanitizeFilename(filename);
  const { legal, referrer } = splitHeaders(headers);
  const nativeArgs = { url, filename: bareName, headers, referrer, dir };
  let nativeError = '';

  // ① 已授权本机桥接 → 优先本机下载（可带完整 UA/Referer，视频 CDN 防盗链必过）
  if (s.useNativeDownload !== false && await nativeReady()) {
    try { return await nativeFetchDownload(nativeArgs); }
    catch (e) { nativeError = e.message; } // 桥接未注册等原因 → 继续走浏览器下载
  }

  try {
    // ② 浏览器内：预检 → 原生下载 / Blob 兼容下载
    const p = await probeDirect(url, legal);
    if (!p.ok) {
      return await blobDownload({ url, filename: finalName, legal, referrer, saveAs });
    }
    const opts = {
      url,
      filename: finalName,
      conflictAction: 'uniquify',
      saveAs: !!saveAs
    };
    if (legal.length) opts.headers = legal;
    let id;
    try {
      id = await chrome.downloads.download(opts);
    } catch (e) {
      if (opts.headers) { delete opts.headers; id = await chrome.downloads.download(opts); }
      else throw e;
    }
    await rememberDownload(id, { url, filename: finalName, legal, referrer, saveAs, retried: false });
    return { downloadId: id, mode: 'direct', probe: { status: p.status, ct: p.ct } };
  } catch (e) {
    throw new Error(`${e.message}${nativeError ? `；本机下载也不可用（${nativeError}）` : ''}`);
  }
}

async function addHistory(entry) {
  try {
    const { history = [] } = await chrome.storage.local.get('history');
    const s = await getSettings();
    const next = [entry, ...history.filter(h => h.url !== entry.url)].slice(0, s.historyLimit || 20);
    await chrome.storage.local.set({ history: next });
  } catch { /* 历史失败不影响主流程 */ }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create('', {
      type: 'basic', iconUrl: ICON, title, message: String(message).slice(0, 160)
    });
  } catch { /* 通知权限可能被系统关闭 */ }
}

/* ------------------------- 快捷入口 ------------------------- */
/** 右键 / 快捷键：链接 → 解析 → 按设置自动下载，结果留给 popup 展示 */
async function quickResolve(rawUrl) {
  const url = extractUrl(rawUrl);
  if (!url) {
    await notify('Video Sniffer', '没有找到有效链接');
    return { ok: false, error: '没有找到有效链接' };
  }
  await chrome.storage.session.set({ pendingUrl: url, pendingAt: Date.now() });
  const settings = await getSettings();
  const result = await resolve(url, settings);
  await chrome.storage.session.set({ lastResult: result, pendingUrl: url });

  if (!result.ok) {
    await notify('解析失败', result.error || '未知错误');
    return result;
  }
  if (settings.quickDownload) {
    const best = result.formats[0];
    // HLS 清单不是可直接播放的视频文件，交给本地 yt-dlp 合并更合适
    if (best.ext === 'm3u8' && settings.useYtdlp) {
      const r = await downloadLocal({ url: result.pageUrl || best.url });
      await notify(r?.ok ? '已交给 yt-dlp 下载' : 'yt-dlp 未就绪', r?.ok ? 'HLS 流将自动合并为 mp4' : (r?.error || ''));
      return { ...result, localDownload: r };
    }
    if (best.ext === 'm3u8') {
      await notify('这是 HLS 流', '浏览器只能下载清单文件；请在设置页启用本地 yt-dlp 后重试');
      return result;
    }
    try {
      const dl = await downloadOne({
        url: best.url, filename: buildFilename(result, best), headers: best.headers
      });
      await addHistory({ url, title: result.title, source: result.sourceLabel, at: Date.now() });
      const note = dl.mode === 'native' ? '（本机下载完成）'
        : dl.mode === 'blob' ? '（兼容模式）' : '';
      await notify(dl.mode === 'native' ? '下载完成' : '开始下载',
        `${result.title.slice(0, 40)} · ${best.label}${note}`);
      return { ...result, downloadId: dl.downloadId, downloadMode: dl.mode, savedPath: dl.path };
    } catch (e) {
      await notify('下载失败', e.message);
      return { ...result, downloadError: e.message };
    }
  }
  await notify('解析成功', `${result.formats.length} 个可用画质，点击插件图标选择`);
  return result;
}

/* --------------------- 当前页面媒体嗅探 --------------------- */
async function grabPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: '没有可用的标签页' };
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const out = [];
        const add = u => {
          if (!u) return;
          const full = u.startsWith('//') ? location.protocol + u : u;
          if (/^https?:\/\//.test(full) && !out.includes(full)) out.push(full);
        };
        document.querySelectorAll('video, source').forEach(v => add(v.src || v.getAttribute('src')));
        document.querySelectorAll('meta[property^="og:video"], meta[name="twitter:player:stream"]').forEach(m => add(m.content));
        const html = document.documentElement.outerHTML.replace(/\\\//g, '/').replace(/&amp;/g, '&');
        const re = /https?:\/\/[^"'\s<>]+\.(?:mp4|m4v|webm|mov|m3u8)(?:\?[^"'\s<>]*)?/gi;
        let m;
        while ((m = re.exec(html)) && out.length < 12) add(m[0]);
        return { url: location.href, title: document.title, media: out };
      }
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingChannel(channel, testUrl) {
  const s = await getSettings();
  // 用公开 B 站视频做内置解析探测：通用嗅探现在只作兜底，YouTube 等
  // 已排除通用嗅探的平台不再适合当「内置解析」的测试样本。
  const url = testUrl || 'https://www.bilibili.com/video/BV1xx411c7mD';
  if (channel === 'cobalt') {
    if (!s.cobaltUrl) return { ok: false, error: '请先填写 Cobalt 实例地址' };
    try {
      const base = s.cobaltUrl.replace(/\/+$/, '');
      const r = await fetch(base + '/api/serverInfo');
      const text = (await r.text()).slice(0, 200);
      if (r.ok) return { ok: true, status: r.status, body: text };
      // v11 没有 /api/serverInfo，直接探测根路径
      const r2 = await fetch(base, { method: 'GET' });
      return { ok: r2.ok, status: r2.status, body: (await r2.text()).slice(0, 200) };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (channel === 'ytdlp') {
    const allowed = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
    if (!allowed) return { ok: false, error: '尚未授予 nativeMessaging 权限' };
    try {
      return await chrome.runtime.sendNativeMessage(s.nativeHost, { action: 'ping' });
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (channel === 'rcuts') {
    // 用一个公开 B 站链接做连通性实测（该接口实测返回 code:0）
    return resolve('https://www.bilibili.com/video/BV1xx411c7mD', {
      ...s, useBuiltin: false, useCustom: false, useCobalt: false, useYtdlp: false
    });
  }
  if (channel === 'custom') {
    if (!s.customApi) return { ok: false, error: '请先填写自定义接口地址' };
    return resolve(url, { ...s, useBuiltin: false, useRcuts: false, useCobalt: false, useYtdlp: false });
  }
  return resolve(url, { ...s, useRcuts: false, useCustom: false, useCobalt: false, useYtdlp: false });
}

async function downloadLocal(msg) {
  const s = await getSettings();
  const allowed = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  if (!allowed) return { ok: false, error: '未授权 nativeMessaging，请到设置页启用' };
  try {
    return await chrome.runtime.sendNativeMessage(s.nativeHost, {
      action: 'download', url: msg.url, dir: s.downloadDir
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------- 消息路由 ------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    switch (msg.type) {
      case 'resolve': return await resolve(msg.url, msg.settings);
      case 'download': {
        const dl = await downloadOne(msg);
        await addHistory({
          url: msg.pageUrl || msg.url, title: msg.title || '视频',
          source: msg.source || '', at: Date.now()
        });
        return { ok: true, ...dl };
      }
      case 'downloadLocal': return await downloadLocal(msg);
      case 'getSettings': return await getSettings();
      case 'getDefaults': return DEFAULT_SETTINGS;
      case 'saveSettings': {
        await chrome.storage.sync.set({ settings: { ...(await getSettings()), ...msg.settings } });
        return { ok: true };
      }
      case 'grabPage': return await grabPage();
      case 'pingChannel': return await pingChannel(msg.channel, msg.url);
      case 'getPending': return await chrome.storage.session.get(['pendingUrl', 'lastResult', 'pendingAt']);
      case 'clearPending': {
        await chrome.storage.session.remove(['pendingUrl', 'lastResult']);
        return { ok: true };
      }
      case 'quickResolve': return await quickResolve(msg.url);
      case 'deleteHistory': {
        const { history = [] } = await chrome.storage.local.get('history');
        const next = history.filter(h => msg.at ? h.at !== msg.at : h.url !== msg.url);
        await chrome.storage.local.set({ history: next });
        return { ok: true, removed: history.length - next.length };
      }
      case 'clearHistory': {
        await chrome.storage.local.set({ history: [] });
        return { ok: true };
      }
      case 'getHistory': {
        const { history = [] } = await chrome.storage.local.get('history');
        return { ok: true, history };
      }
      default: return { ok: false, error: '未知消息类型' };
    }
  })().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // 保持异步消息通道
});

/* ------------------------- 右键菜单 ------------------------- */
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'vs-link', title: 'Video Sniffer：解析并下载这个链接', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'vs-selection', title: 'Video Sniffer：解析选中文字里的链接', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'vs-page', title: 'Video Sniffer：解析当前页面', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'vs-open', title: 'Video Sniffer：打开解析面板', contexts: ['action'] });
  });
}

chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'vs-open') {
    try { await chrome.action.openPopup(); } catch { chrome.runtime.openOptionsPage(); }
    return;
  }
  const raw = info.menuItemId === 'vs-link' ? info.linkUrl
    : info.menuItemId === 'vs-selection' ? info.selectionText
    : tab?.url || '';
  await quickResolve(raw);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'resolve-current-tab') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) await quickResolve(tab.url);
});

/** 直连下载若被 CDN 换成 403 网页，删掉垃圾文件并自动改用 Blob 兼容模式 */
async function retryAsBlob(id, item) {
  await takeDownload(id);
  try { await chrome.downloads.removeFile(id); } catch { /* 可能已不存在 */ }
  try { await chrome.downloads.erase({ id }); } catch { /* 忽略 */ }
  try {
    await blobDownload(item);
    await notify('已自动改用兼容模式重新下载', '原请求被 CDN 拒绝（403 网页），现已带站点 Referer 重新取回视频');
  } catch (e) {
    await notify('下载失败', `CDN 拒绝访问：${e.message}。建议启用本地 yt-dlp，或点「复制链接」用下载工具打开。`);
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const id = delta.id;
  const item = await peekDownload(id);
  if (delta.error?.current) {
    if (item && !item.retried) { await retryAsBlob(id, { ...item, retried: true }); return; }
    await takeDownload(id);
    await notify('下载被中断', `原因：${delta.error.current}。可尝试其它画质，或改用 yt-dlp。`);
    return;
  }
  if (delta.state?.current !== 'complete' || !item) return;
  let d;
  try { [d] = await chrome.downloads.search({ id }); } catch { return; }
  const mime = String(d?.mime || '').toLowerCase();
  const isErrorPage = /text\/html|application\/json/.test(mime) ||
    (d?.fileSize > 0 && d.fileSize < 1024);
  if (isErrorPage && !item.retried) {
    await retryAsBlob(id, { ...item, retried: true });
  } else {
    await takeDownload(id);
  }
});
