// static/js/export.js
import { APP_STATE } from "./state.js";

export function buildContextJson() {
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
      ground_speed_mps: APP_STATE.cGround || 1500,
      latest_gps_fix: APP_STATE.latestGpsFix,
      gps_trajectory_during_recording: APP_STATE.gpsFixes,
      nearest_tmb_station: APP_STATE.nearestStation,
      closest_trains_snapshot: APP_STATE.closestTrainsSnapshot,
      expected_train_tracks: APP_STATE.expectedTrainTracks,
    },
  };
}

export async function downloadBundleZip() {
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
