import { PMTiles } from 'https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/+esm';
import { VectorTile } from 'https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.4/+esm';
import Pbf from 'https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm';

const V = window.Vietflex;
const $ = (id) => document.getElementById(id);
const fmt0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const SOURCE_LAYER = 'admin';
const EXPECTED = { provinces: 34, units: 3321, 'phường': 697, 'xã': 2611, 'đặc khu': 13 };
const PROVINCE_ORDER = [
  'Hà Nội','Cao Bằng','Tuyên Quang','Điện Biên','Lai Châu','Sơn La','Lào Cai','Thái Nguyên','Lạng Sơn','Quảng Ninh','Bắc Ninh','Phú Thọ','Hải Phòng','Hưng Yên','Ninh Bình','Thanh Hóa','Nghệ An','Hà Tĩnh','Quảng Trị','Huế','Đà Nẵng','Quảng Ngãi','Gia Lai','Khánh Hòa','Đắk Lắk','Lâm Đồng','Đồng Nai','Hồ Chí Minh','Tây Ninh','Đồng Tháp','Vĩnh Long','An Giang','Cần Thơ','Cà Mau'
];
const ANHMAP_SOURCES = [
  '/anhmap/index.html',
  'https://cdn.jsdelivr.net/gh/Vietflexmap/anhmap@e80f4ee9f1e167817e4a9af8402c0bca4052573e/index.html'
];
const DATASET_MIRRORS = ['myleo198/sapnhap-bando-vn', 'tmquan/sapnhap-bando-vn'];

const state = {
  data: null,
  units: [],
  provinces: [],
  selected: null,
  boundary: null,
  boundaryRecords: [],
  boundaryByKey: new Map(),
  boundaryById: new Map(),
  compareMode: 'province',
  compareMetric: 'area_km2',
  compareItems: [],
  chart: null,
  dataSource: null
};

function normalize(text = '') {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function escapeHtml(s = '') { return String(s).replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function n(v, d = 0) { return v == null || Number.isNaN(Number(v)) ? '—' : (d ? fmt2 : fmt0).format(Number(v)); }
function shortProvince(name = '') { return String(name).replace(/^(Thủ đô|Thành phố|Tỉnh)\s+/i, '').trim(); }
function unitType(v = '') { const z = normalize(v); if (z.includes('phuong')) return 'phường'; if (z.includes('dac khu')) return 'đặc khu'; if (z.includes('xa')) return 'xã'; return String(v).toLowerCase(); }
function provinceType(v = '') { return normalize(v).includes('tinh') ? 'tỉnh' : 'thành phố'; }
function unitKey(name, type, province) { return `${normalize(province)}|${normalize(type)}|${normalize(name)}`; }
function numberOrNull(v) { const x = Number(v); return v == null || v === '' || Number.isNaN(x) ? null : x; }
function code5(v) { const s = String(v ?? '').trim(); return s ? s.padStart(5, '0') : ''; }
function withDensity(area, pop, density) { const d = numberOrNull(density); if (d != null) return d; const a = numberOrNull(area), p = numberOrNull(pop); return a && p != null ? p / a : null; }

function setFatal(message, detail = '') {
  const card = $('detailCard');
  card.classList.remove('empty');
  card.innerHTML = `<div class="empty-state"><b>${escapeHtml(message)}</b><span>${escapeHtml(detail)}</span></div>`;
  $('resultCount').textContent = '0 đơn vị';
}
function setMapStatus(text, kind = '') {
  const status = $('mapStatus');
  status.innerHTML = `<span class="dot ${kind}"></span><span>${escapeHtml(text)}</span>`;
}

function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.provinces) || !Array.isArray(payload.units)) throw new Error('JSON không đúng schema provinces/units.');
  const counts = {
    provinces: payload.provinces.length,
    units: payload.units.length,
    'phường': payload.units.filter(x => x.type === 'phường').length,
    'xã': payload.units.filter(x => x.type === 'xã').length,
    'đặc khu': payload.units.filter(x => x.type === 'đặc khu').length
  };
  for (const [k, expected] of Object.entries(EXPECTED)) if (counts[k] !== expected) throw new Error(`Kiểm tra ${k}: cần ${expected}, nhận ${counts[k]}.`);
  if (new Set(payload.units.map(x => x.code)).size !== EXPECTED.units) throw new Error('Mã ĐVHC cấp xã bị trùng.');
  return payload;
}

async function loadLocalJson() {
  const r = await fetch('./data/admin.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`admin.json HTTP ${r.status}`);
  return validatePayload(await r.json());
}
async function loadLegacyGzip() {
  if (!('DecompressionStream' in window)) throw new Error('Không có DecompressionStream');
  const r = await fetch('./data/admin.json.gz', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`admin.json.gz HTTP ${r.status}`);
  const stream = r.body.pipeThrough(new DecompressionStream('gzip'));
  return validatePayload(await new Response(stream).json());
}
async function fetchHubRows(dataset, config, expected) {
  const pageSize = 100;
  const offsets = Array.from({ length: Math.ceil(expected / pageSize) }, (_, i) => i * pageSize);
  const rows = [];
  for (let i = 0; i < offsets.length; i += 6) {
    const batch = offsets.slice(i, i + 6);
    const pages = await Promise.all(batch.map(async offset => {
      const u = new URL('https://datasets-server.huggingface.co/rows');
      u.searchParams.set('dataset', dataset);
      u.searchParams.set('config', config);
      u.searchParams.set('split', 'train');
      u.searchParams.set('offset', String(offset));
      u.searchParams.set('length', String(Math.min(pageSize, expected - offset)));
      const r = await fetch(u, { cache: 'force-cache' });
      if (!r.ok) throw new Error(`${dataset}/${config} HTTP ${r.status}`);
      const j = await r.json();
      return (j.rows || []).map(x => x.row);
    }));
    pages.forEach(p => rows.push(...p));
  }
  if (rows.length !== expected) throw new Error(`${config}: cần ${expected} dòng, nhận ${rows.length}`);
  return rows;
}
function transformHub(provinceRows, communeRows) {
  const order = new Map(PROVINCE_ORDER.map((name, i) => [normalize(name), i + 1]));
  const pByName = new Map();
  for (const row of provinceRows) {
    const short = shortProvince(row.ten_short || row.ten);
    pByName.set(normalize(short), row);
  }
  const units = communeRows.map((row, idx) => {
    const parent = shortProvince(row.parent_ten || '');
    const po = order.get(normalize(parent));
    if (!po) throw new Error(`Không xác định tỉnh của ${row.ten || row.ten_short}`);
    const pRow = pByName.get(normalize(parent));
    const type = unitType(row.type);
    const code = code5(row.ma);
    const area = numberOrNull(row.area_km2);
    const pop = numberOrNull(row.population);
    return {
      id: `u:${code}`, province_order: po, province_name: parent,
      province_full_name: pRow?.ten || parent, order: idx + 1, code,
      name: row.ten_short || String(row.ten || '').replace(/^(Phường|Xã|Đặc khu)\s+/i, ''),
      full_name: row.ten || `${type} ${row.ten_short || ''}`, type,
      area_km2: area, population_2025: pop, density: withDensity(area, pop, row.density),
      merged_from: row.predecessors || null,
      administrative_center: row.capital || row.address || null,
      resolution: row.decree || null,
      centroid_lon: numberOrNull(row.centroid_lon), centroid_lat: numberOrNull(row.centroid_lat), bbox: row.bbox || null
    };
  });
  const provinces = PROVINCE_ORDER.map((name, i) => {
    const row = pByName.get(normalize(name));
    if (!row) throw new Error(`Thiếu tỉnh/thành ${name}`);
    const children = units.filter(u => u.province_order === i + 1);
    const counts = { 'phường':0, 'xã':0, 'đặc khu':0, 'khác':0 };
    children.forEach(u => { if (u.type in counts) counts[u.type]++; else counts['khác']++; });
    const area = numberOrNull(row.area_km2), pop = numberOrNull(row.population);
    return {
      id:`p:${String(i + 1).padStart(2,'0')}`, order:i + 1, code:String(row.ma || ''), name,
      full_name:row.ten || name, type:provinceType(row.type), merge_origin:row.predecessors || null,
      administrative_center:row.address || row.capital || null, resolution:row.decree || null,
      area_km2:area, population_2025:pop, density:withDensity(area,pop,row.density),
      commune_level_count:children.length, counts_by_type:counts,
      centroid_lon:numberOrNull(row.centroid_lon), centroid_lat:numberOrNull(row.centroid_lat), bbox:row.bbox || null
    };
  });
  return validatePayload({ metadata:{ source:'Hugging Face mirror fallback' }, provinces, units });
}
async function loadHubFallback() {
  const errors = [];
  for (const dataset of DATASET_MIRRORS) {
    try {
      const [p, u] = await Promise.all([fetchHubRows(dataset, 'provinces', 34), fetchHubRows(dataset, 'communes', 3321)]);
      return transformHub(p, u);
    } catch (err) { errors.push(`${dataset}: ${err.message}`); }
  }
  throw new Error(errors.join(' | '));
}
async function loadData() {
  const loaders = [
    ['local JSON', loadLocalJson],
    ['legacy gzip', loadLegacyGzip],
    ['mirror fallback', loadHubFallback]
  ];
  const errors = [];
  for (const [label, loader] of loaders) {
    try {
      const payload = await loader();
      state.data = payload; state.units = payload.units; state.provinces = payload.provinces; state.dataSource = label;
      populateFilters(); applyFilters();
      console.info(`Vietflex data ready: ${label}`, payload.metadata || {});
      return;
    } catch (err) { console.warn(`${label} failed`, err); errors.push(`${label}: ${err.message}`); }
  }
  throw new Error(errors.join(' · '));
}

class MemorySource {
  constructor(bytes) { this.bytes = bytes; this.key = `memory://vietflex-admin-${bytes.byteLength}`; }
  getKey() { return this.key; }
  async getBytes(offset, length) { const view = this.bytes.subarray(offset, offset + length); return { data:view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) }; }
}
function decodeBase64(text) {
  const binary = atob(String(text).replace(/\s+/g,''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function pointInRing(x,y,ring) { let inside=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(((a.y>y)!==(b.y>y)) && x<(b.x-a.x)*(y-a.y)/(b.y-a.y||Number.EPSILON)+a.x) inside=!inside;} return inside; }
function pointInGeometry(x,y,geometry) { let inside=false; for(const ring of geometry) if(ring.length>2 && pointInRing(x,y,ring)) inside=!inside; return inside; }

class BoundaryLayer extends V.GridLayer {
  initialize(archive, options={}) { super.initialize({ tileSize:256,minZoom:4,maxZoom:18,minNativeZoom:4,maxNativeZoom:9,noWrap:true,updateWhenIdle:false,keepBuffer:2,className:'boundary-canvas',...options }); this.archive=archive; this.decoded=new Map(); this.selectedIds=new Set(); }
  async _getDecodedTile(z,x,y) {
    const key=`${z}/${x}/${y}`;
    if(!this.decoded.has(key)) this.decoded.set(key, this.archive.getZxy(z,x,y).then(result=>{
      if(!result) return [];
      const vt=new VectorTile(new Pbf(new Uint8Array(result.data))); const layer=vt.layers[SOURCE_LAYER]; if(!layer) return [];
      const out=[]; for(let i=0;i<layer.length;i++){const f=layer.feature(i); if(f.type!==3) continue; out.push({properties:f.properties||{},geometry:f.loadGeometry(),extent:layer.extent||4096});} return out;
    }));
    return this.decoded.get(key);
  }
  createTile(coords,done) { const tile=document.createElement('canvas'); const ratio=Math.max(1,Math.min(2,devicePixelRatio||1)); tile.width=256*ratio;tile.height=256*ratio;tile.style.width='256px';tile.style.height='256px';const ctx=tile.getContext('2d');ctx.scale(ratio,ratio);this._getDecodedTile(coords.z,coords.x,coords.y).then(features=>{this._paint(ctx,256,features);done(null,tile);}).catch(err=>done(err,tile));return tile; }
  _paint(ctx,size,features) { for(const f of features){const p=f.properties||{};const province=p.level==='province';const selected=this.selectedIds.has(String(p.id));ctx.beginPath();for(const ring of f.geometry){if(!ring.length)continue;ring.forEach((pt,i)=>{const x=pt.x/f.extent*size,y=pt.y/f.extent*size;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();}ctx.fillStyle=selected?'rgba(255,218,57,.58)':province?'rgba(190,35,51,.075)':'rgba(20,103,186,.055)';ctx.fill('evenodd');ctx.strokeStyle=selected?'#df352f':province?'#bd2333':'#1467ba';ctx.lineWidth=selected?2.8:province?1.4:.75;ctx.globalAlpha=selected?1:.92;ctx.stroke();ctx.globalAlpha=1;} }
  setSelected(ids=[]) { this.selectedIds=new Set(ids.map(String)); this.redraw(); }
  async featureAt(latlng,mapZoom,map) { const z=Math.min(9,Math.max(4,Math.round(mapZoom)));const projected=map.project(latlng,z),x=Math.floor(projected.x/256),y=Math.floor(projected.y/256);const features=await this._getDecodedTile(z,x,y);if(!features.length)return null;const extent=features[0].extent,lx=(projected.x-x*256)/256*extent,ly=(projected.y-y*256)/256*extent;for(let i=features.length-1;i>=0;i--)if(pointInGeometry(lx,ly,features[i].geometry))return features[i];return null; }
}

if (!V || !V.vietflexMap) throw new Error('Vietflex core chưa được nạp.');
const map = V.vietflexMap('map', { useLegacyGoogleTiles:true,googleMapType:'roadmap',zoomControl:false,attributionControl:false,center:[16.1,106.4],zoom:5,minZoom:4,maxZoom:18 });
new V.ZoomControl({position:'topright'}).addTo(map);
new V.AttributionControl({position:'bottomright'}).addTo(map);

async function fetchFirstOk(urls) {
  const errors=[];
  for (const url of urls) {
    try { const r=await fetch(url,{cache:'force-cache'}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
    catch(err){ errors.push(`${url}: ${err.message}`); }
  }
  throw new Error(errors.join(' | '));
}
async function loadBoundary() {
  setMapStatus('Đang nạp ranh giới PMTiles…','loading');
  try {
    const html=await fetchFirstOk(ANHMAP_SOURCES); const doc=new DOMParser().parseFromString(html,'text/html');
    const pm=doc.getElementById('pmtilesData'), ad=doc.getElementById('adminData');
    if(!pm||!ad) throw new Error('ẢnhMap không chứa pmtilesData/adminData.');
    const archive=new PMTiles(new MemorySource(decodeBase64(pm.textContent)));
    const payload=JSON.parse(ad.textContent); state.boundaryRecords=payload.records||[];
    for(const r of state.boundaryRecords){state.boundaryByKey.set(unitKey(r.name,r.type,r.province),r);state.boundaryById.set(String(r.id),r);}
    state.boundary=new BoundaryLayer(archive,{attribution:'Ranh giới: Vietflexmap/anhmap'}).addTo(map);
    const h=await archive.getHeader();
    setMapStatus(`Ranh giới PMTiles sẵn sàng · z${h.minZoom}–${h.maxZoom}`,'');
  } catch(err) { console.error('Boundary error',err); setMapStatus('Không nạp được ranh giới · tra cứu dữ liệu vẫn hoạt động','error'); }
}

function populateFilters() {
  const s=$('provinceFilter'); s.innerHTML='<option value="">Tất cả 34 tỉnh/thành</option>';
  state.provinces.forEach(p=>{const o=document.createElement('option');o.value=p.order;o.textContent=`${String(p.order).padStart(2,'0')} · ${p.full_name}`;s.appendChild(o);});
}
function filteredUnits() { const p=Number($('provinceFilter').value)||null,t=$('typeFilter').value;return state.units.filter(u=>(!p||u.province_order===p)&&(!t||u.type===t)); }
function applyFilters() { const rows=filteredUnits(); renderList(rows.slice(0,300),rows.length); }
function renderList(rows,total) {
  $('resultCount').textContent=`${fmt0.format(total)} đơn vị`; const el=$('unitList'); el.innerHTML='';
  for(const u of rows){const b=document.createElement('button');b.className='unit-item'+(state.selected?.id===u.id?' active':'');b.innerHTML=`<strong>${escapeHtml(u.full_name)}</strong><small><span>${escapeHtml(u.province_name)}</span><code>${escapeHtml(u.code)}</code></small>`;b.onclick=()=>selectItem(u);el.appendChild(b);}
  if(total>300){const note=document.createElement('div');note.className='empty-state';note.innerHTML=`Đang hiển thị 300/${fmt0.format(total)}. Dùng tìm kiếm hoặc bộ lọc để thu hẹp.`;el.appendChild(note);}
}
function provinceDetail(p) { return `<div class="detail-head"><span class="badge">${escapeHtml(p.type)}</span><h2>${escapeHtml(p.full_name)}</h2><div class="detail-sub">${fmt0.format(p.commune_level_count)} đơn vị cấp xã · ${escapeHtml(p.resolution||'')}</div></div><div class="stats-grid"><div><span>Diện tích</span><b>${n(p.area_km2,2)} km²</b></div><div><span>Dân số</span><b>${n(p.population_2025)}</b></div><div><span>Mật độ</span><b>${n(p.density)}</b></div></div><div class="detail-body"><div class="detail-row"><b>Cơ cấu</b>${p.counts_by_type?.['phường']||0} phường · ${p.counts_by_type?.['xã']||0} xã · ${p.counts_by_type?.['đặc khu']||0} đặc khu</div><div class="detail-row"><b>Nguồn hình thành</b>${escapeHtml(p.merge_origin||'—')}</div><div class="detail-row"><b>Trung tâm hành chính</b>${escapeHtml(p.administrative_center||'—')}</div></div><div class="detail-actions"><button class="secondary-btn" data-compare="${p.id}">+ So sánh</button></div>`; }
function unitDetail(u) { return `<div class="detail-head"><span class="badge">${escapeHtml(u.type)}</span><h2>${escapeHtml(u.full_name)}</h2><div class="detail-sub">${escapeHtml(u.province_full_name)} · Mã ĐVHC ${escapeHtml(u.code)}</div></div><div class="stats-grid"><div><span>Diện tích</span><b>${n(u.area_km2,2)} km²</b></div><div><span>Dân số</span><b>${n(u.population_2025)}</b></div><div><span>Mật độ</span><b>${n(u.density)}</b></div></div><div class="detail-body"><div class="detail-row"><b>Trung tâm hành chính</b>${escapeHtml(u.administrative_center||'—')}</div><div class="detail-row"><b>Được sắp xếp từ</b>${escapeHtml(u.merged_from||'—')}</div>${u.resolution?`<div class="detail-row"><b>Căn cứ</b>${escapeHtml(u.resolution)}</div>`:''}</div><div class="detail-actions"><button class="secondary-btn" data-compare="${u.id}">+ So sánh</button></div>`; }
function focusItem(item) { if(item.centroid_lat!=null&&item.centroid_lon!=null){map.setView([item.centroid_lat,item.centroid_lon],item.id.startsWith('p:')?7:11,{animate:true});} }
function selectItem(item,opts={}) {
  if(!item)return; state.selected=item; const card=$('detailCard');card.classList.remove('empty');card.innerHTML=item.id.startsWith('p:')?provinceDetail(item):unitDetail(item);
  card.querySelector('[data-compare]')?.addEventListener('click',()=>{openCompare(item.id.startsWith('p:')?'province':'unit');addCompare(item);});
  if(state.boundary){let rec=null;if(item.id.startsWith('u:')) rec=state.boundaryByKey.get(unitKey(item.name,item.type,item.province_name));else rec=state.boundaryRecords.find(r=>normalize(r.name)===normalize(item.name)&&(r.level==='province'||normalize(r.type).includes('tinh')||normalize(r.type).includes('thanh pho')));state.boundary.setSelected(rec?[rec.id]:[]);}
  renderList(filteredUnits().slice(0,300),filteredUnits().length); if(!opts.keepView)focusItem(item);
  if(opts.openPopupAt) map.openPopup(`<b>${escapeHtml(item.full_name)}</b><br>${item.code?`Mã ${escapeHtml(item.code)}<br>`:''}${n(item.area_km2,2)} km² · ${n(item.population_2025)} người`,opts.openPopupAt);
  if(innerWidth<=800)$('sidebar').classList.add('open');
}
function search(q) { const z=normalize(q);if(!z)return[];const exact=state.units.filter(u=>u.code===q.trim());const prov=state.provinces.filter(p=>normalize(`${p.full_name} ${p.name} ${p.code||''}`).includes(z)).slice(0,6);const units=state.units.filter(u=>normalize(`${u.full_name} ${u.name} ${u.province_name} ${u.code} ${u.merged_from||''}`).includes(z)).slice(0,18);return [...prov,...exact,...units.filter(u=>!exact.includes(u))].slice(0,24); }
function showSearch() { const q=$('searchInput').value.trim(),box=$('searchResults');if(!q){box.hidden=true;return;}const rows=search(q);box.innerHTML=rows.length?rows.map(x=>`<button class="search-hit" data-id="${x.id}"><span><b>${escapeHtml(x.full_name)}</b><span>${x.id.startsWith('p:')?`${x.commune_level_count} đơn vị cấp xã`:escapeHtml(x.province_name)}</span></span>${x.code?`<code>${escapeHtml(x.code)}</code>`:''}</button>`).join(''):'<div class="empty-state">Không tìm thấy đơn vị phù hợp.</div>';box.hidden=false;box.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{const item=[...state.provinces,...state.units].find(x=>x.id===b.dataset.id);selectItem(item);box.hidden=true;}); }

function openCompare(mode=state.compareMode) { state.compareMode=mode;$('compareDrawer').classList.add('open');$('compareDrawer').setAttribute('aria-hidden','false');$('drawerBackdrop').hidden=false;document.querySelectorAll('.compare-mode button').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));state.compareItems=state.compareItems.filter(x=>(mode==='province')===x.id.startsWith('p:'));$('compareSearch').value='';$('compareSuggestions').innerHTML='';renderCompare(); }
function closeCompare() { $('compareDrawer').classList.remove('open');$('compareDrawer').setAttribute('aria-hidden','true');$('drawerBackdrop').hidden=true; }
function addCompare(item) { if(!item||state.compareItems.some(x=>x.id===item.id)||state.compareItems.length>=8)return;state.compareItems.push(item);renderCompare(); }
function renderCompare() {
  const chips=$('compareChips');chips.innerHTML=state.compareItems.map(x=>`<span class="compare-chip">${escapeHtml(x.full_name)}<button data-remove="${x.id}">×</button></span>`).join('');chips.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{state.compareItems=state.compareItems.filter(x=>x.id!==b.dataset.remove);renderCompare();});
  const labels=state.compareItems.map(x=>x.full_name),values=state.compareItems.map(x=>Number(x[state.compareMetric])||0);const meta={area_km2:['Diện tích','km²'],population_2025:['Dân số','người'],density:['Mật độ','người/km²']}[state.compareMetric];
  if(state.chart)state.chart.destroy();state.chart=new Chart($('compareChart'),{type:'bar',data:{labels,datasets:[{label:`${meta[0]} (${meta[1]})`,data:values,borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:labels.length>4?'y':'x',plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${meta[0]}: ${fmt2.format(c.raw)} ${meta[1]}`}}},scales:{y:{beginAtZero:true},x:{beginAtZero:true}}}});
  $('compareTable').innerHTML=state.compareItems.length?`<table><thead><tr><th>Đơn vị</th><th>Diện tích</th><th>Dân số</th><th>Mật độ</th></tr></thead><tbody>${state.compareItems.map(x=>`<tr><td>${escapeHtml(x.full_name)}</td><td>${n(x.area_km2,2)} km²</td><td>${n(x.population_2025)}</td><td>${n(x.density)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">Thêm 2–8 đơn vị để so sánh.</div>';
}
function compareSuggest() { const q=normalize($('compareSearch').value);const box=$('compareSuggestions');if(!q){box.innerHTML='';return;}const pool=state.compareMode==='province'?state.provinces:state.units;const rows=pool.filter(x=>normalize(`${x.full_name} ${x.name} ${x.province_name||''} ${x.code||''}`).includes(q)).slice(0,12);box.innerHTML=rows.map(x=>`<button data-id="${x.id}"><span>${escapeHtml(x.full_name)}</span>${x.code?`<code>${escapeHtml(x.code)}</code>`:''}</button>`).join('');box.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{addCompare(pool.find(x=>x.id===b.dataset.id));$('compareSearch').value='';box.innerHTML='';}); }

map.on('click',async e=>{if(!state.boundary)return;try{const f=await state.boundary.featureAt(e.latlng,map.getZoom(),map);if(!f)return;const rec=state.boundaryById.get(String(f.properties.id));if(!rec)return;let item=state.units.find(x=>unitKey(x.name,x.type,x.province_name)===unitKey(rec.name,rec.type,rec.province));if(!item&&rec.level==='province')item=state.provinces.find(x=>normalize(x.name)===normalize(rec.name));if(item)selectItem(item,{openPopupAt:e.latlng,keepView:true});}catch(err){console.warn('Map identify failed',err);}});

$('provinceFilter').addEventListener('change',applyFilters);$('typeFilter').addEventListener('change',applyFilters);
$('searchInput').addEventListener('input',showSearch);$('searchClear').addEventListener('click',()=>{$('searchInput').value='';$('searchResults').hidden=true;$('searchInput').focus();});
$('compareOpen').addEventListener('click',()=>openCompare());$('compareClose').addEventListener('click',closeCompare);$('drawerBackdrop').addEventListener('click',closeCompare);
document.querySelectorAll('.compare-mode button').forEach(b=>b.addEventListener('click',()=>openCompare(b.dataset.mode)));
document.querySelectorAll('.metric-tabs button').forEach(b=>b.addEventListener('click',()=>{state.compareMetric=b.dataset.metric;document.querySelectorAll('.metric-tabs button').forEach(x=>x.classList.toggle('active',x===b));renderCompare();}));
$('compareSearch').addEventListener('input',compareSuggest);$('sidebarToggle').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeCompare();$('searchResults').hidden=true;}});
document.addEventListener('click',e=>{if(!e.target.closest('.global-search'))$('searchResults').hidden=true;});

async function bootstrap() {
  const dataPromise=loadData(); const boundaryPromise=loadBoundary();
  try {
    await dataPromise;
    const v=state.data?.metadata?.validation||EXPECTED;
    console.info(`Ready: ${v.provinces||34} tỉnh/thành, ${v.units||3321} cấp xã; source=${state.dataSource}`);
    $('detailCard').innerHTML=`<div class="empty-state"><b>Dữ liệu đã sẵn sàng</b><span>${fmt0.format(state.units.length)} phường/xã/đặc khu · nguồn ${escapeHtml(state.dataSource)}. Chọn một đơn vị để tra cứu.</span></div>`;
  } catch(err) {
    console.error('Data initialization failed',err);
    setFatal('Không thể khởi tạo dữ liệu', `${err.message}. Hãy tải lại trang hoặc kiểm tra data/admin.json.`);
  }
  await boundaryPromise;
}
bootstrap();
