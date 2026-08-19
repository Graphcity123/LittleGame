#!/usr/bin/env python3
"""阿瓦隆 · 5-10 人局域网联机版，支持动态人数与对应角色配置。"""

import argparse
import asyncio
import json
import random
import socket
from pathlib import Path

from aiohttp import WSMsgType, web


AVALON_DIR = Path(__file__).resolve().parent
ROOT = AVALON_DIR.parent

SUCCESS_WIN = 3               # 任务成功三次触发刺杀
FAIL_WIN = 3                  # 任务失败三次坏人胜利

# 人数 -> (角色池, 五轮任务人数)
CONFIGS = {
    5: (["merlin", "percival", "loyal", "morgana", "assassin"], [2, 3, 2, 3, 3]),
    6: (["merlin", "percival", "loyal", "loyal", "morgana", "assassin"], [2, 3, 4, 3, 4]),
    7: (["merlin", "percival", "loyal", "loyal", "morgana", "assassin", "minion"], [2, 3, 4, 4, 4]),
    8: (["merlin", "percival", "loyal", "loyal", "loyal", "morgana", "assassin", "minion"], [3, 4, 4, 5, 5]),
    9: (["merlin", "percival", "loyal", "loyal", "loyal", "morgana", "assassin", "oberon", "mordred"], [3, 4, 4, 5, 5]),
    10: (["merlin", "percival", "loyal", "loyal", "loyal", "loyal", "morgana", "assassin", "oberon", "mordred"], [3, 4, 4, 5, 5]),
}

ROLE_LABELS = {
    "merlin": "梅林",
    "percival": "派西维尔",
    "loyal": "忠臣",
    "morgana": "莫甘娜",
    "assassin": "刺客",
    "minion": "爪牙",
    "oberon": "奥伯伦",
    "mordred": "莫德雷德",
    "lancelot": "兰斯洛特",
}
FACTION = {
    "merlin": "good",
    "percival": "good",
    "loyal": "good",
    "morgana": "evil",
    "assassin": "evil",
    "minion": "evil",
    "oberon": "evil",
    "mordred": "evil",
    "lancelot": "good",  # 第三轮可能随机叛变为 evil
}
FACTION_LABELS = {"good": "好人阵营", "evil": "坏人阵营"}


def required_approves(n):
    """发车投票需赞成票数（过半数）。6 人时 = 4，与规则一致。"""
    return n // 2 + 1


class GameError(Exception):
    pass


class AvalonRoom:
    def __init__(self):
        # pid -> {nickname, seat, role, faction, ws, online}
        self.players = {}
        self.state = None
        self.result_seq = 0
        self.lock = asyncio.Lock()
        self.player_count = 6
        self.deep_water = False

    # ---------- 工具 ----------

    @staticmethod
    async def send_json(ws, payload):
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json(payload)
        except (ConnectionResetError, RuntimeError):
            return

    def joined(self):
        return [p for p in self.players.values() if p["nickname"]]

    def seat_of(self, pid):
        player = self.players.get(pid)
        return player["seat"] if player else None

    def pid_of(self, seat):
        for pid, player in self.players.items():
            if player["seat"] == seat:
                return pid
        return None

    def nickname_of_seat(self, seat):
        pid = self.pid_of(seat)
        return self.players[pid]["nickname"] if pid else ""

    def role_of_seat(self, seat):
        pid = self.pid_of(seat)
        return self.players[pid]["role"] if pid else None

    def next_seat(self, seat):
        n = self.state["playerCount"] if self.state else self.player_count
        return seat % n + 1

    def add_history(self, text, tone=""):
        self.state["history"].append({"text": text, "tone": tone})
        if len(self.state["history"]) > 80:
            self.state["history"] = self.state["history"][-80:]

    # ---------- 状态投射（按玩家过滤隐私信息） ----------

    def role_info(self, pid):
        """返回该玩家在“信息确认”环节应看到的内容；无额外信息返回 None。"""
        player = self.players[pid]
        role = player["role"]
        if role == "merlin":
            # 梅林看得到所有坏人，但会把莫德雷德认成好人
            evil = [
                p["seat"]
                for p in self.players.values()
                if p["seat"] and p["faction"] == "evil" and p["role"] != "mordred"
            ]
            return {"kind": "merlin", "evilSeats": sorted(evil)}
        if role == "percival":
            seats = [
                p["seat"]
                for p in self.players.values()
                if p["seat"] and p["role"] in ("merlin", "morgana")
            ]
            return {"kind": "percival", "mysterySeats": sorted(seats)}
        if role in ("morgana", "assassin", "minion", "mordred"):
            # 红方互认，但彼此都看不到奥伯伦；兰斯洛特（即使叛变）也不参与互认
            teammates = [
                {"seat": p["seat"], "role": p["role"]}
                for p in self.players.values()
                if p["seat"]
                and p["seat"] != player["seat"]
                and p["role"] in ("morgana", "assassin", "minion", "mordred")
            ]
            teammates.sort(key=lambda t: t["seat"])
            return {"kind": "evil", "teammates": teammates}
        return None

    def state_for(self, pid):
        player = self.players.get(pid)
        if player is None:
            player = {"nickname": "", "seat": None, "role": None, "faction": None}

        base = {
            "type": "state",
            "playerId": pid,
            "nickname": player["nickname"],
            "playerCount": len(self.joined()),
            "maxPlayers": self.player_count,
            "deepWater": self.deep_water,
            "joinedNicknames": [p["nickname"] for p in self.joined()],
            "canStart": bool(
                self.state is None
                and len(self.joined()) == self.player_count
                and player["nickname"]
            ),
        }

        if self.state is None:
            return {**base, "game": None}

        game = self.state
        n = game["playerCount"]
        seats = []
        for seat in range(1, n + 1):
            seats.append(
                {
                    "seat": seat,
                    "nickname": self.nickname_of_seat(seat),
                    "online": bool(self.pid_of(seat) and self.players[self.pid_of(seat)]["online"]),
                }
            )

        leader_seat = game["leaderSeat"]
        my_seat = player["seat"]
        my_role = player["role"]
        my_faction = player["faction"]
        proposal = game["proposal"]

        can_act = {
            "confirm": (
                game["phase"] in ("role_reveal", "info_reveal")
                and pid not in game["confirmed"]
            ),
            "propose": (
                game["phase"] == "propose" and my_seat == leader_seat
            ),
            "speechDone": (
                game["phase"] == "speech" and my_seat == game["speakerSeat"]
            ),
            "voteBoarding": (
                game["phase"] == "vote" and pid not in game["boardingVotes"]
            ),
            "voteMission": (
                game["phase"] == "mission"
                and my_seat in proposal
                and pid not in game["missionVotes"]
            ),
            "ladyCheck": (
                game["phase"] == "lady" and my_seat == game["ladySeat"]
            ),
            "startAssassinate": (
                game["phase"] in ("propose", "speech", "vote", "mission")
                and my_role == "assassin"
            ),
            "assassinate": (
                game["phase"] == "assassinate" and my_role == "assassin"
            ),
            "reset": game["phase"] == "ended",
        }

        # 公开投票结果（只公布票数，不公布谁投了什么）
        last_vote = game.get("lastVote")

        # 投票进度：谁还没投票（不公布投了什么）
        voted_seats = []
        if game["phase"] == "vote":
            voted_seats = sorted(self.seat_of(p) for p in game["boardingVotes"])
        elif game["phase"] == "mission":
            voted_seats = sorted(self.seat_of(p) for p in game["missionVotes"])

        ended = game["phase"] == "ended"
        role_reveal = None
        if ended:
            role_reveal = {}
            for seat in range(1, n + 1):
                role = self.role_of_seat(seat)
                role_reveal[seat] = {
                    "nickname": self.nickname_of_seat(seat),
                    "role": role,
                    "faction": FACTION[role],
                    "roleLabel": ROLE_LABELS[role],
                }

        # 匿名投票：对局结束后才揭示谁投了什么
        boardings = game["boardings"]
        missions = game["missions"]
        if not ended:
            boardings = [
                {k: v for k, v in b.items() if k not in ("approveSeats", "rejectSeats")}
                for b in boardings
            ]
            missions = [
                {k: v for k, v in m.items() if k not in ("successSeats", "failSeats")}
                for m in missions
            ]

        # 身份与信息只在对应阶段展示（结束前不向他人透露）
        show_role = game["phase"] in ("role_reveal", "info_reveal", "propose", "speech", "vote", "mission", "lady", "assassinate", "ended")
        show_info = game["phase"] != "role_reveal"

        projected = {
            **base,
            "game": {
                "phase": game["phase"],
                "round": game["round"],
                "playerCount": game["playerCount"],
                "teamSize": game["teamSize"],
                "teamSizes": game["teamSizes"],
                "requiredApproves": game["requiredApproves"],
                "leaderSeat": leader_seat,
                "leaderNickname": self.nickname_of_seat(leader_seat),
                "proposal": proposal,
                "speakerSeat": game.get("speakerSeat"),
                "speakerNickname": self.nickname_of_seat(game["speakerSeat"]) if game.get("speakerSeat") else "",
                "spoken": game.get("spoken", []),
                "ladySeat": game.get("ladySeat"),
                "ladyChecks": game.get("ladyChecks", []),
                "privateResults": game.get("privateResults", {}).get(my_seat, []),
                "rejections": game["rejections"],
                "score": game["score"],
                "missions": missions,
                "boardings": boardings,
                "lastResults": game["lastResults"],
                "history": game["history"],
                "seats": seats,
                "mySeat": my_seat,
                "myRole": my_role if show_role else None,
                "myFaction": my_faction if show_role else None,
                "myRoleLabel": ROLE_LABELS[my_role] if show_role and my_role else "",
                "roleInfo": self.role_info(pid) if (show_info and my_role) else None,
                "myConfirmed": pid in game["confirmed"],
                "myVoted": (
                    pid in game["boardingVotes"]
                    if game["phase"] == "vote"
                    else pid in game["missionVotes"]
                    if game["phase"] == "mission"
                    else False
                ),
                "lastVote": last_vote,
                "votedSeats": voted_seats,
                "winner": game["winner"],
                "winReason": game["winReason"],
                "assassinTarget": game["assassinTarget"],
                "roleReveal": role_reveal,
            },
            "canAct": can_act,
        }
        return projected

    async def broadcast_state(self):
        for pid, player in list(self.players.items()):
            if player["online"] and player.get("ws") is not None:
                await self.send_json(player["ws"], self.state_for(pid))
        if self.state is not None:
            self.state["lastResults"] = []
            self.state["privateResults"] = {}

    # ---------- 游戏流程 ----------

    def start_game(self):
        n = self.player_count
        role_pool, team_sizes = CONFIGS[n]
        pids = [pid for pid, p in self.players.items() if p["nickname"]]
        random.shuffle(pids)
        roles = list(role_pool)
        if self.deep_water:
            # 兰斯洛特随机替代一位忠臣
            roles[roles.index("loyal")] = "lancelot"
        random.shuffle(roles)

        for seat, (pid, role) in enumerate(zip(pids, roles), start=1):
            self.players[pid]["seat"] = seat
            self.players[pid]["role"] = role
            self.players[pid]["faction"] = FACTION[role]

        leader = random.randint(1, n)
        self.state = {
            "phase": "role_reveal",
            "round": 1,
            "playerCount": n,
            "teamSize": team_sizes[0],
            "teamSizes": team_sizes,
            "requiredApproves": required_approves(n),
            "deepWater": self.deep_water,
            "leaderSeat": leader,
            "ladySeat": self.next_seat(leader) if self.deep_water else None,
            "ladyChecks": [],
            "proposal": [],
            "speakerSeat": None,
            "spoken": [],
            "rejections": 0,
            "score": {"good": 0, "evil": 0},
            "missions": [],
            "winner": None,
            "winReason": "",
            "assassinTarget": None,
            "confirmed": set(),
            "boardingVotes": {},
            "missionVotes": {},
            "lastVote": None,
            "boardings": [],
            "lastResults": [],
            "privateResults": {},
            "history": [
                {"text": "角色已随机分配，请查看你的身份并确认", "tone": "turn"}
            ],
        }

    def confirm_reveal(self, pid):
        game = self.state
        game["confirmed"].add(pid)
        total = len(self.joined())
        if len(game["confirmed"]) < total:
            return

        if game["phase"] == "role_reveal":
            game["phase"] = "info_reveal"
            game["confirmed"] = set()
            self.add_history("所有玩家已确认身份，进入信息确认", "turn")
        elif game["phase"] == "info_reveal":
            game["phase"] = "propose"
            game["confirmed"] = set()
            self.add_history(
                f"第 1 轮开始 · 车长 {self.nickname_of_seat(game['leaderSeat'])} "
                f"需选择 {game['teamSize']} 人上车",
                "turn",
            )

    def propose_team(self, pid, seats):
        game = self.state
        leader = game["leaderSeat"]
        if self.seat_of(pid) != leader:
            raise GameError("只有当前车长可以选人")

        if len(seats) != game["teamSize"]:
            raise GameError(f"需要选择 {game['teamSize']} 人上车")
        if len(set(seats)) != len(seats):
            raise GameError("不能重复选择同一人")
        if any(not isinstance(s, int) or s < 1 or s > game["playerCount"] for s in seats):
            raise GameError("座位编号无效")

        seats = sorted(seats)
        game["proposal"] = seats
        names = "、".join(f"{s}号·{self.nickname_of_seat(s)}" for s in seats)

        # 进入发言环节：从车长的下一位开始顺时针依次发言
        game["phase"] = "speech"
        game["speakerSeat"] = self.next_seat(leader)
        game["spoken"] = []

        if game["rejections"] >= 2:
            # 第三次发车：取消投票，发言结束后强制上车
            self.add_history(f"第 3 次发车，取消投票，强制上车：{names}", "turn")
        else:
            self.add_history(
                f"车长 {self.nickname_of_seat(leader)} 指定队伍：{names}",
                "turn",
            )
        self.add_history(
            f"进入发言环节，从 {self.nickname_of_seat(game['speakerSeat'])} 开始顺时针发言",
            "turn",
        )

    def speech_done(self, pid):
        game = self.state
        if game["phase"] != "speech":
            raise GameError("当前不是发言阶段")
        speaker = game["speakerSeat"]
        if self.seat_of(pid) != speaker:
            raise GameError("还没轮到你发言")

        game["spoken"].append(speaker)
        leader = game["leaderSeat"]

        if speaker == leader:
            # 车长发言结束，发言环节结束
            names = "、".join(f"{s}号·{self.nickname_of_seat(s)}" for s in game["proposal"])
            if game["rejections"] >= 2:
                self.add_history("发言结束，第 3 次发车强制上车", "turn")
                self.launch_mission()
            else:
                game["phase"] = "vote"
                game["boardingVotes"] = {}
                game["lastVote"] = None
                self.add_history(f"发言结束，进入发车投票：{names}", "turn")
        else:
            game["speakerSeat"] = self.next_seat(speaker)
            self.add_history(
                f"{self.nickname_of_seat(speaker)} 发言结束，"
                f"轮到 {self.nickname_of_seat(game['speakerSeat'])}",
                "turn",
            )

    def vote_boarding(self, pid, approve):
        game = self.state
        if game["phase"] != "vote":
            raise GameError("当前不是发车投票阶段")
        if pid in game["boardingVotes"]:
            raise GameError("你已经投过票了")

        game["boardingVotes"][pid] = bool(approve)
        n = game["playerCount"]
        if len(game["boardingVotes"]) < n:
            return

        approves = sum(1 for v in game["boardingVotes"].values() if v)
        rejects = n - approves
        passed = approves >= game["requiredApproves"]
        game["lastVote"] = {"approve": approves, "reject": rejects, "passed": passed}
        game["boardings"].append(
            {
                "round": game["round"],
                "approve": approves,
                "reject": rejects,
                "passed": passed,
                "approveSeats": sorted(
                    self.seat_of(p) for p, v in game["boardingVotes"].items() if v
                ),
                "rejectSeats": sorted(
                    self.seat_of(p) for p, v in game["boardingVotes"].items() if not v
                ),
            }
        )
        self.push_result("boarding", ok=passed, a=approves, b=rejects)

        if passed:
            game["phase"] = "vote"  # 保持，launch_mission 会改为 mission
            self.add_history(
                f"发车投票：赞成 {approves} 票，反对 {rejects} 票 → 发车成功",
                "good",
            )
            self.launch_mission()
        else:
            game["rejections"] += 1
            game["leaderSeat"] = self.next_seat(game["leaderSeat"])
            game["proposal"] = []
            game["phase"] = "propose"
            self.add_history(
                f"发车投票：赞成 {approves} 票，反对 {rejects} 票 → 发车失败，"
                f"下一位车长 {self.nickname_of_seat(game['leaderSeat'])}",
                "bad",
            )

    def launch_mission(self):
        game = self.state
        game["phase"] = "mission"
        game["missionVotes"] = {}
        seats = game["proposal"]
        names = "、".join(f"{s}号·{self.nickname_of_seat(s)}" for s in seats)
        self.add_history(f"发车成功，车上成员 {names} 开始执行任务", "turn")

    def vote_mission(self, pid, success):
        game = self.state
        if game["phase"] != "mission":
            raise GameError("当前不是任务阶段")
        if self.seat_of(pid) not in game["proposal"]:
            raise GameError("你不是车上成员")
        if pid in game["missionVotes"]:
            raise GameError("你已经投过票了")

        success = bool(success)
        player = self.players[pid]
        if player["faction"] == "good" and not success:
            raise GameError("好人阵营必须投任务成功")

        game["missionVotes"][pid] = success
        if len(game["missionVotes"]) < len(game["proposal"]):
            return

        successes = sum(1 for v in game["missionVotes"].values() if v)
        fails = len(game["missionVotes"]) - successes
        mission_ok = fails == 0
        game["missions"].append(
            {
                "round": game["round"],
                "size": game["teamSize"],
                "success": mission_ok,
                "successVotes": successes,
                "failVotes": fails,
                "seats": list(game["proposal"]),
                "leaderSeat": game["leaderSeat"],
                "successSeats": sorted(
                    self.seat_of(p) for p, v in game["missionVotes"].items() if v
                ),
                "failSeats": sorted(
                    self.seat_of(p) for p, v in game["missionVotes"].items() if not v
                ),
            }
        )
        game["lastVote"] = None
        self.push_result("mission", ok=mission_ok, a=successes, b=fails)

        # 兰斯洛特破坏任务的讯息：当场向所有人公开
        if not mission_ok and self.deep_water:
            lancelot_pid = self.find_role_pid("lancelot")
            if (
                lancelot_pid
                and self.players[lancelot_pid]["seat"] in game["proposal"]
                and game["missionVotes"].get(lancelot_pid) is False
            ):
                seat = self.players[lancelot_pid]["seat"]
                self.push_result("lancelot_trace", seat=seat, nickname=self.nickname_of_seat(seat))
                self.add_history(
                    f"任务失败，兰斯洛特（{seat}号·{self.nickname_of_seat(seat)}）参与了破坏",
                    "bad",
                )

        if mission_ok:
            game["score"]["good"] += 1
            self.add_history("任务成功", "good")
        else:
            game["score"]["evil"] += 1
            self.add_history("任务失败", "bad")

        if game["score"]["evil"] >= FAIL_WIN:
            self.end_game("evil", "任务失败三次，坏人胜利")
            return
        if game["score"]["good"] >= SUCCESS_WIN:
            game["phase"] = "assassinate"
            self.mark_assassinate_start("forced")
            self.add_history("任务成功三次，进入刺客行刺环节", "turn")
            return

        # 湖中仙女查验（第 2/3/4 轮任务结束后）
        if self.deep_water and game["round"] in (2, 3, 4):
            game["phase"] = "lady"
            self.add_history(
                f"第 {game['round']} 轮任务结束，湖中仙女"
                f"（{self.nickname_of_seat(game['ladySeat'])}）可以查验一人",
                "turn",
            )
        else:
            self.advance_round()

    def advance_round(self):
        game = self.state
        game["round"] += 1
        game["teamSize"] = game["teamSizes"][game["round"] - 1]
        game["rejections"] = 0
        game["leaderSeat"] = self.next_seat(game["leaderSeat"])
        game["proposal"] = []
        game["phase"] = "propose"
        if self.deep_water and game["round"] == 3:
            self.flip_lancelot()
        self.add_history(
            f"第 {game['round']} 轮开始 · 车长 {self.nickname_of_seat(game['leaderSeat'])} "
            f"需选择 {game['teamSize']} 人上车",
            "turn",
        )

    def flip_lancelot(self):
        pid = self.find_role_pid("lancelot")
        if not pid:
            return
        flipped = random.random() < 0.5
        seat = self.players[pid]["seat"]
        if flipped:
            self.players[pid]["faction"] = "evil"
        self.push_private_result(seat, "lancelot", flipped=flipped)
        # 梅林也能看到兰斯洛特的阵营变化
        merlin_pid = self.find_role_pid("merlin")
        if merlin_pid:
            self.push_private_result(
                self.players[merlin_pid]["seat"],
                "lancelot_merlin",
                lancelotSeat=seat,
                nickname=self.nickname_of_seat(seat),
                flipped=flipped,
            )

    def lady_check(self, pid, target):
        game = self.state
        if game["phase"] != "lady":
            raise GameError("当前不是湖中仙女查验阶段")
        holder = game["ladySeat"]
        if self.seat_of(pid) != holder:
            raise GameError("只有当前湖中仙女可以查验")
        if not isinstance(target, int) or target < 1 or target > game["playerCount"]:
            raise GameError("目标无效")
        if target == holder:
            raise GameError("不能查验自己")

        target_pid = self.pid_of(target)
        faction = self.players[target_pid]["faction"]
        game["ladyChecks"].append(
            {"round": game["round"], "checkedBy": holder, "target": target}
        )
        game["ladySeat"] = target
        self.push_private_result(
            holder,
            "lady",
            target=target,
            targetNickname=self.nickname_of_seat(target),
            faction=faction,
        )
        self.add_history(
            f"湖中仙女（{self.nickname_of_seat(holder)}）查验了 "
            f"{target}号·{self.nickname_of_seat(target)}，仙女转交给 TA",
            "turn",
        )
        self.advance_round()

    def assassinate_now(self, pid):
        game = self.state
        if game["phase"] not in ("propose", "speech", "vote", "mission"):
            raise GameError("当前不能行刺")
        if self.players[pid]["role"] != "assassin":
            raise GameError("只有刺客可以行刺")
        game["phase"] = "assassinate"
        game["boardingVotes"] = {}
        game["missionVotes"] = {}
        self.mark_assassinate_start("voluntary")
        self.add_history("刺客主动发起行刺", "turn")

    def assassinate(self, pid, target):
        game = self.state
        if game["phase"] != "assassinate":
            raise GameError("当前不是行刺阶段")
        if self.players[pid]["role"] != "assassin":
            raise GameError("只有刺客可以行刺")
        if not isinstance(target, int) or target < 1 or target > game["playerCount"]:
            raise GameError("目标无效")

        game["assassinTarget"] = target
        merlin_seat = None
        for p in self.players.values():
            if p["role"] == "merlin":
                merlin_seat = p["seat"]
        target_name = self.nickname_of_seat(target)

        if target == merlin_seat:
            self.add_history(f"刺客行刺 {target}号·{target_name}，命中梅林", "bad")
            self.end_game("evil", f"刺客刺杀了梅林（{target}号·{target_name}），坏人胜利")
        else:
            self.add_history(f"刺客行刺 {target}号·{target_name}，未命中梅林", "good")
            self.end_game("good", f"刺客刺杀失败（{target}号·{target_name} 不是梅林），好人胜利")

    def end_game(self, winner, reason):
        game = self.state
        game["winner"] = winner
        game["winReason"] = reason
        game["phase"] = "ended"
        self.add_history(f"{'好人' if winner == 'good' else '坏人'}胜利：{reason}", "turn")

    def push_result(self, kind, **extra):
        self.result_seq += 1
        self.state["lastResults"].append({"seq": self.result_seq, "kind": kind, **extra})

    def push_private_result(self, seat, kind, **extra):
        self.result_seq += 1
        bucket = self.state.setdefault("privateResults", {})
        bucket.setdefault(seat, []).append(
            {"seq": self.result_seq, "kind": kind, **extra}
        )

    def find_role_pid(self, role):
        for pid, p in self.players.items():
            if p["role"] == role:
                return pid
        return None

    def mark_assassinate_start(self, mode):
        self.push_result("assassinate", mode=mode)

    def reset(self):
        self.state = None
        for pid in list(self.players.keys()):
            player = self.players[pid]
            player["seat"] = None
            player["role"] = None
            player["faction"] = None

    # ---------- 消息分发 ----------

    async def handle_message(self, pid, message, ws):
        action = message.get("action") if isinstance(message, dict) else None
        async with self.lock:
            try:
                if pid not in self.players:
                    raise GameError("玩家未连接")
                if action == "join":
                    self.join(pid, message)
                elif action == "start":
                    self.start(pid)
                elif action == "confirm":
                    self.confirm(pid)
                elif action == "propose_team":
                    self.propose(pid, message)
                elif action == "speech_done":
                    self.do_speech_done(pid)
                elif action == "vote_boarding":
                    self.board(pid, message)
                elif action == "vote_mission":
                    self.mission(pid, message)
                elif action == "assassinate_now":
                    self.do_assassinate_now(pid)
                elif action == "assassinate":
                    self.do_assassinate(pid, message)
                elif action == "set_player_count":
                    self.do_set_player_count(pid, message)
                elif action == "set_deep_water":
                    self.do_set_deep_water(pid, message)
                elif action == "lady_check":
                    self.do_lady_check(pid, message)
                elif action == "reset":
                    self.do_reset(pid)
                else:
                    raise GameError("无法识别的操作")
                await self.broadcast_state()
            except GameError as exc:
                await self.send_json(ws, {"type": "error", "message": str(exc)})

    def join(self, pid, message):
        nickname = str(message.get("nickname", "")).strip()
        if not nickname:
            raise GameError("请输入昵称")
        if len(nickname) > 12:
            raise GameError("昵称最长 12 个字")
        for other_pid, other in self.players.items():
            if other_pid != pid and other["nickname"] == nickname:
                raise GameError("该昵称已被使用")

        player = self.players[pid]
        if player["nickname"]:
            # 已加入（重连），保持身份不变
            return
        if self.state is not None:
            raise GameError("游戏已开始，无法中途加入")
        if len(self.joined()) >= self.player_count:
            raise GameError(f"已有 {self.player_count} 名玩家")
        player["nickname"] = nickname

    def start(self, pid):
        if self.state is not None:
            raise GameError("游戏已经开始了")
        if len(self.joined()) != self.player_count:
            raise GameError(f"需要 {self.player_count} 名玩家全部加入")
        self.start_game()

    def confirm(self, pid):
        if self.state is None:
            raise GameError("游戏尚未开始")
        if self.state["phase"] not in ("role_reveal", "info_reveal"):
            raise GameError("当前无需确认")
        if pid in self.state["confirmed"]:
            raise GameError("你已经确认过了")
        self.confirm_reveal(pid)

    def propose(self, pid, message):
        if self.state is None:
            raise GameError("游戏尚未开始")
        if self.state["phase"] != "propose":
            raise GameError("当前不是选人阶段")
        seats = message.get("seats")
        if not isinstance(seats, list):
            raise GameError("队伍数据无效")
        self.propose_team(pid, seats)

    def do_speech_done(self, pid):
        if self.state is None:
            raise GameError("游戏尚未开始")
        self.speech_done(pid)

    def board(self, pid, message):
        if self.state is None:
            raise GameError("游戏尚未开始")
        approve = message.get("approve")
        if not isinstance(approve, bool):
            raise GameError("投票数据无效")
        self.vote_boarding(pid, approve)

    def mission(self, pid, message):
        if self.state is None:
            raise GameError("游戏尚未开始")
        success = message.get("success")
        if not isinstance(success, bool):
            raise GameError("投票数据无效")
        self.vote_mission(pid, success)

    def do_assassinate_now(self, pid):
        if self.state is None:
            raise GameError("游戏尚未开始")
        self.assassinate_now(pid)

    def do_assassinate(self, pid, message):
        if self.state is None:
            raise GameError("游戏尚未开始")
        target = message.get("target")
        if not isinstance(target, int):
            raise GameError("目标数据无效")
        self.assassinate(pid, target)

    def do_reset(self, pid):
        if self.state is None or self.state["phase"] != "ended":
            raise GameError("只能在对局结束后重新开始")
        self.reset()

    def set_player_count(self, pid, count):
        if self.state is not None:
            raise GameError("游戏已开始，无法修改人数")
        if not isinstance(count, int) or count not in CONFIGS:
            raise GameError("游戏人数需在 5 到 10 之间")
        if len(self.joined()) > count:
            raise GameError(f"当前已加入 {len(self.joined())} 人，无法改为 {count} 人")
        self.player_count = count

    def do_set_player_count(self, pid, message):
        count = message.get("count")
        self.set_player_count(pid, count)

    def set_deep_water(self, pid, enabled):
        if self.state is not None:
            raise GameError("游戏已开始，无法修改设置")
        self.deep_water = bool(enabled)

    def do_set_deep_water(self, pid, message):
        self.set_deep_water(pid, message.get("deepWater", False))

    def do_lady_check(self, pid, message):
        if self.state is None:
            raise GameError("游戏尚未开始")
        target = message.get("target")
        if not isinstance(target, int):
            raise GameError("目标数据无效")
        self.lady_check(pid, target)


async def websocket_handler(request):
    pid = request.query.get("id", "").strip()
    if not pid:
        return web.Response(text="缺少玩家 id 参数", status=400)

    room = request.app["room"]
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async with room.lock:
        player = room.players.get(pid)
        if player is None:
            player = {
                "nickname": "",
                "seat": None,
                "role": None,
                "faction": None,
                "ws": None,
                "online": False,
            }
            room.players[pid] = player
        old_ws = player.get("ws")
        if old_ws is not None and not old_ws.closed:
            try:
                await old_ws.close()
            except (ConnectionResetError, RuntimeError):
                pass
        player["ws"] = ws
        player["online"] = True

    await AvalonRoom.send_json(ws, room.state_for(pid))
    await room.broadcast_state()

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    await AvalonRoom.send_json(
                        ws, {"type": "error", "message": "消息格式错误"}
                    )
                    continue
                await room.handle_message(pid, data, ws)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        async with room.lock:
            player = room.players.get(pid)
            if player is not None and player.get("ws") is ws:
                player["online"] = False
                player["ws"] = None
                if room.state is None:
                    # 大厅阶段直接移除，释放座位给新玩家
                    room.players.pop(pid, None)
                elif not player["nickname"]:
                    room.players.pop(pid, None)
        await room.broadcast_state()
    return ws


def create_app():
    app = web.Application()
    app["room"] = AvalonRoom()
    app.router.add_get(
        "/", lambda request: web.FileResponse(AVALON_DIR / "index.html")
    )
    app.router.add_get(
        "/game.js", lambda request: web.FileResponse(AVALON_DIR / "game.js")
    )
    app.router.add_get(
        "/styles.css", lambda request: web.FileResponse(ROOT / "styles.css")
    )
    app.router.add_get(
        "/avalon.css", lambda request: web.FileResponse(AVALON_DIR / "styles.css")
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
    parser = argparse.ArgumentParser(description="阿瓦隆 5-10 人局域网版")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=8020, help="监听端口，默认 8020")
    args = parser.parse_args()

    print("阿瓦隆 · 5-10 人局域网联机版")
    print(f"本机访问：http://127.0.0.1:{args.port}/")
    for ip in lan_addresses():
        print(f"局域网访问：http://{ip}:{args.port}/")
    print("大厅内可设定游戏人数（5-10），满员后任意一人可开局。")

    web.run_app(
        create_app(),
        host=args.host,
        port=args.port,
        print=lambda *_: None,
        access_log=None,
    )


if __name__ == "__main__":
    main()
