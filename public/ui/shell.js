// App shell: hash router (#/overview ...) and the masthead navigation (tabs on wide screens, a menu list on small ones).
import { $ } from './dom.js';
import { icon } from './icons.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';

export const ROUTES = {
  overview: { title: 'Account', sub: 'Your mandate, the assistant, and what is waiting for your approval.' },
  search: { title: 'Search', sub: 'Find products on the web yourself. The server checks every price.' },
  ledger: { title: 'Ledger', sub: 'Every purchase and every decision, in one place.' },
  how: { title: 'How it works', sub: 'From request to receipt in four steps.' },
  info: { title: 'Information', sub: 'What this deployment is configured to do.' },
  settings: { title: 'Settings', sub: 'Appearance and behavior. Saved in this browser only.' },
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

const mobileQuery = window.matchMedia('(max-width: 900px)');
const menuOpen = () => document.body.classList.contains('nav-open');

function syncMenu() {
  const open = menuOpen();
  // On small screens the closed menu is out of the tab order and the accessibility tree.
  $('primary-nav').inert = mobileQuery.matches && !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
  $('btn-menu').textContent = open ? 'Close' : 'Menu';
}
export function setMenu(open) {
  document.body.classList.toggle('nav-open', open);
  syncMenu();
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
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('page-title').textContent = ROUTES[route].title;
  $('page-sub').textContent = ROUTES[route].sub;
  document.title = `${ROUTES[route].title} - Mandate`;
  if (menuOpen()) setMenu(false);
  if (userInitiated) { window.scrollTo(0, 0); $('page-title').focus({ preventScroll: true }); }
  listeners.forEach((fn) => fn(route, prev));
}

/** Number of requests waiting for the human, shown next to "Account". */
export function setPendingApprovals(n) {
  const badge = $('nav-approvals');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  badge.setAttribute('aria-label', `${n} waiting for approval`);
}

function syncThemeButton() {
  const dark = document.documentElement.dataset.scheme === 'dark';
  const btn = $('btn-theme');
  btn.replaceChildren(icon(dark ? 'sun' : 'moon', { size: 18 }));
  btn.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
  btn.title = btn.getAttribute('aria-label');
}

export function initShell() {
  document.querySelectorAll('.nav-item').forEach((a) => a.setAttribute('title', a.querySelector('.nav-text').textContent));
  $('btn-menu').addEventListener('click', () => setMenu(!menuOpen()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen()) { setMenu(false); $('btn-menu').focus({ preventScroll: true }); } });
  mobileQuery.addEventListener('change', () => { document.body.classList.remove('nav-open'); syncMenu(); });
  $('btn-theme').addEventListener('click', () => setPref('theme', document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark'));
  onPrefs(syncThemeButton);
  syncThemeButton();
  syncMenu();

  window.addEventListener('hashchange', () => { const r = routeFromHash(); if (r) show(r, true); });
  const first = routeFromHash();
  if (first) show(first, false);
  else { location.replace(`#/${getPrefs().startPage}`); show(getPrefs().startPage, false); }
}
