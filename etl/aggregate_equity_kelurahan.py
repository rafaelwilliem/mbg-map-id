"""
aggregate_equity_kelurahan.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Hitung compute_equity_index() untuk 56 kelurahan RBI ASLI (batas_administrasi,
sumber=SUMBER_BATAS_RESMI), lalu UPLOAD ke skor_equity — ADDITIVE, berdampingan
dengan 5 baris dummy lama (FK ke 6 kelurahan bbox kasar 006_seed_dummy_data.sql,
TIDAK disentuh sama sekali oleh script ini).

Kenapa perlu script terpisah (bukan pakai load_demo_equity_data() +
upload_equity_scores() apa adanya): compute_equity_index() butuh 6 kolom
mentah PER KELURAHAN (kepadatan_penduduk, skor_cai_rata2, proporsi_usia_rentan,
jarak_rata2_pendidikan_m, jarak_rata2_kesehatan_m, jarak_rata2_kerja_m) yang
sebelum ini belum ada scriptnya untuk 56 kelurahan RBI asli — dicatat sebagai
TODO di compute_scores.py dan compute_tdi_full.py.

Sumber tiap kolom mentah:
  - kepadatan_penduduk       <- penduduk.jumlah_penduduk (DKB Semester I 2026
                                 — Ditjen Dukcapil Kemendagri) / luas kelurahan
                                 (geom RBI, dihitung di EPSG:32748 UTM 48S, jiwa/km2)
  - proporsi_usia_rentan      <- penduduk.proporsi_lansia + proporsi_balita
                                 (sama seperti load_kelurahan_mobilitas() di
                                 compute_tdi_full.py — proksi PRD Bab 7d,
                                 data difabel belum tersedia)
  - jarak_rata2_{pendidikan,kesehatan,kerja}_m <- RATA-RATA jarak sjoin_nearest
                                 dari SEMUA centroid grid_analisis (2.607 cell,
                                 fishnet 300m, jauh lebih rapat & representatif
                                 dibanding titik_kandidat yang baru 8 titik) yang
                                 jatuh (point-in-polygon) di kelurahan itu, ke POI
                                 real terdekat (sumber='OpenStreetMap') per jenis
                                 (sekolah/faskes/kerja). Cell yang tidak match ke
                                 kelurahan manapun (celah antar-polygon RBI 25K,
                                 lihat catatan sama di compute_tdi_full.py)
                                 DIKECUALIKAN dari rata-rata kelurahan manapun
                                 (bukan diberi fallback) -- beda kasus dengan TDI:
                                 di sana cell itu SENDIRI butuh skor, di sini yang
                                 dihitung adalah rata-rata MILIK kelurahan, jadi
                                 cell yang tidak jelas kelurahannya memang tidak
                                 boleh ikut menyumbang ke kelurahan mana pun.
  - skor_cai_rata2            <- LIHAT STRATEGI FALLBACK di bawah, ini bagian
                                 paling penting & paling rawan disalahpahami.

STRATEGI skor_cai_rata2 (perintah eksplisit: jangan isi 0/angka menyesatkan
untuk kelurahan tanpa titik_kandidat real):
  Per 27 Agustus 2026, titik_kandidat REAL cuma 8 baris, menyentuh 3 dari 56
  kelurahan RBI (Margahayu, Duren Jaya, Marga Mulya — dicek lewat spatial
  join geom titik_kandidat ke polygon kelurahan RBI, BUKAN field teks
  titik_kandidat.kelurahan yang ejaannya bisa tidak konsisten dengan RBI).
  Dua pilihan dipertimbangkan:
    (a) exclude total 53 kelurahan tanpa titik dari skor_equity — defensible
        tapi bikin Equity Dashboard nyaris kosong (cuma 3 baris), gagal
        acceptance criteria PRD Bab 8 ("ranking minimal 5 kelurahan").
    (b) fallback rata-rata skor_cai SELURUH titik_kandidat real Kota Bekasi
        (bukan 0, bukan angka kelurahan lain yang dipinjam diam-diam),
        DITANDAI EKSPLISIT lewat kolom skor_equity.sumber (migration
        010_skor_equity_sumber.sql) supaya siapa pun yang query tabel ini
        (atau baca lewat Edge Function ai-insight) tahu persis kelurahan mana
        skornya "agregasi lokal" (survei asli di kelurahan itu) vs "fallback
        kota" (proksi sementara, BUKAN representasi lokal).
  DIPILIH: (b) — supaya acceptance criteria "ranking minimal 5 kelurahan"
  tetap terpenuhi dan dashboard tidak kosong, TAPI tetap jujur soal kualitas
  data per baris (bukan diam-diam menyamakan kelurahan yang disurvei dengan
  yang tidak). Kolom `sumber` WAJIB dibaca oleh siapa pun yang menyajikan
  ranking ini ke user (mis. product-analyst/webgis-developer) supaya
  ketidakpastian datanya tidak hilang di lapisan presentasi.

kelompok_terdampak & rekomendasi_intervensi SENGAJA dikosongkan (NULL) untuk
56 baris ini — itu narasi deskriptif hasil analisis tim per PRD Bab 8, BUKAN
sesuatu yang boleh dikarang otomatis oleh script ini untuk 56 kelurahan
sekaligus. Edge Function ai-insight (lapisan interpretasi AI, lihat CLAUDE.md)
bisa menghasilkan narasi kualitatif dari skor_final + n_* yang SUDAH dihitung
di sini; mengisi 56 rekomendasi kebijakan lewat template Python bukan
tanggung jawab formula/ETL.

Idempotent: DELETE dulu baris skor_equity yang sumber-nya diawali 'REAL -'
sebelum INSERT ulang (supaya re-run tidak menumpuk duplikat) — 5 baris dummy
lama (sumber diawali 'DATA SINTETIS') TIDAK PERNAH disentuh.

Cara pakai:
    python aggregate_equity_kelurahan.py              # hitung + print, TIDAK upload
    python aggregate_equity_kelurahan.py --upload      # hitung + upload ke skor_equity
"""

import argparse

import geopandas as gpd
import pandas as pd

from compute_scores import compute_equity_index, sensitivity_check_equity, DEFAULT_EQUITY_WEIGHTS, confidence_tier_dari_ratio
from rerun_dasymetric_grid import fetch_all_paginated, wkb_hex_to_geom, SUMBER_BATAS_RESMI, WGS84
from upload_to_supabase import get_client, load_weights_from_db

METRIC_CRS = "EPSG:32748"  # UTM 48S, konsisten dengan compute_tdi_full.py / build_fishnet_grid.py
SUMBER_POI_REAL = "OpenStreetMap"
PREFIX_ID_TITIK_SURVEI_DEMO = "KND-DEMO-"

SUMBER_LOKAL = "REAL - agregasi lokal (skor_cai_rata2 dari titik_kandidat survei di kelurahan ini, n={n})"
SUMBER_FALLBACK = "REAL - FALLBACK rata-rata kota (belum ada titik_kandidat survei di kelurahan ini, skor_cai_rata2 kota={kota:.4f})"

# Confidence Ratio Equity (035/docs/CONFIDENCE_RATIO.md) — teks persis harus
# sama dengan comment kolom skor_equity.confidence_metode di migration 035.
CONFIDENCE_METODE = "minimum (konservatif) atas cai_confidence_ratio sel grid dalam kelurahan"


def load_kelurahan(client) -> gpd.GeoDataFrame:
    rows = fetch_all_paginated(
        client, "batas_administrasi", "id, nama_kelurahan, geom", filters={"sumber": SUMBER_BATAS_RESMI}
    )
    geoms = [wkb_hex_to_geom(r["geom"]) for r in rows]
    gdf = gpd.GeoDataFrame(
        {"kelurahan_id": [r["id"] for r in rows], "nama_kelurahan": [r["nama_kelurahan"] for r in rows]},
        geometry=geoms, crs=WGS84,
    )
    print(f"[INFO] batas_administrasi (RBI asli): {len(gdf)} kelurahan dimuat.")
    return gdf


def attach_penduduk(client, kelurahan: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    pend_rows = fetch_all_paginated(
        client, "penduduk", "kelurahan_id, jumlah_penduduk, proporsi_lansia, proporsi_balita"
    )
    pend_by_kel = {r["kelurahan_id"]: r for r in pend_rows}

    out = kelurahan.copy()
    jumlah, usia_rentan, missing = [], [], []
    for _, row in out.iterrows():
        p = pend_by_kel.get(row["kelurahan_id"])
        if p is None or p["proporsi_lansia"] is None or p["proporsi_balita"] is None:
            missing.append(row["nama_kelurahan"])
            jumlah.append(None)
            usia_rentan.append(None)
        else:
            jumlah.append(p["jumlah_penduduk"])
            usia_rentan.append(p["proporsi_lansia"] + p["proporsi_balita"])
    out["jumlah_penduduk"] = jumlah
    out["proporsi_usia_rentan"] = usia_rentan

    if missing:
        print(f"[PERINGATAN] {len(missing)} kelurahan RBI tanpa data penduduk lengkap, dikecualikan: {missing}")
    before = len(out)
    out = out.dropna(subset=["jumlah_penduduk", "proporsi_usia_rentan"]).reset_index(drop=True)
    if len(out) < before:
        print(f"[INFO] {before - len(out)} kelurahan dikecualikan karena data penduduk tidak lengkap.")

    # Kepadatan penduduk (jiwa/km2) dari luas geom RBI di CRS metrik.
    area_km2 = out.to_crs(METRIC_CRS).geometry.area / 1e6
    out["kepadatan_penduduk"] = out["jumlah_penduduk"] / area_km2
    return out


def attach_jarak_poi(client, kelurahan: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Rata-rata jarak (m) dari centroid grid_analisis yang jatuh di tiap
    kelurahan ke POI real terdekat, per jenis (sekolah/faskes/kerja). Lihat
    catatan panjang di docstring modul soal kenapa grid_analisis dipakai
    (bukan titik_kandidat -- terlalu jarang) dan kenapa cell yang tidak match
    ke kelurahan manapun dikecualikan, bukan di-fallback.
    """
    grid_rows = fetch_all_paginated(client, "grid_analisis", "id, geom")
    grid_geoms = [wkb_hex_to_geom(r["geom"]) for r in grid_rows]
    grid = gpd.GeoDataFrame({"grid_id": [r["id"] for r in grid_rows]}, geometry=grid_geoms, crs=WGS84)
    print(f"[INFO] grid_analisis: {len(grid)} cell dimuat untuk agregasi jarak POI per kelurahan.")

    grid_m = grid.to_crs(METRIC_CRS)
    kelurahan_m = kelurahan.to_crs(METRIC_CRS)
    centroids = grid_m.copy()
    centroids["geometry"] = centroids.geometry.centroid

    joined = gpd.sjoin(centroids, kelurahan_m[["kelurahan_id", "geometry"]], how="left", predicate="within")
    joined = joined.loc[~joined.index.duplicated(keep="first")]
    centroids["kelurahan_id"] = joined["kelurahan_id"].values
    n_unmatched = centroids["kelurahan_id"].isna().sum()
    if n_unmatched:
        print(
            f"[PERINGATAN] {n_unmatched}/{len(centroids)} centroid grid tidak match ke kelurahan RBI manapun "
            "(celah antar-polygon RBI 25K) -> DIKECUALIKAN dari rata-rata jarak kelurahan mana pun "
            "(beda perlakuan dengan TDI -- di sini tidak ada satu kelurahan spesifik yang berhak atas nilai itu)."
        )
    centroids_matched = centroids.dropna(subset=["kelurahan_id"]).copy()

    kolom_jenis = {"sekolah": "jarak_rata2_pendidikan_m", "faskes": "jarak_rata2_kesehatan_m", "kerja": "jarak_rata2_kerja_m"}
    out = kelurahan.copy()
    for jenis, kolom in kolom_jenis.items():
        poi_rows = fetch_all_paginated(client, "poi", "id, geom", filters={"jenis": jenis, "sumber": SUMBER_POI_REAL})
        poi_geoms = [wkb_hex_to_geom(r["geom"]) for r in poi_rows]
        poi_m = gpd.GeoDataFrame({"poi_id": [r["id"] for r in poi_rows]}, geometry=poi_geoms, crs=WGS84).to_crs(METRIC_CRS)
        print(f"[INFO] POI jenis='{jenis}' (real, OSM): {len(poi_m)} titik.")

        nearest = gpd.sjoin_nearest(centroids_matched, poi_m[["poi_id", "geometry"]], how="left", distance_col="jarak_m")
        nearest = nearest.loc[~nearest.index.duplicated(keep="first")]
        rata2 = nearest.groupby("kelurahan_id")["jarak_m"].mean()
        out[kolom] = out["kelurahan_id"].map(rata2)

    n_tanpa_grid = out[list(kolom_jenis.values())].isna().any(axis=1).sum()
    if n_tanpa_grid:
        nama_tanpa = out.loc[out[list(kolom_jenis.values())].isna().any(axis=1), "nama_kelurahan"].tolist()
        print(
            f"[PERINGATAN] {n_tanpa_grid} kelurahan tidak punya satu pun centroid grid yang match "
            f"(kelurahan sangat kecil / seluruhnya di celah RBI) -> jarak_rata2_* NULL, dikecualikan: {nama_tanpa}"
        )
    return out.dropna(subset=list(kolom_jenis.values())).reset_index(drop=True)


def attach_confidence_cai(client, kelurahan: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Confidence Ratio Equity (BARU 2026-09-13, lihat docs/CONFIDENCE_RATIO.md)
    = MINIMUM cai_confidence_ratio atas sel grid_analisis yang centroidnya
    jatuh di kelurahan ini ("weakest link", defensif -- kelurahan hanya
    dianggap seyakin sel terlemahnya, bukan dirata-ratakan sehingga satu sel
    lemah "ditutupi" banyak sel kuat). confidence_ratio_rata2 (mean) disimpan
    berdampingan HANYA sebagai pembanding audit -- lihat komentar kolom di
    migration 035, JANGAN dipakai sebagai nilai otoritatif di UI/AI.

    Pola spatial join SAMA PERSIS dengan attach_jarak_poi() di atas (centroid
    grid_analisis -> sjoin predicate='within' ke kelurahan) supaya himpunan
    sel yang "match" identik antar kriteria. BEDA PENTING dari attach_jarak_poi:
    di sini TIDAK ada dropna/exclude kelurahan yang tidak match -- Confidence
    Ratio murni sinyal keandalan TAMBAHAN (lihat batasan keras di migration
    035), bukan input skor_final, jadi kelurahan yang kebetulan tidak match
    sel grid manapun tetap masuk Equity Index dengan confidence_ratio NULL,
    BUKAN dikeluarkan dari hasil.
    """
    # fetch_all_paginated cuma dukung filter kesetaraan (.eq) -- "IS NOT NULL"
    # difilter di pandas sesudahnya, bukan di query, supaya tidak perlu ubah
    # helper bersama itu di hari deadline.
    grid_rows_semua = fetch_all_paginated(client, "grid_analisis", "id, geom, cai_confidence_ratio")
    grid_rows = [r for r in grid_rows_semua if r.get("cai_confidence_ratio") is not None]
    if not grid_rows:
        print("[PERINGATAN] Tidak ada sel grid_analisis dengan cai_confidence_ratio terisi -- "
              "confidence_ratio Equity akan NULL semua. Jalankan `python etl/compute_cai_grid.py "
              "--upload` dan pastikan migration 035 sudah di-apply (backfill SQL) dulu.")
        out = kelurahan.copy()
        out["confidence_ratio"] = pd.NA
        out["confidence_ratio_rata2"] = pd.NA
        out["confidence_tier"] = None
        out["confidence_n_sel"] = 0
        return out

    grid_geoms = [wkb_hex_to_geom(r["geom"]) for r in grid_rows]
    grid = gpd.GeoDataFrame(
        {"grid_id": [r["id"] for r in grid_rows],
         "cai_confidence_ratio": [float(r["cai_confidence_ratio"]) for r in grid_rows]},
        geometry=grid_geoms, crs=WGS84,
    )
    grid_m = grid.to_crs(METRIC_CRS)
    kelurahan_m = kelurahan.to_crs(METRIC_CRS)
    centroids = grid_m.copy()
    centroids["geometry"] = centroids.geometry.centroid

    joined = gpd.sjoin(centroids, kelurahan_m[["kelurahan_id", "geometry"]], how="left", predicate="within")
    joined = joined.loc[~joined.index.duplicated(keep="first")]
    n_unmatched = joined["kelurahan_id"].isna().sum()
    if n_unmatched:
        print(
            f"[INFO] {n_unmatched}/{len(joined)} sel dg cai_confidence_ratio tidak match ke kelurahan "
            "RBI manapun (celah antar-polygon RBI 25K, sama seperti attach_jarak_poi) -> dikecualikan "
            "dari agregasi confidence (BUKAN dikecualikan dari Equity Index -- lihat docstring fungsi ini)."
        )
    joined = joined.dropna(subset=["kelurahan_id"])

    agg = joined.groupby("kelurahan_id")["cai_confidence_ratio"].agg(["min", "mean", "count"])

    out = kelurahan.copy()
    out["confidence_ratio"] = out["kelurahan_id"].map(agg["min"])
    out["confidence_ratio_rata2"] = out["kelurahan_id"].map(agg["mean"])
    out["confidence_n_sel"] = out["kelurahan_id"].map(agg["count"]).fillna(0).astype(int)
    out["confidence_tier"] = out["confidence_ratio"].map(confidence_tier_dari_ratio)

    n_tanpa = out["confidence_ratio"].isna().sum()
    if n_tanpa:
        print(f"[INFO] {n_tanpa}/{len(out)} kelurahan tidak punya sel ber-confidence yang match -> "
              "confidence_ratio NULL untuk kelurahan itu (tetap masuk Equity Index).")
    print(f"[INFO] confidence_ratio (min) Equity: {len(out) - n_tanpa}/{len(out)} kelurahan terisi. "
          f"Distribusi tier: {out['confidence_tier'].value_counts(dropna=False).to_dict()}")
    return out


def attach_skor_cai(client, kelurahan: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    skor_cai_rata2 per kelurahan -- lihat STRATEGI di docstring modul untuk
    penjelasan lengkap pilihan (b) fallback rata-rata kota yang ditandai
    eksplisit lewat kolom `sumber`.
    """
    tk_rows = client.table("titik_kandidat").select("id, id_titik_survei, geom").execute().data
    tk_rows = [r for r in tk_rows if not str(r["id_titik_survei"]).startswith(PREFIX_ID_TITIK_SURVEI_DEMO)]
    cai_rows = client.table("skor_cai").select("titik_kandidat_id, skor_final").execute().data
    cai_by_tk = {r["titik_kandidat_id"]: r["skor_final"] for r in cai_rows}

    geoms, skor = [], []
    for r in tk_rows:
        s = cai_by_tk.get(r["id"])
        if s is None:
            continue
        geoms.append(wkb_hex_to_geom(r["geom"]))
        skor.append(float(s))
    titik = gpd.GeoDataFrame({"skor_final": skor}, geometry=geoms, crs=WGS84)
    print(f"[INFO] titik_kandidat REAL dengan skor_cai: {len(titik)} titik (KND-DEMO-* dikecualikan).")

    if titik.empty:
        raise RuntimeError(
            "Tidak ada titik_kandidat REAL dengan skor_cai -- tidak bisa hitung skor_cai_rata2 "
            "sama sekali (bukan cuma fallback), berhenti daripada mengisi angka karangan."
        )

    kota_avg = titik["skor_final"].mean()
    print(f"[INFO] Rata-rata skor_cai kota (dari {len(titik)} titik real) = {kota_avg:.4f} -> dipakai sbg fallback kelurahan tanpa titik.")

    kelurahan_m = kelurahan.to_crs(METRIC_CRS)
    titik_m = titik.to_crs(METRIC_CRS)
    joined = gpd.sjoin(titik_m, kelurahan_m[["kelurahan_id", "nama_kelurahan", "geometry"]], how="left", predicate="within")
    n_unmatched_titik = joined["kelurahan_id"].isna().sum()
    if n_unmatched_titik:
        print(f"[PERINGATAN] {n_unmatched_titik} titik_kandidat real tidak match ke kelurahan RBI manapun, dikecualikan dari agregasi lokal.")
    joined = joined.dropna(subset=["kelurahan_id"])

    agg = joined.groupby("kelurahan_id")["skor_final"].agg(["mean", "count"])

    out = kelurahan.copy()
    skor_cai_rata2, sumber_cai, n_lokal = [], [], []
    for _, row in out.iterrows():
        kid = row["kelurahan_id"]
        if kid in agg.index:
            skor_cai_rata2.append(agg.loc[kid, "mean"])
            n = int(agg.loc[kid, "count"])
            sumber_cai.append(SUMBER_LOKAL.format(n=n))
            n_lokal.append(n)
        else:
            skor_cai_rata2.append(kota_avg)
            sumber_cai.append(SUMBER_FALLBACK.format(kota=kota_avg))
            n_lokal.append(0)
    out["skor_cai_rata2"] = skor_cai_rata2
    out["sumber"] = sumber_cai

    n_lokal_total = sum(1 for n in n_lokal if n > 0)
    print(f"[INFO] {n_lokal_total}/{len(out)} kelurahan punya skor_cai_rata2 dari agregasi lokal (titik survei di dalamnya).")
    print(f"[INFO] {len(out) - n_lokal_total}/{len(out)} kelurahan pakai fallback rata-rata kota (BELUM ada titik survei).")
    return out


def build_equity_input(client) -> gpd.GeoDataFrame:
    kelurahan = load_kelurahan(client)
    kelurahan = attach_penduduk(client, kelurahan)
    kelurahan = attach_jarak_poi(client, kelurahan)
    kelurahan = attach_skor_cai(client, kelurahan)
    # Confidence Ratio (035/docs/CONFIDENCE_RATIO.md) -- SETELAH attach_jarak_poi
    # supaya kelurahan yang sudah di-dropna() attach_jarak_poi tidak ikut minta
    # confidence untuk baris yang toh tidak akan diupload. TIDAK menggunakan
    # dropna sendiri -- lihat docstring attach_confidence_cai().
    kelurahan = attach_confidence_cai(client, kelurahan)
    return kelurahan


def upload_equity_scores_real(client, scored_df: pd.DataFrame) -> int:
    """
    Upload idempotent: DELETE dulu baris skor_equity ber-sumber 'REAL - %'
    (baik agregasi lokal maupun fallback kota), baru INSERT batch baru --
    supaya re-run script ini tidak menumpuk duplikat. 5 baris dummy lama
    (sumber diawali 'DATA SINTETIS') TIDAK PERNAH disentuh oleh query delete
    ini (filter like 'REAL - %' tidak match string itu).
    """
    del_result = client.table("skor_equity").delete().like("sumber", "REAL - %").execute()
    print(f"[INFO] Hapus {len(del_result.data)} baris skor_equity REAL lama (kalau ada, sebelum insert ulang).")

    records = []
    for _, row in scored_df.iterrows():
        records.append({
            "kelurahan_id": int(row["kelurahan_id"]),
            "skor_cai_rata2": round(float(row["skor_cai_rata2"]), 4),
            "n_aksesibilitas_inv": round(float(row["n_aksesibilitas_inv"]), 4),
            "n_kepadatan": round(float(row["n_kepadatan"]), 4),
            "n_usia_rentan": round(float(row["n_usia_rentan"]), 4),
            "n_akses_pendidikan": round(float(row["n_akses_pendidikan"]), 4),
            "n_akses_kesehatan": round(float(row["n_akses_kesehatan"]), 4),
            "n_akses_kerja": round(float(row["n_akses_kerja"]), 4),
            "skor_final": round(float(row["skor_final"]), 4),
            "ranking": int(row["ranking"]),
            "sumber": row["sumber"],
            # Narasi deskriptif -- SENGAJA NULL, lihat catatan di docstring modul.
            "kelompok_terdampak": None,
            "rekomendasi_intervensi": None,
            # Confidence Ratio (035/docs/CONFIDENCE_RATIO.md) -- BUKAN AHP
            # consistency_ratio. NULL kalau kelurahan tidak match sel grid
            # manapun (lihat attach_confidence_cai()) -- pola sama dengan
            # kolom jarak_rata2_* yang boleh NULL secara individual.
            "confidence_ratio": (
                round(float(row["confidence_ratio"]), 4)
                if pd.notna(row["confidence_ratio"]) else None
            ),
            "confidence_ratio_rata2": (
                round(float(row["confidence_ratio_rata2"]), 4)
                if pd.notna(row["confidence_ratio_rata2"]) else None
            ),
            "confidence_tier": row["confidence_tier"] if pd.notna(row["confidence_tier"]) else None,
            "confidence_n_sel": int(row["confidence_n_sel"]),
            "confidence_metode": CONFIDENCE_METODE if pd.notna(row["confidence_ratio"]) else None,
        })

    result = client.table("skor_equity").insert(records).execute()
    print(f"[INFO] Berhasil insert {len(result.data)} baris skor_equity (56 kelurahan RBI real).")
    return len(result.data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload", action="store_true", help="Upload hasil ke skor_equity (default: dry-run, print saja)")
    args = parser.parse_args()

    client = get_client()

    print("=== 1. Susun fitur mentah Equity Index per kelurahan (56 RBI) ===\n")
    df = build_equity_input(client)
    print(f"\n{len(df)}/56 kelurahan siap dihitung (setelah exclude data tidak lengkap).")

    print("\n=== 2. Bobot Equity dari konfigurasi_bobot ===")
    weights = load_weights_from_db(client, "EQUITY", DEFAULT_EQUITY_WEIGHTS)

    print("\n=== 3. Hitung compute_equity_index() ===")
    scored = compute_equity_index(df, weights)

    print("\n--- Ringkasan distribusi skor_final (skor ketimpangan) ---")
    print(scored["skor_final"].describe().round(4).to_string())

    print("\nTop 10 kelurahan paling dirugikan/tertinggal (ranking 1 = skor_final tertinggi):")
    print(scored[["ranking", "nama_kelurahan", "skor_cai_rata2", "kepadatan_penduduk",
                   "proporsi_usia_rentan", "skor_final", "sumber"]].head(10).round(4).to_string(index=False))

    print("\n=== 4. Sensitivity analysis (geser bobot equity ±10%) ===")
    sens = sensitivity_check_equity(scored, weights)
    print(sens.to_string(index=False))
    n_unstable = (sens["jumlah_ranking_berubah"] > 0).sum()
    print(f"\n{n_unstable}/{len(sens)} skenario pergeseran bobot mengubah ranking skor_final (dari {len(scored)} kelurahan).")

    if args.upload:
        print("\n=== 5. Upload ke skor_equity ===")
        upload_equity_scores_real(client, scored)
    else:
        print("\n[DRY-RUN] --upload tidak diberikan, TIDAK ada perubahan ditulis ke Supabase.")
