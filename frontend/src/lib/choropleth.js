// choropleth.js — mesin choropleth bersama untuk layer grid_analisis
// (Analisis Spasial + overlai analitik di Peta Interaktif).
//
// Palet: sequential colorblind-safe — ColorBrewer YlGnBu 5 warna (kuning muda
// -> biru tua) untuk kepadatan, Viridis 5 warna untuk TDI. Menggantikan skema
// lama hijau->merah diverging yang dilarang PRD Bab 10.3 / temuan Coaching
// Clinic 4: skema merah-oranye-hijau tidak terbaca bagi ~8% pria dengan color
// vision deficiency.
//
// Dua gaya rendering hidup berdampingan di sini:
//  - DISKRET (classBreaks/quantileBreaks + stepFillColorExpr + legendClassRows):
//    dulu dipakai AnalisisSpasial.jsx sebelum tab itu punya <MapView> sendiri.
//    Sejak konsolidasi peta 2026-09-12 (AnalisisSpasial.jsx jadi panel kontrol
//    murni atas peta utama, lihat komentar di file itu), TIDAK ADA pemanggil
//    aktif untuk gaya ini di frontend — tetap diekspor (tidak dihapus) untuk
//    jaga-jaga kalau dibutuhkan lagi di masa depan.
//  - KONTINU (linearInterpolateFillColorExpr / sqrtInterpolateFillColorExpr +
//    gradientCssFromColors): dipakai overlai analitik peta utama (App.jsx,
//    state `analyticOverlay`, dibagi oleh tab "Peta Interaktif" & "Analisis
//    Spasial") sejak 2026-09-12, menggantikan heatmap density-based (TDI) dan
//    kelas kuantil (kepadatan) yang keduanya terbukti menyesatkan pada data
//    nyata — lihat komentar di tiap fungsi kontinu untuk detail & angka.
//
// Ini murni format/normalisasi tampilan; TIDAK menghitung ulang CAI/TDI/Equity
// Index (angka datang apa adanya dari grid_analisis yang dihitung data-ai-analyst).

import { ringAveragePoint } from './geo'

export const CHOROPLETH_COLORS = ['#ffffcc', '#a1dab4', '#41b6c4', '#2c7fb8', '#253494']
export const CLASS_COUNT = CHOROPLETH_COLORS.length

/** Palet Viridis 5-stop dipakai overlai TDI (sequential, colorblind-safe). */
export const VIRIDIS_COLORS = ['#440154', '#3b528b', '#21908d', '#5dc963', '#fde725']

/**
 * Ambang kelas equal-interval pada rentang [min, max] -> (n-1) nilai batas,
 * strictly ascending (computeMinMax menjamin max > min).
 */
export function classBreaks([min, max], n) {
  const span = (max - min) / n
  return Array.from({ length: n - 1 }, (_, i) => min + span * (i + 1))
}

/**
 * Ambang kelas KUANTIL pada rentang nilai -> (n-1) nilai batas: tiap kelas
 * memuat kira-kira jumlah sel yang sama. Dipakai overlai "Kepadatan penduduk"
 * di Peta Interaktif supaya variasi kepadatan terbaca (equal-interval linear
 * menumpuk mayoritas sel di kelas terendah -> peta nyaris polos).
 * classBreaks (equal-interval) SENGAJA tidak diubah — tidak ada pemanggil aktif
 * per 2026-09-12 (lihat catatan konsolidasi peta di kepala file), tapi
 * dipertahankan apa adanya. Hasil dijamin strictly ascending (nilai duplikat
 * didorong tipis) supaya ekspresi 'step' MapLibre tidak menolak.
 */
export function quantileBreaks(values, n) {
  const nums = values
    .filter((v) => typeof v === 'number' && !Number.isNaN(v))
    .sort((a, b) => a - b)
  if (nums.length < 2) return classBreaks(computeMinMax(values), n)
  const breaks = []
  for (let i = 1; i < n; i++) {
    const pos = (i / n) * (nums.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    breaks.push(nums[lo] + (nums[hi] - nums[lo]) * (pos - lo))
  }
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1e-6
  }
  return breaks
}

/**
 * Format batas kelas untuk legenda: angka besar (kepadatan) dibulatkan +
 * pemisah ribuan, angka kecil (skor 0-1) dua desimal.
 */
export function fmtBound(v) {
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString('id-ID') : v.toFixed(2)
}

/** [min, max] dari kumpulan nilai numerik; fallback [0, 1] kalau kosong. */
export function computeMinMax(values) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v))
  if (!nums.length) return [0, 1]
  let min = Math.min(...nums)
  let max = Math.max(...nums)
  if (min === max) max = min + 1
  return [min, max]
}

/**
 * FeatureCollection Polygon dari daftar sel { ring, ... }; tiap fitur mendapat
 * properti `value` hasil valueFn(cell) (0 kalau null/undefined).
 */
export function toPolygonFeatureCollection(cells, valueFn) {
  return {
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [c.ring] },
      properties: { value: valueFn(c) ?? 0 },
    })),
  }
}

/**
 * FeatureCollection Point dari daftar sel { ring, ... } — 1 titik pusat per sel
 * (rata-rata vertex ring, ringAveragePoint) dengan properti `skor_tdi` diambil
 * dari cell[valueKey]. Dipakai untuk layer heatmap TDI (permukaan interpolasi
 * dari titik, bukan poligon batas sel).
 */
export function toCentroidPointFC(cells, valueKey) {
  return {
    type: 'FeatureCollection',
    features: cells
      .map((c) => {
        const p = ringAveragePoint(c.ring)
        if (!p) return null
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { skor_tdi: Number(c[valueKey]) || 0 },
        }
      })
      .filter(Boolean),
  }
}

/**
 * Ekspresi 'step' MapLibre untuk fill-color diskret dari daftar ambang kelas
 * (hasil classBreaks / quantileBreaks) + CHOROPLETH_COLORS.
 *
 * Tidak ada pemanggil aktif per 2026-09-12 (dulu dipakai AnalisisSpasial.jsx
 * saat tab itu masih punya <MapView> sendiri dengan choropleth kelas diskret —
 * lihat catatan konsolidasi peta di kepala file) — JANGAN dihapus/diubah
 * perilakunya, tetap diekspor untuk jaga-jaga. Overlai "kepadatan" di peta
 * utama sejak 2026-09-12 pindah ke kontinu (lihat sqrtInterpolateFillColorExpr
 * / linearInterpolateFillColorExpr di bawah).
 */
export function stepFillColorExpr(breaks) {
  const expr = ['step', ['get', 'value'], CHOROPLETH_COLORS[0]]
  breaks.forEach((b, i) => expr.push(b, CHOROPLETH_COLORS[i + 1]))
  return expr
}

/**
 * Ekspresi 'interpolate' MapLibre, KONTINU (bukan kelas/bucket), untuk
 * fill-color langsung dari nilai mentah (['get', 'value']) — dipakai overlai
 * "Transit Desert Index" di Peta Interaktif sejak 2026-09-12.
 *
 * KENAPA KONTINU (bukan heatmap point-density, bukan step/quantile klas):
 * layer heatmap sebelumnya (`type: 'heatmap'`, `heatmap-color` dikunci ke
 * `['heatmap-density']`) mewarnai berdasar JUMLAH kernel titik yang saling
 * tumpang-tindih di sekitar suatu piksel layar, dinormalisasi ke titik paling
 * "ramai" di layar — BUKAN skor_tdi milik sel itu sendiri. Contoh nyata: satu
 * klaster 226 sel bertetangga di Bekasi Utara/Medansatria yang masing-masing
 * cuma bernilai 0,60-0,89 akan tampak menyala LEBIH terang daripada satu sel
 * terisolasi bernilai 0,93+ (kandidat `usulan_halte_model` sengaja
 * di-de-klaster jarak >=800 m, jadi tidak pernah dapat "bonus" dari tetangga)
 * — peta jadi menyesatkan soal di mana prioritas sesungguhnya. Fill poligon
 * per-sel dengan warna dikunci langsung ke skor_tdi sel itu sendiri
 * menghilangkan distorsi ini sepenuhnya.
 *
 * KENAPA LINEAR POLOS (bukan sqrt seperti kepadatan): skor_tdi sudah
 * dinormalisasi 0-1 dan HANYA skew ringan (rata-rata 0,4881, median 0,6488
 * pada recompute terakhir) — beda jauh dari kepadatan mentah yang skew berat
 * (median jauh di bawah rata-rata, ekor panjang ke nilai ekstrem). Kompresi
 * sqrt di sini tidak perlu dan malah menggeser bacaan skala yang sudah wajar.
 *
 * 5 titik warna Viridis di bawah PERSIS sama dengan yang sebelumnya dipakai
 * di `heatmap-color` (0/0,25/0,5/0,75/1 -> #440154/#3b528b/#21908d/#5dc963/
 * #fde725) — hanya wadahnya yang berubah dari density-heatmap ke fill
 * poligon per-sel, palet & pembagian stop tidak berubah.
 */
export function linearInterpolateFillColorExpr(colors = VIRIDIS_COLORS) {
  return [
    'interpolate', ['linear'], ['get', 'value'],
    0, colors[0],
    0.25, colors[1],
    0.5, colors[2],
    0.75, colors[3],
    1, colors[4],
  ]
}

/**
 * Ekspresi 'interpolate' MapLibre, KONTINU + KOMPRESI AKAR KUADRAT, untuk
 * fill-color dari nilai mentah (['get', 'value']) pada rentang [min, max] —
 * dipakai overlai "Kepadatan penduduk" di Peta Interaktif sejak 2026-09-12,
 * menggantikan kelas kuantil diskret (quantileBreaks + stepFillColorExpr).
 *
 * KENAPA BUKAN KELAS DISKRET (quantile) LAGI: data nyata `grid_analisis`
 * (2.607 sel, kepadatan_penduduk 0-14.891 jiwa/km2) — ambang kuantil 5-kelas
 * adalah [0, 108, 690, 1751], artinya kelas teratas MELIPUTI 1.751 s.d.
 * 14.891 (rentang 13.140!): sel 4.257/km2 (klaster utara Bekasi) dan sel
 * 14.891/km2 (maksimum kota, lokasi kandidat `usulan_halte_model` teratas)
 * dicat warna gelap yang PERSIS SAMA — beda 3,5x tidak terbaca di peta. Sudah
 * dicoba juga desil (10 kelas): desil teratas masih 2.835-14.891 (rentang
 * 12.056, nyaris tidak menyempit), dan kelas 1-3 malah DEGENERATE (0-0,
 * tiga warna terbuang untuk nilai nol yang sama karena banyak sel kepadatan
 * persis nol). Menambah jumlah bucket tidak menyelesaikan masalah distribusi
 * yang skew berat — diskretisasi itu sendiri yang salah alat di sini.
 *
 * KENAPA AKAR KUADRAT (bukan linear polos, bukan log): skala LINEAR polos
 * pada rentang 0-14.891 akan menjejalkan ~80% sel (yang mayoritas berkerapatan
 * rendah/nol) ke ~12% bawah rentang warna -> variasi kepadatan di kelurahan
 * biasa jadi tidak terbaca, nyaris satu warna pucat rata (dikonfirmasi: 80%
 * sel akan tampak kuning pucat nyaris seragam di bawah linear). Skala LOG
 * di sisi lain OVER-compress: sel 100/km2 saja sudah duduk di ~48% skala,
 * melebih-lebihkan wilayah yang sebetulnya nyaris kosong. Akar kuadrat berada
 * di tengah: menekan ekor ekstrem (14.891) secukupnya supaya sel-sel biasa
 * tetap tersebar terbaca di seluruh rentang warna, tanpa melebih-lebihkan
 * nilai kecil seperti log.
 *
 * Implementasi: 5 titik warna YlGnBu (CHOROPLETH_COLORS, sama seperti kelas
 * diskret lama) ditempatkan pada 0%/25%/50%/75%/100% dari rentang NILAI
 * MENTAH [min, max] — tapi posisi sumbu interpolasinya adalah sqrt(nilai),
 * bukan nilai itu sendiri. MapLibre mendukung ['sqrt', expr] langsung di
 * ekspresi style, jadi tidak perlu transformasi JS terpisah sebelum di-render.
 */
export function sqrtInterpolateFillColorExpr(min, max, colors = CHOROPLETH_COLORS) {
  const lo = Math.max(0, min)
  const hi = Math.max(lo + 1e-6, max)
  const span = hi - lo
  return [
    'interpolate', ['linear'], ['sqrt', ['get', 'value']],
    Math.sqrt(lo), colors[0],
    Math.sqrt(lo + span * 0.25), colors[1],
    Math.sqrt(lo + span * 0.5), colors[2],
    Math.sqrt(lo + span * 0.75), colors[3],
    Math.sqrt(hi), colors[4],
  ]
}

/**
 * Grup legenda bilah-gradien generik (`shape: 'gradient'` di MapLegend) untuk
 * layer kontinu — 5 stop warna diformat jadi CSS `linear-gradient` di posisi
 * 0/25/50/75/100%, PERSIS sama dengan posisi stop di ekspresi fill-color
 * (linear atau sqrt) di atas, jadi bilah legenda dan peta selalu 1:1 tanpa
 * perhitungan tambahan. `note` opsional dipakai untuk pengungkapan metodologi
 * (mis. disclosure kompresi akar kuadrat pada kepadatan).
 */
export function gradientCssFromColors(colors) {
  return `linear-gradient(90deg, ${colors.join(', ')})`
}

/**
 * Daftar { color, label } untuk legenda kelas diskret — label = rentang angka
 * "a – b" per kelas. Penomoran kelas ditambahkan oleh pemanggil.
 */
export function legendClassRows(range, breaks) {
  const bounds = [range[0], ...breaks, range[1]]
  return CHOROPLETH_COLORS.map((color, i) => ({
    color,
    label: `${fmtBound(bounds[i])} – ${fmtBound(bounds[i + 1])}`,
  }))
}
