"""
compute_cai_grid.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

SURFACE Composite Accessibility Index (CAI) 300 m di grid_analisis — HYBRID:
kriteria DIUKUR di sel yang punya data lapangan di dekatnya (titik survei /
halte tersurvei) dan DITURUNKAN dari geodata (kepadatan dasymetric, jarak POI
OSM) di sel lain. Kapabilitas BARU yang ADITIF:

  * TIDAK menyentuh tabel skor_cai berbasis titik, alur titik_kandidat,
    maupun recompute_all_cai_scores() — ketiganya tetap jadi basis
    normalisasi min-max untuk usulan_halte_model.
  * Menulis kolom cai_* baru di grid_analisis (lihat
    supabase/migrations/033_skor_cai_grid.sql) + di-baca RPC get_cai_breakdown().

FORMULA (ADITIF, Weighted Linear Combination — sejajar CAI titik, BUKAN rasio
seperti TDI):

    cai_skor = Sum( cai_n_i * cai_bobot_i )   untuk i pada {kepadatan, jarak_inv, volume, survei}
                                              yang AKTIF di sel tsb

  - cai_n_kepadatan = minmax( kepadatan_penduduk )                     [SELALU aktif]
  - cai_n_jarak_inv = minmax( jarak ke POI fasilitas umum, INVERSE )   [SELALU aktif; clip 3000 m]
  - cai_n_volume    = minmax( total_aktivitas titik survei terdekat )  [aktif HANYA di sel terukur]
  - cai_n_survei    = skor kondisi halte tersurvei <= 400 m            [aktif HANYA kalau ada halte]
  minmax kepadatan & jarak dihitung lintas SEMUA sel; minmax volume dihitung
  lintas HANYA sel terukur (~37 sel).
  Bobot dasar dari konfigurasi_bobot nama_index='CAI' (AHP pairwise Saaty
  formal 2026-09-03, CR = 0,0226): kepadatan 0,3290 / jarak_inv 0,3290 /
  volume 0,2002 / survei 0,1418.

BOBOT EFEKTIF PER SEL — renormalisasi subset kriteria yang AKTIF ke jumlah 1
(logika identik compute_scores.compute_cai(exclude_criteria=...), tapi exclude
bisa {'volume'}, {'survei'}, atau {'volume','survei'} per sel). Empat kasus:
  - kepadatan + jarak                 -> 0,5000 / 0,5000                 (mayoritas sel)
  - kepadatan + jarak + survei        -> 0,4113 / 0,4113 / 0,1775
  - kepadatan + jarak + volume        -> 0,3834 / 0,3834 / 0,2331
  - keempatnya                        -> 0,3290 / 0,3290 / 0,2002 / 0,1418
Kepadatan & jarak dinilai SAMA di AHP (0,329 = 0,329) -> kasus 2-kriteria
0,5/0,5 adalah rasio AHP persis, hanya di-rescale ke jumlah 1.

VOLUME — HANYA sel terukur:
  * Sel MEMUAT titik survei ATAU centroid <= 300 m dari titik survei REAL
    -> cai_volume_penumpang = total_aktivitas titik terdekat; kriteria volume AKTIF.
  * Sel lain -> cai_volume_penumpang / cai_n_volume / cai_bobot_volume = NULL
    (volume N/A, mekanisme sama persis dg survei N/A). Tidak ada estimasi
    regresi apa pun (Opsi B, keputusan Sam 2026-09-10: R^2 regresi
    kepadatan<->volume terlalu lemah, intercept tak masuk akal).
  Kolom cai_volume_estimasi DIPERTAHANKAN di schema untuk stabilitas, tapi
  SELALU bernilai False (tidak ada sel estimasi).

RADII (semua DIPINJAM dari konstanta yang sudah berlaku di repo):
  POI clip 3000 m · volume "terukur" <= 300 m (= lebar sel) ·
  survei halte <= 400 m (= AMBANG_PENUH_M / walking catchment ITDP) ·
  RPC "di luar grid" > 500 m (cermin get_tdi_breakdown / migration 021).

RUNBOOK (grid_analisis HARUS sudah terisi — sudah: 2607 sel dg skor_tdi):
    supabase db push                          # terapkan 033_skor_cai_grid.sql
    python etl/compute_cai_grid.py            # hitung + print, TIDAK upload (default)
    python etl/compute_cai_grid.py --upload   # hitung + tulis kolom cai_* ke grid_analisis
Offline (Supabase tidak dikonfigurasi): jalan self-test grid+titik sintetis, print saja.

Konvensi ikut sibling ETL: argparse, EPSG:32748 utk semua operasi metrik,
reuse helper dari rerun_dasymetric_grid / compute_scores.
"""

import argparse
import os
import sys
from datetime import datetime, timezone

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely.geometry as sg

from compute_scores import (
    normalize_min_max,
    DEFAULT_WEIGHTS,
    CAI_CRITERIA_KEYS,
    confidence_tier_dari_ratio,
)
from build_fishnet_grid import WGS84
from rerun_dasymetric_grid import fetch_all_paginated, wkb_hex_to_geom

METRIC_CRS = "EPSG:32748"  # UTM 48S — sama dengan seluruh pipeline ETL lain

# --- radii (semua DIPINJAM dari konstanta yang sudah berlaku di repo) ---
JARAK_FASILITAS_CLIP_M = 3000.0     # batas atas jarak POI (di atas ini efek inverse ~nol, hindari outlier skala)
RADIUS_VOLUME_TERUKUR_M = 300.0     # = lebar sel; sel <= 300 m dari titik survei -> kriteria volume aktif
RADIUS_SURVEI_HALTE_M = 400.0       # = AMBANG_PENUH_M compute_tdi_full / walking catchment ITDP (003_simulate_new_stop)

SUMBER_POI_REAL = "OpenStreetMap"                      # konsisten attach_cai_features_titik_kandidat / compute_tdi_full
JENIS_POI_FASILITAS_UMUM = ("sekolah", "faskes", "kerja")
PREFIX_TITIK_DEMO = "KND-DEMO-"                         # = PREFIX_ID_TITIK_SURVEI_DEMO (007 seed rows), dikecualikan
PREFIX_HALTE_DUMMY = "DUMMY-HLT-"                       # = compute_tdi_full.load_halte_real()

# Empat pola bobot efektif yang mungkin (untuk verifikasi/print — bukan dipakai
# langsung; bobot dihitung per-sel dari denominator subset aktif).
POLA_BOBOT_DOC = {
    "kepadatan+jarak":                 (0.5000, 0.5000),
    "kepadatan+jarak+survei":          (0.4113, 0.4113, 0.1775),
    "kepadatan+jarak+volume":          (0.3834, 0.3834, 0.2331),
    "kepadatan+jarak+volume+survei":   (0.3290, 0.3290, 0.2002, 0.1418),
}


def _num_or_none(x, nd: int = 4):
    """Bulatkan ke nd desimal, atau None kalau NaN/None (kolom N/A -> NULL SQL)."""
    if x is None or pd.isna(x):
        return None
    return round(float(x), nd)


# ------------------------------------------------------------
# Loader (live Supabase)
# ------------------------------------------------------------
def load_grid(client) -> gpd.GeoDataFrame:
    rows = fetch_all_paginated(client, "grid_analisis", "id, geom, kepadatan_penduduk")
    gdf = gpd.GeoDataFrame(
        {"id": [r["id"] for r in rows],
         "kepadatan_penduduk": [float(r["kepadatan_penduduk"] or 0.0) for r in rows]},
        geometry=[wkb_hex_to_geom(r["geom"]) for r in rows], crs=WGS84,
    )
    print(f"[INFO] grid_analisis: {len(gdf)} sel.")
    return gdf


def load_poi_fasilitas_umum(client) -> gpd.GeoDataFrame:
    rows = fetch_all_paginated(client, "poi", "id, jenis, geom", filters={"sumber": SUMBER_POI_REAL})
    rows = [r for r in rows if r["jenis"] in JENIS_POI_FASILITAS_UMUM]
    gdf = gpd.GeoDataFrame({"poi_id": [r["id"] for r in rows]},
                           geometry=[wkb_hex_to_geom(r["geom"]) for r in rows], crs=WGS84)
    print(f"[INFO] POI fasilitas umum ({'/'.join(JENIS_POI_FASILITAS_UMUM)}, {SUMBER_POI_REAL}): {len(gdf)}.")
    return gdf


def load_halte_kondisi(client) -> gpd.GeoDataFrame:
    """Halte REAL (DUMMY-HLT-* dikecualikan) yang punya skor kondisi:
    skor_survei_gabungan kalau ada, kalau tidak fallback skor_kelengkapan_fisik."""
    rows = fetch_all_paginated(
        client, "halte_eksisting",
        "id, id_halte_survei, geom, skor_survei_gabungan, skor_kelengkapan_fisik",
    )
    ids, skors, geoms, kolom = [], [], [], []
    for r in rows:
        if str(r["id_halte_survei"] or "").startswith(PREFIX_HALTE_DUMMY):
            continue
        if r["skor_survei_gabungan"] is not None:
            s, src = float(r["skor_survei_gabungan"]), "skor_survei_gabungan"
        elif r["skor_kelengkapan_fisik"] is not None:
            s, src = float(r["skor_kelengkapan_fisik"]), "skor_kelengkapan_fisik"
        else:
            continue
        ids.append(r["id"]); skors.append(s); kolom.append(src)
        geoms.append(wkb_hex_to_geom(r["geom"]))
    gdf = gpd.GeoDataFrame({"halte_id": ids, "cai_skor_survei": skors, "kolom_kondisi": kolom},
                           geometry=geoms, crs=WGS84)
    n_gab = int((gdf["kolom_kondisi"] == "skor_survei_gabungan").sum()) if len(gdf) else 0
    n_fis = int((gdf["kolom_kondisi"] == "skor_kelengkapan_fisik").sum()) if len(gdf) else 0
    print(f"[INFO] halte_eksisting REAL dg skor kondisi: {len(gdf)} "
          f"({n_gab} pakai skor_survei_gabungan, {n_fis} fallback skor_kelengkapan_fisik).")
    return gdf


def load_titik_survei_volume(client) -> gpd.GeoDataFrame:
    """titik_kandidat REAL (KND-DEMO-* / seed 007 dikecualikan) dg total_aktivitas
    (cacahan Traffic Counting 2 jam)."""
    rows = fetch_all_paginated(client, "titik_kandidat", "id, id_titik_survei, geom, total_aktivitas")
    ids, tot, geoms = [], [], []
    for r in rows:
        if str(r["id_titik_survei"] or "").startswith(PREFIX_TITIK_DEMO):
            continue
        if r["total_aktivitas"] is None:
            continue
        ids.append(r["id"]); tot.append(int(r["total_aktivitas"]))
        geoms.append(wkb_hex_to_geom(r["geom"]))
    gdf = gpd.GeoDataFrame({"titik_id": ids, "total_aktivitas": tot}, geometry=geoms, crs=WGS84)
    print(f"[INFO] titik_kandidat REAL dg total_aktivitas: {len(gdf)} titik (KND-DEMO-* dikecualikan).")
    return gdf


# ------------------------------------------------------------
# Inti — geometry-in, tanpa client (dipakai jalur live & offline)
# ------------------------------------------------------------
def compute_cai_grid(grid: gpd.GeoDataFrame, poi: gpd.GeoDataFrame,
                     halte: gpd.GeoDataFrame, survei: gpd.GeoDataFrame,
                     weights: dict):
    """
    grid   : [id, kepadatan_penduduk, geometry]  EPSG:4326
    poi    : [geometry]                           fasilitas umum OSM
    halte  : [cai_skor_survei, geometry]          halte REAL dg skor kondisi 0-1
    survei : [total_aktivitas, geometry]          titik_kandidat REAL
    weights: {kepadatan, jarak_inv, volume, survei}  (jumlah 1)
    Return : (DataFrame kolom cai_* selaras grid, dict ringkas kasus bobot)
    """
    assert abs(sum(weights[k] for k in CAI_CRITERIA_KEYS) - 1.0) < 1e-6, "bobot CAI harus jumlah 1"

    g = grid.to_crs(METRIC_CRS).reset_index(drop=True)
    cent = g.copy()
    cent["geometry"] = cent.geometry.centroid

    out = pd.DataFrame({"id": g["id"].values})
    out["kepadatan_penduduk"] = g["kepadatan_penduduk"].astype(float).values

    # --- 1. jarak ke fasilitas umum terdekat (centroid -> POI), clip 3000 m ---
    poi_m = poi.to_crs(METRIC_CRS)
    nn_poi = gpd.sjoin_nearest(cent[["id", "geometry"]], poi_m[["geometry"]],
                               how="left", distance_col="d")
    nn_poi = nn_poi.loc[~nn_poi.index.duplicated(keep="first")].reset_index(drop=True)
    out["cai_jarak_fasilitas_m"] = np.minimum(nn_poi["d"].astype(float).values, JARAK_FASILITAS_CLIP_M)

    # --- 2. volume transit — HANYA sel terukur (Opsi B: tanpa estimasi regresi) ---
    survei_m = survei.to_crs(METRIC_CRS).reset_index(drop=True)
    nn_s = gpd.sjoin_nearest(cent[["id", "geometry"]],
                             survei_m[["total_aktivitas", "geometry"]],
                             how="left", distance_col="d")
    nn_s = nn_s.loc[~nn_s.index.duplicated(keep="first")].reset_index(drop=True)
    dist_survei = nn_s["d"].astype(float).values
    vol_terdekat = nn_s["total_aktivitas"].astype(float).values

    contains = gpd.sjoin(g[["id", "geometry"]], survei_m[["geometry"]],
                         how="left", predicate="contains")
    contains_ids = set(contains.loc[contains["index_right"].notna(), "id"])
    contains_mask = out["id"].isin(contains_ids).values

    terukur_mask = contains_mask | (dist_survei <= RADIUS_VOLUME_TERUKUR_M)
    out["cai_volume_penumpang"] = np.where(terukur_mask, vol_terdekat, np.nan)
    out["cai_volume_estimasi"] = False  # DIPERTAHANKAN di schema, selalu False (tidak ada estimasi)
    obs_min = float(np.min(survei_m["total_aktivitas"])) if len(survei_m) else float("nan")
    obs_max = float(np.max(survei_m["total_aktivitas"])) if len(survei_m) else float("nan")
    print(f"[INFO] volume: {int(terukur_mask.sum())} sel TERUKUR (memuat titik survei / <= "
          f"{RADIUS_VOLUME_TERUKUR_M:.0f} m); {int((~terukur_mask).sum())} sel volume N/A. "
          f"total_aktivitas terobservasi min={obs_min:.0f} max={obs_max:.0f}.")

    # --- 3. skor survei kondisi halte (centroid -> halte REAL <= 400 m) ---
    halte_m = halte.to_crs(METRIC_CRS)
    nn_h = gpd.sjoin_nearest(cent[["id", "geometry"]],
                             halte_m[["cai_skor_survei", "geometry"]],
                             how="left", distance_col="d")
    nn_h = nn_h.loc[~nn_h.index.duplicated(keep="first")].reset_index(drop=True)
    skor_h = nn_h["cai_skor_survei"].astype(float).values
    skor_h = np.where(nn_h["d"].astype(float).values <= RADIUS_SURVEI_HALTE_M, skor_h, np.nan)
    out["cai_skor_survei"] = skor_h
    print(f"[INFO] survei: {int(np.isfinite(skor_h).sum())} sel punya halte tersurvei <= "
          f"{RADIUS_SURVEI_HALTE_M:.0f} m (kriteria survei aktif), sisanya N/A.")

    # --- 4. normalisasi min-max ---
    out["cai_n_kepadatan"] = normalize_min_max(out["kepadatan_penduduk"]).values          # lintas SEMUA sel
    out["cai_n_jarak_inv"] = normalize_min_max(out["cai_jarak_fasilitas_m"], inverse=True).values  # lintas SEMUA sel
    # volume: minmax lintas HANYA sel terukur (non-null); sel lain tetap NaN
    vol = out["cai_volume_penumpang"]
    n_vol = pd.Series(np.nan, index=out.index)
    m = vol.notna()
    if bool(m.any()):
        n_vol.loc[m] = normalize_min_max(vol[m]).values
    out["cai_n_volume"] = n_vol.values
    out["cai_n_survei"] = out["cai_skor_survei"]  # apa adanya (0-1), NaN tetap NaN

    # --- 5. bobot efektif per sel: renormalisasi subset kriteria AKTIF ke jumlah 1 ---
    has_volume = out["cai_n_volume"].notna().values
    has_survei = out["cai_n_survei"].notna().values
    w = weights
    denom = (
        w["kepadatan"] + w["jarak_inv"]
        + np.where(has_volume, w["volume"], 0.0)
        + np.where(has_survei, w["survei"], 0.0)
    )
    out["cai_bobot_kepadatan"] = w["kepadatan"] / denom
    out["cai_bobot_jarak"] = w["jarak_inv"] / denom
    out["cai_bobot_volume"] = np.where(has_volume, w["volume"] / denom, np.nan)
    out["cai_bobot_survei"] = np.where(has_survei, w["survei"] / denom, np.nan)

    # --- 5b. Confidence Ratio (BARU 2026-09-13, BUKAN AHP consistency_ratio —
    #     lihat docs/CONFIDENCE_RATIO.md) = n_kriteria_aktif / 4. Kepadatan &
    #     jarak SELALU aktif (2); +volume/+survei kalau kriteria itu aktif di
    #     sel ini. Murni sinyal keandalan tambahan, TIDAK memengaruhi cai_skor. ---
    n_aktif = 2 + has_volume.astype(int) + has_survei.astype(int)
    out["cai_confidence_n_kriteria"] = n_aktif
    out["cai_confidence_ratio"] = n_aktif / 4.0
    out["cai_confidence_tier"] = out["cai_confidence_ratio"].map(confidence_tier_dari_ratio)

    # --- 6. skor CAI grid (ADITIF: Sum nilai_i * bobot_i untuk kriteria AKTIF) ---
    term_v = (out["cai_bobot_volume"] * out["cai_n_volume"]).where(pd.Series(has_volume, index=out.index), 0.0)
    term_s = (out["cai_bobot_survei"] * out["cai_n_survei"]).where(pd.Series(has_survei, index=out.index), 0.0)
    out["cai_skor"] = (
        out["cai_bobot_kepadatan"] * out["cai_n_kepadatan"]
        + out["cai_bobot_jarak"] * out["cai_n_jarak_inv"]
        + term_v + term_s
    )

    # --- asersi ---
    assert out["cai_skor"].between(-1e-9, 1 + 1e-9).all(), "cai_skor keluar dari [0,1]"
    out["cai_skor"] = out["cai_skor"].clip(0.0, 1.0)
    min_kriteria = out["cai_bobot_kepadatan"].notna() & out["cai_bobot_jarak"].notna()
    assert bool(min_kriteria.all()), "ada sel tanpa kriteria kepadatan+jarak (minimal 2 harus selalu ada)"

    # ringkas distribusi kasus bobot
    kasus = np.where(
        has_volume & has_survei, "kepadatan+jarak+volume+survei",
        np.where(has_volume, "kepadatan+jarak+volume",
                 np.where(has_survei, "kepadatan+jarak+survei", "kepadatan+jarak")),
    )
    dist = pd.Series(kasus).value_counts().to_dict()
    return out, {"dist_kasus": dist, "obs_min": obs_min, "obs_max": obs_max}


# ------------------------------------------------------------
# Ringkasan + upload
# ------------------------------------------------------------
_SAMPLE_COLS = [
    "id", "kepadatan_penduduk", "cai_jarak_fasilitas_m", "cai_volume_penumpang", "cai_volume_estimasi",
    "cai_n_kepadatan", "cai_n_jarak_inv", "cai_n_volume", "cai_n_survei",
    "cai_bobot_kepadatan", "cai_bobot_jarak", "cai_bobot_volume", "cai_bobot_survei", "cai_skor",
    "cai_confidence_ratio", "cai_confidence_tier",
]


def print_summary(out: pd.DataFrame, meta: dict):
    s = out["cai_skor"]
    recon = (
        out["cai_bobot_kepadatan"] * out["cai_n_kepadatan"]
        + out["cai_bobot_jarak"] * out["cai_n_jarak_inv"]
        + (out["cai_bobot_volume"] * out["cai_n_volume"]).fillna(0.0)
        + (out["cai_bobot_survei"] * out["cai_n_survei"]).fillna(0.0)
    )
    print("\n=== RINGKASAN skor_cai_grid ===")
    print(f"  n sel                      : {len(out)}")
    print(f"  total_aktivitas observed   : min={meta['obs_min']:.0f}  max={meta['obs_max']:.0f}")
    print(f"  sel volume TERUKUR (aktif) : {int(out['cai_n_volume'].notna().sum())}")
    print(f"  sel dg term survei aktif   : {int(out['cai_n_survei'].notna().sum())}")
    print("  distribusi kasus bobot     :")
    for k, v in sorted(meta["dist_kasus"].items(), key=lambda kv: -kv[1]):
        print(f"     {k:<32} {v}")
    print(f"  cai_skor min/mean/max      : {s.min():.4f} / {s.mean():.4f} / {s.max():.4f}")
    print(f"  |cai_skor - Sum(n_i*bobot_i)| max = {(s - recon).abs().max():.2e}  (~0 -> aditif & dapat ditelusuri)")
    print("\n  5 sampel baris:")
    print(out[_SAMPLE_COLS].head(5).to_string(index=False))


def upload_cai_grid(client, out: pd.DataFrame, chunk: int = 500, resume: bool = True):
    """UPDATE (bukan upsert) kolom cai_* di grid_analisis, per baris by id.

    CATATAN: grid_analisis.id adalah `generated always as identity` — PostgREST
    MENOLAK upsert yang menyertakan `id` ('cannot insert a non-DEFAULT value
    into column "id"'). Semua 2607 sel sudah ada, jadi ini murni UPDATE. Pola
    identik dg rerun_dasymetric_grid.upload_kepadatan_only(): `.update(payload)
    .eq('id', ...)` per baris (2607 request; parameter `chunk` hanya dipakai
    untuk kadensi progress-print).

    resume=True (default): lewati sel yang `cai_dihitung_pada` sudah terisi,
    supaya run yang ke-kill di tengah (mis. OOM) tinggal dijalankan ulang dan
    lanjut dari sisa — bukan mulai dari 0. Jalankan ulang sampai 'sisa: 0'."""
    now_iso = datetime.now(timezone.utc).isoformat()
    done_ids = set()
    if resume:
        got = 0
        page = 1000
        start = 0
        while True:
            res = (
                client.table("grid_analisis")
                .select("id")
                .not_.is_("cai_dihitung_pada", "null")
                .range(start, start + page - 1)
                .execute()
            )
            batch = res.data or []
            done_ids.update(int(x["id"]) for x in batch)
            got += len(batch)
            if len(batch) < page:
                break
            start += page
        if done_ids:
            print(f"  resume: {len(done_ids)} sel sudah terisi cai_* -> dilewati.")
    pending = out[~out["id"].astype(int).isin(done_ids)]
    total = len(pending)
    if total == 0:
        print("[UPLOAD] tidak ada sisa — semua sel sudah terisi cai_*.")
        return
    print(f"  akan meng-update {total} sel (sisa).")
    for i, (_, r) in enumerate(pending.iterrows(), start=1):
        payload = {
            "cai_jarak_fasilitas_m": _num_or_none(r["cai_jarak_fasilitas_m"], 2),
            "cai_volume_penumpang": _num_or_none(r["cai_volume_penumpang"], 2),
            "cai_skor_survei": _num_or_none(r["cai_skor_survei"], 4),
            "cai_volume_estimasi": bool(r["cai_volume_estimasi"]),
            "cai_n_kepadatan": _num_or_none(r["cai_n_kepadatan"], 4),
            "cai_n_jarak_inv": _num_or_none(r["cai_n_jarak_inv"], 4),
            "cai_n_volume": _num_or_none(r["cai_n_volume"], 4),
            "cai_n_survei": _num_or_none(r["cai_n_survei"], 4),
            "cai_bobot_kepadatan": _num_or_none(r["cai_bobot_kepadatan"], 4),
            "cai_bobot_jarak": _num_or_none(r["cai_bobot_jarak"], 4),
            "cai_bobot_volume": _num_or_none(r["cai_bobot_volume"], 4),
            "cai_bobot_survei": _num_or_none(r["cai_bobot_survei"], 4),
            "cai_skor": _num_or_none(r["cai_skor"], 4),
            # Confidence Ratio (035/docs/CONFIDENCE_RATIO.md) — dihitung di
            # compute_cai_grid() di atas. Migration 035 sudah membackfill kolom
            # ini langsung via SQL untuk data yang ada saat migration di-apply;
            # disertakan di sini juga supaya rerun ETL berikutnya (data baru/
            # berubah) tidak meninggalkan confidence basi dibanding cai_bobot_*.
            "cai_confidence_n_kriteria": int(r["cai_confidence_n_kriteria"]),
            "cai_confidence_ratio": _num_or_none(r["cai_confidence_ratio"], 4),
            "cai_confidence_tier": r["cai_confidence_tier"],
            "cai_dihitung_pada": now_iso,
        }
        client.table("grid_analisis").update(payload).eq("id", int(r["id"])).execute()
        if i % chunk == 0 or i == total:
            print(f"  update {i}/{total}")
    print(f"[UPLOAD] {total} baris grid_analisis diperbarui kolom cai_* (cai_dihitung_pada={now_iso}).")


# ------------------------------------------------------------
# Jalur live
# ------------------------------------------------------------
def run_live(args):
    from upload_to_supabase import get_client, load_weights_from_db

    client = get_client()
    weights = load_weights_from_db(client, "CAI", DEFAULT_WEIGHTS)
    weights = {k: float(weights[k]) for k in CAI_CRITERIA_KEYS}  # jaga urutan & tipe

    print("\n=== Muat grid_analisis + POI fasilitas umum + halte kondisi + titik survei ===")
    grid = load_grid(client)
    if grid.empty:
        raise SystemExit("grid_analisis kosong — jalankan build_fishnet_grid.py + rerun_dasymetric_grid.py dulu.")
    poi = load_poi_fasilitas_umum(client)
    halte = load_halte_kondisi(client)
    survei = load_titik_survei_volume(client)

    print("\n=== Hitung surface CAI grid (hybrid, tanpa estimasi regresi) ===")
    out, meta = compute_cai_grid(grid, poi, halte, survei, weights)
    print_summary(out, meta)

    if args.upload:
        # Simpan hasil ke CSV dulu (recovery: kalau upload ke-kill, jalankan
        # ulang `--upload` — resume=True lanjut dari sisa; CSV bukan syarat,
        # cuma jejak). Lalu bebaskan GeoDataFrame besar sebelum loop 2607
        # request supaya jejak memori kecil (mesin sempat OOM-kill run ini).
        import gc
        csv_path = os.path.join(os.path.dirname(__file__), "data", "_cai_grid_computed.csv")
        try:
            out.to_csv(csv_path, index=False)
            print(f"\n[JEJAK] hasil komputasi disimpan: {csv_path}")
        except OSError as e:
            print(f"[JEJAK] gagal simpan CSV ({e}) — lanjut upload langsung.")
        del grid, poi, halte, survei
        gc.collect()
        print("\n=== Upload ke grid_analisis ===")
        upload_cai_grid(client, out)
    else:
        print("\n[DRY-RUN] --upload tidak diberikan - TIDAK ada yang ditulis ke Supabase. "
              "Jalankan ulang dengan --upload setelah hasil di atas dinilai masuk akal.")


# ------------------------------------------------------------
# Jalur offline self-test (Supabase tidak dikonfigurasi)
# ------------------------------------------------------------
def run_offline_selftest():
    print("=== OFFLINE SELF-TEST (SUPABASE_URL / SERVICE_ROLE_KEY tidak diset) ===")
    print("Tidak ada CSV survei di etl/data/survei/ -> pakai grid + titik survei sintetis, print saja.\n")

    x0, y0, step = 106.98, -6.28, 0.0027  # ~300 m
    rng = np.random.default_rng(42)
    cells, ids, dens = [], [], []
    k = 1
    for i in range(6):
        for j in range(6):
            minx, miny = x0 + i * step, y0 + j * step
            cells.append(sg.box(minx, miny, minx + step, miny + step))
            ids.append(k); k += 1
            dens.append(float(rng.integers(200, 3500)))
    grid = gpd.GeoDataFrame({"id": ids, "kepadatan_penduduk": dens}, geometry=cells, crs=WGS84)
    poi = gpd.GeoDataFrame(
        geometry=[sg.Point(x0 + 0.004, y0 + 0.004), sg.Point(x0 + 0.012, y0 + 0.010),
                  sg.Point(x0 + 0.006, y0 + 0.014)], crs=WGS84)
    halte = gpd.GeoDataFrame(
        {"cai_skor_survei": [0.62, 0.80]},
        geometry=[sg.Point(x0 + 0.0035, y0 + 0.0035), sg.Point(x0 + 0.014, y0 + 0.006)], crs=WGS84)
    survei = gpd.GeoDataFrame(
        {"total_aktivitas": [12, 25, 40, 63, 78]},
        geometry=[sg.Point(x0 + 0.001 + 0.010 * t, y0 + 0.001 + 0.009 * t) for t in range(5)], crs=WGS84)

    weights = {kk: float(vv) for kk, vv in DEFAULT_WEIGHTS.items()}
    out, meta = compute_cai_grid(grid, poi, halte, survei, weights)
    print_summary(out, meta)

    # Contoh perhitungan manual (buktikan hasil masuk akal, bukan cuma "jalan"):
    print("\n  --- Telusur manual 3 sel pertama (Sum nilai_i * bobot_i, kriteria aktif saja) ---")
    for _, r in out.head(3).iterrows():
        parts = [("kepadatan", r.cai_n_kepadatan, r.cai_bobot_kepadatan),
                 ("jarak_inv", r.cai_n_jarak_inv, r.cai_bobot_jarak),
                 ("volume", r.cai_n_volume, r.cai_bobot_volume),
                 ("survei", r.cai_n_survei, r.cai_bobot_survei)]
        segs, tot = [], 0.0
        for nama, n_i, w_i in parts:
            if pd.isna(n_i) or pd.isna(w_i):
                segs.append(f"{nama}=N/A")
                continue
            tot += n_i * w_i
            segs.append(f"{nama}({n_i:.3f}x{w_i:.3f}={n_i * w_i:.3f})")
        print(f"   sel {int(r.id):>2}: " + " + ".join(segs) + f"  => cai_skor={tot:.4f} (tersimpan {r.cai_skor:.4f})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Surface CAI grid 300 m (hybrid) di grid_analisis — aditif, tidak menyentuh skor_cai titik.")
    ap.add_argument("--upload", action="store_true",
                    help="Tulis kolom cai_* ke grid_analisis (default: hitung + print saja).")
    args = ap.parse_args()

    from dotenv import load_dotenv
    load_dotenv()
    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        run_live(args)
    else:
        run_offline_selftest()
        sys.exit(0)
