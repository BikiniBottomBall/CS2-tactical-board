"""op_handler 锁与广播测试（fake room + 收集广播）"""

from types import SimpleNamespace

import pytest

import op_handler


@pytest.fixture
def room():
    return SimpleNamespace(code="TEST01", board_state={}, tactic_id=None, players={})


@pytest.fixture
def sent(monkeypatch):
    msgs = []

    async def fake_broadcast(room, msg, exclude_user=""):
        msgs.append((msg, exclude_user))

    monkeypatch.setattr(op_handler, "broadcast", fake_broadcast)
    return msgs


@pytest.mark.asyncio
async def test_lock_request_acquire(room, sent):
    await op_handler.h_lock_request(room, "u1", {"resource": "utility_recording"})
    assert op_handler._lock_state["TEST01"]["utility_recording"]["holder"] == "u1"
    assert sent[0][0]["op"] == "lock_acquired"


@pytest.mark.asyncio
async def test_lock_request_denied_when_held(room, sent):
    await op_handler.h_lock_request(room, "u1", {"resource": "r"})
    await op_handler.h_lock_request(room, "u2", {"resource": "r"})
    # u2 未获得锁，且没有第二次 lock_acquired 广播
    assert op_handler._lock_state["TEST01"]["r"]["holder"] == "u1"
    assert [m for m, _ in sent if m["op"] == "lock_acquired"] == [
        {"op": "lock_acquired", "resource": "r", "by": "u1"}
    ]


@pytest.mark.asyncio
async def test_lock_release_then_reacquire(room, sent):
    await op_handler.h_lock_request(room, "u1", {"resource": "r"})
    await op_handler.h_lock_release(room, "u1", {"resource": "r"})
    await op_handler.h_lock_request(room, "u2", {"resource": "r"})
    assert op_handler._lock_state["TEST01"]["r"]["holder"] == "u2"


@pytest.mark.asyncio
async def test_locks_isolated_per_room(room, sent):
    other = SimpleNamespace(code="OTHER9", board_state={}, tactic_id=None, players={})
    await op_handler.h_lock_request(room, "u1", {"resource": "r"})
    # 另一房间同名资源不受影响
    await op_handler.h_lock_request(other, "u2", {"resource": "r"})
    assert op_handler._lock_state["OTHER9"]["r"]["holder"] == "u2"


@pytest.mark.asyncio
async def test_cursor_move_broadcast(room, sent):
    await op_handler.h_cursor_move(room, "u1", {"x": 1.5, "z": -2.5})
    msg, exclude = sent[0]
    assert msg == {"op": "cursor_move", "user_id": "u1", "x": 1.5, "z": -2.5}
    assert exclude == "u1"


@pytest.mark.asyncio
async def test_marker_place_and_move(room, sent):
    await op_handler.h_marker_place(room, "u1", {"kind": "marker-t", "x": 1, "y": 2, "z": 3})
    mid = next(iter(room.board_state))
    await op_handler.h_marker_move(room, "u2", {"id": mid, "x": 9, "y": 8, "z": 7})
    assert room.board_state[mid]["x"] == 9
    await op_handler.h_marker_delete(room, "u1", {"id": mid})
    assert room.board_state == {}


@pytest.mark.asyncio
async def test_board_clear(room, sent):
    room.board_state["m-1"] = {"kind": "marker-t"}
    await op_handler.h_board_clear(room, "u1", {})
    assert room.board_state == {}
    assert sent[0][0]["op"] == "board_cleared"


@pytest.mark.asyncio
async def test_tactic_playback_locked(room, sent):
    await op_handler.h_lock_request(room, "u1", {"resource": "tactic_playback"})
    await op_handler.h_tactic_playback(room, "u2", {"playing": True, "step_idx": 0})
    assert any(m["op"] == "error" for m, _ in sent)
