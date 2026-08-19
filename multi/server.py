#!/usr/bin/env python3
"""词影迷踪多人局域网版：红蓝队长、红蓝队员、观察者。"""

import argparse
import asyncio
import json
import random
import re
import socket
from collections import defaultdict
from pathlib import Path

from aiohttp import WSMsgType, web


ROOT = Path(__file__).resolve().parent.parent
MULTI_DIR = Path(__file__).resolve().parent
GAME_JS = ROOT / "game.js"

DEFAULT_CONFIG = {"rows": 5, "cols": 5, "red": 9, "blue": 8, "bomb": 1}
COLOR_LABELS = {
    "red": "红方目标",
    "blue": "蓝方目标",
    "bomb": "炸弹",
    "neutral": "无效词",
}
CAPTAIN_ROLES = ("red_captain", "blue_captain")
MEMBER_ROLES = ("red_member", "blue_member")
ALL_ROLES = (*CAPTAIN_ROLES, *MEMBER_ROLES, "observer")
ROLE_NAMES = {
    "red_captain": "红方队长",
    "blue_captain": "蓝方队长",
    "red_member": "红方队员",
    "blue_member": "蓝方队员",
    "observer": "观察者",
}


def load_word_bank():
    text = GAME_JS.read_text(encoding="utf-8")
    pattern = re.compile(
        r"\{\s*word:\s*'([^']+)',\s*category:\s*'([^']+)',\s*difficulty:\s*'([^']+)'\s*\}",
        re.MULTILINE,
    )
    matches = pattern.findall(text)
    if len(matches) < 2000:
        raise RuntimeError(f"无法从 game.js 解析词库，仅识别到 {len(matches)} 个词")
    return [
        {"word": word, "category": category, "difficulty": difficulty}
        for word, category, difficulty in matches
    ]


WORD_BANK = load_word_bank()
HARD_WORDS = {item["word"] for item in WORD_BANK if item["difficulty"] == "hard"}


def build_pools(hard_only):
    pools = defaultdict(list)
    for item in WORD_BANK:
        is_hard = item["difficulty"] == "hard"
        if is_hard == hard_only:
            pools[item["category"]].append(item["word"])
    for words in pools.values():
        random.shuffle(words)
    return pools


def draw_from_pools(pools, count):
    names = list(pools.keys())
    random.shuffle(names)
    picked = []
    cursor = 0

    while len(picked) < count and names:
        name = names[cursor % len(names)]
        words = pools[name]
        if not words:
            names.pop(cursor % len(names))
            continue
        picked.append(words.pop())
        if not words:
            names.pop(cursor % len(names))
        cursor += 1
    return picked


def create_board(config):
    total = config["rows"] * config["cols"]
    red = config["red"]
    blue = config["blue"]
    bomb = config["bomb"]
    neutral = total - red - blue - bomb

    hard_words = draw_from_pools(build_pools(True), 2)
    normal_words = draw_from_pools(build_pools(False), total - len(hard_words))
    words = hard_words + normal_words
    random.shuffle(words)

    colors = ["red"] * red + ["blue"] * blue + ["bomb"] * bomb + ["neutral"] * neutral
    random.shuffle(colors)

    hard_indexes = [index for index, word in enumerate(words) if word in HARD_WORDS]
    team_hard_colors = []
    if red >= 1:
        team_hard_colors.append("red")
    if blue >= 1:
        team_hard_colors.append("blue")
    random.shuffle(team_hard_colors)
    for index, wanted in zip(hard_indexes[:2], team_hard_colors):
        current_index = colors.index(wanted)
        if current_index != index:
            colors[index], colors[current_index] = colors[current_index], colors[index]

    return [
        {
            "word": word,
            "color": color,
            "kind": COLOR_LABELS[color],
            "flipped": False,
        }
        for word, color in zip(words, colors)
    ]


class GameError(Exception):
    pass


class MultiRoom:
    def __init__(self):
        self.captain_connections = {role: None for role in CAPTAIN_ROLES}
        self.member_connections = {"red": [], "blue": []}
        self.observers = []
        self.state = None
        self.config = dict(DEFAULT_CONFIG)
        self.lock = asyncio.Lock()

    @staticmethod
    async def send_json(ws, payload):
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json(payload)
        except (ConnectionResetError, RuntimeError):
            return

    @property
    def connected(self):
        result = {
            role: self.captain_connections[role] is not None
            and not self.captain_connections[role].closed
            for role in CAPTAIN_ROLES
        }
        result["red_member"] = bool(self.member_connections["red"])
        result["blue_member"] = bool(self.member_connections["blue"])
        result["observer"] = bool(self.observers)
        return result

    @property
    def counts(self):
        result = {
            role: 1
            if self.captain_connections[role] is not None
            and not self.captain_connections[role].closed
            else 0
            for role in CAPTAIN_ROLES
        }
        result["red_member"] = sum(
            1 for ws in self.member_connections["red"] if not ws.closed
        )
        result["blue_member"] = sum(
            1 for ws in self.member_connections["blue"] if not ws.closed
        )
        result["observer"] = len(self.observers)
        return result

    @property
    def all_required_connected(self):
        return all(self.connected.values())

    def new_game(self):
        config = dict(self.config)
        rows = config["rows"]
        cols = config["cols"]
        self.state = {
            "board": create_board(config),
            "config": config,
            "currentTeam": "red",
            "phase": "clue",
            "clueWord": "",
            "clueCount": 1,
            "flips": 0,
            "limit": 1,
            "score": {"red": 0, "blue": 0},
            "winner": None,
            "winReason": "",
            "history": [
                {
                    "text": f"AI 已生成 {rows}×{cols} 共 {rows * cols} 个词语，红队先手",
                    "tone": "turn",
                    "team": "",
                }
            ],
        }
        return self.state

    def state_for(self, role):
        connected = self.connected
        all_connected = self.all_required_connected
        can_start = role == "observer" and all_connected
        base = {
            "type": "state",
            "role": role,
            "connected": connected,
            "counts": self.counts,
            "allRequiredConnected": all_connected,
            "canStart": can_start,
            "config": dict(self.config),
        }

        if self.state is None:
            return {**base, "canAct": None, "game": None}

        game = self.state
        reveal = role.endswith("_captain") or bool(game["winner"])
        board = []
        for card in game["board"]:
            if reveal or card["flipped"]:
                board.append(card)
            else:
                board.append(
                    {
                        "word": card["word"],
                        "color": None,
                        "kind": "",
                        "flipped": False,
                    }
                )

        current = game["currentTeam"]
        active = not game["winner"]
        can_act = {
            "submitClue": role == f"{current}_captain"
            and active
            and game["phase"] == "clue",
            "flip": role == f"{current}_member"
            and active
            and game["phase"] == "guess",
            "pass": role == f"{current}_member"
            and active
            and game["phase"] == "guess",
            "newGame": role == "observer" and all_connected,
        }
        return {
            **base,
            "canAct": can_act,
            "game": {**game, "board": board},
        }

    async def broadcast_state(self):
        for role in CAPTAIN_ROLES:
            ws = self.captain_connections[role]
            await self.send_json(ws, self.state_for(role))
        for team in ("red", "blue"):
            for member in list(self.member_connections[team]):
                await self.send_json(member, self.state_for(f"{team}_member"))
        for observer in list(self.observers):
            await self.send_json(observer, self.state_for("observer"))

    def add_history(self, text, tone="", team=""):
        self.state["history"].append({"text": text, "tone": tone, "team": team})
        if len(self.state["history"]) > 80:
            self.state["history"] = self.state["history"][-80:]

    def require_ready(self):
        if self.state is None:
            raise GameError("游戏尚未开始")

    async def handle_message(self, role, message, ws):
        action = message.get("action") if isinstance(message, dict) else None
        async with self.lock:
            try:
                if action == "new_game":
                    self.start_new_game(role)
                elif action == "set_config":
                    self.set_config(role, message)
                elif action == "submit_clue":
                    self.submit_clue(role, message)
                elif action == "flip":
                    self.flip_card(role, message)
                elif action == "pass":
                    self.pass_turn(role)
                else:
                    raise GameError("无法识别的操作")
                await self.broadcast_state()
            except GameError as exc:
                await self.send_json(ws, {"type": "error", "message": str(exc)})

    def start_new_game(self, role):
        if role != "observer":
            raise GameError("只有观察者可以开启新局")
        if not self.all_required_connected:
            raise GameError("需要红蓝队长、至少各一位红蓝队员和观察者全部连接")
        self.new_game()

    def set_config(self, role, message):
        if role != "observer":
            raise GameError("只有观察者可以调整配置")
        if self.state is not None and not self.state["winner"]:
            raise GameError("对局进行中无法调整配置")

        try:
            rows = int(message.get("rows", DEFAULT_CONFIG["rows"]))
            cols = int(message.get("cols", DEFAULT_CONFIG["cols"]))
            red = int(message.get("red", DEFAULT_CONFIG["red"]))
            blue = int(message.get("blue", DEFAULT_CONFIG["blue"]))
            bomb = int(message.get("bomb", DEFAULT_CONFIG["bomb"]))
        except (TypeError, ValueError) as exc:
            raise GameError("配置参数无效") from exc

        if rows < 4 or rows > 8:
            raise GameError("行数只能在 4 到 8 之间")
        if cols < 4 or cols > 8:
            raise GameError("列数只能在 4 到 8 之间")
        if red < 1:
            raise GameError("红队目标词至少 1 个")
        if blue < 1:
            raise GameError("蓝队目标词至少 1 个")
        if bomb < 0:
            raise GameError("炸弹词不能为负数")
        if red + blue + bomb > rows * cols:
            raise GameError("目标词与炸弹词总数不能超过卡片总数")

        self.config = {"rows": rows, "cols": cols, "red": red, "blue": blue, "bomb": bomb}

    def submit_clue(self, role, message):
        self.require_ready()
        game = self.state
        if game["winner"]:
            raise GameError("本局已经结束")
        if game["phase"] != "clue":
            raise GameError("当前不是提示阶段")

        expected = f"{game['currentTeam']}_captain"
        if role != expected:
            raise GameError("只有当前队伍队长可以提交提示")

        raw = str(message.get("clueWord", "")).strip()
        if not raw:
            raise GameError("请输入提示词")
        if not re.fullmatch(r"(?=.*[\u4e00-\u9fff])[\u4e00-\u9fff，。！？、；：“”‘’（）《》〈〉【】〔〕…—·～￥％℃]+", raw):
            raise GameError("提示词只能使用汉字和全角标点")

        board_words = [card["word"] for card in game["board"]]
        board_chars = set("".join(board_words))
        clashes = []
        seen = set()
        for ch in raw:
            if ch in board_chars and ch not in seen:
                seen.add(ch)
                words = [w for w in board_words if ch in w]
                clashes.append(f"「{ch}」与「{'」「'.join(words)}」重复")
        if clashes:
            raise GameError("提示词中的字与词板重复：" + "；".join(clashes))

        try:
            count = int(message.get("clueCount", 1))
        except (TypeError, ValueError) as exc:
            raise GameError("数量需要是 0 到 9 之间的整数") from exc
        if count < 0 or count > 9:
            raise GameError("数量需要是 0 到 9 之间的整数")

        game["clueWord"] = raw
        game["clueCount"] = count
        game["flips"] = 0
        game["limit"] = count + 1
        game["phase"] = "guess"
        team = game["currentTeam"]
        self.add_history(
            f"{'红队' if team == 'red' else '蓝队'}：{raw} → {count} 词",
            "hint",
            team,
        )

    def flip_card(self, role, message):
        self.require_ready()
        game = self.state
        if game["winner"]:
            raise GameError("本局已经结束")
        if game["phase"] != "guess":
            raise GameError("当前不是翻词阶段")

        expected = f"{game['currentTeam']}_member"
        if role != expected:
            raise GameError("只有当前队伍队员可以翻词")

        try:
            index = int(message.get("index", -1))
        except (TypeError, ValueError) as exc:
            raise GameError("翻词位置无效") from exc
        if index < 0 or index >= len(game["board"]):
            raise GameError("翻词位置无效")

        card = game["board"][index]
        if card["flipped"]:
            raise GameError("这个词已经翻开")

        card["flipped"] = True
        game["flips"] += 1
        current = game["currentTeam"]
        color = card["color"]
        opponent = "blue" if current == "red" else "red"
        is_own_target = color == current
        is_opponent_target = color in ("red", "blue") and color != current

        if color in ("red", "blue"):
            game["score"][color] += 1

        team_label = "红队" if current == "red" else "蓝队"
        self.add_history(
            f"{team_label}翻开「{card['word']}」：{COLOR_LABELS[color]}",
            "good" if is_own_target else ("bad" if color == "bomb" else ""),
        )

        if color == "bomb":
            game["winner"] = opponent
            game["winReason"] = "bomb"
            game["phase"] = "ended"
            self.add_history(
                f"{'蓝队' if opponent == 'blue' else '红队'}胜利：对手翻到炸弹词",
                "bad",
            )
        elif game["score"]["red"] >= game["config"]["red"]:
            game["winner"] = "red"
            game["winReason"] = "all"
            game["phase"] = "ended"
            self.add_history("红队胜利：目标词全部翻开", "good")
        elif game["score"]["blue"] >= game["config"]["blue"]:
            game["winner"] = "blue"
            game["winReason"] = "all"
            game["phase"] = "ended"
            self.add_history("蓝队胜利：目标词全部翻开", "good")
        elif is_opponent_target:
            self.end_turn("翻到对方目标词，回合结束")
        elif color == "neutral":
            self.end_turn("翻到无效词，回合结束")
        elif game["flips"] >= game["limit"]:
            self.end_turn("已达翻词上限，回合结束")

    def pass_turn(self, role):
        self.require_ready()
        game = self.state
        if game["winner"]:
            raise GameError("本局已经结束")
        if game["phase"] != "guess":
            raise GameError("当前不是翻词阶段")

        expected = f"{game['currentTeam']}_member"
        if role != expected:
            raise GameError("只有当前队伍队员可以弃权")

        team_label = "红队" if game["currentTeam"] == "red" else "蓝队"
        self.add_history(f"{team_label}弃权", "turn")
        self.end_turn(f"{team_label}弃权，回合结束")

    def end_turn(self, message):
        game = self.state
        game["currentTeam"] = "blue" if game["currentTeam"] == "red" else "red"
        game["phase"] = "clue"
        game["flips"] = 0
        game["limit"] = 1
        game["clueWord"] = ""
        team_label = "红队" if game["currentTeam"] == "red" else "蓝队"
        self.add_history(f"轮到{team_label}", "turn")


async def websocket_handler(request):
    role = request.query.get("role", "")
    if role not in ALL_ROLES:
        return web.Response(text="角色参数无效", status=400)

    room = request.app["room"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async with room.lock:
        if role in CAPTAIN_ROLES:
            existing = room.captain_connections[role]
            if existing is not None and not existing.closed:
                await MultiRoom.send_json(
                    ws,
                    {
                        "type": "occupied",
                        "role": role,
                        "message": "该角色已经连接，请先关闭另一端",
                    },
                )
                await ws.close()
                return ws
            room.captain_connections[role] = ws
        elif role in MEMBER_ROLES:
            team = role.split("_")[0]
            room.member_connections[team].append(ws)
        else:
            room.observers.append(ws)

    await MultiRoom.send_json(ws, room.state_for(role))
    await room.broadcast_state()

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    await MultiRoom.send_json(
                        ws, {"type": "error", "message": "消息格式错误"}
                    )
                    continue
                await room.handle_message(role, data, ws)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        async with room.lock:
            if role in CAPTAIN_ROLES:
                if room.captain_connections[role] is ws:
                    room.captain_connections[role] = None
            elif role in MEMBER_ROLES:
                team = role.split("_")[0]
                if ws in room.member_connections[team]:
                    room.member_connections[team].remove(ws)
            else:
                if ws in room.observers:
                    room.observers.remove(ws)
        await room.broadcast_state()
    return ws


def create_app():
    app = web.Application()
    app["room"] = MultiRoom()
    app.router.add_get(
        "/", lambda request: web.FileResponse(MULTI_DIR / "index.html")
    )
    app.router.add_get(
        "/game.js", lambda request: web.FileResponse(MULTI_DIR / "game.js")
    )
    app.router.add_get(
        "/styles.css", lambda request: web.FileResponse(ROOT / "styles.css")
    )
    app.router.add_get(
        "/multi.css", lambda request: web.FileResponse(MULTI_DIR / "styles.css")
    )
    app.router.add_get("/ws", websocket_handler)
    return app


def lan_addresses():
    addresses = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in addresses:
                addresses.append(ip)
    except OSError:
        pass

    if not addresses:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            ip = probe.getsockname()[0]
            if ip not in addresses:
                addresses.append(ip)
        except OSError:
            pass
        finally:
            probe.close()
    return addresses


def main():
    parser = argparse.ArgumentParser(description="词影迷踪多人局域网版")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=8010, help="监听端口，默认 8010")
    args = parser.parse_args()

    print("词影迷踪多人局域网版")
    print(f"本机访问：http://127.0.0.1:{args.port}/")
    for ip in lan_addresses():
        print(f"局域网访问：http://{ip}:{args.port}/")
    print("需要连接红方队长、蓝方队长、红方队员、蓝方队员和至少一位观察者。")

    web.run_app(
        create_app(),
        host=args.host,
        port=args.port,
        print=lambda *_: None,
        access_log=None,
    )


if __name__ == "__main__":
    main()
