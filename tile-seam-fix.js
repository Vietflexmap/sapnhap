(() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ADMIN_URLS = [
    '/anhmap/index.html',
    'https://cdn.jsdelivr.net/gh/Vietflexmap/anhmap@e80f4ee9f1e167817e4a9af8402c0bca4052573e/index.html'
  ];

  const R = {
    map: null,
    boundary: null,
    admin: null,
    records: [],
    byId: new Map(),
    byCode: new Map(),
    byKey: new Map(),
    provinces: new Map(),
    activeRecord: null
  };

  function normalize(value = '') {
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function shortProvince(value = '') {
    return String(value).replace(/^(Thủ đô|Thành phố|Tỉnh)\s+/i, '').trim();
  }

  function shortUnit(value = '') {
    return String(value).replace(/^(Phường|Xã|Đặc khu)\s+/i, '').trim();
  }

  function canonicalType(value = '') {
    const z = normalize(value);
    if (z.includes('dac khu')) return 'dac khu';
    if (z.includes('phuong')) return 'phuong';
    if (z === 'xa' || z.includes(' xa')) return 'xa';
    if (z.includes('tinh')) return 'tinh';
    if (z.includes('thanh pho') || z.includes('thu do')) return 'thanh pho';
    return z;
  }

  function unitKey(name, type, province) {
    return `${normalize(shortProvince(province))}|${canonicalType(type)}|${normalize(shortUnit(name))}`;
  }

  function code5(value) {
    const s = String(value ?? '').trim();
    return s && /^\d+$/.test(s) ? s.padStart(5, '0') : '';
  }

  function recordCode(record) {
    return code5(record?.code ?? record?.ma ?? record?.admin_code ?? record?.ma_dvhc ?? record?.MA ?? '');
  }

  function recordName(record) {
    return record?.name ?? record?.ten_short ?? record?.ten ?? record?.full_name ?? '';
  }

  function recordProvince(record) {
    return record?.province ?? record?.province_name ?? record?.parent_ten ?? record?.parent ?? '';
  }

  function recordType(record) {
    return record?.type ?? record?.loai ?? record?.level_name ?? '';
  }

  function isProvinceRecord(record) {
    if (!record) return false;
    if (String(record.level || '').toLowerCase() === 'province') return true;
    const t = canonicalType(recordType(record));
    return t === 'tinh' || t === 'thanh pho';
  }

  function isProvinceFeature(props = {}) {
    if (String(props.level || '').toLowerCase() === 'province') return true;
    const t = canonicalType(props.type ?? props.loai ?? '');
    return t === 'tinh' || t === 'thanh pho';
  }

  function featureCode(props = {}) {
    return code5(props.code ?? props.ma ?? props.admin_code ?? props.ma_dvhc ?? props.MA ?? '');
  }

  function featureKey(props = {}) {
    return unitKey(
      props.name ?? props.ten_short ?? props.ten ?? props.full_name ?? '',
      props.type ?? props.loai ?? '',
      props.province ?? props.province_name ?? props.parent_ten ?? props.parent ?? ''
    );
  }

  function findBoundaryLayer(map) {
    let found = null;
    map?.eachLayer?.(layer => {
      if (!found && typeof layer.featureAt === 'function' && typeof layer.setSelected === 'function' && typeof layer._paint === 'function') found = layer;
    });
    return found;
  }

  function isTileEdgeSegment(a, b, extent) {
    const eps = Math.max(1.5, extent * 0.0005);
    return (a.x <= eps && b.x <= eps) ||
      (a.x >= extent - eps && b.x >= extent - eps) ||
      (a.y <= eps && b.y <= eps) ||
      (a.y >= extent - eps && b.y >= extent - eps);
  }

  function buildFillPath(ctx, size, feature) {
    const extent = feature.extent || 4096;
    ctx.beginPath();
    for (const ring of feature.geometry || []) {
      if (!ring?.length) continue;
      ring.forEach((pt, i) => {
        const x = pt.x / extent * size;
        const y = pt.y / extent * size;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
  }

  function buildStrokePath(ctx, size, feature) {
    const extent = feature.extent || 4096;
    ctx.beginPath();
    for (const ring of feature.geometry || []) {
      if (!ring || ring.length < 2) continue;
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (!a || !b || isTileEdgeSegment(a, b, extent)) continue;
        ctx.moveTo(a.x / extent * size, a.y / extent * size);
        ctx.lineTo(b.x / extent * size, b.y / extent * size);
      }
    }
  }

  function isSelectedFeature(boundary, props = {}) {
    const id = String(props.id ?? '');
    if (id && boundary.selectedIds?.has(id)) return true;
    const active = R.activeRecord;
    if (!active) return false;
    if (id && String(active.id ?? '') === id) return true;
    const ac = recordCode(active), fc = featureCode(props);
    if (ac && fc && ac === fc) return true;
    if (!isProvinceRecord(active)) {
      const ak = unitKey(recordName(active), recordType(active), recordProvince(active));
      const fk = featureKey(props);
      if (ak && fk && ak === fk) return true;
    }
    return false;
  }

  function fillFeature(ctx, size, feature, fill) {
    buildFillPath(ctx, size, feature);
    ctx.fillStyle = fill;
    ctx.globalAlpha = 1;
    ctx.fill('evenodd');
  }

  function strokeFeature(ctx, size, feature, color, width, alpha = 1) {
    buildStrokePath(ctx, size, feature);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function installRenderer(boundary) {
    if (!boundary) return;
    boundary.__sapnhapEnhancedPaint = true;

    boundary._paint = function hierarchySeamSafePaint(ctx, size, features = []) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      const normal = [];
      const province = [];
      const selected = [];

      for (const feature of features) {
        const props = feature.properties || {};
        if (isSelectedFeature(this, props)) selected.push(feature);
        else if (isProvinceFeature(props)) province.push(feature);
        else normal.push(feature);
      }

      // Pass 1: nền nhẹ, cấp xã trước. Province fill rất nhẹ để không che nền bản đồ.
      for (const feature of normal) fillFeature(ctx, size, feature, 'rgba(20, 103, 186, .045)');
      for (const feature of province) fillFeature(ctx, size, feature, 'rgba(190, 35, 51, .025)');

      // Pass 2: ranh cấp xã màu xanh.
      for (const feature of normal) strokeFeature(ctx, size, feature, '#176fbd', 0.9, 0.92);

      // Pass 3: ranh tỉnh/thành màu đỏ, luôn nằm trên ranh cấp xã.
      for (const feature of province) strokeFeature(ctx, size, feature, '#cf2638', 2.15, 0.98);

      // Pass 4: đơn vị đang chọn nằm trên cùng: vàng + đỏ đậm.
      for (const feature of selected) {
        fillFeature(ctx, size, feature, 'rgba(255, 215, 0, .62)');
        strokeFeature(ctx, size, feature, '#e00000', 4.2, 1);
      }

      ctx.restore();
    };

    boundary.__sapnhapSeamSafeRenderer = true;
    boundary.__sapnhapHierarchyRenderer = true;
    boundary.redraw?.();
  }

  async function loadMaster() {
    try {
      const r = await fetch('./data/admin.json', { cache: 'no-cache' });
      if (r.ok) R.admin = await r.json();
    } catch (error) {
      console.warn('Renderer: không đọc được master data', error);
    }
  }

  async function loadBoundaryRecords() {
    for (const url of ADMIN_URLS) {
      try {
        const r = await fetch(url, { cache: 'force-cache' });
        if (!r.ok) continue;
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const node = doc.getElementById('adminData');
        if (!node) continue;
        const payload = JSON.parse(node.textContent);
        R.records = payload.records || [];
        for (const rec of R.records) {
          if (rec.id != null) R.byId.set(String(rec.id), rec);
          const c = recordCode(rec);
          if (c) R.byCode.set(c, rec);
          if (isProvinceRecord(rec)) {
            const names = [recordName(rec), recordProvince(rec)].map(v => normalize(shortProvince(v))).filter(Boolean);
            for (const name of names) R.provinces.set(name, rec);
          } else {
            R.byKey.set(unitKey(recordName(rec), recordType(rec), recordProvince(rec)), rec);
          }
        }
        return;
      } catch (error) {
        console.warn('Renderer: lỗi đọc adminData', url, error);
      }
    }
  }

  function recordForUnit(item) {
    if (!item) return null;
    const c = code5(item.code);
    if (c && R.byCode.has(c)) return R.byCode.get(c);
    const key = unitKey(item.name || item.full_name, item.type, item.province_name || item.province_full_name);
    if (R.byKey.has(key)) return R.byKey.get(key);

    const wantedName = normalize(shortUnit(item.name || item.full_name));
    const wantedProvince = normalize(shortProvince(item.province_name || item.province_full_name));
    return R.records.find(rec => !isProvinceRecord(rec) &&
      normalize(shortUnit(recordName(rec))) === wantedName &&
      normalize(shortProvince(recordProvince(rec))) === wantedProvince) || null;
  }

  function recordForProvince(item) {
    if (!item) return null;
    const candidates = [item.name, item.full_name].map(v => normalize(shortProvince(v))).filter(Boolean);
    for (const name of candidates) if (R.provinces.has(name)) return R.provinces.get(name);
    return null;
  }

  function setActiveRecord(record) {
    R.activeRecord = record || null;
    if (!R.boundary) return;
    const id = record?.id != null ? String(record.id) : '';
    R.boundary.setSelected(id ? [id] : []);
    R.boundary.redraw?.();
  }

  function masterItemFromButton(button) {
    if (!R.admin || !button) return null;
    const code = code5(button.querySelector('code')?.textContent || '');
    if (code) {
      const unit = R.admin.units?.find(u => code5(u.code) === code);
      if (unit) return unit;
    }
    const name = normalize(shortUnit(button.querySelector('strong,b')?.textContent || ''));
    if (!name) return null;
    return R.admin.units?.find(u => normalize(shortUnit(u.full_name || u.name)) === name) || null;
  }

  function syncActiveListSelection() {
    const active = document.querySelector('#unitList .unit-item.active');
    if (!active) return;
    const item = masterItemFromButton(active);
    const rec = recordForUnit(item);
    if (rec) setActiveRecord(rec);
  }

  function installSelectionSync() {
    const list = document.getElementById('unitList');
    if (list) {
      list.addEventListener('click', event => {
        const button = event.target.closest('.unit-item');
        if (!button) return;
        setTimeout(() => {
          const item = masterItemFromButton(button);
          const rec = recordForUnit(item);
          if (rec) setActiveRecord(rec);
        }, 0);
      }, true);

      new MutationObserver(() => syncActiveListSelection()).observe(list, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class']
      });
    }

    const search = document.getElementById('searchResults');
    search?.addEventListener('click', event => {
      const button = event.target.closest('[data-id]');
      if (!button || !R.admin) return;
      const id = button.dataset.id || '';
      setTimeout(() => {
        let item = null;
        if (id.startsWith('u:')) item = R.admin.units?.find(u => `u:${code5(u.code)}` === id);
        else if (id.startsWith('p:')) item = R.admin.provinces?.find(p => p.id === id);
        const rec = id.startsWith('p:') ? recordForProvince(item) : recordForUnit(item);
        if (rec) setActiveRecord(rec);
      }, 0);
    }, true);
  }

  function decorateBoundarySelection(boundary) {
    // Giữ API cũ nhưng nhớ record theo id để renderer không lệ thuộc duy nhất selectedIds.
    const originalSetSelected = boundary.setSelected.bind(boundary);
    boundary.setSelected = function reliableSetSelected(ids = []) {
      const arr = Array.from(ids || []).map(String);
      const result = originalSetSelected(arr);
      if (arr.length) R.activeRecord = R.byId.get(arr[0]) || R.activeRecord;
      else if (!document.querySelector('#unitList .unit-item.active')) R.activeRecord = null;
      this.redraw?.();
      return result;
    };
  }

  async function boot() {
    await Promise.allSettled([loadMaster(), loadBoundaryRecords()]);

    let map = window.__SAPNHAP_MAP__ || null;
    for (let i = 0; !map && i < 120; i += 1) {
      await sleep(100);
      map = window.__SAPNHAP_MAP__ || null;
    }
    if (!map) return;
    R.map = map;

    let boundary = null;
    for (let i = 0; !boundary && i < 160; i += 1) {
      boundary = findBoundaryLayer(map);
      if (!boundary) await sleep(100);
    }
    if (!boundary) return;
    R.boundary = boundary;

    decorateBoundarySelection(boundary);
    installRenderer(boundary);
    installSelectionSync();
    syncActiveListSelection();

    // Nếu UX khác thay renderer sau đó, lấy lại quyền vẽ hierarchy một lần nữa.
    const expected = boundary._paint;
    setTimeout(() => {
      if (boundary._paint !== expected) installRenderer(boundary);
      syncActiveListSelection();
    }, 1400);

    window.__SAPNHAP_BOUNDARY_RENDERER__ = {
      version: '2026.09.09-r2',
      colors: { province: '#cf2638', commune: '#176fbd', selectedFill: '#ffd700', selectedStroke: '#e00000' }
    };
    console.info('Vietflex renderer r2 ready: province red · commune blue · selected yellow/red · seam-safe.');
  }

  boot();
})();
