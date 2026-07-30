// @ts-nocheck
/* ------------------------------------------------------------
 * 唯一工具状态机：任意时刻只有一个工具/面板激活。
 * 各模块通过 registerMode 注册 { enter, exit }：
 *   exit 负责清理光标样式、controls.enabled、临时图形、body class；
 * setMode 切换时先退旧模式再进新模式，从根上杜绝多工具抢鼠标。
 * Esc / 点「浏览模式」→ browse（空工具）。
 * ---------------------------------------------------------- */
import { controls } from './state';

export const BOARD_TOOLS = ['select', 'brush', 'marker-t', 'marker-ct', 'smoke', 'flash', 'molotov', 'eraser'];

const MODES = {};            // name -> { enter?, exit?, label, toggleOff? }
let current = 'browse';

export function registerMode(name, def) { MODES[name] = def; }
export function getMode() { return current; }
export function isBoardTool(name) { return BOARD_TOOLS.includes(name ?? current); }

export function setMode(name) {
  if (!MODES[name]) return;
  // 面板类模式重复点击 = 关闭（回 browse）
  if (name === current) {
    if (!MODES[name].toggleOff) return;
    name = 'browse';
  }
  const prev = MODES[current];
  if (prev && prev.exit) prev.exit();
  current = name;
  if (controls) controls.enabled = true; // 统一兜底：任何模式退出后镜头可用
  const next = MODES[current];
  if (next && next.enter) next.enter();
  refreshToolUI();
}

/* 侧边栏高亮 + 顶部模式徽章 */
function refreshToolUI() {
  document.querySelectorAll('#sidebar button[data-mode]').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === current);
  });
  const badge = document.getElementById('mode-badge');
  if (badge) {
    badge.textContent = MODES[current]?.label || '👁 浏览模式';
    badge.classList.toggle('active', current !== 'browse');
  }
}

/* 浏览模式（空工具，默认态） */
registerMode('browse', { label: '👁 浏览模式' });

export function initTools() {
  document.querySelectorAll('#sidebar button[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  // 侧边栏折叠/展开（收起仅图标）
  const sb = document.getElementById('sidebar');
  const applyCollapse = (on) => {
    sb.classList.toggle('collapsed', on);
    document.getElementById('sidebar-toggle').textContent = on ? '»' : '«';
  };
  applyCollapse(localStorage.getItem('cs2-sidebar') === 'collapsed');
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const on = !sb.classList.contains('collapsed');
    localStorage.setItem('cs2-sidebar', on ? 'collapsed' : 'expanded');
    applyCollapse(on);
  });

  window.addEventListener('keydown', e => {
    if (e.code !== 'Escape') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    setMode('browse');
  });
  refreshToolUI();
}
