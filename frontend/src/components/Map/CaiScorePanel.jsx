import { X, Target } from 'lucide-react'

/**
 * CaiScorePanel — overlay di atas peta yang muncul saat user klik lokasi
 * (di luar mode simulasi). Menampilkan skor CAI (Composite Accessibility
 * Index) TOTAL milik titik_kandidat terdekat, beserta rincian kontribusi
 * tiap kriteria — acceptance criteria PRD Bab 8 ("bukan angka tunggal
 * tanpa penjelasan").
 *
 * PENTING: komponen ini hanya menampilkan angka yang SUDAH dihitung &
 * disimpan di tabel skor_cai (oleh data-ai-analyst). Tidak ada perkalian
 * nilai x bobot yang dilakukan di sini — nilai ternormalisasi & bobot
 * ditampilkan berdampingan apa adanya supaya user bisa menelusuri asal
 * skor_final tanpa frontend "menghitung ulang" formula CAI.
 */
export default function CaiScorePanel({ loading, result, usingDemo, onClose }) {
  if (!loading && !result) return null

  return (
    <div className="absolute bottom-4 left-4 z-10 w-80 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-xl border border-slate-200">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 sticky top-0 bg-white">
        <Target size={16} className="text-brand-blue shrink-0" />
        <h3 className="font-semibold text-slate-800 text-sm flex-1">Skor Composite Accessibility Index</h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 shrink-0"
          aria-label="Tutup panel skor"
        >
          <X size={16} />
        </button>
      </div>

      {loading && (
        <div className="p-4 text-sm text-slate-400">Menghitung skor lokasi...</div>
      )}

      {!loading && result && !result.skor && (
        <div className="p-4 text-sm text-slate-500">
          Belum ada titik kandidat dengan skor CAI di dekat lokasi ini. Coba klik area yang
          sudah disurvei (lihat layer titik kandidat).
        </div>
      )}

      {!loading && result?.skor && (
        <div className="p-4 space-y-4">
          {usingDemo && (
            <div className="text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
              Menampilkan data contoh. Sambungkan tabel <code>skor_cai</code> untuk data asli.
            </div>
          )}

          <div className="text-center bg-brand-blue/5 rounded-lg py-3">
            <p className="text-xs text-slate-500">Skor CAI Total</p>
            <p className="text-3xl font-bold text-brand-blue">
              {result.skor.skor_final?.toFixed(2) ?? '-'}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">skala 0.00 – 1.00</p>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-500 mb-2">Rincian kontribusi tiap kriteria</p>
            <div className="space-y-2.5">
              <CriteriaRow
                label="Kepadatan penduduk"
                nilai={result.skor.n_kepadatan}
                bobot={result.skor.bobot_kepadatan}
              />
              <CriteriaRow
                label="Jarak ke fasilitas umum (inverse)"
                nilai={result.skor.n_jarak_inv}
                bobot={result.skor.bobot_jarak}
              />
              <CriteriaRow
                label="Volume penumpang transit terdekat"
                nilai={result.skor.n_volume}
                bobot={result.skor.bobot_volume}
              />
              <CriteriaRow
                label="Skor survei lapangan (kondisi halte)"
                nilai={result.skor.n_survei}
                bobot={result.skor.bobot_survei}
                na={result.skor.n_survei == null}
                naText="tidak berlaku — belum ada halte"
              />
            </div>
          </div>

          {result.skor.n_survei == null && (
            <div className="text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
              *Kriteria <strong>skor survei lapangan</strong> tidak berlaku di sini: ini
              <strong> lokasi usulan halte baru</strong>, belum ada halte eksisting untuk dinilai
              lewat Form Kondisi Halte. Kriteria itu dikeluarkan dari perhitungan dan 3 bobot AHP
              sisanya (kepadatan, jarak, volume) dinormalisasi ulang menjadi 100%. Ketiganya dari
              data riil (grid dasymetric DKB Semester I 2026 + traffic counting lapangan + jarak POI).
            </div>
          )}

          {result.titik?.catatan && (
            <div className="text-xs bg-slate-50 text-slate-600 border border-slate-200 rounded-md px-3 py-2">
              <span className="font-medium text-slate-500">Catatan survei: </span>
              {result.titik.catatan}
            </div>
          )}

          <div className="text-xs text-slate-400 pt-2 border-t border-slate-200 space-y-0.5">
            {result.titik?.deskripsi_lokasi && <p>Titik kandidat: {result.titik.deskripsi_lokasi}</p>}
            {(result.titik?.kecamatan || result.titik?.kelurahan) && (
              <p>
                {[result.titik.kelurahan, result.titik.kecamatan].filter(Boolean).join(', ')}
              </p>
            )}
            <p>
              ~{Math.round(result.distance_m ?? 0).toLocaleString('id-ID')} m dari titik yang Anda klik
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function CriteriaRow({ label, nilai, bobot, na = false, naText = 'tidak berlaku' }) {
  const pct = Math.max(0, Math.min(1, nilai ?? 0)) * 100
  return (
    <div className={na ? 'opacity-60' : undefined}>
      <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
        <span>{label}</span>
        <span className="font-mono text-slate-500">
          {na
            ? naText
            : `nilai ${nilai != null ? nilai.toFixed(2) : '-'} · bobot ${bobot != null ? `${Math.round(bobot * 100)}%` : '-'}`}
        </span>
      </div>
      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
        {!na && <div className="h-full bg-brand-orange rounded-full" style={{ width: `${pct}%` }} />}
      </div>
    </div>
  )
}
