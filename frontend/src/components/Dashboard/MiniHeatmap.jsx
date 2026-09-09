import { useEffect, useRef, useState } from 'react'

// MiniHeatmap — thumbnail sebaran "blob panas" Transit Desert Index (skor_tdi)
// di sekitar satu kelurahan, untuk kartu "Top 3 Rekomendasi AI" di Dashboard
// (meniru mockup PRD Gambar 6: peta mini per rekomendasi).
//
// Implementasi = OPSI A (render density ke <canvas>), BUKAN instance MapLibre:
//  - 3 peta GL hidup di dashboard = 3 context WebGL + fetch tile + butuh
//    style/key MAPID hanya untuk gambar 110px — basemap di ukuran itu cuma noise.
//  - Data tetap RIIL: titik = centroid sel grid_analisis (WKB di-parse
//    client-side lewat lib/geo.js), bobot = skor_tdi. Tidak ada blob karangan.
//  - Ringan: ~1.500 blob radial + 1x getImageData 300x110 per thumbnail,
//    jauh di bawah anggaran performa dashboard.
//
// Props:
//  - name        : nama kelurahan (untuk caption)
//  - rings       : array ring [[lon,lat], ...] batas kelurahan (exterior + hole),
//                  null/undefined => placeholder "Peta tidak tersedia"
//  - points      : array { lat, lng, tdi } SELURUH sel transit desert kota
//                  (di-fetch SEKALI di Dashboard, dibagi ke 3 thumbnail);
//                  null => masih memuat
//  - pointsError : true kalau fetch grid_analisis gagal => outline saja + catatan
//
// Degradasi: tanpa rings -> kotak abu netral. Tanpa points (loading/gagal) ->
// outline kelurahan riil saja, tidak pernah blob palsu.

// Palet sequential colorblind-safe (Viridis) — CLAUDE.md Bab 10.3: jangan
// bergantung pada merah–hijau untuk indeks. Ujung kuning = "panas" (skor_tdi
// tinggi = indikasi transit desert kuat).
const VIRIDIS = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
]

function viridis(t) {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = VIRIDIS[i]
  const b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

const H = 112 // tinggi thumbnail (px CSS)
// Sel yang di-fetch Dashboard sudah difilter skor_tdi > ambang ini; dipakai
// untuk menormalkan bobot blob supaya kontras antar sel tetap terlihat.
const TDI_FLOOR = 0.6

export default function MiniHeatmap({ name, rings, points, pointsError }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [width, setWidth] = useState(280)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w) setWidth(Math.max(120, Math.round(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !Array.isArray(rings) || !rings.length) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = width
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // bbox gabungan semua ring batas kelurahan
    let minLon = Infinity
    let maxLon = -Infinity
    let minLat = Infinity
    let maxLat = -Infinity
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
    if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return

    // margin ~30% supaya sel di sekitar kelurahan ikut kelihatan (konteks)
    const padLon = (maxLon - minLon) * 0.3 || 0.005
    const padLat = (maxLat - minLat) * 0.3 || 0.005
    minLon -= padLon
    maxLon += padLon
    minLat -= padLat
    maxLat += padLat

    // proyeksi equirectangular sederhana, jaga rasio aspek (letterbox)
    const midLat = (minLat + maxLat) / 2
    const kx = Math.cos((midLat * Math.PI) / 180) || 1
    const geoW = (maxLon - minLon) * kx
    const geoH = maxLat - minLat
    if (geoW <= 0 || geoH <= 0) return
    const pad = 6
    const scale = Math.min((W - pad * 2) / geoW, (H - pad * 2) / geoH)
    const offX = (W - geoW * scale) / 2
    const offY = (H - geoH * scale) / 2
    const project = (lon, lat) => [
      offX + (lon - minLon) * kx * scale,
      H - (offY + (lat - minLat) * scale), // flip: lat naik = ke atas
    ]

    // sel transit desert yang jatuh di dalam bbox kelurahan (+margin)
    const inBox = Array.isArray(points)
      ? points.filter(
          (p) =>
            p.lng >= minLon &&
            p.lng <= maxLon &&
            p.lat >= minLat &&
            p.lat <= maxLat,
        )
      : []

    if (inBox.length) {
      // Pass 1 — akumulasi alpha grayscale (blob radial additif)
      const r = Math.max(9, H * 0.22)
      ctx.globalCompositeOperation = 'lighter'
      for (const p of inBox) {
        const [x, y] = project(p.lng, p.lat)
        const w = Math.min(
          1,
          Math.max(0.08, (Number(p.tdi) - TDI_FLOOR) / (1 - TDI_FLOOR)),
        )
        const g = ctx.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `rgba(255,255,255,${0.05 + 0.28 * w})`)
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      // Pass 2 — petakan alpha terakumulasi ke ramp Viridis
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d = img.data
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3]
        if (a === 0) continue
        const [cr, cg, cb] = viridis(Math.min(1, a / 200))
        d[i] = cr
        d[i + 1] = cg
        d[i + 2] = cb
        d[i + 3] = Math.min(255, Math.round(a * 1.6))
      }
      ctx.putImageData(img, 0, 0)
    }

    // Pass 3 — outline batas kelurahan (konteks)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(15,23,42,0.55)'
    for (const ring of rings) {
      ctx.beginPath()
      ring.forEach(([lon, lat], idx) => {
        const [x, y] = project(lon, lat)
        if (idx === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.stroke()
    }
  }, [rings, points, width])

  if (!Array.isArray(rings) || !rings.length) {
    return (
      <div
        ref={wrapRef}
        className="mt-2 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center"
        style={{ height: H }}
      >
        <span className="text-[10px] text-slate-400">Peta tidak tersedia</span>
      </div>
    )
  }

  const loading = !Array.isArray(points) && !pointsError

  return (
    <div ref={wrapRef} className="mt-2">
      <div
        className="relative rounded-md overflow-hidden border border-slate-200 bg-slate-50"
        style={{ height: H }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: H, display: 'block' }}
        />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] text-slate-400">Memuat sebaran TDI…</span>
          </div>
        )}
        {pointsError && (
          <span className="absolute bottom-1 left-1.5 text-[9px] text-slate-500 bg-white/75 rounded px-1 leading-tight">
            Sebaran TDI tidak tersedia
          </span>
        )}
        {!loading && !pointsError && (
          <span className="absolute bottom-1 left-1.5 text-[9px] text-slate-600 bg-white/75 rounded px-1 leading-tight">
            {name} · kuning = skor_tdi tinggi
          </span>
        )}
      </div>
      {/* TODO(ui-ux-designer): gaya legenda mini + posisi caption thumbnail final */}
    </div>
  )
}
