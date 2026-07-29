// @ts-nocheck
/* ------------------------------------------------------------
 * 战术板：T/CT 标记、画笔箭头路线、烟闪火道具
 * 橡皮擦 / 撤销 / 清空 / localStorage 持久化
 * 所有放置与拖拽均 raycast 地图表面取高度，贴地不悬空
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, camera, renderer, controls, mapGroup } from './state';
import { STORAGE_KEY_BOARD, MARKER_DEFS, LINE_COLOR } from './config';
import {
  calibMode, altHeld, spaceHeld, editingRegion, calibDrawMode, calibHits,
  regionDrawing, setCalibHits, selectCalibHit, addRegionVertex,
  onEditPointerDown, onEditPointerMove, onEditPointerUp,
  raycastMapAll, updateRegionPreview, renderPositionLabels,
} from './calib';
import { isUtilityRecording } from './utility';
import { isTacticEditing } from './tactic';

let currentTool = 'select';
const markersGroup = new THREE.Group();
const linesGroup = new THREE.Group();
const boardItems = new Map(); // id -> { type:'marker'|'line', group, kind?, points? }
let boardSeq = 1;
const undoStack = [];         // 添加顺序的 id 栈

let dragMarkerId = null;
let drawing = null;           // { id, points: Vector3[], line }
let pointerMoved = false;

const boardRaycaster = new THREE.Raycaster();
const boardPointer = new THREE.Vector2();

export { boardRaycaster };

export function initBoard() {
  markersGroup.name = 'markers';
  linesGroup.name = 'lines';
  scene.add(markersGroup, linesGroup);

  // 工具栏
  document.querySelectorAll('#toolbar button[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.getElementById('btn-undo').addEventListener('click', undoBoard);
  document.getElementById('btn-clear').addEventListener('click', clearBoard);
  document.getElementById('btn-tb-topview').addEventListener('click', () => {
    document.getElementById('btn-topview').click();
  });
  window.addEventListener('keydown', e => {
    // 校准模式下 Ctrl+Z 归校准系统（撤销顶点），不触发画板撤销
    if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !calibMode && !isUtilityRecording() && !isTacticEditing()) undoBoard();
  });

  // 全局标记大小滑杆
  const scaleSlider = document.getElementById('marker-scale');
  scaleSlider.value = String(markerScale);
  scaleSlider.addEventListener('input', () => setMarkerScale(parseFloat(scaleSlider.value)));

  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', onBoardPointerDown);
  window.addEventListener('pointermove', onBoardPointerMove);
  window.addEventListener('pointerup', onBoardPointerUp);
  dom.addEventListener('contextmenu', onBoardRightClick);
}

function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll('#toolbar button[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
}

export function setBoardPointer(e) {
  boardPointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  boardPointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  boardRaycaster.setFromCamera(boardPointer, camera);
}

/* 射线求与地图表面的交点（贴地关键） */
export function raycastMapPoint(e) {
  if (!mapGroup) return null;
  setBoardPointer(e);
  const hits = boardRaycaster.intersectObjects(mapGroup.children, false);
  return hits.length ? hits[0].point.clone() : null;
}

/* 拾取已放置的标记/线条（沿父链找 itemId） */
function pickBoardItem(e) {
  setBoardPointer(e);
  const hits = boardRaycaster.intersectObjects(
    [...markersGroup.children, ...linesGroup.children], true);
  if (!hits.length) return null;
  let obj = hits[0].object;
  while (obj && obj.userData.itemId === undefined) obj = obj.parent;
  return obj ? obj.userData.itemId : null;
}

/* ---- 标记创建 ---- */
export function createMarkerSprite(text, cssColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const fontSize = text.length <= 2 ? 56 : text.length <= 4 ? 40 : 28;
  ctx.font = `bold ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 半透明深色底 + 描边，保证任何地图底色上可读
  const tw = Math.min(ctx.measureText(text).width + 36, 246);
  const th = fontSize + 26;
  ctx.fillStyle = 'rgba(10, 14, 20, 0.62)';
  ctx.beginPath();
  ctx.roundRect((256 - tw) / 2, (128 - th) / 2, tw, th, 12);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 128, 64);
  ctx.fillStyle = cssColor;
  ctx.fillText(text, 128, 64);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false,
    sizeAttenuation: false, // 屏幕尺寸恒定，不随地图缩放变化
  }));
  return sprite;
}

/* 实心小圆点纹理（点标记用） */
let _dotTexture = null;
export function getDotTexture() {
  if (_dotTexture) return _dotTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.stroke();
  _dotTexture = new THREE.CanvasTexture(canvas);
  return _dotTexture;
}

/* 全局标记缩放（滑杆调节，localStorage 持久化） */
export let markerScale = parseFloat(localStorage.getItem('cs2-marker-scale') || '1');

function setMarkerScale(v) {
  markerScale = v;
  localStorage.setItem('cs2-marker-scale', String(v));
  renderPositionLabels();
}

function createMarker(toolKey, pos) {
  const def = MARKER_DEFS[toolKey];
  const group = new THREE.Group();

  const r = def.big ? 2.4 : 1.7;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, 0.5, 24),
    new THREE.MeshLambertMaterial({ color: def.color })
  );
  base.position.y = 0.25;
  group.add(base);

  const sprite = createMarkerSprite(def.label, def.css);
  sprite.scale.set(def.big ? 0.16 : 0.13, def.big ? 0.08 : 0.065, 1);
  sprite.position.y = def.big ? 4.2 : 3.4;
  group.add(sprite);

  group.position.copy(pos);
  const id = boardSeq++;
  group.userData.itemId = id;
  markersGroup.add(group);
  boardItems.set(id, { type: 'marker', group, kind: toolKey });
  return id;
}

/* ---- 线条创建（贴地点序列 + 末端箭头） ---- */
function createLineObject(points) {
  const group = new THREE.Group();
  const lifted = points.map(p => new THREE.Vector3(p.x, p.y + 0.4, p.z));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(lifted),
    new THREE.LineBasicMaterial({ color: LINE_COLOR })
  );
  group.add(line);

  // 末端箭头锥
  if (points.length >= 2) {
    const end = lifted[lifted.length - 1];
    const prev = lifted[lifted.length - 2];
    const dir = end.clone().sub(prev);
    dir.y = 0;
    if (dir.lengthSq() > 0.001) {
      dir.normalize();
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(1.3, 3, 12),
        new THREE.MeshLambertMaterial({ color: LINE_COLOR })
      );
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      cone.position.copy(end).addScaledVector(dir, -1.5);
      cone.position.y = end.y + 0.2;
      group.add(cone);
    }
  }
  return group;
}

/* ---- 增删 / 撤销 / 清空 ---- */
function removeBoardItem(id) {
  const item = boardItems.get(id);
  if (!item) return;
  const parent = item.type === 'marker' ? markersGroup : linesGroup;
  parent.remove(item.group);
  item.group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
  boardItems.delete(id);
  const i = undoStack.indexOf(id);
  if (i >= 0) undoStack.splice(i, 1);
}

function undoBoard() {
  const id = undoStack.pop();
  if (id !== undefined) {
    removeBoardItem(id);
    saveBoard();
  }
}

function clearBoard() {
  [...boardItems.keys()].forEach(removeBoardItem);
  undoStack.length = 0;
  saveBoard();
}

/* ---- localStorage 持久化 ---- */
function saveBoard() {
  const markers = [], lines = [];
  boardItems.forEach(item => {
    if (item.type === 'marker') {
      const p = item.group.position;
      markers.push({ kind: item.kind, x: p.x, y: p.y, z: p.z });
    } else {
      lines.push({ points: item.points.map(p => [p.x, p.y, p.z]) });
    }
  });
  localStorage.setItem(STORAGE_KEY_BOARD, JSON.stringify({ markers, lines }));
}

export function restoreBoard() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BOARD);
    if (!raw) return;
    const data = JSON.parse(raw);
    (data.markers || []).forEach(m => {
      if (!MARKER_DEFS[m.kind]) return;
      const id = createMarker(m.kind, new THREE.Vector3(m.x, m.y, m.z));
      undoStack.push(id);
    });
    (data.lines || []).forEach(l => {
      if (!Array.isArray(l.points) || l.points.length < 2) return;
      const points = l.points.map(a => new THREE.Vector3(a[0], a[1], a[2]));
      const group = createLineObject(points);
      const id = boardSeq++;
      group.userData.itemId = id;
      linesGroup.add(group);
      boardItems.set(id, { type: 'line', group, points });
      undoStack.push(id);
    });
  } catch (err) {
    console.warn('[board] 恢复存档失败', err);
  }
}

/* ---- 指针交互 ---- */
function onBoardPointerDown(e) {
  if (isUtilityRecording() || isTacticEditing()) return; // 道具录入/战术编辑：左键归对应系统
  if (e.button !== 0 || !mapGroup) return;
  pointerMoved = false;

  // 校准模式：点模式分层取点 / 区域模式放顶点 / 编辑模式拖顶点
  // 按住 Alt（旋转）或空格（平移）时左键归镜头，不标点
  if (calibMode) {
    if (altHeld || spaceHeld) return;
    if (editingRegion) { onEditPointerDown(e); return; }
    if (calibDrawMode === 'region') {
      const hits = raycastMapAll(e);
      if (hits.length) addRegionVertex(hits[0].point);
    } else {
      setCalibHits(raycastMapAll(e));
      if (calibHits.length) selectCalibHit(0);
    }
    return;
  }

  if (currentTool === 'select') {
    const id = pickBoardItem(e);
    if (id !== null && boardItems.get(id)?.type === 'marker') {
      dragMarkerId = id;
      controls.enabled = false;
    }
  } else if (currentTool === 'brush') {
    const pt = raycastMapPoint(e);
    if (pt) {
      drawing = { points: [pt], line: null };
      controls.enabled = false;
    }
  } else if (MARKER_DEFS[currentTool]) {
    const pt = raycastMapPoint(e);
    if (pt) {
      const id = createMarker(currentTool, pt);
      undoStack.push(id);
      saveBoard();
      dragMarkerId = id; // 放置后可不松手直接拖
      controls.enabled = false;
    }
  } else if (currentTool === 'eraser') {
    const id = pickBoardItem(e);
    if (id !== null) {
      removeBoardItem(id);
      saveBoard();
    }
  }
}

function onBoardPointerMove(e) {
  // 校准模式：区域编辑拖拽 / 圈地橡皮筋预览
  if (calibMode && mapGroup) {
    if (editingRegion && (editingRegion.dragIdx >= 0 || editingRegion.dragWhole)) {
      onEditPointerMove(e);
      return;
    }
    if (calibDrawMode === 'region' && regionDrawing) {
      const pt = raycastMapPoint(e);
      if (pt) updateRegionPreview(pt);
    }
    return;
  }
  if (dragMarkerId === null && !drawing) return;
  pointerMoved = true;
  const pt = raycastMapPoint(e);
  if (!pt) return;

  if (dragMarkerId !== null) {
    const item = boardItems.get(dragMarkerId);
    if (item) item.group.position.copy(pt);
  } else if (drawing) {
    const last = drawing.points[drawing.points.length - 1];
    if (last.distanceTo(pt) > 1.2) {
      drawing.points.push(pt);
      // 实时预览
      if (drawing.line) {
        linesGroup.remove(drawing.line);
        drawing.line.geometry.dispose();
        drawing.line.material.dispose();
      }
      const lifted = drawing.points.map(p => new THREE.Vector3(p.x, p.y + 0.4, p.z));
      drawing.line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(lifted),
        new THREE.LineBasicMaterial({ color: LINE_COLOR })
      );
      linesGroup.add(drawing.line);
    }
  }
}

function onBoardPointerUp() {
  if (calibMode && editingRegion && (editingRegion.dragIdx >= 0 || editingRegion.dragWhole)) {
    onEditPointerUp();
    return;
  }
  if (dragMarkerId !== null) {
    dragMarkerId = null;
    controls.enabled = true;
    saveBoard();
  }
  if (drawing) {
    controls.enabled = true;
    if (drawing.line) {
      linesGroup.remove(drawing.line);
      drawing.line.geometry.dispose();
      drawing.line.material.dispose();
    }
    if (drawing.points.length >= 2) {
      const group = createLineObject(drawing.points);
      const id = boardSeq++;
      group.userData.itemId = id;
      linesGroup.add(group);
      boardItems.set(id, { type: 'line', group, points: drawing.points });
      undoStack.push(id);
      saveBoard();
    }
    drawing = null;
  }
}

/* 右键：校准模式下不占用（撤销顶点用 Ctrl+Z）；浏览模式删除标记/线条 */
function onBoardRightClick(e) {
  e.preventDefault();
  if (!mapGroup || calibMode || isUtilityRecording() || isTacticEditing()) return;
  const id = pickBoardItem(e);
  if (id !== null) {
    removeBoardItem(id);
    saveBoard();
  }
}
