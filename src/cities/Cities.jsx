import { useEffect, useMemo, useRef, useState } from "react";
import "../App.css";
import "./Cities.css";

const MAX_EPSILON = 500;
const DEFAULT_EPSILON = 150;
// Target pace for edges, counting only "visible" ones (see
// VISIBLE_PIXEL_THRESHOLD) — many of a country's shortest pairs project to
// sub-pixel segments, and pacing on those makes the graph look stalled even
// though it's actually keeping up fine.
const DRAW_OBJECTS_PER_SECOND = (N) => Math.ceil(N/1000) * 200;
const VISIBLE_PIXEL_THRESHOLD = 5;
const POINTS_DRAW_SECONDS = 2;
// Hard ceiling on how many items a single animation frame may draw. Without
// this, a delayed requestAnimationFrame callback (tab backgrounded, a slow
// device, automation throttling — anything that makes one frame's elapsed
// time balloon) makes the loop try to catch up by drawing everything left
// in one synchronous burst, freezing the tab. Capping the per-frame batch
// means a delay just spreads the catch-up over a few more frames instead.
const MAX_ITEMS_PER_FRAME = 2000;
const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 560;
const CANVAS_PADDING = 10;
const POINT_RADIUS_BASE = 3;
const POINT_RADIUS_REFERENCE_N = 50;
const CORRELATION_DIM_MAX_EPS = 50;
// Computing every pairwise distance is O(N^2): fine for a few hundred cities,
// but the real dataset has countries with thousands (France alone has ~9k),
// where a full N^2 pass would freeze the tab for many seconds. Cap the point
// set used for the distances graph / correlation dimension to keep this a
// sub-second synchronous computation; all cities are still drawn as points.
const MAX_PAIR_POINTS = 1500;
const POINT_COLOR = "#5b8dee";
const EDGE_COLOR = "rgba(91, 141, 238, 0.35)";
// Faint, deliberately low-contrast — the border is a location cue, not a focal
// element, so it must stay well behind the points/edges in visual weight.
const BORDER_COLOR = "rgba(122, 130, 160, 0.3)";
// A country's own boundary can include far-flung parts (Kaliningrad-style
// enclaves, Alaska/Hawaii-style overseas regions, empty Arctic islands) that
// mirror exactly the kind of outlier this app already throws away on the
// cities side via trimmedExtent. Reuse that same trimmed view window — grown
// by this fraction on each axis so nearby coastal islands aren't clipped —
// and drop any boundary ring whose centroid falls outside it, so the outline
// only ever covers the region the cities are actually drawn in.
const BORDER_PAD_FRACTION = 0.3;

function guessCountryCode() {
  const lang =
    (typeof navigator !== "undefined" &&
      (navigator.language || (navigator.languages && navigator.languages[0]))) ||
    "";
  const parts = lang.split("-");
  return parts.length > 1 ? parts[1].toUpperCase() : null;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseCoordinates(buffer) {
  const view = new DataView(buffer);
  const points = [];
  for (let offset = 0; offset + 16 <= buffer.byteLength; offset += 16) {
    const lat = view.getFloat64(offset, false);
    const lon = view.getFloat64(offset + 8, false);
    points.push({ lat, lon });
  }
  return points;
}

// Binary layout: int32 ring count, then per ring an int32 point count
// followed by that many (lat, lon) float64 pairs. See BorderRepository on
// the backend.
function parseBorders(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const ringCount = view.getInt32(offset, false);
  offset += 4;
  const rings = [];
  for (let r = 0; r < ringCount; r++) {
    const pointCount = view.getInt32(offset, false);
    offset += 4;
    const ring = new Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      const lat = view.getFloat64(offset, false);
      const lon = view.getFloat64(offset + 8, false);
      offset += 16;
      ring[i] = { lat, lon };
    }
    rings.push(ring);
  }
  return rings;
}

// Countries like Russia straddle the antimeridian: their cities' signed
// longitudes span e.g. -179 to 179, a naive max-min gives a ~358 degree
// span instead of the true ~30. Try shifting negative longitudes by +360
// and keep whichever representation (raw or shifted) yields the smaller
// span — that's the one that doesn't wrap. Also reports whether the shift
// was applied, so the same decision can be replayed for border points that
// weren't part of the input (e.g. reprojecting a boundary ring against a
// transform derived from the country's cities).
function unwrapLongitudes(rawLons) {
  const rawSpan = Math.max(...rawLons) - Math.min(...rawLons);
  const shifted = rawLons.map((lon) => (lon < 0 ? lon + 360 : lon));
  const shiftedSpan = Math.max(...shifted) - Math.min(...shifted);
  return shiftedSpan < rawSpan ? { lons: shifted, wasShifted: true } : { lons: rawLons, wasShifted: false };
}

// y = ln(tan(pi/4 + lat/2)) — standard (unit-radius) Web Mercator northing.
// Clamped short of the poles since it diverges there; no city data gets
// near that range in practice.
function mercatorY(latDeg) {
  const clamped = Math.max(-85, Math.min(85, latDeg));
  return Math.log(Math.tan(Math.PI / 4 + toRad(clamped) / 2));
}

// A handful of countries have one or two cities that are geographically
// enormous outliers relative to the rest (e.g. the UK's "GB" entries
// include the Akrotiri/Dhekelia base in Cyprus, ~3,000 km from Britain).
// A literal min/max bounding box lets one such point dictate the scale and
// squeezes everyone else into a corner. Trim the extreme 1% off each axis
// when fitting the view — for small/well-behaved point sets this is a
// no-op (the trimmed index just lands back on the true min/max).
const OUTLIER_TRIM_FRACTION = 0.03;

function trimmedExtent(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const lo = sorted[Math.floor(n * OUTLIER_TRIM_FRACTION)];
  const hi = sorted[n - 1 - Math.floor(n * OUTLIER_TRIM_FRACTION)];
  return [lo, hi];
}

// The "window": unwrap decision plus trimmed extent, derived once from a
// country's cities. Boundary rings are matched against this (padded, see
// BORDER_PAD_FRACTION) to decide which ones belong to the same region as the
// cities — before any canvas scale/offset exists.
function computeCityWindow(points) {
  const { lons, wasShifted } = unwrapLongitudes(points.map((p) => p.lon));
  const xs = lons.map(toRad);
  const ys = points.map((p) => mercatorY(p.lat));
  const [minX, maxX] = trimmedExtent(xs);
  const [minY, maxY] = trimmedExtent(ys);
  return { minX, maxX, minY, maxY, wasShifted };
}

// Projects a raw (lat, lon) pair into radians/mercator space using a
// window's unwrap decision, without yet applying scale/offset — used both to
// place points on canvas and to compute/fit a border ring's coordinates.
function toPlane(window, lat, lon) {
  const shiftedLon = window.wasShifted && lon < 0 ? lon + 360 : lon;
  return { x: toRad(shiftedLon), y: mercatorY(lat) };
}

function toCanvas(transform, x, y) {
  return {
    x: transform.offsetX + (x - transform.minX) * transform.scale,
    y: transform.offsetY + (transform.maxY - y) * transform.scale,
  };
}

// Keeps only the boundary rings whose centroid falls within the cities'
// (padded) window — see BORDER_PAD_FRACTION — and returns them as unscaled
// plane coordinates, ready to both feed the final fit (computeFinalTransform)
// and be projected onto canvas once that fit is known.
function filterBorderRingsToPlane(rings, cityWindow) {
  const spanX = Math.max(cityWindow.maxX - cityWindow.minX, 1e-6);
  const spanY = Math.max(cityWindow.maxY - cityWindow.minY, 1e-6);
  const padX = spanX * BORDER_PAD_FRACTION;
  const padY = spanY * BORDER_PAD_FRACTION;
  const minXBound = cityWindow.minX - padX;
  const maxXBound = cityWindow.maxX + padX;
  const minYBound = cityWindow.minY - padY;
  const maxYBound = cityWindow.maxY + padY;

  const kept = [];
  for (const ring of rings) {
    if (ring.length === 0) continue;
    let sumX = 0;
    let sumY = 0;
    const plane = ring.map((p) => {
      const { x, y } = toPlane(cityWindow, p.lat, p.lon);
      sumX += x;
      sumY += y;
      return { x, y };
    });
    const centroidX = sumX / plane.length;
    const centroidY = sumY / plane.length;
    if (
      centroidX < minXBound ||
      centroidX > maxXBound ||
      centroidY < minYBound ||
      centroidY > maxYBound
    ) {
      continue;
    }
    kept.push(plane);
  }
  return kept;
}

// A country's boundary almost always extends past its outermost cities, so
// fitting the canvas to the cities alone runs borders off the edge (seen on
// Russia, the US, Mongolia — sparse interiors, cities nowhere near the
// frontier). Fit the scale/offset to the union of the city window and every
// kept border ring instead, so the boundary — not just the cities — lands
// inside the canvas with the usual CANVAS_PADDING margin.
function computeFinalTransform(cityWindow, keptBorderRingsPlane) {
  let minX = cityWindow.minX;
  let maxX = cityWindow.maxX;
  let minY = cityWindow.minY;
  let maxY = cityWindow.maxY;
  for (const ring of keptBorderRingsPlane) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const drawableW = CANVAS_WIDTH - CANVAS_PADDING * 2;
  const drawableH = CANVAS_HEIGHT - CANVAS_PADDING * 2;
  const scale = Math.min(drawableW / spanX, drawableH / spanY);
  const offsetX = CANVAS_PADDING + (drawableW - spanX * scale) / 2;
  const offsetY = CANVAS_PADDING + (drawableH - spanY * scale) / 2;

  return { minX, maxX, minY, maxY, scale, offsetX, offsetY, wasShifted: cityWindow.wasShifted };
}

function projectPoints(points, transform) {
  return points.map((p) => {
    const { x, y } = toPlane(transform, p.lat, p.lon);
    return toCanvas(transform, x, y);
  });
}

function projectBorders(keptBorderRingsPlane, transform) {
  return keptBorderRingsPlane.map((ring) => ring.map((p) => toCanvas(transform, p.x, p.y)));
}

// Evenly-spaced subset of indices [0, n) of size min(n, cap).
function sampleIndices(n, cap) {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const step = n / cap;
  const indices = new Set();
  for (let k = 0; k < cap; k++) {
    indices.add(Math.min(n - 1, Math.floor(k * step)));
  }
  return Array.from(indices);
}

// All pairwise distances among (at most MAX_PAIR_POINTS of) the cities,
// sorted ascending, with the smallest max(100, N/100) of them (excluding
// zero-distance duplicates) flagged — that flagged subset is what the
// correlation dimension estimate is built from.
function computePairs(points) {
  const n = points.length;
  const indices = sampleIndices(n, MAX_PAIR_POINTS);
  const sortedPairs = [];
  let dSum = 0;
  for (let a = 0; a < indices.length; a++) {
    for (let b = a + 1; b < indices.length; b++) {
      const i = indices[a];
      const j = indices[b];
      const distance = haversineKm(points[i], points[j]);
      sortedPairs.push({ i, j, distance });
      dSum += distance;
    }
  }
  sortedPairs.sort((a, b) => a.distance - b.distance);

  const smallPositive = sortedPairs.filter((p) => p.distance > 0 && p.distance < CORRELATION_DIM_MAX_EPS);
  const smallestSet = new Set(smallPositive);
  const avgDistance = dSum/indices.length**2 * 2

  return { sortedPairs, smallestSet, k: smallPositive.length, sampledCount: indices.length, totalCount: n, avgDistance };
}

// Log-log regression of rank vs. distance over the smallest revealed
// distances approximates the correlation dimension (Grassberger-Procaccia).
function estimateCorrelationDimension(ascendingDistances) {
  const n = ascendingDistances.length;
  if (n < 2) return null;

//  const distances = ascendingDistances.filter(d => d < CORRELATION_DIM_MAX_EPS);
  const xs = ascendingDistances.map((d) => Math.log(d));
  const ys = ascendingDistances.map((_, idx) => Math.log(idx + 1));
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (xs[k] - xMean) * (ys[k] - yMean);
    den += (xs[k] - xMean) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

export default function Cities() {
  const apiBase = import.meta.env.VITE_CITIES_API_BASE ?? "";

  const [countries, setCountries] = useState([]);
  const [country, setCountry] = useState("");
  const [epsilon, setEpsilon] = useState(DEFAULT_EPSILON);
  const [points, setPoints] = useState([]);
  const [borders, setBorders] = useState([]);
  const [loadingCountries, setLoadingCountries] = useState(true);
  const [loadingCities, setLoadingCities] = useState(false);
  const [error, setError] = useState(null);
  const [correlationDimension, setCorrelationDimension] = useState(null);

  const pointsCanvasRef = useRef(null);
  const edgesCanvasRef = useRef(null);
  const bordersCanvasRef = useRef(null);

  // A handful of countries (flagged can_hide_border in country_boundaries —
  // currently just Israel) have boundary geometry that makes for a bad-looking
  // fit window, so their canvas scale is derived from city coordinates alone,
  // ignoring the border extent entirely.
  const citiesOnlyScaling = countries.find((c) => c.code === country)?.canHideBorder ?? false;

  const cityWindow = useMemo(
    () => (points.length > 0 ? computeCityWindow(points) : null),
    [points]
  );
  const keptBorderRingsPlane = useMemo(
    () => (cityWindow ? filterBorderRingsToPlane(borders, cityWindow) : []),
    [borders, cityWindow]
  );
  const transform = useMemo(
    () =>
      cityWindow
        ? computeFinalTransform(cityWindow, citiesOnlyScaling ? [] : keptBorderRingsPlane)
        : null,
    [cityWindow, keptBorderRingsPlane, citiesOnlyScaling]
  );
  const projected = useMemo(
    () => (transform ? projectPoints(points, transform) : []),
    [points, transform]
  );
  const projectedBorders = useMemo(
    () => (transform ? projectBorders(keptBorderRingsPlane, transform) : []),
    [keptBorderRingsPlane, transform]
  );
  const pairsInfo = useMemo(() => {
    const res = computePairs(points)
    setEpsilon(points.length ? Math.min(Math.floor(res.avgDistance/3), MAX_EPSILON) : MAX_EPSILON)
    return res;
  }, [points]);


  useEffect(() => {
    let cancelled = false;
    setLoadingCountries(true);
    fetch(`${apiBase}/countries`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setCountries(data);
        const guess = guessCountryCode();
        const match = data.find((c) => c.code === guess) ?? data.find((c) => c.code === "US");
        setCountry((match ?? data[0])?.code ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingCountries(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    setLoadingCities(true);
    setError(null);
    fetch(`${apiBase}/cities?country=${encodeURIComponent(country)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        if (!cancelled) setPoints(parseCoordinates(buffer));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingCities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, country]);

  // Border outline is decorative, so a fetch failure is silently ignored
  // rather than surfaced through the shared `error` state used for cities.
  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    fetch(`${apiBase}/borders?country=${encodeURIComponent(country)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        if (!cancelled) setBorders(parseBorders(buffer));
      })
      .catch(() => {
        if (!cancelled) setBorders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, country]);

  // Draws the faded country outline behind everything else. Small enough to
  // draw synchronously in one pass rather than gradually like the cities/edges.
  useEffect(() => {
    const canvas = bordersCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 1;
    for (const ring of projectedBorders) {
      if (ring.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) {
        ctx.lineTo(ring[i].x, ring[i].y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }, [projectedBorders]);

  // Draws cities only. Depends solely on `points`, so changing epsilon
  // never touches this canvas or re-triggers this animation.
  useEffect(() => {
    const canvas = pointsCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (projected.length === 0) return;

    const radius =
      POINT_RADIUS_BASE * Math.sqrt(POINT_RADIUS_REFERENCE_N / projected.length);
    const rate = projected.length / POINTS_DRAW_SECONDS;

    let drawn = 0;
    let cancelled = false;
    let raf = null;
    const start = performance.now();

    const step = (now) => {
      if (cancelled) return;
      const elapsedSec = (now - start) / 1000;
      const target = Math.min(
        projected.length,
        Math.floor(elapsedSec * rate),
        drawn + MAX_ITEMS_PER_FRAME
      );
      for (; drawn < target; drawn++) {
        const p = projected[drawn];
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = POINT_COLOR;
        ctx.fill();
      }
      if (drawn < projected.length) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [projected]);

  // Draws distances (edges) only, and drives the gradually-updating
  // correlation dimension estimate. Runs on epsilon changes without
  // touching the cities canvas above.
  useEffect(() => {
    const canvas = edgesCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setCorrelationDimension(null);
    if (projected.length === 0) return;

    // sortedPairs is ascending by distance, so filtering preserves order.
    const edgesToShow = pairsInfo.sortedPairs.filter((p) => p.distance <= epsilon);

    let drawn = 0;
    let visibleDrawn = 0;
    let cancelled = false;
    let raf = null;
    const start = performance.now();
    const revealedSmallest = [];

    const step = (now) => {
      if (cancelled) return;
      const elapsedSec = (now - start) / 1000;
      // Pace on visible segments only; sub-threshold ones are drawn as fast
      // as the per-frame cap allows since pacing on them would make the
      // graph look stalled for countries with many near-duplicate cities.
      const visibleTarget = Math.floor(elapsedSec * DRAW_OBJECTS_PER_SECOND(points.length));
      const frameLimit = drawn + MAX_ITEMS_PER_FRAME;
      let gotNewSmallest = false;
      while (
        drawn < edgesToShow.length &&
        drawn < frameLimit &&
        visibleDrawn < visibleTarget
      ) {
        const pair = edgesToShow[drawn];
        const a = projected[pair.i];
        const b = projected[pair.j];
        const pixelLength = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = EDGE_COLOR;
        ctx.lineWidth = 1;
        ctx.stroke();
        if (pixelLength > VISIBLE_PIXEL_THRESHOLD) visibleDrawn++;
        if (pairsInfo.smallestSet.has(pair)) {
          revealedSmallest.push(pair.distance);
          gotNewSmallest = true;
        }
        drawn++;
      }
      if (gotNewSmallest) {
        setCorrelationDimension(estimateCorrelationDimension(revealedSmallest));
      }
      if (drawn < edgesToShow.length) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [projected, pairsInfo, epsilon]);

  return (
    <div className="page">
      <header className="header">
        <span className="header-label">Cities</span>
        <span className="header-sub">Population Centers · Proximity Graph</span>
      </header>

      <main className="main main-cities">
        <div className="cities-controls">
          <div className="control-block">
            <label className="field-label" htmlFor="country-select">
              Country
            </label>
            <select
              id="country-select"
              className="cities-select"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              disabled={loadingCountries || countries.length === 0}
            >
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="control-block">
            <label className="field-label" htmlFor="epsilon-slider">
              Epsilon
              <span className="char-count">{epsilon} km</span>
            </label>
            <input
              id="epsilon-slider"
              className="cities-slider"
              type="range"
              min={0}
              max={MAX_EPSILON}
              value={epsilon}
              onChange={(e) => setEpsilon(Number(e.target.value))}
            />
          </div>
        </div>

        {error && <div className="error-box">⚠ {error}</div>}

        <div className="cities-stats">
          <div className="time-row">
            <span className="time-label">Cities</span>
            <span className="time-value">{points.length.toLocaleString()}</span>
          </div>
          <div className="time-row">
            <span className="time-label">dimension</span>
            <span className="time-value">
              {correlationDimension != null ? correlationDimension.toFixed(3) : "—"}
            </span>
            <span className="info-icon" tabIndex={0}>
              i
              <span className="info-tooltip">
                <span className="info-tooltip-bubble" role="tooltip">
                  Correlation dimension estimates how densely the cities fill
                  the space they occupy: it measures how fast the number of
                  city pairs closer than a given distance grows as that
                  distance grows, giving a fractional "dimension" between a
                  sparse line (≈1) and a fully-filled plane (≈2).{" "}
                  <a
                    href="https://en.wikipedia.org/wiki/Correlation_dimension"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read more on Wikipedia
                  </a>
                </span>
              </span>
            </span>
          </div>
          {/*pairsInfo.sampledCount < pairsInfo.totalCount && (
            <span className="cities-sampled-note">
              distances sampled from {pairsInfo.sampledCount.toLocaleString()} of{" "}
              {pairsInfo.totalCount.toLocaleString()} cities
            </span>
          )*/}
        </div>

        <div className="canvas-panel">
          {(loadingCountries || loadingCities) && (
            <div className="canvas-loading">
              <span className="spinner" />
            </div>
          )}
          <canvas
            ref={bordersCanvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="cities-canvas cities-canvas-borders"
          />
          <canvas
            ref={edgesCanvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="cities-canvas cities-canvas-edges"
          />
          <canvas
            ref={pointsCanvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="cities-canvas cities-canvas-points"
          />
        </div>
      </main>
      <div className="footer-container">
        <footer>
          2026&nbsp;&nbsp;
          <a href="mailto:danila.milanov@gmail.com">Danila Milanov</a>
        </footer>
      </div>
    </div>
  );
}
