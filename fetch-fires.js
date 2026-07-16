/**
 * SUHU fire-hotspot fetcher (transboundary-haze early warning).
 *
 * Runs on GitHub Actions — NOT on your computer. Counts active-fire detections
 * (NASA FIRMS, VIIRS S-NPP) over the regions that drive Malaysian haze, and
 * writes impact/fires.json for the app to read.
 *
 * Needs a FREE NASA FIRMS map key, stored as the repo secret FIRMS_MAP_KEY:
 *   get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/
 * Without the key it writes a graceful placeholder (app shows "not configured").
 *
 * FIRMS area API (CSV):
 *   https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SRC}/{W,S,E,N}/{days}
 *   AREA_COORDINATES order is west,south,east,north (verified against FIRMS docs).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'impact', 'fires.json');
const KEY = process.env.FIRMS_MAP_KEY;
const SRC = 'VIIRS_SNPP_NRT';
const DAYS = 1;

// Bounding boxes [west, south, east, north]. Sumatra & Kalimantan are the
// upwind fire sources for Malaysian haze during the southwest monsoon.
const REGIONS = [
  { name: 'Sumatra',             box: [95, -6, 107, 6] },
  { name: 'Kalimantan',          box: [108, -4, 119, 4] },
  { name: 'Peninsular Malaysia', box: [99, 1, 105, 7] },
  { name: 'Sarawak / Sabah',     box: [109, 0, 119, 8] }
];

async function countFires(box) {
  const [w, s, e, n] = box;
  const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    KEY + '/' + SRC + '/' + w + ',' + s + ',' + e + ',' + n + '/' + DAYS;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'SUHU-monitor/1.0' }, signal: ctl.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.slice(0, 80).replace(/\s+/g, ' '));
    const lines = txt.trim().split(/\r?\n/).filter((l) => l.length);
    // A valid CSV response starts with a header row containing "latitude".
    // Anything else (e.g. "Invalid MAP_KEY", a rate-limit notice) is surfaced.
    if (!lines.length) return 0;
    if (!/latitude/i.test(lines[0])) throw new Error('FIRMS says: ' + lines[0].slice(0, 90).replace(/\s+/g, ' '));
    return Math.max(0, lines.length - 1);
  } finally { clearTimeout(t); }
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
  // If the key is set but every region failed, surface WHY (not "not configured").
  if (!okAny && firstErr) out.note = 'FIRMS fetch failed — ' + firstErr;

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('fires.json written — total hotspots: ' + out.total + (out.note ? (' | note: ' + out.note) : ''));
})().catch((e) => { console.error('fatal', e); process.exit(1); });
