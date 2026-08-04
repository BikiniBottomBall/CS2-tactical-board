"""房间内存管理器（P9 多人协同）

所有活跃房间存内存 dict，房间空时持久化到 DB 后销毁。
单进程 uvicorn 足够，不引入 Redis。
"""

import asyncio
import json
import random
import string
from dataclasses import dataclass, field

from fastapi import WebSocket


@dataclass
class RoomState:
    code: str
    name: str
    owner_id: str  # anonymous_id
    players: dict = field(default_factory=dict)  # user_id -> WebSocket
    board_state: dict = field(default_factory=dict)  # markers + lines
    tactic_id: int | None = None
    lock: str = ""  # 当前锁持有者 user_id，空 = 无锁


_rooms: dict[str, RoomState] = {}
_room_lock = asyncio.Lock()


def _gen_code() -> str:
    """生成 6 位房间码（A-Z + 0-9）"""
    chars = string.ascii_uppercase + string.digits
    return "".join(random.choices(chars, k=6))


async def create_room(owner_id: str, name: str = "") -> str:
    """创建房间，返回 6 位码"""
    async with _room_lock:
        for _ in range(5):
            code = _gen_code()
            if code not in _rooms:
                _rooms[code] = RoomState(code=code, name=name, owner_id=owner_id)
                return code
        raise RuntimeError("failed to generate unique room code after 5 attempts")


async def join_room(code: str, user_id: str, ws: WebSocket) -> RoomState:
    """加入房间"""
    async with _room_lock:
        room = _rooms.get(code)
        if not room:
            raise ValueError(f"room {code} not found")
        room.players[user_id] = ws
        return room


async def leave_room(code: str, user_id: str) -> str | None:
    """离开房间。返回 None 或 'destroyed'"""
    async with _room_lock:
        room = _rooms.get(code)
        if not room:
            return None
        room.players.pop(user_id, None)
        if not room.players:
            # 房间空 → 持久化后销毁
            await _persist(room)
            del _rooms[code]
            return "destroyed"
        # owner 离开 → 自动转移给最长在线者
        if user_id == room.owner_id and room.players:
            room.owner_id = next(iter(room.players))
        return None


async def _persist(room: RoomState):
    """持久化房间快照到 DB"""
    from sqlmodel import Session

    from models import Room as RoomModel
    from models import engine

    data = json.dumps(room.board_state, ensure_ascii=False)
    with Session(engine) as db:
        existing = db.get(RoomModel, room.code)
        if existing:
            existing.board_state = data
            existing.is_active = False
            existing.closed_at = __import__("datetime").datetime.now().isoformat(timespec="seconds")
            db.add(existing)
            db.commit()


def get_room(code: str) -> RoomState | None:
    """查询房间（同步）"""
    return _rooms.get(code)


async def broadcast(room: RoomState, msg: dict, exclude_user: str = ""):
    """广播消息给房间所有人（除 exclude_user）"""
    dead = []
    for uid, ws in list(room.players.items()):
        if uid == exclude_user:
            continue
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(uid)
    for uid in dead:
        room.players.pop(uid, None)


def room_count() -> int:
    return len(_rooms)
