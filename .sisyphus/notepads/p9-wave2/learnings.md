# P9-6 Learnings

## ES Module Import Immutability
- Named imports (`import { x } from './m'`) are READ-ONLY in ES modules. Cannot reassign.
- Solution: use `import * as S from './state'` + setter functions (`S.setMultiplayer(v)`) for live state mutation.
- The setter functions were added to state.ts: `setMultiplayer()`, `setMyUserId()`, `setRoomCode()`.

## WebSocket Auth Pattern
- Browser WebSocket API does NOT support custom HTTP headers.
- Pattern: `ws.accept()` first → read first JSON message → extract `_auth` → validate → join room.
- The `_auth` message is sent by network.ts `onopen` handler: `{_auth: {anonymous_id, token, nickname}}`.

## Room UI Panel
- Positioned at `top:16px; right:196px` — between the sidebar area and top panel.
- Default display is `none` → shown as `block` via main.ts init.
- Two modes: `#room-controls` (create/join form) and `#room-info` (connected state).

## P9-15: Remote Cursor Rendering

### Static imports preferred over dynamic imports
- sync.ts already statically imports from `./state` and `three`, so no need for dynamic `import('three')` / `import('./state')` inside functions.
- Static import of `send` from `./network` in main.ts avoids repeated dynamic imports on every pointermove.

### Cursor position approximation
- OrbitControls.target (camera look-at point) used as cursor position proxy. Simpler than raycasting to ground.
- `S.controls.target.x/z` gives the map-space coordinates of where the user is looking.

### Cleanup pattern
- `cleanupStaleCursors()` runs every frame in animate(), iterates the Map, removes entries where `Date.now() - lastSeen > 30000`.
- `depthTest: false, depthWrite: false` on both the ring mesh and name sprite ensures cursors are always visible through geometry.

### Ring + Sprite composition
- Each remote cursor is a `THREE.Group` containing:
  - `THREE.Mesh` with `RingGeometry(0.5, 1.0, 32)` rotated flat (x = -PI/2), semi-transparent `MeshBasicMaterial` with hash-derived color
  - `THREE.Sprite` with CanvasTexture showing first 6 chars of userId, positioned 2 units above the ring
- Position set to `(x, 1, z)` — 1 unit above ground level.
