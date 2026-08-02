/* ------------------------------------------------------------
 * 同步层（P9 多人协同）
 * 桥接 network.ts 和业务模块（board/tactic/utility）。
 * Wave 2 只做骨架：房间管理 + cursor_move 分发。
 * Wave 3-5 将逐步添加 board/tactic/utility 同步逻辑。
 * ---------------------------------------------------------- */
import * as net from './network';
import * as S from './state';
import { STORAGE_KEY_USER_ID, STORAGE_KEY_NICKNAME, STORAGE_KEY_ROOM } from './config';
import type { ServerMsg } from './network';

let _onRoomState: ((data: any) => void) | null = null;
let _onPlayerJoined: ((data: {user_id: string; nickname: string}) => void) | null = null;
let _onPlayerLeft: ((data: {user_id: string}) => void) | null = null;

export function onRoomState(fn: (data: any) => void): void { _onRoomState = fn; }
export function onPlayerJoined(fn: (data: any) => void): void { _onPlayerJoined = fn; }
export function onPlayerLeft(fn: (data: any) => void): void { _onPlayerLeft = fn; }

function getOrCreateId(): string {
  let id = localStorage.getItem(STORAGE_KEY_USER_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY_USER_ID, id);
  }
  return id;
}

export async function createRoom(name?: string): Promise<string> {
  const uid = getOrCreateId();
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anonymous_id: uid, name: name || '' }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.code;
}

export async function joinRoom(code: string, nickname?: string): Promise<void> {
  const uid = getOrCreateId();
  const nick = nickname || localStorage.getItem(STORAGE_KEY_NICKNAME) || '游客';
  localStorage.setItem(STORAGE_KEY_NICKNAME, nick);
  
  // 连接 WebSocket（auth 通过首条 _auth 消息）
  net.connect(code, uid, '', nick);
  
  // 注册消息处理器
  net.onMessage((msg: ServerMsg) => {
    switch (msg.op) {
      case 'room_state':
        S.setMultiplayer(true);
        S.setMyUserId(msg.my_user_id);
        S.setRoomCode(code);
        localStorage.setItem(STORAGE_KEY_ROOM, code);
        if (_onRoomState) _onRoomState(msg);
        break;
      case 'player_joined':
        if (_onPlayerJoined) _onPlayerJoined(msg as any);
        break;
      case 'player_left':
        if (_onPlayerLeft) _onPlayerLeft(msg as any);
        break;
    }
  });
  
  // 监听状态变化
  net.onStateChange((_s) => {
    updateRoomUI();
  });
}

export function leaveRoom(): void {
  net.disconnect();
  S.setMultiplayer(false);
  S.setMyUserId(null);
  S.setRoomCode(null);
  localStorage.removeItem(STORAGE_KEY_ROOM);
  updateRoomUI();
}

function updateRoomUI(): void {
  const info = document.getElementById('room-info');
  const controls = document.getElementById('room-controls');
  const codeEl = document.getElementById('room-code-display');
  const playersEl = document.getElementById('room-players');
  if (!info || !controls || !codeEl || !playersEl) return;
  
  if (S.isMultiplayer) {
    controls.style.display = 'none';
    info.style.display = 'flex';
    codeEl.textContent = `房间: ${S.roomCode}`;
    playersEl.textContent = net.getState() === 'connected' ? '🟢 已连接' : '🟡 重连中';
  } else {
    controls.style.display = 'flex';
    info.style.display = 'none';
    codeEl.textContent = '';
  }
}
