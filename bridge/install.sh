#!/usr/bin/env bash
# Video Sniffer · 注册本机桥接 Native Messaging Host (macOS Chrome / Edge)
# 本机原生下载（action: fetch）不需要 yt-dlp，系统自带 Python 3 即可。
# 用法： bash install.sh <扩展ID>
set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "用法: bash install.sh <扩展ID>"
  echo "扩展ID 可在插件设置页看到（chrome://extensions 里也能看到）"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PY="$SCRIPT_DIR/host.py"
HOST_NAME="com.vsniffer.ytdlp"

if [[ ! -f "$HOST_PY" ]]; then
  echo "找不到 $HOST_PY"
  exit 1
fi
chmod +x "$HOST_PY"

# 一次性写入所有常见 Chromium 系浏览器，不用关心装的是哪一个
HOST_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
)

write_manifest() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Video Sniffer yt-dlp bridge",
  "path": "$HOST_PY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "✓ 已写入 $dir/$HOST_NAME.json"
}

for d in "${HOST_DIRS[@]}"; do
  write_manifest "$d"
done

echo
echo "✓ 本机原生下载（action: fetch）已就绪，不需要安装 yt-dlp。"
if command -v yt-dlp >/dev/null 2>&1; then
  echo "✓ yt-dlp: $(yt-dlp --version)（可选，用于合并高分音视频 / 1000+ 站点）"
else
  echo "ℹ 未安装 yt-dlp（可选）：只有用到「yt-dlp 合并」时才需要，"
  echo "    brew install yt-dlp ffmpeg     # 或 pip3 install -U yt-dlp"
fi

echo
echo "完成。请完全退出并重新打开 Chrome/Edge，然后在插件设置页点「① 授予本地通信权限」+「② 测试本机桥接」。"
echo "提示：如果以后移动了插件目录，需要重新运行本脚本。"
