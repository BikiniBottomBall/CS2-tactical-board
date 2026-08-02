"""消息分发器（P9 多人协同）

根据 op 字段将消息路由到对应的处理函数。
Wave 2~5 逐步扩充：cursor_move → board markers/lines/undo/clear。
"""
from room_manager import broadcast, get_room

_seq = 0


def _next_id(prefix='m'):
    """生成递增序号 ID（m-1, m-2, L-1, ...）"""
    global _seq
    _seq += 1
    return f'{prefix}-{_seq}'


async def handle_message(room, user_id: str, msg: dict):
    """分发客户端消息到对应 handler"""
    op = msg.get('op', '')
    if op == 'cursor_move':
        await handle_cursor_move(room, user_id, msg)
    elif op == 'marker_place':
        await handle_marker_place(room, user_id, msg)
    elif op == 'marker_move':
        await handle_marker_move(room, user_id, msg)
    elif op == 'marker_delete':
        await handle_marker_delete(room, user_id, msg)
    elif op == 'line_begin':
        await handle_line_begin(room, user_id, msg)
    elif op == 'line_delete':
        await handle_line_delete(room, user_id, msg)
    elif op == 'board_undo':
        await handle_board_undo(room, user_id, msg)
    elif op == 'board_clear':
        await handle_board_clear(room, user_id, msg)


# ---- cursor ----

async def handle_cursor_move(room, user_id: str, msg: dict):
    """广播光标位置给房间其他人"""
    await broadcast(room, {
        'op': 'cursor_move',
        'user_id': user_id,
        'x': msg.get('x', 0),
        'z': msg.get('z', 0),
    }, exclude_user=user_id)


# ---- markers ----

async def handle_marker_place(room, user_id: str, msg: dict):
    """创建标记 → 分配 ID → 写入 board_state → 广播所有人"""
    mid = _next_id('m')
    room.board_state[mid] = {
        'kind': msg.get('kind', ''),
        'x': msg.get('x'), 'y': msg.get('y'), 'z': msg.get('z'),
        'seq': _seq, 'by': user_id,
    }
    await broadcast(room, {
        'op': 'marker_placed',
        'id': mid,
        'kind': msg.get('kind', ''),
        'x': msg.get('x'), 'y': msg.get('y'), 'z': msg.get('z'),
        'by': user_id,
    })


async def handle_marker_move(room, user_id: str, msg: dict):
    """移动标记 → 更新坐标 → 广播除自己外"""
    mid = msg.get('id')
    if mid not in room.board_state or not isinstance(room.board_state.get(mid), dict):
        return
    room.board_state[mid].update({
        'x': msg.get('x'), 'y': msg.get('y'), 'z': msg.get('z'),
    })
    await broadcast(room, {
        'op': 'marker_moved',
        'id': mid,
        'x': msg.get('x'), 'y': msg.get('y'), 'z': msg.get('z'),
        'by': user_id,
    }, exclude_user=user_id)


async def handle_marker_delete(room, user_id: str, msg: dict):
    """删除标记 → 从 board_state 移除 → 广播除自己外"""
    mid = msg.get('id')
    room.board_state.pop(mid, None)
    await broadcast(room, {
        'op': 'marker_deleted',
        'id': mid,
        'by': user_id,
    }, exclude_user=user_id)


# ---- lines ----

async def handle_line_begin(room, user_id: str, msg: dict):
    """画笔线完成 → 分配 ID → 写入 board_state → 广播所有人"""
    lid = _next_id('L')
    pts = msg.get('points', [])
    room.board_state[lid] = {
        'type': 'line', 'points': pts,
        'seq': _seq, 'by': user_id,
    }
    await broadcast(room, {
        'op': 'line_updated',
        'id': lid,
        'points': pts,
        'by': user_id,
    })


async def handle_line_delete(room, user_id: str, msg: dict):
    """删除画笔线 → 从 board_state 移除 → 广播除自己外"""
    lid = msg.get('id')
    room.board_state.pop(lid, None)
    await broadcast(room, {
        'op': 'line_deleted',
        'id': lid,
        'by': user_id,
    }, exclude_user=user_id)


# ---- undo / clear ----

async def handle_board_undo(room, user_id: str, msg: dict):
    """撤销操作 → 从 board_state 移除 → 广播除自己外"""
    item_id = msg.get('id')
    room.board_state.pop(item_id, None)
    await broadcast(room, {
        'op': 'board_undo',
        'id': item_id,
        'by': user_id,
    }, exclude_user=user_id)


async def handle_board_clear(room, user_id: str, msg: dict):
    """清空整个画板 → 清除 board_state → 广播所有人"""
    room.board_state.clear()
    await broadcast(room, {
        'op': 'board_cleared',
        'by': user_id,
    })
