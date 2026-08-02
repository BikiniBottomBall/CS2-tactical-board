# P9-11: Actor Position Multiplayer Sync — Learnings

## What was done
- **network.ts**: Extended `ClientMsg` with `actor_move` and `ServerMsg` with `actor_moved`
- **tactic.ts**: Wrapped `actorPos` with a Proxy that intercepts local writes to detect drag operations, throttles at 100ms, and sends `actor_move` messages. Used `WeakSet` (`_remoteFlag`) to distinguish remote writes from local writes, preventing sync loops. Added `remoteActorMove()` exported function for receiving remote positions with snapped-Y via `groundY()`.
- **sync.ts**: Registered `actor_moved` message handler that calls `remoteActorMove` via dynamic import.

## Key design decisions
1. **Proxy-based interception**: Instead of modifying every `actorPos[id] = ...` site, a single Proxy intercepts all writes. Clean and non-invasive.
2. **WeakSet for remote flag**: `_remoteFlag` uses `WeakSet<object>` — the position object `{x,y,z}` passed to `remoteActorMove` is added to the set, and the Proxy's set trap checks `_remoteFlag.has(value)`. When the object is garbage collected, it auto-removes from the set. No cleanup needed.
3. **100ms throttle**: `_lastActorSync` tracks per-actor last sync time. Prevents flooding the server during smoothstep playback.
4. **r1 rounding**: Uses existing `r1()` (round to 1 decimal) for network payload to reduce bandwidth.
5. **Module-level actorPos init**: `_rawActorPos` is initialized at module level using `defaultActorPos()`. Since `worldToScene` gracefully handles null `mapGroup`, this is safe even before the map loads. The old lazy `ensureActorDefaults()` becomes a no-op.

## Edge cases handled
- **Sync loop prevention**: Remote writes via `remoteActorMove` add the position object to `_remoteFlag` before assignment, so the Proxy sees it and skips the `send()` call.
- **Snapped-Y**: Remote positions are snapped to ground using `groundY()`, matching the MUST NOT requirement.
- **Multiplayer guard**: Sync only triggers when `isMultiplayer` is true (live binding from state.ts).
- **Non-actor properties**: Proxy only intercepts ACTOR_IDS keys; other properties (if any) pass through directly.
