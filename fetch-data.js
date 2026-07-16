/**
 * SUHU cloud data fetcher.
 *
 * Runs on GitHub Actions (or any serverless runner) — NOT on your computer.
 * Node 18+ (built-in fetch). No dependencies. No Python.
 *
 * What it does:
 *   1. Loads the existing data.json (keeps last-known-good values).
 *   2. Fetches each agency feed *server-side* (no browser = no CORS problem).
 *   3. Parses what it can, classifies against thresholds, updates data.json.
 *   4. Anything that fails keeps its previous value and is flagged "stale".
 *
 * Niño 3.4 is implemented end-to-end as the reference. SOI / DMI / MJO have
 * documented fetch stubs with real endpoints — fill in the parser for each
 * (they are plain text / CSV, so parsing is a few lines each).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'data.json');

// ---- helpers --------------------------------------------------------------
async function getText(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SUHU-monitor/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function classifyNino(anom) {
  if (anom >= 2.0) return ['Very strong El Niño ("super")', 's-hot', 'var(--hot)', 95];
  if (anom >= 1.5) return ['Strong El Niño', 's-hot', 'var(--hot)', 88];
  if (anom >= 1.0) return ['Moderate El Niño · strengthening', 's-hot', 'var(--hot)', 80];
  if (anom >= 0.5) return ['Weak El Niño', 's-dry', 'var(--dry)', 65];
  if (anom > -0.5) return ['Neutral', 's-neu', 'var(--neutral)', 50];
  if (anom > -1.0) return ['Weak La Niña', 's-wet', 'var(--wet)', 35];
  return ['Moderate+ La Niña', 's-wet', 'var(--wet)', 20];
}

// ---- source fetchers ------------------------------------------------------

// Niño 3.4 — NOAA CPC detrended weekly ASCII. Fully implemented.
async function fetchNino34() {
  const url = 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/detrend.nino34.ascii.txt';
  const txt = await getText(url);
  const rows = txt.trim().split('\n').map(l => l.trim().split(/\s+/)).filter(r => r.length >= 5);
  const last = rows[rows.length - 1];               // YR MON TOTAL CLIM ANOM
  const anom = parseFloat(last[last.length - 1]);
  const [status, cls, gcol, gauge] = classifyNino(anom);
  return {
    value: (anom >= 0 ? '+' : '') + anom.toFixed(1) + '°C',
    status, cls, gcol, gauge,
    _anom: anom
  };
}

/* SOI — Australia BoM 30-day.
   Endpoint (plain text): ftp/http BoM SOI, or LongPaddock SOI dashboard data.
   e.g. http://www.bom.gov.au/climate/enso/soi/  (scrape latest 30-day value)
async function fetchSOI() { ... parse latest 30-day value ... } */

/* DMI (IOD) — JAMSTEC SINTEX-F monthly CSV via APL VirtualEarth,
   or JMA TCC IOD index text: https://ds.data.jma.go.jp/tcc/tcc/products/elnino/index/
async function fetchDMI() { ... } */

/* MJO (RMM) — Australia BoM RMM text: http://www.bom.gov.au/climate/mjo/
   (RMM1, RMM2 -> phase = atan2, amplitude = sqrt(RMM1^2+RMM2^2))
async function fetchMJO() { ... } */

// ---- main -----------------------------------------------------------------
(async () => {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const now = new Date();
  data.generated = now.toISOString();
  data.snapshotDate = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const setSource = (name, ok) => {
    const row = data.sources.find(s => s[0].startsWith(name));
    if (row) { row[3] = ok ? 'live' : 'stale'; row[4] = ok ? 'just now' : row[4]; }
  };

  // Niño 3.4 / ONI card
  try {
    const n = await fetchNino34();
    const card = data.drivers.find(d => d.key === 'enso');
    Object.assign(card, { value: n.value, status: n.status, cls: n.cls, gcol: n.gcol, gauge: n.gauge });
    // push onto history chart
    const h = data.nino34history;
    const label = now.toLocaleDateString('en-GB', { month: 'short' });
    if (h.labels[h.labels.length - 1] !== label) { h.labels.push(label); h.values.push(n._anom); }
    else { h.values[h.values.length - 1] = n._anom; }
    if (h.labels.length > 12) { h.labels.shift(); h.values.shift(); }
    setSource('Niño', true);
    console.log('Niño 3.4 updated:', n.value, '—', n.status);
  } catch (e) {
    setSource('Niño', false);
    console.error('Niño 3.4 fetch failed, keeping last value:', e.message);
  }

  // TODO: repeat the pattern for SOI / DMI / MJO once their parsers are filled in.
  //   const s = await fetchSOI(); update data.drivers key 'soi'; setSource('SOI', true);

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('data.json written at', data.generated);
})().catch(e => { console.error('fatal', e); process.exit(1); });
