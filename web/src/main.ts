// @ts-nocheck
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
import { initCalib } from './calib';
import { initUtility, updateUtility } from './utility';
import { initTactic, updateTactic } from './tactic';
import { initReplay, updateReplay } from './replay';

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
  const sel = document.getElementById('sel-quality');
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
  initCalib();
  initUtility();
  initTactic();
  initReplay();

  // 正俯视 / 斜 45° 切换按钮
  document.getElementById('btn-topview').addEventListener('click', () => {
    if (isTopView) resetCamera();
    else setTopView();
  });

  window.addEventListener('resize', handleResize);

  loadMap();
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(S.flyClock.getDelta(), 0.1);
  updateFlyControls(dt);
  updateUtility(dt); // 道具播放/效果/预览脉冲
  updateTactic(dt);  // 战术推演
  updateReplay(dt);  // demo 回放
  S.controls.update();
  S.renderer.render(S.scene, S.camera);
}

/* 启动（所有模块求值完毕后再初始化，避免 TDZ 错误） */
init();
