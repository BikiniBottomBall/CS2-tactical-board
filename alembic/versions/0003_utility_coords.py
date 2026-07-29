"""0003_utility_coords：utilities 表新增站位/落点坐标列（幂等）

Revision ID: 0003_utility_coords
Revises: 0002_models
Create Date: 2026-07-26
"""
from alembic import op
import sqlalchemy as sa

revision = '0003_utility_coords'
down_revision = '0002_models'
branch_labels = None
depends_on = None

NEW_COLS = ('stand_x', 'stand_y', 'stand_z', 'landing_x', 'landing_y', 'landing_z')


def upgrade() -> None:
    bind = op.get_bind()
    existing = {r[1] for r in bind.execute(sa.text('PRAGMA table_info(utilities)')).fetchall()}
    for col in NEW_COLS:
        if col not in existing:
            op.add_column('utilities', sa.Column(col, sa.Float(), nullable=True))


def downgrade() -> None:
    for col in NEW_COLS:
        op.drop_column('utilities', col)
