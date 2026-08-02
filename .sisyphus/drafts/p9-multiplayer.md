# P9 多人协同 — 架构方案与实施计划

> 目标：让 2-5 人同时在同一张战术板（同一个房间）上实时协作。
> 原则：操作同步而非状态同步；最小化对现有代码的破坏；能用 SQLite 跑通的先不切 PostgreSQL（但保持兼容）。

---

## 一、核心架构决策

### 1.1 同步模型：操作同步（Operation Sync）

**不传整个 board 状态**，只传用户操作消息。服务端做轻量合并后广播。

```
Client A 放 T 标记 ──→ {"op":"marker_place","kind":"t",...}
                            │
                     Server (room state)
                            │
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
          Client A       Client B      Client C
          (echo + id)   (broadcast)    (broadcast)
```

选择理由：
- 战术板操作是低频的（不是 60fps FPS），不需要 OT/CRDT
- 板上的标记/线/道具数量通常 < 100 个，全量状态也非常小
- 冲突处理简单：后到覆盖 + 光标可见即可避免意外碰撞

### 1.2 服务端房间模型

```
Room
├── owner_id          # 房主（创建者）
├── players[]         # 在线成员
├── board_state       # markers + lines（JSON）
├── tactic_state      # 当前选中的战术 + 步骤（JSON）
├── utility_state     # 道具列表（可读，录入需 lock）
├── active_lock        # 当前独占操作（null | tactic_playback | utility_recording）
└── cursor_positions[] # 每个人的鼠标/光标位置（只广播，不持久化）
```

**服务端不主动计算**。服务端只做三件事：
1. 收消息 → 合并冲突（后到覆盖）→ 广播
2. 管理 lock（谁在播放/录入）
3. 持久化（房间关闭时落 db）

### 1.3 鉴权方案：轻量 Token

不做 OAuth/OIDC 注册流程（太重）。用**匿名 + 昵称 + 房间码**：

```
1. 用户打开页面 → 自动生成匿名 ID（localStorage 持久化）
2. 用户输入昵称 → 存到 localStorage
3. 创建房间 → 服务端返回 6 位房间码（如 "A3K7M2"）
4. 加入房间 → 输入房间码 + 昵称
5. 后续同一浏览器自动复用匿名 ID（不需要重新输入）
```

未来可升级到 JWT + OAuth，但 P9 先做轻量版。

---

## 二、数据库 Schema 变更

### 2.1 新增表（0006 迁移）

```sql
-- 用户表（轻量，匿名为主）
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    anonymous_id TEXT UNIQUE NOT NULL,    -- 浏览器 localStorage 生成的 UUID
    nickname    TEXT,                     -- 可随时改
    created_at  TIMESTAMP DEFAULT NOW()
);

-- 房间表
CREATE TABLE rooms (
    id          SERIAL PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,     -- 6 位房间码
    name        TEXT,
    owner_id    INTEGER REFERENCES users(id),
    board_state JSONB DEFAULT '{}',      -- markers + lines 快照
    tactic_id   INTEGER REFERENCES tactics(id),
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP DEFAULT NOW(),
    closed_at   TIMESTAMP
);

-- 房间成员（历史记录，谁进过这个房间）
CREATE TABLE room_members (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER REFERENCES rooms(id),
    user_id     INTEGER REFERENCES users(id),
    joined_at   TIMESTAMP DEFAULT NOW(),
    left_at     TIMESTAMP
);
```

### 2.2 现有表不变

`utilities`、`tactics`、`tactic_steps`、`annotations`、`matches`、`demo_events`、`models` —— 全部不动。

### 2.3 为什么用 JSONB

`board_state` 存 JSONB 而非单独表。理由：
- board 操作（标记/线）是临时草图，最终产物是 tactic，board 是战术讨论过程中的"白板"
- JSONB 足够灵活，不需要为每个 marker/line 建关系表
- PostgreSQL JSONB 支持索引查询，未来需要时可以加

---

## 三、后端变更

### 3.1 WebSocket 端点

```python
# app.py 新增
from fastapi import WebSocket, WebSocketDisconnect

@app.websocket("/ws/{room_code}")
async def room_websocket(ws: WebSocket, room_code: str):
    await ws.accept()
    user_id = ws.headers.get("x-anonymous-id")  # 从 header 取
    nickname = ws.headers.get("x-nickname", "游客")

    room = join_room(room_code, user_id, nickname, ws)
    try:
        while True:
            msg = await ws.receive_json()
            await handle_message(room, user_id, msg)
    except WebSocketDisconnect:
        leave_room(room, user_id)
```

### 3.2 消息协议

```typescript
// 客户端 → 服务端
type ClientMsg =
  | { op: "cursor_move"; x: number; z: number }          // 光标位置
  | { op: "marker_place"; kind: string; x: number; y: number; z: number; temp_id: string }
  | { op: "marker_move"; id: string; x: number; y: number; z: number }
  | { op: "marker_delete"; id: string }
  | { op: "line_begin"; x: number; y: number; z: number; temp_id: string }
  | { op: "line_extend"; id: string; points: [number,number,number][] }
  | { op: "line_end"; id: string }
  | { op: "line_delete"; id: string }
  | { op: "board_undo" }
  | { op: "board_clear" }
  | { op: "tactic_select"; tactic_id: number }
  | { op: "tactic_play"; step_idx: number }
  | { op: "tactic_pause" }
  | { op: "tactic_step_update"; step_idx: number; data: object }
  | { op: "utility_recording_start" }
  | { op: "utility_recording_cancel" }
  | { op: "lock_request"; resource: string }
  | { op: "lock_release"; resource: string }

// 服务端 → 客户端
type ServerMsg =
  | { op: "room_state"; board: object; tactic: object | null; players: object[]; locks: object[] }
  | { op: "player_joined"; user_id: string; nickname: string }
  | { op: "player_left"; user_id: string }
  | { op: "cursor_move"; user_id: string; x: number; z: number }
  | { op: "marker_placed"; id: string; kind: string; x: number; y: number; z: number; by: string }
  | { op: "marker_moved"; id: string; x: number; y: number; z: number; by: string }
  | { op: "marker_deleted"; id: string; by: string }
  | { op: "line_updated"; id: string; points: [number,number,number][]; by: string }
  | { op: "line_deleted"; id: string; by: string }
  | { op: "board_cleared"; by: string }
  | { op: "board_undo"; by: string }
  | { op: "tactic_changed"; tactic_id: number | null; by: string }
  | { op: "tactic_playback"; playing: boolean; step_idx: number; by: string }
  | { op: "tactic_step_updated"; step_idx: number; data: object; by: string }
  | { op: "lock_acquired"; resource: string; by: string }
  | { op: "lock_released"; resource: string }
  | { op: "error"; message: string }
```

### 3.3 新增 Python 模块

```
app.py            # 加 WebSocket endpoint，其余 REST 不变
auth.py           # 匿名 ID 生成/验证，昵称管理
room_manager.py   # 房间生命周期：创建/加入/离开/关闭
                   # in-memory dict: { room_code -> RoomState }
                   # 用 asyncio.Lock 保护并发
op_handler.py     # 消息分发：根据 op type 路由到具体处理函数
                   # 每个 handler 做：验证 → 合并冲突 → 广播
```

### 3.4 房间生命周期

```
create_room(user) → 生成 6 位码 → 创建 RoomState → 返回码
join_room(code, user, ws) → 验证码 → 添加成员 → 广播 player_joined → 发 room_state 给新成员
leave_room(code, user) → 移除成员 → 广播 player_left
close_room(code) → 如果无在线成员 → board_state 落 db → 释放内存
```

### 3.5 REST API 新增

```
POST   /api/rooms             创建房间
GET    /api/rooms/{code}      检查房间是否存在/获取信息
POST   /api/rooms/{code}/join 加入房间（验证码 + 昵称）
DELETE /api/rooms/{code}      房主关闭房间
```

---

## 四、前端变更

### 4.1 新增模块：network.ts（~200 行）

```
network.ts
├── connect(roomCode)          # 建立 WebSocket 连接
├── send(msg)                  # 发操作消息
├── onMessage(handler)         # 收服务端消息
├── reconnect()                # 断线重连（指数退避）
└── connectionState            # connected | reconnecting | disconnected
```

### 4.2 新增模块：sync.ts（~300 行）— 交互层适配器

**这是最核心的新模块。** 它的职责是在"本地命令式操作"和"消息驱动同步"之间做桥接。

```typescript
// sync.ts — 设计思路：
//
//   当前代码：board.ts 里 pointerdown → 直接 createMarkerMesh() → 加到 scene
//   多人改造后：pointerdown → sync.send({"op":"marker_place",...})
//                       → sync.onMessage("marker_placed") → createMarkerMesh()

// sync.ts 导出给各模块用的接口：

// -- board 操作 --
export function syncMarkerPlace(kind, x, y, z)   // 代替 board.ts 里的直接创建
export function syncMarkerMove(id, x, y, z)       // 代替 board.ts 里的直接移动
export function syncMarkerDelete(id)              // 代替 board.ts 里的直接删除
export function syncLineBegin(x, y, z)
export function syncLineExtend(id, points)
export function syncLineEnd(id)
export function syncBoardClear()

// -- tactic 操作 --
export function syncTacticSelect(tacticId)
export function syncTacticPlay(stepIdx)
export function syncTacticPause()
export function syncActorMove(actorId, x, y, z)

// -- lock 操作 --
export function requestLock(resource)  // Promise<boolean>
export function releaseLock(resource)

// -- 服务端消息分发 --
// 告诉各模块："有人放了 marker，你渲染它"
export function onServerPlaceMarker(id, kind, x, y, z, by)
export function onServerMoveMarker(id, x, y, z, by)
export function onServerDeleteMarker(id, by)
// ... 对应每个 ServerMsg type
```

### 4.3 现有模块改造量

| 模块 | 改动方式 | 预计行数变动 |
|---|---|---|
| **state.ts** | 加 `isConnected`、`myUserId`、`remoteCursors[]` | +20 行 |
| **board.ts** | 标记/线/画笔/橡皮擦所有 handler 里，把"直接操作 mesh"替换成 `sync.xxx()` 调用；新增 `remote_` 前缀的渲染函数给 sync.ts 回调用 | **重写 ~250 行**（409→~350，因为删掉了很多 localStorage 逻辑） |
| **tactic.ts** | 演员拖拽 → `sync.syncActorMove()`；播放/暂停 → `sync.syncTacticPlay/Pause()`；播放引擎加锁检查（只有持有 lock 的人才调 updateTactic） | **重写 ~150 行** |
| **utility.ts** | 录入开始 → `requestLock("utility_recording")`；录入结束 → `releaseLock(...)`；道具 CRUD 不变（走 REST） | +30 行 |
| **tools.ts** | 不变 | 0 行 |
| **main.ts** | 加 room 面板 HTML；init 里调 `network.connect()`；animate 里加 `renderRemoteCursors()` | +40 行 |
| **camera.ts / map.ts / grid.ts / refmap.ts / coords.ts / config.ts** | 不变 | 0 行 |

### 4.4 光标同步

每个人在场景里看到其他人的光标（半透明圆环）：

```typescript
// 在 sync.ts 里维护
const remoteCursors = new Map<string, THREE.Mesh>(); // userId → cursor mesh

// 收到 cursor_move 消息时
function onRemoteCursorMove(userId, x, z) {
  // 创建/更新一个贴地半透明环（环形几何体 + depthTest: false）
  // 光标上浮显示昵称 sprite
}

// 在 animate() 里调用 renderRemoteCursors() 更新位置
```

### 4.5 锁的 UI 反馈

```
战术面板：
  [▶ 播放] ← 绿色（我有锁） / 灰色（别人在播放） / 橙色（可抢锁）

道具录入：
  录入中...  ← 别人看不到录入面板
  别人在录入道具 ← 显示提示，无法点"录入"
```

### 4.6 房间 UI

在左侧边栏顶部加一个折叠区：

```
┌──────────────────┐
│ 👥 多人协同        │
│ 房间码: [A3K7M2]  │
│ 在线: 🟢 你, 小明,  │
│       小红         │
│ [创建房间] [加入]  │
│ [断开]            │
└──────────────────┘
```

---

## 五、实施阶段

### 阶段 1：基础设施（2-3 天）

```
□ 0006 迁移：users + rooms + room_members 表
□ auth.py：匿名 ID 生成 + 验证
□ room_manager.py：房间内存管理
□ app.py：/api/rooms CRUD + /ws/{room_code}
□ network.ts：WebSocket 连接 + 断线重连
□ sync.ts：消息收发骨架 + 事件注册机制
□ 房间 UI 面板（侧边栏顶部）
```

### 阶段 2：Board 同步（2-3 天）

```
□ 消息协议完整实现（marker_* + line_* + board_*）
□ op_handler.py：board 操作处理
□ board.ts 改造：所有操作走 sync
□ 服务端 board_state 持久化（房间关闭时）
□ 回归测试：单人模式功能无退化（localStorage 模式保留）
```

### 阶段 3：Tactic + Utility 同步（2 天）

```
□ tactic 选择/播放/暂停同步
□ 演员拖拽同步
□ 播放锁机制
□ utility 录入锁机制
□ 回归测试
```

### 阶段 4：光标 + 体验（1-2 天）

```
□ 远程光标渲染
□ 昵称显示
□ 锁状态 UI 反馈
□ 断线重连后状态恢复
□ 房间关闭/超时清理
```

### 阶段 5：打磨（1-2 天）

```
□ 连接状态指示器
□ 延迟补偿（本地先渲染，服务端 echo 后校正 ID）
□ 错误处理完善
□ E2E 测试（Playwright：2 个浏览器窗口协作）
□ 文档
```

**总预估：8-12 天**

---

## 六、风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| board.ts 改造引入回归 bug | 中 | 阶段 2 先做双模式——单人时走 localStorage 老路径，多人时走 sync 新路径；分别测试 |
| WebSocket 断线导致状态不一致 | 中 | 断线重连时服务端发完整 room_state；客户端 diff 合并 |
| 播放锁竞争导致体验差 | 低 | 只有一个锁类型，简单超时释放（30s 无操作自动释放） |
| 多人操作同一标记导致抖动 | 低 | 后到覆盖策略；视觉上标记数量少，不易碰撞 |

---

## 七、不做的事（明确边界）

- ❌ 不做用户注册/密码/邮箱验证 —— 匿名足够
- ❌ 不做消息持久化历史 —— 房间关闭即清
- ❌ 不做离线编辑 —— 需要联网
- ❌ 不做实时语音/文字聊天 —— 用 Discord
- ❌ 不做权限系统（管理员/普通成员）—— 只有"房主 vs 成员"
- ❌ 不做移动端适配 —— desktop only（Three.js 在移动端性能不够）

---

## 八、技术栈备选（如果 SQLite 跑不动）

当前阶段仍用 SQLite 做持久化（room state 本身在内存，关闭时才写 db）。如果多人并发上去了（>10 个活跃房间）：

- 切 PostgreSQL（已完成兼容改造）
- 加 Redis 做 pub/sub（跨进程广播，目前单进程 uvicorn 不需要）
- 加 nginx 做 WebSocket 负载均衡
