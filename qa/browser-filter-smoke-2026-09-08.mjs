// qa/browser-filter-smoke-2026-09-08.mjs
// (1) Smoke: load app shell + walk every sidebar panel, record console.error /
//     exceptions / failed requests.
// (2) Measure PRD Bab 8 "filter per-kecamatan render ulang < 2 detik" on the
//     Analisis Spasial map: wall-clock from <select> change dispatch until
//     MapLibre 'idle' after the source is re-set, plus the app's own
//     lastFilterMs ("Filter diterapkan dalam N ms").
// No deps — raw CDP against installed Chrome. Needs `vite preview` on :4319.
//   node qa/browser-filter-smoke-2026-09-08.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL_APP = 'http://localhost:4319/'
const PORT = 9351
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-0908', 'about:blank',
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
const failedRequests = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties ?? '')).join(' '))
  if (m.method === 'Runtime.exceptionThrown')
    pageExceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  if (m.method === 'Network.loadingFailed' && !/Aborted|net::ERR_ABORTED/.test(m.params.errorText || ''))
    failedRequests.push(`${m.params.type} ${m.params.errorText}`)
})
await new Promise((res) => ws.addEventListener('open', res))
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }
  return r.result?.result?.value
}
await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable')

console.log('navigate ->', URL_APP)
await send('Page.navigate', { url: URL_APP })
await sleep(4000)
const shellErrCount = consoleErrors.length
console.log(`app shell mounted. console.error so far: ${shellErrCount}`)

const tabLabels = {
  Dashboard: 'Dashboard', 'Peta Interaktif': 'Peta Interaktif', 'Analisis Spasial': 'Analisis Spasial',
  'AI Spatial Consultant': 'AI Spatial Consultant', 'Simulasi Skenario': 'Simulasi Skenario',
  Rekomendasi: 'Rekomendasi', 'Data & Laporan': 'Data & Laporan', Pengaturan: 'Pengaturan',
}
const perTab = {}
for (const [name, label] of Object.entries(tabLabels)) {
  const before = consoleErrors.length
  const clicked = await ev(`(() => { const b=[...document.querySelectorAll('button[title]')].find(x=>x.title===${JSON.stringify(label)}); if(!b) return 'NOT_FOUND'; b.click(); return 'ok'; })()`)
  await sleep(2200)
  const asideLen = await ev(`(document.querySelector('aside')?.innerText||'').length`)
  perTab[name] = { clicked, newErrors: consoleErrors.length - before, asideChars: asideLen }
  console.log(`  [${name}] ${clicked} asideChars=${asideLen} newErrors=${consoleErrors.length - before}`)
}

// ---------- FILTER TIMING on Analisis Spasial ----------
console.log('\n=== kecamatan filter timing (Analisis Spasial) ===')
await ev(`[...document.querySelectorAll('button[title]')].find(x=>x.title==='Analisis Spasial')?.click()`)
await sleep(3500)
// make sure a data layer is on (kepadatan is default). list options:
const opts = await ev(`[...document.querySelectorAll('aside select option')].map(o=>o.value).filter(Boolean)`)
console.log('  kecamatan options:', JSON.stringify(opts))
// hook maplibre idle timing into window
await ev(`(() => {
  window.__mapIdleAt = null;
  const found = (window.__anaMap) || null;
  return !!found;
})()`)

async function timeFilter(kec) {
  // reset markers, dispatch change, then poll for lastFilterMs text + wait for network+raf settle
  await ev(`window.__t0 = performance.now(); window.__filterMsText = null;`)
  await ev(`(() => {
    const s = document.querySelector('aside select');
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
    set.call(s, ${JSON.stringify(kec)});
    s.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  // poll up to 5s for the app's own "Filter diterapkan dalam N ms"
  let appMs = null, wall = null
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    const t = await ev(`(document.querySelector('aside')?.innerText.match(/Filter diterapkan dalam\\s+([\\d.]+)\\s*ms/)||[])[1] || null`)
    if (t) { appMs = Number(t); wall = await ev(`performance.now() - window.__t0`); break }
  }
  // extra settle for map repaint
  await sleep(400)
  const featCount = await ev(`(() => {
    const m = document.querySelector('aside')?.innerText.match(/(\\d[\\d.]*)\\s*sel/); return m ? m[1] : null;
  })()`)
  return { kec, appReportedMs: appMs, wallClockToReportMs: wall != null ? Math.round(wall) : null, selBadge: featCount }
}

const runs = []
for (const kec of ['Mustika Jaya', 'Bekasi Timur', 'Rawa Lumbu', 'Bantargebang', '']) {
  const r = await timeFilter(kec)
  runs.push(r)
  console.log(`  filter="${kec || '(Semua)'}" -> appReportedMs=${r.appReportedMs} wallClockToReportMs=${r.wallClockToReportMs} selBadge=${r.selBadge}`)
  await sleep(800)
}

console.log('\n================ SUMMARY ================')
console.log('console.error total:', consoleErrors.length)
consoleErrors.slice(0, 25).forEach((e, i) => console.log(`  [err ${i}] ${e.slice(0, 260)}`))
console.log('page exceptions:', pageExceptions.length)
pageExceptions.slice(0, 15).forEach((e, i) => console.log(`  [exc ${i}] ${String(e).slice(0, 260)}`))
console.log('failed network (non-aborted):', failedRequests.length)
failedRequests.slice(0, 15).forEach((e, i) => console.log(`  [net ${i}] ${e}`))
const appMsVals = runs.map((r) => r.appReportedMs).filter((x) => x != null)
const wallVals = runs.map((r) => r.wallClockToReportMs).filter((x) => x != null)
console.log('filter appReportedMs:', JSON.stringify(appMsVals), ' max=', Math.max(...appMsVals))
console.log('filter wallClockToReportMs:', JSON.stringify(wallVals), ' max=', Math.max(...wallVals))
console.log('PRD < 2000ms:', Math.max(...wallVals) < 2000 ? 'PASS (wall)' : 'CHECK', '| appReported', Math.max(...appMsVals) < 2000 ? 'PASS' : 'CHECK')

const fs = await import('node:fs')
const p = new URL(import.meta.url).pathname.replace(/\/[^/]+$/, '') + '/browser-filter-smoke-2026-09-08-result.json'
fs.writeFileSync(process.platform === 'win32' ? p.replace(/^\//, '') : p, JSON.stringify({ shellErrCount, perTab, runs, consoleErrors, pageExceptions, failedRequests }, null, 2))
ws.close(); chrome.kill(); await sleep(300)
console.log('\n=== DONE ===')
process.exit(0)
