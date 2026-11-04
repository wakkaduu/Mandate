#!/usr/bin/env node
// Record the app for the demo: drives the real Mandate app (PayPal sandbox, live assistant and web search) through the
// storyboard in a headless browser and writes one clip per shot to public/clips/, plus clips/manifest.json (clip
// durations and the screen positions of the highlight rings).
//
//   npm run capture                      all automatic scenes, fresh session
//   npm run capture -- ask suggest       only these scenes, continuing the saved session (needs the same server/database)
//   BASE_URL=http://localhost:3101 npm run capture
//
// Start the server first, with the recording settings (an isolated database keeps your real data out of it):
//   PORT=3101 DATABASE_PATH=/tmp/mandate-video.db REFUND_COOLING_OFF_SECONDS=8 HIGH_VALUE_USD=30 npm start   (from the repo root)
//
// The PayPal approval (scene "paypal") signs in to PayPal's SANDBOX with the test buyer from ../accounts (the first
// "sb-...@personal.example.com" entry and the line after it) in a plain headless browser, and approves one sandbox
// payment; scene "refund" then refunds it. Both need the scenes before them (ask, approve) in the same session.
import fs from 'node:fs';
import path from 'node:path';
import { Recorder, launch, click, typeInto, moveTo, rectOf, sleep, videoRoot } from './lib/recorder.mjs';
import { buildTimeline } from '../src/timing.js';

const BASE = (process.env.BASE_URL || 'http://localhost:3101').replace(/\/$/, '');
const SCALE = 1.5;
const clipsDir = path.join(videoRoot, 'public', 'clips');
const manifestPath = path.join(clipsDir, 'manifest.json');
const statePath = path.join(videoRoot, '.capture-state.json');
const debugDir = path.join(videoRoot, '.capture-debug');

const shots = JSON.parse(fs.readFileSync(path.join(videoRoot, 'shots.json'), 'utf8'));
const narration = JSON.parse(fs.readFileSync(path.join(videoRoot, 'public', 'narration', 'manifest.json'), 'utf8'));
const timeline = buildTimeline(shots, narration);
const dur = Object.fromEntries(timeline.items.map((i) => [`${i.sceneId}-${i.shot.id}`, i.durSec]));

const wantedScenes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const AUTO = ['hook', 'mandate', 'ask', 'approve', 'paypal', 'refund', 'suggest', 'audit', 'close'];
const scenes = wantedScenes.length ? wantedScenes : AUTO;
const resume = wantedScenes.length > 0 && fs.existsSync(statePath);

// Fail early if the app is not up in the expected mode.
const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json()).catch(() => null);
if (!cfg) { console.error(`No app at ${BASE}. Start the server first (see the header of this file).`); process.exit(1); }
console.log(`App at ${BASE}: paypal=${cfg.paypalMode}, assistant=${cfg.agentMode}, refund delay ${cfg.refundCoolingSeconds}s, high-value from $${(cfg.highValueCents / 100).toFixed(2)}`);
if (cfg.paypalMode !== 'sandbox') console.warn('! The app is not in PayPal sandbox mode; the narration says PayPal, so record against the sandbox.');
if (!cfg.aiEnabled) { console.error('The assistant is not configured (no AI key); the ask and suggest scenes need it.'); process.exit(1); }

// A resumed session keeps the app's cookie and settings but not PayPal's remembered-buyer data, so PayPal asks for a
// sign-in again (a remembered email would otherwise be prefilled and the buyer skipped straight to the review).
function sessionWithoutPayPal() {
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  st.cookies = (st.cookies ?? []).filter((c) => !/paypal\.com$/.test(c.domain.replace(/^\./, '')));
  st.origins = (st.origins ?? []).filter((o) => !/paypal\.com/.test(o.origin));
  return st;
}
const { browser, context, page } = await launch({ baseURL: BASE, storage: resume ? sessionWithoutPayPal() : undefined });
const rec = new Recorder(page, { outDir: clipsDir, width: 1920, height: 1080 });
const metaPath = path.join(videoRoot, '.capture-meta.json'); // survives between partial runs (which request was confirmed)
const meta = fs.existsSync(metaPath) && resume ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
const overlays = {};   // shot id -> { clip, atSec }: a second recording (PayPal's popup) shown over this shot
const extraRecs = [];  // recorders of popup windows, encoded at the end
const rings = {};
const settle = {}; // shot id -> seconds into the clip when the long wait (assistant thinking) ended
let current = null; // { id, startedAt }

// ---------------------------------------------------------------- helpers
/** Start recording a shot; the previous one ends here. Records until `run` finished and the shot is long enough. */
async function shot(id, run = async () => {}, { hold = true } = {}) {
  const key = id;
  const t = rec.mark(key);
  current = { id: key, t };
  await run();
  if (hold) await rec.holdUntil(dur[key] ?? 4);
}
/** Unrecorded setup between shots (reloads, navigation). */
async function gap(run) { rec.mark('_gap'); current = null; await run(); }

/** Mark the moment a long wait ended. The cut speeds up what came before and plays what follows at normal speed. */
function settled() { if (current) settle[current.id] = Number((rec.now() - current.t).toFixed(2)); }

async function ring(selector, { delay = 0 } = {}) {
  if (delay) await sleep(delay * 1000);
  const r = await rectOf(page, selector);
  if (!r || !current) return;
  const k = current.id;
  (rings[k] ??= []).push({ at: Number((rec.now() - current.t).toFixed(2)), x: r.x * SCALE, y: r.y * SCALE, w: r.w * SCALE, h: r.h * SCALE });
}

/** The assistant shows a "thinking" bubble while it works; the reply replaces it. */
let lastAssistant = 0;
async function waitForReply(timeout = 120000) {
  await page.locator('#thinking').waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  await page.locator('#thinking').waitFor({ state: 'detached', timeout });
  lastAssistant = Date.now();
  await sleep(900); // let the cards and trace settle
}

/** The free AI tier is rate limited per minute and one assistant turn makes several calls: space the turns out.
 *  Call it where nothing is being recorded (in a gap, or right after a discarded take). */
async function cooldown(sec = 55) {
  const left = sec * 1000 - (Date.now() - lastAssistant);
  if (lastAssistant && left > 0) { process.stdout.write(`(cooling down ${Math.ceil(left / 1000)}s for the AI rate limit) `); await sleep(left); }
}

/** Smoothly scroll so the element sits `offset` CSS px below the top (clear of the sticky header). */
async function scrollTo(selector, offset = 96) {
  await page.evaluate(([sel, off]) => {
    const el = document.querySelector(sel);
    if (el) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - off), behavior: 'smooth' });
  }, [selector, offset]);
  await sleep(900);
}

async function scrollToLocator(loc, offset = 120) {
  await loc.evaluate((el, off) => window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - off), behavior: 'smooth' }), offset);
  await sleep(900);
}

/** Type into a field and check it took (a field that is still animating into place swallows keystrokes). */
async function typeChecked(pg, r, loc, text, opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await loc.fill('');
    await typeInto(pg, r, loc, text, opts);
    if ((await loc.inputValue().catch(() => '')) === text) return;
    await sleep(500);
  }
  throw new Error('a field did not take the typed text');
}

/** Cut out a dull wait on every recorder at once, so the main clip and the popup clip stay in step. */
const pauseAll = (recs) => recs.forEach((r) => r.pause());
const resumeAll = (recs) => Promise.all(recs.map((r) => r.resume()));

function testBuyer() {
  const lines = fs.readFileSync(path.join(videoRoot, '..', 'accounts'), 'utf8').split('\n').map((l) => l.trim());
  const i = lines.findIndex((l) => l.includes('@'));
  if (i < 0 || !lines[i + 1]) throw new Error('no test buyer found in ../accounts (an email line followed by its password line)');
  return { email: lines[i], password: lines[i + 1] };
}

async function park(x = 1080, y = 620) { await moveTo(page, rec, x, y, 500); }
async function goHome() {
  await page.evaluate(() => { location.hash = '#/overview'; });
  await page.waitForSelector('#page-overview:not([hidden])');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
}
async function dismissOpenDialogs() {
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}

// ---------------------------------------------------------------- scenes
const SCENES = {
  async hook() {
    await gap(async () => {
      await page.goto('/');
      await page.waitForSelector('#dlg-tour[open], #dlg-edit[open]', { timeout: 15000 });
      await page.evaluate(() => localStorage.setItem('mandate.tour.v1', JSON.stringify({ seen: true, at: new Date().toISOString() })));
      await page.reload();
      await page.waitForSelector('#dlg-edit[open]', { timeout: 15000 });
      await page.click('#edit-cancel'); // the empty statement is the shot, so the setup dialog must not cover it
      await page.waitForSelector('#dlg-edit:not([open])', { state: 'attached' });
      await sleep(900);
      await moveTo(page, rec, 1100, 640, 100);
    });
    await shot('hook-1b');
    await shot('hook-1c');
  },

  async mandate() {
    await gap(async () => {
      await page.evaluate(() => localStorage.removeItem('mandate.tour.v1'));
      await page.reload();
      await page.waitForSelector('#dlg-tour[open]', { timeout: 15000 });
      await sleep(1000);
    });
    await shot('mandate-2a', async () => {
      await sleep(1300); // step 1 of the welcome tour
      await click(page, rec, '#tour-skip');
    });
    await shot('mandate-2b', async () => {
      await page.waitForSelector('#dlg-edit[open]');
      await sleep(500);
      await typeInto(page, rec, '#form-edit [name=budget]', '300');
      await typeInto(page, rec, '#form-edit [name=cap]', '120');
      for (const cat of ['office', 'electronics', 'home']) {
        await click(page, rec, page.locator('#edit-cats label', { hasText: new RegExp(`^\\s*${cat}\\s*$`) }), { ms: 420, settle: 120 });
      }
    });
    await shot('mandate-2c', async () => {
      await ring('#edit-summary', { delay: 0.3 });
      // activate near the end of this shot so the budget going live lands in 2d
      await rec.holdUntil(dur['mandate-2c'] - 1.5);
      await click(page, rec, '#edit-save', { ms: 600, settle: 150 });
    });
    await shot('mandate-2d', async () => {
      await page.waitForSelector('#dlg-edit:not([open])', { state: 'attached', timeout: 20000 });
      await moveTo(page, rec, 900, 560, 700);
    });
  },

  async ask() {
    await gap(async () => { await goHome(); await park(); await cooldown(); });
    await shot('ask-3a', async () => {
      await scrollTo('#h-agent', 100);
      await typeInto(page, rec, '#chat-input', 'a vertical ergonomic mouse and a large desk mat', { delay: 48 });
      await sleep(350);
      await click(page, rec, '#chat-send', { ms: 500, settle: 150 });
    });
    await shot('ask-3b', async () => {
      await waitForReply();
      settled();
      const summary = page.locator('details.trace summary').last();
      if (await summary.count()) {
        const open = await page.locator('details.trace').last().evaluate((d) => d.open);
        if (!open) await click(page, rec, summary, { ms: 600, settle: 200 });
      }
      await sleep(1200);
    });
    await shot('ask-3c', async () => {
      await scrollTo('#h-approvals', 100);
      const checks = page.locator('#approvals .req.pending .checks').first();
      if (await checks.count()) { const b = await checks.boundingBox(); if (b) await moveTo(page, rec, b.x + b.width * 0.5, b.y + b.height * 0.5, 800); }
    });
    // The refused request. It goes through the Search page: the result is tagged "outside mandate" with the exact rule,
    // and "Request purchase" sends it through the same server rule as the assistant's requests. Deterministic: it does
    // not depend on the model choosing to propose something it expects to be refused.
    await shot('ask-3d', async () => {
      await click(page, rec, '.nav-item[data-route=search]', { ms: 600 });
      const outside = page.locator('#search-results .offer.outside .btn').first();
      let found = false;
      for (const q of ['27 inch 4K monitor', '4K monitor', 'ultrawide 4K monitor']) {
        await page.fill('#search-input', '');
        await typeInto(page, rec, '#search-input', q, { delay: 45 });
        await click(page, rec, '#search-btn', { ms: 450 });
        found = await outside.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
        if (found) break;
        console.warn(`  (no result for "${q}")`);
      }
      if (!found) throw new Error('the web search found no priced 4K monitor (try again in a minute)');
      settled();
      await sleep(900);
      await click(page, rec, outside, { ms: 700 });
      await sleep(1500); // the "blocked" toast
      await goHome();
      const blocked = page.locator('#approvals .req', { has: page.locator('.status.blocked') }).first();
      await blocked.waitFor({ state: 'attached', timeout: 15000 });
      await scrollTo('#approvals .req:has(.status.blocked)', 130);
      await ring('#approvals .req:has(.status.blocked) .check.fail');
      await sleep(1800);
      await ring('#approvals .req:has(.status.blocked) .req-meta:last-of-type');
      await sleep(2000);
    });
  },

  async approve() {
    await gap(async () => { await goHome(); await park(); });
    // 4a: the typed-amount step for a high-value request. Only the part before PayPal's own button is recorded here.
    await shot('approve-4a', async () => {
      // The cheapest request that asks for the typed amount: it is the one paid and then refunded in the next scenes
      // (the sandbox seller account refunds small payments reliably; a $99.99 refund was refused by PayPal).
      const needing = page.locator('#approvals .req.pending', { has: page.getByRole('button', { name: 'Review and confirm' }) });
      await needing.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      let card = needing.first(), cheapest = Infinity;
      for (let i = 0; i < await needing.count(); i++) {
        const price = parseFloat((await needing.nth(i).locator('.req-amt').first().innerText()).replace(/[^0-9.]/g, ''));
        if (price < cheapest) { cheapest = price; card = needing.nth(i); }
      }
      await card.waitFor({ state: 'visible', timeout: 10000 }).catch(() => console.warn('! no pending request needs the typed amount; set HIGH_VALUE_USD lower than the item price'));
      meta.payTitle = (await card.locator('.req-title').first().innerText().catch(() => '')).trim() || null;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      await click(page, rec, card.getByRole('button', { name: 'Review and confirm' }), { ms: 800 });
      await page.waitForSelector('#dlg-confirm[open]');
      await sleep(900);
      const amount = (await page.locator('#confirm-facts').innerText()).match(/\$\s?[\d,]+\.\d{2}/)?.[0]?.replace(/[$\s,]/g, '');
      await typeInto(page, rec, '#confirm-amount', amount ?? '0', { delay: 120 });
      await sleep(700);
      await click(page, rec, '#confirm-go', { ms: 600 });
      await page.waitForSelector('#dlg-confirm:not([open])', { state: 'attached', timeout: 15000 });
      await page.locator('#approvals .req.pending .pp-slot iframe, #approvals .req.pending .pp-slot [data-funding-source]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => console.warn('! the PayPal button did not render in the headless browser'));
      await sleep(1200);
    });
  },

  async paypal() {
    // PayPal remembers a buyer who signed in before: start signed out so the sign-in is what the viewer sees.
    await gap(async () => { await context.clearCookies({ domain: /paypal\.com$/ }); await goHome(); await park(); });
    const card = meta.payTitle
      ? page.locator('#approvals .req.pending', { hasText: meta.payTitle }).first()
      : page.locator('#approvals .req.pending:has(.pp-slot iframe)').first();
    const buyer = testBuyer();
    let popup = null, rec2 = null;

    // 4b: PayPal's own button, then PayPal's own window (recorded separately, shown 1:1 over the app).
    await shot('approve-4b', async () => {
      await scrollToLocator(card, 140);
      const btn = card.frameLocator('.pp-slot iframe').first().locator('div[role=link], .paypal-button, [data-funding-source=paypal]').first();
      await btn.waitFor({ state: 'visible', timeout: 30000 });
      const opened = context.waitForEvent('page', { timeout: 30000 });
      await click(page, rec, btn, { ms: 550 });
      popup = await opened;
      await popup.setViewportSize({ width: 568, height: 700 }); // 852x1050 px at 1.5x: fits the frame at native size
      rec2 = new Recorder(popup, { outDir: clipsDir, width: 852, height: 1050 });
      rec2.cursor = { x: 70, y: 40 };
      const both = [rec, rec2];
      pauseAll([rec]);                 // the popup is blank while it loads: cut it
      const emailBox = popup.locator('input[name=login_email], #email').first();
      const complete = popup.getByRole('button', { name: /Complete Purchase|Pay Now|Continue/i }).first();
      await Promise.race([emailBox.waitFor({ state: 'visible', timeout: 45000 }), complete.waitFor({ state: 'visible', timeout: 45000 })]);
      const needsLogin = await emailBox.isVisible().catch(() => false);
      await rec2.start();
      rec2.mark('approve-4b-popup');
      await rec.resume();
      overlays['approve-4b'] = { clip: 'approve-4b-popup', atSec: Number((rec.now() - current.t).toFixed(2)) };
      extraRecs.push(rec2);

      if (needsLogin) {
        await typeChecked(popup, rec2, emailBox, buyer.email, { delay: 26, ms: 450 });
        await sleep(200);
        const password = popup.locator('input[name=login_password], #password').first();
        const login = popup.locator('#btnLogin, button:has-text("Log In")').first();
        // PayPal serves two layouts: email, "Next", then password; or both fields on one page.
        const next = popup.locator('#btnNext').first();
        if (await next.isVisible().catch(() => false)) {
          await click(popup, rec2, next, { ms: 400 });
          pauseAll(both);
          await login.waitFor({ state: 'visible', timeout: 45000 });
          await password.waitFor({ state: 'visible', timeout: 45000 });
          await sleep(1200);           // let the password step finish sliding in before typing
          await resumeAll(both);
        }
        await typeChecked(popup, rec2, password, buyer.password, { delay: 26, ms: 400 });
        await sleep(200);
        await click(popup, rec2, login, { ms: 400 });
        pauseAll(both);                // PayPal signs in: cut the wait
        await complete.waitFor({ state: 'visible', timeout: 60000 });
        await sleep(900);
        await resumeAll(both);
      }
      await sleep(1000);               // the review page: who pays, how much
      await click(popup, rec2, complete, { ms: 550 });
      await popup.waitForEvent('close', { timeout: 60000 }).catch(() => {});
      await rec2.stop(); // the popup's clip ends when its window closes
    }, { hold: false });

    // 4c: back in the app, the server captures the payment, checks the amount and updates the budget.
    await shot('approve-4c', async () => {
      const captured = page.locator('#approvals .req', { has: page.locator('.status.captured') }).first();
      await captured.waitFor({ state: 'attached', timeout: 60000 });
      await scrollToLocator(captured, 150);
      await sleep(1800);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(900);
      await moveTo(page, rec, 900, 600, 600);
    });
  },

  async refund() {
    await gap(async () => { await goHome(); await park(); });
    const captured = page.locator('#approvals .req', { has: page.locator('.status.captured') }).first();
    await captured.waitFor({ state: 'attached', timeout: 20000 });
    await shot('refund-5a', async () => {
      await scrollToLocator(captured, 150);
      await click(page, rec, captured.getByRole('button', { name: /^Refund/ }), { ms: 600 });
      await page.waitForSelector('#dlg-refund[open]');
    });
    await shot('refund-5b', async () => {
      await sleep(300);
      await click(page, rec, '#refund-ack', { ms: 450 });
      await sleep(200);
      await click(page, rec, '#refund-go', { ms: 400 });
    });
    await shot('refund-5c', async () => {
      // the safety delay counts down on screen (8 s on the recording setting; 30 s in production)
      await page.waitForFunction(() => { const b = document.getElementById('refund-go'); return b && b.textContent.trim() === 'Confirm refund' && !b.disabled; }, null, { timeout: 40000 });
    });
    await shot('refund-5d', async () => {
      const cancel = await rectOf(page, '#refund-cancel');
      if (cancel) await moveTo(page, rec, cancel.x + cancel.w / 2, cancel.y + cancel.h / 2, 450);
      await sleep(700);
      await click(page, rec, '#refund-go', { ms: 420 });
      await page.waitForSelector('#dlg-refund:not([open])', { state: 'attached', timeout: 30000 });
      await page.locator('#approvals .req .status.refunded').first().waitFor({ state: 'visible', timeout: 30000 });
      await sleep(1200);
    });
  },

  async suggest() {
    await gap(async () => { await dismissOpenDialogs(); await goHome(); await park(); await cooldown(); });
    await shot('suggest-6a', async () => {
      await typeInto(page, rec, '#chat-input', 'raise my budget to five hundred dollars', { delay: 45 });
      await sleep(250);
      await click(page, rec, '#chat-send', { ms: 450, settle: 120 });
    });
    await shot('suggest-6b', async () => {
      await waitForReply();
      const card = page.locator('#proposals .suggestion').first();
      await card.waitFor({ state: 'visible', timeout: 20000 });
      settled();
      await scrollTo('#proposals', 110);
      await click(page, rec, card.getByRole('button', { name: 'Review and apply' }), { ms: 700 });
      await page.waitForSelector('#dlg-proposal[open]');
    });
    await shot('suggest-6c', async () => {
      await sleep(900);
      await click(page, rec, '#proposal-ack', { ms: 600, settle: 150 });
      await sleep(500);
      await click(page, rec, '#proposal-go', { ms: 500, settle: 150 });
      await page.waitForSelector('#dlg-proposal:not([open])', { state: 'attached', timeout: 20000 });
      await moveTo(page, rec, 1000, 640, 600);
    });
  },

  async audit() {
    await gap(async () => { await dismissOpenDialogs(); await goHome(); await sleep(400); });
    await shot('audit-7a', async () => {
      await click(page, rec, '.nav-item[data-route=ledger]', { ms: 700 });
      await page.waitForSelector('#page-ledger:not([hidden])');
      await page.waitForSelector('#grid-purchases .ag-row', { timeout: 15000 });
    });
    await shot('audit-7b', async () => {
      await sleep(600);
      await click(page, rec, '.tab[data-tab=audit]', { ms: 700 });
      await page.waitForSelector('#grid-audit .ag-row', { timeout: 15000 });
    });
    await shot('audit-7c', async () => {
      await sleep(700);
      await click(page, rec, '#export-audit', { ms: 800 });
    });
    await shot('audit-7d', async () => {
      await sleep(500);
      await click(page, rec, '.nav-item[data-route=info]', { ms: 700 });
      await page.waitForSelector('#page-info:not([hidden])');
    });
  },

  async close() {
    await gap(async () => { await goHome(); await park(1100, 660); });
    await shot('close-8a', async () => { await sleep(300); });
  },
};

// ---------------------------------------------------------------- run
fs.mkdirSync(clipsDir, { recursive: true });
fs.mkdirSync(debugDir, { recursive: true });
page.on('download', (d) => { d.delete().catch(() => {}); });
await page.goto('/');
await page.waitForLoadState('networkidle').catch(() => {});
await rec.start();
let failed = null;
try {
  for (const name of scenes) {
    if (!SCENES[name]) { console.warn(`(skipping "${name}": not a scene. Scenes: ${AUTO.join(', ')})`); continue; }
    process.stdout.write(`scene ${name} ... `);
    const t = Date.now();
    await SCENES[name]();
    console.log(`${((Date.now() - t) / 1000).toFixed(1)} s`);
    await context.storageState({ path: statePath });
  }
} catch (e) {
  failed = e;
  console.error(`\nFAILED in scene: ${e.message}`);
  await page.screenshot({ path: path.join(debugDir, 'failure.png') }).catch(() => {});
}
await rec.stop();
const lengths = await rec.encodeShots();
rec.cleanup();
for (const r of extraRecs) { await r.stop(); Object.assign(lengths, await r.encodeShots()); r.cleanup(); }
await browser.close();

const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { clips: {}, rings: {} };
manifest.settle ??= {};
manifest.overlays ??= {};
manifest.viewport = { width: 1920, height: 1080 };
for (const [id, sec] of Object.entries(lengths)) {
  if (id.startsWith('_')) continue;
  manifest.clips[id] = { durationSec: sec, source: 'auto', recordedAt: new Date().toISOString() };
  if (rings[id]) manifest.rings[id] = rings[id]; else delete manifest.rings[id];
  if (settle[id] !== undefined) manifest.settle[id] = settle[id]; else delete manifest.settle[id];
  if (overlays[id]) manifest.overlays[id] = overlays[id]; else delete manifest.overlays[id];
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
for (const id of Object.keys(lengths)) { if (id.startsWith('_')) continue; console.log(`  ${id.padEnd(14)} ${lengths[id].toFixed(1).padStart(5)} s  (cut: ${(dur[id] ?? 0).toFixed(1)} s)`); }
if (failed) process.exit(1);
