/* global mapboxgl */

const DATA_FILES = {
  all: 'data/All_Street.geojson',
  each: 'data/Each_Street.geojson',
  accessibility: 'data/Accessibility_Network.geojson'
};

const COLORS = {
  ink: '#2f312d',
  base: '#8d918a',
  invalid: '#a2a29b',
  landing: '#20b8aa',
  uphill: '#e45c4f',
  slope0: '#d8f2e5',
  slope2: '#9bd8bd',
  slope5: '#5fa8a1',
  slope833: '#f0b26e',
  slope15: '#e56d55',
  slope25: '#8f2538',
  // Blue/cyan Landing Accessibility palette.
  // 0 ft = very light cyan; farther network distance moves through blue to indigo.
  // Landing Accessibility palette matched to the reference: pale green → teal → blue-gray → deep indigo.
  access0: '#dff1cf',
  access100: '#c4e8d8',
  access250: '#83d0c9',
  access400: '#6998ad',
  access520: '#596d8d',
  access600: '#424661'
};


// Analysis-road widths use a hybrid zoom rule:
// - when zoomed out, keep a minimum on-screen width so the network never disappears;
// - when zoomed in, grow the line so it continues to cover roughly the street width.
const LINE_WIDTHS = {
  networkBase: 1.8,
  selectedCasing: 7.5,
  selectedSlope: 6.0,
  selectedInvalid: 6.0,
  landing: 6.0,
  uphill: 6.5,
  accessibility: 6.0,
  unreachable: 6.0,
  streetHit: 28,
  segmentHit: 26
};

function worldScaledLineWidth(widthAtZoom15) {
  const z11 = Math.max(3.5, widthAtZoom15 * 0.65);
  const z12 = Math.max(4.0, widthAtZoom15 * 0.75);
  const z13 = Math.max(4.5, widthAtZoom15 * 0.85);
  const z14 = Math.max(5.0, widthAtZoom15 * 0.95);

  return [
    'interpolate', ['linear'], ['zoom'],
    11, z11,
    12, z12,
    13, z13,
    14, z14,
    15, widthAtZoom15,
    16, widthAtZoom15 * 1.6,
    17, widthAtZoom15 * 2.6,
    18, widthAtZoom15 * 4.6,
    19, widthAtZoom15 * 8.0,
    20, widthAtZoom15 * 14.0
  ];
}

const state = {
  map: null,
  allData: null,
  eachData: null,
  accessibilityData: null,
  accessibilityOverviewData: null,
  accessibilityDisplayData: null,
  eachById: new Map(),
  segmentsByStreet: new Map(),
  streetIds: [],
  selectedStreetIndex: 0,
  mode: 'individual',
  networkLayer: 'landing',
  is3D: true,
  popup: null,
  dashboardCollapsed: false,
  networkStats: null
};

const $ = (id) => document.getElementById(id);

function tokenIsConfigured() {
  return (
    typeof window.MAPBOX_TOKEN === 'string' &&
    window.MAPBOX_TOKEN.startsWith('pk.') &&
    !window.MAPBOX_TOKEN.includes('PASTE_')
  );
}

function showTokenNotice(message) {
  const notice = $('tokenNotice');
  notice.classList.remove('hidden');
  if (message) {
    notice.querySelector('span').innerHTML = message;
  }
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatNumber(value, digits = 1) {
  const n = safeNumber(value);
  return n === null ? '—' : n.toFixed(digits);
}

function formatInteger(value) {
  const n = safeNumber(value);
  return n === null ? '—' : Math.round(n).toLocaleString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setWidth(id, percent) {
  $(id).style.width = `${clamp(percent, 0, 100)}%`;
}

function setRing(id, value) {
  const pct = clamp(safeNumber(value, 0), 0, 100);
  $(id).style.setProperty('--coverage', `${pct * 3.6}deg`);
}

function slopeColor(value, valid = true) {
  if (!valid) return COLORS.invalid;
  const v = Math.abs(safeNumber(value, 0));
  if (v <= 2) return COLORS.slope2;
  if (v <= 5) return COLORS.slope5;
  if (v <= 8.33) return COLORS.slope833;
  if (v <= 15) return COLORS.slope15;
  return COLORS.slope25;
}


// ---------------------------------------------------------
// Accessibility display geometry
// ---------------------------------------------------------
// Grasshopper exports the repaired Dijkstra graph as short edges with
// network distance at both endpoints. Mapbox line-gradient cannot use
// feature properties as a data-driven start/end gradient, so we subdivide
// each repaired edge into very short display pieces and linearly interpolate
// the endpoint distances. Shared graph nodes therefore retain the same
// distance/color on every branch meeting at an intersection.

function haversineFeet(a, b) {
  const rad = Math.PI / 180;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const meters = 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return meters * 3.280839895;
}

function interpolateCoord(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t
  ];
}


function buildAccessibilityOverviewGeoJSON(collection) {
  // Merge the repaired graph's many short edges into longer junction-to-junction
  // chains for overview rendering. This is display-only: distances are still
  // calculated by Grasshopper and the detailed layer still uses every repaired edge.
  //
  // Why this is needed: each Dijkstra graph edge is often only a few feet long.
  // At medium/low zoom, Mapbox may simplify/cull separate sub-pixel features even
  // when line-width is large. Merging them into block-length chains prevents that.

  const rawEdges = [];
  const nodeCoords = new Map();
  const nodeAdjacency = new Map();

  const nodeKey = (coord) => `${Number(coord[0]).toFixed(7)},${Number(coord[1]).toFixed(7)}`;

  for (const feature of collection.features || []) {
    const geometry = feature.geometry;
    const p = feature.properties || {};
    if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) continue;

    const a = geometry.coordinates[0];
    const b = geometry.coordinates[geometry.coordinates.length - 1];
    const aKey = nodeKey(a);
    const bKey = nodeKey(b);
    const unreachable = p.is_unreachable === true || p.is_unreachable === 'true';

    const startRaw = Number.isFinite(Number(p.start_display_distance_ft))
      ? Number(p.start_display_distance_ft)
      : Number(p.start_distance_ft);
    const endRaw = Number.isFinite(Number(p.end_display_distance_ft))
      ? Number(p.end_display_distance_ft)
      : Number(p.end_distance_ft);

    const startDistance = Number.isFinite(startRaw) ? clamp(startRaw, 0, 600) : 600;
    const endDistance = Number.isFinite(endRaw) ? clamp(endRaw, 0, 600) : 600;

    const edgeIndex = rawEdges.length;
    rawEdges.push({
      a,
      b,
      aKey,
      bKey,
      unreachable,
      distance: (startDistance + endDistance) / 2
    });

    nodeCoords.set(aKey, a);
    nodeCoords.set(bKey, b);

    if (!nodeAdjacency.has(aKey)) nodeAdjacency.set(aKey, []);
    if (!nodeAdjacency.has(bKey)) nodeAdjacency.set(bKey, []);
    nodeAdjacency.get(aKey).push(edgeIndex);
    nodeAdjacency.get(bKey).push(edgeIndex);
  }

  const visited = new Set();
  const mergedFeatures = [];

  function walkChain(startNodeKey, firstEdgeIndex) {
    const coordinates = [nodeCoords.get(startNodeKey)];
    const distances = [];
    let currentNodeKey = startNodeKey;
    let currentEdgeIndex = firstEdgeIndex;
    let chainUnreachable = rawEdges[firstEdgeIndex].unreachable;

    while (currentEdgeIndex !== null && !visited.has(currentEdgeIndex)) {
      const edge = rawEdges[currentEdgeIndex];
      visited.add(currentEdgeIndex);
      distances.push(edge.distance);
      chainUnreachable = chainUnreachable || edge.unreachable;

      const nextNodeKey = edge.aKey === currentNodeKey ? edge.bKey : edge.aKey;
      coordinates.push(nodeCoords.get(nextNodeKey));

      const incident = (nodeAdjacency.get(nextNodeKey) || []).filter((idx) => {
        // Do not merge reachable and unreachable network states into one chain.
        return rawEdges[idx].unreachable === edge.unreachable;
      });

      // Junction/end: stop. Degree-2 node: keep walking through the block.
      if (incident.length !== 2) break;

      const nextEdgeIndex = incident.find((idx) => idx !== currentEdgeIndex && !visited.has(idx));
      if (nextEdgeIndex === undefined) break;

      currentNodeKey = nextNodeKey;
      currentEdgeIndex = nextEdgeIndex;
    }

    if (coordinates.length < 2) return;

    const meanDistance = distances.length
      ? distances.reduce((sum, value) => sum + value, 0) / distances.length
      : 600;

    mergedFeatures.push({
      type: 'Feature',
      properties: {
        is_unreachable: chainUnreachable,
        display_distance_ft: clamp(meanDistance, 0, 600)
      },
      geometry: {
        type: 'LineString',
        coordinates
      }
    });
  }

  // First walk from graph endpoints/junctions. This produces long, stable
  // junction-to-junction features instead of thousands of tiny edge features.
  for (const [key, incidentEdges] of nodeAdjacency.entries()) {
    for (const edgeIndex of incidentEdges) {
      if (visited.has(edgeIndex)) continue;
      const edge = rawEdges[edgeIndex];
      const sameStateDegree = incidentEdges.filter((idx) => rawEdges[idx].unreachable === edge.unreachable).length;
      if (sameStateDegree !== 2) walkChain(key, edgeIndex);
    }
  }

  // Any remaining edges are closed loops composed entirely of degree-2 nodes.
  for (let edgeIndex = 0; edgeIndex < rawEdges.length; edgeIndex += 1) {
    if (!visited.has(edgeIndex)) walkChain(rawEdges[edgeIndex].aKey, edgeIndex);
  }

  return {
    type: 'FeatureCollection',
    name: 'Accessibility_Network_Overview',
    features: mergedFeatures
  };
}

function buildAccessibilityDisplayGeoJSON(collection) {
  const features = [];
  const targetPieceLengthFt = 2.5;
  const maxPiecesPerEdge = 10;

  for (const feature of collection.features || []) {
    const geometry = feature.geometry;
    const p = feature.properties || {};
    if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) continue;

    const a = geometry.coordinates[0];
    const b = geometry.coordinates[geometry.coordinates.length - 1];
    const unreachable = p.is_unreachable === true || p.is_unreachable === 'true';

    if (unreachable) {
      features.push({
        type: 'Feature',
        properties: {
          edge_id: p.edge_id,
          is_unreachable: true,
          display_distance_ft: 600
        },
        geometry: { type: 'LineString', coordinates: [a, b] }
      });
      continue;
    }

    const startRaw = Number.isFinite(Number(p.start_display_distance_ft))
      ? Number(p.start_display_distance_ft)
      : Number(p.start_distance_ft);
    const endRaw = Number.isFinite(Number(p.end_display_distance_ft))
      ? Number(p.end_display_distance_ft)
      : Number(p.end_distance_ft);
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) continue;

    // Grasshopper's visualization cap is 600 ft. Keep the true values in the
    // source file, but cap only the browser display values here.
    const startDistance = clamp(startRaw, 0, 600);
    const endDistance = clamp(endRaw, 0, 600);

    const edgeLengthFt = Math.max(haversineFeet(a, b), 0.01);
    const pieces = clamp(Math.ceil(edgeLengthFt / targetPieceLengthFt), 2, maxPiecesPerEdge);

    for (let i = 0; i < pieces; i += 1) {
      const t0 = i / pieces;
      const t1 = (i + 1) / pieces;
      const tm = (t0 + t1) / 2;
      const displayDistance = startDistance + (endDistance - startDistance) * tm;

      features.push({
        type: 'Feature',
        properties: {
          edge_id: p.edge_id,
          is_unreachable: false,
          display_distance_ft: clamp(displayDistance, 0, 600)
        },
        geometry: {
          type: 'LineString',
          coordinates: [interpolateCoord(a, b, t0), interpolateCoord(a, b, t1)]
        }
      });
    }
  }

  return {
    type: 'FeatureCollection',
    name: 'Accessibility_Network_Display',
    features
  };
}

function buildDataIndexes() {
  state.eachById.clear();
  state.segmentsByStreet.clear();

  for (const feature of state.eachData.features) {
    const id = Number(feature.properties.street_id);
    state.eachById.set(id, feature);
  }

  for (const feature of state.allData.features) {
    const id = Number(feature.properties.street_id);
    if (!state.segmentsByStreet.has(id)) state.segmentsByStreet.set(id, []);
    state.segmentsByStreet.get(id).push(feature);
  }

  for (const segments of state.segmentsByStreet.values()) {
    segments.sort((a, b) => Number(a.properties.segment_id) - Number(b.properties.segment_id));
  }

  state.streetIds = [...state.eachById.keys()].sort((a, b) => a - b);
  state.selectedStreetIndex = 0;
  state.networkStats = calculateNetworkStats();
}

function calculateNetworkStats() {
  const valid = state.allData.features.filter((f) => Boolean(f.properties.slope_valid));
  const validSlopes = valid.map((f) => Number(f.properties.slope_pct)).filter(Number.isFinite);
  const landing = valid.filter((f) => Boolean(f.properties.is_landing));
  const reachableDistances = state.allData.features
    .map((f) => Number(f.properties.landing_distance_ft))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const unreachable = state.allData.features.filter((f) => Boolean(f.properties.is_unreachable));
  const uphillLengths = state.allData.features
    .map((f) => Number(f.properties.longest_uphill_length_ft))
    .filter((v) => Number.isFinite(v) && v > 0);

  return {
    segmentCount: state.allData.features.length,
    validCount: valid.length,
    meanSlope: validSlopes.length ? validSlopes.reduce((a, b) => a + b, 0) / validSlopes.length : null,
    landingCount: landing.length,
    landingCoverage: valid.length ? (landing.length / valid.length) * 100 : null,
    meanDistance: reachableDistances.length ? reachableDistances.reduce((a, b) => a + b, 0) / reachableDistances.length : null,
    maxDistance: reachableDistances.length ? Math.max(...reachableDistances) : null,
    unreachableCount: unreachable.length,
    longestUphill: uphillLengths.length ? Math.max(...uphillLengths) : 0,
    uphillLengths
  };
}

function getGeometryCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  return [];
}

function boundsFromFeature(feature) {
  const coords = getGeometryCoordinates(feature.geometry);
  if (!coords.length) return null;
  const bounds = new mapboxgl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((coord) => bounds.extend(coord));
  return bounds;
}

function boundsFromCollection(collection) {
  let bounds = null;
  for (const feature of collection.features) {
    for (const coord of getGeometryCoordinates(feature.geometry)) {
      if (!bounds) bounds = new mapboxgl.LngLatBounds(coord, coord);
      else bounds.extend(coord);
    }
  }
  return bounds;
}

function selectedStreetId() {
  return state.streetIds[state.selectedStreetIndex];
}

function syncStreetControls() {
  const id = selectedStreetId();
  $('streetSlider').max = Math.max(0, state.streetIds.length - 1);
  $('streetSlider').value = state.selectedStreetIndex;
  $('selectedStreetId').textContent = id ?? '—';
  $('streetCounter').textContent = `${state.selectedStreetIndex + 1} / ${state.streetIds.length}`;
}

function setSelectedStreetByIndex(index, focus = false) {
  if (!state.streetIds.length) return;
  state.selectedStreetIndex = clamp(Number(index), 0, state.streetIds.length - 1);
  syncStreetControls();
  updateSelectedStreetLayers();
  updateIndividualDashboard();
  if (focus) focusSelectedStreet();
}

function setSelectedStreetById(id, focus = false) {
  const index = state.streetIds.indexOf(Number(id));
  if (index >= 0) setSelectedStreetByIndex(index, focus);
}

function focusSelectedStreet() {
  const feature = state.eachById.get(selectedStreetId());
  if (!feature || !state.map) return;
  const bounds = boundsFromFeature(feature);
  if (!bounds) return;

  state.map.fitBounds(bounds, {
    padding: { top: 130, right: 150, bottom: 285, left: 310 },
    maxZoom: 16.7,
    duration: 900,
    pitch: state.is3D ? 62 : 0,
    bearing: state.is3D ? -28 : 0
  });
}

function focusStudyArea() {
  if (!state.map) return;
  const bounds = boundsFromCollection(state.allData);
  if (!bounds) return;
  state.map.fitBounds(bounds, {
    padding: { top: 125, right: 100, bottom: 285, left: 310 },
    maxZoom: 15.35,
    duration: 900,
    pitch: state.is3D ? 58 : 0,
    bearing: state.is3D ? -28 : 0
  });
}

function addMapSourcesAndLayers() {
  const map = state.map;

  if (!map.getSource('all-streets')) {
    map.addSource('all-streets', { type: 'geojson', data: state.allData });
  }
  if (!map.getSource('each-street')) {
    map.addSource('each-street', { type: 'geojson', data: state.eachData });
  }
  if (!map.getSource('access-network-overview')) {
    // Render-safe junction-to-junction chains. tolerance: 0 prevents GeoJSON-VT
    // from simplifying short repaired network details at medium/low zoom.
    map.addSource('access-network-overview', {
      type: 'geojson',
      data: state.accessibilityOverviewData,
      tolerance: 0,
      buffer: 512,
      maxzoom: 24
    });
  }
  if (!map.getSource('access-network-display')) {
    // Densified micro-segments used at closer zooms for smooth endpoint-to-endpoint color interpolation.
    map.addSource('access-network-display', {
      type: 'geojson',
      data: state.accessibilityDisplayData,
      tolerance: 0,
      buffer: 512,
      maxzoom: 24
    });
  }
  if (!map.getSource('mapbox-dem')) {
    map.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14
    });
  }

  // Subtle full study network.
  map.addLayer({
    id: 'network-base',
    type: 'line',
    source: 'all-streets',
    layout: { 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': COLORS.base,
      'line-width': worldScaledLineWidth(LINE_WIDTHS.networkBase),
      'line-opacity': 0.36,
      'line-emissive-strength': 0.1
    }
  });

  // A light casing makes the selected street read like the raised route in the reference image.
  map.addLayer({
    id: 'selected-street-casing',
    type: 'line',
    source: 'all-streets',
    layout: { 'line-cap': 'square', 'line-join': 'miter' },
    filter: ['==', ['get', 'street_id'], -9999],
    paint: {
      'line-color': '#fbfaf5',
      'line-width': worldScaledLineWidth(LINE_WIDTHS.selectedCasing),
      'line-opacity': 0.96,
      'line-emissive-strength': 0.2
    }
  });

  map.addLayer({
    id: 'selected-street-slope',
    type: 'line',
    source: 'all-streets',
    layout: { 'line-cap': 'square', 'line-join': 'miter' },
    filter: ['all', ['==', ['get', 'street_id'], -9999], ['==', ['get', 'slope_valid'], true]],
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['get', 'slope_pct'],
        0, COLORS.slope0,
        2, COLORS.slope2,
        5, COLORS.slope5,
        8.33, COLORS.slope833,
        15, COLORS.slope15,
        25, COLORS.slope25
      ],
      'line-width': worldScaledLineWidth(LINE_WIDTHS.selectedSlope),
      'line-opacity': 1,
      'line-emissive-strength': 0.48
    }
  });

  map.addLayer({
    id: 'selected-street-invalid',
    type: 'line',
    source: 'all-streets',
    layout: { 'line-cap': 'square', 'line-join': 'miter' },
    filter: ['all', ['==', ['get', 'street_id'], -9999], ['==', ['get', 'slope_valid'], false]],
    paint: {
      'line-color': COLORS.invalid,
      'line-width': worldScaledLineWidth(LINE_WIDTHS.selectedInvalid),
      'line-dasharray': [1.2, 1.2],
      'line-opacity': 0.95,
      'line-emissive-strength': 0.25
    }
  });

  map.addLayer({
    id: 'landing-layer',
    type: 'line',
    source: 'all-streets',
    filter: ['==', ['get', 'is_landing'], true],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': COLORS.landing,
      'line-width': worldScaledLineWidth(LINE_WIDTHS.landing),
      'line-opacity': 0.98,
      'line-emissive-strength': 0.55
    }
  });

  map.addLayer({
    id: 'uphill-layer',
    type: 'line',
    source: 'all-streets',
    filter: ['==', ['get', 'is_longest_steep_uphill'], true],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': COLORS.uphill,
      'line-width': worldScaledLineWidth(LINE_WIDTHS.uphill),
      'line-opacity': 1,
      'line-emissive-strength': 0.5
    }
  });

  // ---------------------------------------------------------
  // LANDING ACCESSIBILITY — ZOOMED-OUT OVERVIEW
  //
  // The repaired graph is made of many short edges. Even large line-widths do
  // not guarantee that separate sub-pixel GeoJSON features survive simplification.
  // The overview therefore uses merged junction-to-junction chains and NEVER
  // fully disappears. The detailed interpolated layer is added on top at close zoom.
  // ---------------------------------------------------------
  map.addLayer({
    id: 'access-overview-casing',
    type: 'line',
    source: 'access-network-overview',
    filter: ['==', ['get', 'is_unreachable'], false],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': '#f1f5f3',
      'line-width': worldScaledLineWidth(LINE_WIDTHS.accessibility + 1.8),
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        10, 0.82,
        14, 0.78,
        16, 0.58,
        20, 0.42
      ],
      'line-emissive-strength': 0.2
    }
  });

  map.addLayer({
    id: 'access-overview-layer',
    type: 'line',
    source: 'access-network-overview',
    filter: ['==', ['get', 'is_unreachable'], false],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['get', 'display_distance_ft'],
        0, COLORS.access0,
        100, COLORS.access100,
        250, COLORS.access250,
        400, COLORS.access400,
        520, COLORS.access520,
        600, COLORS.access600
      ],
      'line-width': worldScaledLineWidth(LINE_WIDTHS.accessibility),
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        10, 1.0,
        14, 0.96,
        16, 0.72,
        20, 0.52
      ],
      'line-emissive-strength': 0.5
    }
  });

  // Light casing keeps the repaired accessibility graph legible over the 3D basemap.
  map.addLayer({
    id: 'access-casing',
    type: 'line',
    source: 'access-network-display',
    filter: ['==', ['get', 'is_unreachable'], false],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': '#eef4f8',
      'line-width': worldScaledLineWidth(LINE_WIDTHS.accessibility + 1.8),
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13.2, 0.0,
        14.2, 0.50,
        15.0, 0.78
      ],
      'line-emissive-strength': 0.28
    }
  });

  map.addLayer({
    id: 'access-layer',
    type: 'line',
    source: 'access-network-display',
    filter: ['==', ['get', 'is_unreachable'], false],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['get', 'display_distance_ft'],
        0, COLORS.access0,
        100, COLORS.access100,
        250, COLORS.access250,
        400, COLORS.access400,
        520, COLORS.access520,
        600, COLORS.access600
      ],
      'line-width': worldScaledLineWidth(LINE_WIDTHS.accessibility),
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13.2, 0.0,
        14.2, 0.72,
        15.0, 1.0
      ],
      'line-emissive-strength': 0.62
    }
  });

  map.addLayer({
    id: 'unreachable-layer',
    type: 'line',
    source: 'access-network-display',
    filter: ['==', ['get', 'is_unreachable'], true],
    layout: { visibility: 'none', 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': '#474944',
      'line-width': worldScaledLineWidth(LINE_WIDTHS.unreachable),
      'line-dasharray': [1.4, 1.2],
      'line-opacity': 0.88,
      'line-emissive-strength': 0.25
    }
  });

  // Wide invisible street hit target, using the one-feature-per-street file.
  map.addLayer({
    id: 'street-hit',
    type: 'line',
    source: 'each-street',
    layout: { 'line-cap': 'square', 'line-join': 'miter' },
    paint: {
      'line-color': '#000000',
      'line-width': LINE_WIDTHS.streetHit,
      'line-opacity': 0.01
    }
  });

  // Wide segment hit target for hover popups.
  map.addLayer({
    id: 'segment-hit',
    type: 'line',
    source: 'all-streets',
    layout: { 'line-cap': 'square', 'line-join': 'miter' },
    filter: ['==', ['get', 'street_id'], -9999],
    paint: {
      'line-color': '#000000',
      'line-width': LINE_WIDTHS.segmentHit,
      'line-opacity': 0.01
    }
  });

  if (state.is3D) {
    map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.12 });
  }

  updateSelectedStreetLayers();
  syncLayerVisibility();
  installMapInteractions();
}

function updateSelectedStreetLayers() {
  if (!state.map || !state.map.getLayer('selected-street-slope')) return;
  const id = selectedStreetId();
  const idFilter = ['==', ['get', 'street_id'], id];
  state.map.setFilter('selected-street-casing', idFilter);
  state.map.setFilter('selected-street-slope', ['all', idFilter, ['==', ['get', 'slope_valid'], true]]);
  state.map.setFilter('selected-street-invalid', ['all', idFilter, ['==', ['get', 'slope_valid'], false]]);
  state.map.setFilter('segment-hit', state.mode === 'individual' ? idFilter : null);
}

function setLayerVisibility(layerId, visible) {
  if (state.map?.getLayer(layerId)) {
    state.map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

function syncLayerVisibility() {
  if (!state.map?.getLayer('network-base')) return;

  const individual = state.mode === 'individual';
  setLayerVisibility('selected-street-casing', individual);
  setLayerVisibility('selected-street-slope', individual);
  setLayerVisibility('selected-street-invalid', individual);
  setLayerVisibility('street-hit', individual);

  setLayerVisibility('landing-layer', !individual && state.networkLayer === 'landing');
  setLayerVisibility('uphill-layer', !individual && state.networkLayer === 'uphill');
  setLayerVisibility('access-overview-casing', !individual && state.networkLayer === 'access');
  setLayerVisibility('access-overview-layer', !individual && state.networkLayer === 'access');
  setLayerVisibility('access-casing', !individual && state.networkLayer === 'access');
  setLayerVisibility('access-layer', !individual && state.networkLayer === 'access');
  setLayerVisibility('unreachable-layer', !individual && state.networkLayer === 'access');

  state.map.setPaintProperty('network-base', 'line-opacity', individual ? 0.26 : 0.33);
  updateSelectedStreetLayers();
}

function installMapInteractions() {
  const map = state.map;

  map.on('click', 'street-hit', (event) => {
    if (state.mode !== 'individual' || !event.features?.length) return;
    setSelectedStreetById(event.features[0].properties.street_id, false);
  });

  map.on('mouseenter', 'street-hit', () => {
    if (state.mode === 'individual') map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'street-hit', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('mousemove', 'segment-hit', (event) => {
    if (!event.features?.length) return;
    const feature = event.features[0];
    const p = feature.properties;

    if (!state.popup) {
      state.popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    }

    const slopeText = p.slope_valid === true || p.slope_valid === 'true'
      ? `${formatNumber(p.slope_pct, 2)}%`
      : 'No terrain data';
    const distance = Number(p.landing_distance_ft);
    const distanceText = Number.isFinite(distance) && distance >= 0 ? `${formatNumber(distance, 0)} ft` : 'Unreachable';

    state.popup
      .setLngLat(event.lngLat)
      .setHTML(`
        <div class="popup-title">Street ${p.street_id} · Segment ${p.segment_id}</div>
        <div class="popup-grid">
          <span>Absolute slope</span><strong>${slopeText}</strong>
          <span>Landing-like</span><strong>${String(p.is_landing) === 'true' ? 'Yes' : 'No'}</strong>
          <span>Steep &gt; 8.33%</span><strong>${String(p.is_steep) === 'true' ? 'Yes' : 'No'}</strong>
          <span>Landing distance</span><strong>${distanceText}</strong>
        </div>
      `)
      .addTo(map);

    map.getCanvas().style.cursor = 'crosshair';
  });

  map.on('mouseleave', 'segment-hit', () => {
    state.popup?.remove();
    state.map.getCanvas().style.cursor = '';
  });
}

function updateLegend() {
  const legend = $('legend');

  if (state.mode === 'individual') {
    legend.innerHTML = `
      <div class="legend-title">SEGMENT SLOPE</div>
      <div class="legend-gradient" style="background:linear-gradient(90deg, ${COLORS.slope0}, ${COLORS.slope5}, ${COLORS.slope833}, ${COLORS.slope15}, ${COLORS.slope25});"></div>
      <div class="legend-labels"><span>0%</span><span>8.33%</span><span>25%+</span></div>
      <div class="legend-row"><span class="legend-line" style="background:${COLORS.invalid}; border:1px dashed #777;"></span><span>No terrain data</span></div>
      <div class="legend-note">Slope is modeled from 20-ft street-aligned segments. 8.33% is used as an analytical benchmark.</div>
    `;
    return;
  }

  if (state.networkLayer === 'landing') {
    legend.innerHTML = `
      <div class="legend-title">LANDING-LIKE SEGMENTS</div>
      <div class="legend-row"><span class="legend-line" style="background:${COLORS.landing};"></span><span>Modeled slope ≤ 2%</span></div>
      <div class="legend-row"><span class="legend-line" style="background:${COLORS.base}; opacity:.45;"></span><span>Other analyzed segments</span></div>
      <div class="legend-note">These are modeled level/rest opportunities, not verified constructed ADA landings.</div>
    `;
  } else if (state.networkLayer === 'uphill') {
    legend.innerHTML = `
      <div class="legend-title">LONGEST STEEP UPHILL</div>
      <div class="legend-row"><span class="legend-line" style="background:${COLORS.uphill};"></span><span>Selected longest run per street</span></div>
      <div class="legend-row"><span class="legend-line" style="background:${COLORS.base}; opacity:.45;"></span><span>Other analyzed segments</span></div>
      <div class="legend-note">Only the longer of forward/reverse continuous runs above 8.33% is retained for each street.</div>
    `;
  } else {
    legend.innerHTML = `
      <div class="legend-title">NETWORK DISTANCE TO LANDING</div>
      <div class="legend-gradient" style="background:linear-gradient(90deg, ${COLORS.access0}, ${COLORS.access100}, ${COLORS.access250}, ${COLORS.access400}, ${COLORS.access520}, ${COLORS.access600});"></div>
      <div class="legend-labels"><span>0 ft</span><span>300 ft</span><span>600+ ft</span></div>
      <div class="legend-row"><span class="legend-line" style="background:#474944;"></span><span>Unreachable / disconnected</span></div>
      <div class="legend-note">Distance follows the modeled street network rather than Euclidean distance.</div>
    `;
  }
}

function updateIndividualDashboard() {
  const id = selectedStreetId();
  const street = state.eachById.get(id);
  const segments = state.segmentsByStreet.get(id) || [];
  if (!street) return;

  const p = street.properties;
  const invalidCount = Math.max(0, Number(p.segment_count) - Number(p.valid_slope_segment_count));

  $('dashboardKicker').textContent = 'INDIVIDUAL STREET ANALYSIS';
  $('dashboardTitle').textContent = `Street ${id}`;
  $('qualityBadge').textContent = invalidCount ? `${invalidCount} NO-DATA SEGMENT${invalidCount === 1 ? '' : 'S'}` : 'ALL SLOPES VALID';
  $('dashboardSummary').textContent = `This street contains ${p.segment_count} modeled 20-ft segments. The dashboard compares average and peak slope, slope variability, the longest continuous steep uphill run, and modeled access to landing-like segments.`;

  $('profileSegmentCount').textContent = `${p.segment_count} segments`;
  $('meanSlopeValue').textContent = formatNumber(p.mean_abs_slope_pct, 2);
  $('maxSlopeValue').textContent = formatNumber(p.max_segment_slope_pct, 2);
  $('slopeVariationValue').textContent = formatNumber(p.slope_variation_range_pct, 2);
  $('uphillLengthValue').textContent = formatInteger(p.longest_continuous_steep_uphill_ft);
  $('uphillRatioValue').textContent = formatNumber(p.continuous_steep_uphill_ratio_pct, 1);
  $('landingCoverageValue').textContent = `${formatNumber(p.landing_like_coverage_ratio_pct, 1)}%`;
  $('meanDistanceValue').textContent = formatInteger(p.mean_landing_distance_ft);
  $('maxDistanceValue').textContent = formatInteger(p.max_landing_distance_ft);

  setWidth('meanSlopeBar', (safeNumber(p.mean_abs_slope_pct, 0) / 20) * 100);
  setWidth('maxSlopeBar', (safeNumber(p.max_segment_slope_pct, 0) / 25) * 100);
  setWidth('uphillRatioBar', safeNumber(p.continuous_steep_uphill_ratio_pct, 0));
  setWidth('distanceRange', (safeNumber(p.max_landing_distance_ft, 0) / 1200) * 100);
  setRing('landingRing', p.landing_like_coverage_ratio_pct);

  const maxSlope = safeNumber(p.max_segment_slope_pct);
  $('maxSlopeDelta').textContent = maxSlope === null ? '—' : (maxSlope > 8.33 ? `+${(maxSlope - 8.33).toFixed(1)} pp` : `${(maxSlope - 8.33).toFixed(1)} pp`);
  $('unreachableNote').textContent = Number(p.unreachable_segment_count) > 0
    ? `${p.unreachable_segment_count} segment${Number(p.unreachable_segment_count) === 1 ? '' : 's'} cannot reach a modeled landing in the repaired network.`
    : 'All segments connect to at least one modeled landing-like segment.';

  renderSlopeProfile(segments);
  renderVariationTicks(segments);
}

function renderSlopeProfile(segments) {
  const container = $('slopeProfile');
  container.innerHTML = '';
  const maxVisualSlope = 25;

  for (const feature of segments) {
    const p = feature.properties;
    const valid = Boolean(p.slope_valid);
    const slope = safeNumber(p.slope_pct, 0);
    const bar = document.createElement('span');
    bar.className = 'slope-bar';
    bar.style.height = valid ? `${10 + (clamp(slope, 0, maxVisualSlope) / maxVisualSlope) * 62}px` : '9px';
    bar.style.background = slopeColor(slope, valid);
    if (!valid) bar.style.border = '1px dashed rgba(70,70,66,.5)';
    bar.title = `Segment ${p.segment_id}: ${valid ? `${Number(slope).toFixed(2)}%` : 'No terrain data'}`;
    container.appendChild(bar);
  }
}

function renderVariationTicks(segments) {
  const target = $('variationTicks');
  target.innerHTML = '';
  const values = segments
    .filter((f) => Boolean(f.properties.slope_valid))
    .map((f) => Math.abs(Number(f.properties.slope_pct)))
    .filter(Number.isFinite);

  if (!values.length) return;
  const bins = 12;
  const maxV = Math.max(...values, 1);
  const counts = Array(bins).fill(0);
  values.forEach((v) => {
    const index = Math.min(bins - 1, Math.floor((v / maxV) * bins));
    counts[index] += 1;
  });
  const maxCount = Math.max(...counts, 1);
  counts.forEach((count) => {
    const el = document.createElement('span');
    el.style.height = `${4 + (count / maxCount) * 20}px`;
    target.appendChild(el);
  });
}

function updateNetworkDashboard() {
  const s = state.networkStats;
  $('dashboardKicker').textContent = 'NETWORK ANALYSIS';
  $('dashboardTitle').textContent = state.networkLayer === 'landing'
    ? 'Landing-Like Opportunities'
    : state.networkLayer === 'uphill'
      ? 'Continuous Steep Uphill Burden'
      : 'Landing Accessibility';
  $('qualityBadge').textContent = `${s.validCount.toLocaleString()} VALID SLOPES`;

  const narratives = {
    landing: 'Highlights modeled level/rest-opportunity segments across the full network. The base network remains visible to show where rest opportunities are sparse.',
    uphill: 'Highlights only the longest continuous steep uphill run identified on each street, preserving the same logic used in the street-level analysis.',
    access: 'Displays the repaired Dijkstra street graph and interpolates network distance between graph nodes, so repaired gaps and intersection colors match the actual Grasshopper network.'
  };
  $('dashboardSummary').textContent = narratives[state.networkLayer];

  $('networkSegmentsValue').textContent = s.segmentCount.toLocaleString();
  $('networkMeanSlopeValue').textContent = formatNumber(s.meanSlope, 2);
  $('networkLandingCoverageValue').textContent = `${formatNumber(s.landingCoverage, 1)}%`;
  $('networkLandingCount').textContent = `${s.landingCount.toLocaleString()} segments`;
  $('networkLongestUphillValue').textContent = formatInteger(s.longestUphill);
  $('networkMeanDistanceValue').textContent = formatInteger(s.meanDistance);
  $('networkMaxDistanceValue').textContent = formatInteger(s.maxDistance);

  setWidth('networkMeanSlopeBar', (safeNumber(s.meanSlope, 0) / 20) * 100);
  setRing('networkLandingRing', s.landingCoverage);
  setWidth('networkDistanceRange', (safeNumber(s.maxDistance, 0) / 1800) * 100);
  $('networkUnreachableNote').textContent = `${s.unreachableCount.toLocaleString()} segment${s.unreachableCount === 1 ? '' : 's'} are unreachable from any modeled landing-like segment in the repaired network.`;
  renderNetworkUphillBars(s.uphillLengths);
}

function renderNetworkUphillBars(values) {
  const target = $('networkUphillBars');
  target.innerHTML = '';
  const unique = [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => b - a).slice(0, 14).reverse();
  const maxV = Math.max(...unique, 1);
  unique.forEach((value) => {
    const bar = document.createElement('span');
    bar.style.height = `${5 + (value / maxV) * 27}px`;
    bar.title = `${value} ft`;
    target.appendChild(bar);
  });
}

function setMode(mode, focus = false) {
  state.mode = mode;
  const individual = mode === 'individual';

  $('individualModeBtn').classList.toggle('active', individual);
  $('networkModeBtn').classList.toggle('active', !individual);
  $('streetControls').classList.toggle('hidden', !individual);
  $('networkControls').classList.toggle('hidden', individual);
  $('individualDashboard').classList.toggle('hidden', !individual);
  $('networkDashboard').classList.toggle('hidden', individual);

  syncLayerVisibility();
  updateLegend();
  if (individual) {
    updateIndividualDashboard();
    if (focus) focusSelectedStreet();
  } else {
    updateNetworkDashboard();
    if (focus) focusStudyArea();
  }
}

function setNetworkLayer(layer) {
  state.networkLayer = layer;
  document.querySelectorAll('.network-layer-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.layer === layer);
  });
  syncLayerVisibility();
  updateLegend();
  updateNetworkDashboard();
}

function set3DView(is3D) {
  state.is3D = is3D;
  $('view3dBtn').classList.toggle('active', is3D);
  $('view2dBtn').classList.toggle('active', !is3D);

  const map = state.map;
  if (!map) return;

  try {
    map.setConfigProperty('basemap', 'show3dObjects', is3D);
    map.setConfigProperty('basemap', 'show3dBuildings', is3D);
  } catch (error) {
    console.warn('3D basemap config update:', error);
  }

  if (is3D) {
    if (map.getSource('mapbox-dem')) map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.12 });
    map.easeTo({ pitch: 62, bearing: -28, duration: 850 });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 850 });
  }
}

function bindUI() {
  $('individualModeBtn').addEventListener('click', () => setMode('individual', true));
  $('networkModeBtn').addEventListener('click', () => setMode('network', true));
  $('view3dBtn').addEventListener('click', () => set3DView(true));
  $('view2dBtn').addEventListener('click', () => set3DView(false));

  $('streetSlider').addEventListener('input', (event) => setSelectedStreetByIndex(event.target.value, false));
  $('prevStreetBtn').addEventListener('click', () => setSelectedStreetByIndex(state.selectedStreetIndex - 1, false));
  $('nextStreetBtn').addEventListener('click', () => setSelectedStreetByIndex(state.selectedStreetIndex + 1, false));
  $('focusStreetBtn').addEventListener('click', focusSelectedStreet);

  document.querySelectorAll('.network-layer-btn').forEach((button) => {
    button.addEventListener('click', () => setNetworkLayer(button.dataset.layer));
  });

  $('toggleDashboardBtn').addEventListener('click', () => {
    state.dashboardCollapsed = !state.dashboardCollapsed;
    $('dashboard').classList.toggle('collapsed', state.dashboardCollapsed);
    $('toggleDashboardBtn').classList.toggle('collapsed', state.dashboardCollapsed);
  });
}

async function init() {
  bindUI();

  if (!tokenIsConfigured()) {
    showTokenNotice('Open <code>config.js</code>, paste a Mapbox <strong>public</strong> token that starts with <code>pk.</code>, then refresh the page.');
    return;
  }

  try {
    const [allResponse, eachResponse, accessibilityResponse] = await Promise.all([
      fetch(DATA_FILES.all),
      fetch(DATA_FILES.each),
      fetch(DATA_FILES.accessibility)
    ]);

    if (!allResponse.ok || !eachResponse.ok || !accessibilityResponse.ok) {
      throw new Error('GeoJSON request failed. Confirm data/All_Street.geojson, data/Each_Street.geojson, and data/Accessibility_Network.geojson all exist, then run the folder through a local web server.');
    }

    state.allData = await allResponse.json();
    state.eachData = await eachResponse.json();
    state.accessibilityData = await accessibilityResponse.json();
    state.accessibilityOverviewData = buildAccessibilityOverviewGeoJSON(state.accessibilityData);
    state.accessibilityDisplayData = buildAccessibilityDisplayGeoJSON(state.accessibilityData);

    if (!state.accessibilityOverviewData.features.length || !state.accessibilityDisplayData.features.length) {
      throw new Error('Accessibility_Network.geojson loaded, but no drawable repaired-network geometry was produced.');
    }

    console.info(
      `Loaded ${state.accessibilityData.features.length.toLocaleString()} repaired network edges; ` +
      `${state.accessibilityOverviewData.features.length.toLocaleString()} merged overview chains; ` +
      `${state.accessibilityDisplayData.features.length.toLocaleString()} detail pieces created.`
    );

    buildDataIndexes();
    syncStreetControls();
    updateIndividualDashboard();
    updateNetworkDashboard();
    updateLegend();

    mapboxgl.accessToken = window.MAPBOX_TOKEN;

    state.map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/standard',
      center: [-73.9626, 40.8104],
      zoom: 14.9,
      pitch: 62,
      bearing: -28,
      antialias: true,
      attributionControl: true,
      config: {
        basemap: {
          theme: 'monochrome',
          lightPreset: 'day',
          showPointOfInterestLabels: false,
          showTransitLabels: false,
          showRoadLabels: false,
          showPlaceLabels: false,
          showAdminBoundaries: false,
          show3dObjects: true,
          show3dBuildings: true,
          show3dTrees: false,
          show3dLandmarks: false,
          show3dFacades: false,
          colorLand: '#e7edf3',
          colorGreenspace: '#dce8e9',
          colorWater: '#d8e8f0',
          colorRoads: '#d3dee7',
          colorBuildings: '#eef3f7'
        }
      }
    });

    state.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    state.map.on('style.load', () => {
      addMapSourcesAndLayers();
      focusStudyArea();
      setTimeout(() => focusSelectedStreet(), 1050);
    });

    state.map.on('error', (event) => {
      if (event?.error) console.error('Mapbox:', event.error);
    });
  } catch (error) {
    console.error(error);
    showTokenNotice(`<strong>Site data could not load.</strong><br>${error.message}<br><br>Start a local server in this folder with <code>python -m http.server 8000</code>, then open <code>http://localhost:8000</code>.`);
  }
}

init();
