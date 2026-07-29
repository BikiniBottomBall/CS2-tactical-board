// @ts-nocheck
/* ------------------------------------------------------------
 * 点位/区域标注系统：全部标注从 positions.json 读取渲染
 * 校准模式：分层取点（Tab 切层 / +/- 调高度）+ 多边形圈地
 * 表面贴合投影选区：three-mesh-bvh + delaunator 贴地
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import Delaunator from 'delaunator';
import { scene, controls, mapGroup, collisionMesh } from './state';
import {
  POINT_COLORS, r1,
  GROUND_NORMAL_MIN, FLOOR_WINDOW, EDGE_DY_MAX, REGION_GRID_STEP,
  MOUSE_BROWSE, MOUSE_CALIB,
} from './config';
import {
  boardRaycaster, setBoardPointer, raycastMapPoint,
  createMarkerSprite, getDotTexture, markerScale,
} from './board';
import { setTopView } from './camera';
import { cancelUtilityRecording } from './utility';

let positions = {};          // { "名称": 归一化标注对象 }
export let calibMode = false;
export let calibDrawMode = 'point'; // 'point' | 'region'
export let calibHits = [];          // 点击命中的所有层级
let calibHitIdx = 0;
let heightAdjust = 0;
let pendingPoint = null;     // 点模式：最终取定的点
let pendingRegion = null;    // 区域模式：已闭合待保存 { points, height }
export let regionDrawing = null;    // 区域模式：绘制中 { points: Vector3[] }
export let editingRegion = null;    // 区域编辑中：{ name, dragIdx, dragWhole, startPt, origPoints }
const editHandles = new THREE.Group();
editHandles.name = 'region-edit-handles';
const labelGroup = new THREE.Group();
labelGroup.name = 'position-labels';
const calibPreview = new THREE.Group();
calibPreview.name = 'calib-preview';

/* board.ts 需要写入 calibHits（点击命中层级），提供 setter */
export function setCalibHits(hits) { calibHits = hits; }

/* 标注归一化（兼容旧格式；默认值：点标记橙色 / 区域标记半透蓝） */
function normalizeAnnotation(name, raw) {
  const type = raw.type || 'point';
  const ann = {
    type, parent: null, fontSize: null,
    color: POINT_COLORS[name] || (type === 'region' ? '#5aa9ff' : '#ffa940'),
    labelColor: '#ffffff', outlineColor: null, opacity: null,
    ...raw,
  };
  if (ann.fontSize === null) ann.fontSize = type === 'region' ? (ann.parent ? 10 : 14) : (ann.parent ? 7 : 9);
  if (ann.opacity === null) ann.opacity = type === 'region' ? 0.3 : 0.9;
  if (ann.outlineColor === null) ann.outlineColor = ann.color;
  return ann;
}

export async function loadPositions() {
  try {
    const r = await fetch('/api/annotations?t=' + Date.now());
    if (r.ok) {
      const raw = await r.json();
      positions = {};
      for (const [name, ann] of Object.entries(raw)) {
        positions[name] = normalizeAnnotation(name, ann);
      }
    }
  } catch (e) {
    console.warn('[positions] 读取标注失败', e);
  }
}

async function persistPositions() {
  try {
    await fetch('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(positions),
    });
  } catch (e) {
    console.warn('[positions] 保存失败（需要 server.py 提供数据接口）', e);
  }
}

/* ---- JSON 备份：导出 / 导入 ---- */
function exportBackup() {
  window.open('/api/export', '_blank');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const resp = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!resp.ok) throw new Error(await resp.text());
      await loadPositions();
      renderPositionLabels();
      alert('导入成功');
    } catch (e) {
      alert('导入失败：' + e.message);
    }
  };
  reader.readAsText(file);
}

/* 取某点的地面高度（标注贴地） */
function groundYAt(x, z, fallback) {
  boardRaycaster.set(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
  const hits = boardRaycaster.intersectObjects(mapGroup.children, false);
  return hits.length ? hits[0].point.y : fallback;
}

/* 射线返回所有命中层级（分层取点核心） */
export function raycastMapAll(e) {
  if (!mapGroup) return [];
  setBoardPointer(e);
  return boardRaycaster.intersectObjects(mapGroup.children, false);
}

function clearLabelGroup(group) {
  while (group.children.length) {
    const c = group.children.pop();
    c.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }
}

/* ---- 渲染：点=实心小圆点+侧置标签；区域=半透明多边形+描边+标签 ---- */
export function renderPositionLabels() {
  clearLabelGroup(labelGroup);
  if (!mapGroup) return;
  const pointEntries = Object.entries(positions).filter(([, a]) => a.type !== 'region');
  const stacks = computeLabelStacks(pointEntries);
  for (const [name, ann] of Object.entries(positions)) {
    if (ann.type === 'region') renderRegionLabel(name, ann);
    else renderPointLabel(name, ann, stacks.get(name) || 0);
  }
  refreshCalibList();
  refreshParentOptions();
}

function renderPointLabel(name, ann, stackIdx = 0) {
  const y = groundYAt(ann.x, ann.z, ann.y || 0);

  // 实心小圆点（屏幕定尺寸，精确落在标点位置）
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getDotTexture(), color: ann.color, transparent: true,
    depthTest: false, sizeAttenuation: false,
  }));
  dot.scale.set(0.018 * markerScale, 0.018 * markerScale, 1);
  dot.position.set(ann.x, y, ann.z);
  labelGroup.add(dot);

  // 名称标签显示在圆点旁边；靠近的标记按序号自动向下错开
  const sprite = createMarkerSprite(name, ann.labelColor);
  const h = 0.0045 * ann.fontSize * markerScale;
  sprite.scale.set(h * 2, h, 1);
  sprite.center.set(-0.15, 0.5 + stackIdx * 1.15); // 锚在圆点右侧，逐层下移
  sprite.position.set(ann.x, y, ann.z);
  labelGroup.add(sprite);
}

/* 相近点标记的标签自动错开：按世界距离分组，组内依次编号 */
function computeLabelStacks(pointEntries) {
  const stacks = new Map(); // name -> 序号
  const THRESH = 12;
  const groups = [];
  for (const [name, ann] of pointEntries) {
    let g = groups.find(gr => gr.some(([, a]) =>
      Math.hypot(a.x - ann.x, a.z - ann.z) < THRESH));
    if (!g) { g = []; groups.push(g); }
    g.push([name, ann]);
  }
  for (const g of groups) {
    g.sort((a, b) => a[1].z - b[1].z || a[1].x - b[1].x);
    g.forEach(([name], i) => stacks.set(name, i));
  }
  return stacks;
}

/* ------------------------------------------------------------
 * 表面贴合投影选区：
 * 圈选只存 2D 多边形顶点；XZ 平面栅格采样 + Delaunay 剖分，
 * 每个采样点用 three-mesh-bvh 向下 raycast 地面碰撞层，
 * 命中点沿法线偏移 2cm 生成贴地 BufferGeometry。
 * 陡面(normal.y<0.55)剔除；相邻点高差超阈值断开；支持 floorY 分层。
 * ---------------------------------------------------------- */
const _groundRay = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, -1, 0);

function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/* 在 (x,z) 处向下 raycast 地面碰撞层，按 floorY 选层，沿法线偏移 2cm */
function sampleGroundPoint(x, z, floorY) {
  if (!collisionMesh) return null;
  _groundRay.set(new THREE.Vector3(x, 500, z), _downDir);
  const hits = _groundRay.intersectObject(collisionMesh, false);
  if (!hits.length) return null;
  let hit = hits[0];
  if (floorY !== undefined && floorY !== null) {
    hit = hits.find(h => Math.abs(h.point.y - floorY) <= FLOOR_WINDOW) || null;
    if (!hit) return null; // 该处不存在此楼层 → 不生成
  }
  if (hit.face && hit.face.normal.y < GROUND_NORMAL_MIN) return null;
  const n = hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(x + n.x * 0.02, hit.point.y + n.y * 0.02, z + n.z * 0.02);
}

/* 栅格化 + 三角剖分 + 贴地采样，高差过大自动加密或断开 */
function buildRegionGeometry(ann) {
  const pts2 = ann.points.map(p => [p[0], p[1]]);
  if (pts2.length < 3) return null;
  const floorY = ann.floorY !== undefined ? ann.floorY : null;

  let step = ann.gridStep || REGION_GRID_STEP;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = triangulateRegion(pts2, floorY, step);
    if (!result) return null;
    // 断开比例过高且还能加密 → 步长减半重试
    if (result.dropRatio > 0.3 && step > 1) { step /= 2; continue; }
    return result;
  }
  return null;
}

function triangulateRegion(pts2, floorY, step) {
  // 候选点 = 边界点 + 内部栅格点
  const candidates = [...pts2];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts2.forEach(([x, z]) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  });
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let z = minZ + step / 2; z < maxZ; z += step) {
      if (pointInPolygon(x, z, pts2)) candidates.push([x, z]);
    }
  }

  // 逐点 raycast 贴地（剔除陡面与不属于本楼层的点）
  const verts = [], keys = [];
  for (const [x, z] of candidates) {
    const v = sampleGroundPoint(x, z, floorY);
    if (v) { verts.push(v); keys.push([x, z]); }
  }
  if (verts.length < 3) return null;

  const delaunay = Delaunator.from(keys);
  const tris = delaunay.triangles;
  const positions = [];
  let dropped = 0, total = 0;
  const edgeOk = (a, b) => Math.abs(verts[a].y - verts[b].y) <= EDGE_DY_MAX;

  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    const cx = (keys[a][0] + keys[b][0] + keys[c][0]) / 3;
    const cz = (keys[a][1] + keys[b][1] + keys[c][1]) / 3;
    if (!pointInPolygon(cx, cz, pts2)) continue;
    total++;
    if (!edgeOk(a, b) || !edgeOk(b, c) || !edgeOk(a, c)) { dropped++; continue; }
    positions.push(verts[a], verts[b], verts[c]);
  }
  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry().setFromPoints(positions);
  geo.computeVertexNormals();
  const avgY = verts.reduce((s, v) => s + v.y, 0) / verts.length;
  return { geometry: geo, avgY, dropRatio: total ? dropped / total : 0 };
}

function renderRegionLabel(name, ann) {
  if (!Array.isArray(ann.points) || ann.points.length < 3) return;

  // 数据迁移：顶点统一改存 2D（投影几何在渲染时现算）
  if (ann.points.some(p => p.length > 2)) {
    ann.points = ann.points.map(p => [p[0], p[1]]);
    persistPositions();
  }
  // floorY 缺省：取首顶点命中层
  if (ann.floorY === undefined || ann.floorY === null) {
    const h = sampleGroundPoint(ann.points[0][0], ann.points[0][1], null);
    ann.floorY = h ? r1(h.y) : 0;
  }

  const built = buildRegionGeometry(ann);
  if (built) {
    const fill = new THREE.Mesh(built.geometry, new THREE.MeshBasicMaterial({
      color: new THREE.Color(ann.color),
      transparent: true, opacity: ann.opacity,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
    }));
    fill.userData.regionName = name;
    labelGroup.add(fill);
    ann.height = r1(built.avgY + 0.3);
  }

  // 描边：边界点贴地采样
  const outlinePts = [];
  for (const [x, z] of ann.points) {
    const v = sampleGroundPoint(x, z, ann.floorY);
    if (v) outlinePts.push(v.clone().setY(v.y + 0.1));
  }
  if (outlinePts.length >= 3) {
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(outlinePts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(ann.outlineColor), transparent: true, opacity: 0.95 })
    );
    outline.userData.regionName = name;
    labelGroup.add(outline);
  }

  const yLabel = ann.height !== undefined ? ann.height : 0;
  const cx = ann.points.reduce((s, p) => s + p[0], 0) / ann.points.length;
  const cz = ann.points.reduce((s, p) => s + p[1], 0) / ann.points.length;
  const sprite = createMarkerSprite(name, ann.labelColor);
  const h = 0.0045 * ann.fontSize * markerScale;
  sprite.scale.set(h * 2, h, 1);
  sprite.position.set(cx, yLabel + 2 + ann.fontSize * 0.3, cz);
  sprite.userData.regionName = name;
  labelGroup.add(sprite);
}

/* 单区域重建（编辑拖动时局部刷新用） */
function removeRegionObjects(name) {
  const objs = labelGroup.children.filter(o => o.userData.regionName === name);
  objs.forEach(o => {
    labelGroup.remove(o);
    o.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
  });
}

function rebuildRegionLabel(name) {
  const ann = positions[name];
  removeRegionObjects(name);
  if (ann && ann.type === 'region') renderRegionLabel(name, ann);
}

/* ---- 校准模式 ---- */
/* 模式化鼠标输入：
 * 校准模式：左键只标点/放顶点；Alt+左键旋转；中键或空格+左键平移；滚轮缩放
 * 浏览模式：OrbitControls 默认（左键旋转 / 右键平移 / 滚轮缩放）
 */
export let altHeld = false;
export let spaceHeld = false;

function applyCalibMouseButtons() {
  if (!calibMode) {
    controls.mouseButtons = { ...MOUSE_BROWSE };
    return;
  }
  const m = { ...MOUSE_CALIB };
  if (spaceHeld) m.LEFT = THREE.MOUSE.PAN;
  else if (altHeld) m.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons = m;
}

export function setCalibMode(on) {
  calibMode = on;
  document.body.classList.toggle('calib', on);
  document.getElementById('btn-calib').textContent = on ? '✔ 完成校准' : '🎯 标点校准';
  document.getElementById('mode-badge').textContent = on
    ? '🎯 校准模式：左键标点 · Alt+左键旋转 · 中键平移（Q 返回浏览）'
    : '👁 浏览模式（Q 切换校准）';
  applyCalibMouseButtons();
  if (on) {
    cancelUtilityRecording(); // 与道具录入互斥
    setTopView(); // 校准在正俯视图下进行
    refreshCalibList();
    refreshParentOptions();
  } else {
    stopRegionEdit();
    cancelRegionDrawing();
    clearLabelGroup(calibPreview);
  }
}

function setCalibDrawMode(mode) {
  calibDrawMode = mode;
  document.getElementById('calib-mode-point').classList.toggle('active', mode === 'point');
  document.getElementById('calib-mode-region').classList.toggle('active', mode === 'region');
  stopRegionEdit();
  cancelRegionDrawing();
  clearLabelGroup(calibPreview);
  document.getElementById('calib-coords').textContent =
    mode === 'point' ? '坐标：点击地图取点' : '区域：连续点击放顶点';
}

function updateCalibCoords(pt) {
  document.getElementById('calib-coords').textContent =
    `坐标：x=${pt.x.toFixed(1)}  y=${pt.y.toFixed(1)}  z=${pt.z.toFixed(1)}`;
}

function updateCalibLayerInfo() {
  const el = document.getElementById('calib-layer');
  el.textContent = calibHits.length > 1
    ? `命中 ${calibHits.length} 层 第 ${calibHitIdx + 1}/${calibHits.length} 层（Tab 切换）`
    : (calibHits.length === 1 ? '命中 1 层' : '');
}

/* 选定第 idx 层 */
export function selectCalibHit(idx) {
  if (!calibHits.length) return;
  calibHitIdx = ((idx % calibHits.length) + calibHits.length) % calibHits.length;
  heightAdjust = 0;
  pendingPoint = calibHits[calibHitIdx].point.clone();
  document.getElementById('calib-height').textContent = '高度微调 0';
  updateCalibCoords(pendingPoint);
  updateCalibLayerInfo();
  updateCalibPreviewPoint();
}

/* +/- 微调高度 */
function adjustCalibHeight(delta) {
  if (!pendingPoint) return;
  heightAdjust += delta;
  pendingPoint.y += delta;
  document.getElementById('calib-height').textContent =
    `高度微调 ${heightAdjust >= 0 ? '+' : ''}${heightAdjust.toFixed(1)}`;
  updateCalibCoords(pendingPoint);
  updateCalibPreviewPoint();
}

/* 取点预览（小圆环跟随选中点） */
function updateCalibPreviewPoint() {
  clearLabelGroup(calibPreview);
  if (!pendingPoint || calibDrawMode !== 'point') return;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.8, 2.6, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe082, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(pendingPoint).y += 0.3;
  calibPreview.add(ring);
}

/* ---- 区域编辑：拖顶点 / 边中加点 / Ctrl+点删点 / 拖填充整体移动 / Esc 完成 ---- */
function startRegionEdit(name) {
  if (editingRegion && editingRegion.name === name) { stopRegionEdit(); return; }
  cancelRegionDrawing();
  clearLabelGroup(calibPreview);
  editingRegion = { name, dragIdx: -1, dragWhole: false, startPt: null, origPoints: null };
  updateEditHandles();
  document.getElementById('calib-coords').textContent =
    `编辑「${name}」：拖顶点 / 拖边中白点加顶点 / Ctrl+点删顶点 / 拖填充整体移动 / Esc 完成`;
}

function stopRegionEdit() {
  editingRegion = null;
  clearLabelGroup(editHandles);
}

function updateEditHandles() {
  clearLabelGroup(editHandles);
  if (!editingRegion) return;
  const ann = positions[editingRegion.name];
  if (!ann || ann.type !== 'region') { editingRegion = null; return; }
  const y = (ann.height || 0) + 0.6;
  ann.points.forEach(([x, z], i) => {
    const h = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe082, depthTest: false })
    );
    h.position.set(x, y, z);
    h.userData = { handle: 'vertex', idx: i };
    editHandles.add(h);

    const [x2, z2] = ann.points[(i + 1) % ann.points.length];
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false })
    );
    m.position.set((x + x2) / 2, y, (z + z2) / 2);
    m.userData = { handle: 'mid', idx: i };
    editHandles.add(m);
  });
}

function updateEditingRegionHeight(ann) {
  // 标签/手柄参考高度：顶点地面高度均值（渲染时投影会重算真实贴地网格）
  ann.height = r1(ann.points.reduce((s, p) => s + groundYAt(p[0], p[1], 0) + 0.05, 0) / ann.points.length + 0.3);
}

export function onEditPointerDown(e) {
  const ann = positions[editingRegion.name];
  if (!ann) { stopRegionEdit(); return; }
  setBoardPointer(e);

  // 1) 顶点/边中手柄
  const hits = boardRaycaster.intersectObjects(editHandles.children, false);
  if (hits.length) {
    const h = hits[0].object.userData;
    if (h.handle === 'vertex') {
      if ((e.ctrlKey || e.metaKey) && ann.points.length > 3) {
        ann.points.splice(h.idx, 1); // Ctrl+点：删顶点（保底 3 个）
        updateEditingRegionHeight(ann);
        persistPositions();
        rebuildRegionLabel(editingRegion.name);
        updateEditHandles();
        return;
      }
      editingRegion.dragIdx = h.idx;
    } else {
      // 边中点：插入新顶点（2D）并立即拖拽它
      const pt = hits[0].point;
      ann.points.splice(h.idx + 1, 0, [r1(pt.x), r1(pt.z)]);
      editingRegion.dragIdx = h.idx + 1;
    }
    controls.enabled = false;
    return;
  }

  // 2) 填充面：整体移动
  const fillHits = boardRaycaster.intersectObjects(
    labelGroup.children.filter(o => o.userData.regionName === editingRegion.name), true);
  if (fillHits.length) {
    editingRegion.dragWhole = true;
    editingRegion.startPt = fillHits[0].point.clone();
    editingRegion.origPoints = ann.points.map(p => [...p]);
    controls.enabled = false;
  }
}

export function onEditPointerMove(e) {
  const ann = positions[editingRegion.name];
  if (!ann) return;
  const pt = raycastMapPoint(e);
  if (!pt) return;
  if (editingRegion.dragIdx >= 0) {
    // 顶点拖拽：只改 2D 坐标，贴地投影在渲染时重算
    ann.points[editingRegion.dragIdx] = [r1(pt.x), r1(pt.z)];
  } else if (editingRegion.dragWhole) {
    const dx = pt.x - editingRegion.startPt.x;
    const dz = pt.z - editingRegion.startPt.z;
    ann.points = editingRegion.origPoints.map(p => [r1(p[0] + dx), r1(p[1] + dz)]);
  } else {
    return;
  }
  updateEditingRegionHeight(ann);
  rebuildRegionLabel(editingRegion.name);
  updateEditHandles();
}

export async function onEditPointerUp() {
  editingRegion.dragIdx = -1;
  editingRegion.dragWhole = false;
  controls.enabled = true;
  const ann = positions[editingRegion.name];
  if (ann) updateEditingRegionHeight(ann);
  await persistPositions();
  rebuildRegionLabel(editingRegion.name);
  updateEditHandles();
  refreshCalibList();
}

export function addRegionVertex(pt) {
  if (!regionDrawing) regionDrawing = { points: [] };
  // 点击起点附近闭合
  if (regionDrawing.points.length >= 3 && pt.distanceTo(regionDrawing.points[0]) < 3) {
    closeRegionDrawing();
    return;
  }
  regionDrawing.points.push(pt.clone());
  updateRegionPreview();
}

function undoRegionVertex() {
  if (!regionDrawing) return;
  regionDrawing.points.pop();
  if (!regionDrawing.points.length) regionDrawing = null;
  updateRegionPreview();
}

function cancelRegionDrawing() {
  regionDrawing = null;
  pendingRegion = null;
  updateRegionPreview();
}

function closeRegionDrawing() {
  if (!regionDrawing || regionDrawing.points.length < 3) return;
  const pts = regionDrawing.points;
  // 圈选只存 2D 多边形顶点 + 首顶点楼层高度（投影贴地在渲染时现算）
  pendingRegion = {
    points: pts.map(p => [r1(p.x), r1(p.z)]),
    floorY: r1(pts[0].y),
    height: r1(pts[0].y + 0.3),
  };
  regionDrawing = null;
  updateRegionPreview();
  document.getElementById('calib-coords').textContent = '区域已闭合：输入名称后保存';
}

/* 区域绘制实时预览：顶点圆点 + 连线 + 半透明填充 */
export function updateRegionPreview(hoverPt) {
  clearLabelGroup(calibPreview);
  const src = pendingRegion
    ? pendingRegion.points.map(([x, z]) => new THREE.Vector3(x, pendingRegion.height, z))
    : (regionDrawing ? regionDrawing.points : []);
  if (!src.length) return;
  const pts = src.concat(hoverPt && regionDrawing ? [hoverPt] : []);
  const color = 0xffe082;

  pts.forEach(p => {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 10, 10),
      new THREE.MeshBasicMaterial({ color, depthWrite: false })
    );
    dot.position.copy(p).y += 0.4;
    calibPreview.add(dot);
  });

  if (pts.length >= 2) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts.map(p => p.clone().setY(p.y + 0.4))),
      new THREE.LineBasicMaterial({ color })
    );
    calibPreview.add(line);
  }

  if (pts.length >= 3) {
    const shape = new THREE.Shape();
    pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const yAvg = pts.reduce((s, p) => s + p.y, 0) / pts.length + 0.3;
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false,
    }));
    fill.position.y = yAvg;
    calibPreview.add(fill);
  }
}

/* ---- 保存 ---- */
async function saveCalibPoint() {
  const name = document.getElementById('calib-name').value.trim();
  if (!name) { document.getElementById('calib-name').focus(); return; }
  const parent = document.getElementById('calib-parent').value || null;

  if (calibDrawMode === 'region') {
    if (!pendingRegion) {
      document.getElementById('calib-coords').textContent = '请先圈出区域（回车或点击起点闭合）';
      return;
    }
    positions[name] = normalizeAnnotation(name, {
      type: 'region', points: pendingRegion.points,
      floorY: pendingRegion.floorY, height: pendingRegion.height, parent,
    });
    pendingRegion = null;
    clearLabelGroup(calibPreview);
  } else {
    if (!pendingPoint) {
      document.getElementById('calib-coords').textContent = '坐标：请先在地图上点击取点';
      return;
    }
    positions[name] = normalizeAnnotation(name, {
      type: 'point', x: r1(pendingPoint.x), y: r1(pendingPoint.y), z: r1(pendingPoint.z), parent,
    });
  }
  document.getElementById('calib-name').value = '';
  await persistPositions();
  renderPositionLabels();
}

/* ---- 标注列表（含逐标注样式编辑：取色器/透明度） ---- */
function refreshCalibList() {
  const el = document.getElementById('calib-list');
  if (!el) return;
  el.innerHTML = '';
  for (const [name, ann] of Object.entries(positions)) {
    const row = document.createElement('div');
    row.className = 'calib-item';
    const typeTag = ann.type === 'region' ? '区域' : '点';
    const detail = ann.type === 'region' ? `${ann.points.length}顶点` : `(${ann.x}, ${ann.y}, ${ann.z})`;
    row.innerHTML = `<span class="tb-dot" style="background:${ann.color}"></span>` +
      `<span class="calib-name" style="cursor:pointer" title="点击展开样式编辑">${name}</span>` +
      `<span class="calib-type">${typeTag}${ann.parent ? '·子' : ''}</span>` +
      `<span class="calib-xyz">${detail}</span>`;

    const fm = document.createElement('button');
    fm.className = 'calib-font-btn';
    fm.textContent = 'A-';
    fm.addEventListener('click', () => adjustAnnotationFont(name, -1));
    const fp = document.createElement('button');
    fp.className = 'calib-font-btn';
    fp.textContent = 'A+';
    fp.addEventListener('click', () => adjustAnnotationFont(name, 1));
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', async () => {
      delete positions[name];
      await persistPositions();
      renderPositionLabels();
    });
    row.append(fm, fp);
    if (ann.type === 'region') {
      const ed = document.createElement('button');
      ed.className = 'calib-font-btn';
      ed.textContent = '✎';
      ed.title = '编辑区域（拖顶点/加删顶点/整体移动）';
      ed.addEventListener('click', () => startRegionEdit(name));
      row.appendChild(ed);
    }
    row.appendChild(del);
    el.appendChild(row);

    // 点击名称展开/收起样式编辑器
    const editor = buildStyleEditor(name, ann);
    editor.style.display = 'none';
    row.querySelector('.calib-name').addEventListener('click', () => {
      editor.style.display = editor.style.display === 'none' ? 'block' : 'none';
    });
    el.appendChild(editor);
  }
}

/* 每个标注的样式编辑器（点：圆点/标签颜色；区域：填充/透明度/描边/标签颜色） */
function buildStyleEditor(name, ann) {
  const box = document.createElement('div');
  box.className = 'calib-style-editor';

  const addColor = (label, key) => {
    const wrap = document.createElement('label');
    wrap.className = 'style-field';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = ann[key];
    input.addEventListener('input', async () => {
      ann[key] = input.value;
      row0Dot();
      await persistPositions();
      renderPositionLabels();
    });
    wrap.append(input, document.createTextNode(label));
    box.appendChild(wrap);
  };
  const row0Dot = () => {}; // 占位（列表小圆点下次刷新时同步）

  if (ann.type === 'region') {
    addColor('填充', 'color');
    const wrap = document.createElement('label');
    wrap.className = 'style-field';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0.05'; range.max = '1'; range.step = '0.05';
    range.value = String(ann.opacity);
    const val = document.createElement('span');
    val.textContent = Number(ann.opacity).toFixed(2);
    range.addEventListener('input', async () => {
      ann.opacity = parseFloat(range.value);
      val.textContent = ann.opacity.toFixed(2);
      await persistPositions();
      renderPositionLabels();
    });
    wrap.append(document.createTextNode('透明度'), range, val);
    box.appendChild(wrap);
    addColor('描边', 'outlineColor');
    addColor('标签', 'labelColor');

    // 楼层 Y（上下层区域的分层选择：只投影到该高度层）
    const fw = document.createElement('label');
    fw.className = 'style-field';
    const fy = document.createElement('input');
    fy.type = 'number';
    fy.step = '1';
    fy.value = String(ann.floorY ?? 0);
    fy.title = '只在该高度层生成选区（上下层同屏时用它选层）';
    fy.addEventListener('change', async () => {
      ann.floorY = parseFloat(fy.value) || 0;
      await persistPositions();
      renderPositionLabels();
    });
    fw.append(document.createTextNode('楼层Y'), fy);
    box.appendChild(fw);
  } else {
    addColor('圆点', 'color');
    addColor('标签', 'labelColor');
  }
  return box;
}

async function adjustAnnotationFont(name, delta) {
  const ann = positions[name];
  if (!ann) return;
  ann.fontSize = Math.max(4, ann.fontSize + delta);
  await persistPositions();
  renderPositionLabels();
}

/* 父级下拉：所有已有标注都可作为父级 */
function refreshParentOptions() {
  const sel = document.getElementById('calib-parent');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">无父级</option>';
  for (const name of Object.keys(positions)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = cur;
}

export function initCalib() {
  scene.add(labelGroup, calibPreview, editHandles);
  document.getElementById('btn-calib').addEventListener('click', () => setCalibMode(!calibMode));
  document.getElementById('calib-mode-point').addEventListener('click', () => setCalibDrawMode('point'));
  document.getElementById('calib-mode-region').addEventListener('click', () => setCalibDrawMode('region'));
  document.getElementById('calib-save').addEventListener('click', saveCalibPoint);
  document.getElementById('calib-hminus').addEventListener('click', () => adjustCalibHeight(-0.5));
  document.getElementById('calib-hplus').addEventListener('click', () => adjustCalibHeight(0.5));
  document.getElementById('calib-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveCalibPoint();
    e.stopPropagation();
  });
  document.getElementById('calib-export').addEventListener('click', exportBackup);
  document.getElementById('calib-import').addEventListener('click', () => {
    document.getElementById('calib-import-file').click();
  });
  document.getElementById('calib-import-file').addEventListener('change', e => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
  window.addEventListener('keydown', e => {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      if (e.code === 'KeyQ') { setCalibMode(!calibMode); return; }
      if (e.code === 'AltLeft' || e.code === 'AltRight') { altHeld = true; applyCalibMouseButtons(); }
      if (e.code === 'Space') {
        if (calibMode) e.preventDefault();
        spaceHeld = true;
        applyCalibMouseButtons();
      }
    }
    if (!calibMode || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Tab') {
      e.preventDefault();
      if (calibDrawMode === 'point' && calibHits.length > 1) {
        selectCalibHit(calibHitIdx + (e.shiftKey ? -1 : 1));
      }
    } else if (e.code === 'Escape') {
      if (editingRegion) {
        stopRegionEdit();
        document.getElementById('calib-coords').textContent = '已退出区域编辑';
      } else {
        cancelRegionDrawing();
        document.getElementById('calib-coords').textContent = '区域：连续点击放顶点';
      }
    } else if (e.code === 'Enter') {
      closeRegionDrawing();
    } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      adjustCalibHeight(0.5);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      adjustCalibHeight(-0.5);
    } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      undoRegionVertex(); // 校准模式下 Ctrl+Z 撤销顶点
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'AltLeft' || e.code === 'AltRight') { altHeld = false; applyCalibMouseButtons(); }
    if (e.code === 'Space') { spaceHeld = false; applyCalibMouseButtons(); }
  });
  window.addEventListener('blur', () => {
    altHeld = false;
    spaceHeld = false;
    applyCalibMouseButtons();
  });
}
