// static/js/proximity.js
import { APP_STATE, SPEC_VIEW } from "./state.js";

/**
 * Returns up to 4 tracks with real logged samples, sorted by ground-delayed arrival time
 */
export function getProximityTracks(cGround) {
  let tracks = Object.values(APP_STATE.expectedTrainTracks || {})
    .filter((t) => t && t.samples && t.samples.length >= 2)
    .map((t) => {
      const pts = t.samples
        .map((s) => ({ t: s.tEmit + s.distM / cGround, d: s.distM, delay: s.distM / cGround }))
        .sort((a, b) => a.t - b.t);
      let cpa = pts[0];
      for (const p of pts) if (p.d < cpa.d) cpa = p;
      return { ...t, pts, cpa };
    })
    .sort((a, b) => a.cpa.d - b.cpa.d);

  // If no recorded tracks exist yet (e.g. initial view before recording), preview the closest live map trains
  if (tracks.length === 0 && APP_STATE.closestTrainsSnapshot && APP_STATE.closestTrainsSnapshot.length > 0) {
    const dur = SPEC_VIEW.result ? SPEC_VIEW.result.duration_sec : 6.0;
    return APP_STATE.closestTrainsSnapshot.slice(0, 4).map((c, i) => {
      const tPeak = dur * (0.2 + i * 0.2);
      const pts = [];
      for (let t = 0; t <= dur; t += 0.2) {
        const d = Math.hypot(17.5 * (t - tPeak), c.distM);
        pts.push({ t, d, delay: d / cGround });
      }
      let cpa = pts[0];
      for (const p of pts) if (p.d < cpa.d) cpa = p;
      return {
        srvId: c.srvId,
        lineName: c.lineName,
        color: c.color,
        pts,
        cpa,
      };
    });
  }

  return tracks.slice(0, 4);
}

/**
 * Draws up to 4 Metro Line Proximity Bars directly BELOW the spectrogram (shared time axis).
 * Uses only real logged samples (or the simulation's own SIM track). Brightness/thickness
 * scale with real 3D distance (auto-fit across all shown trains); ◆ marks each train's closest point.
 */
export function drawExpectedMetroOverlay(ctx, padLeft, padTop, plotW, plotH) {
  if (!APP_STATE.showExpectedOverlay) return;
  const cGround = Math.max(200, parseFloat(document.getElementById("input-c-ground")?.value) || 1500);
  const tracks = getProximityTracks(cGround);
  if (tracks.length === 0) return;

  const { tMin, tMax } = SPEC_VIEW;
  const toX = (t) => padLeft + ((t - tMin) / Math.max(1e-6, tMax - tMin)) * plotW;
  let dLo = Infinity, dHi = 0;
  for (const tr of tracks) for (const p of tr.pts) { dLo = Math.min(dLo, p.d); dHi = Math.max(dHi, p.d); }
  const dSpan = Math.max(1, dHi - dLo);

  const laneH = 14;
  const stripTop = padTop + plotH + 6;
  ctx.save();
  tracks.forEach((tr, idx) => {
    const laneY = stripTop + idx * laneH + laneH / 2;
    const color = tr.color || "#38bdf8";
    ctx.font = "700 10px monospace";
    ctx.fillStyle = color;
    ctx.textAlign = "right";
    ctx.fillText(`${tr.lineName}#${tr.srvId}`, padLeft - 6, laneY + 3.5);
    ctx.fillStyle = "rgba(30, 41, 59, 0.6)";
    ctx.fillRect(padLeft, laneY - 4.5, plotW, 9);

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, laneY - 7, plotW, 14);
    ctx.clip();
    ctx.fillStyle = color;
    for (let i = 0; i < tr.pts.length - 1; i++) {
      const a = tr.pts[i], b = tr.pts[i + 1];
      const prox = 1 - ((a.d + b.d) / 2 - dLo) / dSpan; // 1 = closest of all shown
      const h = 2 + 7 * prox;
      ctx.globalAlpha = 0.25 + 0.75 * prox;
      ctx.fillRect(toX(a.t), laneY - h / 2, Math.max(1.5, toX(b.t) - toX(a.t) + 0.5), h);
    }
    ctx.globalAlpha = 1;
    const cx = toX(tr.cpa.t);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, laneY - 4.5); ctx.lineTo(cx + 4.5, laneY); ctx.lineTo(cx, laneY + 4.5); ctx.lineTo(cx - 4.5, laneY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
}

/**
 * Renders the 3D Distance graph in #proximity-canvas (middle box).
 * Y = real 3D distance to target in metres, auto-fit, closest at TOP. X = ground-delayed arrival time.
 * One thin line per train (real logged samples only), ◆ at each train's closest point, legend top-right.
 */
export function renderProximityGraphToCanvas() {
  const canvas = document.getElementById("proximity-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, W, H);

  const padLeft = 68, padRight = 84, padTop = 30, padBottom = 34;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;
  const cGround = Math.max(200, parseFloat(document.getElementById("input-c-ground")?.value) || 1500);
  const tMin = SPEC_VIEW.result ? SPEC_VIEW.tMin : 0;
  const tMax = SPEC_VIEW.result ? SPEC_VIEW.tMax : 6;
  const toX = (t) => padLeft + ((t - tMin) / Math.max(1e-6, tMax - tMin)) * plotW;

  ctx.fillStyle = "#070b12";
  ctx.fillRect(padLeft, padTop, plotW, plotH);
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  ctx.strokeRect(padLeft, padTop, plotW, plotH);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "600 12px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`3D distance to target vs. arrival time (c_ground = ${cGround} m/s)`, padLeft, 19);

  // X axis
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i++) {
    const tv = tMin + (i / 6) * (tMax - tMin);
    ctx.fillText(`${tv.toFixed(tMax - tMin < 2 ? 3 : 1)}s`, padLeft + (i / 6) * plotW, padTop + plotH + 15);
  }
  ctx.fillText("Arrival time t_emit + D/c_ground (s)", padLeft + plotW / 2, H - 4);

  const tracks = getProximityTracks(cGround);
  if (tracks.length === 0) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px Inter, sans-serif";
    ctx.fillText("No train data yet — start a recording (or Simulate Pass-By)", padLeft + plotW / 2, padTop + plotH / 2);
    return;
  }

  // Auto-fit Y range (metres), closest at top, with 8% margin
  // Compute continuous lower-envelope
  const allPoints = [];
  for (const tr of tracks) {
    for (const p of tr.pts) {
      allPoints.push({ t: p.t, d: p.d, tr });
    }
  }
  allPoints.sort((a, b) => a.t - b.t);

  const minEnvelope = [];
  if (allPoints.length > 0) {
    for (let i = 0; i < allPoints.length; i++) {
      const curT = allPoints[i].t;
      let minD = allPoints[i].d;
      let minTr = allPoints[i].tr;
      for (const tr of tracks) {
        if (!tr.pts || tr.pts.length === 0) continue;
        if (tr.pts.length === 1) {
          if (tr.pts[0].d < minD) { minD = tr.pts[0].d; minTr = tr; }
        } else {
          if (curT >= tr.pts[0].t && curT <= tr.pts[tr.pts.length - 1].t) {
            for (let j = 0; j < tr.pts.length - 1; j++) {
              const pA = tr.pts[j];
              const pB = tr.pts[j + 1];
              if (curT >= pA.t && curT <= pB.t) {
                const dt = pB.t - pA.t;
                const frac = dt > 1e-4 ? (curT - pA.t) / dt : 0;
                const distAtT = pA.d + frac * (pB.d - pA.d);
                if (distAtT < minD) {
                  minD = distAtT;
                  minTr = tr;
                }
                break;
              }
            }
          } else {
            const nearestPt = curT < tr.pts[0].t ? tr.pts[0] : tr.pts[tr.pts.length - 1];
            if (nearestPt.d < minD) {
              minD = nearestPt.d;
              minTr = tr;
            }
          }
        }
      }
      minEnvelope.push({ t: curT, d: minD, tr: minTr });
    }
  }

  let dLo = Infinity, dHi = 0;
  for (const p of minEnvelope) {
    dLo = Math.min(dLo, p.d);
    dHi = Math.max(dHi, p.d);
  }
  const m = Math.max(10, (dHi - dLo) * 0.1);
  dLo = Math.max(0, dLo - m);
  dHi = dHi + m;
  const toY = (d) => padTop + ((d - dLo) / Math.max(1e-6, dHi - dLo)) * plotH;

  // Y grid + labels
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const d = dLo + (i / 4) * (dHi - dLo);
    const y = toY(d);
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(`${Math.round(d)} m`, padLeft - 8, y + 4);
    ctx.strokeStyle = "rgba(71, 85, 105, 0.25)";
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(padLeft, padTop, plotW, plotH);
  ctx.clip();

  // Draw the single continuous minimum distance line across all metros
  if (minEnvelope.length >= 2) {
    ctx.shadowColor = "rgba(56, 189, 248, 0.4)";
    ctx.shadowBlur = 8;
    ctx.lineWidth = 3.2;

    for (let i = 0; i < minEnvelope.length - 1; i++) {
      const p0 = minEnvelope[i];
      const p1 = minEnvelope[i + 1];
      ctx.strokeStyle = p0.tr && p0.tr.color ? p0.tr.color : "#38bdf8";
      ctx.beginPath();
      ctx.moveTo(toX(p0.t), toY(p0.d));
      ctx.lineTo(toX(p1.t), toY(p1.d));
      ctx.stroke();
    }
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }

  let globalMinPt = minEnvelope[0];
  for (const p of minEnvelope) {
    if (p.d < globalMinPt.d) globalMinPt = p;
  }

  const drawnPoints = [];
  for (const tr of tracks) {
    const cx = toX(tr.cpa.t);
    const cy = toY(tr.cpa.d);
    const color = tr.color || "#38bdf8";
    drawnPoints.push({ cx, cy, color, tr });
  }
  if (drawnPoints.length === 0 && globalMinPt) {
    drawnPoints.push({
      cx: toX(globalMinPt.t),
      cy: toY(globalMinPt.d),
      color: globalMinPt.tr.color || "#38bdf8",
      tr: globalMinPt.tr
    });
  }

  for (const pt of drawnPoints) {
    ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pt.cx, padTop);
    ctx.lineTo(pt.cx, padTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.cx, pt.cy, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(pt.cx, pt.cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = "bold 11px monospace";
    ctx.fillStyle = pt.color;
    ctx.textAlign = "left";
    const lbl = `${pt.tr.lineName} (${Math.round(pt.tr.cpa.d)}m)`;
    ctx.fillText(lbl, pt.cx + 12, pt.cy + 4);
  }
  ctx.restore();

  // Legend (top-right, inside plot)
  ctx.font = "600 11px monospace";
  const rows = tracks.map((tr) => {
    const snap = APP_STATE.closestTrainsSnapshot.find((c) => c.srvId === tr.srvId && c.lineName === tr.lineName);
    const liveDist = snap ? Math.round(snap.distM) : Math.round(tr.pts[tr.pts.length - 1].d);
    const liveDelay = snap ? Math.round(snap.groundDelaySec * 1000) : Math.round(tr.cpa.delay * 1000);
    return {
      text: `${tr.lineName}#${tr.srvId} · live ${liveDist}m (min ${Math.round(tr.cpa.d)}m) · Δτ ${liveDelay}ms`,
      color: tr.color || "#38bdf8",
    };
  });

  const lw = Math.max(...rows.map((r) => ctx.measureText(r.text).width)) + 32;
  const lx = padLeft + plotW - lw - 8, ly = padTop + 8;
  const boxHeight = rows.length * 18 + 8;

  ctx.fillStyle = "rgba(9, 13, 22, 0.92)";
  ctx.fillRect(lx, ly, lw, boxHeight);
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  ctx.strokeRect(lx, ly, lw, boxHeight);

  ctx.textAlign = "left";
  rows.forEach((r, i) => {
    const itemY = ly + 14 + i * 18;
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(lx + 12, itemY - 3.5, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f1f5f9";
    ctx.fillText(r.text, lx + 24, itemY);
  });
}
