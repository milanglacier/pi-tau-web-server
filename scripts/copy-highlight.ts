// Copy the JavaScript highlighter into the served UI so it works offline.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const assets = path.dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(projectRoot, 'public', 'vendor', 'highlight');

fs.mkdirSync(vendorDir, { recursive: true });
for (const [source, target] of [
  ['es/core.min.js', 'core.min.js'],
  ['es/languages/javascript.min.js', 'javascript.min.js'],
  ['LICENSE', 'LICENSE'],
]) {
  fs.copyFileSync(path.join(assets, source), path.join(vendorDir, target));
}
