"""0004_step_actors：tactic_steps 表新增演员/道具/时长列（幂等）

Revision ID: 0004_step_actors
Revises: 0003_utility_coords
Create Date: 2026-07-26
"""
from alembic import op
import sqlalchemy as sa

revision = '0004_step_actors'
down_revision = '0003_utility_coords'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {r[1] for r in bind.execute(sa.text('PRAGMA table_info(tactic_steps)')).fetchall()}
    if 'actors' not in existing:
        op.add_column('tactic_steps', sa.Column('actors', sa.Text(), nullable=True))
    if 'utility_ids' not in existing:
        op.add_column('tactic_steps', sa.Column('utility_ids', sa.Text(), nullable=True))
    if 'duration' not in existing:
        op.add_column('tactic_steps', sa.Column('duration', sa.Float(), nullable=True, server_default='2.0'))


def downgrade() -> None:
    op.drop_column('tactic_steps', 'duration')
    op.drop_column('tactic_steps', 'utility_ids')
    op.drop_column('tactic_steps', 'actors')
