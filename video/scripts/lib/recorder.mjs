// Screen recorder for the demo: drives the real app in a headless Chromium, captures it at full quality through the
// DevTools screencast (JPEG frames, not the low-bitrate built-in video), and encodes constant-frame-rate H.264 clips.
// A visible cursor and click highlight are injected into the page (headless browsers draw no OS cursor).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const videoRoot = path.resolve(here, '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium binary.');
}

export function ffmpegPath() {
  const p = path.join(videoRoot, 'node_modules', '@remotion', 'compositor-linux-x64-gnu', 'ffmpeg');
  if (!fs.existsSync(p)) throw new Error('Remotion ffmpeg not found. Run npm install in video/.');
  return p;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${err.slice(-1200)}`))));
  });
}

// Injected before any page script. A top-layer popover so it stays above open <dialog> elements.
const CURSOR_SCRIPT = `(() => {
  if (window.__cursorInstalled) return; window.__cursorInstalled = true;
  const mount = () => {
    const el = document.createElement('div');
    el.setAttribute('popover', 'manual');
    el.id = '__demo_cursor';
    const s = el.style;
    s.cssText = 'position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;width:0;height:0;left:0;top:0;';
    el.innerHTML = '<svg width="30" height="36" viewBox="0 0 30 36" style="position:absolute;left:0;top:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));overflow:visible"><path d="M2 2 L2 28 L8.5 22.5 L13 33 L18 31 L13.5 20.5 L22 20.5 Z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    try { el.showPopover(); } catch {}
    let x = -100, y = -100;
    const place = () => { s.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    const raise = () => { if (document.querySelector('dialog[open]')) { try { el.hidePopover(); el.showPopover(); } catch {} } };
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; place(); raise(); }, true);
    addEventListener('mousedown', (e) => {
      x = e.clientX; y = e.clientY; place(); raise();
      const r = document.createElement('div');
      r.style.cssText = 'position:absolute;left:-26px;top:-26px;width:52px;height:52px;border-radius:50%;border:3px solid #60cdff;background:rgba(96,205,255,.28);transform:scale(.3);opacity:1;transition:transform .45s cubic-bezier(.2,.7,.2,1),opacity .45s ease-out;';
      el.appendChild(r);
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0'; }));
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.documentElement) mount(); else addEventListener('DOMContentLoaded', mount);
})();`;

// Output is width x height pixels. The page is laid out at (width/scale) x (height/scale) CSS pixels so text is
// large enough to read in a video (1280x720 CSS px at 1.5x = a 1080p laptop screen at 150% display scaling).
export async function launch({ width = 1920, height = 1080, scale = 1.5, baseURL, storage } = {}) {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: Math.round(width / scale), height: Math.round(height / scale) }, deviceScaleFactor: scale, baseURL, colorScheme: 'light', acceptDownloads: true, ...(storage ? { storageState: storage } : {}) });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  return { browser, context, page };
}

export class Recorder {
  constructor(page, { fps = 30, width = 1920, height = 1080, outDir, quality = 90 } = {}) {
    Object.assign(this, { page, fps, width, height, outDir, quality });
    this.frames = [];       // { t: seconds since start (arrival), file }
    this.marks = [];        // { id, t }
    this.t0 = 0;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-rec-'));
    this.cursor = { x: 640, y: 360 }; // CSS pixels
  }

  now() { return (performance.now() - this.t0) / 1000; }

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.t0 = performance.now();
    this.n = 0;
    this.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      const file = path.join(this.tmp, `f${String(this.n++).padStart(6, '0')}.jpg`);
      this.frames.push({ t: this.now(), file });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      try { await this.cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* closing */ }
    });
    // A still page sends no frames, so seed the timeline with a real screenshot.
    const first = path.join(this.tmp, `f${String(this.n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(first, await this.page.screenshot({ type: 'jpeg', quality: this.quality }));
    this.frames.push({ t: 0, file: first });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 2 });
  }

  /** Start a new shot at the current moment. The previous shot ends here. */
  mark(id) { this.marks.push({ id, t: this.now() }); return this.now(); }

  /** Wait until the current shot has been running for at least `sec` seconds (screen keeps animating meanwhile). */
  async holdUntil(sec) {
    const m = this.marks[this.marks.length - 1];
    if (!m) return;
    const left = sec - (this.now() - m.t);
    if (left > 0) await sleep(left * 1000);
  }

  async stop() {
    this.endT = this.now();
    try { await this.cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
    // Final settled frame so the last shot ends on the true end state.
    const last = path.join(this.tmp, `f${String(this.n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(last, await this.page.screenshot({ type: 'jpeg', quality: this.quality }));
    this.frames.push({ t: this.endT, file: last });
  }

  frameAt(t) {
    let best = this.frames[0];
    for (const f of this.frames) { if (f.t <= t) best = f; else break; }
    return best;
  }

  /** Encode every marked shot to <outDir>/<id>.mp4 (H.264, constant frame rate). Returns { id: durationSec }.
   *  Each output frame is the most recent screencast frame at that moment, written out as a numbered image sequence:
   *  no timing tricks, so a clip is always exactly round(duration * fps) frames long. */
  async encodeShots(nameFor = (id) => id) {
    fs.mkdirSync(this.outDir, { recursive: true });
    const out = {};
    for (let i = 0; i < this.marks.length; i++) {
      const id = this.marks[i].id;
      if (id.startsWith('_')) continue; // unrecorded setup between shots
      const a = this.marks[i].t;
      const b = i + 1 < this.marks.length ? this.marks[i + 1].t : this.endT;
      const n = Math.max(1, Math.round((b - a) * this.fps));
      const dir = path.join(this.tmp, `seq-${id}`);
      fs.mkdirSync(dir, { recursive: true });
      let k = 0; // index of the latest screencast frame at or before t
      while (k + 1 < this.frames.length && this.frames[k + 1].t <= a) k++;
      for (let f = 0; f < n; f++) {
        const t = a + f / this.fps;
        while (k + 1 < this.frames.length && this.frames[k + 1].t <= t) k++;
        fs.symlinkSync(this.frames[k].file, path.join(dir, `${String(f).padStart(6, '0')}.jpg`));
      }
      const file = path.join(this.outDir, `${nameFor(id)}.mp4`);
      await run(ffmpegPath(), ['-y', '-loglevel', 'error', '-framerate', String(this.fps), '-i', path.join(dir, '%06d.jpg'),
        '-vf', `scale=${this.width}:${this.height}:flags=lanczos,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-movflags', '+faststart', '-an', file]);
      fs.rmSync(dir, { recursive: true, force: true });
      out[id] = Number((n / this.fps).toFixed(3));
    }
    return out;
  }

  cleanup() { fs.rmSync(this.tmp, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ human-looking input
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export async function moveTo(page, rec, x, y, ms = 650) {
  const from = { ...rec.cursor };
  const dist = Math.hypot(x - from.x, y - from.y);
  const dur = Math.min(ms * 1.4, Math.max(260, ms * Math.min(1, dist / 700 + 0.35)));
  const steps = Math.max(8, Math.round(dur / 16));
  for (let i = 1; i <= steps; i++) {
    const e = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(dur / steps);
  }
  rec.cursor = { x, y };
}

async function centerOf(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${target}`);
  return { loc, x: box.x + box.width * 0.5, y: box.y + box.height * 0.5, box };
}

export async function click(page, rec, target, { ms = 520, settle = 150 } = {}) {
  const { x, y } = await centerOf(page, target);
  await moveTo(page, rec, x, y, ms);
  await sleep(settle);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
}

export async function typeInto(page, rec, target, text, { delay = 45, ms = 520 } = {}) {
  await click(page, rec, target, { ms });
  await sleep(180);
  await page.keyboard.type(text, { delay });
}

export async function rectOf(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await loc.waitFor({ state: 'visible', timeout: 20000 });
  const b = await loc.boundingBox();
  return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
}
