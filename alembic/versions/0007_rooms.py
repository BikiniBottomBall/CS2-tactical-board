"""0007_rooms：新增 users / rooms / room_members 表（P9 多人协同）

Revision ID: 0007_rooms
Revises: 0006_share_link
Create Date: 2026-07-31
"""
from alembic import op
from sqlmodel import SQLModel

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import models  # noqa: F401, E402

revision = '0007_rooms'
down_revision = '0006_share_link'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    SQLModel.metadata.create_all(bind)


def downgrade() -> None:
    op.drop_table('room_members')
    op.drop_table('rooms')
    op.drop_table('users')
