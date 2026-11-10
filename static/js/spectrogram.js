"use strict";

import { APP_STATE, SPEC_VIEW, COLORMAP_LUT } from "./state.js";
import { drawExpectedMetroOverlay, renderProximityGraphToCanvas } from "./proximity.js";

/**
 * Bilinear sampling in dB space for smooth zooming on spectrogram
 */
let cachedOffCanvas = null;
let cachedOffCtx = null;
let cachedImgData = null;

export function sampleBilinearDb(sxxDb, numFrames, numBins, fFrame, fBin) {
  const x0 = Math.max(0, Math.min(numFrames - 1, Math.floor(fFrame)));
  const x1 = Math.max(0, Math.min(numFrames - 1, x0 + 1));
  const y0 = Math.max(0, Math.min(numBins - 1, Math.floor(fBin)));
  const y1 = Math.max(0, Math.min(numBins - 1, y0 + 1));
  const tx = fFrame - x0;
  const ty = fBin - y0;
  const v00 = sxxDb[x0 * numBins + y0];
  const v10 = sxxDb[x1 * numBins + y0];
  const v01 = sxxDb[x0 * numBins + y1];
  const v11 = sxxDb[x1 * numBins + y1];
  const v0 = v00 + tx * (v10 - v00);
  const v1 = v01 + tx * (v11 - v01);
  return v0 + ty * (v1 - v0);
}

export function setSpectrogramData(canvas, result) {
  SPEC_VIEW.result = result;
  const rollSec = parseFloat(document.getElementById("select-rolling-window")?.value) || 20.0;
  const totalT = (result.tOffset || 0) + result.duration_sec;

  if (APP_STATE.isRecording && rollSec > 0) {
    if (totalT <= rollSec) {
      SPEC_VIEW.tMin = 0;
      SPEC_VIEW.tMax = rollSec;
    } else {
      SPEC_VIEW.tMin = totalT - rollSec;
      SPEC_VIEW.tMax = totalT;
    }
  } else {
    SPEC_VIEW.tMin = result.tOffset || 0;
    SPEC_VIEW.tMax = Math.max(SPEC_VIEW.tMin + 0.01, totalT);
  }
  SPEC_VIEW.fMin = 0;
  SPEC_VIEW.fMax = Math.max(10, result.fmax_hz);
  renderSpectrogramToCanvas(canvas, result);
}

export function renderSpectrogramToCanvas(canvas, result) {
  if (!canvas) canvas = document.getElementById("hires-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, W, H);

  const { left: padLeft, right: padRight, top: padTop, bottom: padBottom } = SPEC_VIEW.pad;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  if (!result) result = SPEC_VIEW.result;
  if (!result || !result.sxxDb) {
    // Standby grid and expected proximity bars
    ctx.fillStyle = "#070b12";
    ctx.fillRect(padLeft, padTop, plotW, plotH);
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "600 12px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("High-Res Spectrogram (Standby — click Start Recording or Simulate)", padLeft, 21);

    ctx.fillStyle = "#64748b";
    ctx.font = "12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Awaiting audio input — closest live Metro proximity tracks below", padLeft + plotW / 2, padTop + plotH / 2);

    const barsBottomY = padTop + plotH + 62;
    ctx.textAlign = "center";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    for (let i = 0; i <= 6; i++) {
      const frac = i / 6;
      const tVal = frac * 6.0;
      const xPos = padLeft + frac * plotW;
      ctx.fillText(`${tVal.toFixed(1)}s`, xPos, barsBottomY + 16);
      ctx.beginPath();
      ctx.moveTo(xPos, barsBottomY);
      ctx.lineTo(xPos, barsBottomY + 4);
      ctx.strokeStyle = "#475569";
      ctx.stroke();
    }
    ctx.fillText("Time (s)", padLeft + plotW / 2, H - 4);

    drawExpectedMetroOverlay(ctx, padLeft, padTop, plotW, plotH);
    renderProximityGraphToCanvas();
    return;
  }

  const numFrames = result.time_bins;
  const numBins = result.freq_bins;
  const { sxxDb, vmin, vmax, duration_sec: totalDur, fmax_hz: totalFmax } = result;
  const dbSpan = Math.max(1e-6, vmax - vmin);

  const tMin = SPEC_VIEW.tMin;
  const tMax = SPEC_VIEW.tMax;
  const fMin = SPEC_VIEW.fMin;
  const fMax = SPEC_VIEW.fMax;

  const renderW = Math.min(plotW, APP_STATE.isRecording ? 640 : 900);
  const renderH = Math.min(plotH, APP_STATE.isRecording ? 256 : 360);

  if (!cachedOffCanvas || cachedOffCanvas.width !== renderW || cachedOffCanvas.height !== renderH) {
    cachedOffCanvas = document.createElement("canvas");
    cachedOffCanvas.width = renderW;
    cachedOffCanvas.height = renderH;
    cachedOffCtx = cachedOffCanvas.getContext("2d");
    cachedImgData = cachedOffCtx.createImageData(renderW, renderH);
  }
  const offCanvas = cachedOffCanvas;
  const offCtx = cachedOffCtx;
  const imgData = cachedImgData;
  const pixels = imgData.data;
  const smooth = SPEC_VIEW.smooth;

  // Precompute Y -> freqBin lookup
  const fBinLookup = new Float32Array(renderH);
  for (let py = 0; py < renderH; py++) {
    const fFrac = 1.0 - py / Math.max(1, renderH - 1);
    const freqHz = fMin + fFrac * (fMax - fMin);
    fBinLookup[py] = (freqHz / Math.max(1e-6, totalFmax)) * (numBins - 1);
  }

  // Precompute X -> timeSec & valid check
  const tOffset = result.tOffset || 0;
  const tSpan = Math.max(1e-6, tMax - tMin);
  const durSpan = Math.max(1e-6, totalDur);

  for (let px = 0; px < renderW; px++) {
    const tFrac = px / Math.max(1, renderW - 1);
    const timeSec = tMin + tFrac * tSpan;

    if (APP_STATE.isRecording && (timeSec < tOffset || timeSec > tOffset + totalDur + 0.05)) {
      // Future/blank column
      for (let py = 0; py < renderH; py++) {
        const pIdx = (py * renderW + px) * 4;
        pixels[pIdx + 0] = 7;
        pixels[pIdx + 1] = 11;
        pixels[pIdx + 2] = 18;
        pixels[pIdx + 3] = 255;
      }
      continue;
    }

    const fFrame = ((timeSec - tOffset) / durSpan) * (numFrames - 1);
    const ix = Math.max(0, Math.min(numFrames - 1, Math.round(fFrame)));

    for (let py = 0; py < renderH; py++) {
      const fBin = fBinLookup[py];
      const pIdx = (py * renderW + px) * 4;

      let db;
      if (smooth) {
        db = sampleBilinearDb(sxxDb, numFrames, numBins, fFrame, fBin);
      } else {
        const iy = Math.max(0, Math.min(numBins - 1, Math.round(fBin)));
        db = sxxDb[ix * numBins + iy];
      }

      const norm = Math.max(0, Math.min(1, (db - vmin) / dbSpan));
      const lutIdx = Math.round(norm * 255) * 3;
      pixels[pIdx + 0] = COLORMAP_LUT[lutIdx + 0];
      pixels[pIdx + 1] = COLORMAP_LUT[lutIdx + 1];
      pixels[pIdx + 2] = COLORMAP_LUT[lutIdx + 2];
      pixels[pIdx + 3] = 255;
    }
  }
  offCtx.putImageData(imgData, 0, 0);

  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(offCanvas, padLeft, padTop, plotW, plotH);

  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  ctx.strokeRect(padLeft, padTop, plotW, plotH);

  // Title
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "600 12.5px Inter, sans-serif";
  const p = result.parameters;
  const zoomPct = Math.round((totalDur / Math.max(1e-4, tMax - tMin)) * 100);
  ctx.fillText(
    `High-Res Spectrogram (${result.engine} | fs=${result.sample_rate_hz} Hz | ${p.window} ${p.nperseg}/${p.noverlap} | Zoom ${zoomPct}%)`,
    padLeft,
    21
  );

  // Y-axis ticks
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px monospace";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const frac = i / 5;
    const freqVal = fMin + frac * (fMax - fMin);
    const yPos = padTop + plotH - frac * plotH;
    ctx.fillText(`${freqVal.toFixed(fMax - fMin < 200 ? 1 : 0)} Hz`, padLeft - 8, yPos + 4);
    ctx.beginPath();
    ctx.moveTo(padLeft - 4, yPos);
    ctx.lineTo(padLeft, yPos);
    ctx.strokeStyle = "#475569";
    ctx.stroke();
  }

  // X-axis ticks (drawn below the 4 Proximity Bars under the spectrogram)
  const barsBottomY = padTop + plotH + 62;
  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i++) {
    const frac = i / 6;
    const tVal = tMin + frac * (tMax - tMin);
    const xPos = padLeft + frac * plotW;
    ctx.fillText(`${tVal.toFixed(tMax - tMin < 2 ? 3 : 2)}s`, xPos, barsBottomY + 16);
    ctx.beginPath();
    ctx.moveTo(xPos, barsBottomY);
    ctx.lineTo(xPos, barsBottomY + 4);
    ctx.strokeStyle = "#475569";
    ctx.stroke();
  }
  ctx.fillText("Time (s)", padLeft + plotW / 2, H - 4);

  // Colorbar
  const cbX = padLeft + plotW + 14;
  const cbW = 13;
  for (let y = 0; y < plotH; y++) {
    const norm = 1.0 - y / plotH;
    const lutIdx = Math.round(norm * 255) * 3;
    ctx.fillStyle = `rgb(${COLORMAP_LUT[lutIdx]},${COLORMAP_LUT[lutIdx + 1]},${COLORMAP_LUT[lutIdx + 2]})`;
    ctx.fillRect(cbX, padTop + y, cbW, 1);
  }
  ctx.strokeStyle = "#1e293b";
  ctx.strokeRect(cbX, padTop, cbW, plotH);
  ctx.fillStyle = "#94a3b8";
  ctx.textAlign = "left";
  ctx.fillText(`${vmax.toFixed(0)} dB`, cbX + cbW + 5, padTop + 10);
  ctx.fillText(`${vmin.toFixed(0)} dB`, cbX + cbW + 5, padTop + plotH);

  drawExpectedMetroOverlay(ctx, padLeft, padTop, plotW, plotH);
  drawMeasureOverlay(ctx, padLeft, padTop, plotW, plotH);
  renderProximityGraphToCanvas();
}

export function drawMeasureOverlay(ctx, padLeft, padTop, plotW, plotH) {
  const { tMin, tMax, fMin, fMax, measureP1: p1, measureP2: p2 } = SPEC_VIEW;
  if (!p1) return;

  const toX = (t) => padLeft + ((t - tMin) / Math.max(1e-6, tMax - tMin)) * plotW;
  const toY = (f) => padTop + plotH - ((f - fMin) / Math.max(1e-6, fMax - fMin)) * plotH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padLeft, padTop, plotW, plotH);
  ctx.clip();

  const x1 = toX(p1.t);
  const y1 = toY(p1.f);

  // P1 crosshair
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, padTop);
  ctx.lineTo(x1, padTop + plotH);
  ctx.moveTo(padLeft, y1);
  ctx.lineTo(padLeft + plotW, y1);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "#10b981";
  ctx.beginPath();
  ctx.arc(x1, y1, 4.5, 0, Math.PI * 2);
  ctx.fill();

  if (p2) {
    const x2 = toX(p2.t);
    const y2 = toY(p2.f);

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x2, padTop);
    ctx.lineTo(x2, padTop + plotH);
    ctx.moveTo(padLeft, y2);
    ctx.lineTo(padLeft + plotW, y2);
    ctx.stroke();

    ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

    ctx.setLineDash([]);
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(x2, y2, 4.5, 0, Math.PI * 2);
    ctx.fill();

    const dt = p2.t - p1.t;
    const absDt = Math.abs(dt);
    const df = p2.f - p1.f;
    const label = `Δt = ${absDt.toFixed(3)}s (${(absDt * 1000).toFixed(0)} ms) | Δf = ${df >= 0 ? "+" : ""}${df.toFixed(1)} Hz`;
    ctx.font = "600 11.5px monospace";
    const tw = ctx.measureText(label).width + 14;
    const lx = Math.max(padLeft + 6, Math.min(padLeft + plotW - tw - 6, (x1 + x2) / 2 - tw / 2));
    const ly = Math.max(padTop + 20, Math.min(padTop + plotH - 10, (y1 + y2) / 2 - 10));

    ctx.fillStyle = "rgba(9, 13, 22, 0.9)";
    ctx.fillRect(lx, ly - 15, tw, 22);
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = 1;
    ctx.strokeRect(lx, ly - 15, tw, 22);
    ctx.fillStyle = "#fef08a";
    ctx.textAlign = "left";
    ctx.fillText(label, lx + 7, ly);
  }
  ctx.restore();
}

export function updateMeasurementReadout() {
  const banner = document.getElementById("measure-readout");
  const txt = document.getElementById("measure-text");
  const clearBtn = document.getElementById("btn-clear-measure");
  const p1 = SPEC_VIEW.measureP1;
  const p2 = SPEC_VIEW.measureP2;

  if (!p1) {
    if (SPEC_VIEW.mode === "measure") {
      banner.classList.remove("hidden");
      txt.textContent = "Measure Mode: Click and drag on the spectrogram to measure Δt, Δf, and Doppler speed.";
    } else {
      banner.classList.add("hidden");
    }
    clearBtn.classList.add("hidden");
    return;
  }

  banner.classList.remove("hidden");
  clearBtn.classList.remove("hidden");

  if (!p2) {
    txt.textContent = `P1: t₁ = ${p1.t.toFixed(3)} s, f₁ = ${p1.f.toFixed(1)} Hz — drag or click second point P2…`;
    return;
  }

  const dt = p2.t - p1.t;
  const absDt = Math.abs(dt);
  const df = p2.f - p1.f;
  const slope = absDt > 1e-5 ? df / dt : 0;
  const c = 343.0;
  const fSum = Math.max(1.0, p1.f + p2.f);
  const vMps = (c * Math.abs(p1.f - p2.f)) / fSum;
  const vKmh = vMps * 3.6;

  txt.innerHTML =
    `<strong>Δt:</strong> ${absDt.toFixed(4)} s (${(absDt * 1000).toFixed(1)} ms) &nbsp;|&nbsp; ` +
    `<strong>Δf:</strong> ${df >= 0 ? "+" : ""}${df.toFixed(2)} Hz (${p1.f.toFixed(1)} → ${p2.f.toFixed(1)} Hz) &nbsp;|&nbsp; ` +
    `<strong>df/dt:</strong> ${slope.toFixed(2)} Hz/s &nbsp;|&nbsp; ` +
    `<strong>Doppler est.:</strong> ${vMps.toFixed(1)} m/s (${vKmh.toFixed(1)} km/h)`;
}

export function initSpectrogramInteractions(canvas) {
  const wrap = canvas.parentElement;

  const clientToData = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const cx = ((ev.clientX - rect.left) / rect.width) * canvas.width;
    const cy = ((ev.clientY - rect.top) / rect.height) * canvas.height;
    const { left: padLeft, right: padRight, top: padTop, bottom: padBottom } = SPEC_VIEW.pad;
    const plotW = canvas.width - padLeft - padRight;
    const plotH = canvas.height - padTop - padBottom;
    const fx = Math.max(0, Math.min(1, (cx - padLeft) / plotW));
    const fy = Math.max(0, Math.min(1, 1.0 - (cy - padTop) / plotH));
    const t = SPEC_VIEW.tMin + fx * (SPEC_VIEW.tMax - SPEC_VIEW.tMin);
    const f = SPEC_VIEW.fMin + fy * (SPEC_VIEW.fMax - SPEC_VIEW.fMin);
    return { t, f, fx, fy, inPlot: cx >= padLeft && cx <= padLeft + plotW && cy >= padTop && cy <= padTop + plotH };
  };

  canvas.addEventListener("wheel", (ev) => {
    if (!SPEC_VIEW.result) return;
    ev.preventDefault();
    const pt = clientToData(ev);
    const factor = ev.deltaY < 0 ? 0.8 : 1.25;
    zoomSpectrogram(factor, pt.fx, pt.fy);
  }, { passive: false });

  canvas.addEventListener("mousedown", (ev) => {
    if (!SPEC_VIEW.result) return;
    const pt = clientToData(ev);
    if (!pt.inPlot) return;
    SPEC_VIEW.isDragging = true;
    SPEC_VIEW.dragStart = {
      clientX: ev.clientX,
      clientY: ev.clientY,
      tMin: SPEC_VIEW.tMin,
      tMax: SPEC_VIEW.tMax,
      fMin: SPEC_VIEW.fMin,
      fMax: SPEC_VIEW.fMax,
    };

    if (SPEC_VIEW.mode === "measure" || ev.shiftKey) {
      SPEC_VIEW.measureP1 = { t: pt.t, f: pt.f };
      SPEC_VIEW.measureP2 = null;
      updateMeasurementReadout();
      renderSpectrogramToCanvas(canvas);
    }
  });

  window.addEventListener("mousemove", (ev) => {
    if (!SPEC_VIEW.result) return;
    const pt = clientToData(ev);
    const res = SPEC_VIEW.result;

    if (pt.inPlot && res.sxxDb) {
      const fFrame = (pt.t / Math.max(1e-6, res.duration_sec)) * (res.time_bins - 1);
      const fBin = (pt.f / Math.max(1e-6, res.fmax_hz)) * (res.freq_bins - 1);
      const db = sampleBilinearDb(res.sxxDb, res.time_bins, res.freq_bins, fFrame, fBin);
      const readoutEl = document.getElementById("spec-cursor-readout");
      if (readoutEl) {
        readoutEl.textContent = `t: ${pt.t.toFixed(3)} s | f: ${pt.f.toFixed(1)} Hz | ${db.toFixed(1)} dB`;
      }
    }

    if (!SPEC_VIEW.isDragging) return;

    if (SPEC_VIEW.mode === "measure" || ev.shiftKey) {
      SPEC_VIEW.measureP2 = { t: pt.t, f: pt.f };
      updateMeasurementReadout();
      renderSpectrogramToCanvas(canvas);
    } else {
      const rect = canvas.getBoundingClientRect();
      const { left: padLeft, right: padRight, top: padTop, bottom: padBottom } = SPEC_VIEW.pad;
      const plotW = canvas.width - padLeft - padRight;
      const plotH = canvas.height - padTop - padBottom;
      const dxNorm = (((ev.clientX - SPEC_VIEW.dragStart.clientX) / rect.width) * canvas.width) / plotW;
      const dyNorm = (((ev.clientY - SPEC_VIEW.dragStart.clientY) / rect.height) * canvas.height) / plotH;

      const tSpan = SPEC_VIEW.dragStart.tMax - SPEC_VIEW.dragStart.tMin;
      const fSpan = SPEC_VIEW.dragStart.fMax - SPEC_VIEW.dragStart.fMin;

      let newTMin = SPEC_VIEW.dragStart.tMin - dxNorm * tSpan;
      let newFMin = SPEC_VIEW.dragStart.fMin + dyNorm * fSpan;

      newTMin = Math.max(0, Math.min(res.duration_sec - tSpan, newTMin));
      newFMin = Math.max(0, Math.min(res.fmax_hz - fSpan, newFMin));

      SPEC_VIEW.tMin = newTMin;
      SPEC_VIEW.tMax = newTMin + tSpan;
      SPEC_VIEW.fMin = newFMin;
      SPEC_VIEW.fMax = newFMin + fSpan;
      renderSpectrogramToCanvas(canvas);
    }
  });

  window.addEventListener("mouseup", () => {
    SPEC_VIEW.isDragging = false;
  });

  wrap.classList.add("mode-pan");
}

export function zoomSpectrogram(factor, anchorFx = 0.5, anchorFy = 0.5) {
  const res = SPEC_VIEW.result;
  if (!res) return;
  const curTSpan = SPEC_VIEW.tMax - SPEC_VIEW.tMin;
  const curFSpan = SPEC_VIEW.fMax - SPEC_VIEW.fMin;
  const newTSpan = Math.max(0.05, Math.min(res.duration_sec, curTSpan * factor));
  const newFSpan = Math.max(40, Math.min(res.fmax_hz, curFSpan * factor));

  const anchorT = SPEC_VIEW.tMin + anchorFx * curTSpan;
  const anchorF = SPEC_VIEW.fMin + anchorFy * curFSpan;

  let tMin = anchorT - anchorFx * newTSpan;
  let fMin = anchorF - anchorFy * newFSpan;
  tMin = Math.max(0, Math.min(res.duration_sec - newTSpan, tMin));
  fMin = Math.max(0, Math.min(res.fmax_hz - newFSpan, fMin));

  SPEC_VIEW.tMin = tMin;
  SPEC_VIEW.tMax = tMin + newTSpan;
  SPEC_VIEW.fMin = fMin;
  SPEC_VIEW.fMax = fMin + newFSpan;
  renderSpectrogramToCanvas(document.getElementById("hires-canvas"));
}

