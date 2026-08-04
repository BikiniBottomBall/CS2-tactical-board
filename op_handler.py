"""消息分发器（P9 多人协同）

锁状态按房间隔离（per-room）：_lock_state[room_code][resource]。
所有 handler 异常在 dispatch 层统一捕获记日志，避免单条坏消息拖垮连接。
"""

import logging
import time

from room_manager import broadcast

logger = logging.getLogger(__name__)

_seq = 0
_lock_state: dict[str, dict[str, dict]] = {}  # {room_code: {resource: {holder, acquired_at}}}


def _next_id(prefix="m"):
    global _seq
    _seq += 1
    return f"{prefix}-{_seq}"


async def handle_message(room, user_id, msg):
    op = msg.get("op", "")
    try:
        if op == "cursor_move":
            await h_cursor_move(room, user_id, msg)
        elif op == "marker_place":
            await h_marker_place(room, user_id, msg)
        elif op == "marker_move":
            await h_marker_move(room, user_id, msg)
        elif op == "marker_delete":
            await h_marker_delete(room, user_id, msg)
        elif op == "line_begin":
            await h_line_begin(room, user_id, msg)
        elif op == "line_delete":
            await h_line_delete(room, user_id, msg)
        elif op == "board_undo":
            await h_board_undo(room, user_id, msg)
        elif op == "board_clear":
            await h_board_clear(room, user_id, msg)
        elif op == "actor_move":
            await h_actor_move(room, user_id, msg)
        elif op == "tactic_select":
            await h_tactic_select(room, user_id, msg)
        elif op == "tactic_playback":
            await h_tactic_playback(room, user_id, msg)
        elif op == "lock_request":
            await h_lock_request(room, user_id, msg)
        elif op == "lock_release":
            await h_lock_release(room, user_id, msg)
        elif op == "utility_recording_start":
            await h_lock_request(
                room, user_id, {"resource": "utility_recording", "op": "lock_request"}
            )
        elif op == "utility_recording_cancel":
            await h_lock_release(
                room, user_id, {"resource": "utility_recording", "op": "lock_release"}
            )
    except Exception:
        logger.exception("[op] 处理 %s 失败（房间 %s 用户 %s）", op, room.code, user_id)


# --- cursor ---
async def h_cursor_move(room, user_id, msg):
    await broadcast(
        room,
        {"op": "cursor_move", "user_id": user_id, "x": msg.get("x", 0), "z": msg.get("z", 0)},
        exclude_user=user_id,
    )


# --- markers ---
async def h_marker_place(room, user_id, msg):
    mid = _next_id("m")
    room.board_state[mid] = {
        "kind": msg.get("kind", ""),
        "x": msg.get("x"),
        "y": msg.get("y"),
        "z": msg.get("z"),
        "seq": _seq,
        "by": user_id,
    }
    await broadcast(
        room,
        {
            "op": "marker_placed",
            "id": mid,
            "kind": msg.get("kind", ""),
            "x": msg.get("x"),
            "y": msg.get("y"),
            "z": msg.get("z"),
            "by": user_id,
        },
    )


async def h_marker_move(room, user_id, msg):
    mid = msg.get("id")
    if mid not in room.board_state:
        return
    room.board_state[mid].update({"x": msg.get("x"), "y": msg.get("y"), "z": msg.get("z")})
    await broadcast(
        room,
        {
            "op": "marker_moved",
            "id": mid,
            "x": msg.get("x"),
            "y": msg.get("y"),
            "z": msg.get("z"),
            "by": user_id,
        },
        exclude_user=user_id,
    )


async def h_marker_delete(room, user_id, msg):
    room.board_state.pop(msg.get("id"), None)
    await broadcast(
        room, {"op": "marker_deleted", "id": msg.get("id"), "by": user_id}, exclude_user=user_id
    )


# --- lines ---
async def h_line_begin(room, user_id, msg):
    lid = _next_id("L")
    room.board_state[lid] = {
        "type": "line",
        "points": msg.get("points", []),
        "seq": _seq,
        "by": user_id,
    }
    await broadcast(
        room, {"op": "line_updated", "id": lid, "points": msg.get("points", []), "by": user_id}
    )


async def h_line_delete(room, user_id, msg):
    room.board_state.pop(msg.get("id"), None)
    await broadcast(
        room, {"op": "line_deleted", "id": msg.get("id"), "by": user_id}, exclude_user=user_id
    )


# --- undo/clear ---
async def h_board_undo(room, user_id, msg):
    room.board_state.pop(msg.get("id"), None)
    await broadcast(
        room, {"op": "board_undo", "id": msg.get("id"), "by": user_id}, exclude_user=user_id
    )


async def h_board_clear(room, user_id, msg):
    room.board_state.clear()
    await broadcast(room, {"op": "board_cleared", "by": user_id})


# --- actors ---
async def h_actor_move(room, user_id, msg):
    await broadcast(
        room,
        {
            "op": "actor_moved",
            "id": msg.get("id"),
            "x": msg.get("x"),
            "y": msg.get("y"),
            "z": msg.get("z"),
            "by": user_id,
        },
        exclude_user=user_id,
    )


# --- tactic ---
async def h_tactic_select(room, user_id, msg):
    room.tactic_id = msg.get("tactic_id")
    await broadcast(room, {"op": "tactic_changed", "tactic_id": room.tactic_id, "by": user_id})


async def h_tactic_playback(room, user_id, msg):
    # 检查锁（per-room）
    lock = _lock_state.get(room.code, {}).get("tactic_playback", {})
    # 锁被他人持有且未超时（30s）→ 拒绝
    if (
        lock.get("holder")
        and lock["holder"] != user_id
        and time.time() - lock.get("acquired_at", 0) < 30
    ):
        await broadcast(
            room,
            {"op": "error", "message": "playback locked by another user"},
            exclude_user=user_id,
        )
        return
    await broadcast(
        room,
        {
            "op": "tactic_playback",
            "playing": msg.get("playing", True),
            "step_idx": msg.get("step_idx", 0),
            "by": user_id,
        },
    )


# --- locks（per-room 隔离） ---
async def h_lock_request(room, user_id, msg):
    resource = msg.get("resource", "")
    room_locks = _lock_state.setdefault(room.code, {})
    existing = room_locks.get(resource)
    if (
        existing
        and existing.get("holder")
        and existing["holder"] != user_id
        and time.time() - existing.get("acquired_at", 0) < 60
    ):
        return  # 锁被占用，静默拒绝
    room_locks[resource] = {"holder": user_id, "acquired_at": time.time()}
    await broadcast(room, {"op": "lock_acquired", "resource": resource, "by": user_id})


async def h_lock_release(room, user_id, msg):
    resource = msg.get("resource", "")
    room_locks = _lock_state.get(room.code, {})
    existing = room_locks.get(resource)
    if existing and existing["holder"] == user_id:
        room_locks[resource] = {}
    await broadcast(room, {"op": "lock_released", "resource": resource})
