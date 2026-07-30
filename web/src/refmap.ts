// @ts-nocheck
/* ------------------------------------------------------------
 * 参考图对照模式：2D 点位参考图（refmap.png）半透明平铺在正俯视图，
 * 透明度/平移/缩放/旋转 90° 步进可调，参数存 localStorage 自动恢复。
 * 「导出对齐校验图」：强制正俯视 + 网格 + 参考图，截画布 POST 后端写盘。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { scene, camera, renderer, mapBounds } from './state';
import { isTopView, setTopView } from './camera';
import { isGridOn, setGridOn } from './grid';

const ALIGN_KEY = 'cs2-refmap-align';
/* 默认对齐：参考图上方=游戏北=场景 +x（rotK=1），
 * 覆盖可玩区 Source x∈[-2100,2300] y∈[-900,3300]（约 140 场景单位） */
const DEFAULT_ALIGN = { cx: 6.4, cz: 25.4, size: 140, rotK: 1, opacity: 0.5 };

let plane = null;
let align = loadAlign();
let refmapOn = localStorage.getItem('cs2-refmap-on') === '1';

function loadAlign() {
  try {
    const raw = localStorage.getItem(ALIGN_KEY);
    if (raw) return { ...DEFAULT_ALIGN, ...JSON.parse(raw) };
  } catch (e) { /* 损坏则用默认 */ }
  return { ...DEFAULT_ALIGN };
}

function saveAlign() {
  localStorage.setItem(ALIGN_KEY, JSON.stringify(align));
}

function applyAlign() {
  if (!plane) return;
  plane.position.set(align.cx, plane.position.y, align.cz);
  plane.scale.set(align.size, 1, align.size); // 几何已平铺 XZ：x/z 缩放，y 不动
  plane.rotation.y = -align.rotK * Math.PI / 2;
  plane.material.opacity = align.opacity;
  const slider = document.getElementById('refmap-opacity');
  if (slider) slider.value = String(Math.round(align.opacity * 100));
}

/* 地图就绪后构建（map.ts onMapReady 调用） */
export function buildRefmap() {
  if (plane || !mapBounds) return;
  const tex = new THREE.TextureLoader().load('refmap.png');
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // 平铺 XZ，朝上；纹理上边指向 -z（由 rotation.y 再转正）
  plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: align.opacity,
    side: THREE.DoubleSide, depthWrite: false, depthTest: false,
  }));
  plane.position.y = mapBounds.min.y + 0.4;
  plane.renderOrder = 1000;
  plane.visible = false;
  scene.add(plane);
  applyAlign();
  updateRefmap();
}

export function updateRefmap() {
  if (plane) plane.visible = refmapOn && isTopView;
}

function setRefmapOn(on) {
  refmapOn = on;
  localStorage.setItem('cs2-refmap-on', on ? '1' : '0');
  const btn = document.getElementById('btn-refmap');
  if (btn) btn.classList.toggle('active', on);
  updateRefmap();
}

export function initRefmap() {
  document.getElementById('btn-refmap').addEventListener('click', () => setRefmapOn(!refmapOn));
  const btn = document.getElementById('btn-refmap');
  if (btn) btn.classList.toggle('active', refmapOn);

  document.getElementById('refmap-opacity').addEventListener('input', e => {
    align.opacity = parseInt(e.target.value, 10) / 100;
    applyAlign();
    saveAlign();
  });
  const PAN = 2, ZOOM = 1.05;
  const nudge = (fn) => () => { fn(); applyAlign(); saveAlign(); };
  document.getElementById('refmap-left').addEventListener('click', nudge(() => { align.cx -= PAN; }));
  document.getElementById('refmap-right').addEventListener('click', nudge(() => { align.cx += PAN; }));
  document.getElementById('refmap-up').addEventListener('click', nudge(() => { align.cz -= PAN; }));
  document.getElementById('refmap-down').addEventListener('click', nudge(() => { align.cz += PAN; }));
  document.getElementById('refmap-zoomin').addEventListener('click', nudge(() => { align.size *= ZOOM; }));
  document.getElementById('refmap-zoomout').addEventListener('click', nudge(() => { align.size /= ZOOM; }));
  document.getElementById('refmap-rot').addEventListener('click', nudge(() => { align.rotK = (align.rotK + 1) % 4; }));
  document.getElementById('refmap-reset').addEventListener('click', nudge(() => {
    align = { ...DEFAULT_ALIGN, opacity: align.opacity };
  }));

  document.getElementById('btn-export-align').addEventListener('click', exportAlignImage);
}

/* 导出对齐校验图：正俯视 + 网格 + 参考图 → 画布 PNG → 后端写 check_align.png */
async function exportAlignImage() {
  if (!isTopView) setTopView();
  if (!isGridOn()) setGridOn(true);
  if (!refmapOn) setRefmapOn(true);
  // 等同帧渲染完成后取画布（WebGL 内含网格/标签/参考图）
  requestAnimationFrame(async () => {
    renderer.render(scene, camera);
    renderer.domElement.toBlob(async (blob) => {
      if (!blob) return;
      try {
        const r = await fetch('/api/export-align', { method: 'POST', body: blob });
        const data = await r.json();
        if (data.error) throw new Error(data.error);
        flashBadge(`📷 已导出 ${data.path}（${Math.round(data.bytes / 1024)} KB）`);
      } catch (e) {
        flashBadge('导出失败：' + e.message);
      }
    }, 'image/png');
  });
}

/* 徽章临时提示（2.5s 后恢复） */
function flashBadge(text) {
  const badge = document.getElementById('mode-badge');
  if (!badge) return;
  const prev = badge.textContent;
  badge.textContent = text;
  setTimeout(() => { badge.textContent = prev; }, 2500);
}
