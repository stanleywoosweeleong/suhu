/**
 * SUHU cloud data fetcher.
 *
 * Runs on GitHub Actions (or any serverless runner) — NOT on your computer.
 * Node 18+ (built-in fetch, auto-gunzips). No dependencies. No Python.
 *
 * Updates all four drivers live:
 *   • Niño 3.4  — NOAA CPC detrended weekly ASCII
 *   • SOI       — Australia BoM Troup SOI (monthly plain text)
 *   • DMI (IOD) — NOAA PSL HadISST Dipole Mode Index (monthly)
 *   • MJO (RMM) — Australia BoM real-time RMM series (daily)
 *
 * Anything that fails keeps its previous value and is flagged "stale".
 * Every parser is defensive: missing-value flags are filtered, and the
 * most recent valid observation is used.
 */

const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'data.json');

const NL = /\r?\n/; // line splitter (handles LF and CRLF)

// ---- fetch helper ---------------------------------------------------------
async function getText(url, ms = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SUHU-monitor/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();   // Node auto-decompresses gzip
  } finally { clearTimeout(t); }
}

const fmt = (v, dp = 1) => (v >= 0 ? '+' : '') + v.toFixed(dp);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- generic monthly-grid parser ------------------------------------------
// Handles "YEAR v1 v2 ... v12" tables (SOI Troup, PSL long.data). Strips any
// HTML, skips header/footer lines, and returns the most recent valid value.
// `isMissing(v)` decides which numbers are fill values.
function latestMonthly(text, isMissing) {
  const lines = text.replace(/<[^>]+>/g, ' ').split(NL);
  let best = null; // { year, month, value }
  for (const line of lines) {
    const toks = line.trim().split(/\s+/).map(Number);
    if (toks.length < 2) continue;
    const year = toks[0];
    if (!Number.isInteger(year) || year < 1870 || year > 2100) continue;
    const vals = toks.slice(1, 13); // up to 12 months
    for (let m = 0; m < vals.length; m++) {
      const v = vals[m];
      if (!Number.isFinite(v) || isMissing(v)) continue;
      if (!best || year > best.year || (year === best.year && m + 1 > best.month)) {
        best = { year, month: m + 1, value: v };
      }
    }
  }
  return best;
}

// ---- classifiers ----------------------------------------------------------
function classifyNino(a) {
  if (a >= 2.0) return ['Very strong El Niño ("super")', 's-hot', 'var(--hot)', 95];
  if (a >= 1.5) return ['Strong El Niño', 's-hot', 'var(--hot)', 88];
  if (a >= 1.0) return ['Moderate El Niño · strengthening', 's-hot', 'var(--hot)', 80];
  if (a >= 0.5) return ['Weak El Niño', 's-dry', 'var(--dry)', 65];
  if (a > -0.5) return ['Neutral', 's-neu', 'var(--neutral)', 50];
  if (a > -1.0) return ['Weak La Niña', 's-wet', 'var(--wet)', 35];
  return ['Moderate+ La Niña', 's-wet', 'var(--wet)', 20];
}

// BoM Troup SOI (scale roughly ±35). Negative = El Niño-coupled = drier for Malaysia.
function classifySOI(s) {
  const gauge = clamp(50 - s * 1.6, 0, 100); // negative SOI -> high (dry) gauge
  if (s <= -14) return ['Strongly El Niño-coupled', 's-dry', 'var(--dry)', gauge];
  if (s <= -7)  return ['El Niño-coupled', 's-dry', 'var(--dry)', gauge];
  if (s < 7)    return ['Neutral', 's-neu', 'var(--neutral)', gauge];
  if (s < 14)   return ['La Niña-coupled', 's-wet', 'var(--wet)', gauge];
  return ['Strongly La Niña-coupled', 's-wet', 'var(--wet)', gauge];
}

// Dipole Mode Index (°C). Positive = drier SE Asia (compounds El Niño).
function classifyDMI(d) {
  const gauge = clamp(50 + d * 50, 0, 100); // positive DMI -> high (dry) gauge
  if (d >= 0.4)  return ['Positive IOD · drier for SE Asia', 's-dry', 'var(--dry)', gauge];
  if (d <= -0.4) return ['Negative IOD · wetter for SE Asia', 's-wet', 'var(--wet)', gauge];
  return ['Neutral', 's-neu', 'var(--neutral)', gauge];
}

// MJO: amplitude<1 = weak. Phases 3-5 enhance convection over the Maritime
// Continent (wetter); phases 6-8 & 1 are suppressed (drier) for Malaysia.
function classifyMJO(phase, amp) {
  const gauge = clamp(amp * 45, 0, 100);
  if (amp < 1) return ['Weak · little MJO influence', 's-neu', 'var(--neutral)', gauge];
  if (phase >= 3 && phase <= 5) return ['Active · wet pulse over Maritime Continent', 's-wet', 'var(--wet)', gauge];
  return ['Active · suppressed over Maritime Continent', 's-dry', 'var(--dry)', gauge];
}

// ---- source fetchers ------------------------------------------------------

// Niño 3.4 — NOAA CPC detrended monthly ASCII: YR MON TOTAL CLIM ANOM.
// Returns the latest anomaly AND the last 12 real months (for the trend chart),
// so the chart is built entirely from live data — no placeholders.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
async function fetchNino34() {
  const txt = await getText('https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/detrend.nino34.ascii.txt');
  const rows = txt.trim().split(NL)
    .map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 5 && /^\d{4}$/.test(r[0])); // skip the header row
  const parsed = rows
    .map(r => ({ mon: parseInt(r[1], 10), anom: parseFloat(r[r.length - 1]) }))
    .filter(x => x.mon >= 1 && x.mon <= 12 && Number.isFinite(x.anom));
  if (!parsed.length) throw new Error('no Niño 3.4 rows parsed');
  const recent = parsed.slice(-12); // last 12 real months
  const months = recent.map(x => ({ label: MON[x.mon - 1], value: Math.round(x.anom * 10) / 10 }));
  const anom = recent[recent.length - 1].anom;
  const [status, cls, gcol, gauge] = classifyNino(anom);
  return { anom, months, patch: { value: fmt(anom) + '°C', status, cls, gcol, gauge } };
}

// SOI — Australia BoM Troup SOI, monthly plain text.
async function fetchSOI() {
  const txt = await getText('http://www.bom.gov.au/climate/enso/soiplaintext.html');
  const b = latestMonthly(txt, v => Math.abs(v) >= 90); // 999 / -999 = missing
  if (!b) throw new Error('no valid SOI value parsed');
  const [status, cls, gcol, gauge] = classifySOI(b.value);
  return { patch: { value: fmt(b.value), status, cls, gcol, gauge } };
}

// DMI (IOD) — source chain: JAMSTEC SINTEX-F primary, NOAA PSL fallback.
// JAMSTEC's static dmi.monthly.txt now redirects to APL VirtualEarth; when a
// source carries no numeric grid the parser returns null and we move to the
// next source automatically. Both indices are HadISST-based, so values match.
// To force JAMSTEC's new portal, point the first url at its VirtualEarth
// CSV/JSON export once you have that endpoint.
const DMI_SOURCES = [
  { name: 'JAMSTEC', url: 'https://www.jamstec.go.jp/aplinfo/sintexf/DATA/dmi.monthly.txt' },
  { name: 'NOAA PSL', url: 'https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data' }
];
async function fetchDMI() {
  let best, used;
  for (const s of DMI_SOURCES) {
    try {
      const parsed = latestMonthly(await getText(s.url), v => v <= -90 || v >= 90);
      if (parsed) { best = parsed; used = s.name; break; }
    } catch (e) { /* source down or unparsable — try the next one */ }
  }
  if (!best) throw new Error('all DMI sources failed');
  const [status, cls, gcol, gauge] = classifyDMI(best.value);
  const src = 'DMI chain: JAMSTEC -> NOAA PSL (used ' + used + ')';
  return { patch: { value: fmt(best.value, 2) + '°C', status, cls, gcol, gauge, src } };
}

// MJO — Australia BoM real-time RMM: year month day RMM1 RMM2 phase amplitude
async function fetchMJO() {
  const txt = await getText('http://www.bom.gov.au/climate/mjo/graphics/rmm.74toRealtime.txt');
  const rows = txt.split(NL)
    .map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 7 && /^\d{4}$/.test(r[0]));
  // walk backward to the last row with a valid (non-1e36 / non-999) amplitude
  let phase, amp;
  for (let i = rows.length - 1; i >= 0; i--) {
    const a = parseFloat(rows[i][6]);
    const p = parseInt(rows[i][5], 10);
    if (Number.isFinite(a) && a < 100 && Number.isFinite(p)) { amp = a; phase = p; break; }
  }
  if (amp === undefined) throw new Error('no valid RMM row parsed');
  const [status, cls, gcol, gauge] = classifyMJO(phase, amp);
  return { patch: { value: 'Ph ' + phase + ' · ' + amp.toFixed(1), status, cls, gcol, gauge } };
}

// ---- driver runner --------------------------------------------------------
function setSource(data, name, ok) {
  const row = data.sources.find(s => s[0].startsWith(name));
  if (row) { row[3] = ok ? 'live' : 'stale'; if (ok) row[4] = 'just now'; }
}

async function runDriver(data, key, sourceName, fn, extra) {
  const card = data.drivers.find(d => d.key === key);
  try {
    const { patch, ...rest } = await fn();
    Object.assign(card, patch);
    if (extra) extra(rest, card, data);
    setSource(data, sourceName, true);
    console.log('OK  ' + key + ': ' + card.value + ' — ' + card.status);
  } catch (e) {
    setSource(data, sourceName, false);
    console.error('ERR ' + key + ' failed, keeping last value: ' + e.message);
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const now = new Date();
  data.generated = now.toISOString();
  data.snapshotDate = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  await runDriver(data, 'enso', 'Niño', fetchNino34, (rest, card, d) => {
    // Rebuild the whole trend from real NOAA months (no placeholders, no dupes).
    if (rest.months && rest.months.length) {
      const h = d.nino34history;
      h.labels = rest.months.map(m => m.label);
      h.values = rest.months.map(m => m.value);
      h.labels[h.labels.length - 1] += '*'; // mark current (partial) month
    }
  });
  await runDriver(data, 'soi', 'SOI', fetchSOI);
  await runDriver(data, 'iod', 'DMI', fetchDMI);
  await runDriver(data, 'mjo', 'MJO', fetchMJO);

  // Keep the ONI card's colour in step with the latest Niño 3.4 value.
  const enso = data.drivers.find(d => d.key === 'enso');
  const oni = data.drivers.find(d => d.key === 'oni');
  if (enso && oni) { oni.cls = enso.cls; oni.gcol = enso.gcol; }

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('data.json written at', data.generated);
}

// Only auto-run when executed directly (so tests can import the helpers).
if (require.main === module) {
  main().catch(e => { console.error('fatal', e); process.exit(1); });
}

module.exports = { latestMonthly, classifyNino, classifySOI, classifyDMI, classifyMJO, fmt };
