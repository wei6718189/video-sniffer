# Video Sniffer · 万能视频解析下载插件

> 🤖 **本项目由 WorkBuddy 实现**：方案规划、解析接口逆向、插件代码、下载链路排障与文档撰写，均在 WorkBuddy 中协作完成。

把 iOS 快捷指令「复制视频地址 → 解析 → 无水印下载」的体验搬到 Chrome / Edge / 其它 Chromium 浏览器上。
**插件本身不解析任何视频，它是一个「统一前端 + 可插拔解析后端」的调度层。**

> **2026-11-13 更新**：已从本机 Mac 快捷指令中实测提取出它真正调用的解析接口，做成内置「RC 全平台解析」通道（**默认开启**）。装好插件即可像快捷指令一样「复制链接 → 出画质 → 下载」，不必再手动填接口地址；设置页可一键关闭。完整实测过程见文末 **附录 B**。
>
> **v1.1.0 下载修复**：解析成功但点下载得到 `.html` / 提示「无法从网站上提取文件」的问题已修复。原因是 Chrome 的下载接口禁止设置 `User-Agent`，而 CDN 会拒绝非浏览器 UA 并返回 403 网页。现在改为自动预检 + Blob 兼容下载 + 失败自动补救，详见「六、故障排查」。
>
> **v1.2.0 本机原生下载**：视频 CDN 的防盗链比音频严格，浏览器内下载仍可能失败。新增「本机原生下载」——把直链连同解析服务给的**完整请求头**（含 `User-Agent` / `Referer`）交给本机 Python 下载，和快捷指令能成功下载是同一个原理。**只需跑一次 `bridge/install.sh` 并在设置页授权本地通信即可，不需要装 yt-dlp。** 升级后请在 `chrome://extensions` 点一下插件的刷新按钮。
>
> **v1.3.0 抖音解析修复**：修复「抖音解析不了 / 只出现一条 `bytednsdoc.com` 页面内嵌媒体」的问题。根因是解析通道优先级错误：抖音短链 `v.douyin.com` 没被「已知 SPA 平台」规则匹配到，通用网页嗅探抓到页面静态资源后误判为解析成功并提前返回，导致真正能解析抖音的 **RC 全平台解析通道根本没有执行**（界面 trace 里只有两行，没有 RC 记录）。现在抖音类平台直接优先走 RC，通用嗅探降为最后兜底并标红警示。实测短链、带文案的整段分享文本、`www.iesdouyin.com` 分享页均能返回 1080P / 720P / 540P 三档无水印直链，下载返回 `HTTP 206 · video/mp4`。**升级后请在 `chrome://extensions` 点插件的刷新按钮，再重新解析一次。**

---

## 一、方案规划（为什么这么设计）

### 1. 先回答你的问题：公共解析平台能直接引用吗？

能，但**不能只靠它**。我实际做了探测（2026-11-13）：

| 类型 | 代表 | 现状 | 结论 |
|---|---|---|---|
| 平台专属只读 API | `api.fxtwitter.com` / `api.vxtwitter.com`（FixTweet、BetterTwitFix，开源、免鉴权） | ✅ 实测返回完整 JSON，含 `media.videos[].url`、`variants` 多码率、`d.fxtwitter.com` 重定向直链 | 可直接引用，作为 X 视频首选 |
| 平台官方半公开接口 | 抖音 `iesdouyin.com` 分享页 `window._ROUTER_DATA` / `iteminfo`；B站 `x/web-interface/view` + `x/player/playurl`；微博 `m.weibo.cn/statuses/show` | ✅ 页面/接口可访问；抖音 `playwm → play` 拿无水印流 | 可直连，但平台随时改签名/加 `a_bogus`，需容错回退 |
| 通用开源解析服务 | **Cobalt**（AGPL-3.0，覆盖 YouTube/TikTok/Instagram/Reddit 等） | ⚠️ 官方公共实例 `api.cobalt.tools` 现已要求 JWT，第三方调用实测返回 `{"status":"error","error":{"code":"error.api.auth.jwt.missing"}}` | **官方实例已不可白嫖**；但自建实例（Docker 一条命令）非常香，作为可配置后端 |
| 各类「短视频去水印」公共 API | 网上大量 `?url=&token=` 接口 | 无 SLA、随时关停/限流/加广告、可能记录你的链接 | 支持填，但只作为**用户自己配置**的通道，不内置硬编码 |
| 本地开源引擎 | **yt-dlp**（Unlicense，1000+ 站点，自动合并音视频） | ✅ 最稳、不依赖任何第三方服务器 | 终极兜底，代价是要装本地组件 |

**结论**：不存在一个"永久免费、全平台、永不变"的公共解析接口。iOS 快捷指令之所以"什么都能下"，本质就是它调用了某个第三方解析 API——那个 API 换域名/加鉴权的那天，快捷指令就失效。所以正确做法是**分层 + 可插拔**，任何一层挂了自动降级，并且用户可以随时把自己的新接口填进设置页，不用改代码。

### 2. 架构

```
复制/粘贴链接
      │
      ▼
[① 内置直连解析器]  X / 抖音 / B站 / 微博 / 直链 / 通用网页嗅探
      │ 失败
      ▼
[② RC 全平台解析]   ← 与本机快捷指令同源，动态读配置端点 · 默认开启
      │ 失败
      ▼
[③ 自定义解析 API]  ← 你有别的接口就粘进设置页
      │ 失败
      ▼
[④ Cobalt 实例]     ← 自建 or 你有权限的社区实例
      │ 失败
      ▼
[⑤ 本地 yt-dlp 桥]  ← Native Messaging，支持 1000+ 站点、合并音视频
      │
      ▼
下载链：① 已授权本机桥接 → 直链 + 完整请求头交给本机 Python 下载（推荐）
        └ 未授权则走浏览器：剥离禁止头 → Range 预检 → 原生下载
          └ 若被 CDN 拒绝 → offscreen 带站点 Referer 抓取 → Blob 下载
          └ 若仍存成 HTML 错误页 → 自动删除并重试一次
```

每一层的结果都归一化为 `formats: [{label, url, ext, headers}]`，UI 完全不关心来源。
`trace` 会记录每层耗时和失败原因，方便你一眼看出是哪个通道挂了。

### 3. 为什么"浏览器扩展"比网页/快捷指令更合适

- 扩展的 Service Worker 申请 `host_permissions` 后可以**绕过 CORS** 请求任意解析 API 和 CDN，普通网页做不到；
- `chrome.downloads` 能直接写文件、带自定义请求头、断点续传，比 `window.open(直链)` 稳；
- 能加右键菜单、全局快捷键、剪贴板自动识别、当前页面 `<video>` 嗅探；
- 解析调度全部在你本机浏览器完成，**本项目没有服务器**；但启用的第三方解析通道会把链接发给对应服务（RC 通道的数据流见附录 B），不想外发就关掉它们。

### 4. 与"在开源项目基础上改"的关系

没有 fork 某个单一项目，而是把开源生态当后端复用：FixTweet / BetterTwitFix（X 元数据）、Cobalt（通用解析）、yt-dlp（全站下载）+ 各平台公开接口，再加一条从本机快捷指令实测提取的第三方解析通道。插件只做调度、归一化和下载。好处是任何一个后端更新，你不用改插件；坏处是这些后端各自可能失效——所以才做了五层回退。

---

## 二、安装（2 分钟）

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），右上角打开 **开发者模式**；
2. 点 **加载已解压的扩展程序**，选择本文件夹 `video-sniffer/`；
3. 固定插件图标到工具栏，点开即可用；
4. 首次使用建议先去 **设置** 页看看五个通道（默认开启「内置直连」+「RC 全平台解析」+「剪贴板自动解析」+「右键自动下载」）。设置页的「测试通道（公开 B 站链接）」按钮可一键验证 RC 通道是否连通。
5. **强烈建议一次性启用「本机原生下载」**（视频能不能下主要看它）：
   ```bash
   cd video-sniffer/bridge
   bash install.sh <扩展ID>     # 扩展ID 在设置页可一键复制；命令会自动带入
   ```
   然后**完全退出并重开浏览器** → 设置页点「① 授予本地通信权限」→「② 测试本机桥接」出现 ✓ 即完成。此步骤**不需要安装 yt-dlp**，系统自带 Python 3 就够。

> 权限说明：安装时会提示「读取和更改您在所有网站上的数据」。这是后台请求任意解析接口/CDN 所必需的（`*://*/*`），插件不会注入脚本到网页，只有主动点「嗅探页面」时才会读取当前页 DOM。

---

## 三、怎么用

| 场景 | 操作 |
|---|---|
| 复制了视频链接 | 点开插件图标 → 自动读取剪贴板并解析 → 选画质点「下载」 |
| 页面上看到视频链接 | 右键链接 → **Video Sniffer：解析并下载这个链接**（默认直接下载最高画质） |
| 当前标签页就是视频页 | 按 `Alt` + `D`，或右键页面 → 解析当前页面 |
| 分享文案里混着中文 | 整段粘进去就行，插件会自动提取其中的第一个 URL |
| 想自己挑画质/复制链接 | 在面板里手动点「解析」，会列出所有画质，可「复制链接」「下载」「yt-dlp 合并」 |
| 页面里藏着 mp4 | 点「🔍 嗅探页面」，从 `<video>`、`og:video`、页面源码里找直链 |

下载文件默认落在 `~/Downloads/VideoSniffer/`，文件名含标题和画质，重名自动加序号。

---

## 四、支持的平台（默认开箱）

| 平台 | 通道 | 备注 |
|---|---|---|
| X / Twitter（含 x.com、fxtwitter 链接） | fxTwitter / vxTwitter 公共 API | 公开推文、多码率 mp4；登录/年龄限制内容需 yt-dlp + Cookie |
| 抖音（含 v.douyin.com 短链） | 官方分享页 + iteminfo 双通道 | `playwm → play` 无水印；图集也能下；平台改签名时会失败，建议配自定义 API |
| B 站（含 b23.tv 短链） | 公开 view + playurl | 自动带 Referer；1080P+ 可能只有 DASH 纯画面，用 yt-dlp 合并 |
| 微博 | 移动端 statuses/show | 多清晰度 + 配图 |
| 任意直接是 .mp4/.m3u8 的链接 | 直链媒体 | m3u8 需 yt-dlp/ffmpeg 才能合并 |
| 其它网页 | 通用网页嗅探 | 只能拿到页面 HTML 里出现的直链 |
| YouTube / TikTok / Instagram / Reddit / Vimeo / 快手 / 小红书 … | Cobalt 或 yt-dlp | 需按下面启用，开箱默认不启用 |

---

## 五、增强通道配置

### A. 自定义解析 API（最贴近你的 iOS 快捷指令）

设置页打开开关，填接口地址，用 `{url}` 表示视频链接：

```
https://your-api.com/api/parse?url={url}
```

- 支持 GET / POST，POST 请求体可用 `{"url":"{url}"}`；
- 插件会**递归扫描返回的 JSON**，自动找出所有 mp4 / m3u8 / `video.twimg.com` / `aweme/v1/play` 等直链，不要求固定字段名；
- 返回纯文本直链也支持；
- 如果你知道快捷指令里调用的那个接口地址，直接填进来即可让插件获得和它一样的全平台能力。

### B. 自建 Cobalt（推荐，覆盖海外平台）

官方公共实例已加 JWT，请自建：

```bash
docker run -d --name cobalt -p 9000:9000 ghcr.io/imputnet/cobalt:latest
# 或按官方文档用 docker-compose，可配 cookies.json 处理需登录内容
```

设置页填 `http://localhost:9000`，点「测试实例」。
插件同时兼容 Cobalt v11（`POST /`）和 v10（`POST /api/json`）两套 API，能处理 `tunnel / redirect / stream / picker` 各种响应。

### C. 本地 yt-dlp（最稳，支持 1000+ 站点）

```bash
brew install yt-dlp ffmpeg          # 或 pip3 install -U yt-dlp
cd video-sniffer/bridge
bash install.sh <扩展ID>             # 扩展ID 在设置页能看到
```

然后：**完全退出并重启浏览器** → 设置页 → ① 授予本地通信权限 → ② 测试桥接 → 打开「本地 yt-dlp」开关。

启用后：
- 前三层都失败时自动用 yt-dlp 兜底；
- 结果列表会出现「yt-dlp 合并」按钮，交给本机下载并自动合并音视频（YouTube 1080P+ / B站高画质必需）；
- 下载落在 `~/Downloads/VideoSniffer/`。

macOS 上脚本会同时给 Chrome 和 Edge 注册 Native Messaging Host。移动插件目录后要重新跑一次 `install.sh`。

---

## 六、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 抖音「解析成功」但只有一条 `bytednsdoc.com` 页面内嵌媒体 | **v1.3.0 已修复**：通用网页嗅探抢跑返回了静态资源。升级到 v1.3.0 → 刷新扩展 → 重新解析；确认设置页「RC 全平台解析」已开启 |
| 抖音解析失败，trace 里没有 RC 记录 | 同上，或 RC 通道在设置页被关闭（失败提示会明确指出） |
| 抖音提示 `解析失败，请稍后再试 (50201)` | 链接已失效 / 不是有效作品链接，或服务端临时限流；重新复制一次分享链接再试 |
| 音频能下、视频点下载没反应 / 得到 `.html` | 视频 CDN 校验 UA，见下方两节。**开启「本机原生下载」即可解决**（先刷新扩展） |
| X 提示推文不可用 | 仅支持公开推文；登录可见内容需 yt-dlp + Cookie |
| Cobalt 测试失败 | 检查是否用了 `api.cobalt.tools`（已需 JWT）、容器是否启动、端口是否正确 |
| yt-dlp 桥接无响应 | 确认 `brew install yt-dlp`、跑过 `install.sh`、重启过浏览器、扩展 ID 一致、设置页已授权权限 |
| 只看得到无声音的高画质 | DASH 分离流，用「yt-dlp 合并」按钮 |
| 解析全通道失败 | 打开面板底部的解析轨迹（trace），看是哪一层报错，再针对性配置 |

### 下载排错：解析成功、下载却是 `.html`

**实测根因（2026-11-13，B站 CDN 直链）**

| 请求条件 | 结果 |
|---|---|
| 无 UA / `curl/8.7.1` | `403 text/html`，146 字节错误页 |
| 任意浏览器 UA（Chrome 120 / 140、Safari） | `206 application/octet-stream`，真实 mp4 数据 |
| 只加 Referer、不给浏览器 UA | 仍然 403 |

Chrome 把这个 403 网页当成下载内容存成 `.html`，于是弹「无法从网站上提取文件」。而 `chrome.downloads.download` 的 `headers` 参数**受 XHR 允许的头约束**，`User-Agent` / `Referer` / `Cookie` / `DNT` 一律传不进去。旧版把解析服务返回的 `d_headers`（Referer + UA + dnt）原样交给下载接口，等于一个都没生效。

**v1.1.0 的四道处理**

1. 剥离所有 forbidden 头，让下载请求恢复**浏览器原生 UA**（CDN 主要校验的就是它）；
2. 用 `Range: bytes=0-0` 做一次极轻量预检，判断 CDN 会不会放行原生下载；
3. 预检失败 → 在 offscreen 隐藏页面里 `fetch`（浏览器原生 UA + 合法设置站点 Referer）→ 生成 Blob URL 下载；
4. 原生下载完成后若发现存的是 HTML 错误页，自动删除垃圾文件并用第 3 步重来一次，并发系统通知。

面板会用「（兼容模式，已绕过防盗链）」标注走了哪条路。解析引擎还会在服务端没下发 `d_headers` 时，按平台 / CDN 域名自动补站点 Referer。

**仍然下载不了**：按「二、安装」第 5 步开启本机原生下载（最稳）→ 换一个画质（不同 CDN 域名策略不同）→ 点「复制链接」用支持自定义 UA 的下载工具。浏览器内兼容模式会先把文件读进内存，数百 MB 的超大视频建议直接走本机下载。

### 常见问题：为什么不直接用快捷指令的解析地址？是接口没公开吗？

**其实一直在用，而且接口完全公开、无需鉴权。** 从本机快捷指令里挖出的真实链路：

```
GET  https://i.rcuts.com/update/247           → 动态下发 parse 端点
POST https://parse.rcuts.com:8443/v1/parse    → {"url":"...","sv":"1","client":"ios-shortcut-247","quality":"all"}
     ← data.urls[] / labels[] / d_headers[]（直链、画质、下载请求头）
```

插件的「RC 全平台解析」通道就是它：动态读配置、POST 解析、把 `urls/labels` 一一对应成画质列表。截图里 4K / 2K / 音频都列出来了，说明**解析这步已经 100% 成功**，既不是"没公开"也不是"没接上"。它是第三方公共服务，随时可能变更，所以插件做了配置端点动态读取 + 内置兜底地址 + 五层回退。

**卡住的是解析之后的「下载」，两者不是一回事：**

| | 快捷指令（macOS / iOS 原生） | 浏览器扩展 |
|---|---|---|
| 设置 `User-Agent` | ✅ 可任意设置（配置 `ag` + `d_headers`） | ❌ `chrome.downloads` 受 XHR 允许头约束；`fetch` 里 UA 是 forbidden header |
| 设置 `Referer` 等请求头 | ✅ | ❌ 一律被忽略 |
| 结果 | 带正确头取回视频 | 直链被 CDN 判为非法 → 403 网页 → 存成 `.html` |

**所以「音频能下、视频不能下」**：音频 CDN（`*.douyinstatic.com`）一般不校验防盗链，视频 CDN（`*.douyinvod.com` / `*.bilivideo.com`）会校验 UA。同一条直链实测：浏览器 UA → `206` 拿到 mp4；不给 UA / 给 `curl` UA → `403 text/html`。

**解法（v1.2.0）**：「本机原生下载」把直链和 `d_headers` 原样交给本机 Python 进程（Native Messaging），由原生进程带完整 UA / Referer 下载到 `~/Downloads/VideoSniffer/` —— 等于把快捷指令的下载能力搬进插件，同时绕开 Chrome 的安全限制。本机桥接实测：带 UA 成功取回数据，不带 UA 返回 `HTTP 403`。

---

## 七、合规提示

请仅下载你有权保存的内容（自己发布、已获授权、平台明确允许离线缓存的内容），遵守各平台服务条款与著作权相关规定。插件不提供绕过登录、DRM 或付费墙的能力，也不包含任何第三方服务器地址（除你主动配置的和 X 解析所用的开源公开 API）。

## 文件清单

```
manifest.json          MV3 清单
parsers.js             分层解析引擎（6 个内置解析器 + 3 个外部通道）
background.js          Service Worker：消息路由/右键/快捷键/下载预检与自动补救/通知
offscreen.html/js      兼容下载：带 Referer 抓取视频并生成 Blob URL
popup.html/css/js      解析面板
options.html/js        设置页
icons/                 图标
bridge/host.py         本机桥接：fetch 直链下载（无需 yt-dlp）+ yt-dlp 解析/合并
bridge/install.sh      macOS 一键注册脚本
tools/find-shortcut-api.py       从快捷指令数据库挖解析接口（需完全磁盘访问）
tools/inspect-shortcut-file.py  解析导出的 .shortcut / plist 文件（含 AEA1 签名档案）
```

---

## 附录：怎么找出 macOS 快捷指令调用的解析接口

你那个「复制地址 → 点一下就下载」的快捷指令，本质只是把链接发给了某个第三方解析 API。找出它的四种办法，从快到彻底。

**现在最短的一步（30 秒，零权限）**：切到已经打开的「快捷指令」App，在右侧动作列表里找到第一个「URL」动作，双击输入框 `⌘A` `⌘C`，把地址贴给我即可。本机相关的 5 个快捷指令：

```
抖音解析 无水印 / 抖音解析 无水印 1 / 抖音解析 无水印 2
无水印视频保存 / 全网VIP视频解析
```

其中 `全网VIP视频解析` 最可能就是你 iOS 上那个「全平台」版本的对应物，优先看它。

如果不想手工翻，就做一次性授权（方法 2），之后我能把 5 个快捷指令的接口全部批量挖出来。

### 方法 1：直接在编辑器里看（最快，无需任何权限）

```bash
shortcuts list                          # 列出所有快捷指令
shortcuts view "抖音解析 无水印"         # 直接在「快捷指令」App 里打开它的编辑界面
```

在右侧动作列表里找这两类动作：

- **「URL」动作**：直接写着完整接口，例如 `https://xxx.com/api?url=<剪贴板>&token=...`。蓝色胶囊是魔法变量，代表运行时插入剪贴板内容。
- **「获取 URL 内容」动作**：点 **显示更多**，能看到 GET/POST、请求头（常藏 token）、请求体（常是 `{"url":"..."}`）。

典型链路是 `URL → 获取 URL 内容 → 获取字典值（键名如 data.playAddr / url / video）→ 获取 URL 内容 → 存储文件`。注意会有两个 URL：第一个是**解析接口**（你要找的），第二个是运行时才生成的**视频直链**（不用管）。

小技巧：双击 URL 输入框 → `⌘A` `⌘C`，粘到备忘录里就能保存下来；魔法变量会显示为占位文本。

### 方法 2：一键脚本把所有接口导出来（推荐，能拿到 token）

快捷指令的动作定义存在 `~/Library/Shortcuts/Shortcuts.sqlite` 的 `ZSHORTCUTACTIONS.ZDATA`（binary plist）。脚本会递归扫描并打印所有 http(s) 地址：

```bash
# 一次性授权：系统设置 → 隐私与安全性 → 完全磁盘访问 → 打开「终端」
# 然后完全退出并重新打开终端（该目录受 TCC 保护，不授权会报 authorization denied）
python3 tools/find-shortcut-api.py --match 抖音
python3 tools/find-shortcut-api.py --json        # 机器可读，方便贴给我帮你预填
```

`★ 网络动作` 标记的就是 URL / 获取 URL 内容动作里的地址。脚本只读，不修改任何快捷指令；也支持 `--db <路径>` 读取备份或另一台机器的数据库。

本机实测（2026-11-13）：未授权时读库会报 `authorization denied` 或 `unable to open database file`。授权步骤：**系统设置 → 隐私与安全性 → 完全磁盘访问 → 打开「终端」→ 完全退出终端并重新打开**，然后重跑脚本即可。授权后一次能拿到 5 个快捷指令里所有 URL、请求方式、请求头和 token。

### 方法 3：地址被变量拼接 / 编码了

有些快捷指令把域名、路径、token 拆在多个「文本」动作里再拼接，或做了 Base64 / URL 编码，静态看不出来。两种兜底：

- **临时显示法**（零成本）：先复制一份快捷指令，在「获取 URL 内容」动作**前面**插入「快速查看」或「显示结果」，输入选那个 URL 变量，运行一次就能看到拼接后的完整地址，看完删掉这个动作。
- **抓包法**：用 Proxyman / Charles / mitmproxy，开启系统 HTTPS 代理并信任根证书，运行一次快捷指令，完整请求行、参数、响应体一目了然。另外，快捷指令第一次联网时弹出的「允许连接到 xxx.com？」里那个域名也是线索。

### 方法 4：导出 `.shortcut` 文件后离线解析

在「快捷指令」App 里选中快捷指令 → 菜单栏 **文件 > 导出**，存成 `.shortcut` 文件，然后：

```bash
python3 tools/inspect-shortcut-file.py ~/Downloads/全网VIP视频解析.shortcut
python3 tools/inspect-shortcut-file.py "*.shortcut" --json      # 批量 + 机器可读
python3 tools/inspect-shortcut-file.py 文件 --all               # 连平台域名、字节片段一起列
```

脚本会打印疑似解析接口（★）、它在动作里的位置，以及 `WFHTTPMethod` / `WFHTTPHeaders` / `WFHTTPBody` 等参数，便于判断 GET/POST 和 token。只读输入文件，临时产物放系统临时目录并自动清理。

**格式说明（本机实测）**：新版 `.shortcut` 是 Apple 加密档案 `AEA1`（profile 0：签名不加密），内部是 LZFSE 压缩的 Apple Archive，包着快捷指令 plist；直接 `plutil` / `strings` 读不出来。脚本会自动从容器内的 X.509 证书提取验签公钥，调用系统自带 `aea decrypt` → `aa extract` → `plistlib` 解包（用自签样本完整验证过）；解包失败时会退化为原始字节扫描并明确提示。旧格式 / 未签名 plist 直接支持。

⚠️ 导出时若选「任何人」，Apple 会收到一份副本用于完整性校验，快捷指令里若嵌了 token 会一并上传；**含密钥时更推荐方法 1 / 2，别上传**。另外导出仍需手工操作 GUI，所以这条是「不想授权 TCC」时的备选，不是最短路径。

### 拿到地址之后（通用填法）

**本机这条接口已经内置成「RC 全平台解析」通道，不用再手动填**（见附录 B）。以后若找到别的解析接口，按下面方式填到设置页「自定义解析 API」：

```
快捷指令:  https://xxx.com/api?url=<剪贴板>&token=tk_xxx
插件设置:  https://xxx.com/api?url={url}&token=tk_xxx
```

POST 就把请求方式改成 POST、请求体照抄（同样用 `{url}` 代替魔法变量）。插件会递归扫描返回 JSON 自动找出直链，不要求固定字段名。

---

## 附录 B：本机快捷指令实测结论 & 内置 RC 通道（2026-11-13）

授权「完全磁盘访问」后，批量扫描了 `~/Library/Shortcuts/Shortcuts.sqlite` 里全部快捷指令的动作定义。结论有点出人意料：

### 静态扫描结果

| 快捷指令 | 静态能看到的地址 | 实际是什么 |
|---|---|---|
| `抖音解析 无水印`（及 1/2/4/5，共 5 份） | `https://i.rcuts.com/update/247` | **更新检查 / 配置端点**，不是解析接口 |
| `抖音全类型` | `https://i.rcuts.com/update/249` | 同上，配置端点不同 |
| `全网VIP视频解析` | `http://movie.leyoudou.top/index.php/vod/search.html?wd=…` | 影视站搜索页（在线看片），不是视频解析 |
| `无水印视频保存` | 无 | 只有「最新实况照片 → 编码 → 存相册」，与解析无关 |

**关键点**：抖音那几个快捷指令把解析接口做成了「运行时下发」，动作链是：

```
字典(Config.update = i.rcuts.com/update/247)
  → 获取 URL 内容 → 检测字典(rcuts)
  → 获取 URL 内容(POST, URL = rcuts.parse, JSON body)
  → 获取字典值(data.urls / data.labels / data.d_headers …)
  → 下载直链 → 存储到相册
```

所以静态只看动作里的 URL 永远找不到解析接口——必须真的请求一次配置端点。

### 实测拿到的接口

`GET https://i.rcuts.com/update/247` 返回（节选）：

```json
{
  "name": "抖音解析 无水印",
  "version": "4",
  "api": "http://api.rcuts.com/Video/DouYin.php",
  "parse": "https://parse.rcuts.com:8443/v1/parse",
  "ag": "Mozilla/5.0 (iPhone; … aweme_8.3.1 …)"
}
```

解析请求（实测可用）：

```bash
curl -X POST 'https://parse.rcuts.com:8443/v1/parse' \
  -H 'Content-Type: application/json' \
  -d '{"url":"<视频分享链接>","sv":"1","client":"ios-shortcut-247","quality":"all"}'
```

成功响应（`code: 0`）的关键字段：

| 字段 | 含义 |
|---|---|
| `data.platform` / `data.type` | 平台标识、内容类型 |
| `data.title` / `data.desc` / `data.author.name` / `data.cover` | 元数据 |
| `data.urls[]` / `data.labels[]` | 直链数组与对应画质标签（一一对应） |
| `data.video` / `data.audio` / `data.medias[]` / `data.music.url` | 主视频 / 音频 / 图集 / 配乐 |
| `data.d_headers.a~e` | CDN 下载请求头，形如 `{n:"Referer", v:"https://www.bilibili.com/"}` |
| `data.quality` / `quality_hd` | 画质与是否有高清 |

### 实测记录

| 测试链接 | 结果 |
|---|---|
| B站 `BV1xx411c7mD` | ✅ `code:0`，标题「字幕君交流场所」，`1080P · 94.1 MB`，直链带 `deadline` 时效参数，`d_headers` 含 Referer |
| X `x.com/jack/status/20` | ❌ `code:40006`「不支持该类型的链接」→ 插件仍走内置 fxTwitter，实测正常 |
| 抖音 / 微博示例链接 | ⚠️ `50201/50202` 通道繁忙或解析失败（第三方服务状态，非插件问题） |

### 插件里怎么实现的

新增 `runRcuts()` 通道（`parsers.js`），默认开启，位于内置直连之后、自定义 API 之前：

1. 缓存 6 小时：先 GET 配置端点拿 `parse`，配置挂了就用内置兜底地址；对方换域名插件会自动跟随，不用改代码；
2. POST 上述 JSON，`client` 与配置端点可在设置页改；
3. 把 `data.urls` 与 `data.labels` 按位置配对成画质列表，补上 `video / audio / medias / music`；
4. 把 `d_headers` 转成 `[{name,value}]` 交给 `chrome.downloads`（自动去重、由下载层过滤浏览器禁用的头），解决 CDN 防盗链；
5. 失败写入 `trace` 并自动降级到下一层，不会卡住。

端到端实测：`resolve()` 返回 `sourceLabel=RC 全平台解析 · bili`、1 个 `1080P · 94.1 MB` 画质、Referer 头正确；默认设置下 X 链接仍由内置 fxTwitter 命中，不受影响。

### 数据流与开关

- 启用时，**只有内置直连失败的链接**才会被发送给 `i.rcuts.com` / `parse.rcuts.com`（行为与快捷指令一致）。插件自身没有服务器，也不上传历史记录或文件。
- 不想让任何链接离开本机：设置页关掉「RC 全平台解析」，只用内置直连 + 本地 yt-dlp。
- 该服务是第三方，可能限流、改协议或关停；解析出的直链带时效参数，**解析后请尽快下载**。
- 请仅下载你有权保存的内容，遵守平台条款与著作权规定。

### 找到之后

把接口填进插件设置页的「自定义解析 API」，链接参数换成 `{url}`：

```
快捷指令:  https://xxx.com/api?url=<剪贴板>&token=tk_xxx
插件设置:  https://xxx.com/api?url={url}&token=tk_xxx
```

若是 POST，把「请求方式」改成 POST，请求体照抄（同样用 `{url}` 代替变量），有 token 请求头的话目前可在自定义 API 地址里带上或告诉我帮你加请求头支持。插件会自动递归扫描返回 JSON，不用关心字段名。
