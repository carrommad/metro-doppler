// static/js/map.js
import { APP_STATE, SPEC_VIEW } from "./state.js";
import { renderSpectrogramToCanvas } from "./spectrogram.js";
import { renderProximityGraphToCanvas } from "./proximity.js";

let mapInstance = null;
let gtfsLayerGroup = null;
let radarLayerGroup = null;
let obsMarker = null;
let userMarker = null;
let userAccuracyCircle = null;
let userTrackLine = null;
let trainLayerGroup = null;
let trainFleet = [];
let trainAnimId = null;
let lastRadarUpdatePerf = 0;

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Inverse-distance-weighted BCN Orography & Metro Tunnel Depth model (ICGC DEM + TMB station depths)
export function estimateBcnOrographyAndDepth(lat, lon, lineName = null) {
  const DEFAULT_LINE_DEPTH = {
    L1: 13, L2: 18, L3: 22, L4: 15, L5: 28, L9N: 48, L9S: 44, L10N: 45, L10S: 42, L11: 32,
  };
  let sumW = 0, sumElev = 0, sumDepth = 0;
  for (const feat of APP_STATE.gtfsFeatures) {
    if (feat.geometry && feat.geometry.type === "Point" && feat.properties) {
      const p = feat.properties;
      if (p.surface_elev_m === undefined) continue;
      if (lineName && Array.isArray(p.lines) && !p.lines.includes(lineName)) continue;
      const [sLon, sLat] = feat.geometry.coordinates;
      const d = Math.max(25.0, haversineMeters(lat, lon, sLat, sLon));
      const w = 1.0 / (d * d);
      sumW += w;
      sumElev += w * p.surface_elev_m;
      sumDepth += w * (p.depth_m || 18);
    }
  }
  const surfaceElevM = sumW > 0 ? sumElev / sumW : 25.0;
  const tunnelDepthM = sumW > 0 ? sumDepth / sumW : (DEFAULT_LINE_DEPTH[lineName] || 18.0);
  return {
    surfaceElevM: Number(surfaceElevM.toFixed(1)),
    tunnelDepthM: Number(tunnelDepthM.toFixed(1)),
    railElevM: Number((surfaceElevM - tunnelDepthM).toFixed(1)),
  };
}

export function setObservationPoint(lat, lon, source = "map-click") {
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
  if (!APP_STATE.isRecording) {
    if (SPEC_VIEW.result) {
      renderSpectrogramToCanvas(document.getElementById("hires-canvas"));
    } else {
      renderProximityGraphToCanvas();
    }
  }
}

export function updateNearestStation(lat, lon) {
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
          surface_elev_m: feat.properties.surface_elev_m ?? 25,
          depth_m: feat.properties.depth_m ?? 18,
          distance_m: Math.round(d),
          coordinates: [sLon, sLat],
        };
      }
    }
  }
  APP_STATE.nearestStation = best;
  const stEl = document.getElementById("nearest-station");
  const lnEl = document.getElementById("nearest-lines");
  const coordsEl = document.getElementById("gps-coords");
  const obsOro = estimateBcnOrographyAndDepth(lat, lon, null);
  if (coordsEl) {
    coordsEl.textContent =
      `${lat.toFixed(5)}, ${lon.toFixed(5)} (Z_surf≈${obsOro.surfaceElevM}m ASL)`;
  }
  if (best) {
    stEl.textContent = `${best.stop_name} (${best.distance_m}m horiz, depth≈${best.depth_m}m)`;
    lnEl.textContent = Array.isArray(best.lines) ? best.lines.join(", ") : String(best.lines);
  } else {
    stEl.textContent = "—";
    lnEl.textContent = "—";
  }
}

export function updateClosestTrainsRadar(now) {
  if (now - lastRadarUpdatePerf < 140) return;
  lastRadarUpdatePerf = now;

  const obs = APP_STATE.observationPoint;
  if (!obs || trainFleet.length === 0) return;

  const cGround = Math.max(200, parseFloat(document.getElementById("input-c-ground")?.value) || 1500);
  const f0Base = Math.max(40, parseFloat(document.getElementById("input-f0-train")?.value) || 440);
  const cosLat = Math.cos((obs.lat * Math.PI) / 180.0);
  const obsOro = estimateBcnOrographyAndDepth(obs.lat, obs.lon, null);
  obs.surface_elev_m = obsOro.surfaceElevM;

  const ranked = [];
  for (const tr of trainFleet) {
    if (tr.lat === undefined || tr.lon === undefined) continue;
    const horizDistM = haversineMeters(obs.lat, obs.lon, tr.lat, tr.lon);
    const trOro = estimateBcnOrographyAndDepth(tr.lat, tr.lon, tr.lineName);
    const dzM = obsOro.surfaceElevM - trOro.railElevM;
    const distM = Math.hypot(horizDistM, dzM);

    // Compute unit tangent along track and 3D radial velocity
    const idx = tr.segIdx || 0;
    const dxTrack = (tr.coords[idx + 1][0] - tr.coords[idx][0]) * cosLat * 111320 * tr.dir;
    const dyTrack = (tr.coords[idx + 1][1] - tr.coords[idx][1]) * 110540 * tr.dir;
    const trackNorm = Math.max(1e-6, Math.hypot(dxTrack, dyTrack));
    const vx = (dxTrack / trackNorm) * tr.speedMps;
    const vy = (dyTrack / trackNorm) * tr.speedMps;

    const rx = (tr.lon - obs.lon) * cosLat * 111320;
    const ry = (tr.lat - obs.lat) * 110540;
    const rNorm3D = Math.max(1.0, distM);
    const vRadialMps = (vx * rx + vy * ry) / rNorm3D;
    const groundDelaySec = distM / cGround;
    const fExpectedHz = f0Base / (1.0 + vRadialMps / cGround);

    ranked.push({
      srvId: tr.srvId,
      lineName: tr.lineName,
      color: tr.color,
      lat: tr.lat,
      lon: tr.lon,
      horizDistM,
      tunnelDepthM: trOro.tunnelDepthM,
      railElevM: trOro.railElevM,
      distM,
      vRadialMps,
      groundDelaySec,
      fExpectedHz,
    });
  }

  ranked.sort((a, b) => a.distM - b.distM);
  const closest = ranked.slice(0, 4);
  APP_STATE.closestTrainsSnapshot = closest;

  // Draw dashed ground-propagation rays from observation point to closest trains
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
          `3D:${Math.round(c.distM)}m (depth:${Math.round(c.tunnelDepthM)}m, Δτ=${(c.groundDelaySec * 1000).toFixed(0)}ms, f≈${c.fExpectedHz.toFixed(0)}Hz)`
      )
      .join(" · ");
  }

  // Log kinematics during recording for proximity curves
  if (APP_STATE.isRecording) {
    const tEmit = (performance.now() - APP_STATE.recordingStartPerf) / 1000.0;
    const rollSec = parseFloat(document.getElementById("select-rolling-window")?.value) || 20.0;
    for (const c of closest.slice(0, 4)) {
      const key = `${c.lineName}_${c.srvId}`;
      if (!APP_STATE.expectedTrainTracks[key]) {
        APP_STATE.expectedTrainTracks[key] = {
          srvId: c.srvId,
          lineName: c.lineName,
          color: c.color,
          samples: [],
        };
      }
      const tr = APP_STATE.expectedTrainTracks[key];
      tr.samples.push({
        tEmit,
        distM: c.distM,
        vRadialMps: c.vRadialMps,
      });
      if (rollSec > 0 && tr.samples.length > 2) {
        const cutoff = tEmit - (rollSec + 4.0);
        while (tr.samples.length > 2 && tr.samples[0].tEmit < cutoff) {
          tr.samples.shift();
        }
      }
    }
    if (SPEC_VIEW.result) {
      renderSpectrogramToCanvas(document.getElementById("hires-canvas"));
    } else {
      renderSpectrogramToCanvas(document.getElementById("hires-canvas"));
      renderProximityGraphToCanvas();
    }
  } else if (!SPEC_VIEW.result) {
    renderSpectrogramToCanvas(document.getElementById("hires-canvas"));
    renderProximityGraphToCanvas();
  }
}

export function initMetroTrainFleet(features) {
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
    const coords = r.geometry.coordinates;
    if (!coords || coords.length < 2) continue;
    const p = r.properties || {};
    const lineName = p.route_short_name || p.route_id || "M";
    const color = p.route_color || "#3b82f6";

    const segDists = [0];
    let totalLen = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      totalLen += d;
      segDists.push(totalLen);
    }
    if (totalLen < 200) continue;

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

  syncLiveIMetroTrains();
  if (!window._imetroInterval) {
    window._imetroInterval = setInterval(syncLiveIMetroTrains, 15000);
  }
}

export async function syncLiveIMetroTrains() {
  try {
    const r = await fetch("/api/imetro", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (data.status !== "ok" || !Array.isArray(data.trains) || data.trains.length === 0) return;

    const metaEl = document.getElementById("map-meta");
    if (metaEl) {
      metaEl.textContent = `TMB i-Metro LIVE (${data.trains.length} active trains synced via API) • Drag corner to resize`;
    }

    const stopMap = {};
    for (const f of APP_STATE.gtfsFeatures) {
      if (f.geometry && f.geometry.type === "Point" && f.properties && f.properties.stop_id) {
        stopMap[String(f.properties.stop_id)] = f.geometry.coordinates;
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

export function renderGTFSGeoJSON(geojson) {
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
        const zInfo =
          p.surface_elev_m !== undefined
            ? `<br/>Orography Z_surf: <b>${p.surface_elev_m} m ASL</b> | Tunnel Depth: <b>-${p.depth_m} m</b>`
            : "";
        layer.bindPopup(
          `<strong>Station: ${p.stop_name}</strong><br/>Stop ID: ${p.stop_id || "—"}<br/>Lines: ${lines}${zInfo}`
        );
      }
    },
  }).addTo(gtfsLayerGroup);

  if (APP_STATE.latestGpsFix) {
    updateNearestStation(APP_STATE.latestGpsFix.lat, APP_STATE.latestGpsFix.lon);
  }
  initMetroTrainFleet(APP_STATE.gtfsFeatures);
}

export function initGeolocation() {
  const badgeGps = document.getElementById("badge-gps");
  const coordsEl = document.getElementById("gps-coords");
  if (!("geolocation" in navigator)) {
    if (badgeGps) {
      badgeGps.textContent = "GPS: Unsupported";
      badgeGps.className = "badge badge-err";
    }
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

      if (badgeGps) {
        badgeGps.textContent = `GPS: ±${fix.accuracy_m}m`;
        badgeGps.className = "badge badge-ok";
      }
      if (coordsEl) coordsEl.textContent = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;

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
    },
    (err) => {
      if (badgeGps) {
        badgeGps.textContent = `GPS: ${err.message || "Unavailable"}`;
        badgeGps.className = "badge badge-warn";
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

export async function handleCustomGTFSFile(file) {
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

export function initMap() {
  if (!window.L || !document.getElementById("map")) return;
  mapInstance = window.L.map("map", {
    center: [41.395, 2.172],
    zoom: 12,
  });

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
