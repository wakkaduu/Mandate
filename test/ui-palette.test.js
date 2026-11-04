// The brand palette is a contract: exact hex values must be in the CSS, and every text/background pairing the UI uses
// must meet WCAG AA (4.5:1 for text, 3:1 for UI components). Sky Blue is light, so text on it is ink, never white.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'styles.css'), 'utf8');
const P = { sky: '#60cdff', midnight: '#002991', ink: '#000000', white: '#ffffff', ivory: '#f1efea', link: '#0070e0', success: '#007a56', error: '#c0212b', gold: '#ffd140' };

const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const mix = (a, b, pa) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * pa + parseInt(b.slice(i, i + 2), 16) * (1 - pa)).toString(16).padStart(2, '0')).join('')}`;

test('the exact brand hex values are defined in the stylesheet', () => {
  for (const [name, hex] of Object.entries(P)) {
    if (name === 'white') continue;
    assert.ok(css.toLowerCase().includes(hex), `${name} ${hex}`);
  }
  assert.ok(!/#00457c|#0079c1/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'legacy Pay/Pal blues are not used in rules');
});

test('text pairings meet WCAG AA (4.5:1)', () => {
  const text = [
    ['ink on white', P.ink, P.white], ['ink on ivory', P.ink, P.ivory],
    ['muted #595959 on white', '#595959', P.white], ['muted on ivory', '#595959', P.ivory],
    ['ink on Sky Blue (primary button, user bubble)', P.ink, P.sky],
    ['midnight on white (accent text)', P.midnight, P.white], ['midnight on sky tint (active nav)', P.midnight, mix(P.sky, P.white, 0.12)], ['midnight on ivory', P.midnight, P.ivory],
    ['link blue on white (hyperlinks)', P.link, P.white],
    ['white on success green (positive buttons)', P.white, P.success], ['success on its tint (tags)', P.success, mix(P.success, P.white, 0.10)],
    ['white on error red (toast)', P.white, P.error], ['error on white', P.error, P.white], ['error on its tint', P.error, mix(P.error, P.white, 0.09)],
    ['warning text on gold tint', '#7a5200', mix(P.gold, P.white, 0.28)],
    ['white on midnight (budget card)', P.white, P.midnight], ['hero muted on midnight', '#c9d6ff', P.midnight], ['sky on midnight', P.sky, P.midnight], ['gold on midnight', P.gold, P.midnight],
    ['white on link blue (Link Blue accent)', P.white, P.link], ['white on ink (Ink accent)', P.white, P.ink],
    // dark theme
    ['dark: white on surface', P.white, '#001245'], ['dark: muted on surface', '#a9b7e6', '#001245'], ['dark: muted on surface-2', '#a9b7e6', '#001a5c'],
    ['dark: sky links on surface', P.sky, '#001245'], ['dark: ok text', '#3fd6a6', '#001245'], ['dark: error text', '#ff8088', '#001245'], ['dark: warning gold', P.gold, '#001245'],
    ['dark: midnight accent text', '#9db9ff', '#001245'], ['dark: blue accent text', '#7ec0ff', '#001245'], ['dark: white on lifted midnight button', P.white, '#2b5fe0'],
  ];
  const bad = text.filter(([, fg, bg]) => ratio(fg, bg) < 4.5).map(([n, fg, bg]) => `${n}: ${ratio(fg, bg).toFixed(2)}`);
  assert.deepEqual(bad, []);
});

test('white on Sky Blue really is unusable (guards the "ink on sky" rule)', () => {
  assert.ok(ratio(P.white, P.sky) < 3);
  assert.match(css, /:root, :root\[data-accent="sky"\] \{[^}]*--accent-ink: #000000/);
  assert.match(css, /:root\[data-scheme="dark"\], :root\[data-scheme="dark"\]\[data-accent="sky"\] \{[^}]*--accent-ink: #000000/);
});

test('focus rings and non-text UI use colors with >= 3:1 against their background', () => {
  assert.ok(ratio(P.link, P.white) >= 3 && ratio(P.link, P.ivory) >= 3, 'light focus ring (Link Blue)');
  assert.ok(ratio(P.sky, '#001245') >= 3 && ratio(P.sky, '#001a5c') >= 3, 'dark focus ring (Sky)');
  assert.ok(ratio(P.midnight, P.white) >= 3, 'active-nav indicator uses Midnight, not Sky (sky on white is 1.8:1)');
  assert.match(css, /\.nav-item\[aria-current="page"\] \{[^}]*border-bottom-color: var\(--accent-text\)/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\)/);
});

test('settings accent choices map onto the palette and all have readable check marks', () => {
  const boot = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'theme-boot.js'), 'utf8');
  assert.match(boot, /accent: \['sky', 'midnight', 'blue', 'green', 'ink'\]/);
  for (const a of ['sky', 'midnight', 'blue', 'green', 'ink']) assert.match(css, new RegExp(`:root\\[data-accent="${a}"\\]|data-accent="sky"`));
  const pages = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'ui', 'pages.js'), 'utf8');
  const swatches = [...pages.matchAll(/(\w+): \['[^']+', '(#[0-9a-f]{6})', '(#[0-9a-f]{6})'\]/g)];
  assert.equal(swatches.length, 5);
  for (const [, name, bg, fg] of swatches) assert.ok(ratio(bg, fg) >= 4.5, `${name} check mark ${ratio(bg, fg).toFixed(2)}`);
});
