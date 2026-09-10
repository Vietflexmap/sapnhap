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

function shortProvince(text = '') {
  return String(text).replace(/^(Thủ đô|Thành phố|Tỉnh)\s+/i, '').trim();
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
  return `${normalize(shortProvince(province))}|${normalize(type)}|${normalize(name)}`;
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
  // Painting is owned by tile-seam-fix.js. Do not wrap _paint here: a second
  // canvas pass makes native z9 tiles scale a second red/yellow outline at
  // high zoom and produces the large red block seen in the UI.
  if (!boundary) return;
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
    return makeProvinceRecord(item);
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

function provinceRecordsFor(itemOrRecord) {
  if (!itemOrRecord) return [];
  const provinceCode = String(itemOrRecord.province_code ?? itemOrRecord.order ?? '').trim();
  const names = [
    itemOrRecord.name,
    itemOrRecord.full_name,
    itemOrRecord.province,
    itemOrRecord.province_full_name
  ].map(normalize).filter(Boolean);
  return UX.boundaryRecords.filter(record => {
    if (isProvinceRecord(record)) return false;
    if (provinceCode && String(record.province_code ?? '').trim() === provinceCode) return true;
    return names.includes(normalize(record.province));
  });
}

function unionBBox(records) {
  const boxes = records.map(record => parseBBox(record.bbox)).filter(Boolean);
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map(box => box[0])),
    Math.min(...boxes.map(box => box[1])),
    Math.max(...boxes.map(box => box[2])),
    Math.max(...boxes.map(box => box[3]))
  ];
}

function makeProvinceRecord(item) {
  const records = provinceRecordsFor(item);
  const provinceName = records[0]?.province || item.province_full_name || item.full_name || item.name;
  return {
    id: `P_${String(item.order ?? '').replace(/^0+/, '') || '0'}`,
    name: provinceName,
    full_name: provinceName,
    type: item.type || 'tỉnh',
    province: provinceName,
    province_code: String(item.order ?? ''),
    level: 'province',
    bbox: unionBBox(records),
    childIds: records.map(record => String(record.id)).filter(Boolean)
  };
}

function selectionIdsForRecord(record) {
  if (!record) return [];
  const id = String(record.id ?? '');
  if (!id) return [];
  if (!isProvinceRecord(record)) return [id];
  const childIds = (record.childIds?.length ? record.childIds : provinceRecordsFor(record).map(child => child.id))
    .map(String)
    .filter(Boolean);
  return [...new Set([id, ...childIds])];
}

function usableBBox(bbox, item) {
  if (!bbox) return false;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (maxLon <= minLon || maxLat <= minLat || maxLon - minLon > 10 || maxLat - minLat > 10) return false;
  if (item?.centroid_lon == null || item?.centroid_lat == null) return true;
  return item.centroid_lon >= minLon && item.centroid_lon <= maxLon &&
    item.centroid_lat >= minLat && item.centroid_lat <= maxLat;
}

function fitItem(item, record = null) {
  if (!UX.map || !item) return;
  const recordBBox = parseBBox(record?.bbox);
  const itemBBox = parseBBox(item.bbox);
  const bbox = recordBBox || (usableBBox(itemBBox, item) ? itemBBox : null);
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

function showHint() {
  if (document.querySelector('.map-interaction-hint')) return;
  const wrap = document.querySelector('.map-wrap');
  if (!wrap) return;
  const hint = document.createElement('div');
  hint.className = 'map-interaction-hint';
  hint.innerHTML = '<span class="gesture-icon">◎</span><span><b>Chọn đơn vị trên bản đồ</b><small>Nhấp vào vùng để cập nhật hồ sơ địa phương</small></span>';
  wrap.appendChild(hint);
  UX.hint = hint;
  if (localStorage.getItem('sapnhap-focus-hint-seen') === '1') hint.classList.add('compact');
}

function dismissHint() {
  try { localStorage.setItem('sapnhap-focus-hint-seen', '1'); } catch (_) {}
  UX.hint?.classList.add('is-dismissed');
}

function selectBoundary(record) {
  if (!record || !UX.boundary) return false;
  const id = String(record.id ?? '');
  if (!id) return false;
  UX.activeBoundaryId = id;
  UX.boundary.setSelected(selectionIdsForRecord(record));
  return true;
}

function focusItemFromUI(item, { fit = true } = {}) {
  if (!item || !UX.boundary) return;
  const record = findRecordForItem(item);
  if (!record) {
    console.warn('Không tìm thấy ranh giới cho đơn vị đang chọn', item);
    return;
  }
  selectBoundary(record);
  if (fit) fitItem(item, record);
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
    selectBoundary(record);
    const fitRecord = isProvinceRecord(record) ? findRecordForItem(item) : record;
    fitItem(item, fitRecord);
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
    setTimeout(() => focusItemFromUI(item, { fit: true }), 0);
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
    console.warn('Không thể khởi tạo lớp UX chọn địa phương', dataResult.reason);
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
