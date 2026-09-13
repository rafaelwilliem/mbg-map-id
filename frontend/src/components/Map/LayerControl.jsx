import { useState } from 'react'
import { ChevronDown, ChevronUp, Layers } from 'lucide-react'

/**
 * LayerControl — panel pengatur layer untuk tab "Peta Interaktif".
 * Overlay di pojok KIRI-ATAS (MapLegend memakai pojok kanan-bawah,
 * CaiScorePanel kiri-bawah — sengaja berseberangan supaya tidak tumpang tindih).
 *
 * Bisa diciutkan: bilah header "Layer" selalu tampil + jadi tombol buka/tutup.
 * Default = TERBUKA saat load. State ciut/kembang lokal saja, tidak dipersisten.
 *
 * Dua bagian:
 *  - Overlai analitik (radio, default "Tidak ada"): fill choropleth KONTINU
 *    (bukan kelas/bucket diskret) grid 300 m — kepadatan penduduk (skala akar
 *    kuadrat, YlGnBu) atau Transit Desert Index (skala linear, Viridis).
 *    Hanya SATU aktif sekaligus. Sejak 2026-09-12 keduanya fill poligon
 *    per-sel warna kontinu; TDI sebelumnya heatmap density-based (diganti
 *    karena density titik menyesatkan — lihat komentar choroDerived di
 *    App.jsx untuk detail), kepadatan sebelumnya kelas kuantil diskret
 *    (diganti karena kelas teratas terlalu lebar untuk data skew berat).
 *  - Titik & jaringan (checkbox, semua default ON): visibilitas marker/garis
 *    layer konteks.
 *
 * Props:
 *  - value: objek visibilitas layer titik/garis (state di App.jsx), key =
 *    usulanModel, halte, stasiun, koridorBiskita, krl, lrt, transjakartaB21,
 *    batasKota.
 *  - onChange: (nextValue) => void — dipanggil dengan objek `value` baru.
 *  - analyticOverlay: 'none' | 'kepadatan' | 'tdi' (state di App.jsx).
 *  - onAnalyticOverlayChange: (key) => void.
 *  - overlayLoading: boolean opsional — grid_analisis untuk overlai sedang
 *    di-fetch (lazy, sekali). Sekadar info, tidak memblok interaksi.
 *  - usulanModelRankLimit: number (1-100) — ambang `ranking <= N` untuk
 *    layer "Usulan halte model" (state di App.jsx, default 25 = Level 1).
 *    Filter tunggal di atas field `usulan_halte_model.ranking`; 3 preset
 *    (Level 1/2/3 = 25/50/100) cuma mengeset slider ini, bukan data terpisah.
 *  - onUsulanModelRankLimitChange: (n) => void.
 *  - usulanModelTotal: number opsional — total baris usulan_halte_model yang
 *    sudah dimuat (untuk teks "Menampilkan N dari TOTAL"). Default 100.
 *
 * TODO(ui-ux-designer): radio/checkbox masih kontrol native polos, belum
 * disesuaikan sistem desain final (toggle switch / ikon per layer, dst).
 */

const OVERLAY_OPTIONS = [
  { key: 'none', label: 'Tidak ada' },
  { key: 'kepadatan', label: 'Kepadatan penduduk' },
  { key: 'tdi', label: 'Transit Desert Index' },
]

const POINT_LINE_OPTIONS = [
  { key: 'usulanModel', label: 'Usulan halte model' },
  { key: 'halte', label: 'Halte tersurvei' },
  { key: 'stasiun', label: 'Stasiun (KRL & LRT)' },
  { key: 'koridorBiskita', label: 'Koridor BisKita' },
  { key: 'krl', label: 'Jaringan KRL' },
  { key: 'lrt', label: 'Jalur LRT' },
  { key: 'transjakartaB21', label: 'Transjakarta B21 (Bekasi–Cawang)' },
  { key: 'batasKota', label: 'Batas Kota' },
]

// Preset tingkat prioritas untuk slider "Usulan halte model" — cuma
// menetapkan nilai slider, bukan sumber data terpisah (lihat filter
// `ranking <= usulanModelRankLimit` di App.jsx).
const USULAN_MODEL_PRESETS = [
  { level: 1, value: 25, label: 'Level 1 (25)' },
  { level: 2, value: 50, label: 'Level 2 (50)' },
  { level: 3, value: 100, label: 'Level 3 (100)' },
]

export default function LayerControl({
  value,
  onChange,
  analyticOverlay = 'none',
  onAnalyticOverlayChange,
  overlayLoading = false,
  usulanModelRankLimit = 25,
  onUsulanModelRankLimitChange,
  usulanModelTotal = 100,
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="absolute top-3 left-3 z-10 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white/95 text-xs text-slate-600 shadow-lg backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="layer-control-body"
        className="flex w-full items-center gap-2 px-3 py-2 font-semibold text-slate-700 hover:text-slate-900"
      >
        <Layers size={14} className="shrink-0 text-brand-blue" />
        <span className="flex-1 text-left">Layer</span>
        {expanded ? (
          <ChevronUp size={14} className="shrink-0" />
        ) : (
          <ChevronDown size={14} className="shrink-0" />
        )}
      </button>

      <div
        id="layer-control-body"
        hidden={!expanded}
        className="max-h-[60vh] space-y-3 overflow-y-auto border-t border-slate-200 px-3 pb-3 pt-2"
      >
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Overlai analitik
          </p>
          <div className="space-y-1">
            {OVERLAY_OPTIONS.map((o) => (
              <label key={o.key} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="analytic-overlay"
                  checked={analyticOverlay === o.key}
                  onChange={() => onAnalyticOverlayChange?.(o.key)}
                />
                <span className="leading-tight">{o.label}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-slate-400">
            {overlayLoading
              ? 'Memuat grid 300 m…'
              : analyticOverlay === 'tdi'
                ? 'Heatmap dari titik pusat sel 300 m (Viridis). Keterangan di Keterangan Peta.'
                : analyticOverlay === 'kepadatan'
                  ? 'Choropleth grid 300 m, kelas kuantil (YlGnBu). Rincian kelas di Keterangan Peta.'
                  : 'Pilih overlai untuk menampilkan kepadatan atau Transit Desert Index di peta.'}
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Titik &amp; jaringan
          </p>
          <div className="space-y-1">
            {POINT_LINE_OPTIONS.map((o) => (
              <div key={o.key}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!value?.[o.key]}
                    onChange={(e) => onChange?.({ ...value, [o.key]: e.target.checked })}
                  />
                  <span className="leading-tight">{o.label}</span>
                </label>
                {o.key === 'usulanModel' && value?.usulanModel && (
                  <UsulanModelRankControl
                    rankLimit={usulanModelRankLimit}
                    total={usulanModelTotal}
                    onChange={onUsulanModelRankLimitChange}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Kontrol bertingkat untuk layer "Usulan halte model": 3 preset (Level
 * 1/2/3 = top 25/50/100) + slider kontinu 0–100, dua arah sinkron dengan
 * state `usulanModelRankLimit` di App.jsx. Filter TUNGGAL di field
 * `usulan_halte_model.ranking` (ranking <= nilai ini) — tidak ada data
 * berbeda per level, preset cuma jalan pintas nilai slider.
 */
function UsulanModelRankControl({ rankLimit, total, onChange }) {
  const matchedPreset = USULAN_MODEL_PRESETS.find((p) => p.value === rankLimit)?.level ?? null
  const shownCount = Math.min(rankLimit, total)

  return (
    <div className="ml-6 mt-1.5 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
      <div className="flex flex-wrap gap-1">
        {USULAN_MODEL_PRESETS.map((p) => (
          <button
            key={p.level}
            type="button"
            onClick={() => onChange?.(p.value)}
            aria-pressed={matchedPreset === p.level}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
              matchedPreset === p.level
                ? 'border-brand-blue bg-brand-blue text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:border-brand-blue hover:text-brand-blue'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={rankLimit}
        onChange={(e) => onChange?.(Number(e.target.value))}
        className="w-full accent-brand-blue"
        aria-label="Jumlah usulan halte model teratas yang ditampilkan"
      />
      <p className="text-[10px] leading-snug text-slate-500">
        Menampilkan {shownCount} usulan teratas dari {total}
        {rankLimit === 0 ? ' (disembunyikan)' : ''}.
      </p>
    </div>
  )
}
