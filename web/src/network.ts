/* ------------------------------------------------------------
 * WebSocket 连接管理器（P9 多人协同）
 * 原生 WebSocket，断线自动重连（指数退避），消息缓冲。
 * ---------------------------------------------------------- */

// ---- 消息类型 ----
export type ClientMsg =
  | { op: 'cursor_move'; x: number; z: number }
  | { op: 'marker_place'; kind: string; x: number; y: number; z: number; temp_id: string }
  | { op: 'marker_move'; id: string; x: number; y: number; z: number }
  | { op: 'marker_delete'; id: string }
  | { op: 'line_begin'; x: number; y: number; z: number; temp_id: string; points: Array<[number,number,number]> }
  | { op: 'line_delete'; id: string }
  | { op: 'board_undo'; user_id: string; id: string }
  | { op: 'board_clear' }
  | { op: 'lock_request'; resource: string }
  | { op: 'lock_release'; resource: string }
  | { op: 'actor_move'; id: string; x: number; y: number; z: number }
  | { op: 'tactic_select'; tactic_id: number }
  | { op: 'tactic_playback'; playing: boolean; step_idx: number };

export type ServerMsg =
  | { op: 'room_state'; board: Record<string, unknown>; tactic_id: number | null; players: Array<{user_id: string; nickname: string}>; my_user_id: string }
  | { op: 'player_joined'; user_id: string; nickname: string }
  | { op: 'player_left'; user_id: string }
  | { op: 'cursor_move'; user_id: string; x: number; z: number }
  | { op: 'marker_placed'; id: string; kind: string; x: number; y: number; z: number; by: string }
  | { op: 'marker_moved'; id: string; x: number; y: number; z: number; by: string }
  | { op: 'marker_deleted'; id: string; by: string }
  | { op: 'line_updated'; id: string; points: Array<[number,number,number]>; by: string }
  | { op: 'line_deleted'; id: string; by: string }
  | { op: 'board_undo'; id: string; by: string }
  | { op: 'board_cleared'; by: string }
  | { op: 'lock_acquired'; resource: string; by: string }
  | { op: 'lock_released'; resource: string }
  | { op: 'actor_moved'; id: string; x: number; y: number; z: number; by: string }
  | { op: 'tactic_playback'; playing: boolean; step_idx: number; by: string }
  | { op: 'tactic_changed'; tactic_id: number; by: string }
  | { op: string; [key: string]: unknown };

// ---- 状态 ----
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

let ws: WebSocket | null = null;
let state: ConnectionState = 'disconnected';
let handlers: Array<(msg: ServerMsg) => void> = [];
let reconnectTimer = 0;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
const BASE_DELAY = 1000; // ms
let msgBuffer: ClientMsg[] = [];
const MAX_BUFFER = 100;

let currentRoomCode = '';
let currentAnonymousId = '';
let currentToken = '';
let currentNickname = '';

const listeners: Array<(s: ConnectionState) => void> = [];

// ---- API ----

export function getState(): ConnectionState { return state; }

function setState(s: ConnectionState): void {
  state = s;
  for (const fn of listeners) fn(s);
}

export function onStateChange(fn: (s: ConnectionState) => void): void {
  listeners.push(fn);
}

export function connect(roomCode: string, anonymousId: string, token: string, nickname: string = '游客'): void {
  currentRoomCode = roomCode;
  currentAnonymousId = anonymousId;
  currentToken = token;
  currentNickname = nickname;
  doConnect();
}

function doConnect(): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  setState('connecting');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${currentRoomCode}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setState('connected');
    // 如果是重连（非首次），清空缓冲区，丢弃过期操作，等 room_state 恢复
    if (reconnectAttempts > 0) {
      msgBuffer = [];
    }
    reconnectAttempts = 0;
    // 发送认证 header（通过首条消息）
    sendRaw({ _auth: { anonymous_id: currentAnonymousId, token: currentToken, nickname: currentNickname } });
    // 重放缓冲消息（重连时已清空）
    for (const msg of msgBuffer) sendRaw(msg);
    msgBuffer = [];
  };

  ws.onmessage = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data as string) as ServerMsg;
      for (const fn of handlers) fn(data);
    } catch { /* 忽略非 JSON 消息 */ }
  };

  ws.onclose = () => {
    ws = null;
    if (state === 'connected') {
      setState('reconnecting');
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose 会紧随其后处理，不用在这里做
  };
}

// WebSocket 连接通过 header 传 auth，但 JS WebSocket API 不支持自定义 header。
// 替代方案：连接建立后通过首条 JSON 消息传 auth 信息。
function sendRaw(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function send(msg: ClientMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (msgBuffer.length < MAX_BUFFER) {
    msgBuffer.push(msg);
  }
}

export function onMessage(handler: (msg: ServerMsg) => void): void {
  handlers.push(handler);
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT || currentRoomCode === '') return;
  const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    if (state === 'reconnecting') {
      doConnect();
    }
  }, delay);
}

export function disconnect(): void {
  currentRoomCode = '';
  clearTimeout(reconnectTimer);
  if (ws) { ws.close(); ws = null; }
  setState('disconnected');
}
