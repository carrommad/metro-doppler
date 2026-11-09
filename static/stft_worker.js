"use strict";
importScripts("vendor/fft.js");

let sampleRate = 48000;
let nperseg = 4096;
let noverlap = 3584;
let step = 512;
let fmax = 4000;
let nyquist = 24000;
let plottedBins = 512;
let numFreqBins = 2049;
let win = null;
let scale = 1.0;
let fft = null;
let inputBlock = null;
let complexOut = null;

// Rolling sample buffer for streaming STFT
let sampleBuf = new Float32Array(0);
let nextFrameStart = 0;

function initConfig(cfg) {
  sampleRate = cfg.sampleRate || 48000;
  nperseg = parseInt(cfg.nperseg, 10) || 4096;
  if ((nperseg & (nperseg - 1)) !== 0) {
    nperseg = 1 << Math.round(Math.log2(nperseg));
  }
  noverlap = parseInt(cfg.noverlap, 10);
  if (isNaN(noverlap) || noverlap >= nperseg || noverlap < 0) {
    noverlap = Math.floor(nperseg * 0.875);
  }
  step = Math.max(64, nperseg - noverlap);
  nyquist = sampleRate / 2.0;
  fmax = Math.min(nyquist, parseFloat(cfg.fmax) || 4000);
  numFreqBins = (nperseg >> 1) + 1;
  const maxBin = Math.min(numFreqBins - 1, Math.ceil((fmax / nyquist) * (numFreqBins - 1)));
  plottedBins = maxBin + 1;

  win = new Float64Array(nperseg);
  let winSumSq = 0;
  for (let i = 0; i < nperseg; i++) {
    const w = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / nperseg);
    win[i] = w;
    winSumSq += w * w;
  }
  scale = 1.0 / (sampleRate * winSumSq);

  fft = new self.FFT(nperseg);
  inputBlock = new Float64Array(nperseg);
  complexOut = fft.createComplexArray();

  sampleBuf = new Float32Array(0);
  nextFrameStart = 0;

  self.postMessage({
    type: "init_ack",
    sampleRate,
    nperseg,
    noverlap,
    step,
    fmax,
    plottedBins,
    freqResolutionHz: Number((sampleRate / nperseg).toFixed(4)),
    timeStepSec: Number((step / sampleRate).toFixed(6)),
  });
}

function appendSamplesAndCompute(newChunk) {
  const oldLen = sampleBuf.length;
  const combined = new Float32Array(oldLen + newChunk.length);
  combined.set(sampleBuf, 0);
  combined.set(newChunk, oldLen);
  sampleBuf = combined;

  const framesDb = [];
  const frameTimes = [];
  const framePeaks = [];

  while (nextFrameStart + nperseg <= sampleBuf.length) {
    let mean = 0.0;
    for (let i = 0; i < nperseg; i++) {
      mean += sampleBuf[nextFrameStart + i];
    }
    mean /= nperseg;

    for (let i = 0; i < nperseg; i++) {
      inputBlock[i] = (sampleBuf[nextFrameStart + i] - mean) * win[i];
    }

    fft.realTransform(complexOut, inputBlock);

    const colDb = new Float32Array(plottedBins);
    let maxPsd = -1;
    let maxBinIdx = 0;

    for (let b = 0; b < plottedBins; b++) {
      const re = complexOut[2 * b];
      const im = complexOut[2 * b + 1];
      let psd = (re * re + im * im) * scale;
      if (b > 0 && b < numFreqBins - 1) psd *= 2.0;
      if (psd > maxPsd) {
        maxPsd = psd;
        maxBinIdx = b;
      }
      colDb[b] = 10.0 * Math.log10(Math.max(psd, 1e-20));
    }

    framesDb.push(colDb);
    frameTimes.push((nextFrameStart + nperseg / 2.0) / sampleRate);
    framePeaks.push(Number(((maxBinIdx * sampleRate) / nperseg).toFixed(2)));
    nextFrameStart += step;
  }

  // Trim consumed prefix from sampleBuf to keep memory footprint tiny
  if (nextFrameStart > 0) {
    sampleBuf = sampleBuf.slice(nextFrameStart);
    nextFrameStart = 0;
  }

  if (framesDb.length > 0) {
    const flat = new Float32Array(framesDb.length * plottedBins);
    for (let i = 0; i < framesDb.length; i++) {
      flat.set(framesDb[i], i * plottedBins);
    }
    self.postMessage(
      {
        type: "frames",
        numNewFrames: framesDb.length,
        plottedBins,
        flatDb: flat,
        framePeaks,
      },
      [flat.buffer]
    );
  }
}

self.onmessage = function (ev) {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "init") {
    initConfig(msg);
  } else if (msg.type === "chunk" && msg.samples) {
    appendSamplesAndCompute(msg.samples);
  }
};

