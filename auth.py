"""匿名鉴权（P9 多人协同）

客户端生成 anonymous_id（crypto.randomUUID）→ 服务端 HMAC 签名 token。
验证通过后才允许 WebSocket 连接。不依赖 OAuth/JWT。
"""
import hashlib
import hmac
import os
import secrets
from typing import Optional

from sqlmodel import Session, select

from models import User, engine

SECRET_KEY = os.environ.get('BOARD_SECRET', secrets.token_hex(32))


def generate_token(anonymous_id: str) -> str:
    """为 anonymous_id 生成 HMAC-SHA256 签名 token（前 32 位 hex）"""
    return hmac.new(
        SECRET_KEY.encode('utf-8'),
        anonymous_id.encode('utf-8'),
        hashlib.sha256,
    ).hexdigest()[:32]


def verify_token(token: str) -> Optional[str]:
    """验证 token 格式。HMAC 验证需要知晓 original anonymous_id，此函数仅做格式校验。
    实际验证在 WebSocket handler 中：verify_token(header_token) == generate_token(header_anonymous_id)
    """
    if not token or len(token) != 32:
        return None
    try:
        int(token, 16)  # 纯 hex 检测
        return token
    except (ValueError, TypeError):
        return None


def validate_connection(anonymous_id: str, token: str) -> bool:
    """验证 WebSocket 连接：client token 必须等于 server 用 secret 生成的 token"""
    if not anonymous_id or not token:
        return False
    return hmac.compare_digest(token, generate_token(anonymous_id))


def get_or_create_user(anonymous_id: str, nickname: str = '') -> User:
    """获取或创建用户（幂等）"""
    with Session(engine) as db:
        row = db.exec(select(User).where(User.anonymous_id == anonymous_id)).first()
        if row:
            if nickname and row.nickname != nickname:
                row.nickname = nickname
                db.add(row)
                db.commit()
                db.refresh(row)
            return row
        from datetime import datetime
        u = User(
            anonymous_id=anonymous_id,
            nickname=nickname or None,
            created_at=datetime.now().isoformat(timespec='seconds'),
        )
        db.add(u)
        db.commit()
        db.refresh(u)
        return u
