const fmt0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

const UX = {
  map: null,
  boundary: null,
  data: null,
  boundaryRecords: [],
  boundaryById: new Map(),
  boundaryByKey: new Map(),
  activeBoundaryId: null,
  hint: null
};

function normalize(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'\"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;'
  }[ch]));
}

function number(value, digits = 0) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return (digits ? fmt2 : fmt0).format(Number(value));
}

function unitKey(name, type, province) {
  return `${normalize(province)}|${normalize(type)}|${normalize(name)}`;
}

function codeOf(record) {
  const raw = record?.code ?? record?.ma ?? record?.admin_code ?? record?.ma_dvhc ?? '';
  const s = String(raw).trim();
  return s ? s.padStart(5, '0') : '';
}

function isProvinceRecord(record) {
  if (!record) return false;
  if (record.level === 'province') return true;
  const t = normalize(record.type);
  return t === 'tinh' || t === 'thanh pho' || t.includes('cap tinh');
}

function parseBBox(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 4) {
    const nums = value.slice(0, 4).map(Number);
    return nums.every(Number.isFinite) ? nums : null;
  }
  if (typeof value === 'string') {
    const nums = value.match(/-?\d+(?:\.\d+)?/g)?.slice(0, 4).map(Number);
    return nums?.length === 4 && nums.every(Number.isFinite) ? nums : null;
  }
  if (typeof value === 'object') {
    const candidates = [
      [value.minx, value.miny, value.maxx, value.maxy],
      [value.west, value.south, value.east, value.north],
      [value.min_lon, value.min_lat, value.max_lon, value.max_lat]
    ];
    for (const candidate of candidates) {
      const nums = candidate.map(Number);
      if (nums.every(Number.isFinite)) return nums;
    }
  }
  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function loadAdminData() {
  const payload = await fetchJson('./data/admin.json');
  if (!Array.isArray(payload.provinces) || payload.provinces.length !== 34) throw new Error('admin.json thiếu 34 tỉnh/thành');
  if (!Array.isArray(payload.units) || payload.units.length !== 3321) throw new Error('admin.json thiếu 3.321 đơn vị cấp xã');
  UX.data = payload;
}

async function loadBoundaryIndex() {
  const urls = [
    '/anhmap/index.html',
    'https://cdn.jsdelivr.net/gh/Vietflexmap/anhmap@e80f4ee9f1e167817e4a9af8402c0bca4052573e/index.html'
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const node = doc.getElementById('adminData');
      if (!node) throw new Error('không có adminData');
      const payload = JSON.parse(node.textContent);
      UX.boundaryRecords = payload.records || [];
      for (const record of UX.boundaryRecords) {
        UX.boundaryById.set(String(record.id), record);
        if (!isProvinceRecord(record)) {
          UX.boundaryByKey.set(unitKey(record.name, record.type, record.province), record);
        }
      }
      return;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  console.warn('Không nạp được boundary index cho UX', errors.join(' | '));
}

function findBoundaryLayer(map) {
  let found = null;
  map.eachLayer?.(layer => {
    if (!found && typeof layer.featureAt === 'function' && typeof layer.setSelected === 'function') found = layer;
  });
  return found;
}

async function waitForBoundary(map) {
  for (let i = 0; i < 120; i += 1) {
    const found = findBoundaryLayer(map);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  return null;
}

function enhanceBoundaryPaint(boundary) {
  if (!boundary || boundary.__sapnhapEnhancedPaint || typeof boundary._paint !== 'function') return;
  const original = boundary._paint.bind(boundary);
  boundary._paint = function enhancedPaint(ctx, size, features) {
    original(ctx, size, features);
    for (const feature of features) {
      if (!this.selectedIds?.has(String(feature.properties?.id))) continue;
      ctx.save();
      ctx.beginPath();
      for (const ring of feature.geometry || []) {
        if (!ring.length) continue;
        ring.forEach((pt, index) => {
          const x = pt.x / feature.extent * size;
          const y = pt.y / feature.extent * size;
          if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(255, 214, 0, .72)';
      ctx.fill('evenodd');
      ctx.strokeStyle = '#d40000';
      ctx.lineWidth = 4.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(150, 0, 0, .30)';
      ctx.shadowBlur = 3;
      ctx.stroke();
      ctx.restore();
    }
  };
  boundary.__sapnhapEnhancedPaint = true;
  boundary.redraw?.();
}

function resolveItem(record) {
  if (!record || !UX.data) return null;
  const recordCode = codeOf(record);
  if (recordCode) {
    const byCode = UX.data.units.find(unit => String(unit.code).padStart(5, '0') === recordCode);
    if (byCode) return byCode;
  }
  if (isProvinceRecord(record)) {
    const targets = [record.name, record.province, record.full_name].map(normalize).filter(Boolean);
    return UX.data.provinces.find(p => targets.includes(normalize(p.name)) || targets.includes(normalize(p.full_name))) || null;
  }
  const key = unitKey(record.name, record.type, record.province);
  return UX.data.units.find(unit => unitKey(unit.name, unit.type, unit.province_name) === key) ||
    UX.data.units.find(unit => normalize(unit.name) === normalize(record.name) && normalize(unit.province_name) === normalize(record.province)) ||
    null;
}

function findRecordForItem(item) {
  if (!item) return null;
  if (item.id?.startsWith('p:')) {
    const pName = normalize(item.name);
    const pFull = normalize(item.full_name);
    return UX.boundaryRecords.find(record => {
      if (!isProvinceRecord(record)) return false;
      const names = [record.name, record.province, record.full_name].map(normalize);
      return names.includes(pName) || names.includes(pFull);
    }) || null;
  }

  const itemCode = String(item.code || '').padStart(5, '0');
  if (itemCode && itemCode !== '00000') {
    const byCode = UX.boundaryRecords.find(record => !isProvinceRecord(record) && codeOf(record) === itemCode);
    if (byCode) return byCode;
  }

  const exact = UX.boundaryByKey.get(unitKey(item.name, item.type, item.province_name));
  if (exact) return exact;

  const name = normalize(item.name);
  const province = normalize(item.province_name);
  return UX.boundaryRecords.find(record =>
    !isProvinceRecord(record) &&
    normalize(record.name) === name &&
    normalize(record.province) === province
  ) || null;
}

function fitItem(item) {
  if (!UX.map || !item) return;
  const bbox = parseBBox(item.bbox);
  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    UX.map.fitBounds([[minLat, minLon], [maxLat, maxLon]], {
      animate: true,
      duration: 0.38,
      paddingTopLeft: window.innerWidth > 800 ? [46, 46] : [18, 74],
      paddingBottomRight: window.innerWidth > 800 ? [46, 46] : [18, 24],
      maxZoom: item.id?.startsWith('p:') ? 8 : 13
    });
    return;
  }
  if (item.centroid_lat != null && item.centroid_lon != null) {
    UX.map.setView([item.centroid_lat, item.centroid_lon], item.id?.startsWith('p:') ? 7 : 12, { animate: true });
  }
}

function statBox(label, value, unit = '') {
  return `<div class="admin-popup-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</div>`;
}

function popupHtml(item) {
  const province = item.id?.startsWith('p:');
  const typeLabel = item.type || (province ? 'tỉnh/thành' : 'đơn vị cấp xã');
  const subtitle = province
    ? `${number(item.commune_level_count)} đơn vị cấp xã`
    : `${escapeHtml(item.province_full_name || item.province_name || '')}${item.code ? ` · Mã ĐVHC ${escapeHtml(item.code)}` : ''}`;
  const structure = province
    ? `<div class="admin-popup-row"><span>Cơ cấu</span><b>${number(item.counts_by_type?.['phường'])} phường · ${number(item.counts_by_type?.['xã'])} xã · ${number(item.counts_by_type?.['đặc khu'])} đặc khu</b></div>`
    : '';
  const sourceLabel = province ? 'Nguồn hình thành' : 'Được sắp xếp từ';
  const sourceValue = province ? item.merge_origin : item.merged_from;

  return `<article class="admin-focus-card" role="dialog" aria-label="Thông tin ${escapeHtml(item.full_name)}">
    <header class="admin-popup-head">
      <div class="admin-popup-type">${escapeHtml(typeLabel)}</div>
      <h2>${escapeHtml(item.full_name)}</h2>
      <p>${subtitle}</p>
    </header>
    <section class="admin-popup-stats">
      ${statBox('Diện tích', number(item.area_km2, 2), 'km²')}
      ${statBox('Dân số', number(item.population_2025), 'người')}
      ${statBox('Mật độ', number(item.density), 'người/km²')}
    </section>
    <section class="admin-popup-body">
      ${structure}
      <div class="admin-popup-row"><span>Trung tâm hành chính</span><b>${escapeHtml(item.administrative_center || '—')}</b></div>
      <div class="admin-popup-row"><span>${sourceLabel}</span><b>${escapeHtml(sourceValue || '—')}</b></div>
      ${item.resolution ? `<div class="admin-popup-row"><span>Căn cứ / Nghị quyết</span><b>${escapeHtml(item.resolution)}</b></div>` : ''}
    </section>
    <footer class="admin-popup-footer">
      <span><i></i> Nền vàng · viền đỏ = đơn vị đang chọn</span>
      <button type="button" class="admin-popup-close" data-admin-popup-close>Đóng</button>
    </footer>
  </article>`;
}

function showHint() {
  if (document.querySelector('.map-interaction-hint')) return;
  const wrap = document.querySelector('.map-wrap');
  if (!wrap) return;
  const hint = document.createElement('div');
  hint.className = 'map-interaction-hint';
  hint.innerHTML = '<span class="gesture-icon">◎</span><span><b>Chọn đơn vị trên bản đồ</b><small>Nhấp đúp hoặc chạm 2 lần để mở thông tin đầy đủ</small></span>';
  wrap.appendChild(hint);
  UX.hint = hint;
  if (localStorage.getItem('sapnhap-focus-hint-seen') === '1') hint.classList.add('compact');
}

function dismissHint() {
  try { localStorage.setItem('sapnhap-focus-hint-seen', '1'); } catch (_) {}
  UX.hint?.classList.add('compact');
}

function selectBoundary(record) {
  if (!record || !UX.boundary) return false;
  const id = String(record.id ?? '');
  if (!id) return false;
  UX.activeBoundaryId = id;
  UX.boundary.setSelected([id]);
  return true;
}

function openRichPopup(item, latlng) {
  if (!UX.map || !item) return;
  const anchor = latlng || (item.centroid_lat != null && item.centroid_lon != null ? [item.centroid_lat, item.centroid_lon] : UX.map.getCenter());
  UX.map.openPopup(popupHtml(item), anchor, {
    className: 'admin-focus-popup',
    maxWidth: 470,
    minWidth: Math.min(320, Math.max(260, window.innerWidth - 36)),
    closeButton: true,
    autoPan: true,
    autoPanPaddingTopLeft: window.innerWidth > 800 ? [390, 86] : [18, 72],
    autoPanPaddingBottomRight: [18, 24],
    keepInView: true
  });
  requestAnimationFrame(() => {
    document.querySelector('[data-admin-popup-close]')?.addEventListener('click', () => UX.map.closePopup());
    document.querySelector('.admin-focus-popup .leaflet-popup-close-button')?.setAttribute('aria-label', 'Đóng cửa sổ thông tin');
  });
}

function focusItemFromUI(item, { popup = false, fit = true } = {}) {
  if (!item || !UX.boundary) return;
  const record = findRecordForItem(item);
  if (!record) {
    console.warn('Không tìm thấy ranh giới cho đơn vị đang chọn', item);
    return;
  }
  selectBoundary(record);
  if (fit) fitItem(item);
  if (popup) setTimeout(() => openRichPopup(item), 180);
  dismissHint();
}

async function identifyAndFocus(event) {
  if (!UX.boundary || !UX.data || !event?.latlng) return;
  try {
    const feature = await UX.boundary.featureAt(event.latlng, UX.map.getZoom(), UX.map);
    if (!feature) return;
    const id = String(feature.properties?.id ?? '');
    const record = UX.boundaryById.get(id) || feature.properties || null;
    const item = resolveItem(record);
    if (!item) {
      console.warn('Không ghép được ranh giới với master data', record);
      return;
    }
    UX.activeBoundaryId = id;
    UX.boundary.setSelected([id]);
    fitItem(item);
    setTimeout(() => openRichPopup(item, event.latlng), 190);
    dismissHint();
  } catch (error) {
    console.warn('Identify/focus failed', error);
  }
}

function itemFromClickedElement(target) {
  const searchHit = target.closest?.('.search-hit[data-id]');
  if (searchHit) {
    const id = searchHit.dataset.id;
    return [...(UX.data?.provinces || []), ...(UX.data?.units || [])].find(x => x.id === id) || null;
  }

  const unitButton = target.closest?.('.unit-item');
  if (unitButton) {
    const code = unitButton.querySelector('code')?.textContent?.trim();
    if (code) return UX.data?.units.find(x => String(x.code).padStart(5, '0') === code.padStart(5, '0')) || null;
    const name = unitButton.querySelector('strong')?.textContent?.trim();
    return UX.data?.units.find(x => normalize(x.full_name) === normalize(name)) || null;
  }
  return null;
}

function installUiSelectionSync() {
  document.addEventListener('click', event => {
    const item = itemFromClickedElement(event.target);
    if (!item) return;
    setTimeout(() => focusItemFromUI(item, { popup: false, fit: true }), 0);
  }, false);
}

function installMapUX() {
  if (!UX.map || !UX.boundary) return;
  enhanceBoundaryPaint(UX.boundary);
  UX.map.doubleClickZoom?.disable?.();
  UX.map.on('dblclick', identifyAndFocus);
  showHint();
  installUiSelectionSync();

  // Expose one canonical focus API so future UI pieces reuse the same selection path.
  window.__SAPNHAP_FOCUS_ITEM__ = (item, options = {}) => focusItemFromUI(item, options);
  window.__SAPNHAP_CLEAR_SELECTION__ = () => {
    UX.activeBoundaryId = null;
    UX.boundary?.setSelected([]);
  };
}

async function bootstrapUX() {
  for (let i = 0; i < 100 && !window.__SAPNHAP_MAP__; i += 1) await new Promise(resolve => setTimeout(resolve, 100));
  UX.map = window.__SAPNHAP_MAP__;
  if (!UX.map) {
    console.warn('Không nhận được map instance từ Vietflex');
    return;
  }

  const [dataResult, boundaryIndexResult] = await Promise.allSettled([loadAdminData(), loadBoundaryIndex()]);
  if (dataResult.status === 'rejected') {
    console.warn('Không thể khởi tạo lớp UX popup', dataResult.reason);
    return;
  }
  if (boundaryIndexResult.status === 'rejected') console.warn('Boundary index fallback failed', boundaryIndexResult.reason);

  UX.boundary = await waitForBoundary(UX.map);
  if (!UX.boundary) {
    console.warn('Không tìm thấy BoundaryLayer cho lớp UX');
    return;
  }
  installMapUX();
}

bootstrapUX();
