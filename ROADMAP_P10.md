# CS2 战术板 · P10 工程化与生产就绪（2026-08-04 方案）

> P0~P9 完成了全部功能路线。P10 不新增业务功能，目标是把项目打磨到**可面试展示、可团队协作、可生产部署**的全栈标准。

---

## 一、当前问题清单（P9 收尾后的技术债）

| # | 问题 | 文件 | 严重程度 |
|---|------|------|----------|
| 1 | 所有 API 用 `dict = Body(...)`，无 Pydantic 校验 / 无 `/docs` 契约 | `app.py` | 🔴 高 |
| 2 | 异常静默吞掉（`except: pass`），无日志无追踪 | `app.py`, `op_handler.py` | 🔴 高 |
| 3 | 同步 endpoint 里 hack `asyncio.new_event_loop()` | `app.py:400` | 🔴 高 |
| 4 | 锁状态是全局的，非 per-room | `op_handler.py:7` | 🟡 中 |
| 5 | 前端 `@ts-nocheck` + 大量 `as any` | `main.ts`, `sync.ts` | 🟡 中 |
| 6 | **零测试**：无 pytest、无前端单测、无 e2e | 全局 | 🔴 高 |
| 7 | 无 CI/CD：无 GitHub Actions，PR 无门禁 | 全局 | 🟡 中 |
| 8 | 无统一配置管理（`.env.example` 都没有） | 全局 | 🟡 中 |
| 9 | 无代码格式化 / lint 配置（ruff/black/prettier） | 全局 | 🟢 低 |
| 10 | API 无 `response_model`，返回值类型不透明 | `app.py` | 🟡 中 |
| 11 | `Room` 表字段 `code` 是 PK，但内存房间用 `code` 查；迁移里 `code` 没设长度限制 | `models.py`, `alembic/0007` | 🟢 低 |
| 12 | `board_state` 存在 `Room` 表但从未被读取恢复（房间销毁时持久化，但重建时不读） | `room_manager.py` | 🟡 中 |

---

## 二、P10 目标与验收标准

### 2.1 总体目标

把项目从「功能跑通」提升到「工程规范」——代码能过 review、测试能跑通、部署能一键完成。

### 2.2 验收标准（必须全部通过）

1. **pytest 覆盖率 ≥ 60%**（后端 API + 工具函数）
2. **GitHub Actions 绿**：PR 时自动跑 `pytest` + `tsc --noEmit` + `vite build`
3. **所有 API endpoint 有 Pydantic Request/Response 模型**，`/docs` 页面可读
4. **异常处理规范化**：统一 `HTTPException` + 结构化日志，无裸 `except: pass`
5. **前端移除 `@ts-nocheck`**，所有 `any` 有类型注解或 TODO 注释
6. **Docker 镜像能一键构建运行**，`docker-compose up` 直接可用
7. **提供 `.env.example`** + `README` 更新部署指南

---

## 三、P10 具体任务（按优先级排序）

### 🔴 P10-A：测试体系（投入产出最高）

#### A1 后端单元测试

**目标**：pytest + FastAPI `TestClient`，覆盖所有 CRUD endpoint。

**文件**：`tests/` 目录（新增）

```
tests/
├── conftest.py          # TestClient fixture + 内存 SQLite 引擎
├── test_utilities.py    # /api/utilities CRUD
├── test_tactics.py      # /api/tactics + /api/tactics/{tid}/pack + import
├── test_demos.py        # /api/demos upload/list/pack/delete（mock 文件）
├── test_share.py        # /api/share + /view/{share_id}
├── test_rooms.py        # /api/rooms create/join/close + WebSocket 握手
├── test_auth.py         # HMAC token 生成/验证
└── test_op_handler.py   # 锁逻辑、消息分发
```

**关键技术点**：
- `conftest.py` 里用 `create_engine("sqlite:///:memory:")` 隔离测试 DB
- `monkeypatch` 替换 `SECRET_KEY` 为固定值，保证 token 可预测
- demo 上传测试用 `io.BytesIO(b'...')` mock `.dem` 文件
- WebSocket 测试用 `TestClient` 的 `websocket_connect`

#### A2 前端类型检查修复

**目标**：移除 `@ts-nocheck`，让 `tsc --noEmit` 0 错误。

**工作量估算**：
- `main.ts`：1 行 `@ts-nocheck` + 少量 `as Error` 已合规，主要问题是 event listener 类型
- `sync.ts`：约 15 处 `(msg as any)` → 改成 `isServerMsg(msg)` 类型守卫 + switch case 细化
- `board.ts`, `tactic.ts`, `utility.ts`：检查是否有隐式 `any`

**具体做法**：
```typescript
// 替换 sync.ts 里的 (msg as any).xxx
function isRoomStateMsg(msg: ServerMsg): msg is Extract<ServerMsg, {op: 'room_state'}> {
  return msg.op === 'room_state';
}
// 或在 switch 里用 if ('field' in msg) 细化
```

#### A3 E2E 截图回归（可选，但建议做）

复用已有的 `puppeteer-core`，写一个最小 e2e：
- 启动后端 → 打开首页 → 截图 → 对比基准图
- 验收：能检测「地图加载不出来」级别的回归

---

### 🔴 P10-B：API 规范化与异常处理

#### B1 Pydantic Schema

为每个 endpoint 定义 Request/Response 模型：

```python
# schemas.py（新增）
from pydantic import BaseModel
from typing import Optional, List

class UtilityCreate(BaseModel):
    name: str
    type: Optional[str] = None
    throw_type: Optional[str] = None
    stand_x: Optional[float] = None
    ...

class UtilityOut(UtilityCreate):
    id: int
    created_at: Optional[str] = None

class TacticCreate(BaseModel):
    name: str
    description: Optional[str] = None

class TacticOut(TacticCreate):
    id: int
    steps: List[TacticStepOut] = []
```

**修改量**：`app.py` 中约 15 个 endpoint，每个加 `response_model=...` 和 typed request。

#### B2 异常规范化

统一异常模式：

```python
from fastapi import HTTPException
import logging

logger = logging.getLogger(__name__)

# 之前：
# return {'error': 'not found'}

# 之后：
raise HTTPException(status_code=404, detail='not found')

# 之前：
# except Exception: pass

# 之后：
except WebSocketDisconnect:
    logger.info(f"Player {user_id} disconnected")
except Exception as e:
    logger.exception(f"Unexpected error in WS handler: {e}")
```

**日志配置**：`logging.config.dictConfig` 在 `app.py` 启动时配置，格式含时间/级别/模块名。

#### B3 异步规范化

修复 `app.py:400` 的 `asyncio.new_event_loop()` hack：

```python
# 之前（同步函数里开新 loop）：
@app.post('/api/rooms')
def api_create_room(...):
    loop = asyncio.new_event_loop()
    code = loop.run_until_complete(create_room(...))

# 之后：
@app.post('/api/rooms')
async def api_create_room(...):
    code = await create_room(...)
```

`room_manager.py` 里的 `async` 函数本来就支持，直接改 endpoint 为 `async def` 即可。

---

### 🟡 P10-C：代码质量工具链

#### C1 Python：Ruff + Black

```toml
# pyproject.toml（新增）
[tool.ruff]
line-length = 100
target-version = "py311"
select = ["E", "F", "I", "W", "N", "UP", "B", "C4", "SIM"]

[tool.black]
line-length = 100
target-version = ["py311"]
```

**GitHub Actions** 中跑 `ruff check .` 和 `black --check .`。

#### C2 TypeScript：Prettier

```json
// web/.prettierrc（新增）
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

#### C3 Pre-commit（可选）

`.pre-commit-config.yaml`：自动跑 ruff + black + tsc + vite build。

---

### 🟡 P10-D：CI/CD（GitHub Actions）

```yaml
# .github/workflows/ci.yml（新增）
name: CI
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt
      - run: pip install pytest pytest-asyncio httpx
      - run: pytest tests/ --cov=app --cov-report=xml
      - run: ruff check .
      - run: black --check .
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: cd web && npm ci
      - run: cd web && npx tsc --noEmit
      - run: cd web && npm run build
```

---

### 🟡 P10-E：配置管理

#### E1 Pydantic Settings

```python
# config.py（新增）
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    board_db_url: str = "sqlite:///board.db"
    board_secret: str = "dev-secret-change-me"
    log_level: str = "INFO"
    
    class Config:
        env_file = ".env"

settings = Settings()
```

替换所有 `os.environ.get(...)` 为 `settings.xxx`。

#### E2 `.env.example`

```bash
BOARD_DB_URL=sqlite:///board.db
# BOARD_DB_URL=postgresql://cs2user:cs2pass@localhost:5432/cs2tactical
BOARD_SECRET=your-secret-key-here
LOG_LEVEL=INFO
```

#### E3 README 更新

补充：
- 环境变量说明
- Docker 部署步骤
- 测试命令
- CI 徽章

---

### 🟢 P10-F：Bug 修复与细节优化

#### F1 锁隔离（per-room）

```python
# op_handler.py
# 之前：
_lock_state: dict[str, dict] = {}  # {resource: {holder, acquired_at}}

# 之后：
_lock_state: dict[str, dict[str, dict]] = {}  # {room_code: {resource: {...}}}

async def h_lock_request(room, user_id, msg):
    resource = msg.get('resource', '')
    room_locks = _lock_state.setdefault(room.code, {})
    existing = room_locks.get(resource)
    ...
```

#### F2 `board_state` 恢复

`room_manager.py` 的 `_persist` 把房间状态写入 DB，但 `create_room` 时从不读取历史状态。应该：

```python
async def create_room(owner_id, name=''):
    # 检查 DB 里是否有同 code 的历史房间（is_active=False）
    # 如果有 → 恢复 board_state
    # 如果没有 → 新建
```

或更简单：P10 阶段把 `_persist` 改为仅记录日志，不做恢复（因为房间 code 是 6 位随机，复用概率极低），去掉误导性代码。

#### F3 `Room` 表 `code` 字段长度限制

```python
# models.py
class Room(SQLModel, table=True):
    code: str = Field(max_length=6, index=True, unique=True)
```

Alembic 补迁移 `0008_room_code_length.py`。

---

## 四、实施计划（建议顺序）

| 阶段 | 任务 | 预估工时 | 依赖 |
|------|------|----------|------|
| W1 | B1 Pydantic Schema + B3 异步规范化 | 4h | 无 |
| W1 | B2 异常处理 + 日志配置 | 3h | B1 |
| W2 | A1 后端测试（pytest） | 8h | B1, B2 |
| W2 | A2 前端类型修复 | 4h | 无 |
| W3 | C1/C2 工具链配置 | 2h | 无 |
| W3 | D CI/CD + E 配置管理 | 4h | A1, A2, C1 |
| W4 | F Bug 修复 + 文档更新 | 3h | 全部 |
| **合计** | | **~28h** | |

---

## 五、P10 完成后项目状态

```
CS2-tactical-board/
├── .github/workflows/ci.yml    # CI 门禁
├── .env.example                # 配置模板
├── pyproject.toml              # Ruff/Black 配置
├── config.py                   # Pydantic Settings
├── schemas.py                  # API 契约
├── tests/                      # 测试套件
│   ├── conftest.py
│   ├── test_utilities.py
│   ├── ...
│   └── test_op_handler.py
├── app.py                      # 规范化 API
├── ...（其余不变）
```

**最终交付物**：
1. 一个能通过 CI 的代码库
2. 一份更新的 README（含部署、测试、环境变量）
3. 一个能在面试中讲 20 分钟的全栈项目故事

---

## 六、风险

| 风险 | 缓解措施 |
|------|----------|
| Pydantic 化改动量大，可能引入回归 | 先写测试，再改实现（TDD） |
| 前端 TS 错误可能比预期多 | 分模块修复，优先 `sync.ts` 和 `main.ts` |
| demoparser2 在 CI 环境可能装不上 | `test_demos.py` mock 解析子进程，不测真实解析 |

---

> **P10 完成后，项目从「功能 Demo」正式升级为「可展示的全栈作品集」。**
