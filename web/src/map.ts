// @ts-nocheck
/* ------------------------------------------------------------
 * 地图加载：官方 de_dust2 模型，几何原样保留，仅合并静态网格
 * （不减面）；材质纯色分类；地面碰撞层 BVH 绑定；onMapReady
 * ---------------------------------------------------------- */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, categorize, matchClothKeyword } from './config';
import { scene, controls, mapBounds, setMapGroup, setMapBounds, setCollisionMesh } from './state';
import { resetCamera, setTopView } from './camera';
import { restoreBoard } from './board';
import { buildGrid } from './grid';
import { buildRefmap } from './refmap';

export function loadMap() {
  const bar = document.getElementById('load-bar');
  const pct = document.getElementById('load-pct');
  const loader = new GLTFLoader();
  // Draco 压缩模型（data/models/ 管线产物）
  const draco = new DRACOLoader();
  draco.setDecoderPath('libs/draco/'); // 本地解码器，避免 CDN Worker 问题
  loader.setDRACOLoader(draco);

  loader.load(
    'data/models/de_dust2.glb',
    (gltf) => {
      pct.textContent = '解析几何体…';
      buildMergedMap(gltf.scene);
      document.getElementById('loading').style.display = 'none';
      onMapReady();
    },
    (ev) => {
      if (ev.total > 0) {
        const p = Math.round(ev.loaded / ev.total * 100);
        bar.style.width = p + '%';
        pct.textContent = `${p}%（${Math.round(ev.loaded / 1048576)} / ${Math.round(ev.total / 1048576)} MB）`;
      } else {
        pct.textContent = `已下载 ${Math.round(ev.loaded / 1048576)} MB…`;
      }
    },
    (err) => {
      pct.textContent = '加载失败：' + err.message;
      console.error(err);
    }
  );
}

/* 按分类合并静态网格（性能优化手段，不删除任何可见几何）
 * 过滤规则（仅影响渲染，不改模型文件，可随时恢复）：
 *  1) 名称命中布料/物理关键词（按非字母数字切分后整词匹配）
 *  2) 蒙皮网格（isSkinnedMesh）：布料模拟物件，蒙皮丢失后顶点拉伸变形
 * 过滤与保留名单均打印到 console 供核对
 */
function buildMergedMap(root) {
  root.updateMatrixWorld(true);
  const buckets = { ground: [], wall: [], prop: [] };
  const filteredCloth = [];   // 布料/物理/蒙皮过滤名单
  const keptNames = new Set(); // 保留名单（核对误删用）
  const seenGeo = new Set();   // 共享几何体去重（防矩阵重复应用）
  let hiddenCount = 0;

  root.traverse(obj => {
    if (!obj.isMesh) return;
    const name = obj.name || '';

    // --- 布料模拟 / 物理 / LOD 过滤 ---
    const kw = matchClothKeyword(name) || matchClothKeyword(obj.geometry && obj.geometry.name);
    if (kw) {
      filteredCloth.push(`${name}（关键词: ${kw}）`);
      return; // 不加入场景 = 移除渲染；模型文件未动
    }
    if (obj.isSkinnedMesh) {
      filteredCloth.push(`${name}（蒙皮网格）`);
      return;
    }

    const cat = categorize(name);
    if (cat === 'hidden') { hiddenCount++; return; }

    // 同一 geometry 被多个节点共享时必须先克隆，否则矩阵会被重复应用
    const geo = seenGeo.has(obj.geometry) ? obj.geometry.clone() : obj.geometry;
    seenGeo.add(obj.geometry);
    // 就地应用世界变换（原 gltf 场景随后整体丢弃）
    // 保留索引：全部有索引时走索引合并，渲染顶点数可降约 3 倍
    geo.applyMatrix4(obj.matrixWorld);
    // 只保留 position + normal，便于跨网格合并
    for (const key of Object.keys(geo.attributes)) {
      if (key !== 'position' && key !== 'normal') geo.deleteAttribute(key);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.morphAttributes = {};
    buckets[cat].push(geo);
    keptNames.add(name.replace(/\.meshset.*$/, ''));
  });

  console.log(`[filter] 已过滤布料/物理/LOD/蒙皮节点 ${filteredCloth.length} 个：`, filteredCloth);
  console.log(`[filter] 保留的网格名（${keptNames.size} 种，核对是否误删用）:`, [...keptNames].sort());
  console.log(`[map] 隐藏工具网格 ${hiddenCount} 个；合并：ground=${buckets.ground.length} wall=${buckets.wall.length} prop=${buckets.prop.length}`);

  const mg = new THREE.Group();
  mg.name = 'dust2-map';
  for (const cat of ['ground', 'wall', 'prop']) {
    if (!buckets[cat].length) continue;
    // 全索引几何体直接合并（省顶点）；有非索引混入时统一转非索引再合并
    const allIndexed = buckets[cat].every(g => g.index);
    const inputs = allIndexed ? buckets[cat] : buckets[cat].map(g => (g.index ? g.toNonIndexed() : g));
    const merged = BufferGeometryUtils.mergeGeometries(inputs, false);
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: COLORS[cat] }));
    mesh.name = `map-${cat}`;
    mg.add(mesh);
  }

  // 按模型实际包围盒归一化：最长水平边 = 240，底面中心对齐原点
  const bbox = new THREE.Box3().setFromObject(mg);
  const size = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());
  const s = 240 / Math.max(size.x, size.z);
  mg.scale.setScalar(s);
  mg.position.set(-center.x * s, -bbox.min.y * s, -center.z * s);
  scene.add(mg);
  setMapGroup(mg);

  mg.updateMatrixWorld(true);
  setMapBounds(new THREE.Box3().setFromObject(mg));

  // 地面碰撞层：区域投影只 raycast 它，并为它构建 BVH
  const cm = mg.getObjectByName('map-ground') || null;
  setCollisionMesh(cm);
  if (cm) cm.geometry.computeBoundsTree();
  console.log('[map] 归一化后包围盒', mapBounds);
}

function onMapReady() {
  controls.maxDistance = mapBounds.getSize(new THREE.Vector3()).length() * 2;
  resetCamera();
  restoreBoard(); // 恢复上次保存的标记和线条
  buildGrid();      // 坐标网格叠加层（正俯视+开关时显示）
  buildRefmap();    // 参考图对照层（正俯视+开关时显示）
  window.__mapReady = true; // e2e 就绪信号

  // 正俯视截图模式（?shot=1）
  if (new URLSearchParams(location.search).has('shot')) {
    document.body.classList.add('shot');
    setTopView();
  }
}
