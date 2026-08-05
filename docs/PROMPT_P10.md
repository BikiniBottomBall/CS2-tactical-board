# 执行 P10：CS2 战术板工程化改造 —— AI 执行提示词

## 一、项目背景

当前工作目录：`D:/KimiCode/cs2-tactical-board`

这是一个 CS2 de_dust2 3D 战术板全栈项目：
- **前端**：Three.js + Vite + TypeScript（`web/src/` 约 3800 行）
- **后端**：FastAPI + SQLModel + Alembic（`app.py` 688 行）
- **实时通信**：原生 WebSocket 多人协同（`room_manager.py`, `op_handler.py`, `auth.py`）
- **数据库**：SQLite 默认，PostgreSQL 环境变量切换
- **容器化**：Dockerfile + docker-compose.yml 已有

**P0~P9 功能已完成，P10 目标是不新增业务功能，只做工程化与生产就绪改造。**

参考文档：`ROADMAP_P10.md`（同目录下，已存在）

---

## 二、执行原则

1. **一次只改一个文件**，改完必须验证（测试跑通 / tsc 0 错误 / 运行正常）
2. **先写测试再改实现**（TDD），避免 Pydantic 化引入回归
3. **所有改动必须可回滚**，不要删除旧代码注释，用替换方式
4. **不要修改 `data/`、`libs/`、`web/dist/`、`.git/` 目录**
5. **所有新文件必须放在当前工作目录内**

---

## 三、执行阶段（严格按顺序）

### 阶段 W1：API 规范化与异常处理（必须先完成，才能写测试）

#### W1-1：创建 `schemas.py`（新增文件）

为所有 API endpoint 定义 Pydantic Request/Response 模型。

必须覆盖的模型：
```python
# schemas.py
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

class UtilityBase(BaseModel):
    name: str
    type: Optional[str] = None
    landing_point: Optional[str] = None
    throw_type: Optional[str] = None
    trajectory: Optional[str] = None
    animation: Optional[str] = None
    stand_x: Optional[float] = None
    stand_y: Optional[float] = None
    stand_z: Optional[float] = None
    landing_x: Optional[float] = None
    landing_y: Optional[float] = None
    landing_z: Optional[float] = None

class UtilityCreate(UtilityBase):
    pass

class UtilityOut(UtilityBase):
    id: int
    created_at: Optional[str] = None

class TacticCreate(BaseModel):
    name: str
    description: Optional[str] = None

class TacticStepBase(BaseModel):
    step_order: int
    annotation: Optional[str] = None
    utility_id: Optional[int] = None
    note: Optional[str] = None
    actors: Optional[List[Dict[str, Any]]] = None
    utility_ids: Optional[List[int]] = None
    duration: float = 2.0

class TacticStepOut(TacticStepBase):
    id: int

class TacticOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    created_at: Optional[str] = None
    steps: List[TacticStepOut] = []

class MatchOut(BaseModel):
    id: int
    name: str
    map: Optional[str] = None
    duration_s: Optional[float] = None
    file_raw: Optional[str] = None
    file_parsed: Optional[str] = None
    created_at: Optional[str] = None

class ShareCreate(BaseModel):
    tactic_data: Dict[str, Any]

class ShareOut(BaseModel):
    share_id: str

class RoomCreate(BaseModel):
    anonymous_id: str
    token: str
    name: Optional[str] = ''
    nickname: Optional[str] = ''

class RoomJoin(BaseModel):
    anonymous_id: str
    token: str
    nickname: Optional[str] = ''

class RoomClose(BaseModel):
    anonymous_id: str
    token: str
```

#### W1-2：修改 `app.py` —— Pydantic 化所有 endpoint

规则：
- 所有 `data: dict = Body(...)` 替换为对应的 Pydantic 模型
- 所有 endpoint 加 `response_model=...`
- `return {'error': ...}` 替换为 `raise HTTPException(status_code=..., detail=...)`
- 导入 `from schemas import ...`

具体修改点：

| Endpoint | 原 Request | 新 Request | Response |
|----------|-----------|-----------|----------|
| `POST /api/utilities` | `dict = Body(...)` | `UtilityCreate` | `UtilityOut` |
| `PUT /api/utilities/{uid}` | `dict = Body(...)` | `UtilityCreate` | `UtilityOut` |
| `POST /api/tactics` | `dict = Body(...)` | `TacticCreate` | `TacticOut` |
| `PUT /api/tactics/{tid}` | `dict = Body(...)` | 保持 dict（含 steps 嵌套） | `TacticOut` |
| `POST /api/share` | `dict = Body(...)` | `ShareCreate` | `ShareOut` |
| `POST /api/rooms` | `dict = Body(...)` | `RoomCreate` | `dict`（`{'code': str}`） |
| `POST /api/rooms/{code}/join` | `dict = Body(...)` | `RoomJoin` | `dict` |
| `DELETE /api/rooms/{code}` | `dict = Body(...)` | `RoomClose` | `dict` |
| `POST /api/tactics/import` | `dict = Body(...)` | 保持 dict（pack 结构复杂） | `TacticOut` |
| `POST /api/import` | `dict = Body(...)` | 保持 dict | `dict` |

**注意**：`/api/tactics/{tid}/pack`（导出）和 `/api/demos/upload`、`/api/export-align` 保持原样，因为返回结构复杂/涉及文件上传。

#### W1-3：修改 `app.py` —— 异步规范化

把以下同步 endpoint 改为 `async def`：
- `POST /api/rooms`（删除 `asyncio.new_event_loop()` hack，直接 `await create_room(...)`）
- `DELETE /api/rooms/{code}`（删除 `asyncio.new_event_loop()` hack，`kick_all()` 直接 `await`）

同时删除 `app.py` 中所有 `import asyncio` 的函数内导入（移到文件顶部）。

#### W1-4：异常处理与日志配置

1. 在 `app.py` 顶部添加：
```python
import logging
from fastapi import HTTPException
from logging.config import dictConfig

LOGGING_CONFIG = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'default': {
            'format': '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'default',
            'level': 'INFO',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
}
dictConfig(LOGGING_CONFIG)
logger = logging.getLogger(__name__)
```

2. 替换所有裸 `except: pass`：
   - `app.py:671-675` WebSocket handler：`except WebSocketDisconnect:` 记录 `logger.info`；`except Exception as e:` 记录 `logger.exception`
   - `op_handler.py`：所有 handler 加 `try/except`，异常记录日志

3. 所有 `return {'error': 'not found'}` 改为 `raise HTTPException(status_code=404, detail='not found')`

#### W1-5：验证

- 后端能启动：`.venv/Scripts/python -c "import app; print('ok')"`
- `/docs` 页面能打开（FastAPI 自动文档）
- 手动测试几个 API 正常

---

### 阶段 W2：测试体系

#### W2-1：创建测试目录结构

```
tests/
├── __init__.py
├── conftest.py
├── test_utilities.py
├── test_tactics.py
├── test_share.py
├── test_rooms.py
├── test_auth.py
└── test_op_handler.py
```

#### W2-2：`tests/conftest.py`

```python
import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, create_engine, Session
from sqlmodel.pool import StaticPool

from models import Annotation, Utility, Tactic, TacticStep, Match, ShareLink, User, Room, RoomMember
from app import app

# 内存 SQLite 引擎（测试隔离）
TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)

@pytest.fixture(scope="function")
def db_session():
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    SQLModel.metadata.drop_all(engine)

@pytest.fixture(scope="function")
def client(db_session):
    # Monkeypatch app 的 engine（关键：让 app.py 里的 endpoint 用测试引擎）
    import app as app_module
    original_engine = app_module.engine
    app_module.engine = engine
    
    # 也需要 patch models.engine
    import models
    models.engine = engine
    
    yield TestClient(app)
    
    app_module.engine = original_engine
    models.engine = original_engine
```

**关键**：必须 monkeypatch `app.py` 和 `models.py` 里的 `engine`，否则 endpoint 会用生产 DB。

#### W2-3：编写测试文件

每个测试文件覆盖对应 endpoint 的 CRUD：

**`test_utilities.py`**：
- `test_list_utilities_empty`：GET /api/utilities 空列表
- `test_create_utility`：POST /api/utilities，验证返回有 id
- `test_create_utility_no_name`：验证 422（Pydantic 会自动做这个）
- `test_update_utility`：PUT /api/utilities/{id}
- `test_delete_utility`：DELETE /api/utilities/{id}
- `test_update_not_found`：验证 404

**`test_tactics.py`**：
- `test_create_tactic`：POST /api/tactics
- `test_create_tactic_no_name`：验证 422
- `test_update_tactic_with_steps`：PUT /api/tactics/{id} 含 steps 数组
- `test_export_tactic_pack`：GET /api/tactics/{id}/pack，验证 format/version
- `test_import_tactic_pack`：POST /api/tactics/import，验证去重/重名加后缀
- `test_delete_tactic`：DELETE /api/tactics/{id}

**`test_share.py`**：
- `test_create_share`：POST /api/share，验证 share_id 是 8 位 hex
- `test_get_share`：GET /api/share/{share_id}
- `test_get_share_not_found`：验证 404

**`test_rooms.py`**：
- `test_create_room`：POST /api/rooms，验证返回 code 是 6 位
- `test_join_room`：POST /api/rooms/{code}/join
- `test_close_room`：DELETE /api/rooms/{code}
- `test_close_room_not_owner`：验证非 owner 不能关闭

**`test_auth.py`**：
- `test_generate_token`：HMAC token 长度 32
- `test_validate_connection`：正确 token 通过，错误 token 拒绝
- `test_get_or_create_user`：幂等创建

**`test_op_handler.py`**：
- `test_lock_request_acquire`：请求锁能获得
- `test_lock_request_denied`：锁被占用时拒绝
- `test_lock_release`：释放后其他人能获得
- `test_cursor_move_broadcast`：cursor_move 消息广播

#### W2-4：运行测试

```bash
.venv/Scripts/pip install pytest pytest-asyncio httpx
.venv/Scripts/pytest tests/ -v
```

目标：**所有测试通过**，覆盖率 `pytest --cov=app --cov=op_handler --cov=auth --cov=room_manager tests/` 达到 60%+。

---

### 阶段 W3：前端类型修复

#### W3-1：移除 `web/src/main.ts` 的 `@ts-nocheck`

- 检查 `tsc --noEmit` 输出
- 修复类型错误（通常是 event listener 的参数类型）

#### W3-2：修复 `web/src/sync.ts` 的 `as any`

用类型守卫替换 `as any`：

```typescript
// 替换前：
const remoteBoard = (msg as any).board || {};

// 替换后：
if (msg.op === 'room_state') {
  const remoteBoard = msg.board || {};
  // ...
}
```

所有 `switch (msg.op)` 分支里，TypeScript 会自动收窄类型，不需要 `as any`。

#### W3-3：验证

```bash
cd web && npx tsc --noEmit
```

目标：**0 错误，0 警告**。

---

### 阶段 W4：代码质量工具链 + CI/CD

#### W4-1：Python 工具链

**创建 `pyproject.toml`**：
```toml
[tool.ruff]
line-length = 100
target-version = "py311"
select = ["E", "F", "I", "W", "N", "UP", "B", "C4", "SIM"]

[tool.black]
line-length = 100
target-version = ["py311"]
```

安装并运行：
```bash
.venv/Scripts/pip install ruff black
.venv/Scripts/ruff check app.py models.py auth.py room_manager.py op_handler.py schemas.py tests/
.venv/Scripts/black --check app.py models.py auth.py room_manager.py op_handler.py schemas.py tests/
```

目标：**ruff 0 错误**，black 无需格式化（或格式化后无 diff）。

#### W4-2：前端工具链

**创建 `web/.prettierrc`**：
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

#### W4-3：GitHub Actions CI

**创建 `.github/workflows/ci.yml`**：
```yaml
name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: pip install pytest pytest-asyncio httpx ruff black
      - run: ruff check app.py models.py auth.py room_manager.py op_handler.py schemas.py tests/
      - run: black --check app.py models.py auth.py room_manager.py op_handler.py schemas.py tests/
      - run: pytest tests/ -v --cov=app --cov=op_handler --cov=auth --cov=room_manager

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: cd web && npm ci
      - run: cd web && npx tsc --noEmit
      - run: cd web && npm run build
```

#### W4-4：配置管理

**创建 `config.py`**（Pydantic Settings）：
```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    board_db_url: str = "sqlite:///board.db"
    board_secret: str = "dev-secret-change-me"
    log_level: str = "INFO"
    
    class Config:
        env_file = ".env"

settings = Settings()
```

**替换 `app.py` 和 `models.py` 中的环境变量读取**：
- `models.py:15`：`os.environ.get('BOARD_DB_URL', 'sqlite:///board.db')` → `config.settings.board_db_url`
- `auth.py:16`：`os.environ.get('BOARD_SECRET', secrets.token_hex(32))` → `config.settings.board_secret`（但保留 fallback 随机生成逻辑，因为 Settings 有默认值）

**创建 `.env.example`**：
```bash
# 数据库（SQLite 默认，可切换 PostgreSQL）
BOARD_DB_URL=sqlite:///board.db
# BOARD_DB_URL=postgresql://cs2user:cs2pass@localhost:5432/cs2tactical

# HMAC 签名密钥（生产环境必须修改！）
BOARD_SECRET=your-secret-key-here

# 日志级别
LOG_LEVEL=INFO
```

---

### 阶段 W5：Bug 修复与收尾

#### W5-1：修复锁隔离（per-room）

修改 `op_handler.py`：
```python
# 之前：
_lock_state: dict[str, dict] = {}

# 之后：
_lock_state: dict[str, dict[str, dict]] = {}  # {room_code: {resource: {holder, acquired_at}}}

async def h_lock_request(room, user_id, msg):
    resource = msg.get('resource', '')
    room_locks = _lock_state.setdefault(room.code, {})
    existing = room_locks.get(resource)
    if existing and existing.get('holder') and existing['holder'] != user_id:
        if time.time() - existing.get('acquired_at', 0) < 60:
            return
    room_locks[resource] = {'holder': user_id, 'acquired_at': time.time()}
    await broadcast(room, {'op': 'lock_acquired', 'resource': resource, 'by': user_id})

async def h_lock_release(room, user_id, msg):
    resource = msg.get('resource', '')
    room_locks = _lock_state.get(room.code, {})
    existing = room_locks.get(resource)
    if existing and existing['holder'] == user_id:
        room_locks[resource] = {}
    await broadcast(room, {'op': 'lock_released', 'resource': resource})
```

#### W5-2：修复 `Room` 表 `code` 字段长度

修改 `models.py`：
```python
class Room(SQLModel, table=True):
    code: str = Field(max_length=6, index=True, unique=True)
```

新增 Alembic 迁移 `alembic/versions/0008_room_code_length.py`：
```python
from alembic import op
import sqlalchemy as sa

revision = '0008'
down_revision = '0007'

def upgrade():
    op.alter_column('rooms', 'code', existing_type=sa.String(), type_=sa.String(length=6))

def downgrade():
    op.alter_column('rooms', 'code', existing_type=sa.String(length=6), type_=sa.String())
```

#### W5-3：更新 `requirements.txt`

新增测试和工具依赖：
```
alembic==1.18.5
fastapi==0.140.0
pydantic==2.13.4
pydantic_core==2.46.4
pydantic-settings>=2.0
SQLAlchemy==2.0.51
sqlmodel==0.0.39
starlette==1.3.1
uvicorn==0.51.0
python-multipart
psycopg2-binary>=2.9
demoparser2

# 测试
pytest>=8.0
pytest-asyncio>=0.23
httpx>=0.27
pytest-cov>=5.0

# 代码质量
ruff>=0.5
black>=24.0
```

#### W5-4：更新 `README.md`

在「路线图状态」后添加 P10 完成状态：
```markdown
## P10 工程化（已完成）

- 全部 API 使用 Pydantic Schema，OpenAPI 文档自动生成
- pytest 测试覆盖所有 CRUD endpoint
- GitHub Actions CI：自动跑测试 + 类型检查 + 构建
- Ruff + Black 代码规范
- 结构化日志配置
- 环境变量管理（`.env.example`）
```

在「从零搭建」后添加测试命令：
```bash
# 运行测试
.venv/Scripts/pytest tests/ -v

# 代码检查
.venv/Scripts/ruff check .
.venv/Scripts/black --check .

# 前端类型检查
cd web && npx tsc --noEmit
```

---

## 四、最终验收清单

执行完所有阶段后，逐项检查：

- [ ] `pytest tests/ -v` **全部通过**
- [ ] `pytest --cov=app --cov=op_handler --cov=auth --cov=room_manager tests/` **覆盖率 ≥ 60%**
- [ ] `ruff check app.py models.py auth.py room_manager.py op_handler.py schemas.py tests/` **0 错误**
- [ ] `black --check app.py models.py auth.py room_manager.py op_handler.py schemas.py tests/` **无 diff**
- [ ] `cd web && npx tsc --noEmit` **0 错误**
- [ ] `cd web && npm run build` **成功**
- [ ] `.venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8000` **能启动**
- [ ] 访问 `http://localhost:8000/docs` **能看到完整的 API 文档**
- [ ] 手动测试：创建道具 → 创建战术 → 导出战术包 → 导入战术包 **流程正常**
- [ ] `.github/workflows/ci.yml` 内容正确，能在 GitHub Actions 跑通（可本地用 `act` 验证）

---

## 五、禁止做的事

1. **不要修改业务逻辑**：P10 不改战术推演算法、不改 Three.js 渲染逻辑、不改 demo 解析
2. **不要删除迁移文件**：只能新增迁移（如 `0008`），不能改已有的 `0001~0007`
3. **不要动 `data/` 目录**：模型文件、demo 文件保持不动
4. **不要重写前端 UI**：只修类型，不改 DOM 操作逻辑
5. **不要改数据库 schema 的已有字段**：只能加限制（如 `max_length`），不改类型

---

## 六、输出要求

每完成一个阶段，汇报：
1. 改了哪些文件
2. 测试结果（通过/失败，覆盖率）
3. 遇到的阻塞性问题（如果有）

最终交付：一个能通过全部验收清单的代码库。
