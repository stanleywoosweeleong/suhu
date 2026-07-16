/**
 * SUHU fire-hotspot fetcher (transboundary-haze early warning).
 *
 * Runs on GitHub Actions — NOT on your computer. Counts active-fire detections
 * (NASA FIRMS, VIIRS S-NPP) over the regions that drive Malaysian haze, and
 * writes impact/fires.json for the app to read.
 *
 * Needs a FREE NASA FIRMS map key, stored as the repo secret FIRMS_MAP_KEY:
 *   get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/
 *
 * FIRMS area API (CSV):
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SRC}/{W,S,E,N}/{days}
 *   AREA_COORDINATES order is west,south,east,north (verified against FIRMS docs).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'impact', 'fires.json');
// .trim() + strip any stray whitespace/newlines a pasted secret may carry —
// a trailing newline makes every request URL invalid ("fetch failed").
const KEY = (process.env.FIRMS_MAP_KEY || '').replace(/\s+/g, '');
const SRC = 'VIIRS_SNPP_NRT';
const DAYS = 1;

const REGIONS = [
  { name: 'Sumatra',             box: [95, -6, 107, 6] },
  { name: 'Kalimantan',          box: [108, -4, 119, 4] },
  { name: 'Peninsular Malaysia', box: [99, 1, 105, 7] },
  { name: 'Sarawak / Sabah',     box: [109, 0, 119, 8] }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch with retries; on network failure surface the real underlying cause.
async function fetchText(url, tries = 3) {
  let lastErr = 'request failed';
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'SUHU-monitor/1.0', 'Accept': 'text/csv,*/*' },
        redirect: 'follow', signal: ctl.signal
      });
      const txt = await r.text();
      return { ok: r.ok, status: r.status, txt };
    } catch (e) {
      const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
      lastErr = e.message + (cause ? ' [' + cause + ']' : '');
    } finally { clearTimeout(t); }
    if (i < tries - 1) await sleep(1500);
  }
  throw new Error(lastErr);
}

async function countFires(box) {
  const [w, s, e, n] = box;
  const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    KEY + '/' + SRC + '/' + w + ',' + s + ',' + e + ',' + n + '/' + DAYS;
  const { ok, status, txt } = await fetchText(url);
  if (!ok) throw new Error('HTTP ' + status + ': ' + txt.slice(0, 80).replace(/\s+/g, ' '));
  const lines = txt.trim().split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return 0;                                   // no fires in window
  if (!/latitude/i.test(lines[0])) throw new Error('FIRMS: ' + lines[0].slice(0, 90).replace(/\s+/g, ' '));
  return Math.max(0, lines.length - 1);
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  if (!KEY) {
    fs.writeFileSync(OUT, JSON.stringify({
      generated: new Date().toISOString(), total: null, regions: [],
      note: 'FIRMS_MAP_KEY secret is not set — add it in repo Settings → Secrets → Actions.'
    }, null, 2));
    console.log('No FIRMS_MAP_KEY set — wrote placeholder.');
    return;
  }
  console.log('Using FIRMS key of length ' + KEY.length + ' (whitespace stripped).');

  const regions = [];
  let total = 0, okAny = false, firstErr = null;
  for (const rg of REGIONS) {
    try {
      const c = await countFires(rg.box);
      regions.push({ name: rg.name, count: c });
      total += c; okAny = true;
      console.log('OK  ' + rg.name + ': ' + c);
    } catch (e) {
      regions.push({ name: rg.name, count: null });
      if (!firstErr) firstErr = e.message;
      console.error('ERR ' + rg.name + ': ' + e.message);
    }
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'NASA FIRMS VIIRS S-NPP',
    day_range: DAYS,
    frame: new Date().toISOString().slice(0, 10),
    regions,
    total: okAny ? total : null
  };
  if (!okAny && firstErr) out.note = 'FIRMS fetch failed — ' + firstErr;

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('fires.json written — total: ' + out.total + (out.note ? (' | ' + out.note) : ''));
})().catch((e) => { console.error('fatal', e); process.exit(1); });
