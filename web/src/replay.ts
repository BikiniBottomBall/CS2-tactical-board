// @ts-nocheck
/* ------------------------------------------------------------
 * Demo 回放（P7）：上传 .dem → 解析包 → 时间轴回放 10 人走位
 * + yaw 视锥 + 道具弹道（真实采样点）+ 爆点效果 + 书签订点跳转。
 * 只记录不模拟：位置帧间 lerp 插值，不预测。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, collisionMesh } from './state';
import { ACTOR_DEFS, MARKER_DEFS } from './config';
import { createActorVisual } from './tactic';
import { clearLandingEffects, spawnLandingEffect } from './utility';
import { ensureGrenadeModels, createProjectileVisual, disposeProjectileVisual } from './grenadeModel';
import { worldToScene, sourceYawToRadians } from './coords';
import { boardRaycaster } from './board';
import { registerMode } from './tools';

const BOOKMARK_COLORS = {
  round_start: '#ffffff', round_end: '#6b7888',
  kill: '#ff5252', plant: '#ffa940', defuse: '#5aa9ff',
};
const SPEEDS = [1, 2, 4];

const _down = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3();

/* 高度吸附：从演员位置上方 4 单位向下打射线（走 BVH 地面层），
 * 仅当命中点与当前高度差在 0.8 单位内才贴地（保留跳跃/空中高度，
 * 只修正转换残差），隧道内不会吸到上层地面 */
function snapGround(pos) {
  if (!collisionMesh) return pos;
  _rayOrigin.set(pos.x, pos.y + 4, pos.z);
  boardRaycaster.set(_rayOrigin, _down);
  const hits = boardRaycaster.intersectObject(collisionMesh, false);
  if (hits.length && hits[0].point.y > pos.y - 0.8) pos.y = hits[0].point.y;
  return pos;
}

/* 地面高度：从参考高度上方 4 单位向下射线命中 BVH 地面层，返回地面 y（无命中返回 0） */
function groundHeightAt(x, z, refY) {
  if (!collisionMesh) return 0;
  _rayOrigin.set(x, refY + 4, z);
  boardRaycaster.set(_rayOrigin, _down);
  const hits = boardRaycaster.intersectObject(collisionMesh, false);
  // 跳过头顶上方的结构（隧道/房顶），取脚下最近的地面
  for (const h of hits) {
    if (h.point.y <= refY + 0.8) return h.point.y;
  }
  return 0;
}

/* P13.2.2：跳跃姿态动画（空中前倾 + 四肢摆动 + 落地缓冲），仅回放调用 */
const JUMP_AIR_H = 0.18;   // 高于地面此值视为空中
const JUMP_BUFFER_S = 0.12;

function applyJumpMotion(group, h: number, vy: number, tick: number) {
  const body = group.userData?.body;
  if (!body) return;
  if (group.userData.killState?.dead) return; // 死亡玩家不跳
  const parts = body.userData?.parts;
  const m = group.userData.motion || (group.userData.motion = { prevH: 0, prevVy: 0, buffer: 0 });

  const airborne = h > JUMP_AIR_H;
  const ph = (tick / 64) * 9; // 摆动相位

  if (!airborne) {
    // 落地缓冲：从较高处快速回落触地瞬间压扁
    if (m.prevH > 0.4 && h < 0.2) m.buffer = JUMP_BUFFER_S;
    body.rotation.x = 0;
    body.scale.setScalar(1);
    if (parts) {
      parts.armL.rotation.x = 0;
      parts.armR.rotation.x = 0;
      parts.legL.rotation.x = 0;
      parts.legR.rotation.x = 0;
    }
    if (m.buffer > 0) {
      body.scale.set(1.08, 0.92, 1.08);
      m.buffer = Math.max(m.buffer - 1 / 64, 0);
    }
  } else {
    // 空中：前倾 + 双臂后摆 + 双腿微屈（起跳姿态）
    body.rotation.x = 0.18;
    body.scale.set(1, 1.06, 1);
    if (parts) {
      parts.armL.rotation.x = -0.75 + Math.sin(ph) * 0.18;
      parts.armR.rotation.x = -0.75 - Math.sin(ph) * 0.18;
      parts.legL.rotation.x = -0.28;
      parts.legR.rotation.x = 0.22;
    }
  }

  m.prevH = h;
  m.prevVy = vy;
}

let demos = [];
let currentDemoId = null;
let pack = null;           // 当前解析包
let duration = 0;

let time = 0;
let playing = false;
let speedIdx = 0;
let sliderDragging = false;
let firedUtilIdx = 0;      // 已触发的道具事件下标（utility_events 按 tick 升序）

const replayGroup = new THREE.Group();
replayGroup.name = 'demo-replay';
replayGroup.visible = false;
const actorObjs = [];      // slot -> { group }
// 注意：CS2 entity id 会被复用（pack.grenades 中同 entity 可对应多个投掷物），
// 因此以 grenade 对象本身为 key（对象引用唯一），避免轨迹/弹道球状态互相覆盖。
const projectilePool = new Map(); // grenade -> mesh
const grenadeTrails = new Map();  // grenade -> { line, first, last, fading }：弹道轨迹（生效后淡出）

const _v = new THREE.Vector3();

/* ---- P12 击杀状态：kill feed / 倒地 / 击杀者高亮 ---- */
const KILL_FEED_WINDOW_S = 3.5;
const KILL_HIGHLIGHT_S = 1.0;
const _deadMat = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
const _highlightMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const _actorMats: Record<string, THREE.MeshLambertMaterial> = {
  t: new THREE.MeshLambertMaterial({ color: ACTOR_DEFS.t.color }),
  ct: new THREE.MeshLambertMaterial({ color: ACTOR_DEFS.ct.color }),
};
let killEvents: any[] = [];
let flashEvents: any[] = [];   // { slot, start, end, dur }：被闪状态（起点对齐闪光爆点事件）
let roundStartTicks: number[] = [];
let roundEndTicks: number[] = [];   // P13.2.3：round_end 触发跨局清理
let nameToSlot = new Map<string, number>();
let lastFeedKey = '';
let clearedRoundIdx = 0;   // 已执行回合清理的 round_end 数量（跨局清理用）

/* ---- P12.1 对局 HUD（选手面板 / 回合时间 / 存活状态） ---- */
const HUD_FREEZE_S = 15;    // CS2 默认准备时长
const HUD_ROUND_S = 115;    // CS2 默认回合时长（1:55）
const HUD_END_GAP_S = 5;    // 最后一场结束后的兜底倒计时
const HUD_FILTER_WPN = new Set(['Charm Detachments', 'None']);
let hud: any = null;        // { rows, dotsT, dotsCT, statTicks, stats, rounds, kda, lastTick }

function fmtHudTime(s: number): string {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* KDA：由 kill 事件按当前 tick 累计（全场口径），预计算快照供二分查找 */
function buildKda(): any[] {
  const n = pack.players.length;
  const cur = Array.from({ length: n }, () => ({ k: 0, d: 0, a: 0 }));
  const snaps: any[] = Array.from({ length: n }, () => [{ tick: -1, k: 0, d: 0, a: 0 }]);
  for (const k of killEvents) {
    const touched: number[] = [];
    if (k.attackerSlot >= 0) { cur[k.attackerSlot].k++; touched.push(k.attackerSlot); }
    if (k.victimSlot >= 0) { cur[k.victimSlot].d++; touched.push(k.victimSlot); }
    if (k.assister != null && k.assister >= 0 && k.assister < n) { cur[k.assister].a++; touched.push(k.assister); }
    for (const s of new Set(touched)) snaps[s].push({ tick: k.tick, ...cur[s] });
  }
  return snaps;
}

function kdaAt(slot: number, tick: number): { k: number; d: number; a: number } {
  const arr = (hud.kda[slot] as any[]) || [{ tick: -1, k: 0, d: 0, a: 0 }];
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].tick <= tick) lo = mid; else hi = mid - 1;
  }
  return arr[lo];
}

/* 当前 tick 最近一次 stats 采样（8Hz） */
function hudStatsAt(tick: number): any | null {
  const st = hud.statTicks;
  let lo = 0, hi = st.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (st[mid] <= tick) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx >= 0 ? hud.stats[idx] : null;
}

function aliveAt(tick: number, slot: number): boolean {
  const s = hudStatsAt(tick);
  if (!s) return false;
  const e = s.p[slot];
  return !!(e && e[3]);
}

/* 回合阶段与倒计时：准备时间 → 回合进行中 → 回合结束（依据 pack.rounds） */
function hudPhase(tick: number): { label: string; remain: number } {
  const rate = pack.meta.tick_rate;
  const rounds: any[] = hud.rounds;
  if (!rounds.length || tick < rounds[0].start) return { label: '开局', remain: 0 };
  let ri = -1;
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i].start <= tick) ri = i; else break;
  }
  if (ri < 0) return { label: '开局', remain: 0 };
  const r = rounds[ri];
  const next = rounds[ri + 1] || null;
  if (tick < r.freeze_end) {
    return { label: '准备时间', remain: (r.freeze_end - tick) / rate };
  }
  if (r.end == null || tick < r.end) {
    return { label: '回合进行中', remain: (r.freeze_end + HUD_ROUND_S * rate - tick) / rate };
  }
  const gapTick = next ? next.start : (r.end != null ? r.end + HUD_END_GAP_S * rate : tick);
  return { label: '回合结束', remain: (gapTick - tick) / rate };
}

/* 每回合存活历史条：只显示已结束回合，幸存者取该 round_end 时刻的采样 */
function renderHistory(tick: number) {
  const el = document.getElementById('hud-history');
  if (!el) return;
  el.innerHTML = '';
  const rounds: any[] = hud.rounds;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (r.end == null || r.end > tick) continue;
    const item = document.createElement('div');
    item.className = 'hud-hist' + (r.winner ? ' win-' + (r.winner === 'T' ? 't' : 'ct') : '');
    const tT = document.createElement('span');
    tT.className = 'hud-hist-team t';
    const tC = document.createElement('span');
    tC.className = 'hud-hist-team ct';
    for (const p of pack.players) {
      const d = document.createElement('i');
      d.className = 'hud-dot' + (aliveAt(r.end, p.slot) ? ' on' : '');
      (p.team === 'T' ? tT : tC).appendChild(d);
    }
    const lab = document.createElement('span');
    lab.className = 'hud-hist-lab';
    lab.textContent = `R${i + 1}` + (r.winner ? (r.winner === 'T' ? ' T胜' : ' CT胜') : '');
    item.append(tT, lab, tC);
    el.appendChild(item);
  }
}

/* 按 tick 刷新 HUD（约 8Hz 节流） */
function updateHud(tick: number) {
  if (!hud || !pack) return;
  if (hud.lastTick >= 0 && tick - hud.lastTick < 8) return;
  hud.lastTick = tick;
  const sample = hudStatsAt(tick);
  const entries = sample ? sample.p : [];
  for (let s = 0; s < hud.rows.length; s++) {
    const row = hud.rows[s];
    const e = entries[s] || null;
    const alive = !!(e && e[3]);
    row.root.classList.toggle('dead', !alive);
    const hp = e ? e[0] : 0, ap = e ? e[1] : 0, money = e ? e[2] : 0;
    row.hpBar.style.width = hp + '%';
    row.hpTxt.textContent = String(hp);
    row.apBar.style.width = ap + '%';
    row.apTxt.textContent = String(ap);
    row.money.textContent = '$' + money;
    const wpn = e && e[4] != null ? pack.weapons[e[4]] : null;
    row.wpn.textContent = wpn && !HUD_FILTER_WPN.has(wpn) ? String(wpn) : '—';
    const k = kdaAt(s, tick);
    row.kda.textContent = `${k.k}/${k.d}/${k.a}`;
    const dot = s < hud.dotsT.length ? hud.dotsT[s] : hud.dotsCT[s - hud.dotsT.length];
    if (dot) dot.classList.toggle('on', alive);
  }
  const ph = hudPhase(tick);
  const phaseEl = document.getElementById('hud-phase');
  const timerEl = document.getElementById('hud-timer');
  if (phaseEl) phaseEl.textContent = ph.label;
  if (timerEl) timerEl.textContent = fmtHudTime(ph.remain);
  renderHistory(tick);
}

function hideHud() {
  hud = null;
  const top = document.getElementById('hud-top');
  if (top) top.style.display = 'none';   // 保留静态子元素（phase/timer/alive/history）
  for (const id of ['hud-left', 'hud-right']) {
    const el = document.getElementById(id);
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }
}

function buildHud() {
  hideHud();
  if (!pack || !pack.stats || !pack.stats.length) return;
  const top = document.getElementById('hud-top');
  const left = document.getElementById('hud-left');
  const right = document.getElementById('hud-right');
  if (!top || !left || !right) return;
  top.style.display = 'flex';
  left.style.display = 'block';
  right.style.display = 'block';
  const rows: any[] = [];
  for (const p of pack.players) {
    const row = document.createElement('div');
    row.className = 'hud-row ' + (p.team === 'T' ? 't' : 'ct');
    row.innerHTML =
      `<div class="hud-name"></div>` +
      `<div class="hud-bar hp"><i></i><span></span></div>` +
      `<div class="hud-bar ap"><i></i><span></span></div>` +
      `<div class="hud-meta"><span class="hud-money"></span><span class="hud-wpn"></span><span class="hud-kda"></span></div>`;
    (p.team === 'T' ? left : right).appendChild(row);
    rows[p.slot] = {
      root: row,
      name: row.querySelector('.hud-name'),
      hpBar: row.querySelector('.hp i'),
      hpTxt: row.querySelector('.hp span'),
      apBar: row.querySelector('.ap i'),
      apTxt: row.querySelector('.ap span'),
      money: row.querySelector('.hud-money'),
      wpn: row.querySelector('.hud-wpn'),
      kda: row.querySelector('.hud-kda'),
    };
    rows[p.slot].name.textContent = p.name;
  }
  const aliveRow = document.getElementById('hud-alive');
  if (!aliveRow) return;
  aliveRow.innerHTML = '';
  const dotT = document.createElement('div');
  dotT.className = 'hud-dots t';
  const dotCT = document.createElement('div');
  dotCT.className = 'hud-dots ct';
  aliveRow.append(dotT, dotCT);
  const dotsT: HTMLElement[] = [], dotsCT: HTMLElement[] = [];
  for (const p of pack.players) {
    const d = document.createElement('i');
    d.className = 'hud-dot';
    (p.team === 'T' ? dotT : dotCT).appendChild(d);
    (p.team === 'T' ? dotsT : dotsCT).push(d);
  }
  hud = {
    rows, dotsT, dotsCT,
    statTicks: pack.stats.map((s: any) => s.t),
    stats: pack.stats,
    rounds: pack.rounds || [],
    kda: buildKda(),
    lastTick: -1,
  };
}

function disposeChildren(group) {
  while (group.children.length) {
    const c = group.children.pop();
    c.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------
 * 列表 / 上传
 * ---------------------------------------------------------- */
async function fetchDemos() {
  try {
    const r = await fetch('/api/demos?t=' + Date.now());
    if (r.ok) demos = await r.json();
  } catch (e) {
    console.warn('[replay] 读取 demo 列表失败', e);
  }
  renderDemoList();
}

function renderDemoList() {
  const el = document.getElementById('demo-list');
  el.innerHTML = '';
  if (!demos.length) {
    el.innerHTML = '<div class="calib-hint" style="margin:4px 0">暂无 demo，点击下方上传</div>';
    return;
  }
  for (const d of demos) {
    const row = document.createElement('div');
    row.className = 'calib-item demo-item' + (d.id === currentDemoId ? ' selected' : '');
    const short = d.name.length > 26 ? '…' + d.name.slice(-25) : d.name;
    row.innerHTML = `<span class="demo-name" title="${d.name}">${short}</span>` +
      `<span class="demo-meta">${d.map || ''} ${fmtTime(d.duration_s || 0)}</span>`;
    row.querySelector('.demo-name').addEventListener('click', () => selectDemo(d.id));
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除（含原始文件与解析包）';
    del.addEventListener('click', async () => {
      await fetch(`/api/demos/${d.id}`, { method: 'DELETE' });
      if (currentDemoId === d.id) unloadPack();
      await fetchDemos();
    });
    row.appendChild(del);
    el.appendChild(row);
  }
}

async function uploadDemo(file) {
  const status = document.getElementById('demo-status');
  status.textContent = `上传解析中「${file.name}」…（大文件可能需要几分钟）`;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/demos/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    status.textContent = `解析完成：${data.name}（${fmtTime(data.duration_s || 0)}）`;
    await fetchDemos();
    selectDemo(data.id);
  } catch (e) {
    status.textContent = '上传/解析失败：' + e.message;
    console.warn('[replay] 上传失败', e);
  }
}

/* ------------------------------------------------------------
 * 加载解析包 / 建演员
 * ---------------------------------------------------------- */
async function selectDemo(id) {
  if (currentDemoId === id && pack) return;
  unloadPack();
  currentDemoId = id;
  renderDemoList();
  const status = document.getElementById('demo-status');
  status.textContent = '加载解析包…';
  try {
    const r = await fetch(`/api/demos/${id}/pack`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    pack = data;
    pack.utility_events.sort((a, b) => a.tick - b.tick);
    duration = pack.meta.duration_s || (pack.meta.max_tick / pack.meta.tick_rate);
    await ensureGrenadeModels();   // P13.2.4 预载投掷物模型（失败内部回退，不阻塞回放）
    buildActors();
    buildHud();   // P12.1 对局 HUD
    buildBookmarks();
    document.getElementById('replay-bar').style.display = 'block';
    document.getElementById('replay-slider').max = String(duration);
    status.textContent = `${pack.meta.name} · ${pack.players.length} 人 · ${pack.frames.length} 帧`;
    seek(0);
  } catch (e) {
    status.textContent = '加载失败：' + e.message;
    console.warn('[replay] 加载 pack 失败', e);
  }
}

function unloadPack() {
  pack = null;
  playing = false;
  time = 0;
  firedUtilIdx = 0;
  hideHud();
  disposeChildren(replayGroup);
  replayGroup.visible = false;
  actorObjs.length = 0;
  projectilePool.clear();
  grenadeTrails.clear();
  killEvents = [];
  flashEvents = [];
  roundStartTicks = [];
  roundEndTicks = [];
  nameToSlot.clear();
  lastFeedKey = '';
  clearedRoundIdx = 0;
  const kf = document.getElementById('kill-feed');
  if (kf) kf.innerHTML = '';
  document.getElementById('replay-bar').style.display = 'none';
  document.getElementById('replay-play').textContent = '▶';
}

/* ---- P12 击杀索引与时间驱动状态 ---- */
function buildKillIndex() {
  nameToSlot = new Map();
  (pack.players || []).forEach((p, i) => {
    if (!nameToSlot.has(p.name)) nameToSlot.set(p.name, i);
  });
  roundStartTicks = (pack.events || [])
    .filter(e => e.type === 'round_start')
    .map(e => e.tick)
    .sort((a, b) => a - b);
  roundEndTicks = (pack.events || [])
    .filter(e => e.type === 'round_end')
    .map(e => e.tick)
    .sort((a, b) => a - b);
  killEvents = (pack.events || [])
    .filter(e => e.type === 'kill')
    .map(normalizeKill)
    .sort((a, b) => a.tick - b.tick);
  buildFlashIndex();
}

/* P13.2.2 修复：被闪状态改为事件驱动——从帧数据提取每个玩家的被闪区段，
 * 并把区段起点对齐到最近的闪光爆点事件 tick（避免帧插值导致“效果未出先被闪”） */
function buildFlashIndex() {
  flashEvents = [];
  const flashTicks = (pack.utility_events || [])
    .filter(e => e.type === 'flash')
    .map(e => e.tick);
  const pushSeg = (slot, startTick, dur, endTick) => {
    // 对齐最近的闪光爆点（±16 tick 内取最近）
    let best = -1, bestDist = Infinity;
    for (const ft of flashTicks) {
      if (ft >= startTick - 16 && ft <= startTick + 8) {
        const d = Math.abs(ft - startTick);
        if (d < bestDist) { bestDist = d; best = ft; }
      }
    }
    flashEvents.push({ slot, start: best >= 0 ? best : startTick, end: endTick, dur });
  };
  const n = (pack.players || []).length;
  for (let slot = 0; slot < n; slot++) {
    let segStart = -1, segDur = 0;
    for (const fr of pack.frames) {
      const p = fr.p[slot];
      const v = p ? (p[4] ?? 0) : 0;
      if (v > 0.1) {
        if (segStart < 0) { segStart = fr.t; segDur = v; }
      } else if (segStart >= 0) {
        pushSeg(slot, segStart, segDur, fr.t);
        segStart = -1;
      }
    }
    if (segStart >= 0) pushSeg(slot, segStart, segDur, Number.MAX_SAFE_INTEGER);
  }
}

function normalizeKill(e) {
  let attacker = e.attacker, user = e.user, weapon = e.weapon, headshot = e.headshot;
  if (attacker == null || user == null) {
    // 旧 pack 回退：label 形如「A 击杀 B（weapon）（爆头）」
    const m = /^(.+?) 击杀 (.+?)（(.+?)）/.exec(e.label || '');
    if (m) {
      attacker = m[1];
      user = m[2];
      weapon = m[3].replace(/（爆头）$/, '');
    }
    headshot = /（爆头）/.test(e.label || '');
  }
  return {
    tick: e.tick,
    attacker: attacker != null ? String(attacker) : '',
    user: user != null ? String(user) : '',
    weapon: String(weapon || '').replace('weapon_', ''),
    headshot: !!headshot,
    attackerSlot: nameToSlot.has(attacker) ? nameToSlot.get(attacker) : -1,
    victimSlot: nameToSlot.has(user) ? nameToSlot.get(user) : -1,
    assister: e.assister != null ? e.assister : -1,
    label: e.label || '',
  };
}

function lastRoundStart(tick: number): number {
  let rs = 0;
  for (const t of roundStartTicks) {
    if (t <= tick) rs = t;
    else break;
  }
  return rs;
}

/* P13.2.3：最近一次 round_end（本局起点判定用；0 表示第一局尚未结束） */
function lastRoundEnd(tick: number): number {
  let re = 0;
  for (const t of roundEndTicks) {
    if (t <= tick) re = t;
    else break;
  }
  return re;
}

function getKillsInWindow(tick: number, winS: number, rs: number): any[] {
  const minTick = tick - winS * pack.meta.tick_rate;
  const out = [];
  for (const k of killEvents) {
    if (k.tick > tick) break;
    if (k.tick < minTick || k.tick < rs) continue;
    out.push(k);
  }
  return out;
}

function getDeadSlots(tick: number): Set<number> {
  const rs = lastRoundStart(tick);
  const dead = new Set<number>();
  for (const k of killEvents) {
    if (k.tick > tick) break;
    if (k.tick < rs || k.victimSlot < 0) continue;
    dead.add(k.victimSlot);
  }
  return dead;
}

function applyKillState(tick: number, flashBySlot: Record<number, number>) {
  if (!pack || !actorObjs.length) return;
  const rate = pack.meta.tick_rate;
  const rs = lastRoundStart(tick);
  const dead = getDeadSlots(tick);
  const kills = getKillsInWindow(tick, KILL_FEED_WINDOW_S, rs);
  const latest = kills.length ? kills[kills.length - 1] : null;
  const highlightSlot = latest && tick - latest.tick <= KILL_HIGHLIGHT_S * rate ? latest.attackerSlot : -1;

  for (let slot = 0; slot < actorObjs.length; slot++) {
    const obj = actorObjs[slot];
    if (!obj) continue;
    const isDead = dead.has(slot);
    const isHL = slot === highlightSlot && !isDead;
    const isFlash = !isDead && (flashBySlot[slot] || 0) > 0.1;
    applyActorBodyState(obj.group, isDead, isHL, isFlash);
  }
  updateFlashRings(flashBySlot, dead);
  updateKillFeed(kills);
}

function applyActorBodyState(group, dead: boolean, highlight: boolean, flash: boolean) {
  const body = group.userData?.body;
  if (!body) return;
  const st = group.userData.killState || (group.userData.killState = { dead: false, highlight: false, flash: false });
  if (st.dead === dead && st.highlight === highlight && st.flash === flash) return;
  st.dead = dead;
  st.highlight = highlight;
  st.flash = flash;
  body.rotation.x = dead ? -Math.PI / 2 : 0;
  const teamKey = group.userData.teamKey || 't';
  const mat = dead ? _deadMat : ((flash || highlight) ? _highlightMat : _actorMats[teamKey]);
  body.traverse(o => { if (o.isMesh) o.material = mat; });
}

/* ---- 被闪头顶圆环指示器：白色圆弧 = 剩余被白时间比例（纯图形，无数字） ---- */
const FLASH_FULL_S = 3; // 满闪按 3s 归算

function createFlashRing(group) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false,
  }));
  sprite.scale.set(0.15, 0.15, 1);
  sprite.position.y = 4.5;
  sprite.renderOrder = 1003;
  group.add(sprite);
  return { sprite, canvas, tex };
}

function removeFlashRing(group) {
  const ring = group.userData.flashRing;
  if (!ring) return;
  group.remove(ring.sprite);
  ring.tex.dispose();
  ring.sprite.material.dispose();
  group.userData.flashRing = null;
}

function drawFlashRing(ring, progress: number) {
  const ctx = ring.canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(64, 64, 45, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(64, 64, 45, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ring.tex.needsUpdate = true;
}

function updateFlashRings(flashBySlot: Record<number, number>, dead: Set<number>) {
  for (let slot = 0; slot < actorObjs.length; slot++) {
    const obj = actorObjs[slot];
    if (!obj) continue;
    const g = obj.group;
    const flash = flashBySlot[slot] || 0;
    if (flash > 0.1 && !dead.has(slot)) {
      if (!g.userData.flashRing) g.userData.flashRing = createFlashRing(g);
      drawFlashRing(g.userData.flashRing, Math.min(flash / FLASH_FULL_S, 1));
    } else if (g.userData.flashRing) {
      removeFlashRing(g);
    }
  }
}

function updateKillFeed(kills: any[]) {
  const el = document.getElementById('kill-feed');
  if (!el) return;
  const key = kills.map(k => `${k.tick}:${k.attacker}>${k.user}:${k.headshot}`).join('|');
  if (key === lastFeedKey) return;
  lastFeedKey = key;
  el.innerHTML = '';
  for (const k of kills) {
    const row = document.createElement('div');
    row.className = 'kf-row';
    if (!k.attacker && !k.user) {
      row.textContent = k.label || '';
      el.appendChild(row);
      continue;
    }
    const a = document.createElement('span');
    a.className = 'kf-name ' + teamClass(k.attackerSlot);
    a.textContent = k.attacker;
    const w = document.createElement('span');
    w.className = 'kf-weapon';
    w.textContent = k.weapon || '?';
    const v = document.createElement('span');
    v.className = 'kf-name ' + teamClass(k.victimSlot);
    v.textContent = k.user;
    row.append(a, w, v);
    if (k.headshot) {
      const hs = document.createElement('span');
      hs.className = 'kf-headshot';
      hs.textContent = '爆头';
      row.appendChild(hs);
    }
    el.appendChild(row);
  }
}

function teamClass(slot: number): string {
  if (slot >= 0 && pack.players && pack.players[slot]) {
    return pack.players[slot].team === 'T' ? 'kf-t' : 'kf-ct';
  }
  return '';
}

function buildActors() {
  disposeChildren(replayGroup);
  projectilePool.clear();
  actorObjs.length = 0;
  buildKillIndex();
  for (const p of pack.players) {
    const group = createActorVisual(p.name, p.team === 'T');
    group.userData.teamKey = p.team === 'T' ? 't' : 'ct';
    // yaw 视锥扇形（贴地半透明，指示朝向）
    const def = ACTOR_DEFS[p.team === 'T' ? 't' : 'ct'];
    const cone = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 16, -0.5, 1.0),
      new THREE.MeshBasicMaterial({
        color: def.color, transparent: true, opacity: 0.3,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.y = 0.12;
    group.add(cone);
    replayGroup.add(group);
    actorObjs[p.slot] = { group };
  }
  replayGroup.visible = true;
}

function buildBookmarks() {
  const track = document.getElementById('bookmark-track');
  track.querySelectorAll('.bookmark-dot').forEach(d => d.remove());
  const maxTick = pack.meta.max_tick || 1;
  for (const ev of pack.events) {
    const dot = document.createElement('span');
    dot.className = 'bookmark-dot';
    dot.style.left = (ev.tick / maxTick * 100) + '%';
    dot.style.background = BOOKMARK_COLORS[ev.type] || '#ffffff';
    dot.title = `${fmtTime(ev.tick / pack.meta.tick_rate)} ${ev.label || ev.type}`;
    dot.addEventListener('click', () => seek(ev.tick / pack.meta.tick_rate));
    track.appendChild(dot);
  }
}

/* ------------------------------------------------------------
 * 回放核心：seek / 帧插值 / 道具
 * ---------------------------------------------------------- */
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * k;
}

function seek(t) {
  time = Math.min(Math.max(t, 0), duration);
  if (pack) {
    const tick = time * pack.meta.tick_rate;
    // 快照式补齐：跳到任意时刻时，只触发当前可见窗口（覆盖最长烟雾 15s）内的道具事件，
    // 修复既有逻辑（原指针指向第一个未来事件导致落地效果从不触发），且避免跳转批量爆炸
    const windowTicks = 16 * pack.meta.tick_rate;
    let idx = pack.utility_events.findIndex(e => e.tick > tick - windowTicks);
    firedUtilIdx = idx < 0 ? pack.utility_events.length : idx;
    if (hud) hud.lastTick = -1;   // 跳转时强制刷新 HUD
    renderFrame();
  }
  syncTimelineUI();
}

function renderFrame() {
  if (!pack || !replayGroup.visible) return;
  const rate = pack.meta.tick_rate;
  const se = pack.meta.sample_every;
  const tick = time * rate;
  // P13.2.3 round_end 触发：清理本局残留的道具轨迹 / 弹道网格 / 落地效果
  while (clearedRoundIdx < roundEndTicks.length && tick >= roundEndTicks[clearedRoundIdx]) {
    clearLandingEffects();
    for (const [, tr] of grenadeTrails) {
      replayGroup.remove(tr.line);
      tr.line.geometry.dispose();
      tr.line.material.dispose();
    }
    grenadeTrails.clear();
    for (const [, mesh] of projectilePool) {
      replayGroup.remove(mesh);
      disposeProjectileVisual(mesh);
    }
    projectilePool.clear();
    clearedRoundIdx++;
  }
  const fi = tick / se;
  const i0 = Math.min(Math.floor(fi), pack.frames.length - 1);
  const i1 = Math.min(i0 + 1, pack.frames.length - 1);
  const k = Math.min(Math.max(fi - i0, 0), 1);
  const f0 = pack.frames[i0].p;
  const f1 = pack.frames[i1].p;
  const flashBySlot: Record<number, number> = {};
  for (const fe of flashEvents) {
    if (tick >= fe.start && tick < fe.end) {
      const rem = fe.dur - (tick - fe.start) / rate;
      if (rem > 0.1) flashBySlot[fe.slot] = Math.max(flashBySlot[fe.slot] || 0, rem);
    }
  }

  for (let slot = 0; slot < actorObjs.length; slot++) {
    const a = f0[slot], b = f1[slot];
    const obj = actorObjs[slot];
    if (!obj) continue;
    const src = a || b;
    if (!src) { obj.group.visible = false; continue; }
    // 过滤 [0,0,0] 占位（玩家不在场时坐标归零），避免假位置干扰回放与跳跃判定
    if (Math.abs(src[0]) < 0.01 && Math.abs(src[1]) < 0.01) { obj.group.visible = false; continue; }
    obj.group.visible = true;
    const x = a && b ? a[0] + (b[0] - a[0]) * k : src[0];
    const y = a && b ? a[1] + (b[1] - a[1]) * k : src[1];
    const z = a && b ? a[2] + (b[2] - a[2]) * k : src[2];
    const yaw = a && b ? lerpAngle(a[3], b[3], k) : src[3];
    worldToScene(x, y, z, _v);
    const rawY = _v.y;
    const ground = groundHeightAt(_v.x, _v.z, rawY);
    obj.group.position.copy(snapGround(_v));
    const h = rawY - ground;
    const gm = obj.group.userData.motion || (obj.group.userData.motion = {});
    const dt = Math.max((tick - (gm.prevTick ?? tick)) / rate, 0.001);
    const vy = (h - (gm.prevH ?? h)) / dt;
    gm.prevTick = tick;
    applyJumpMotion(obj.group, h, vy, tick);
    obj.group.rotation.y = sourceYawToRadians(yaw);
  }

  // 道具事件：到点放效果
  const roundBase = lastRoundEnd(tick);   // P13.2.3：本局起点（最近一次 round_end）
  while (firedUtilIdx < pack.utility_events.length && pack.utility_events[firedUtilIdx].tick <= tick) {
    const e = pack.utility_events[firedUtilIdx++];
    if (e.tick <= roundBase) continue;    // P13.2.3：上一局的落点效果已清除，不复活
    spawnLandingEffect({ type: e.type }, worldToScene(e.x, e.y, e.z, new THREE.Vector3()));
  }

  // 道具弹道：真实采样点插值
  const active = new Set();
  for (const g of pack.grenades) {
    const pts = g.points;
    const first = pts[0][0];
    const last = pts[pts.length - 1][0];
    if (tick < first) continue;
    if (first <= roundBase) continue;     // P13.2.3：上一局/更早的轨迹不再显示
    // P13.2.1：弹道轨迹（加色发光高亮，懒创建，随弹体渐进画出；落地/生效后 2s 正常淡出）
    let tr = grenadeTrails.get(g);
    if (!tr) {
      const linePts = pts.map(p => worldToScene(p[1], p[2], p[3], new THREE.Vector3()));
      const def = MARKER_DEFS[g.type] || MARKER_DEFS.smoke;
      const geo = new THREE.BufferGeometry().setFromPoints(linePts);
      geo.setDrawRange(0, 1);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: def.color, transparent: true, opacity: 0.9,
          depthTest: false, blending: THREE.AdditiveBlending,
        })
      );
      line.visible = false;
      replayGroup.add(line);
      tr = { line, first, last, fading: false };
      grenadeTrails.set(g, tr);
    }
    if (tick <= last) {
      tr.fading = false;
      tr.line.visible = true;
      tr.line.material.opacity = 0.9;
      tr.line.geometry.setDrawRange(0, Math.max(1, Math.round(((tick - first) / (last - first)) * pts.length)));
    } else if (!tr.fading) {
      tr.fading = true; // 生效：开始淡出
    }
    if (tick > last) continue;
    active.add(g);
    let mesh = projectilePool.get(g);
    if (!mesh) {
      mesh = createProjectileVisual(g.type);
      replayGroup.add(mesh);
      projectilePool.set(g, mesh);
    }
    mesh.visible = true;
    let j = 0;
    while (j < pts.length - 2 && pts[j + 1][0] < tick) j++;
    const p0 = pts[j], p1 = pts[j + 1];
    const span = p1[0] - p0[0];
    const kk = span > 0 ? (tick - p0[0]) / span : 0;
    mesh.position.copy(worldToScene(
      p0[1] + (p1[1] - p0[1]) * kk,
      p0[2] + (p1[2] - p0[2]) * kk,
      p0[3] + (p1[3] - p0[3]) * kk,
      _v
    ));
  }
  for (const [g, mesh] of projectilePool) {
    if (!active.has(g)) mesh.visible = false;
  }
  // 弹道轨迹淡出推进与清理
  const fadeRate = 2 * rate;
  for (const [g, tr] of grenadeTrails) {
    if (!tr.fading) continue;
    const fadeK = (tick - tr.last) / fadeRate;
    if (fadeK >= 1) {
      replayGroup.remove(tr.line);
      tr.line.geometry.dispose();
      tr.line.material.dispose();
      grenadeTrails.delete(g);
    } else {
      tr.line.material.opacity = 0.9 * (1 - fadeK);
    }
  }

  // P12：击杀状态（倒地/高亮/kill feed）按当前时间快照同步
  applyKillState(tick, flashBySlot);
  updateHud(tick);   // P12.1 对局 HUD
}

function syncTimelineUI() {
  if (!sliderDragging) document.getElementById('replay-slider').value = String(time);
  document.getElementById('replay-time').textContent = `${fmtTime(time)} / ${fmtTime(duration)}`;
}

function setPlaying(on) {
  if (!pack) return;
  if (on && time >= duration) time = 0; // 播完再点 → 从头
  playing = on;
  document.getElementById('replay-play').textContent = on ? '⏸' : '▶';
}

/* 主循环钩子 */
export function updateReplay(dt) {
  if (!pack || !playing) return;
  time += dt * SPEEDS[speedIdx];
  if (time >= duration) {
    time = duration;
    setPlaying(false);
  }
  renderFrame();
  syncTimelineUI();
}

/* ------------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
export function initReplay() {
  scene.add(replayGroup);

  registerMode('demo', {
    label: '📼 Demo 回放',
    toggleOff: true,
    enter: () => {
      document.body.classList.add('demo');
      fetchDemos();
    },
    exit: () => { document.body.classList.remove('demo'); hideHud(); },
  });
  document.getElementById('demo-upload-btn').addEventListener('click', () => {
    document.getElementById('demo-upload-file').click();
  });
  document.getElementById('demo-upload-file').addEventListener('change', e => {
    if (e.target.files[0]) uploadDemo(e.target.files[0]);
    e.target.value = '';
  });

  const slider = document.getElementById('replay-slider');
  slider.addEventListener('pointerdown', () => { sliderDragging = true; });
  slider.addEventListener('pointerup', () => { sliderDragging = false; });
  slider.addEventListener('input', () => seek(parseFloat(slider.value)));
  document.getElementById('replay-play').addEventListener('click', () => setPlaying(!playing));
  document.getElementById('replay-speed').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    document.getElementById('replay-speed').textContent = SPEEDS[speedIdx] + 'x';
  });

  fetchDemos();
}
