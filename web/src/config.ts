// @ts-nocheck
/* ============================================================
 * 常量与规则：材质分类配色/正则、布料过滤关键词、画板标记定义、
 * 标注颜色、投影选区阈值、校准模式鼠标映射
 * ============================================================ */
import * as THREE from 'three';

/* 纯色材质分类规则（雷达图配色）
 * 按节点名启发式分类；HIDDEN 是编辑器工具网格（游戏内不可见） */
export const COLORS = {
  ground: 0xc9b28c,  // 地面/道路：浅沙色
  wall:   0x7d828a,  // 墙体/建筑：深灰色
  prop:   0x9a7a4e,  // 箱子/掩体道具：棕色
};

/* 编辑器工具网格 + alpha 贴片/特效片（电线/晾布/藤蔓/蒸汽/光柱/浮尘卡，去贴图后变实心碎片） */
export const RE_HIDDEN = /blocklight|overlay|nodraw|skybox|_sky|clipbrush|trigger|wire|leaves|weed|agave|awning|tarp|fabric|rope|laundry|chainlink|_card|cloth|vine|ivy|steam|lightshaft|light_shaft|dust_001/i;
export const RE_GROUND = /ground|asphalt|sand|floortile|brick_ground|curb|road/i;
export const RE_PROP   = /crate|pallet|\bcart|\bcar|truck|drum|barrel|sack|detruis|basket|pottery|terracotta|dumpster|garbage|box|chair|umbrella|door_\d|table|shelf|vehicle/i;

export function categorize(name) {
  if (RE_HIDDEN.test(name)) return 'hidden';
  if (RE_GROUND.test(name)) return 'ground';
  if (RE_PROP.test(name)) return 'prop';
  return 'wall';
}

/* 布料模拟 / 物理 / LOD 过滤关键词（按非字母数字切分后整词匹配） */
export const CLOTH_KEYWORDS = ['cloth', 'awning', 'tarp', 'flag', 'fabric', 'curtain', 'canopy', 'physics', 'collision', 'shadow', 'lod'];

export function matchClothKeyword(name) {
  if (!name) return null;
  const segs = String(name).toLowerCase().split(/[^a-z0-9]+/);
  return CLOTH_KEYWORDS.find(k => segs.includes(k)) || null;
}

/* ---- 战术板 ---- */
export const STORAGE_KEY_BOARD = 'cs2-board-v1';
export const MARKER_DEFS = {
  'marker-t':  { label: 'T',  color: 0xff7a3d, css: '#ff7a3d', big: true },
  'marker-ct': { label: 'CT', color: 0x5aa9ff, css: '#5aa9ff', big: true },
  'smoke':     { label: '烟', color: 0x9aa5ad, css: '#9aa5ad', big: false },
  'flash':     { label: '闪', color: 0xffe082, css: '#ffe082', big: false },
  'molotov':   { label: '火', color: 0xff7043, css: '#ff7043', big: false },
};
export const LINE_COLOR = 0xff5252;

/* ---- 点位/区域标注 ---- */
export const POINT_COLORS = {
  'A点': '#ffa940', 'B点': '#5aa9ff',
  '警家': '#7ec8ff', '匪家': '#ff7a3d',
};

export function pointColor(name) { return POINT_COLORS[name] || '#ffffff'; }
export const r1 = v => Math.round(v * 10) / 10;

/* ---- 表面贴合投影选区阈值 ---- */
export const GROUND_NORMAL_MIN = 0.55; // 陡面剔除阈值
export const FLOOR_WINDOW = 4;         // 楼层过滤窗口（floorY ± 4）
export const EDGE_DY_MAX = 2.5;        // 相邻采样点高差阈值（超过断开）
export const REGION_GRID_STEP = 2;     // 栅格采样基础步长

/* ---- 校准模式鼠标映射 ---- */
export const MOUSE_BROWSE = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
export const MOUSE_CALIB = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
