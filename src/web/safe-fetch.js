// SSRF-hardened page fetcher. The product URLs come from a language model reading the open web, so they are
// untrusted input: https only, no credentials / odd ports, every redirect hop re-validated, and DNS results are
// checked at connect time (so a hostname that resolves to a private address, or rebinds to one, is refused).
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { config } from '../config.js';

export class FetchBlocked extends Error {}

function v4Private(a, b) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return v4Private(a, b); }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateIp(mapped[1]);
    return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b');
  }
  return true; // not an IP at all: refuse
}

const guardedLookup = (allowPrivate) => (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) return cb(new FetchBlocked(`${hostname} resolves to a private address`));
    return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
};

function checkUrl(u, allowPrivate) {
  if (u.username || u.password) throw new FetchBlocked('credentials in URL');
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new FetchBlocked('only https URLs are allowed');
  if (!allowPrivate && u.port && u.port !== '443') throw new FetchBlocked('non-standard port');
  if (!allowPrivate && (u.hostname === 'localhost' || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal'))) throw new FetchBlocked('internal hostname');
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) && !allowPrivate && isPrivateIp(bare)) throw new FetchBlocked('private address');
}

function once(u, { timeoutMs, maxBytes, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method: 'GET',
      lookup: guardedLookup(allowPrivate),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MandateBot/1.0; product price check)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, br',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).href });
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }); };
      stream.on('data', (c) => {
        size += c.length;
        chunks.push(c);
        if (size >= maxBytes) { req.destroy(); finish(); } // JSON-LD lives in the head: a truncated page is fine
      });
      stream.on('end', finish);
      stream.on('error', (e) => (done ? undefined : reject(e)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/** GET a page. Resolves { finalUrl, status, type, body }; rejects on blocked / failed / non-HTML responses. */
export async function safeGet(rawUrl, { maxBytes = 1_500_000, timeoutMs = 5000, maxRedirects = 3 } = {}) {
  const allowPrivate = config.web.allowPrivate;
  const deadline = Date.now() + timeoutMs * 2;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    checkUrl(url, allowPrivate);
    if (Date.now() > deadline) throw new Error('timeout');
    const r = await once(url, { timeoutMs, maxBytes, allowPrivate });
    if (r.redirect) { url = new URL(r.redirect); continue; }
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    if (!/html|json|xml/i.test(r.type)) throw new Error(`unsupported content type ${r.type}`);
    return { finalUrl: url.href, status: r.status, type: r.type, body: r.body };
  }
  throw new Error('too many redirects');
}
