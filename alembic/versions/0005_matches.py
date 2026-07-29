"""0005_matches：新增 matches / demo_events 表（P7 demo 回放）

Revision ID: 0005_matches
Revises: 0004_step_actors
Create Date: 2026-07-29
"""
from alembic import op
from sqlmodel import SQLModel

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import models  # noqa: F401, E402

revision = '0005_matches'
down_revision = '0004_step_actors'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    SQLModel.metadata.create_all(bind)  # 建 matches / demo_events 表（幂等）


def downgrade() -> None:
    op.drop_table('demo_events')
    op.drop_table('matches')
