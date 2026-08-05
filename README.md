# CS2-tactical-board

CS2 de_dust2 官方地图 3D 战术板：真实模型加载、道具库（lineup 轨迹）、战术编排自动推演、demo 轨迹回放、坐标网格/参考图对齐校验。

## 技术栈

- **前端**：Three.js + Vite + TypeScript（`web/`）
- **后端**：FastAPI + SQLModel + Alembic（`app.py`，API 文档 `/docs`）
- **数据**：SQLite（`board.db`，可由 `BOARD_DB_URL` 平迁 PostgreSQL）
- **模型管线**：Source 2 Viewer 反编译 + gltf-transform Draco 压缩（300 MB → 45 MB）
- **Demo 解析**：demoparser2（16 Hz 轨迹采样 + 道具弹道 + 书签事件）

## 从零搭建

```bash
git clone https://github.com/BikiniBottomBall/CS2-tactical-board.git
cd CS2-tactical-board

# 1. 后端环境
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Windows
# .venv/bin/pip install -r requirements.txt          # Linux/macOS

# 2. 数据库迁移（自动建 board.db）
.venv/Scripts/alembic upgrade head

# 3. 地图模型（二选一）
#   a) 直接放入压缩产物：data/models/de_dust2.glb
#   b) 重新生成（需本机装有 CS2 + Source 2 Viewer CLI）：
#      Source2Viewer-CLI.exe -i "<CS2>\game\csgo\maps\de_dust2.vpk" -o map_export -d -f "maps/de_dust2" --gltf_export_format gltf
#      npx -y @gltf-transform/cli draco map_export/maps/de_dust2/world.gltf data/models/de_dust2.glb

# 4. 前端构建
cd web && npm i && npm run build && cd ..

# 5. 启动
.venv/Scripts/uvicorn app:app --host 127.0.0.1 --port 8000
```

打开 http://localhost:8000 即可。Draco 解码器在 `libs/draco/`（已入库，无需额外处理）。

## 测试与代码检查

```bash
# 运行测试（42 例，内存 SQLite 隔离）
.venv/Scripts/pytest tests/ -v

# 覆盖率（目标 ≥60%）
.venv/Scripts/pytest tests/ --cov=app --cov=op_handler --cov=auth --cov=room_manager

# 代码检查
.venv/Scripts/ruff check .
.venv/Scripts/black --check .

# 前端类型检查
cd web && npx tsc --noEmit
```

## Docker 运行

```bash
docker compose up -d --build   # app（:8000）+ PostgreSQL（:5432，pgdata 卷）
```

环境变量集中走 `config.py`（Pydantic Settings），可配项见 `.env.example`。

## 目录说明

```
app.py            FastAPI 后端（静态服务 + REST API + WebSocket 房间）
schemas.py        API 契约（Pydantic Request/Response 模型）
config.py         配置管理（环境变量集中读取）
models.py         SQLModel 表结构（道具/战术/demo 对局/房间/用户；annotations 表已废弃）
auth.py           匿名鉴权（HMAC token）
room_manager.py   房间内存管理器
op_handler.py     房间消息分发（锁 per-room 隔离）
alembic/          数据库迁移（0001~0008）
tests/            pytest 测试（CRUD + 鉴权 + 房间 + 锁）
web/              前端源码（Vite + TS，build 到 web/dist 由后端服务）
tools/            demo 解析管线（parse_demo.py / verify_demo.py）
data/             模型与 demo 数据（glb/raw/parsed 均不入库，见 .gitignore）
libs/draco/       Draco 解码器
ROADMAP.md        技术栈定稿与阶段路线图（P0~P10）
```

## 路线图状态

已完成：真实模型加载与纯色材质、道具库、战术编排、战术包分享、demo 回放与解析管线、链接分享、多人协同（P0~P9）；坐标系统一（worldToScene）、侧边栏工具状态机、坐标网格。点位标注（预设常用点位 + 自定义取点标注，数据存 /api/annotations）已加入；参考图对齐与标点校准已移除。

## P10 工程化（已完成）

- 全部 API 使用 Pydantic Schema，OpenAPI 文档自动生成（`/docs`）
- pytest 测试覆盖所有 CRUD endpoint（42 例，覆盖率 67%）
- GitHub Actions CI：自动跑测试 + 类型检查 + 构建（`.github/workflows/ci.yml`）
- Ruff + Black 代码规范（`pyproject.toml`）
- 结构化日志配置（`dictConfig`）
- 环境变量管理（`config.py` + `.env.example`）
