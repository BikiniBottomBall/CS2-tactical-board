"""0006_share_link：新增 share_links 表（P8 战术板分享）

Revision ID: 0006_share_link
Revises: 0005_matches
Create Date: 2026-07-31
"""
from alembic import op
from sqlmodel import SQLModel

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import models  # noqa: F401, E402

revision = '0006_share_link'
down_revision = '0005_matches'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    SQLModel.metadata.create_all(bind)  # 建 share_links 表（幂等）


def downgrade() -> None:
    op.drop_table('share_links')
