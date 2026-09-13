"""
compute_tdi_full.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Hitung skor_tdi untuk SELURUH 2.607 cell grid_analisis (fishnet 300m, sudah
diisi kepadatan_penduduk dasymetric-real oleh rerun_dasymetric_grid.py),
lalu UPDATE ke Supabase. Sebelumnya BLOCKED karena konfigurasi_bobot belum
ada baris 'TDI_MOBILITAS' (lihat docs/DATA_CHECKLIST.md) — sekarang
unblocked oleh 009_bobot_tdi_equity_mentor_review.sql.

compute_tdi() di compute_scores.py butuh 3 kolom mentah per grid yang BELUM
ada scriptnya (dicatat sebagai TODO di compute_scores.py & DATA_CHECKLIST.md):
  - skor_aksesibilitas_transit  <- jarak grid ke halte terdekat, fungsi decay
    linear coverage isochrone 400m/800m (bukan network routing riil -
    eksplisit out-of-scope PRD Bab 3, sama seperti pendekatan RPC
    simulate_new_stop()). SUMBER HALTE (sejak 2026-09-11, lihat CATATAN
    2026-09-11 di bawah): GABUNGAN halte_eksisting REAL tersurvei (15,
    HLT-001..015, DUMMY-HLT-* dikecualikan) + halte BisKita Trans Patriot
    dari OSM yang belum disurvei lapangan (frontend/src/data/
    biskita_halte_osm.geojson, ~32 titik) — lihat load_halte_gabungan().
  - proporsi_usia_rentan        <- spatial join centroid grid ke kelurahan
    RBI asli (56, batas_administrasi sumber=SUMBER_BATAS_RESMI), lalu ambil
    proporsi_lansia + proporsi_balita kelurahan itu dari tabel `penduduk`
    (DKB Semester I 2026 — Ditjen Dukcapil Kemendagri). Definisi "usia rentan" di sini
    HANYA lansia+balita (proksi PRD Bab 7d) — data difabel belum tersedia,
    dicatat sebagai keterbatasan, bukan disembunyikan.
  - proporsi_usia_sekolah       <- spatial join yang SAMA (centroid grid ->
    kelurahan RBI), ambil penduduk.proporsi_usia_sekolah (proporsi penduduk
    umur 5–19 = pita 05-09 + 10-14 + 15-19, jenjang SD–SMA / populasi di
    bawah usia mengemudi yang transit-dependent). Komponen ketiga Indeks
    Kebutuhan Mobilitas sejak keputusan tim 2026-09-06 (migration 026),
    MENGGANTIKAN 'tanpa_kendaraan' yang tidak tersedia pada resolusi spasial.
  - kepadatan_poi_harian        <- jumlah POI real (sumber='OpenStreetMap',
    jenis sekolah/faskes/kerja) dalam radius RADIUS_POI_M dari centroid grid.

kepadatan_penduduk grid TIDAK dihitung ulang di sini — dipakai apa adanya
dari grid_analisis (hasil rerun_dasymetric_grid.py, building footprint OSM
asli, assert konservasi populasi sudah lolos).

CATATAN 2026-09-06: komponen ketiga Indeks Kebutuhan Mobilitas diganti dari
'tanpa_kendaraan' (fallback netral 0,5 seragam -> nol daya pisah) ke
'usia_sekolah' (proporsi penduduk umur 5–19 per kelurahan, real dari
penduduk.proporsi_usia_sekolah). Jalur fallback 0,5 di
compute_indeks_kebutuhan_mobilitas() sudah dihapus (migration 026).

CATATAN 2026-09-11 (perbaikan metodologi, diminta Sam): skor_aksesibilitas_
transit SEBELUMNYA hanya mengukur jarak ke 15 halte_eksisting REAL yang
sempat disurvei tim (HLT-001..015). Padahal jaringan fisik BisKita Trans
Patriot punya ~32-33 halte nyata (dikonfirmasi via OSM, network="Trans
Bekasi Patriot", sudah dimaterialisasi di frontend/src/data/
biskita_halte_osm.geojson oleh build_rute_biskita_osm.py). ~18 halte yang
NYATA ADA tapi tidak sempat disurvei sebelumnya "tidak terlihat" oleh
formula ini -> sel di sekitarnya salah dihitung seolah tidak ada transit
sama sekali, menggembungkan skor_tdi secara artifisial di sekitar halte
riil yang belum tersurvei.

PERBAIKAN: load_halte_gabungan() menggabungkan (a) halte_eksisting REAL
tersurvei (15) dan (b) titik OSM BisKita dari file geojson di atas (~32),
lalu dipakai bersama untuk nearest-distance skor_aksesibilitas_transit.
Duplikat/near-duplikat titik yang sama dari 2 sumber TIDAK di-dedup --
untuk perhitungan jarak-terdekat ini tidak berbahaya (jarak minimum tidak
berubah oleh titik duplikat di dekatnya).

SCOPE KETAT: perubahan ini HANYA menyentuh skor_aksesibilitas_transit (dan
turunannya skor_tdi). Kriteria "skor survei kondisi halte" pada skor_cai
SENGAJA TIDAK diubah -- itu terikat pada ketersediaan Form Kondisi Halte
(cakupan survei kondisi fisik), bukan keberadaan fisik halte, konsep yang
berbeda (lihat CLAUDE.md bagian Composite Accessibility Index).

Cara pakai:
    python compute_tdi_full.py              # hitung + print ringkasan, TIDAK upload
    python compute_tdi_full.py --upload      # hitung + upload ke grid_analisis
"""

import argparse
import json
import os

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import shape

from compute_scores import compute_tdi, sensitivity_check_tdi, DEFAULT_MOBILITY_WEIGHTS, compute_tdi_confidence
from rerun_dasymetric_grid import (
    fetch_all_paginated,
    wkb_hex_to_geom,
    SUMBER_BATAS_RESMI,
    WGS84,
)
from upload_to_supabase import get_client, load_weights_from_db, upload_tdi_scores

METRIC_CRS = "EPSG:32748"  # UTM 48S, sama dengan build_fishnet_grid.py

# Radius hitung POI "kebutuhan harian" di sekitar grid (meter) — skala jalan
# kaki 5 menit (~400m @ 4.8km/jam), konsisten dengan RPC simulate_new_stop()
# ("standar ITDP walking catchment" 400m) dan CLAUDE.md (estimasi jalan kaki,
# BUKAN network routing riil).
RADIUS_POI_M = 400

# Ambang coverage isochrone untuk skor_aksesibilitas_transit (Bab 7 PRD):
# <=AMBANG_PENUH  -> layanan penuh (1.0)
# antara          -> decay linear
# >AMBANG_NIHIL   -> tidak terlayani (0.0)
AMBANG_PENUH_M = 400
AMBANG_NIHIL_M = 800

SUMBER_POI_REAL = "OpenStreetMap"
JENIS_POI_HARIAN = ["sekolah", "faskes", "kerja"]
PREFIX_HALTE_DUMMY = "DUMMY-HLT-"

# Halte BisKita Trans Patriot dari OSM (network="Trans Bekasi Patriot"),
# dimaterialisasi oleh build_rute_biskita_osm.py — sumber KEDUA untuk
# skor_aksesibilitas_transit sejak 2026-09-11 (lihat CATATAN di docstring
# atas). Ini file yang SAMA yang dipakai frontend untuk menggambar layer
# halte BisKita, jadi otomatis konsisten dengan apa yang dilihat user di peta.
OSM_HALTE_GEOJSON_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "data", "biskita_halte_osm.geojson")
)


def skor_aksesibilitas_dari_jarak(jarak_m: pd.Series) -> pd.Series:
    """
    Fungsi decay linear coverage isochrone 400m/800m — lihat AMBANG_* di atas.
    Contoh: 300m -> 1.0 | 400m -> 1.0 | 600m -> 0.5 | 800m -> 0.0 | 1500m -> 0.0
    """
    out = 1 - (jarak_m - AMBANG_PENUH_M) / (AMBANG_NIHIL_M - AMBANG_PENUH_M)
    return out.clip(lower=0.0, upper=1.0)


def load_grid(client) -> gpd.GeoDataFrame:
    rows = fetch_all_paginated(client, "grid_analisis", "id, geom, kepadatan_penduduk")
    geoms = [wkb_hex_to_geom(r["geom"]) for r in rows]
    gdf = gpd.GeoDataFrame(
        {
            "grid_analisis_id": [r["id"] for r in rows],
            "kepadatan_penduduk": [float(r["kepadatan_penduduk"] or 0.0) for r in rows],
        },
        geometry=geoms,
        crs=WGS84,
    )
    print(f"[INFO] grid_analisis: {len(gdf)} cell dimuat.")
    return gdf


def load_kelurahan_mobilitas(client) -> gpd.GeoDataFrame:
    """Kelurahan RBI asli (56) + dua proksi kebutuhan mobilitas per-kelurahan
    dari tabel `penduduk`:
      - proporsi_usia_rentan  = proporsi_lansia + proporsi_balita
      - proporsi_usia_sekolah = penduduk.proporsi_usia_sekolah (umur 5–19,
        kolom migration 026)
    Kelurahan yang salah satu proksinya NULL dikecualikan (dicatat), lalu
    ditangani lewat fallback rata-rata kota tertimbang populasi di
    build_grid_features()."""
    admin_rows = fetch_all_paginated(
        client, "batas_administrasi", "id, nama_kelurahan, geom", filters={"sumber": SUMBER_BATAS_RESMI}
    )
    pend_rows = fetch_all_paginated(
        client,
        "penduduk",
        "kelurahan_id, jumlah_penduduk, proporsi_lansia, proporsi_balita, proporsi_usia_sekolah",
    )
    pend_by_kel = {r["kelurahan_id"]: r for r in pend_rows}

    records, missing = [], []
    for r in admin_rows:
        p = pend_by_kel.get(r["id"])
        if (
            p is None
            or p["proporsi_lansia"] is None
            or p["proporsi_balita"] is None
            or p.get("proporsi_usia_sekolah") is None
        ):
            missing.append(r["nama_kelurahan"])
            continue
        records.append({
            "kelurahan_id": r["id"],
            "nama_kelurahan": r["nama_kelurahan"],
            "jumlah_penduduk": p["jumlah_penduduk"],
            "proporsi_usia_rentan": p["proporsi_lansia"] + p["proporsi_balita"],
            "proporsi_usia_sekolah": float(p["proporsi_usia_sekolah"]),
            "geometry": wkb_hex_to_geom(r["geom"]),
        })
    if missing:
        print(
            f"[PERINGATAN] {len(missing)} kelurahan RBI tanpa data penduduk lengkap "
            f"(lansia/balita/usia_sekolah NULL), dikecualikan: {missing}"
        )

    gdf = gpd.GeoDataFrame(records, crs=WGS84)
    print(
        f"[INFO] Kelurahan RBI + proporsi_usia_rentan + proporsi_usia_sekolah: "
        f"{len(gdf)}/{len(admin_rows)} siap dipakai."
    )
    return gdf


def load_poi_harian(client) -> gpd.GeoDataFrame:
    rows = fetch_all_paginated(client, "poi", "id, jenis, geom", filters={"sumber": SUMBER_POI_REAL})
    rows = [r for r in rows if r["jenis"] in JENIS_POI_HARIAN]
    geoms = [wkb_hex_to_geom(r["geom"]) for r in rows]
    gdf = gpd.GeoDataFrame({"poi_id": [r["id"] for r in rows]}, geometry=geoms, crs=WGS84)
    print(f"[INFO] POI kebutuhan harian real ({'/'.join(JENIS_POI_HARIAN)}): {len(gdf)} titik.")
    return gdf


def load_halte_survei_real(client) -> gpd.GeoDataFrame:
    """Halte eksisting REAL yang sudah disurvei tim (15, HLT-001..015),
    DUMMY-HLT-* dikecualikan. NAMA DIPERTAHANKAN apa adanya (bukan direname
    load_halte_real) supaya scope perubahan 2026-09-11 jelas: fungsi ini
    sendiri TIDAK berubah perilakunya, hanya dipanggil bareng sumber kedua
    di load_halte_gabungan()."""
    rows = fetch_all_paginated(client, "halte_eksisting", "id, id_halte_survei, nama, geom")
    rows = [r for r in rows if not str(r["id_halte_survei"]).startswith(PREFIX_HALTE_DUMMY)]
    geoms = [wkb_hex_to_geom(r["geom"]) for r in rows]
    gdf = gpd.GeoDataFrame(
        {
            "halte_id": [f"SURVEI-{r['id']}" for r in rows],
            "nama_halte": [r["nama"] for r in rows],
            "sumber_halte": ["survei_lapangan"] * len(rows),
        },
        geometry=geoms, crs=WGS84,
    )
    print(f"[INFO] Halte eksisting REAL tersurvei (HLT-001..015, DUMMY-HLT-* dikecualikan): {len(gdf)} titik.")
    return gdf


# Alias lama dipertahankan (dipakai file lain sebagai referensi nama di komentar,
# dan supaya import lama tidak patah kalau ada script lain yang memanggilnya).
load_halte_real = load_halte_survei_real


def load_halte_osm_biskita() -> gpd.GeoDataFrame:
    """Titik halte BisKita Trans Patriot dari OSM (~32), belum disurvei
    lapangan tim. Dibaca langsung dari file lokal yang sudah dimaterialisasi
    oleh build_rute_biskita_osm.py — TIDAK hit Overpass API lagi di sini."""
    if not os.path.exists(OSM_HALTE_GEOJSON_PATH):
        raise SystemExit(
            f"[GAGAL] File halte OSM tidak ditemukan: {OSM_HALTE_GEOJSON_PATH}\n"
            "Jalankan etl/build_rute_biskita_osm.py dulu, atau cek path."
        )
    with open(OSM_HALTE_GEOJSON_PATH, "r", encoding="utf-8") as f:
        fc = json.load(f)
    feats = fc["features"]
    gdf = gpd.GeoDataFrame(
        {
            "halte_id": [f"OSM-{i}" for i in range(len(feats))],
            "nama_halte": [f["properties"].get("nama") for f in feats],
            "sumber_halte": ["osm_belum_disurvei"] * len(feats),
        },
        geometry=[shape(f["geometry"]) for f in feats],
        crs=WGS84,
    )
    print(
        f"[INFO] Halte BisKita OSM (belum disurvei lapangan, {os.path.basename(OSM_HALTE_GEOJSON_PATH)}): "
        f"{len(gdf)} titik."
    )
    return gdf


def load_halte_gabungan(client) -> gpd.GeoDataFrame:
    """SUMBER HALTE GABUNGAN untuk skor_aksesibilitas_transit (2026-09-11):
    halte_eksisting REAL tersurvei (15) + halte OSM BisKita belum-disurvei
    (~32) = ~47 titik. Tidak ada dedup near-duplicate antar 2 sumber — untuk
    nearest-distance ini tidak masalah (lihat CATATAN 2026-09-11 di atas)."""
    survei = load_halte_survei_real(client)
    osm = load_halte_osm_biskita()
    gabungan = pd.concat([survei, osm], ignore_index=True)
    gabungan = gpd.GeoDataFrame(gabungan, geometry="geometry", crs=WGS84)
    print(
        f"[INFO] Halte GABUNGAN (survei + OSM) untuk skor_aksesibilitas_transit: "
        f"{len(survei)} + {len(osm)} = {len(gabungan)} titik."
    )
    return gabungan


def build_grid_features(client) -> gpd.GeoDataFrame:
    grid = load_grid(client)
    kelurahan = load_kelurahan_mobilitas(client)
    poi = load_poi_harian(client)
    halte = load_halte_gabungan(client)

    grid_m = grid.to_crs(METRIC_CRS)
    kelurahan_m = kelurahan.to_crs(METRIC_CRS)
    poi_m = poi.to_crs(METRIC_CRS)
    halte_m = halte.to_crs(METRIC_CRS)

    centroids = grid_m.copy()
    centroids["geometry"] = centroids.geometry.centroid

    # --- proporsi_usia_rentan + proporsi_usia_sekolah: centroid grid ->
    #     kelurahan RBI (point-in-polygon), SATU spatial join untuk keduanya ---
    joined = gpd.sjoin(
        centroids,
        kelurahan_m[["kelurahan_id", "proporsi_usia_rentan", "proporsi_usia_sekolah", "geometry"]],
        how="left", predicate="within",
    )
    joined = joined.loc[~joined.index.duplicated(keep="first")]  # jaga2 kalau centroid pas di garis batas 2 polygon
    grid_m["proporsi_usia_rentan"] = joined["proporsi_usia_rentan"].values
    grid_m["proporsi_usia_sekolah"] = joined["proporsi_usia_sekolah"].values

    total_pop = kelurahan["jumlah_penduduk"].sum()
    for kol in ("proporsi_usia_rentan", "proporsi_usia_sekolah"):
        n_unmatched = grid_m[kol].isna().sum()
        if n_unmatched:
            # Fallback: rata-rata kota (weighted by jumlah_penduduk) -- BUKAN 0 --
            # supaya cell yang jatuh persis di celah antar-polygon (efek simplifikasi
            # RBI 25K) tidak diam-diam mendapat skor kebutuhan mobilitas nihil.
            rata2_kota = (kelurahan[kol] * kelurahan["jumlah_penduduk"]).sum() / total_pop
            print(
                f"[PERINGATAN] {n_unmatched}/{len(grid_m)} cell tidak match ke kelurahan RBI manapun "
                f"(kemungkinan celah antar-polygon RBI 25K) -> {kol} pakai fallback rata-rata kota "
                f"(weighted): {rata2_kota:.4f}"
            )
            grid_m[kol] = grid_m[kol].fillna(rata2_kota)

    # --- kepadatan_poi_harian: jumlah POI real dalam radius RADIUS_POI_M dari centroid ---
    buffers = centroids.copy()
    buffers["geometry"] = buffers.geometry.buffer(RADIUS_POI_M)
    poi_join = gpd.sjoin(poi_m, buffers[["grid_analisis_id", "geometry"]], how="left", predicate="within")
    poi_count = poi_join.groupby("grid_analisis_id").size()
    grid_m["kepadatan_poi_harian"] = grid_m["grid_analisis_id"].map(poi_count).fillna(0).astype(int)

    # --- skor_aksesibilitas_transit: nearest halte (GABUNGAN survei+OSM sejak
    #     2026-09-11), decay 400/800m ---
    nearest = gpd.sjoin_nearest(
        centroids, halte_m[["halte_id", "nama_halte", "sumber_halte", "geometry"]],
        how="left", distance_col="jarak_halte_m",
    )
    nearest = nearest.loc[~nearest.index.duplicated(keep="first")]
    grid_m["jarak_halte_terdekat_m"] = nearest["jarak_halte_m"].values
    grid_m["nama_halte_terdekat"] = nearest["nama_halte"].values
    grid_m["sumber_halte_terdekat"] = nearest["sumber_halte"].values
    grid_m["skor_aksesibilitas_transit"] = skor_aksesibilitas_dari_jarak(grid_m["jarak_halte_terdekat_m"])

    grid_m["grid_id"] = grid_m["grid_analisis_id"].astype(str)  # id_col utk sensitivity_check_tdi
    return grid_m


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload", action="store_true", help="Upload hasil ke grid_analisis (default: dry-run, print saja)")
    args = parser.parse_args()

    client = get_client()

    print("=== 1. Susun fitur mentah TDI per grid (2.607 cell) ===\n")
    df = build_grid_features(client)

    print("\n=== 2. Bobot Indeks Kebutuhan Mobilitas dari konfigurasi_bobot ===")
    weights = load_weights_from_db(client, "TDI_MOBILITAS", DEFAULT_MOBILITY_WEIGHTS)

    print("\n=== 3. Hitung compute_tdi() untuk seluruh grid ===")
    scored = compute_tdi(df, weights)

    # Confidence Ratio TDI (035/docs/CONFIDENCE_RATIO.md) — BUKAN skor_tdi,
    # murni sinyal keandalan tambahan berdasar sumber_halte_terdekat yang
    # SUDAH dihitung di build_grid_features() (in-memory sebelumnya, sejak
    # 035 dipersist ke grid_analisis). Dipanggil terpisah SETELAH compute_tdi()
    # persis seperti didokumentasikan di compute_tdi_confidence() sendiri —
    # tidak menyentuh skor_tdi/skor_aksesibilitas_transit sama sekali.
    _confidence = compute_tdi_confidence(scored["sumber_halte_terdekat"])
    scored["tdi_confidence_ratio"] = _confidence["tdi_confidence_ratio"].values
    scored["tdi_confidence_tier"] = _confidence["tdi_confidence_tier"].values

    print("\n--- Ringkasan distribusi skor_tdi ---")
    print(scored["skor_tdi"].describe().round(4).to_string())
    print("\n--- Ringkasan distribusi kepadatan_penduduk (input, dasymetric-real) ---")
    print(scored["kepadatan_penduduk"].describe().round(2).to_string())
    print("\n--- Ringkasan distribusi skor_aksesibilitas_transit ---")
    print(scored["skor_aksesibilitas_transit"].describe().round(4).to_string())
    print("\n--- Ringkasan Confidence Ratio TDI (BUKAN AHP consistency_ratio) ---")
    print(scored["tdi_confidence_tier"].value_counts().to_string())

    print(f"\nTop 10 cell paling 'transit desert' (skor_tdi tertinggi):")
    print(scored[["grid_analisis_id", "kepadatan_penduduk", "proporsi_usia_rentan",
                   "proporsi_usia_sekolah", "kepadatan_poi_harian", "jarak_halte_terdekat_m",
                   "skor_aksesibilitas_transit", "skor_tdi"]].head(10).round(4).to_string(index=False))

    # --- Perbandingan skor_tdi LAMA (tersimpan di grid_analisis, 15 halte survei
    #     saja) vs BARU (halte GABUNGAN survei+OSM, 2026-09-11) ---
    print("\n--- skor_tdi LAMA (15 halte survei) vs BARU (halte gabungan survei+OSM) ---")
    lama_rows = fetch_all_paginated(client, "grid_analisis", "id, skor_tdi")
    lama_map = {r["id"]: (float(r["skor_tdi"]) if r["skor_tdi"] is not None else None) for r in lama_rows}
    cmp_df = scored[["grid_analisis_id", "skor_tdi"]].copy()
    cmp_df["skor_tdi_lama"] = cmp_df["grid_analisis_id"].map(lama_map)
    both = cmp_df.dropna(subset=["skor_tdi_lama"])
    for label, s in [("LAMA", both["skor_tdi_lama"]), ("BARU", both["skor_tdi"])]:
        print(
            f"  {label}: min={s.min():.4f} q1={s.quantile(0.25):.4f} median={s.median():.4f} "
            f"q3={s.quantile(0.75):.4f} max={s.max():.4f} mean={s.mean():.4f}"
        )
    td_lama = int((both["skor_tdi_lama"] > 0.6).sum())
    td_baru = int((both["skor_tdi"] > 0.6).sum())
    delta = (both["skor_tdi"] - both["skor_tdi_lama"]).abs()
    print(f"  Transit desert (skor_tdi > 0,6): LAMA {td_lama} -> BARU {td_baru} cell (dari {len(both)} cell dibandingkan)")
    print(f"  |delta skor_tdi|: median={delta.median():.4f} max={delta.max():.4f} ; "
          f"{int((delta > 0.05).sum())} cell berubah > 0,05 ; {int((delta > 0.10).sum())} cell berubah > 0,10")
    # Spearman = Pearson correlation atas rank (scipy tidak ter-install di
    # env ETL ini; hindari dependency baru untuk perhitungan sederhana ini).
    rho = both["skor_tdi"].rank().corr(both["skor_tdi_lama"].rank())
    n_null_new = int(scored["skor_tdi"].isna().sum())
    n_oob_new = int(((scored["skor_tdi"] < 0) | (scored["skor_tdi"] > 1)).sum())
    print(f"  Korelasi Spearman ranking LAMA vs BARU: rho={rho:.4f} (dari {len(both)} cell) "
          f"— mendekati 1 = perbaikan halus (refinement), bukan pengacakan ranking.")
    print(f"  skor_tdi NULL setelah recompute: {n_null_new} (harus 0)")
    print(f"  skor_tdi di luar rentang [0,1] setelah recompute: {n_oob_new} (harus 0)")

    # --- Face-validity: sel yang halte terdekatnya HANYA ada di sumber OSM
    #     (sebelumnya invisible ke formula LAMA) harus membaik ---
    print("\n--- Face-validity: sel dg halte terdekat dari sumber OSM (dulu invisible) ---")
    osm_terdekat = scored[scored["sumber_halte_terdekat"] == "osm_belum_disurvei"].copy()
    print(f"  Jumlah sel yang halte GABUNGAN terdekatnya adalah titik OSM: {len(osm_terdekat)}")
    if len(osm_terdekat):
        osm_terdekat = osm_terdekat.merge(
            cmp_df[["grid_analisis_id", "skor_tdi_lama"]], on="grid_analisis_id", how="left"
        )
        contoh = osm_terdekat.sort_values("jarak_halte_terdekat_m").head(5)
        print(
            contoh[["grid_analisis_id", "nama_halte_terdekat", "jarak_halte_terdekat_m",
                    "skor_aksesibilitas_transit", "skor_tdi_lama", "skor_tdi"]]
            .rename(columns={"skor_tdi_lama": "skor_tdi_LAMA", "skor_tdi": "skor_tdi_BARU"})
            .round(4).to_string(index=False)
        )
        # Toleransi kecil (1e-4) karena skor_tdi_lama tersimpan dibulatkan 4
        # desimal di grid_analisis, sedangkan skor_tdi baru dihitung presisi
        # penuh -- selisih di bawah itu murni noise pembulatan, bukan regresi.
        delta_osm = osm_terdekat["skor_tdi"] - osm_terdekat["skor_tdi_lama"]
        membaik = (delta_osm < -1e-4).mean()
        memburuk = (delta_osm > 1e-4).mean()
        print(f"  {membaik:.1%} dari sel-sel ini skor_tdi TURUN (membaik) setelah halte OSM diperhitungkan; "
              f"{memburuk:.1%} naik (di luar toleransi pembulatan 1e-4 — harus ~0%, sinyal regresi kalau tinggi); "
              f"sisanya praktis tidak berubah (halte terdekat gabungan == halte terdekat lama).")
        print(f"  delta skor_tdi (BARU-LAMA) di sel ini: mean={delta_osm.mean():.4f} "
              f"min={delta_osm.min():.4f} max={delta_osm.max():.4f}")

    print("\n=== 4. Sensitivity analysis (geser bobot mobilitas ±10%) ===")
    sens = sensitivity_check_tdi(scored, weights)
    print(sens.to_string(index=False))
    n_unstable = (sens["jumlah_ranking_berubah"] > 0).sum()
    print(f"\n{n_unstable}/{len(sens)} skenario pergeseran bobot mengubah ranking skor_tdi (dari {len(scored)} cell).")

    print("\n=== 5. Face-validity check: skor_tdi dekat vs jauh dari halte real ===")
    dekat = scored[scored["jarak_halte_terdekat_m"] <= AMBANG_PENUH_M]
    jauh = scored[scored["jarak_halte_terdekat_m"] > AMBANG_NIHIL_M]
    print(f"Cell dalam {AMBANG_PENUH_M}m dari halte terdekat (n={len(dekat)}): rata2 skor_tdi = {dekat['skor_tdi'].mean():.4f}")
    print(f"Cell di atas {AMBANG_NIHIL_M}m dari halte terdekat (n={len(jauh)}): rata2 skor_tdi = {jauh['skor_tdi'].mean():.4f}")

    if args.upload:
        print("\n=== 6. Upload ke grid_analisis ===")
        upload_tdi_scores(client, scored)
    else:
        print("\n[DRY-RUN] --upload tidak diberikan, TIDAK ada perubahan ditulis ke Supabase.")
