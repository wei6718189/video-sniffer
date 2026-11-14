/* Video Sniffer · Popup 交互 */
'use strict';

const $ = id => document.getElementById(id);
// 后台偶发卡住时不要让按钮永远停在「下载中…」
const send = (msg, ms = 120000) => Promise.race([
  chrome.runtime.sendMessage(msg),
  new Promise((_, rej) =>
    setTimeout(() => rej(new Error('后台处理超时，请查看下载管理器或重试')), ms))
]);

let settings = {};
let current = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setStatus(text, type = '') {
  const box = $('status');
  box.hidden = !text;
  box.className = 'status' + (type ? ' ' + type : '');
  box.textContent = text || '';
}

function renderTrace(trace) {
  const box = $('trace');
  box.replaceChildren();
  if (!trace || !trace.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const t of trace) {
    const line = el('div', t.ok ? 'ok' : 'no');
    line.textContent = `${t.ok ? '✓' : '✗'} ${t.label || t.channel} · ${t.ms}ms${t.error ? ' · ' + t.error : ''}${t.parser ? ' [' + t.parser + ']' : ''}`;
    box.appendChild(line);
  }
}

function safeName(s) {
  return String(s || 'video').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function fileNameFor(result, f) {
  const ext = /^(mp4|m4v|webm|mov|m3u8|flv|jpg|png|webp|m4a|mp3)$/.test(f.ext) ? f.ext : 'mp4';
  return safeName(result.title) + (f.label && !/推荐|默认|候选/.test(f.label) ? ' - ' + safeName(f.label) : '') + '.' + ext;
}

function formatRow(f, result, index) {
  const row = el('div', 'fmt');
  const label = el('div', 'fmt-label');
  label.appendChild(el('span', 'l', f.label || `画质 ${index + 1}`));
  label.appendChild(el('span', 's', f.note || (f.url.length > 46 ? f.url.slice(0, 46) + '…' : f.url)));
  row.appendChild(label);

  const copy = el('button', 'mini', '复制链接');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(f.url);
      copy.textContent = '已复制';
      setTimeout(() => { copy.textContent = '复制链接'; }, 1400);
    } catch { setStatus('复制失败，请手动选择结果中的地址', 'error'); }
  };

  const isHls = f.ext === 'm3u8';
  const dl = el('button', 'mini solid', isHls && settings.useYtdlp ? 'yt-dlp 下载' : '下载');
  dl.onclick = async () => {
    if (isHls && settings.useYtdlp) {
      dl.disabled = true; dl.textContent = '…';
      const r = await send({ type: 'downloadLocal', url: f.url });
      dl.disabled = false; dl.textContent = 'yt-dlp 下载';
      setStatus(r?.ok ? '已交给本地 yt-dlp 下载并合并' : 'yt-dlp：' + (r?.error || '未就绪'), r?.ok ? 'success' : 'error');
      return;
    }
    if (isHls) {
      setStatus('这是 HLS 清单文件（.m3u8），直接下载无法播放；请在设置页启用本地 yt-dlp', 'error');
      return;
    }
    dl.disabled = true; dl.textContent = '下载中…';
    const r = await send({
      type: 'download',
      url: f.url,
      filename: fileNameFor(result, f),
      headers: f.headers || [],
      title: result.title,
      source: result.sourceLabel,
      pageUrl: result.pageUrl
    });
    dl.disabled = false; dl.textContent = '下载';
    if (r?.ok) {
      if (r.mode === 'native') {
        setStatus(`✓ 已由本机下载并保存：${r.path || fileNameFor(result, f)}`, 'success');
      } else {
        const extra = r.mode === 'blob' ? '（兼容模式，已绕过防盗链）' : '';
        setStatus(`已开始下载：${fileNameFor(result, f)} ${extra}`, 'success');
      }
      loadHistory();
    } else {
      setStatus('下载失败：' + (r?.error || '未知错误') + '，可换其它画质、复制链接或启用 yt-dlp', 'error');
    }
  };
  row.appendChild(copy);
  row.appendChild(dl);

  if (settings.useYtdlp && result.source !== 'ytdlp') {
    const local = el('button', 'mini', 'yt-dlp 合并');
    local.title = '交给本地 yt-dlp 下载并自动合并音视频（适合 YouTube/B站高画质）';
    local.onclick = async () => {
      local.disabled = true; local.textContent = '…';
      const r = await send({ type: 'downloadLocal', url: result.pageUrl || f.url });
      local.disabled = false; local.textContent = 'yt-dlp 合并';
      setStatus(r?.ok ? '已交给本地 yt-dlp 下载' : 'yt-dlp：' + (r?.error || '未就绪'), r?.ok ? 'success' : 'error');
    };
    row.appendChild(local);
  }
  return row;
}

function renderResult(r) {
  current = r;
  const box = $('result');
  box.hidden = false;
  $('rTitle').textContent = r.title || '未命名视频';
  $('rAuthor').textContent = r.author || '';
  const cover = $('cover');
  if (r.cover) { cover.src = r.cover; cover.style.display = ''; }
  else { cover.removeAttribute('src'); cover.style.display = 'none'; }
  $('rNotes').textContent = (r.notes || []).join(' ');
  $('rNotes').classList.toggle('weak', !!r.weak);
  $('rSource').classList.toggle('weak', !!r.weak);
  $('rSource').textContent = (r.sourceLabel || r.source || '') + (r.weak ? ' · 兜底结果，可能不是视频' : '');

  const list = $('formatList');
  list.replaceChildren();
  (r.formats || []).forEach((f, i) => list.appendChild(formatRow(f, r, i)));

  const extras = r.extras || [];
  $('extraWrap').hidden = !extras.length;
  const elist = $('extraList');
  elist.replaceChildren();
  extras.slice(0, 12).forEach((x, i) => elist.appendChild(formatRow({
    label: x.label || `素材 ${i + 1}`, url: x.url, ext: (x.url.split('?')[0].match(/\.(\w{3,4})$/) || [])[1] || 'jpg'
  }, { ...r, title: `${r.title} ${i + 1}` }, i)));

  renderTrace(r.trace);
}

async function parse(urlText, auto = false) {
  const raw = (urlText || $('urlInput').value || '').trim();
  if (!raw) { setStatus('请先粘贴视频链接', 'error'); return; }
  $('urlInput').value = raw;
  $('parseBtn').disabled = true;
  setStatus('正在解析，依次尝试各通道…');
  $('result').hidden = true;
  $('trace').hidden = true;
  try {
    const r = await send({ type: 'resolve', url: raw });
    if (!r?.ok) {
      setStatus(r?.error || '解析失败', 'error');
      renderTrace(r?.trace);
      return;
    }
    if (r.weak) {
      setStatus('⚠️ 只拿到网页内嵌素材，可能不是目标视频。请在设置页确认「RC 全平台解析」已开启后重新解析', 'error');
    } else {
      setStatus(auto ? '已从剪贴板识别链接并解析成功' : `解析成功 · ${r.formats.length} 个可用文件`, 'success');
    }
    renderResult(r);
  } catch (e) {
    setStatus('解析异常：' + (e.message || e), 'error');
  } finally {
    $('parseBtn').disabled = false;
  }
}

async function loadHistory() {
  try {
    const { history = [] } = await send({ type: 'getHistory' });
    const box = $('historyWrap');
    const list = $('historyList');
    list.replaceChildren();
    if (!history.length) { box.hidden = true; return; }
    box.hidden = false;
    for (const h of history.slice(0, 4)) {
      const row = el('div', 'history-item');
      row.appendChild(el('span', '', h.title || h.url));
      const again = el('button', 'mini', '重新解析');
      again.onclick = () => { $('urlInput').value = h.url; parse(h.url); };
      row.appendChild(again);
      const del = el('button', 'mini del', '删除');
      del.title = '从下载列表中删除这一条';
      del.onclick = async () => {
        del.disabled = true; del.textContent = '…';
        const r = await send({ type: 'deleteHistory', at: h.at, url: h.url });
        if (r?.ok) loadHistory();
        else { del.disabled = false; del.textContent = '删除'; setStatus('删除失败：' + (r?.error || '未知'), 'error'); }
      };
      row.appendChild(del);
      list.appendChild(row);
    }
  } catch { /* 忽略 */ }
}

async function init() {
  settings = await send({ type: 'getSettings' }).catch(() => ({})) || {};

  $('parseBtn').onclick = () => parse();
  $('urlInput').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') parse();
  });
  $('pasteBtn').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) { $('urlInput').value = t.trim(); parse(t.trim()); }
      else setStatus('剪贴板是空的', 'error');
    } catch (e) {
      setStatus('无法读取剪贴板，请用 ⌘V 粘贴到输入框', 'error');
    }
  };
  $('grabBtn').onclick = async () => {
    setStatus('正在嗅探当前页面…');
    const r = await send({ type: 'grabPage' });
    if (!r?.ok || !r.media?.length) {
      setStatus('当前页面没有发现可直接使用的视频直链' + (r?.error ? ' · ' + r.error : ''), 'error');
      return;
    }
    setStatus(`在当前页面找到 ${r.media.length} 个媒体地址`, 'success');
    renderResult({
      title: r.title || '当前页面媒体', sourceLabel: '页面嗅探', pageUrl: r.url,
      formats: r.media.map((u, i) => ({ label: `媒体 ${i + 1}`, url: u, ext: (u.split('?')[0].match(/\.(\w{3,4})$/) || [])[1] || 'mp4' })),
      extras: [], notes: []
    });
  };
  $('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
  $('clearBtn').onclick = async () => {
    const r = await send({ type: 'clearHistory' });
    if (r?.ok) { loadHistory(); setStatus('已清空下载列表', 'success'); }
    else setStatus('清空失败：' + (r?.error || '未知'), 'error');
  };

  // 清空输入框（解析内容），不动「最近下载」列表
  $('clearInputBtn').onclick = () => {
    $('urlInput').value = '';
    $('result').hidden = true;
    $('trace').hidden = true;
    setStatus('');
    $('clearInputBtn').hidden = true;
    send({ type: 'clearPending' });
    $('urlInput').focus();
  };
  $('urlInput').addEventListener('input', () => {
    $('clearInputBtn').hidden = !$('urlInput').value.trim();
  });

  // 1) 右键 / 快捷键刚刚解析过 → 直接展示结果
  const pending = await send({ type: 'getPending' }).catch(() => ({})) || {};
  if (pending.lastResult?.ok && pending.pendingAt && Date.now() - pending.pendingAt < 15 * 60 * 1000) {
    $('urlInput').value = pending.pendingUrl || '';
    setStatus('来自右键/快捷键的解析结果', 'success');
    renderResult(pending.lastResult);
    await send({ type: 'clearPending' });
  } else if (settings.autoPaste) {
    // 2) 剪贴板里有链接 → 自动填入并解析（贴近 iOS 快捷指令的体验）
    try {
      const t = (await navigator.clipboard.readText() || '').trim();
      if (/https?:\/\//i.test(t)) {
        $('urlInput').value = t;
        await parse(t, true);
      }
    } catch { /* 无用户手势时浏览器可能拒绝，用户点「粘贴剪贴板」即可 */ }
  }
  loadHistory();
  $('clearInputBtn').hidden = !$('urlInput').value.trim();
}

init();
