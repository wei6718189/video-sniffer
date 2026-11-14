/* Video Sniffer · 设置页 */
'use strict';

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
const FIELDS = [
  'useBuiltin', 'useRcuts', 'useCustom', 'useCobalt', 'useYtdlp',
  'rcutsConfig', 'rcutsClient',
  'customApi', 'customMethod', 'customBody',
  'cobaltUrl', 'cobaltQuality',
  'downloadDir', 'historyLimit', 'quickDownload', 'autoPaste', 'useNativeDownload'
];
const SWITCHES = ['useBuiltin', 'useRcuts', 'useCustom', 'useCobalt', 'useYtdlp', 'useNativeDownload'];

function msg(text, kind = '') {
  const m = $('msg');
  m.textContent = text;
  m.className = kind;
}

function syncBodies() {
  const map = {
    useBuiltin: 'body-builtin', useRcuts: 'body-rcuts', useCustom: 'body-custom',
    useCobalt: 'body-cobalt', useYtdlp: 'body-ytdlp'
  };
  for (const [k, id] of Object.entries(map)) {
    $(id).classList.toggle('off', !$(k).checked);
  }
}

function collect() {
  const out = {};
  for (const f of FIELDS) {
    const n = $(f);
    out[f] = n.type === 'checkbox' ? n.checked :
      f === 'historyLimit' ? Math.max(0, parseInt(n.value || '20', 10)) : n.value.trim();
  }
  return out;
}

async function save(silent = false) {
  const r = await send({ type: 'saveSettings', settings: collect() });
  if (!silent) msg(r?.ok ? '✓ 设置已保存' : '保存失败：' + (r?.error || ''), r?.ok ? 'ok' : 'err');
  return r?.ok;
}

async function init() {
  const s = await send({ type: 'getSettings' });
  for (const f of FIELDS) {
    const n = $(f);
    if (!n) continue;
    if (n.type === 'checkbox') n.checked = !!s[f];
    else n.value = s[f] !== undefined ? s[f] : '';
  }
  syncBodies();

  const id = chrome.runtime.id;
  $('extId').textContent = id;
  $('installCmd').textContent = `bash install.sh ${id}`;

  for (const k of SWITCHES) $(k).addEventListener('change', syncBodies);

  $('saveBtn').onclick = () => save();
  $('copyId').onclick = async () => {
    await navigator.clipboard.writeText(id);
    msg('✓ 扩展 ID 已复制', 'ok');
  };

  $('grantPerm').onclick = async () => {
    try {
      const ok = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
      msg(ok ? '✓ 已授权，现在可以测试桥接；视频下载会优先走本机原生下载' : '未授权，本机原生下载与 yt-dlp 通道将不可用', ok ? 'ok' : 'err');
    } catch (e) { msg('授权失败：' + e.message, 'err'); }
  };

  const test = async (channel, label) => {
    await save(true);
    msg('正在测试 ' + label + ' …');
    try {
      const r = await send({ type: 'pingChannel', channel });
      if (r?.ok) {
        const detail = r.formats ? `${r.formats.length} 个画质` : (r.body || '').slice(0, 80);
        msg(`✓ ${label} 可用 ${detail ? '· ' + detail : ''}`, 'ok');
      } else {
        const trace = (r?.trace || []).map(t => `${t.ok ? '✓' : '✗'}${t.label}`).join(' / ');
        msg(`✗ ${label}：${r?.error || r?.body || '无结果'} ${trace}`, 'err');
      }
    } catch (e) { msg('✗ 测试异常：' + e.message, 'err'); }
  };

  $('testBuiltin').onclick = () => test('builtin', '内置解析');
  $('testRcuts').onclick = () => test('rcuts', 'RC 全平台解析');
  $('testCustom').onclick = () => test('custom', '自定义接口');
  $('testCobalt').onclick = () => test('cobalt', 'Cobalt 实例');
  $('testYtdlp').onclick = () => test('ytdlp', '本机桥接');
}

init();
