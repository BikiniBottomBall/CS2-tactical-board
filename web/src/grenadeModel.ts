// @ts-nocheck
/* ------------------------------------------------------------
 * P13.2.4 投掷物 3D 模型：GLB 模板（web/public/models/）→ 按类型克隆
 *   molotov / incendiary → 燃烧瓶；smoke / flash / he / 其他 → 军用手雷
 * 颜色沿用 MARKER_DEFS（扁平纯色，保持战术板风格）。
 * 加载失败 / 未就绪时回退同色球体，功能不受网络与资产缺失影响。
 * 克隆实例：几何与模板共享并标记 userData.shared = true，
 * dispose 时仅释放按实例新建的材质，避免破坏模板。
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MARKER_DEFS } from './config';

const GRENADE_TARGET = 1.2;  // 手雷最长轴（场景单位）
const MOLOTOV_TARGET = 1.4;  // 燃烧瓶最长轴（场景单位）

let grenadeTemplate: THREE.Object3D | null = null;
let molotovTemplate: THREE.Object3D | null = null;
let loading: Promise<void> | null = null;
let modelsFailed = false;

/* 归一化模板：缩放到目标尺寸，并把包围盒中心烘焙进几何（局部原点） */
function normalize(root: THREE.Object3D, target: number): THREE.Object3D {
  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  root.scale.setScalar(target / maxDim);
  root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  root.traverse(o => {
    if (o.isMesh && o.geometry) {
      o.geometry = o.geometry.clone();           // 模板几何私有化，烘焙中心
      o.geometry.translate(-center.x, -center.y, -center.z);
      o.position.set(0, 0, 0);
    }
  });
  root.updateMatrixWorld(true);
  return root;
}

/* 幂等预加载；失败仅 console.warn，不抛错 */
export function ensureGrenadeModels(): Promise<void> {
  if (loading) return loading;
  if (modelsFailed || (grenadeTemplate && molotovTemplate)) return Promise.resolve();

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('libs/draco/');
  loader.setDRACOLoader(draco);

  const loadOne = (url: string): Promise<THREE.Object3D | null> =>
    new Promise(resolve => {
      loader.load(
        url,
        gltf => resolve(gltf.scene),
        undefined,
        err => {
          console.warn('[grenadeModel] 模型加载失败，回退球体:', url, (err && err.message) || err);
          resolve(null);
        }
      );
    });

  loading = Promise.all([
    loadOne('models/grenade.glb').then(scene => {
      if (scene) grenadeTemplate = normalize(scene, GRENADE_TARGET);
    }),
    loadOne('models/molotov.glb').then(scene => {
      if (scene) molotovTemplate = normalize(scene, MOLOTOV_TARGET);
    }),
  ]).then(() => {
    loading = null;
    if (!grenadeTemplate && !molotovTemplate) modelsFailed = true;
  });
  return loading;
}

export function isGrenadeModelsReady(): boolean {
  return !!(grenadeTemplate && molotovTemplate);
}

/* 创建单个投掷物实例：按类型克隆 GLB 并着色；未就绪/失败回退同色球体 */
export function createProjectileVisual(type: string): THREE.Object3D {
  const def = MARKER_DEFS[type] || MARKER_DEFS.smoke;
  const isMolotov = type === 'molotov' || type === 'incendiary';
  const template = isMolotov ? molotovTemplate : grenadeTemplate;

  if (template) {
    const root = template.clone(true);
    root.traverse(o => {
      if (!o.isMesh) return;
      o.material = new THREE.MeshBasicMaterial({ color: def.color });
      if (o.geometry) o.geometry.userData.shared = true;   // 与模板共享几何，释放时跳过
    });
    return root;
  }
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 12, 12),
    new THREE.MeshBasicMaterial({ color: def.color })
  );
}

/* 释放实例：材质（含贴图）按实例新建，可安全 dispose；共享几何跳过 */
export function disposeProjectileVisual(obj: THREE.Object3D) {
  obj.traverse(o => {
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}
