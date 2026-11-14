#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
find-shortcut-api.py —— 找出 macOS 快捷指令里调用的「视频解析接口地址」

只读，绝不修改快捷指令或数据库。

用法:
    python3 find-shortcut-api.py                    # 列出所有快捷指令里的网络地址
    python3 find-shortcut-api.py --match 抖音       # 只看名字含「抖音」的快捷指令
    python3 find-shortcut-api.py --json             # 输出 JSON，便于进一步处理

前置条件（只需做一次）:
    系统设置 → 隐私与安全性 → 完全磁盘访问 → 打开「终端」（或你用的终端 App）开关
    然后完全退出并重新打开终端，再运行本脚本。
    原因: ~/Library/Shortcuts/Shortcuts.sqlite 受 macOS TCC 保护。

原理:
    快捷指令的动作定义存在 Shortcuts.sqlite 的 ZSHORTCUTACTIONS.ZDATA，
    是一个 binary plist；递归扫描其中的字符串即可拿到「URL」「获取 URL 内容」
    动作里写的完整接口地址（含 token、请求体、请求头）。
"""
import argparse
import base64
import json
import os
import plistlib
import re
import sqlite3
import sys

DEFAULT_DB = os.path.expanduser("~/Library/Shortcuts/Shortcuts.sqlite")
URL_RE = re.compile(r"https?://[^\s\"'<>\\\)\]\}）】]+", re.I)
NET_HINT = re.compile(r"geturlcontents|downloadurl|url|request|api|http", re.I)
NOISE = re.compile(r"support\.apple\.com|apple\.com/(guide|shortcuts)|icloud\.com/shortcuts|schema", re.I)


def walk(node, out, path="", depth=0):
    """递归收集所有字符串及其在 plist 里的键路径"""
    if depth > 14:
        return
    if isinstance(node, str):
        out.append((path, node))
    elif isinstance(node, dict):
        for k, v in node.items():
            walk(v, out, (path + "." if path else "") + str(k), depth + 1)
    elif isinstance(node, (list, tuple)):
        for i, v in enumerate(node):
            walk(v, out, f"{path}[{i}]", depth + 1)
    elif isinstance(node, bytes):
        try:
            walk(plistlib.loads(node), out, path + ".plist", depth + 1)
        except Exception:
            pass


def maybe_decode_b64(s):
    """有些快捷指令会把接口地址 base64 藏起来"""
    if len(s) > 24 and len(s) % 4 == 0 and re.fullmatch(r"[A-Za-z0-9+/=]+", s):
        try:
            d = base64.b64decode(s).decode("utf-8", "ignore")
            if "http" in d:
                return d
        except Exception:
            pass
    return None


def extract_from_blob(blob):
    try:
        data = plistlib.loads(blob)
    except Exception:
        return []
    strings = []
    walk(data, strings)
    found = []
    seen = set()
    for path, text in strings:
        candidates = list(URL_RE.findall(text))
        decoded = maybe_decode_b64(text.strip())
        if decoded:
            candidates += URL_RE.findall(decoded)
        for u in candidates:
            u = u.rstrip(".,;:'\"")
            if NOISE.search(u) or u in seen:
                continue
            seen.add(u)
            action = ""
            m = re.search(r"WFWorkflowActionIdentifier[:.]([^.\[]+)", path)
            if m:
                action = m.group(1)
            found.append({
                "action": action or (path.split(".")[0] if path else ""),
                "key": path.split(".")[-1],
                "url": u,
                "network_action": bool(NET_HINT.search(path))
            })
    return found


def main():
    ap = argparse.ArgumentParser(description="提取 macOS 快捷指令里的解析接口地址")
    ap.add_argument("--match", default="", help="只处理名称包含该关键词的快捷指令")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--db", default=DEFAULT_DB, help="数据库路径（默认读本机快捷指令库）")
    args = ap.parse_args()

    db = os.path.expanduser(args.db)
    if not os.path.exists(db):
        print(f"找不到数据库：{db}\n请确认这台 Mac 上装了「快捷指令」并至少创建过一个快捷指令。", file=sys.stderr)
        sys.exit(1)

    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    except sqlite3.Error as e:
        print(f"无法读取数据库：{e}\n\n→ 请到「系统设置 → 隐私与安全性 → 完全磁盘访问」打开终端的开关，\n  完全退出并重新打开终端后重试。", file=sys.stderr)
        sys.exit(2)

    names = {}
    if "ZSHORTCUT" in tables:
        cols = [c[1] for c in con.execute("PRAGMA table_info(ZSHORTCUT)")]
        pk = "Z_PK" if "Z_PK" in cols else cols[0]
        nm = next((c for c in cols if c.upper() in ("ZNAME", "NAME")), None)
        if nm:
            for r in con.execute(f"SELECT {pk}, {nm} FROM ZSHORTCUT"):
                names[r[0]] = r[1]

    results = {}
    target = "ZSHORTCUTACTIONS" if "ZSHORTCUTACTIONS" in tables else None
    if target:
        cols = [c[1] for c in con.execute(f"PRAGMA table_info({target})")]
        fk = next((c for c in cols if c.upper().startswith("ZSHORTCUT") and c.upper() != "ZSHORTCUTACTIONS"), None)
        datacol = next((c for c in cols if "DATA" in c.upper() or "ACTIONS" in c.upper()), None)
        if datacol:
            sel = f"SELECT {fk or 'rowid'}, {datacol} FROM {target}"
            for key, blob in con.execute(sel):
                if not blob:
                    continue
                title = names.get(key, f"快捷指令 #{key}")
                if args.match and args.match.lower() not in title.lower():
                    continue
                hits = extract_from_blob(blob)
                if hits:
                    results.setdefault(title, []).extend(hits)

    # 兜底：schema 变了就扫所有表里所有 blob 列
    if not results and not args.match:
        for t in tables:
            cols = [c[1] for c in con.execute(f"PRAGMA table_info('{t}')")]
            for c in cols:
                try:
                    for (blob,) in con.execute(f"SELECT \"{c}\" FROM \"{t}\" WHERE typeof(\"{c}\")='blob' LIMIT 200"):
                        hits = extract_from_blob(blob)
                        if hits:
                            results.setdefault(f"{t}/{c}", []).extend(hits)
                except sqlite3.Error:
                    continue

    con.close()

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return

    if not results:
        print("没有找到任何 http(s) 地址。可能这个快捷指令把地址拆成了多个「文本」动作拼接，"
              "或用了编码。请看下面输出的排查建议，或直接在编辑器里查看动作。")
        return

    print(f"共在 {len(results)} 个快捷指令里找到网络地址：\n")
    for title, hits in sorted(results.items(), key=lambda x: -sum(1 for h in x[1] if h["network_action"])):
        print(f"=== {title} ===")
        uniq = {}
        for h in hits:
            uniq.setdefault(h["url"], h)
        for h in sorted(uniq.values(), key=lambda x: not x["network_action"]):
            flag = "★ 网络动作" if h["network_action"] else "  "
            print(f"  {flag} [{h['key']}] {h['url']}")
        print()
    print("提示：带 ★ 的通常就是解析接口。如果地址里含变量（剪贴板/魔法变量），")
    print("把变量那一段替换成 {url} 后，填进 Video Sniffer 设置页的「自定义解析 API」即可。")
    print("别忘了在编辑器里展开「获取 URL 内容 → 显示更多」，确认是 GET 还是 POST、")
    print("是否带 token 请求头或请求体——这些要一并填到设置页，否则接口可能拒绝请求。")


if __name__ == "__main__":
    main()
