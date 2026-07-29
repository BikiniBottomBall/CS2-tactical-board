// @ts-nocheck
/* ------------------------------------------------------------
 * 相机与镜头控制：WASD 飞行、复位、正俯视、范围钳制、窗口 resize
 * OrbitControls 实例由 main.ts 创建后注入 state
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { camera, renderer, controls, mapBounds } from './state';

/* WASD 飞行移动：沿相机朝向平移（W/S 前后，A/D 左右，Q/E 升降，
 * Shift 加速），速度随观察距离缩放 */
const flyKeys = new Set();

export function initFlyControls() {
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return; // 输入框打字不触发快捷键
    if (e.code === 'KeyR') { resetCamera(); return; }
    flyKeys.add(e.code);
  });
  window.addEventListener('keyup', e => flyKeys.delete(e.code));
  window.addEventListener('blur', () => flyKeys.clear());
}

const _flyDir = new THREE.Vector3();
const _flyRight = new THREE.Vector3();
const _flyMove = new THREE.Vector3();

export function updateFlyControls(dt) {
  if (!flyKeys.size) return;
  const boost = (flyKeys.has('ShiftLeft') || flyKeys.has('ShiftRight')) ? 3 : 1;
  // 速度随相机到目标距离缩放，远处快、近处慢
  const speed = Math.max(camera.position.distanceTo(controls.target) * 0.8, 10) * boost;

  camera.getWorldDirection(_flyDir);
  _flyDir.y = 0;
  _flyDir.normalize();
  _flyRight.crossVectors(_flyDir, new THREE.Vector3(0, 1, 0)).negate();

  _flyMove.set(0, 0, 0);
  if (flyKeys.has('KeyW')) _flyMove.add(_flyDir);
  if (flyKeys.has('KeyS')) _flyMove.sub(_flyDir);
  if (flyKeys.has('KeyA')) _flyMove.add(_flyRight);
  if (flyKeys.has('KeyD')) _flyMove.sub(_flyRight);
  if (flyKeys.has('PageUp')) _flyMove.y += 1;
  if (flyKeys.has('PageDown')) _flyMove.y -= 1;
  if (_flyMove.lengthSq() === 0) return;

  _flyMove.normalize().multiplyScalar(speed * dt);
  camera.position.add(_flyMove);
  controls.target.add(_flyMove);
  clampToMap();
}

/* 限制相机与目标点不飞出地图范围（防止 WASD 飞丢） */
const _clampMin = new THREE.Vector3();
const _clampMax = new THREE.Vector3();

export function clampToMap() {
  if (!mapBounds) return;
  _clampMin.set(mapBounds.min.x - 120, mapBounds.min.y - 30, mapBounds.min.z - 120);
  _clampMax.set(mapBounds.max.x + 120, mapBounds.max.y + 260, mapBounds.max.z + 120);
  camera.position.clamp(_clampMin, _clampMax);
  controls.target.clamp(_clampMin, _clampMax);
}

/* 复位到默认斜 45° 俯瞰 */
export let isTopView = false;

export function resetCamera() {
  if (!mapBounds) return;
  const size = mapBounds.getSize(new THREE.Vector3());
  const center = mapBounds.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.72;
  camera.up.set(0, 1, 0);
  camera.position.set(center.x + r, r * 1.1, center.z + r);
  controls.target.copy(center);
  controls.update();
  isTopView = false;
  updateTopViewBtn();
}

/* 正俯视：垂直向下，地图摆正（逆时针 90°：匪家下 / B 左上 / A 右上）
 * 不改 camera.up（恒为 Y 轴向上），与斜 45° 共用同一套 OrbitControls 旋转逻辑；
 * x 方向加 -0.01 偏移避免视线与 up 共线，Y-up 下屏幕上方即世界 +X
 */
export function setTopView() {
  if (!mapBounds) return;
  const size = mapBounds.getSize(new THREE.Vector3());
  const center = mapBounds.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.72;
  camera.position.set(center.x, mapBounds.max.y + r * 1.7, center.z + 0.01);
  controls.target.copy(center);
  controls.update();
  isTopView = true;
  updateTopViewBtn();
}

function updateTopViewBtn() {
  const btn = document.getElementById('btn-topview');
  if (btn) btn.textContent = isTopView ? '↩ 斜 45° 视角' : '⬇ 正俯视视角';
}

/* 窗口尺寸变化 */
export function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
