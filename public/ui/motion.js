// Motion layer. Everything here is optional polish and is gated by the user's Motion setting (motionOn() is true only for
// "full"; "system" resolves to reduced when the OS asks for it). Effects: a navigation underline that glides between tabs,
// staggered entrance + scroll reveal for page sections, button ripples, a soft pointer spotlight on cards, a masthead
// shadow on scroll, a cross-fade when the theme changes, a top progress bar, and small "it worked" celebrations.
// Nothing here touches PayPal's buttons.
import { $, h, motionOn } from './dom.js';
import { onRoute, currentRoute } from './shell.js';
import { onPrefs } from './prefs.js';

// ------------------------------------------------------------------ top progress bar
let busy = 0;
export const progress = {
  start() { busy += 1; $('progress').classList.add('on'); },
  stop() { busy = Math.max(0, busy - 1); if (!busy) $('progress').classList.remove('on'); },
};

// ------------------------------------------------------------------ celebrations
function replay(el, cls, ms) {
  if (!el || !motionOn()) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}
/** Called when money actually moved: the budget figure bumps and the bar sends out a ring. */
export function celebrate() {
  replay(document.querySelector('.statement .figure'), 'pulse', 800);
  replay(document.querySelector('.statement .bar'), 'glow', 1000);
}
export const flashRow = (el) => replay(el, 'flash', 1900);

// ------------------------------------------------------------------ page entrance: stagger + reveal on scroll
let observer;
const REVEAL = '.page-head, .page:not([hidden]) > *, .workbench > .dock, .how-cols > *, .steps-list > li, .doc-section, .info-actions';

function animatePage(page) {
  observer?.disconnect();
  // Animate leaf sections only (a wrapper that contains other targets would fade twice), and never the rows that hold PayPal's buttons.
  const all = [...document.querySelectorAll(REVEAL)].filter((el) => !el.hidden && !el.closest('[hidden]') && !el.classList.contains('page'));
  const targets = all.filter((el) => !all.some((o) => o !== el && el.contains(o)) && !el.querySelector('.pp-slot'));
  if (!motionOn()) { targets.forEach((el) => el.classList.remove('reveal', 'in')); return; }
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); observer.unobserve(e.target); }
  }, { threshold: 0.06, rootMargin: '0px 0px -4% 0px' });
  targets.forEach((el, i) => {
    el.style.setProperty('--i', String(i));
    el.classList.remove('in');
    el.classList.add('reveal');
    observer.observe(el);
  });
  void page;
}

// ------------------------------------------------------------------ navigation underline that glides between tabs
function initNavInk() {
  const nav = $('primary-nav');
  const ink = h('span', { class: 'nav-ink', 'aria-hidden': 'true' });
  nav.append(ink);
  const place = () => {
    const a = nav.querySelector('.nav-item[aria-current="page"]');
    if (!a || window.matchMedia('(max-width: 900px)').matches || !motionOn()) { nav.classList.remove('has-ink'); return; }
    const n = nav.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    ink.style.setProperty('--x', `${r.left - n.left}px`);
    ink.style.setProperty('--w', `${r.width}px`);
    nav.classList.add('has-ink');
  };
  onRoute(() => requestAnimationFrame(place));
  window.addEventListener('resize', place);
  document.fonts?.ready?.then(place);
  onPrefs((_p, key) => { if (key === 'motion' || key === 'system' || key === '*') requestAnimationFrame(place); });
  requestAnimationFrame(place);
}

// ------------------------------------------------------------------ pointer effects: ripple on buttons, spotlight on cards
const SPOT = '.statement, .req:not(.pending), .offer, .doc-section, .steps-list li';
function initPointer() {
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest?.('.btn');
    if (!btn || btn.disabled || !motionOn()) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const ripple = h('span', { class: 'ripple', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px` });
    btn.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
  let frame = 0;
  document.addEventListener('pointermove', (e) => {
    if (frame || !motionOn() || e.pointerType === 'touch') return;
    const card = e.target.closest?.(SPOT);
    if (!card) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }, { passive: true });
}

// ------------------------------------------------------------------ masthead shadow once the page scrolls; theme cross-fade
function initChrome() {
  const bar = document.querySelector('.masthead');
  const sync = () => bar.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', sync, { passive: true });
  sync();
  let fadeTimer;
  onPrefs((_p, key) => {
    if (!['theme', 'accent', 'system', '*'].includes(key) || document.documentElement.dataset.motion === 'off') return;
    document.documentElement.classList.add('theme-fade');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => document.documentElement.classList.remove('theme-fade'), 600);
  });
}

export function initMotion() {
  onRoute((route) => animatePage(document.querySelector(`.page[data-page="${route}"]`)));
  if (currentRoute()) requestAnimationFrame(() => animatePage(null)); // the first route was shown before this module started
  onPrefs((_p, key) => { if (key === 'motion' || key === 'system' || key === '*') animatePage(null); });
  initNavInk();
  initPointer();
  initChrome();
}
