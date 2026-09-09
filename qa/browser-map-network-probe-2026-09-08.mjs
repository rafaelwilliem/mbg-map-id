import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9365
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-netprobe', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())
async function cdpPage() { for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) return p } catch {} await sleep(250) } throw new Error('no CDP') }
const page = await cdpPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const reqs = new Map(); const responses = []; const failed = []; const warns = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
  if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, m.params.request.url)
  if (m.method === 'Network.responseReceived') { const u = m.params.response.url; if (/mapid|basemap|tile|style|maptiler|openstreetmap/i.test(u)) responses.push(`${m.params.response.status} ${u.slice(0, 130)}`) }
  if (m.method === 'Network.loadingFailed') { const u = reqs.get(m.params.requestId) || '?'; if (/mapid|basemap|tile|style|openstreetmap/i.test(u)) failed.push(`${m.params.errorText} ${u.slice(0, 130)}`) }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) warns.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200))
})
await new Promise(r => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value }
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
await send('Page.navigate', { url: 'http://localhost:4321/' })
await sleep(9000)

const mapState = await ev(`(() => {
  const isMap = o => o && typeof o==='object' && typeof o.flyTo==='function' && typeof o.getZoom==='function';
  const root=document.getElementById('root'); const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));
  let f=root[k]; f=f&&(f.current||f); const st=[f]; const seen=new Set(); let g=0; let map=null;
  while(st.length&&g++<40000){ const x=st.pop(); if(!x||seen.has(x))continue; seen.add(x);
    let h=x.memoizedState,gi=0; while(h&&gi++<120){ const v=h.memoizedState; if(v&&typeof v==='object'&&isMap(v.current))map=v.current; if(isMap(v))map=v; h=h.next; }
    if(x.child)st.push(x.child); if(x.sibling)st.push(x.sibling); }
  if(!map) return 'no-map';
  return { loaded: map.loaded(), styleLoaded: map.isStyleLoaded(), hasImage: !!map.style, layers: (map.getStyle && map.getStyle().layers||[]).length };
})()`)
console.log('map state after 9s:', JSON.stringify(mapState))
console.log('\nbasemap-ish responses:'); responses.forEach(r => console.log('  ', r))
console.log('\nbasemap-ish failed:'); failed.forEach(r => console.log('  ', r))
console.log('\nwarn/err console:'); [...new Set(warns)].slice(0, 20).forEach(r => console.log('  ', r))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) { writeFileSync('C:/Users/Agentsae/AppData/Local/Temp/claude/C--Users-Agentsae-mbg-webgis/495cd438-27ca-4d04-94b2-7e1d3d95397f/scratchpad/map-headless.png', Buffer.from(shot.result.data, 'base64')); console.log('\nscreenshot saved to scratchpad/map-headless.png') }

ws.close(); chrome.kill(); await sleep(200); process.exit(0)
