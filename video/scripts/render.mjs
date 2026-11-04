#!/usr/bin/env node
// Render the cut: syncs the clip manifest, then runs Remotion (H.264, 1080p, 30 fps, AAC voice-over).
//   npm run render                 -> out/mandate-demo.mp4        (or out/mandate-demo-draft.mp4 while clips are missing)
//   npm run render -- --frames=0-300   extra arguments go straight to `remotion render` (e.g. a quick preview range)
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from './probe-clips.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { missing } = probe();
const name = missing.length ? 'mandate-demo-draft.mp4' : 'mandate-demo.mp4';
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
const out = path.join('out', name);
console.log(`\nRendering ${out}${missing.length ? '  (DRAFT: placeholders in the cut)' : ''}\n`);
const r = spawnSync(path.join(root, 'node_modules', '.bin', 'remotion'),
  ['render', 'src/index.jsx', 'Demo', out, '--codec=h264', '--audio-codec=aac', '--crf=16', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
