import { X, Target } from 'lucide-react'
import ConfidenceBadge from './ConfidenceBadge'

/**
 * CaiScorePanel — overlay di atas peta (di luar mode simulasi) yang muncul saat
 * user klik lokasi. Sejak 2026-09-10 CAI adalah SURFACE grid 300 m
 * (grid_analisis, migration 033) — bukan lagi 19 titik_kandidat diskret. Panel
 * ini MENGONSUMSI JSON RPC get_cai_breakdown apa adanya: menampilkan skor CAI
 * sel grid terpilih + rincian kontribusi tiap kriteria AKTIF di sel itu
 * (acceptance criteria PRD Bab 8 — "bukan angka tunggal tanpa penjelasan").
 *
 * PENTING: tidak ada perkalian nilai × bobot yang dihitung di sini. Kolom
 * `kontribusi` sudah datang jadi dari RPC (yang pun hanya menyajikan kolom
 * cai_* hasil etl/compute_cai_grid.py). Bar tiap baris memakai
 * `kontribusi / skor_cai` murni untuk proporsi visual, bukan menghitung ulang
 * skor.
 *
 * Colorblind-safe (CLAUDE.md Bab 10.3): bar satu warna (brand-orange), tiap
 * baris kriteria dibedakan oleh label + angka — bukan warna. Tidak ada
 * pasangan merah–hijau.
 *
 * Prop `result` = JSON RPC. Dua bentuk:
 *   - ditemukan:true  -> { cell_id, match:'memuat'|'terdekat', jarak_ke_sel_m,
 *                          skor_cai, komponen:[…2-4], catatan, formula, … }
 *   - ditemukan:false -> { di_luar_cakupan_grid } | { pesan:'…belum dihitung…' }
 *                        | { pesan:'…' } (shape #1 / rpc error)
 *
 * Prop `variant` (BARU 2026-09-13, permintaan Sam):
 *   - 'floating' (default) -> overlay absolute di atas peta, dipakai tab
 *     "Peta Interaktif" (App.jsx, anak dari <MapView>).
 *   - 'inline' -> blok biasa dlm alur dokumen (tanpa absolute/z-index/shadow-xl
 *     seberat versi floating), dipakai tab "Analisis Spasial" supaya rincian
 *     tampil DI PANEL KANAN (di bawah toggle overlai analitik), bukan
 *     menutupi peta dg kotak melayang. Konten & logika identik — hanya
 *     wrapper luar yang beda.
 */

const FALLBACK_FORMULA =
  'cai_skor = Σ( nilai_ternormalisasi_i × bobot_efektif_i ) untuk kriteria aktif di sel; ' +
  'model aditif (Weighted Linear Combination), bukan rasio seperti TDI.'

// Kriteria yang BISA N/A pada sebuah sel (kepadatan & jarak selalu hadir).
// Kalau tidak muncul di `komponen`, panel menampilkan baris abu-abu penjelas.
const KRITERIA_OPSIONAL = [
  { kunci: 'volume', labelNa: 'Volume transit — tidak berlaku di sel ini' },
  { kunci: 'survei', labelNa: 'Skor survei kondisi halte — tidak berlaku di sel ini' },
]

const WRAPPER_CLASS = {
  floating:
    'absolute bottom-4 left-4 z-10 w-80 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-xl border border-slate-200',
  inline: 'w-full bg-white rounded-lg border border-slate-200',
}

export default function CaiScorePanel({ loading, result, usingDemo, onClose, variant = 'floating' }) {
  if (!loading && !result) return null

  const sukses = !loading && result && result.ditemukan === true
  const gagal = !loading && result && result.ditemukan !== true

  return (
    <div className={WRAPPER_CLASS[variant] ?? WRAPPER_CLASS.floating}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 sticky top-0 bg-white">
        <Target size={16} className="text-brand-blue shrink-0" />
        <h3 className="font-semibold text-slate-800 text-sm flex-1">
          Skor Composite Accessibility Index
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 shrink-0"
          aria-label="Tutup panel skor"
        >
          <X size={16} />
        </button>
      </div>

      {loading && <div className="p-4 text-sm text-slate-400">Mengambil rincian sel…</div>}

      {gagal && <CaiGagal result={result} />}

      {sukses && (
        <div className="p-4 space-y-4">
          {usingDemo && (
            <div className="text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
              Menampilkan data contoh. Sambungkan RPC <code>get_cai_breakdown</code> untuk data asli.
            </div>
          )}
          <CaiSukses result={result} />
        </div>
      )}
    </div>
  )
}

function CaiSukses({ result }) {
  const komponen = Array.isArray(result.komponen) ? result.komponen : []
  const skor = Number(result.skor_cai)
  // Pembagi bar: skor_cai. Kalau 0 / tak wajar, jatuh ke Σ kontribusi lalu 1
  // supaya width bar tidak jadi NaN/Infinity.
  const totalKontribusi = komponen.reduce((s, k) => s + (Number(k.kontribusi) || 0), 0)
  const pembagi = skor > 0 ? skor : totalKontribusi > 0 ? totalKontribusi : 1
  const hadir = (kunci) => komponen.some((k) => k.kunci === kunci)

  return (
    <>
      <div className="text-center bg-brand-blue/5 rounded-lg py-3">
        <p className="text-xs text-slate-500">Skor CAI — sel grid 300 m</p>
        <p className="text-3xl font-bold text-brand-blue">
          {Number.isFinite(skor) ? skor.toFixed(2) : '—'}
        </p>
        <p className="text-xs text-slate-400 mt-0.5">skala 0–1</p>
        <p className="text-[11px] text-slate-400 mt-1">
          {result.match === 'terdekat'
            ? `Sel grid terdekat (~${Math.round(
                result.jarak_ke_sel_m ?? 0,
              ).toLocaleString('id-ID')} m)`
            : 'Sel grid yang memuat titik ini'}
          {result.cell_id != null ? ` · #${result.cell_id}` : ''}
        </p>
      </div>

      {result.confidence && (
        <ConfidenceBadge
          tier={result.confidence.confidence_tier}
          ratio={result.confidence.confidence_ratio}
          detail={`${result.confidence.n_kriteria_aktif} dari ${result.confidence.n_kriteria_total} kriteria CAI terisi data di sel ini.`}
        />
      )}

      <div>
        <p className="text-xs font-medium text-slate-500 mb-2">Rincian kontribusi tiap kriteria</p>
        <div className="space-y-2.5">
          {komponen.map((k) => (
            <CriteriaRow key={k.kunci} komponen={k} pembagi={pembagi} />
          ))}
          {KRITERIA_OPSIONAL.filter((o) => !hadir(o.kunci)).map((o) => (
            <div key={o.kunci} className="opacity-60">
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500 mb-1">
                <span>{o.labelNa}</span>
                <span className="font-mono text-slate-400 shrink-0">N/A</span>
              </div>
              <div className="w-full h-1.5 bg-slate-100 rounded-full" />
              <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">
                Lihat catatan di bawah untuk alasannya.
              </p>
            </div>
          ))}
        </div>
      </div>

      {result.catatan && (
        <div className="text-xs bg-slate-50 text-slate-600 border border-slate-200 rounded-md px-3 py-2 leading-relaxed">
          {result.catatan}
        </div>
      )}

      <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-200 leading-relaxed">
        <span className="font-medium text-slate-500">Formula: </span>
        {result.formula || FALLBACK_FORMULA}
      </div>
    </>
  )
}

function CriteriaRow({ komponen, pembagi }) {
  const nilai = Number(komponen.nilai)
  const bobot = Number(komponen.bobot)
  const kontribusi = Number(komponen.kontribusi) || 0
  const lebar = Math.max(0, Math.min(100, (kontribusi / pembagi) * 100))
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs text-slate-600 mb-1">
        <span>{komponen.label}</span>
        <span className="font-mono text-slate-500 shrink-0">
          nilai {Number.isFinite(nilai) ? nilai.toFixed(2) : '—'} · bobot{' '}
          {Number.isFinite(bobot) ? `${Math.round(bobot * 100)}%` : '—'}
        </span>
      </div>
      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-orange rounded-full"
          style={{ width: `${Number.isFinite(lebar) ? lebar : 0}%` }}
        />
      </div>
      {(komponen.nilai_mentah != null || komponen.satuan) && (
        <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">
          {komponen.nilai_mentah != null
            ? Number(komponen.nilai_mentah).toLocaleString('id-ID')
            : ''}
          {komponen.satuan ? ` ${komponen.satuan}` : ''}
        </p>
      )}
    </div>
  )
}

function CaiGagal({ result }) {
  // Bentuk 2 — di luar footprint grid berpenduduk.
  if (result?.di_luar_cakupan_grid) {
    return (
      <div className="p-4 text-sm text-slate-500 leading-relaxed space-y-1.5">
        <p>
          Lokasi ini di luar cakupan analisis. Grid CAI hanya dibangun pada area berpenduduk
          Kota Bekasi.
        </p>
        {result.catatan && <p className="text-xs text-slate-400">{result.catatan}</p>}
      </div>
    )
  }
  // Bentuk 3 — sel ketemu tapi kolom cai_skor belum diisi (ETL upload belum jalan).
  if (result?.pesan && /belum dihitung/i.test(result.pesan)) {
    return (
      <div className="p-4 text-sm text-slate-500 leading-relaxed space-y-1.5">
        <p>Skor CAI grid belum dihitung untuk sel ini.</p>
        <p className="text-xs text-slate-400">{result.pesan}</p>
      </div>
    )
  }
  // Bentuk 1 / error RPC / apa pun yang tidak dikenali.
  return (
    <div className="p-4 text-sm text-slate-500 leading-relaxed">
      Skor CAI tidak tersedia untuk lokasi ini.
    </div>
  )
}
