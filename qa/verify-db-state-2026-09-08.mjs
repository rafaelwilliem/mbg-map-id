// qa/verify-db-state-2026-09-08.mjs
// Empirical DB-state verification sprint (2026-09-08). Read-only.
//   node qa/verify-db-state-2026-09-08.mjs
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
let SERVICE = null
try { SERVICE = parseEnv(new URL('../etl/.env', import.meta.url)).SUPABASE_SERVICE_ROLE_KEY } catch {}
const svc = createClient(fe.VITE_SUPABASE_URL, SERVICE || fe.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
console.log('service key present:', !!SERVICE, '| url:', fe.VITE_SUPABASE_URL)

const stat = (arr) => {
  const s = arr.filter((x) => x != null).map(Number).sort((a, b) => a - b)
  if (!s.length) return { n: 0 }
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return { n: s.length, min: +s[0].toFixed(4), p10: +s[Math.floor(s.length*0.1)].toFixed(4), median: +med.toFixed(4), mean: +mean.toFixed(4), p90: +s[Math.floor(s.length*0.9)].toFixed(4), max: +s[s.length - 1].toFixed(4) }
}
async function fetchAll(table, cols, mod = (q) => q) {
  const out = []
  const page = 1000
  for (let from = 0; ; from += page) {
    let q = svc.from(table).select(cols).range(from, from + page - 1)
    q = mod(q)
    const { data, error } = await q
    if (error) { console.log(`ERR ${table}:`, error.message); break }
    out.push(...data)
    if (data.length < page) break
  }
  return out
}

// ============ A2. grid_analisis.skor_tdi ============
console.log('\n======== A2. grid_analisis.skor_tdi (post-026) ========')
{
  const g = await fetchAll('grid_analisis', 'id, skor_tdi, indeks_kebutuhan_mobilitas, kepadatan_penduduk, skor_aksesibilitas_transit')
  const n = g.length
  const tdiNull = g.filter((r) => r.skor_tdi == null).length
  const tdiOob = g.filter((r) => r.skor_tdi != null && (r.skor_tdi < 0 || r.skor_tdi > 1)).length
  const gt06 = g.filter((r) => r.skor_tdi != null && r.skor_tdi > 0.6).length
  const ikmNull = g.filter((r) => r.indeks_kebutuhan_mobilitas == null).length
  const ikmFlat = [...new Set(g.map((r) => r.indeks_kebutuhan_mobilitas != null ? Number(r.indeks_kebutuhan_mobilitas).toFixed(3) : null))]
  console.log(`  total sel: ${n}`)
  console.log(`  skor_tdi: NULL=${tdiNull}  OOB[0,1]=${tdiOob}  >0.6=${gt06} (${(100*gt06/n).toFixed(1)}%)`)
  console.log(`  skor_tdi dist: ${JSON.stringify(stat(g.map((r) => r.skor_tdi)))}`)
  console.log(`  IKM: NULL=${ikmNull}  distinct(3dp) count=${ikmFlat.length}  dist: ${JSON.stringify(stat(g.map((r) => r.indeks_kebutuhan_mobilitas)))}`)
  console.log(`  -> IKM varies spatially? ${ikmFlat.length > 5 ? 'YES (not flat 0.5)' : 'SUSPECT flat: ' + ikmFlat.slice(0,8)}`)
}

// ============ A2b. compute_tdi report artifact ============
console.log('\n======== A2b. TDI recompute artifact ========')
{
  const fs = await import('node:fs')
  const dirs = ['../etl', '../etl/reports', '../etl/out', '../docs']
  for (const d of dirs) {
    try {
      const p = new URL(d + '/', import.meta.url)
      const files = fs.readdirSync(p)
      const hits = files.filter((f) => /tdi|usia_sekolah|compute_tdi/i.test(f))
      if (hits.length) console.log(`  ${d}: ${hits.join(', ')}`)
    } catch {}
  }
}

// ============ A3. usulan_halte_model ============
console.log('\n======== A3. usulan_halte_model (028) ========')
{
  const { data, error } = await svc.from('usulan_halte_model').select('*').order('ranking')
  if (error) { console.log('  ERR:', error.message) }
  else {
    console.log(`  row count: ${data.length}  (pipeline cap = 25)`)
    const p4Null = data.filter((r) => r.penduduk_terlayani_400m == null).length
    const p8Null = data.filter((r) => r.penduduk_terlayani_800m == null).length
    const p4Neg = data.filter((r) => r.penduduk_terlayani_400m < 0).length
    const p8Neg = data.filter((r) => r.penduduk_terlayani_800m < 0).length
    const jNear = data.filter((r) => r.jarak_halte_terdekat_m != null && r.jarak_halte_terdekat_m < 400).length
    console.log(`  penduduk_terlayani_400m: NULL=${p4Null} neg=${p4Neg}  dist=${JSON.stringify(stat(data.map(r=>r.penduduk_terlayani_400m)))}`)
    console.log(`  penduduk_terlayani_800m: NULL=${p8Null} neg=${p8Neg}  dist=${JSON.stringify(stat(data.map(r=>r.penduduk_terlayani_800m)))}`)
    console.log(`  jarak_halte_terdekat_m < 400 (violates construction): ${jNear}  dist=${JSON.stringify(stat(data.map(r=>r.jarak_halte_terdekat_m)))}`)
    console.log(`  skor_tdi_sel dist: ${JSON.stringify(stat(data.map(r=>r.skor_tdi_sel)))}  (all should be > 0.6)`)
    const belowThresh = data.filter((r) => r.skor_tdi_sel != null && r.skor_tdi_sel <= 0.6).length
    console.log(`  skor_tdi_sel <= 0.6: ${belowThresh}`)
    // ranking monotonic w/ penduduk_terlayani_800m desc?
    let mono = true
    for (let i = 1; i < data.length; i++) if ((data[i].penduduk_terlayani_800m ?? -1) > (data[i-1].penduduk_terlayani_800m ?? -1)) mono = false
    console.log(`  ranking monotonic decreasing by penduduk_terlayani_800m: ${mono}`)
    console.log('  first 6 rows:')
    for (const r of data.slice(0, 6)) console.log(`    #${r.ranking} ${r.kode}  tdi=${r.skor_tdi_sel}  p400=${r.penduduk_terlayani_400m}  p800=${r.penduduk_terlayani_800m}  jHalte=${r.jarak_halte_terdekat_m}  ${r.kecamatan}/${r.kelurahan}`)
    console.log('  last 3 rows:')
    for (const r of data.slice(-3)) console.log(`    #${r.ranking} ${r.kode}  tdi=${r.skor_tdi_sel}  p400=${r.penduduk_terlayani_400m}  p800=${r.penduduk_terlayani_800m}  jHalte=${r.jarak_halte_terdekat_m}  ${r.kecamatan}/${r.kelurahan}`)
  }
}

// ============ A4. skor_equity post-029 ============
console.log('\n======== A4. skor_equity (post-029) ========')
{
  const all = await fetchAll('skor_equity', '*')
  const real = all.filter((r) => (r.sumber || '').startsWith('REAL'))
  console.log(`  total rows: ${all.length}  REAL rows: ${real.length}`)
  const noKel = real.filter((r) => !r.kelompok_terdampak || (Array.isArray(r.kelompok_terdampak) && r.kelompok_terdampak.length === 0)).length
  const noRek = real.filter((r) => !r.rekomendasi_intervensi).length
  const oob = real.filter((r) => r.skor_final != null && (r.skor_final < 0 || r.skor_final > 1)).length
  const sfNull = real.filter((r) => r.skor_final == null).length
  console.log(`  REAL missing kelompok_terdampak: ${noKel}   missing rekomendasi_intervensi: ${noRek}`)
  console.log(`  skor_final: NULL=${sfNull}  OOB[0,1]=${oob}  dist=${JSON.stringify(stat(real.map(r=>r.skor_final)))}`)
  // direction: rank 1 should have highest skor_final
  const byRank = [...real].filter(r=>r.ranking!=null).sort((a,b)=>a.ranking-b.ranking)
  const r1 = byRank[0], rLast = byRank[byRank.length-1]
  const maxSf = Math.max(...real.map(r=>Number(r.skor_final)))
  const minSf = Math.min(...real.map(r=>Number(r.skor_final)))
  console.log(`  rank 1 = ${r1?.nama_kelurahan||r1?.kelurahan_id} skor_final=${Number(r1?.skor_final).toFixed(4)} (max in set = ${maxSf.toFixed(4)})  -> direction ${Number(r1?.skor_final)===maxSf?'OK (higher=worse)':'WRONG'}`)
  console.log(`  rank ${rLast?.ranking} = ${rLast?.nama_kelurahan||rLast?.kelurahan_id} skor_final=${Number(rLast?.skor_final).toFixed(4)} (min = ${minSf.toFixed(4)})`)
  // ranking contiguous 1..N ?
  const ranks = byRank.map(r=>r.ranking)
  const contiguous = ranks.every((v,i)=> i===0 || v===ranks[i-1]+1)
  console.log(`  ranking contiguous 1..${ranks[ranks.length-1]}: ${contiguous}`)
  console.log('  TOP 6:')
  for (const r of byRank.slice(0,6)) console.log(`    #${r.ranking} ${String(r.nama_kelurahan||r.kelurahan_id).padEnd(20)} sf=${Number(r.skor_final).toFixed(4)}  kelompok=[${(r.kelompok_terdampak||[]).join('; ')}]  rekomLen=${(r.rekomendasi_intervensi||'').length}`)
}

// ============ A5. skor_cai ============
console.log('\n======== A5. skor_cai range/null check ========')
{
  const d = await fetchAll('skor_cai', '*')
  console.log(`  rows: ${d.length}`)
  const cols = Object.keys(d[0] || {})
  console.log(`  columns: ${cols.join(', ')}`)
  const scoreCol = cols.includes('skor_cai') ? 'skor_cai' : (cols.includes('skor_final') ? 'skor_final' : null)
  for (const c of cols.filter(c=>/^(skor|n_|bobot_)/.test(c))) {
    const vals = d.map(r=>r[c])
    const nn = vals.filter(v=>v!=null)
    const oob = nn.filter(v=>Number(v) < 0 || Number(v) > 1).length
    const nulls = vals.length - nn.length
    console.log(`    ${c.padEnd(22)} NULL=${String(nulls).padStart(3)}  OOB[0,1]=${oob}  dist=${JSON.stringify(stat(vals))}`)
  }
  // titik_kandidat rows w/ NULL n_survei expected
  if (cols.includes('n_survei')) {
    const nsNull = d.filter(r => r.n_survei == null).length
    console.log(`  n_survei NULL rows: ${nsNull} (expected: titik_kandidat rows per 2026-09-07 deviation)`)
  }
}

// ============ B2. simulate_new_stop RPC timing + correctness ============
console.log('\n======== B2. simulate_new_stop (RPC) timing + sanity ========')
{
  // discover signature by trying common param names
  const pts = [
    ['Mustika Jaya (PRD)', -6.2986, 107.0620],
    ['pusat kota alun2', -6.2383, 106.9896],
    ['Bekasi Utara padat', -6.1850, 106.9750],
    ['tepi/luar - far SE', -6.35, 107.10],
  ]
  const tryCall = async (lat, lon) => {
    const variants = [
      { p_lat: lat, p_lon: lon },
      { lat, lon },
      { lat, lng: lon },
      { p_lat: lat, p_lng: lon },
      { in_lat: lat, in_lon: lon },
    ]
    for (const v of variants) {
      const t0 = performance.now()
      const { data, error } = await svc.rpc('simulate_new_stop', v)
      const ms = performance.now() - t0
      if (!error) return { ok: true, ms, data, params: Object.keys(v) }
      if (!/could not find|function|does not exist|schema cache/i.test(error.message)) return { ok: false, ms, error: error.message, params: Object.keys(v) }
    }
    return { ok: false, error: 'no param variant matched' }
  }
  for (const [label, lat, lon] of pts) {
    const r = await tryCall(lat, lon)
    if (!r.ok) { console.log(`  ${label}: FAIL ${r.error}`); continue }
    const d = Array.isArray(r.data) ? r.data[0] : r.data
    console.log(`  ${label}: ${r.ms.toFixed(0)}ms  params=[${r.params}]`)
    console.log(`     ${JSON.stringify(d)}`)
  }
}

console.log('\n=== SELESAI ===')
