// qa/browser-sorot-wilayah-2026-09-08.mjs
// Verifikasi layer sorotan batas wilayah (sorot-wilayah-fill / sorot-wilayah-garis)
// saat hasil pencarian "Wilayah" dipilih. Diadaptasi dari
// qa/browser-search-camera-mapid-2026-09-08.mjs. END-TO-END: memanggil RPC
// get_admin_geometry yang SUNGGUHAN (tidak ada stub), lewat jalur produksi
// SearchBar -> supabase.rpc -> state App -> MapView.
//
// CATATAN BASEMAP (penting): dengan basemap MAPID di headless Chrome, event
// 'load' MapLibre tidak pernah menyala (vector tile tidak sampai — lihat catatan
// lama di MapView.jsx), sehingga TIDAK ADA layer aplikasi yang tergambar sama
// sekali, termasuk batas-kota-bekasi yang sudah lama ada. Untuk menguji LAYER,
// pakai build fallback OSM:
//     cd frontend
//     VITE_MAPID_MAPS_STYLE_URL= VITE_MAPID_MAPS_API_KEY= npx vite build --outDir dist-osm
//     npx vite preview --outDir dist-osm --port 4322     # catat port aslinya!
//     node qa/browser-sorot-wilayah-2026-09-08.mjs http://localhost:4322/
// Untuk cek KAMERA dengan basemap produksi MAPID: `npx vite preview --port 4323`
// lalu jalankan tanpa argumen.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const APP_URL = process.argv[2] || 'http://localhost:4323/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9375
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-sorot-' + PORT, 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())
async function cdpPage() { for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) return p } catch {} await sleep(250) } throw new Error('no CDP') }
const page = await cdpPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map(); const cerr = []
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') cerr.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ')) })
await new Promise(r => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }; return r.result?.result?.value }
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: APP_URL })
console.log('app:', APP_URL)
await sleep(6000)

await ev(`window.__QA_findMap=function(){ function isMap(o){return o&&typeof o==='object'&&typeof o.flyTo==='function'&&typeof o.getZoom==='function';} const root=document.getElementById('root');const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));let f=root[k];f=f&&(f.current||f);const st=[f];const seen=new Set();let g=0;let map=null;while(st.length&&g++<40000){const x=st.pop();if(!x||seen.has(x))continue;seen.add(x);let h=x.memoizedState,gi=0;while(h&&gi++<120){const v=h.memoizedState;if(v&&typeof v==='object'&&isMap(v.current))map=v.current;if(isMap(v))map=v;h=h.next;}if(x.child)st.push(x.child);if(x.sibling)st.push(x.sibling);}return map;};`)
console.log('layer aplikasi saat awal:', JSON.stringify(await ev(`window.__QA_findMap().getStyle().layers.map(l=>l.id)`)))

const cam = () => ev(`(() => { const m=window.__QA_findMap(); const c=m.getCenter(); return {lng:+c.lng.toFixed(5),lat:+c.lat.toFixed(5),zoom:+m.getZoom().toFixed(2)}; })()`)

// Ringkasan sorotan: layer ada/tidak, isi source (lewat Source.serialize() —
// properti privat maplibre di-mangle di bundle dist, jadi jangan baca `_data`),
// paint aktual, dan posisi dari atas (harus 0/1 = paling atas).
const sorotState = () => ev(`(() => {
  const m = window.__QA_findMap(); if (!m) return 'no-map';
  const ids = ['sorot-wilayah-fill','sorot-wilayah-garis'];
  const styleLayers = m.getStyle().layers.map(l => l.id);
  const out = ids.map(id => {
    const src = m.getSource(id);
    let d = null; try { d = src ? src.serialize().data : null } catch (e) {}
    const f0 = d && d.features && d.features[0];
    const ringLen = f0 ? (f0.geometry.type === 'Polygon'
        ? f0.geometry.coordinates[0].length
        : f0.geometry.coordinates[0][0].length) : null;
    return { id,
      layer: !!m.getLayer(id),
      source: !!src,
      fcType: d ? d.type : null,
      features: d && d.features ? d.features.length : null,
      geomType: f0 ? f0.geometry.type : null,
      titikPoligon: ringLen,
      nama: f0 ? f0.properties.nama : null,
      level: f0 ? f0.properties.level : null,
      color: m.getLayer(id) ? m.getPaintProperty(id, id.endsWith('fill') ? 'fill-color' : 'line-color') : null,
      opacity: m.getLayer(id) ? m.getPaintProperty(id, id.endsWith('fill') ? 'fill-opacity' : 'line-opacity') : null,
      width: id.endsWith('garis') && m.getLayer(id) ? m.getPaintProperty(id, 'line-width') : null,
      idxDariAtas: styleLayers.indexOf(id) < 0 ? null : styleLayers.length - 1 - styleLayers.indexOf(id),
    };
  });
  return { layers: out,
           totalLayerSorot: styleLayers.filter(x => x.startsWith('sorot-')).length,
           totalLayerPeta: styleLayers.length,
           legenda: (/Wilayah terpilih \\(hasil pencarian\\): ([^\\n]+)/.exec(document.body.innerText)||[])[1] || null };
})()`)

const ringkas = (s) => ({
  layerAda: s.layers.map(l => l.layer),
  totalLayerSorot: s.totalLayerSorot,
  fitur: s.layers.map(l => l.features),
  geom: s.layers[0].geomType,
  titikPoligon: s.layers[0].titikPoligon,
  namaDiSource: s.layers[0].nama,
  level: s.layers[0].level,
  warna: s.layers.map(l => l.color),
  opacity: s.layers.map(l => l.opacity),
  lebarGaris: s.layers[1].width,
  idxDariAtas: s.layers.map(l => l.idxDariAtas),
  legenda: s.legenda,
})

async function typeAndSelect(text, rowRe) {
  await ev(`document.querySelector('input[role="combobox"]')?.blur()`); await sleep(200)
  await ev(`(() => { const s=document.querySelector('input[role="combobox"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(s,${JSON.stringify(text)}); s.dispatchEvent(new Event('input',{bubbles:true})); s.focus(); })()`)
  await sleep(1600)
  const before = await cam()
  const t0 = Date.now()
  const clicked = await ev(`(() => { const b=[...(document.querySelector('div[class*="z-50"]')?.querySelectorAll('button[data-idx]')||[])].find(x=>${rowRe}.test(x.innerText)); if(!b) return 'no-row'; b.click(); return b.innerText.replace(/\\n/g,' | '); })()`)
  // Kapan kamera mulai bergerak
  let kameraMs = null
  for (let i = 0; i < 20; i++) { await sleep(200); const c = await cam(); if (JSON.stringify(c) !== JSON.stringify(before)) { kameraMs = Date.now() - t0; break } }
  // Kapan sorotan muncul (polling) — mengukur latensi RPC + render layer
  let sorotMs = null
  for (let i = 0; i < 25; i++) {
    const s = await sorotState()
    if (s !== 'no-map' && s.layers[0].layer && s.layers[0].features) { sorotMs = Date.now() - t0; break }
    await sleep(200)
  }
  await sleep(500)
  return { clicked, kameraMulaiPindahMs: kameraMs, sorotMunculMs: sorotMs, before, after: await cam(), sorot: ringkas(await sorotState()) }
}

console.log('\n=== 1. Pilih KECAMATAN "Bekasi Timur" (RPC sungguhan) ===')
console.log(JSON.stringify(await typeAndSelect('bekasi timur', '/Kecamatan/'), null, 1))

console.log('\n=== 2. Pilih KELURAHAN "Margahayu" -> harus MENGGANTI, bukan menumpuk ===')
console.log(JSON.stringify(await typeAndSelect('margahayu', '/Kelurahan/'), null, 1))

console.log('\n=== 3. Pilih hasil TITIK (Stasiun/Titik Survei) -> sorotan harus HILANG ===')
const r3 = await typeAndSelect('Stasiun Bekasi Timur', '/Stasiun Bekasi Timur/')
console.log(JSON.stringify({ clicked: r3.clicked, kameraMulaiPindahMs: r3.kameraMulaiPindahMs, sorot: r3.sorot }, null, 1))

console.log('\n=== 4. Sorot lagi, lalu tombol × (Bersihkan) ===')
await typeAndSelect('mustika jaya', '/Kecamatan/')
console.log('sebelum ×:', JSON.stringify(ringkas(await sorotState())))
await ev(`document.querySelector('button[title="Bersihkan"]')?.click()`)
await sleep(800)
console.log('sesudah ×:', JSON.stringify(ringkas(await sorotState())))

console.log('\n=== 5. Sorot lagi, lalu tombol Esc ===')
await typeAndSelect('margahayu', '/Kelurahan/')
console.log('sebelum Esc:', JSON.stringify(ringkas(await sorotState())))
await ev(`(() => { const s=document.querySelector('input[role="combobox"]'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`)
await sleep(800)
console.log('sesudah Esc:', JSON.stringify(ringkas(await sorotState())))

// ---------------- Regresi ----------------
console.log('\n=== REGRESI ===')
await ev(`(() => { const c=document.querySelector('.maplibregl-canvas'); const r=c.getBoundingClientRect(); const o={bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}; c.dispatchEvent(new MouseEvent('mousedown',o)); c.dispatchEvent(new MouseEvent('mouseup',o)); c.dispatchEvent(new MouseEvent('click',o)); })()`)
await sleep(2500)
console.log('klik peta -> panel CAI:', await ev(`/Composite Accessibility|Skor CAI|Rincian|kontribusi/i.test(document.body.innerText) ? 'PANEL ADA' : 'panel tidak terdeteksi'`))
console.log('legenda:', await ev(`/Batas Kota Bekasi/i.test(document.body.innerText) ? 'ADA' : 'tidak ada'`))
console.log('jumlah marker:', await ev(`document.querySelectorAll('.maplibregl-marker').length`))
console.log('layer aplikasi:', JSON.stringify(await ev(`window.__QA_findMap().getStyle().layers.map(l=>l.id).filter(x=>x!=='osm-basemap')`)))
await ev(`[...document.querySelectorAll('button')].find(b=>/Simulasi Skenario/.test(b.innerText))?.click()`)
await sleep(1000)
const tabOk = await ev(`/Mode Simulasi|Simulasi/i.test(document.body.innerText)`)
await ev(`[...document.querySelectorAll('button')].find(b=>/Peta Interaktif/.test(b.innerText))?.click()`)
await sleep(1000)
console.log('pindah tab Simulasi lalu balik ke Peta:', tabOk ? 'OK' : 'GAGAL',
  '| layer aplikasi masih:', JSON.stringify(await ev(`window.__QA_findMap().getStyle().layers.map(l=>l.id).filter(x=>x!=='osm-basemap')`)))

console.log('\nconsole.error:', cerr.length); cerr.slice(0, 10).forEach((e, i) => console.log(' ', i, e.slice(0, 220)))
ws.close(); chrome.kill(); await sleep(200); process.exit(0)
