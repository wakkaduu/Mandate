// App shell: hash router (#/overview ...), side panel (collapsible on desktop, drawer on small screens), top bar.
import { $, h } from './dom.js';
import { icon, mountIcons } from './icons.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';

export const ROUTES = {
  overview: { title: 'Overview', sub: 'Your mandate, the shopping agent, and what is waiting for your approval' },
  search: { title: 'Search', sub: 'Find products on the web yourself, with every price checked by the server' },
  ledger: { title: 'Ledger', sub: 'Every purchase and every decision, in one place' },
  how: { title: 'How it works', sub: 'From request to receipt in four steps' },
  info: { title: 'Information', sub: 'Environment, AI, search and hosting status' },
  settings: { title: 'Settings', sub: 'Make Mandate look and behave the way you like' },
};

const listeners = new Set();
let current = null;
export const currentRoute = () => current;
export const onRoute = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const routeFromHash = () => {
  const r = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return r in ROUTES ? r : null;
};

export function navigate(route) {
  if (!(route in ROUTES)) return;
  if (routeFromHash() === route) show(route, true);
  else location.hash = `#/${route}`;
}

const mobileQuery = window.matchMedia('(max-width: 1000px)');
const drawerOpen = () => document.body.classList.contains('nav-open');

function syncDrawer() {
  const side = $('sidebar');
  const open = drawerOpen();
  // On small screens the closed drawer is off-canvas: keep it out of the tab order and the accessibility tree.
  side.inert = mobileQuery.matches && !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
  $('scrim').hidden = !(mobileQuery.matches && open);
}
export function setDrawer(open) {
  document.body.classList.toggle('nav-open', open);
  syncDrawer();
  if (!open && mobileQuery.matches) $('btn-menu').focus({ preventScroll: true });
}

function show(route, userInitiated) {
  if (route === current) return;
  const prev = current;
  current = route;
  document.querySelectorAll('.page').forEach((p) => {
    const on = p.dataset.page === route;
    p.hidden = !on;
    if (on) { p.classList.remove('page-enter'); void p.offsetWidth; p.classList.add('page-enter'); }
  });
  document.querySelectorAll('.nav-item').forEach((a) => {
    const on = a.dataset.route === route;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('page-title').textContent = ROUTES[route].title;
  $('page-sub').textContent = ROUTES[route].sub;
  document.title = `${ROUTES[route].title} - Mandate`;
  if (drawerOpen()) { document.body.classList.remove('nav-open'); syncDrawer(); }
  if (userInitiated) { window.scrollTo(0, 0); $('page-title').focus({ preventScroll: true }); }
  listeners.forEach((fn) => fn(route, prev));
  updateApprovalsChip();
}

// ------------------------------------------------------------------ approvals badge (side panel + top bar)
let pendingCount = 0;
function updateApprovalsChip() {
  const badge = $('nav-approvals');
  badge.hidden = pendingCount === 0;
  badge.textContent = String(pendingCount);
  badge.setAttribute('aria-label', `${pendingCount} waiting for approval`);
  const chip = $('top-approvals');
  chip.hidden = pendingCount === 0 || current === 'overview';
  chip.querySelector('span').textContent = `${pendingCount} waiting for approval`;
}
export function setPendingApprovals(n) { pendingCount = n; updateApprovalsChip(); }

// ------------------------------------------------------------------ theme quick toggle
function syncThemeButton() {
  const dark = document.documentElement.dataset.scheme === 'dark';
  const btn = $('btn-theme');
  btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  btn.title = btn.getAttribute('aria-label');
}

function syncCollapse() {
  const collapsed = getPrefs().sidebar === 'collapsed';
  const btn = $('btn-collapse');
  btn.setAttribute('aria-pressed', String(collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Expand the side panel' : 'Collapse the side panel');
  btn.title = btn.getAttribute('aria-label');
}

export function initShell() {
  mountIcons();
  $('btn-menu').replaceChildren(icon('menu'));
  $('btn-collapse').replaceChildren(icon('collapse'));
  document.querySelectorAll('.nav-item').forEach((a) => a.setAttribute('title', a.querySelector('.nav-text').textContent));

  $('btn-menu').addEventListener('click', () => setDrawer(!drawerOpen()));
  $('scrim').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen()) setDrawer(false); });
  mobileQuery.addEventListener('change', () => { document.body.classList.remove('nav-open'); syncDrawer(); });
  $('btn-collapse').addEventListener('click', () => setPref('sidebar', getPrefs().sidebar === 'collapsed' ? 'expanded' : 'collapsed'));
  $('btn-theme').addEventListener('click', () => setPref('theme', document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark'));
  $('top-approvals').addEventListener('click', (e) => { e.preventDefault(); navigate('overview'); });
  onPrefs(() => { syncThemeButton(); syncCollapse(); });
  syncThemeButton();
  syncCollapse();
  syncDrawer();

  window.addEventListener('hashchange', () => { const r = routeFromHash(); if (r) show(r, true); });
  const first = routeFromHash();
  if (first) show(first, false);
  else { location.replace(`#/${getPrefs().startPage}`); show(getPrefs().startPage, false); }
}

/** Small accessible status dot used on several pages. */
export const dot = (kind) => h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' });
