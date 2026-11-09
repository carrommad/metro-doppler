# Metro Doppler Hybrid Web App
> **Target:** `metro-doppler` (main)

- 2026-11-09T23:05:00+01:00 | Fixed phone view responsiveness and missing proximity lines: replaced min-width with responsive mobile media queries, added initial standby rendering for spectrogram and live fallback tracks for proximity canvas | DONE

- 2026-11-09T22:50:30+01:00 | Created comprehensive README.md with application documentation, quickstart instructions, parameter tables, and user screenshots saved in `docs/images/` | DONE
- 2026-11-09T22:43:15+01:00 | Fixed minimum distance envelope calculation so the single minimum distance curve reliably renders across all recording durations, with colored circles and the live-distance legend intact | DONE
- 2026-11-09T22:42:00+01:00 | Enhanced distance graph legend with real-time live distance, minimum distance, ground transmission delay, and metro line color indicators | DONE
- 2026-11-09T22:42:00+01:00 | Enhanced distance graph legend with real-time live distance, minimum distance, ground transmission delay, and metro line color indicators | DONE
- 2026-11-09T22:41:10+01:00 | Simplified distance graph to a single continuous lower-envelope line representing the minimum distance across all metros at every point in time, with colored circles highlighting the closest metro line points | DONE
- 2026-11-09T22:38:50+01:00 | Added panel minimization toggle (`−`/`+`) with title bars on all panels, simplified proximity graph to display discrete minimum-distance points with colored Metro line circles and labels | DONE
- 2026-11-09T22:36:30+01:00 | Decluttered proximity views: real logged samples only (no synthetic curves; SIM track only in simulation), graph Y-axis = real 3D distance in metres (auto-fit, closest on top), thin lines + ◆ + legend; bars use same data (`getProximityTracks`) | DONE
- 2026-11-09T22:30:30+01:00 | Placed 4 Metro Line Proximity Bars directly below the spectrogram inside the top panel (`drawExpectedMetroOverlay`) AND added a dedicated full-resolution **3D Distance & Target Proximity Graph** middle box (`#panel-proximity` / `renderProximityGraphToCanvas`) with the Horizontal Top Max (`CLOSEST`) reference line | DONE
- 2026-11-09T22:21:35+01:00 | Moved Proximity vs. Time Graph directly BELOW the spectrogram (`drawExpectedMetroOverlay`), with Horizontal Top Max (`CLOSEST`) reference line and 4 Metro line curves (`FAR` $\rightarrow$ `CLOSEST` `◆` $\rightarrow$ `FAR`) painted live during recording and after stopping | DONE
- 2026-11-09T22:12:15+01:00 | Replaced horizontal spectrogram overlay lines with 4 unobstructed Metro Line Proximity Time Bars in the header strip (`drawExpectedMetroOverlay`) showing far $\rightarrow$ closest (`◆` peak + ground delay $\Delta\tau$) $\rightarrow$ far | DONE
- 2026-11-09T22:05:00+01:00 | Enlarged map panel height (`72vh`, `min-height: 560px`) with page scroll, added BCN surface elevation ($Z_{\text{surface}}$) + tunnel depths ($d_{\text{tunnel}}$) to `static/tmb_metro.geojson`, and switched closest-train ground delay $\Delta\tau$ to 3D slant distance (`estimateBcnOrographyAndDepth`) | DONE
- 2026-11-09T22:00:15+01:00 | Made map observation pin (`obsMarker`) a draggable `🎯` target above all layers, wired click pass-through on GTFS lines/stations, fixed `refreshStaticExpectedTracksFromPoint` data keys, and bumped `?v=4` cache buster | DONE
- 2026-11-09T21:54:40+01:00 | Added interactive Map Observation Point (`setObservationPoint`), live closest-trains radar rays + telemetry (`updateClosestTrainsRadar`), and ground-delayed expected Metro Doppler signal region/curves (`drawExpectedMetroOverlay`, $\Delta\tau = d/c_{\text{ground}}$) on the spectrogram | DONE
- 2026-11-09T21:46:35+01:00 | Generated `static/favicon.ico` and `static/favicon.png` (64x64/32x32/16x16) with cache-busting `?v=3` links so Chrome tab/sidebar icon updates immediately | DONE
- 2026-11-09T21:44:20+01:00 | Added local untracked `.env` with TMB i-Metro credentials, added `/api/imetro` proxy in `server.py`, synced live TMB trains onto map in `static/app.js`, and added custom SVG favicon (`static/favicon.svg`) | DONE
- 2026-11-09T21:39:40+01:00 | Added animated moving TMB Metro trains (`initMetroTrainFleet`) on the Leaflet map, created root `index.html` + `.github/workflows/pages.yml`, and prepared GitHub Pages deployment to `https://carrommad.github.io/metro-doppler/` | DONE
- 2026-11-09T21:30:45+01:00 | Consolidated into a single unified Live High-Res Spectrogram powered by a parallel Web Worker (`static/stft_worker.js`), removed `context.json` preview box, and arranged Spectrogram (top) + Map (bottom) in a centered, half-and-half, drag-resizable stacked layout | DONE
- 2026-11-09T21:22:10+01:00 | Enhanced layout, fixed map tiles (OSM dark filter, no API watermark), wired real-time WebGL spectrogram directly to `AudioWorklet` PCM stream, and added smooth 2D bilinear zoom/pan + two-point Δt/Δf/Doppler measurement tool | DONE
- 2026-11-09T21:05:55+01:00 | Enabled dual-stack IPv4+IPv6 binding in `server.py` (`DualStackServer`), restarted server on port 8000, and verified Chrome loaded `/` + `/api/health` + `/tmb_metro.geojson` | DONE
- 2026-11-09T21:00:05+01:00 | Started `server.py` daemon on `http://127.0.0.1:8000` (`projects` env) and opened browser | DONE
- 2026-11-09T20:59:10+01:00 | Verified `server.py` `scipy.signal.spectrogram` across dynamic sample rates (44.1 kHz, 48 kHz) and audited repository for zero personal info | DONE
- 2026-11-09T20:58:35+01:00 | Created `static/app.js` (DSP-off `getUserMedia` + `AudioWorklet`, dynamic sampleRate, WebGL live spectrogram, `fft.js` & `scipy` high-res spectrogram, Leaflet TMB GTFS + GPS, JSZip bundle export) and `.gitignore` | DONE
- 2026-11-09T20:31:30+01:00 | Sanitized target path in `CONVERSATION.md` for public repository safety | DONE
- 2026-11-09T20:30:55+01:00 | Created `static/index.html` and `static/style.css` | DONE
- 2026-11-09T20:29:40+01:00 | Created `server.py` (static server + `POST /api/spectrogram` with exact `scipy.signal.spectrogram` parameters) and `requirements.txt` | DONE
- 2026-11-09T20:28:50+01:00 | Created `static/tmb_metro.geojson` with TMB static GTFS Metro lines (L1–L5, L9–L11) and stations | DONE
- 2026-11-09T20:28:00+01:00 | Downloaded and wrapped vendor libraries (`leaflet.js`, `leaflet.css`, `jszip.min.js`, `fft.js`) in `static/vendor/` | DONE
- 2026-11-09T20:26:50+01:00 | Installed `scipy` 1.17.1 in `projects` conda environment | DONE
- 2026-11-09T20:25:00+01:00 | Initialize CONVERSATION.md and start building client-first hybrid web app | DONE


