/**
 * SUHU Himawari image mirror (Option 1).
 *
 * Runs on GitHub Actions — NOT on your computer. Fetches the latest Himawari-9
 * full-disk frame SERVER-SIDE (so hotlink/CORS blocking doesn't apply) and
 * saves it into himawari/ as your own copy. The app then displays your copy.
 *
 * Source: NICT Himawari real-time (true-colour, full disk). Documented,
 * stable pattern:
 *   latest frame time -> https://himawari8.nict.go.jp/img/D531106/latest.json
 *   single full-disk  -> https://himawari8.nict.go.jp/img/D531106/1d/550/YYYY/MM/DD/HHMMSS_0_0.png
 *
 * On any failure the previous image is left untouched (job still succeeds).
 *
 * NOTE: NICT true-colour is dark at night. To switch to a day+night infrared
 * regional view, point IMG_BASE at JMA's Southeast-Asia B13 sector instead
 * (see README "Himawari mirror"). The rest of this script is source-agnostic.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'himawari');
const LATEST_JSON = 'https://himawari8.nict.go.jp/img/D531106/latest.json';
const IMG_BASE = 'https://himawari8.nict.go.jp/img/D531106/1d/550'; // 1 tile = whole disk, 550px

async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SUHU-monitor/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    // 1. resolve the latest available frame time
    const info = await getJson(LATEST_JSON);           // { date: "2026-07-10 09:20:00", file: "..." }
    const [datePart, timePart] = String(info.date).split(' ');
    const [Y, M, D] = datePart.split('-');
    const hhmmss = timePart.replace(/:/g, '');
    const imgUrl = IMG_BASE + '/' + Y + '/' + M + '/' + D + '/' + hhmmss + '_0_0.png';

    // 2. download the image server-side
    const res = await fetch(imgUrl, { headers: { 'User-Agent': 'SUHU-monitor/1.0' } });
    if (!res.ok) throw new Error('image HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('image suspiciously small (' + buf.length + ' bytes)');

    // 3. save our own copy + metadata
    fs.writeFileSync(path.join(DIR, 'latest.png'), buf);
    const meta = {
      source: 'NICT Himawari-9 · true colour · full disk',
      frame_utc: info.date + ' UTC',
      fetched: new Date().toISOString(),
      bytes: buf.length,
      attribution: 'Imagery: NICT / JMA (Himawari-9)'
    };
    fs.writeFileSync(path.join(DIR, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log('OK mirrored', imgUrl, '(' + buf.length + ' bytes)  frame', info.date);
  } catch (e) {
    // keep the previous image; do not fail the workflow
    console.error('Himawari mirror failed, keeping last image:', e.message);
  }
}

main();
