"""
attach_kepadatan_titik_kandidat.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Ganti KEPADATAN_NEUTRAL_PLACEHOLDER (konstanta 11650, SAMA untuk semua 8
titik_kandidat REAL) di recompute_all_cai_scores() dengan kepadatan_penduduk
REAL per titik, diambil lewat spatial join ke grid_analisis (2.607 cell,
300m, hasil TRUE dasymetric mapping berbobot building footprint OSM asli —
lihat rerun_dasymetric_grid.py). Lalu recompute skor_cai untuk 8 titik itu
saja (KND-DEMO-001..004 TIDAK disentuh, tetap load_demo_data() sintetis).

KENAPA INI PENTING (temuan qa-tester 27 Agu, diverifikasi manual): n_kepadatan
adalah salah satu kriteria berbobot terbesar di CAI (0,329 hasil AHP 2026-09-03,
seri dengan jarak_inv; DEFAULT_WEIGHTS / konfigurasi_bobot). Selama ini
semua 8 titik real memakai kepadatan_penduduk = KEPADATAN_NEUTRAL_PLACEHOLDER
(nilai konstan) -> normalize_min_max() otomatis mengembalikan 0.5 untuk semua
baris (hi==lo, lihat compute_scores.normalize_min_max()) -> kriteria berbobot
terbesar itu TIDAK membedakan ranking sama sekali. grid_analisis sudah punya
kepadatan per-cell yang benar-benar bervariasi (bukan rata merata), tinggal
disambungkan ke titik_kandidat lewat geometrinya.

===========================================================================
METODOLOGI SPATIAL JOIN (baca ini untuk laporan akhir proyek / pertanyaan juri)
===========================================================================

1. UTAMA — point-in-polygon ("within"), proyeksi metrik EPSG:32748 (UTM 48S,
   konsisten dengan seluruh pipeline ETL lain — build_fishnet_grid.py,
   compute_tdi_full.py, aggregate_equity_kelurahan.py):
   tiap titik_kandidat (geometry Point, hasil GPS survei lapangan/MAPID Apps)
   dicek jatuh di cell grid_analisis (Polygon 300x300m) yang mana. Ini valid
   karena grid_analisis adalah fishnet UTUH yang menutupi seluruh Kota Bekasi
   TANPA celah internal — dibuat dari bounding box kota penuh (generate_fishnet()),
   dan clip_to_boundary() sengaja memakai filter predikat 'intersects' (BUKAN
   potong geometris gpd.clip), jadi setiap cell yang tersisa tetap kotak UTUH
   300x300m, tidak berlubang. (Beda dengan celah antar-POLYGON KELURAHAN RBI
   yang disebut di aggregate_equity_kelurahan.py/compute_tdi_full.py — itu
   celah administratif, bukan celah grid analisis ini.)

2. FALLBACK — nearest-neighbor (gpd.sjoin_nearest ke tepi polygon cell
   terdekat), dipakai HANYA untuk titik yang TIDAK jatuh di cell manapun
   (edge case: titik persis di tepi luar bounding box fishnet akibat
   pembulatan floating-point saat generate_fishnet()). Jarak fallback
   dicetak eksplisit per titik supaya bisa dinilai masuk akal — untuk cell
   300x300m, jarak wajar untuk kasus "tepi bounding box" ada di kisaran
   puluhan meter; kalau ternyata jauh lebih besar dari itu, dicetak sebagai
   peringatan tambahan (indikasi ada masalah data lain, bukan cuma
   floating-point edge case) supaya tidak diam-diam dipakai.

3. KONVERSI SATUAN — grid_analisis.kepadatan_penduduk adalah ESTIMASI JUMLAH
   JIWA PER CELL (bukan per km2 — lihat docstring
   build_fishnet_grid.disaggregate_population_dasymetric(), nilainya hasil
   sebaran proporsional populasi kelurahan ke luas building footprint per
   cell). Di sini DIBAGI luas cell asli (dihitung di EPSG:32748, ~0.09 km2
   untuk cell 300x300m, dihitung per-baris — bukan di-hardcode — untuk jaga
   diri kalau suatu saat ukuran cell berubah) supaya hasilnya jadi
   kepadatan_penduduk dalam **jiwa/km2**, konsisten dengan semantik kolom
   yang sama di compute_cai() ("kepadatan_penduduk (jiwa/km2 atau jumlah
   penduduk sekitar titik)") dan skala load_demo_data() (~6.100-16.500).
   Pembagi konstan yang SAMA untuk semua cell (karena semua cell berukuran
   sama) tidak mengubah urutan/rasio relatif antar 8 titik — konversi ini
   murni supaya angka mentahnya interpretable (jiwa/km2, bukan jiwa/cell),
   BUKAN untuk mengubah hasil ranking.

Cara pakai:
    python attach_kepadatan_titik_kandidat.py              # hitung + print, TIDAK upload
    python attach_kepadatan_titik_kandidat.py --upload      # hitung + upload ke skor_cai
"""

import argparse

import geopandas as gpd
import pandas as pd

from compute_scores import DEFAULT_WEIGHTS
from rerun_dasymetric_grid import fetch_all_paginated, wkb_hex_to_geom, WGS84
from upload_to_supabase import (
    get_client,
    load_weights_from_db,
    recompute_all_cai_scores,
    PREFIX_ID_TITIK_SURVEI_DEMO,
)

METRIC_CRS = "EPSG:32748"  # UTM 48S, konsisten dengan seluruh pipeline ETL lain


def load_titik_kandidat_real(client) -> gpd.GeoDataFrame:
    rows = (
        client.table("titik_kandidat")
        .select("id, id_titik_survei, deskripsi_lokasi, geom")
        .execute()
        .data
    )
    rows = [r for r in rows if not str(r["id_titik_survei"]).startswith(PREFIX_ID_TITIK_SURVEI_DEMO)]
    geoms = [wkb_hex_to_geom(r["geom"]) for r in rows]
    gdf = gpd.GeoDataFrame(
        {
            "titik_kandidat_id": [r["id"] for r in rows],
            "id_titik_survei": [r["id_titik_survei"] for r in rows],
            "deskripsi_lokasi": [r["deskripsi_lokasi"] for r in rows],
        },
        geometry=geoms,
        crs=WGS84,
    )
    print(f"[INFO] titik_kandidat REAL (non {PREFIX_ID_TITIK_SURVEI_DEMO}*): {len(gdf)} titik dimuat.")
    return gdf


def load_grid(client) -> gpd.GeoDataFrame:
    rows = fetch_all_paginated(client, "grid_analisis", "id, geom, kepadatan_penduduk")
    geoms = [wkb_hex_to_geom(r["geom"]) for r in rows]
    gdf = gpd.GeoDataFrame(
        {
            "grid_analisis_id": [r["id"] for r in rows],
            "kepadatan_penduduk_cell": [float(r["kepadatan_penduduk"] or 0.0) for r in rows],
        },
        geometry=geoms,
        crs=WGS84,
    )
    print(f"[INFO] grid_analisis: {len(gdf)} cell dimuat.")
    return gdf


def attach_kepadatan_real(titik: gpd.GeoDataFrame, grid: gpd.GeoDataFrame) -> pd.DataFrame:
    """
    Lihat docstring modul untuk penjelasan lengkap metodologi (within utama,
    sjoin_nearest fallback, konversi jiwa/cell -> jiwa/km2).
    """
    titik_m = titik.to_crs(METRIC_CRS).reset_index(drop=True)
    grid_m = grid.to_crs(METRIC_CRS)
    grid_m = grid_m.assign(luas_cell_km2=grid_m.geometry.area / 1e6)
    grid_cols = ["grid_analisis_id", "kepadatan_penduduk_cell", "luas_cell_km2", "geometry"]

    # --- 1. UTAMA: point-in-polygon ---
    joined = gpd.sjoin(titik_m, grid_m[grid_cols], how="left", predicate="within")
    joined = joined.loc[~joined.index.duplicated(keep="first")].reset_index(drop=True)

    unmatched_mask = joined["grid_analisis_id"].isna()
    n_unmatched = int(unmatched_mask.sum())
    joined["metode_join"] = "within (point-in-polygon)"
    joined["jarak_fallback_m"] = 0.0

    if n_unmatched:
        print(
            f"[INFO] {n_unmatched} titik tidak jatuh di cell grid_analisis manapun (within) "
            "-> pakai fallback nearest-neighbor (sjoin_nearest)."
        )
        # --- 2. FALLBACK: nearest-neighbor, hanya untuk baris yang unmatched ---
        unmatched_idx = joined.index[unmatched_mask]
        unmatched_titik = titik_m.loc[unmatched_idx]
        nearest = gpd.sjoin_nearest(unmatched_titik, grid_m[grid_cols], how="left", distance_col="jarak_fallback_m")
        nearest = nearest.loc[~nearest.index.duplicated(keep="first")]
        for idx in unmatched_idx:
            joined.loc[idx, "grid_analisis_id"] = nearest.loc[idx, "grid_analisis_id"]
            joined.loc[idx, "kepadatan_penduduk_cell"] = nearest.loc[idx, "kepadatan_penduduk_cell"]
            joined.loc[idx, "luas_cell_km2"] = nearest.loc[idx, "luas_cell_km2"]
            joined.loc[idx, "jarak_fallback_m"] = nearest.loc[idx, "jarak_fallback_m"]
            joined.loc[idx, "metode_join"] = "sjoin_nearest (fallback)"
            jarak = nearest.loc[idx, "jarak_fallback_m"]
            print(
                f"  [FALLBACK] titik_kandidat_id={int(joined.loc[idx, 'titik_kandidat_id'])} "
                f"({joined.loc[idx, 'id_titik_survei']}): nearest cell grid_analisis_id="
                f"{int(nearest.loc[idx, 'grid_analisis_id'])}, jarak={jarak:.1f}m"
                + (" [PERINGATAN: jarak lebih besar dari perkiraan wajar edge-case (>250m)]" if jarak > 250 else "")
            )
    else:
        print("[INFO] Semua titik match langsung via point-in-polygon (within), fallback tidak diperlukan.")

    joined["kepadatan_penduduk_density"] = joined["kepadatan_penduduk_cell"] / joined["luas_cell_km2"]

    out = joined[
        [
            "titik_kandidat_id", "id_titik_survei", "deskripsi_lokasi", "metode_join",
            "grid_analisis_id", "kepadatan_penduduk_cell", "luas_cell_km2",
            "kepadatan_penduduk_density", "jarak_fallback_m",
        ]
    ].reset_index(drop=True)
    return out


def load_existing_skor_cai(client, titik_kandidat_ids: list) -> pd.DataFrame:
    """Ambil baris skor_cai LAMA (sebelum recompute) untuk 8 titik ini, dipakai laporan before/after."""
    rows = (
        client.table("skor_cai")
        .select("titik_kandidat_id, n_kepadatan, n_jarak_inv, n_volume, n_survei, skor_final")
        .in_("titik_kandidat_id", titik_kandidat_ids)
        .execute()
        .data
    )
    return pd.DataFrame(rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--upload", action="store_true",
        help="Upload hasil recompute ke skor_cai (default: dry-run, hitung + print saja)",
    )
    args = parser.parse_args()

    client = get_client()

    print("=== 1. Muat titik_kandidat REAL + grid_analisis ===\n")
    titik = load_titik_kandidat_real(client)
    grid = load_grid(client)
    if titik.empty:
        raise SystemExit("Tidak ada titik_kandidat REAL — tidak ada yang bisa dihitung.")

    print("\n=== 2. Spatial join: kepadatan_penduduk REAL per titik (lihat metodologi di docstring modul) ===\n")
    kepadatan_df = attach_kepadatan_real(titik, grid)
    print(
        kepadatan_df[
            ["id_titik_survei", "deskripsi_lokasi", "metode_join", "grid_analisis_id",
             "kepadatan_penduduk_cell", "kepadatan_penduduk_density"]
        ].round(2).to_string(index=False)
    )

    kepadatan_by_titik_id = dict(zip(kepadatan_df["titik_kandidat_id"], kepadatan_df["kepadatan_penduduk_density"]))

    print("\n=== 3. Baris skor_cai LAMA (sebelum recompute, untuk perbandingan before/after) ===\n")
    before = load_existing_skor_cai(client, kepadatan_df["titik_kandidat_id"].tolist())
    if not before.empty:
        print(before.round(4).to_string(index=False))
    else:
        print("(Belum ada baris skor_cai untuk titik-titik ini — akan INSERT baru, bukan UPDATE.)")

    print("\n=== 4. Bobot CAI dari konfigurasi_bobot ===")
    weights = load_weights_from_db(client, "CAI", DEFAULT_WEIGHTS)

    mode = "UPLOAD (menulis ke skor_cai)" if args.upload else "DRY-RUN (tidak menulis apa pun)"
    print(f"\n=== 5. Recompute skor_cai — 8 titik REAL, n_kepadatan sekarang dari grid_analisis real [{mode}] ===\n")
    # NOTE 2026-09-07: jalur kanonik penuh sekarang
    # attach_cai_features_titik_kandidat.py (kepadatan + jarak dari geom).
    # Script ini hanya menyusun kepadatan; tetap oper exclude_criteria=['survei']
    # supaya --upload di sini tidak me-reintroduksi n_survei=0 di skor_cai.
    scored = recompute_all_cai_scores(
        client, weights=weights, kepadatan_by_titik_id=kepadatan_by_titik_id,
        exclude_criteria=["survei"], upload=args.upload,
    )

    if not scored.empty:
        print("\n--- Hasil BARU (n_kepadatan diskriminatif per titik, bukan konstan 0.5) ---")
        print(
            scored[
                ["id_titik_survei", "nama_lokasi", "titik_kandidat_id",
                 "kepadatan_penduduk", "n_kepadatan", "n_jarak_inv", "n_volume", "n_survei", "skor_cai"]
            ].round(4).to_string(index=False)
        )

    if not args.upload:
        print(
            "\n[DRY-RUN] --upload tidak diberikan, TIDAK ada perubahan ditulis ke Supabase. "
            "Jalankan ulang dengan --upload setelah hasil di atas diverifikasi masuk akal."
        )
