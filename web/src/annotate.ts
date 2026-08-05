// @ts-nocheck
/* ------------------------------------------------------------
 * 点位标注：在地图上点击取点 → 命名保存；预设常用点位一键标注。
 * 坐标一律存 Source 世界坐标（x东 / y北 / z上），渲染时 worldToScene
 * 精确放置，与出生点/道具/demo 共用同一映射（不依赖参考图对齐）。
 * 数据持久化到后端 /api/annotations。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, camera, controls, renderer, mapGroup } from './state';
import { worldToScene, sceneToSource } from './coords';
import { createMarkerSprite, raycastMapPoint } from './board';
import { registerMode, getMode } from './tools';

const annGroup = new THREE.Group();
const annotations = new Map(); // name -> { data, group }
let pendingScene: THREE.Vector3 | null = null;
let pendingMarker: THREE.Mesh | null = null;

/* 标点显示样式（localStorage 持久化） */
let annSize = parseFloat(localStorage.getItem('cs2-ann-size') || '0.7');
let annOpacity = parseFloat(localStorage.getItem('cs2-ann-opacity') || '1');
let labelsOn = localStorage.getItem('cs2-ann-labels') !== '0';

function flash(text: string) {
  const badge = document.getElementById('mode-badge');
  if (!badge) return;
  const prev = badge.textContent;
  badge.textContent = text;
  setTimeout(() => { badge.textContent = prev; }, 2500);
}

function annColor(data: any): string {
  return data.color || '#ffa940';
}

/* ---- 渲染 / 移除 ---- */
function renderAnnotation(data: any) {
  if (!mapGroup || annotations.has(data.name)) return;
  const pos = worldToScene(data.x ?? 0, data.y ?? 0, data.z ?? 0, new THREE.Vector3());
  const group = new THREE.Group();
  group.position.copy(pos);

  // 标点（圆点 + 光环）：整体缩放由 pointGroup 控制，透明度可调
  const pointGroup = new THREE.Group();
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(2.2, 16, 16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(annColor(data)), depthTest: false, transparent: true, opacity: annOpacity })
  );
  dot.renderOrder = 998;
  pointGroup.add(dot);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3, 0.3, 8, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(annColor(data)), depthTest: false, side: THREE.DoubleSide, transparent: true, opacity: annOpacity })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 997;
  pointGroup.add(ring);
  pointGroup.scale.setScalar(annSize);
  group.add(pointGroup);

  // 名称标签：随镜头缩放（近大远小），拉远不遮挡标点；可整体隐藏
  const sprite = createMarkerSprite(data.name, annColor(data));
  sprite.material.sizeAttenuation = true;
  sprite.scale.set(24, 12, 1);
  sprite.position.set(0, 7, 0);
  sprite.visible = labelsOn;
  group.add(sprite);

  group.userData = { pointGroup, dot, ring, sprite, annName: data.name };
  annGroup.add(group);
  annotations.set(data.name, { data, group });
}

function removeAnnotation(name: string) {
  const item = annotations.get(name);
  if (!item) return;
  annGroup.remove(item.group);
  item.group.traverse((o: any) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m: any) => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
  annotations.delete(name);
}

/* ---- 标点显示样式：大小 / 透明度 / 标签显隐 ---- */
function applyAnnStyle() {
  for (const { group } of annotations.values()) {
    const u = group.userData;
    if (!u) continue;
    u.pointGroup.scale.setScalar(annSize);
    u.dot.material.opacity = annOpacity;
    u.ring.material.opacity = annOpacity;
    u.sprite.visible = labelsOn;
  }
  if (pendingMarker) {
    pendingMarker.scale.setScalar(annSize);
    pendingMarker.material.opacity = annOpacity;
  }
  updateAnnControls();
}

function updateAnnControls() {
  const sizeEl = document.getElementById('ann-size') as HTMLInputElement;
  const sizeVal = document.getElementById('ann-size-val');
  const opEl = document.getElementById('ann-opacity') as HTMLInputElement;
  const opVal = document.getElementById('ann-opacity-val');
  const lblBtn = document.getElementById('ann-toggle-labels');
  if (sizeEl && sizeVal) { sizeEl.value = String(annSize); sizeVal.textContent = `${annSize.toFixed(1)}x`; }
  if (opEl && opVal) { opEl.value = String(annOpacity); opVal.textContent = `${Math.round(annOpacity * 100)}%`; }
  if (lblBtn) lblBtn.classList.toggle('active', labelsOn);
}

/* ---- 列表 ---- */
function refreshList() {
  const el = document.getElementById('ann-list');
  if (!el) return;
  if (!annotations.size) {
    el.innerHTML = '<div class="calib-hint">暂无标注，点击地图取点或使用预设</div>';
    return;
  }
  el.innerHTML = '';
  for (const [name, { data }] of annotations) {
    const row = document.createElement('div');
    row.className = 'calib-item';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '6px';

    const label = document.createElement('span');
    label.textContent = name;
    label.style.color = annColor(data);
    label.style.cursor = 'pointer';
    label.title = '点击聚焦';
    label.addEventListener('click', () => focusAnnotation(name));

    const coord = document.createElement('span');
    coord.className = 'calib-xyz';
    coord.textContent = `(${Math.round(data.x ?? 0)}, ${Math.round(data.y ?? 0)})`;

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除标注';
    del.addEventListener('click', () => deleteAnnotation(name));

    row.append(label, coord, del);
    el.appendChild(row);
  }
}

function focusAnnotation(name: string) {
  const item = annotations.get(name);
  if (!item || !mapGroup) return;
  const p = item.group.position.clone();
  controls.target.copy(p);
  camera.position.set(p.x + 30, p.y + 55, p.z + 30);
  controls.update();
}

/* ---- 取点 ---- */
function clearPending() {
  pendingScene = null;
  if (pendingMarker) {
    annGroup.remove(pendingMarker);
    pendingMarker = null;
  }
  const el = document.getElementById('ann-coords');
  if (el) el.textContent = '坐标：点击地图取点';
}

function onPointerDown(e: PointerEvent) {
  if (getMode() !== 'annotate' || e.button !== 0) return;
  const pt = raycastMapPoint(e);
  if (!pt) return;
  pendingScene = pt;
  if (!pendingMarker) {
    pendingMarker = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffa940, depthTest: false, transparent: true, opacity: annOpacity })
    );
    pendingMarker.scale.setScalar(annSize);
    pendingMarker.renderOrder = 999;
    annGroup.add(pendingMarker);
  }
  pendingMarker.position.copy(pt);
  const src = sceneToSource(pt, new THREE.Vector3());
  const el = document.getElementById('ann-coords');
  if (el) el.textContent = `坐标：(${Math.round(src.x)}, ${Math.round(src.y)}, ${Math.round(src.z)})`;
}

/* ---- 保存 / 预设 / 删除 ---- */
async function saveAnnotation() {
  const nameEl = document.getElementById('ann-name') as HTMLInputElement;
  const name = (nameEl.value || '').trim();
  if (!name) { nameEl.focus(); return; }
  if (!pendingScene) { flash('请先点击地图取点'); return; }
  const src = sceneToSource(pendingScene, new THREE.Vector3());
  const body = {
    name,
    type: 'point',
    x: Math.round(src.x * 10) / 10,
    y: Math.round(src.y * 10) / 10,
    z: Math.round(src.z * 10) / 10,
  };
  try {
    const r = await fetch('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => null);
      throw new Error(err?.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    renderAnnotation(data);
    clearPending();
    nameEl.value = '';
    refreshList();
    flash(`已标注 ${name}`);
  } catch (e) {
    flash('保存失败：' + (e as Error).message);
  }
}

async function deleteAnnotation(name: string) {
  try {
    const r = await fetch(`/api/annotations/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    removeAnnotation(name);
    refreshList();
    flash(`已删除 ${name}`);
  } catch (e) {
    flash('删除失败：' + (e as Error).message);
  }
}

/* ---- 加载全部标注（地图就绪后） ---- */
export async function loadAnnotations() {
  try {
    const r = await fetch('/api/annotations');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    list.forEach(renderAnnotation);
    refreshList();
  } catch (e) {
    console.warn('[ann] 加载标注失败', e);
  }
}

export function initAnnotate() {
  annGroup.name = 'annotations';
  scene.add(annGroup);

  registerMode('annotate', {
    label: '📍 点位标注',
    enter: () => { renderer.domElement.style.cursor = 'crosshair'; },
    exit: () => { renderer.domElement.style.cursor = ''; clearPending(); },
  });

  document.getElementById('ann-save')!.addEventListener('click', saveAnnotation);
  document.getElementById('ann-name')!.addEventListener('keydown', e => {
    if (e.key === 'Enter') { saveAnnotation(); e.stopPropagation(); }
  });
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  // 标点显示控制
  const sizeSlider = document.getElementById('ann-size') as HTMLInputElement;
  const opSlider = document.getElementById('ann-opacity') as HTMLInputElement;
  const lblBtn = document.getElementById('ann-toggle-labels');
  if (sizeSlider) sizeSlider.addEventListener('input', () => {
    annSize = parseFloat(sizeSlider.value);
    localStorage.setItem('cs2-ann-size', String(annSize));
    applyAnnStyle();
  });
  if (opSlider) opSlider.addEventListener('input', () => {
    annOpacity = parseFloat(opSlider.value);
    localStorage.setItem('cs2-ann-opacity', String(annOpacity));
    applyAnnStyle();
  });
  if (lblBtn) lblBtn.addEventListener('click', () => {
    labelsOn = !labelsOn;
    localStorage.setItem('cs2-ann-labels', labelsOn ? '1' : '0');
    applyAnnStyle();
  });
  updateAnnControls();

  // 地图就绪后加载已保存标注
  if (mapGroup) {
    loadAnnotations();
  } else {
    const timer = window.setInterval(() => {
      if (mapGroup) {
        clearInterval(timer);
        loadAnnotations();
      }
    }, 200);
  }
}
