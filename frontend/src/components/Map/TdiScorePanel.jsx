import { X, MapPinOff, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import ConfidenceBadge from './ConfidenceBadge'

// Label manusiawi untuk sumber_halte_terdekat (lihat get_tdi_breakdown, 035) —
// nilai mentahnya adalah kode internal, bukan untuk ditampilkan apa adanya.
const SUMBER_HALTE_LABEL = {
  survei_lapangan: 'halte tersurvei langsung oleh tim lapangan',
  osm_belum_disurvei: 'halte dari data OpenStreetMap, belum disurvei fisik oleh tim',
}

/**
 * TdiScorePanel — overlay di atas peta UTAMA (dipakai bersama tab "Peta
 * Interaktif" & "Analisis Spasial", lihat App.jsx) yang muncul saat user klik
 * peta SEDANGKAN overlai analitik aktif = "Transit Desert Index" (state
 * `analyticOverlay === 'tdi'`, App.jsx). Menampilkan skor Transit Desert Index
 * (TDI) sel terpilih + rincian kontribusi tiap komponen formula — acceptance
 * criteria PRD Bab 8 ("CAI & TDI — klik lokasi -> rincian kontribusi tiap
 * kriteria, bukan angka tunggal").
 *
 * Dipindah dari components/AnalisisSpasial/TdiScorePanel.jsx pada konsolidasi
 * peta 2026-09-12 (Analisis Spasial tidak lagi punya <MapView> sendiri —
 * klik-untuk-rincian TDI kini ditangani App.jsx di peta utama yang sama
 * dipakai seluruh tab). Perilaku & kontrak `result` TIDAK berubah.
 *
 * Catatan istilah: skor ini disebut TDI (Transit Desert Index) di SELURUH UI
 * — label lama "Indeks Gap Aksesibilitas" (dulu dipakai AnalisisSpasial.jsx)
 * sudah dihapus supaya tidak terkesan metrik berbeda dari TDI yang disebut di
 * tempat lain (permintaan Sam 2026-09-12). Secara substansi label ini tetap
 * memenuhi istilah PRD Bab 8 "indeks gap aksesibilitas" — lihat CLAUDE.md.
 *
 * PENTING — TDI itu RASIO, bukan kombinasi linear berbobot seperti CAI:
 *   TDI_raw = Kepadatan x Indeks Kebutuhan Mobilitas / maks(Skor Aksesibilitas, 0,01)
 *   skor_tdi = normalisasi_minmax( ln(1 + TDI_raw) )  lintas seluruh sel
 * Karena itu komponen di sini TIDAK memakai model "nilai x bobot" ala
 * CaiScorePanel. Tiap komponen dirender menurut `peran`:
 *   - 'pembilang' -> menaikkan TDI (defisit layanan makin besar)
 *   - 'penyebut'  -> menurunkan TDI (akses transit sudah baik)
 * Angka diambil apa adanya dari RPC get_tdi_breakdown (migration 015, refined
 * 021/027) yang hanya MENYAJIKAN kolom grid_analisis yang sudah dihitung
 * offline — frontend tidak menghitung ulang skor.
 *
 * Posisi: bottom-3 left-3, sama dengan CaiScorePanel (bottom-4 left-4) —
 * TIDAK tumpang tindih pada praktiknya karena keduanya digerakkan oleh
 * handleMapClick yang eksklusif per state `analyticOverlay` (hanya salah satu
 * dari caiResult/tdiResult yang pernah terisi pada satu waktu, lihat App.jsx).
 *
 * Prop `variant` (BARU 2026-09-13, permintaan Sam, pola sama dg CaiScorePanel):
 *   - 'floating' (default) -> overlay absolute di atas peta (tab "Peta
 *     Interaktif", TIDAK berubah).
 *   - 'inline' -> blok biasa di panel kanan tab "Analisis Spasial", di bawah
 *     toggle overlai analitik — bukan menutupi peta.
 */
const WRAPPER_CLASS = {
  floating:
    'absolute bottom-3 left-3 z-10 w-[19rem] max-h-[75%] overflow-y-auto bg-white rounded-lg shadow-xl border border-slate-200',
  inline: 'w-full bg-white rounded-lg border border-slate-200',
}

export default function TdiScorePanel({ loading, result, usingDemo, onClose, variant = 'floating' }) {
  if (!loading && !result) return null

  return (
    <div className={WRAPPER_CLASS[variant] ?? WRAPPER_CLASS.floating}>
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200 sticky top-0 bg-white">
        <MapPinOff size={15} className="text-brand-orange shrink-0" />
        <h3 className="font-semibold text-slate-800 text-sm flex-1">Rincian Transit Desert Index</h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 shrink-0"
          aria-label="Tutup panel rincian TDI"
        >
          <X size={15} />
        </button>
      </div>

      {loading && <div className="p-4 text-sm text-slate-400">Mengambil rincian sel…</div>}

      {!loading && result && result.ditemukan === false && (
        <div className="p-4 text-sm text-slate-500 leading-relaxed">
          {result.di_luar_cakupan_grid ? (
            <>
              {result.catatan ||
                'Titik ini di luar cakupan grid analisis (area berpenduduk).'}
              {result.jarak_ke_sel_terdekat_m != null && (
                <span className="block mt-1 text-xs text-slate-400">
                  Jarak ke sel terdekat:{' '}
                  {Math.round(result.jarak_ke_sel_terdekat_m).toLocaleString('id-ID')} m
                  {result.ambang_luar_grid_m != null
                    ? ` (ambang ${Math.round(result.ambang_luar_grid_m).toLocaleString('id-ID')} m)`
                    : ''}
                </span>
              )}
            </>
          ) : (
            result.pesan || 'Tidak ada sel grid analisis di lokasi ini.'
          )}
        </div>
      )}

      {!loading && result && result.ditemukan !== false && (
        <div className="p-3 space-y-3">
          {usingDemo && (
            <div className="text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-2.5 py-1.5">
              Data contoh — sambungkan RPC <code>get_tdi_breakdown</code> untuk data asli.
            </div>
          )}

          <div className="text-center bg-brand-orange/5 rounded-lg py-2.5">
            <p className="text-xs text-slate-500">Skor TDI sel</p>
            <p className="text-3xl font-bold text-brand-orange">
              {fmt(result.skor_tdi, 2)}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              skala 0,00 – 1,00 · lebih tinggi = makin “transit desert”
            </p>
          </div>

          {result.confidence && (
            <ConfidenceBadge
              tier={result.confidence.confidence_tier}
              ratio={result.confidence.confidence_ratio}
              detail={`Berdasar ${
                SUMBER_HALTE_LABEL[result.confidence.sumber_halte_terdekat] ??
                result.confidence.sumber_halte_terdekat ??
                'sumber tidak diketahui'
              }, ${fmt(result.confidence.jarak_halte_terdekat_m, 0)} m dari sel ini.`}
            />
          )}

          {/* Formula rasio — ditampilkan eksplisit supaya jelas ini BUKAN penjumlahan berbobot */}
          <div className="text-[11px] bg-slate-50 border border-slate-200 rounded-md px-2.5 py-2 text-slate-600 leading-relaxed">
            <span className="font-medium text-slate-500">Formula: </span>
            {result.formula ||
              'TDI_raw = Kepadatan × Indeks Kebutuhan Mobilitas ÷ maks(Skor Aksesibilitas Transit, 0,01); skor_tdi = normalisasi_minmax(ln(1 + TDI_raw))'}
          </div>

          <div>
            <p className="text-xs font-medium text-slate-500 mb-2">
              Komponen formula (rasio — bukan nilai × bobot)
            </p>
            <div className="space-y-2">
              {(result.komponen || []).map((k) => (
                <ComponentRow key={k.kunci} komponen={k} />
              ))}
            </div>
          </div>

          <dl className="text-[11px] text-slate-500 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-200 pt-2">
            <dt>TDI rasio mentah</dt>
            <dd className="text-right font-mono text-slate-600">{fmt(result.tdi_raw, 2)}</dd>
            <dt>Reproduksi skor (perkiraan)</dt>
            <dd className="text-right font-mono text-slate-600">
              {result.skor_tdi_reproduksi_perkiraan != null
                ? fmt(result.skor_tdi_reproduksi_perkiraan, 3)
                : '—'}
            </dd>
            <dt>Sel dinilai</dt>
            <dd className="text-right font-mono text-slate-600">
              {result.match === 'terdekat'
                ? `terdekat (~${Math.round(result.jarak_ke_sel_m ?? 0).toLocaleString('id-ID')} m)`
                : 'memuat titik klik'}
              {result.cell_id != null ? ` · #${result.cell_id}` : ''}
            </dd>
          </dl>

          {result.catatan && (
            <p className="text-[11px] text-slate-400 leading-relaxed border-t border-slate-200 pt-2">
              {result.catatan}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ComponentRow({ komponen }) {
  const naik = komponen.peran === 'pembilang'
  return (
    <div className="rounded-md border border-slate-200 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-xs font-medium text-slate-700">{komponen.label}</span>
        <span className="font-mono text-xs text-slate-600">
          {komponen.nilai != null ? String(komponen.nilai).replace('.', ',') : '—'}
        </span>
      </div>
      <div
        className={
          'inline-flex items-center gap-1 text-[10px] font-medium rounded px-1.5 py-0.5 ' +
          (naik ? 'bg-orange-50 text-orange-700' : 'bg-sky-50 text-sky-700')
        }
      >
        {naik ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
        {naik ? 'pembilang — menaikkan TDI' : 'penyebut — menurunkan TDI'}
      </div>
      {komponen.satuan && (
        <p className="text-[10px] text-slate-400 mt-1 leading-snug">{komponen.satuan}</p>
      )}
      {komponen.arah && (
        <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">{komponen.arah}</p>
      )}
    </div>
  )
}

function fmt(v, d) {
  if (v == null || Number.isNaN(Number(v))) return '—'
  return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })
}
