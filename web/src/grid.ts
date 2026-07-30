// @ts-nocheck
/* ------------------------------------------------------------
 * 坐标网格叠加层：正俯视图下按 CS2 游戏世界坐标（Source x/y）
 * 每 500 单位一格，网格线端部标注坐标数值，标出原点与 +x/+y 轴。
 * 所有线/标签 depthTest=false 始终可见（对齐校验用覆盖层）。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, mapBounds } from './state';
import { worldToScene, sceneToSource } from './coords';
import { isTopView } from './camera';
import { createMarkerSprite } from './board';

const GRID_STEP = 500;       // Source 单位
const COLOR_LINE = 0x4a5a70;
const COLOR_X = '#ffa940';   // x 轴标签/箭头
const COLOR_Y = '#7ec8ff';   // y 轴标签/箭头

let gridGroup = null;
let gridOn = localStorage.getItem('cs2-grid') === '1';

export function isGridOn() { return gridOn; }

function makeLabel(text, cssColor) {
  const sprite = createMarkerSprite(text, cssColor);
  sprite.scale.set(0.09, 0.045, 1);
  return sprite;
}

/* 地图就绪后构建一次（map.ts onMapReady 调用） */
export function buildGrid() {
  if (gridGroup) return;
  if (!mapBounds) return;

  // 场景包围盒 → Source 坐标范围（8 角点取 min/max）
  const lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
  const _s = new THREE.Vector3();
  for (const cx of [mapBounds.min.x, mapBounds.max.x]) {
    for (const cz of [mapBounds.min.z, mapBounds.max.z]) {
      const src = sceneToSource(_s.set(cx, 0, cz), new THREE.Vector3());
      lo.x = Math.min(lo.x, src.x); hi.x = Math.max(hi.x, src.x);
      lo.y = Math.min(lo.y, src.y); hi.y = Math.max(hi.y, src.y);
    }
  }
  const x0 = Math.floor(lo.x / GRID_STEP) * GRID_STEP, x1 = Math.ceil(hi.x / GRID_STEP) * GRID_STEP;
  const y0 = Math.floor(lo.y / GRID_STEP) * GRID_STEP, y1 = Math.ceil(hi.y / GRID_STEP) * GRID_STEP;
  const yGrid = mapBounds.min.y + 0.5; // 平铺高度（depthTest=false，不被遮挡）

  gridGroup = new THREE.Group();
  gridGroup.name = 'coord-grid';

  const linePts = [];
  const labels = [];
  const _p = new THREE.Vector3();
  const at = (sx, sy) => {
    const p = worldToScene(sx, sy, 0, _p);
    return new THREE.Vector3(p.x, yGrid, p.z);
  };

  // 常 x 线（南北向）+ 常 y 线（东西向）
  for (let sx = x0; sx <= x1; sx += GRID_STEP) {
    const a = at(sx, y0), b = at(sx, y1);
    linePts.push(a, b);
    labels.push({ text: `x=${sx}`, color: COLOR_X, pos: a });
  }
  for (let sy = y0; sy <= y1; sy += GRID_STEP) {
    const a = at(x0, sy), b = at(x1, sy);
    linePts.push(a, b);
    labels.push({ text: `y=${sy}`, color: COLOR_Y, pos: a });
  }
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(linePts),
    new THREE.LineBasicMaterial({ color: COLOR_LINE, transparent: true, opacity: 0.75, depthTest: false })
  );
  lines.renderOrder = 1001;
  gridGroup.add(lines);

  for (const l of labels) {
    const sprite = makeLabel(l.text, l.color);
    sprite.position.copy(l.pos);
    sprite.renderOrder = 1002;
    gridGroup.add(sprite);
  }

  // 原点 (0,0)：圆环 + 标签
  const origin = at(0, 0);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.2, 3.0, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(origin);
  ring.renderOrder = 1002;
  gridGroup.add(ring);
  const oLabel = makeLabel('(0,0)', '#ffffff');
  oLabel.position.copy(origin);
  oLabel.renderOrder = 1002;
  gridGroup.add(oLabel);

  // 轴正方向箭头：+x 橙 / +y 蓝（沿网格方向 1500 单位处）
  for (const [dx, dy, color] of [[1, 0, 0xffa940], [0, 1, 0x7ec8ff]]) {
    const from = at(0, 0);
    const to = at(dx * 1500, dy * 1500);
    const dir = to.clone().sub(from); dir.y = 0;
    if (dir.lengthSq() < 0.01) continue;
    dir.normalize();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(2.2, 7, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cone.position.copy(to).addScaledVector(dir, -3.5);
    cone.renderOrder = 1002;
    gridGroup.add(cone);
  }

  gridGroup.visible = false;
  scene.add(gridGroup);
  updateGrid();
}

/* 每帧显隐：正俯视 + 开关 */
export function updateGrid() {
  if (gridGroup) gridGroup.visible = gridOn && isTopView;
}

export function setGridOn(on) {
  gridOn = on;
  localStorage.setItem('cs2-grid', on ? '1' : '0');
  const btn = document.getElementById('btn-grid');
  if (btn) btn.classList.toggle('active', on);
  updateGrid();
}

export function initGrid() {
  document.getElementById('btn-grid').addEventListener('click', () => setGridOn(!gridOn));
  const btn = document.getElementById('btn-grid');
  if (btn) btn.classList.toggle('active', gridOn);
}
