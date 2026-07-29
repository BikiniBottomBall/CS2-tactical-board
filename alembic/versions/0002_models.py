"""0002_models：新增 models 表并登记 de_dust2

Revision ID: 0002_models
Revises: 0001_init
Create Date: 2026-07-26
"""
from alembic import op
import sqlalchemy as sa
from sqlmodel import SQLModel

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import models  # noqa: F401, E402

revision = '0002_models'
down_revision = '0001_init'
branch_labels = None
depends_on = None

MODEL_PATH = 'data/models/de_dust2.glb'


def upgrade() -> None:
    bind = op.get_bind()
    SQLModel.metadata.create_all(bind)  # 建 models 表（幂等）
    row = bind.execute(sa.text("SELECT id FROM models WHERE name = 'de_dust2'")).fetchone()
    if not row:
        size = os.path.getsize(MODEL_PATH) if os.path.exists(MODEL_PATH) else None
        bind.execute(
            sa.text("INSERT INTO models (name, path, size_bytes) VALUES ('de_dust2', :p, :s)"),
            {'p': MODEL_PATH, 's': size},
        )


def downgrade() -> None:
    op.drop_table('models')
