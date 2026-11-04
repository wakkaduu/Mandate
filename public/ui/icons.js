// Inline SVG icons (stroke style, currentColor) built with createElementNS, so there is no innerHTML and no icon font.
const NS = 'http://www.w3.org/2000/svg';
const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const R = (x, y, width, height, rx = 2) => ['rect', { x, y, width, height, rx }];

const ICONS = {
  overview: [R(3, 3, 7, 9, 1.5), R(14, 3, 7, 5, 1.5), R(14, 12, 7, 9, 1.5), R(3, 16, 7, 5, 1.5)],
  search: [C(11, 11, 7.5), P('m21 21-4.3-4.3')],
  ledger: [P('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01')],
  how: [C(6, 19, 3), P('M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15'), C(18, 5, 3)],
  info: [C(12, 12, 10), P('M12 16v-4M12 8h.01')],
  settings: [P('M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4')],
  menu: [P('M4 6h16M4 12h16M4 18h16')],
  close: [P('M18 6 6 18M6 6l12 12')],
  collapse: [P('m11 17-5-5 5-5M18 17l-5-5 5-5')],
  sun: [C(12, 12, 4), P('M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41')],
  moon: [P('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z')],
  shield: [P('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'), P('m9 12 2 2 4-4')],
  check: [P('M20 6 9 17l-5-5')],
  sparkle: [P('m12 3 1.9 5.8 5.8 1.9-5.8 1.9L12 18.4l-1.9-5.8L4.3 10.7l5.8-1.9z')],
  card: [R(2, 5, 20, 14, 2), P('M2 10h20')],
  database: [['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }], P('M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0')],
  globe: [C(12, 12, 10), P('M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z')],
  plug: [P('M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z')],
  copy: [R(9, 9, 13, 13, 2), P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  arrow: [P('M5 12h14M12 5l7 7-7 7')],
  bulb: [P('M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4')],
  bell: [P('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0')],
  refresh: [P('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5')],
  reset: [P('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5')],
  palette: [P('M12 22a10 10 0 1 1 10-10c0 3-2 4-4 4h-2a2 2 0 0 0-1 3.7c.7.5.3 2.3-3 2.3z'), C(7.5, 11, 1), C(11, 7, 1), C(16, 8, 1)],
  motion: [P('M5 12h14M13 6l6 6-6 6M3 6v12')],
  layout: [R(3, 3, 18, 18, 2), P('M9 3v18')],
  sliders: [P('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6')],
  help: [C(12, 12, 10), P('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01')],
};

/** @param {keyof typeof ICONS} name */
export function icon(name, { size = 20, cls = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** Fill every <el data-icon="name"> placeholder in the page with its icon. */
export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.firstChild) return;
    el.append(icon(el.dataset.icon, { size: Number(el.dataset.size) || 20 }));
  });
}
