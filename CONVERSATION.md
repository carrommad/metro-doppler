# Metro Doppler Hybrid Web App
> **Target:** `metro-doppler` (main)

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


