/* global maplibregl, XLSX, shp, flatgeobuf, Flatbush, turf */

const INDEX_URL = 'data/distritos/index.json';
const API = (window.SUNARP_CONFIG || {}).API_URL || '';
const API_KEY = (window.SUNARP_CONFIG || {}).API_KEY || '';
const R2 = (window.SUNARP_CONFIG || {}).R2_URL || '';
const PMTILES_URL = (window.SUNARP_CONFIG || {}).PMTILES_URL || '';
const LIMITE_MAPA_CFG = (window.SUNARP_CONFIG || {}).LIMITE_MAPA || 30000;
const LIMITE_MAPA = 3000;   // maximo de predios que se pintan en el mapa (evita crashear)
const BASE_VECTOR = 'https://tiles.openfreemap.org/styles/bright';
const BASE_BRIGHT = 'https://tiles.openfreemap.org/styles/bright';
const SAT_SOURCE = {
  type: 'raster',
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  attribution: 'Esri, Maxar, Earthstar Geographics'
};
const SAT_LAYER = 'satelite';

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

function normaliza(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
      downloadShp: document.getElementById('download-shp'),
      drawBtn: document.getElementById('draw-btn'),
      tilesBtn: document.getElementById('tiles-btn'),
      drawHint: document.getElementById('draw-hint'),
      drawCancel: document.getElementById('draw-cancel'),
      downloadCsv: document.getElementById('download-csv'),
      downloadXlsx: document.getElementById('download-xlsx'),
      searchWrap: document.querySelector('.search-wrap'),
      upload: document.getElementById('upload-file'),
      uploadResult: document.getElementById('upload-result'),
      uploadCount: document.getElementById('upload-count'),
      downloadSubsetGeojson: document.getElementById('download-subset-geojson'),
      downloadSubsetParquet: document.getElementById('download-subset-parquet'),
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
      this.addSatelliteLayer();
      this.loadDistricts();
    });

    this.map.on('style.load', () => {
      this.addSatelliteLayer();
      if (this.current) this.renderDistrictLayer();
    });

    this.map.on('mousemove', 'predios-fill', (e) => this.onHover(e));
    this.map.on('mouseleave', 'predios-fill', () => this.onHoverLeave());
    this.map.on('click', 'predios-fill', (e) => this.onClick(e));
    this.map.on('click', (e) => {
      if (this.dibujando) {
        this.puntos.push([e.lngLat.lng, e.lngLat.lat]);
        this.pintarDibujo();
        return;
      }
      if (!e.defaultPrevented) this.closePopup();
    });
    this.map.on('dblclick', (e) => {
      if (this.dibujando) {
        e.preventDefault();
        this.cerrarDibujo();
      }
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
    this.ui.downloadShp.addEventListener('click', () => this.downloadShp());
    this.ui.downloadCsv.addEventListener('click', () => this.downloadCsv());
    this.ui.downloadXlsx.addEventListener('click', () => this.downloadXlsx());

    this.ui.upload.addEventListener('change', (e) => this.onUpload(e));
    this.ui.drawBtn.addEventListener('click', () => this.iniciarDibujo());
    this.ui.tilesBtn.addEventListener('click', () => this.toggleTeselas());
    this.ui.drawCancel.addEventListener('click', () => this.cancelarDibujo());
    this.ui.downloadSubsetGeojson.addEventListener('click', () => this.downloadSubsetGeojson());
    this.ui.downloadSubsetParquet.addEventListener('click', () => this.downloadSubsetParquet());
    this.ui.downloadSubsetCsv.addEventListener('click', () => this.downloadSubsetCsv());
    this.ui.downloadSubsetXlsx.addEventListener('click', () => this.downloadSubsetXlsx());
  }

  async loadDistricts() {
    try {
      if (R2) {
        const res = await fetch(`${R2}/sunarp/distritos/index_web.json`);
        if (!res.ok) throw new Error(`R2 ${res.status}`);
        this.districts = await res.json();
      } else if (API && API_KEY) {
        this.districts = await this.loadIndexApi();
      } else {
        this.districts = await loadIndex();
      }
      if (R2) this.districts = await this.mezclarDemo(this.districts);
    } catch (err) {
      console.error(err);
      try {
        this.districts = await loadIndex();
      } catch (err2) {
        this.ui.results.innerHTML = '<li class="no-results">Error cargando distritos.</li>';
        this.ui.results.hidden = false;
        return;
      }
    }
    if (this.districts.length === 1) {
      this.selectDistrict(this.districts[0]);
    }
  }

  async mezclarDemo(datos) {
    // los 3 distritos de demo tienen archivo local (carga instantánea y completa)
    const locales = await loadIndex().catch(() => []);
    const porUbigeo = new Map(locales.map(d => [d.ubigeo, d]));
    return datos.map(d => ({ ...d, ...(porUbigeo.get(d.ubigeo) || {}) }));
  }

  async cargarFgb(url, max) {
    // la libreria exige un rect: el del Peru (el indice espacial del FGB filtra)
    const rect = this.current && this.current.bbox
      ? this.current.bbox
      : { minX: -81.5, minY: -18.5, maxX: -68.4, maxY: 0.5 };
    const feats = [];
    for await (const f of flatgeobuf.deserialize(url, rect)) {
      feats.push(f);
      if (feats.length >= max) break;
    }
    return { type: 'FeatureCollection', features: feats };
  }

  async loadIndexApi() {
    const res = await fetch(`${API}/distritos`, { headers: { 'X-API-Key': API_KEY } });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const datos = await res.json();
    const locales = await loadIndex().catch(() => []);
    const porUbigeo = new Map(locales.map(d => [d.ubigeo, d]));
    return datos.map(d => {
      const api = { ...d };
      delete api.archivo;
      delete api.bytes;
      return { ...api, ...(porUbigeo.get(d.ubigeo) || {}) };
    });
  }

  async cargarDesdeApi(d) {
    const url = `${API}/predios?ubigeo=${encodeURIComponent(d.ubigeo)}&formato=geojson&limite=${LIMITE_MAPA_CFG}&api_key=${encodeURIComponent(API_KEY)}`;
    const res = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const fc = await res.json();
    this.limitado = (fc.features || []).length < (d.n_predios || 0);
    return fc;
  }

  async cargarDistrito(d) {
    const esLocal = d.archivo && /^data\/distritos\/[\w-]+\.geojson$/.test(d.archivo);
    if (esLocal) {
      const res = await fetch(d.archivo);
      if (!res.ok) throw new Error(`No se pudo cargar ${d.archivo}`);
      this.limitado = false;
      return res.json();
    }
    if (d.fgb && R2) {
      const fc = await this.cargarFgb(d.fgb, LIMITE_MAPA_CFG);
      this.limitado = fc.features.length >= LIMITE_MAPA_CFG;
      return fc;
    }
    if (API && API_KEY) return this.cargarDesdeApi(d);
    throw new Error('Distrito no disponible');
  }

  onSearch(query) {
    const q = normaliza(query.trim());
    this.ui.clear.hidden = !q;
    if (!q) {
      this.ui.results.hidden = true;
      this.ui.results.innerHTML = '';
      return;
    }
    const matches = this.districts
      .filter(d =>
        normaliza(d.distrito).includes(q) ||
        normaliza(d.provincia).includes(q) ||
        normaliza(d.departamento).includes(q) ||
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
    const aSatelite = this.baseMode === 'vector';
    this.baseMode = aSatelite ? 'satellite' : 'vector';
    this.ui.layer.title = aSatelite ? 'Cambiar a vector' : 'Cambiar a satélite';
    if (!this.map.getLayer(SAT_LAYER)) this.addSatelliteLayer();
    if (this.map.getLayer(SAT_LAYER)) {
      this.map.setLayoutProperty(SAT_LAYER, 'visibility', aSatelite ? 'visible' : 'none');
    }
    this.applyPaintForMode();
  }

  addSatelliteLayer() {
    if (this.map.getLayer(SAT_LAYER)) return;
    if (!this.map.getSource('satelite')) this.map.addSource('satelite', SAT_SOURCE);
    const capas = (this.map.getStyle() && this.map.getStyle().layers) || [];
    const primera = capas.find(l => l.type !== 'background');
    const opciones = {
      id: SAT_LAYER,
      type: 'raster',
      source: 'satelite',
      layout: { visibility: this.baseMode === 'satellite' ? 'visible' : 'none' },
      paint: { 'raster-opacity': 1 }
    };
    if (primera) this.map.addLayer(opciones, primera.id);
    else this.map.addLayer(opciones);
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
      const fc = await this.cargarDistrito(d);
      this.currentFeatures = fc.features || [];
      this.enrichFeatures();
      this.buildIndex();
      this.renderDistrictLayer();
      this.renderLegend();
      this.mostrarAvisoVistaPrevia();
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

  mostrarAvisoVistaPrevia() {
    let aviso = document.getElementById('aviso-vista-previa');
    if (!aviso) {
      aviso = document.createElement('p');
      aviso.id = 'aviso-vista-previa';
      aviso.className = 'aviso-vista-previa';
      this.ui.panelContent.prepend(aviso);
    }
    aviso.hidden = true;
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
    const haloId = 'predios-halo';
    const lineId = 'predios-line';
    const hoverId = 'predios-hover';

    if (this.map.getLayer(hoverId)) this.map.removeLayer(hoverId);
    if (this.map.getLayer(lineId)) this.map.removeLayer(lineId);
    if (this.map.getLayer(haloId)) this.map.removeLayer(haloId);
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
      id: haloId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.0, 14, 2.2, 18, 3.0],
        'line-opacity': 0
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

    this.applyPaintForMode();
    this.fitCurrent();
  }

  applyPaintForMode() {
    if (!this.map.getLayer('predios-fill')) return;
    const sat = this.baseMode === 'satellite';
    this.map.setPaintProperty('predios-fill', 'fill-opacity', sat ? 0.18 : 0.35);
    this.map.setPaintProperty('predios-line', 'line-color', sat ? '#22d3ee' : '#334155');
    this.map.setPaintProperty('predios-line', 'line-width',
      sat ? ['interpolate', ['linear'], ['zoom'], 10, 1.6, 13, 1.2, 15, 0.9, 18, 0.8]
          : ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 0.8, 18, 1.2]);
    this.map.setPaintProperty('predios-line', 'line-opacity', sat ? 0.95 : 0.45);
    this.map.setPaintProperty('predios-halo', 'line-opacity',
      sat ? ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 0.35, 16, 0]
          : 0);
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
    const feats = this.map.queryRenderedFeatures(e.point, { layers: ['predios-fill'] });
    if (!feats || !feats.length) return;
    const porPartida = new Map();
    for (const f of feats) {
      const k = `${f.properties.PART_REG || 'x'}|${f.properties.capa || ''}`;
      if (!porPartida.has(k)) porPartida.set(k, f);
    }
    const lista = Array.from(porPartida.values()).sort(
      (a, b) => (a.properties.GEO_AREA || 0) - (b.properties.GEO_AREA || 0));

    if (lista.length === 1) {
      this.mostrarDetalle(e.lngLat, lista[0].properties);
      return;
    }

    const html = `
      <h3 class="popup-title">${lista.length} predios en este punto</h3>
      <p class="popup-hint">Elige cuál ver (del más chico al más grande):</p>
      <div class="popup-pick">
        ${lista.map((f, i) => {
          const p = f.properties;
          const color = TYPE_COLORS[p._tip] || TYPE_FALLBACK;
          return `<button class="pick-row" data-i="${i}" data-id="${f.id}">
            <span class="pick-chip" style="background:${color}"></span>
            <span class="pick-text">
              <span class="pick-partida">${p.PART_REG || 'sin partida'}</span>
              <span class="pick-meta">${TYPE_LABELS[p._tip] || '—'} · ${formatNumber(p.GEO_AREA || 0)} m²</span>
              <span class="pick-capa">${(p.capa || '').replace(/^(BGR|BGI)_/, '').replace(/_/g, ' ')}</span>
            </span>
            <span class="pick-chevron" aria-hidden="true">›</span>
          </button>`;
        }).join('')}
      </div>`;
    this.closePopup();
    this.popup = new maplibregl.Popup({ maxWidth: '340px', anchor: 'bottom' })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(this.map);
    const el = this.popup.getElement();
    el.querySelectorAll('.pick-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const f = lista[Number(btn.dataset.i)];
        this.mostrarDetalle(this.popup.getLngLat(), f.properties);
      });
      btn.addEventListener('mouseenter', () => {
        const id = Number(btn.dataset.id);
        if (!Number.isNaN(id) && this.map.getLayer('predios-hover')) {
          this.map.setFilter('predios-hover', ['==', ['id'], id]);
        }
      });
      btn.addEventListener('mouseleave', () => {
        if (this.map.getLayer('predios-hover')) {
          this.map.setFilter('predios-hover', ['boolean', false]);
        }
      });
    });
  }

  mostrarDetalle(lngLat, p) {
    const filas = [
      ['Oficina', p.COD_OFRE],
      ['Tipo', TYPE_LABELS[p._tip] || p._tip],
      ['Área', p.GEO_AREA ? formatNumber(p.GEO_AREA) + ' m²' : ''],
      ['Fecha título', p.FEC_TIT_F],
      ['Asiento', p.ASIENTO_REG],
      ['Nº título', p.NUM_TIT],
      ['Dirección', p.DIR_REG],
    ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '—');
    const html = `
      <h3 class="popup-title">Predio ${p.PART_REG || '—'}</h3>
      ${filas.map(([k, v]) => `<div class="popup-row"><span class="label">${k}</span><span class="value">${v}</span></div>`).join('')}
    `;
    this.closePopup();
    this.popup = new maplibregl.Popup({ maxWidth: '320px', anchor: 'bottom' })
      .setLngLat(lngLat)
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

  downloadShp() {
    if (!this.current) return;
    if (!this.current.shp) {
      alert('El shapefile de este distrito todavía no está disponible. Usa GeoJSON.');
      return;
    }
    fetch(this.current.shp)
      .then(r => {
        if (!r.ok) throw new Error('no disponible');
        return r.blob();
      })
      .then(blob => downloadBlob(blob, `${this.current.ubigeo}_${this.current.distrito}_shp.zip`.replace(/[^\w.-]+/g, '_')))
      .catch(() => alert('No se pudo descargar el shapefile. Usa GeoJSON.'));
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

  toggleTeselas() {
    if (!API && !PMTILES_URL) {
      alert('Las teselas estarán disponibles en unos minutos (generándose en el servidor).');
      return;
    }
    const activo = this.map.getLayer('pais-fill') !== undefined;
    if (activo) {
      for (const capa of ['pais-fill', 'pais-line']) {
        if (this.map.getLayer(capa)) this.map.removeLayer(capa);
      }
      if (this.map.getSource('pais')) this.map.removeSource('pais');
      this.ui.tilesBtn.classList.remove('activo');
      return;
    }
    if (PMTILES_URL) {
      this.map.addSource('pais', { type: 'vector', url: `pmtiles://${PMTILES_URL}`, minzoom: 11, maxzoom: 15 });
    } else {
      this.map.addSource('pais', {
        type: 'vector',
        tiles: [`${API}/tiles/{z}/{x}/{y}.mvt?api_key=${encodeURIComponent(API_KEY)}`],
        minzoom: 8,
        maxzoom: 18
      });
    }
    const antes = this.map.getLayer('predios-fill') ? 'predios-fill'
      : (this.map.getLayer(SAT_LAYER) ? SAT_LAYER : undefined);
    this.map.addLayer({
      id: 'pais-fill',
      type: 'fill',
      source: 'pais',
      'source-layer': 'predios',
      minzoom: 8,
      paint: {
        'fill-color': '#7c3aed',
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.12, 11, 0.17, 13, 0.22, 16, 0.34]
      }
    }, antes);
    this.map.addLayer({
      id: 'pais-line',
      type: 'line',
      source: 'pais',
      'source-layer': 'predios',
      minzoom: 8,
      paint: {
        'line-color': '#4c1d95',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 11, 0.4, 14, 0.7, 18, 1.0],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.25, 11, 0.4, 14, 0.6, 18, 0.8]
      }
    }, antes);
    this.ui.tilesBtn.classList.add('activo');
    if (this.map.getZoom() < 11) {
      // a zoom de pais no hay detalle: acercarse, respetando donde esta mirando
      const c = this.map.getCenter();
      const enPeru = c.lng > -81.5 && c.lng < -68.4 && c.lat > -18.5 && c.lat < 0.5;
      this.map.flyTo({ center: enPeru ? [c.lng, c.lat] : [-77.03, -12.05],
                       zoom: 12, duration: 2000 });
    }
  }

  iniciarDibujo() {
    this.dibujando = true;
    this.puntos = [];
    this.map.getCanvas().style.cursor = 'crosshair';
    this.ui.drawHint.hidden = false;
    if (!this.map.getSource('dibujo')) {
      this.map.addSource('dibujo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({ id: 'dibujo-fill', type: 'fill', source: 'dibujo',
        paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.15 } });
      this.map.addLayer({ id: 'dibujo-line', type: 'line', source: 'dibujo',
        paint: { 'line-color': '#0891b2', 'line-width': 2 } });
    }
  }

  pintarDibujo() {
    const coords = this.puntos.concat(this.puntos.length > 2 ? [this.puntos[0]] : []);
    const fuente = this.map.getSource('dibujo');
    if (!fuente) return;
    fuente.setData({
      type: 'FeatureCollection',
      features: this.puntos.length ? [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords }
      }] : []
    });
  }

  cancelarDibujo() {
    this.dibujando = false;
    this.puntos = [];
    this.ui.drawHint.hidden = true;
    this.map.getCanvas().style.cursor = '';
    const fuente = this.map.getSource('dibujo');
    if (fuente) fuente.setData({ type: 'FeatureCollection', features: [] });
  }

  async cerrarDibujo() {
    if (this.puntos.length < 3) {
      alert('Marca al menos 3 puntos.');
      return;
    }
    const anillo = this.puntos.concat([this.puntos[0]]);
    this.dibujando = false;
    this.ui.drawHint.hidden = true;
    this.map.getCanvas().style.cursor = '';
    const fuente = this.map.getSource('dibujo');
    if (fuente) {
      fuente.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [anillo] } }]
      });
    }
    this.areaNombre = 'dibujada';
    await this.buscarPorArea({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [anillo] } }]
    });
  }

  async onUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    let uploaded;
    try {
      const buffer = await file.arrayBuffer();
      if (file.name.toLowerCase().endsWith('.zip')) {
        uploaded = await shp(buffer);
      } else {
        uploaded = JSON.parse(new TextDecoder().decode(buffer));
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
    this.areaNombre = file.name.replace(/\.(geojson|json|zip)$/i, '');

    if (API && API_KEY) {
      await this.buscarPorArea(inputFc);
      return;
    }

    // Sin API: se resuelve en el navegador con la capa de distritos y los FGB de R2
    if (R2) {
      this.areaNombre = file.name.replace(/\.(geojson|json|zip)$/i, '');
      await this.buscarPorArea(inputFc);
      return;
    }
    if (!this.current || !this.currentFeatures.length) {
      alert('Sube un distrito primero para poder comparar.');
      this.ui.upload.value = '';
      return;
    }
    const inputBbox = turf.bbox(inputFc);
    let candidates = this.currentFeatures;
    if (this.flatbush) {
      const ids = this.flatbush.search(inputBbox[0], inputBbox[1], inputBbox[2], inputBbox[3]);
      candidates = ids.map(i => this.currentFeatures[i]);
    }
    const intersecting = [];
    for (const f of candidates) {
      try {
        if (turf.booleanIntersects(f, inputFc)) intersecting.push(f);
      } catch (_) { /* geometria invalida */ }
    }
    this.subset = intersecting;
    this.subsetLimitado = false;
    this.mostrarResultadoArea();
  }

  async buscarPorAreaLocal(inputFc) {
    // Todo en el navegador: los distritos que tocan el area se piden al FGB de R2
    // (su indice espacial solo lee los bytes necesarios) y de cada uno se traen
    // los predios con el mismo rect.
    const bbox = turf.bbox(inputFc);
    const rect = { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] };
    const distritos = [];
    console.log('LOCAL rect', JSON.stringify(rect));
    for await (const d of flatgeobuf.deserialize(`${R2}/sunarp/capas/distritos_capa.fgb`, rect)) {
      try {
        if (turf.booleanIntersects(d, inputFc)) distritos.push(d);
      } catch (_) { /* geometria invalida */ }
    }
    console.log('LOCAL distritos', distritos.length);
    const vistos = new Set();
    const salida = [];
    const tope = LIMITE_MAPA_CFG * 2;
    for (const d of distritos) {
      const ubigeo = d.properties.UBIGEO;
      try {
        for await (const f of flatgeobuf.deserialize(`${R2}/sunarp/distritos/${ubigeo}.fgb`, rect)) {
          const clave = `${f.properties.PART_REG}|${f.properties.OID}`;
          if (vistos.has(clave)) continue;
          try {
            if (!turf.booleanIntersects(f, inputFc)) continue;
          } catch (_) { continue; }
          vistos.add(clave);
          salida.push(f);
          if (salida.length >= tope) break;
        }
      } catch (err) {
        console.warn('distrito', ubigeo, err);
      }
      console.log('LOCAL tras', ubigeo, salida.length);
      if (salida.length >= tope) break;
    }
    return { type: 'FeatureCollection', features: salida };
  }

  async buscarPorArea(inputFc) {
    this.setLoading(true);
    try {
      this.areaGeojson = inputFc;
      if (R2 && !API) {
        console.log('AREA-R2 inicio');
        const fc = await this.buscarPorAreaLocal(inputFc);
        console.log('AREA-R2 resultado', fc.features.length);
        this.subset = fc.features.slice(0, LIMITE_MAPA_CFG);
        this.subsetTotal = fc.features.length;
        this.subsetLimitado = fc.features.length > this.subset.length;
        this.mostrarResultadoArea();
        return;
      }
      const url = `${API}/predios?formato=geojson&limite=${LIMITE_MAPA}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(inputFc)
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const total = parseInt(res.headers.get('X-Total-Predios') || '0', 10);
      const fc = await res.json();
      this.subset = fc.features || [];
      this.subsetTotal = total || this.subset.length;
      this.subsetLimitado = this.subsetTotal > this.subset.length;
      this.mostrarResultadoArea();
    } catch (err) {
      console.error(err);
      alert('No se pudo consultar el área. Inténtalo de nuevo.');
    } finally {
      this.setLoading(false);
    }
  }

  mostrarResultadoArea() {
    const n = this.subset.length;
    this.ui.uploadCount.textContent = formatNumber(n);
    this.ui.uploadResult.hidden = false;
    const p = this.ui.uploadResult.querySelector('p');
    if (!n) {
      p.innerHTML = 'Ningún predio intersecta tu área.';
      return;
    }
    const total = this.subsetTotal || n;
    p.innerHTML = `<strong id="upload-count">${formatNumber(total)}</strong> predios en tu área` +
      (this.subsetLimitado ? ` <span class="aviso-inline">(${formatNumber(n)} dibujados en el mapa; descarga el archivo para el total)</span>` : '.');
    this.pintarResultadoArea();
  }

  pintarResultadoArea() {
    const srcId = 'area-resultado';
    for (const capa of [srcId + '-line', srcId + '-fill']) {
      if (this.map.getLayer(capa)) this.map.removeLayer(capa);
    }
    if (this.map.getSource(srcId)) this.map.removeSource(srcId);
    if (!this.subset || !this.subset.length) return;

    this.map.addSource(srcId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: this.subset }
    });
    this.map.addLayer({
      id: srcId + '-fill', type: 'fill', source: srcId,
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.5 }
    });
    this.map.addLayer({
      id: srcId + '-line', type: 'line', source: srcId,
      paint: { 'line-color': '#b45309', 'line-width': 1.4 }
    });
    try {
      const bbox = turf.bbox({ type: 'FeatureCollection', features: this.subset });
      this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
                         { padding: 70, duration: 800, maxZoom: 16 });
    } catch (_) { /* bbox invalido */ }
  }

  async _descargarArea(formato, ext) {
    if (!this.areaGeojson) {
      if (!this.subset || !this.subset.length) return;
      const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: this.subset })],
                            { type: 'application/geo+json' });
      downloadBlob(blob, `area_${(this.areaNombre || 'seleccion')}_predios.${ext}`);
      return;
    }
    const boton = document.activeElement;
    if (boton) boton.disabled = true;
    try {
      const res = await fetch(`${API}/predios?formato=${formato}&limite=200000`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.areaGeojson)
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const blob = await res.blob();
      downloadBlob(blob, `area_${(this.areaNombre || 'seleccion')}_predios.${ext}`);
    } catch (err) {
      console.error(err);
      alert('No se pudo descargar el área completa.');
    } finally {
      if (boton) boton.disabled = false;
    }
  }

  downloadSubsetGeojson() {
    if (this.areaGeojson) return this._descargarArea('geojson', 'geojson');
    if (!this.subset || !this.subset.length) return;
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: this.subset })], { type: 'application/geo+json' });
    downloadBlob(blob, `area_${(this.areaNombre || 'seleccion')}_predios.geojson`);
  }

  downloadSubsetParquet() {
    return this._descargarArea('geoparquet', 'parquet');
  }

  downloadSubsetCsv() {
    if (this.areaGeojson) return this._descargarArea('csv', 'csv');
    if (!this.subset || !this.subset.length) return;
    const rows = featuresToCsvRows(this.subset);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `area_${(this.areaNombre || 'seleccion')}_predios.csv`);
  }

  downloadSubsetXlsx() {
    if (!this.subset || !this.subset.length) return;
    const ws = featuresToWorksheet(this.subset);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Seleccion');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `area_${(this.areaNombre || 'seleccion')}_predios.xlsx`);
  }
}

window.SunarpUtils = { normalizeType, formatNumber, formatAreaHa, featuresToCsvRows, featuresToWorksheet, downloadBlob };

window.__sunarp = new App();
