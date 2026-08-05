// @ts-nocheck
/* ------------------------------------------------------------
 * 唯一坐标转换入口：CS2 游戏世界坐标 → 战术板场景坐标。
 * 出生点、道具落点、demo 轨迹、标记点一律走 worldToScene。
 *
 * 依据（map_export/maps/de_dust2.gltf 实测）：
 * Source2Viewer 导出时全部静态网格节点共用同一矩阵，
 * 把 Source 世界坐标（单位 0.0254 m/in，x 东 y 北 z 上）映射为
 *   gltf_world = (local_z, local_x, local_y) * 0.0254
 * 地图地面在 XY 平面（非标准 Three.js XZ），轴交换补偿此差异。
 * 再经 mapGroup.localToWorld 套用建图时的归一化（缩放+平移）。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { mapGroup } from './state';

const SOURCE_TO_M = 0.0254;

/* out 可复用；mapGroup 未就绪时返回未归一化的 gltf 坐标 */
export function worldToScene(sx, sy, sz, out) {
  const v = out || new THREE.Vector3();
  v.set(sy * SOURCE_TO_M, sz * SOURCE_TO_M, sx * SOURCE_TO_M);
  return mapGroup ? mapGroup.localToWorld(v) : v;
}

/* 逆变换：场景坐标 → CS2 游戏世界坐标（网格坐标换算用） */
export function sceneToSource(sceneV, out) {
  const v = out || new THREE.Vector3();
  v.copy(sceneV);
  if (mapGroup) mapGroup.worldToLocal(v);
  v.set(v.z / SOURCE_TO_M, v.x / SOURCE_TO_M, v.y / SOURCE_TO_M);
  return v;
}

/* Source yaw（度，0=+X 东，逆时针增加，实测与击杀朝向一致）→ three 绕 Y 旋转（弧度）。
 * Source 前向 (cosψ, sinψ, 0) 映射为 scene (sinψ, 0, cosψ)，
 * 与模型局部 +z 经 rotation.y=θ 的朝向 (sinθ, 0, cosθ) 对齐 → θ = ψ */
export function sourceYawToRadians(yawDeg) {
  return THREE.MathUtils.degToRad(yawDeg);
}
