import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, MapPin, Loader2 } from 'lucide-react'
import { supabase, isConfigured } from '../../lib/supabaseClient'
import { KECAMATAN_KOTA_BEKASI } from '../../lib/kecamatan'
import CaiScorePanel from '../Map/CaiScorePanel'
import TdiScorePanel from '../Map/TdiScorePanel'

/**
 * AnalisisSpasial — panel kontrol untuk "Peta Multi-Layer Gap Analysis"
 * (PRD Bab 8).
 *
 * KONSOLIDASI PETA (2026-09-12, permintaan Sam eksplisit: "kalau kita pilih
 * kecamatan, perubahan di peta ada di main map, jadi kita tidak perlu peta
 * kecil di sisi kanan") — komponen ini TIDAK LAGI merender <MapView> sendiri.
 * Sebelumnya tab ini punya instance peta terpisah (384px, sempit) dengan
 * choropleth kelas diskret sendiri; sekarang ia murni panel kontrol di sisi
 * kanan yang mengubah state PETA UTAMA yang sama dipakai tab "Peta Interaktif"
 * (App.jsx <main>, ~line 1604, tetap terpasang lintas semua tab) — sifatnya
 * sama seperti LayerControl.jsx untuk tab "peta". Semua rendering choropleth
 * & marker tetap terjadi di satu peta, satu kali.
 *
 * Kontrol di sini, semuanya REUSE mekanisme yang sudah ada di App.jsx (TIDAK
 * ada jalur rendering/skoring baru):
 *  - Filter kecamatan -> reuse mekanisme `sorotWilayah` (App.jsx ~line 1485,
 *    persis yang dipakai SearchBar saat memilih hasil "Wilayah") via RPC
 *    `get_admin_geometry(p_level:'kecamatan', p_nama)`: sorot + fitBounds
 *    peta utama ke batas kecamatan terpilih. RPC ini sudah mendukung level
 *    kecamatan secara native (ST_Union seluruh kelurahan di kecamatan itu),
 *    jadi tidak perlu fetch/geometry-merge terpisah di frontend.
 *  - Overlai Kepadatan / Transit Desert Index -> reuse state `analyticOverlay`
 *    ('none'|'kepadatan'|'tdi', App.jsx) yang sudah menggerakkan choropleth
 *    KONTINU peta utama sejak 2026-09-12. TIDAK ADA rendering choropleth
 *    terpisah lagi di sini — classBreaks/stepFillColorExpr/
 *    toPolygonFeatureCollection lama (lib/choropleth.js) sudah TIDAK dipakai
 *    komponen ini (tetap diekspor di sana untuk jaga-jaga, lihat komentar di
 *    file itu).
 *  - "Jaringan Transit Eksisting" -> reuse `layerVis.halte` (App.jsx), TOGGLE
 *    YANG SAMA dengan checkbox "Halte tersurvei" di LayerControl tab Peta
 *    Interaktif. Versi lama komponen ini menampilkan SEMUA baris
 *    halte_eksisting tanpa saringan; layer yang direuse di sini sudah
 *    menyaring baris dummy `DUMMY-HLT-*` (lib/halteEksisting.js) — sekaligus
 *    perbaikan kecil.
 *  - Klik sel CAI/TDI di peta -> PENANGANAN klik (handleMapClick, RPC
 *    get_cai_breakdown/get_tdi_breakdown) tetap sepenuhnya di App.jsx, bukan
 *    di komponen ini — tidak ada onMapClick/handleMapClick baru di sini.
 *    TAMPILAN hasilnya SEJAK 2026-09-13 (permintaan Sam) DIRENDER DI SINI,
 *    di panel kanan di bawah toggle overlai analitik — bukan lagi kotak
 *    melayang di atas peta (perilaku lama itu TETAP dipakai tab "Peta
 *    Interaktif", lihat App.jsx: <CaiScorePanel>/<TdiScorePanel> varian
 *    'floating' hanya dirender saat activeTab !== 'analisis'). Reuse
 *    komponen yang SAMA PERSIS (CaiScorePanel/TdiScorePanel dari
 *    components/Map/) lewat prop `variant="inline"` yang cuma mengganti
 *    wrapper CSS (absolute -> block biasa) — konten & logika tidak digandakan.
 *
 * TERMINOLOGI (permintaan Sam 2026-09-12): label "Indeks Gap Aksesibilitas"
 * (nama lama skor_tdi di versi lama komponen ini) DIHAPUS dari UI. Skor ini
 * disebut SATU nama saja di mana pun user melihatnya: "Transit Desert Index
 * (TDI)" — supaya tidak terkesan metrik berbeda dari TDI yang disebut di
 * tempat lain (LayerControl, dashboard, dst). Secara substansi label ini
 * tetap memenuhi istilah PRD Bab 8 "indeks gap aksesibilitas" — lihat
 * CLAUDE.md untuk detail.
 *
 * ACCEPTANCE CRITERIA (PRD Bab 8, "filter kecamatan render ulang < 2 detik"):
 * diukur dari saat kecamatan dipilih sampai RPC get_admin_geometry selesai
 * DAN sorotan+kamera peta utama diperbarui (lastFilterMs di bawah). Ini beda
 * dari versi lama (yang mengukur filter array di memori, ~instan) karena
 * "render ulang" sekarang benar-benar berarti memperbarui peta utama (network
 * round-trip 1 RPC ringan), bukan choropleth kecil terpisah yang datanya
 * sudah di memori.
 *
 * Props (semua di-lift dari App.jsx):
 *  - mapInstance: maplibre-gl Map | null — untuk fitBounds ke kecamatan terpilih.
 *  - analyticOverlay: 'none' | 'kepadatan' | 'tdi'.
 *  - onAnalyticOverlayChange: (key) => void.
 *  - overlayLoading: boolean — grid_analisis untuk overlai sedang di-fetch.
 *  - legendGroup: { title, note?, items:[{gradient, labelLeft, labelRight}] } | null
 *    — legenda gradien overlai aktif (dihitung App.jsx, sama persis dengan
 *    yang dipakai <MapLegend> di tab Peta Interaktif), ditampilkan apa adanya.
 *  - sorotWilayah: { level, nama, geojson } | null — sorotan wilayah aktif
 *    saat ini (bisa berasal dari SearchBar ATAU dropdown kecamatan di sini).
 *  - onWilayahSelected: (sorot|null) => void — setter sorotWilayah (App.jsx).
 *  - layerVis: objek visibilitas layer titik/garis (App.jsx).
 *  - onLayerVisChange: (nextValue) => void.
 *  - caiLoading/caiResult/caiUsingDemo/onCaiClose: state klik CAI (App.jsx,
 *    sama persis dg yang dipakai <CaiScorePanel variant="floating"> di tab
 *    Peta Interaktif) — dirender inline di sini, lihat catatan di atas.
 *  - tdiLoading/tdiResult/tdiUsingDemo/onTdiClose: idem untuk TDI.
 */
const SUMBER_BATAS_RESMI = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'

export default function AnalisisSpasial({
  mapInstance = null,
  analyticOverlay = 'none',
  onAnalyticOverlayChange,
  overlayLoading = false,
  legendGroup = null,
  sorotWilayah = null,
  onWilayahSelected,
  layerVis,
  onLayerVisChange,
  caiLoading = false,
  caiResult = null,
  caiUsingDemo = false,
  onCaiClose,
  tdiLoading = false,
  tdiResult = null,
  tdiUsingDemo = false,
  onTdiClose,
}) {
  const [kecamatanFilter, setKecamatanFilter] = useState('')
  const [kecamatanOptions, setKecamatanOptions] = useState(KECAMATAN_KOTA_BEKASI)
  const [usingDemoBoundary, setUsingDemoBoundary] = useState(!isConfigured)

  const [filterLoading, setFilterLoading] = useState(false)
  const [lastFilterMs, setLastFilterMs] = useState(null)
  const filterStartRef = useRef(null)
  // Menandai permintaan get_admin_geometry TERKINI — respons yang datang
  // terlambat (user sudah ganti pilihan lagi) dibuang, sama pola dengan
  // sorotReqRef di SearchBar.jsx.
  const reqRef = useRef(0)

  // Kalau belum ada overlai analitik aktif sama sekali saat tab ini dibuka,
  // nyalakan default "Kepadatan Penduduk" — dulu peta kecil komponen ini
  // SELALU menampilkan salah satu choropleth begitu tab dibuka; perilaku itu
  // dipertahankan lewat state analyticOverlay yang sekarang dibagi dengan tab
  // Peta Interaktif. Hanya jalan sekali saat mount (dep sengaja kosong) —
  // tidak mengganggu kalau overlai sudah dipilih user dari tab lain.
  useEffect(() => {
    if (analyticOverlay === 'none') {
      onAnalyticOverlayChange?.('kepadatan')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Prefill dropdown kalau sudah ada sorotan KECAMATAN aktif dari sumber lain
  // (mis. SearchBar) saat tab ini pertama dibuka, supaya dropdown tidak
  // menampilkan "Semua Kecamatan" padahal peta sedang menyorot sebuah
  // wilayah. Sengaja hanya sekali saat mount, bukan tiap kali sorotWilayah
  // berubah (kalau tidak, memilih hasil titik/garis lain di SearchBar yang
  // membersihkan sorotan akan diam-diam mereset dropdown ini juga).
  useEffect(() => {
    if (sorotWilayah?.level === 'kecamatan' && sorotWilayah.nama) {
      setKecamatanFilter(sorotWilayah.nama)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Daftar nama kecamatan untuk dropdown — HANYA dari data ASLI (sumber =
  // SUMBER_BATAS_RESMI, 56 poligon BIG RBI 25K), BUKAN 6 baris dummy lama
  // ('DATA SINTETIS - seed testing...', lihat 006_seed_dummy_data.sql /
  // 008_batas_administrasi_sumber.sql) — 2 di antaranya (nama_kecamatan
  // 'Bekasi Utara' & 'Bekasi Timur') collide persis dengan nama kecamatan
  // resmi, jadi filter ini WAJIB supaya dropdown tidak menduplikasi nama.
  // Dropdown ini TIDAK butuh geometri sama sekali (get_admin_geometry yang
  // mengambil geometri LAZY, hanya saat sebuah kecamatan benar-benar dipilih)
  // — cukup nama, jadi query di bawah ringan (1 kolom, tanpa geom).
  useEffect(() => {
    if (!isConfigured) return
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('batas_administrasi')
          .select('nama_kecamatan')
          .eq('sumber', SUMBER_BATAS_RESMI)
          .limit(1000)
        if (cancelled) return
        if (error || !data?.length) return
        const unik = [...new Set(data.map((r) => r.nama_kecamatan).filter(Boolean))].sort((a, b) =>
          a.localeCompare(b),
        )
        if (unik.length) {
          setKecamatanOptions(unik)
          setUsingDemoBoundary(false)
        }
      } catch {
        // biarkan fallback KECAMATAN_KOTA_BEKASI
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Pilih kecamatan -> RPC get_admin_geometry (ALUR SAMA dengan
  // ambilSorotWilayah di components/Search/SearchBar.jsx) -> sorotan +
  // fitBounds ke peta UTAMA. get_admin_geometry cocok nama TAK-PEDULI-SPASI
  // (lihat migration 032), jadi aman dipanggil baik dengan ejaan asli hasil
  // fetch di atas MAUPUN fallback KECAMATAN_KOTA_BEKASI ("Rawa Lumbu" tetap
  // ketemu "Rawalumbu") kalau baris ini sempat terpanggil sebelum fetch
  // selesai.
  async function handleFilterChange(e) {
    const nama = e.target.value
    setKecamatanFilter(nama)
    const req = (reqRef.current += 1)
    filterStartRef.current = performance.now()

    if (!nama) {
      onWilayahSelected?.(null)
      setLastFilterMs(performance.now() - filterStartRef.current)
      return
    }

    setFilterLoading(true)
    try {
      if (!isConfigured) {
        await new Promise((r) => setTimeout(r, 150))
        if (req !== reqRef.current) return
        // Mode demo: tidak ada geometri asli untuk disorot — bersihkan saja
        // sorotan lama supaya tidak menampilkan wilayah yang salah.
        onWilayahSelected?.(null)
        return
      }
      const { data, error } = await supabase.rpc('get_admin_geometry', {
        p_level: 'kecamatan',
        p_nama: nama,
      })
      if (req !== reqRef.current) return // pilihan sudah tergeser, buang respons basi
      const row = Array.isArray(data) ? data[0] : data
      if (error || !row?.geojson) {
        onWilayahSelected?.(null)
      } else {
        onWilayahSelected?.({ level: 'kecamatan', nama: row.nama || nama, geojson: row.geojson })
        if (mapInstance && row.min_lng != null) {
          mapInstance.fitBounds(
            [
              [row.min_lng, row.min_lat],
              [row.max_lng, row.max_lat],
            ],
            { padding: 60, duration: 800, maxZoom: 15 },
          )
        }
      }
    } catch {
      if (req === reqRef.current) onWilayahSelected?.(null)
    } finally {
      if (req === reqRef.current) {
        setFilterLoading(false)
        setLastFilterMs(performance.now() - filterStartRef.current)
      }
    }
  }

  const overlayNote = overlayLoading
    ? 'Memuat grid 300 m…'
    : analyticOverlay === 'tdi'
      ? 'Klik sel di peta utama untuk melihat rincian tiap komponen TDI.'
      : analyticOverlay === 'kepadatan'
        ? 'Kepadatan penduduk per sel grid 300 m (dasymetric).'
        : 'Pilih salah satu overlai di bawah untuk ditampilkan di peta utama.'

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <SlidersHorizontal size={18} className="text-brand-orange" />
        <h2 className="font-semibold text-slate-800">Analisis Spasial</h2>
      </div>

      <p className="px-4 pt-3 text-[11px] text-slate-400 leading-relaxed">
        Panel ini mengendalikan peta utama yang sama dengan tab "Peta Interaktif" —
        bukan peta terpisah. Perubahan di bawah langsung terlihat di sana.
      </p>

      {!isConfigured && (
        <div className="mx-4 mt-3 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
          Belum tersambung ke Supabase — daftar kecamatan memakai data contoh.
        </div>
      )}
      {isConfigured && usingDemoBoundary && (
        <div className="mx-4 mt-3 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
          Data <code>batas_administrasi</code> asli belum termuat — dropdown kecamatan
          sementara memakai daftar nama contoh.
        </div>
      )}

      <div className="px-4 pt-3 space-y-4">
        <div>
          <label className="text-[11px] font-medium text-slate-500 block mb-1">
            Filter kecamatan (sorot &amp; zoom peta utama)
          </label>
          <div className="relative">
            <MapPin size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <select
              value={kecamatanFilter}
              onChange={handleFilterChange}
              className="w-full text-sm border border-slate-300 rounded-md pl-7 pr-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-blue"
            >
              <option value="">Semua Kecamatan</option>
              {kecamatanOptions.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          {filterLoading && (
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> Menyorot &amp; memindahkan peta…
            </p>
          )}
          {!filterLoading && lastFilterMs != null && (
            <p className="text-[10px] text-slate-400 mt-1">
              Filter diterapkan dalam {lastFilterMs.toFixed(0)} ms (target &lt; 2000 ms)
            </p>
          )}
        </div>

        <div>
          <p className="text-[11px] font-medium text-slate-500 mb-1">Overlai analitik</p>
          {/* TODO(ui-ux-designer): radio native, belum disesuaikan sistem desain final. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="analisis-overlay"
                checked={analyticOverlay === 'kepadatan'}
                onChange={() => onAnalyticOverlayChange?.('kepadatan')}
              />
              Kepadatan Penduduk
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="analisis-overlay"
                checked={analyticOverlay === 'tdi'}
                onChange={() => onAnalyticOverlayChange?.('tdi')}
              />
              Transit Desert Index (TDI)
            </label>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-slate-400">{overlayNote}</p>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={!!layerVis?.halte}
            onChange={(e) => onLayerVisChange?.({ ...layerVis, halte: e.target.checked })}
          />
          Jaringan Transit Eksisting (halte tersurvei)
        </label>

        {/* Perbaikan 2026-09-13 (Sam melaporkan nama kecamatan terpilih tidak
            cukup mencolok): teks 11px abu-abu diganti badge/chip supaya jadi
            elemen yang menonjol, bukan mudah terlewat. `yellow-600` dipakai
            sengaja — itu PERSIS hex SOROT_WILAYAH_COLOR ('#CA8A04', lihat
            lib/mapColors.js) yang dipakai untuk sorotan batas kecamatan di
            peta utama, jadi badge di panel & sorotan di peta terasa satu
            indikator visual yang sama. Dipakai lewat kelas Tailwind bawaan
            (bukan inline style/hex baru) supaya tetap konsisten dengan
            sistem desain file ini — CATATAN: kalau SOROT_WILAYAH_COLOR di
            lib/mapColors.js diganti di masa depan, kelas yellow-* di sini
            perlu disesuaikan manual (tidak otomatis ikut). */}
        {sorotWilayah?.level === 'kecamatan' && (
          <div className="flex items-center gap-1.5 rounded-md border border-yellow-300 bg-yellow-50 px-2.5 py-1.5">
            <MapPin size={14} className="text-yellow-600 shrink-0" />
            <p className="text-xs text-slate-600 leading-snug">
              Kecamatan tersorot di peta:{' '}
              <span className="font-semibold text-yellow-800">{sorotWilayah.nama}</span>
            </p>
          </div>
        )}

        {/* Rincian klik sel CAI/TDI (BARU 2026-09-13) — di bawah toggle overlai
            analitik, bukan lagi kotak melayang di atas peta (itu tetap dipakai
            tab Peta Interaktif). Keduanya reuse komponen persis sama dg varian
            'inline'; masing-masing render null kalau loading/result-nya kosong,
            jadi aman dirender berdampingan (App.jsx menjamin hanya salah satu
            yang pernah terisi pada satu waktu — lihat catatan di TdiScorePanel). */}
        <CaiScorePanel
          variant="inline"
          loading={caiLoading}
          result={caiResult}
          usingDemo={caiUsingDemo}
          onClose={onCaiClose}
        />
        <TdiScorePanel
          variant="inline"
          loading={tdiLoading}
          result={tdiResult}
          usingDemo={tdiUsingDemo}
          onClose={onTdiClose}
        />
      </div>

      {legendGroup && (
        <div className="px-4 pt-5 pb-4 mt-auto border-t border-slate-100 space-y-2">
          <p className="text-xs font-medium text-slate-600">{legendGroup.title}</p>
          {legendGroup.items.map((item, i) => (
            <div key={i} className="space-y-1">
              <div className="h-3 rounded-full" style={{ background: item.gradient }} />
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{item.labelLeft}</span>
                <span>{item.labelRight}</span>
              </div>
            </div>
          ))}
          {legendGroup.note && (
            <p className="text-[10px] text-slate-400 leading-relaxed">{legendGroup.note}</p>
          )}
          <p className="text-[10px] text-slate-400 leading-snug">
            Palet sequential colorblind-safe. Klik sel di peta utama untuk rincian angka per
            kriteria — legenda ini hanya skala warna, bukan pengganti rincian.
          </p>
        </div>
      )}
    </div>
  )
}
