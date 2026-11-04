// Copies the AG Grid bundle from node_modules into public/vendor so it is served as a plain static asset
// (by Express locally/on Render, by the CDN on Vercel). Runs on postinstall and as the Vercel build step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.js');
const dest = path.join(root, 'public', 'vendor', 'ag-grid', 'ag-grid-community.min.js');
if (!fs.existsSync(src)) {
  console.warn('[copy-vendor] ag-grid-community not installed yet; skipping');
  process.exit(0);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[copy-vendor] ${path.relative(root, dest)} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
