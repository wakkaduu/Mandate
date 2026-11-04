// Seller (retailer domain) helpers shared by the policy engine, the mandate editor and the offer pre-check.
// A seller is a bare domain such as "example.com"; "www." and scheme/path are stripped; subdomains match their parent.

/** @returns {string|null} the normalised domain, or null when it is not a plausible domain name */
export function normalizeSeller(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  return s.length <= 100 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}

/** Hostname of a product URL without "www.", or '' when the URL is unusable. */
export function sellerOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export const sellerMatches = (host, entry) => host === entry || host.endsWith(`.${entry}`);

/** Normalise and de-duplicate a list of sellers. @returns {{list:string[]}|{bad:string}} */
export function normalizeSellerList(input) {
  if (!Array.isArray(input) || input.length > 50) return { bad: 'a list of at most 50 domains' };
  const out = [];
  for (const raw of input) {
    const s = normalizeSeller(raw);
    if (!s) return { bad: String(raw).slice(0, 40) };
    if (!out.includes(s)) out.push(s);
  }
  return { list: out };
}
