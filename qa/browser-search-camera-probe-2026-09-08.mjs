// Focused probe: does selecting a SearchBar result actually move the map?
// Needs vite preview on :4321.  node qa/browser-search-camera-probe-2026-09-08.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9361
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-camprobe', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())
async function cdpPage() {
  for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) return p } catch {} await sleep(250) }
  throw new Error('no CDP')
}
const page = await cdpPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map(); const cerr = []
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') cerr.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ')) })
await new Promise(r => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 500) }; return r.result?.result?.value }
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'http://localhost:4321/' })
await sleep(6000)

// reduced motion?
console.log('prefers-reduced-motion reduce:', await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`))

const FIND = `window.__QA_findMap = function(){
  function isMap(o){ return o && typeof o==='object' && typeof o.getZoom==='function' && typeof o.getCenter==='function' && typeof o.flyTo==='function'; }
  const maps=[]; const seen=new Set();
  const root=document.getElementById('root'); const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));
  let f=root[k]; f=f&&(f.current||f); const st=f?[f]:[]; let g=0;
  while(st.length&&g++<20000){ const x=st.pop(); if(!x||seen.has(x))continue; seen.add(x);
    let h=x.memoizedState,gg=0; while(h&&gg++<60){ const v=h.memoizedState;
      if(isMap(v)&&!maps.includes(v))maps.push(v);
      if(v&&typeof v==='object'&&isMap(v.current)&&!maps.includes(v.current))maps.push(v.current);
      h=h.next; }
    if(x.child)st.push(x.child); if(x.sibling)st.push(x.sibling); }
  return maps;
};`
await ev(FIND)
const nMaps = await ev(`window.__QA_findMap().length`)
console.log('MapLibre instances found via fiber:', nMaps)
const cam = i => ev(`(() => { const m = window.__QA_findMap()[${i}]; if(!m) return null; const c=m.getCenter(); return {lng:+c.lng.toFixed(5),lat:+c.lat.toFixed(5),zoom:+m.getZoom().toFixed(2)}; })()`)
for (let i = 0; i < nMaps; i++) console.log(`  map[${i}] cam=`, JSON.stringify(await cam(i)))

// 1) does map[0] respond to a direct flyTo?
console.log('\n-- direct flyTo on map[0] --')
await ev(`window.__QA_findMap()[0].flyTo({center:[106.95,-6.28], zoom:15, duration:0})`)
await sleep(500)
console.log('  after direct flyTo:', JSON.stringify(await cam(0)))
await ev(`window.__QA_findMap()[0].jumpTo({center:[107.0074,-6.2185], zoom:12})`)
await sleep(300)

// 2) Is App's mapInstance state non-null? scan for a hook whose value isMap AND is map[0]
const appHasMapState = await ev(`(() => {
  const isMap=o=> o && typeof o==='object' && typeof o.flyTo==='function';
  const root=document.getElementById('root'); const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));
  let f=root[k]; f=f&&(f.current||f); const st=f?[f]:[]; let g=0; const found=[];
  while(st.length&&g++<20000){ const x=st.pop(); if(!x)continue;
    const nm = x.type && (x.type.name || x.type.displayName);
    let h=x.memoizedState,gg=0,hooks=[];
    while(h&&gg++<80){ const v=h.memoizedState; if(isMap(v)) hooks.push('mapState'); h=h.next; }
    if(hooks.length) found.push((nm||'?')+':'+hooks.join(','));
    if(x.child)st.push(x.child); if(x.sibling)st.push(x.sibling); }
  return found;
})()`)
console.log('\nfibers holding a map-like useState value:', JSON.stringify(appHasMapState))

// 3) type + select a Wilayah row, poll camera 5s
console.log('\n-- type "margahayu", click Wilayah row, poll camera --')
await ev(`(() => { const s=document.querySelector('input[role="combobox"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(s,'margahayu'); s.dispatchEvent(new Event('input',{bubbles:true})); s.focus(); })()`)
await sleep(1600)
const rows = await ev(`[...(document.querySelector('div[class*="z-50"]')?.querySelectorAll('button[data-idx]')||[])].map(b=>b.innerText.replace(/\\n/g,' | '))`)
console.log('  dropdown rows:', JSON.stringify(rows))
const before = await cam(0)
const clicked = await ev(`(() => { const b=[...(document.querySelector('div[class*="z-50"]')?.querySelectorAll('button[data-idx]')||[])].find(x=>/Kelurahan|Kecamatan/.test(x.innerText)); if(!b) return 'no-row'; b.click(); return b.innerText.replace(/\\n/g,' | '); })()`)
console.log('  clicked:', clicked, '| cam before:', JSON.stringify(before))
for (let i = 0; i < 20; i++) { await sleep(300); const c = await cam(0); if (JSON.stringify(c) !== JSON.stringify(before)) { console.log(`  cam CHANGED @ ${(i + 1) * 300}ms ->`, JSON.stringify(c)); break } if (i === 19) console.log('  cam NEVER changed after 6s ->', JSON.stringify(c)) }

console.log('\nconsole.error:', cerr.length); cerr.slice(0, 10).forEach((e, i) => console.log(' ', i, e.slice(0, 200)))
ws.close(); chrome.kill(); await sleep(200); process.exit(0)
