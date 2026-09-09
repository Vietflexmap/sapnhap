(() => {
  async function waitForMap() {
    for (let i = 0; i < 100; i += 1) {
      if (window.__SAPNHAP_MAP__) return window.__SAPNHAP_MAP__;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  waitForMap().then(map => {
    if (!map) return;
    const container = map.getContainer?.();
    if (!container) return;

    let lastTap = null;
    let lastSyntheticAt = 0;

    container.addEventListener('pointerup', event => {
      if (event.pointerType !== 'touch') return;
      const now = Date.now();
      const current = { time: now, x: event.clientX, y: event.clientY };

      if (lastTap) {
        const dt = now - lastTap.time;
        const distance = Math.hypot(current.x - lastTap.x, current.y - lastTap.y);
        if (dt > 70 && dt < 380 && distance < 32) {
          event.preventDefault();
          lastSyntheticAt = now;
          lastTap = null;
          const latlng = map.mouseEventToLatLng(event);
          map.fire('dblclick', { latlng, originalEvent: event, syntheticTouch: true });
          return;
        }
      }
      lastTap = current;
    }, { passive: false });

    container.addEventListener('dblclick', event => {
      if (Date.now() - lastSyntheticAt < 650) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
})();
