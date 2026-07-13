// Copies the KaTeX runtime assets from node_modules into public/vendor/katex/
// so the served UI is self-contained and works offline. Only woff2 fonts are
// copied: KaTeX's CSS lists woff2 first in every @font-face src(), so browsers
// that can run this app never request the woff/ttf fallbacks.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

let katexDist;
try {
  katexDist = path.join(path.dirname(require.resolve('katex/package.json')), 'dist');
} catch {
  console.error('copy-katex: cannot resolve the "katex" package — run `npm install` first.');
  process.exit(1);
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(projectRoot, 'public', 'vendor', 'katex');
const fontsDir = path.join(vendorDir, 'fonts');

fs.mkdirSync(fontsDir, { recursive: true });
for (const file of ['katex.min.js', 'katex.min.css']) {
  fs.copyFileSync(path.join(katexDist, file), path.join(vendorDir, file));
}
for (const font of fs.readdirSync(path.join(katexDist, 'fonts'))) {
  if (font.endsWith('.woff2')) {
    fs.copyFileSync(path.join(katexDist, 'fonts', font), path.join(fontsDir, font));
  }
}
