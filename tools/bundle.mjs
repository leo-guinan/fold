// Browser bundles of the engine, and each demo's page bundle (plus a Node bundle of its scene for tests).
import { build } from 'esbuild'; import fs from 'node:fs';
const common = { bundle: true, target: 'es2022', sourcemap: true, legalComments: 'none' };
await build({ ...common, entryPoints: ['src/index.ts'], format: 'iife', globalName: 'Fold', outfile: 'dist/fold.iife.js' });
await build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/fold.esm.js' });
for (const d of fs.readdirSync('demos', { withFileTypes: true }).filter(d => d.isDirectory())) {
  const dir = `demos/${d.name}`;
  if (fs.existsSync(`${dir}/main.ts`)) await build({ ...common, entryPoints: [`${dir}/main.ts`], format: 'esm', outfile: `${dir}/dist/app.js` });
  if (fs.existsSync(`${dir}/scene.ts`)) await build({ ...common, entryPoints: [`${dir}/scene.ts`], format: 'esm', platform: 'node', outfile: `${dir}/dist/scene.mjs` });
}
console.log('bundled engine and demos');
