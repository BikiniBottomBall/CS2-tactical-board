"""init：建表（幂等）+ annotations 补 floorY 列

Revision ID: 0001_init
Revises:
Create Date: 2026-07-26

老库（server.py 时代）表已存在但缺 floorY 列；新库全量建表。
"""
from alembic import op
import sqlalchemy as sa
from sqlmodel import SQLModel

# 让 Alembic 找到 models.py
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import models  # noqa: F401, E402

revision = '0001_init'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # 幂等建表（存在的表跳过）
    SQLModel.metadata.create_all(bind)
    # 老库补 floorY 列
    cols = [c['name'] for c in sa.inspect(bind).get_columns('annotations')]
    if 'floorY' not in cols:
        op.add_column('annotations', sa.Column('floorY', sa.Float(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    cols = [c['name'] for c in sa.inspect(bind).get_columns('annotations')]
    if 'floorY' in cols:
        op.drop_column('annotations', 'floorY')
