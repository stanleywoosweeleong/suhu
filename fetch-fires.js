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
 * Uses `curl` (IPv4, generous timeout) instead of Node's fetch/https. Node's
 * built-in HTTP stack has repeatedly failed to connect to FIRMS from CI runners
 * ("fetch failed" / connect timeout) even though the key and endpoint are fine.
 * curl is the battle-tested HTTP client on runners and its errors are clear.
 *
 * FIRMS area API (CSV):
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SRC}/{W,S,E,N}/{days}
 *   AREA_COORDINATES order is west,south,east,north (verified against FIRMS docs).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OUT = path.join(__dirname, 'impact', 'fires.json');
// Strip any whitespace/newlines a pasted secret may carry.
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

// GET via curl: force IPv4, follow redirects, 60s cap; append the HTTP status.
function curlGet(url) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--ipv4', '--max-time', '60',
      '-A', 'SUHU-monitor/1.0', '-w', '\\n%{http_code}', url];
    execFile('curl', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        return reject(new Error('curl: ' + String(stderr || err.message).trim().replace(/\s+/g, ' ').slice(0, 120)));
      }
      const i = stdout.lastIndexOf('\n');
      const status = parseInt(stdout.slice(i + 1).trim(), 10) || 0;
      resolve({ status, txt: stdout.slice(0, i) });
    });
  });
}

async function fetchText(url, tries = 2) {
  let lastErr = 'request failed';
  for (let i = 0; i < tries; i++) {
    try { return await curlGet(url); }
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
  if (status && status !== 200) throw new Error('HTTP ' + status + ': ' + txt.slice(0, 80).replace(/\s+/g, ' '));
  const lines = txt.trim().split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return 0;
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
