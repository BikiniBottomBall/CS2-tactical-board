// @ts-nocheck
/* ------------------------------------------------------------
 * 战术编排（P5）：底部步骤轨时间轴。每步摆人（10 个固定演员
 * T1~T5/CT1~CT5 拖拽贴地）+ 配道具（道具库多选）+ 定时；
 * tactics/tactic_steps 整体存取；▶ 自动推演（演员 smoothstep
 * 补间 → 道具依次投出 → 停留 → 下一步）。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, renderer, controls, mapGroup } from './state';
import { MARKER_DEFS, r1 } from './config';
import { createMarkerSprite, boardRaycaster, setBoardPointer, raycastMapPoint } from './board';
import { playUtility, getUtilityById, getUtilities, isUtilityRecording } from './utility';
import { calibMode } from './calib';

const ACTOR_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'CT1', 'CT2', 'CT3', 'CT4', 'CT5'];
const T_SPAWN = { x: -56, y: 5, z: 48 };    // 匪家默认区
const CT_SPAWN = { x: -25, y: 20, z: -50 }; // 警家默认区
const THROW_INTERVAL = 0.8;  // 同一步内道具依次投出间隔（秒）
const HOLD_TIME = 1.5;       // 步间停留（秒）

const _downDir = new THREE.Vector3(0, -1, 0);

let tactics = [];
let currentTacticId = null;
let steps = [];              // 当前战术步骤（本地编辑副本）
let currentStepIdx = -1;
let panelOpen = false;

const actorPos = {};         // id -> {x,y,z} 当前世界位置
const actorObjects = new Map();
const actorsGroup = new THREE.Group();
actorsGroup.name = 'tactic-actors';
actorsGroup.visible = false; // 仅战术面板打开或播放时显示

let dragActorId = null;
let playback = null;         // { stepIdx, phase, t, from, utilQueue, utilTimer }

/* 步骤编辑激活（board 指针交互让路判断用） */
export function isTacticEditing() {
  return panelOpen && !playback && currentStepIdx >= 0;
}

/* ------------------------------------------------------------
 * 演员
 * ---------------------------------------------------------- */
function defaultActorPos(id) {
  const isT = id[0] === 'T';
  const n = parseInt(id.slice(isT ? 1 : 2), 10) - 1;
  const base = isT ? T_SPAWN : CT_SPAWN;
  return { x: base.x + (n % 3) * 4 - 4, y: base.y, z: base.z + Math.floor(n / 3) * 4 };
}

function groundY(x, z, fallback) {
  if (!mapGroup) return fallback;
  boardRaycaster.set(new THREE.Vector3(x, 500, z), _downDir);
  const hits = boardRaycaster.intersectObjects(mapGroup.children, false);
  return hits.length ? hits[0].point.y : fallback;
}

/* 演员视觉（小圆柱底座 + 标签精灵），tactic 演员与 demo 回放共用 */
export function createActorVisual(label, isT) {
  const def = isT ? MARKER_DEFS['marker-t'] : MARKER_DEFS['marker-ct'];
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 0.5, 24),
    new THREE.MeshLambertMaterial({ color: def.color })
  );
  base.position.y = 0.25;
  group.add(base);
  const sprite = createMarkerSprite(label, def.css);
  sprite.scale.set(0.13, 0.065, 1);
  sprite.position.y = 3.4;
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
  if (!playback) return;
  const step = steps[playback.stepIdx];
  if (!step) { stopPlayback(); return; }

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
    actorPos[id] = defaultActorPos(id);
    const obj = createActor(id);
    actorObjects.set(id, obj);
    actorsGroup.add(obj);
  });
  scene.add(actorsGroup);

  document.getElementById('btn-tactic').addEventListener('click', () => {
    panelOpen = !panelOpen;
    document.body.classList.toggle('tactic', panelOpen);
    if (panelOpen) {
      actorsGroup.visible = true;
      syncAllActors();
      fetchTactics();
    } else {
      if (playback) stopPlayback();
      currentStepIdx = -1;
      actorsGroup.visible = false;
      renderStepChips();
      renderStepEditor();
    }
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
  document.getElementById('tactic-play').addEventListener('click', () => {
    if (playback) stopPlayback();
    else startPlayback();
  });
  document.getElementById('step-save').addEventListener('click', saveCurrentStep);
  document.getElementById('step-note').addEventListener('keydown', e => e.stopPropagation());
  document.getElementById('step-duration').addEventListener('keydown', e => e.stopPropagation());

  /* 演员拖拽摆位（board 在编辑态已让路） */
  renderer.domElement.addEventListener('pointerdown', e => {
    if (!isTacticEditing() || calibMode || isUtilityRecording() || e.button !== 0) return;
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
