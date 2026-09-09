import { useEffect, useState } from 'react'
import {
  BarChart3, MapPinOff, Users, Grid3x3, Map as MapIcon, Briefcase, Gauge,
  Bus, Lightbulb, Waypoints,
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { supabase, isConfigured } from '../../lib/supabaseClient'
import { fetchAllRows } from '../../lib/fetchAllRows'
import { KOTA_PROFIL } from '../../lib/kotaProfil'
import { extractPolygonRings, ringAveragePoint } from '../../lib/geo'
import MiniHeatmap from './MiniHeatmap'

// Ambil semua ring (exterior + hole) dari geom batas kelurahan. extractPolygonRings
// (lib/geo.js) menangani WKB hex Polygon & GeoJSON Polygon; di sini ditambah
// cabang GeoJSON MultiPolygon supaya kelurahan multi-bagian tetap dapat outline.
// Return null kalau format tak dikenali -> MiniHeatmap tampil placeholder netral.
function ringsFromGeom(geom) {
  const poly = extractPolygonRings(geom)
  if (poly && poly.length) return poly
  if (
    geom && typeof geom === 'object' && geom.type === 'MultiPolygon' &&
    Array.isArray(geom.coordinates)
  ) {
    const rings = geom.coordinates.flatMap((p) => (Array.isArray(p) ? p : []))
    return rings.length ? rings : null
  }
  return null
}

const fmtInt = (n) => Number(n).toLocaleString('id-ID')
const fmtDec = (n, d = 2) =>
  Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })

// Ringkasan Kota Bekasi (mockup PRD Gambar 3, panel ringkasan kota). Nilai
// demo = angka kanonik dari KOTA_PROFIL; dipakai kalau Supabase belum
// tersambung / query gagal.
const DEMO_RINGKASAN = {
  populasi: KOTA_PROFIL.populasi_fallback,
  kepadatan: KOTA_PROFIL.kepadatan_fallback,
  indeksAksesibilitas: KOTA_PROFIL.indeks_aksesibilitas_fallback,
  indeksAksesibilitasN: null,
}

// Data contoh coverage ratio per kecamatan — dipakai HANYA kalau view
// coverage_transit_kecamatan (migration 016/017) gagal di-query / kosong
// (mis. Supabase belum tersambung). Angka asli dari view sengaja rendah
// (mayoritas kecamatan ~0%) karena halte_eksisting baru berisi 15 halte
// koridor BisKita tersurvei — itu gambaran transit desert sesungguhnya,
// bukan bug. `coverage` di sini pada skala 0–100 (persen).
const DEMO_DATA = [
  { kecamatan: 'Bekasi Selatan', coverage: 28.4 },
  { kecamatan: 'Bekasi Timur', coverage: 11.2 },
  { kecamatan: 'Rawalumbu', coverage: 6.8 },
  { kecamatan: 'Bekasi Barat', coverage: 0 },
  { kecamatan: 'Bekasi Utara', coverage: 0 },
  { kecamatan: 'Mustikajaya', coverage: 0 },
]
const DEMO_CITY_COVERAGE_800M = 0.071 // ~7,1% penduduk kota dalam radius 800 m halte tersurvei

// Kartu "Usulan Halte Prioritas" (mockup PRD Gambar 6 / Bab 10.2).
// SUMBER DIUBAH 2026-09-07: dulu menghitung baris `titik_kandidat` — itu
// TITIK SURVEI LAPANGAN, bukan usulan; melabelinya "usulan halte" menyesatkan
// (beberapa di antaranya justru simpul eksisting: Stasiun Bekasi, Terminal
// Bekasi). Usulan yang sebenarnya = `usulan_halte_model` (migration 028),
// diturunkan dari sel transit desert lalu diukur dampaknya lewat RPC
// simulate_new_stop. Ringkasan "teratas" pakai proyeksi penduduk terlayani
// 800 m — titik model sengaja TIDAK punya skor CAI (lihat CLAUDE.md).
const DEMO_USULAN_HALTE = {
  jumlah: 25,
  teratas: { lokasi: 'MDL-001 — Kranji, Bekasi Barat (contoh)', terlayani800: 61728 },
}

// Kartu "Top 3 Rekomendasi AI" (mockup PRD Gambar 6 / Bab 10.2). Sumber:
// 3 kelurahan paling timpang di skor_equity + rekomendasi_intervensi-nya.
// "Skor dampak" di sini = skor_final ketimpangan (0–1, makin tinggi makin
// butuh intervensi). Potensi manfaat & estimasi biaya BELUM ada sebagai
// kolom di skema — ditampilkan sebagai "belum tersedia".
// TODO(data-ai-analyst): kalau kolom potensi_manfaat_jiwa / estimasi_biaya
// ditambahkan ke skor_equity atau titik_kandidat, tinggal petakan di sini.
// `bounds: null` disengaja — pada mode demo (Supabase belum tersambung) tidak
// ada geom batas kelurahan riil, jadi MiniHeatmap menampilkan placeholder
// "Peta tidak tersedia", BUKAN blob karangan (CLAUDE.md: dilarang visual yang
// seolah-olah data).
const DEMO_REKOMENDASI_AI = [
  { kelurahan: 'Mustika Jaya', skorDampak: 0.81, rekomendasi: 'Prioritaskan halte baru + trotoar terhubung ke permukiman padat.', bounds: null },
  { kelurahan: 'Bantar Gebang', skorDampak: 0.76, rekomendasi: 'Tambah rute feeder ke terminal terdekat, perbaiki penyeberangan.', bounds: null },
  { kelurahan: 'Rawa Lumbu', skorDampak: 0.71, rekomendasi: 'Perbaikan trotoar & penerangan jalur jalan kaki menuju halte eksisting.', bounds: null },
]

// Grid dengan skor_tdi DI ATAS ambang ini dianggap "transit desert" untuk
// keperluan tampilan kartu ringkasan (skor_tdi lebih tinggi = grid makin
// "transit desert" — normalisasi min-max, lihat etl/compute_scores.py
// compute_tdi(); arahnya BERBEDA dari skor_aksesibilitas_transit yang
// dipakai proksi sebelumnya, saat itu skor_tdi masih selalu null).
// TODO(data-ai-analyst): konfirmasi ambang resmi "transit desert" untuk
// dashboard (mis. top quartile / nilai absolut tertentu) — 0.6 di bawah ini
// hanya placeholder tampilan yang wajar, BUKAN definisi final Transit
// Desert Index.
const TRANSIT_DESERT_THRESHOLD = 0.6

// Kartu ringkasan contoh — dipakai kalau Supabase belum tersambung/tabel
// grid_analisis masih kosong.
const DEMO_TRANSIT_DESERT_COUNT = 18
// Potensi penerima manfaat contoh — dipakai kalau RPC potensi_penerima_manfaat
// (migration 022) gagal / belum ada. Angka disetel di ballpark hasil RPC nyata
// (~164 rb jiwa di transit desert dalam 800 m jalan kaki dari usulan halte
// prioritas), bukan jutaan.
const DEMO_POTENSI_PENERIMA_MANFAAT = 163000
const DEMO_POTENSI_TRANSIT_DESERT_TOTAL = 2516369

export default function Dashboard() {
  const [data, setData] = useState(DEMO_DATA)
  const [usingDemo, setUsingDemo] = useState(!isConfigured)
  const [cityCoverage800m, setCityCoverage800m] = useState(DEMO_CITY_COVERAGE_800M)

  const [usulanHalte, setUsulanHalte] = useState(DEMO_USULAN_HALTE)
  const [usingDemoUsulan, setUsingDemoUsulan] = useState(!isConfigured)

  const [rekomendasiAI, setRekomendasiAI] = useState(DEMO_REKOMENDASI_AI)
  const [usingDemoRekomendasi, setUsingDemoRekomendasi] = useState(!isConfigured)

  // Centroid + skor_tdi SELURUH sel transit desert kota — di-fetch SEKALI
  // (lihat grid_analisis fetchAllRows di bawah, geom ditambahkan ke select yang
  // sudah ada) lalu dibagi ke 3 thumbnail MiniHeatmap. null = belum termuat.
  const [gridHotPoints, setGridHotPoints] = useState(null)
  const [gridPointsError, setGridPointsError] = useState(false)

  const [transitDesertCount, setTransitDesertCount] = useState(DEMO_TRANSIT_DESERT_COUNT)
  const [usingDemoDesert, setUsingDemoDesert] = useState(!isConfigured)

  const [potensiPenerimaManfaat, setPotensiPenerimaManfaat] = useState(DEMO_POTENSI_PENERIMA_MANFAAT)
  const [usingDemoPenerima, setUsingDemoPenerima] = useState(!isConfigured)
  const [potensiDesertTotal, setPotensiDesertTotal] = useState(DEMO_POTENSI_TRANSIT_DESERT_TOTAL)

  // Ringkasan Kota Bekasi
  const [ringkasan, setRingkasan] = useState(DEMO_RINGKASAN)
  const [usingDemoPopulasi, setUsingDemoPopulasi] = useState(!isConfigured)
  const [usingDemoIndeks, setUsingDemoIndeks] = useState(!isConfigured)
  const [ringkasanLoading, setRingkasanLoading] = useState(isConfigured)

  useEffect(() => {
    if (!isConfigured) return

    // --- Ringkasan Kota Bekasi ---
    // Populasi: sum(jumlah_penduduk) dari `penduduk` (56 baris agregat per
    // kelurahan — jauh di bawah cap 1000 baris PostgREST, jadi tidak perlu
    // fetchAllRows). Basis ini harus sama dengan yang dipakai RPC
    // simulate_new_stop (2.607.248). Kepadatan diturunkan = populasi /
    // luas (KOTA_PROFIL.luas_km2), tidak di-hardcode, supaya konsisten
    // kalau data penduduk berubah.
    //
    // Indeks aksesibilitas rata-rata: rata-rata `skor_final` dari `skor_cai`
    // (Composite Accessibility Index per titik kandidat tersurvei). Dipilih
    // daripada grid_analisis.skor_aksesibilitas_transit karena: (a) skor_cai
    // adalah CAI resmi yang sama persis dengan yang ditampilkan saat user
    // klik peta — bisa ditelusuri; (b) query ringan (~70 baris). Kelemahan:
    // titik kandidat sengaja disampel di lokasi yang diduga bermasalah, jadi
    // ini rata-rata "di titik kandidat", bukan rata-rata spasial se-kota —
    // karena itu kartunya diberi caption "berdasarkan N titik kandidat".
    // TODO(data-ai-analyst): kalau grid_analisis.skor_aksesibilitas_transit
    // sudah terisi penuh se-kota, pertimbangkan pakai itu untuk rata-rata
    // spasial yang lebih representatif (butuh fetchAllRows, 2.607 baris).
    Promise.all([
      supabase.from('penduduk').select('jumlah_penduduk'),
      supabase.from('skor_cai').select('skor_final'),
    ]).then(([pendudukRes, caiRes]) => {
      const next = { ...DEMO_RINGKASAN }

      const pendudukRows = pendudukRes.data
      if (!pendudukRes.error && pendudukRows?.length) {
        const total = pendudukRows.reduce((s, r) => s + (r.jumlah_penduduk ?? 0), 0)
        if (total > 0) {
          next.populasi = total
          next.kepadatan = Math.round(total / KOTA_PROFIL.luas_km2)
          setUsingDemoPopulasi(false)
        } else {
          setUsingDemoPopulasi(true)
        }
      } else {
        setUsingDemoPopulasi(true)
      }

      const caiRows = caiRes.data
      const caiVals =
        !caiRes.error && caiRows?.length
          ? caiRows.map((r) => r.skor_final).filter((v) => v != null).map(Number)
          : []
      if (caiVals.length) {
        next.indeksAksesibilitas = caiVals.reduce((s, v) => s + v, 0) / caiVals.length
        next.indeksAksesibilitasN = caiVals.length
        setUsingDemoIndeks(false)
      } else {
        setUsingDemoIndeks(true)
      }

      setRingkasan(next)
      setRingkasanLoading(false)
    }).catch(() => {
      // Network error dsb — jatuh ke angka kanonik KOTA_PROFIL (mode demo).
      setUsingDemoPopulasi(true)
      setUsingDemoIndeks(true)
      setRingkasanLoading(false)
    })

    // Coverage ratio per kecamatan — dari view coverage_transit_kecamatan
    // (migration 016/017): agregasi NYATA share penduduk (dasymetric grid)
    // dalam radius jalan kaki 800 m dari halte_eksisting. Frontend hanya
    // membaca hasil view, tidak menghitung ulang. 12 baris, jauh di bawah
    // cap PostgREST — tidak perlu fetchAllRows. Fallback ke DEMO_DATA hanya
    // kalau query gagal / kosong (mis. Supabase belum tersambung).
    supabase
      .from('coverage_transit_kecamatan')
      .select('kecamatan, populasi_total, populasi_terlayani_800m, coverage_ratio_800m')
      .then(({ data: rows, error }) => {
        if (error || !rows?.length) {
          setData(DEMO_DATA)
          setCityCoverage800m(DEMO_CITY_COVERAGE_800M)
          setUsingDemo(true)
          return
        }
        const chart = rows
          .map((r) => ({
            kecamatan: r.kecamatan,
            coverage: Math.round((Number(r.coverage_ratio_800m) || 0) * 1000) / 10,
          }))
          .sort((a, b) => b.coverage - a.coverage)
        const totPop = rows.reduce((s, r) => s + (Number(r.populasi_total) || 0), 0)
        const totServed = rows.reduce((s, r) => s + (Number(r.populasi_terlayani_800m) || 0), 0)
        setData(chart)
        setCityCoverage800m(totPop > 0 ? totServed / totPop : 0)
        setUsingDemo(false)
      })

    // Kartu "Usulan Halte Prioritas" — usulan_halte_model (migration 028),
    // BUKAN titik_kandidat (itu titik survei lapangan, lihat catatan di
    // DEMO_USULAN_HALTE). ranking 1 = proyeksi penduduk terlayani terbesar,
    // sudah dihitung data-ai-analyst lewat simulate_new_stop — frontend hanya
    // membaca, tidak menghitung ulang.
    supabase
      .from('usulan_halte_model')
      .select('kode, kelurahan, kecamatan, penduduk_terlayani_800m, ranking')
      .order('ranking', { ascending: true })
      .limit(500)
      .then(({ data: rows, error }) => {
        if (error || !rows?.length) {
          setUsingDemoUsulan(true)
          return
        }
        const top = rows[0]
        setUsulanHalte({
          jumlah: rows.length,
          teratas: top
            ? {
                lokasi: [top.kode, [top.kelurahan, top.kecamatan].filter(Boolean).join(', ')]
                  .filter(Boolean)
                  .join(' — '),
                terlayani800:
                  top.penduduk_terlayani_800m != null ? Number(top.penduduk_terlayani_800m) : null,
              }
            : null,
        })
        setUsingDemoUsulan(false)
      })

    // Kartu "Top 3 Rekomendasi AI" — 3 kelurahan paling timpang di
    // skor_equity + rekomendasi_intervensi-nya. WAJIB filter sumber REAL%
    // (baris dummy punya ranking 1-5 sendiri — lihat EquityIndexView.jsx).
    // `geom` ditambahkan ke select yang sudah ada (bukan query baru) untuk
    // outline batas kelurahan di thumbnail MiniHeatmap.
    supabase
      .from('skor_equity')
      .select('skor_final, ranking, rekomendasi_intervensi, sumber, batas_administrasi(nama_kelurahan, geom)')
      .ilike('sumber', 'REAL%')
      .order('ranking', { ascending: true })
      .limit(3)
      .then(({ data: rows, error }) => {
        if (error || !rows?.length) {
          setUsingDemoRekomendasi(true)
          return
        }
        setRekomendasiAI(
          rows.map((r) => ({
            kelurahan: r.batas_administrasi?.nama_kelurahan || 'Kelurahan',
            skorDampak: r.skor_final != null ? Number(r.skor_final) : null,
            rekomendasi: r.rekomendasi_intervensi || null,
            bounds: ringsFromGeom(r.batas_administrasi?.geom),
          }))
        )
        setUsingDemoRekomendasi(false)
      })

    // Jumlah transit desert teridentifikasi: hitung grid dengan skor_tdi di
    // atas ambang. Ini murni filter/count atas skor_tdi yang SUDAH dihitung
    // data-ai-analyst (Transit Desert Index) — tidak ada formula CAI/TDI
    // yang dihitung ulang di sini.
    //
    // fetchAllRows (bukan `.select(...).then(...)` polos) — dengan ambang
    // 0.6, ~1.503 dari 2.607 grid cocok filter ini (diverifikasi langsung ke
    // API pasca-recompute TDI usia_sekolah 2026-09-06), jauh di atas cap 1000
    // baris/request PostgREST. Tanpa paginasi, transitDesertCount akan diam-
    // diam undercount (hanya menghitung 1000 grid) — lihat lib/fetchAllRows.js.
    fetchAllRows(() =>
      supabase
        .from('grid_analisis')
        .select('id, skor_tdi, geom')
        .gt('skor_tdi', TRANSIT_DESERT_THRESHOLD)
        .order('id', { ascending: true })
    ).then(({ data: rows, error }) => {
      if (error || !rows) {
        setUsingDemoDesert(true)
        setGridPointsError(true)
        return
      }
      setTransitDesertCount(rows.length)
      setUsingDemoDesert(false)

      // Reuse baris yang SAMA untuk thumbnail MiniHeatmap: centroid ring
      // pertama (client-side, tanpa PostGIS) + skor_tdi sebagai bobot blob.
      const pts = []
      for (const row of rows) {
        const ring0 = extractPolygonRings(row.geom)?.[0]
        if (!ring0) continue
        const c = ringAveragePoint(ring0)
        if (c) pts.push({ lat: c.lat, lng: c.lon, tdi: Number(row.skor_tdi) })
      }
      setGridHotPoints(pts)
    }).catch(() => {
      setUsingDemoDesert(true)
      setGridPointsError(true)
    })

    // Potensi penerima manfaat: RPC potensi_penerima_manfaat (migration 022).
    // Server melakukan join spasial — headcount penduduk pada sel transit
    // desert yang berada dalam radius jalan kaki 800 m dari titik_kandidat
    // (usulan halte) NYATA. Ini bukan Σ kepadatan_penduduk se-kota (yang
    // ~2,5 jt / ~96% kota, menyesatkan); frontend hanya membaca hasil RPC,
    // tidak menghitung ulang.
    supabase
      .rpc('potensi_penerima_manfaat')
      .then(({ data, error }) => {
        if (error || !data || data.potensi_penerima_manfaat_jiwa == null) {
          setUsingDemoPenerima(true)
          return
        }
        setPotensiPenerimaManfaat(Math.round(Number(data.potensi_penerima_manfaat_jiwa)))
        if (data.populasi_transit_desert_total != null) {
          setPotensiDesertTotal(Number(data.populasi_transit_desert_total))
        }
        setUsingDemoPenerima(false)
      })
      .catch(() => setUsingDemoPenerima(true))
  }, [])

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 shrink-0 sticky top-0 bg-white z-10">
        <BarChart3 size={18} className="text-brand-orange" />
        <h2 className="font-semibold text-slate-800">Dashboard Indikator</h2>
      </div>

      {usingDemo && (
        <div className="mx-4 mt-3 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
          Coverage ratio menampilkan data contoh. Sambungkan view{' '}
          <code>coverage_transit_kecamatan</code> untuk data asli.
        </div>
      )}

      <div className="px-4 pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
          Ringkasan Kota Bekasi
        </p>
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            icon={Users}
            label="Populasi"
            value={ringkasanLoading ? '—' : fmtInt(ringkasan.populasi)}
            unit="jiwa"
            sub={usingDemoPopulasi ? 'angka kanonik DKB Semester I 2026' : 'DKB Semester I 2026'}
            usingDemo={usingDemoPopulasi}
            demoHint="Gagal memuat tabel penduduk — memakai angka kanonik DKB Semester I 2026"
          />
          <StatCard
            icon={Grid3x3}
            label="Kepadatan"
            value={ringkasanLoading ? '—' : fmtInt(ringkasan.kepadatan)}
            unit="jiwa/km²"
            sub="diturunkan: populasi ÷ 210,49 km²"
            usingDemo={usingDemoPopulasi}
            demoHint="Diturunkan dari populasi fallback kanonik dibagi luas wilayah BPS"
          />
          <StatCard
            icon={MapIcon}
            label="Luas Wilayah"
            value={fmtDec(KOTA_PROFIL.luas_km2)}
            unit="km²"
            sub="BPS Kota Bekasi Dalam Angka"
          />
          <StatCard
            icon={Briefcase}
            label="Usia Produktif"
            value={`${fmtDec(KOTA_PROFIL.usia_produktif_persen)}%`}
            unit={`${fmtInt(KOTA_PROFIL.usia_produktif_jiwa)} jiwa`}
            sub="DKB Semester I 2026"
            hint={`${KOTA_PROFIL.usia_produktif_definisi} (usia 15–64 tahun)`}
          />
          <StatCard
            icon={Gauge}
            label="Indeks Aksesibilitas Rata-rata"
            value={ringkasanLoading ? '—' : fmtDec(ringkasan.indeksAksesibilitas)}
            unit="skala 0–1 (CAI)"
            sub={
              usingDemoIndeks
                ? 'estimasi sementara (skor_cai belum terisi)'
                : `berdasarkan ${ringkasan.indeksAksesibilitasN} titik kandidat`
            }
            usingDemo={usingDemoIndeks}
            demoHint="Tabel skor_cai belum berisi skor_final — menampilkan estimasi sementara"
            hint="Rata-rata skor_final tabel skor_cai (Composite Accessibility Index) pada titik kandidat tersurvei"
          />
        </div>
      </div>

      <div className="px-4 pt-4 grid grid-cols-2 gap-3">
        <StatCard
          icon={MapPinOff}
          label="Transit Desert Teridentifikasi"
          value={transitDesertCount.toLocaleString('id-ID')}
          unit="grid"
          usingDemo={usingDemoDesert}
        />
        <StatCard
          icon={Users}
          label="Potensi Penerima Manfaat"
          value={potensiPenerimaManfaat.toLocaleString('id-ID')}
          unit="jiwa di transit desert"
          sub={
            usingDemoPenerima
              ? 'estimasi contoh'
              : `dalam 800 m jalan kaki dari usulan halte prioritas${
                  potensiDesertTotal
                    ? ` · dari ${fmtInt(potensiDesertTotal)} jiwa transit desert kota`
                    : ''
                }`
          }
          usingDemo={usingDemoPenerima}
          demoHint="Sambungkan RPC potensi_penerima_manfaat untuk angka asli"
          hint="RPC potensi_penerima_manfaat: headcount penduduk sel transit desert dalam radius jalan kaki 800 m dari titik_kandidat (usulan halte) nyata — join spasial dihitung di server"
        />
        <StatCard
          icon={Waypoints}
          label="Coverage Transit Kota"
          value={`${fmtDec(cityCoverage800m * 100, 1)}%`}
          unit="penduduk dalam radius 800 m halte"
          sub={usingDemo ? 'estimasi contoh' : '15 halte koridor BisKita tersurvei'}
          usingDemo={usingDemo}
          demoHint="Sambungkan view coverage_transit_kecamatan untuk angka asli"
          hint="Σ penduduk terlayani 800 m ÷ Σ penduduk seluruh kecamatan (view coverage_transit_kecamatan)"
        />
        <StatCard
          icon={Bus}
          label="Usulan Halte Prioritas"
          value={fmtInt(usulanHalte.jumlah)}
          unit="usulan dari model spasial"
          sub={
            usulanHalte.teratas
              ? `Teratas: ${truncate(usulanHalte.teratas.lokasi, 32)}${
                  usulanHalte.teratas.terlayani800 != null
                    ? ` · ${fmtInt(usulanHalte.teratas.terlayani800)} jiwa (800 m)`
                    : ''
                }`
              : 'Belum ada usulan model'
          }
          usingDemo={usingDemoUsulan}
          demoHint="Sambungkan tabel usulan_halte_model untuk data asli"
          hint="Baris usulan_halte_model: sel transit desert (TDI > 0,6) ≥400 m dari halte, de-klaster 800 m, dampak dari RPC simulate_new_stop. BELUM disurvei lapangan — beda dari titik survei di peta."
        />
      </div>

      <div className="px-4 pt-4">
        <div className="bg-white border border-slate-200 rounded-lg p-3 relative">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Lightbulb size={14} />
            <span className="text-[11px] font-medium uppercase tracking-wide">
              Top 3 Rekomendasi AI
            </span>
            {usingDemoRekomendasi && (
              <span className="ml-auto text-[9px] bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">
                demo
              </span>
            )}
          </div>
          <ol className="space-y-2">
            {rekomendasiAI.map((r, i) => (
              <li key={i} className="border-t border-slate-100 pt-2 first:border-t-0 first:pt-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">
                    {i + 1}. {r.kelurahan}
                  </span>
                  <span
                    className="text-xs font-mono text-slate-500 shrink-0"
                    title="Skor dampak = skor ketimpangan (equity gap) 0–1; makin tinggi makin butuh intervensi"
                  >
                    dampak {r.skorDampak != null ? fmtDec(r.skorDampak) : '—'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                  {r.rekomendasi || 'Belum ada rekomendasi intervensi terisi untuk kelurahan ini.'}
                </p>
                <p className="text-[10px] text-slate-300 mt-0.5">
                  Potensi manfaat &amp; estimasi biaya: belum tersedia di data
                </p>
                <MiniHeatmap
                  name={r.kelurahan}
                  rings={r.bounds}
                  points={gridHotPoints}
                  pointsError={gridPointsError}
                />
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="p-4 flex-1">
        <p className="text-sm text-slate-500 mb-1">
          Coverage ratio (%) penduduk terlayani transit per kecamatan — radius jalan kaki 800 m
        </p>
        <p className="text-[10px] text-slate-400 mb-3">
          {usingDemo
            ? 'Data contoh.'
            : 'Angka riil rendah: halte tersurvei baru mencakup koridor BisKita — mayoritas kecamatan ~0% (gambaran transit desert Kota Bekasi, bukan galat).'}
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" domain={[0, 100]} unit="%" fontSize={12} />
            <YAxis type="category" dataKey="kecamatan" width={100} fontSize={12} />
            <Tooltip formatter={(v) => `${v}%`} />
            <Bar dataKey="coverage" fill="#1B659D" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function truncate(s, n) {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Kartu ringkasan — pola mockup PRD Gambar 6: ikon kecil + label + angka besar
// scannable + unit/caption di bawah, sudut membulat, border tipis. Sudah
// direview ui-ux-designer 2026-09-07 (branding pass); struktur data & logika
// tidak disentuh, murni className.
function StatCard({ icon: Icon, label, value, unit, sub, usingDemo, demoHint, hint }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 relative hover:border-slate-300 transition-colors">
      <div className="flex items-center gap-2 text-slate-400 mb-1">
        <Icon size={14} className="text-brand-blue/70" />
        <span
          className="text-[11px] font-medium uppercase tracking-wide"
          title={hint || undefined}
        >
          {label}
          {hint && <span className="ml-1 text-slate-300 normal-case">ⓘ</span>}
        </span>
      </div>
      <p className="text-2xl font-bold text-slate-800 leading-tight">{value}</p>
      <p className="text-[11px] text-slate-400">{unit}</p>
      {sub && <p className="text-[10px] text-slate-300 mt-0.5 leading-tight">{sub}</p>}
      {usingDemo && (
        <span
          title={demoHint || 'Menampilkan data contoh — sambungkan grid_analisis untuk data asli'}
          className="absolute top-2 right-2 text-[9px] bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5"
        >
          demo
        </span>
      )}
    </div>
  )
}
