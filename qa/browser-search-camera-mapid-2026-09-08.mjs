// Verifikasi fix silent-failure 2026-09-08 dengan basemap MAPID produksi.
// Sebelum fix: 'load' tidak pernah menyala -> mapInstance null -> kamera diam.
// Sesudah fix: onMapReady dipanggil segera setelah konstruktor MapLibre.
// Jalankan `npx vite preview --port 4323` di frontend/ lebih dulu.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9371
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-mapid-fix', 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: 'http://localhost:4323/' })

await sleep(2500)
await ev(`window.__QA_findMap=function(){ function isMap(o){return o&&typeof o==='object'&&typeof o.flyTo==='function'&&typeof o.getZoom==='function';} const root=document.getElementById('root');const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));let f=root[k];f=f&&(f.current||f);const st=[f];const seen=new Set();let g=0;let map=null;while(st.length&&g++<40000){const x=st.pop();if(!x||seen.has(x))continue;seen.add(x);let h=x.memoizedState,gi=0;while(h&&gi++<120){const v=h.memoizedState;if(v&&typeof v==='object'&&isMap(v.current))map=v.current;if(isMap(v))map=v;h=h.next;}if(x.child)st.push(x.child);if(x.sibling)st.push(x.sibling);}return map;};`)
const sbPropExpr = `(() => {
  const isMap=o=>o&&typeof o==='object'&&typeof o.flyTo==='function';
  const root=document.getElementById('root');const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));
  let f=root[k];f=f&&(f.current||f);const st=[f];let g=0;
  while(st.length&&g++<40000){const x=st.pop();if(!x)continue;const p=x.memoizedProps;
    if(p&&typeof p==='object'&&'mapInstance' in p&&'onResultSelected' in p){ return { mapInstanceSet: isMap(p.mapInstance), val: p.mapInstance===null?'null':typeof p.mapInstance }; }
    if(x.child)st.push(x.child);if(x.sibling)st.push(x.sibling);}
  return 'SearchBar fiber not found';
})()`
// Cek CEPAT: apakah mapInstance sudah terisi walau style MAPID belum selesai?
console.log('t=2.5s SearchBar.mapInstance prop:', JSON.stringify(await ev(sbPropExpr)))
console.log('t=2.5s map state:', JSON.stringify(await ev(`(() => { const m=window.__QA_findMap(); return m?{loaded:m.loaded(),styleLoaded:m.isStyleLoaded()}:'no-map'; })()`)))

await sleep(4000)
console.log('t=6.5s SearchBar.mapInstance prop:', JSON.stringify(await ev(sbPropExpr)))
const st = await ev(`(() => { const m=window.__QA_findMap(); return m?{loaded:m.loaded(),styleLoaded:m.isStyleLoaded()}:'no-map'; })()`)
console.log('t=6.5s map state (MAPID):', JSON.stringify(st))
const cam = () => ev(`(() => { const m=window.__QA_findMap(); const c=m.getCenter(); return {lng:+c.lng.toFixed(5),lat:+c.lat.toFixed(5),zoom:+m.getZoom().toFixed(2)}; })()`)

async function typeAndSelect(text, rowRe) {
  await ev(`document.querySelector('input[role="combobox"]')?.blur()`); await sleep(200)
  await ev(`(() => { const s=document.querySelector('input[role="combobox"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(s,${JSON.stringify(text)}); s.dispatchEvent(new Event('input',{bubbles:true})); s.focus(); })()`)
  await sleep(1500)
  const rows = await ev(`[...(document.querySelector('div[class*="z-50"]')?.querySelectorAll('button[data-idx]')||[])].map(b=>b.innerText.replace(/\\n/g,' | '))`)
  // Apakah hint "Peta belum siap" muncul di kaki dropdown?
  const hint = await ev(`(() => { const d=document.querySelector('div[class*="z-50"]'); return d? (/Peta belum siap/.test(d.innerText) ? 'HINT SHOWN' : 'no hint') : 'no dropdown'; })()`)
  const before = await cam()
  const clicked = await ev(`(() => { const b=[...(document.querySelector('div[class*="z-50"]')?.querySelectorAll('button[data-idx]')||[])].find(x=>${rowRe}.test(x.innerText)); if(!b) return 'no-row'; b.click(); return b.innerText.replace(/\\n/g,' | '); })()`)
  let after = before, changedAt = null
  for (let i = 0; i < 20; i++) { await sleep(250); const c = await cam(); if (JSON.stringify(c) !== JSON.stringify(before)) { after = c; changedAt = (i + 1) * 250; break } after = c }
  const note = await ev(`/Peta belum siap dimuat/.test(document.body.innerText) ? 'NOTE SHOWN' : 'no note'`)
  return { text, rowsCount: rows?.length, dropdownHint: hint, clicked, before, after, changedAt, postSelectNote: note }
}

console.log('\n-- Wilayah (kecamatan bbox -> fitBounds) --')
console.log(JSON.stringify(await typeAndSelect('bekasi timur', '/Kecamatan/'), null, 1))
console.log('\n-- Wilayah (kelurahan bbox -> fitBounds) --')
console.log(JSON.stringify(await typeAndSelect('margahayu', '/Kelurahan/'), null, 1))
console.log('\n-- Stasiun (point -> flyTo zoom 16) --')
console.log(JSON.stringify(await typeAndSelect('Stasiun Bekasi Timur', '/Stasiun Bekasi Timur.*KRL|KRL.*Stasiun Bekasi Timur/'), null, 1))

// Regresi: klik peta -> panel skor CAI, dan pergantian tab.
await ev(`(() => { const c=document.querySelector('.maplibregl-canvas'); if(!c) return 'no canvas'; const r=c.getBoundingClientRect(); const o={bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}; c.dispatchEvent(new MouseEvent('mousedown',o)); c.dispatchEvent(new MouseEvent('mouseup',o)); c.dispatchEvent(new MouseEvent('click',o)); return 'clicked'; })()`)
await sleep(2500)
console.log('\nregresi klik peta -> panel CAI:', await ev(`/Composite Accessibility|Skor CAI|Rincian|kontribusi/i.test(document.body.innerText) ? 'PANEL ADA' : 'panel tidak terdeteksi'`))
console.log('regresi legenda:', await ev(`/Legenda/i.test(document.body.innerText) ? 'ADA' : 'tidak ada'`))
console.log('regresi jumlah marker:', await ev(`document.querySelectorAll('.maplibregl-marker').length`))

console.log('\nconsole.error:', cerr.length); cerr.slice(0, 10).forEach((e, i) => console.log(' ', i, e.slice(0, 200)))
ws.close(); chrome.kill(); await sleep(200); process.exit(0)
