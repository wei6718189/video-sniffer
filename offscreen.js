/**
 * Video Sniffer · Offscreen Document
 * ------------------------------------------------------------------
 * MV3 的 service worker 没有 DOM，无法调用 URL.createObjectURL；
 * 这里用一个隐藏页面在真实页面上下文里带合法 referrer 抓取视频，
 * 生成 blob: URL 交给 chrome.downloads 保存。
 * 浏览器会自动带上原生 User-Agent，这是 CDN 防盗链最关键的一条。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'fetchBlobDownload') return;

  (async () => {
    const headers = {};
    for (const h of msg.headers || []) {
      if (h && h.name && h.value != null) headers[h.name] = String(h.value);
    }
    const init = {
      method: 'GET',
      headers,
      credentials: 'omit',
      redirect: 'follow'
    };
    if (msg.referrer) {
      init.referrer = msg.referrer;
      init.referrerPolicy = 'unsafe-url';
    } else {
      init.referrerPolicy = 'no-referrer';
    }

    let res;
    try {
      res = await fetch(msg.url, init);
    } catch (e) {
      // 少数版本不接受自定义 referrer：退回去掉 referrer 重试（UA 仍是浏览器原生）
      delete init.referrer;
      delete init.referrerPolicy;
      res = await fetch(msg.url, init);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) throw new Error(`CDN 返回 HTTP ${res.status}`);
    if (/text\/html|application\/json|text\/plain|text\/xml/.test(ct)) {
      throw new Error(`返回的不是视频而是网页（${ct || '未知类型'}），防盗链未通过`);
    }

    const blob = await res.blob();
    if (blob.size < 1024) throw new Error(`文件过小（${blob.size} 字节），疑似错误页`);
    const objectUrl = URL.createObjectURL(blob);
    // 下载启动后数据已被浏览器接管，延迟回收 URL
    setTimeout(() => URL.revokeObjectURL(objectUrl), 3 * 60 * 1000);

    if (chrome.downloads && chrome.downloads.download) {
      const id = await chrome.downloads.download({
        url: objectUrl,
        filename: msg.filename,
        conflictAction: 'uniquify',
        saveAs: !!msg.saveAs
      });
      return { ok: true, downloadId: id, size: blob.size, mode: 'blob' };
    }
    // 极少数版本在 offscreen 中不暴露 downloads：把 blob URL 交回 SW 兜底
    return { ok: true, objectUrl, filename: msg.filename, size: blob.size, mode: 'blob' };
  })()
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: e.message || String(e) }));

  return true; // 异步 sendResponse
});
