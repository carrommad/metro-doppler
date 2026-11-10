// static/js/audio.js
import { APP_STATE, SPEC_VIEW } from "./state.js";
import { setSpectrogramData, renderSpectrogramToCanvas } from "./spectrogram.js";
import { updateClosestTrainsRadar } from "./map.js";
import { renderProximityGraphToCanvas } from "./proximity.js";

export const WORKLET_CODE = `
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

export function encodeWAV(samplesFloat32, sampleRate) {
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
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

export function computeSpectrogramFFTJS(samples, sampleRate, params) {
  if (!sampleRate || sampleRate <= 0) {
    throw new Error("Dynamic sampleRate required for spectrogram calculation");
  }
  const N = samples.length;
  let nperseg = parseInt(params.nperseg, 10) || 4096;
  if (N < nperseg) {
    nperseg = Math.max(64, 1 << Math.floor(Math.log2(Math.max(64, N))));
  }
  if ((nperseg & (nperseg - 1)) !== 0) {
    nperseg = 1 << Math.round(Math.log2(nperseg));
  }
  let noverlap = parseInt(params.noverlap, 10);
  if (isNaN(noverlap) || noverlap >= nperseg || noverlap < 0) {
    noverlap = Math.floor(nperseg * 0.875);
  }
  const step = nperseg - noverlap;
  const nfft = nperseg;

  const win = new Float64Array(nperseg);
  let winSumSq = 0;
  for (let i = 0; i < nperseg; i++) {
    const w = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / nperseg);
    win[i] = w;
    winSumSq += w * w;
  }
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
      nperseg,
      noverlap,
      nfft,
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

let stftWorker = null;
let animFrameId = null;
let latestChunkPeak = 0;

export const LIVE_STFT = {
  columns: [],
  peakFreqs: [],
  plottedBins: 0,
  nperseg: 4096,
  noverlap: 3584,
  step: 512,
  fmax: 4000,
  sampleRate: 48000,
  freqResolutionHz: 0,
  timeStepSec: 0,
  totalFramesCount: 0,
  dirty: false,
};

export function initParallelWorker() {
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
      LIVE_STFT.totalFramesCount = 0;
      LIVE_STFT.peakFreqs = [];
      LIVE_STFT.dirty = false;
    } else if (msg.type === "frames") {
      const { numNewFrames, plottedBins, flatDb, framePeaks } = msg;
      for (let i = 0; i < numNewFrames; i++) {
        LIVE_STFT.columns.push(flatDb.slice(i * plottedBins, (i + 1) * plottedBins));
      }
      LIVE_STFT.totalFramesCount += numNewFrames;
      if (framePeaks) {
        for (const p of framePeaks) {
          if (LIVE_STFT.peakFreqs.length < 500) LIVE_STFT.peakFreqs.push(p);
        }
      }
      LIVE_STFT.dirty = true;
    }
  };
}

export function flushLiveHighResSpectrogram() {
  if (!LIVE_STFT.dirty || LIVE_STFT.columns.length === 0) return;
  LIVE_STFT.dirty = false;

  const rollSec = parseFloat(document.getElementById("select-rolling-window")?.value) || 20.0;
  if (rollSec > 0 && LIVE_STFT.timeStepSec > 0) {
    const maxCols = Math.max(10, Math.ceil(rollSec / LIVE_STFT.timeStepSec));
    if (LIVE_STFT.columns.length > maxCols) {
      LIVE_STFT.columns = LIVE_STFT.columns.slice(LIVE_STFT.columns.length - maxCols);
    }
  }

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
    tOffset: Math.max(0, Number(((LIVE_STFT.totalFramesCount - numFrames) * LIVE_STFT.timeStepSec).toFixed(4))),
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

  const tagEl = document.getElementById("hires-engine-tag");
  const metaEl = document.getElementById("hires-spec-meta");
  if (tagEl) tagEl.textContent = `Parallel Worker • Hann ${LIVE_STFT.nperseg}/${LIVE_STFT.noverlap}`;
  if (metaEl) {
    metaEl.textContent =
      `LIVE: fs=${liveRes.sample_rate_hz} Hz | Δf=${liveRes.freq_resolution_hz} Hz | Δt=${(liveRes.time_step_sec * 1000).toFixed(2)} ms | ` +
      `Frames: ${numFrames}×${numBins}`;
  }
}

export function showDspAlert(msg) {
  const banner = document.getElementById("dsp-alert");
  if (!banner) return;
  if (!msg) {
    banner.classList.add("hidden");
    banner.textContent = "";
  } else {
    banner.textContent = msg;
    banner.classList.remove("hidden");
  }
}

export async function startRecording() {
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
    if (badgeDsp) {
      badgeDsp.textContent = "DSP: BLOCKED (Active!)";
      badgeDsp.className = "badge badge-err";
    }
    const errMsg = `ABORTED: Browser refused to disable DSP (noiseSuppression=${settings.noiseSuppression}, echoCancellation=${settings.echoCancellation}, autoGainControl=${settings.autoGainControl}).`;
    showDspAlert(errMsg);
    throw new Error(errMsg);
  }

  APP_STATE.dspVerifiedOff = true;
  if (badgeDsp) {
    badgeDsp.textContent = "DSP: OFF (Verified)";
    badgeDsp.className = "badge badge-ok";
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  await audioCtx.resume();

  const actualSampleRate = audioCtx.sampleRate;
  if (!actualSampleRate || actualSampleRate <= 0) {
    throw new Error("Unable to determine dynamic AudioContext sampleRate");
  }
  APP_STATE.sampleRate = actualSampleRate;
  APP_STATE.audioCtx = audioCtx;

  if (badgeSr) {
    badgeSr.textContent = `Sample Rate: ${actualSampleRate} Hz`;
    badgeSr.className = "badge badge-ok";
  }

  if (dspTelemetry) {
    dspTelemetry.innerHTML =
      `<span><strong>DSP Verified OFF:</strong> noiseSuppression=<code>${String(settings.noiseSuppression ?? false)}</code> | ` +
      `echoCancellation=<code>${String(settings.echoCancellation ?? false)}</code> | ` +
      `autoGainControl=<code>${String(settings.autoGainControl ?? false)}</code> | ` +
      `Hardware AudioContext fs=<code>${actualSampleRate} Hz</code> (drag bottom-right corner to resize box)</span>`;
  }

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
    const fillEl = document.getElementById("level-fill");
    const dbEl = document.getElementById("level-db");
    if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;
    if (dbEl) dbEl.textContent = db <= -99 ? "-∞ dBFS" : `${db.toFixed(1)} dBFS`;

    const elapsedSec = (performance.now() - APP_STATE.recordingStartPerf) / 1000;
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const secs = (elapsedSec % 60).toFixed(1).padStart(4, "0");
    const timerEl = document.getElementById("rec-timer");
    const samplesEl = document.getElementById("rec-samples");
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;

    const totalSamples = APP_STATE.recordedChunks.reduce((acc, c) => acc + c.length, 0);
    if (samplesEl) samplesEl.textContent = `(${totalSamples.toLocaleString()} samples)`;

    animFrameId = requestAnimationFrame(renderLoop);
  };
  animFrameId = requestAnimationFrame(renderLoop);
}

export async function stopRecordingAndCompute() {
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

export async function finalizeAudioAndComputeHighRes() {
  const samples = APP_STATE.recordedSamples;
  const fs = APP_STATE.sampleRate;
  if (!samples || samples.length === 0 || !fs) {
    document.getElementById("rec-state-label").textContent = "EMPTY";
    return;
  }

  const wavBlob = encodeWAV(samples, fs);
  APP_STATE.recordedWavBlob = wavBlob;

  const audioEl = document.getElementById("audio-preview");
  if (audioEl) {
    audioEl.src = URL.createObjectURL(wavBlob);
    audioEl.classList.remove("hidden");
  }

  await computeHighResSpectrogram();
  document.getElementById("rec-state-label").textContent = "READY";
  document.getElementById("btn-recompute").disabled = false;
  document.getElementById("btn-download-bundle").disabled = false;
}

export async function computeHighResSpectrogram() {
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
      if (hiresImg) hiresImg.classList.add("hidden");
      hiresCanvas.classList.remove("hidden");
      setSpectrogramData(hiresCanvas, data);

      if (tagEl) tagEl.textContent = `scipy.signal • Hann ${data.parameters.nperseg}/${data.parameters.noverlap}`;
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

  if (hiresImg) hiresImg.classList.add("hidden");
  hiresCanvas.classList.remove("hidden");
  setSpectrogramData(hiresCanvas, res);

  const pngBlob = await new Promise((resolve) => hiresCanvas.toBlob(resolve, "image/png"));
  APP_STATE.spectrogramPngBlob = pngBlob;

  if (tagEl) tagEl.textContent = `fft.js • Hann ${res.parameters.nperseg}/${res.parameters.noverlap}`;
  metaEl.textContent =
    `fs=${res.sample_rate_hz} Hz | Δf=${res.freq_resolution_hz} Hz | Δt=${(res.time_step_sec * 1000).toFixed(2)} ms | ` +
    `Grid: ${res.time_bins}×${res.freq_bins}`;
}

export function refreshStaticExpectedTracksFromPoint(durationOverride = null) {
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
}

export async function simulateMetroPassBy() {
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

  const badgeDsp = document.getElementById("badge-dsp");
  const badgeSr = document.getElementById("badge-sr");
  const dspTelemetry = document.getElementById("dsp-telemetry");

  if (badgeDsp) {
    badgeDsp.textContent = "DSP: OFF (Simulated Raw)";
    badgeDsp.className = "badge badge-ok";
  }
  if (badgeSr) {
    badgeSr.textContent = `Sample Rate: ${fs} Hz`;
    badgeSr.className = "badge badge-ok";
  }
  if (dspTelemetry) {
    dspTelemetry.innerHTML =
      `<span><strong>Simulated Metro Pass-By:</strong> Hardware AudioContext fs=<code>${fs} Hz</code> | ` +
      `v=<code>18 m/s (64.8 km/h)</code> | d_min=<code>4.5 m</code> | Harmonics: <code>220, 440, 880, 1320, 1760 Hz</code> (drag bottom-right corner to resize)</span>`;
  }

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
  const timerEl = document.getElementById("rec-timer");
  const samplesEl = document.getElementById("rec-samples");
  if (timerEl) timerEl.textContent = `00:0${duration.toFixed(1)}`;
  if (samplesEl) samplesEl.textContent = `(${N.toLocaleString()} samples)`;

  refreshStaticExpectedTracksFromPoint(duration);
  await finalizeAudioAndComputeHighRes();
}
