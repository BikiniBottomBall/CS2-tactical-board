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
import { spawnLandingEffect } from './utility';
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
 * 命中点落在下方 8 单位窗口内则贴地，防止转换残差导致浮空/埋地；
 * 从演员自身高度起算，隧道内不会吸到上层地面 */
function snapGround(pos) {
  if (!collisionMesh) return pos;
  _rayOrigin.set(pos.x, pos.y + 4, pos.z);
  boardRaycaster.set(_rayOrigin, _down);
  const hits = boardRaycaster.intersectObject(collisionMesh, false);
  if (hits.length && hits[0].point.y > pos.y - 8) pos.y = hits[0].point.y;
  return pos;
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
const projectilePool = new Map(); // entity -> mesh

const _v = new THREE.Vector3();

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
    buildActors();
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
  projectilePool.clear();
  disposeChildren(replayGroup);
  replayGroup.visible = false;
  actorObjs.length = 0;
  document.getElementById('replay-bar').style.display = 'none';
  document.getElementById('replay-play').textContent = '▶';
}

function buildActors() {
  disposeChildren(replayGroup);
  projectilePool.clear();
  actorObjs.length = 0;
  for (const p of pack.players) {
    const group = createActorVisual(p.name, p.team === 'T');
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
    firedUtilIdx = pack.utility_events.filter(e => e.tick <= tick).length;
    renderFrame();
  }
  syncTimelineUI();
}

function renderFrame() {
  if (!pack || !replayGroup.visible) return;
  const rate = pack.meta.tick_rate;
  const se = pack.meta.sample_every;
  const tick = time * rate;
  const fi = tick / se;
  const i0 = Math.min(Math.floor(fi), pack.frames.length - 1);
  const i1 = Math.min(i0 + 1, pack.frames.length - 1);
  const k = Math.min(Math.max(fi - i0, 0), 1);
  const f0 = pack.frames[i0].p;
  const f1 = pack.frames[i1].p;

  for (let slot = 0; slot < actorObjs.length; slot++) {
    const a = f0[slot], b = f1[slot];
    const obj = actorObjs[slot];
    if (!obj) continue;
    const src = a || b;
    if (!src) { obj.group.visible = false; continue; }
    obj.group.visible = true;
    const x = a && b ? a[0] + (b[0] - a[0]) * k : src[0];
    const y = a && b ? a[1] + (b[1] - a[1]) * k : src[1];
    const z = a && b ? a[2] + (b[2] - a[2]) * k : src[2];
    const yaw = a && b ? lerpAngle(a[3], b[3], k) : src[3];
    obj.group.position.copy(snapGround(worldToScene(x, y, z, _v)));
    obj.group.rotation.y = sourceYawToRadians(yaw);
  }

  // 道具事件：到点放效果
  while (firedUtilIdx < pack.utility_events.length && pack.utility_events[firedUtilIdx].tick <= tick) {
    const e = pack.utility_events[firedUtilIdx++];
    spawnLandingEffect({ type: e.type }, worldToScene(e.x, e.y, e.z, new THREE.Vector3()));
  }

  // 道具弹道：真实采样点插值
  const active = new Set();
  for (const g of pack.grenades) {
    const pts = g.points;
    if (tick < pts[0][0] || tick > pts[pts.length - 1][0]) continue;
    active.add(g.entity);
    let mesh = projectilePool.get(g.entity);
    if (!mesh) {
      const def = MARKER_DEFS[g.type] || MARKER_DEFS.smoke;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 10, 10),
        new THREE.MeshBasicMaterial({ color: def.color })
      );
      replayGroup.add(mesh);
      projectilePool.set(g.entity, mesh);
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
  for (const [entity, mesh] of projectilePool) {
    if (!active.has(entity)) mesh.visible = false;
  }
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
    exit: () => { document.body.classList.remove('demo'); },
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
