// @ts-nocheck
/* ------------------------------------------------------------
 * Source 引擎坐标 → 战术板世界坐标（demo 回放用）
 * Source 单位为英寸（0.0254 m/in），Source: x前 y左 z上；
 * gltf 场景: y 上。映射：(x,y,z) → (x*S, z*S, -y*S)，
 * 再经 mapGroup.localToWorld 套用建图时的归一化变换。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { mapGroup } from './state';

const SOURCE_TO_M = 0.0254;

/* out 可复用；mapGroup 未就绪时返回未归一化的 gltf 坐标 */
export function sourceToWorld(sx, sy, sz, out) {
  const v = out || new THREE.Vector3();
  v.set(sx * SOURCE_TO_M, sz * SOURCE_TO_M, -sy * SOURCE_TO_M);
  return mapGroup ? mapGroup.localToWorld(v) : v;
}

/* Source yaw（度，绕 z 轴 CCW，0=+x）→ three 绕 Y 旋转（弧度） */
export function sourceYawToRadians(yawDeg) {
  return THREE.MathUtils.degToRad(yawDeg);
}
