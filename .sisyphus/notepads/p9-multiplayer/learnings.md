# P9-13: utility.ts — 道具录入锁

## Pattern: Lock-based concurrency control for multiplayer recording

- `enterRecording()` checks `isMultiplayer` before starting; if true, sends `lock_request` and waits
- `onLockAcquired` callback triggers `startRecording()` (the actual recording logic)
- `cancelUtilityRecording()` releases the lock on exit
- `updateLockUI()` disables the "录入" button and shows tooltip when another user holds the lock
- Server is responsible for lock timeout (60s, P9-14), frontend only requests/releases

## Files changed
- `web/src/network.ts` — Added `lock_request`/`lock_release` to ClientMsg, `lock_acquired`/`lock_released` to ServerMsg
- `web/src/utility.ts` — Lock state, updateLockUI, onLockAcquired, onLockReleased, split enterRecording → startRecording, cancel releases lock
- `web/src/sync.ts` — Registered `lock_acquired` and `lock_released` handlers via dynamic import

## Pre-existing issue
- `sync.ts(54)` has a TypeScript error: `Argument of type 'unknown' is not assignable to parameter of type 'string'` — unrelated to this task

## P9-17: 断线重连状态恢复 (Reconnection State Recovery)

### Changes
- **network.ts**: Reconnect detection in `ws.onopen` — if `reconnectAttempts > 0`, clear `msgBuffer` (discard stale ops, wait for server `room_state`). Auth still sent via `sendRaw` first, then empty buffer replayed (no-op on reconnect).
- **sync.ts**: `room_state` handler now does diff merge — iterates `board` items and calls `renderRemoteMarker`/`renderRemoteLine`, which have dedup checks (`boardItems.has(id)` returns early). This is safe for both initial join and reconnection.
- **op_handler.py / app.py**: Already confirmed — `join_room` sends full `room_state` with `board`, `tactic_id`, `players`, `my_user_id`. No changes needed.

### Key Design
- `renderRemoteMarker`/`renderRemoteLine` in board.ts check `boardItems.has(id)` before rendering → natural dedup
- On reconnect: msgBuffer is cleared → stale operations discarded → server sends fresh `room_state` → diff merge only adds items that don't exist locally
- `reconnectAttempts` is incremented in `scheduleReconnect()` BEFORE `doConnect()` is called, so the check inside `onopen` (`reconnectAttempts > 0`) correctly distinguishes reconnect from initial connect
