import { useEffect, useState } from 'react'
import { FileDown, FileImage, FileText, Loader2 } from 'lucide-react'
import { jsPDF } from 'jspdf'
import { supabase, isConfigured } from '../../lib/supabaseClient'
import { KOTA_PROFIL } from '../../lib/kotaProfil'

/**
 * DataLaporan — tab "Data & Laporan" (PRD Bab 8 "Export Report" + User Flow
 * Bab 10.1 langkah terakhir). Menghasilkan ringkasan satu halaman: tampilan
 * peta Kota Bekasi + indikator kunci (ringkasan kota, transit desert, coverage
 * ratio, potensi penerima manfaat, ringkasan CAI grid), daftar Usulan Halte
 * Prioritas top 5, dan ranking Transit Equity Index teratas sebagai PDF/PNG.
 *
 * Catatan implementasi: komposisi ekspor TIDAK memakai html2canvas atas DOM
 * ber-Tailwind (Tailwind v4 memakai warna oklch() yang belum didukung
 * html2canvas 1.4.1 dan bikin ekspor gagal). Sebagai gantinya:
 *   - PNG: digambar manual ke <canvas> 2D (teks + drawImage kanvas peta).
 *   - PDF: jsPDF langsung (doc.text + doc.addImage kanvas peta).
 *
 * Kanvas peta yang direkam = peta UTAMA (MapView di <main> App.jsx), dioper
 * lewat prop `mapInstance`. Sebelumnya komponen ini men-spawn MapView kedua di
 * panel 208 px; peta kecil itu sering ter-init 0x0 di dalam scroll-container
 * dan TIDAK PERNAH menggambar tile -> export selalu tanpa peta (deteksi blank
 * -> note). Peta utama selalu ter-render (view yang sedang dilihat user),
 * `preserveDrawingBuffer: true` di MapView bikin kanvasnya bisa dibaca ulang.
 * Konsekuensi: laporan merekam tampilan "Peta Interaktif" saat itu (zoom/layer
 * yang sedang aktif) — sesuai "tampilan peta" di PRD Bab 8.
 *
 * Semua angka murni membaca hasil yang sudah dihitung di Supabase — tidak ada
 * formula CAI/TDI/Equity dihitung ulang di sini.
 */

const TRANSIT_DESERT_THRESHOLD = 0.6
// Ambang "aksesibilitas tinggi" untuk ringkasan CAI grid — sama dengan ambang
// yang dipakai di permukaan CAI grid 300 m (get_cai_breakdown / migration 033).
const CAI_HIGH_THRESHOLD = 0.6
// Total sel grid analisis Kota Bekasi (grid 300 m). Dipakai hanya sebagai
// penyebut tampilan "{count} dari {total}" — TIDAK memicu fetch 2.607 baris.
const GRID_TOTAL = 2607

const DEMO_MODEL = {
  transitDesertCount: 1503,
  transitDesertDemo: true,
  cityCoverage800m: 0.071,
  coverageDemo: true,
  // Cermin kartu "Potensi Penerima Manfaat" di Dashboard.jsx (RPC
  // potensi_penerima_manfaat, migration 022) — ballpark ~163 rb jiwa.
  potensiPenerimaManfaat: 163000,
  potensiDemo: true,
  // Ringkasan CAI grid: jumlah sel dengan cai_skor >= 0,6.
  caiHighCount: 690,
  caiDemo: true,
  // Usulan Halte Prioritas (usulan_halte_model) — usulan dari model spasial,
  // BELUM disurvei lapangan. Ranking primer = penduduk terlayani.
  usulanTop: [
    { rank: 1, kode: 'UHM-01', kelurahan: 'Ciketing Udik', kecamatan: 'Bantargebang', p400: 3100, p800: 9800 },
    { rank: 2, kode: 'UHM-02', kelurahan: 'Padurenan', kecamatan: 'Mustikajaya', p400: 2800, p800: 8700 },
    { rank: 3, kode: 'UHM-03', kelurahan: 'Bojongmenteng', kecamatan: 'Rawalumbu', p400: 2500, p800: 7900 },
    { rank: 4, kode: 'UHM-04', kelurahan: 'Jatirangga', kecamatan: 'Jatisampurna', p400: 2300, p800: 7200 },
    { rank: 5, kode: 'UHM-05', kelurahan: 'Cimuning', kecamatan: 'Mustikajaya', p400: 2100, p800: 6800 },
  ],
  usulanDemo: true,
  equityTop: [
    { rank: 1, kelurahan: 'Arenjaya', skor: 0.83 },
    { rank: 2, kelurahan: 'Mustika Jaya', skor: 0.81 },
    { rank: 3, kelurahan: 'Bantar Gebang', skor: 0.76 },
    { rank: 4, kelurahan: 'Rawa Lumbu', skor: 0.71 },
    { rank: 5, kelurahan: 'Bekasi Jaya', skor: 0.68 },
  ],
  equityDemo: true,
}

export default function DataLaporan({ mapInstance = null }) {
  const [model, setModel] = useState(DEMO_MODEL)
  const [loadingModel, setLoadingModel] = useState(isConfigured)
  const [exporting, setExporting] = useState(null) // 'png' | 'pdf' | null
  const [note, setNote] = useState(null)
  // mapPainted = peta UTAMA sudah benar-benar menggambar tile (bukan sekadar
  // "instance peta ada"). Tombol unduh baru aktif setelah ini true, supaya klik
  // langsung menghasilkan file DENGAN peta — tanpa penantian panjang saat klik.
  const [mapPainted, setMapPainted] = useState(false)
  // paintTimedOut = safety timeout tercapai sebelum 'idle' (tile vektor MAPID
  // streaming terus). Tombol tetap dibuka, hanya diberi hint kecil.
  const [paintTimedOut, setPaintTimedOut] = useState(false)

  // Tunggu peta UTAMA (prop mapInstance, di-lift dari MapView <main> App.jsx)
  // benar-benar ter-cat. Dilakukan saat tab dibuka, BUKAN saat klik unduh —
  // jadi captureMap() nanti cukup redraw + rAF. Peta utama praktis selalu sudah
  // ter-render (user baru saja melihatnya di tab lain), tapi guard 'idle'/'load'
  // + timeout 12 dtk tetap dipasang untuk kasus MAPID lambat.
  useEffect(() => {
    const m = mapInstance
    if (!m) return
    let settled = false
    const mark = () => {
      if (settled) return
      settled = true
      clearTimeout(t)
      try { m.off('idle', mark); m.off('load', mark) } catch { /* noop */ }
      setMapPainted(true)
    }
    const styleReady = typeof m.isStyleLoaded !== 'function' || m.isStyleLoaded()
    const fullyLoaded = typeof m.loaded !== 'function' || m.loaded()
    if (styleReady && fullyLoaded) {
      requestAnimationFrame(() => requestAnimationFrame(mark))
    } else {
      m.once('idle', mark)
      m.on('load', mark)
    }
    const t = setTimeout(() => { setPaintTimedOut(true); mark() }, 12000)
    return () => {
      clearTimeout(t)
      try { m.off('idle', mark); m.off('load', mark) } catch { /* noop */ }
    }
  }, [mapInstance])

  useEffect(() => {
    if (!isConfigured) return
    let cancelled = false

    async function load() {
      const next = { ...DEMO_MODEL }

      // Semua kueri dijalankan PARALEL (Promise.allSettled) — satu kueri lambat
      // (mis. count grid 2.607 sel / RPC join spasial saat PostgREST dingin)
      // tidak lagi memblok yang lain, jadi `setModel` tidak menunggu rantai
      // await terpanjang. Tiap blok punya try/catch sendiri: gagal → tetap demo
      // untuk slice itu saja. Semua angka murni membaca hasil di Supabase.
      await Promise.allSettled([
        // Transit desert count — count atas skor_tdi yang sudah dihitung.
        (async () => {
          const { count, error } = await supabase
            .from('grid_analisis')
            .select('id', { count: 'exact', head: true })
            .gt('skor_tdi', TRANSIT_DESERT_THRESHOLD)
          if (!error && typeof count === 'number') {
            next.transitDesertCount = count
            next.transitDesertDemo = false
          }
        })(),

        // Coverage ratio kota (radius 800 m) — view coverage_transit_kecamatan.
        (async () => {
          const { data, error } = await supabase
            .from('coverage_transit_kecamatan')
            .select('populasi_total, populasi_terlayani_800m')
          if (!error && data?.length) {
            const tot = data.reduce((s, r) => s + (Number(r.populasi_total) || 0), 0)
            const served = data.reduce((s, r) => s + (Number(r.populasi_terlayani_800m) || 0), 0)
            if (tot > 0) {
              next.cityCoverage800m = served / tot
              next.coverageDemo = false
            }
          }
        })(),

        // Ranking Transit Equity Index teratas (WAJIB filter sumber REAL%).
        (async () => {
          const { data, error } = await supabase
            .from('skor_equity')
            .select('skor_final, ranking, sumber, batas_administrasi(nama_kelurahan)')
            .ilike('sumber', 'REAL%')
            .order('ranking', { ascending: true })
            .limit(5)
          if (!error && data?.length) {
            next.equityTop = data.map((d, i) => ({
              rank: d.ranking ?? i + 1,
              kelurahan: d.batas_administrasi?.nama_kelurahan || 'Kelurahan',
              skor: d.skor_final != null ? Number(d.skor_final) : null,
            }))
            next.equityDemo = false
          }
        })(),

        // Usulan Halte Prioritas top 5 — usulan_halte_model (belum disurvei
        // lapangan). Dampak (penduduk_terlayani_*) dihitung di server; frontend
        // hanya membaca ranking + angka yang sudah ada.
        (async () => {
          const { data, error } = await supabase
            .from('usulan_halte_model')
            .select('kode, ranking, kelurahan, kecamatan, penduduk_terlayani_400m, penduduk_terlayani_800m')
            .order('ranking', { ascending: true })
            .limit(5)
          if (!error && data?.length) {
            next.usulanTop = data.map((d, i) => ({
              rank: d.ranking ?? i + 1,
              kode: d.kode || null,
              kelurahan: d.kelurahan || 'Kelurahan',
              kecamatan: d.kecamatan || '-',
              p400: d.penduduk_terlayani_400m != null ? Math.round(Number(d.penduduk_terlayani_400m)) : null,
              p800: d.penduduk_terlayani_800m != null ? Math.round(Number(d.penduduk_terlayani_800m)) : null,
            }))
            next.usulanDemo = false
          }
        })(),

        // Potensi penerima manfaat — CERMIN kartu di Dashboard.jsx: RPC
        // potensi_penerima_manfaat (migration 022), field
        // potensi_penerima_manfaat_jiwa. Join spasial dihitung di server.
        (async () => {
          const { data, error } = await supabase.rpc('potensi_penerima_manfaat')
          if (!error && data && data.potensi_penerima_manfaat_jiwa != null) {
            next.potensiPenerimaManfaat = Math.round(Number(data.potensi_penerima_manfaat_jiwa))
            next.potensiDemo = false
          }
        })(),

        // Ringkasan CAI grid — hanya COUNT sel cai_skor >= ambang (jangan tarik
        // 2.607 baris untuk rata-rata; itu mahal & tidak dipakai di ringkasan).
        (async () => {
          const { count, error } = await supabase
            .from('grid_analisis')
            .select('id', { count: 'exact', head: true })
            .gte('cai_skor', CAI_HIGH_THRESHOLD)
          if (!error && typeof count === 'number') {
            next.caiHighCount = count
            next.caiDemo = false
          }
        })(),
      ])

      if (!cancelled) {
        setModel(next)
        setLoadingModel(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  const nowLabel = () => new Date().toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' })

  function buildLines() {
    const pct = (v) => `${(v * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`
    return [
      ['Populasi Kota Bekasi', `${KOTA_PROFIL.populasi_fallback.toLocaleString('id-ID')} jiwa (DKB Semester I 2026)`],
      ['Kepadatan', `${KOTA_PROFIL.kepadatan_fallback.toLocaleString('id-ID')} jiwa/km2`],
      ['Luas wilayah', `${KOTA_PROFIL.luas_km2.toLocaleString('id-ID')} km2 (BPS)`],
      ['Usia produktif (15-64 th)', `${KOTA_PROFIL.usia_produktif_persen}% (${KOTA_PROFIL.usia_produktif_jiwa.toLocaleString('id-ID')} jiwa)`],
      [
        'Transit desert teridentifikasi',
        `${model.transitDesertCount.toLocaleString('id-ID')} sel grid (skor_tdi > ${TRANSIT_DESERT_THRESHOLD})${model.transitDesertDemo ? ' [contoh]' : ''}`,
      ],
      [
        'Coverage transit kota (radius 800 m)',
        `${pct(model.cityCoverage800m)} penduduk${model.coverageDemo ? ' [contoh]' : ''}`,
      ],
      [
        'Potensi penerima manfaat',
        `${model.potensiPenerimaManfaat.toLocaleString('id-ID')} jiwa (transit desert, ` +
          `radius 800 m dari usulan halte)${model.potensiDemo ? ' [contoh]' : ''}`,
      ],
      [
        'Sel CAI grid aksesibilitas tinggi',
        `${model.caiHighCount.toLocaleString('id-ID')} dari ${GRID_TOTAL.toLocaleString('id-ID')} sel ` +
          `(cai_skor >= ${String(CAI_HIGH_THRESHOLD).replace('.', ',')}, grid 300 m)${model.caiDemo ? ' [contoh]' : ''}`,
      ],
    ]
  }

  /**
   * captureMap — helper tunggal yang dipakai BERSAMA oleh exportPng & exportPdf
   * supaya perilaku redraw/deteksi-blank konsisten di kedua jalur.
   *
   * Mengembalikan { canvas, dataUrl, note }:
   *   - canvas  : HTMLCanvasElement peta yang SUDAH dipastikan tergambar, atau null
   *   - dataUrl : hasil toDataURL('image/png') dari canvas itu, atau null
   *   - note    : string alasan kalau peta TIDAK bisa disertakan (blank / CORS /
   *               belum siap) — laporan tetap dibuat tanpa blok peta, tidak throw.
   *
   * TIDAK ADA penantian 'idle' di sini: tombol unduh baru aktif setelah
   * `mapPainted` (peta sudah menggambar tile — ditunggu di background sejak tab
   * dibuka, lihat handleMapReady). Jadi saat fungsi ini dipanggil, cukup:
   * redraw paksa SINKRON (`map.redraw()` di maplibre-gl v6) + 2x rAF supaya
   * satu frame benar-benar ter-commit, lalu baca canvas. Blank-check tetap ada
   * sebagai jaring pengaman terakhir (mis. safety-timeout 12 dtk terpicu saat
   * tile MAPID masih streaming).
   */
  async function captureMap() {
    const map = mapInstance
    if (!map) {
      return {
        canvas: null,
        dataUrl: null,
        note: 'Peta belum siap. Buka tab "Peta Interaktif" sebentar supaya peta termuat, lalu kembali ke sini.',
      }
    }

    // Render paksa SINKRON (map.redraw() maplibre-gl v6) + 2x rAF supaya minimal
    // satu frame benar-benar di-commit ke drawing buffer sebelum dibaca. resize()
    // dulu sebagai jaga-jaga kalau ukuran kanvas belum sinkron dengan kontainer.
    try {
      if (typeof map.resize === 'function') map.resize()
      if (typeof map.redraw === 'function') map.redraw()
      else if (typeof map.triggerRepaint === 'function') map.triggerRepaint()
    } catch { /* noop */ }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    try { if (typeof map.redraw === 'function') map.redraw() } catch { /* noop */ }
    await new Promise((r) => requestAnimationFrame(r))

    // 2) Baca canvas
    let mapCanvas
    try {
      mapCanvas = map.getCanvas()
    } catch {
      mapCanvas = null
    }
    if (!mapCanvas) {
      return {
        canvas: null,
        dataUrl: null,
        note: 'Tidak bisa membaca kanvas peta — coba lagi setelah peta selesai dimuat.',
      }
    }

    // 3) Deteksi kanvas kosong (semua piksel identik / transparan penuh).
    //    getImageData bisa melempar SecurityError kalau kanvas ter-taint CORS
    //    (mis. basemap OSM fallback tanpa key MAPID) -> perlakukan sebagai
    //    "tidak bisa disalin".
    try {
      if (isBlankCanvas(mapCanvas)) {
        return {
          canvas: null,
          dataUrl: null,
          note:
            'Peta belum selesai dirender — tunggu beberapa detik setelah membuka tab ini, lalu coba unduh lagi.',
        }
      }
    } catch (err) {
      if (err && err.name === 'SecurityError') {
        return {
          canvas: null,
          dataUrl: null,
          note:
            'Basemap tidak mengizinkan penyalinan gambar (mode fallback tanpa MAPID Maps) — peta tidak ikut di file.',
        }
      }
      // Kegagalan lain saat cek: jangan halangi ekspor, lanjut coba salin.
    }

    // 4) Salin ke dataURL (dipakai jalur PDF; jalur PNG pakai drawImage(canvas)).
    //    SecurityError di sini = kanvas ter-taint -> laporan tanpa peta.
    let dataUrl = null
    try {
      dataUrl = mapCanvas.toDataURL('image/png')
    } catch (err) {
      if (err && err.name === 'SecurityError') {
        return {
          canvas: null,
          dataUrl: null,
          note:
            'Basemap tidak mengizinkan penyalinan gambar (mode fallback tanpa MAPID Maps) — peta tidak ikut di file.',
        }
      }
      return {
        canvas: null,
        dataUrl: null,
        note: 'Gagal menyalin gambar peta — peta tidak ikut di file.',
      }
    }

    return { canvas: mapCanvas, dataUrl, note: null }
  }

  async function exportPng() {
    setExporting('png')
    setNote(null)
    try {
      const W = 960
      const pad = 40
      const cap = await captureMap()
      if (cap.note) setNote(cap.note)
      const mapCanvas = cap.canvas
      const lines = buildLines()
      const usulan = model.usulanTop
      const equity = model.equityTop

      // Tinggi dinamis: header + peta + indikator + usulan halte + ranking.
      const mapH = mapCanvas ? Math.round(((W - pad * 2) * mapCanvas.height) / mapCanvas.width) : 0
      const usulanH = 10 + 22 + 18 + 20 + usulan.length * 24
      const H =
        pad + 70 + (mapH ? mapH + 24 : 0) + 22 + lines.length * 30 + usulanH + 40 + equity.length * 26 + 60

      const cv = document.createElement('canvas')
      cv.width = W
      cv.height = H
      const ctx = cv.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)

      let y = pad
      ctx.fillStyle = '#1B659D'
      ctx.font = 'bold 26px Arial, sans-serif'
      ctx.fillText('GeoTransit Insight — Ringkasan Laporan', pad, y + 24)
      y += 40
      ctx.fillStyle = '#64748b'
      ctx.font = '13px Arial, sans-serif'
      ctx.fillText(`Kota Bekasi · dibuat ${nowLabel()}`, pad, y + 14)
      y += 34

      if (mapCanvas && mapH) {
        ctx.drawImage(mapCanvas, pad, y, W - pad * 2, mapH)
        ctx.strokeStyle = '#cbd5e1'
        ctx.strokeRect(pad, y, W - pad * 2, mapH)
        y += mapH + 24
      }

      ctx.fillStyle = '#0f172a'
      ctx.font = 'bold 16px Arial, sans-serif'
      ctx.fillText('Indikator kunci', pad, y)
      y += 22
      ctx.font = '14px Arial, sans-serif'
      lines.forEach(([k, v]) => {
        ctx.fillStyle = '#475569'
        ctx.fillText(`${k}:`, pad, y)
        ctx.fillStyle = '#0f172a'
        ctx.fillText(String(v), pad + 320, y)
        y += 30
      })

      // Blok Usulan Halte Prioritas (top 5) — usulan model spasial.
      y += 10
      ctx.fillStyle = '#0f172a'
      ctx.font = 'bold 16px Arial, sans-serif'
      ctx.fillText(
        `Usulan Halte Prioritas — ${usulan.length} teratas${model.usulanDemo ? ' [contoh]' : ''}`,
        pad,
        y
      )
      y += 18
      ctx.fillStyle = '#94a3b8'
      ctx.font = '11px Arial, sans-serif'
      ctx.fillText('Usulan dari model spasial (grid TDI tinggi) — belum disurvei lapangan.', pad, y)
      y += 20
      ctx.font = '13px Arial, sans-serif'
      usulan.forEach((u) => {
        ctx.fillStyle = '#475569'
        ctx.fillText(`${u.rank}. ${u.kelurahan}, ${u.kecamatan}`, pad, y)
        ctx.fillStyle = '#0f172a'
        ctx.fillText(usulanImpactText(u), pad + 320, y)
        y += 24
      })

      y += 10
      ctx.fillStyle = '#0f172a'
      ctx.font = 'bold 16px Arial, sans-serif'
      ctx.fillText(`Transit Equity Index — ${equity.length} kelurahan paling timpang${model.equityDemo ? ' [contoh]' : ''}`, pad, y)
      y += 22
      ctx.font = '14px Arial, sans-serif'
      equity.forEach((e) => {
        ctx.fillStyle = '#475569'
        ctx.fillText(`${e.rank}. ${e.kelurahan}`, pad, y)
        ctx.fillStyle = '#0f172a'
        ctx.fillText(e.skor != null ? `skor ketimpangan ${e.skor.toFixed(2)}` : 'skor -', pad + 320, y)
        y += 26
      })

      y += 20
      ctx.fillStyle = '#94a3b8'
      ctx.font = '11px Arial, sans-serif'
      ctx.fillText('Skor ketimpangan lebih tinggi = akses transit lebih tertinggal (ranking 1 = paling butuh intervensi).', pad, y)

      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'))
      triggerDownload(blob, `geotransit-laporan-${fileStamp()}.png`)
    } catch (err) {
      console.error(err)
      setNote('Gagal membuat PNG. Coba lagi setelah peta selesai dimuat.')
    } finally {
      setExporting(null)
    }
  }

  async function exportPdf() {
    setExporting('pdf')
    setNote(null)
    try {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' })
      const pageW = doc.internal.pageSize.getWidth()
      const margin = 15
      let y = margin

      doc.setFontSize(16)
      doc.setTextColor('#1B659D')
      doc.text('GeoTransit Insight — Ringkasan Laporan', margin, y)
      y += 7
      doc.setFontSize(10)
      doc.setTextColor('#64748b')
      doc.text(`Kota Bekasi · dibuat ${nowLabel()}`, margin, y)
      y += 8

      const cap = await captureMap()
      if (cap.note) setNote(cap.note)
      if (cap.canvas && cap.dataUrl) {
        const imgW = pageW - margin * 2
        const imgH = (imgW * cap.canvas.height) / cap.canvas.width
        y = ensureSpace(doc, y, imgH + 10, margin)
        doc.addImage(cap.dataUrl, 'PNG', margin, y, imgW, imgH)
        doc.setDrawColor('#cbd5e1')
        doc.rect(margin, y, imgW, imgH)
        y += imgH + 8
      }

      const lines = buildLines()
      y = ensureSpace(doc, y, 8 + lines.length * 6, margin)
      doc.setFontSize(12)
      doc.setTextColor('#0f172a')
      doc.text('Indikator kunci', margin, y)
      y += 6
      doc.setFontSize(10)
      lines.forEach(([k, v]) => {
        doc.setTextColor('#475569')
        doc.text(`${k}:`, margin, y)
        doc.setTextColor('#0f172a')
        doc.text(doc.splitTextToSize(String(v), pageW - margin * 2 - 60), margin + 60, y)
        y += 6
      })

      // Blok Usulan Halte Prioritas (top 5) — usulan model spasial.
      y += 4
      y = ensureSpace(doc, y, 14 + model.usulanTop.length * 6, margin)
      doc.setFontSize(12)
      doc.setTextColor('#0f172a')
      doc.text(
        `Usulan Halte Prioritas — ${model.usulanTop.length} teratas${model.usulanDemo ? ' [contoh]' : ''}`,
        margin,
        y
      )
      y += 5
      doc.setFontSize(8)
      doc.setTextColor('#94a3b8')
      doc.text('Usulan dari model spasial (grid TDI tinggi) — belum disurvei lapangan.', margin, y)
      y += 6
      doc.setFontSize(10)
      model.usulanTop.forEach((u) => {
        doc.setTextColor('#475569')
        doc.text(`${u.rank}. ${u.kelurahan}, ${u.kecamatan}`, margin, y)
        doc.setTextColor('#0f172a')
        doc.text(usulanImpactText(u), margin + 60, y)
        y += 6
      })

      y += 4
      y = ensureSpace(doc, y, 12 + model.equityTop.length * 6, margin)
      doc.setFontSize(12)
      doc.setTextColor('#0f172a')
      doc.text(
        `Transit Equity Index — ${model.equityTop.length} kelurahan paling timpang${model.equityDemo ? ' [contoh]' : ''}`,
        margin,
        y
      )
      y += 6
      doc.setFontSize(10)
      model.equityTop.forEach((e) => {
        doc.setTextColor('#475569')
        doc.text(`${e.rank}. ${e.kelurahan}`, margin, y)
        doc.setTextColor('#0f172a')
        doc.text(e.skor != null ? `skor ketimpangan ${e.skor.toFixed(2)}` : 'skor -', margin + 60, y)
        y += 6
      })

      y += 6
      y = ensureSpace(doc, y, 20, margin)
      doc.setFontSize(8)
      doc.setTextColor('#94a3b8')
      doc.text(
        doc.splitTextToSize(
          'Skor ketimpangan lebih tinggi = akses transit lebih tertinggal (ranking 1 = paling butuh intervensi). ' +
            'Angka bertanda [contoh] memakai data fallback karena Supabase belum tersambung/terisi.',
          pageW - margin * 2
        ),
        margin,
        y
      )

      doc.save(`geotransit-laporan-${fileStamp()}.pdf`)
    } catch (err) {
      console.error(err)
      setNote('Gagal membuat PDF. Coba lagi setelah peta selesai dimuat.')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <FileDown size={18} className="text-brand-orange" />
        <h2 className="font-semibold text-slate-800">Data &amp; Laporan</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!isConfigured && (
          <div className="text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
            Belum tersambung ke Supabase — laporan memakai angka contoh.
          </div>
        )}

        <p className="text-sm text-slate-500">
          Unduh ringkasan satu halaman: tampilan peta + indikator kunci (ringkasan kota, transit
          desert, coverage ratio, potensi penerima manfaat, ringkasan CAI grid), Usulan Halte
          Prioritas top 5, dan ranking Transit Equity Index teratas.
        </p>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Laporan merekam <span className="font-medium text-slate-600">tampilan peta &quot;Peta Interaktif&quot; saat ini</span>
          {' '}(zoom &amp; layer yang sedang aktif). Atur dulu di tab itu bila perlu, lalu kembali ke sini untuk mengunduh.
        </div>

        <div className="rounded-lg border border-slate-200 p-3 space-y-1.5 text-xs">
          <p className="font-medium text-slate-600 mb-1">
            Isi laporan {loadingModel && <span className="text-slate-400">(memuat…)</span>}
          </p>
          {buildLines().map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <span className="text-slate-500">{k}</span>
              <span className="text-slate-800 text-right">{v}</span>
            </div>
          ))}
          <div className="pt-1 border-t border-slate-100 mt-1">
            <span className="text-slate-500">
              Usulan Halte Prioritas: {model.usulanTop.map((u) => u.kelurahan).join(', ')}
              {model.usulanDemo ? ' [contoh]' : ''}
            </span>
          </div>
          <div>
            <span className="text-slate-500">
              Ranking Transit Equity Index: {model.equityTop.map((e) => e.kelurahan).join(', ')}
              {model.equityDemo ? ' [contoh]' : ''}
            </span>
          </div>
        </div>

        {note && (
          <div className="text-xs bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2">
            {note}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={exportPdf}
            disabled={!mapPainted || exporting != null}
            className="flex-1 flex items-center justify-center gap-1.5 bg-brand-blue text-white rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting === 'pdf' ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
            Unduh PDF
          </button>
          <button
            onClick={exportPng}
            disabled={!mapPainted || exporting != null}
            className="flex-1 flex items-center justify-center gap-1.5 bg-slate-100 text-slate-700 rounded-md px-3 py-2 text-sm font-medium hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting === 'png' ? <Loader2 size={15} className="animate-spin" /> : <FileImage size={15} />}
            Unduh PNG
          </button>
        </div>
        {!mapPainted ? (
          <p className="text-[10px] text-slate-400 flex items-center gap-1.5">
            <Loader2 size={11} className="animate-spin" />
            Menyiapkan peta… tombol unduh aktif setelah peta selesai dirender.
          </p>
        ) : paintTimedOut ? (
          <p className="text-[10px] text-amber-600">
            Peta mungkin belum lengkap saat diunduh (tile basemap masih dimuat) — tunggu beberapa
            detik lagi bila hasilnya kosong, lalu unduh ulang.
          </p>
        ) : (
          <p className="text-[10px] text-slate-400">
            Peta siap. Unduhan menyertakan tampilan peta apa adanya saat tombol ditekan.
          </p>
        )}
      </div>
    </div>
  )
}

function fileStamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
}

// Baris dampak satu usulan halte: "{800m} jiwa (800 m) / {400m} jiwa (400 m)".
function usulanImpactText(u) {
  const a = u.p800 != null ? `${u.p800.toLocaleString('id-ID')} jiwa (800 m)` : '– (800 m)'
  const b = u.p400 != null ? `${u.p400.toLocaleString('id-ID')} jiwa (400 m)` : '– (400 m)'
  return `${a} / ${b}`
}

/**
 * ensureSpace — paginasi jsPDF sederhana. Kalau menulis `need` mm lagi dari
 * posisi `y` akan melewati batas bawah halaman, buka halaman baru dan kembalikan
 * y = margin. Kalau tidak, kembalikan y apa adanya. Dipanggil sebelum tiap blok.
 */
function ensureSpace(doc, y, need, margin) {
  const pageH = doc.internal.pageSize.getHeight()
  if (y + need > pageH - margin) {
    doc.addPage()
    return margin
  }
  return y
}

/**
 * isBlankCanvas — true kalau tangkapan peta praktis kosong: setiap piksel
 * transparan penuh, ATAU semua piksel identik (satu warna rata, mis. abu-abu
 * placeholder sebelum tile pertama tercat). Sampling 32x32 sudah cukup untuk
 * membedakan "ada peta" vs "buffer belum dicat" tanpa biaya baca full-res.
 * Melempar SecurityError kalau kanvas sumber ter-taint CORS (ditangani pemanggil).
 */
function isBlankCanvas(srcCanvas) {
  const s = document.createElement('canvas')
  s.width = 32
  s.height = 32
  const sctx = s.getContext('2d')
  if (!sctx) return false
  sctx.drawImage(srcCanvas, 0, 0, 32, 32)
  const { data } = sctx.getImageData(0, 0, 32, 32) // dapat melempar SecurityError
  const r0 = data[0]
  const g0 = data[1]
  const b0 = data[2]
  const a0 = data[3]
  let allTransparent = true
  let allIdentical = true
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) allTransparent = false
    if (
      data[i] !== r0 ||
      data[i + 1] !== g0 ||
      data[i + 2] !== b0 ||
      data[i + 3] !== a0
    ) {
      allIdentical = false
    }
    if (!allTransparent && !allIdentical) return false
  }
  return allTransparent || allIdentical
}

function triggerDownload(blob, filename) {
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
