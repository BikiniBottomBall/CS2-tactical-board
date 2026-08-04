/* ------------------------------------------------------------
 * 入口：装配 scene/camera/renderer/controls 注入 state，
 * 初始化各子系统，启动渲染循环。
 * 注意：'./state' 必须第一个导入（内含 three-mesh-bvh 补丁）。
 * ---------------------------------------------------------- */
import './state';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as S from './state';
import { initFlyControls, updateFlyControls, resetCamera, setTopView, isTopView, handleResize } from './camera';
import { loadMap } from './map';
import { initBoard } from './board';
import { initTools, setMode } from './tools';
import { initUtility, updateUtility } from './utility';
import { initTactic, updateTactic } from './tactic';
import { initReplay, updateReplay } from './replay';
import { initGrid, updateGrid } from './grid';
import { initRefmap, updateRefmap } from './refmap';
import { createRoom, joinRoom, leaveRoom, cleanupStaleCursors } from './sync';
import { send } from './network';

/* e2e/调试探针（window 挂载点） */
declare global {
  interface Window {
    __scene: any;
    __camera: any;
    __controls: any;
    __mapReady: boolean;
  }
}

/* 画质档位：流畅 dpr1 / 均衡 dpr1.5 / 画质 dpr2（高分屏帧率差异的主要来源） */
const QUALITY_DPR = { smooth: 1, balanced: 1.5, quality: 2 };
let currentQuality = localStorage.getItem('cs2-quality') || 'balanced';

function applyQuality(renderer) {
  const dpr = QUALITY_DPR[currentQuality] || 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, dpr));
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function init() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  applyQuality(renderer);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  document.getElementById('app').appendChild(renderer.domElement);

  // 画质选择器（左上角面板）
  const sel = document.getElementById('sel-quality') as HTMLSelectElement | null;
  if (sel) {
    sel.value = currentQuality;
    sel.addEventListener('change', () => {
      currentQuality = sel.value;
      localStorage.setItem('cs2-quality', currentQuality);
      applyQuality(renderer);
    });
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1219);
  scene.fog = new THREE.Fog(0x0d1219, 500, 1800);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(120, 140, 120);

  // 灯光：精简两盏（性能考虑，不删几何）
  scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x8a6f4d, 1.8));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(80, 160, 60);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;

  S.setCore(scene, camera, renderer, controls);
  window.__scene = scene; // e2e/调试探针
  window.__camera = camera;
  window.__controls = controls;

  initFlyControls();
  initBoard();
  initUtility();
  initTactic();
  initReplay();
  initGrid();
  initRefmap();
  initTools(); // 最后：模式注册完毕后统一刷新侧边栏高亮

  // ---- P9 多人协同：房间 UI ----
  document.getElementById('btn-room-create')?.addEventListener('click', async () => {
    try {
      const code = await createRoom('CS2 战术板');
      await joinRoom(code, localStorage.getItem('cs2-nickname') || undefined);
    } catch (e) { alert('创建失败: ' + (e as Error).message); }
  });
  document.getElementById('btn-room-join')?.addEventListener('click', async () => {
    const code = (document.getElementById('room-code-input') as HTMLInputElement)?.value.trim().toUpperCase();
    if (!code) return;
    try {
      await joinRoom(code, localStorage.getItem('cs2-nickname') || undefined);
    } catch (e) { alert('加入失败: ' + (e as Error).message); }
  });
  document.getElementById('btn-room-leave')?.addEventListener('click', () => leaveRoom());
  document.getElementById('btn-room-copy')?.addEventListener('click', () => {
    if (S.roomCode) navigator.clipboard.writeText(S.roomCode).then(() => alert('已复制'));
  });
  // 显示 room panel
  document.getElementById('room-panel')!.style.display = 'block';

  // 视角按钮（侧边栏视角组；即时切换，不占工具态）
  document.getElementById('btn-view-browse').addEventListener('click', () => setMode('browse'));
  document.getElementById('btn-view-top').addEventListener('click', () => {
    setTopView();
    updateViewButtons();
  });
  document.getElementById('btn-view-45').addEventListener('click', () => {
    resetCamera();
    updateViewButtons();
  });
  updateViewButtons();

  window.addEventListener('resize', handleResize);

  loadMap();

  // P9-15: 本地光标位置上报（50ms 节流）
  let lastCursorSync = 0;
  renderer.domElement.addEventListener('pointermove', () => {
    if (!S.isMultiplayer) return;
    const now = Date.now();
    if (now - lastCursorSync < 50) return;
    lastCursorSync = now;
    // 用 OrbitControls target 近似光标在地图上的关注点
    send({ op: 'cursor_move', x: S.controls.target.x, z: S.controls.target.z });
  });

  animate();
}

/* 视角组按钮高亮（正俯视/斜45°） */
function updateViewButtons() {
  const top = document.getElementById('btn-view-top');
  const v45 = document.getElementById('btn-view-45');
  if (top) top.classList.toggle('active', isTopView);
  if (v45) v45.classList.toggle('active', !isTopView);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(S.flyClock.getDelta(), 0.1);
  updateFlyControls(dt);
  updateUtility(dt); // 道具播放/效果/预览脉冲
  updateTactic(dt);  // 战术推演
  updateReplay(dt);  // demo 回放
  updateGrid();      // 网格显隐（跟随正俯视）
  updateRefmap();   // 参考图显隐
  cleanupStaleCursors();  // P9-15: 清理超时远程光标
  S.controls.update();
  S.renderer.render(S.scene, S.camera);
}

/* 启动（所有模块求值完毕后再初始化，避免 TDZ 错误） */
init();
