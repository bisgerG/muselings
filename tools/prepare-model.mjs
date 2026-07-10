/**
 * prepare-model.mjs — 模型前處理
 * 1. KHR_materials_pbrSpecularGlossiness → 標準 metallic-roughness（新版 three.js 必需）
 * 2. 只保留遊戲需要的動畫剪輯（用子字串比對）
 * 3. prune 清除無引用資源，並輸出模型尺寸供場景縮放參考
 *
 * 用法: node prepare-model.mjs <input.glb> <output.glb> <keep1,keep2,...>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { metalRough, prune, dedup, getBounds } from '@gltf-transform/functions';

const [input, output, keepArg] = process.argv.slice(2);
if (!input || !output || !keepArg) {
  console.error('usage: node prepare-model.mjs <input.glb> <output.glb> <keep1,keep2,...>');
  process.exit(1);
}
const keepPatterns = keepArg.split(',').map(s => s.trim().toLowerCase());

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);

// 1. 材質格式轉換
await doc.transform(metalRough());

// 2. 動畫瘦身
const anims = doc.getRoot().listAnimations();
let kept = 0, removed = 0;
for (const anim of anims) {
  const name = (anim.getName() || '').toLowerCase();
  if (keepPatterns.some(p => name.includes(p))) {
    console.log('KEEP  ' + anim.getName());
    kept++;
  } else {
    anim.dispose();
    removed++;
  }
}
console.log(`animations: kept ${kept}, removed ${removed}`);

// 3. 清理 + 尺寸資訊
await doc.transform(dedup(), prune());
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
const { min, max } = getBounds(scene);
console.log('bounds min:', min.map(v => v.toFixed(3)).join(', '));
console.log('bounds max:', max.map(v => v.toFixed(3)).join(', '));
console.log('size (x,y,z):', max.map((v, i) => (v - min[i]).toFixed(3)).join(', '));

await io.write(output, doc);
console.log('written:', output);
