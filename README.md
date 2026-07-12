# MinMax (Web)

The web version of MinMax — a dependency-free single-page app tracking Jeff Nippard's **Min-Max Program (5x/week)**, with the full 12-week program embedded (`program.js`, parsed from the original spreadsheet). This replaces the native iOS app; the Apple Health / recovery features were dropped in the move (browsers can't read HealthKit).

## Running it

Any static file server works:

```sh
cd MinMaxWeb
python3 -m http.server 5173
# open http://localhost:5173
```

Or deploy the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages). Once opened, it works offline (service worker) and can be **installed on an iPhone**: open in Safari → Share → *Add to Home Screen*. It runs full-screen with the MAX icon, like a native app.

## Where data lives

Everything is stored in the browser's localStorage — no account, no server. Use **Settings → Data**:
- **Export to Excel** — real .xlsx with a per-set Workout Log sheet and a Sessions summary sheet.
- **Download / import backup (JSON)** — move your data between devices or browsers.

> localStorage is per-browser-per-device. If you use it on your phone and laptop, sync manually via backup export/import.

## Features

- **Today** — today's session with one-tap start, block/week position, deload countdown + postpone, week overview.
- **Session editor** — exercises in sheet order; per-set weight/reps with RIR targets; previous session's numbers shown per set (and as input placeholders); last-set intensity techniques flagged (drop sets auto-scaffolded, weight-only "to failure", auto-filled at −25% compounding); substitutions; per-exercise notes; auto rest timer from the program's rest prescription plus a manual timer (1–5 min) with sound + vibration; plate calculator.
- **Editable history** — any finished workout can be viewed (full set-by-set detail), **edited** in the same editor, or **re-opened** to continue logging.
- **Calendar** — month grid with status dots, move a session, shift the program from any point (pause), skip/un-skip, deload badge + postpone.
- **Progress** — volume and estimated-1RM charts (canvas, no libraries), filter by day/exercise, date range defaulting to Week 1 → today, % change header.
- **Plate calculator** — target weight + 0–100% slider, per-side breakdown, custom barbells and plate inventory (Settings → Equipment).
- **AI Coach** — Claude (claude-opus-4-8) called directly from the browser with your own API key (Settings → AI Coach; stored in localStorage, sent only to Anthropic). Sees your program position, next session plan, and recent logs.
- **Settings** — kg/lbs, System/Light/Dark theme, Week 1 start date, rest-timer sound, equipment, exports.

## Files

```
index.html        shell + tab bar
app.js            the whole app (state, schedule engine, views, xlsx export)
program.js        the 12-week program data
styles.css        theme (light/dark)
sw.js             offline cache
manifest.webmanifest + icons
```
