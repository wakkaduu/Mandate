// Welcome tour: a short modal walkthrough shown the first time someone opens Mandate on a device, then remembered
// in this browser (localStorage) so it does not appear again. It can always be replayed from Settings > Help.
// All text goes through text nodes (no HTML strings). Animation is pure CSS, so the Motion setting governs it.
import { $, h, usd } from './dom.js';
import { icon } from './icons.js';

const KEY = 'mandate.tour.v1';
let seenThisVisit = false; // fallback when storage is blocked (private mode): at least no repeat within this page visit

/** Has this device already been shown the tour? */
export function tourSeen() {
  try { return localStorage.getItem(KEY) !== null; } catch { return seenThisVisit; }
}
function markSeen() {
  seenThisVisit = true;
  try { localStorage.setItem(KEY, JSON.stringify({ seen: true, at: new Date().toISOString() })); } catch { /* storage blocked: remembered for this visit only */ }
}

// ------------------------------------------------------------------ small illustrations (decorative, built from DOM nodes)
const node = (cls, ...kids) => h('div', { class: cls }, ...kids);
const chip = (name, label, k) => h('span', { class: 'mock chip', style: `--k:${k}` }, icon(name, { size: 18 }), label);
const arrow = (k) => h('span', { class: 'mock arrow', style: `--k:${k}` }, icon('arrow', { size: 18 }));

const ART = {
  welcome: () => node('art-row', chip('sliders', 'Your limits', 0), arrow(1), chip('shield', 'Checked', 2), arrow(3), chip('card', 'You pay in PayPal', 4)),
  budget: () => node('art-stack',
    h('div', { class: 'mock panel', style: '--k:0' },
      h('small', {}, 'Available to spend'),
      h('b', { class: 'art-figure' }, '$', h('span', { class: 'caret' })),
      h('i', { class: 'art-bar' }, h('i', {})),
      h('span', { class: 'art-terms' }, h('span', {}, 'Per-purchase cap ', h('em', {}, 'you choose')), h('span', {}, 'Categories ', h('em', {}, 'you choose'))))),
  ask: () => node('art-stack',
    h('div', { class: 'mock bubble you', style: '--k:0' }, 'A desk lamp under $40'),
    h('div', { class: 'mock bubble bot', style: '--k:1' }, 'Found one for $34.00. It is waiting for your approval.'),
    h('div', { class: 'mock searchbar', style: '--k:2' }, icon('search', { size: 16 }), 'or search the web yourself')),
  checks: () => node('art-stack',
    ...[['Category', true], ['Seller', true], ['Under the cap', true], ['Within budget', false]].map(([label, ok], i) =>
      h('div', { class: `mock row ${ok ? 'pass' : 'fail'}`, style: `--k:${i}` }, h('b', {}, ok ? '✓' : '✗'), label, ok ? null : h('em', {}, 'blocked before PayPal')))),
  approve: () => node('art-row', chip('bell', 'Request', 0), arrow(1), chip('shield', 'Checked', 2), arrow(3), h('span', { class: 'mock chip hot', style: '--k:4' }, icon('check', { size: 18 }), 'You approve')),
  record: () => node('art-stack',
    ...[['Desk lamp', '$34.00', 'paid'], ['4K monitor', '$429.00', 'blocked'], ['Desk mat', '$24.00', 'paid']].map(([name, amount, st], i) =>
      h('div', { class: 'mock ledger-row', style: `--k:${i}` }, h('span', {}, name), h('span', { class: 'amt' }, amount), h('span', { class: `st ${st}` }, st))),
    h('div', { class: 'mock searchbar', style: '--k:3' }, icon('copy', { size: 16 }), 'Export as CSV')),
};

/** Steps are built per call so the copy can use this deployment's real numbers. */
function steps({ configured, highValueCents }) {
  const hv = usd(highValueCents ?? 10000);
  return [
    { art: 'welcome', title: 'Welcome to Mandate', text: 'Let an AI assistant do your shopping without handing it your wallet. You decide how much it may spend. Every purchase is checked against your rules, and you approve each payment yourself in PayPal.',
      points: [] },
    { art: 'budget', title: 'You set the budget first', text: 'Nothing is built in. Before the assistant can search or request anything, you choose the numbers.',
      points: ['Total budget: the most that can be committed in all', 'Per-purchase cap: the most for any single item', 'Categories: what kinds of things it may buy', 'Optional: daily limit, blocked sellers, pace, expiry'] },
    { art: 'ask', title: 'Ask the assistant, or search yourself', text: 'Describe what you need in plain words, or use the Search page. Either way, a request is only a request.',
      points: ['The server opens each product page and reads the real price', 'The assistant never sets or changes a price', 'It cannot spend money or approve its own orders'] },
    { art: 'checks', title: 'Every request is checked first', text: 'Before PayPal is even contacted, a rule engine tests the request against your mandate. If a rule says no, you see exactly which one.',
      points: ['Category, seller, price cap, budget, daily limit and pace', 'Blocked requests never create a PayPal order'] },
    { art: 'approve', title: 'You approve with PayPal', text: 'Allowed requests wait under Awaiting your approval. Nothing is paid until you approve it with the PayPal button.',
      points: [`Payments of ${hv} or more ask you to type the amount first`, 'Refunds take two steps and a short cooling-off delay', 'Making your limits bigger later asks you to confirm'] },
    { art: 'record', title: 'Everything is on the record', text: 'The Ledger lists every purchase and every decision, and you can export it for your finance team.',
      points: ['The assistant may suggest a change to your limits, but only you can apply it', 'You can replay this tour any time from Settings, under Help'],
      last: configured ? 'Done' : 'Set up my mandate' },
  ];
}

// ------------------------------------------------------------------ the dialog
let ctx = () => ({ configured: true, highValueCents: 10000 });
let onFinish = () => {};
let list = [];
let at = 0;
let auto = false;
let opener = null;

function paint(direction = 1) {
  const s = list[at];
  const body = $('tour-body');
  const art = $('tour-art');
  $('tour-step').textContent = `Step ${at + 1} of ${list.length}`;
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-points').replaceChildren(...s.points.map((p) => h('li', {}, icon('check', { size: 16 }), h('span', {}, p))));
  art.replaceChildren(ART[s.art]());
  art.dataset.art = s.art;
  $('tour-back').hidden = at === 0;
  $('tour-next').textContent = at === list.length - 1 ? (s.last ?? 'Done') : 'Next';
  $('tour-skip').hidden = at === list.length - 1;
  $('tour-dots').replaceChildren(...list.map((x, i) => h('button', {
    type: 'button', class: 'tour-dot', 'aria-label': `Step ${i + 1}: ${x.title}`, 'aria-current': i === at ? 'step' : null, onclick: () => go(i),
  })));
  body.classList.remove('swap-fwd', 'swap-back'); void body.offsetWidth; body.classList.add(direction >= 0 ? 'swap-fwd' : 'swap-back'); // the illustration plays its own staggered entrance
}

function go(i) {
  const next = Math.max(0, Math.min(list.length - 1, i));
  if (next === at) return;
  const dir = next > at ? 1 : -1;
  at = next;
  paint(dir);
}

function close(reason) {
  const dlg = $('dlg-tour');
  if (dlg.open) dlg.close(reason);
}

/** Open the tour. `first` = shown automatically to a new visitor (it will be remembered either way). */
export function openTour({ first = false } = {}) {
  const dlg = $('dlg-tour');
  if (dlg.open) return;
  list = steps(ctx());
  at = 0;
  auto = first;
  opener = document.activeElement;
  paint(1);
  markSeen();
  dlg.showModal();
  $('tour-next').focus({ preventScroll: true });
}

/**
 * @param {{ context: () => {configured:boolean, highValueCents?:number}, finished: (r:{auto:boolean, wantsSetup:boolean}) => void }} opts
 * finished() runs after the tour closes. wantsSetup is true when the person pressed the last-step button while the
 * mandate is still not set up (or the tour was the automatic first-visit tour).
 */
export function initTour({ context, finished }) {
  ctx = context;
  onFinish = finished;
  const dlg = $('dlg-tour');
  $('tour-next').addEventListener('click', () => {
    if (at === list.length - 1) close('done'); else go(at + 1);
  });
  $('tour-back').addEventListener('click', () => go(at - 1));
  $('tour-skip').addEventListener('click', () => close('skip'));
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(at + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
  });
  dlg.addEventListener('close', () => {
    const reason = dlg.returnValue || 'skip'; // Escape closes without a value
    dlg.returnValue = '';
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    const { configured } = ctx();
    onFinish({ auto, wantsSetup: !configured && (auto || reason === 'done') });
  });
}
