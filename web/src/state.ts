// @ts-nocheck
/* ============================================================
 * 共享状态：scene/camera/renderer/controls 由 main.ts 装配后经
 * setCore 注入；mapGroup/mapBounds/collisionMesh 由 map.ts 建图
 * 后注入。其他模块一律通过 live binding 在函数内读取。
 * three-mesh-bvh 的 prototype 补丁放在这里：本模块是所有模块的
 * 共同依赖，且 main.ts 第一个导入它，保证补丁最早执行。
 * ============================================================ */
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

/* BVH 加速射线（贴地投影采样量大，必须用） */
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export let scene = null;
export let camera = null;
export let renderer = null;
export let controls = null;
export let mapGroup = null;
export let mapBounds = null;      // 模型实际包围盒（归一化后）
export let collisionMesh = null;  // 地面碰撞层（仅 map-ground，区域投影只打它，忽略树/栏杆/箱子）
export const flyClock = new THREE.Clock();

/* ---- P9 多人协同 ---- */
export let isMultiplayer = false;
export let myUserId: string | null = null;
export let roomCode: string | null = null;

export function setMultiplayer(v: boolean): void { isMultiplayer = v; }
export function setMyUserId(v: string | null): void { myUserId = v; }
export function setRoomCode(v: string | null): void { roomCode = v; }

export function setCore(s, c, r, ctl) { scene = s; camera = c; renderer = r; controls = ctl; }
export function setMapGroup(g) { mapGroup = g; }
export function setMapBounds(b) { mapBounds = b; }
export function setCollisionMesh(m) { collisionMesh = m; }
