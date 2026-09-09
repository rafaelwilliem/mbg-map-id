// qa/verify-get-admin-geometry-2026-09-08.mjs
// Cek kontrak RPC get_admin_geometry(p_level, p_nama) dari sisi ANON (persis
// seperti dipanggil SearchBar). Read-only. Kalau RPC belum ter-deploy, script
// ini melaporkannya sebagai "BELUM DEPLOY", bukan gagal keras — sisi klien
// memang dirancang degrade gracefully.
//   node qa/verify-get-admin-geometry-2026-09-08.mjs
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
const anon = createClient(fe.VITE_SUPABASE_URL, fe.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})

const KASUS = [
  ['kecamatan', 'Bekasi Timur'],
  ['kelurahan', 'Margahayu'],
  ['kecamatan', 'Mustikajaya'],
  ['kelurahan', 'Tidak Ada Kelurahan Ini'],
]

for (const [p_level, p_nama] of KASUS) {
  const t0 = Date.now()
  const { data, error } = await anon.rpc('get_admin_geometry', { p_level, p_nama })
  const ms = Date.now() - t0
  if (error) {
    console.log(`${p_level}/${p_nama}: ERROR (${ms} ms) ${error.code || ''} ${error.message}`)
    continue
  }
  const rows = Array.isArray(data) ? data : data ? [data] : []
  const r = rows[0]
  if (!r) {
    console.log(`${p_level}/${p_nama}: 0 baris (${ms} ms)`)
    continue
  }
  const g = typeof r.geojson === 'string' ? JSON.parse(r.geojson) : r.geojson
  console.log(
    `${p_level}/${p_nama}: 1 baris (${ms} ms) level=${r.level} nama="${r.nama}" ` +
      `geom=${g?.type} ring0=${
        g?.type === 'Polygon' ? g.coordinates?.[0]?.length : g?.coordinates?.[0]?.[0]?.length
      } ` +
      `bbox=[${[r.min_lng, r.min_lat, r.max_lng, r.max_lat].map((v) => Number(v).toFixed(4))}] ` +
      `bytes=${JSON.stringify(r.geojson).length}`,
  )
}
process.exit(0)
