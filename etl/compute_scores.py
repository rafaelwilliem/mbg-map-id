"""
compute_scores.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Implementasi tiga skor inti sesuai Bab 7 PRD & framework teknis:
  - Composite Accessibility Index (CAI)  — Weighted Linear Combination, per titik/grid
  - Transit Desert Index (TDI)            — rasio kebutuhan vs aksesibilitas, per grid
  - Transit Equity Index                  — CAI + indikator kerentanan, per kelurahan

Cara pakai:
    python compute_scores.py            # jalankan demo ketiga skor dengan data sintetis
    (nanti) python compute_scores.py --input data/processed/titik_kandidat.csv

TODO integrasi selanjutnya (belum dikerjakan di sini, butuh data asli):
  - Ganti load_demo_data()/load_demo_grid_data()/load_demo_equity_data() dengan
    query GeoPandas/PostGIS asli:
      * n_kepadatan   <- spatial join grid_analisis/batas_administrasi dengan penduduk
        [SELESAI untuk CAI titik_kandidat, 28 Agu 2026 — lihat
        etl/attach_kepadatan_titik_kandidat.py: spatial join titik_kandidat ->
        grid_analisis (dasymetric real), gantikan KEPADATAN_NEUTRAL_PLACEHOLDER
        di upload_to_supabase.recompute_all_cai_scores()]
      * n_jarak_inv   <- ST_Distance / GeoPandas .distance() ke poi terdekat
      * n_volume      <- jumlah penumpang KRL/BRT dalam radius tertentu
      * n_survei      <- skor_survei_gabungan dari tabel halte_eksisting
      * skor_aksesibilitas_transit <- coverage isochrone 400m/800m per grid
      * kepadatan_poi_harian <- overlay poi; proporsi_usia_sekolah <- spatial join
        centroid grid -> kelurahan, ambil penduduk.proporsi_usia_sekolah (migration 026)
      * skor_cai_rata2, jarak_rata2_* per kelurahan <- agregasi skor_cai per grid/titik
        yang jatuh di dalam tiap kelurahan (spatial join ke batas_administrasi)
  - Bobot dibaca dari tabel konfigurasi_bobot (hasil AHP pairwise Saaty
    formal 2026-09-03, migration 018) lewat load_weights_from_db() di
    upload_to_supabase.py. DEFAULT_*_WEIGHTS di bawah = salinan fallback
    yang harus tetap identik dengan tabel itu.
"""

import pandas as pd
import numpy as np

# ============================================================
# BOBOT FINAL — hasil AHP pairwise (Saaty) formal, sesi 2026-09-03.
# Rujukan tunggal saat runtime tetap tabel konfigurasi_bobot di Supabase
# (migration 018_konfigurasi_bobot_ahp_final.sql); DEFAULT_* di bawah ini
# adalah SALINAN FALLBACK yang WAJIB identik dengan isi tabel itu, dipakai
# hanya kalau DB tidak bisa dihubungi / baris index-nya kosong
# (load_weights_from_db() di upload_to_supabase.py). Kalau bobot di DB
# diubah lagi, sinkronkan angka di sini pada commit yang sama.
# consistency_ratio (untuk dokumentasi): CAI 0,0226 | TDI_MOBILITAS 0,0000
# | EQUITY 0,0457 — ketiganya < 0,1 (memenuhi ambang Saaty).
# ============================================================
DEFAULT_WEIGHTS = {
    "kepadatan": 0.3290,
    "jarak_inv": 0.3290,
    "volume": 0.2002,
    "survei": 0.1418,
}

# Bobot untuk Indeks Kebutuhan Mobilitas (komponen TDI) — proksi kerentanan
# mobilitas. PRD Bab 7 menyebut proksi "proporsi lansia/difabel, kepadatan
# POI kebutuhan harian, rasio RT tanpa kendaraan". Komponen ketiga DIGANTI
# (keputusan tim 2026-09-06, migration 026) dari 'tanpa_kendaraan' ->
# 'usia_sekolah' = proporsi penduduk umur 5–19 (jenjang SD–SMA / di bawah
# usia mengemudi, transit-dependent). Alasan: rasio tanpa-kendaraan tidak
# tersedia pada resolusi spasial (Susenas hanya angka kota 93,05% RT punya
# aset transportasi) -> selama ini fallback netral 0,5 di semua grid (nol
# daya pisah). Nilai bobot = hasil AHP (konfigurasi_bobot
# nama_index='TDI_MOBILITAS'); 'usia_sekolah' mengambil alih slot 0,4000
# apa adanya, matriks pairwise Saaty 3x3 tetap CR = 0,0000.
DEFAULT_MOBILITY_WEIGHTS = {
    "usia_rentan": 0.2000,
    "poi_harian": 0.4000,
    "usia_sekolah": 0.4000,
}

# Bobot untuk Transit Equity Index — menggabungkan composite accessibility
# index (dibalik, karena makin rendah CAI makin timpang) dengan indikator
# kerentanan per kelurahan (Bab 7 PRD). Kolom mengikuti skema tabel
# skor_equity di 001_init_tables.sql. Nilai = hasil AHP 2026-09-03
# (konfigurasi_bobot nama_index='EQUITY', CR 0,0457).
DEFAULT_EQUITY_WEIGHTS = {
    "aksesibilitas_inv": 0.3076,
    "kepadatan": 0.1538,
    "usia_rentan": 0.1513,
    "akses_pendidikan": 0.1260,
    "akses_kesehatan": 0.1353,
    "akses_kerja": 0.1260,
}


def normalize_min_max(series: pd.Series, inverse: bool = False) -> pd.Series:
    """
    Normalisasi min-max ke skala 0-1.

    inverse=True dipakai untuk kriteria 'semakin kecil semakin baik'
    (mis. jarak ke fasilitas umum — makin dekat, makin baik).
    """
    lo, hi = series.min(), series.max()
    if hi == lo:
        # Semua nilai sama -> tidak ada variasi untuk dibedakan, netral di tengah
        return pd.Series(0.5, index=series.index)
    normalized = (series - lo) / (hi - lo)
    return 1 - normalized if inverse else normalized


CAI_CRITERIA_KEYS = ("kepadatan", "jarak_inv", "volume", "survei")


def compute_cai(
    df: pd.DataFrame,
    weights: dict = None,
    exclude_criteria: list = None,
) -> pd.DataFrame:
    """
    Hitung Composite Accessibility Index untuk tiap baris (titik/grid).

    df wajib punya kolom mentah:
      - kepadatan_penduduk   (jiwa/km2 atau jumlah penduduk sekitar titik)
      - jarak_fasilitas_m    (meter, semakin kecil semakin baik -> inverse)
      - volume_penumpang     (penumpang/hari di simpul transit terdekat)
      - skor_survei          (0-1, sudah dihitung dari S_survei lapangan) —
        WAJIB hanya kalau 'survei' TIDAK ada di exclude_criteria.

    exclude_criteria (opsional, default None -> perilaku lama 4 kriteria):
      list berisi subset dari {'kepadatan','jarak_inv','volume','survei'}.
      Kriteria yang disebut di sini diperlakukan N/A (bukan "bernilai 0"):
        - kolom ternormalisasinya (mis. n_survei) ditulis NaN, BUKAN 0;
        - bobotnya dikeluarkan dari WLC dan sisa bobot AHP dinormalisasi
          ulang supaya berjumlah 1 -> kontribusi tiap kriteria yang tersisa
          tetap bisa ditelusuri (Sum n_i * bobot_i == skor_cai).
      Dipakai untuk titik_kandidat (usulan halte baru): kriteria "skor survei
      lapangan (kondisi fisik & akses simpul)" = Form Kondisi Halte atas halte
      EKSISTING, jadi tidak berlaku di lokasi yang belum ada haltenya —
      keputusan tim 2026-09-07, lihat docs/VALIDASI_BOBOT_AHP.md. Set bobot
      AHP 4 kriteria di konfigurasi_bobot TETAP definisi kanonik CAI;
      renormalisasi ini turunan runtime khusus subset titik_kandidat.

    Return: df yang sama + kolom n_kepadatan, n_jarak_inv, n_volume,
    n_survei, skor_cai (0-1), plus bobot EFEKTIF yang dipakai per baris
    (bobot_kepadatan, bobot_jarak, bobot_volume, bobot_survei — kolom yang
    dikecualikan ditulis NaN). Kolom bobot_* ini yang di-persist ke tabel
    skor_cai supaya breakdown di CaiScorePanel rekonsiliasi dengan skor_final.
    """
    weights = weights or DEFAULT_WEIGHTS
    assert abs(sum(weights.values()) - 1.0) < 1e-6, "Bobot harus berjumlah 1.0"

    exclude = set(exclude_criteria or [])
    unknown = exclude - set(CAI_CRITERIA_KEYS)
    if unknown:
        raise ValueError(f"exclude_criteria tak dikenal: {sorted(unknown)} (valid: {CAI_CRITERIA_KEYS})")
    if not exclude <= set(CAI_CRITERIA_KEYS) or len(exclude) >= len(CAI_CRITERIA_KEYS):
        raise ValueError("exclude_criteria tidak boleh mengecualikan semua kriteria CAI.")

    # Bobot efektif: kriteria yang di-exclude -> 0, sisanya dinormalisasi
    # ulang ke jumlah 1. Kalau exclude kosong, eff identik dengan weights.
    eff = {k: (0.0 if k in exclude else float(weights[k])) for k in weights}
    total_eff = sum(eff.values())
    assert total_eff > 0, "Tidak ada bobot tersisa setelah exclude_criteria."
    eff = {k: v / total_eff for k, v in eff.items()}

    out = df.copy()
    out["n_kepadatan"] = normalize_min_max(out["kepadatan_penduduk"])
    out["n_jarak_inv"] = normalize_min_max(out["jarak_fasilitas_m"], inverse=True)
    out["n_volume"] = normalize_min_max(out["volume_penumpang"])
    # 'survei' N/A -> NaN (bukan 0); kalau tidak dikecualikan, pakai skor
    # instrumen survei apa adanya (sudah 0-1, tidak dinormalisasi ulang).
    out["n_survei"] = np.nan if "survei" in exclude else out["skor_survei"]

    # bobot efektif per baris (konstan lintas baris di sini, ditulis sbg
    # kolom supaya upload_to_supabase bisa mem-persist-nya ke skor_cai.bobot_*)
    out["bobot_kepadatan"] = np.nan if "kepadatan" in exclude else eff["kepadatan"]
    out["bobot_jarak"] = np.nan if "jarak_inv" in exclude else eff["jarak_inv"]
    out["bobot_volume"] = np.nan if "volume" in exclude else eff["volume"]
    out["bobot_survei"] = np.nan if "survei" in exclude else eff["survei"]

    term_survei = 0.0 if "survei" in exclude else eff["survei"] * out["n_survei"]
    out["skor_cai"] = (
        eff["kepadatan"] * out["n_kepadatan"]
        + eff["jarak_inv"] * out["n_jarak_inv"]
        + eff["volume"] * out["n_volume"]
        + term_survei
    )
    return out.sort_values("skor_cai", ascending=False).reset_index(drop=True)


def sensitivity_check(df: pd.DataFrame, base_weights: dict, delta: float = 0.1) -> pd.DataFrame:
    """
    Uji kestabilan ranking skor_cai (CAI) terhadap pergeseran tiap bobot
    +/- delta (dengan sisanya disesuaikan proporsional), lihat apakah
    urutan top-N berubah. Dipakai untuk validasi metodologi sebelum
    dipresentasikan ke juri (lihat framework Bagian 2, prinsip
    'sensitivity analysis').

    FIX (lihat _sensitivity_check_generic untuk detail bug lama): versi
    sebelumnya membandingkan .rank() pada kolom skor_cai SETELAH df
    diurutkan & di-reset index oleh compute_cai(), sehingga rank() di
    atasnya selalu menghasilkan [1, 2, 3, ...] apa pun isinya -> selalu
    melaporkan 0 perubahan ranking (positif palsu "robust"). Sekarang
    delegasi ke _sensitivity_check_generic() yang membandingkan ranking
    PER "nama_lokasi" (id_col), align lewat .reindex(), bukan per posisi
    baris. Diverifikasi manual: menggeser bobot survei ke 0.97 membuat
    "Kawasan Industri Marga Mulya" naik dari peringkat 4 ke 2 (dan
    "Dekat Stasiun Bekasi Timur" turun dari 2 ke 4) -> terdeteksi sebagai
    2 baris ranking berubah, tidak lagi 0.
    """
    return _sensitivity_check_generic(df, base_weights, "nama_lokasi", compute_cai, "skor_cai", delta)


def _sensitivity_check_generic(
    df: pd.DataFrame,
    base_weights: dict,
    id_col: str,
    compute_fn,
    score_col: str,
    delta: float = 0.1,
) -> pd.DataFrame:
    """
    Helper generik untuk uji kestabilan ranking (dipakai oleh
    sensitivity_check_tdi dan sensitivity_check_equity di bawah).

    LATAR BELAKANG BUG (sudah diperbaiki, dicatat supaya tidak terulang):
    versi awal sensitivity_check() (CAI) membandingkan .rank() pada kolom
    skor SETELAH df diurutkan & di-reset index oleh compute_fn. Karena
    kolom itu sudah terurut menurun, rank() di atasnya SELALU menghasilkan
    [1, 2, 3, ...] apa pun isinya — jadi baseline_order.values dan
    new_order.values akan selalu identik walau identitas baris yang
    menempati tiap peringkat berubah total. Itu bug: ranking_berubah akan
    selalu terbaca 0, positif palsu untuk "robust". Diverifikasi manual:
    menggeser bobot CAI ke ekstrem (survei=0.97) membuat "Kawasan Industri
    Marga Mulya" naik dari peringkat 4 ke 2, tapi versi lama melaporkan 0
    perubahan. sensitivity_check() (CAI) sekarang juga didelegasikan ke
    fungsi generik ini, sama seperti sensitivity_check_tdi/_equity.

    Fungsi generik ini memakai id_col (kolom identitas stabil, mis. nama
    lokasi/grid_id/nama_kelurahan) supaya ranking dibandingkan PER ENTITAS,
    bukan per posisi baris setelah sort.
    """
    baseline = compute_fn(df, base_weights).set_index(id_col)[score_col].rank(ascending=False)
    results = []
    for key in base_weights:
        for sign in (+1, -1):
            shifted = base_weights.copy()
            shifted[key] = max(0, shifted[key] + sign * delta)
            total = sum(shifted.values())
            shifted = {k: v / total for k, v in shifted.items()}  # renormalize ke 1.0

            new = compute_fn(df, shifted).set_index(id_col)[score_col].rank(ascending=False)
            new_aligned = new.reindex(baseline.index)  # samakan urutan berdasarkan id_col, bukan posisi
            rank_changed = (baseline.values != new_aligned.values).sum()
            results.append({
                "kriteria_digeser": key,
                "arah": "+" if sign > 0 else "-",
                "jumlah_ranking_berubah": int(rank_changed),
            })
    return pd.DataFrame(results)


def top_n_stability_check(
    df: pd.DataFrame,
    base_weights: dict,
    id_col: str,
    compute_fn,
    score_col: str,
    top_n: int = 20,
    delta: float = 0.1,
) -> pd.DataFrame:
    """
    Pelengkap _sensitivity_check_generic() untuk dataset besar (mis. 2.607
    grid TDI) di mana "jumlah ranking berubah" per ENTITAS jadi metrik yang
    bising/kurang informatif secara kebijakan: dengan ribuan baris bernilai
    kontinu, pergeseran bobot kecil wajar menukar urutan pasangan yang
    skornya nyaris identik (mis. peringkat #1000 vs #1001) tanpa itu berarti
    prioritas kebijakan berubah. Yang lebih relevan untuk pengambil keputusan
    (Dishub/Bappeda memprioritaskan TOP-N lokasi, bukan urutan lengkap
    seluruh grid) adalah: dari top_n entitas prioritas tertinggi versi bobot
    dasar, berapa yang TETAP masuk top_n setelah bobot digeser ±delta.

    Return: DataFrame dengan kolom 'kriteria_digeser', 'arah',
    'jumlah_tetap_top_n' (dari top_n, semakin dekat ke top_n = semakin
    stabil), 'top_n'.
    """
    baseline_top = set(
        compute_fn(df, base_weights).set_index(id_col)[score_col].nlargest(top_n).index
    )
    results = []
    for key in base_weights:
        for sign in (+1, -1):
            shifted = base_weights.copy()
            shifted[key] = max(0, shifted[key] + sign * delta)
            total = sum(shifted.values())
            shifted = {k: v / total for k, v in shifted.items()}

            new_top = set(
                compute_fn(df, shifted).set_index(id_col)[score_col].nlargest(top_n).index
            )
            tetap = len(baseline_top & new_top)
            results.append({
                "kriteria_digeser": key,
                "arah": "+" if sign > 0 else "-",
                "jumlah_tetap_top_n": tetap,
                "top_n": top_n,
            })
    return pd.DataFrame(results)


def sensitivity_check_tdi(df: pd.DataFrame, base_weights: dict = None, delta: float = 0.1) -> pd.DataFrame:
    """
    Uji kestabilan ranking skor_tdi terhadap pergeseran bobot Indeks
    Kebutuhan Mobilitas (mengikuti prinsip sensitivity_check() untuk CAI,
    tapi dengan perbandingan per-grid_id yang benar — lihat catatan di
    _sensitivity_check_generic).
    """
    base_weights = base_weights or DEFAULT_MOBILITY_WEIGHTS
    return _sensitivity_check_generic(df, base_weights, "grid_id", compute_tdi, "skor_tdi", delta)


def sensitivity_check_equity(df: pd.DataFrame, base_weights: dict = None, delta: float = 0.1) -> pd.DataFrame:
    """
    Uji kestabilan ranking skor_final (Transit Equity Index) terhadap
    pergeseran bobot equity (mengikuti prinsip sensitivity_check() untuk
    CAI, tapi dengan perbandingan per-nama_kelurahan yang benar — lihat
    catatan di _sensitivity_check_generic).
    """
    base_weights = base_weights or DEFAULT_EQUITY_WEIGHTS
    return _sensitivity_check_generic(df, base_weights, "nama_kelurahan", compute_equity_index, "skor_final", delta)


def compute_indeks_kebutuhan_mobilitas(df: pd.DataFrame, weights: dict = None) -> pd.Series:
    """
    Hitung Indeks Kebutuhan Mobilitas (0-1) — komponen TDI. Proksi kerentanan
    mobilitas (PRD Bab 7), dengan komponen ketiga diganti ke usia sekolah
    (keputusan tim 2026-09-06, migration 026 — lihat DEFAULT_MOBILITY_WEIGHTS):

      - proporsi_usia_rentan    (0-1, gabungan proporsi lansia + balita; sudah
                                  rasio -> dipakai APA ADANYA, tidak dinormalisasi)
      - kepadatan_poi_harian    (jumlah POI kebutuhan harian per grid/radius;
                                  dinormalisasi min-max lintas grid)
      - proporsi_usia_sekolah   (0-1, proporsi penduduk umur 5–19 per kelurahan =
                                  pita 05-09 + 10-14 + 15-19 / jumlah_penduduk;
                                  proksi populasi di bawah usia mengemudi yang
                                  transit-dependent. Dinormalisasi min-max lintas
                                  grid supaya rentang sempitnya (~0,22–0,29 di
                                  Kota Bekasi) tetap punya daya pisah — beda dari
                                  usia_rentan yang dipakai mentah.)

    Semua kolom di atas WAJIB ada. Tidak ada lagi jalur fallback netral 0,5
    (dulu dipakai untuk 'rasio_tanpa_kendaraan' yang tak tersedia per-grid —
    dihapus di migration 026).
    """
    weights = weights or DEFAULT_MOBILITY_WEIGHTS
    assert abs(sum(weights.values()) - 1.0) < 1e-6, "Bobot mobilitas harus berjumlah 1.0"

    n_usia_rentan = df["proporsi_usia_rentan"]
    n_poi_harian = normalize_min_max(df["kepadatan_poi_harian"])
    n_usia_sekolah = normalize_min_max(df["proporsi_usia_sekolah"])

    return (
        weights["usia_rentan"] * n_usia_rentan
        + weights["poi_harian"] * n_poi_harian
        + weights["usia_sekolah"] * n_usia_sekolah
    )


def compute_tdi(df: pd.DataFrame, mobility_weights: dict = None) -> pd.DataFrame:
    """
    Hitung Transit Desert Index (TDI) per grid, sesuai formula Bab 7 PRD:

        TDI = (Kepadatan Penduduk x Indeks Kebutuhan Mobilitas) / Skor Aksesibilitas Transit

    df wajib punya kolom mentah:
      - kepadatan_penduduk           (jiwa/km2 per grid)
      - skor_aksesibilitas_transit   (0-1, dari coverage isochrone 400m/800m —
                                       makin tinggi makin terlayani)
      - proporsi_usia_rentan, kepadatan_poi_harian, proporsi_usia_sekolah
        -> lihat compute_indeks_kebutuhan_mobilitas()

    Return: df + kolom indeks_kebutuhan_mobilitas, tdi_raw (rasio mentah,
    satuannya tidak berskala 0-1, disimpan APA ADANYA untuk transparansi/
    debugging — inilah angka yang ditelusuri kalau ada yang bertanya "kok
    grid ini skornya segini"), dan skor_tdi (0-1, dipakai untuk ranking/
    pewarnaan peta — skor lebih tinggi = grid makin "transit desert",
    makin butuh prioritas).

    FIX outlier: skor_tdi TIDAK dinormalisasi langsung dari tdi_raw, tapi
    dari log1p(tdi_raw) dulu. Alasan: tdi_raw dari pembagian oleh
    skor_aksesibilitas_transit yang sangat kecil (dekat AKSESIBILITAS_FLOOR)
    bisa meledak jadi outlier ekstrem (mis. grid dengan aksesibilitas=0).
    Kalau normalize_min_max (linear min-max) dipakai langsung ke tdi_raw,
    satu outlier ekstrem itu akan menjadi hi (nilai maksimum), dan SEMUA
    grid lain — termasuk transit desert asli seperti Kaliabang Tengah,
    Mustika Jaya, Rawa Lumbu — "tenggelam" ke dekat 0 karena skala jadi
    didominasi outlier tsb, padahal secara kebutuhan riil mereka jelas jauh
    lebih butuh prioritas dibanding grid yang sudah terlayani baik.
    log1p() (kompresi logaritmik) meredam rentang ekstrem itu sebelum
    min-max, sehingga sebaran skor_tdi tetap terbedakan secara berarti
    antar grid, bukan cuma terdorong ke ujung skala oleh satu outlier.
    """
    out = df.copy()
    out["indeks_kebutuhan_mobilitas"] = compute_indeks_kebutuhan_mobilitas(out, mobility_weights)

    # Guard pembagi nol: grid yang benar-benar tidak terlayani sama sekali
    # (skor_aksesibilitas_transit = 0) tetap harus dihitung, bukan error/NaN
    # atau infinity yang merusak ranking — pakai nilai lantai (floor) kecil
    # yang setara dengan "aksesibilitas hampir nihil".
    AKSESIBILITAS_FLOOR = 0.01
    aksesibilitas_aman = out["skor_aksesibilitas_transit"].clip(lower=AKSESIBILITAS_FLOOR)

    out["tdi_raw"] = (
        out["kepadatan_penduduk"] * out["indeks_kebutuhan_mobilitas"] / aksesibilitas_aman
    )
    # log1p meredam outlier ekstrem sebelum min-max — lihat catatan "FIX outlier" di atas.
    out["skor_tdi"] = normalize_min_max(np.log1p(out["tdi_raw"]))

    return out.sort_values("skor_tdi", ascending=False).reset_index(drop=True)


def compute_equity_index(df: pd.DataFrame, weights: dict = None) -> pd.DataFrame:
    """
    Hitung Transit Equity Index per kelurahan, sesuai Bab 7 PRD:
    "menggabungkan composite accessibility index dengan indikator kerentanan
    untuk menghasilkan ranking ketimpangan akses antarkelurahan".

    df wajib punya kolom mentah per kelurahan:
      - kepadatan_penduduk          (jiwa/km2)
      - skor_cai_rata2              (0-1, rata-rata skor_cai semua titik/grid
                                      dalam kelurahan tsb — hasil spatial join)
      - proporsi_usia_rentan        (0-1, sudah rasio, tidak dinormalisasi ulang)
      - jarak_rata2_pendidikan_m    (meter, rata-rata jarak ke sekolah terdekat)
      - jarak_rata2_kesehatan_m     (meter, rata-rata jarak ke faskes terdekat)
      - jarak_rata2_kerja_m         (meter, rata-rata jarak ke pusat kerja terdekat)

    Return: df + kolom n_kepadatan, n_usia_rentan, n_akses_pendidikan,
    n_akses_kesehatan, n_akses_kerja, skor_final, ranking — nama kolom
    sengaja disamakan dengan skema tabel skor_equity di 001_init_tables.sql
    supaya siap diupload langsung via upload_to_supabase.py.

    Kolom opsional 'kelompok_terdampak' dan 'rekomendasi_intervensi' (skema
    005_equity_kelompok_rekomendasi.sql), kalau ada di df input, dibawa
    apa adanya (pass-through, lewat df.copy() di awal fungsi ini) — bukan
    dihitung dari formula, karena keduanya narasi deskriptif hasil analisis
    tim, bukan skor numerik.

    Catatan skala: skor_final di sini adalah SKOR KETIMPANGAN (equity gap),
    bukan skor akses — semakin TINGGI skor_final, semakin dirugikan/tertinggal
    kelurahan tsb (konsisten dengan EquityIndexView.jsx di frontend). Jarak ke
    fasilitas TIDAK dibalik (inverse=False) karena jarak besar = akses buruk =
    memang seharusnya menaikkan skor ketimpangan.
    """
    weights = weights or DEFAULT_EQUITY_WEIGHTS
    assert abs(sum(weights.values()) - 1.0) < 1e-6, "Bobot equity index harus berjumlah 1.0"

    out = df.copy()
    # CAI tinggi = akses bagus -> equity gap rendah, jadi dibalik (inverse=True)
    out["n_aksesibilitas_inv"] = normalize_min_max(out["skor_cai_rata2"], inverse=True)
    out["n_kepadatan"] = normalize_min_max(out["kepadatan_penduduk"])
    out["n_usia_rentan"] = out["proporsi_usia_rentan"]
    out["n_akses_pendidikan"] = normalize_min_max(out["jarak_rata2_pendidikan_m"])
    out["n_akses_kesehatan"] = normalize_min_max(out["jarak_rata2_kesehatan_m"])
    out["n_akses_kerja"] = normalize_min_max(out["jarak_rata2_kerja_m"])

    out["skor_final"] = (
        weights["aksesibilitas_inv"] * out["n_aksesibilitas_inv"]
        + weights["kepadatan"] * out["n_kepadatan"]
        + weights["usia_rentan"] * out["n_usia_rentan"]
        + weights["akses_pendidikan"] * out["n_akses_pendidikan"]
        + weights["akses_kesehatan"] * out["n_akses_kesehatan"]
        + weights["akses_kerja"] * out["n_akses_kerja"]
    )

    out = out.sort_values("skor_final", ascending=False).reset_index(drop=True)
    # ranking 1 = paling dirugikan/tertinggal (skor_final tertinggi)
    out["ranking"] = out["skor_final"].rank(ascending=False, method="min").astype(int)
    return out


def load_demo_data() -> pd.DataFrame:
    """Data sintetis untuk demo/testing — GANTI dengan data asli."""
    return pd.DataFrame({
        "nama_lokasi": [
            "Simpang Mustika Jaya",
            "Dekat Stasiun Bekasi Timur",
            "Perumahan Rawa Lumbu",
            "Kawasan Industri Marga Mulya",
        ],
        "kepadatan_penduduk": [14200, 9800, 16500, 6100],
        "jarak_fasilitas_m": [850, 300, 1200, 600],
        "volume_penumpang": [120, 4200, 80, 1500],
        "skor_survei": [0.55, 0.80, 0.40, 0.65],
    })


def load_demo_grid_data() -> pd.DataFrame:
    """Data grid sintetis untuk demo TDI — GANTI dengan hasil fishnet asli."""
    return pd.DataFrame({
        "grid_id": ["GRID-KAJ-01", "GRID-BKT-02", "GRID-MJY-03", "GRID-RWL-04"],
        "nama_area": [
            "Kaliabang Tengah (kelurahan terpadat)",
            "Sekitar Stasiun Bekasi Timur",
            "Mustika Jaya (kandidat transit desert)",
            "Rawa Lumbu (kandidat transit desert)",
        ],
        "kepadatan_penduduk": [18500, 11000, 15200, 13800],
        "skor_aksesibilitas_transit": [0.10, 0.85, 0.15, 0.20],
        "proporsi_usia_rentan": [0.22, 0.15, 0.25, 0.19],
        "kepadatan_poi_harian": [12, 30, 9, 14],
        # proporsi_usia_sekolah (umur 5–19) — komponen ketiga Indeks Kebutuhan
        # Mobilitas sejak migration 026 (menggantikan rasio_tanpa_kendaraan).
        # Angka contoh dalam rentang riil Kota Bekasi (~0,22–0,29).
        "proporsi_usia_sekolah": [0.27, 0.23, 0.28, 0.25],
    })


def load_demo_equity_data() -> pd.DataFrame:
    """Data kelurahan sintetis untuk demo Transit Equity Index — GANTI dengan
    hasil agregasi skor_cai per kelurahan (spatial join ke batas_administrasi).

    kelompok_terdampak & rekomendasi_intervensi (kolom skor_equity, lihat
    migration 005_equity_kelompok_rekomendasi.sql) TIDAK dihitung dari
    formula — ini isian deskriptif hasil analisis tim/mentor per kelurahan,
    dibawa apa adanya (pass-through) oleh compute_equity_index() supaya
    langsung siap diupload lewat upload_to_supabase.upload_equity_scores().
    Nilai di bawah ini masih CONTOH/DUMMY, ganti begitu ada analisis kerentanan
    sosial yang tervalidasi per kelurahan (PRD Bab 8, Transit Equity Index
    Dashboard: "kelompok terdampak" + "1 rekomendasi intervensi")."""
    return pd.DataFrame({
        "nama_kelurahan": [
            "Mustika Jaya",
            "Bantar Gebang",
            "Rawa Lumbu",
            "Bekasi Utara",
            "Marga Mulya",
        ],
        "kepadatan_penduduk": [15200, 9600, 13800, 12100, 8200],
        "skor_cai_rata2": [0.22, 0.28, 0.31, 0.38, 0.71],
        "proporsi_usia_rentan": [0.25, 0.21, 0.19, 0.20, 0.14],
        "jarak_rata2_pendidikan_m": [1100, 950, 900, 700, 350],
        "jarak_rata2_kesehatan_m": [1800, 1600, 1400, 1000, 500],
        "jarak_rata2_kerja_m": [2500, 2100, 1900, 1300, 600],
        "kelompok_terdampak": [
            ["lansia", "anak sekolah", "pekerja informal"],
            ["pekerja informal", "anak sekolah"],
            ["lansia", "ibu dan balita"],
            ["pekerja komuter", "anak sekolah"],
            ["pekerja industri"],
        ],
        "rekomendasi_intervensi": [
            "Prioritaskan halte baru dalam radius 400m dari permukiman padat di Mustika Jaya, dekat sentra industri.",
            "Sediakan jalur pejalan kaki aman dan halte dekat kawasan TPST Bantar Gebang untuk pekerja informal.",
            "Tambahkan armada feeder dari permukiman padat Rawa Lumbu menuju simpul transit terdekat.",
            "Tingkatkan headway pada koridor menuju Bekasi Utara pada jam sibuk pagi dan sore.",
            "Pertahankan kualitas layanan eksisting; fokuskan investasi baru ke kelurahan dengan skor equity lebih rendah.",
        ],
    })


if __name__ == "__main__":
    print("=== 1. Demo Composite Accessibility Index (CAI) — data sintetis ===\n")
    demo = load_demo_data()
    result = compute_cai(demo, DEFAULT_WEIGHTS)

    print(result[[
        "nama_lokasi", "n_kepadatan", "n_jarak_inv", "n_volume", "n_survei", "skor_cai"
    ]].round(3).to_string(index=False))

    print("\n--- Sensitivity analysis CAI (geser tiap bobot ±0.1) ---\n")
    sens = sensitivity_check(demo, DEFAULT_WEIGHTS)
    print(sens.to_string(index=False))

    n_unstable = (sens["jumlah_ranking_berubah"] > 0).sum()
    print(f"\n{n_unstable} dari {len(sens)} skenario pergeseran bobot mengubah ranking.")
    print("Jika sebagian besar 0 -> ranking cukup stabil (robust terhadap pemilihan bobot).")

    print("\n\n=== 2. Demo Transit Desert Index (TDI) — data grid sintetis ===\n")
    demo_grid = load_demo_grid_data()
    tdi_result = compute_tdi(demo_grid, DEFAULT_MOBILITY_WEIGHTS)
    print(tdi_result[[
        "nama_area", "kepadatan_penduduk", "skor_aksesibilitas_transit",
        "indeks_kebutuhan_mobilitas", "tdi_raw", "skor_tdi",
    ]].round(3).to_string(index=False))
    print(
        "\nCatatan: skor_tdi tertinggi = grid paling 'transit desert' — kepadatan "
        "& kebutuhan mobilitas tinggi, tapi aksesibilitas transit rendah."
    )

    print("\n--- Sensitivity analysis TDI (geser bobot Indeks Kebutuhan Mobilitas ±0.1) ---\n")
    sens_tdi = sensitivity_check_tdi(demo_grid, DEFAULT_MOBILITY_WEIGHTS)
    print(sens_tdi.to_string(index=False))
    n_unstable_tdi = (sens_tdi["jumlah_ranking_berubah"] > 0).sum()
    print(f"\n{n_unstable_tdi} dari {len(sens_tdi)} skenario pergeseran bobot mengubah ranking skor_tdi.")

    print("\n\n=== 3. Demo Transit Equity Index — data kelurahan sintetis ===\n")
    demo_equity = load_demo_equity_data()
    equity_result = compute_equity_index(demo_equity, DEFAULT_EQUITY_WEIGHTS)
    print(equity_result[[
        "ranking", "nama_kelurahan", "skor_cai_rata2", "n_aksesibilitas_inv",
        "n_kepadatan", "n_usia_rentan", "n_akses_pendidikan", "n_akses_kesehatan",
        "n_akses_kerja", "skor_final",
    ]].round(3).to_string(index=False))
    print(
        "\nCatatan: ranking 1 = kelurahan paling dirugikan/tertinggal aksesnya "
        "(skor_final tertinggi), sesuai urutan yang ditampilkan EquityIndexView.jsx."
    )

    print("\n--- Sensitivity analysis Equity Index (geser tiap bobot ±0.1) ---\n")
    sens_equity = sensitivity_check_equity(demo_equity, DEFAULT_EQUITY_WEIGHTS)
    print(sens_equity.to_string(index=False))
    n_unstable_equity = (sens_equity["jumlah_ranking_berubah"] > 0).sum()
    print(f"\n{n_unstable_equity} dari {len(sens_equity)} skenario pergeseran bobot mengubah ranking skor_final.")
