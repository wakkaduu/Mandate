#!/usr/bin/env node
// Sync public/clips/manifest.json with the .mp4 files that exist: read each clip's real duration, keep the capture
// data (highlight-ring positions) for clips the capture script made, and register clips you recorded by hand.
// Run automatically by `npm run render` and `npm run studio`. Also prints which shots still have no clip.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clipsDir = path.join(root, 'public', 'clips');
const manifestPath = path.join(clipsDir, 'manifest.json');
const ffprobe = path.join(root, 'node_modules', '@remotion', 'compositor-linux-x64-gnu', 'ffprobe');

export function probe({ quiet = false } = {}) {
  fs.mkdirSync(clipsDir, { recursive: true });
  const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { clips: {}, rings: {} };
  const next = { viewport: old.viewport ?? { width: 1920, height: 1080 }, clips: {}, rings: {}, settle: {}, overlays: {} };
  for (const f of fs.readdirSync(clipsDir).filter((x) => x.endsWith('.mp4')).sort()) {
    const id = f.replace(/\.mp4$/, '');
    const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path.join(clipsDir, f)], { encoding: 'utf8' });
    const sec = Number(r.stdout.trim());
    if (!Number.isFinite(sec) || sec <= 0) { console.warn(`! ${f}: not a readable video, ignored`); continue; }
    const prev = old.clips?.[id];
    // The capture script writes the manifest after encoding, so its clips are never newer than `recordedAt`.
    // A file saved later (a clip you recorded by hand, or re-recorded) is registered as manual.
    const mtime = fs.statSync(path.join(clipsDir, f)).mtimeMs;
    const sameFile = Boolean(prev?.recordedAt) && prev.source === 'auto' && mtime <= Date.parse(prev.recordedAt) + 2000;
    next.clips[id] = { durationSec: Number(sec.toFixed(3)), source: sameFile ? prev.source : 'manual', ...(sameFile ? { recordedAt: prev.recordedAt } : {}) };
    if (old.rings?.[id] && sameFile) next.rings[id] = old.rings[id];
    if (old.settle?.[id] !== undefined && sameFile) next.settle[id] = old.settle[id];
    if (old.overlays?.[id] && sameFile) next.overlays[id] = old.overlays[id];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2));

  const shots = JSON.parse(fs.readFileSync(path.join(root, 'shots.json'), 'utf8'));
  const missing = [];
  for (const sc of shots.scenes) for (const sh of sc.shots) if (sh.kind === 'clip' && !next.clips[sh.clip]) missing.push({ sceneId: sc.id, ...sh });
  if (!quiet) {
    console.log(`${Object.keys(next.clips).length} clips on disk (${Object.values(next.clips).filter((c) => c.source === 'manual').length} recorded by hand).`);
    if (missing.length) {
      console.log(`${missing.length} shots have no clip yet (the cut shows a placeholder for each):`);
      for (const m of missing) console.log(`  ${m.clip.padEnd(14)} ${m.recorder === 'manual' ? '[by hand]' : '[capture]'}  ${m.note ?? m.narration}`);
    }
  }
  return { manifest: next, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) probe();
