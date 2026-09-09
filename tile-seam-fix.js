(() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function findBoundaryLayer(map) {
    let found = null;
    map?.eachLayer?.(layer => {
      if (!found && typeof layer.featureAt === 'function' && typeof layer.setSelected === 'function' && typeof layer._paint === 'function') {
        found = layer;
      }
    });
    return found;
  }

  function isTileEdgeSegment(a, b, extent) {
    const eps = Math.max(1.5, extent * 0.0005);
    const left = a.x <= eps && b.x <= eps;
    const right = a.x >= extent - eps && b.x >= extent - eps;
    const top = a.y <= eps && b.y <= eps;
    const bottom = a.y >= extent - eps && b.y >= extent - eps;
    return left || right || top || bottom;
  }

  function buildFillPath(ctx, size, feature) {
    const extent = feature.extent || 4096;
    ctx.beginPath();
    for (const ring of feature.geometry || []) {
      if (!ring?.length) continue;
      ring.forEach((pt, i) => {
        const x = pt.x / extent * size;
        const y = pt.y / extent * size;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }

  function buildSeamSafeStrokePath(ctx, size, feature) {
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

  function installRenderer(boundary) {
    if (!boundary || boundary.__sapnhapSeamSafeRenderer) return;

    // Chặn lớp UX cũ bọc thêm original renderer sau khi bản sửa đã cài.
    boundary.__sapnhapEnhancedPaint = true;

    boundary._paint = function seamSafePaint(ctx, size, features) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const feature of features || []) {
        const props = feature.properties || {};
        const isProvince = props.level === 'province';
        const selected = this.selectedIds?.has(String(props.id));

        // Fill polygon vẫn dùng toàn bộ ring để không tạo khe trắng giữa tile.
        buildFillPath(ctx, size, feature);
        ctx.fillStyle = selected
          ? 'rgba(255, 214, 0, .72)'
          : isProvince
            ? 'rgba(190, 35, 51, .075)'
            : 'rgba(20, 103, 186, .055)';
        ctx.fill('evenodd');

        // Stroke chỉ vẽ biên thật; bỏ đoạn do polygon bị clip theo mép tile.
        buildSeamSafeStrokePath(ctx, size, feature);
        ctx.strokeStyle = selected ? '#d40000' : (isProvince ? '#bd2333' : '#1467ba');
        ctx.lineWidth = selected ? 4.5 : (isProvince ? 1.4 : 0.75);
        ctx.globalAlpha = selected ? 1 : 0.92;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    };

    boundary.__sapnhapSeamSafeRenderer = true;
    boundary.redraw?.();
    console.info('Vietflex: PMTiles tile-seam artifacts removed.');
  }

  async function boot() {
    let map = window.__SAPNHAP_MAP__ || null;
    for (let i = 0; !map && i < 120; i += 1) {
      await sleep(100);
      map = window.__SAPNHAP_MAP__ || null;
    }
    if (!map) return;

    let boundary = null;
    for (let i = 0; !boundary && i < 160; i += 1) {
      boundary = findBoundaryLayer(map);
      if (!boundary) await sleep(100);
    }
    if (!boundary) return;

    installRenderer(boundary);

    // Tự phục hồi nếu một lớp UX khác thay _paint sau đó.
    const expected = boundary._paint;
    setTimeout(() => {
      if (boundary._paint !== expected && !boundary.__sapnhapSeamSafeRendererLocked) {
        boundary.__sapnhapSeamSafeRenderer = false;
        installRenderer(boundary);
      }
      boundary.__sapnhapSeamSafeRendererLocked = true;
    }, 1200);
  }

  boot();
})();
