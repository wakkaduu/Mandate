// Static checks on the front end (no browser): every element the scripts look up exists, the removed controls are gone,
// the optional "How it works" content lives on its own page, and no UI code uses innerHTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pub = path.join(import.meta.dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
const html = read('index.html');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const scripts = ['app.js', 'ui/shell.js', 'ui/pages.js', 'ui/prefs.js', 'ui/dom.js', 'ui/icons.js', 'theme-boot.js'];

test('every $("id") lookup in the UI scripts points at an element that exists in index.html', () => {
  const missing = [];
  for (const f of scripts) {
    for (const m of read(f).matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) if (!ids.has(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('side panel links, pages and routes line up', () => {
  const navRoutes = [...html.matchAll(/class="nav-item" data-route="(\w+)"/g)].map((m) => m[1]);
  const pages = [...html.matchAll(/class="page" id="page-(\w+)" data-page="(\w+)"/g)].map((m) => m[2]);
  const shellRoutes = [...read('ui/shell.js').matchAll(/^\s+(\w+): \{ title:/gm)].map((m) => m[1]);
  assert.deepEqual(navRoutes.sort(), ['how', 'info', 'ledger', 'overview', 'search', 'settings']);
  assert.deepEqual(pages.sort(), navRoutes);
  assert.deepEqual(shellRoutes.sort(), navRoutes);
});

test('removed controls are gone; the 4-step strip now lives only on the How it works page', () => {
  assert.ok(!/Reset demo|btn-reset|Connect an agent|btn-connect|dlg-connect/i.test(html + read('app.js')));
  assert.ok(!html.includes('class="steps"'));
  const how = html.slice(html.indexOf('id="page-how"'), html.indexOf('id="page-info"'));
  assert.equal((how.match(/class="step-no"/g) ?? []).length, 4);
  const overview = html.slice(html.indexOf('id="page-overview"'), html.indexOf('id="page-search"'));
  assert.ok(!overview.includes('step-no'));
});

test('no innerHTML / document.write in UI code; PayPal buttons are not restyled', () => {
  for (const f of scripts) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(read(f).replace(/\/\/.*$/gm, '')), f);   // comments may mention the words
  const css = read('styles.css');
  assert.ok(!/\.pp-slot[^{]*\{[^}]*(filter|transform|zoom|opacity)/.test(css), 'no visual effects on the PayPal button slot');
  assert.ok(!/paypal-button|zoid/.test(css), 'no selectors reaching into the PayPal SDK');
  assert.ok(!/gold/i.test(read('app.js').replace(/color: 'gold'/, '')), 'only the SDK option color: gold remains in app.js');
});

test('preferences: every option list has a default and the boot script exposes them', () => {
  const boot = read('theme-boot.js');
  for (const k of ['theme', 'accent', 'density', 'text', 'motion', 'sidebar', 'startPage']) assert.match(boot, new RegExp(`${k}: \\[`));
  assert.match(boot, /window\.__prefsCore/);
});
