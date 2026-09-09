import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9363
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1200',
  '--user-data-dir=' + process.env.TEMP + '/qa-chrome-miprobe', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())
async function cdpPage() { for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) return p } catch {} await sleep(250) } throw new Error('no CDP') }
const page = await cdpPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
await new Promise(r => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 600) }; return r.result?.result?.value }
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'http://localhost:4321/' })
await sleep(6500)

const report = await ev(`(() => {
  const isMap = o => o && typeof o==='object' && typeof o.flyTo==='function' && typeof o.getZoom==='function';
  const root=document.getElementById('root'); const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));
  let f=root[k]; f=f&&(f.current||f); const st=f?[f]:[]; let g=0; const out=[];
  while(st.length&&g++<40000){ const x=st.pop(); if(!x)continue;
    const nm = x.type && (typeof x.type==='function') ? (x.type.name||x.type.displayName||'anon') : null;
    if (nm && /^(App|SearchBar|MapView)$/.test(nm)) {
      let h=x.memoizedState, gi=0; const hooks=[];
      while(h&&gi++<120){
        const v=h.memoizedState;
        let desc;
        if (isMap(v)) desc='MAP(state)';
        else if (v && typeof v==='object' && isMap(v.current)) desc='ref->MAP';
        else if (v && typeof v==='object' && 'current' in v) desc='ref('+(v.current===null?'null':typeof v.current)+')';
        else if (typeof v==='function') desc='fn';
        else if (v===null) desc='null';
        else if (Array.isArray(v)) desc='arr['+v.length+']';
        else desc=typeof v;
        hooks.push(gi+':'+desc);
        h=h.next;
      }
      out.push({ nm, hooks });
    }
    if(x.child)st.push(x.child); if(x.sibling)st.push(x.sibling);
  }
  // also the map itself
  let theMap=null;
  const st2=[f]; const seen=new Set(); let g2=0;
  while(st2.length&&g2++<40000){ const x=st2.pop(); if(!x||seen.has(x))continue; seen.add(x);
    let h=x.memoizedState,gi=0; while(h&&gi++<120){ const v=h.memoizedState; if(v&&typeof v==='object'&&isMap(v.current)){theMap=v.current;} if(isMap(v))theMap=v; h=h.next; }
    if(x.child)st2.push(x.child); if(x.sibling)st2.push(x.sibling); }
  return { fibers: out, mapLoaded: theMap ? theMap.loaded() : 'no-map', mapStyleLoaded: theMap ? theMap.isStyleLoaded() : 'n/a' };
})()`)
console.log(JSON.stringify(report, null, 2))

// Force: manually call every function-hook in App with the map? no. Instead check if SearchBar received a non-null mapInstance prop.
const sbProps = await ev(`(() => {
  const isMap = o => o && typeof o==='object' && typeof o.flyTo==='function';
  const root=document.getElementById('root'); const k=Object.keys(root).find(x=>x.startsWith('__reactContainer$'));
  let f=root[k]; f=f&&(f.current||f); const st=[f]; let g=0;
  while(st.length&&g++<40000){ const x=st.pop(); if(!x)continue;
    const nm = x.type && typeof x.type==='function' ? (x.type.name||x.type.displayName) : null;
    if (nm==='SearchBar') {
      const p = x.memoizedProps||{};
      return { hasMapInstanceKey: 'mapInstance' in p, mapInstanceIsMap: isMap(p.mapInstance), mapInstanceVal: p.mapInstance===null?'null':typeof p.mapInstance, propKeys:Object.keys(p) };
    }
    if(x.child)st.push(x.child); if(x.sibling)st.push(x.sibling);
  }
  return 'SearchBar fiber not found';
})()`)
console.log('SearchBar props:', JSON.stringify(sbProps))

ws.close(); chrome.kill(); await sleep(200); process.exit(0)
