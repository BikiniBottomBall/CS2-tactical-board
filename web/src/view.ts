/* ------------------------------------------------------------
 * view.ts — 只读战术板查看器
 * 通过 /view/{share_id} 或 ?share=xxx 加载分享数据，
 * 渲染 de_dust2 地图 + 战术演员 + 道具轨迹。
 * 仅 OrbitControls（旋转/缩放/平移），无编辑功能。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setCore } from './state';
import { loadMap } from './map';
import { createActorVisual } from './tactic';
import { MARKER_DEFS } from './config';

/* ---- 画质 ---- */
const QUALITY_DPR: Record<string, number> = { smooth: 1, balanced: 1.5, quality: 2 };
const currentQuality = localStorage.getItem('cs2-quality') || 'balanced';

function applyQuality(r: THREE.WebGLRenderer): void {
  const dpr = QUALITY_DPR[currentQuality] || 1.5;
  r.setPixelRatio(Math.min(window.devicePixelRatio, dpr));
  r.setSize(window.innerWidth, window.innerHeight);
}

/* ---- 轨迹曲线（复刻 utility.ts buildCurve，该函数未导出） ---- */
interface UtilCoords {
  stand_x: number; stand_y: number; stand_z: number;
  landing_x: number; landing_y: number; landing_z: number;
  type?: string;
}

function buildCurve(u: UtilCoords): THREE.QuadraticBezierCurve3 {
  const p0 = new THREE.Vector3(u.stand_x, u.stand_y + 2, u.stand_z);
  const p2 = new THREE.Vector3(u.landing_x, u.landing_y, u.landing_z);
  const dist = p0.distanceTo(p2);
  const mid = p0.clone().lerp(p2, 0.5);
  const p1 = new THREE.Vector3(mid.x, 6 + dist * 0.25, mid.z);
  return new THREE.QuadraticBezierCurve3(p0, p1, p2);
}

function hasCoords(u: UtilCoords): boolean {
  return u.stand_x != null && u.stand_y != null && u.stand_z != null &&
    u.landing_x != null && u.landing_y != null && u.landing_z != null;
}

/* ---- 道具轨迹渲染 ---- */
function renderTrajectory(u: UtilCoords, scn: THREE.Scene): void {
  if (!hasCoords(u)) return;
  const defs = MARKER_DEFS as Record<string, { color: number; css: string }>;
  const def = defs[u.type || 'smoke'] || defs['smoke'];
  const curve = buildCurve(u);
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 64, 0.28, 8, false),
    new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.85, depthTest: false })
  );
  scn.add(tube);

  // 落点环
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.5, 3.5, 28),
    new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(u.landing_x, u.landing_y + 0.3, u.landing_z);
  scn.add(ring);
}

/* ---- 数据解析 ---- */
interface StepData {
  actors?: Array<{ id: string; x: number; y: number; z: number }>;
  utility_ids?: number[];
}

interface ShareData {
  tactic?: { name?: string; description?: string };
  steps?: StepData[];
  utilities?: UtilCoords[];
  name?: string;
  [key: string]: unknown;
}

function getSteps(data: ShareData): StepData[] {
  if (Array.isArray(data.steps)) return data.steps;
  return [];
}

function getUtilities(data: ShareData): UtilCoords[] {
  if (Array.isArray(data.utilities)) return data.utilities;
  return [];
}

function getTacticName(data: ShareData): string {
  return data?.tactic?.name || data?.name || '';
}

/* ---- 主逻辑 ---- */
const renderer = new THREE.WebGLRenderer({ antialias: true });
applyQuality(renderer);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1219);
scene.fog = new THREE.Fog(0x0d1219, 500, 1800);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(120, 140, 120);

// 灯光
scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x8a6f4d, 1.8));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.position.set(80, 160, 60);
scene.add(sun);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.05;

// 注入共享状态（loadMap 依赖 scene/controls）
setCore(scene, camera, renderer, controls);

// 启动地图加载
loadMap();

// 解析 share_id：优先 ?share= 查询参数，其次 URL 路径末段
const shareId = new URLSearchParams(location.search).get('share')
  || location.pathname.split('/').filter(Boolean).pop() || '';

// 异步加载战术数据
if (shareId) {
  (async () => {
    try {
      const res = await fetch(`/api/share/${shareId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ShareData = await res.json();
      if ((data as any).error) throw new Error((data as any).error);

      const name = getTacticName(data);
      if (name) {
        const el = document.getElementById('tactic-name');
        if (el) el.textContent = `战术：${name}`;
      }

      const steps = getSteps(data);
      const utils = getUtilities(data);

      // 构建 utility 索引（id -> 条目）
      const utilMap = new Map<number, UtilCoords>();
      for (const u of utils) {
        const uid = (u as any).id;
        if (uid != null) utilMap.set(uid, u);
      }

      // 收集所有步骤引用的道具 ID（去重）
      const usedUtilIds = new Set<number>();
      for (const s of steps) {
        for (const uid of (s.utility_ids || [])) {
          usedUtilIds.add(uid);
        }
      }

      // 渲染道具轨迹
      for (const uid of usedUtilIds) {
        const u = utilMap.get(uid);
        if (u) renderTrajectory(u, scene);
      }

      // 渲染最终态演员（最后一步的 actor 位置）
      const lastStep = steps[steps.length - 1];
      if (lastStep && Array.isArray(lastStep.actors)) {
        for (const a of lastStep.actors) {
          if (!a.id) continue;
          const isT = a.id[0] === 'T';
          const group = createActorVisual(a.id, isT);
          group.position.set(a.x, a.y, a.z);
          scene.add(group);
        }
      }
    } catch (err: any) {
      console.error('[view] 加载分享数据失败', err);
      const el = document.getElementById('error-msg');
      if (el) {
        el.style.display = 'block';
        el.textContent = '加载战术数据失败：' + (err.message || '未知错误');
      }
    }
  })();
}

// 响应窗口缩放
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 渲染循环（仅维护镜头旋转缩放，无工具/编辑逻辑）
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
