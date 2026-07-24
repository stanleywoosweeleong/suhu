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
  if (a >= 1.0) return ['Moderate El Niño', 's-hot', 'var(--hot)', 80];
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

// Warm Water Volume (upper-ocean heat content, PMEL GODAS). Positive anomaly =
// recharged (warm water built up — El Niño-FAVOURABLE and a LEADING signal, weeks
// to months ahead of the surface); negative = discharged (La Niña-favourable).
// Sign-first: even if the magnitude scale drifts, the recharge/discharge call holds.
function classifyWWV(a) {
  const gauge = clamp(50 + a * 20, 0, 100);
  if (a >= 1.0)  return ['Strongly recharged · El Niño-favourable', 's-dry', 'var(--dry)', gauge];
  if (a >= 0.3)  return ['Recharging · warm build-up', 's-dry', 'var(--dry)', gauge];
  if (a > -0.3)  return ['Neutral heat content', 's-neu', 'var(--neutral)', gauge];
  if (a > -1.0)  return ['Discharging · cool build-up', 's-wet', 'var(--wet)', gauge];
  return ['Strongly discharged · La Niña-favourable', 's-wet', 'var(--wet)', gauge];
}

// 850-hPa West-Pacific zonal wind, standardized. CPC convention is u-wind with
// westerly POSITIVE; anomalous westerlies (weakened trades) accompany El Niño.
// (If a first live run ever disagrees with the known state, flip the two signs.)
function classifyWind(z) {
  const gauge = clamp(50 + z * 20, 0, 100);
  if (z >= 1)  return ['Westerly anomaly · El Niño-coupled', 's-dry', 'var(--dry)', gauge];
  if (z <= -1) return ['Easterly anomaly · La Niña-coupled', 's-wet', 'var(--wet)', gauge];
  return ['Near-normal trade winds', 's-neu', 'var(--neutral)', gauge];
}

// OLR at the dateline (160°E-160°W), standardized. Negative = enhanced convection
// shifted east toward the dateline (El Niño coupling; drier over the Maritime
// Continent / Malaysia). Positive = suppressed there (convection stays over us).
function classifyOLR(z) {
  const gauge = clamp(50 - z * 20, 0, 100); // negative OLR -> higher dry-for-us gauge
  if (z <= -1) return ['Enhanced convection at dateline · El Niño-coupled', 's-dry', 'var(--dry)', gauge];
  if (z >= 1)  return ['Suppressed convection at dateline', 's-wet', 'var(--wet)', gauge];
  return ['Near-normal convection', 's-neu', 'var(--neutral)', gauge];
}

// ENSO "flavor": Eastern-Pacific (canonical) vs Central-Pacific (Modoki). CP events
// (Niño-4 warmest) push the drought toward the Maritime Continent — worse for
// Malaysia — so we flag them. Decided by comparing Niño-4 vs Niño-3 anomalies.
function classifyFlavor(n12, n3, n4, n34) {
  if (n34 >= 0.5) {
    if (n4 >= n3) return ['Central-Pacific (Modoki) El Niño', 's-dry', 'var(--dry)', 80];
    return ['Eastern-Pacific El Niño', 's-dry', 'var(--dry)', 62];
  }
  if (n34 <= -0.5) {
    if (n4 <= n3) return ['Central-Pacific La Niña', 's-wet', 'var(--wet)', 30];
    return ['Eastern-Pacific La Niña', 's-wet', 'var(--wet)', 38];
  }
  return ['Neutral — no clear flavor', 's-neu', 'var(--neutral)', 50];
}

// CPC index files (wpac850, olr, ...) stack blocks of "YEAR v1..v12" rows and end
// with the STANDARDIZED block. Two gotchas handled here: (1) fill values run
// together with no spaces, e.g. "-1.1-999.9-999.9" and "2027-999.9..." — so we
// extract numbers by regex, not by whitespace-splitting; (2) the same (year,month)
// recurs across blocks, so a ">=" tie-break keeps the LAST occurrence = standardized
// (unambiguous magnitude ~±3, same sign as the anomaly). Missing = ±999.9.
function latestCpcStd(text) {
  const lines = text.replace(/<[^>]+>/g, ' ').split(NL);
  let best = null;
  for (const line of lines) {
    const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length < 2) continue;
    const year = nums[0];
    if (!Number.isInteger(year) || year < 1950 || year > 2100) continue;
    const vals = nums.slice(1, 13); // up to 12 months
    for (let m = 0; m < vals.length; m++) {
      const v = vals[m];
      if (!Number.isFinite(v) || Math.abs(v) >= 999) continue; // -999.9 fill (and year-range header's 2nd token)
      if (!best || year > best.year || (year === best.year && m + 1 >= best.month)) {
        best = { year, month: m + 1, value: v };
      }
    }
  }
  return best;
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
  const latest = months[months.length - 1].value; // same rounding the chart shows
  // trend direction from the real data (latest month vs the previous one)
  const prev = months.length >= 2 ? months[months.length - 2].value : latest;
  // trend by EVENT MAGNITUDE so it's correct for both El Niño and La Niña
  // (a La Niña "strengthens" as the anomaly goes more negative):
  const mag = Math.round((Math.abs(latest) - Math.abs(prev)) * 10) / 10;
  const trend = mag >= 0.1 ? 'strengthening' : (mag <= -0.1 ? 'easing' : 'holding steady');
  const [intensity, cls, gcol, gauge] = classifyNino(anom);
  // status = intensity + data-driven trend (so the wording can't contradict the chart)
  const status = Math.abs(anom) >= 0.5 ? (intensity + ' · ' + trend) : intensity;
  // card value uses the same rounded number as the chart's last point -> they always agree
  return { anom, months, patch: { value: fmt(latest) + '°C', status, cls, gcol, gauge } };
}

// ONI / RONI — NOAA CPC seasonal indices. Files are "SEAS YR [TOTAL] ANOM";
// ANOM is always the last column. ONI = official 3-month Niño 3.4 index.
// RONI = the SAME index minus the tropical-mean SST anomaly (removes the
// global-warming background), so it reads lower than ONI in recent years.
async function fetchSeasonal(url) {
  const txt = await getText(url);
  const rows = txt.trim().split(NL).map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 3 && /^[A-Za-z]{3}$/.test(r[0]) && /^\d{4}$/.test(r[1]));
  if (!rows.length) throw new Error('no seasonal rows parsed');
  const last = rows[rows.length - 1];
  return { seas: last[0], anom: parseFloat(last[last.length - 1]) };
}
async function fetchONI() {
  const { anom } = await fetchSeasonal('https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt');
  const [status, cls, gcol, gauge] = classifyNino(anom);
  return { patch: { value: fmt(anom, 2) + '°C', status, cls, gcol, gauge } };
}
async function fetchRONI() {
  const { anom } = await fetchSeasonal('https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt');
  const [status, cls, gcol, gauge] = classifyNino(anom);
  return { patch: { value: fmt(anom, 2) + '°C', status, cls, gcol, gauge } };
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

// MJO — Australia BoM real-time RMM: year month day RMM1 RMM2 phase amplitude.
// We also keep the last ~40 valid days (RMM1,RMM2,amp) as a "track" for the phase
// wheel's trail — the same feed already carries the full daily history.
async function fetchMJO() {
  const txt = await getText('http://www.bom.gov.au/climate/mjo/graphics/rmm.74toRealtime.txt');
  const rows = txt.split(NL)
    .map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 7 && /^\d{4}$/.test(r[0]));
  const valid = [];
  for (const r of rows) {
    const rmm1 = parseFloat(r[3]), rmm2 = parseFloat(r[4]);
    const p = parseInt(r[5], 10), a = parseFloat(r[6]);
    // 1e36 / 999 are BoM missing flags
    if (Number.isFinite(a) && a < 90 && Number.isFinite(p) &&
        Math.abs(rmm1) < 90 && Math.abs(rmm2) < 90) {
      valid.push({ rmm1: +rmm1.toFixed(3), rmm2: +rmm2.toFixed(3), amp: +a.toFixed(2), phase: p });
    }
  }
  if (!valid.length) throw new Error('no valid RMM row parsed');
  const last = valid[valid.length - 1];
  const track = valid.slice(-40).map(v => ({ rmm1: v.rmm1, rmm2: v.rmm2, amp: v.amp }));
  const [status, cls, gcol, gauge] = classifyMJO(last.phase, last.amp);
  return { patch: { value: 'Ph ' + last.phase + ' · ' + last.amp.toFixed(1), status, cls, gcol, gauge,
                    phase: last.phase, amp: last.amp, track } };
}

// WWV (subsurface heat content) — PMEL GODAS, monthly.
// Rows are "YYYYMM  WWVmean  WWVanom", values in scientific notation (m^3), e.g.
//   202606 0.2691901E+16 0.3004249E+15   ->  anomaly = 3.004e14 m^3 = +3.0 (×10^14).
// Last column is the anomaly; we scale to the conventional 10^14 m^3 unit (~±3).
async function fetchWWV() {
  const txt = await getText('https://www.pmel.noaa.gov/tao/wwv/data/wwv.dat');
  const rows = txt.split(NL).map(l => l.trim().split(/\s+/)).filter(r => /^\d{6}$/.test(r[0]));
  let val;
  for (let i = rows.length - 1; i >= 0; i--) {
    const a = parseFloat(rows[i][rows[i].length - 1]); // handles "0.30E+15" and "-.12E+15"
    if (Number.isFinite(a)) { val = a / 1e14; break; }
  }
  if (val === undefined) throw new Error('no WWV row parsed');
  const [status, cls, gcol, gauge] = classifyWWV(val);
  return { patch: { value: fmt(val, 1), status, cls, gcol, gauge } };
}

// 850-hPa West-Pacific trade winds — CPC wpac850 (standardized anomaly).
async function fetchWind() {
  const b = latestCpcStd(await getText('https://www.cpc.ncep.noaa.gov/data/indices/wpac850'));
  if (!b) throw new Error('no wind value parsed');
  const [status, cls, gcol, gauge] = classifyWind(b.value);
  return { patch: { value: fmt(b.value, 1) + 'σ', status, cls, gcol, gauge } };
}

// Dateline OLR (convection) — CPC olr (standardized anomaly).
async function fetchOLR() {
  const b = latestCpcStd(await getText('https://www.cpc.ncep.noaa.gov/data/indices/olr'));
  if (!b) throw new Error('no OLR value parsed');
  const [status, cls, gcol, gauge] = classifyOLR(b.value);
  return { patch: { value: fmt(b.value, 1) + 'σ', status, cls, gcol, gauge } };
}

// ENSO flavor (EP vs CP) — CPC ERSSTv5 Niño regions, monthly.
// Columns: YR MON  NINO1+2 ANOM  NINO3 ANOM  NINO4 ANOM  NINO3.4 ANOM
async function fetchFlavor() {
  const txt = await getText('https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii');
  const rows = txt.trim().split(NL).map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 10 && /^\d{4}$/.test(r[0]) && /^\d{1,2}$/.test(r[1]));
  if (!rows.length) throw new Error('no Niño-region rows parsed');
  const r = rows[rows.length - 1];
  const n12 = parseFloat(r[3]), n3 = parseFloat(r[5]), n4 = parseFloat(r[7]), n34 = parseFloat(r[9]);
  if (![n12, n3, n4, n34].every(Number.isFinite)) throw new Error('bad Niño-region anomalies');
  const [status, cls, gcol, gauge] = classifyFlavor(n12, n3, n4, n34);
  return { patch: { value: 'Niño4 ' + fmt(n4, 1) + ' · N1+2 ' + fmt(n12, 1), status, cls, gcol, gauge } };
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

// ---- national narrative (El Niño / La Niña / neutral, monsoon-aware) -------
const MONSOON = (m) => ([11, 12, 1, 2, 3].includes(m) ? 'NE' : ([5, 6, 7, 8, 9].includes(m) ? 'SW' : 'INTER'));
const MLABEL = { NE: 'Northeast Monsoon', SW: 'Southwest Monsoon', INTER: 'Inter-monsoon' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const region = (rn, risk, label, p) => ({ rn, risk, label, p });

function applyNarrative(data, anom, dmi, month, trend) {
  const mon = MONSOON(month), ml = MLABEL[mon];
  let banner, regions;

  if (anom >= 0.5) {                                   // ---------- El Niño ----------
    const dry = (mon === 'SW' || mon === 'INTER');
    banner = {
      tone: 'warm',
      tag: 'National Climate-Driver Status · ' + ml,
      title: 'El Niño — ' + cap(trend),
      desc: dry
        ? 'El Niño is ' + trend + " during Malaysia's drier season. Expect a warm, dry bias with elevated drought and transboundary-haze risk"
          + (dmi >= 0.4 ? ', compounded by a positive Indian Ocean Dipole.' : '.')
        : 'El Niño is ' + trend + ' during the northeast monsoon, tending to suppress rainfall — a drier-than-normal wet season. Lower flood risk, but watch for water stress.',
      pills: dry ? [['hot', 'Warm bias'], ['dry', 'Drought risk'], ['watch', '🔥 Haze watch']]
                 : [['hot', 'Warm bias'], ['dry', 'Drier wet season']]
    };
    if (dmi >= 0.4) banner.pills.push(['dry', 'Positive IOD']);
    regions = [
      region('Peninsula — West Coast', dry ? 'r-high' : 'r-mod', dry ? 'High risk' : 'Moderate',
        dry ? 'Driest & most haze-prone zone now. Heat + reduced rainfall; watch Klang Valley/Melaka air quality.'
            : 'Drier than normal; reduced rainfall, limited flood risk. Watch water supply.'),
      region('Peninsula — East Coast', 'r-mod', 'Moderate',
        mon === 'NE' ? 'NE monsoon suppressed by El Niño — a drier wet season, lower flood risk than usual.'
                     : 'Near-normal to drier; main flood season is Nov–Mar.'),
      region('Sabah', 'r-mod', 'Moderate',
        'Drier bias; agricultural water stress and localised fire risk possible.'),
      region('Sarawak', dry ? 'r-high' : 'r-mod', dry ? 'High risk' : 'Moderate',
        'Peatland fire & haze risk elevated under prolonged dry conditions; monitor hotspots.')
    ];
  } else if (anom <= -0.5) {                            // ---------- La Niña ----------
    const wet = (mon === 'NE' || mon === 'INTER');
    banner = {
      tone: 'cool',
      tag: 'National Climate-Driver Status · ' + ml,
      title: 'La Niña — ' + cap(trend),
      desc: wet
        ? 'La Niña is ' + trend + " during the northeast monsoon — Malaysia's flood season. Expect a wetter, cooler bias with elevated flood and landslide risk, especially the east-coast Peninsula, Sabah and Sarawak"
          + (dmi <= -0.4 ? ', compounded by a negative Indian Ocean Dipole.' : '.')
        : 'La Niña is ' + trend + ' during the southwest monsoon, tending to enhance rainfall — a wetter-than-normal dry season. Lower haze risk, but localised flooding possible.',
      pills: wet ? [['wet', 'Wet bias'], ['wet', 'Flood risk'], ['watch', 'Landslide watch']]
                 : [['wet', 'Wet bias'], ['wet', 'Wetter than normal']]
    };
    if (dmi <= -0.4) banner.pills.push(['wet', 'Negative IOD']);
    regions = [
      region('Peninsula — West Coast', 'r-mod', 'Moderate',
        'Wetter than normal; localised flash-flood risk in heavy downpours.'),
      region('Peninsula — East Coast', wet ? 'r-high' : 'r-mod', wet ? 'High risk' : 'Moderate',
        wet ? 'NE monsoon amplified by La Niña — highest flood risk. Watch Kelantan, Terengganu, Pahang.'
            : 'Wetter than normal; flood season is Nov–Mar.'),
      region('Sabah', wet ? 'r-high' : 'r-mod', wet ? 'High risk' : 'Moderate',
        'Enhanced rainfall; flood and landslide risk, especially the east coast.'),
      region('Sarawak', wet ? 'r-high' : 'r-mod', wet ? 'High risk' : 'Moderate',
        'Wetter conditions; river flooding and landslide risk in the interior.')
    ];
  } else {                                             // ---------- Neutral ----------
    banner = {
      tone: 'neutral',
      tag: 'National Climate-Driver Status · ' + ml,
      title: 'ENSO-neutral',
      desc: 'The Pacific is near neutral, so the ' + ml + ' drives conditions. No strong basin-scale push toward drought or flood; watch the monsoon and MJO for shorter-term swings.',
      pills: [['watch', 'Near-normal'], ['watch', ml]]
    };
    regions = [
      region('Peninsula — West Coast', 'r-low', 'Low', 'Near-normal; monsoon-driven weather.'),
      region('Peninsula — East Coast', mon === 'NE' ? 'r-mod' : 'r-low', mon === 'NE' ? 'Moderate' : 'Low',
        mon === 'NE' ? 'Northeast monsoon rains — usual seasonal flood watch.' : 'Near-normal seasonal conditions.'),
      region('Sabah', 'r-low', 'Low', 'Near-normal; watch the MJO for short-term wet spells.'),
      region('Sarawak', 'r-low', 'Low', 'Near-normal seasonal conditions.')
    ];
  }
  data.banner = banner;
  data.regions = regions;
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
  await runDriver(data, 'oni', 'ONI', fetchONI);
  await runDriver(data, 'roni', 'RONI', fetchRONI);
  await runDriver(data, 'flavor', 'ENSO flavor', fetchFlavor);
  await runDriver(data, 'hc', 'Heat content', fetchWWV);
  await runDriver(data, 'soi', 'SOI', fetchSOI);
  await runDriver(data, 'wind', 'Trade winds', fetchWind);
  await runDriver(data, 'olr', 'OLR', fetchOLR);
  await runDriver(data, 'iod', 'DMI', fetchDMI);
  await runDriver(data, 'mjo', 'MJO', fetchMJO);

  // National narrative from the live ENSO sign + IOD + monsoon month
  try {
    const h = data.nino34history;
    const a = h.values[h.values.length - 1];
    const pv = h.values.length >= 2 ? h.values[h.values.length - 2] : a;
    const mg = Math.round((Math.abs(a) - Math.abs(pv)) * 10) / 10;
    const tr = mg >= 0.1 ? 'strengthening' : (mg <= -0.1 ? 'easing' : 'holding steady');
    const dmiCard = data.drivers.find(d => d.key === 'iod');
    const dmi = dmiCard ? parseFloat(String(dmiCard.value).replace('−', '-')) : 0;
    applyNarrative(data, a, Number.isFinite(dmi) ? dmi : 0, now.getUTCMonth() + 1, tr);
  } catch (e) { console.error('narrative compute failed:', e.message); }

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('data.json written at', data.generated);
}

// Only auto-run when executed directly (so tests can import the helpers).
if (require.main === module) {
  main().catch(e => { console.error('fatal', e); process.exit(1); });
}

module.exports = { latestMonthly, latestCpcStd, classifyNino, classifySOI, classifyDMI, classifyMJO, classifyWWV, classifyWind, classifyOLR, classifyFlavor, fmt };
