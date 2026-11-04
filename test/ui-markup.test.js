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

test('no visible "sandbox" wording in the working UI; the one honest disclosure lives on the Information page', () => {
  const visible = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['index.html', 'app.js', 'ui/shell.js', 'ui/dom.js', 'ui/icons.js', 'ui/prefs.js', 'styles.css', 'theme-boot.js']) assert.ok(!/sandbox/i.test(visible(f)), `${f} should not mention the sandbox`);
  assert.match(visible('ui/pages.js'), /Sandbox \(test mode\)/, 'Information states the payment environment truthfully');
  assert.equal((visible('ui/pages.js').match(/sandbox/gi) ?? []).length, 1);
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
  for (const k of ['theme', 'accent', 'density', 'text', 'motion', 'startPage']) assert.match(boot, new RegExp(`${k}: \\[`));
  assert.match(boot, /window\.__prefsCore/);
});

test('the UI never shows third-party vendor names (only PayPal); product titles and retailers are data, not chrome', () => {
  const visible = (f) => read(f).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const vendors = /gemini|claude|anthropic|openai|tavily|serper|google|turso|vercel|render\.com|\bmcp\b|model context protocol/i;
  for (const f of ['index.html', 'app.js', 'ui/shell.js', 'ui/pages.js', 'ui/dom.js', 'ui/prefs.js', 'ui/motion.js', 'ui/icons.js', 'theme-boot.js']) assert.ok(!vendors.test(visible(f)), `${f} mentions a vendor`);
});

test('motion is opt-in per setting: every JS effect is gated by motionOn(); CSS honours reduced and off', () => {
  const motion = read('ui/motion.js');
  assert.match(motion, /import \{[^}]*motionOn[^}]*\} from '\.\/dom\.js'/);
  assert.ok((motion.match(/motionOn\(\)/g) ?? []).length >= 6, 'ripple, spotlight, reveal, ink, replay, theme fade are gated');
  const css = read('styles.css');
  assert.match(css, /:root\[data-motion="off"\] \*[^{]*\{[^}]*animation-duration: \.001ms !important/);
  assert.match(css, /:root\[data-motion="reduced"\] \{[^}]*--move: 0px/);
  assert.ok(!/\.pp-slot[^{]*\{[^}]*(filter|transform|zoom)/.test(css), 'no effects on the PayPal slot');
  assert.match(css, /:is\(\.statement, \.req:not\(\.pending\)/, 'spotlight skips rows that hold PayPal buttons');
  assert.match(css, /\.req:not\(\.pending\):hover/, 'no lift on rows that hold PayPal buttons');
});
