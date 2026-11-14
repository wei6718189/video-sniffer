#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Video Sniffer · Native Messaging Host (macOS / Linux)
----------------------------------------------------
Chrome/Edge 通过 stdin/stdout（4 字节小端长度前缀 + JSON）与本机通信。

支持 action:
  ping    -> 检查桥接是否可用（不要求装 yt-dlp），附带 yt-dlp 状态
  fetch   -> 【推荐】本机直接下载一条视频直链，可设置任意请求头
             （含 User-Agent / Referer，这是浏览器扩展做不到的）
  resolve -> yt-dlp -j 拿元数据（需要 yt-dlp）
  download-> yt-dlp 下载并合并音视频（需要 yt-dlp）

注意：绝对不要向 stdout 打印日志，否则会破坏 Native Messaging 协议。
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.request

HOST_NAME = "com.vsniffer.ytdlp"


def log(text):
    sys.stderr.write("[vsniffer] %s\n" % text)
    sys.stderr.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    if length <= 0 or length > 10 * 1024 * 1024:
        return None
    payload = sys.stdin.buffer.read(length)
    if len(payload) < length:
        return None
    return json.loads(payload.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def ytdlp_cmd():
    candidates = [
        "yt-dlp",
        os.path.expanduser("~/.local/bin/yt-dlp"),
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
    ]
    for c in candidates:
        if os.path.isabs(c):
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return [c]
        else:
            found = shutil.which(c)
            if found:
                return [found]
    return None


def run(cmd, timeout):
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def safe_filename(name):
    name = os.path.basename(str(name or "").replace("\\", "/"))
    name = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "_", name).strip().strip(".")
    if not name:
        name = "video.mp4"
    if not re.search(r"\.[a-z0-9]{2,5}$", name, re.I):
        name += ".mp4"
    return name[:150]


def unique_path(folder, name):
    path = os.path.join(folder, name)
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(name)
    for i in range(1, 1000):
        candidate = os.path.join(folder, "%s (%d)%s" % (stem, i, ext))
        if not os.path.exists(candidate):
            return candidate
    return path


def handle_fetch(request):
    """本机带完整请求头下载一条直链 —— 与快捷指令的能力完全一致。"""
    url = str(request.get("url") or "")
    if not re.match(r"^https?://", url, re.I):
        return {"ok": False, "error": "缺少有效的直链地址"}

    folder = os.path.expanduser("~/Downloads")
    sub = str(request.get("dir") or "VideoSniffer").replace("/", "_").replace("\\", "_").strip(".")
    folder = os.path.join(folder, sub or "VideoSniffer")
    os.makedirs(folder, exist_ok=True)
    path = unique_path(folder, safe_filename(request.get("filename") or "video.mp4"))

    # 解析服务返回的 d_headers 会原样带来（Referer / User-Agent / dnt 等）
    headers = {}
    for h in request.get("headers") or []:
        if isinstance(h, dict) and h.get("name") and h.get("value") is not None:
            headers[str(h["name"])] = str(h["value"])
    if request.get("referer") and not any(k.lower() == "referer" for k in headers):
        headers["Referer"] = str(request["referer"])
    headers.setdefault("Accept", "*/*")

    req = urllib.request.Request(url, headers=headers, method="GET")
    tmp = path + ".part"
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            ct = (resp.headers.get("Content-Type") or "").lower()
            status = getattr(resp, "status", 200) or 200
            if status >= 400 or "text/html" in ct or "application/json" in ct:
                return {"ok": False, "error": "CDN 拒绝访问（HTTP %s / %s），防盗链未通过" % (status, ct or "未知类型")}
            with open(tmp, "wb") as f:
                shutil.copyfileobj(resp, f, length=1024 * 1024)
        size = os.path.getsize(tmp)
        if size < 1024:
            os.remove(tmp)
            return {"ok": False, "error": "下载内容过小（%d 字节），疑似错误页" % size}
        os.replace(tmp, path)
        return {"ok": True, "path": path, "size": size}
    except Exception as exc:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return {"ok": False, "error": str(exc)[:300]}
    finally:
        pass


def handle_ping(cmd):
    reply = {"ok": True, "host": HOST_NAME, "python": sys.version.split()[0],
             "ytdlp": bool(cmd)}
    if cmd:
        try:
            r = run(cmd + ["--version"], 15)
            reply["version"] = (r.stdout or "").strip() if r.returncode == 0 else ""
        except Exception as exc:
            reply["version"] = ""
            reply["ytdlp_warning"] = str(exc)[:100]
    return reply


def handle_resolve(cmd, url, timeout):
    r = run(cmd + ["-j", "--no-warnings", "--no-playlist", url], timeout)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or r.stdout).strip()[-500:] or "yt-dlp 解析失败"}
    line = ""
    for ln in r.stdout.splitlines():
        if ln.strip().startswith("{"):
            line = ln.strip()
            break
    if not line:
        return {"ok": False, "error": "yt-dlp 未返回 JSON 元数据"}
    info = json.loads(line)
    formats = []
    for f in info.get("formats") or []:
        if not f.get("url"):
            continue
        label = f.get("format_note") or ("%sP" % f["height"] if f.get("height") else f.get("ext") or "默认")
        label += " · %s" % (f.get("ext") or "mp4")
        label += " · 含音频" if f.get("acodec") not in (None, "none") else " · 纯画面"
        formats.append({
            "label": label,
            "url": f["url"],
            "ext": f.get("ext") or "mp4",
            "headers": [],
        })
    return {"ok": bool(formats), "title": info.get("title") or "",
            "author": info.get("uploader") or "", "formats": formats}


def handle_download(cmd, url, subdir):
    folder = os.path.join(os.path.expanduser("~/Downloads"), subdir or "VideoSniffer")
    os.makedirs(folder, exist_ok=True)
    out = os.path.join(folder, "%(title).100s.%(ext)s")
    r = run(cmd + ["--no-playlist", "--no-warnings", "-f", "bv*+ba/b",
                    "--merge-output-format", "mp4", "-o", out, url], 900)
    if r.returncode == 0:
        return {"ok": True, "path": folder}
    return {"ok": False, "error": (r.stderr or r.stdout).strip()[-500:] or "yt-dlp 下载失败"}


def main():
    request = read_message()
    if not request:
        send_message({"ok": False, "error": "无效的请求"})
        return
    action = request.get("action", "ping")
    try:
        if action == "fetch":
            reply = handle_fetch(request)
        elif action == "ping":
            reply = handle_ping(ytdlp_cmd())
        else:
            cmd = ytdlp_cmd()
            if not cmd:
                reply = {"ok": False,
                         "error": "找不到 yt-dlp（仅 resolve/download 需要）；brew install yt-dlp 或 pip3 install -U yt-dlp"}
            elif action == "resolve":
                reply = handle_resolve(cmd, request.get("url", ""), int(request.get("timeout", 120)))
            elif action == "download":
                reply = handle_download(cmd, request.get("url", ""), request.get("dir"))
            else:
                reply = {"ok": False, "error": "未知 action: %s" % action}
    except subprocess.TimeoutExpired:
        reply = {"ok": False, "error": "执行超时"}
    except Exception as exc:
        log("exception: %r" % exc)
        reply = {"ok": False, "error": str(exc)[:300]}
    send_message(reply)


if __name__ == "__main__":
    main()
