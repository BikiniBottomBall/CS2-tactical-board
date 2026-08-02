// @ts-nocheck
/* ------------------------------------------------------------
 * 道具库（P4）：lineup 录入（站位/落点/投掷方式）、REST 存储、
 * 轨迹预览（二次贝塞尔虚线）、播放动画（弹体 + 落地效果）。
 * 录入取点复用 board 的分层命中（raycastMapAll + Tab 切层 + +/- 微调）。
 * 面板开合与互斥由 tools.ts 状态机统一调度。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, renderer, mapGroup, isMultiplayer, myUserId } from './state';
import { MARKER_DEFS } from './config';
import { getDotTexture, raycastMapAll } from './board';
import { registerMode } from './tools';
import { send } from './network';

const TYPE_ORDER = ['smoke', 'flash', 'molotov'];
const TYPE_NAMES = { smoke: '烟雾弹', flash: '闪光弹', molotov: '燃烧弹' };
const FLIGHT_TIME = 1.6; // 弹体飞行时长（秒）

let utilities = [];        // 服务端道具列表
let selectedId = null;     // 当前选中（轨迹预览）的道具 id

/* 录入状态：{ type, throwType, step, stand, landing } */
let recording = null;
let utilHits = [];         // 当前步骤点击命中层级
let utilHitIdx = 0;
let heightAdjust = 0;

/* ---- P9 多人协同：道具录入锁 ---- */
let currentLockHolder = '';
export function updateLockUI(holder: string): void {
  currentLockHolder = holder;
  const addBtn = document.getElementById('utility-add');
  if (addBtn) {
    if (holder && holder !== myUserId) {
      addBtn.disabled = true;
      addBtn.title = '别人正在录入道具';
    } else {
      addBtn.disabled = false;
      addBtn.title = '';
    }
  }
}

export function onLockAcquired(resource: string): void {
  if (resource === 'utility_recording') {
    enterRecording();
  }
}

export function onLockReleased(resource: string): void {
  if (resource === 'utility_recording') {
    updateLockUI('');
  }
}

/* 播放与效果 */
let playing = null;        // { u, curve, ball, t }
const effects = [];        // { t, life, objs, tick }
let elapsed = 0;

const trajPreview = new THREE.Group();  // 轨迹预览（虚线 + 站位点 + 落点环）
trajPreview.name = 'utility-traj-preview';
const pickPreview = new THREE.Group();  // 录入取点黄环
pickPreview.name = 'utility-pick-preview';
const fxGroup = new THREE.Group();      // 播放弹体 + 落地效果
fxGroup.name = 'utility-fx';

function disposeGroup(group) {
  while (group.children.length) {
    const c = group.children.pop();
    c.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }
}

function disposeObject(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
}

export function isUtilityRecording() { return !!recording; }

/* ------------------------------------------------------------
 * REST
 * ---------------------------------------------------------- */
async function fetchUtilities() {
  try {
    const r = await fetch('/api/utilities?t=' + Date.now());
    if (r.ok) utilities = await r.json();
  } catch (e) {
    console.warn('[utility] 读取道具失败', e);
  }
  renderUtilityList();
}

async function saveUtility() {
  const name = document.getElementById('utility-name').value.trim();
  if (!name) { document.getElementById('utility-name').focus(); return; }
  if (!recording.stand || !recording.landing) {
    document.getElementById('utility-coords').textContent = '请先点站位和落点';
    return;
  }
  const body = {
    name,
    type: recording.type,
    throw_type: recording.throwType,
    stand_x: recording.stand.x, stand_y: recording.stand.y, stand_z: recording.stand.z,
    landing_x: recording.landing.x, landing_y: recording.landing.y, landing_z: recording.landing.z,
  };
  try {
    const r = await fetch('/api/utilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    const created = await r.json();
    await fetchUtilities();
    selectUtility(created.id); // 保存后立即预览轨迹
    // 继续录下一个：清点位、刷新名称建议
    recording.stand = null;
    recording.landing = null;
    recording.step = 'stand';
    utilHits = [];
    updateStepUI();
    updatePickRing();
    suggestName();
    document.getElementById('utility-coords').textContent = '已保存，点击地图选下一个站位';
  } catch (e) {
    console.warn('[utility] 保存失败', e);
    document.getElementById('utility-coords').textContent = '保存失败：' + e.message;
  }
}

async function renameUtility(u) {
  const name = prompt('道具名称', u.name);
  if (!name || name === u.name) return;
  try {
    await fetch(`/api/utilities/${u.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await fetchUtilities();
  } catch (e) {
    console.warn('[utility] 改名失败', e);
  }
}

async function deleteUtility(u) {
  try {
    await fetch(`/api/utilities/${u.id}`, { method: 'DELETE' });
    if (selectedId === u.id) selectUtility(null);
    await fetchUtilities();
  } catch (e) {
    console.warn('[utility] 删除失败', e);
  }
}

/* ------------------------------------------------------------
 * 面板列表
 * ---------------------------------------------------------- */
function renderUtilityList() {
  const el = document.getElementById('utility-list');
  if (!el) return;
  el.innerHTML = '';
  if (!utilities.length) {
    el.innerHTML = '<div class="calib-hint" style="margin:4px 0">暂无道具，点击下方「＋ 录入道具」</div>';
    return;
  }
  for (const type of TYPE_ORDER) {
    const group = utilities.filter(u => (u.type || 'smoke') === type);
    if (!group.length) continue;
    const title = document.createElement('div');
    title.className = 'util-group-title';
    title.textContent = TYPE_NAMES[type];
    el.appendChild(title);
    for (const u of group) {
      const row = document.createElement('div');
      row.className = 'calib-item util-item' + (u.id === selectedId ? ' selected' : '');
      const css = (MARKER_DEFS[u.type] || MARKER_DEFS.smoke).css;
      row.innerHTML = `<span class="tb-dot" style="background:${css}"></span>` +
        `<span class="util-name" title="点击预览轨迹">${u.name}</span>` +
        `<span class="util-throw">${u.throw_type || ''}</span>`;
      row.querySelector('.util-name').addEventListener('click', () => {
        selectUtility(u.id === selectedId ? null : u.id);
      });

      const play = document.createElement('button');
      play.textContent = '▶';
      play.title = '播放轨迹';
      play.addEventListener('click', () => { selectUtility(u.id); playUtility(u); });
      const ren = document.createElement('button');
      ren.textContent = '✎';
      ren.title = '改名';
      ren.addEventListener('click', () => renameUtility(u));
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '删除';
      del.addEventListener('click', () => deleteUtility(u));
      row.append(play, ren, del);
      el.appendChild(row);
    }
  }
}

/* ------------------------------------------------------------
 * 轨迹：二次贝塞尔（站位上方 2 → 顶点 mid.y=6+距离×0.25 → 落点）
 * ---------------------------------------------------------- */
function buildCurve(u) {
  const p0 = new THREE.Vector3(u.stand_x, u.stand_y + 2, u.stand_z);
  const p2 = new THREE.Vector3(u.landing_x, u.landing_y, u.landing_z);
  const dist = p0.distanceTo(p2);
  const mid = p0.clone().lerp(p2, 0.5);
  const p1 = new THREE.Vector3(mid.x, 6 + dist * 0.25, mid.z);
  return new THREE.QuadraticBezierCurve3(p0, p1, p2);
}

function hasCoords(u) {
  return u.stand_x != null && u.stand_y != null && u.stand_z != null &&
    u.landing_x != null && u.landing_y != null && u.landing_z != null;
}

/* 选中预览：虚线轨迹 + 站位小圆点 + 落点脉冲圆环 */
function selectUtility(id) {
  selectedId = id;
  disposeGroup(trajPreview);
  const u = utilities.find(x => x.id === id);
  if (u && hasCoords(u) && mapGroup) {
    const def = MARKER_DEFS[u.type] || MARKER_DEFS.smoke;
    const curve = buildCurve(u);

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 64, 0.28, 8, false),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.85, depthTest: false })
    );
    trajPreview.add(tube);

    // 站位小圆点（屏幕定尺寸）
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getDotTexture(), color: def.color, transparent: true,
      depthTest: false, sizeAttenuation: false,
    }));
    dot.scale.set(0.02, 0.02, 1);
    dot.position.set(u.stand_x, u.stand_y, u.stand_z);
    trajPreview.add(dot);

    // 落点脉冲圆环（update 中缩放）
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.5, 3.5, 28),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(u.landing_x, u.landing_y + 0.3, u.landing_z);
    ring.userData.pulse = true;
    trajPreview.add(ring);
  }
  renderUtilityList();
}

export function getUtilityById(id) {
  return utilities.find(u => u.id === id) || null;
}

export function getUtilities() {
  return utilities;
}

/* ------------------------------------------------------------
 * 播放：弹体匀速飞行 + 落地效果
 * ---------------------------------------------------------- */
export function playUtility(u) {
  stopPlaying();
  if (!hasCoords(u)) return;
  const def = MARKER_DEFS[u.type] || MARKER_DEFS.smoke;
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 12),
    new THREE.MeshBasicMaterial({ color: def.color })
  );
  fxGroup.add(ball);
  playing = { u, curve: buildCurve(u), ball, t: 0 };
}

function stopPlaying() {
  if (!playing) return;
  fxGroup.remove(playing.ball);
  disposeObject(playing.ball);
  playing = null;
}

export function spawnLandingEffect(u, pt) {  if (u.type === 'flash') {
    // 闪：白色爆闪球 + 点光，0.5s
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(2, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false })
    );
    ball.position.copy(pt).y += 1;
    const light = new THREE.PointLight(0xffffff, 500, 60);
    light.position.copy(ball.position);
    fxGroup.add(ball, light);
    effects.push({
      t: 0, life: 0.5, objs: [ball, light],
      tick(t, k) {
        ball.scale.setScalar(1 + k * 6);
        ball.material.opacity = 0.95 * (1 - k);
        light.intensity = 500 * (1 - k);
      },
    });
  } else if (u.type === 'molotov') {
    // 火：地面橙色圆盘脉动 + 橙光，3s 淡出
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3, 32),
      new THREE.MeshBasicMaterial({ color: 0xff7043, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(pt).y += 0.15;
    const light = new THREE.PointLight(0xff7043, 300, 40);
    light.position.copy(pt).y += 3;
    fxGroup.add(disc, light);
    effects.push({
      t: 0, life: 3, objs: [disc, light],
      tick(t, k) {
        disc.scale.setScalar(1 + 0.2 * Math.sin(t * 12));
        disc.material.opacity = 0.85 * (1 - k);
        light.intensity = (300 + 100 * Math.sin(t * 20)) * (1 - k);
      },
    });
  } else {
    // 烟：灰色半透明球扩散 ~4.5 倍，停 4s 后淡出
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 20, 20),
      new THREE.MeshLambertMaterial({ color: 0x9aa5ad, transparent: true, opacity: 0.55, depthWrite: false })
    );
    ball.position.copy(pt).y += 2;
    fxGroup.add(ball);
    effects.push({
      t: 0, life: 5, objs: [ball],
      tick(t, k) {
        const grow = Math.min(t / 0.8, 1);
        ball.scale.setScalar(1 + grow * 3.5);
        ball.material.opacity = 0.55 * (k > 0.8 ? (1 - k) / 0.2 : 1);
      },
    });
  }
}

/* 主循环钩子：推进弹体 / 落地效果 / 落点环脉冲 */
export function updateUtility(dt) {
  elapsed += dt;

  const ring = trajPreview.children.find(o => o.userData.pulse);
  if (ring) {
    const s = 1 + 0.15 * Math.sin(elapsed * 4);
    ring.scale.set(s, s, s);
  }

  if (playing) {
    playing.t += dt / FLIGHT_TIME;
    if (playing.t >= 1) {
      const u = playing.u;
      const pt = playing.curve.getPointAt(1);
      stopPlaying();
      spawnLandingEffect(u, pt);
    } else {
      playing.ball.position.copy(playing.curve.getPointAt(playing.t));
    }
  }

  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.t += dt;
    const k = e.t / e.life;
    if (k >= 1) {
      e.objs.forEach(o => { fxGroup.remove(o); disposeObject(o); });
      effects.splice(i, 1);
    } else {
      e.tick(e.t, k);
    }
  }
}

/* ------------------------------------------------------------
 * 录入模式：类型/投掷方式选择 + 分层取点（站位 → 落点）
 * ---------------------------------------------------------- */
function suggestName() {
  const count = utilities.filter(u => (u.type || 'smoke') === recording.type).length;
  document.getElementById('utility-name').value = `${TYPE_NAMES[recording.type]} #${count + 1}`;
}

function enterRecording() {
  if (recording) return;
  // 多人模式：请求锁，等 lock_acquired 回调再继续
  if (isMultiplayer) {
    send({ op: 'lock_request', resource: 'utility_recording' } as any);
    return;
  }
  // 单人模式直接开始
  startRecording();
}

function startRecording() {
  if (recording) return;
  recording = { type: 'smoke', throwType: '站投', step: 'stand', stand: null, landing: null };
  utilHits = [];
  utilHitIdx = 0;
  document.body.classList.add('utility'); // 确保面板可见
  document.getElementById('utility-entry').style.display = 'block';
  document.getElementById('utility-add').style.display = 'none';
  document.getElementById('utility-coords').textContent = '点击地图选站位';
  document.getElementById('utility-layer').textContent = '';
  document.getElementById('utility-height').textContent = '高度微调 0';
  document.querySelectorAll('#utility-types button').forEach(b =>
    b.classList.toggle('active', b.dataset.utype === recording.type));
  document.querySelectorAll('#utility-throws button').forEach(b =>
    b.classList.toggle('active', b.dataset.uthrow === recording.throwType));
  updateStepUI();
  suggestName();
}

export function cancelUtilityRecording() {
  if (!recording) return;
  recording = null;
  utilHits = [];
  disposeGroup(pickPreview);
  document.getElementById('utility-entry').style.display = 'none';
  document.getElementById('utility-add').style.display = '';
  if (isMultiplayer) send({ op: 'lock_release', resource: 'utility_recording' } as any);
}

function updateStepUI() {
  document.getElementById('utility-step-stand').classList.toggle('active', recording.step === 'stand');
  document.getElementById('utility-step-landing').classList.toggle('active', recording.step === 'landing');
}

function currentPoint() {
  return recording ? recording[recording.step] : null;
}

/* 取点黄环预览（当前步骤已选点位） */
function updatePickRing() {
  disposeGroup(pickPreview);
  if (!recording) return;
  const pt = currentPoint();
  if (!pt) return;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.8, 2.6, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe082, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(pt).y += 0.3;
  pickPreview.add(ring);
}

function updateUtilCoords() {
  const pt = currentPoint();
  const label = recording.step === 'stand' ? '站位' : '落点';
  document.getElementById('utility-coords').textContent = pt
    ? `${label}：x=${pt.x.toFixed(1)}  y=${pt.y.toFixed(1)}  z=${pt.z.toFixed(1)}`
    : `点击地图选${label}`;
}

function updateUtilLayerInfo() {
  const el = document.getElementById('utility-layer');
  el.textContent = utilHits.length > 1
    ? `命中 ${utilHits.length} 层 第 ${utilHitIdx + 1}/${utilHits.length} 层（Tab 切换）`
    : (utilHits.length === 1 ? '命中 1 层' : '');
}

/* 选定第 idx 层，写入当前步骤 */
function selectUtilHit(idx) {
  if (!utilHits.length) return;
  utilHitIdx = ((idx % utilHits.length) + utilHits.length) % utilHits.length;
  heightAdjust = 0;
  recording[recording.step] = utilHits[utilHitIdx].point.clone();
  document.getElementById('utility-height').textContent = '高度微调 0';
  updateUtilCoords();
  updateUtilLayerInfo();
  updatePickRing();
}

function adjustUtilHeight(delta) {
  const pt = currentPoint();
  if (!pt) return;
  heightAdjust += delta;
  pt.y += delta;
  document.getElementById('utility-height').textContent =
    `高度微调 ${heightAdjust >= 0 ? '+' : ''}${heightAdjust.toFixed(1)}`;
  updateUtilCoords();
  updatePickRing();
}

/* ------------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
export function initUtility() {
  scene.add(trajPreview, pickPreview, fxGroup);

  // 面板模式注册进状态机：enter 开面板，exit 关面板并清理录入/预览
  registerMode('utility', {
    label: '🧨 道具库',
    toggleOff: true,
    enter: () => { document.body.classList.add('utility'); },
    exit: () => {
      cancelUtilityRecording();
      selectUtility(null);
      document.body.classList.remove('utility');
    },
  });
  document.getElementById('utility-add').addEventListener('click', enterRecording);

  document.querySelectorAll('#utility-types button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!recording) return;
      recording.type = btn.dataset.utype;
      document.querySelectorAll('#utility-types button').forEach(b =>
        b.classList.toggle('active', b === btn));
      suggestName();
    });
  });
  document.querySelectorAll('#utility-throws button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!recording) return;
      recording.throwType = btn.dataset.uthrow;
      document.querySelectorAll('#utility-throws button').forEach(b =>
        b.classList.toggle('active', b === btn));
    });
  });
  document.getElementById('utility-step-stand').addEventListener('click', () => {
    if (!recording) return;
    recording.step = 'stand';
    utilHits = [];
    updateStepUI();
    updateUtilCoords();
    updateUtilLayerInfo();
    updatePickRing();
  });
  document.getElementById('utility-step-landing').addEventListener('click', () => {
    if (!recording) return;
    recording.step = 'landing';
    utilHits = [];
    updateStepUI();
    updateUtilCoords();
    updateUtilLayerInfo();
    updatePickRing();
  });
  document.getElementById('utility-hminus').addEventListener('click', () => adjustUtilHeight(-0.5));
  document.getElementById('utility-hplus').addEventListener('click', () => adjustUtilHeight(0.5));
  document.getElementById('utility-save').addEventListener('click', saveUtility);
  document.getElementById('utility-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveUtility();
    e.stopPropagation();
  });

  /* 地图取点（仅录入中响应；board 在其他工具激活时才监听，天然让路） */
  renderer.domElement.addEventListener('pointerdown', e => {
    if (!recording || e.button !== 0) return;
    const hits = raycastMapAll(e);
    if (!hits.length) return;
    utilHits = hits;
    selectUtilHit(0);
    // 站位点完自动切到落点步骤
    if (recording.step === 'stand') {
      recording.step = 'landing';
      updateStepUI();
    }
  });

  window.addEventListener('keydown', e => {
    if (!recording) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Tab') {
      e.preventDefault();
      if (utilHits.length > 1) selectUtilHit(utilHitIdx + (e.shiftKey ? -1 : 1));
    } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      adjustUtilHeight(0.5);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      adjustUtilHeight(-0.5);
    }
  });

  fetchUtilities();
}
