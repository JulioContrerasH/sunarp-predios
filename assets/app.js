/* global maplibregl, XLSX, shp, Flatbush, turf */

const INDEX_URL = 'data/distritos/index.json';
const BASE_VECTOR = 'https://tiles.openfreemap.org/styles/bright';
const BASE_BRIGHT = 'https://tiles.openfreemap.org/styles/bright';
const BASE_SATELLITE = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri, Maxar, Earthstar Geographics'
    }
  },
  layers: [{
    id: 'satellite',
    type: 'raster',
    source: 'satellite',
    minzoom: 0,
    maxzoom: 22
  }]
};

const TYPE_COLORS = {
  '03': '#f59e0b',
  '04': '#10b981',
  '07': '#3b82f6',
  '08': '#8b5cf6',
  '10': '#ec4899',
  '13': '#ef4444',
  '99': '#64748b'
};

const TYPE_LABELS = {
  '03': 'Predio urbano (03)',
  '04': 'Predio rural (04)',
  '07': 'Predio urbano (07)',
  '08': 'Predio rural (08)',
  '10': 'Industrial / especial (10)',
  '13': 'Otros usos (13)',
  '99': 'Sin clasificar (99)'
};

const TYPE_FALLBACK = '#94a3b8';

function normalizeType(t) {
  if (t === null || t === undefined) return '99';
  const s = String(t).trim();
  if (s === '') return '99';
  const padded = s.padStart(2, '0');
  return TYPE_COLORS[padded] ? padded : '99';
}

function formatNumber(n) {
  return new Intl.NumberFormat('es-PE').format(Math.round(n));
}

function formatCompact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const dec = (v, d) => new Intl.NumberFormat('es-PE', { maximumFractionDigits: d }).format(v);
  if (abs >= 1e9) return `${dec(n / 1e9, 2)} mil M`;
  if (abs >= 1e6) return `${dec(n / 1e6, 1)} M`;
  if (abs >= 1e5) return `${dec(n / 1e3, 0)} mil`;
  return dec(n, 0);
}

function formatAreaHa(m2) {
  return new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(m2 / 10000);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function featuresToCsvRows(features) {
  if (!features.length) return [];
  const keys = Object.keys(features[0].properties);
  const rows = [keys.join(',')];
  for (const f of features) {
    const vals = keys.map(k => {
      let v = f.properties[k];
      if (v === null || v === undefined) v = '';
      v = String(v).replace(/"/g, '""');
      if (/[",\n]/.test(v)) v = `"${v}"`;
      return v;
    });
    rows.push(vals.join(','));
  }
  return rows;
}

function featuresToWorksheet(features) {
  if (!features.length) return null;
  const keys = Object.keys(features[0].properties);
  const aoa = [keys];
  for (const f of features) {
    aoa.push(keys.map(k => {
      const v = f.properties[k];
      return v === null || v === undefined ? '' : v;
    }));
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

async function loadIndex() {
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`No se pudo cargar el índice de distritos (${res.status})`);
  return res.json();
}

class App {
  constructor() {
    this.districts = [];
    this.current = null;
    this.currentFeatures = [];
    this.hoveredId = null;
    this.baseMode = 'vector';
    this.subset = [];
    this.flatbush = null;

    this.ui = {
      search: document.getElementById('district-search'),
      results: document.getElementById('search-results'),
      clear: document.getElementById('clear-search'),
      theme: document.getElementById('theme-toggle'),
      menu: document.getElementById('menu-toggle'),
      sidebar: document.getElementById('sidebar'),
      layer: document.getElementById('layer-toggle'),
      locate: document.getElementById('locate-btn'),
      panelEmpty: document.getElementById('panel-empty'),
      panelContent: document.getElementById('panel-content'),
      title: document.getElementById('panel-title'),
      breadcrumb: document.getElementById('panel-breadcrumb'),
      count: document.getElementById('metric-count'),
      area: document.getElementById('metric-area'),
      ha: document.getElementById('metric-ha'),
      legend: document.getElementById('legend-list'),
      downloadGeojson: document.getElementById('download-geojson'),
      downloadCsv: document.getElementById('download-csv'),
      downloadXlsx: document.getElementById('download-xlsx'),
      searchWrap: document.querySelector('.search-wrap'),
      upload: document.getElementById('upload-file'),
      uploadResult: document.getElementById('upload-result'),
      uploadCount: document.getElementById('upload-count'),
      downloadSubsetGeojson: document.getElementById('download-subset-geojson'),
      downloadSubsetCsv: document.getElementById('download-subset-csv'),
      downloadSubsetXlsx: document.getElementById('download-subset-xlsx')
    };

    this.initTheme();
    this.initMap();
    this.bindEvents();
    document.__app = this;
  }

  initTheme() {
    const saved = localStorage.getItem('sunarp-theme');
    const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const theme = saved || prefers;
    document.documentElement.setAttribute('data-theme', theme);
  }

  initMap() {
    this.map = new maplibregl.Map({
      container: 'map',
      style: BASE_VECTOR,
      center: [-76.2, -10.5],
      zoom: 5,
      attributionControl: true
    });

    this.map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    this.map.on('load', () => {
      this.map.getCanvas().style.cursor = '';
      this.loadDistricts();
    });

    this.map.on('style.load', () => {
      if (this.current) this.renderDistrictLayer();
    });

    this.map.on('mousemove', 'predios-fill', (e) => this.onHover(e));
    this.map.on('mouseleave', 'predios-fill', () => this.onHoverLeave());
    this.map.on('click', 'predios-fill', (e) => this.onClick(e));
    this.map.on('click', (e) => {
      if (!e.defaultPrevented) this.closePopup();
    });
  }

  bindEvents() {
    this.ui.theme.addEventListener('click', () => this.toggleTheme());
    this.ui.menu.addEventListener('click', () => {
      this.ui.sidebar.classList.toggle('open');
      setTimeout(() => this.fitCurrent(), 340);
    });
    this.ui.layer.addEventListener('click', () => this.toggleBaseLayer());
    this.ui.locate.addEventListener('click', () => this.fitCurrent());

    if (window.matchMedia('(max-width: 720px)').matches) {
      this.ui.search.placeholder = 'Distrito…';
    }
    this.ui.search.addEventListener('input', (e) => this.onSearch(e.target.value));
    this.ui.search.addEventListener('focus', () => this.onSearch(this.ui.search.value));
    this.ui.search.addEventListener('keydown', (e) => this.onSearchKey(e));
    this.ui.clear.addEventListener('click', () => {
      this.ui.search.value = '';
      this.ui.results.hidden = true;
      this.ui.clear.hidden = true;
    });

    document.addEventListener('click', (e) => {
      if (!this.ui.searchWrap.contains(e.target)) {
        this.ui.results.hidden = true;
      }
    });

    this.ui.downloadGeojson.addEventListener('click', () => this.downloadGeojson());
    this.ui.downloadCsv.addEventListener('click', () => this.downloadCsv());
    this.ui.downloadXlsx.addEventListener('click', () => this.downloadXlsx());

    this.ui.upload.addEventListener('change', (e) => this.onUpload(e));
    this.ui.downloadSubsetGeojson.addEventListener('click', () => this.downloadSubsetGeojson());
    this.ui.downloadSubsetCsv.addEventListener('click', () => this.downloadSubsetCsv());
    this.ui.downloadSubsetXlsx.addEventListener('click', () => this.downloadSubsetXlsx());
  }

  async loadDistricts() {
    try {
      this.districts = await loadIndex();
    } catch (err) {
      console.error(err);
      this.ui.results.innerHTML = '<li class="no-results">Error cargando distritos.</li>';
      this.ui.results.hidden = false;
      return;
    }
    if (this.districts.length === 1) {
      this.selectDistrict(this.districts[0]);
    }
  }

  onSearch(query) {
    const q = query.trim().toLowerCase();
    this.ui.clear.hidden = !q;
    if (!q) {
      this.ui.results.hidden = true;
      this.ui.results.innerHTML = '';
      return;
    }
    const matches = this.districts
      .filter(d =>
        d.distrito.toLowerCase().includes(q) ||
        d.provincia.toLowerCase().includes(q) ||
        d.departamento.toLowerCase().includes(q) ||
        d.ubigeo.includes(q)
      )
      .slice(0, 8);

    if (!matches.length) {
      this.ui.results.innerHTML = '<li class="no-results">No se encontraron distritos.</li>';
    } else {
      this.ui.results.innerHTML = matches.map((d, i) => `
        <li data-ubigeo="${d.ubigeo}" role="option" ${i === 0 ? 'aria-selected="true"' : ''}>
          <span class="result-name">${this.escapeHtml(d.distrito)}</span>
          <span class="result-meta">${this.escapeHtml(d.departamento)} › ${this.escapeHtml(d.provincia)} · ${formatNumber(d.n_predios)} predios</span>
        </li>
      `).join('');
      this.ui.results.querySelectorAll('li[data-ubigeo]').forEach(li => {
        li.addEventListener('click', () => {
          const d = this.districts.find(x => x.ubigeo === li.dataset.ubigeo);
          if (d) this.selectDistrict(d);
        });
      });
    }
    this.ui.results.hidden = false;
  }

  onSearchKey(e) {
    const items = Array.from(this.ui.results.querySelectorAll('li[data-ubigeo]'));
    let idx = items.findIndex(li => li.getAttribute('aria-selected') === 'true');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = (idx + 1) % items.length;
      this.setActiveItem(items, idx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = idx <= 0 ? items.length - 1 : idx - 1;
      this.setActiveItem(items, idx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = items.find(li => li.getAttribute('aria-selected') === 'true') || items[0];
      const d = this.districts.find(x => x.ubigeo === active.dataset.ubigeo);
      if (d) this.selectDistrict(d);
    } else if (e.key === 'Escape') {
      this.ui.results.hidden = true;
    }
  }

  setActiveItem(items, idx) {
    items.forEach((li, i) => li.setAttribute('aria-selected', i === idx ? 'true' : 'false'));
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('sunarp-theme', next);
  }

  toggleBaseLayer() {
    if (this.baseMode === 'vector') {
      this.map.setStyle(BASE_SATELLITE);
      this.baseMode = 'satellite';
      this.ui.layer.title = 'Cambiar a vector';
    } else {
      this.map.setStyle(BASE_VECTOR);
      this.baseMode = 'vector';
      this.ui.layer.title = 'Cambiar a satélite';
    }
  }

  async selectDistrict(d) {
    this.ui.search.value = `${d.distrito}, ${d.provincia}`;
    this.ui.results.hidden = true;
    this.ui.sidebar.classList.add('open');

    this.current = d;
    this.ui.panelEmpty.hidden = true;
    this.ui.panelContent.hidden = false;
    this.ui.title.textContent = d.distrito;
    this.ui.breadcrumb.textContent = `${d.departamento} › ${d.provincia} › ${d.distrito}`;
    this.ui.count.textContent = formatCompact(d.n_predios);
    this.ui.count.title = formatNumber(d.n_predios);
    this.ui.area.textContent = formatCompact(d.area_total_m2);
    this.ui.area.title = `${formatNumber(d.area_total_m2)} m²`;
    this.ui.ha.textContent = formatCompact(d.area_total_m2 / 10000);
    this.ui.ha.title = `${formatAreaHa(d.area_total_m2)} ha`;

    this.setLoading(true);
    try {
      const res = await fetch(d.archivo);
      if (!res.ok) throw new Error(`No se pudo cargar ${d.archivo}`);
      const fc = await res.json();
      this.currentFeatures = fc.features || [];
      this.enrichFeatures();
      this.buildIndex();
      this.renderDistrictLayer();
      this.renderLegend();
      this.subset = [];
      this.ui.uploadResult.hidden = true;
      this.ui.upload.value = '';
    } catch (err) {
      console.error(err);
      alert('No se pudo cargar el distrito. Inténtalo de nuevo.');
    } finally {
      this.setLoading(false);
    }
  }

  enrichFeatures() {
    for (let i = 0; i < this.currentFeatures.length; i++) {
      const f = this.currentFeatures[i];
      f.properties._tip = normalizeType(f.properties.TIP_PRED);
    }
  }

  buildIndex() {
    if (!this.currentFeatures.length || typeof Flatbush !== 'function') {
      this.flatbush = null;
      return;
    }
    const index = new Flatbush(this.currentFeatures.length);
    for (const f of this.currentFeatures) {
      const bbox = turf.bbox(f);
      index.add(bbox[0], bbox[1], bbox[2], bbox[3]);
    }
    index.finish();
    this.flatbush = index;
  }

  renderDistrictLayer() {
    const sourceId = 'predios';
    const fillId = 'predios-fill';
    const lineId = 'predios-line';
    const hoverId = 'predios-hover';

    if (this.map.getLayer(hoverId)) this.map.removeLayer(hoverId);
    if (this.map.getLayer(lineId)) this.map.removeLayer(lineId);
    if (this.map.getLayer(fillId)) this.map.removeLayer(fillId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    const match = ['match', ['get', '_tip']];
    Object.entries(TYPE_COLORS).forEach(([k, v]) => match.push(k, v));
    match.push(TYPE_FALLBACK);

    this.map.addSource(sourceId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: this.currentFeatures },
      generateId: true
    });

    this.map.addLayer({
      id: fillId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': match,
        'fill-opacity': 0.35
      }
    });

    this.map.addLayer({
      id: lineId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#334155',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 0.8, 18, 1.2],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.25, 14, 0.45, 18, 0.7]
      }
    });

    this.map.addLayer({
      id: hoverId,
      type: 'line',
      source: sourceId,
      filter: ['boolean', false],
      paint: {
        'line-color': '#facc15',
        'line-width': 2,
        'line-opacity': 0.95
      }
    });

    this.fitCurrent();
  }

  fitCurrent() {
    if (!this.currentFeatures.length) return;
    const bbox = turf.bbox({ type: 'FeatureCollection', features: this.currentFeatures });
    const esMovil = window.matchMedia('(max-width: 720px)').matches;
    const hojaAbierta = esMovil && this.ui.sidebar.classList.contains('open');
    const padding = hojaAbierta
      ? { top: 76, bottom: Math.round(window.innerHeight * 0.58), left: 28, right: 28 }
      : { top: 40, bottom: 56, left: 40, right: 40 };
    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
                       { padding, duration: 700, maxZoom: 16 });
  }

  renderLegend() {
    const counts = {};
    let total = 0;
    for (const f of this.currentFeatures) {
      const t = f.properties._tip;
      counts[t] = (counts[t] || 0) + 1;
      total++;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    this.ui.legend.innerHTML = sorted.map(([t, n]) => {
      const pct = total ? ((n / total) * 100).toFixed(1) : '0.0';
      return `
        <div class="legend-item">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="legend-swatch" style="background:${TYPE_COLORS[t] || TYPE_FALLBACK};"></span>
            <span class="legend-type">${this.escapeHtml(TYPE_LABELS[t] || `Tipo ${t}`)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="legend-count">${formatNumber(n)}</span>
            <span class="legend-pct">${pct}%</span>
          </div>
        </div>
      `;
    }).join('');
  }

  setLoading(loading) {
    this.ui.title.style.opacity = loading ? '0.6' : '1';
  }

  onHover(e) {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    if (feature.id === this.hoveredId) return;
    this.hoveredId = feature.id;
    this.map.setFilter('predios-hover', ['==', ['id'], feature.id]);
    this.map.getCanvas().style.cursor = 'pointer';
    this.showTooltip(feature, e.point);
  }

  onHoverLeave() {
    this.hoveredId = null;
    this.map.setFilter('predios-hover', ['boolean', false]);
    this.map.getCanvas().style.cursor = '';
    this.hideTooltip();
  }

  showTooltip(feature, point) {
    this.hideTooltip();
    const el = document.createElement('div');
    el.className = 'map-tooltip';
    el.style.cssText = `
      position:absolute;left:${point.x + 12}px;top:${point.y + 12}px;
      background:rgba(15,23,42,.9);color:#fff;padding:6px 10px;border-radius:6px;
      font-size:12px;pointer-events:none;white-space:nowrap;z-index:100;
    `;
    const p = feature.properties;
    el.textContent = `${p.PART_REG || 'Sin partida'} · ${TYPE_LABELS[p._tip] || p._tip}`;
    this.tooltipEl = el;
    this.map.getContainer().appendChild(el);
  }

  hideTooltip() {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }

  onClick(e) {
    e.preventDefault();
    if (!e.features || !e.features.length) return;
    const f = e.features[0];
    const p = f.properties;
    const html = `
      <h3 class="popup-title">Predio ${p.PART_REG || '—'}</h3>
      <div class="popup-row"><span class="label">Oficina</span><span class="value">${p.COD_OFRE || '—'}</span></div>
      <div class="popup-row"><span class="label">Tipo</span><span class="value">${TYPE_LABELS[p._tip] || p._tip}</span></div>
      <div class="popup-row"><span class="label">Área</span><span class="value">${p.GEO_AREA ? formatNumber(p.GEO_AREA) + ' m²' : '—'}</span></div>
      <div class="popup-row"><span class="label">Fecha título</span><span class="value">${p.FEC_TIT_F || '—'}</span></div>
      <div class="popup-row"><span class="label">Asiento</span><span class="value">${p.ASIENTO_REG || '—'}</span></div>
      <div class="popup-row"><span class="label">Nº título</span><span class="value">${p.NUM_TIT || '—'}</span></div>
      <div class="popup-row"><span class="label">Dirección</span><span class="value">${p.DIR_REG || '—'}</span></div>
    `;
    this.closePopup();
    this.popup = new maplibregl.Popup({ maxWidth: '320px', anchor: 'bottom' })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(this.map);
  }

  closePopup() {
    if (this.popup) { this.popup.remove(); this.popup = null; }
  }

  downloadGeojson() {
    if (!this.current) return;
    fetch(this.current.archivo)
      .then(r => r.blob())
      .then(blob => downloadBlob(blob, `${this.current.ubigeo}_${this.current.distrito}.geojson`));
  }

  downloadCsv() {
    if (!this.currentFeatures.length) return;
    const rows = featuresToCsvRows(this.currentFeatures);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `${this.current.ubigeo}_${this.current.distrito}.csv`);
  }

  downloadXlsx() {
    if (!this.currentFeatures.length) return;
    const ws = featuresToWorksheet(this.currentFeatures);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Predios');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${this.current.ubigeo}_${this.current.distrito}.xlsx`);
  }

  async onUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!this.current) {
      alert('Primero selecciona un distrito para comparar.');
      this.ui.upload.value = '';
      return;
    }
    if (!this.currentFeatures.length) {
      alert('El distrito aún no tiene predios cargados.');
      this.ui.upload.value = '';
      return;
    }

    let uploaded;
    try {
      const buffer = await file.arrayBuffer();
      if (file.name.toLowerCase().endsWith('.zip')) {
        uploaded = await shp(buffer);
      } else {
        const text = new TextDecoder().decode(buffer);
        uploaded = JSON.parse(text);
      }
    } catch (err) {
      console.error(err);
      alert('No se pudo leer el archivo. Verifica que sea un GeoJSON o .zip de Shapefile válido.');
      this.ui.upload.value = '';
      return;
    }

    const inputFeatures = uploaded.type === 'FeatureCollection' ? (uploaded.features || []) : (uploaded.type === 'Feature' ? [uploaded] : []);
    if (!inputFeatures.length) {
      alert('El archivo no contiene geometrías.');
      this.ui.upload.value = '';
      return;
    }

    const inputFc = { type: 'FeatureCollection', features: inputFeatures };
    const inputBbox = turf.bbox(inputFc);

    // Stage 1: bbox filter with flatbush.
    let candidates = this.currentFeatures;
    if (this.flatbush) {
      const ids = this.flatbush.search(inputBbox[0], inputBbox[1], inputBbox[2], inputBbox[3]);
      candidates = ids.map(i => this.currentFeatures[i]);
    }

    // Stage 2: precise intersection with turf.
    const intersecting = [];
    for (const f of candidates) {
      try {
        if (turf.booleanIntersects(f, inputFc)) intersecting.push(f);
      } catch (_) {
        // Skip invalid geometries.
      }
    }

    this.subset = intersecting;
    this.ui.uploadCount.textContent = formatNumber(intersecting.length);
    this.ui.uploadResult.hidden = false;

    if (!intersecting.length) {
      this.ui.uploadResult.querySelector('p').innerHTML = 'Ningún predio del distrito intersecta tu área.';
    } else {
      this.ui.uploadResult.querySelector('p').innerHTML = `<strong id="upload-count">${formatNumber(intersecting.length)}</strong> predios intersectan tu área.`;
    }
  }

  downloadSubsetGeojson() {
    if (!this.subset.length) return;
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: this.subset })], { type: 'application/geo+json' });
    downloadBlob(blob, `${this.current.ubigeo}_${this.current.distrito}_seleccion.geojson`);
  }

  downloadSubsetCsv() {
    if (!this.subset.length) return;
    const rows = featuresToCsvRows(this.subset);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `${this.current.ubigeo}_${this.current.distrito}_seleccion.csv`);
  }

  downloadSubsetXlsx() {
    if (!this.subset.length) return;
    const ws = featuresToWorksheet(this.subset);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Seleccion');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${this.current.ubigeo}_${this.current.distrito}_seleccion.xlsx`);
  }
}

window.SunarpUtils = { normalizeType, formatNumber, formatAreaHa, featuresToCsvRows, featuresToWorksheet, downloadBlob };

new App();
