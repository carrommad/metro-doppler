"use strict";

/**
 * Metro Doppler — Client-First Hybrid Web Application
 * - Raw audio capture via getUserMedia with DSP strictly disabled (echoCancellation: false, noiseSuppression: false, autoGainControl: false)
 * - Dynamic hardware sampleRate detection (never assumes sample rate)
 * - Live low-res WebGL waterfall spectrogram during recording
 * - High-res spectrogram computed either in-browser via fft.js (exact scipy parameters) or via POST /api/spectrogram (Python scipy.signal.spectrogram)
 * - Leaflet map with TMB static GTFS lines + stations and live user GPS tracking
 * - Bundle download (.zip) containing WAV + PNG + context.json
 */

const APP_STATE = {
  isRecording: false,
  sampleRate: null,          // Populated strictly from AudioContext.sampleRate or WAV header
  audioCtx: null,
  mediaStream: null,
  mediaTrack: null,
  workletNode: null,
  analyserNode: null,
  recordedChunks: [],
  recordedSamples: null,     // Float32Array of mono PCM
  recordedWavBlob: null,
  spectrogramPngBlob: null,
  spectrogramMeta: null,
  recordingStartTimeIso: null,
  recordingEndTimeIso: null,
  recordingStartPerf: 0,
  trackConstraintsRequested: null,
  trackSettingsActual: null,
  trackCapabilities: null,
  dspVerifiedOff: false,
  gpsFixes: [],
  latestGpsFix: null,
  observationPoint: { lat: 41.3870, lon: 2.1700, source: "default-catalunya" },
  manualPointSelected: false,
  closestTrainsSnapshot: [],
  expectedTrainTracks: {},
  showExpectedOverlay: true,
  nearestStation: null,
  gtfsFeatures: [],
  pythonBackendAvailable: false,
};

// Inferno-like colormap LUT (256 x RGB)
const COLORMAP_LUT = (function buildInfernoLUT() {
  const stops = [
    [0.0, [0, 0, 4]],
    [0.15, [31, 12, 72]],
    [0.35, [85, 15, 109]],
    [0.55, [156, 43, 89]],
    [0.75, [221, 81, 58]],
    [0.9, [252, 165, 10]],
    [1.0, [252, 255, 164]],
  ];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s0 = stops[0], s1 = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j + 1][0]) {
        s0 = stops[j];
        s1 = stops[j + 1];
        break;
      }
    }
    const localT = (t - s0[0]) / Math.max(1e-6, s1[0] - s0[0]);
    lut[i * 3 + 0] = Math.round(s0[1][0] + localT * (s1[1][0] - s0[1][0]));
    lut[i * 3 + 1] = Math.round(s0[1][1] + localT * (s1[1][1] - s0[1][1]));
    lut[i * 3 + 2] = Math.round(s0[1][2] + localT * (s1[1][2] - s0[1][2]));
  }
  return lut;
})();

/* =========================================================================
   1. WebGL Live Low-Res Waterfall Spectrogram Renderer
   ========================================================================= */
class WebGLSpectrogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    this.texWidth = 360;   // Time columns
    this.texHeight = 256;  // Frequency bins (512-pt FFT -> 256 bins)
    this.writeCol = 0;
    this.dataBuffer = new Uint8Array(this.texWidth * this.texHeight);
    this.columnData = new Uint8Array(this.texHeight);
    if (this.gl) {
      this._initGL();
    }
  }

  _initGL() {
    const gl = this.gl;
    const vsSource = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
    const fsSource = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_specTex;
      uniform sampler2D u_cmapTex;
      uniform float u_writeOffset;
      void main() {
        float x = fract(v_uv.x + u_writeOffset);
        float val = texture2D(u_specTex, vec2(x, v_uv.y)).r;
        vec3 col = texture2D(u_cmapTex, vec2(val, 0.5)).rgb;
        gl_FragColor = vec4(col, 1.0);
      }
    `;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Spectrogram 2D LUMINANCE texture
    this.specTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.LUMINANCE,
      this.texWidth, this.texHeight, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, this.dataBuffer
    );

    // Colormap 1D-like RGB texture (256 x 1)
    this.cmapTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGB,
      256, 1, 0,
      gl.RGB, gl.UNSIGNED_BYTE, COLORMAP_LUT
    );

    gl.uniform1i(gl.getUniformLocation(prog, "u_specTex"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_cmapTex"), 1);
    this.uWriteOffset = gl.getUniformLocation(prog, "u_writeOffset");

    this.render();
  }

  clear() {
    this.dataBuffer.fill(0);
    this.writeCol = 0;
    if (!this.gl) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.LUMINANCE,
      this.texWidth, this.texHeight, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, this.dataBuffer
    );
    this.render();
  }

  pushColumn(freqByteArray) {
    if (!this.gl) return;
    const gl = this.gl;
    const len = Math.min(this.texHeight, freqByteArray.length);
    for (let y = 0; y < this.texHeight; y++) {
      this.columnData[y] = y < len ? freqByteArray[y] : 0;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      this.writeCol, 0, 1, this.texHeight,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, this.columnData
    );
    this.writeCol = (this.writeCol + 1) % this.texWidth;
    this.render();
  }

  render() {
    if (!this.gl) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.uniform1f(this.uWriteOffset, this.writeCol / this.texWidth);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/* =========================================================================
   2. Raw Audio Capture (No Browser DSP, Dynamic Sample Rate) + WAV Encoder
   ========================================================================= */

const WORKLET_CODE = `
class RawCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const ch0 = input[0];
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("raw-capture-processor", RawCaptureProcessor);
`;

function encodeWAV(samplesFloat32, sampleRate) {
  if (!sampleRate || sampleRate <= 0) {
    throw new Error("Refusing to encode WAV without verified dynamic sampleRate");
  }
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samplesFloat32.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);             // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);              // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);     // Dynamic sample rate
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samplesFloat32.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samplesFloat32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/* =========================================================================
   3. High-Res Spectrogram Engine (In-Browser via fft.js & Python Scipy API)
   ========================================================================= */

/**
 * Matches scipy.signal.spectrogram(x, fs=fs, window='hann', nperseg=nperseg,
 * noverlap=noverlap, nfft=nfft, detrend='constant', scaling='density', mode='psd')
 * Note: scipy.signal.get_window('hann', N) uses periodic Hann (fftbins=True):
 * w[n] = 0.5 - 0.5 * cos(2 * pi * n / N)
 */
function computeSpectrogramFFTJS(samples, sampleRate, params) {
  if (!sampleRate || sampleRate <= 0) {
    throw new Error("Dynamic sampleRate required for spectrogram calculation");
  }
  const N = samples.length;
  let nperseg = parseInt(params.nperseg, 10) || 4096;
  if (N < nperseg) {
    nperseg = Math.max(64, 1 << Math.floor(Math.log2(Math.max(64, N))));
  }
  // Ensure power of two for radix-4/2 FFT
  if ((nperseg & (nperseg - 1)) !== 0) {
    nperseg = 1 << Math.round(Math.log2(nperseg));
  }
  let noverlap = parseInt(params.noverlap, 10);
  if (isNaN(noverlap) || noverlap >= nperseg || noverlap < 0) {
    noverlap = Math.floor(nperseg * 0.875);
  }
  const step = nperseg - noverlap;
  const nfft = nperseg;

  // Periodic Hann window matching scipy get_window('hann', nperseg, fftbins=True)
  const win = new Float64Array(nperseg);
  let winSumSq = 0;
  for (let i = 0; i < nperseg; i++) {
    const w = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / nperseg);
    win[i] = w;
    winSumSq += w * w;
  }
  // Scipy scaling='density' scale factor: 1.0 / (fs * sum(win^2))
  const scale = 1.0 / (sampleRate * winSumSq);

  const numFrames = Math.max(1, Math.floor((N - noverlap) / step));
  const numFreqBins = (nfft >> 1) + 1;
  const nyquist = sampleRate / 2.0;
  const fmaxReq = parseFloat(params.fmax) || 4000.0;
  const fmax = Math.min(nyquist, fmaxReq > 0 ? fmaxReq : nyquist);
  const maxBin = Math.min(numFreqBins - 1, Math.ceil((fmax / nyquist) * (numFreqBins - 1)));
  const plottedBins = maxBin + 1;

  const fft = new window.FFT(nfft);
  const inputBlock = new Float64Array(nfft);
  const complexOut = fft.createComplexArray();

  // Sxx_db stored as [frame][bin]
  const sxxDb = new Float32Array(numFrames * plottedBins);
  const times = new Float32Array(numFrames);
  const freqs = new Float32Array(plottedBins);
  for (let b = 0; b < plottedBins; b++) {
    freqs[b] = (b * sampleRate) / nfft;
  }

  const peakFreqTrack = [];

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * step;
    times[frame] = (start + nperseg / 2.0) / sampleRate;

    // detrend='constant' (subtract segment mean)
    let mean = 0.0;
    for (let i = 0; i < nperseg; i++) {
      mean += start + i < N ? samples[start + i] : 0.0;
    }
    mean /= nperseg;

    for (let i = 0; i < nperseg; i++) {
      const val = (start + i < N ? samples[start + i] : 0.0) - mean;
      inputBlock[i] = val * win[i];
    }

    fft.realTransform(complexOut, inputBlock);

    let maxPsd = -1;
    let maxBinIdx = 0;

    for (let b = 0; b < plottedBins; b++) {
      const re = complexOut[2 * b];
      const im = complexOut[2 * b + 1];
      let psd = (re * re + im * im) * scale;
      // One-sided PSD doubles non-DC, non-Nyquist bins (matching scipy one-sided PSD)
      if (b > 0 && b < numFreqBins - 1) {
        psd *= 2.0;
      }
      if (psd > maxPsd) {
        maxPsd = psd;
        maxBinIdx = b;
      }
      const db = 10.0 * Math.log10(Math.max(psd, 1e-20));
      sxxDb[frame * plottedBins + b] = db;
    }

    if (frame < 500) {
      peakFreqTrack.push(Number(freqs[maxBinIdx].toFixed(2)));
    }
  }

  // Compute robust dB range (99.5th percentile and 80 dB dynamic range)
  const sorted = Float32Array.from(sxxDb).sort();
  const vmax = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.995)] : 0;
  const vmin = Math.max(vmax - 80.0, sorted.length > 0 ? sorted[0] : -120.0);

  return {
    engine: "browser-fft.js",
    sample_rate_hz: sampleRate,
    nyquist_hz: nyquist,
    num_samples: N,
    duration_sec: Number((N / sampleRate).toFixed(4)),
    freq_resolution_hz: Number((sampleRate / nfft).toFixed(4)),
    time_step_sec: Number((step / sampleRate).toFixed(6)),
    time_bins: numFrames,
    freq_bins: plottedBins,
    fmax_hz: fmax,
    db_range: [Number(vmin.toFixed(2)), Number(vmax.toFixed(2))],
    parameters: {
      window: "hann",
      nperseg: nperseg,
      noverlap: noverlap,
      nfft: nfft,
      detrend: "constant",
      scaling: "density",
      mode: "psd",
    },
    peak_freq_track_hz: peakFreqTrack,
    sxxDb,
    times,
    freqs,
    vmin,
    vmax,
  };
}


/* =========================================================================
   3b. Interactive High-Res Spectrogram Viewport (Zoom, Smooth Bilinear, Measure)
   ========================================================================= */

const SPEC_VIEW = {
  result: null,
  tMin: 0,
  tMax: 1,
  fMin: 0,
  fMax: 4000,
  smooth: true,
  mode: "pan", // "pan" | "measure"
  isDragging: false,
  dragStart: null,
  measureP1: null, // { t, f }
  measureP2: null, // { t, f }
  hoverPt: null,   // { t, f, db, x, y }
  pad: { left: 68, right: 84, top: 34, bottom: 40 },
};

function sampleBilinearDb(sxxDb, numFrames, numBins, fFrame, fBin) {
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

function setSpectrogramData(canvas, result) {
  SPEC_VIEW.result = result;
  SPEC_VIEW.tMin = 0;
  SPEC_VIEW.tMax = Math.max(0.01, result.duration_sec);
  SPEC_VIEW.fMin = 0;
  SPEC_VIEW.fMax = Math.max(10, result.fmax_hz);
  renderSpectrogramToCanvas(canvas, result);
}

function renderSpectrogramToCanvas(canvas, result) {
  if (!result) result = SPEC_VIEW.result;
  if (!result || !result.sxxDb) return;

  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, W, H);

  const { left: padLeft, right: padRight, top: padTop, bottom: padBottom } = SPEC_VIEW.pad;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  const numFrames = result.time_bins;
  const numBins = result.freq_bins;
  const { sxxDb, vmin, vmax, duration_sec: totalDur, fmax_hz: totalFmax } = result;
  const dbSpan = Math.max(1e-6, vmax - vmin);

  const tMin = SPEC_VIEW.tMin;
  const tMax = SPEC_VIEW.tMax;
  const fMin = SPEC_VIEW.fMin;
  const fMax = SPEC_VIEW.fMax;

  // Render viewport at high resolution with optional 2D Bilinear dB interpolation
  const renderW = Math.min(plotW, 900);
  const renderH = Math.min(plotH, 360);
  const offCanvas = document.createElement("canvas");
  offCanvas.width = renderW;
  offCanvas.height = renderH;
  const offCtx = offCanvas.getContext("2d");
  const imgData = offCtx.createImageData(renderW, renderH);
  const pixels = imgData.data;
  const smooth = SPEC_VIEW.smooth;

  for (let py = 0; py < renderH; py++) {
    const fFrac = 1.0 - py / Math.max(1, renderH - 1);
    const freqHz = fMin + fFrac * (fMax - fMin);
    const fBin = (freqHz / Math.max(1e-6, totalFmax)) * (numBins - 1);

    for (let px = 0; px < renderW; px++) {
      const tFrac = px / Math.max(1, renderW - 1);
      const timeSec = tMin + tFrac * (tMax - tMin);
      const fFrame = (timeSec / Math.max(1e-6, totalDur)) * (numFrames - 1);

      let db;
      if (smooth) {
        db = sampleBilinearDb(sxxDb, numFrames, numBins, fFrame, fBin);
      } else {
        const ix = Math.max(0, Math.min(numFrames - 1, Math.round(fFrame)));
        const iy = Math.max(0, Math.min(numBins - 1, Math.round(fBin)));
        db = sxxDb[ix * numBins + iy];
      }

      const norm = Math.max(0, Math.min(1, (db - vmin) / dbSpan));
      const lutIdx = Math.round(norm * 255) * 3;
      const pIdx = (py * renderW + px) * 4;
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

  // X-axis ticks
  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i++) {
    const frac = i / 6;
    const tVal = tMin + frac * (tMax - tMin);
    const xPos = padLeft + frac * plotW;
    ctx.fillText(`${tVal.toFixed(tMax - tMin < 2 ? 3 : 2)}s`, xPos, padTop + plotH + 17);
    ctx.beginPath();
    ctx.moveTo(xPos, padTop + plotH);
    ctx.lineTo(xPos, padTop + plotH + 4);
    ctx.strokeStyle = "#475569";
    ctx.stroke();
  }
  ctx.fillText("Time (s)", padLeft + plotW / 2, H - 5);

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
}

/**
 * Draws the expected Doppler signal band & trajectory from the closest moving Metro trains,
 * shifted in time by ground acoustic propagation delay Δτ = distance / c_ground
 * and in frequency by Doppler shift f_obs = f0 / (1 + v_radial / c_ground).
 */
function drawExpectedMetroOverlay(ctx, padLeft, padTop, plotW, plotH) {
  if (!APP_STATE.showExpectedOverlay) return;
  const tracks = Object.values(APP_STATE.expectedTrainTracks || {});
  if (tracks.length === 0) return;

  const { tMin, tMax, fMin, fMax } = SPEC_VIEW;
  const cGround = Math.max(200, parseFloat(document.getElementById("input-c-ground")?.value) || 1500);
  const f0Base = Math.max(40, parseFloat(document.getElementById("input-f0-train")?.value) || 440);
  const harmonics = [0.5, 1.0, 2.0, 3.0];

  const toX = (t) => padLeft + ((t - tMin) / Math.max(1e-6, tMax - tMin)) * plotW;
  const toY = (f) => padTop + plotH - ((f - fMin) / Math.max(1e-6, fMax - fMin)) * plotH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padLeft, padTop, plotW, plotH);
  ctx.clip();

  for (const tr of tracks) {
    const samples = tr.samples;
    if (!samples || samples.length < 2) continue;

    for (const hMult of harmonics) {
      const fHarm = f0Base * hMult;
      const isPrimary = hMult === 1.0;

      // Shaded expected signal region (band width proportional to proximity 1/dist)
      ctx.beginPath();
      const upperPts = [];
      const lowerPts = [];

      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const delaySec = s.distM / cGround;
        const tArrival = s.tEmit + delaySec;
        const fShift = fHarm / (1.0 + s.vRadialMps / cGround);
        // Stronger/wider expected signal zone when train is closer (< 600 m)
        const proximity = Math.max(0.15, Math.min(1.0, 250.0 / Math.max(50.0, s.distM)));
        const bandHz = (isPrimary ? 48 : 26) * proximity;
        upperPts.push({ x: toX(tArrival), y: toY(fShift + bandHz), fShift, tArrival, delaySec, distM: s.distM });
        lowerPts.push({ x: toX(tArrival), y: toY(Math.max(0, fShift - bandHz)) });
      }

      ctx.moveTo(upperPts[0].x, upperPts[0].y);
      for (let i = 1; i < upperPts.length; i++) ctx.lineTo(upperPts[i].x, upperPts[i].y);
      for (let i = lowerPts.length - 1; i >= 0; i--) ctx.lineTo(lowerPts[i].x, lowerPts[i].y);
      ctx.closePath();
      ctx.fillStyle = isPrimary ? "rgba(56, 189, 248, 0.18)" : "rgba(56, 189, 248, 0.08)";
      ctx.fill();

      // Center expected Doppler line
      ctx.beginPath();
      for (let i = 0; i < upperPts.length; i++) {
        const yCenter = (upperPts[i].y + lowerPts[i].y) * 0.5;
        if (i === 0) ctx.moveTo(upperPts[i].x, yCenter);
        else ctx.lineTo(upperPts[i].x, yCenter);
      }
      ctx.strokeStyle = isPrimary ? (tr.color || "#38bdf8") : "rgba(147, 197, 253, 0.55)";
      ctx.lineWidth = isPrimary ? 2.2 : 1.2;
      ctx.setLineDash(isPrimary ? [] : [5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label primary harmonic with train ID, distance & ground delay Δτ
      if (isPrimary && upperPts.length > 0) {
        const last = upperPts[upperPts.length - 1];
        const yCenter = (last.y + lowerPts[lowerPts.length - 1].y) * 0.5;
        const lbl = `🚇 ${tr.lineName} #${tr.srvId} (${Math.round(last.distM)}m, Δτ=${(last.delaySec * 1000).toFixed(0)}ms)`;
        ctx.font = "600 10.5px monospace";
        const tw = ctx.measureText(lbl).width + 10;
        const lx = Math.max(padLeft + 6, Math.min(padLeft + plotW - tw - 6, last.x - tw - 4));
        const ly = Math.max(padTop + 16, Math.min(padTop + plotH - 8, yCenter - 6));
        ctx.fillStyle = "rgba(9, 13, 22, 0.88)";
        ctx.fillRect(lx, ly - 12, tw, 17);
        ctx.strokeStyle = tr.color || "#38bdf8";
        ctx.lineWidth = 1;
        ctx.strokeRect(lx, ly - 12, tw, 17);
        ctx.fillStyle = "#f8fafc";
        ctx.textAlign = "left";
        ctx.fillText(lbl, lx + 5, ly);
      }
    }
  }
  ctx.restore();
}

function drawMeasureOverlay(ctx, padLeft, padTop, plotW, plotH) {
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

  // Draw P1 crosshair
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

    // Shaded Δt / Δf box and connecting vector
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

function updateMeasurementReadout() {
  const banner = document.getElementById("measure-readout");
  const txt = document.getElementById("measure-text");
  const clearBtn = document.getElementById("btn-clear-measure");
  const p1 = SPEC_VIEW.measureP1;
  const p2 = SPEC_VIEW.measureP2;

  if (!p1) {
    if (SPEC_VIEW.mode === "measure") {
      banner.classList.remove("hidden");
      txt.textContent = "Measure Mode: Click and drag (or click two points) on the spectrogram to measure Δt, Δf, and Doppler speed.";
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
  // Acoustic Doppler velocity estimate v = c * |f1 - f2| / (f1 + f2)
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

function initSpectrogramInteractions(canvas) {
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
      document.getElementById("spec-cursor-readout").textContent =
        `t: ${pt.t.toFixed(3)} s | f: ${pt.f.toFixed(1)} Hz | ${db.toFixed(1)} dB`;
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

function zoomSpectrogram(factor, anchorFx = 0.5, anchorFy = 0.5) {
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

/* =========================================================================
   4. Leaflet Map, User GPS & TMB Static GTFS Overlay (No API Key Watermark)
   ========================================================================= */

let mapInstance = null;
let gtfsLayerGroup = null;
let radarLayerGroup = null;
let obsMarker = null;
let userMarker = null;
let userAccuracyCircle = null;
let userTrackLine = null;

function setObservationPoint(lat, lon, source = "map-click") {
  APP_STATE.observationPoint = {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    source,
  };
  APP_STATE.manualPointSelected = source === "map-click" || source === "marker-drag";

  const coordsEl = document.getElementById("gps-coords");
  if (coordsEl) {
    coordsEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} (${APP_STATE.manualPointSelected ? "Selected Point" : "GPS"})`;
  }

  if (mapInstance) {
    const latlng = [lat, lon];
    if (!obsMarker) {
      const obsIcon = window.L.divIcon({
        className: "obs-pin-icon",
        html: `<div class="obs-pin-badge" title="Drag or click anywhere on map to move Observation Point">🎯</div>`,
        iconSize: [0, 0],
      });
      obsMarker = window.L.marker(latlng, {
        icon: obsIcon,
        draggable: true,
        zIndexOffset: 2500,
      })
        .addTo(mapInstance)
        .bindPopup("<strong>🎯 Acoustic Observation Point</strong><br/>Click anywhere on the map or drag this pin to move.");
      obsMarker.on("drag", (ev) => {
        const pos = ev.target.getLatLng();
        setObservationPoint(pos.lat, pos.lng, "marker-drag");
      });
      obsMarker.on("dragend", (ev) => {
        const pos = ev.target.getLatLng();
        setObservationPoint(pos.lat, pos.lng, "marker-drag");
      });
    } else {
      obsMarker.setLatLng(latlng);
    }
  }

  updateNearestStation(lat, lon);
  lastRadarUpdatePerf = 0;
  updateClosestTrainsRadar(performance.now());
  if (!APP_STATE.isRecording && SPEC_VIEW.result) {
    refreshStaticExpectedTracksFromPoint();
    renderSpectrogramToCanvas(document.getElementById("hires-canvas"));
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initMap() {
  mapInstance = window.L.map("map", {
    center: [41.395, 2.172],
    zoom: 12,
  });

  // Standard OpenStreetMap tile server (100% free, no API key watermark) styled via CSS dark class
  window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors | TMB Static GTFS',
    maxZoom: 19,
    className: "osm-dark-tiles",
  }).addTo(mapInstance);

  gtfsLayerGroup = window.L.layerGroup().addTo(mapInstance);
  radarLayerGroup = window.L.layerGroup().addTo(mapInstance);
  userTrackLine = window.L.polyline([], {
    color: "#38bdf8",
    weight: 3,
    dashArray: "4 4",
  }).addTo(mapInstance);

  // Place initial observation marker and allow clicking anywhere on map to select observation point
  setObservationPoint(APP_STATE.observationPoint.lat, APP_STATE.observationPoint.lon, "default-catalunya");
  mapInstance.on("click", (ev) => {
    setObservationPoint(ev.latlng.lat, ev.latlng.lng, "map-click");
  });

  fetch("tmb_metro.geojson")
    .then((r) => r.json())
    .then((geojson) => renderGTFSGeoJSON(geojson))
    .catch((err) => console.error("Failed to load tmb_metro.geojson:", err));

  initGeolocation();
}

function renderGTFSGeoJSON(geojson) {
  if (!gtfsLayerGroup) return;
  gtfsLayerGroup.clearLayers();
  APP_STATE.gtfsFeatures = geojson.features || [];

  window.L.geoJSON(geojson, {
    style: (feature) => {
      if (feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString") {
        return {
          color: feature.properties.route_color || "#3b82f6",
          weight: 4,
          opacity: 0.92,
        };
      }
      return {};
    },
    pointToLayer: (feature, latlng) =>
      window.L.circleMarker(latlng, {
        radius: 5,
        fillColor: "#0f172a",
        color: "#f8fafc",
        weight: 2,
        fillOpacity: 1.0,
      }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      layer.on("click", (ev) => {
        if (ev && ev.latlng) {
          setObservationPoint(ev.latlng.lat, ev.latlng.lng, "map-click");
        }
      });
      if (p.feature_type === "route" || p.route_short_name) {
        layer.bindPopup(
          `<strong>TMB Metro ${p.route_short_name || p.route_id}</strong><br/>${p.route_long_name || ""}`
        );
      } else if (p.feature_type === "stop" || p.stop_name) {
        const lines = Array.isArray(p.lines) ? p.lines.join(", ") : p.lines || "";
        layer.bindPopup(
          `<strong>Station: ${p.stop_name}</strong><br/>Stop ID: ${p.stop_id || "—"}<br/>Lines: ${lines}`
        );
      }
    },
  }).addTo(gtfsLayerGroup);

  if (APP_STATE.latestGpsFix) {
    updateNearestStation(APP_STATE.latestGpsFix.lat, APP_STATE.latestGpsFix.lon);
  }
  initMetroTrainFleet(APP_STATE.gtfsFeatures);
}

let trainLayerGroup = null;
let trainFleet = [];
let trainAnimId = null;

function initMetroTrainFleet(features) {
  if (!mapInstance) return;
  if (!trainLayerGroup) {
    trainLayerGroup = window.L.layerGroup().addTo(mapInstance);
  } else {
    trainLayerGroup.clearLayers();
  }
  if (trainAnimId) cancelAnimationFrame(trainAnimId);
  trainFleet = [];

  const routes = features.filter((f) => f.geometry && f.geometry.type === "LineString");
  let serviceCounter = 101;

  for (const r of routes) {
    const coords = r.geometry.coordinates; // [lon, lat]
    if (!coords || coords.length < 2) continue;
    const p = r.properties || {};
    const lineName = p.route_short_name || p.route_id || "M";
    const color = p.route_color || "#3b82f6";

    // Precompute cumulative segment distances in meters
    const segDists = [0];
    let totalLen = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      totalLen += d;
      segDists.push(totalLen);
    }
    if (totalLen < 200) continue;

    // Spawn 2 trains per direction along each line (cruising at ~17.5 m/s = 63 km/h)
    const numTrains = Math.max(2, Math.min(4, Math.round(totalLen / 3800)));
    for (let k = 0; k < numTrains; k++) {
      for (const dir of [1, -1]) {
        const srvId = String(serviceCounter++);
        const startFrac = ((k + (dir === 1 ? 0.15 : 0.6)) / numTrains) % 1.0;
        const icon = window.L.divIcon({
          className: "metro-train-icon",
          html: `<div class="train-pill" style="background:${color}">${lineName} #${srvId}</div>`,
          iconSize: [0, 0],
        });
        const marker = window.L.marker([coords[0][1], coords[0][0]], { icon }).addTo(trainLayerGroup);
        marker.bindPopup(
          `<strong>🚇 Train #${srvId} (${lineName})</strong><br/>${p.route_long_name || ""}<br/>Speed: ~63 km/h (17.5 m/s)`
        );
        trainFleet.push({
          srvId,
          lineName,
          color,
          coords,
          segDists,
          totalLen,
          distPos: startFrac * totalLen,
          dir,
          speedMps: 16.5 + (k % 3) * 1.2,
          marker,
        });
      }
    }
  }

  let lastTs = performance.now();
  const stepTrains = (now) => {
    const dt = Math.min(0.2, (now - lastTs) / 1000.0);
    lastTs = now;

    for (const tr of trainFleet) {
      tr.distPos += tr.dir * tr.speedMps * dt;
      if (tr.distPos >= tr.totalLen) {
        tr.distPos = tr.totalLen;
        tr.dir = -1;
      } else if (tr.distPos <= 0) {
        tr.distPos = 0;
        tr.dir = 1;
      }

      // Interpolate lat/lon along polyline
      const d = tr.distPos;
      let idx = 0;
      while (idx < tr.segDists.length - 2 && tr.segDists[idx + 1] < d) {
        idx++;
      }
      const d0 = tr.segDists[idx];
      const d1 = tr.segDists[idx + 1];
      const frac = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
      const lon = tr.coords[idx][0] + frac * (tr.coords[idx + 1][0] - tr.coords[idx][0]);
      const lat = tr.coords[idx][1] + frac * (tr.coords[idx + 1][1] - tr.coords[idx][1]);
      tr.lat = lat;
      tr.lon = lon;
      tr.segIdx = idx;
      tr.marker.setLatLng([lat, lon]);
    }
    updateClosestTrainsRadar(now);
    trainAnimId = requestAnimationFrame(stepTrains);
  };
  trainAnimId = requestAnimationFrame(stepTrains);

  // Poll live TMB i-Metro API (/api/imetro) every 15s to sync real train service IDs & arrivals
  syncLiveIMetroTrains();
  if (!window._imetroInterval) {
    window._imetroInterval = setInterval(syncLiveIMetroTrains, 15000);
  }
}

async function syncLiveIMetroTrains() {
  try {
    const r = await fetch("/api/imetro", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (data.status !== "ok" || !Array.isArray(data.trains) || data.trains.length === 0) return;

    const metaEl = document.getElementById("map-meta");
    if (metaEl) {
      metaEl.textContent = `TMB i-Metro LIVE (${data.trains.length} active trains synced via API) • Drag corner to resize`;
    }

    // Match live API trains onto line routes by line name and station proximity
    const stopMap = {};
    for (const f of APP_STATE.gtfsFeatures) {
      if (f.geometry && f.geometry.type === "Point" && f.properties && f.properties.stop_id) {
        stopMap[String(f.properties.stop_id)] = f.geometry.coordinates; // [lon, lat]
      }
    }

    let idx = 0;
    for (const apiTr of data.trains) {
      if (idx >= trainFleet.length) break;
      const tr = trainFleet.find((t) => t.lineName === apiTr.nom_linia && !t._synced) || trainFleet[idx++];
      if (!tr) continue;
      tr._synced = true;
      tr.srvId = apiTr.codi_servei;
      const pillHtml = `<div class="train-pill" style="background:${apiTr.color_linia || tr.color}">${apiTr.nom_linia} #${apiTr.codi_servei}</div>`;
      tr.marker.setIcon(
        window.L.divIcon({ className: "metro-train-icon", html: pillHtml, iconSize: [0, 0] })
      );
      tr.marker.setPopupContent(
        `<strong>🚇 TMB Live Train #${apiTr.codi_servei} (${apiTr.nom_linia})</strong><br/>` +
          `Destination: <b>${apiTr.desti_trajecte}</b><br/>` +
          `Next Station ID: ${apiTr.codi_estacio} (ETA: ${apiTr.eta_sec}s)`
      );

      // Snap train distance along route near its upcoming station minus ETA * speed
      const stCoord = stopMap[String(apiTr.codi_estacio)];
      if (stCoord) {
        let bestSeg = 0;
        let bestD = Infinity;
        for (let i = 0; i < tr.coords.length; i++) {
          const d = haversineMeters(stCoord[1], stCoord[0], tr.coords[i][1], tr.coords[i][0]);
          if (d < bestD) {
            bestD = d;
            bestSeg = i;
          }
        }
        tr.dir = apiTr.id_sentit === 1 ? 1 : -1;
        const offsetMeters = tr.dir * Math.min(800, apiTr.eta_sec * tr.speedMps);
        tr.distPos = Math.max(0, Math.min(tr.totalLen, tr.segDists[bestSeg] - offsetMeters));
      }
    }
    for (const t of trainFleet) delete t._synced;
  } catch (_) {}
}

let lastRadarUpdatePerf = 0;

function updateClosestTrainsRadar(now) {
  if (now - lastRadarUpdatePerf < 140) return;
  lastRadarUpdatePerf = now;

  const obs = APP_STATE.observationPoint;
  if (!obs || trainFleet.length === 0) return;

  const cGround = Math.max(200, parseFloat(document.getElementById("input-c-ground")?.value) || 1500);
  const f0Base = Math.max(40, parseFloat(document.getElementById("input-f0-train")?.value) || 440);
  const cosLat = Math.cos((obs.lat * Math.PI) / 180.0);

  const ranked = [];
  for (const tr of trainFleet) {
    if (tr.lat === undefined || tr.lon === undefined) continue;
    const distM = haversineMeters(obs.lat, obs.lon, tr.lat, tr.lon);

    // Compute unit tangent along track and radial velocity v_r = v_train · r_hat (positive = receding, negative = approaching)
    const idx = tr.segIdx || 0;
    const dxTrack = (tr.coords[idx + 1][0] - tr.coords[idx][0]) * cosLat * 111320 * tr.dir;
    const dyTrack = (tr.coords[idx + 1][1] - tr.coords[idx][1]) * 110540 * tr.dir;
    const trackNorm = Math.max(1e-6, Math.hypot(dxTrack, dyTrack));
    const vx = (dxTrack / trackNorm) * tr.speedMps;
    const vy = (dyTrack / trackNorm) * tr.speedMps;

    const rx = (tr.lon - obs.lon) * cosLat * 111320;
    const ry = (tr.lat - obs.lat) * 110540;
    const rNorm = Math.max(1.0, Math.hypot(rx, ry));
    const vRadialMps = (vx * rx + vy * ry) / rNorm;
    const groundDelaySec = distM / cGround;
    const fExpectedHz = f0Base / (1.0 + vRadialMps / cGround);

    ranked.push({
      srvId: tr.srvId,
      lineName: tr.lineName,
      color: tr.color,
      lat: tr.lat,
      lon: tr.lon,
      distM,
      vRadialMps,
      groundDelaySec,
      fExpectedHz,
    });
  }

  ranked.sort((a, b) => a.distM - b.distM);
  const closest = ranked.slice(0, 3);
  APP_STATE.closestTrainsSnapshot = closest;

  // Draw dashed ground-propagation rays from selected observation point to the 3 closest trains
  if (radarLayerGroup) {
    radarLayerGroup.clearLayers();
    for (let i = 0; i < closest.length; i++) {
      const c = closest[i];
      window.L.polyline(
        [
          [obs.lat, obs.lon],
          [c.lat, c.lon],
        ],
        {
          color: c.color || "#facc15",
          weight: i === 0 ? 2.5 : 1.5,
          opacity: i === 0 ? 0.9 : 0.55,
          dashArray: "5 5",
        }
      ).addTo(radarLayerGroup);
    }
  }

  const el = document.getElementById("closest-trains-live");
  if (el) {
    el.innerHTML = closest
      .map(
        (c) =>
          `<span style="color:${c.color};font-weight:700">${c.lineName}#${c.srvId}</span> ` +
          `${Math.round(c.distM)}m (Δτ=${(c.groundDelaySec * 1000).toFixed(0)}ms, f≈${c.fExpectedHz.toFixed(0)}Hz)`
      )
      .join(" · ");
  }

  // Log kinematics during recording for the spectrogram expected-signal region overlay
  if (APP_STATE.isRecording) {
    const tEmit = (performance.now() - APP_STATE.recordingStartPerf) / 1000.0;
    for (const c of closest.slice(0, 2)) {
      const key = `${c.lineName}_${c.srvId}`;
      if (!APP_STATE.expectedTrainTracks[key]) {
        APP_STATE.expectedTrainTracks[key] = {
          srvId: c.srvId,
          lineName: c.lineName,
          color: c.color,
          samples: [],
        };
      }
      APP_STATE.expectedTrainTracks[key].samples.push({
        tEmit,
        distM: c.distM,
        vRadialMps: c.vRadialMps,
      });
    }
  }
}

function updateNearestStation(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const feat of APP_STATE.gtfsFeatures) {
    if (feat.geometry && feat.geometry.type === "Point") {
      const [sLon, sLat] = feat.geometry.coordinates;
      const d = haversineMeters(lat, lon, sLat, sLon);
      if (d < bestDist) {
        bestDist = d;
        best = {
          stop_id: feat.properties.stop_id,
          stop_name: feat.properties.stop_name,
          lines: feat.properties.lines || [],
          distance_m: Math.round(d),
          coordinates: [sLon, sLat],
        };
      }
    }
  }
  APP_STATE.nearestStation = best;
  const stEl = document.getElementById("nearest-station");
  const lnEl = document.getElementById("nearest-lines");
  if (best) {
    stEl.textContent = `${best.stop_name} (${best.distance_m} m)`;
    lnEl.textContent = Array.isArray(best.lines) ? best.lines.join(", ") : String(best.lines);
  } else {
    stEl.textContent = "—";
    lnEl.textContent = "—";
  }
}

function initGeolocation() {
  const badgeGps = document.getElementById("badge-gps");
  const coordsEl = document.getElementById("gps-coords");
  if (!("geolocation" in navigator)) {
    badgeGps.textContent = "GPS: Unsupported";
    badgeGps.className = "badge badge-err";
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      const fix = {
        timestamp_iso: new Date(pos.timestamp).toISOString(),
        lat: Number(pos.coords.latitude.toFixed(6)),
        lon: Number(pos.coords.longitude.toFixed(6)),
        accuracy_m: Number((pos.coords.accuracy || 0).toFixed(1)),
        altitude_m: pos.coords.altitude !== null ? Number(pos.coords.altitude.toFixed(1)) : null,
        speed_mps: pos.coords.speed !== null ? Number(pos.coords.speed.toFixed(2)) : null,
      };
      APP_STATE.latestGpsFix = fix;
      if (APP_STATE.isRecording) APP_STATE.gpsFixes.push(fix);

      badgeGps.textContent = `GPS: ±${fix.accuracy_m}m`;
      badgeGps.className = "badge badge-ok";
      coordsEl.textContent = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;

      const latlng = [fix.lat, fix.lon];
      if (!userMarker) {
        userMarker = window.L.circleMarker(latlng, {
          radius: 7,
          fillColor: "#10b981",
          color: "#ffffff",
          weight: 2,
          fillOpacity: 1,
        })
          .addTo(mapInstance)
          .bindPopup("User GPS Position");
        userAccuracyCircle = window.L.circle(latlng, {
          radius: Math.min(fix.accuracy_m, 1200),
          color: "#10b981",
          weight: 1,
          fillOpacity: 0.1,
        }).addTo(mapInstance);
      } else {
        userMarker.setLatLng(latlng);
        userAccuracyCircle.setLatLng(latlng);
        userAccuracyCircle.setRadius(Math.min(fix.accuracy_m, 1200));
      }

      if (APP_STATE.isRecording && userTrackLine) userTrackLine.addLatLng(latlng);
      if (!APP_STATE.manualPointSelected) {
        setObservationPoint(fix.lat, fix.lon, "gps");
      }
      updateContextPreview();
    },
    (err) => {
      badgeGps.textContent = `GPS: ${err.message || "Unavailable"}`;
      badgeGps.className = "badge badge-warn";
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

async function handleCustomGTFSFile(file) {
  if (!file) return;
  if (file.name.endsWith(".json") || file.name.endsWith(".geojson")) {
    renderGTFSGeoJSON(JSON.parse(await file.text()));
    return;
  }
  if (file.name.endsWith(".zip")) {
    const zip = await window.JSZip.loadAsync(file);
    const features = [];
    const parseCSV = (txt) => {
      const lines = txt.trim().split(/\r?\n/);
      if (lines.length < 2) return [];
      const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      return lines.slice(1).map((line) => {
        const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
        const obj = {};
        headers.forEach((h, i) => (obj[h] = vals[i]));
        return obj;
      });
    };
    if (zip.file("shapes.txt")) {
      const rows = parseCSV(await zip.file("shapes.txt").async("string"));
      const byShape = {};
      for (const r of rows) {
        if (!r.shape_id) continue;
        (byShape[r.shape_id] = byShape[r.shape_id] || []).push({
          seq: parseInt(r.shape_pt_sequence || "0", 10),
          lon: parseFloat(r.shape_pt_lon),
          lat: parseFloat(r.shape_pt_lat),
        });
      }
      for (const [shapeId, pts] of Object.entries(byShape)) {
        pts.sort((a, b) => a.seq - b.seq);
        features.push({
          type: "Feature",
          properties: { feature_type: "route", route_id: shapeId, route_short_name: shapeId, route_color: "#38bdf8" },
          geometry: { type: "LineString", coordinates: pts.map((p) => [p.lon, p.lat]) },
        });
      }
    }
    if (zip.file("stops.txt")) {
      const rows = parseCSV(await zip.file("stops.txt").async("string"));
      for (const r of rows.slice(0, 600)) {
        const lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
        if (!isNaN(lat) && !isNaN(lon)) {
          features.push({
            type: "Feature",
            properties: { feature_type: "stop", stop_id: r.stop_id, stop_name: r.stop_name || r.stop_id, lines: [] },
            geometry: { type: "Point", coordinates: [lon, lat] },
          });
        }
      }
    }
    if (features.length > 0) renderGTFSGeoJSON({ type: "FeatureCollection", features });
  }
}


/* =========================================================================
   5. Parallel Worker Live High-Res Spectrogram, DSP Guard & ZIP Bundle
   ========================================================================= */

let stftWorker = null;
let animFrameId = null;
let latestChunkPeak = 0;

const LIVE_STFT = {
  columns: [],       // Array of Float32Array(plottedBins)
  peakFreqs: [],
  plottedBins: 0,
  nperseg: 4096,
  noverlap: 3584,
  step: 512,
  fmax: 4000,
  sampleRate: 48000,
  freqResolutionHz: 0,
  timeStepSec: 0,
  dirty: false,
};

function initParallelWorker() {
  if (stftWorker) stftWorker.terminate();
  stftWorker = new Worker("stft_worker.js");
  stftWorker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "init_ack") {
      LIVE_STFT.plottedBins = msg.plottedBins;
      LIVE_STFT.nperseg = msg.nperseg;
      LIVE_STFT.noverlap = msg.noverlap;
      LIVE_STFT.step = msg.step;
      LIVE_STFT.fmax = msg.fmax;
      LIVE_STFT.sampleRate = msg.sampleRate;
      LIVE_STFT.freqResolutionHz = msg.freqResolutionHz;
      LIVE_STFT.timeStepSec = msg.timeStepSec;
      LIVE_STFT.columns = [];
      LIVE_STFT.peakFreqs = [];
      LIVE_STFT.dirty = false;
    } else if (msg.type === "frames") {
      const { numNewFrames, plottedBins, flatDb, framePeaks } = msg;
      for (let i = 0; i < numNewFrames; i++) {
        LIVE_STFT.columns.push(flatDb.slice(i * plottedBins, (i + 1) * plottedBins));
      }
      if (framePeaks) {
        for (const p of framePeaks) {
          if (LIVE_STFT.peakFreqs.length < 500) LIVE_STFT.peakFreqs.push(p);
        }
      }
      LIVE_STFT.dirty = true;
    }
  };
}

function flushLiveHighResSpectrogram() {
  if (!LIVE_STFT.dirty || LIVE_STFT.columns.length === 0) return;
  LIVE_STFT.dirty = false;

  const numFrames = LIVE_STFT.columns.length;
  const numBins = LIVE_STFT.plottedBins;
  const sxxDb = new Float32Array(numFrames * numBins);
  let maxVal = -200;
  let minVal = 200;

  for (let f = 0; f < numFrames; f++) {
    const col = LIVE_STFT.columns[f];
    sxxDb.set(col, f * numBins);
    for (let b = 0; b < numBins; b += 4) {
      const v = col[b];
      if (v > maxVal) maxVal = v;
      if (v < minVal) minVal = v;
    }
  }

  const vmax = maxVal > -180 ? maxVal - 3.0 : -40.0;
  const vmin = Math.max(vmax - 78.0, minVal);
  const durationSec = Math.max(0.1, Number((numFrames * LIVE_STFT.timeStepSec).toFixed(4)));

  const liveRes = {
    engine: "worker-fft.js (live)",
    sample_rate_hz: LIVE_STFT.sampleRate,
    nyquist_hz: LIVE_STFT.sampleRate / 2,
    num_samples: numFrames * LIVE_STFT.step + LIVE_STFT.noverlap,
    duration_sec: durationSec,
    freq_resolution_hz: LIVE_STFT.freqResolutionHz,
    time_step_sec: LIVE_STFT.timeStepSec,
    time_bins: numFrames,
    freq_bins: numBins,
    fmax_hz: LIVE_STFT.fmax,
    db_range: [Number(vmin.toFixed(2)), Number(vmax.toFixed(2))],
    parameters: {
      window: "hann",
      nperseg: LIVE_STFT.nperseg,
      noverlap: LIVE_STFT.noverlap,
      nfft: LIVE_STFT.nperseg,
      detrend: "constant",
      scaling: "density",
      mode: "psd",
    },
    peak_freq_track_hz: LIVE_STFT.peakFreqs,
    sxxDb,
    vmin,
    vmax,
  };

  APP_STATE.spectrogramMeta = liveRes;
  const hiresCanvas = document.getElementById("hires-canvas");
  setSpectrogramData(hiresCanvas, liveRes);

  document.getElementById("hires-engine-tag").textContent =
    `Parallel Worker • Hann ${LIVE_STFT.nperseg}/${LIVE_STFT.noverlap}`;
  document.getElementById("hires-spec-meta").textContent =
    `LIVE: fs=${liveRes.sample_rate_hz} Hz | Δf=${liveRes.freq_resolution_hz} Hz | Δt=${(liveRes.time_step_sec * 1000).toFixed(2)} ms | ` +
    `Frames: ${numFrames}×${numBins}`;
}

function buildContextJson() {
  return {
    app: "metro-doppler",
    schema_version: "1.0",
    exported_at_iso: new Date().toISOString(),
    recording: {
      start_time_iso: APP_STATE.recordingStartTimeIso,
      end_time_iso: APP_STATE.recordingEndTimeIso,
      sample_rate_hz: APP_STATE.sampleRate,
      sample_rate_assumed: false,
      num_samples: APP_STATE.recordedSamples ? APP_STATE.recordedSamples.length : 0,
      duration_sec:
        APP_STATE.recordedSamples && APP_STATE.sampleRate
          ? Number((APP_STATE.recordedSamples.length / APP_STATE.sampleRate).toFixed(4))
          : 0,
    },
    audio_dsp_verification: {
      dsp_disabled_verified: APP_STATE.dspVerifiedOff,
      constraints_requested: APP_STATE.trackConstraintsRequested,
      track_settings_actual: APP_STATE.trackSettingsActual,
    },
    spectrogram: APP_STATE.spectrogramMeta
      ? {
          engine: APP_STATE.spectrogramMeta.engine,
          sample_rate_hz: APP_STATE.spectrogramMeta.sample_rate_hz,
          nyquist_hz: APP_STATE.spectrogramMeta.nyquist_hz,
          freq_resolution_hz: APP_STATE.spectrogramMeta.freq_resolution_hz,
          time_step_sec: APP_STATE.spectrogramMeta.time_step_sec,
          time_bins: APP_STATE.spectrogramMeta.time_bins,
          freq_bins: APP_STATE.spectrogramMeta.freq_bins,
          fmax_hz: APP_STATE.spectrogramMeta.fmax_hz,
          db_range: APP_STATE.spectrogramMeta.db_range,
          parameters: APP_STATE.spectrogramMeta.parameters,
          peak_freq_track_hz: APP_STATE.spectrogramMeta.peak_freq_track_hz,
        }
      : null,
    geolocation_and_gtfs: {
      observation_point: APP_STATE.observationPoint,
      ground_speed_mps: APP_STATE.cGround,
      latest_gps_fix: APP_STATE.latestGpsFix,
      gps_trajectory_during_recording: APP_STATE.gpsFixes,
      nearest_tmb_station: APP_STATE.nearestStation,
      closest_trains_snapshot: APP_STATE.closestTrainsSnapshot,
      expected_train_tracks: APP_STATE.expectedTrainTracks,
    },
  };
}

function updateContextPreview() {
  // Context JSON is built on demand for the ZIP bundle; no on-screen preview box needed
}

function showDspAlert(msg) {
  const banner = document.getElementById("dsp-alert");
  if (!msg) {
    banner.classList.add("hidden");
    banner.textContent = "";
  } else {
    banner.textContent = msg;
    banner.classList.remove("hidden");
  }
}

async function startRecording() {
  showDspAlert(null);
  const badgeDsp = document.getElementById("badge-dsp");
  const badgeSr = document.getElementById("badge-sr");
  const dspTelemetry = document.getElementById("dsp-telemetry");

  const strictConstraints = {
    audio: {
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
      channelCount: { ideal: 1 },
    },
    video: false,
  };

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(strictConstraints);
    APP_STATE.trackConstraintsRequested = strictConstraints.audio;
  } catch (_) {
    const fallbackConstraints = {
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    };
    stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
    APP_STATE.trackConstraintsRequested = fallbackConstraints.audio;
  }

  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("No audio track obtained from getUserMedia");

  try {
    await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  } catch (_) {}

  const settings = track.getSettings ? track.getSettings() : {};
  APP_STATE.trackSettingsActual = settings;
  APP_STATE.mediaStream = stream;
  APP_STATE.mediaTrack = track;

  if (settings.noiseSuppression === true || settings.echoCancellation === true || settings.autoGainControl === true) {
    track.stop();
    stream.getTracks().forEach((t) => t.stop());
    APP_STATE.dspVerifiedOff = false;
    badgeDsp.textContent = "DSP: BLOCKED (Active!)";
    badgeDsp.className = "badge badge-err";
    const errMsg = `ABORTED: Browser refused to disable DSP (noiseSuppression=${settings.noiseSuppression}, echoCancellation=${settings.echoCancellation}, autoGainControl=${settings.autoGainControl}).`;
    showDspAlert(errMsg);
    throw new Error(errMsg);
  }

  APP_STATE.dspVerifiedOff = true;
  badgeDsp.textContent = "DSP: OFF (Verified)";
  badgeDsp.className = "badge badge-ok";

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  await audioCtx.resume();

  const actualSampleRate = audioCtx.sampleRate;
  if (!actualSampleRate || actualSampleRate <= 0) {
    throw new Error("Unable to determine dynamic AudioContext sampleRate");
  }
  APP_STATE.sampleRate = actualSampleRate;
  APP_STATE.audioCtx = audioCtx;

  badgeSr.textContent = `Sample Rate: ${actualSampleRate} Hz`;
  badgeSr.className = "badge badge-ok";

  dspTelemetry.innerHTML =
    `<span><strong>DSP Verified OFF:</strong> noiseSuppression=<code>${String(settings.noiseSuppression ?? false)}</code> | ` +
    `echoCancellation=<code>${String(settings.echoCancellation ?? false)}</code> | ` +
    `autoGainControl=<code>${String(settings.autoGainControl ?? false)}</code> | ` +
    `Hardware AudioContext fs=<code>${actualSampleRate} Hz</code> (drag bottom-right corner to resize box)</span>`;

  // Initialize parallel Web Worker with current STFT parameters and hardware sampleRate
  const nperseg = parseInt(document.getElementById("input-nperseg").value, 10) || 4096;
  const noverlap = parseInt(document.getElementById("input-overlap").value, 10) || 3584;
  const fmax = parseFloat(document.getElementById("input-fmax").value) || 4000;
  initParallelWorker();
  stftWorker.postMessage({
    type: "init",
    sampleRate: actualSampleRate,
    nperseg,
    noverlap,
    fmax,
  });

  const sourceNode = audioCtx.createMediaStreamSource(stream);
  const zeroGain = audioCtx.createGain();
  zeroGain.gain.value = 0.0;
  zeroGain.connect(audioCtx.destination);

  APP_STATE.recordedChunks = [];
  APP_STATE.gpsFixes = APP_STATE.latestGpsFix ? [APP_STATE.latestGpsFix] : [];
  if (userTrackLine) userTrackLine.setLatLngs([]);
  latestChunkPeak = 0;

  const onPcmChunk = (chunk) => {
    APP_STATE.recordedChunks.push(chunk);
    let pk = 0;
    for (let i = 0; i < chunk.length; i++) {
      const a = Math.abs(chunk[i]);
      if (a > pk) pk = a;
    }
    latestChunkPeak = Math.max(pk, latestChunkPeak * 0.85);
    if (stftWorker) {
      const workerCopy = new Float32Array(chunk);
      stftWorker.postMessage({ type: "chunk", samples: workerCopy }, [workerCopy.buffer]);
    }
  };

  if (audioCtx.audioWorklet) {
    const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const workletNode = new AudioWorkletNode(audioCtx, "raw-capture-processor");
    workletNode.port.onmessage = (ev) => {
      if (APP_STATE.isRecording && ev.data) {
        onPcmChunk(new Float32Array(ev.data));
      }
    };
    sourceNode.connect(workletNode);
    workletNode.connect(zeroGain);
    APP_STATE.workletNode = workletNode;
  } else {
    const scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);
    scriptNode.onaudioprocess = (ev) => {
      if (APP_STATE.isRecording) {
        onPcmChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
      }
    };
    sourceNode.connect(scriptNode);
    scriptNode.connect(zeroGain);
    APP_STATE.workletNode = scriptNode;
  }

  APP_STATE.isRecording = true;
  APP_STATE.recordingStartTimeIso = new Date().toISOString();
  APP_STATE.recordingEndTimeIso = null;
  APP_STATE.recordingStartPerf = performance.now();
  APP_STATE.expectedTrainTracks = {};
  updateClosestTrainsRadar(APP_STATE.recordingStartPerf);

  document.getElementById("btn-record").disabled = true;
  document.getElementById("btn-record").classList.add("recording-active");
  document.getElementById("btn-stop").disabled = false;
  document.getElementById("btn-synth").disabled = true;
  document.getElementById("rec-state-label").textContent = "RECORDING (LIVE STFT)";

  const renderLoop = () => {
    if (!APP_STATE.isRecording) return;

    flushLiveHighResSpectrogram();

    const db = latestChunkPeak > 1e-6 ? 20 * Math.log10(latestChunkPeak) : -100;
    const pct = Math.max(0, Math.min(100, ((db + 65) / 65) * 100));
    document.getElementById("level-fill").style.width = `${pct.toFixed(1)}%`;
    document.getElementById("level-db").textContent = db <= -99 ? "-∞ dBFS" : `${db.toFixed(1)} dBFS`;

    const elapsedSec = (performance.now() - APP_STATE.recordingStartPerf) / 1000;
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const secs = (elapsedSec % 60).toFixed(1).padStart(4, "0");
    document.getElementById("rec-timer").textContent = `${mins}:${secs}`;

    const totalSamples = APP_STATE.recordedChunks.reduce((acc, c) => acc + c.length, 0);
    document.getElementById("rec-samples").textContent = `(${totalSamples.toLocaleString()} samples)`;

    animFrameId = requestAnimationFrame(renderLoop);
  };
  animFrameId = requestAnimationFrame(renderLoop);
}

async function stopRecordingAndCompute() {
  if (!APP_STATE.isRecording) return;
  APP_STATE.isRecording = false;
  APP_STATE.recordingEndTimeIso = new Date().toISOString();
  if (animFrameId) cancelAnimationFrame(animFrameId);

  if (APP_STATE.mediaTrack) APP_STATE.mediaTrack.stop();
  if (APP_STATE.mediaStream) APP_STATE.mediaStream.getTracks().forEach((t) => t.stop());
  if (APP_STATE.audioCtx) {
    try {
      await APP_STATE.audioCtx.close();
    } catch (_) {}
  }

  document.getElementById("btn-record").disabled = false;
  document.getElementById("btn-record").classList.remove("recording-active");
  document.getElementById("btn-stop").disabled = true;
  document.getElementById("btn-synth").disabled = false;
  document.getElementById("rec-state-label").textContent = "FINALIZING";

  const totalLen = APP_STATE.recordedChunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of APP_STATE.recordedChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  APP_STATE.recordedSamples = merged;

  await finalizeAudioAndComputeHighRes();
}

async function finalizeAudioAndComputeHighRes() {
  const samples = APP_STATE.recordedSamples;
  const fs = APP_STATE.sampleRate;
  if (!samples || samples.length === 0 || !fs) {
    document.getElementById("rec-state-label").textContent = "EMPTY";
    return;
  }

  const wavBlob = encodeWAV(samples, fs);
  APP_STATE.recordedWavBlob = wavBlob;

  const audioEl = document.getElementById("audio-preview");
  audioEl.src = URL.createObjectURL(wavBlob);
  audioEl.classList.remove("hidden");

  await computeHighResSpectrogram();
  document.getElementById("rec-state-label").textContent = "READY";
  document.getElementById("btn-recompute").disabled = false;
  document.getElementById("btn-download-bundle").disabled = false;
}

async function computeHighResSpectrogram() {
  const samples = APP_STATE.recordedSamples;
  const fs = APP_STATE.sampleRate;
  if (!samples || !fs) return;

  const engine = document.getElementById("select-engine").value;
  const nperseg = parseInt(document.getElementById("input-nperseg").value, 10) || 4096;
  const noverlap = parseInt(document.getElementById("input-overlap").value, 10) || 3584;
  const fmax = parseFloat(document.getElementById("input-fmax").value) || 4000;

  const hiresCanvas = document.getElementById("hires-canvas");
  const hiresImg = document.getElementById("hires-img");
  const metaEl = document.getElementById("hires-spec-meta");
  const tagEl = document.getElementById("hires-engine-tag");

  metaEl.textContent = `Computing high-resolution spectrogram (${engine})…`;

  if (engine === "scipy") {
    try {
      const paramsHeader = JSON.stringify({
        window: "hann",
        nperseg,
        noverlap,
        nfft: nperseg,
        detrend: "constant",
        scaling: "density",
        mode: "psd",
        fmax,
      });
      const resp = await fetch("/api/spectrogram", {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-Spectrogram-Params": paramsHeader,
        },
        body: APP_STATE.recordedWavBlob,
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();

      const binStr = atob(data.png_base64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      APP_STATE.spectrogramPngBlob = new Blob([bytes], { type: "image/png" });

      if (data.sxx_db_f32_b64) {
        const fStr = atob(data.sxx_db_f32_b64);
        const fBytes = new Uint8Array(fStr.length);
        for (let i = 0; i < fStr.length; i++) fBytes[i] = fStr.charCodeAt(i);
        data.sxxDb = new Float32Array(fBytes.buffer);
        data.vmin = data.db_range[0];
        data.vmax = data.db_range[1];
      }

      APP_STATE.spectrogramMeta = data;
      hiresImg.classList.add("hidden");
      hiresCanvas.classList.remove("hidden");
      setSpectrogramData(hiresCanvas, data);

      tagEl.textContent = `scipy.signal • Hann ${data.parameters.nperseg}/${data.parameters.noverlap}`;
      metaEl.textContent =
        `fs=${data.sample_rate_hz} Hz | Δf=${data.freq_resolution_hz} Hz | Δt=${(data.time_step_sec * 1000).toFixed(2)} ms | ` +
        `Grid: ${data.time_bins}×${data.freq_bins}`;
      return;
    } catch (err) {
      console.warn("Python scipy service failed or unreachable, falling back to in-browser fft.js:", err);
      metaEl.textContent = `Python service error (${err.message}); falling back to in-browser fft.js…`;
    }
  }

  const res = computeSpectrogramFFTJS(samples, fs, { nperseg, noverlap, fmax });
  APP_STATE.spectrogramMeta = res;

  hiresImg.classList.add("hidden");
  hiresCanvas.classList.remove("hidden");
  setSpectrogramData(hiresCanvas, res);

  const pngBlob = await new Promise((resolve) => hiresCanvas.toBlob(resolve, "image/png"));
  APP_STATE.spectrogramPngBlob = pngBlob;

  tagEl.textContent = `fft.js • Hann ${res.parameters.nperseg}/${res.parameters.noverlap}`;
  metaEl.textContent =
    `fs=${res.sample_rate_hz} Hz | Δf=${res.freq_resolution_hz} Hz | Δt=${(res.time_step_sec * 1000).toFixed(2)} ms | ` +
    `Grid: ${res.time_bins}×${res.freq_bins}`;
}

async function simulateMetroPassBy() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const tempCtx = new AudioCtx();
  const fs = tempCtx.sampleRate;
  await tempCtx.close();

  APP_STATE.sampleRate = fs;
  APP_STATE.dspVerifiedOff = true;
  APP_STATE.trackConstraintsRequested = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    synthetic_simulation: true,
  };
  APP_STATE.trackSettingsActual = {
    sampleRate: fs,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };

  document.getElementById("badge-dsp").textContent = "DSP: OFF (Simulated Raw)";
  document.getElementById("badge-dsp").className = "badge badge-ok";
  document.getElementById("badge-sr").textContent = `Sample Rate: ${fs} Hz`;
  document.getElementById("badge-sr").className = "badge badge-ok";
  document.getElementById("dsp-telemetry").innerHTML =
    `<span><strong>Simulated Metro Pass-By:</strong> Hardware AudioContext fs=<code>${fs} Hz</code> | ` +
    `v=<code>18 m/s (64.8 km/h)</code> | d_min=<code>4.5 m</code> | Harmonics: <code>220, 440, 880, 1320, 1760 Hz</code> (drag bottom-right corner to resize)</span>`;

  const duration = 6.0;
  const N = Math.floor(duration * fs);
  const samples = new Float32Array(N);

  const c = 343.0, v = 18.0, d0 = 4.5, t0 = duration / 2.0;
  const baseFreqs = [220, 440, 660, 880, 1320, 1760, 2420];
  const amps = [0.28, 0.35, 0.18, 0.22, 0.15, 0.12, 0.08];
  const phases = new Float64Array(baseFreqs.length);

  for (let n = 0; n < N; n++) {
    const t = n / fs;
    const xPos = v * (t - t0);
    const dist = Math.sqrt(xPos * xPos + d0 * d0);
    const radialVel = (v * xPos) / dist;
    const dopplerFactor = c / (c + radialVel);
    const env = Math.min(1.0, 5.0 / (dist + 1.5));

    let val = (Math.random() * 2 - 1) * 0.015;
    for (let k = 0; k < baseFreqs.length; k++) {
      const fInst = baseFreqs[k] * dopplerFactor;
      phases[k] += (2.0 * Math.PI * fInst) / fs;
      val += amps[k] * env * Math.sin(phases[k]);
    }
    samples[n] = Math.max(-0.98, Math.min(0.98, val));
  }

  const now = new Date();
  APP_STATE.recordingStartTimeIso = new Date(now.getTime() - duration * 1000).toISOString();
  APP_STATE.recordingEndTimeIso = now.toISOString();
  APP_STATE.recordedSamples = samples;
  document.getElementById("rec-timer").textContent = `00:0${duration.toFixed(1)}`;
  document.getElementById("rec-samples").textContent = `(${N.toLocaleString()} samples)`;

  // Populate expected train track for the simulated pass-by + current closest map trains
  refreshStaticExpectedTracksFromPoint(duration);

  await finalizeAudioAndComputeHighRes();
}

function refreshStaticExpectedTracksFromPoint(durationOverride = null) {
  const duration = durationOverride || (SPEC_VIEW.result ? SPEC_VIEW.result.duration_sec : 6.0);
  const v = 18.0, d0 = 4.5, t0 = duration / 2.0;
  const simSamples = [];
  for (let t = 0; t <= duration; t += 0.1) {
    const xPos = v * (t - t0);
    const distM = Math.sqrt(xPos * xPos + d0 * d0);
    const vRadialMps = (v * xPos) / distM;
    simSamples.push({
      tEmit: Number(t.toFixed(2)),
      distM: Number(distM.toFixed(1)),
      vRadialMps: Number(vRadialMps.toFixed(2)),
    });
  }
  APP_STATE.expectedTrainTracks = {
    SIM_L1: {
      srvId: "SIM",
      lineName: "L1",
      color: "#ef4444",
      samples: simSamples,
    },
  };
  for (const tr of APP_STATE.closestTrainsSnapshot.slice(0, 2)) {
    const key = `${tr.lineName}_${tr.srvId}`;
    const samples = [];
    for (let t = 0; t <= duration; t += 0.25) {
      samples.push({
        tEmit: Number(t.toFixed(2)),
        distM: Math.max(10, tr.distM + tr.vRadialMps * t),
        vRadialMps: tr.vRadialMps,
      });
    }
    APP_STATE.expectedTrainTracks[key] = {
      srvId: tr.srvId,
      lineName: tr.lineName,
      color: tr.color,
      samples,
    };
  }
}

async function downloadBundleZip() {
  if (!APP_STATE.recordedWavBlob || !APP_STATE.spectrogramPngBlob) return;
  const zip = new window.JSZip();
  const ts = (APP_STATE.recordingEndTimeIso || new Date().toISOString())
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);

  const contextObj = buildContextJson();
  zip.file(`metro_doppler_${ts}.wav`, APP_STATE.recordedWavBlob);
  zip.file(`metro_doppler_${ts}.png`, APP_STATE.spectrogramPngBlob);
  zip.file(`context.json`, JSON.stringify(contextObj, null, 2));

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zipBlob);
  a.download = `metro_doppler_bundle_${ts}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function checkPythonBackend() {
  const badge = document.getElementById("badge-backend");
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (r.ok) {
      APP_STATE.pythonBackendAvailable = true;
      badge.textContent = "Python API: Online (scipy)";
      badge.className = "badge badge-ok";
      return;
    }
  } catch (_) {}
  APP_STATE.pythonBackendAvailable = false;
  badge.textContent = "Python API: Offline (fft.js active)";
  badge.className = "badge badge-warn";
}

window.addEventListener("DOMContentLoaded", () => {
  const hiresCanvas = document.getElementById("hires-canvas");
  initSpectrogramInteractions(hiresCanvas);
  initMap();
  checkPythonBackend();

  // Keep Leaflet map and Spectrogram crisp whenever the user drag-resizes either panel
  if (window.ResizeObserver) {
    const mapPanel = document.getElementById("panel-map");
    const specPanel = document.getElementById("panel-spectrogram");
    const ro = new ResizeObserver(() => {
      if (mapInstance) mapInstance.invalidateSize();
      if (SPEC_VIEW.result) renderSpectrogramToCanvas(hiresCanvas);
    });
    if (mapPanel) ro.observe(mapPanel);
    if (specPanel) ro.observe(specPanel);
  }

  document.getElementById("btn-record").addEventListener("click", () => {
    startRecording().catch((err) => {
      console.error("Recording error:", err);
      showDspAlert(`Microphone Capture Error: ${err.message}`);
    });
  });

  document.getElementById("btn-stop").addEventListener("click", () => stopRecordingAndCompute());
  document.getElementById("btn-synth").addEventListener("click", () => simulateMetroPassBy());
  document.getElementById("btn-recompute").addEventListener("click", () => computeHighResSpectrogram());
  document.getElementById("btn-download-bundle").addEventListener("click", () => downloadBundleZip());

  document.getElementById("btn-locate").addEventListener("click", () => {
    const pt = APP_STATE.observationPoint || APP_STATE.latestGpsFix;
    if (pt && mapInstance) {
      mapInstance.setView([pt.lat, pt.lon], 15);
    }
  });

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

  document.getElementById("input-gtfs-file").addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (file) handleCustomGTFSFile(file);
  });

  document.getElementById("input-nperseg").addEventListener("change", (ev) => {
    const nperseg = parseInt(ev.target.value, 10) || 4096;
    document.getElementById("input-overlap").value = Math.floor(nperseg * 0.875);
  });

  const btnPan = document.getElementById("btn-mode-pan");
  const btnMeasure = document.getElementById("btn-mode-measure");
  const wrap = hiresCanvas.parentElement;

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

  document.getElementById("btn-clear-measure").addEventListener("click", () => {
    SPEC_VIEW.measureP1 = null;
    SPEC_VIEW.measureP2 = null;
    updateMeasurementReadout();
    renderSpectrogramToCanvas(hiresCanvas);
  });

  document.getElementById("chk-smooth").addEventListener("change", (ev) => {
    SPEC_VIEW.smooth = ev.target.checked;
    renderSpectrogramToCanvas(hiresCanvas);
  });

  document.getElementById("btn-zoom-in").addEventListener("click", () => zoomSpectrogram(0.75));
  document.getElementById("btn-zoom-out").addEventListener("click", () => zoomSpectrogram(1.33));
  document.getElementById("btn-zoom-reset").addEventListener("click", () => {
    if (!SPEC_VIEW.result) return;
    SPEC_VIEW.tMin = 0;
    SPEC_VIEW.tMax = SPEC_VIEW.result.duration_sec;
    SPEC_VIEW.fMin = 0;
    SPEC_VIEW.fMax = SPEC_VIEW.result.fmax_hz;
    renderSpectrogramToCanvas(hiresCanvas);
  });
});
