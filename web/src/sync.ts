/* ------------------------------------------------------------
 * 同步层（P9 多人协同）
 * 桥接 network.ts 和业务模块（board/tactic/utility）。
 * Wave 2 只做骨架：房间管理 + cursor_move 分发。
 * Wave 3-5 将逐步添加 board/tactic/utility 同步逻辑。
 * ---------------------------------------------------------- */
import * as net from './network';
import * as S from './state';
import * as THREE from 'three';
import { STORAGE_KEY_USER_ID, STORAGE_KEY_NICKNAME, STORAGE_KEY_ROOM } from './config';
import type { ServerMsg } from './network';

// P9-15: 远程光标渲染
const remoteCursors = new Map<string, { mesh: THREE.Group; lastSeen: number }>();
const CURSOR_TIMEOUT = 30000;

let _onRoomState: ((data: any) => void) | null = null;
let _onPlayerJoined: ((data: {user_id: string; nickname: string}) => void) | null = null;
let _onPlayerLeft: ((data: {user_id: string}) => void) | null = null;

export function onRoomState(fn: (data: any) => void): void { _onRoomState = fn; }
export function onPlayerJoined(fn: (data: any) => void): void { _onPlayerJoined = fn; }
export function onPlayerLeft(fn: (data: any) => void): void { _onPlayerLeft = fn; }

/* ---- 在线成员列表 ---- */
let _players: Array<{user_id: string; nickname: string}> = [];
export function getPlayers() { return _players; }

/* room_state.board 里的单个画板项（服务端 JSON 反序列化后的形状） */
interface RemoteBoardItem {
  type?: string;
  kind?: string;
  points?: Array<[number, number, number]>;
  x?: number;
  y?: number;
  z?: number;
  by?: string;
}

function cssHashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 65%, 55%)`;
}

function playerDisplayName(userId: string): string {
  const p = _players.find(x => x.user_id === userId);
  return p ? (p.nickname || userId.slice(0, 6)) : userId.slice(0, 6);
}

function getOrCreateId(): string {
  let id = localStorage.getItem(STORAGE_KEY_USER_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY_USER_ID, id);
  }
  return id;
}

async function fetchToken(uid: string): Promise<string> {
  const res = await fetch(`/api/auth/token?anonymous_id=${encodeURIComponent(uid)}`);
  if (!res.ok) throw new Error(`token 签发失败 HTTP ${res.status}`);
  return (await res.json()).token;
}

export async function createRoom(name?: string): Promise<string> {
  const uid = getOrCreateId();
  const token = await fetchToken(uid);
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anonymous_id: uid, token, name: name || '' }),
  });
  if (!res.ok) throw new Error(`创建房间失败 HTTP ${res.status}`);
  const data = await res.json();
  return data.code;
}

export async function joinRoom(code: string, nickname?: string): Promise<void> {
  const uid = getOrCreateId();
  const nick = nickname || localStorage.getItem(STORAGE_KEY_NICKNAME) || '游客';
  localStorage.setItem(STORAGE_KEY_NICKNAME, nick);

  // 连接 WebSocket（auth 通过首条 _auth 消息）
  const token = await fetchToken(uid);
  net.connect(code, uid, token, nick);
  
  // 注册消息处理器（ServerMsg 判别联合，switch 内自动收窄）
  net.onMessage((msg: ServerMsg) => {
    switch (msg.op) {
      case 'room_state':
        S.setMultiplayer(true);
        S.setMyUserId(msg.my_user_id);
        S.setRoomCode(code);
        localStorage.setItem(STORAGE_KEY_ROOM, code);
        _players = msg.players || [];
        updateRoomUI();
        // Diff merge board items（重连时服务端发完整 room_state，只添加本地没有的）
        import('./board').then(m => {
          const remoteBoard = msg.board as Record<string, RemoteBoardItem>;
          for (const [id, bItem] of Object.entries(remoteBoard)) {
            if (bItem.type === 'line') {
              m.renderRemoteLine(id, bItem.points, bItem.by);
            } else {
              m.renderRemoteMarker(id, bItem.kind, bItem.x, bItem.y, bItem.z, bItem.by);
            }
          }
        });
        if (_onRoomState) _onRoomState(msg);
        break;
      case 'player_joined':
        _players.push({ user_id: msg.user_id, nickname: msg.nickname || '玩家' });
        updateRoomUI();
        if (_onPlayerJoined) _onPlayerJoined(msg);
        break;
      case 'player_left':
        _players = _players.filter(p => p.user_id !== msg.user_id);
        updateRoomUI();
        if (_onPlayerLeft) _onPlayerLeft(msg);
        break;
      case 'cursor_move':
        updateRemoteCursor(msg.user_id, msg.x, msg.z);
        break;
      case 'marker_placed':
        import('./board').then(m => m.renderRemoteMarker(
          msg.id, msg.kind, msg.x, msg.y, msg.z, msg.by
        ));
        break;
      case 'marker_moved':
        import('./board').then(m => m.moveRemoteMarker(msg.id, msg.x, msg.y, msg.z));
        break;
      case 'marker_deleted':
        import('./board').then(m => m.removeRemoteMarker(msg.id));
        break;
      case 'line_updated':
        import('./board').then(m => m.renderRemoteLine(msg.id, msg.points, msg.by));
        break;
      case 'line_deleted':
        import('./board').then(m => m.removeRemoteLine(msg.id));
        break;
      case 'board_undo':
        import('./board').then(m => m.remoteUndoItem(msg.id));
        break;
      case 'board_cleared':
        import('./board').then(m => m.remoteClearAll());
        break;
      case 'actor_moved':
        import('./tactic').then(m => m.remoteActorMove(msg.id, msg.x, msg.y, msg.z));
        break;
      case 'tactic_playback':
        import('./tactic').then(m => m.onRemotePlayback(msg.playing, msg.step_idx));
        break;
      case 'tactic_changed':
        import('./tactic').then(m => m.onRemoteTacticChanged(msg.tactic_id));
        break;
      case 'lock_acquired':
        import('./utility').then(m => {
          m.updateLockUI(msg.by);
          if (msg.by === S.myUserId) m.onLockAcquired(msg.resource);
        });
        // 锁状态提示
        {
          const holderName = msg.by === S.myUserId ? '你' : playerDisplayName(msg.by);
          // 道具面板锁提示
          const ulh = document.getElementById('utility-lock-hint');
          if (ulh && msg.resource === 'utility_recording') {
            ulh.textContent = `🔒 ${holderName} 正在录入道具`;
            ulh.style.display = 'block';
          }
          // 战术面板锁提示
          const tlh = document.getElementById('tactic-lock-hint');
          if (tlh && msg.resource === 'tactic_playback') {
            tlh.textContent = `🔒 ${holderName} 正在播放`;
            tlh.style.display = 'block';
          }
        }
        // tactic_playback 锁回调
        if (msg.resource === 'tactic_playback' && msg.by === S.myUserId) {
          import('./tactic').then(m => m.onPlayLockAcquired());
        }
        break;
      case 'lock_released':
        import('./utility').then(m => {
          m.updateLockUI('');
          m.onLockReleased(msg.resource);
        });
        // 清除锁状态提示
        {
          const ulh = document.getElementById('utility-lock-hint');
          if (ulh) { ulh.textContent = ''; ulh.style.display = 'none'; }
          const tlh = document.getElementById('tactic-lock-hint');
          if (tlh) { tlh.textContent = ''; tlh.style.display = 'none'; }
        }
        break;
      case 'error':
        console.warn('[sync] 服务端错误消息:', msg.message);
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
    
    // 连接状态指示器
    const icons: Record<string, string> = { connected: '🟢', reconnecting: '🟡', disconnected: '🔴', connecting: '🟡' };
    const st = icons[net.getState()] || '🟡';
    
    // 在线成员列表（彩色圆点 + 昵称）
    let html = `${st} `;
    const myId = S.myUserId;
    for (const p of _players) {
      const me = p.user_id === myId ? ' (你)' : '';
      html += `<span style="color:${cssHashColor(p.user_id)}">●</span> ${p.nickname || p.user_id.slice(0, 6)}${me} `;
    }
    if (_players.length === 0) {
      html += '<span style="color:#8b98a8">等待其他玩家加入...</span>';
    }
    playersEl.innerHTML = html;
  } else {
    controls.style.display = 'flex';
    info.style.display = 'none';
    codeEl.textContent = '';
  }
}

/* ---- P9-15: 远程光标渲染 ---- */

function hashColor(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = ((hash << 5) - hash) + userId.charCodeAt(i);
  return (Math.abs(hash) % 0xffffff) | 0x404040; // 保证亮度
}

function updateRemoteCursor(userId: string, x: number, z: number): void {
  let entry = remoteCursors.get(userId);
  if (!entry) {
    // 创建新光标 Group
    const group = new THREE.Group();
    
    // 半透明圆环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 1.0, 32),
      new THREE.MeshBasicMaterial({
        color: hashColor(userId),
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    
    // 昵称 sprite
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px "Microsoft YaHei"';
    ctx.textAlign = 'center';
    ctx.fillText(userId.slice(0, 6), 64, 20);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false }));
    sprite.scale.set(6, 1.5, 1);
    sprite.position.y = 2;
    group.add(sprite);
    
    S.scene.add(group);
    entry = { mesh: group, lastSeen: 0 };
    remoteCursors.set(userId, entry);
  }
  entry.mesh.position.set(x, 1, z); // 离地 1 单位
  entry.lastSeen = Date.now();
}

/** 每帧调用，清理 30 秒未更新的远程光标 */
export function cleanupStaleCursors(): void {
  const now = Date.now();
  remoteCursors.forEach((entry, id) => {
    if (now - entry.lastSeen > CURSOR_TIMEOUT) {
      entry.mesh.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(x => x.dispose());
        else if (mat) mat.dispose();
      });
      S.scene.remove(entry.mesh);
      remoteCursors.delete(id);
    }
  });
}
