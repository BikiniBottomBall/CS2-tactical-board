"""pytest 公共夹具：内存 SQLite 隔离 + 引擎 monkeypatch

关键：app.py / auth.py 都是 `from models import engine` 绑定，
必须同时 patch app.engine / models.engine / auth.engine，
否则 endpoint 会打到生产 board.db。
"""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app import app

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(
    TEST_DB_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


@pytest.fixture(scope="function")
def db_session():
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    SQLModel.metadata.drop_all(engine)


@pytest.fixture(scope="function")
def client(db_session, monkeypatch):
    import app as app_module
    import auth as auth_module
    import models

    monkeypatch.setattr(app_module, "engine", engine)
    monkeypatch.setattr(models, "engine", engine)
    monkeypatch.setattr(auth_module, "engine", engine)
    # room_manager 的 _persist 是函数内 from-import，读 models.engine（已 patch）
    yield TestClient(app)


@pytest.fixture(scope="function")
def rooms_clean():
    """房间内存状态隔离"""
    import op_handler
    import room_manager

    room_manager._rooms.clear()
    op_handler._lock_state.clear()
    yield
    room_manager._rooms.clear()
    op_handler._lock_state.clear()


@pytest.fixture(scope="function")
def auth_headers():
    """合法 anonymous_id + HMAC token"""
    from auth import generate_token

    uid = "test-user-0001"
    return {"anonymous_id": uid, "token": generate_token(uid)}
