#!/usr/bin/env python3
"""
Metro Doppler Hybrid Web App — Python Backend Service
Serves static client assets and provides POST /api/spectrogram using exact
scipy.signal.spectrogram parameters without assuming sample rate.
"""

import argparse
import base64
import io
import json
import os
import socket
import time
import traceback
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal
from scipy.io import wavfile

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
IMETRO_CACHE = {"ts": 0.0, "data": None}


def load_local_env() -> dict:
    env = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env


def fetch_tmb_imetro() -> dict:
    now = time.time()
    if IMETRO_CACHE["data"] and (now - IMETRO_CACHE["ts"] < 12.0):
        return IMETRO_CACHE["data"]

    env = load_local_env()
    app_id = os.environ.get("TMB_APP_ID") or env.get("TMB_APP_ID")
    app_key = os.environ.get("TMB_APP_KEY") or env.get("TMB_APP_KEY")
    if not app_id or not app_key:
        return {"status": "no_credentials", "trains": []}

    stops = "125,124,121,319,324,325,221,128,131,126,215,419,515,312,335,224,424,328,520,127"
    url = f"https://api.tmb.cat/v1/itransit/metro/estacions?estacions={stops}&app_id={app_id}&app_key={app_key}"
    req = urllib.request.urlopen(url, timeout=8)
    raw = json.loads(req.read().decode("utf-8"))
    api_ts_ms = raw.get("timestamp") or int(now * 1000)

    # Extract each unique active physical train (codi_servei) and its soonest arrival station
    by_train = {}
    for linia in raw.get("linies", []):
        nom_linia = linia.get("nom_linia")
        color_linia = "#" + str(linia.get("color_linia", "3b82f6")).lstrip("#")
        for est in linia.get("estacions", []):
            codi_estacio = str(est.get("codi_estacio"))
            id_sentit = est.get("id_sentit", 1)
            for traj in est.get("linies_trajectes", []):
                desti = traj.get("desti_trajecte", "")
                for tren in traj.get("propers_trens", []):
                    srv = str(tren.get("codi_servei", "")).strip()
                    arr_ms = tren.get("temps_arribada")
                    if not srv or not arr_ms:
                        continue
                    eta_sec = max(0.0, (arr_ms - api_ts_ms) / 1000.0)
                    if srv not in by_train or eta_sec < by_train[srv]["eta_sec"]:
                        by_train[srv] = {
                            "codi_servei": srv,
                            "nom_linia": nom_linia,
                            "color_linia": color_linia,
                            "codi_estacio": codi_estacio,
                            "id_sentit": id_sentit,
                            "desti_trajecte": desti,
                            "eta_sec": round(eta_sec, 1),
                        }

    result = {
        "status": "ok",
        "source": "TMB i-Metro Live API",
        "timestamp_ms": api_ts_ms,
        "trains": list(by_train.values()),
    }
    IMETRO_CACHE["ts"] = now
    IMETRO_CACHE["data"] = result
    return result

# Exact notebook scipy spectrogram parameters
DEFAULT_SCIPY_PARAMS = {
    "window": "hann",
    "nperseg": 4096,
    "noverlap": 3584,
    "nfft": 4096,
    "detrend": "constant",
    "scaling": "density",
    "mode": "psd",
}


def compute_scipy_spectrogram(wav_bytes: bytes, params: dict) -> dict:
    """Read WAV bytes, dynamically extract actual sample rate fs, and compute spectrogram."""
    bio = io.BytesIO(wav_bytes)
    fs, data = wavfile.read(bio)
    fs = int(fs)

    # Convert integer PCM to float64 normalized in [-1.0, 1.0]
    if np.issubdtype(data.dtype, np.integer):
        info = np.iinfo(data.dtype)
        if data.dtype == np.uint8:
            x = (data.astype(np.float64) - 128.0) / 128.0
        else:
            x = data.astype(np.float64) / float(max(abs(info.min), info.max))
    else:
        x = data.astype(np.float64)

    # Downmix multi-channel to mono if needed
    if x.ndim > 1:
        x = np.mean(x, axis=1)

    num_samples = int(x.shape[0])
    duration_sec = float(num_samples) / float(fs) if fs > 0 else 0.0

    window = params.get("window", DEFAULT_SCIPY_PARAMS["window"])
    nperseg = int(params.get("nperseg", DEFAULT_SCIPY_PARAMS["nperseg"]))
    noverlap = int(params.get("noverlap", DEFAULT_SCIPY_PARAMS["noverlap"]))
    nfft = int(params.get("nfft", max(nperseg, DEFAULT_SCIPY_PARAMS["nfft"])))
    detrend = params.get("detrend", DEFAULT_SCIPY_PARAMS["detrend"])
    scaling = params.get("scaling", DEFAULT_SCIPY_PARAMS["scaling"])
    mode = params.get("mode", DEFAULT_SCIPY_PARAMS["mode"])
    fmax_req = float(params.get("fmax", 4000.0))

    # Clamp nperseg if recording is very short
    if num_samples < nperseg:
        nperseg = max(64, 1 << (num_samples.bit_length() - 1))
        noverlap = int(nperseg * 0.875)
        nfft = max(nperseg, nfft)

    f, t, Sxx = signal.spectrogram(
        x,
        fs=fs,
        window=window,
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        detrend=detrend,
        scaling=scaling,
        mode=mode,
    )

    nyquist = fs / 2.0
    fmax = min(fmax_req, nyquist) if fmax_req > 0 else nyquist
    freq_mask = f <= fmax
    f_plot = f[freq_mask]
    Sxx_plot = Sxx[freq_mask, :]

    Sxx_db = 10.0 * np.log10(np.maximum(Sxx_plot, 1e-20))
    vmax = float(np.percentile(Sxx_db, 99.5)) if Sxx_db.size > 0 else 0.0
    vmin = max(vmax - 80.0, float(np.min(Sxx_db)) if Sxx_db.size > 0 else -120.0)

    fig, ax = plt.subplots(figsize=(12, 5), dpi=160, facecolor="#0b0f17")
    ax.set_facecolor("#0b0f17")

    if t.size > 1 and f_plot.size > 1:
        im = ax.pcolormesh(
            t,
            f_plot,
            Sxx_db,
            shading="gouraud",
            cmap="inferno",
            vmin=vmin,
            vmax=vmax,
        )
    else:
        im = ax.imshow(
            Sxx_db,
            aspect="auto",
            origin="lower",
            cmap="inferno",
            vmin=vmin,
            vmax=vmax,
            extent=[0, max(duration_sec, 0.1), 0, fmax],
        )

    ax.set_title(
        f"High-Res Spectrogram (scipy.signal.spectrogram | fs={fs} Hz | {window}, nperseg={nperseg}, noverlap={noverlap})",
        color="#e2e8f0",
        fontsize=10,
        pad=10,
    )
    ax.set_xlabel("Time (s)", color="#94a3b8", fontsize=9)
    ax.set_ylabel("Frequency (Hz)", color="#94a3b8", fontsize=9)
    ax.tick_params(colors="#94a3b8", labelsize=8)
    for spine in ax.spines.values():
        spine.set_color("#1e293b")

    cbar = fig.colorbar(im, ax=ax, pad=0.02)
    cbar.set_label("PSD (dB/Hz)" if scaling == "density" else "Power (dB)", color="#94a3b8", fontsize=9)
    cbar.ax.yaxis.set_tick_params(color="#94a3b8", labelcolor="#94a3b8", labelsize=8)

    fig.tight_layout()
    png_io = io.BytesIO()
    fig.savefig(png_io, format="png", dpi=160, facecolor=fig.get_facecolor())
    plt.close(fig)
    png_bytes = png_io.getvalue()

    # Estimate dominant frequency track for Doppler inspection
    peak_freqs = []
    if Sxx_plot.size > 0 and t.size > 0:
        idx_max = np.argmax(Sxx_plot, axis=0)
        peak_freqs = [round(float(f_plot[i]), 2) for i in idx_max[:500]]

    # Transpose to [time_bins, freq_bins] in float32 row-major order to match client sxxDb layout
    sxx_db_t = np.ascontiguousarray(Sxx_db.T, dtype=np.float32)

    return {
        "engine": "python-scipy",
        "scipy_version": signal.__name__,
        "sample_rate_hz": fs,
        "nyquist_hz": nyquist,
        "num_samples": num_samples,
        "duration_sec": round(duration_sec, 4),
        "freq_resolution_hz": round(float(fs) / float(nfft), 4),
        "time_step_sec": round(float(nperseg - noverlap) / float(fs), 6),
        "time_bins": int(t.size),
        "freq_bins": int(f_plot.size),
        "fmax_hz": fmax,
        "db_range": [round(vmin, 2), round(vmax, 2)],
        "parameters": {
            "window": window,
            "nperseg": nperseg,
            "noverlap": noverlap,
            "nfft": nfft,
            "detrend": detrend,
            "scaling": scaling,
            "mode": mode,
        },
        "peak_freq_track_hz": peak_freqs,
        "sxx_db_f32_b64": base64.b64encode(sxx_db_t.tobytes()).decode("ascii"),
        "png_base64": base64.b64encode(png_bytes).decode("ascii"),
    }


class MetroDopplerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Spectrogram-Params")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            payload = {
                "status": "ok",
                "service": "metro-doppler-scipy",
                "default_scipy_params": DEFAULT_SCIPY_PARAMS,
            }
            self._send_json(200, payload)
            return
        if parsed.path == "/api/imetro":
            try:
                self._send_json(200, fetch_tmb_imetro())
            except Exception as exc:
                self._send_json(200, {"status": "error", "error": str(exc), "trains": []})
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/spectrogram":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                self._send_json(400, {"error": "Empty request body; expected WAV payload"})
                return

            wav_bytes = self.rfile.read(content_length)

            # Parse optional query or header overrides for scipy parameters
            qs = parse_qs(parsed.query)
            params = dict(DEFAULT_SCIPY_PARAMS)
            header_params = self.headers.get("X-Spectrogram-Params")
            if header_params:
                params.update(json.loads(header_params))
            for k in ("window", "nperseg", "noverlap", "nfft", "detrend", "scaling", "mode", "fmax"):
                if k in qs and qs[k]:
                    params[k] = qs[k][0]

            result = compute_scipy_spectrogram(wav_bytes, params)
            self._send_json(200, result)
        except Exception as exc:
            traceback.print_exc()
            self._send_json(500, {"error": str(exc)})

    def _send_json(self, status_code: int, data: dict):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except Exception:
            pass
        return super().server_bind()


def main():
    parser = argparse.ArgumentParser(description="Metro Doppler Hybrid Server")
    parser.add_argument("--host", default="::", help="Bind host (default: :: dual-stack IPv4+IPv6)")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    args = parser.parse_args()

    try:
        server = DualStackServer((args.host, args.port), MetroDopplerHandler)
    except Exception:
        server = ThreadingHTTPServer(("0.0.0.0", args.port), MetroDopplerHandler)
    print(f"Metro Doppler server listening on http://localhost:{args.port} (IPv4 + IPv6)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

