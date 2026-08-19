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
// If the previous run saw at least this many hotspots in total, a sudden
// all-region zero is treated as a feed fault rather than a real reading.
const COLLAPSE_MIN = 50;
// Four FIRMS sources — five spacecraft, two instruments. Matches the Fire
// Alert app's list exactly, so the two never disagree about what they watched.
//
//   VIIRS_NOAA20_NRT   NOAA-20 (JPSS-1)   375 m   ~13:30 local
//   VIIRS_SNPP_NRT     Suomi-NPP          375 m   ~13:30 local
//   VIIRS_NOAA21_NRT   NOAA-21 (JPSS-2)   375 m   ~13:30 local
//   MODIS_NRT          Terra + Aqua       1 km    ~10:30 / ~13:30 local
//
// The three VIIRS birds share one sun-synchronous plane about 50 minutes
// apart, so they are three looks at the SAME hour — and they share one
// processing chain, which is why they can all come back empty together. MODIS
// is the only genuinely independent instrument here, and Terra's ~10:30 pass
// is the only thing in the list seeing a different hour: that is what catches
// a mid-morning burn already out by early afternoon.
//
// Counts are combined by taking the HIGHEST per region, not the first success:
// a valid CSV with zero rows IS a success, so returning early on the aging
// S-NPP feed reported 0 while the others were watching fires. MODIS is coarser
// and will rarely be the maximum — it earns its place on the days when every
// VIIRS source comes back blind.
//
// Deliberately excluded: LANDSAT_NRT (30 m but curated for US/Canada, no
// useful Malaysian coverage) and every _SP source (standard processing, months
// behind — useless for alerting).
const SRCS = ['VIIRS_NOAA20_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const DAYS = 2;   // 48-h window — smooths over overpass timing and NRT latency

const REGIONS = [
  { name: 'Sumatra',             box: [95, -6, 107, 6] },
  { name: 'Kalimantan',          box: [108, -4, 119, 4] },
  { name: 'Peninsular Malaysia', box: [99, 1, 105, 7] },
  { name: 'Sarawak / Sabah',     box: [109, 0, 119, 8] }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ONE box covering every region, so each sensor costs ONE request instead of
// four. The old shape fired 3 sensors x 4 regions = 12 unpaced requests per
// run; FIRMS throttles bursts, which is exactly why this worked one day and
// returned empty bodies the next. Rows are binned into the region boxes here,
// which is also more accurate than four separate queries because it is the
// same snapshot for every region.
const UNION = [
  Math.min(...REGIONS.map((r) => r.box[0])), Math.min(...REGIONS.map((r) => r.box[1])),
  Math.max(...REGIONS.map((r) => r.box[2])), Math.max(...REGIONS.map((r) => r.box[3])),
];
const PACE_MS = 2000;          // between sensor requests
let lastCall = 0;

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

// Validate INSIDE the retry loop.
//
// This used to retry only when curl itself failed. An empty 200 resolves
// perfectly well, so the single most common FIRMS fault -- a body with no CSV
// header -- was never retried even once. Now anything that is not a usable CSV
// is retried, with a longer wait, because an empty body usually means we were
// throttled and hitting it again immediately just spends more of the budget.
async function fetchCsv(url, tries = 4) {
  let lastErr = 'request failed';
  for (let i = 0; i < tries; i++) {
    const wait = PACE_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const { status, txt } = await curlGet(url);
      if (status && status !== 200) {
        lastErr = 'HTTP ' + status + ': ' + txt.slice(0, 80).replace(/\s+/g, ' ');
      } else {
        const lines = txt.trim().split(/\r?\n/).filter((l) => l.length);
        if (!lines.length) lastErr = 'empty body (no CSV header) — throttled or unavailable';
        else if (!/latitude/i.test(lines[0])) lastErr = 'FIRMS: ' + lines[0].slice(0, 90).replace(/\s+/g, ' ');
        else return lines;
      }
    } catch (e) { lastErr = e.message; }
    if (i < tries - 1) await sleep(5000 * (i + 1));   // 5s, 10s, 15s
  }
  throw new Error(lastErr);
}

// One request per sensor over the union box; bin the rows into the region
// boxes ourselves. A point inside two overlapping boxes counts in both, which
// is what four separate queries did too -- kept identical so the numbers stay
// comparable with the history already committed.
function binRows(lines) {
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude');
  if (iLat < 0 || iLon < 0) throw new Error('CSV has no latitude/longitude column');
  const counts = {};
  REGIONS.forEach((r) => { counts[r.name] = 0; });
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const la = parseFloat(c[iLat]), lo = parseFloat(c[iLon]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    for (const r of REGIONS) {
      const [w, so, e, n] = r.box;
      if (lo >= w && lo <= e && la >= so && la <= n) counts[r.name]++;
    }
  }
  return counts;
}

async function countFromSensor(src) {
  const [w, so, e, n] = UNION;
  const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    KEY + '/' + src + '/' + w + ',' + so + ',' + e + ',' + n + '/' + DAYS;
  return binRows(await fetchCsv(url));
}

// Query every sensor and keep the HIGHEST count per region, so one sensor's
// lagging or empty feed cannot blank a region another sensor sees burning.
// Only throws if they ALL fail.
async function countAllRegions() {
  const best = {}, seen = [];
  let anyOk = false, lastErr = 'no sensor tried';
  for (const src of SRCS) {
    const tag = src.replace('VIIRS_', '').replace('_NRT', '');
    try {
      const c = await countFromSensor(src);
      anyOk = true;
      seen.push(tag + '=' + REGIONS.map((r) => c[r.name]).join('/'));
      REGIONS.forEach((r) => {
        if (best[r.name] === undefined || c[r.name] > best[r.name]) best[r.name] = c[r.name];
      });
    } catch (err) { lastErr = err.message; seen.push(tag + '=ERR'); }
  }
  if (!anyOk) throw new Error(lastErr);
  return { best, seen: seen.join('  ') + '   [regions: ' + REGIONS.map((r) => r.name).join('/') + ']' };
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

  // Load the previous fires.json so a region that fails this run can keep its
  // last-good count (flagged stale) instead of blanking out.
  // Carry the per-region asOf forward as well as the count.
  //
  // `generated` is stamped every run, including runs where every region failed,
  // so it says when the JOB ran -- not when the NUMBERS were measured. The app
  // was ageing the card off it, which meant a total that had not refreshed for
  // days still read "updated 4 hours ago", and the stopped-updating branch
  // could never fire while the workflow kept running.
  let prev = {}, prevAsOf = {}, prevTotal = null;
  try {
    const p = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    (p.regions || []).forEach((r) => {
      if (typeof r.count === 'number') prev[r.name] = r.count;
      if (r.asOf) prevAsOf[r.name] = r.asOf;
    });
    if (typeof p.total === 'number') prevTotal = p.total;
  } catch (_) { /* first run — no previous file */ }
  const NOW = new Date().toISOString();

  // ONE pass for every sensor, then assemble the regions from it. The per-
  // region loop used to make its own requests, which is where the 12-request
  // burst came from.
  const regions = [];
  let total = 0, freshAny = false, staleAny = false, firstErr = null;
  let best = null;
  try {
    const r = await countAllRegions();
    best = r.best;
    console.log('OK  sensors: ' + r.seen);
  } catch (e) {
    firstErr = e.message;
    console.error('ERR all sensors failed: ' + e.message);
  }

  for (const rg of REGIONS) {
    const fresh = best && typeof best[rg.name] === 'number';
    if (fresh) {
      regions.push({ name: rg.name, count: best[rg.name], stale: false, asOf: NOW });
      total += best[rg.name]; freshAny = true;
    } else if (rg.name in prev) {          // reuse last-good count
      regions.push({ name: rg.name, count: prev[rg.name], stale: true,
                     asOf: prevAsOf[rg.name] || null });
      total += prev[rg.name]; staleAny = true;
      console.error('STALE ' + rg.name + ': kept ' + prev[rg.name] + ' — ' + firstErr);
    } else {
      regions.push({ name: rg.name, count: null, stale: true, asOf: null });
      console.error('ERR ' + rg.name + ': ' + firstErr);
    }
  }

  // Implausibility guard. Four independent regions across Sumatra, Kalimantan,
  // the Peninsula and Borneo do not all go from hundreds of hotspots to exactly
  // zero overnight -- especially not in August under a strong El Nino. A total
  // collapse means the feed answered oddly, not that the fires went out, so the
  // last-good counts are kept and flagged rather than published as a real zero.
  const collapsed = freshAny && total === 0 && prevTotal !== null && prevTotal >= COLLAPSE_MIN;
  if (collapsed) {
    console.error('SUSPECT every region returned 0 while the last run totalled '
      + prevTotal + ' — keeping last-good counts and flagging partial');
    regions.forEach((r) => {
      if (r.name in prev) { r.count = prev[r.name]; r.stale = true; r.asOf = prevAsOf[r.name] || null; }
      else { r.count = null; r.stale = true; r.asOf = null; }
    });
    total = regions.reduce((a, r) => a + (typeof r.count === 'number' ? r.count : 0), 0);
    staleAny = true;
    firstErr = firstErr || ('all regions returned 0 against a previous total of ' + prevTotal);
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'NASA FIRMS VIIRS — highest of NOAA-20 / S-NPP / NOAA-21',
    day_range: DAYS,
    frame: new Date().toISOString().slice(0, 10),
    regions,
    total: (freshAny || staleAny) ? total : null,
    partial: staleAny || (!freshAny && !staleAny),
    // The total is only as fresh as its STALEST part, so that is what the app
    // must age the card off.
    oldestAsOf: (() => {
      const t = regions.map((r) => r.asOf).filter(Boolean).map((x) => Date.parse(x));
      return t.length === regions.length && t.length ? new Date(Math.min(...t)).toISOString() : null;
    })(),
  };
  // `reason` is for the log and the Action summary. It is NOT for the card:
  // this string is English-only and internal, and it was being rendered raw
  // into a Chinese UI.
  if (staleAny) out.reason = 'Some regions kept last-good values — ' + firstErr;
  else if (!freshAny) out.reason = 'FIRMS fetch failed — ' + firstErr;

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('fires.json written — total: ' + out.total
    + (out.oldestAsOf ? ' | oldest region data: ' + out.oldestAsOf : '')
    + (out.reason ? ' | ' + out.reason : ''));
})().catch((e) => {
  // Never fail the job over a data hiccup — log and exit clean so the workflow stays green.
  console.error('non-fatal:', e && e.message);
  process.exit(0);
});
