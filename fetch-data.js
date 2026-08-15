/**
 * SUHU cloud data fetcher.
 *
 * Runs on GitHub Actions (or any serverless runner) — NOT on your computer.
 * Node 18+ (built-in fetch, auto-gunzips). No dependencies. No Python.
 *
 * Updates all four drivers live:
 *   • Niño 3.4  — NOAA CPC WEEKLY OISSTv2.1 (wksst9120.for), 1991-2020 base.
 *                 Fallback: CPC ERSSTv5 monthly Niño regions (same base).
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
    // PSL's newer files are CSV: "YYYY-MM-01,   value". The whitespace-split
    // path below cannot read those, so handle the row shape first.
    const csv = line.trim().match(/^(\d{4})-(\d{2})-\d{2}\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (csv) {
      const v = parseFloat(csv[3]);
      if (Number.isFinite(v) && !isMissing(v)) {
        const y = +csv[1], mo = +csv[2];
        if (!best || y > best.year || (y === best.year && mo > best.month)) best = { year: y, month: mo, value: v };
      }
      continue;
    }
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

// ---- history series (for the compact per-card sparklines) -----------------
const lastN = (arr, n) => (arr || []).slice(-n).map(v => Math.round(v * 100) / 100);
// "YEAR v1..v12" grids (SOI Troup, DMI) -> chronological value array.
function monthlySeries(text, isMissing) {
  const out = [];
  for (const line of text.replace(/<[^>]+>/g, ' ').split(NL)) {
    const csv = line.trim().match(/^(\d{4})-(\d{2})-\d{2}\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (csv) {
      const v = parseFloat(csv[3]);
      if (Number.isFinite(v) && !isMissing(v)) out.push({ year: +csv[1], m: +csv[2], v });
      continue;
    }
    const toks = line.trim().split(/\s+/).map(Number);
    if (toks.length < 2) continue;
    const year = toks[0];
    if (!Number.isInteger(year) || year < 1870 || year > 2100) continue;
    toks.slice(1, 13).forEach((v, i) => { if (Number.isFinite(v) && !isMissing(v)) out.push({ year, m: i + 1, v }); });
  }
  out.sort((a, b) => a.year - b.year || a.m - b.m);
  return out.map(o => o.v);
}
// CPC seasonal files (ONI/RONI): "SEAS YR [TOTAL] ANOM" -> anomaly array.
function seasonalSeries(text) {
  return text.trim().split(NL).map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 3 && /^[A-Za-z]{3}$/.test(r[0]) && /^\d{4}$/.test(r[1]))
    .map(r => parseFloat(r[r.length - 1])).filter(Number.isFinite);
}
// CPC standardized-block files (wpac850, olr): the last block, chronological.
function cpcStdSeries(text) {
  const blocks = []; let cur = null;
  for (const line of text.replace(/<[^>]+>/g, ' ').split(NL)) {
    const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length === 2 && Number.isInteger(nums[0]) && Number.isInteger(nums[1]) && nums[0] >= 1900 && nums[1] >= 1900 && nums[0] < nums[1]) { cur = []; blocks.push(cur); continue; }
    if (!nums.length) continue;
    const year = nums[0];
    if (!Number.isInteger(year) || year < 1950 || year > 2100) continue;
    if (!cur) { cur = []; blocks.push(cur); }
    for (let m = 1; m <= 12 && m < nums.length; m++) { const v = nums[m]; if (Number.isFinite(v) && Math.abs(v) < 999) cur.push(v); }
  }
  return blocks[blocks.length - 1] || [];
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

// ---- Niño-region parsers --------------------------------------------------

// CPC week stamps look like "05AUG2026". Convert to a sortable timestamp.
const WK_MON = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
function weekTs(d) {
  const m = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(d);
  if (!m) return 0;
  const mon = WK_MON[m[2].toUpperCase()];
  if (mon === undefined) return 0;
  return Date.UTC(+m[3], mon, +m[1]);
}

// Parse a BoM/CPC prose date ("9 August 2026", or "17 September" with the year
// omitted) into a timestamp. Year-less dates that would land in the future are
// rolled back a year, so an old date can never read as fresh.
const PROSE_MON = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,
                    august:7,september:8,october:9,november:10,december:11 };
function proseDateTs(str) {
  if (!str) return 0;
  const m = /(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?/.exec(String(str));
  if (!m) return 0;
  const mon = PROSE_MON[m[2].toLowerCase()];
  if (mon === undefined) return 0;
  const now = new Date();
  const year = m[3] ? +m[3] : now.getUTCFullYear();
  let ts = Date.UTC(year, mon, +m[1]);
  if (!m[3] && ts > now.getTime()) ts = Date.UTC(year - 1, mon, +m[1]);
  return ts;
}
function ageDays(ts) { return ts > 0 ? Math.round((Date.now() - ts) / 86400000) : Infinity; }

// Maximum age before a feed stops being "current". A fetch that SUCCEEDS but
// returns data older than this is treated as a failure: runDriver keeps the
// previous value and flags the source, so the card shows a ⚠ stale chip instead
// of quietly presenting an old number as today's.
const MAX_AGE_DAYS = {
  iodWeekly:  21,   // BoM publishes weekly
  // PSL's monthly DMI is HadISST-derived and normally runs TWO TO THREE months
  // behind: on 15 Aug 2026 its newest real month was 2026-05, i.e. 92 days old.
  // The old 70-day gate therefore rejected the feed during normal operation,
  // not just when it died. Split into two thresholds:
  //   iodMonthly       -- past this the source is presumed DEAD; throw.
  //   iodMonthlyAdvice -- past this the value is still shown (labelled with its
  //                       month) but is not allowed to drive the drought
  //                       escalation in the narrative banner.
  iodMonthly: 110,
  iodMonthlyAdvice: 75,
  mjo:        10,   // BoM RMM is daily — an old phase is worse than none
};

// CPC WEEKLY file (wksst9120.for). Region order in the file is
//   Nino1+2, Nino3, Nino3.4, Nino4  -- verified against the CPC header.
// Each region is "SST SSTA", so with 8 numbers the anomalies sit at odd indices.
// CPC sometimes glues a negative anomaly onto its SST ("23.4-0.4"), so we pull
// every signed decimal individually instead of splitting on whitespace.
function parseWeeklyNino(text) {
  const rows = [];
  for (const raw of text.replace(/<[^>]+>/g, ' ').split(NL)) {
    const ln = raw.trim();
    const m = /^(\d{1,2}[A-Za-z]{3}\d{4})/.exec(ln);
    if (!m) continue;
    const nums = (ln.slice(m[1].length).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    let n12, n3, n34, n4;
    if (nums.length >= 8) {            // SST + anomaly pairs
      n12 = nums[1]; n3 = nums[3]; n34 = nums[5]; n4 = nums[7];
    } else if (nums.length >= 4) {     // anomaly-only variant
      [n12, n3, n34, n4] = nums.slice(0, 4);
    } else continue;
    if (![n12, n3, n34, n4].every(v => Number.isFinite(v) && Math.abs(v) < 90)) continue;
    rows.push({ date: m[1], ts: weekTs(m[1]), n12, n3, n34, n4 });
  }
  rows.sort((a, b) => a.ts - b.ts);    // never trust file order for "latest"
  return rows;
}

// CPC ERSSTv5 monthly Niño regions (ersst5.nino.mth.91-20.ascii).
// Columns: YR MON  NINO1+2 ANOM  NINO3 ANOM  NINO4 ANOM  NINO3.4 ANOM
// NOTE the order here is 1+2, 3, 4, 3.4 -- it is NOT the same as the weekly file.
function parseErsstNino(text) {
  return text.trim().split(NL).map(l => l.trim().split(/\s+/))
    .filter(r => r.length >= 10 && /^\d{4}$/.test(r[0]) && /^\d{1,2}$/.test(r[1]))
    .map(r => ({
      year: +r[0], mon: +r[1],
      n12: parseFloat(r[3]), n3: parseFloat(r[5]),
      n4:  parseFloat(r[7]), n34: parseFloat(r[9]),
    }))
    .filter(o => [o.n12, o.n3, o.n4, o.n34].every(Number.isFinite));
}

// ---- source fetchers ------------------------------------------------------

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Shared card-building step so the weekly path and the monthly fallback can
// never disagree about classification, trend wording or rounding.
// `points` = [{label, value}, ...] oldest -> newest, already rounded to 1 dp.
function buildNinoCard(points, extra) {
  const latest = points[points.length - 1].value;
  const prev   = points.length >= 2 ? points[points.length - 2].value : latest;
  // Trend by EVENT MAGNITUDE so it reads correctly for El Niño and La Niña alike.
  const mag = Math.round((Math.abs(latest) - Math.abs(prev)) * 10) / 10;
  const trend = mag >= 0.1 ? 'strengthening' : (mag <= -0.1 ? 'easing' : 'holding steady');
  const [intensity, cls, gcol, gauge] = classifyNino(latest);
  const status = Math.abs(latest) >= 0.5 ? (intensity + ' · ' + trend) : intensity;
  return {
    anom: latest,
    months: points,
    patch: Object.assign({
      value: fmt(latest) + '°C', status, cls, gcol, gauge,
      hist: points.map(p => p.value),
    }, extra),
  };
}

// Niño 3.4 -- WEEKLY is the headline number, because that is what CPC, BoM and
// the IRI quote as "the current Niño 3.4". Two earlier bugs lived here:
//   (a) it read detrend.nino34.ascii.txt -- the DETRENDED series, which strips
//       the background warming and therefore reads several tenths low;
//   (b) that file is MONTHLY and lags, so the card sat ~2 months behind reality
//       while still advertising itself as weekly.
// The 12-point trend is now weekly too, so the card value and the chart's last
// point are the same number by construction.
async function fetchNino34Weekly() {
  const txt = await getText('https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for');
  const rows = parseWeeklyNino(txt);
  if (!rows.length) throw new Error('no weekly Niño rows parsed');
  const last = rows[rows.length - 1];
  // Loud staleness check: this file updates every Monday. If the newest week is
  // more than 3 weeks old the feed is broken, so fail over rather than show it.
  const ageDays = Math.round((Date.now() - last.ts) / 86400000);
  if (ageDays > 21) throw new Error('weekly file stale: newest week ' + last.date + ' is ' + ageDays + 'd old');
  const points = rows.slice(-12).map(r => ({ label: r.date.slice(0, 5), value: Math.round(r.n34 * 10) / 10 }));
  return buildNinoCard(points, {
    asOf: last.date, basis: 'weekly',
    src: 'NOAA CPC weekly OISSTv2.1 (wksst9120.for) · 1991-2020 base · week centred ' + last.date,
  });
}

// Fallback only. Same 1991-2020 base, same (undetrended) definition as the
// weekly feed -- just coarser and later. Flagged as basis:'monthly' so the UI
// can say so out loud instead of passing a month off as this week.
async function fetchNino34Monthly() {
  const txt = await getText('https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii');
  const rows = parseErsstNino(txt);
  if (!rows.length) throw new Error('no monthly Niño rows parsed');
  const last = rows[rows.length - 1];
  const points = rows.slice(-12).map(r => ({ label: MON[r.mon - 1], value: Math.round(r.n34 * 10) / 10 }));
  return buildNinoCard(points, {
    asOf: MON[last.mon - 1] + ' ' + last.year, basis: 'monthly',
    src: 'FALLBACK — NOAA CPC ERSSTv5 monthly (ersst5.nino.mth.91-20.ascii) · ' + MON[last.mon - 1] + ' ' + last.year,
  });
}

async function fetchNino34() {
  try {
    return await fetchNino34Weekly();
  } catch (e) {
    console.error('WARN weekly Niño 3.4 unavailable (' + e.message + ') — falling back to ERSSTv5 monthly');
    return await fetchNino34Monthly();
  }
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
  return { seas: last[0], anom: parseFloat(last[last.length - 1]), hist: lastN(seasonalSeries(txt), 12) };
}
async function fetchONI() {
  const { anom, hist } = await fetchSeasonal('https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt');
  const [status, cls, gcol, gauge] = classifyNino(anom);
  return { patch: { value: fmt(anom, 2) + '°C', status, cls, gcol, gauge, hist,
                    src: 'NOAA CPC ONI (oni.ascii.txt) · 3-month running mean' } };
}
async function fetchRONI() {
  const { anom, hist } = await fetchSeasonal('https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt');
  const [status, cls, gcol, gauge] = classifyNino(anom);
  return { patch: { value: fmt(anom, 2) + '°C', status, cls, gcol, gauge, hist,
                    src: 'NOAA CPC RONI (RONI.ascii.txt) · relative to tropical mean' } };
}

// SOI — BoM Troup SOI (±35 scale). BoM's HTML page intermittently returns an
// empty body to non-browser clients (its .txt feeds like MJO are fine), which is
// why SOI kept going stale. Fallback: NOAA CPC's standardized SOI (~±3), scaled
// ×10 to the Troup convention the app classifies on — CPC is on the same reliable
// infrastructure as our other always-live feeds.
async function fetchSOI() {
  try {
    const txt = await getText('https://www.bom.gov.au/climate/enso/soiplaintext.html');
    const b = latestMonthly(txt, v => Math.abs(v) >= 90); // 999 / -999 = missing
    if (b && Math.abs(b.value) <= 60) {
      const [status, cls, gcol, gauge] = classifySOI(b.value);
      return { patch: { value: fmt(b.value), status, cls, gcol, gauge, src: 'Australia BoM (Troup) · fallback NOAA CPC', hist: lastN(monthlySeries(txt, v => Math.abs(v) >= 90), 12) } };
    }
  } catch (e) { /* BoM empty/unreachable — fall through to NOAA CPC */ }
  const cpcTxt = await getText('https://www.cpc.ncep.noaa.gov/data/indices/soi');
  const s = latestCpcStd(cpcTxt);
  if (!s) throw new Error('SOI: BoM empty and CPC parse failed');
  const troup = Math.round((Math.abs(s.value) <= 6 ? s.value * 10 : s.value) * 10) / 10; // standardized -> Troup
  const [status, cls, gcol, gauge] = classifySOI(troup);
  return { patch: { value: fmt(troup), status, cls, gcol, gauge, src: 'NOAA CPC SOI ×10 (BoM fallback)', hist: lastN(cpcStdSeries(cpcTxt).map(v => v * 10), 12) } };
}

// DMI (IOD) — source chain: JAMSTEC SINTEX-F primary, NOAA PSL fallback.
// JAMSTEC's static dmi.monthly.txt now redirects to APL VirtualEarth; when a
// source carries no numeric grid the parser returns null and we move to the
// next source automatically. Both indices are HadISST-based, so values match.
// To force JAMSTEC's new portal, point the first url at its VirtualEarth
// CSV/JSON export once you have that endpoint.
// Monthly DMI fallback chain, tried in order. Verified 15 Aug 2026:
//
//   JAMSTEC dmi.monthly.txt is REMOVED from this list. It still answers HTTP
//   200, but the body is now only a notice pointing at "APL VirtualEarth" with
//   no data in it at all. latestMonthly() returned null and the chain fell
//   through correctly, so nothing broke -- but the source had been silently
//   contributing nothing, which is exactly the failure shape we keep hunting.
//   If it is ever restored, put it back ABOVE the PSL entries.
//
//   PSL is retiring the /gcos_wgsp/Timeseries/ paths ("being taken down", per
//   their own pages). The live location is /data/timeseries/month/data/, so
//   that goes first and the old path stays as a transition fallback.
//
//   The .csv and .data files carry the same series in different shapes;
//   latestMonthly() reads both.
const DMI_SOURCES = [
  { name: 'NOAA PSL (monthly)',    url: 'https://psl.noaa.gov/data/timeseries/month/data/dmi.had.long.csv' },
  { name: 'NOAA PSL (monthly alt)',url: 'https://psl.noaa.gov/data/timeseries/month/data/dmi.had.long.data' },
  { name: 'NOAA PSL (gcos, retiring)', url: 'https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data' }
];
async function fetchDMI() {
  // PRIMARY: BoM WEEKLY IOD — the regionally-authoritative, most-current reading, and
  // the value the "+0.4 positive IOD" drought-escalation rule keys on. BoM publishes no
  // clean machine-readable IOD feed, so it is scraped from bom.gov.au/climate/enso/ by the
  // user's own Cloudflare Worker, which returns {ok,value,asOf}. If the Worker or the
  // scrape is unavailable, we fall back to the monthly JAMSTEC -> NOAA PSL chain below.
  //
  // AGE GATE: a successful scrape is not the same as a current value. BoM can
  // freeze the page, and the drought-escalation rule (DMI >= +0.4) keys on this
  // number — so an unchecked stale IOD would keep escalating dry advice on its
  // own. Past MAX_AGE_DAYS.iodWeekly we abandon the BoM branch and drop to the
  // monthly chain rather than trust it.
  try {
    const o = JSON.parse(await getText('https://enso-proxy.standphoto.workers.dev/?feed=iod'));
    const iodAge = o && o.asOf ? ageDays(proseDateTs(o.asOf)) : Infinity;
    if (o && o.ok === true && o.asOf && iodAge > MAX_AGE_DAYS.iodWeekly) {
      console.warn('WARN BoM weekly IOD is ' + iodAge + 'd old (asOf ' + o.asOf + ') — ignoring, trying monthly chain');
    } else if (o && o.ok === true && !o.asOf) {
      console.warn('WARN BoM weekly IOD carries no date — cannot age-check it, trying monthly chain');
    } else if (o && o.ok === true && typeof o.value === 'number' && Math.abs(o.value) < 5) {
      const [status, cls, gcol, gauge] = classifyDMI(o.value);
      return { patch: {
        value: fmt(o.value, 2) + '°C', status, cls, gcol, gauge,
        src: 'Australia BoM — weekly IOD' + (o.asOf ? ' (' + o.asOf + ')' : ''),
        asOf: o.asOf, adviceOk: true,   // already gated at iodWeekly above
        hist: []   // BoM is a single weekly value — no monthly series
      } };
    }
  } catch (e) { /* Worker/BoM scrape unavailable — fall through to the monthly chain */ }
  let best, used, txtUsed;
  for (const s of DMI_SOURCES) {
    try {
      const t = await getText(s.url);
      const parsed = latestMonthly(t, v => v <= -90 || v >= 90);
      if (parsed) { best = parsed; used = s.name; txtUsed = t; break; }
    } catch (e) { /* source down or unparsable — try the next one */ }
  }
  if (!best) throw new Error('all DMI sources failed');
  // Same gate on the fallback, but calibrated to what a monthly source actually
  // does. Past iodMonthly we presume it has died and throw; between
  // iodMonthlyAdvice and iodMonthly the value is real but too far back to drive
  // farm advice, so it is shown with its month and flagged adviceOk:false.
  const ym = best.year + '-' + String(best.month).padStart(2, '0');
  const mAge = ageDays(Date.UTC(best.year, best.month - 1, 15));
  if (mAge > MAX_AGE_DAYS.iodMonthly) {
    throw new Error('DMI chain stale: newest month ' + ym + ' is ' + mAge + 'd old (limit ' + MAX_AGE_DAYS.iodMonthly + 'd)');
  }
  const adviceOk = mAge <= MAX_AGE_DAYS.iodMonthlyAdvice;
  if (!adviceOk) {
    console.warn('WARN monthly DMI ' + ym + ' is ' + mAge + 'd old — shown for reference, IOD escalation suppressed');
  }
  const [status, cls, gcol, gauge] = classifyDMI(best.value);
  // Stamp the MONTH into the src line. A monthly figure presented without one
  // reads as "now", which is the whole mistake this chain exists to avoid.
  const src = 'Monthly DMI ' + ym + ' — ' + used + (adviceOk ? '' : ' (older than usual)');
  return { patch: { value: fmt(best.value, 2) + '°C', status, cls, gcol, gauge, src, adviceOk,
                    hist: lastN(monthlySeries(txtUsed, v => v <= -90 || v >= 90), 12) } };
}

// MJO ------------------------------------------------------------------------
// PRIMARY is now NOAA PSL's ROMI, not BoM's RMM. Reason, found the hard way:
// BoM's rmm.74toRealtime.txt still serves, still parses, and still ends with a
// plausible-looking row — but its last VALID row is 24 Feb 2024. Everything
// after that is missing-flagged, so "take the last valid row" quietly returned a
// phase from early 2024 for well over a year, with no gate to catch it.
//
// ROMI is OLR-based, updates daily, and Kiladis et al. (2014) define it to be
// directly comparable to RMM: ROMI PC2 is analogous to RMM1, and -ROMI PC1 to
// RMM2. Applying that rotation gives a phase and amplitude the existing wheel
// and classifyMJO() can use unchanged. It is also the same feed the ENSO
// Monitor uses, so the two apps now agree instead of one of them being frozen.
// BoM stays as a fallback in case it comes back — behind the same age gate.
const ROMI_URL    = 'https://psl.noaa.gov/mjo/mjoindex/romi.cpcolr.1x.txt';
const BOM_RMM_URL = 'https://www.bom.gov.au/climate/mjo/graphics/rmm.74toRealtime.txt';

// Standard WH04 RMM phase from (RMM1, RMM2): vector angle split into 8 sectors.
function rmmPhaseOf(rmm1, rmm2) {
  let deg = Math.atan2(rmm2, rmm1) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  if (deg < 45)  return 5;
  if (deg < 90)  return 6;
  if (deg < 135) return 7;
  if (deg < 180) return 8;
  if (deg < 225) return 1;
  if (deg < 270) return 2;
  if (deg < 315) return 3;
  return 4;
}

function mjoCard(last, track, src) {
  const [status, cls, gcol, gauge] = classifyMJO(last.phase, last.amp);
  return { patch: { value: 'Ph ' + last.phase + ' · ' + last.amp.toFixed(1), status, cls, gcol, gauge,
                    phase: last.phase, amp: last.amp, track, src,
                    asOf: new Date(last.ts).toISOString().slice(0, 10) } };
}

// NOAA PSL ROMI: year month day hour PC1 PC2 amplitude.
async function fetchMjoRomi() {
  const txt = await getText(ROMI_URL);
  const valid = [];
  for (const line of txt.split(NL)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 7 || !/^\d{4}$/.test(p[0])) continue;
    const ts = Date.UTC(+p[0], +p[1] - 1, +p[2]);          // p[3] is hour, ignored
    const pc1 = parseFloat(p[4]), pc2 = parseFloat(p[5]), amp = parseFloat(p[6]);
    if (!Number.isFinite(amp) || Math.abs(pc1) > 90 || Math.abs(pc2) > 90) continue;
    if (!Number.isFinite(ts)) continue;
    const rmm1 = pc2, rmm2 = -pc1;                          // ROMI -> RMM convention
    valid.push({ ts, rmm1: +rmm1.toFixed(3), rmm2: +rmm2.toFixed(3),
                 amp: +amp.toFixed(2), phase: rmmPhaseOf(rmm1, rmm2) });
  }
  if (!valid.length) throw new Error('no valid ROMI row parsed');
  valid.sort((a, b) => a.ts - b.ts);
  const last = valid[valid.length - 1];
  const age = ageDays(last.ts);
  if (age > MAX_AGE_DAYS.mjo) {
    throw new Error('ROMI feed stale: newest day ' + new Date(last.ts).toISOString().slice(0, 10) + ' is ' + age + 'd old');
  }
  return mjoCard(last, valid.slice(-40).map(v => ({ rmm1: v.rmm1, rmm2: v.rmm2, amp: v.amp })),
                 'NOAA PSL ROMI (OLR-based, RMM-equivalent per Kiladis 2014) · ' + new Date(last.ts).toISOString().slice(0, 10));
}

// Australia BoM real-time RMM: year month day RMM1 RMM2 phase amplitude.
// Kept as a fallback. 1e36 / 999 are BoM's missing flags.
async function fetchMjoBom() {
  const txt = await getText(BOM_RMM_URL);
  const valid = [];
  for (const line of txt.split(NL)) {
    const r = line.trim().split(/\s+/);
    if (r.length < 7 || !/^\d{4}$/.test(r[0])) continue;
    const ts = Date.UTC(+r[0], +r[1] - 1, +r[2]);
    const rmm1 = parseFloat(r[3]), rmm2 = parseFloat(r[4]);
    const p = parseInt(r[5], 10), a = parseFloat(r[6]);
    if (Number.isFinite(a) && a < 90 && Number.isFinite(p) && Number.isFinite(ts) &&
        Math.abs(rmm1) < 90 && Math.abs(rmm2) < 90) {
      valid.push({ ts, rmm1: +rmm1.toFixed(3), rmm2: +rmm2.toFixed(3), amp: +a.toFixed(2), phase: p });
    }
  }
  if (!valid.length) throw new Error('no valid RMM row parsed');
  valid.sort((a, b) => a.ts - b.ts);
  const last = valid[valid.length - 1];
  const age = ageDays(last.ts);
  if (age > MAX_AGE_DAYS.mjo) {
    throw new Error('BoM RMM feed stale: newest valid day ' + new Date(last.ts).toISOString().slice(0, 10) + ' is ' + age + 'd old');
  }
  return mjoCard(last, valid.slice(-40).map(v => ({ rmm1: v.rmm1, rmm2: v.rmm2, amp: v.amp })),
                 'Australia BoM RMM · ' + new Date(last.ts).toISOString().slice(0, 10));
}

async function fetchMJO() {
  try {
    return await fetchMjoRomi();
  } catch (e) {
    console.warn('WARN ROMI MJO unavailable (' + e.message + ') — trying BoM RMM');
    return await fetchMjoBom();
  }
}

async function fetchWWV() {
  const txt = await getText('https://www.pmel.noaa.gov/tao/wwv/data/wwv.dat');
  const rows = txt.split(NL).map(l => l.trim().split(/\s+/)).filter(r => /^\d{6}$/.test(r[0]));
  const series = rows.map(r => parseFloat(r[r.length - 1]) / 1e14).filter(Number.isFinite); // ×10^14 m^3
  if (!series.length) throw new Error('no WWV row parsed');
  const val = series[series.length - 1];
  const [status, cls, gcol, gauge] = classifyWWV(val);
  return { patch: { value: fmt(val, 1), status, cls, gcol, gauge, hist: lastN(series, 12),
                    src: 'NOAA PMEL TAO — warm water volume (wwv.dat) · ×10^14 m³' } };
}

// 850-hPa West-Pacific trade winds — CPC wpac850 (standardized anomaly).
async function fetchWind() {
  const series = cpcStdSeries(await getText('https://www.cpc.ncep.noaa.gov/data/indices/wpac850'));
  if (!series.length) throw new Error('no wind value parsed');
  const val = series[series.length - 1];
  const [status, cls, gcol, gauge] = classifyWind(val);
  return { patch: { value: fmt(val, 1) + 'σ', status, cls, gcol, gauge, hist: lastN(series, 12),
                    src: 'NOAA CPC 850 hPa zonal wind, W Pacific (wpac850) · standardised' } };
}

// Dateline OLR (convection) — CPC olr (standardized anomaly).
async function fetchOLR() {
  const series = cpcStdSeries(await getText('https://www.cpc.ncep.noaa.gov/data/indices/olr'));
  if (!series.length) throw new Error('no OLR value parsed');
  const val = series[series.length - 1];
  const [status, cls, gcol, gauge] = classifyOLR(val);
  return { patch: { value: fmt(val, 1) + 'σ', status, cls, gcol, gauge, hist: lastN(series, 12),
                    src: 'NOAA CPC OLR at the dateline (olr) · standardised' } };
}

// ENSO flavor (EP vs CP) — CPC ERSSTv5 Niño regions, monthly.
// Columns: YR MON  NINO1+2 ANOM  NINO3 ANOM  NINO4 ANOM  NINO3.4 ANOM
async function fetchFlavor() {
  const txt = await getText('https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii');
  const rows = parseErsstNino(txt);
  if (!rows.length) throw new Error('no Niño-region rows parsed');
  const r = rows[rows.length - 1];
  const [status, cls, gcol, gauge] = classifyFlavor(r.n12, r.n3, r.n4, r.n34);
  const nreg = { n12: +r.n12.toFixed(2), n3: +r.n3.toFixed(2), n4: +r.n4.toFixed(2), n34: +r.n34.toFixed(2) };
  return { patch: { value: 'Niño4 ' + fmt(r.n4, 1) + ' · N1+2 ' + fmt(r.n12, 1), status, cls, gcol, gauge, nreg,
                    src: 'NOAA CPC ERSSTv5 monthly Niño regions · ' + MON[r.mon - 1] + ' ' + r.year } };
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
    // A card's src line must describe the fetch that just happened. If a
    // fetcher does not stamp one, the label in data.json is a static seed and
    // will quietly go out of date -- say so rather than let it lie.
    if (!patch.src) console.warn('NOTE ' + key + ': src not stamped by fetcher (static seed: "' + card.src + '")');
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
    // Rebuild the whole trend from real NOAA data (no placeholders, no dupes).
    if (rest.months && rest.months.length) {
      const h = d.nino34history;
      h.labels = rest.months.map(m => m.label);
      h.values = rest.months.map(m => m.value);
      h.basis  = card.basis || 'weekly';
      // Weekly points are complete weeks, so no partial marker. Only the
      // monthly fallback has an in-progress last point.
      if (h.basis === 'monthly') h.labels[h.labels.length - 1] += '*';
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
    // The IOD escalation rule (DMI >= +0.4) must not fire off a flagged feed.
    // If the DMI source did not refresh this run, feed the narrative a neutral
    // 0 so the banner drops the IOD clause instead of compounding dry risk on
    // a number we already know we could not confirm.
    // setSource() matches source rows by prefix, so look the row up the same way.
    const dmiRow = (data.sources || []).find(r => Array.isArray(r) && String(r[0]).startsWith('DMI'));
    const dmiStale = dmiRow ? dmiRow[3] === 'stale' : false;
    const dmiCard = data.drivers.find(d => d.key === 'iod');
    const dmiRaw = dmiCard ? parseFloat(String(dmiCard.value).replace('−', '-')) : 0;
    // Two ways the IOD clause must be dropped: the source did not refresh at
    // all (stale), or it refreshed but returned a monthly value too far back to
    // speak for right now (adviceOk === false). Either way feed the narrative a
    // neutral 0 rather than let an unconfirmable number compound dry risk.
    const dmiOld = dmiCard ? dmiCard.adviceOk === false : false;
    const dmi = (dmiStale || dmiOld || !Number.isFinite(dmiRaw)) ? 0 : dmiRaw;
    if (dmiStale) console.warn('NOTE DMI flagged stale — IOD escalation suppressed in narrative');
    if (dmiOld) console.warn('NOTE DMI value is an old monthly reading — IOD escalation suppressed in narrative');
    applyNarrative(data, a, dmi, now.getUTCMonth() + 1, tr);
  } catch (e) { console.error('narrative compute failed:', e.message); }

  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log('data.json written at', data.generated);
}

// Only auto-run when executed directly (so tests can import the helpers).
if (require.main === module) {
  main().catch(e => { console.error('fatal', e); process.exit(1); });
}

module.exports = { latestMonthly, latestCpcStd, parseWeeklyNino, parseErsstNino, buildNinoCard, weekTs, classifyNino, classifySOI, classifyDMI, classifyMJO, classifyWWV, classifyWind, classifyOLR, classifyFlavor, fmt };
