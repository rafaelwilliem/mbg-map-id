import { Gauge, Info } from 'lucide-react'

/**
 * ConfidenceBadge — tampilan Confidence Ratio (BARU 2026-09-13, migration
 * `035_confidence_ratio.sql`, lihat docs/CONFIDENCE_RATIO.md) yang dipakai
 * bersama oleh CaiScorePanel, TdiScorePanel, dan EquityIndexView.
 *
 * BUKAN AHP consistency_ratio (konfigurasi_bobot, sudah ada sejak migration
 * 018 — itu validitas matriks pairwise, satu angka per index). Confidence
 * Ratio di sini mengukur keluasan bukti data di BALIK satu skor spesifik
 * (per sel grid / per kelurahan) — makin banyak sumber data lapangan
 * independen yang menyusunnya, makin tinggi keyakinannya. Penjelasan
 * pembeda ini SELALU ditampilkan (lewat prop `note`, ikon info + tooltip
 * native `title`) supaya tidak tertukar seperti yang pernah terjadi di satu
 * narasi AI arsip (lihat docs/CONFIDENCE_RATIO.md).
 *
 * Sengaja TIDAK bergantung pada warna semata (CLAUDE.md Bab 10.3,
 * colorblind-safe): label tier ("Tinggi"/"Sedang"/"Rendah") selalu berupa
 * TEKS, warna aksen cuma penguat sekunder — dan sengaja BUKAN pasangan
 * merah-hijau (Tinggi=brand-blue, Sedang=amber, Rendah=slate netral),
 * konsisten dengan skema warna lain di aplikasi ini yang menghindari
 * pasangan itu.
 *
 * Props:
 *  - tier: 'Tinggi' | 'Sedang' | 'Rendah' | null|undefined (null -> N/A).
 *  - ratio: number 0-1 | null — ditampilkan sbg pelengkap tier, opsional.
 *  - detail: string — kalimat singkat alasan tier ini (mis. "2 dari 4
 *    kriteria" atau "berdasar halte OSM, belum disurvei tim").
 */
const TIER_STYLE = {
  Tinggi: 'bg-brand-blue/10 text-brand-blue border-brand-blue/20',
  Sedang: 'bg-amber-50 text-amber-800 border-amber-200',
  Rendah: 'bg-slate-100 text-slate-600 border-slate-300',
}

const NOTE_DEFAULT =
  'Confidence Ratio: seberapa luas bukti data lapangan di balik skor ini — BUKAN consistency ' +
  'ratio (CR) AHP yang mengukur validitas bobot pairwise. Tidak memengaruhi skor itu sendiri.'

export default function ConfidenceBadge({ tier, ratio, detail, note = NOTE_DEFAULT }) {
  if (!tier) return null
  const style = TIER_STYLE[tier] ?? TIER_STYLE.Rendah

  return (
    <div className={`rounded-md border px-2.5 py-2 text-xs ${style}`}>
      <div className="flex items-center gap-1.5 font-medium">
        <Gauge size={13} className="shrink-0" />
        <span>Keyakinan data: {tier}</span>
        {ratio != null && (
          <span className="font-mono font-normal opacity-70">
            ({Number(ratio).toFixed(2)})
          </span>
        )}
        <Info size={12} className="ml-auto shrink-0 opacity-60" aria-hidden="true" title={note} />
      </div>
      {detail && <p className="mt-1 leading-snug opacity-90">{detail}</p>}
    </div>
  )
}
