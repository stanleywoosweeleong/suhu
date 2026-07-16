/**
 * SUHU Himawari image mirror (Option 1).
 *
 * Runs on GitHub Actions — NOT on your computer. Fetches the latest Himawari-9
 * frame SERVER-SIDE (so hotlink/CORS blocking doesn't apply) and saves it into
 * himawari/ as your own copy. The app then displays your copy.
 *
 * PRIMARY: JMA Meteorological Satellite Center — Southeast Asia sector,
 *          Band 13 infrared. Works day AND night, framed on the region.
 *          URL pattern: .../img/se1/se1_b13_HHMM.jpg   (HHMM = UTC, 10-min steps)
 *
 * FALLBACK: NICT Himawari real-time — true-colour full disk (dark at night).
 *
 * Clock: we read NICT's latest.json only to learn the newest available frame
 * time, then request the JMA sector for that same time (stepping back a few
 * 10-min slots if a slot is missing). This avoids guessing observation latency
 * and avoids accidentally grabbing a 24-hour-old frame.
 *
 * On any failure the previous image is left untouched (job still succeeds).
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'himawari');
const NICT_LATEST = 'https://himawari8.nict.go.jp/img/D531106/latest.json';
const NICT_IMG = 'https://himawari8.nict.go.jp/img/D531106/1d/550'; // 1 tile = full disk
const JMA_BASE = 'https://www.data.jma.go.jp/mscweb/data/himawari/img/se1'; // Southeast Asia 1
const JMA_PROD = 'se1_b13'; // Band 13 infrared

const pad = (n) => String(n).padStart(2, '0');
const UA = { 'User-Agent': 'SUHU-monitor/1.0' };

async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: UA });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function getBuf(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: UA });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 2000 ? buf : null; // guard against tiny error bodies
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

// "2026-07-16 09:40:00" -> Date (interpreted as UTC)
function parseUTC(s) {
  const [d, t] = String(s).split(' ');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, mi, sec] = t.split(':').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, mi, sec || 0));
}
function fmtUTC(dt) {
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()) +
    ' ' + pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes()) + ' UTC';
}

// PRIMARY — JMA Southeast Asia B13 infrared, stepping back from the clock time.
async function tryJMA(dateStr) {
  const base = parseUTC(dateStr);
  for (let k = 0; k < 9; k++) {                 // up to ~90 min back to skip gaps
    const dt = new Date(base.getTime() - k * 600000);
    const hhmm = pad(dt.getUTCHours()) + pad(dt.getUTCMinutes());
    for (const ext of ['jpg', 'png']) {          // robust to extension
      const buf = await getBuf(JMA_BASE + '/' + JMA_PROD + '_' + hhmm + '.' + ext);
      if (buf) {
        return {
          buf, image: 'latest.' + ext, frame_utc: fmtUTC(dt),
          source: 'JMA · Southeast Asia · B13 infrared (day & night)'
        };
      }
    }
  }
  return null;
}

// FALLBACK — NICT true-colour full disk for the same clock time.
async function tryNICT(dateStr) {
  const [d, t] = String(dateStr).split(' ');
  const [Y, M, D] = d.split('-');
  const hhmmss = t.replace(/:/g, '');
  const buf = await getBuf(NICT_IMG + '/' + Y + '/' + M + '/' + D + '/' + hhmmss + '_0_0.png');
  if (buf) {
    return {
      buf, image: 'latest.png', frame_utc: dateStr + ' UTC',
      source: 'NICT Himawari-9 · true colour · full disk'
    };
  }
  return null;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  // 1. clock: newest available frame time (from NICT's latest.json)
  let clock;
  try {
    clock = String((await getJson(NICT_LATEST)).date); // "2026-07-16 09:40:00"
  } catch (e) {
    console.error('Could not read frame clock, keeping last image:', e.message);
    return;
  }

  // 2. JMA IR primary, NICT full-disk fallback
  let r = await tryJMA(clock);
  if (!r) r = await tryNICT(clock);
  if (!r) {
    console.error('All Himawari sources failed, keeping last image.');
    return;
  }

  // 3. save our copy; remove the other-format file so only one image remains
  fs.writeFileSync(path.join(DIR, r.image), r.buf);
  const other = r.image === 'latest.jpg' ? 'latest.png' : 'latest.jpg';
  try { fs.unlinkSync(path.join(DIR, other)); } catch (e) { /* not present */ }

  const meta = {
    source: r.source,
    image: r.image,
    frame_utc: r.frame_utc,
    fetched: new Date().toISOString(),
    bytes: r.buf.length,
    attribution: 'Imagery: JMA / NICT (Himawari-9)'
  };
  fs.writeFileSync(path.join(DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('OK mirrored', r.image, '(' + r.buf.length + ' bytes)  frame', r.frame_utc, '·', r.source);
}

main();
