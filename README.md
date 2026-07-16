# SUHU — ENSO Monitor PWA (Malaysia)

A true **Progressive Web App**: installable to phone/desktop, works offline, and refreshes its data **without any Python or any server running on your computer**. All the fetching happens in the cloud.

## What's in this folder

```
suhu-pwa/
├── index.html          ← the app (installable, offline-capable)
├── manifest.json       ← PWA metadata (name, icons, theme)
├── sw.js               ← service worker (offline cache + fresh data)
├── data.json           ← the data the app reads (overwritten by the pipeline)
├── fetch-data.js       ← Node fetcher — runs in the CLOUD, not on your PC
├── .github/workflows/
│   └── update-data.yml ← GitHub Actions cron that runs fetch-data.js
└── icons/              ← app icons (192, 512, maskable, apple-touch)
```

## The core idea (why no Python on your computer)

The weather-agency data files aren't CORS-enabled, so a browser can't fetch them directly. The classic fix is a backend — but you don't want to run one. So we move the fetch **into the cloud**:

1. A tiny **Node** script (`fetch-data.js`) fetches and parses the feeds *server-side* (no browser = no CORS problem).
2. **GitHub Actions** runs that script on a schedule **on GitHub's servers** and commits the fresh `data.json` back to the repo.
3. The PWA (static files on free hosting) just reads `data.json`.

Nothing runs on your machine. It's Node, not Python. And it's all free.

## Deploy in ~10 minutes (free, recommended path)

### 1. Put it on GitHub
- Create a new GitHub repo and upload this whole `suhu-pwa` folder.

### 2. Turn on GitHub Pages (the hosting)
- Repo → **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main` → `/root` (or the folder) → Save.
- Your app is now live at `https://<you>.github.io/<repo>/` over HTTPS (required for PWAs). ✅

### 3. Turn on the data pipeline
- The workflow in `.github/workflows/update-data.yml` runs automatically every 6 hours.
- Repo → **Actions** tab → enable workflows → click **Update SUHU data → Run workflow** once to test.
- It fetches **all four drivers live** — Niño 3.4 (NOAA CPC), SOI (BoM Troup), DMI/IOD (NOAA PSL), MJO/RMM (BoM) — and rewrites `data.json`. Any feed that fails keeps its last value and is flagged "stale".

### 4. Install the app
- Open the Pages URL on your phone → browser menu → **Add to Home Screen**.
- On desktop Chrome/Edge → the **⬇ Install** button (or the install icon in the address bar).
- It now opens full-screen like a native app and works offline.

## Alternative: live serverless proxy (no static-file cron)

If you'd rather fetch on demand instead of on a schedule, replace `data.json` with a **serverless edge function** that proxies the feeds live:

- **Cloudflare Workers**, **Netlify Functions**, or **Vercel Edge Functions** — all have free tiers, all run in the cloud.
- Point the app's `fetch('data.json')` at your function URL (e.g. `/api/indices`). The function fetches the agency feeds, parses, and returns JSON with proper CORS headers.
- Same "no computer" property; trades scheduled caching for live-on-load.

Use GitHub Actions (above) if you want offline resilience and zero cold-starts; use a serverless function if you want always-fresh-on-open.

## Himawari mirror (Option 1 — self-hosted imagery)

Instead of hotlinking (which browsers block by referer), the app serves its **own copy** of the latest Himawari frame. A second scheduled job fetches it server-side and commits it to `himawari/`.

Files:
- `mirror-himawari.js` — resolves the latest frame via NICT's `latest.json`, downloads the full-disk image server-side, saves `himawari/latest.png` + `himawari/meta.json`. Keeps the last image on any failure.
- `.github/workflows/update-himawari.yml` — runs it every 30 min on GitHub's servers and commits the result. (`workflow_dispatch` lets you run it manually.)
- `himawari/latest.png` + `meta.json` — ship with a placeholder so the panel works before the first run.

To enable: upload these, then **Actions → Mirror Himawari → Run workflow**. The satellite panel switches to your own copy automatically (with the frame timestamp), works offline, and the JMA/NICT/SLIDER buttons remain as live regional links.

Notes and upgrades:
- **Cadence:** default every 30 min. Change the cron to `*/10 * * * *` for 10-min updates.
- **Night:** NICT's image is true-colour, so it's dark at night. For a **day+night infrared regional view**, point `IMG_BASE` in `mirror-himawari.js` at JMA's Southeast-Asia B13 sector (the script is source-agnostic — only the URL builder changes).
- **Repo size:** committing a PNG every run grows git history. Fine for a while; to keep it lean, store the image in object storage (S3/Cloudflare R2) or an orphan branch instead of `main`, or reduce cadence.
- **Malaysia crop / custom bands:** that's "Option 2" — pull raw Level-1b from the free AWS `noaa-himawari9` bucket and render with Satpy on a beefier runner. Heavier compute; not needed for this mirror.
- **Attribution:** imagery credited to NICT / JMA (Himawari-9). No endorsement implied.

## Local preview (optional)

To look at it on your own machine before deploying, serve the folder over http (a service worker won't run from `file://`):

```
npx serve suhu-pwa      # or:  python3 -m http.server (only if you happen to have it)
```

Then open the printed `http://localhost:...` URL. This is just for previewing — production needs no local process at all.

## Extending

- **All four parsers are implemented** in `fetch-data.js`. To swap the DMI source to the JAMSTEC SINTEX-F primary (currently uses the NOAA PSL fallback), add a `fetchDMI` variant pointing at the JAMSTEC CSV.
- **Add push alerts**: a scheduled job can send Telegram/web-push when a threshold trips.
- **Localize** (Bahasa Malaysia / English) by keying strings in `data.json`.

See `ENSO-Malaysia-Technical-Spec.md` for the full data-source table, thresholds, and interpretation logic.
