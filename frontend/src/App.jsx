import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard,
  Map as MapIcon,
  SlidersHorizontal,
  Sparkles,
  MousePointerClick,
  Lightbulb,
  FileDown,
  Settings,
  LogOut,
  Bell,
  HelpCircle,
} from 'lucide-react'
import MapView from './components/Map/MapView'
import SearchBar from './components/Search/SearchBar'
import CaiScorePanel from './components/Map/CaiScorePanel'
import TdiScorePanel from './components/Map/TdiScorePanel'
import MapLegend from './components/Map/MapLegend'
import LayerControl from './components/Map/LayerControl'
import AIPanel from './components/AIPanel/AIPanel'
import AnalisisSpasial from './components/AnalisisSpasial/AnalisisSpasial'
import SimulationPanel from './components/SimulationMode/SimulationPanel'
import Dashboard from './components/Dashboard/Dashboard'
import EquityIndexView from './components/EquityIndexView/EquityIndexView'
import DataLaporan from './components/DataLaporan/DataLaporan'
import LoginPage from './components/Auth/LoginPage'
import Pengaturan from './components/Pengaturan/Pengaturan'
import { supabase, isConfigured } from './lib/supabaseClient'
import { extractLatLon, extractLineStringCoords, extractPolygonRings, haversineMeters } from './lib/geo'
import { isDummyHalte } from './lib/halteEksisting'
import { fetchAllRows } from './lib/fetchAllRows'
import { SOROT_WILAYAH_COLOR, SOROT_WILAYAH_HALO_COLOR } from './lib/mapColors'
import {
  CHOROPLETH_COLORS,
  computeMinMax,
  fmtBound,
  gradientCssFromColors,
  linearInterpolateFillColorExpr,
  sqrtInterpolateFillColorExpr,
  toPolygonFeatureCollection,
  VIRIDIS_COLORS,
} from './lib/choropleth'
import { markerIconSvg, legendIconSvg } from './lib/mapIcons'

// Batas area studi (outline Kota Bekasi) — aset STATIS yang di-bundle saat
// build, hasil etl/build_bekasi_boundary_geojson.py (dissolve 56 kelurahan
// RBI dari tabel batas_administrasi). Geografi batas administrasi tidak
// berubah, jadi ini sengaja BUKAN fetch runtime. Di-import lewat `?raw` +
// JSON.parse karena Vite tidak memproses ekstensi `.geojson` sebagai JSON
// modul secara default (hanya `.json`).
import bekasiBoundaryRaw from './data/bekasi_boundary.geojson?raw'

// Koridor + halte BisKita Trans Patriot versi APROKSIMASI dari OpenStreetMap
// (network=Trans Bekasi Patriot) + OSRM — aset STATIS di-bundle saat build,
// hasil etl/build_rute_biskita_osm.py. Sama sifatnya dengan bekasi_boundary di
// atas: display-only, TIDAK dipakai untuk skor/RPC apa pun. Ditampilkan sebagai
// konteks "cakupan koridor yang lebih penuh" di samping ruas biskita_survei yang
// lebih pendek. `?raw` + JSON.parse karena Vite tidak memproses `.geojson`.
import biskitaKoridorOsmRaw from './data/biskita_koridor_osm.geojson?raw'
import biskitaHalteOsmRaw from './data/biskita_halte_osm.geojson?raw'
import stasiunKotaBekasiRaw from './data/stasiun_kota_bekasi.geojson?raw'
import lrtJabodebekOsmRaw from './data/lrt_jabodebek_osm.geojson?raw'

// Koridor Transjakarta B21 (Bekasi Timur -> Cawang) — request Sam 2026-09-12,
// LAYER KONTEKS VISUAL MURNI (kategori sama dengan Koridor BisKita/KRL/LRT di
// atas): TIDAK dipakai skor CAI/TDI apa pun, TIDAK disentuh ETL/Supabase,
// TIDAK masuk Export Report (DataLaporan) — bukan data/skor/kartu dashboard
// baru, jadi aturan tetap sinkronisasi Data & Laporan tidak berlaku di sini.
// Aset STATIS hasil ekspor relasi rute OSM (ref=B21): 1 LineString (411 titik,
// ~21,4 km) + 15 Point halte, sudah divalidasi (geometri valid, halte snap
// persis ke vertex garis — data relasi rute bertag, bukan aproksimasi seperti
// layer biskita_koridor_osm). `?raw` + JSON.parse karena Vite tidak memproses
// `.geojson` sebagai modul JSON secara default.
import transjakartaB21Raw from './data/transjakarta_b21_osm.geojson?raw'

const bekasiBoundary = JSON.parse(bekasiBoundaryRaw)
const biskitaKoridorOsm = JSON.parse(biskitaKoridorOsmRaw)
const biskitaHalteOsm = JSON.parse(biskitaHalteOsmRaw)
const stasiunKotaBekasi = JSON.parse(stasiunKotaBekasiRaw)
const lrtJabodebekOsm = JSON.parse(lrtJabodebekOsmRaw)
const transjakartaB21 = JSON.parse(transjakartaB21Raw)
// Pisahkan garis rute (1 LineString) dari titik halte (15 Point) — sumbernya
// satu FeatureCollection gabungan, tapi MapView butuh source per-tipe geometri
// terpisah (line layer vs marker) mengikuti pola biskitaKoridorOsm/biskitaHalteOsm.
const transjakartaB21Line = {
  type: 'FeatureCollection',
  features: (transjakartaB21.features || []).filter((f) => f.geometry?.type === 'LineString'),
}
const transjakartaB21Stops = (transjakartaB21.features || []).filter(
  (f) => f.geometry?.type === 'Point',
)

// Feature flag login wall — OFF by default. Auth gate (LoginPage) hanya
// dipasang kalau VITE_AUTH_REQUIRED === 'true' DI SAMPING isConfigured.
// Submission WebGIS 13 Sep di-ship dengan flag OFF (akses tanpa login);
// login wall internal dinyalakan pasca-13 Sep cukup dengan set env var,
// tanpa ubah kode. Nilai selain string 'true' (termasuk unset) = OFF.
const AUTH_REQUIRED = import.meta.env.VITE_AUTH_REQUIRED === 'true'

// 8 menu sidebar sesuai wireframe resmi PRD (Gambar 6, Bab 10.2, lihat CLAUDE.md).
// Seluruh 8 menu kini punya komponen nyata (ComingSoon/../ComingSoon.jsx
// disisakan sebagai placeholder generik untuk menu masa depan kalau
// dibutuhkan lagi, tidak dipakai aktif saat ini).
const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'peta', label: 'Peta Interaktif', icon: MapIcon },
  { id: 'analisis', label: 'Analisis Spasial', icon: SlidersHorizontal },
  { id: 'ai', label: 'AI Spatial Consultant', icon: Sparkles },
  { id: 'simulasi', label: 'Simulasi Skenario', icon: MousePointerClick },
  { id: 'rekomendasi', label: 'Rekomendasi', icon: Lightbulb },
  { id: 'data-laporan', label: 'Data & Laporan', icon: FileDown },
  { id: 'pengaturan', label: 'Pengaturan', icon: Settings },
]

const DEMO_SIMULATION_RESULT = {
  penduduk_terlayani_400m: 3120,
  penduduk_terlayani_800m: 9840,
  estimasi_pengurangan_waktu_tempuh_menit: 6.5,
  fasilitas_pendidikan_400m: 2,
  fasilitas_kesehatan_400m: 1,
  transit_eksisting_terdekat: { nama: 'Halte Summarecon Bekasi (contoh)', jarak_m: 520 },
}

// Data contoh titik_kandidat + skor_cai — dipakai kalau Supabase belum
// tersambung/tabel masih kosong, supaya fitur "klik peta -> skor CAI" tetap
// bisa didemokan. Struktur field sengaja meniru kolom asli skor_cai
// (migration 001_init_tables.sql) — TIDAK ada formula dihitung di sini,
// murni angka contoh statis.
const DEMO_CAI_POINTS = [
  {
    lat: -6.2185, lon: 107.0074,
    titik: { id_titik_survei: 'KND-DEMO-001', deskripsi_lokasi: 'Depan Summarecon Mall Bekasi (contoh)', kecamatan: 'Bekasi Utara', kelurahan: 'Marga Mulya', catatan: null },
    skor: { n_kepadatan: 0.82, n_jarak_inv: 0.55, n_volume: 0.70, n_survei: 0.60, bobot_kepadatan: 0.35, bobot_jarak: 0.25, bobot_volume: 0.25, bobot_survei: 0.15, skor_final: 0.69 },
  },
  {
    lat: -6.2461, lon: 107.0021,
    titik: { id_titik_survei: 'KND-DEMO-002', deskripsi_lokasi: 'Simpang Jl. Ir. H. Juanda (contoh)', kecamatan: 'Bekasi Timur', kelurahan: 'Margahayu', catatan: null },
    skor: { n_kepadatan: 0.90, n_jarak_inv: 0.70, n_volume: 0.20, n_survei: 0.55, bobot_kepadatan: 0.35, bobot_jarak: 0.25, bobot_volume: 0.25, bobot_survei: 0.15, skor_final: 0.62 },
  },
  {
    lat: -6.2603, lon: 107.0324,
    titik: { id_titik_survei: 'KND-DEMO-003', deskripsi_lokasi: 'Terminal Bekasi (contoh)', kecamatan: 'Bekasi Selatan', kelurahan: 'Margajaya', catatan: null },
    skor: { n_kepadatan: 0.65, n_jarak_inv: 0.40, n_volume: 0.85, n_survei: 0.75, bobot_kepadatan: 0.35, bobot_jarak: 0.25, bobot_volume: 0.25, bobot_survei: 0.15, skor_final: 0.65 },
  },
  {
    lat: -6.2825, lon: 107.0450,
    titik: { id_titik_survei: 'KND-DEMO-004', deskripsi_lokasi: 'Perempatan Rawa Lumbu (contoh)', kecamatan: 'Rawa Lumbu', kelurahan: 'Sepanjang Jaya', catatan: null },
    skor: { n_kepadatan: 0.75, n_jarak_inv: 0.80, n_volume: 0.15, n_survei: 0.40, bobot_kepadatan: 0.35, bobot_jarak: 0.25, bobot_volume: 0.25, bobot_survei: 0.15, skor_final: 0.55 },
  },
  {
    lat: -6.2989, lon: 107.0658,
    titik: { id_titik_survei: 'KND-DEMO-005', deskripsi_lokasi: 'Jl. Raya Mustika Jaya (contoh)', kecamatan: 'Mustika Jaya', kelurahan: 'Mustika Jaya', catatan: null },
    skor: { n_kepadatan: 0.88, n_jarak_inv: 0.85, n_volume: 0.10, n_survei: 0.35, bobot_kepadatan: 0.35, bobot_jarak: 0.25, bobot_volume: 0.25, bobot_survei: 0.15, skor_final: 0.58 },
  },
]

// Data contoh rincian CAI — dipakai kalau Supabase belum tersambung, meniru
// JSON keluaran RPC get_cai_breakdown (migration 033) APA ADANYA. CAI kini
// SURFACE grid 300 m (grid_analisis), bukan lagi 19 titik_kandidat diskret —
// jadi bentuk ini per-sel, bukan per-titik. TIDAK ada formula dihitung di sini:
// `kontribusi` sudah = nilai x bobot, murni angka contoh statis.
//   * DEMO_CAI_BREAKDOWN         -> kasus mayoritas sel: 2 kriteria aktif
//     (kepadatan + jarak), bobot efektif 0,5 / 0,5 (rasio AHP kepadatan=jarak).
//   * DEMO_CAI_BREAKDOWN_VOLUME  -> sel dekat titik cacah lapangan: 3 kriteria
//     (kepadatan + jarak + volume), bobot efektif 0,3834 / 0,3834 / 0,2331.
// handleMapClick memilih salah satunya berdasar titik DEMO_CAI_POINTS terdekat
// (hanya untuk variasi tampilan — jarak tidak lagi jadi gerbang apa pun).
const DEMO_CAI_BREAKDOWN = {
  ditemukan: true,
  cell_id: 1487,
  match: 'memuat',
  jarak_ke_sel_m: 0,
  skor_cai: 0.5316,
  skor_cai_reproduksi: 0.5316,
  formula:
    'cai_skor = Σ( nilai_ternormalisasi_i × bobot_efektif_i ) untuk kriteria AKTIF di sel; ' +
    'tiap nilai dinormalisasi min-max 0–1; bobot dari AHP pairwise Saaty (konfigurasi_bobot ' +
    "nama_index='CAI'), subset kriteria aktif direnormalisasi ke jumlah 1. Model ADITIF (WLC), " +
    'bukan rasio seperti TDI.',
  volume_estimasi: false,
  komponen: [
    {
      kunci: 'kepadatan',
      label: 'Kepadatan penduduk',
      nilai: 0.618,
      bobot: 0.5,
      kontribusi: 0.309,
      nilai_mentah: 7284.15,
      satuan: 'jiwa per sel (~300 × 300 m, dasymetric mapping)',
      arah: 'Makin padat → skor CAI naik (prioritas naik)',
    },
    {
      kunci: 'jarak_fasilitas_inv',
      label: 'Jarak ke fasilitas umum (inverse)',
      nilai: 0.4452,
      bobot: 0.5,
      kontribusi: 0.2226,
      nilai_mentah: 612.4,
      satuan: 'meter ke POI fasilitas umum terdekat (sekolah/faskes/kerja, OSM; dibatasi 3000 m)',
      arah: 'Makin dekat → skor CAI naik',
    },
  ],
  catatan:
    'Data contoh — surface CAI grid 300 m HYBRID: kepadatan (dasymetric) & jarak POI (OSM) ' +
    'diturunkan dari geodata di setiap sel. Kriteria volume transit N/A untuk sel ini (tidak ada ' +
    'titik cacah lapangan ≤ 300 m); kriteria survei kondisi halte N/A (tidak ada halte tersurvei ' +
    '≤ 400 m). Bobot 2 kriteria sisanya (kepadatan, jarak) direnormalisasi ke jumlah 1.',
}

const DEMO_CAI_BREAKDOWN_VOLUME = {
  ditemukan: true,
  cell_id: 803,
  match: 'terdekat',
  jarak_ke_sel_m: 128,
  skor_cai: 0.632,
  skor_cai_reproduksi: 0.632,
  formula: DEMO_CAI_BREAKDOWN.formula,
  volume_estimasi: false,
  komponen: [
    {
      kunci: 'kepadatan',
      label: 'Kepadatan penduduk',
      nilai: 0.701,
      bobot: 0.3834,
      kontribusi: 0.2688,
      nilai_mentah: 9105.6,
      satuan: 'jiwa per sel (~300 × 300 m, dasymetric mapping)',
      arah: 'Makin padat → skor CAI naik (prioritas naik)',
    },
    {
      kunci: 'jarak_fasilitas_inv',
      label: 'Jarak ke fasilitas umum (inverse)',
      nilai: 0.523,
      bobot: 0.3834,
      kontribusi: 0.2005,
      nilai_mentah: 445,
      satuan: 'meter ke POI fasilitas umum terdekat (sekolah/faskes/kerja, OSM; dibatasi 3000 m)',
      arah: 'Makin dekat → skor CAI naik',
    },
    {
      kunci: 'volume',
      label: 'Volume penumpang / aktivitas transit',
      nilai: 0.698,
      bobot: 0.2331,
      kontribusi: 0.1627,
      nilai_mentah: 412,
      satuan: 'aktivitas / 2 jam (traffic counting lapangan, titik survei ≤ 300 m)',
      arah: 'Makin tinggi → skor CAI naik',
    },
  ],
  catatan:
    'Data contoh — surface CAI grid 300 m HYBRID: sel ini ≤ 300 m dari titik cacah lapangan, jadi ' +
    'kriteria volume transit AKTIF (traffic counting riil). Kriteria survei kondisi halte N/A ' +
    '(tidak ada halte tersurvei ≤ 400 m); bobot 3 kriteria sisanya direnormalisasi ke jumlah 1.',
}

// Rincian TDI contoh — dipakai kalau Supabase belum tersambung / RPC
// get_tdi_breakdown gagal, saat overlai analitik = 'tdi' dan user klik peta.
// Struktur meniru output RPC (migration 015, refined 021/027) apa adanya;
// TIDAK ada formula dihitung di sini, murni angka contoh statis. Dipindah dari
// AnalisisSpasial.jsx pada konsolidasi peta 2026-09-12 (klik-untuk-rincian TDI
// kini ditangani di sini, peta utama, bukan di peta kecil terpisah).
const DEMO_TDI_BREAKDOWN = {
  ditemukan: true,
  cell_id: null,
  match: 'memuat',
  jarak_ke_sel_m: 0,
  skor_tdi: 0.68,
  skor_tdi_reproduksi_perkiraan: 0.679,
  tdi_raw: 41.32,
  aksesibilitas_floor: 0.01,
  formula:
    'TDI_raw = kepadatan_penduduk x indeks_kebutuhan_mobilitas / maks(skor_aksesibilitas_transit, 0,01); ' +
    'skor_tdi = normalisasi_minmax(ln(1 + TDI_raw)) lintas seluruh sel grid',
  komponen: [
    {
      kunci: 'kepadatan_penduduk',
      label: 'Kepadatan penduduk',
      nilai: 8120.5,
      satuan: 'jiwa per sel (~300 x 300 m, hasil dasymetric mapping)',
      peran: 'pembilang',
      arah: 'Makin tinggi -> TDI makin tinggi (defisit layanan makin besar)',
    },
    {
      kunci: 'indeks_kebutuhan_mobilitas',
      label: 'Indeks Kebutuhan Mobilitas',
      nilai: 0.612,
      satuan: 'indeks 0-1 (proksi: proporsi usia rentan, kepadatan POI harian, proporsi usia sekolah 5-19)',
      peran: 'pembilang',
      arah: 'Makin tinggi -> TDI makin tinggi',
    },
    {
      kunci: 'skor_aksesibilitas_transit',
      label: 'Skor Aksesibilitas Transit',
      nilai: 0.12,
      satuan: 'indeks 0-1 (coverage isochrone 400/800 m ke halte eksisting terdekat)',
      peran: 'penyebut',
      arah: 'Makin tinggi -> TDI makin RENDAH (akses transit sudah baik)',
    },
  ],
  catatan:
    'Data contoh. skor_tdi lebih tinggi = sel makin "transit desert" (makin butuh prioritas).',
}

// Data contoh halte_eksisting — dipakai kalau Supabase belum tersambung/tabel
// masih kosong, supaya layer "jaringan transit eksisting" (acceptance criteria
// Peta Multi-Layer Gap Analysis, CLAUDE.md) tetap tampil. Koordinat & nama
// meniru sebagian titik nyata koridor BisKita di
// etl/data/survei/koordinat_halte_koridor_biskita.csv — ditandai "(contoh)"
// karena ini bukan hasil query tabel asli.
const DEMO_HALTE_POINTS = [
  { lat: -6.25645, lon: 106.99116, nama: 'Halte Simpang Pekayon (contoh)', kecamatan: 'Bekasi Selatan' },
  { lat: -6.25558, lon: 106.99061, nama: 'Halte Revo Mall (contoh)', kecamatan: 'Bekasi Selatan' },
  { lat: -6.2771474, lon: 106.9919647, nama: 'Halte RS Elisabeth (contoh)', kecamatan: 'Bekasi Selatan' },
  { lat: -6.2917104, lon: 106.9848925, nama: 'Halte Pesona Metropolitan Bekasi (contoh)', kecamatan: 'Bekasi Selatan' },
  { lat: -6.30884, lon: 106.98381, nama: 'Halte STISIP Bekasi (contoh)', kecamatan: 'Bekasi Selatan' },
]

// Data contoh rute_transit_eksisting — dipakai kalau Supabase belum
// tersambung/tabel masih kosong, meniru struktur 2 layer nyata (koridor
// BisKita tersurvei + jaringan rel KRL, lihat docs/DATA_CHECKLIST.md Tugas B).
// Koordinat BisKita meniru DEMO_HALTE_POINTS di atas; koordinat KRL murni
// ilustratif (ditandai "(contoh)"), BUKAN jejak rel sungguhan.
const DEMO_RUTE_BISKITA_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: DEMO_HALTE_POINTS.map((h) => [h.lon, h.lat]) },
      properties: { nama: 'Koridor BisKita (contoh)' },
    },
  ],
}
const DEMO_RUTE_KRL_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [106.9928, -6.2394],
          [107.0074, -6.2185],
        ],
      },
      properties: { nama: 'Jalur KRL Commuter Line (contoh)' },
    },
  ],
}
const DEMO_RUTE_TRANSIT_DISCLAIMER =
  'Data contoh — belum tersambung ke tabel rute_transit_eksisting.'

// Grid contoh untuk OVERLAI ANALITIK (choropleth kepadatan / TDI) saat Supabase
// belum tersambung. 36 sel kotak membagi bbox kasar Kota Bekasi — BUKAN grid
// 300 m riil grid_analisis, hanya supaya overlai tetap bisa didemokan. Nilai
// deterministik (bukan Math.random) supaya stabil antar reload.
const DEMO_CHORO_BBOX = { minLat: -6.35, maxLat: -6.15, minLon: 106.95, maxLon: 107.12 }
function buildDemoChoroCells() {
  const n = 6
  const lonStep = (DEMO_CHORO_BBOX.maxLon - DEMO_CHORO_BBOX.minLon) / n
  const latStep = (DEMO_CHORO_BBOX.maxLat - DEMO_CHORO_BBOX.minLat) / n
  const cells = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const seed = r * n + c + 1
      const rnd = (k) => {
        const x = Math.sin(seed * k) * 43758.5453
        return x - Math.floor(x)
      }
      const minLon = DEMO_CHORO_BBOX.minLon + c * lonStep
      const minLat = DEMO_CHORO_BBOX.minLat + r * latStep
      const maxLon = minLon + lonStep
      const maxLat = minLat + latStep
      cells.push({
        ring: [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
        kepadatan: Math.round(rnd(12.9898) * 16000 + 1500),
        tdi: Number(rnd(3.7).toFixed(2)),
      })
    }
  }
  return cells
}

// Warna marker titik_kandidat = TITIK SURVEI LAPANGAN (Form Traffic Counting).
// SATU warna sejak 2026-09-07: skema 2-warna lama membedakan "4 kriteria CAI
// terisi" vs "skor survei N/A", tapi setelah kriteria survei dinyatakan N/A
// untuk SELURUH titik kandidat, warna pertama tidak pernah muncul dengan data
// riil — legenda 2 entri jadi menyesatkan. Nuansa N/A tetap dijelaskan di
// panel rincian CAI (CaiScorePanel).
// TODO(ui-ux-designer): ini asumsi sementara, bukan keputusan desain final.
const CANDIDATE_MARKER_COLOR = '#2E7D5B'

// Warna marker halte TERSURVEI — sengaja beda rumpun warna (ungu) dari
// hijau/kuning titik_kandidat di atas supaya "halte yang sudah ada" vs
// "usulan lokasi baru" langsung terlihat beda tanpa harus buka popup dulu.
// TODO(ui-ux-designer): ini asumsi sementara, bukan keputusan desain final.
const HALTE_TERSURVEI_MARKER_COLOR = '#7C3AED'

// Warna garis koridor BisKita — sengaja DIBEDAKAN dari marker halte tersurvei
// (dulu sama-sama #7C3AED, jadi sulit dibedakan "ini titik halte" vs "ini
// garis rute" sekilas pandang). Dipilih oranye (referensi warna brand BisKita
// di beberapa kota nyata) supaya tetap kerasa "satu keluarga BisKita" dari sisi
// makna, tapi kontras jelas terhadap ungu halte maupun biru KRL — 3 warna jadi
// gampang dibedakan sekilas: ungu=titik halte, oranye=garis BisKita, biru=KRL.
// TODO(ui-ux-designer): ini asumsi sementara, bukan keputusan desain final.
const RUTE_BISKITA_COLOR = '#F97316'

// Warna koridor BisKita APROKSIMASI OSM — sengaja oranye lebih terang (orange-300)
// + garis putus-putus tipis, kontras jelas dengan RUTE_BISKITA_COLOR (oranye-500
// solid tebal ruas tersurvei) supaya terbaca sebagai "perkiraan cakupan koridor
// yang lebih panjang" di BELAKANG ruas tersurvei, bukan menyaingi/menutupinya.
// Warna titik halte OSM pakai oranye-600 (lebih gelap dari kedua garis) supaya
// dot kecilnya tetap kebaca, tetap satu keluarga warna BisKita, dan jelas beda
// dari ungu halte tersurvei (HALTE_TERSURVEI_MARKER_COLOR).
// TODO(ui-ux-designer): asumsi sementara, bukan keputusan desain final.
const RUTE_BISKITA_OSM_COLOR = '#FDBA74'
const HALTE_BISKITA_OSM_COLOR = '#EA580C'

// Warna jaringan KRL — sengaja beda rumpun (biru) dari ungu BisKita di atas
// supaya "infrastruktur eksis tapi belum disurvei tim" langsung terlihat beda
// dari korridor yang sudah jadi objek survei. Biru dipilih supaya familiar ke
// user awam (asosiasi umum warna KRL Commuter Line Indonesia).
// TODO(ui-ux-designer): ini asumsi sementara, bukan keputusan desain final.
const RUTE_KRL_COLOR = '#2563EB'

// Marker stasiun kereta eksisting (layer referensi, stasiun_kota_bekasi.geojson).
// KRL = biru (satu keluarga dengan garis RUTE_KRL_COLOR). LRT = teal, beda
// rumpun supaya 2 moda rel langsung terbedakan; keduanya jelas beda dari ungu
// halte BisKita tersurvei & hijau/cokelat titik kandidat.
const STASIUN_KRL_MARKER_COLOR = '#2563EB'
const STASIUN_LRT_MARKER_COLOR = '#0D9488'
// Garis jalur LRT — teal sama dengan marker stasiunnya (satu moda = satu
// keluarga warna), solid tipis: geometri rel ASLI dari OSM, bukan aproksimasi
// seperti koridor BisKita (yang sengaja dashed).
const RUTE_LRT_COLOR = '#0D9488'

// Marker usulan halte hasil MODEL SPASIAL (tabel usulan_halte_model, migration
// 028) — magenta, sengaja di luar seluruh rumpun warna lain supaya tidak pernah
// tertukar dengan titik survei lapangan (hijau) maupun halte tersurvei (ungu).
// Ini usulan turunan model, BELUM disurvei — pembedaan wajib, lihat CLAUDE.md.
const USULAN_MODEL_MARKER_COLOR = '#DB2777'

// Warna koridor Transjakarta B21 (Bekasi Timur <-> Cawang) — sengaja MERAH,
// rumpun warna belum dipakai layer mana pun (hijau/ungu/oranye/biru/teal/
// magenta/emas sudah terpakai di atas), sekaligus dekat warna brand
// Transjakarta di dunia nyata. Harus kontras jelas dari RUTE_BISKITA_OSM_COLOR
// (oranye-300) supaya "koridor OSM lain" ini tidak tertukar dengan BisKita —
// dibedakan garis PUTUS-PUTUS (data relasi OSM presisi, tapi bukan geometri
// jalan-per-jalan tervalidasi tim seperti biskita_survei yang solid) + warna
// beda rumpun sama sekali (merah vs oranye), memenuhi syarat colorblind-safe
// non-warna CLAUDE.md Bab 10.3 sekaligus.
// TODO(ui-ux-designer): ini asumsi sementara webgis-developer, bukan keputusan
// desain final.
const TRANSJAKARTA_B21_COLOR = '#DC2626'

// Warna garis batas area studi (outline Kota Bekasi) — token brand-blue
// (#1B659D, --color-brand-blue di src/index.css; sama dengan warna header &
// marker default MapView). Garis putus-putus supaya kebaca sebagai "batas
// wilayah", bukan rute/jaringan.
const BATAS_KOTA_COLOR = '#1B659D'

// Warna sorotan batas wilayah TERPILIH dari hasil pencarian (kelurahan/kecamatan
// via RPC get_admin_geometry) DAN filter kecamatan di tab Analisis Spasial.
// Sengaja dibedakan tegas dari BATAS_KOTA_COLOR: batas kota = biru brand +
// PUTUS-PUTUS ("area studi", konteks permanen); wilayah terpilih = emas +
// SOLID tebal + isian tipis ("area yang barusan kamu pilih", sementara). Beda
// bentuk garis + adanya isian bidang membuat keduanya terbedakan TANPA
// bergantung warna sama sekali (syarat colorblind-safe CLAUDE.md Bab 10.3).
// Tidak memakai pasangan merah–hijau sama sekali.
// Dipindah ke lib/mapColors.js (2026-09-13, ui-ux-designer, final — bukan lagi
// TODO) supaya AnalisisSpasial.jsx bisa memakai warna yang SAMA PERSIS untuk
// badge nama kecamatan terpilih di panel kontrol, tanpa hex literal kedua.
// Lihat lib/mapColors.js untuk rincian perbaikan kontras garis (halo gelap).

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Popup titik_kandidat. PENTING (keputusan Sam 2026-09-07): titik-titik ini
// adalah TITIK SURVEI LAPANGAN (Form Traffic Counting), bukan "usulan lokasi
// baru" — dulu dilabeli begitu dan menyesatkan, karena beberapa di antaranya
// justru simpul eksisting (Stasiun Bekasi, Terminal Bekasi). Yang bersifat
// usulan adalah PROYEKSI-nya: skor CAI menjawab "seberapa layak kalau halte
// baru ditaruh di sini". Popup menyatakan keduanya terpisah.
// Usulan yang diturunkan MODEL ada di layer terpisah (usulan_halte_model).
function buildCandidatePopupHtml(titik) {
  const lines = []
  if (titik?.deskripsi_lokasi) lines.push(`<strong>${escapeHtml(titik.deskripsi_lokasi)}</strong>`)
  const wilayah = [titik?.kelurahan, titik?.kecamatan].filter(Boolean).join(', ')
  if (wilayah) lines.push(escapeHtml(wilayah))
  lines.push('<span style="color:#64748b">Titik survei lapangan — Form Traffic Counting</span>')
  if (titik?.catatan) {
    lines.push(escapeHtml(titik.catatan))
  }
  lines.push(
    '<em>Klik titik ini untuk proyeksi <strong>halte baru di lokasi ini</strong>: skor CAI + rincian tiap kriteria.</em>',
  )
  return lines.join('<br/>')
}

// Popup halte_eksisting sengaja minimal (nama + wilayah) — rincian survei
// lengkap (headway, okupansi, dst) itu domain tab Analisis Spasial, bukan
// tab Peta Interaktif ini. Label "Halte Tersurvei" (bukan "Halte Eksisting")
// sengaja dipakai: halte yang belum disurvei pun tetap eksis secara fisik,
// yang benar-benar membedakan baris ini adalah status SUDAH DISURVEI tim,
// bukan keberadaan fisiknya (lihat juga layer KRL di bawah — eksis tapi
// belum disurvei).
function buildHaltePopupHtml(halte) {
  const lines = [`<strong>${escapeHtml(halte?.nama || 'Halte Tersurvei')}</strong>`]
  if (halte?.kecamatan) lines.push(escapeHtml(halte.kecamatan))
  lines.push('<span style="color:#64748b">Halte tersurvei (koridor BisKita)</span>')
  return lines.join('<br/>')
}

// Popup marker stasiun kereta (stasiun_kota_bekasi.geojson) — per-fitur,
// nama + moda + keterangan dari properties FeatureCollection.
function buildStasiunPopupHtml(props) {
  const lines = [`<strong>${escapeHtml(props?.nama || 'Stasiun')}</strong>`]
  if (props?.keterangan) lines.push(escapeHtml(props.keterangan))
  lines.push('<span style="color:#64748b">Infrastruktur eksisting — belum disurvei lapangan tim</span>')
  return lines.join('<br/>')
}

// Popup usulan halte hasil model spasial (tabel usulan_halte_model). Angka
// penduduk terlayani = keluaran RPC simulate_new_stop, bukan estimasi frontend.
function buildUsulanModelPopupHtml(u) {
  const n = (v) => (v == null ? '-' : Number(v).toLocaleString('id-ID'))
  const lines = [
    `<strong>Usulan #${escapeHtml(u?.ranking)} — ${escapeHtml(u?.kode)}</strong>`,
  ]
  const wilayah = [u?.kelurahan, u?.kecamatan].filter(Boolean).join(', ')
  if (wilayah) lines.push(escapeHtml(wilayah))
  lines.push(
    `Proyeksi terlayani: <strong>${n(u?.penduduk_terlayani_400m)}</strong> jiwa (400 m) · ` +
      `<strong>${n(u?.penduduk_terlayani_800m)}</strong> jiwa (800 m)`,
  )
  if (u?.skor_tdi_sel != null) {
    lines.push(`Skor TDI sel asal: ${Number(u.skor_tdi_sel).toFixed(3)}`)
  }
  if (u?.jarak_halte_terdekat_m != null) {
    lines.push(`Halte terdekat: ~${n(Math.round(u.jarak_halte_terdekat_m))} m`)
  }
  lines.push(
    '<span style="color:#be185d">Usulan dari model spasial — BELUM disurvei lapangan</span>',
  )
  return lines.join('<br/>')
}

// Popup layer garis "Koridor BisKita (tersurvei)" — statis, sama untuk
// seluruh garis (satu layer = satu pesan, lihat popupHtml di MapView.jsx).
// Isi disclaimer diambil LANGSUNG dari kolom `catatan` baris
// rute_transit_eksisting (ditulis data-ai-analyst) — bukan dikarang di
// frontend — supaya kalau redaksinya direvisi di database, popup ikut
// berubah tanpa perlu redeploy frontend.
function buildBiskitaPopupHtml(catatan) {
  const lines = [
    '<strong>Koridor BisKita (tersurvei)</strong>',
    '<span style="color:#b45309">Aproksimasi — bukan rute resmi operator/GTFS</span>',
  ]
  if (catatan) lines.push(escapeHtml(catatan))
  return lines.join('<br/>')
}

// Popup layer garis jaringan KRL — statis (satu layer = satu pesan). Isi
// diambil dari kolom `catatan` baris rute_transit_eksisting jenis='krl'
// (identik di semua baris krl saat ini) — bukan dikarang di frontend.
function buildKrlPopupHtml(catatan) {
  const lines = [
    '<strong>Jalur KRL Commuter Line</strong>',
    '<span style="color:#64748b">Infrastruktur eksis — belum disurvei lapangan oleh tim</span>',
  ]
  if (catatan) lines.push(escapeHtml(catatan))
  return lines.join('<br/>')
}

// Popup layer koridor & halte BisKita aproksimasi OSM — statis per layer (mekanisme
// `layers` di MapView.jsx hanya mendukung SATU popupHtml per layer, bukan per-fitur,
// jadi popup nama per-halte tidak dibuat — cukup satu disclaimer seragam). Redaksi
// mengikuti properties.catatan/sumber di FeatureCollection-nya + disclaimer aproksimasi
// yang eksplisit (bukan trayek resmi operator).
// Popup layer garis jalur LRT. Beda tegas dari koridor BisKita OSM: geometri
// rel LRT ADA di OSM sebagai way railway=light_rail, jadi ini bukan aproksimasi.
const LRT_POPUP_HTML = [
  '<strong>Jalur LRT Jabodebek</strong>',
  `<span style="color:#64748b">Geometri rel asli OpenStreetMap (bukan aproksimasi), di-clip ke batas Kota Bekasi${
    lrtJabodebekOsm?.properties?.panjang_km_dalam_kota
      ? ` — ${lrtJabodebekOsm.properties.panjang_km_dalam_kota} km dalam kota`
      : ''
  }. Infrastruktur eksisting, belum disurvei lapangan tim.</span>`,
  escapeHtml(lrtJabodebekOsm?.properties?.sumber || ''),
].filter(Boolean).join('<br/>')

const BISKITA_KORIDOR_OSM_POPUP_HTML = [
  '<strong>Koridor BisKita Trans Patriot (aproksimasi OSM)</strong>',
  '<span style="color:#b45309">Aproksimasi koridor dari halte OpenStreetMap + OSRM — bukan trayek resmi operator/Dishub, bukan hasil survei lapangan tim.</span>',
  escapeHtml(biskitaKoridorOsm?.properties?.sumber || ''),
].filter(Boolean).join('<br/>')

const BISKITA_HALTE_OSM_POPUP_HTML = [
  '<strong>Halte BisKita Trans Patriot (OSM)</strong>',
  '<span style="color:#b45309">Titik halte dari OpenStreetMap — belum disurvei lapangan tim, bukan data resmi operator.</span>',
  escapeHtml(biskitaHalteOsm?.properties?.sumber || ''),
].filter(Boolean).join('<br/>')

// Popup koridor Transjakarta B21 — layer KONTEKS VISUAL murni, sama seperti
// KRL/LRT/BisKita OSM di atas: tidak dipakai skor apa pun. Catatan cakupan
// (±72% dalam Kota Bekasi) ditulis apa adanya mengikuti konvensi honest-
// disclosure proyek ini (lihat BISKITA_KORIDOR_OSM_POPUP_HTML) — rute
// ditampilkan UTUH (tidak dipotong), garis + seluruh 15 halte tetap
// ditampilkan sampai Cawang supaya tidak menyalahi data relasi OSM yang valid.
const TRANSJAKARTA_B21_LINE_POPUP_HTML = [
  '<strong>Transjakarta B21: Bekasi Timur → Cawang</strong>',
  '<span style="color:#64748b">Relasi rute OpenStreetMap (ref=B21, route=bus) — konteks visual, bukan data resmi dipakai skor CAI/TDI apa pun.</span>',
  '<span style="color:#64748b">±72% panjang rute berada dalam Kota Bekasi (~15,55 km dari total ~21,4 km); sisanya menuju Cawang, DKI Jakarta, di luar area studi.</span>',
].join('<br/>')

// Popup per-halte B21 — dipakai lewat marker (bukan popupHtml layer statis)
// supaya tiap titik menampilkan namanya sendiri, sama pola dengan
// buildStasiunPopupHtml di bawah.
function buildTransjakartaB21StopPopupHtml(nama) {
  const lines = [
    `<strong>${escapeHtml(nama || 'Halte Transjakarta B21')}</strong>`,
    '<span style="color:#64748b">Transjakarta B21: Bekasi Timur → Cawang (OpenStreetMap) — konteks visual, bukan data resmi dipakai skor apa pun.</span>',
  ]
  return lines.join('<br/>')
}

// Auth gate sederhana single-role (Dishub/Bappeda staf) — Supabase Auth
// email+password, TANPA role/permission berjenjang dan TANPA UI signup
// (akun staf dibuat lewat Supabase Dashboard, lihat catatan di README/laporan
// task). Ini hanya proteksi di level UI (siapa yang boleh MEMBUKA aplikasi),
// BUKAN perubahan RLS — SELECT publik di Supabase tetap seperti semula
// (lihat CLAUDE.md, migration 002_rls_policies.sql).
//
// Kalau Supabase belum dikonfigurasi (`isConfigured` false), auth gate ini
// SENGAJA dilewati (langsung render app) supaya mode demo tanpa .env tetap
// bisa dijalankan untuk development/demo cepat — konsisten dengan pola
// isConfigured di seluruh komponen lain.
//
// Kalau AUTH_REQUIRED false (default), hook ini SHORT-CIRCUIT total: tidak
// ada panggilan supabase.auth.getSession()/onAuthStateChange, session tetap
// null, authLoading langsung false — jadi tidak ada network call auth mubazir
// saat login wall dimatikan untuk submission.
function useAuthSession() {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(AUTH_REQUIRED && isConfigured)

  useEffect(() => {
    if (!AUTH_REQUIRED || !isConfigured) return

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  return { session, authLoading }
}

export default function App() {
  const { session, authLoading } = useAuthSession()
  const [activeTab, setActiveTab] = useState('peta')

  // Instance MapLibre di-lift dari MapView (lewat onMapReady) supaya komponen
  // di luar peta — mis. SearchBar di header — bisa memanggil flyTo/fitBounds.
  // Null sampai event 'load' peta pertama selesai; pemakai wajib guard null.
  const [mapInstance, setMapInstance] = useState(null)

  // Batas wilayah yang sedang disorot karena dipilih dari hasil pencarian:
  // { level: 'kelurahan'|'kecamatan', nama, geojson } atau null. Diisi SearchBar
  // (lazy, via RPC get_admin_geometry saat baris Wilayah dipilih) dan
  // dikosongkan saat hasil titik/garis dipilih atau input dibersihkan.
  const [sorotWilayah, setSorotWilayah] = useState(null)

  // --- Panel Layer (tab Peta Interaktif) ---
  // Visibilitas layer titik/garis konteks — default SELEKTIF, bukan semua ON:
  // usulanModel & krl mulai tertutup (usulan model belum tervalidasi lapangan;
  // jaringan KRL garis tumpang tindih dengan layer stasiun) sementara sisanya
  // (halte, stasiun, koridorBiskita, lrt, batasKota) tampil dari awal. Key
  // dipetakan ke marker group / layer garis di mapLayers di bawah.
  // candidateMarkers (titik survei, jangkar CAI) sengaja TIDAK di daftar ini
  // — selalu tampil.
  const [layerVis, setLayerVis] = useState({
    usulanModel: false,
    halte: true,
    stasiun: true,
    koridorBiskita: true,
    krl: true,
    lrt: true,
    batasKota: true,
    // Default OFF — request Sam 2026-09-12 eksplisit menandai ini sebagai
    // asumsi wajar, bukan keputusan final: layer baru mengikuti konvensi
    // minimalis-default panel ini (hanya core layer yang disepakati lebih
    // dulu default ON; tambahan sejak itu default OFF). Ganti ke `true` di
    // sini kalau Sam minta tampil dari awal.
    transjakartaB21: false,
  })
  // Ambang tampil untuk layer "Usulan halte model" — filter TUNGGAL di
  // `usulan_halte_model.ranking` (ranking <= nilai ini), bukan data
  // berbeda per level. Default 25 = "Level 1" (paling mendesak), konsisten
  // dengan pola default konservatif panel ini (usulanModel sendiri default
  // OFF; begitu dinyalakan, langsung tampil subset paling prioritas dulu,
  // bukan semuanya). Diatur lewat LayerControl (3 preset + slider 0–100).
  const [usulanModelRankLimit, setUsulanModelRankLimit] = useState(25)
  // Overlai analitik choropleth full-map: 'none' | 'kepadatan' | 'tdi'.
  const [analyticOverlay, setAnalyticOverlay] = useState('none')
  // Cache sel grid_analisis untuk overlai — di-fetch LAZY (sekali, saat overlai
  // pertama kali dinyalakan) lalu ditahan; toggle off/on tidak fetch ulang.
  // Bentuk: array { ring:[[lon,lat]...], kepadatan:number, tdi:number } | null.
  const [gridChoro, setGridChoro] = useState(null)
  const [gridChoroLoading, setGridChoroLoading] = useState(false)
  // Penjaga supaya fetch grid_analisis untuk overlai HANYA jalan sekali —
  // toggle overlai off lalu on lagi tidak memicu fetch ulang.
  const gridChoroFetchStartedRef = useRef(false)

  useEffect(() => {
    if (analyticOverlay === 'none' || gridChoroFetchStartedRef.current) return
    gridChoroFetchStartedRef.current = true
    let cancelled = false

    ;(async () => {
      setGridChoroLoading(true)
      try {
        if (!isConfigured) {
          if (!cancelled) setGridChoro(buildDemoChoroCells())
          return
        }
        // 2.607 baris grid_analisis > cap 1000/req PostgREST -> fetchAllRows.
        const { data, error } = await fetchAllRows(() =>
          supabase.from('grid_analisis').select('id, geom, kepadatan_penduduk, skor_tdi'),
        )
        if (error) throw error
        const cells = (data ?? [])
          .map((row) => {
            const ring0 = extractPolygonRings(row.geom)?.[0]
            if (!ring0) return null
            return { ring: ring0, kepadatan: row.kepadatan_penduduk, tdi: row.skor_tdi }
          })
          .filter(Boolean)
        if (!cancelled) setGridChoro(cells.length ? cells : buildDemoChoroCells())
      } catch (err) {
        console.error('Gagal memuat grid_analisis untuk overlai analitik:', err)
        if (!cancelled) setGridChoro(buildDemoChoroCells())
      } finally {
        if (!cancelled) setGridChoroLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [analyticOverlay])

  // --- Simulasi What-If ---
  const [simulationActive, setSimulationActive] = useState(false)
  const [simLoading, setSimLoading] = useState(false)
  const [simResult, setSimResult] = useState(null)
  // Hasil simulate_new_stop TERAKHIR dalam sesi ini — TIDAK ikut dibersihkan
  // saat ganti mode/klik CAI (beda dari simResult). Dipakai AIPanel: kalau user
  // sudah pernah menjalankan What-If, output-nya diteruskan ke Edge Function
  // ai-insight sebagai body.simulasi supaya tahap Action narasi CCIA bisa
  // mengutip "+N jiwa" riil (bukan angka karangan). Aman kalau null.
  const [lastSimResult, setLastSimResult] = useState(null)

  // --- Skor CAI per klik lokasi (Fase 2 — Composite Accessibility Index) ---
  const [caiLoading, setCaiLoading] = useState(false)
  const [caiResult, setCaiResult] = useState(null)
  const [caiUsingDemo, setCaiUsingDemo] = useState(!isConfigured)

  // --- Rincian TDI per klik lokasi — aktif HANYA saat analyticOverlay==='tdi'
  // (konsolidasi peta 2026-09-12: dipindah dari AnalisisSpasial.jsx, yang dulu
  // punya <MapView> + handleMapClick sendiri). RPC get_tdi_breakdown HANYA
  // menyajikan kolom grid_analisis yang sudah dihitung offline (data-ai-analyst)
  // — tidak ada skor dihitung ulang di sini.
  const [tdiLoading, setTdiLoading] = useState(false)
  const [tdiResult, setTdiResult] = useState(null)
  const [tdiUsingDemo, setTdiUsingDemo] = useState(!isConfigured)

  // Overlai berpindah menjauh dari 'tdi' (mis. user ganti ke 'kepadatan' atau
  // 'none') -> tutup panel rincian TDI yang mungkin masih terbuka, supaya
  // tidak ada panel basi yang tidak relevan lagi dengan overlai aktif.
  useEffect(() => {
    if (analyticOverlay !== 'tdi') setTdiResult(null)
  }, [analyticOverlay])

  // Daftar titik_kandidat + skor_cai — di-fetch sekali di awal supaya klik peta
  // instan (tidak query ulang tiap klik) DAN supaya bisa dirender sebagai marker
  // di peta (state, bukan ref, karena harus memicu render ulang marker). Ini
  // murni membaca hasil yang sudah dihitung data-ai-analyst, bukan menghitung
  // ulang formula CAI di frontend. Query TANPA filter/limit ketat (limit 500
  // jauh di atas jumlah baris riil saat ini) supaya seluruh titik_kandidat
  // ikut, bukan subset.
  const [caiPoints, setCaiPoints] = useState({ points: DEMO_CAI_POINTS, usingDemo: !isConfigured })

  // Daftar halte_eksisting (jaringan transit eksisting, koridor BisKita) —
  // fetch sekali di awal, sama polanya dengan caiPoints di atas, supaya
  // acceptance criteria "Peta Multi-Layer Gap Analysis" (layer jaringan
  // transit eksisting, lihat CLAUDE.md) benar-benar tampil di tab Peta
  // Interaktif, bukan cuma di tab Analisis Spasial. Baris dummy/seed testing
  // (id_halte_survei berprefix "DUMMY-HLT-") dibuang — lihat lib/halteEksisting.js.
  const [haltePoints, setHaltePoints] = useState({ points: DEMO_HALTE_POINTS, usingDemo: !isConfigured })

  useEffect(() => {
    if (!isConfigured) return

    supabase
      .from('halte_eksisting')
      .select('id, id_halte_survei, nama, geom, kecamatan, kelurahan')
      .limit(500)
      .then(({ data, error }) => {
        if (error || !data?.length) {
          setHaltePoints({ points: DEMO_HALTE_POINTS, usingDemo: true })
          return
        }
        const points = data
          .filter((row) => !isDummyHalte(row.id_halte_survei))
          .map((row) => {
            const coords = extractLatLon(row.geom)
            if (!coords) return null
            return { ...coords, nama: row.nama, kecamatan: row.kecamatan, kelurahan: row.kelurahan }
          })
          .filter(Boolean)

        setHaltePoints(
          points.length
            ? { points, usingDemo: false }
            : { points: DEMO_HALTE_POINTS, usingDemo: true }
        )
      })
  }, [])

  // Usulan halte hasil MODEL SPASIAL (tabel usulan_halte_model, migration 028).
  // Ini yang menjawab PRD Bab 1.1 "di titik mana pengembangan transit memberi
  // dampak terbesar" dengan lokasi yang DITEMUKAN MODEL (sel transit desert
  // TDI > 0,6, ≥400 m dari halte, de-klaster 800 m, dampak dari RPC
  // simulate_new_stop) — bukan lokasi yang kebetulan disurvei.
  // WAJIB dibedakan dari titik_kandidat di UI (lihat CLAUDE.md): yang ini
  // BELUM disurvei lapangan. Tidak ada baris dummy di tabel ini, jadi tidak
  // perlu filter sumber seperti skor_equity.
  const [usulanModel, setUsulanModel] = useState([])

  useEffect(() => {
    if (!isConfigured) return
    supabase
      .from('usulan_halte_model')
      .select(
        'kode, geom, ranking, skor_tdi_sel, penduduk_terlayani_400m, penduduk_terlayani_800m, jarak_halte_terdekat_m, kecamatan, kelurahan',
      )
      .order('ranking', { ascending: true })
      .then(({ data, error }) => {
        if (error || !data?.length) return // biarkan kosong — layer tidak tampil
        setUsulanModel(
          data
            .map((row) => {
              const coords = extractLatLon(row.geom)
              return coords ? { ...row, ...coords } : null
            })
            .filter(Boolean),
        )
      })
  }, [])

  // Rute transit eksisting — 2 layer garis dari tabel rute_transit_eksisting
  // (migration 013): koridor BisKita TERSURVEI (jenis='biskita_survei',
  // LineString) dan jaringan KRL yang EKSIS TAPI BELUM DISURVEI tim
  // (jenis='krl', LineString ruas rel). Titik stasiun KRL TIDAK dirender
  // sebagai marker: jejak rel sudah cukup jadi konteks, basemap MAPID sendiri
  // sudah menampilkan ikon stasiun, dan marker titik sempat salah lokasi /
  // membingungkan (dihapus 2026-09-07 atas permintaan Sam). Fetch sekali di
  // awal, sama polanya dengan haltePoints/caiPoints. `nama` sebagian baris krl
  // memang kosong — buildKrlPopupHtml sudah fallback teks generik.
  const [ruteTransit, setRuteTransit] = useState({
    biskitaGeoJSON: DEMO_RUTE_BISKITA_GEOJSON,
    biskitaPopupHtml: buildBiskitaPopupHtml(DEMO_RUTE_TRANSIT_DISCLAIMER),
    krlLinesGeoJSON: DEMO_RUTE_KRL_GEOJSON,
    krlPopupHtml: buildKrlPopupHtml(DEMO_RUTE_TRANSIT_DISCLAIMER),
    usingDemo: !isConfigured,
  })

  useEffect(() => {
    if (!isConfigured) return

    supabase
      .from('rute_transit_eksisting')
      .select('id, nama, jenis, tipe_geometri, geom, sumber, catatan')
      .limit(500)
      .then(({ data, error }) => {
        if (error || !data?.length) return // biarkan fallback demo di state awal

        const biskitaRows = data.filter((r) => r.jenis === 'biskita_survei' && r.tipe_geometri === 'line')
        const krlLineRows = data.filter((r) => r.jenis === 'krl' && r.tipe_geometri === 'line')

        const toLineFeatures = (rows) =>
          rows
            .map((row) => {
              const coords = extractLineStringCoords(row.geom)
              if (!coords?.length) return null
              return {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties: { nama: row.nama?.trim() || null },
              }
            })
            .filter(Boolean)

        const biskitaFeatures = toLineFeatures(biskitaRows)
        const krlLineFeatures = toLineFeatures(krlLineRows)

        setRuteTransit({
          biskitaGeoJSON: biskitaFeatures.length
            ? { type: 'FeatureCollection', features: biskitaFeatures }
            : DEMO_RUTE_BISKITA_GEOJSON,
          biskitaPopupHtml: buildBiskitaPopupHtml(biskitaRows[0]?.catatan),
          krlLinesGeoJSON: krlLineFeatures.length
            ? { type: 'FeatureCollection', features: krlLineFeatures }
            : DEMO_RUTE_KRL_GEOJSON,
          krlPopupHtml: buildKrlPopupHtml(krlLineRows[0]?.catatan),
          usingDemo: !(biskitaFeatures.length || krlLineFeatures.length),
        })
      })
  }, [])

  // Marker tunggal untuk lokasi yang baru diklik bebas (dipakai kedua mode:
  // simulasi & cek skor CAI di lokasi non-titik-kandidat)
  const [clickMarker, setClickMarker] = useState(null)

  useEffect(() => {
    if (!isConfigured) return

    supabase
      .from('titik_kandidat')
      .select(
        'id, id_titik_survei, deskripsi_lokasi, kecamatan, kelurahan, catatan, geom, ' +
        'skor_cai(n_kepadatan, n_jarak_inv, n_volume, n_survei, ' +
        'bobot_kepadatan, bobot_jarak, bobot_volume, bobot_survei, skor_final)'
      )
      .limit(500)
      .then(({ data, error }) => {
        if (error || !data?.length) {
          setCaiPoints({ points: DEMO_CAI_POINTS, usingDemo: true })
          return
        }
        const points = data
          .map((row) => {
            const coords = extractLatLon(row.geom)
            if (!coords) return null
            const skorRow = Array.isArray(row.skor_cai) ? row.skor_cai[0] : row.skor_cai
            if (!skorRow) return null
            return {
              lat: coords.lat,
              lon: coords.lon,
              titik: {
                id_titik_survei: row.id_titik_survei,
                deskripsi_lokasi: row.deskripsi_lokasi,
                kecamatan: row.kecamatan,
                kelurahan: row.kelurahan,
                catatan: row.catatan,
              },
              skor: skorRow,
            }
          })
          .filter(Boolean)

        setCaiPoints(
          points.length
            ? { points, usingDemo: false }
            : { points: DEMO_CAI_POINTS, usingDemo: true }
        )
      })
  }, [])

  // Jalankan RPC simulate_new_stop di satu lokasi — dipakai baik oleh klik peta
  // (mode simulasi aktif) maupun oleh dropdown skenario preset di SimulationPanel.
  const runSimulationAt = useCallback(async ({ lat, lon, popupText = 'Lokasi simulasi', focusTab = false }) => {
    if (focusTab) setActiveTab('simulasi')
    setSimLoading(true)
    setCaiResult(null)
    setClickMarker({ lat, lon, color: '#E08A1E', popupText, pulse: true })

    try {
      if (isConfigured) {
        const { data, error } = await supabase.rpc('simulate_new_stop', { lat, lon })
        if (error) throw error
        setSimResult(data)
        setLastSimResult(data)
      } else {
        await new Promise((r) => setTimeout(r, 500))
        setSimResult(DEMO_SIMULATION_RESULT)
        setLastSimResult(DEMO_SIMULATION_RESULT)
      }
    } catch (err) {
      console.error('Gagal menjalankan simulate_new_stop:', err)
      setSimResult(null)
    } finally {
      setSimLoading(false)
    }
  }, [])

  const handleMapClick = useCallback(async ({ lat, lon }) => {
    if (simulationActive) {
      // --- Alur Simulasi What-If (RPC simulate_new_stop) ---
      await runSimulationAt({ lat, lon })
      return
    }

    if (analyticOverlay === 'tdi') {
      // --- Alur rincian TDI (RPC get_tdi_breakdown) — aktif hanya saat
      // overlai analitik = 'tdi' (dipindah dari AnalisisSpasial.jsx, lihat
      // catatan state tdiResult di atas). Klik saat overlai lain aktif tetap
      // masuk jalur CAI di bawah, tidak berubah.
      setTdiLoading(true)
      setCaiResult(null)
      setSimResult(null)
      setClickMarker({ lat, lon, color: '#334155', popupText: 'Lokasi dicek', pulse: true })

      if (isConfigured) {
        setTdiUsingDemo(false)
        try {
          const { data, error } = await supabase.rpc('get_tdi_breakdown', { lng: lon, lat })
          if (error) throw error
          setTdiResult(data)
        } catch (err) {
          console.error('Gagal memanggil get_tdi_breakdown:', err)
          setTdiResult({ ditemukan: false, pesan: 'Gagal memuat rincian TDI.' })
        }
      } else {
        setTdiUsingDemo(true)
        await new Promise((r) => setTimeout(r, 300))
        setTdiResult(DEMO_TDI_BREAKDOWN)
      }
      setTdiLoading(false)
      return
    }

    // --- Alur skor CAI (klik lokasi -> RPC get_cai_breakdown, surface grid 300 m) ---
    // Sejak CAI pindah dari 19 titik_kandidat diskret ke SURFACE grid 300 m
    // (grid_analisis, migration 033), skor CAI tersedia untuk SEMBARANG
    // koordinat di area berpenduduk Kota Bekasi — bukan lagi lookup tetangga
    // terdekat + ambang jarak. RPC HANYA menyajikan kolom cai_* yang sudah
    // dihitung offline (etl/compute_cai_grid.py); frontend tidak menghitung
    // ulang formula CAI. setCaiResult diisi JSON RPC apa adanya (CaiScorePanel
    // yang mem-parse bentuk ditemukan:true / ditemukan:false).
    setCaiLoading(true)
    setSimResult(null)
    // Slate netral — marker transient "titik yang baru diklik", sengaja bukan
    // warna layer data mana pun. Marker simulasi sudah oranye.
    setClickMarker({ lat, lon, color: '#334155', popupText: 'Lokasi dicek', pulse: true })

    if (isConfigured) {
      setCaiUsingDemo(false)
      try {
        const { data, error } = await supabase.rpc('get_cai_breakdown', { lng: lon, lat })
        if (error) throw error
        setCaiResult(data)
      } catch (err) {
        console.error('Gagal memanggil get_cai_breakdown:', err)
        setCaiResult({ ditemukan: false, pesan: 'Gagal memuat skor CAI.' })
      }
    } else {
      // Mode demo: pilih ragam breakdown menurut titik DEMO_CAI_POINTS terdekat
      // (jaraknya TIDAK lagi jadi gerbang apa pun — cuma untuk memvariasikan
      // tampilan antara kasus 2-kriteria dan 3-kriteria + volume).
      setCaiUsingDemo(true)
      let terdekat = null
      let jarakMin = Infinity
      for (const p of DEMO_CAI_POINTS) {
        const d = haversineMeters(p, { lat, lon })
        if (d < jarakMin) {
          jarakMin = d
          terdekat = p
        }
      }
      const pakaiVolume = (terdekat?.skor?.n_volume ?? 0) >= 0.5
      setCaiResult(pakaiVolume ? DEMO_CAI_BREAKDOWN_VOLUME : DEMO_CAI_BREAKDOWN)
    }
    setCaiLoading(false)
  }, [simulationActive, runSimulationAt, analyticOverlay])

  function handleToggleSimulation() {
    setSimulationActive((v) => !v)
    if (simulationActive) {
      // matikan mode -> bersihkan hasil supaya tidak membingungkan sesi berikutnya
      setSimResult(null)
      setClickMarker(null)
    } else {
      setCaiResult(null)
    }
  }

  const showPanel = activeTab !== 'peta'
  const activeLabel = TABS.find((t) => t.id === activeTab)?.label ?? 'GeoTransit Insight'

  // Marker visual untuk seluruh titik_kandidat (supaya user LIHAT titik di peta
  // dulu, bukan menebak lokasi lalu klik "buta"). Ke-19 marker ini tetap
  // menandai titik survei lapangan. Klik langsung pada marker memanggil
  // handleMapClick di koordinat titik itu sendiri — yang kini mengenai RPC
  // get_cai_breakdown pada sel grid 300 m yang memuat titik tsb (sel itu punya
  // volume terukur, jadi breakdown 3-4 kriteria).
  // Di-useMemo supaya identitas array marker STABIL antar-render (kalau tidak,
  // MapView membongkar-pasang seluruh marker + popup terbuka tiap kali App
  // re-render — mis. saat fetch data selesai / panel skor dibuka).
  const candidateMarkers = useMemo(
    () =>
      caiPoints.points.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        // SATU warna: skema 2-warna lama (final vs "skor survei N/A") jadi
        // usang setelah kriteria survei dinyatakan N/A untuk SEMUA titik
        // kandidat — warna "final" tidak pernah muncul dengan data riil.
        color: CANDIDATE_MARKER_COLOR,
        popupHtml: buildCandidatePopupHtml(p.titik),
        // Klik titik survei -> buka panel skor CAI (proyeksi halte baru di situ).
        onClick: () => handleMapClick({ lat: p.lat, lon: p.lon }),
      })),
    [caiPoints.points, handleMapClick],
  )

  // Marker halte tersurvei — ungu, klik menampilkan popup info (nama, kecamatan).
  const halteMarkers = useMemo(
    () =>
      haltePoints.points.map((h) => ({
        lat: h.lat,
        lon: h.lon,
        color: HALTE_TERSURVEI_MARKER_COLOR,
        icon: markerIconSvg('bus'),
        popupHtml: buildHaltePopupHtml(h),
      })),
    [haltePoints.points],
  )

  // Marker stasiun kereta eksisting (KRL + LRT) di Kota Bekasi — layer
  // referensi statis (stasiun_kota_bekasi.geojson, koordinat OSM). Display-only,
  // tidak menyentuh skoring. Klik -> popup nama + moda.
  const stationMarkers = useMemo(
    () =>
      (stasiunKotaBekasi.features || [])
        .map((f) => {
          const [lon, lat] = f.geometry?.coordinates || []
          if (lat == null || lon == null) return null
          const isLrt = f.properties?.moda === 'LRT'
          return {
            lat,
            lon,
            color: isLrt ? STASIUN_LRT_MARKER_COLOR : STASIUN_KRL_MARKER_COLOR,
            // Glyph beda per moda: trem (LRT) vs kereta (KRL) — pembeda BENTUK
            // di samping warna (colorblind-safe, CLAUDE.md Bab 10.3).
            icon: markerIconSvg(isLrt ? 'tram' : 'train'),
            popupHtml: buildStasiunPopupHtml(f.properties),
          }
        })
        .filter(Boolean),
    [],
  )

  // Marker usulan halte hasil model spasial — magenta, popup berisi proyeksi
  // penduduk terlayani (keluaran simulate_new_stop) + penegasan belum disurvei.
  // Disaring dulu ke ranking <= usulanModelRankLimit (kontrol bertingkat di
  // LayerControl, lihat catatan state di atas) — bukan selalu seluruh baris.
  const usulanModelMarkers = useMemo(
    () =>
      usulanModel
        .filter((u) => (u.ranking ?? Infinity) <= usulanModelRankLimit)
        .map((u) => ({
          lat: u.lat,
          lon: u.lon,
          color: USULAN_MODEL_MARKER_COLOR,
          // Pin + tepi PUTUS-PUTUS: usulan model, BELUM disurvei lapangan —
          // sengaja tampil "belum riil" vs badge solid halte tersurvei.
          icon: markerIconSvg('pin'),
          iconStyle: 'dashed',
          popupHtml: buildUsulanModelPopupHtml(u),
        })),
    [usulanModel, usulanModelRankLimit],
  )

  // Marker halte Transjakarta B21 (15 titik, konteks visual murni — lihat
  // catatan impor transjakartaB21 di atas). Ikon bus dipakai ulang dari
  // mapIcons.js (sama glyph dengan halte tersurvei), warna DIBEDAKAN
  // (TRANSJAKARTA_B21_COLOR) supaya tetap terbedakan dari ungu halte
  // tersurvei sekalipun bentuk ikonnya sama.
  const transjakartaB21StopMarkers = useMemo(
    () =>
      transjakartaB21Stops
        .map((f) => {
          const [lon, lat] = f.geometry?.coordinates || []
          if (lat == null || lon == null) return null
          return {
            lat,
            lon,
            color: TRANSJAKARTA_B21_COLOR,
            icon: markerIconSvg('bus'),
            popupHtml: buildTransjakartaB21StopPopupHtml(f.properties?.name),
          }
        })
        .filter(Boolean),
    [],
  )

  // clickMarker TIDAK digabung di sini — dikirim sebagai prop terpisah ke
  // MapView supaya perubahannya tiap klik tidak ikut membongkar marker persisten.
  // Grup marker disaring oleh panel Layer (layerVis). candidateMarkers (titik
  // survei, jangkar CAI) SELALU ikut — tidak ada di daftar toggle.
  const markers = useMemo(() => {
    const out = []
    if (layerVis.stasiun) out.push(...stationMarkers)
    if (layerVis.halte) out.push(...halteMarkers)
    if (layerVis.usulanModel) out.push(...usulanModelMarkers)
    if (layerVis.transjakartaB21) out.push(...transjakartaB21StopMarkers)
    out.push(...candidateMarkers)
    return out
  }, [
    stationMarkers,
    halteMarkers,
    usulanModelMarkers,
    transjakartaB21StopMarkers,
    candidateMarkers,
    layerVis.stasiun,
    layerVis.halte,
    layerVis.usulanModel,
    layerVis.transjakartaB21,
  ])

  // Layer garis rute transit eksisting — 2 layer terpisah dengan visual jelas
  // berbeda (lihat konstanta warna RUTE_BISKITA_COLOR/RUTE_KRL_COLOR di atas).
  // BisKita: solid tebal (line-width 5, tanpa dasharray) supaya jelas beda
  // bentuk juga dari KRL (dashed, lebih tipis) — bukan cuma beda warna.
  // popupHtml statis per layer (bukan per-fitur) — cukup untuk kasus "satu
  // layer = satu pesan disclaimer/status", lihat dukungan popupHtml generik
  // di MapView.jsx.
  const ruteLayers = [
    {
      id: 'rute-biskita-tersurvei',
      type: 'line',
      data: ruteTransit.biskitaGeoJSON,
      paint: { 'line-color': RUTE_BISKITA_COLOR, 'line-width': 5, 'line-opacity': 0.9 },
      popupHtml: ruteTransit.biskitaPopupHtml,
      visible: layerVis.koridorBiskita,
    },
    {
      id: 'rute-krl-eksisting',
      type: 'line',
      data: ruteTransit.krlLinesGeoJSON,
      paint: {
        'line-color': RUTE_KRL_COLOR,
        'line-width': 3,
        'line-opacity': 0.85,
        'line-dasharray': [2, 1.5],
      },
      popupHtml: ruteTransit.krlPopupHtml,
      visible: layerVis.krl,
    },
  ]

  // Layer batas area studi + rute transit, disusun sesuai urutan gambar
  // (elemen belakang array digambar di ATAS):
  //   1. koridor BisKita aproksimasi OSM — PALING BAWAH, supaya ruas
  //      biskita_survei (di ruteLayers) tergambar di atasnya
  //   2. rute transit eksisting tersurvei (ruteLayers)
  //   3. titik halte BisKita OSM (circle kecil) — di atas garis rute
  //   4. garis batas Kota Bekasi — TERAKHIR, selalu di atas layer lain
  // De-dup layer halte OSM terhadap halte tersurvei: 15 halte tersurvei
  // (halte_eksisting) adalah SUBSET dari ~32 titik OSM koridor yang sama, jadi
  // titik OSM yang berhimpit dengan halte tersurvei adalah halte yang SAMA —
  // menampilkannya lagi sebagai "belum disurvei" itu dobel + salah label.
  // Ambang 100 m: pada data saat ini 8 titik berhimpit < 20 m + "Revo Mall"
  // ~98 m (nama sama, jelas titik yang sama), lalu tidak ada lagi sampai
  // > 150 m — jadi 100 m memisahkan dup sejati dari halte berbeda dgn bersih.
  const biskitaHalteOsmFiltered = useMemo(() => {
    const surveyed = haltePoints.points.filter((h) => h.lat != null && h.lon != null)
    if (!surveyed.length) return biskitaHalteOsm
    const features = (biskitaHalteOsm.features || []).filter((f) => {
      const [lon, lat] = f.geometry?.coordinates || []
      if (lat == null || lon == null) return true
      return !surveyed.some((h) => haversineMeters({ lat, lon }, h) < 100)
    })
    return { ...biskitaHalteOsm, features }
  }, [haltePoints.points])

  // get_admin_geometry mengembalikan GEOMETRY TELANJANG (Polygon/MultiPolygon),
  // bukan Feature/FeatureCollection — source GeoJSON MapLibre butuh yang
  // terakhir, jadi dibungkus di sini. Cabang JSON.parse untuk jaga-jaga kalau
  // kolom json datang sebagai string; kalau bentuknya tidak dikenali, hasilnya
  // null (tidak ada layer sorotan) — bukan crash.
  const sorotWilayahGeoJSON = useMemo(() => {
    const mentah = sorotWilayah?.geojson
    if (!mentah) return null
    let geometry = mentah
    if (typeof mentah === 'string') {
      try {
        geometry = JSON.parse(mentah)
      } catch {
        return null
      }
    }
    if (!geometry?.type || !geometry?.coordinates) return null
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { nama: sorotWilayah.nama, level: sorotWilayah.level },
          geometry,
        },
      ],
    }
  }, [sorotWilayah])

  // Overlai analitik full-map dari grid 300 m (grid_analisis), dinyalakan dari
  // panel Layer. Data grid mentah di-cache di `gridChoro` (lazy fetch). Tidak
  // ada skor dihitung ulang di sini; hanya klasifikasi/visualisasi tampilan.
  //
  // Sejak 2026-09-12 KEDUANYA adalah fill poligon per-sel dengan warna
  // KONTINU (bukan lagi heatmap density-based untuk TDI, bukan lagi kelas
  // kuantil diskret untuk kepadatan) — root-cause dua masalah nyata yang
  // ditemukan & dikonfirmasi dengan data live grid_analisis:
  //   * 'tdi' dulu HEATMAP dari titik pusat sel: `heatmap-color` dikunci ke
  //     `heatmap-density` (jumlah kernel titik yang saling tumpuk di suatu
  //     piksel, dinormalisasi ke titik teramai di layar) — BUKAN skor_tdi sel
  //     itu sendiri. Klaster 226 sel bertetangga di Bekasi Utara/Medansatria
  //     (masing-masing cuma 0,60-0,89) tampak lebih menyala dari satu sel
  //     terisolasi 0,93+ (kandidat usulan_halte_model sengaja de-klaster
  //     >=800 m, tidak pernah dapat "bonus tetangga") — peta menyesatkan soal
  //     lokasi prioritas sesungguhnya. Fix: fill poligon, warna langsung dari
  //     skor_tdi sel (linearInterpolateFillColorExpr, lihat choropleth.js).
  //   * 'kepadatan' dulu kelas KUANTIL 5 warna: data live (2.607 sel, 0-14.891
  //     jiwa/km2) -> kelas teratas meliputi 1.751-14.891 (rentang 13.140!),
  //     jadi sel 4.257/km2 dan sel 14.891/km2 (maksimum kota) dicat sama gelap
  //     — beda 3,5x tak terbaca. Desil (10 kelas) dicoba & TIDAK memperbaiki
  //     (desil teratas masih 2.835-14.891; kelas bawah malah degenerate 0-0).
  //     Fix: skala kontinu akar-kuadrat (sqrtInterpolateFillColorExpr) —
  //     detail lengkap kenapa sqrt (bukan linear/log) ada di choropleth.js.
  const choroActive = analyticOverlay !== 'none'
  const choroDerived = useMemo(() => {
    if (!gridChoro?.length) return null
    if (analyticOverlay === 'tdi') {
      const fc = toPolygonFeatureCollection(gridChoro, (c) => c.tdi)
      return { kind: 'tdi', fc }
    }
    const values = gridChoro.map((c) => c.kepadatan)
    const range = computeMinMax(values)
    const fc = toPolygonFeatureCollection(gridChoro, (c) => c.kepadatan)
    return { kind: 'kepadatan', range, fc }
  }, [gridChoro, analyticOverlay])

  // Grup legenda untuk overlai aktif — keduanya sekarang bilah `gradient`
  // (bukan swatch kelas diskret) karena keduanya kontinu. Posisi stop warna
  // di CSS gradient (0/25/50/75/100%) 1:1 dengan stop di ekspresi fill-color
  // (linear untuk TDI, sqrt untuk kepadatan) — lihat gradientCssFromColors.
  const choroLegendGroup = useMemo(() => {
    if (!choroActive || !choroDerived) return null
    if (choroDerived.kind === 'tdi') {
      return {
        title: 'Overlai: Transit Desert Index',
        note:
          "Konsentrasi kebutuhan transit yang belum terlayani, per sel grid 300 m. Makin terang = skor TDI makin tinggi (wilayah makin 'transit desert'). Warna langsung dari skor_tdi sel itu sendiri (fill kontinu) — bukan lagi permukaan heatmap yang bisa menonjolkan klaster sel sedang dibanding satu sel skor tinggi yang terisolasi.",
        items: [
          {
            shape: 'gradient',
            gradient: gradientCssFromColors(VIRIDIS_COLORS),
            labelLeft: 'TDI rendah (0)',
            labelRight: 'TDI tinggi (1)',
          },
        ],
      }
    }
    const [min, max] = choroDerived.range
    return {
      title: 'Overlai: Kepadatan penduduk',
      note:
        'Jiwa per sel grid 300 m (dasymetric). Makin gelap makin padat. Skala akar kuadrat (bukan linear) — supaya variasi kepadatan di kelurahan biasa (bukan hanya titik terpadat) tetap terlihat.',
      items: [
        {
          shape: 'gradient',
          gradient: gradientCssFromColors(CHOROPLETH_COLORS),
          labelLeft: fmtBound(min),
          labelRight: fmtBound(max),
        },
      ],
    }
  }, [choroActive, choroDerived])

  // Layer titik/garis konteks. `visible` tiap layer disetel dari panel Layer
  // (layerVis) — MapView menerapkannya lewat setLayoutProperty('visibility').
  const mapLayers = [
    // Overlai analitik PALING AWAL (digambar paling BAWAH) supaya rute, marker,
    // dan batas tetap di atas. Tanpa popupHtml -> klik peta tembus ke
    // handleMapClick (RPC get_cai_breakdown) seperti biasa. Keduanya sekarang
    // `type: 'fill'` (bukan lagi heatmap untuk TDI) dengan id berbeda supaya
    // sinkronisasi layer MapView membongkar-pasang dengan bersih saat user
    // ganti jenis overlai.
    ...(choroActive && choroDerived
      ? choroDerived.kind === 'tdi'
        ? [
            {
              id: 'overlay-tdi-fill',
              type: 'fill',
              data: choroDerived.fc,
              paint: {
                // Kontinu, linear polos (skor_tdi sudah 0-1 dan cuma skew
                // ringan — lihat linearInterpolateFillColorExpr di
                // choropleth.js untuk alasan lengkap kenapa TDI tidak butuh
                // kompresi sqrt seperti kepadatan).
                'fill-color': linearInterpolateFillColorExpr(),
                'fill-opacity': 0.75,
                'fill-outline-color': 'rgba(255,255,255,0.35)',
              },
              visible: choroActive,
            },
          ]
        : [
            {
              id: 'overlay-kepadatan-fill',
              type: 'fill',
              data: choroDerived.fc,
              paint: {
                // Kontinu + kompresi akar kuadrat — lihat
                // sqrtInterpolateFillColorExpr di choropleth.js untuk data
                // & alasan lengkap kenapa bukan kelas diskret/linear/log.
                'fill-color': sqrtInterpolateFillColorExpr(
                  choroDerived.range[0],
                  choroDerived.range[1]
                ),
                'fill-opacity': 0.7,
                'fill-outline-color': 'rgba(255,255,255,0.4)',
              },
              visible: choroActive,
            },
          ]
      : []),
    {
      id: 'biskita-koridor-osm',
      type: 'line',
      data: biskitaKoridorOsm,
      paint: {
        'line-color': RUTE_BISKITA_OSM_COLOR,
        'line-width': 4.5,
        'line-opacity': 0.95,
        'line-dasharray': [2, 1.2],
      },
      popupHtml: BISKITA_KORIDOR_OSM_POPUP_HTML,
      visible: layerVis.koridorBiskita,
    },
    {
      // Jalur LRT Jabodebek — geometri rel ASLI dari OSM (bukan aproksimasi),
      // di-clip ke batas Kota Bekasi oleh etl/build_rute_lrt_osm.py. Solid
      // (bukan dashed seperti koridor BisKita OSM) justru untuk menandakan
      // geometrinya presisi, bukan perkiraan.
      id: 'rute-lrt-jabodebek',
      type: 'line',
      data: lrtJabodebekOsm,
      paint: { 'line-color': RUTE_LRT_COLOR, 'line-width': 3, 'line-opacity': 0.85 },
      popupHtml: LRT_POPUP_HTML,
      visible: layerVis.lrt,
    },
    {
      // Koridor Transjakarta B21 (Bekasi Timur -> Cawang) — layer konteks
      // visual murni (lihat catatan impor di atas), default OFF (layerVis
      // init). Dashed + merah: beda tegas dari SEMUA layer rute lain (BisKita
      // oranye, KRL/LRT biru/teal) supaya tidak pernah tertukar sekalipun
      // toggle bersamaan.
      id: 'rute-transjakarta-b21',
      type: 'line',
      data: transjakartaB21Line,
      paint: {
        'line-color': TRANSJAKARTA_B21_COLOR,
        'line-width': 4,
        'line-opacity': 0.9,
        'line-dasharray': [3, 1.5],
      },
      popupHtml: TRANSJAKARTA_B21_LINE_POPUP_HTML,
      visible: layerVis.transjakartaB21,
    },
    ...ruteLayers,
    {
      id: 'biskita-halte-osm',
      type: 'circle',
      data: biskitaHalteOsmFiltered,
      paint: {
        'circle-radius': 3.5,
        'circle-color': HALTE_BISKITA_OSM_COLOR,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.9,
      },
      popupHtml: BISKITA_HALTE_OSM_POPUP_HTML,
      visible: layerVis.koridorBiskita,
    },
    {
      id: 'batas-kota-bekasi',
      type: 'line',
      data: bekasiBoundary,
      paint: { 'line-color': BATAS_KOTA_COLOR, 'line-width': 2.5, 'line-dasharray': [3, 2] },
      visible: layerVis.batasKota,
    },
    // Sorotan wilayah terpilih dari pencarian / filter kecamatan (Analisis
    // Spasial) — DITARUH PALING AKHIR supaya digambar di atas semua layer
    // lain (elemen belakang array = paling atas), termasuk overlai analitik
    // (Kepadatan/TDI) yang bisa aktif bersamaan di tab Analisis Spasial.
    // Isian sengaja tipis (opacity 0,16): menegaskan BIDANG wilayahnya, bukan
    // mewarnai penuh; grid/marker/rute di bawahnya tetap terbaca.
    //
    // Perbaikan 2026-09-13 (Sam melaporkan garis nyaris tak terlihat di
    // peta): garis gold sebelumnya (line-width 3, tanpa halo) nyaris menyatu
    // dengan (a) jalan basemap yang kebetulan oranye/amber, dan (b) ujung
    // pucat/terang KEDUA palet choropleth kontinu (YlGnBu #ffffcc, Viridis
    // #fde725 — lib/choropleth.js). Solusi: layer 'sorot-wilayah-garis-halo'
    // digambar LEBIH DULU (lebar 6,5, warna gelap SOROT_WILAYAH_HALO_COLOR)
    // sebagai casing kontras, lalu 'sorot-wilayah-garis' (gold, lebar 3,2)
    // di atasnya sebagai core — pola casing gelap + core terang ini terbaca
    // di ATAS/BAWAH kedua ujung kedua palet sekaligus (beda dari halo putih
    // konvensional yang akan hilang di sel YlGnBu paling pucat). Ini murni
    // pembeda VISUAL (bentuk garis dobel + kontras luminansi), bukan
    // bergantung pada satu hue tunggal — konsisten dengan syarat
    // colorblind-safe CLAUDE.md Bab 10.3.
    ...(sorotWilayahGeoJSON
      ? [
          {
            id: 'sorot-wilayah-fill',
            type: 'fill',
            data: sorotWilayahGeoJSON,
            paint: { 'fill-color': SOROT_WILAYAH_COLOR, 'fill-opacity': 0.16 },
          },
          {
            id: 'sorot-wilayah-garis-halo',
            type: 'line',
            data: sorotWilayahGeoJSON,
            paint: {
              'line-color': SOROT_WILAYAH_HALO_COLOR,
              'line-width': 6.5,
              'line-opacity': 0.85,
            },
          },
          {
            id: 'sorot-wilayah-garis',
            type: 'line',
            data: sorotWilayahGeoJSON,
            paint: {
              'line-color': SOROT_WILAYAH_COLOR,
              'line-width': 3.2,
              'line-opacity': 1,
            },
          },
        ]
      : []),
  ]

  // Auth gate: kalau login wall dinyalakan (AUTH_REQUIRED) DAN Supabase
  // dikonfigurasi TAPI belum ada session, tampilkan HANYA halaman Login
  // (bukan seluruh app). Loading singkat saat getSession() masih berjalan
  // supaya tidak "flash" ke LoginPage lalu langsung ke app. Dengan
  // AUTH_REQUIRED false (default submission) ATAU mode demo (!isConfigured),
  // kedua cabang di bawah dilewati sepenuhnya → app langsung render.
  if (AUTH_REQUIRED && isConfigured && authLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50 text-sm text-slate-400">
        Memuat sesi…
      </div>
    )
  }
  if (AUTH_REQUIRED && isConfigured && !session) {
    return <LoginPage />
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-50">
      {/* Header — branding + poles (PRD Gambar 6). Kolom pencarian fungsional
          (SearchBar); Bell/Help masih dekoratif. */}
      <header className="flex items-center gap-3 px-4 py-2.5 bg-brand-blue text-white shrink-0">
        {/* Logo hanya di header saat sidebar disembunyikan (viewport sempit) —
            di desktop logo ada di sidebar, hindari dobel. */}
        <img
          src="/Logo.png"
          alt="Logo MASSTRANSIT BASED GEOINSIGHT"
          className="w-9 h-9 rounded-full bg-white/10 shrink-0 md:hidden"
        />
        <div className="min-w-0">
          <h1 className="font-semibold leading-tight truncate">{activeLabel}</h1>
          <p className="text-xs text-white/70 leading-tight">GeoTransit Insight — Kota Bekasi</p>
        </div>

        {/* Kolom pencarian — cari fitur peta (halte, titik survei, usulan model,
            stasiun, koridor) yang sudah dimuat + wilayah administratif via RPC
            search_admin_bounds. Memilih hasil Wilayah juga menyorot batas
            administrasinya di peta (get_admin_geometry, lihat sorotWilayah).
            Desktop-only (hidden sm:block) seperti sebelumnya. */}
        <SearchBar
          className="relative hidden sm:block flex-1 max-w-sm ml-2"
          mapInstance={mapInstance}
          onResultSelected={() => setActiveTab('peta')}
          onWilayahSelected={setSorotWilayah}
          halte={haltePoints.points}
          titikKandidat={caiPoints.points}
          usulanModel={usulanModel}
          ruteTransit={ruteTransit}
        />

        <div className="ml-auto flex items-center gap-1.5">
          {!isConfigured && (
            <span
              title="Supabase belum tersambung — menampilkan data contoh"
              className="hidden lg:inline text-[11px] bg-amber-400/20 text-amber-100 border border-amber-300/40 rounded-full px-2.5 py-1"
            >
              Mode demo
            </span>
          )}
          {/* Dekoratif — title saja, tanpa dropdown */}
          <button type="button" title="Notifikasi" className="p-2 rounded-full hover:bg-white/10 transition">
            <Bell size={16} />
          </button>
          <button type="button" title="Bantuan" className="p-2 rounded-full hover:bg-white/10 transition">
            <HelpCircle size={16} />
          </button>

          {isConfigured && session ? (
            <div className="flex items-center gap-2 pl-1.5">
              <span className="hidden sm:inline text-xs text-white/70 truncate max-w-[140px]" title={session.user?.email}>
                {session.user?.email}
              </span>
              <button
                onClick={() => supabase.auth.signOut()}
                title="Logout"
                className="flex items-center gap-1 text-xs bg-white/10 hover:bg-white/20 border border-white/20 rounded-full px-3 py-1 transition"
              >
                <LogOut size={12} />
                Logout
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 pl-1.5" title="Dishub Kota Bekasi">
              <span className="w-7 h-7 rounded-full bg-white/15 flex items-center justify-center text-[11px] font-semibold">
                DB
              </span>
              <span className="hidden sm:inline text-xs text-white/80">Dishub Kota Bekasi</span>
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar nav — 8 menu sesuai wireframe PRD (Gambar 6). Lebar penuh
            dengan ikon + label di desktop; rail ikon-saja di bawahnya sebagai
            fallback viewport sempit. */}
        <nav className="hidden md:flex w-60 shrink-0 bg-white border-r border-slate-200 flex-col">
          <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-200">
            <img
              src="/Logo.png"
              alt="Logo MASSTRANSIT BASED GEOINSIGHT"
              className="w-11 h-11 rounded-full shrink-0"
            />
            <div className="min-w-0">
              <p className="font-bold text-slate-800 leading-tight">GeoTransit Insight</p>
              <p className="text-[10px] text-slate-400 leading-tight">
                Spatial Decision Support System berbasis AI
              </p>
              <p className="text-[10px] text-slate-400 leading-tight">Kota Bekasi</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={
                  'w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ' +
                  (activeTab === id
                    ? 'bg-brand-blue/10 text-brand-blue font-medium'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700')
                }
              >
                <Icon size={18} className="shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>

          <div className="border-t border-slate-200 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
              Tentang Sistem
            </p>
            <p className="text-[10px] text-slate-400 leading-snug">
              SDSS WebGIS untuk membantu Dishub &amp; Bappeda Kota Bekasi menentukan lokasi
              prioritas infrastruktur transit massal berbasis data.
            </p>
            <p className="text-[10px] text-slate-300 mt-2">Versi 1.0.0</p>
          </div>
        </nav>

        {/* Fallback rail ikon-saja untuk layar sempit (< md) */}
        <nav className="flex md:hidden w-14 shrink-0 bg-white border-r border-slate-200 flex-col items-center py-3 gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              title={label}
              className={
                'w-11 h-11 rounded-lg flex items-center justify-center transition ' +
                (activeTab === id
                  ? 'bg-brand-blue/10 text-brand-blue'
                  : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600')
              }
            >
              <Icon size={18} />
            </button>
          ))}
        </nav>

        {/* Map */}
        <main className="flex-1 relative">
          <MapView
            simulationMode={simulationActive}
            onMapClick={handleMapClick}
            onMapReady={setMapInstance}
            markers={markers}
            clickMarker={clickMarker}
            layers={mapLayers}
          >
            {/* Varian 'floating' (default) HANYA di luar tab Analisis Spasial
                sejak 2026-09-13 (permintaan Sam) -- tab itu sekarang merender
                CaiScorePanel/TdiScorePanel-nya SENDIRI dg variant="inline" di
                panel kanan (lihat AnalisisSpasial.jsx), supaya rincian klik
                tampil di bawah toggle overlai, bukan menutupi peta dg kotak
                melayang. State caiResult/tdiResult tetap satu-satunya sumber
                (di-lift ke sini), cuma tempat rendering-nya yang berbeda per
                tab -- tidak ada duplikasi RPC/klik. */}
            {activeTab !== 'analisis' && (
              <CaiScorePanel
                loading={caiLoading}
                result={caiResult}
                usingDemo={caiUsingDemo}
                onClose={() => {
                  setCaiResult(null)
                  setClickMarker(null)
                }}
              />
            )}
            {activeTab !== 'analisis' && (
              <TdiScorePanel
                loading={tdiLoading}
                result={tdiResult}
                usingDemo={tdiUsingDemo}
                onClose={() => {
                  setTdiResult(null)
                  setClickMarker(null)
                }}
              />
            )}
            {activeTab === 'peta' && (
              <MapLegend
                groups={[
                  // Grup "Pilihan aktif" hanya muncul saat ada wilayah terpilih
                  // dari pencarian — legenda permanen untuk sesuatu yang biasanya
                  // tidak ada di peta justru membingungkan. Menyebut nama
                  // wilayahnya supaya jelas ini status sementara.
                  ...(sorotWilayah
                    ? [{
                        title: 'Pilihan aktif',
                        items: [{
                          color: SOROT_WILAYAH_COLOR,
                          shape: 'line',
                          lineStyle: 'solid',
                          label: `Wilayah terpilih: ${sorotWilayah.nama}`,
                        }],
                      }]
                    : []),
                  // Grup overlai analitik — hanya saat overlai aktif. Keduanya
                  // kontinu sekarang: bilah gradien YlGnBu (kepadatan, skala
                  // akar kuadrat) atau Viridis (TDI, skala linear). note = cara
                  // baca + (kepadatan) disclosure skala sqrt. Colorblind-safe
                  // (CLAUDE.md Bab 10.3).
                  ...(choroLegendGroup ? [choroLegendGroup] : []),
                  {
                    title: 'Wilayah & area studi',
                    items: [
                      { color: BATAS_KOTA_COLOR, shape: 'line', lineStyle: 'dashed', label: 'Batas Kota Bekasi (area studi)' },
                    ],
                  },
                  {
                    title: 'Transit tersurvei tim',
                    items: [
                      { color: HALTE_TERSURVEI_MARKER_COLOR, icon: legendIconSvg('bus'), label: 'Halte tersurvei' },
                      { color: RUTE_BISKITA_COLOR, shape: 'line', lineStyle: 'solid', label: 'Koridor BisKita (tersurvei)' },
                    ],
                  },
                  {
                    title: 'Infrastruktur eksisting — belum disurvei',
                    items: [
                      { color: RUTE_BISKITA_OSM_COLOR, shape: 'line', lineStyle: 'dashed', label: 'Koridor BisKita Trans Patriot (OSM)' },
                      { color: HALTE_BISKITA_OSM_COLOR, shape: 'dot', label: 'Halte BisKita (OSM)' },
                      { color: RUTE_KRL_COLOR, shape: 'line', lineStyle: 'dashed', label: 'Jaringan KRL' },
                      { color: STASIUN_KRL_MARKER_COLOR, icon: legendIconSvg('train'), label: 'Stasiun KRL' },
                      { color: RUTE_LRT_COLOR, shape: 'line', lineStyle: 'solid', label: 'Jalur LRT Jabodebek (geometri OSM)' },
                      { color: STASIUN_LRT_MARKER_COLOR, icon: legendIconSvg('tram'), label: 'Stasiun LRT Jabodebek' },
                    ],
                  },
                  // Grup Transjakarta B21 — hanya muncul saat layer ditoggle ON
                  // (default OFF, lihat layerVis init). Layer konteks visual
                  // murni, sama kategori dengan grup "Infrastruktur eksisting" di
                  // atas, tapi ditaruh sebagai grup terpisah + kondisional supaya
                  // legenda tidak menyebut layer yang sedang tidak tampil di peta.
                  ...(layerVis.transjakartaB21
                    ? [{
                        title: 'Transjakarta B21 (Bekasi–Cawang)',
                        note: 'Relasi rute OSM (ref=B21) — konteks visual, bukan data resmi dipakai skor apa pun. ±72% rute dalam Kota Bekasi, sisanya menuju Cawang, DKI Jakarta.',
                        items: [
                          { color: TRANSJAKARTA_B21_COLOR, shape: 'line', lineStyle: 'dashed', label: 'Koridor Transjakarta B21' },
                          { color: TRANSJAKARTA_B21_COLOR, icon: legendIconSvg('bus'), label: 'Halte Transjakarta B21 (15 titik)' },
                        ],
                      }]
                    : []),
                  {
                    title: 'Titik analisis',
                    items: [
                      { color: CANDIDATE_MARKER_COLOR, shape: 'dot', label: 'Titik survei lapangan (Traffic Counting)' },
                      // Item usulan model HANYA ikut saat layer-nya ON — legenda
                      // tidak boleh menyebut layer yang sedang tidak tampil.
                      // Label memuat jumlah yang benar-benar tampil (hasil
                      // filter usulanModelRankLimit di LayerControl), bukan
                      // total baris tabel.
                      ...(layerVis.usulanModel
                        ? [{
                            color: USULAN_MODEL_MARKER_COLOR,
                            icon: legendIconSvg('pin'),
                            label: `Usulan halte dari model spasial, belum disurvei (${usulanModelMarkers.length} dari ${usulanModel.length} ditampilkan)`,
                          }]
                        : []),
                    ],
                  },
                ]}
              />
            )}
            {activeTab === 'peta' && (
              <LayerControl
                value={layerVis}
                onChange={setLayerVis}
                analyticOverlay={analyticOverlay}
                onAnalyticOverlayChange={setAnalyticOverlay}
                overlayLoading={gridChoroLoading}
                usulanModelRankLimit={usulanModelRankLimit}
                onUsulanModelRankLimitChange={setUsulanModelRankLimit}
                usulanModelTotal={usulanModel.length}
              />
            )}
          </MapView>
        </main>

        {/* Right panel */}
        {showPanel && (
          <aside className="w-96 shrink-0 bg-white border-l border-slate-200 overflow-hidden">
            {activeTab === 'dashboard' && <Dashboard />}
            {activeTab === 'analisis' && (
              <AnalisisSpasial
                mapInstance={mapInstance}
                analyticOverlay={analyticOverlay}
                onAnalyticOverlayChange={setAnalyticOverlay}
                overlayLoading={gridChoroLoading}
                legendGroup={choroLegendGroup}
                sorotWilayah={sorotWilayah}
                onWilayahSelected={setSorotWilayah}
                layerVis={layerVis}
                onLayerVisChange={setLayerVis}
                caiLoading={caiLoading}
                caiResult={caiResult}
                caiUsingDemo={caiUsingDemo}
                onCaiClose={() => {
                  setCaiResult(null)
                  setClickMarker(null)
                }}
                tdiLoading={tdiLoading}
                tdiResult={tdiResult}
                tdiUsingDemo={tdiUsingDemo}
                onTdiClose={() => {
                  setTdiResult(null)
                  setClickMarker(null)
                }}
              />
            )}
            {activeTab === 'ai' && (
              <AIPanel
                latestSimulasi={lastSimResult}
                mapInstance={mapInstance}
                onWilayahSelected={setSorotWilayah}
              />
            )}
            {activeTab === 'simulasi' && (
              <SimulationPanel
                active={simulationActive}
                onToggle={handleToggleSimulation}
                loading={simLoading}
                result={simResult}
                onRunPreset={runSimulationAt}
              />
            )}
            {activeTab === 'rekomendasi' && <EquityIndexView />}
            {activeTab === 'data-laporan' && <DataLaporan mapInstance={mapInstance} />}
            {activeTab === 'pengaturan' && (
              <Pengaturan session={session} onLoggedOut={() => setActiveTab('peta')} />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
