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
 * Uses the https module with IPv4 forced (family: 4). Node's built-in fetch
 * (undici) often fails on CI runners with a bare "fetch failed" when it tries
 * IPv6 — this avoids that. Retries transient failures and logs the real cause.
 *
 * FIRMS area API (CSV):
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SRC}/{W,S,E,N}/{days}
 *   AREA_COORDINATES order is west,south,east,north (verified against FIRMS docs).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = path.join(__dirname, 'impact', 'fires.json');
// Strip any whitespace/newlines a pasted secret may carry (a trailing newline
// makes every request URL invalid).
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

// GET over https, forcing IPv4, following redirects, with a timeout.
function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      family: 4,
      headers: { 'User-Agent': 'SUHU-monitor/1.0', 'Accept': 'text/csv,*/*' },
      timeout: 25000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 4) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).href, redirects + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, txt: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 25s')));
    req.on('error', (e) => reject(new Error(e.code || e.message)));
  });
}

async function fetchText(url, tries = 3) {
  let lastErr = 'request failed';
  for (let i = 0; i < tries; i++) {
    try { return await httpGet(url); }
    catch (e) { lastErr = e.message; }
    if (i < tries - 1) await sleep(2000);
  }
  throw new Error(lastErr);
}

async function countFires(box) {
  const [w, s, e, n] = box;
  const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    KEY + '/' + SRC + '/' + w + ',' + s + ',' + e + ',' + n + '/' + DAYS;
  const { status, txt } = await fetchText(url);
  if (status !== 200) throw new Error('HTTP ' + status + ': ' + txt.slice(0, 80).replace(/\s+/g, ' '));
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
