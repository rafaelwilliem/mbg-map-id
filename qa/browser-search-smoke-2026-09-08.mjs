// qa/browser-search-smoke-2026-09-08.mjs
// Headless smoke for the header SearchBar (migration 030 + SearchBar.jsx + App.jsx).
// Raw CDP against installed Chrome. Needs `vite preview` on :4321.
//   (cd frontend && npx vite preview --port 4321 &) ; node qa/browser-search-smoke-2026-09-08.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL_APP = 'http://localhost:4321/'
const PORT = 9358
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-search-0908b', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())

async function cdpPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p
    } catch {}
    await sleep(250)
  }
  throw new Error('CDP not reachable')
}
const page = await cdpPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const consoleErrors = []
const pageExceptions = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  if (m.method === 'Runtime.exceptionThrown')
    pageExceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
})
await new Promise((res) => ws.addEventListener('open', res))
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }
  return r.result?.result?.value
}
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')

// Install a fiber-walk that locates the live MapLibre Map instance and pins it to
// window.__QA_MAP (the app keeps it only in React state, never on window).
const INSTALL_MAP_HOOK = `(() => {
  window.__QA_findMap = function () {
    if (window.__QA_MAP && typeof window.__QA_MAP.getZoom === 'function') return window.__QA_MAP;
    const seen = new Set();
    function isMap(o){ return o && typeof o==='object' && typeof o.getZoom==='function' && typeof o.getCenter==='function' && typeof o.flyTo==='function' && typeof o.fitBounds==='function'; }
    function scanHooks(fiber){
      let h = fiber.memoizedState;
      let guard = 0;
      while (h && guard++ < 50){
        const v = h.memoizedState;
        if (isMap(v)) return v;
        if (v && typeof v==='object' && isMap(v.current)) return v.current;
        h = h.next;
      }
      return null;
    }
    const root = document.getElementById('root');
    let key = Object.keys(root).find(k => k.startsWith('__reactContainer$'));
    let node = key ? root[key] : null;
    let fiber = node && (node.current || node);
    const stack = fiber ? [fiber] : [];
    let guard = 0;
    while (stack.length && guard++ < 20000){
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      try { const m = scanHooks(f); if (m){ window.__QA_MAP = m; return m; } } catch {}
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return null;
  };
  return true;
})()`

async function mapCam() {
  return await ev(`(() => {
    const m = window.__QA_findMap && window.__QA_findMap();
    if (!m) return null;
    const c = m.getCenter();
    return { lng:+c.lng.toFixed(5), lat:+c.lat.toFixed(5), zoom:+m.getZoom().toFixed(2) };
  })()`)
}

console.log('navigate ->', URL_APP)
await send('Page.navigate', { url: URL_APP })
await sleep(5500)
await ev(INSTALL_MAP_HOOK)
const mapFound = await ev(`!!(window.__QA_findMap && window.__QA_findMap())`)
console.log('shell mounted. console.error so far:', consoleErrors.length, '| MapLibre instance located via fiber:', mapFound)
console.log('initial camera:', JSON.stringify(await mapCam()))

const SET_VAL = `(v) => { const s=document.querySelector('input[role="combobox"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(s,v); s.dispatchEvent(new Event('input',{bubbles:true})); s.focus(); }`
async function type(v) { await ev(`(${SET_VAL})(${JSON.stringify(v)})`) }
async function dropdownState() {
  return await ev(`(() => {
    const list = document.querySelector('div[class*="z-50"]');
    if (!list) return { open:false };
    const headers = [...list.querySelectorAll('div')].filter(d => /^(WILAYAH|HALTE|TITIK SURVEI|USULAN MODEL|STASIUN|KORIDOR)$/i.test(d.textContent.trim())).map(d=>d.textContent.trim());
    const items = [...list.querySelectorAll('button[data-idx]')].map(b => b.innerText.replace(/\\n/g,' | '));
    const empty = /Tidak ada hasil/.test(list.innerText);
    return { open:true, headers, items, empty };
  })()`)
}
const currentHeader = () => ev(`document.querySelector('header h1')?.innerText || null`)
const activeNavTitle = () => ev(`[...document.querySelectorAll('nav button[title]')].find(b=>/bg-brand-blue|text-white/.test(b.className))?.title || null`)

const out = {}

// ---- 1. narrow viewport: input hidden (hidden sm:block) ----
await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(500)
out.narrowInputVisible = await ev(`(() => { const s=document.querySelector('input[role="combobox"]'); if(!s) return 'no-input'; const r=s.getBoundingClientRect(); return r.width>0 && r.height>0; })()`)
console.log('\n[1] narrow 480px -> input visible:', out.narrowInputVisible, '(expect false / no-input)')
await send('Emulation.clearDeviceMetricsOverride'); await sleep(500)

// ---- put app on Dashboard so a subsequent Wilayah-select tab switch is observable ----
await ev(`[...document.querySelectorAll('nav button[title], button[title]')].find(x=>x.title==='Dashboard')?.click()`)
await sleep(1500)
console.log('[setup] switched to tab:', await currentHeader())

// ---- 2. type "bekasi" ----
const errBefore = consoleErrors.length
await type('bekasi')
await sleep(1400)
out.bekasi = await dropdownState()
console.log('\n[2] "bekasi" -> open:', out.bekasi.open, '| headers:', JSON.stringify(out.bekasi.headers), '| items:', out.bekasi.items?.length)
;(out.bekasi.items || []).forEach((it) => console.log('     ', it))
out.bekasiNewErrors = consoleErrors.length - errBefore
console.log('     new console.error during this step:', out.bekasiNewErrors)

// ---- 3. select the first Wilayah result -> expect tab switch to Peta + camera move (fitBounds) ----
const camBefore = await mapCam()
const headerBefore = await currentHeader()
const selected = await ev(`(() => {
  const list = document.querySelector('div[class*="z-50"]');
  if (!list) return 'no-list';
  const btns = [...list.querySelectorAll('button[data-idx]')];
  const target = btns.find(b => /Kecamatan|Kelurahan/.test(b.innerText)) || btns[0];
  if (!target) return 'no-btn';
  const label = target.innerText.replace(/\\n/g,' | ');
  target.click();
  return label;
})()`)
await sleep(2600)
const camAfter = await mapCam()
const headerAfter = await currentHeader()
out.wilayahSelect = { selected, headerBefore, headerAfter, camBefore, camAfter,
  moved: JSON.stringify(camBefore) !== JSON.stringify(camAfter) }
console.log('\n[3] selected Wilayah row:', selected)
console.log('     header:', headerBefore, '->', headerAfter, '(expect -> Peta Interaktif)')
console.log('     camera before:', JSON.stringify(camBefore))
console.log('     camera after :', JSON.stringify(camAfter))
console.log('     camera moved:', out.wilayahSelect.moved)

// ---- 4. type a known station name -> point result -> select -> flyTo zoom ~16 ----
await ev(`document.querySelector('input[role="combobox"]')?.blur()`); await sleep(300)
await type('Stasiun Bekasi Timur')
await sleep(1400)
out.stasiun = await dropdownState()
console.log('\n[4] "Stasiun Bekasi Timur" -> headers:', JSON.stringify(out.stasiun.headers), '| items:', out.stasiun.items?.length)
;(out.stasiun.items || []).forEach((it) => console.log('     ', it))
const camB2 = await mapCam()
const picked2 = await ev(`(() => {
  const list = document.querySelector('div[class*="z-50"]');
  const b = list && [...list.querySelectorAll('button[data-idx]')].find(x => /Stasiun Bekasi Timur/.test(x.innerText) && /KRL|LRT/.test(x.innerText));
  if (!b) return 'no-station-row';
  const l = b.innerText.replace(/\\n/g,' | '); b.click(); return l;
})()`)
await sleep(2800)
const camA2 = await mapCam()
out.stasiunSelect = { picked2, camB2, camA2, moved: JSON.stringify(camB2) !== JSON.stringify(camA2),
  zoomNear16: camA2 ? Math.abs(camA2.zoom - 16) < 1.0 : null }
console.log('     picked:', picked2)
console.log('     camera before:', JSON.stringify(camB2), '-> after:', JSON.stringify(camA2))
console.log('     moved:', out.stasiunSelect.moved, '| zoom ended ~16:', out.stasiunSelect.zoomNear16)

// ---- 5. 1 char -> no dropdown ; gibberish -> "Tidak ada hasil" ----
await type('z'); await sleep(700)
out.oneChar = await dropdownState()
console.log('\n[5] "z" (1 char) -> open:', out.oneChar.open, '(expect false)')
await type('zzzzzz'); await sleep(1400)
out.gibberish = await dropdownState()
console.log('     "zzzzzz" -> open:', out.gibberish.open, '| empty:', out.gibberish.empty, '| items:', out.gibberish.items?.length, '(expect empty=true, items=0)')

// ---- 6. Esc clears ; X clears ----
await type('bekasi'); await sleep(900)
await ev(`(() => { const s=document.querySelector('input[role="combobox"]'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`)
await sleep(400)
out.escClears = await ev(`document.querySelector('input[role="combobox"]')?.value === ''`)
await type('bekasi'); await sleep(900)
const xClicked = await ev(`(() => { const b=document.querySelector('button[title="Bersihkan"]'); if(!b) return 'no-x'; b.click(); return 'ok'; })()`)
await sleep(400)
out.xClears = await ev(`document.querySelector('input[role="combobox"]')?.value === ''`)
console.log('\n[6] Esc clears:', out.escClears, '| X (', xClicked, ') clears:', out.xClears)

// ---- 7. regression: map click -> CAI panel ----
await ev(`[...document.querySelectorAll('button[title]')].find(x=>x.title==='Peta Interaktif')?.click()`)
await sleep(2500)
const caiBefore = await ev(`!!document.querySelector('[class*="z-"]') && (document.body.innerText.match(/Composite Accessibility Index|Skor CAI|Rincian kontribusi/i)||[])[0] || null`)
const fired = await ev(`(() => {
  const m = window.__QA_findMap && window.__QA_findMap();
  if (!m) return 'no-map';
  const c = m.getCenter();
  const p = m.project([c.lng, c.lat]);
  m.fire('click', { lngLat: c, point: p, originalEvent: {} });
  return 'fired at ' + c.lng.toFixed(4) + ',' + c.lat.toFixed(4);
})()`)
await sleep(3500)
const caiAfter = await ev(`(document.body.innerText.match(/Composite Accessibility Index|Skor CAI|Rincian kontribusi|Kepadatan penduduk/gi)||[]).slice(0,4)`)
out.caiRegression = { caiBefore, fired, caiAfter, panelAppeared: Array.isArray(caiAfter) && caiAfter.length > 0 }
console.log('\n[7] map click regression: ', fired)
console.log('     CAI panel markers before:', JSON.stringify(caiBefore), '| after:', JSON.stringify(caiAfter))
console.log('     CAI panel appeared:', out.caiRegression.panelAppeared)

// ---- 8. legend present on Peta tab ----
out.legendPresent = await ev(`/Batas Kota Bekasi|Halte tersurvei|Usulan halte dari model/i.test(document.body.innerText)`)
console.log('[8] legend visible on Peta tab:', out.legendPresent)

// ---- 9. tab switching still works ----
const tabWalk = []
for (const label of ['Dashboard', 'Analisis Spasial', 'AI Spatial Consultant', 'Rekomendasi', 'Simulasi Skenario', 'Peta Interaktif']) {
  const before = consoleErrors.length
  await ev(`[...document.querySelectorAll('button[title]')].find(x=>x.title===${JSON.stringify(label)})?.click()`)
  await sleep(1800)
  tabWalk.push({ label, header: await currentHeader(), newErr: consoleErrors.length - before })
}
out.tabWalk = tabWalk
console.log('\n[9] tab walk:'); tabWalk.forEach((t) => console.log('     ', t.label, '-> header:', t.header, '| newErr:', t.newErr))

console.log('\n================ SUMMARY ================')
console.log('console.error total:', consoleErrors.length)
consoleErrors.slice(0, 30).forEach((e, i) => console.log(`  [err ${i}] ${e.slice(0, 240)}`))
console.log('page exceptions:', pageExceptions.length)
pageExceptions.slice(0, 15).forEach((e, i) => console.log(`  [exc ${i}] ${String(e).slice(0, 240)}`))

const fs = await import('node:fs')
const p = new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\/[^/]+$/, '') + '/browser-search-smoke-2026-09-08-result.json'
fs.writeFileSync(p, JSON.stringify({ out, consoleErrors, pageExceptions }, null, 2))
ws.close(); chrome.kill(); await sleep(300)
console.log('\n=== DONE ===')
process.exit(0)
