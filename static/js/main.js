// static/js/main.js
import { APP_STATE, SPEC_VIEW } from "./state.js";
import {
  initSpectrogramInteractions,
  renderSpectrogramToCanvas,
  setSpectrogramData,
  updateMeasurementReadout,
  zoomSpectrogram,
} from "./spectrogram.js";
import { renderProximityGraphToCanvas } from "./proximity.js";
import {
  initMap,
  setObservationPoint,
  updateClosestTrainsRadar,
  handleCustomGTFSFile,
} from "./map.js";
import {
  startRecording,
  stopRecordingAndCompute,
  simulateMetroPassBy,
  computeHighResSpectrogram,
  showDspAlert,
} from "./audio.js";
import { downloadBundleZip } from "./export.js";

// Adds a minimize/restore (−/+) button to every panel box; state persists in localStorage
export function initPanelMinimizers() {
  document.querySelectorAll(".resizable-panel").forEach((panel) => {
    const bar = document.createElement("div");
    bar.className = "panel-minbar";
    const title = document.createElement("span");
    title.className = "panel-minbar-title";
    title.textContent = panel.dataset.title || panel.id;
    const btn = document.createElement("button");
    btn.className = "panel-min-btn";
    bar.append(title, btn);
    panel.prepend(bar);

    const key = `md-min-${panel.id}`;
    const apply = (min) => {
      panel.classList.toggle("minimized", min);
      btn.textContent = min ? "+" : "−";
      btn.title = min ? "Restore box" : "Minimize box";
      localStorage.setItem(key, min ? "1" : "0");
      if (!min) {
        setTimeout(() => {
          const hc = document.getElementById("hires-canvas");
          if (SPEC_VIEW.result && hc) renderSpectrogramToCanvas(hc);
          else renderProximityGraphToCanvas();
        }, 50);
      }
    };
    btn.addEventListener("click", () => apply(!panel.classList.contains("minimized")));
    apply(localStorage.getItem(key) === "1");
  });
}

export async function checkPythonBackend() {
  const badge = document.getElementById("badge-backend");
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (r.ok) {
      APP_STATE.pythonBackendAvailable = true;
      if (badge) {
        badge.textContent = "Python API: Online (scipy)";
        badge.className = "badge badge-ok";
      }
      return;
    }
  } catch (_) {}
  APP_STATE.pythonBackendAvailable = false;
  if (badge) {
    badge.textContent = "Python API: Offline (fft.js active)";
    badge.className = "badge badge-warn";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initPanelMinimizers();
  const hiresCanvas = document.getElementById("hires-canvas");
  initSpectrogramInteractions(hiresCanvas);
  initMap();
  checkPythonBackend();

  // Initial draw
  renderSpectrogramToCanvas(hiresCanvas);
  renderProximityGraphToCanvas();

  if (window.ResizeObserver) {
    const mapPanel = document.getElementById("panel-map");
    const specPanel = document.getElementById("panel-spectrogram");
    const proxPanel = document.getElementById("panel-proximity");
    const ro = new ResizeObserver(() => {
      renderSpectrogramToCanvas(hiresCanvas);
      renderProximityGraphToCanvas();
    });
    if (mapPanel) ro.observe(mapPanel);
    if (specPanel) ro.observe(specPanel);
    if (proxPanel) ro.observe(proxPanel);
  }

  const btnRecord = document.getElementById("btn-record");
  if (btnRecord) {
    btnRecord.addEventListener("click", () => {
      startRecording().catch((err) => {
        console.error("Recording error:", err);
        showDspAlert(`Microphone Capture Error: ${err.message}`);
      });
    });
  }

  const btnStop = document.getElementById("btn-stop");
  if (btnStop) {
    btnStop.addEventListener("click", () => stopRecordingAndCompute());
  }

  const btnSynth = document.getElementById("btn-synth");
  if (btnSynth) {
    btnSynth.addEventListener("click", () => {
      simulateMetroPassBy().catch((err) => {
        console.error("Simulation error:", err);
        showDspAlert(`Simulation Error: ${err.message}`);
      });
    });
  }

  const btnRecompute = document.getElementById("btn-recompute");
  if (btnRecompute) {
    btnRecompute.addEventListener("click", () => computeHighResSpectrogram());
  }

  const btnDownloadBundle = document.getElementById("btn-download-bundle");
  if (btnDownloadBundle) {
    btnDownloadBundle.addEventListener("click", () => downloadBundleZip());
  }

  const btnLocate = document.getElementById("btn-locate");
  if (btnLocate) {
    btnLocate.addEventListener("click", () => {
      const pt = APP_STATE.observationPoint || APP_STATE.latestGpsFix;
      if (pt && window.L && window.L.map) {
        const mapEl = document.getElementById("map");
        if (mapEl && mapEl._leaflet_map) {
          mapEl._leaflet_map.setView([pt.lat, pt.lon], 15);
        }
      }
    });
  }

  const btnUseGps = document.getElementById("btn-use-gps");
  if (btnUseGps) {
    btnUseGps.addEventListener("click", () => {
      APP_STATE.manualPointSelected = false;
      if (APP_STATE.latestGpsFix) {
        setObservationPoint(APP_STATE.latestGpsFix.lat, APP_STATE.latestGpsFix.lon, "gps");
      } else {
        setObservationPoint(41.387, 2.17, "default");
      }
    });
  }

  const chkExpected = document.getElementById("chk-expected-overlay");
  if (chkExpected) {
    chkExpected.addEventListener("change", (ev) => {
      APP_STATE.showExpectedOverlay = ev.target.checked;
      renderSpectrogramToCanvas(hiresCanvas);
    });
  }

  const inputCGround = document.getElementById("input-c-ground");
  if (inputCGround) {
    inputCGround.addEventListener("change", () => {
      updateClosestTrainsRadar(performance.now());
      renderSpectrogramToCanvas(hiresCanvas);
    });
  }

  const inputF0Train = document.getElementById("input-f0-train");
  if (inputF0Train) {
    inputF0Train.addEventListener("change", () => {
      renderSpectrogramToCanvas(hiresCanvas);
    });
  }

  const selectRolling = document.getElementById("select-rolling-window");
  if (selectRolling) {
    selectRolling.addEventListener("change", () => {
      if (SPEC_VIEW.result) {
        setSpectrogramData(hiresCanvas, SPEC_VIEW.result);
      }
    });
  }

  const inputGtfs = document.getElementById("input-gtfs-file");
  if (inputGtfs) {
    inputGtfs.addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (file) handleCustomGTFSFile(file);
    });
  }

  const inputNperseg = document.getElementById("input-nperseg");
  if (inputNperseg) {
    inputNperseg.addEventListener("change", (ev) => {
      const nperseg = parseInt(ev.target.value, 10) || 4096;
      const ov = document.getElementById("input-overlap");
      if (ov) ov.value = Math.floor(nperseg * 0.875);
    });
  }

  const btnPan = document.getElementById("btn-mode-pan");
  const btnMeasure = document.getElementById("btn-mode-measure");
  const wrap = hiresCanvas ? hiresCanvas.parentElement : null;

  if (btnPan && btnMeasure && wrap) {
    btnPan.addEventListener("click", () => {
      SPEC_VIEW.mode = "pan";
      btnPan.classList.add("active");
      btnMeasure.classList.remove("active");
      wrap.classList.remove("mode-measure");
      wrap.classList.add("mode-pan");
      updateMeasurementReadout();
    });

    btnMeasure.addEventListener("click", () => {
      SPEC_VIEW.mode = "measure";
      btnMeasure.classList.add("active");
      btnPan.classList.remove("active");
      wrap.classList.remove("mode-pan");
      wrap.classList.add("mode-measure");
      updateMeasurementReadout();
    });
  }

  const btnClearMeasure = document.getElementById("btn-clear-measure");
  if (btnClearMeasure) {
    btnClearMeasure.addEventListener("click", () => {
      SPEC_VIEW.measureP1 = null;
      SPEC_VIEW.measureP2 = null;
      updateMeasurementReadout();
      renderSpectrogramToCanvas(hiresCanvas);
    });
  }

  const chkSmooth = document.getElementById("chk-smooth");
  if (chkSmooth) {
    chkSmooth.addEventListener("change", (ev) => {
      SPEC_VIEW.smooth = ev.target.checked;
      renderSpectrogramToCanvas(hiresCanvas);
    });
  }

  const btnZoomIn = document.getElementById("btn-zoom-in");
  if (btnZoomIn) btnZoomIn.addEventListener("click", () => zoomSpectrogram(0.75));

  const btnZoomOut = document.getElementById("btn-zoom-out");
  if (btnZoomOut) btnZoomOut.addEventListener("click", () => zoomSpectrogram(1.33));

  const btnZoomReset = document.getElementById("btn-zoom-reset");
  if (btnZoomReset) {
    btnZoomReset.addEventListener("click", () => {
      if (!SPEC_VIEW.result) return;
      SPEC_VIEW.tMin = 0;
      SPEC_VIEW.tMax = SPEC_VIEW.result.duration_sec;
      SPEC_VIEW.fMin = 0;
      SPEC_VIEW.fMax = SPEC_VIEW.result.fmax_hz;
      renderSpectrogramToCanvas(hiresCanvas);
    });
  }
});
