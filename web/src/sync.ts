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
        _players = (msg as any).players || [];
        updateRoomUI();
        // Diff merge board items（重连时服务端发完整 room_state，只添加本地没有的）
        import('./board').then(m => {
          const remoteBoard = (msg as any).board || {};
          for (const [id, item] of Object.entries(remoteBoard)) {
            const bItem = item as any;
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
        _players.push({ user_id: (msg as any).user_id, nickname: (msg as any).nickname || '玩家' });
        updateRoomUI();
        if (_onPlayerJoined) _onPlayerJoined(msg as any);
        break;
      case 'player_left':
        _players = _players.filter(p => p.user_id !== (msg as any).user_id);
        updateRoomUI();
        if (_onPlayerLeft) _onPlayerLeft(msg as any);
        break;
      case 'cursor_move':
        updateRemoteCursor((msg as any).user_id, (msg as any).x, (msg as any).z);
        break;
      case 'marker_placed':
        import('./board').then(m => m.renderRemoteMarker(
          (msg as any).id, (msg as any).kind,
          (msg as any).x, (msg as any).y, (msg as any).z,
          (msg as any).by
        ));
        break;
      case 'marker_moved':
        import('./board').then(m => m.moveRemoteMarker(
          (msg as any).id,
          (msg as any).x, (msg as any).y, (msg as any).z
        ));
        break;
      case 'marker_deleted':
        import('./board').then(m => m.removeRemoteMarker((msg as any).id));
        break;
      case 'line_updated':
        import('./board').then(m => m.renderRemoteLine(
          (msg as any).id, (msg as any).points, (msg as any).by
        ));
        break;
      case 'line_deleted':
        import('./board').then(m => m.removeRemoteLine((msg as any).id));
        break;
      case 'board_undo':
        import('./board').then(m => m.remoteUndoItem((msg as any).id));
        break;
      case 'board_cleared':
        import('./board').then(m => m.remoteClearAll());
        break;
      case 'actor_moved':
        import('./tactic').then(m => m.remoteActorMove((msg as any).id, (msg as any).x, (msg as any).y, (msg as any).z));
        break;
      case 'tactic_playback':
        import('./tactic').then(m => m.onRemotePlayback((msg as any).playing, (msg as any).step_idx));
        break;
      case 'tactic_changed':
        import('./tactic').then(m => m.onRemoteTacticChanged((msg as any).tactic_id));
        break;
      case 'lock_acquired':
        import('./utility').then(m => {
          m.updateLockUI((msg as any).by);
          if ((msg as any).by === S.myUserId) m.onLockAcquired((msg as any).resource);
        });
        // 锁状态提示
        {
          const holder = (msg as any).by;
          const holderName = holder === S.myUserId ? '你' : playerDisplayName(holder);
          // 道具面板锁提示
          const ulh = document.getElementById('utility-lock-hint');
          if (ulh && (msg as any).resource === 'utility_recording') {
            ulh.textContent = `🔒 ${holderName} 正在录入道具`;
            ulh.style.display = 'block';
          }
          // 战术面板锁提示
          const tlh = document.getElementById('tactic-lock-hint');
          if (tlh && (msg as any).resource === 'tactic_playback') {
            tlh.textContent = `🔒 ${holderName} 正在播放`;
            tlh.style.display = 'block';
          }
        }
        // tactic_playback 锁回调
        if ((msg as any).resource === 'tactic_playback' && (msg as any).by === S.myUserId) {
          import('./tactic').then(m => m.onPlayLockAcquired());
        }
        break;
      case 'lock_released':
        import('./utility').then(m => {
          m.updateLockUI('');
          m.onLockReleased((msg as any).resource);
        });
        // 清除锁状态提示
        {
          const ulh = document.getElementById('utility-lock-hint');
          if (ulh) { ulh.textContent = ''; ulh.style.display = 'none'; }
          const tlh = document.getElementById('tactic-lock-hint');
          if (tlh) { tlh.textContent = ''; tlh.style.display = 'none'; }
        }
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
      entry.mesh.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      S.scene.remove(entry.mesh);
      remoteCursors.delete(id);
    }
  });
}
