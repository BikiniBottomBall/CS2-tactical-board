// @ts-nocheck
/* ------------------------------------------------------------
 * 战术编排（P5）：底部步骤轨时间轴。每步摆人（10 个固定演员
 * T1~T5/CT1~CT5 拖拽贴地）+ 配道具（道具库多选）+ 定时；
 * tactics/tactic_steps 整体存取；▶ 自动推演（演员 smoothstep
 * 补间 → 道具依次投出 → 停留 → 下一步）。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, renderer, controls, mapGroup, isMultiplayer } from './state';
import { ACTOR_DEFS, MARKER_DEFS, r1 } from './config';
import { send } from './network';
import { createMarkerSprite, boardRaycaster, setBoardPointer, raycastMapPoint } from './board';
import { playUtility, getUtilityById, getUtilities } from './utility';
import { registerMode, getMode } from './tools';
import { worldToScene } from './coords';

const ACTOR_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'CT1', 'CT2', 'CT3', 'CT4', 'CT5'];
/* 出生点锚点（CS2 Source 世界坐标），经 worldToScene 换算到场景，
 * 与地图模型/demo 回放共用同一坐标变换，模型重导出后自动跟随。
 * 坐标取自 CS2 官方 de_dust2.vpk 实体数据（info_player_* 原点均值，
 * tools/s2v 解包 default_ents.vents，15 个出生点位） */
const T_SPAWN_SRC = { x: -756, y: -791, z: 145 };  // 匪家（实体簇中心）
const CT_SPAWN_SRC = { x: 281, y: 2269, z: -109 }; // 警家（实体簇中心）
const THROW_INTERVAL = 0.8;  // 同一步内道具依次投出间隔（秒）
const HOLD_TIME = 1.5;       // 步间停留（秒）

const _downDir = new THREE.Vector3(0, -1, 0);

let tactics = [];
let currentTacticId = null;
let steps = [];              // 当前战术步骤（本地编辑副本）
let currentStepIdx = -1;
let panelOpen = false;

/* actorPos 用 Proxy 包装：本地拖拽写入 → 100ms 节流发送 actor_move；
 * 远程写入通过 remoteActorMove（_remoteFlag 标记）不触发 sync 回环。
 * 注意：默认出生位不能在模块加载时填充（地图未就绪 worldToScene 无归一化），
 * 一律走 ensureActorDefaults（首次打开面板时）惰性填充。 */
const _rawActorPos: Record<string, {x:number,y:number,z:number}> = {};
const _remoteFlag = new WeakSet<object>();
const _lastActorSync: Record<string, number> = {};

const actorPos = new Proxy(_rawActorPos, {
  set(target, prop, value) {
    if (typeof prop !== 'string' || !ACTOR_IDS.includes(prop)) {
      target[prop as string] = value;
      return true;
    }
    target[prop] = value;
    if (isMultiplayer && !_remoteFlag.has(value)) {
      // 本地拖拽 → 节流发送（100ms）
      const now = Date.now();
      if (!_lastActorSync[prop] || now - _lastActorSync[prop] > 100) {
        _lastActorSync[prop] = now;
        send({
          op: 'actor_move',
          id: prop,
          x: r1(value.x),
          y: r1(value.y),
          z: r1(value.z),
        } as any);
      }
    }
    return true;
  },
});
const actorObjects = new Map();
const actorsGroup = new THREE.Group();
actorsGroup.name = 'tactic-actors';
actorsGroup.visible = false; // 仅战术面板打开或播放时显示

let dragActorId = null;
let playback = null;         // { stepIdx, phase, t, from, utilQueue, utilTimer }
let _remotePlayState: {playing: boolean; stepIdx: number} | null = null;  // 远程被动跟随
let _lastPlayBroadcast = 0;  // 播放状态广播节流

/* 步骤编辑激活（board 指针交互让路判断用） */
export function isTacticEditing() {
  return panelOpen && !playback && currentStepIdx >= 0;
}

/* ---- P9 多人协同：播放锁回调 ---- */
export function onPlayLockAcquired(): void {
  startPlayback();
}

/* 收到 tactic_playback 广播（远程被动跟随） */
export function onRemotePlayback(playing: boolean, stepIdx: number): void {
  if (playing) {
    _remotePlayState = { playing: true, stepIdx };
  } else {
    _remotePlayState = null;
    if (playback) stopPlayback();
  }
}

/* 远程战术切换 */
export function onRemoteTacticChanged(tacticId: number): void {
  if (tacticId && tacticId !== currentTacticId) {
    currentTacticId = tacticId;
    loadCurrentSteps();
    renderTacticSelect();
    renderStepChips();
    renderStepEditor();
    syncAllActors();
  }
}

/* ------------------------------------------------------------
 * 演员
 * ---------------------------------------------------------- */
function defaultActorPos(id) {
  const isT = id[0] === 'T';
  const n = parseInt(id.slice(isT ? 1 : 2), 10) - 1;
  const src = isT ? T_SPAWN_SRC : CT_SPAWN_SRC;
  const base = worldToScene(src.x, src.y, src.z);
  return { x: base.x + (n % 3) * 4 - 4, y: base.y, z: base.z + Math.floor(n / 3) * 4 };
}

/* actorPos 依赖 worldToScene（地图就绪后才可用），故延迟到首次使用时填充 */
function ensureActorDefaults() {
  if (!mapGroup) return;
  ACTOR_IDS.forEach(id => { if (!actorPos[id]) actorPos[id] = defaultActorPos(id); });
}

/* 贴地高度：取与参考高度 refY 最接近的命中层（而非最顶层），
 * 多层结构（隧道/上下层）不会吸到顶板或屋顶 */
function groundY(x, z, refY) {
  if (!mapGroup) return refY;
  boardRaycaster.set(new THREE.Vector3(x, 500, z), _downDir);
  const hits = boardRaycaster.intersectObjects(mapGroup.children, false);
  if (!hits.length) return refY;
  let best = hits[0].point.y;
  for (const h of hits) {
    if (Math.abs(h.point.y - refY) < Math.abs(best - refY)) best = h.point.y;
  }
  return best;
}

/* 远程演员位置同步：标记 _remoteFlag 避免 Proxy 回环，贴地 y */
export function remoteActorMove(id: string, x: number, y: number, z: number): void {
  const snappedY = groundY(x, z, y);
  const pos = { x, y: snappedY, z };
  _remoteFlag.add(pos);
  actorPos[id] = pos;
  syncActor(id);
}

/* ---- 低模人形（tactic 演员与 demo 回放共用）----
 * 组原点在脚底，人形正面朝局部 +z（与 sourceYawToRadians 兼容：yaw=0 面朝东）。
 * 几何体与材质按队伍缓存共享，20 人同屏不重复创建。 */
const _actorGeoCache: Record<string, any> = {};
const _actorMatCache: Record<string, THREE.MeshLambertMaterial> = {};

function getActorGeo() {
  if (!_actorGeoCache.geo) {
    _actorGeoCache.geo = {
      leg:   new THREE.BoxGeometry(0.30, 0.80, 0.30),
      torso: new THREE.BoxGeometry(1.10, 1.10, 0.55),
      arm:   new THREE.BoxGeometry(0.22, 0.90, 0.24),
      head:  new THREE.SphereGeometry(0.40, 16, 12),
    };
  }
  return _actorGeoCache.geo;
}

function getActorMat(isT: boolean): THREE.MeshLambertMaterial {
  const key = isT ? 't' : 'ct';
  if (!_actorMatCache[key]) {
    _actorMatCache[key] = new THREE.MeshLambertMaterial({ color: ACTOR_DEFS[key].color });
  }
  return _actorMatCache[key];
}

export function createActorVisual(label, isT) {
  const key = isT ? 't' : 'ct';
  const def = ACTOR_DEFS[key];
  const geo = getActorGeo();
  const mat = getActorMat(isT);
  const group = new THREE.Group();

  const legL = new THREE.Mesh(geo.leg, mat);
  legL.position.set(-0.18, 0.40, 0);
  const legR = new THREE.Mesh(geo.leg, mat);
  legR.position.set(0.18, 0.40, 0);
  const torso = new THREE.Mesh(geo.torso, mat);
  torso.position.y = 1.35;
  const armL = new THREE.Mesh(geo.arm, mat);
  armL.position.set(-0.66, 1.30, 0);
  const armR = new THREE.Mesh(geo.arm, mat);
  armR.position.set(0.66, 1.30, 0);
  const head = new THREE.Mesh(geo.head, mat);
  head.position.y = 2.30;

  group.add(legL, legR, torso, armL, armR, head);

  const sprite = createMarkerSprite(label, def.css);
  sprite.scale.set(0.13, 0.065, 1);
  sprite.position.y = 3.5;
  group.add(sprite);
  return group;
}

function createActor(id) {
  const group = createActorVisual(id, id[0] === 'T');
  group.userData.actorId = id;
  return group;
}

function syncActor(id) {
  const g = actorObjects.get(id);
  const p = actorPos[id];
  if (!g || !p) return;
  g.position.set(p.x, groundY(p.x, p.z, p.y), p.z);
}

function syncAllActors() {
  ensureActorDefaults();
  ACTOR_IDS.forEach(syncActor);
}

/* ------------------------------------------------------------
 * REST
 * ---------------------------------------------------------- */
async function fetchTactics() {
  try {
    const r = await fetch('/api/tactics?t=' + Date.now());
    if (r.ok) tactics = await r.json();
  } catch (e) {
    console.warn('[tactic] 读取战术失败', e);
  }
  if (currentTacticId && !tactics.some(t => t.id === currentTacticId)) currentTacticId = null;
  if (!currentTacticId && tactics.length) currentTacticId = tactics[0].id;
  loadCurrentSteps();
  renderTacticSelect();
  renderStepChips();
  renderStepEditor();
}

function loadCurrentSteps() {
  const t = tactics.find(x => x.id === currentTacticId);
  steps = t ? (t.steps || []) : [];
  if (currentStepIdx >= steps.length) currentStepIdx = -1;
}

async function saveSteps() {
  if (!currentTacticId) return false;
  const body = {
    steps: steps.map((s, i) => ({
      step_order: i,
      annotation: s.annotation ?? null,
      utility_id: s.utility_id ?? null,
      note: s.note ?? null,
      actors: s.actors ?? [],
      utility_ids: s.utility_ids ?? [],
      duration: s.duration ?? 2,
    })),
  };
  try {
    const r = await fetch(`/api/tactics/${currentTacticId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    const t = await r.json();
    const idx = tactics.findIndex(x => x.id === currentTacticId);
    if (idx >= 0) tactics[idx] = t;
    steps = t.steps || [];
    renderStepChips();
    return true;
  } catch (e) {
    console.warn('[tactic] 保存步骤失败', e);
    document.getElementById('step-save-hint').textContent = '保存失败：' + e.message;
    return false;
  }
}

/* ------------------------------------------------------------
 * 面板渲染
 * ---------------------------------------------------------- */
function renderTacticSelect() {
  const sel = document.getElementById('tactic-select');
  sel.innerHTML = '';
  if (!tactics.length) {
    const opt = document.createElement('option');
    opt.textContent = '（无战术，点 ＋ 新建）';
    sel.appendChild(opt);
    return;
  }
  for (const t of tactics) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    opt.textContent = t.name;
    sel.appendChild(opt);
  }
  sel.value = String(currentTacticId);
}

function renderStepChips() {
  const el = document.getElementById('tactic-steps');
  el.innerHTML = '';
  steps.forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = 'step-chip';
    if (playback && i === playback.stepIdx) chip.classList.add('playing');
    else if (!playback && i === currentStepIdx) chip.classList.add('active');
    chip.textContent = i < 10 ? String.fromCharCode(0x2460 + i) : String(i + 1);
    chip.title = s.note || `步骤 ${i + 1}`;
    chip.addEventListener('click', () => { if (!playback) selectStep(i); });
    el.appendChild(chip);
  });
  if (currentTacticId && !playback) {
    const add = document.createElement('button');
    add.className = 'step-chip';
    add.textContent = '＋';
    add.title = '添加步骤';
    add.addEventListener('click', addStep);
    el.appendChild(add);
  }
}

function renderStepEditor() {
  const ed = document.getElementById('step-editor');
  const step = steps[currentStepIdx];
  if (!step || playback) { ed.style.display = 'none'; return; }
  ed.style.display = 'block';
  document.getElementById('step-duration').value = String(step.duration ?? 2);
  document.getElementById('step-note').value = step.note || '';
  document.getElementById('step-save-hint').textContent = '';
  renderStepUtilities(step);
}

function renderStepUtilities(step) {
  const el = document.getElementById('step-utilities');
  el.innerHTML = '';
  const utils = getUtilities();
  if (!utils.length) {
    el.innerHTML = '<span class="calib-hint" style="margin:0">道具库为空（先在道具库录入）</span>';
    return;
  }
  for (const u of utils) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (step.utility_ids || []).includes(u.id);
    cb.addEventListener('change', () => {
      step.utility_ids = step.utility_ids || [];
      if (cb.checked) step.utility_ids.push(u.id);
      else step.utility_ids = step.utility_ids.filter(x => x !== u.id);
    });
    const def = MARKER_DEFS[u.type] || MARKER_DEFS.smoke;
    const dot = document.createElement('span');
    dot.className = 'tb-dot';
    dot.style.background = def.css;
    label.append(cb, dot, document.createTextNode(`${u.name}${u.throw_type ? '·' + u.throw_type : ''}`));
    el.appendChild(label);
  }
}

/* ------------------------------------------------------------
 * 步骤操作
 * ---------------------------------------------------------- */
function selectTactic(id) {
  currentTacticId = id;
  currentStepIdx = -1;
  loadCurrentSteps();
  renderStepChips();
  renderStepEditor();
  // 多人模式：广播战术选择
  if (isMultiplayer) {
    send({ op: 'tactic_select', tactic_id: id } as any);
  }
}

function selectStep(idx) {
  currentStepIdx = idx;
  const step = steps[idx];
  // 跳到该步演员位置（编辑起点）
  if (step && Array.isArray(step.actors)) {
    step.actors.forEach(a => {
      if (!ACTOR_IDS.includes(a.id)) return;
      actorPos[a.id] = { x: a.x, y: a.y, z: a.z };
      syncActor(a.id);
    });
  }
  renderStepChips();
  renderStepEditor();
}

async function addStep() {
  if (!currentTacticId) return;
  steps.push({
    step_order: steps.length,
    annotation: null,
    utility_id: null,
    note: '',
    actors: ACTOR_IDS.map(id => ({ id, x: r1(actorPos[id].x), y: r1(actorPos[id].y), z: r1(actorPos[id].z) })),
    utility_ids: [],
    duration: 2,
  });
  if (await saveSteps()) selectStep(steps.length - 1);
}

async function saveCurrentStep() {
  const step = steps[currentStepIdx];
  if (!step) return;
  // 演员当前位置写入 step.actors
  step.actors = ACTOR_IDS.map(id => ({ id, x: r1(actorPos[id].x), y: r1(actorPos[id].y), z: r1(actorPos[id].z) }));
  step.duration = parseFloat(document.getElementById('step-duration').value) || 2;
  step.note = document.getElementById('step-note').value;
  if (await saveSteps()) {
    document.getElementById('step-save-hint').textContent = '已保存';
  }
}

/* ------------------------------------------------------------
 * 自动推演
 * ---------------------------------------------------------- */
function startPlayback() {
  if (!steps.length || playback) return;
  currentStepIdx = -1;
  renderStepEditor();
  playback = { stepIdx: -1, phase: 'move', t: 0, from: {}, utilQueue: [], utilTimer: 0 };
  document.getElementById('tactic-play').textContent = '⏸ 停止';
  document.getElementById('panel-tactic').classList.add('playing');
  actorsGroup.visible = true;
  advanceStep();
}

function stopPlayback() {
  // 多人模式：广播停止 + 释放锁
  if (isMultiplayer && playback) {
    send({ op: 'tactic_playback', playing: false, step_idx: 0 } as any);
    send({ op: 'lock_release', resource: 'tactic_playback' } as any);
  }
  playback = null;
  dragActorId = null;
  controls.enabled = true;
  document.getElementById('tactic-play').textContent = '▶ 播放';
  document.getElementById('panel-tactic').classList.remove('playing');
  actorsGroup.visible = panelOpen;
  renderStepChips();
  renderStepEditor();
}

function advanceStep() {
  playback.stepIdx++;
  if (playback.stepIdx >= steps.length) { stopPlayback(); return; }
  const step = steps[playback.stepIdx];
  playback.phase = 'move';
  playback.t = 0;
  playback.from = {};
  (step.actors || []).forEach(a => {
    if (actorPos[a.id]) playback.from[a.id] = { ...actorPos[a.id] };
  });
  playback.utilQueue = (step.utility_ids || []).map(id => getUtilityById(id)).filter(Boolean);
  playback.utilTimer = THROW_INTERVAL; // 到位后立即投第一个
  renderStepChips();
}

export function updateTactic(dt) {
  // 远程被动跟随（不跑自己的推演逻辑）
  if (_remotePlayState) {
    const step = steps[_remotePlayState.stepIdx];
    if (step && Array.isArray(step.actors)) {
      step.actors.forEach(a => {
        if (!ACTOR_IDS.includes(a.id)) return;
        actorPos[a.id] = { x: a.x, y: a.y, z: a.z };
        syncActor(a.id);
      });
    }
    renderStepChips();
    return;
  }

  if (!playback) return;
  const step = steps[playback.stepIdx];
  if (!step) { stopPlayback(); return; }

  // 500ms 广播播放状态
  const now = Date.now();
  if (isMultiplayer && now - _lastPlayBroadcast > 500) {
    _lastPlayBroadcast = now;
    send({
      op: 'tactic_playback',
      playing: true,
      step_idx: playback.stepIdx,
    } as any);
  }

  if (playback.phase === 'move') {
    const dur = Math.max(step.duration || 2, 0.1);
    playback.t += dt;
    const k0 = Math.min(playback.t / dur, 1);
    const k = k0 * k0 * (3 - 2 * k0); // smoothstep
    (step.actors || []).forEach(a => {
      const f = playback.from[a.id];
      if (!f) return;
      actorPos[a.id] = {
        x: f.x + (a.x - f.x) * k,
        y: f.y + (a.y - f.y) * k,
        z: f.z + (a.z - f.z) * k,
      };
      syncActor(a.id);
    });
    if (k0 >= 1) playback.phase = 'utils';
  } else if (playback.phase === 'utils') {
    playback.utilTimer += dt;
    if (playback.utilQueue.length) {
      if (playback.utilTimer >= THROW_INTERVAL) {
        playUtility(playback.utilQueue.shift());
        playback.utilTimer = 0;
      }
    } else {
      playback.phase = 'hold';
      playback.t = 0;
    }
  } else if (playback.phase === 'hold') {
    playback.t += dt;
    if (playback.t >= HOLD_TIME) advanceStep();
  }
}

/* ------------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
export function initTactic() {
  ACTOR_IDS.forEach(id => {
    // actorPos 不在此处初始化：worldToScene 依赖地图就绪，
    // 首次 syncAllActors（打开面板）时由 ensureActorDefaults 填充
    const obj = createActor(id);
    actorObjects.set(id, obj);
    actorsGroup.add(obj);
  });
  scene.add(actorsGroup);

  registerMode('tactic', {
    label: '🎬 战术',
    toggleOff: true,
    enter: () => {
      panelOpen = true;
      document.body.classList.add('tactic');
      actorsGroup.visible = true;
      syncAllActors();
      fetchTactics();
    },
    exit: () => {
      if (playback) stopPlayback();
      panelOpen = false;
      currentStepIdx = -1;
      document.body.classList.remove('tactic');
      actorsGroup.visible = false;
      renderStepChips();
      renderStepEditor();
    },
  });
  document.getElementById('tactic-select').addEventListener('change', e => {
    selectTactic(parseInt(e.target.value, 10) || null);
  });
  document.getElementById('tactic-new').addEventListener('click', async () => {
    const name = prompt('战术名称', '新战术');
    if (!name) return;
    try {
      const r = await fetch('/api/tactics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(await r.text());
      const t = await r.json();
      await fetchTactics();
      selectTactic(t.id);
      renderTacticSelect();
    } catch (e) {
      console.warn('[tactic] 新建失败', e);
    }
  });
  document.getElementById('tactic-rename').addEventListener('click', async () => {
    const t = tactics.find(x => x.id === currentTacticId);
    if (!t) return;
    const name = prompt('战术名称', t.name);
    if (!name || name === t.name) return;
    try {
      await fetch(`/api/tactics/${t.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      await fetchTactics();
    } catch (e) {
      console.warn('[tactic] 改名失败', e);
    }
  });
  document.getElementById('tactic-delete').addEventListener('click', async () => {
    const t = tactics.find(x => x.id === currentTacticId);
    if (!t || !confirm(`删除战术「${t.name}」及其全部步骤？`)) return;
    try {
      await fetch(`/api/tactics/${t.id}`, { method: 'DELETE' });
      currentTacticId = null;
      steps = [];
      currentStepIdx = -1;
      await fetchTactics();
    } catch (e) {
      console.warn('[tactic] 删除失败', e);
    }
  });

  /* P6 战术包：导出（下载自包含 JSON）/ 导入 */
  document.getElementById('tactic-export').addEventListener('click', async () => {
    const t = tactics.find(x => x.id === currentTacticId);
    if (!t) return;
    try {
      const r = await fetch(`/api/tactics/${t.id}/pack`);
      if (!r.ok) throw new Error(await r.text());
      const pack = await r.json();
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `战术包-${t.name}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.warn('[tactic] 导出失败', e);
      alert('导出失败：' + e.message);
    }
  });
  document.getElementById('tactic-import').addEventListener('click', () => {
    document.getElementById('tactic-import-file').click();
  });
  // 分享按钮（P8）
  document.getElementById('tactic-share').addEventListener('click', async () => {
    const tid = currentTacticId;
    if (!tid) return;
    try {
      const packRes = await fetch(`/api/tactics/${tid}/pack`);
      if (!packRes.ok) throw new Error(`HTTP ${packRes.status}`);
      const pack = await packRes.json();
      const shareRes = await fetch('/api/share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tactic_data: pack }),
      });
      if (!shareRes.ok) throw new Error(`HTTP ${shareRes.status}`);
      const shareData = await shareRes.json();
      const url = `${location.origin}/view/${shareData.share_id}`;
      showToast(url);
    } catch (err: any) {
      alert('分享失败：' + (err.message || err));
    }
  });
  document.getElementById('tactic-import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const pack = JSON.parse(reader.result);
        const r = await fetch('/api/tactics/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pack),
        });
        if (!r.ok) throw new Error(await r.text());
        const t = await r.json();
        await fetchTactics();
        selectTactic(t.id);
        alert(`已导入战术「${t.name}」（${t.steps.length} 步）`);
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
  });
  document.getElementById('tactic-play').addEventListener('click', () => {
    if (playback) { stopPlayback(); return; }
    // 多人模式：先请求播放锁
    if (isMultiplayer) {
      send({ op: 'lock_request', resource: 'tactic_playback' } as any);
      return; // 等待 lock_acquired 回调 → onPlayLockAcquired
    }
    startPlayback();
  });
  document.getElementById('step-save').addEventListener('click', saveCurrentStep);
  document.getElementById('step-note').addEventListener('keydown', e => e.stopPropagation());
  document.getElementById('step-duration').addEventListener('keydown', e => e.stopPropagation());

  /* 演员拖拽摆位（仅战术面板模式激活时响应，互斥由状态机保证） */
  renderer.domElement.addEventListener('pointerdown', e => {
    if (getMode() !== 'tactic' || !isTacticEditing() || e.button !== 0) return;
    setBoardPointer(e);
    const hits = boardRaycaster.intersectObjects(actorsGroup.children, true);
    if (!hits.length) return;
    let obj = hits[0].object;
    while (obj && obj.userData.actorId === undefined) obj = obj.parent;
    if (!obj) return;
    dragActorId = obj.userData.actorId;
    controls.enabled = false;
  });
  window.addEventListener('pointermove', e => {
    if (dragActorId === null) return;
    const pt = raycastMapPoint(e);
    if (!pt) return;
    actorPos[dragActorId] = { x: pt.x, y: pt.y, z: pt.z };
    syncActor(dragActorId);
  });
  window.addEventListener('pointerup', () => {
    if (dragActorId !== null) {
      dragActorId = null;
      controls.enabled = true;
    }
  });

  fetchTactics();
}

let toastTimer = 0;
function showToast(url: string) {
  const toast = document.getElementById('toast');
  const link = document.getElementById('toast-link');
  const copyBtn = document.getElementById('toast-copy');
  if (!toast || !link || !copyBtn) return;
  link.textContent = url;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 5000);
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
    }).catch(() => { copyBtn.textContent = '失败'; });
  };
}
