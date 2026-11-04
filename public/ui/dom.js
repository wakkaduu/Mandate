// Tiny DOM helpers shared by every UI module. All dynamic text goes through text nodes / textContent (no innerHTML).
export const $ = (id) => document.getElementById(id);
export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

/** Product links come from the open web: only ever render http(s) URLs as links. */
export const safeHref = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? u : null);

/** True when animations should run (user setting "full"; "system" resolves to reduced when the OS asks for it). */
export const motionOn = () => document.documentElement.dataset.motion === 'full';

/** Cheap animated number for the budget readout; falls back to an instant update when motion is reduced/off. */
export function tweenText(el, from, to, format, ms = 480) {
  if (!motionOn() || from === to || !Number.isFinite(from)) { el.textContent = format(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
