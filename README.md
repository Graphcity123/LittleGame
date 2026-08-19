# 词影迷踪

中文猜词游戏合集，含单机版与多套局域网联机版。纯前端 + Python（aiohttp WebSocket）服务端，无构建步骤、开箱即玩。

## 子项目

| 目录 | 玩法 | 人数 | 端口 | 入口 |
| --- | --- | --- | --- | --- |
| 根目录 | 猜词 · 单机版 | 1 | — | 直接用浏览器打开 `index.html` |
| `lan/` | 猜词 · 双机局域网 | 2（队长 + 队员） | 8000 | `python lan/server.py` |
| `multi/` | 猜词 · 五人局域网 | 5（红/蓝队长、红/蓝队员、观察者） | 8010 | `python multi/server.py` |
| `avalon/` | 阿瓦隆 · 隐藏身份推理 | 5–10（动态人数） | 8020 | `python avalon/server.py` |

## 快速开始

需要 Python 3.11+ 和 `aiohttp`：

```bash
pip install -r lan/requirements.txt    # multi、avalon 各自目录下也有 requirements.txt
python lan/server.py                   # 例：启动双机版，默认监听 0.0.0.0:8000
```

启动后终端会打印本机与局域网访问地址：

- 本机打开 `http://127.0.0.1:<端口>/`
- 其他电脑打开 `http://<服务器局域网IP>:<端口>/`

各子项目规则详见：

- `role.md` —— 猜词通用规则
- `lan/README.md` —— 双机版
- `multi/README.md` —— 五人版
- `avalon/README.md`、`avalon/role.md` —— 阿瓦隆（含深水局房规）

## 词库

词库由 `tools/wordbank.txt`（分类词表）经 `tools/build_wordbank.py` 生成，写入根目录 `game.js` 的 `WORD_BANK`（约 4800 词、52 分类，现代词为主）。`lan/` 与 `multi/` 的服务端启动时自动从根 `game.js` 读取同一份词库。

改词库流程：

```bash
# 编辑 tools/wordbank.txt（难词写进 HARD 集合）
python tools/build_wordbank.py    # 写回 game.js（首次运行生成 game.js.bak 备份）
```

## 阿瓦隆「深水局」

`avalon/` 支持 5–10 人动态人数，大厅勾选「深水局」即进入深色模式并启用特殊角色（兰斯洛特、湖中仙女）。任务成功/失败不显示具体票数，对局结束后复盘才揭示。详见 `avalon/README.md`。

## 联网玩

代码侧已就绪（`connect()` 用 `location.protocol` 自适应 `wss://`，服务端绑 `0.0.0.0`），可搭配 Radmin VPN / Tailscale / Cloudflare Tunnel 让不同局域网的朋友加入。详见 `lan/multi/avalon` 各 README。
