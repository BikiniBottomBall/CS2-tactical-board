"""room code 字段长度限制（P10 W5）

rooms.code 加 max_length=6（与生成器 _gen_code 的 6 位码一致）

Revision ID: 0008_room_code_length
Revises: 0007_rooms
"""
import sqlalchemy as sa
from alembic import op

revision = '0008_room_code_length'
down_revision = '0007_rooms'
branch_labels = None
depends_on = None


def upgrade():
    # batch 模式：SQLite 走表重建，PostgreSQL 走原生 ALTER（方言无关）
    with op.batch_alter_table('rooms') as batch:
        batch.alter_column('code', existing_type=sa.String(), type_=sa.String(length=6))


def downgrade():
    with op.batch_alter_table('rooms') as batch:
        batch.alter_column('code', existing_type=sa.String(length=6), type_=sa.String())
