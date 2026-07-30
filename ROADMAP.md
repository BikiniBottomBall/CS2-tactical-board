# CS2 战术板 · 技术栈与路线图（2026-07-25 定稿）

## 推荐技术栈

- **前端**：Three.js + Vite + TypeScript（P3 迁入）；纯 CSS 手写 UI
- **后端**：FastAPI + SQLModel + Alembic（P1 替换 server.py）
- **数据库**：SQLite → PostgreSQL（环境变量切换，一套代码两种形态）
- **存储**：库管元数据，文件管内容（data/models、data/demos/raw、data/demos/parsed）
- **轨迹格式**：16Hz 稀疏采样 + 差值压缩，整局几 MB
- **Demo 解析**：demoparser / awpy
- **工程化**：uv、pytest、Playwright；gltf-transform/gltfpack 模型压缩
- **明确不要**：React/Vue、Electron、MongoDB、微服务

## 路线图

| 阶段 | 目标 | 主要内容 | 验收标准 | 预估 |
|---|---|---|---|---|
| P0 ✅ | 现状 | 官方模型战术板 + 标注系统 + SQLite | 已在跑 | 已完成 |
| P1 ✅ | 后端换骨架（2026-07-26 完成） | FastAPI + SQLModel + Alembic 接管现有 API；DB 连接走环境变量；server.py 退役 | 功能全回归；uvicorn 一条命令起；有 API 文档页 | 1~2 天 |
| P2 ✅ | 模型管线（2026-07-26 完成） | Draco 压缩地图（298MB→45MB）；data/models/ 规范；models 表（0002 迁移）；DRACOLoader 本地解码器；puppeteer-core e2e 截图工具 | 加载 ~5 秒；几何无损；渲染回归通过 | 1 天 |
| P3 ✅ | 前端现代化（2026-07-26 完成） | web/：Vite + TypeScript；拆为 state/config/camera/map/board/calib/main 七模块；/ 挂 web/dist；tactical.html → tactical.legacy.html | 功能零回归；tsc 0 错误；vite build 通过；e2e 5.6s 出图 | 2~3 天 |
| P4 ✅ | 道具库（2026-07-27 完成） | lineup 录入（站位/落点/投掷方式/类型）；utilities 表启用（0003 扩列 + CRUD API）；TubeGeometry 轨迹管预览（穿透显示）+ 站位点/落点脉冲环；播放动画（弹体飞行 + 烟/闪/火落地效果）；分层取点录入模式 | 录 3 个道具并逐个预览轨迹通过 | 3~4 天 |
| P5 ✅ | 战术编排（2026-07-27 完成） | 底部步骤轨时间轴；每步摆人（T1~T5/CT1~CT5 演员拖拽贴地）+配道具（道具库多选）+定时；tactics/tactic_steps 启用（0004 扩列 actors/utility_ids/duration + CRUD API）；▶ 自动推演（smoothstep 补间 → 道具依次投出 → 停留 → 下一步） | 创建「A 大强攻」3 步战术并自动演示（e2e 验证演员移动 + 芯片高亮跟随） | 4~5 天 |
| P6 ✅ | 分享 1.0（2026-07-30 完成） | 自包含战术包导出/导入（道具哈希去重，缺失自动补齐，重名加后缀，utility_ids 自动重映射） | 往返测试通过（去重生效、缺道具重建、重名(2)） | 1~2 天 |
| P7 ✅ | Demo 解析（2026-07-29 完成） | demoparser2 抽轨迹（16Hz 稀疏采样）+道具弹道真实逐点+爆点/书签事件；gzip 轨迹包；matches/demo_events 表（0005）；上传 API + 时间轴回放 UI（插值/yaw 视锥/书签订点/1x2x4x） | 导入 5E dust2 demo 可拖时间轴看走位与道具（e2e 验证 10 演员在图、播放移动） | 5~8 天 |
| P8 | 分享 2.0 | 局域网链接分享；可选公网 + Postgres | 队友浏览器打开链接看演示 | 2~3 天 |
| P9 | 多人协同 | WebSocket 实时同步 + 账号 | 两人同时标注互见光标 | 4~6 天 |

## 备注

- P2/P3 可互换；P6 可紧跟 P5；P7 风险最大（先做半天技术验证）
- P5 完成即拥有完整"可布置、可演示、可分享"的战术板，之后皆是增强
- 数据原则：元数据进库、大件进文件、轨迹稀疏采样、视角与效果播放时现算
- 数据库切换原则：现 SQLite 保便携，多人协同时换 PostgreSQL，schema 无方言可平迁

## 明天从 P1 开始（已完成 ✅ 2026-07-26）

1. ~~`uv pip install fastapi uvicorn sqlmodel alembic`~~ → `.venv` + `requirements.txt`
2. ~~FastAPI 接管：静态文件、/api/annotations、/api/export、/api/import~~ → `app.py`
3. ~~SQLModel 定义 annotations/utilities/tactics/tactic_steps 四表~~ → `models.py`
4. ~~Alembic 初始化迁移；环境变量 `BOARD_DB_URL`（默认 sqlite:///board.db）~~ → `alembic/` + `0001_init`（含 floorY 补列）
5. ~~回归验证：页面功能全部正常~~ → 25 条标注渲染无回归，/docs 可用

**P1 完成状态**：`server.py` 已退役，启动命令改为
`.venv/Scripts/uvicorn app:app --host 127.0.0.1 --port 8000`，API 文档 `http://localhost:8000/docs`
