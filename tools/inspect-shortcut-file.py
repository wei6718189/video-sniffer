#!/usr/bin/env python3
"""从 macOS「快捷指令」导出文件里挖出它调用的解析接口地址。

支持三类输入：
  1. 旧式 / 未签名的 plist（.shortcut / .plist / .wflow）
  2. Apple 签名档案 AEA1（macOS 快捷指令「文件 > 导出」生成的 .shortcut）——
     自动从容器内证书提取公钥，调用系统自带的 aea + aa 解包
  3. 兜底：直接在原始字节里正则扫 http(s) 地址

用法：
  python3 inspect-shortcut-file.py ~/Downloads/全网VIP视频解析.shortcut
  python3 inspect-shortcut-file.py "*.shortcut" --json
  python3 inspect-shortcut-file.py 文件 --all      # 连平台域名一起列出

只读输入文件，临时产物写系统临时目录并在结束时清理。
"""

import argparse
import glob
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

# 只接受 URL 合法字符，避免在二进制 plist / 压缩数据里扫出乱码
URL_CHARS = rb"[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%\-]"
URL_B = re.compile(rb"https?://" + URL_CHARS + rb"+", re.I)
URL_S = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%\-]+", re.I)

# 疑似解析接口的特征
API_HINT = re.compile(
    r"(api|/parse|/jx|jiexi|/vip|/resolve|/down|/get_video|/v\d/|/video/|/analysis)",
    re.I,
)
# 常见的「被解析平台」域名，用于把噪音折叠掉
PLATFORM = re.compile(
    r"(douyin|iesdouyin|snssdk|bilibili|b23\.tv|weibo|twitter|x\.com|tiktok|"
    r"youtube|youtu\.be|kuaishou|qq\.com|weixin|apple\.com|icloud\.com|"
    r"icloud-content|mzstatic|schema\.org|w3\.org|shortcuts|workflow\.is)",
    re.I,
)
PARAM_KEYS = {
    "WFURLActionURL", "WFURL", "WFHTTPMethod", "WFHTTPHeaders",
    "WFHTTPBody", "WFDictionaryKey", "WFWorkflowActionIdentifier",
    "WFInputVariable", "WFTextActionText",
}


def clean(u):
    return u.rstrip(".,;:)\"'>]}").strip()


def walk(node, path, urls, params):
    """递归遍历 plist，收集 URL 与关键请求参数。"""
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}" if path else str(k)
            if k in PARAM_KEYS and isinstance(v, (str, int, float, dict, list)):
                params.setdefault(str(k), []).append({"at": p, "value": v})
            walk(v, p, urls, params)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]", urls, params)
    elif isinstance(node, str):
        for m in URL_S.finditer(node):
            urls.append({"url": clean(m.group(0)), "at": path, "origin": "plist"})
    elif isinstance(node, bytes):
        for m in URL_B.finditer(node):
            urls.append({"url": clean(m.group(0).decode("utf-8", "ignore")), "at": path, "origin": "plist"})
    elif isinstance(node, (int, float)):
        pass


def scan_raw(data, label, urls):
    """兜底：不管什么格式，直接从字节流里搜 URL。"""
    for m in URL_B.finditer(data):
        try:
            u = clean(m.group(0).decode("utf-8", "ignore"))
        except Exception:
            continue
        if u.startswith("http"):
            urls.append({"url": u, "at": label + " (原始字节)", "origin": "raw"})


def try_plist(data):
    """尝试把数据当 plist 解析，返回对象或 None。"""
    for candidate in (data,):
        try:
            return plistlib.loads(candidate)
        except Exception:
            pass
    idx = data.find(b"bplist00")
    if idx >= 0:
        for end in (len(data),):
            try:
                return plistlib.loads(data[idx:end])
            except Exception:
                pass
    try:
        return plistlib.loads(data, fmt=plistlib.FMT_XML)
    except Exception:
        return None


def candidate_pubkeys(data):
    """从 AEA 容器（含 auth data 里的证书链）里找出可用的验签公钥。"""
    seen = set()
    # 1) 直接找 DER 编码的 X.509 证书：30 82 LL LL ...
    for m in re.finditer(b"\x30\x82", data):
        s = m.start()
        if s + 4 > len(data):
            continue
        ln = int.from_bytes(data[s + 2:s + 4], "big")
        if not (200 < ln < 8000) or s + 4 + ln > len(data):
            continue
        cert = data[s:s + 4 + ln]
        try:
            p = subprocess.run(
                ["openssl", "x509", "-inform", "DER", "-pubkey", "-noout"],
                input=cert, capture_output=True, timeout=5,
            )
        except Exception:
            continue
        pub = p.stdout
        if p.returncode == 0 and b"BEGIN PUBLIC KEY" in pub and pub not in seen:
            seen.add(pub)
            yield pub
    # 2) auth data 是 binary plist，里面的 NSData 也可能是证书
    for m in list(re.finditer(b"bplist00", data[:400000]))[:20]:
        s = m.start()
        obj = try_plist(data[s:])
        if obj is None:
            continue

        def collect(o):
            if isinstance(o, bytes):
                try:
                    p = subprocess.run(
                        ["openssl", "x509", "-inform", "DER", "-pubkey", "-noout"],
                        input=o, capture_output=True, timeout=5,
                    )
                    if p.returncode == 0 and p.stdout not in seen:
                        seen.add(p.stdout)
                        yield p.stdout
                except Exception:
                    return
            elif isinstance(o, dict):
                for v in o.values():
                    yield from collect(v)
            elif isinstance(o, list):
                for v in o:
                    yield from collect(v)

        yield from collect(obj)


def aea_extract(path, data, tmp):
    """解开 AEA1 签名档案，返回 [(文件名, 字节内容)]。"""
    if not data.startswith(b"AEA1"):
        return None, "非 AEA1 格式"
    if not shutil.which("aea") or not shutil.which("aa"):
        return None, "缺少系统命令 aea / aa（需 macOS 12+）"
    aar = os.path.join(tmp, "payload.aar")
    outdir = os.path.join(tmp, "extracted")
    os.makedirs(outdir, exist_ok=True)
    pubpath = os.path.join(tmp, "sign-pub.pem")

    tried = 0
    ok = False
    for pub in candidate_pubkeys(data):
        tried += 1
        with open(pubpath, "wb") as f:
            f.write(pub)
        try:
            subprocess.run(
                ["aea", "decrypt", "-i", path, "-o", aar, "-sign-pub", pubpath],
                capture_output=True, timeout=30,
            )
        except Exception:
            continue
        if os.path.exists(aar) and os.path.getsize(aar) > 0:
            ok = True
            break
    if not ok:
        return None, f"AEA 验签未通过（试过 {tried} 个容器证书），该文件可能被重新签名或使用了新版容器格式"

    subprocess.run(
        ["aa", "extract", "-i", aar, "-d", outdir],
        capture_output=True, timeout=30,
    )
    files = []
    for root, _, names in os.walk(outdir):
        for n in names:
            fp = os.path.join(root, n)
            try:
                if os.path.getsize(fp) < 20 * 1024 * 1024:
                    files.append((os.path.relpath(fp, outdir), open(fp, "rb").read()))
            except OSError:
                continue
    if not files:
        files.append(("payload.aar", open(aar, "rb").read()))
    return files, f"AEA1 → aea decrypt (验签成功) → aa extract，{len(files)} 个内部文件"


def analyze(path):
    with open(path, "rb") as f:
        data = f.read()
    urls, params, notes = [], {}, []
    tmp = tempfile.mkdtemp(prefix="vs-shortcut-")
    try:
        payloads = None
        if data.startswith(b"AEA1"):
            payloads, note = aea_extract(path, data, tmp)
            notes.append(note)
            if payloads is None:
                notes.append("AEA 解包失败，改为扫描原始字节（可能读不到完整地址）")
        else:
            obj = try_plist(data)
            if obj is not None:
                payloads = [("plist", data)]
                notes.append("按 plist 解析")
            else:
                notes.append("非 plist / 非 AEA1，按原始字节扫描")

        if payloads:
            for name, raw in payloads:
                obj = try_plist(raw)
                if obj is not None:
                    walk(obj, name, urls, params)
                # 无论能否完整解析，都扫一遍字节，防止 URL 在二进制片段里
                scan_raw(raw, name, urls)
        scan_raw(data, "原始文件", urls)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 去重：优先保留解包后 plist 的结构化结果，其次保留位置更短（更上层）的
    dedup = {}

    def score(i):
        return (0 if i.get("origin") == "plist" else 1, len(i["at"]))

    for item in urls:
        u = item["url"]
        if not u:
            continue
        if u not in dedup or score(item) < score(dedup[u]):
            dedup[u] = item
    items = list(dedup.values())

    structured = [i for i in items if i.get("origin") == "plist"]
    fragments = [i for i in items if i.get("origin") == "raw"]
    # 解包成功时，字节片段往往是截断/粘连的，单独存放，不污染主结果
    base = structured if structured else fragments

    def is_api(u):
        host = u.split("/")[2] if "://" in u and len(u.split("/")) > 2 else ""
        return bool(API_HINT.search(u)) and not PLATFORM.search(host)

    api = sorted((i for i in base if is_api(i["url"])), key=lambda x: x["url"])
    other = sorted((i for i in base if not is_api(i["url"])), key=lambda x: x["url"])
    return {
        "file": os.path.abspath(path),
        "size": len(data),
        "notes": notes,
        "api_candidates": api,
        "other_urls": other,
        "raw_fragments": fragments if structured else [],
        "params": params,
    }


def show(r, show_all):
    print(f"\n文件: {r['file']}  ({r['size']} 字节)")
    for n in r["notes"]:
        print(f"  解码: {n}")
    print("\n  ★ 疑似解析接口")
    if r["api_candidates"]:
        for i in r["api_candidates"]:
            print(f"    {i['url']}")
            print(f"      位置: {i['at']}")
    else:
        print("    （没找到，往下看「其他 URL」，或改用编辑器 / 数据库脚本）")
    if show_all and r["other_urls"]:
        print("\n  其他 URL")
        for i in r["other_urls"]:
            print(f"    {i['url']}  ← {i['at']}")
    elif r["other_urls"]:
        print(f"  （另有 {len(r['other_urls'])} 个非接口 URL，加 --all 查看）")
    if show_all and r.get("raw_fragments"):
        print("\n  字节片段（可能截断，仅供参考）")
        for i in r["raw_fragments"][:12]:
            print(f"    {i['url']}")
    if r["params"]:
        print("\n  请求参数（判断 GET/POST、token 用）")
        for k, vals in r["params"].items():
            if k == "WFWorkflowActionIdentifier":
                continue
            for v in vals[:4]:
                print(f"    {k} = {v['value']!r}   ← {v['at']}")
    print("\n  提示：带 ★ 的通常就是解析接口。地址里若含魔法变量（Clipboard / ShortcutInput），")
    print("  把那一段替换成 {url} 后，填进 Video Sniffer 设置页的「自定义解析 API」即可。")


def main():
    ap = argparse.ArgumentParser(description="从快捷指令导出文件提取解析接口")
    ap.add_argument("files", nargs="+", help="一个或多个 .shortcut / .plist 文件（支持通配符）")
    ap.add_argument("--json", action="store_true", help="输出 JSON（便于贴给助手）")
    ap.add_argument("--all", action="store_true", help="同时列出平台域名等非接口 URL")
    args = ap.parse_args()

    paths = []
    for pat in args.files:
        hits = sorted(glob.glob(os.path.expanduser(pat)))
        paths.extend(hits if hits else [os.path.expanduser(pat)])

    results = []
    for p in paths:
        if not os.path.isfile(p):
            print(f"跳过（文件不存在）: {p}", file=sys.stderr)
            continue
        try:
            results.append(analyze(p))
        except Exception as e:
            print(f"解析失败 {p}: {e}", file=sys.stderr)

    if not results:
        print("没有可解析的文件。", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2, default=str))
    else:
        for r in results:
            show(r, args.all)


if __name__ == "__main__":
    main()
