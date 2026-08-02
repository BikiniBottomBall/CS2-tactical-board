"""消息分发器（P9 多人协同）

根据 op 字段将消息路由到对应的处理函数。
Wave 2 仅处理 cursor_move，后续 wave 逐步扩充。
"""
from room_manager import broadcast, get_room


async def handle_message(room, user_id: str, msg: dict):
    """分发客户端消息到对应 handler"""
    op = msg.get('op', '')
    if op == 'cursor_move':
        await handle_cursor_move(room, user_id, msg)
    # Wave 3-5 在此添加更多 handler


async def handle_cursor_move(room, user_id: str, msg: dict):
    """广播光标位置给房间其他人"""
    await broadcast(room, {
        'op': 'cursor_move',
        'user_id': user_id,
        'x': msg.get('x', 0),
        'z': msg.get('z', 0),
    }, exclude_user=user_id)
