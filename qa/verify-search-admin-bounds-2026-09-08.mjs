// qa/verify-search-admin-bounds-2026-09-08.mjs
// E2E verification of RPC search_admin_bounds (migration 030) against REMOTE.
// Uses ANON/publishable key ONLY (tests that unauthenticated frontend can call it).
// Read-only.  node qa/verify-search-admin-bounds-2026-09-08.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '../frontend/node_modules/@supabase/supabase-js/dist/index.mjs'

function parseEnv(p) {
  const o = {}
  for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z_]+)=(.*)$/)
    if (m) o[m[1]] = m[2].trim()
  }
  return o
}
const fe = parseEnv(new URL('../frontend/.env', import.meta.url))
const anon = createClient(fe.VITE_SUPABASE_URL, fe.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
// service key (only for the batas_administrasi row-count sanity in section 7)
let SERVICE = null
try { SERVICE = parseEnv(new URL('../etl/.env', import.meta.url)).SUPABASE_SERVICE_ROLE_KEY } catch {}
const svc = SERVICE ? createClient(fe.VITE_SUPABASE_URL, SERVICE, { auth: { persistSession: false } }) : null
console.log('url:', fe.VITE_SUPABASE_URL, '| anon key prefix:', fe.VITE_SUPABASE_ANON_KEY.slice(0, 20), '| service key present:', !!SERVICE)

const BEKASI_BBOX = { lngMin: 106.85, lngMax: 107.15, latMin: -6.45, latMax: -6.05 }
function bboxSane(r) {
  const okOrder = r.min_lng < r.max_lng && r.min_lat < r.max_lat
  const inCity =
    r.min_lng >= BEKASI_BBOX.lngMin && r.max_lng <= BEKASI_BBOX.lngMax &&
    r.min_lat >= BEKASI_BBOX.latMin && r.max_lat <= BEKASI_BBOX.latMax
  return { okOrder, inCity }
}
async function call(q) {
  const t0 = performance.now()
  const { data, error } = await anon.rpc('search_admin_bounds', { q })
  const ms = performance.now() - t0
  return { ms, data, error }
}
function dump(rows) {
  for (const r of rows) {
    const s = bboxSane(r)
    console.log(
      `    [${r.level.padEnd(9)}] ${String(r.nama).padEnd(22)} kec=${String(r.nama_kecamatan).padEnd(16)} ` +
      `bbox=[${Number(r.min_lng).toFixed(4)},${Number(r.min_lat).toFixed(4)} .. ${Number(r.max_lng).toFixed(4)},${Number(r.max_lat).toFixed(4)}] ` +
      `${s.okOrder ? 'ord:OK' : 'ord:BAD'} ${s.inCity ? 'city:OK' : 'city:OUT'}`,
    )
  }
}

// ============ 2. 'bekasi' ============
console.log('\n======== 2. search_admin_bounds(\'bekasi\') ========')
{
  const { ms, data, error } = await call('bekasi')
  if (error) { console.log('  ERROR:', JSON.stringify(error)) }
  else {
    console.log(`  ${data.length} rows in ${ms.toFixed(0)}ms  (expect <=12)`)
    dump(data)
    const kecFirst = (() => {
      let seenKel = false
      for (const r of data) {
        if (r.level === 'kelurahan') seenKel = true
        if (r.level === 'kecamatan' && seenKel) return false
      }
      return true
    })()
    const allOrd = data.every((r) => bboxSane(r).okOrder)
    const allCity = data.every((r) => bboxSane(r).inCity)
    console.log(`  kecamatan-before-kelurahan: ${kecFirst}  | all bbox order OK: ${allOrd}  | all within city bbox: ${allCity}  | <=12: ${data.length <= 12}`)
  }
}

// ============ 3. guard: 'a', '', ' ' ============
console.log('\n======== 3. guard (short/empty) ========')
for (const q of ['a', '', ' ', '  ']) {
  const { data, error } = await call(q)
  console.log(`  q=${JSON.stringify(q)} -> ${error ? 'ERROR ' + error.message : (data.length + ' rows')}  ${data && data.length === 0 ? 'OK' : 'CHECK'}`)
}

// ============ 4. 'margahayu' ============
console.log('\n======== 4. search_admin_bounds(\'margahayu\') ========')
{
  const { data, error } = await call('margahayu')
  if (error) console.log('  ERROR:', error.message)
  else {
    console.log(`  ${data.length} rows`)
    dump(data)
    const kel = data.filter((r) => r.level === 'kelurahan')
    console.log(`  exactly 1 kelurahan row: ${kel.length === 1}  | parent kecamatan: ${kel[0]?.nama_kecamatan} (expect Bekasi Timur)`)
    if (kel[0]) {
      const w = (kel[0].max_lng - kel[0].min_lng), h = (kel[0].max_lat - kel[0].min_lat)
      console.log(`  bbox span deg: dLng=${w.toFixed(4)} dLat=${h.toFixed(4)} (small = sane, expect < ~0.1)`)
    }
  }
}

// ============ 5. 'bekasi timur' ============
console.log('\n======== 5. search_admin_bounds(\'bekasi timur\') ========')
{
  const { data, error } = await call('bekasi timur')
  if (error) console.log('  ERROR:', error.message)
  else {
    console.log(`  ${data.length} rows`)
    dump(data)
    const kec = data.find((r) => r.level === 'kecamatan')
    if (kec) {
      const cx = (kec.min_lng + kec.max_lng) / 2
      console.log(`  kecamatan bbox centre lng=${cx.toFixed(4)} (east side => expect > ~107.00): ${cx > 107.0 ? 'PLAUSIBLE east' : 'CHECK - not east'}`)
    } else console.log('  no kecamatan row returned - CHECK')
  }
}

// ============ 6. ANON callable ============
console.log('\n======== 6. RPC callable with ANON key ========')
{
  const { data, error } = await call('bekasi')
  if (error) console.log(`  BLOCKER: anon call failed -> ${JSON.stringify(error)}`)
  else console.log(`  OK: anon key returned ${data.length} rows, no permission error`)
}

// ============ 7. batas_administrasi real vs dummy ============
console.log('\n======== 7. batas_administrasi population (real 56 kel / 12 kec vs dummy 6) ========')
{
  const client = svc || anon
  const { data, error, count } = await client
    .from('batas_administrasi')
    .select('nama_kecamatan, nama_kelurahan', { count: 'exact' })
  if (error) { console.log('  ERROR:', error.message) }
  else {
    const kecs = [...new Set(data.map((r) => r.nama_kecamatan))].sort()
    const kels = [...new Set(data.map((r) => r.nama_kelurahan))]
    console.log(`  total rows: ${count ?? data.length}`)
    console.log(`  distinct kecamatan: ${kecs.length}  -> ${JSON.stringify(kecs)}`)
    console.log(`  distinct kelurahan: ${kels.length}`)
    const verdict = kecs.length >= 12 && kels.length >= 50 ? 'REAL (full admin)' :
      (data.length <= 8 ? 'DUMMY (migration 006 seed only)' : 'PARTIAL / unclear')
    console.log(`  VERDICT: ${verdict}`)
  }
}

console.log('\n=== SELESAI ===')
process.exit(0)
