"use strict";

/**
 * Global reactive state and visualization constants for Metro Doppler
 */

export const APP_STATE = {
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

export const SPEC_VIEW = {
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
  pad: { left: 68, right: 84, top: 34, bottom: 96 },
};

// Inferno-like colormap LUT (256 x RGB)
export const COLORMAP_LUT = (function buildInfernoLUT() {
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
