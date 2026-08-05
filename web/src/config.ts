// @ts-nocheck
/* ============================================================
 * 常量与规则：材质分类配色/正则、布料过滤关键词、画板标记定义
 * ============================================================ */

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
export const STORAGE_KEY_USER_ID = 'cs2-user-id';
export const STORAGE_KEY_NICKNAME = 'cs2-nickname';
export const STORAGE_KEY_ROOM = 'cs2-room';
export const MARKER_DEFS = {
  'marker-t':  { label: 'T',  color: 0xff7a3d, css: '#ff7a3d', big: true },
  'marker-ct': { label: 'CT', color: 0x5aa9ff, css: '#5aa9ff', big: true },
  'smoke':     { label: '烟', color: 0x9aa5ad, css: '#9aa5ad', big: false },
  'flash':     { label: '闪', color: 0xffe082, css: '#ffe082', big: false },
  'molotov':   { label: '火', color: 0xff7043, css: '#ff7043', big: false },
};

/* 演员（低模人形）队伍配色：T 金黄 / CT 蓝；仅人物、人物标签与回放视锥使用，
 * 不影响画板 T/CT 临时标记（MARKER_DEFS）颜色 */
export const ACTOR_DEFS = {
  t:  { color: 0xf5c518, css: '#f5c518' },
  ct: { color: 0x5aa9ff, css: '#5aa9ff' },
};
export const LINE_COLOR = 0xff5252;

export const r1 = v => Math.round(v * 10) / 10;
