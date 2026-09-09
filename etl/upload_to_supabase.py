"""
upload_to_supabase.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Mengunggah hasil compute_scores.py (CAI, TDI, Transit Equity Index) ke
Supabase. Dipakai berulang kali selama periode survei/analisis (7 Agu–6 Sep,
lihat docs/FRAMEWORK_GeoTransitInsight.md Bagian 9), bukan sekali jalan di akhir.

Setup:
    pip install supabase python-dotenv
    export SUPABASE_URL=https://xxxx.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=xxxx   # BUKAN anon key — ini bypass RLS

    [PERINGATAN] Service role key HANYA untuk script ini (server-side),
    JANGAN PERNAH dimasukkan ke frontend/.env atau ke repository git.

Cara pakai:
    python upload_to_supabase.py

Catatan penting soal TDI & Equity Index (beda dengan CAI):
  - upload_tdi_scores() melakukan UPDATE ke tabel grid_analisis, BUKAN insert
    — kolom geom di tabel itu NOT NULL, jadi grid harus sudah dibuat lebih
    dulu lewat build_fishnet_grid.py (belum ditulis, lihat README "Belum
    dikerjakan"). Script ini hanya mengisi kolom skornya.
  - upload_equity_scores() perlu mencocokkan nama_kelurahan ke kelurahan_id
    di tabel batas_administrasi dulu (lookup_kelurahan_ids), baru insert ke
    skor_equity. Kelurahan yang belum ada di batas_administrasi akan
    dilewati (bukan diupload dengan kelurahan_id kosong) supaya tidak ada
    baris skor_equity yang "menggantung" tanpa referensi wilayah.
  - Selama data grid/kelurahan asli belum ada di database, kedua fungsi ini
    akan melewati (skip) baris demo dan mencetak peringatan — ini SENGAJA,
    bukan bug, supaya tidak ada data sampah yang ter-upload.
"""

import os
import sys
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client
from compute_scores import (
    compute_cai,
    compute_tdi,
    compute_equity_index,
    load_demo_data,
    load_demo_grid_data,
    load_demo_equity_data,
    DEFAULT_WEIGHTS,
    DEFAULT_MOBILITY_WEIGHTS,
    DEFAULT_EQUITY_WEIGHTS,
)

# Prefix id_titik_survei untuk 4 titik SINTETIS murni (testing/fallback,
# lihat 007_seed_titik_kandidat_link_cai.sql) — KND-DEMO-001..004.
# recompute_all_cai_scores() SENGAJA mengecualikan baris berpola ini, baik
# dari perhitungan (tidak ikut jadi bagian skala normalisasi min-max) maupun
# dari penulisan ke skor_cai (skor_cai id 1-4 tidak boleh disentuh sama
# sekali oleh fungsi itu). Jangan pernah pakai prefix ini untuk id_titik_survei
# hasil survei lapangan asli.
PREFIX_ID_TITIK_SURVEI_DEMO = "KND-DEMO-"

# Proxy/placeholder untuk recompute_all_cai_scores() — KONSISTEN dengan yang
# sebelumnya dipakai upload_cai_titik_kandidat_batch2.py (lihat penjelasan
# panjang soal alasan tiap nilai di file itu, sekarang di-deprecate).
#
# STATUS 28 Agu 2026 (temuan qa-tester 27 Agu, DIPERBAIKI): KEPADATAN_NEUTRAL_PLACEHOLDER
# dulu dipakai untuk SEMUA 8 titik real (n_kepadatan identik 0.5000 di semua
# baris -> kriteria kepadatan, salah satu berbobot terbesar (0,329 hasil AHP
# 2026-09-03), efektif tidak diskriminatif sama sekali). Sekarang
# recompute_all_cai_scores() menerima parameter opsional
# `kepadatan_by_titik_id` (dict {titik_kandidat_id: kepadatan_penduduk_real})
# — kalau diisi, dipakai menggantikan placeholder ini per baris. Nilai real
# didapat lewat spatial join titik_kandidat ke grid_analisis (lihat
# etl/attach_kepadatan_titik_kandidat.py untuk metodologi lengkap). Placeholder
# ini TETAP dipertahankan sebagai fallback kalau parameter itu tidak diisi
# (perilaku lama, mis. dipanggil tanpa argumen) ATAU untuk titik_kandidat_id
# yang KEBETULAN tidak ada di dict yang dioper (data grid belum menutupi
# lokasi itu) — supaya baris itu tidak error, tapi dicetak sebagai peringatan
# eksplisit (bukan diam-diam).
KEPADATAN_NEUTRAL_PLACEHOLDER = 11650  # PLACEHOLDER: rata-rata kepadatan_penduduk 4 titik demo load_demo_data(), BUKAN data BPS per titik asli

# Sejak 2026-09-07 (keputusan Sam, lihat docs/VALIDASI_BOBOT_AHP.md): untuk
# titik_kandidat REAL (usulan halte baru) kriteria "skor survei lapangan" =
# Form Kondisi Halte atas halte EKSISTING -> TIDAK BERLAKU, bukan "bernilai 0".
# recompute_all_cai_scores(..., exclude_criteria=['survei']) menulis
# skor_cai.n_survei = NULL & bobot_survei = NULL, lalu menormalisasi ulang 3
# bobot AHP sisanya (kepadatan/jarak/volume) supaya berjumlah 1. Konstanta
# lama SKOR_SURVEI_TITIK_BARU = 0.0 sudah TIDAK dipakai untuk titik_kandidat;
# dipertahankan hanya sebagai jejak (jalur 4-kriteria default masih dipakai
# load_demo_data()/sensitivity_check yang memang punya skor survei riil).
SKOR_SURVEI_TITIK_BARU = 0.0  # DEPRECATED untuk titik_kandidat — lihat catatan di atas


def _num_or_none(x, ndigits: int = 4):
    """Bulatkan ke ndigits desimal, atau kembalikan None kalau NaN/None —
    supaya kolom N/A (mis. n_survei / bobot_survei untuk titik_kandidat)
    ditulis sebagai NULL SQL, bukan 0.0 atau 'NaN'."""
    if x is None or pd.isna(x):
        return None
    return round(float(x), ndigits)


# Kolom bobot efektif yang (kalau ada di scored_df hasil compute_cai) ikut
# di-persist ke skor_cai — perlu supaya breakdown CaiScorePanel rekonsiliasi
# dengan skor_final saat bobot dinormalisasi ulang (mode exclude_criteria).
_BOBOT_COLS = ("bobot_kepadatan", "bobot_jarak", "bobot_volume", "bobot_survei")


def _cai_record(row, scored_df) -> dict:
    """Bangun satu record skor_cai dari baris hasil compute_cai().
    NULL-safe untuk kriteria N/A; menyertakan bobot_* hanya kalau
    compute_cai() memang menuliskannya (kompat mundur untuk pemanggil lama)."""
    record = {
        "n_kepadatan": _num_or_none(row["n_kepadatan"]),
        "n_jarak_inv": _num_or_none(row["n_jarak_inv"]),
        "n_volume": _num_or_none(row["n_volume"]),
        "n_survei": _num_or_none(row["n_survei"]),
        "skor_final": _num_or_none(row["skor_cai"]),
    }
    for col in _BOBOT_COLS:
        if col in scored_df.columns:
            record[col] = _num_or_none(row[col])
    return record


def get_client():
    load_dotenv()  # baca etl/.env kalau ada — lihat komentar setup di atas
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print(
            "[PERINGATAN] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset.\n"
            "    Set dulu sebagai environment variable sebelum menjalankan script ini.\n"
            "    Lihat komentar di bagian atas file ini."
        )
        sys.exit(1)
    return create_client(url, key)


def load_weights_from_db(client, nama_index: str, default_weights: dict) -> dict:
    """
    Ambil bobot terbaru dari tabel konfigurasi_bobot (hasil sesi AHP pairwise
    Saaty formal 2026-09-03, migration 018) untuk index tertentu ('CAI',
    'TDI_MOBILITAS', atau 'EQUITY').
    Fallback ke default_weights kalau baris index-nya belum terisi di tabel.
    """
    res = client.table("konfigurasi_bobot").select("*").eq("nama_index", nama_index).execute()
    rows = res.data
    if not rows:
        print(f"Belum ada bobot AHP untuk '{nama_index}' di database, pakai bobot default sementara.")
        return default_weights

    weights = {row["nama_kriteria"]: float(row["bobot"]) for row in rows}
    print(f"Bobot '{nama_index}' dari konfigurasi_bobot: {weights}")
    return weights


def upload_cai_scores(client, scored_df, titik_kandidat_id_col: str = None):
    """
    Push hasil compute_cai() ke tabel skor_cai.

    titik_kandidat_id_col: nama kolom OPSIONAL di scored_df yang berisi FK
    asli ke titik_kandidat.id (mis. hasil lookup dari tabel titik_kandidat
    yang sudah diupload lewat upload_titik_kandidat_data()). Kalau diisi,
    setiap record ikut menyertakan "titik_kandidat_id" itu.

    Default None supaya PERILAKU LAMA TIDAK BERUBAH untuk pemanggilan yang
    belum punya FK asli (mis. load_demo_data() sintetis di __main__ bawah —
    4 baris skor_cai id 1-4 dari situ sengaja dibiarkan titik_kandidat_id
    NULL saat upload, baru disambungkan belakangan lewat migration SQL
    007_seed_titik_kandidat_link_cai.sql). Jalur FK asli langsung saat
    insert (bukan UPDATE terpisah setelahnya) dipakai pertama kali untuk
    8 titik KND-002..009, lihat upload_cai_titik_kandidat_batch2.py.
    """
    records = []
    for _, row in scored_df.iterrows():
        record = _cai_record(row, scored_df)
        if titik_kandidat_id_col is not None:
            record["titik_kandidat_id"] = int(row[titik_kandidat_id_col])
        records.append(record)

    result = client.table("skor_cai").insert(records).execute()
    print(f"Berhasil upload {len(records)} baris skor_cai.")
    return result


def update_cai_scores_by_titik_kandidat_id(client, scored_df, titik_kandidat_id_col: str = "titik_kandidat_id"):
    """
    UPDATE (bukan INSERT) baris skor_cai yang titik_kandidat_id-nya sudah ada,
    dipakai saat data mentah sebuah titik_kandidat DIREVISI (bukan baris baru)
    sehingga skor_final lama harus diganti, bukan dipertahankan atau
    diduplikasi. Dipakai pertama kali untuk revisi KND-002..009 (angka
    Traffic Counting direvisi jauh lebih rendah oleh PIC, 26 Agu 2026 —
    lihat upload_cai_titik_kandidat_batch2.py).

    Beda dengan upload_cai_scores(): fungsi itu selalu INSERT baris baru
    (dipakai untuk titik yang BELUM punya skor_cai). Fungsi ini men-UPDATE
    baris yang match via titik_kandidat_id (FK, bukan skor_cai.id) — jadi
    aman dipanggil berkali-kali (idempotent secara isi, walau bukan
    upsert on_conflict karena skor_cai tidak punya kolom unique selain
    primary key id-nya sendiri).

    Kalau ada titik_kandidat_id di scored_df yang TERNYATA belum punya baris
    skor_cai (harusnya tidak terjadi untuk kasus revisi, tapi dijaga supaya
    tidak diam-diam melewati data), dicetak sebagai peringatan eksplisit
    (bukan auto-insert di sini) supaya pemanggil sadar dan bisa pakai
    upload_cai_scores() untuk baris yang memang baru.
    """
    updated = 0
    tidak_ditemukan = []
    for _, row in scored_df.iterrows():
        tk_id = int(row[titik_kandidat_id_col])
        record = _cai_record(row, scored_df)
        result = (
            client.table("skor_cai")
            .update(record)
            .eq("titik_kandidat_id", tk_id)
            .execute()
        )
        if result.data:
            updated += len(result.data)
        else:
            tidak_ditemukan.append(tk_id)

    if tidak_ditemukan:
        print(
            f"[PERINGATAN] {len(tidak_ditemukan)} titik_kandidat_id tidak punya baris "
            f"skor_cai untuk di-UPDATE (tidak ditemukan): {tidak_ditemukan}. "
            "Pakai upload_cai_scores() (INSERT) untuk baris yang memang baru."
        )
    print(f"Berhasil UPDATE {updated} dari {len(scored_df)} baris skor_cai (revisi, bukan insert baru).")
    return updated


def recompute_all_cai_scores(
    client,
    weights: dict = None,
    kepadatan_by_titik_id: dict = None,
    jarak_fasilitas_by_titik_id: dict = None,
    exclude_criteria: list = None,
    upload: bool = True,
) -> pd.DataFrame:
    """
    FUNGSI STANDAR untuk skor_cai — panggil fungsi ini SETIAP KALI ada
    perubahan data titik_kandidat (upload baru dari MAPID Apps ATAU revisi
    data survei), BUKAN menulis script batch baru tiap kali seperti
    upload_cai_titik_kandidat_batch2.py sebelumnya (sekarang di-deprecate,
    isinya tinggal memanggil fungsi ini — lihat file itu).

    kepadatan_by_titik_id (BARU, 28 Agu 2026): dict opsional
    {titik_kandidat_id: kepadatan_penduduk_real} — kalau diisi, MENGGANTIKAN
    KEPADATAN_NEUTRAL_PLACEHOLDER per baris yang id-nya ada di dict tsb.
    Titik yang id-nya TIDAK ada di dict tetap pakai placeholder (dicetak
    sebagai peringatan eksplisit) supaya baris itu tidak diam-diam kosong.
    Default None -> perilaku lama tidak berubah (semua baris pakai placeholder).
    Lihat etl/attach_kepadatan_titik_kandidat.py untuk cara menyusun dict ini
    dari spatial join ke grid_analisis (dasymetric real).

    exclude_criteria (BARU, 2026-09-07): diteruskan apa adanya ke
    compute_cai(). Untuk titik_kandidat REAL dipanggil dengan
    ['survei'] -> kriteria "skor survei lapangan" (Form Kondisi Halte
    halte EKSISTING) diperlakukan N/A: skor_cai.n_survei & bobot_survei
    ditulis NULL, 3 bobot AHP sisanya (kepadatan/jarak/volume)
    dinormalisasi ulang ke jumlah 1, skor_cai jadi WLC 3 kriteria.
    Alasan: lokasi usulan halte baru belum punya halte untuk dinilai —
    memberi 0 membuat term berbobot 0,1418 jadi beban mati seragam yang
    menekan skor absolut semua kandidat. Keputusan Sam 2026-09-07
    (docs/VALIDASI_BOBOT_AHP.md), bukan perubahan bobot AHP kanonik.
    Default None -> perilaku lama 4 kriteria tidak berubah.

    jarak_fasilitas_by_titik_id (BARU, 7 Sep 2026): dict opsional
    {titik_kandidat_id: jarak_ke_POI_fasilitas_umum_terdekat_m} — kalau diisi,
    MENGGANTIKAN proxy lama `jarak_fasilitas_m <- jarak_transit_terdekat_m` per
    baris yang id-nya ada di dict. Proxy lama itu memakai kolom Excel
    hand-typed `jarak_transit_terdekat_m` yang semantiknya TIDAK KONSISTEN
    antar batch survei (KND-002..009 mencatat "jarak ke transit apa saja"
    20–350 m; KND-010..023 mencatat angka bulat 3000–8000 m) sehingga
    n_jarak_inv terbelah ekstrem antar batch. PRD Bab 7.3 mendefinisikan
    kriteria ini sebagai "Jarak ke fasilitas umum (inverse) — POI
    OpenStreetMap / Menu Go, ST_Distance", jadi menghitungnya dari geom
    membawa pipeline SESUAI spec (bukan perubahan metodologi). Titik yang
    id-nya TIDAK ada di dict jatuh kembali ke `jarak_transit_terdekat_m`
    (dicetak sebagai peringatan). Default None -> perilaku lama tidak berubah.
    Lihat etl/attach_cai_features_titik_kandidat.py untuk cara menyusun dict
    ini dari sjoin_nearest titik_kandidat -> poi (EPSG:32748).

    upload (BARU, 28 Agu 2026): kalau False, fungsi ini HANYA menghitung
    (compute_cai()) dan mengembalikan DataFrame, TIDAK menulis apa pun ke
    Supabase — dipakai untuk preview/dry-run sebelum commit perubahan.
    Default True supaya pemanggil lama (mis. upload_cai_titik_kandidat_batch2.py,
    __main__ file ini) yang tidak mengoper argumen ini tetap berperilaku
    identik dengan sebelumnya (selalu upload).

    MASALAH YANG DIPERBAIKI (lihat permintaan Sam 26 Agu 2026): compute_cai()
    melakukan normalisasi min-max (normalize_min_max() di compute_scores.py)
    — skala 0-1 tiap kriteria ditentukan dari min/max KELOMPOK BARIS yang
    dimasukkan ke fungsi itu SEKALIGUS. Pola lama (hitung compute_cai() cuma
    untuk baris yang baru diupload sesi itu, mis. upload_cai_scores() satu
    batch kecil per sesi) membuat skala pembanding beda-beda antar sesi
    upload -> skor_cai dari batch berbeda TIDAK sebanding satu sama lain,
    walau sama-sama disebut "skor_cai". Fungsi ini menyelesaikannya dengan
    SELALU menghitung ulang SELURUH titik_kandidat REAL sebagai satu
    kelompok normalisasi yang sama setiap kali dipanggil, lalu UPSERT
    hasilnya ke skor_cai (bukan insert buta) — jadi aman dipanggil berkali-
    kali ke depan tanpa membuat skala tambal-sulam atau baris duplikat.

    KENAPA KND-DEMO-001..004 DIKECUALIKAN TOTAL (bukan sekadar "kebetulan
    tidak berubah", tapi sengaja tidak pernah ikut dihitung ATAU ditulis):
      - Keempatnya titik SINTETIS murni untuk testing/fallback, dibuat lewat
        007_seed_titik_kandidat_link_cai.sql — bukan hasil survei lapangan
        asli. Kalau ikut campur dalam normalisasi min/max bersama titik
        REAL, skala CAI titik real akan ikut bergeser mengikuti angka
        rekaan yang tidak merepresentasikan kondisi Kota Bekasi sesungguhnya.
      - Baris skor_cai id 1-4 (yang FK-nya menunjuk ke 4 titik demo ini)
        TIDAK PERNAH disentuh oleh fungsi ini — filter id_titik_survei
        dengan prefix PREFIX_ID_TITIK_SURVEI_DEMO dilakukan SEBELUM baris
        mana pun masuk ke compute_cai() atau ke query upsert skor_cai.

    Proxy 4 input mentah compute_cai() — KONSISTEN dengan yang dipakai
    upload_cai_titik_kandidat_batch2.py sebelumnya (lihat docstring panjang
    di file itu untuk alasan tiap pilihan):
      - kepadatan_penduduk = KEPADATAN_NEUTRAL_PLACEHOLDER (~11650, konstan
        untuk semua baris) — PLACEHOLDER MURNI, BUKAN data BPS per titik
        asli (granularitas BPS baru sebatas kecamatan/kelurahan). Karena
        nilainya sama di semua baris, normalize_min_max() otomatis
        mengembalikan 0.5 (hi==lo) untuk n_kepadatan semua titik real ->
        kriteria ini (salah satu bobot terbesar, 0,329 hasil AHP 2026-09-03
        di DEFAULT_WEIGHTS / konfigurasi_bobot) efektif TIDAK membedakan
        ranking sampai ada data BPS per titik.
      - jarak_fasilitas_m  <- jarak_transit_terdekat_m (semantik CAI aslinya
        "jarak ke fasilitas umum"; titik_kandidat tidak punya kolom
        terpisah untuk itu, jadi dipakai jarak ke transit terdekat).
      - volume_penumpang   <- total_aktivitas (naik+turun+pejalan kaki,
        Form Traffic Counting — proksi kasar, BUKAN data penumpang transit
        resmi).
      - skor_survei = SKOR_SURVEI_TITIK_BARU (0.0, BUKAN 0.5 netral) —
        titik kandidat baru belum punya infrastruktur transit eksisting
        untuk dinilai lewat Form Kondisi Halte.

    Bobot: kalau `weights` tidak diisi, pakai DEFAULT_WEIGHTS dari
    compute_scores.py — sekarang = bobot AHP pairwise Saaty final
    (sesi 2026-09-03, migration 018), salinan fallback dari tabel
    konfigurasi_bobot. Pemanggil sebaiknya tetap mengoper hasil
    load_weights_from_db(client, "CAI", DEFAULT_WEIGHTS) supaya membaca
    langsung dari DB (rujukan tunggal).

    UPSERT (aman dipanggil berulang kali): titik_kandidat_id yang SUDAH
    punya baris skor_cai -> UPDATE lewat update_cai_scores_by_titik_kandidat_id().
    titik_kandidat_id yang BELUM punya -> INSERT baru lewat upload_cai_scores().

    Return: DataFrame hasil compute_cai() untuk seluruh titik real (terurut
    skor_cai menurun) — dipakai pemanggil untuk verifikasi/print, TIDAK
    berisi baris KND-DEMO-*.
    """
    weights = weights or DEFAULT_WEIGHTS

    res = (
        client.table("titik_kandidat")
        .select("id, id_titik_survei, deskripsi_lokasi, total_aktivitas, jarak_transit_terdekat_m")
        .execute()
    )
    rows = [
        r for r in res.data
        if not str(r["id_titik_survei"]).startswith(PREFIX_ID_TITIK_SURVEI_DEMO)
    ]

    if not rows:
        print(
            "[PERINGATAN] recompute_all_cai_scores: tidak ada baris titik_kandidat REAL "
            f"(non {PREFIX_ID_TITIK_SURVEI_DEMO}*) ditemukan di database — tidak ada yang dihitung."
        )
        return pd.DataFrame()

    df = pd.DataFrame(rows).rename(columns={"id": "titik_kandidat_id"})
    # Proxy kolom mentah compute_cai() — lihat penjelasan lengkap di docstring atas.
    df["volume_penumpang"] = df["total_aktivitas"]

    if jarak_fasilitas_by_titik_id is not None:
        df["jarak_fasilitas_m"] = df["titik_kandidat_id"].map(jarak_fasilitas_by_titik_id)
        n_missing_jarak = df["jarak_fasilitas_m"].isna().sum()
        if n_missing_jarak:
            missing_ids = df.loc[df["jarak_fasilitas_m"].isna(), "titik_kandidat_id"].tolist()
            print(
                f"[PERINGATAN] {n_missing_jarak} titik_kandidat_id tidak ada di "
                f"jarak_fasilitas_by_titik_id -> fallback ke jarak_transit_terdekat_m "
                f"(kolom Excel hand-typed, semantik tidak konsisten) untuk baris itu saja: {missing_ids}"
            )
        df["jarak_fasilitas_m"] = df["jarak_fasilitas_m"].fillna(df["jarak_transit_terdekat_m"])
    else:
        # PROXY LAMA: kolom Excel hand-typed jarak_transit_terdekat_m (semantik
        # tidak konsisten antar batch survei) — dipertahankan sebagai fallback
        # kalau pemanggil tidak mengoper jarak_fasilitas_by_titik_id.
        df["jarak_fasilitas_m"] = df["jarak_transit_terdekat_m"]

    if kepadatan_by_titik_id is not None:
        df["kepadatan_penduduk"] = df["titik_kandidat_id"].map(kepadatan_by_titik_id)
        n_missing = df["kepadatan_penduduk"].isna().sum()
        if n_missing:
            missing_ids = df.loc[df["kepadatan_penduduk"].isna(), "titik_kandidat_id"].tolist()
            print(
                f"[PERINGATAN] {n_missing} titik_kandidat_id tidak ada di kepadatan_by_titik_id "
                f"(grid_analisis belum menutupi lokasi itu) -> pakai KEPADATAN_NEUTRAL_PLACEHOLDER "
                f"untuk baris itu saja: {missing_ids}"
            )
        df["kepadatan_penduduk"] = df["kepadatan_penduduk"].fillna(KEPADATAN_NEUTRAL_PLACEHOLDER)
    else:
        df["kepadatan_penduduk"] = KEPADATAN_NEUTRAL_PLACEHOLDER  # PLACEHOLDER, lihat docstring

    if exclude_criteria and "survei" in exclude_criteria:
        # 'survei' N/A untuk titik_kandidat -> compute_cai() akan menulis
        # n_survei = NaN sendiri; kolom skor_survei tidak dipakai, tapi
        # tetap disiapkan (NaN) supaya df punya bentuk kolom konsisten.
        df["skor_survei"] = float("nan")
    else:
        df["skor_survei"] = SKOR_SURVEI_TITIK_BARU  # PLACEHOLDER, lihat docstring
    df["nama_lokasi"] = df["deskripsi_lokasi"]  # keterbacaan print/debug saja

    # SATU pemanggilan compute_cai() untuk seluruh baris real sekaligus —
    # inilah yang membuat skala normalisasi konsisten lintas-batch (lihat
    # docstring "MASALAH YANG DIPERBAIKI" di atas), bukan per-sesi-upload.
    scored = compute_cai(df, weights, exclude_criteria=exclude_criteria)

    if not upload:
        print(
            f"[DRY-RUN] recompute_all_cai_scores: {len(scored)} titik_kandidat REAL dihitung "
            "(upload=False), TIDAK ada perubahan ditulis ke skor_cai."
        )
        return scored

    target_ids = scored["titik_kandidat_id"].tolist()
    existing_res = (
        client.table("skor_cai")
        .select("titik_kandidat_id")
        .in_("titik_kandidat_id", target_ids)
        .execute()
    )
    ids_with_existing = {r["titik_kandidat_id"] for r in existing_res.data}

    to_update = scored[scored["titik_kandidat_id"].isin(ids_with_existing)]
    to_insert = scored[~scored["titik_kandidat_id"].isin(ids_with_existing)]

    print(
        f"recompute_all_cai_scores: {len(scored)} titik_kandidat REAL dihitung ulang sebagai "
        f"SATU batch gabungan ({len(to_update)} UPDATE skor_cai lama, {len(to_insert)} INSERT baru). "
        f"KND-DEMO-* dikecualikan total dari perhitungan ini."
    )

    if not to_update.empty:
        update_cai_scores_by_titik_kandidat_id(client, to_update, titik_kandidat_id_col="titik_kandidat_id")
    if not to_insert.empty:
        upload_cai_scores(client, to_insert, titik_kandidat_id_col="titik_kandidat_id")

    return scored


def upload_tdi_scores(client, scored_df):
    """
    Update kolom skor TDI di tabel grid_analisis untuk grid yang sudah ada.

    scored_df wajib punya kolom 'grid_analisis_id' (id asli baris grid_analisis
    di database, BUKAN 'grid_id' string dari data demo) supaya tahu baris mana
    yang harus diupdate — geom grid tidak dibuat ulang di sini, hanya skornya.

    TODO: setelah build_fishnet_grid.py ditulis dan grid_analisis terisi geom,
    hasilkan kolom 'grid_analisis_id' dengan spatial join grid demo/asli ke
    grid_analisis (mis. berdasarkan kolom grid_id yang disimpan bersama geom).
    """
    if "grid_analisis_id" not in scored_df.columns:
        print(
            "[DILEWATI] upload_tdi_scores: kolom 'grid_analisis_id' tidak ada di data — "
            "grid_analisis belum bisa diisi karena geom-nya belum dibuat "
            "(build_fishnet_grid.py belum ada). Jalankan fishnet grid dulu, "
            "lalu petakan grid_id demo/asli ke id baris grid_analisis sebelum upload."
        )
        return None

    updated = 0
    for _, row in scored_df.iterrows():
        result = (
            client.table("grid_analisis")
            .update({
                "kepadatan_penduduk": round(row["kepadatan_penduduk"], 2),
                "indeks_kebutuhan_mobilitas": round(row["indeks_kebutuhan_mobilitas"], 4),
                "skor_aksesibilitas_transit": round(row["skor_aksesibilitas_transit"], 4),
                "skor_tdi": round(row["skor_tdi"], 4),
            })
            .eq("id", row["grid_analisis_id"])
            .execute()
        )
        updated += len(result.data)

    print(f"Berhasil update {updated} dari {len(scored_df)} baris grid_analisis (skor TDI).")
    return updated


def load_halte_survey_excel(path: str, sheet_name: str = "Form Kondisi Halte") -> list:
    """
    Baca hasil Form Kondisi Halte dari file Excel instrumen survei
    (docs/../etl/data/survei/Instrumen_Survei_GeoTransitInsight.xlsx atau
    sejenis) dan kembalikan list of dict siap dipetakan ke tabel
    halte_eksisting.

    Struktur sheet (lihat sheet "Petunjuk" di file yang sama):
      - Baris 1: header kolom
      - Baris 2: instruksi pengisian tiap kolom (bukan data — dilewati)
      - Baris 3: CONTOH pengisian (bukan data survei asli — dilewati)
      - Baris 4 dst: data survei asli, satu baris per titik, berhenti di
        baris pertama yang kolom "ID Halte"-nya kosong.

    Kolom O/R/T/U (skor_kelengkapan_fisik, skor_headway, skor_okupansi,
    skor_survei_gabungan) adalah kolom FORMULA Excel (lihat sheet Petunjuk):
        O = IFERROR(COUNTIF(checklist,"Ya")/5, "")
        R = IFERROR(MIN(1, headway_ideal/headway_aktual), "")
        T = IFERROR(okupansi_persen/100, "")
        U = IFERROR(0,4*O + 0,35*R + 0,25*T, "")
    openpyxl tidak menjalankan formula Excel, jadi nilai cache-nya bisa
    kosong kalau file pernah disave lewat openpyxl tanpa dibuka Excel/
    LibreOffice dulu (formula string-nya tetap ada, cuma cache-nya hilang).
    Untuk keandalan, keempat skor ini DIHITUNG ULANG di sini langsung dari
    kolom mentah (checklist J-N, headway P/Q, okupansi S) memakai formula
    yang identik — bukan dibaca dari cache — supaya hasilnya konsisten
    apa pun status cache filenya.

    GUARD ID DUPLIKAT (ditambahkan 28 Agustus 2026): ditemukan `HLT-001`
    terpakai untuk 2 baris berbeda ("Halte Summarecon Bekasi" &
    "Halte Simpang Pekayon") di file instrumen survei asli. Kalau ini
    lolos tanpa dicek, `upload_halte_data()` (upsert
    `on_conflict='id_halte_survei'`) akan diam-diam MENIMPA salah satu
    titik dengan titik lain — baris terakhir menang, baris pertama HILANG
    tanpa peringatan apa pun. Fungsi ini SEKARANG memindai seluruh ID
    Halte lebih dulu dan **raise ValueError + hentikan total (0 baris
    diproses)** kalau ada ID yang muncul >1 kali, supaya siapa pun yang
    menjalankan ETL ini sadar perlu ID unik dari tim survei dulu — bukan
    sistem yang menebak/mendiamkan salah satu titik dianggap "kalah".
    File Excel sumber TIDAK BOLEH diedit langsung oleh ETL ini (itu jejak
    audit data lapangan asli tim survei) — perbaikan ID unik harus datang
    dari tim survei sendiri.
    """
    import openpyxl
    from collections import defaultdict

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet_name]

    # --- Pemindaian pertama: kumpulkan semua ID Halte + baris asalnya,
    # SEBELUM baris mana pun difilter/diproses, supaya duplikat tetap
    # terdeteksi walau salah satu baris duplikatnya kebetulan tidak
    # punya koordinat (kasus HLT-001 di atas: baris pertama ada
    # koordinat, baris kedua kosong — kalau cek duplikat dilakukan
    # SETELAH filter lat/lon kosong, duplikat ini akan lolos tak
    # terdeteksi karena baris kedua sudah lebih dulu disingkirkan).
    #
    # Sengaja mulai dari baris 3 (bukan 4): di praktiknya baris 3 — yang
    # menurut desain instrumen seharusnya "CONTOH" placeholder — di file
    # ini justru berisi data yang terlihat seperti entri asli (nama
    # surveyor & tanggal survei terisi, bukan teks contoh generik).
    # Konvensi loop produksi di bawah TETAP mulai dari baris 4 (perilaku
    # lama, tidak diubah — memutuskan apakah baris 3 boleh ikut jadi
    # data upload sungguhan adalah keputusan tim survei, bukan wewenang
    # ETL ini). Tapi untuk DETEKSI DUPLIKAT saja, baris 3 tetap harus
    # ikut dipindai — kalau tidak, tabrakan ID persis seperti kasus
    # HLT-001 (baris 3 vs baris 4) tidak akan pernah terlihat oleh guard
    # ini sama sekali.
    id_to_rows = defaultdict(list)
    scan_row = 3
    while True:
        raw_id = ws.cell(row=scan_row, column=1).value
        if raw_id is None:
            break
        id_to_rows[str(raw_id)].append((
            scan_row,
            ws.cell(row=scan_row, column=2).value,  # Nama Halte / Titik
            ws.cell(row=scan_row, column=3).value,  # Kecamatan
            ws.cell(row=scan_row, column=4).value,  # Kelurahan
        ))
        scan_row += 1

    duplikat = {k: v for k, v in id_to_rows.items() if len(v) > 1}
    if duplikat:
        detail = []
        for dup_id, rows in duplikat.items():
            baris_desc = "; ".join(
                f"baris {r} ('{nama}', kec. {kec}/kel. {kel})"
                for r, nama, kec, kel in rows
            )
            detail.append(f"  - ID Halte '{dup_id}' muncul {len(rows)}x: {baris_desc}")
        raise ValueError(
            "GAGAL memuat 'Form Kondisi Halte': ditemukan ID Halte DUPLIKAT di "
            f"'{path}' (sheet '{sheet_name}'). ETL DIHENTIKAN TOTAL — 0 baris "
            "diproses/diupload — supaya upsert on_conflict='id_halte_survei' "
            "TIDAK diam-diam menimpa salah satu titik dengan titik lainnya.\n"
            + "\n".join(detail)
            + "\n\nTINDAK LANJUT: file sumber ini TIDAK BOLEH diedit oleh ETL "
              "(jejak audit data lapangan tim survei) — minta tim survei "
              "memberi ID UNIK untuk tiap baris di atas (mis. ID kedua jadi "
              "'HLT-001b' atau nomor urut baru yang belum dipakai), baru "
              "jalankan ulang ETL ini."
        )

    records = []
    row_num = 4  # baris 1=header, 2=instruksi, 3=contoh -> data asli mulai baris 4
    while True:
        id_halte = ws.cell(row=row_num, column=1).value
        if id_halte is None:
            break

        lat = ws.cell(row=row_num, column=5).value
        lon = ws.cell(row=row_num, column=6).value
        if lat is None or lon is None:
            print(f"[DILEWATI] Baris {row_num} ({id_halte}): Latitude/Longitude kosong.")
            row_num += 1
            continue

        tanggal = ws.cell(row=row_num, column=8).value
        tanggal_iso = None
        if tanggal:
            # Kolom bisa berupa datetime (Excel date) atau string 'DD/MM/YYYY'
            if hasattr(tanggal, "strftime"):
                tanggal_iso = tanggal.strftime("%Y-%m-%d")
            else:
                try:
                    d, m, y = str(tanggal).split("/")
                    tanggal_iso = f"{y}-{int(m):02d}-{int(d):02d}"
                except ValueError:
                    print(f"[PERINGATAN] Baris {row_num}: format tanggal '{tanggal}' tidak dikenali, disimpan null.")

        # Checklist fisik (kolom J-N): Papan Nama, Atap/Naungan, Tempat Duduk,
        # Akses Difabel, Penerangan — masing-masing 'Ya'/'Tidak'.
        checklist = [ws.cell(row=row_num, column=c).value for c in range(10, 15)]
        skor_kelengkapan_fisik = sum(1 for v in checklist if str(v).strip().lower() == "ya") / 5

        headway_aktual = ws.cell(row=row_num, column=16).value
        headway_ideal = ws.cell(row=row_num, column=17).value
        skor_headway = min(1.0, headway_ideal / headway_aktual) if headway_aktual else None

        okupansi_persen = ws.cell(row=row_num, column=19).value
        skor_okupansi = (okupansi_persen / 100) if okupansi_persen is not None else None

        skor_survei_gabungan = None
        if skor_headway is not None and skor_okupansi is not None:
            skor_survei_gabungan = (
                0.4 * skor_kelengkapan_fisik + 0.35 * skor_headway + 0.25 * skor_okupansi
            )

        records.append({
            "id_halte_survei": str(id_halte),
            "nama": ws.cell(row=row_num, column=2).value,
            "geom": f"SRID=4326;POINT({lon} {lat})",
            "kecamatan": ws.cell(row=row_num, column=3).value,
            "kelurahan": ws.cell(row=row_num, column=4).value,
            "skor_kelengkapan_fisik": round(skor_kelengkapan_fisik, 3),
            "headway_aktual_menit": headway_aktual,
            "headway_ideal_menit": headway_ideal,
            "skor_headway": round(skor_headway, 3) if skor_headway is not None else None,
            "okupansi_persen": okupansi_persen,
            "skor_okupansi": round(skor_okupansi, 3) if skor_okupansi is not None else None,
            "skor_survei_gabungan": round(skor_survei_gabungan, 3) if skor_survei_gabungan is not None else None,
            "tanggal_survei": tanggal_iso,
            "nama_surveyor": ws.cell(row=row_num, column=7).value,
            "foto_url": ws.cell(row=row_num, column=23).value,
            "catatan": ws.cell(row=row_num, column=24).value,
        })
        row_num += 1

    print(f"Dibaca {len(records)} baris data survei halte asli dari '{path}' (baris 4-{row_num - 1}).")
    return records


def upload_halte_data(client, records: list):
    """
    Upload hasil load_halte_survey_excel() ke tabel halte_eksisting.
    Pakai upsert on_conflict='id_halte_survei' supaya aman dijalankan
    berulang kali (re-run setelah data survei direvisi) tanpa duplikat.

    GUARD tambahan (defense-in-depth, 28 Agustus 2026): cek ulang
    `id_halte_survei` duplikat di `records` di sini juga — bukan cuma
    di load_halte_survey_excel(). Kalau suatu saat `records` dibangun
    dari jalur lain (mis. digabung manual dengan
    koordinat_halte_koridor_biskita.csv) yang tidak lewat guard loader
    di atas, upsert on_conflict='id_halte_survei' TETAP tidak boleh
    diam-diam menimpa satu baris dengan baris lain tanpa peringatan.
    """
    if records:
        seen = {}
        dup_ids = set()
        for r in records:
            rid = r.get("id_halte_survei")
            if rid in seen:
                dup_ids.add(rid)
            seen[rid] = r
        if dup_ids:
            raise ValueError(
                "GAGAL upload halte_eksisting: ditemukan id_halte_survei "
                f"DUPLIKAT di 'records' ({sorted(dup_ids)}). Upload DIBATALKAN "
                "total supaya upsert tidak diam-diam menimpa satu baris dengan "
                "baris lain — beri ID unik dulu sebelum upload."
            )

    if not records:
        print("Tidak ada baris halte_eksisting yang diupload (records kosong).")
        return None

    result = client.table("halte_eksisting").upsert(records, on_conflict="id_halte_survei").execute()
    print(f"Berhasil upload/update {len(records)} baris halte_eksisting.")
    return result


def load_traffic_counting_excel(path: str, sheet_name: str = "Form Traffic Counting") -> list:
    """
    Baca hasil Form Traffic Counting dari file Excel instrumen survei dan
    kembalikan list of dict siap dipetakan ke tabel titik_kandidat.
    Pola persis load_halte_survey_excel() di atas — baca komentarnya untuk
    alasan detail (baris header/instruksi/contoh, recompute formula, dll).

    Struktur sheet:
      - Baris 1: header kolom
      - Baris 2: instruksi pengisian tiap kolom (bukan data — dilewati)
      - Baris 3: CONTOH pengisian (id 'KND-001', surveyor 'Galuh Eka Permana' —
        bukan data survei asli — dilewati)
      - Baris 4 dst: data survei asli, satu baris per titik, berhenti di
        baris pertama yang kolom "ID Titik"-nya kosong.

    Kolom P (Total Aktivitas Teramati) adalah kolom FORMULA Excel:
        =IFERROR(SUM(naik, turun, pejalan_kaki), "")
    Sama seperti load_halte_survey_excel(), openpyxl tidak menjalankan
    formula Excel jadi nilai cache-nya tidak diandalkan — total_aktivitas
    DIHITUNG ULANG di sini langsung dari kolom mentah (Jumlah Naik +
    Jumlah Turun + Jumlah Pejalan Kaki), bukan dibaca dari cache.

    CATATAN STATUS DATA (penting untuk siapa pun yang query titik_kandidat):
    untuk baris yang kolom Catatan Tambahan-nya sudah diberi prefix
    '[ESTIMASI 2 JAM]' oleh tim survei, kolom Jumlah Naik/Turun, Jumlah
    Pejalan Kaki, Kondisi Penyeberangan, dan Jarak ke Transit Eksisting
    Terdekat adalah ESTIMASI AWAL, BUKAN hasil observasi lapangan aktual
    (lihat catatan eksplisit di baris 13 sheet ini) — akan diganti kalau
    data lapangan asli tersedia. Teks catatan itu disalin APA ADANYA
    (termasuk prefix-nya) ke kolom 'catatan', tidak diringkas/dihapus, biar
    status data ini tetap terlihat oleh siapa pun yang query tabel nanti.
    """
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet_name]

    records = []
    row_num = 4  # baris 1=header, 2=instruksi, 3=contoh -> data asli mulai baris 4
    while True:
        id_titik = ws.cell(row=row_num, column=1).value
        if id_titik is None:
            break

        lat = ws.cell(row=row_num, column=5).value
        lon = ws.cell(row=row_num, column=6).value
        if lat is None or lon is None:
            print(f"[DILEWATI] Baris {row_num} ({id_titik}): Latitude/Longitude kosong.")
            row_num += 1
            continue

        tanggal = ws.cell(row=row_num, column=8).value
        tanggal_iso = None
        if tanggal:
            # Kolom bisa berupa datetime (Excel date) atau string 'DD/MM/YYYY'
            if hasattr(tanggal, "strftime"):
                tanggal_iso = tanggal.strftime("%Y-%m-%d")
            else:
                try:
                    d, m, y = str(tanggal).split("/")
                    tanggal_iso = f"{y}-{int(m):02d}-{int(d):02d}"
                except ValueError:
                    print(f"[PERINGATAN] Baris {row_num}: format tanggal '{tanggal}' tidak dikenali, disimpan null.")

        naik = ws.cell(row=row_num, column=10).value or 0
        turun = ws.cell(row=row_num, column=11).value or 0
        pejalan_kaki = ws.cell(row=row_num, column=12).value or 0
        total_aktivitas = naik + turun + pejalan_kaki

        records.append({
            "id_titik_survei": str(id_titik),
            "deskripsi_lokasi": ws.cell(row=row_num, column=2).value,
            "geom": f"SRID=4326;POINT({lon} {lat})",
            "kecamatan": ws.cell(row=row_num, column=3).value,
            "kelurahan": ws.cell(row=row_num, column=4).value,
            "total_aktivitas": total_aktivitas,
            "kondisi_trotoar": ws.cell(row=row_num, column=13).value,
            "kondisi_penyeberangan": ws.cell(row=row_num, column=14).value,
            "jarak_transit_terdekat_m": ws.cell(row=row_num, column=15).value,
            "tanggal_survei": tanggal_iso,
            "nama_surveyor": ws.cell(row=row_num, column=7).value,
            "catatan": ws.cell(row=row_num, column=17).value,
        })
        row_num += 1

    print(f"Dibaca {len(records)} baris data survei titik kandidat asli dari '{path}' (baris 4-{row_num - 1}).")
    return records


def upload_titik_kandidat_data(client, records: list):
    """
    Upload hasil load_traffic_counting_excel() ke tabel titik_kandidat.
    Pakai upsert on_conflict='id_titik_survei' supaya aman dijalankan
    berulang kali (re-run setelah data survei direvisi/estimasi diganti
    hasil observasi lapangan asli) tanpa duplikat.
    """
    if not records:
        print("Tidak ada baris titik_kandidat yang diupload (records kosong).")
        return None

    result = client.table("titik_kandidat").upsert(records, on_conflict="id_titik_survei").execute()
    print(f"Berhasil upload/update {len(records)} baris titik_kandidat.")
    return result


def lookup_kelurahan_ids(client, nama_kelurahan_list: list) -> dict:
    """
    Cocokkan nama_kelurahan -> id di tabel batas_administrasi.
    Return dict {nama_kelurahan: id}; nama yang tidak ditemukan tidak ikut
    di dict hasil (ditangani sebagai skip, bukan error, oleh pemanggil).
    """
    res = (
        client.table("batas_administrasi")
        .select("id, nama_kelurahan")
        .in_("nama_kelurahan", nama_kelurahan_list)
        .execute()
    )
    return {row["nama_kelurahan"]: row["id"] for row in res.data}


def upload_equity_scores(client, scored_df):
    """
    Push hasil compute_equity_index() ke tabel skor_equity.
    Mencocokkan nama_kelurahan ke kelurahan_id lebih dulu lewat
    lookup_kelurahan_ids() — kelurahan yang belum ada di batas_administrasi
    dilewati (bukan diupload tanpa kelurahan_id) supaya skor_equity tidak
    punya baris yang tidak bisa ditelusuri ke wilayahnya.
    """
    id_map = lookup_kelurahan_ids(client, scored_df["nama_kelurahan"].tolist())

    records = []
    dilewati = []
    for _, row in scored_df.iterrows():
        kelurahan_id = id_map.get(row["nama_kelurahan"])
        if kelurahan_id is None:
            dilewati.append(row["nama_kelurahan"])
            continue
        records.append({
            "kelurahan_id": kelurahan_id,
            "skor_cai_rata2": round(row["skor_cai_rata2"], 4),
            "n_aksesibilitas_inv": round(row["n_aksesibilitas_inv"], 4),
            "n_kepadatan": round(row["n_kepadatan"], 4),
            "n_usia_rentan": round(row["n_usia_rentan"], 4),
            "n_akses_pendidikan": round(row["n_akses_pendidikan"], 4),
            "n_akses_kesehatan": round(row["n_akses_kesehatan"], 4),
            "n_akses_kerja": round(row["n_akses_kerja"], 4),
            "skor_final": round(row["skor_final"], 4),
            "ranking": int(row["ranking"]),
            # Kolom deskriptif (005_equity_kelompok_rekomendasi.sql) — narasi hasil
            # analisis tim, bukan skor. Opsional: kalau scored_df tidak punya kolom
            # ini (data lama sebelum load_demo_equity_data() diupdate), kirim None
            # supaya Postgres pakai default/null, bukan error KeyError di sini.
            "kelompok_terdampak": row["kelompok_terdampak"] if "kelompok_terdampak" in scored_df.columns else None,
            "rekomendasi_intervensi": row["rekomendasi_intervensi"] if "rekomendasi_intervensi" in scored_df.columns else None,
        })

    if dilewati:
        print(
            f"[DILEWATI] {len(dilewati)} kelurahan tidak ditemukan di batas_administrasi, "
            f"tidak diupload: {', '.join(dilewati)}. Pastikan 001_init_tables.sql sudah "
            "diisi data batas administrasi Kota Bekasi sebelum upload equity index."
        )

    if not records:
        print("Tidak ada baris skor_equity yang diupload (semua kelurahan tidak ditemukan).")
        return None

    result = client.table("skor_equity").insert(records).execute()
    print(f"Berhasil upload {len(records)} baris skor_equity.")
    return result


if __name__ == "__main__":
    client = get_client()

    print("=== 1. Composite Accessibility Index (CAI) ===")
    cai_weights = load_weights_from_db(client, "CAI", DEFAULT_WEIGHTS)
    # TODO: ganti load_demo_data() dengan load data asli dari data/processed/
    cai_df = load_demo_data()
    cai_scored = compute_cai(cai_df, cai_weights)
    print(cai_scored[["nama_lokasi", "skor_cai"]].round(3).to_string(index=False))
    upload_cai_scores(client, cai_scored)

    print("\n=== 2. Transit Desert Index (TDI) ===")
    mobility_weights = load_weights_from_db(client, "TDI_MOBILITAS", DEFAULT_MOBILITY_WEIGHTS)
    # TODO: ganti load_demo_grid_data() dengan hasil build_fishnet_grid.py + overlay asli
    tdi_df = load_demo_grid_data()
    tdi_scored = compute_tdi(tdi_df, mobility_weights)
    print(tdi_scored[["nama_area", "skor_tdi"]].round(3).to_string(index=False))
    upload_tdi_scores(client, tdi_scored)

    print("\n=== 3. Transit Equity Index ===")
    equity_weights = load_weights_from_db(client, "EQUITY", DEFAULT_EQUITY_WEIGHTS)
    # TODO: ganti load_demo_equity_data() dengan agregasi skor_cai per kelurahan asli
    equity_df = load_demo_equity_data()
    equity_scored = compute_equity_index(equity_df, equity_weights)
    print(equity_scored[["ranking", "nama_kelurahan", "skor_final"]].round(3).to_string(index=False))
    upload_equity_scores(client, equity_scored)
