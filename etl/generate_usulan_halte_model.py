"""
generate_usulan_halte_model.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

GENERATOR USULAN HALTE BERBASIS MODEL SPASIAL (bukan berbasis "di mana tim
kebetulan survei"). Mengisi tabel `usulan_halte_model` (migration
028_usulan_halte_model.sql).

===========================================================================
KENAPA SCRIPT INI ADA (gap metodologis yang ditutup)
===========================================================================
PRD Bab 1.1 menempatkan produk ini sebagai penjawab: "di titik mana
pengembangan layanan transit akan memberikan dampak aksesibilitas terbesar".
Artinya MODEL yang harus MENGUSULKAN lokasi.

Sebelum script ini, yang ada:
  * grid_analisis (2.607 sel @300 m, skor_tdi) -> transit desert, sekota, model
  * skor_equity   (56 kelurahan)               -> ranking ketimpangan, sekota, model
  * skor_cai                                   -> HANYA di 19 titik_kandidat survei
Sehingga "Usulan Halte Prioritas" = 19 titik yang didatangi surveyor, diurut
CAI. TIDAK ADA langkah yang menurunkan kandidat halte dari keluaran TDI/Equity.

Script ini menambahkan langkah itu — MURNI ADITIF, tidak menyentuh CAI, TDI,
maupun Equity (tidak ada satu pun kolom skor lama yang ditulis ulang).

===========================================================================
METODOLOGI (semua ambang DIPINJAM dari yang SUDAH ada di repo — tidak ada
konstanta baru yang dikarang)
===========================================================================
1. SUMBER KANDIDAT — sel `grid_analisis` dengan `skor_tdi` > 0,6.
   Ambang 0,6 = definisi "transit desert" yang SUDAH berlaku di:
     - frontend/src/components/Dashboard/Dashboard.jsx  TRANSIT_DESERT_THRESHOLD = 0.6
     - frontend/src/components/DataLaporan/DataLaporan.jsx (konstanta sama)
     - supabase/migrations/022_potensi_penerima_manfaat.sql (ambang_tdi default 0.6)
   Sengaja tidak mendefinisikan ambang baru supaya "jumlah transit desert" di
   dashboard dan "kolam kandidat" script ini adalah HIMPUNAN YANG SAMA.

2. SARING JARAK KE LAYANAN EKSISTING — buang sel yang centroid-nya < 400 m
   dari halte_eksisting REAL mana pun. Halte DUMMY-HLT-* dikecualikan persis
   seperti compute_tdi_full.load_halte_real().
   400 m = walking catchment ITDP yang SUDAH dipakai di
   supabase/migrations/003_simulate_new_stop.sql (radius 400 m, komentar
   "standar ITDP walking catchment") dan compute_tdi_full.AMBANG_PENUH_M.
   Alasan: menambah halte di dalam catchment halte yang sudah ada = duplikasi
   layanan, bukan penambahan aksesibilitas.
   CATATAN JUJUR (run 2026-09-07): filter ini saat ini MEMBUANG 0 dari 1.503
   sel — bukan karena tidak jalan, tapi karena `skor_aksesibilitas_transit`
   (penyebut TDI) sudah memakai decay 400/800 m ke halte real yang sama,
   sehingga sel dekat halte praktis tidak pernah menembus skor_tdi > 0,6.
   Filter tetap dipertahankan sebagai guard eksplisit: begitu halte
   eksisting bertambah/berubah, langkah ini yang mencegah usulan tumpang
   tindih. Jarak terdekat pada run ini: 1.117 m.

3. DE-KLASTER (greedy, jarak minimum antar-usulan 800 m) — sel diurut
   `skor_tdi` desc; ambil sel teratas, lalu TOLAK setiap sel berikutnya yang
   berjarak < 800 m dari titik yang sudah terpilih. Ulangi sampai MAKS_USULAN.
   800 m = catchment luar yang SUDAH dipakai (compute_tdi_full.AMBANG_NIHIL_M
   dan radius kedua simulate_new_stop). Alasan: dua usulan yang berjarak
   < 800 m melayani populasi yang sebagian besar sama -> daftar-pendek jadi
   redundan (klaster pin di satu blok, bukan sebaran prioritas kota).
   Greedy dipilih (bukan k-means / p-median) karena bisa ditelusuri manual:
   urutannya deterministik dan tiap penolakan bisa dijelaskan satu kalimat.

4. SKOR DAMPAK — untuk tiap titik terpilih dipanggil RPC `simulate_new_stop`
   (lat, lon) yang SUDAH divalidasi (populasi dari grid_analisis dasymetric,
   diprorata luas irisan lingkaran; migration 012 + guard luar-area 025).
   Diambil `penduduk_terlayani_400m` dan `penduduk_terlayani_800m`.
   TIDAK ADA formula skor baru yang diciptakan di sini — sengaja, supaya
   angka "dampak" usulan model dan angka simulasi What-If yang dilihat user
   di peta adalah angka yang SAMA persis.

5. RANKING — primer `penduduk_terlayani_800m` (proyeksi penduduk tambahan
   terlayani = "dampak aksesibilitas"), sekunder `skor_tdi_sel` (sinyal
   kebutuhan). Keduanya disimpan supaya rincian kontribusi bisa ditelusuri
   (prinsip explainability CLAUDE.md).

===========================================================================
KENAPA TIDAK MENGHITUNG CAI UNTUK TITIK-TITIK INI
===========================================================================
Kriteria ke-3 CAI ("volume penumpang / aktivitas transit") diisi dari
`titik_kandidat.total_aktivitas` = hasil traffic counting LAPANGAN. Titik
hasil model tidak punya angka itu. Mengisinya dengan tebakan/rata-rata lalu
menyebutnya "CAI" akan melanggar prinsip inti CLAUDE.md ("model/AI tidak
pernah menciptakan angka"). Ranking berdasarkan populasi terlayani hasil
simulasi adalah metrik yang jujur dan sepenuhnya dapat ditelusuri.

===========================================================================
KENAPA TIDAK INSERT KE `titik_kandidat`
===========================================================================
Ke-19 baris `titik_kandidat` REAL menjadi basis normalisasi min-max CAI.
Menambah baris di sana akan diam-diam merescale skor CAI SEMUA kandidat
survei (min/max tiap kriteria bergeser) dan bisa mengubah ranking tanpa
disadari. Karena itu output ditulis ke tabel TERPISAH `usulan_halte_model`.

    titik_kandidat     = kandidat TERVALIDASI LAPANGAN (Survey Activities)
    usulan_halte_model = USULAN MODEL SPASIAL, BELUM DISURVEI

Cara pakai:
    python generate_usulan_halte_model.py            # hitung + print tabel, TIDAK upload
    python generate_usulan_halte_model.py --upload   # + tulis ke usulan_halte_model
    python generate_usulan_halte_model.py --maks 30  # ubah panjang daftar-pendek
"""

import argparse

import geopandas as gpd
import pandas as pd

from rerun_dasymetric_grid import (
    fetch_all_paginated,
    wkb_hex_to_geom,
    SUMBER_BATAS_RESMI,
    WGS84,
)
from upload_to_supabase import get_client

# --- Konstanta: SEMUA dipinjam dari yang sudah berlaku di repo (lihat docstring) ---
METRIC_CRS = "EPSG:32748"  # UTM 48S — konvensi metrik proyek (build_fishnet_grid.py dll.)

# Ambang transit desert — sama dengan Dashboard.jsx TRANSIT_DESERT_THRESHOLD
# dan migration 022 (potensi_penerima_manfaat.ambang_tdi default).
AMBANG_TRANSIT_DESERT = 0.6

# Walking catchment ITDP — sama dengan radius 400 m simulate_new_stop (003)
# dan AMBANG_PENUH_M compute_tdi_full.py.
JARAK_MIN_DARI_HALTE_M = 400

# Catchment luar — sama dengan AMBANG_NIHIL_M compute_tdi_full.py dan radius
# 800 m simulate_new_stop. Jarak minimum antar-usulan (de-klaster).
JARAK_MIN_ANTAR_USULAN_M = 800

MAKS_USULAN_DEFAULT = 25  # daftar-pendek yang bisa dipakai pengambil keputusan, bukan ribuan pin

PREFIX_HALTE_DUMMY = "DUMMY-HLT-"  # sama dengan compute_tdi_full.load_halte_real()

SUMBER_PROVENANCE = (
    "MODEL SPASIAL (belum disurvei lapangan) — grid_analisis skor_tdi>"
    f"{AMBANG_TRANSIT_DESERT}, centroid >={JARAK_MIN_DARI_HALTE_M}m dari halte_eksisting real, "
    f"de-klaster greedy jarak min {JARAK_MIN_ANTAR_USULAN_M}m, ranking dari RPC simulate_new_stop"
)


# ---------------------------------------------------------------------------
# 1. Loader
# ---------------------------------------------------------------------------
def load_grid_transit_desert(client) -> gpd.GeoDataFrame:
    """Sel grid_analisis dengan skor_tdi > AMBANG_TRANSIT_DESERT."""
    rows = fetch_all_paginated(client, "grid_analisis", "id, geom, skor_tdi, kepadatan_penduduk")
    total = len(rows)
    rows = [r for r in rows if r["skor_tdi"] is not None and float(r["skor_tdi"]) > AMBANG_TRANSIT_DESERT]
    gdf = gpd.GeoDataFrame(
        {
            "grid_analisis_id": [r["id"] for r in rows],
            "skor_tdi": [float(r["skor_tdi"]) for r in rows],
            "kepadatan_penduduk": [float(r["kepadatan_penduduk"] or 0.0) for r in rows],
        },
        geometry=[wkb_hex_to_geom(r["geom"]) for r in rows],
        crs=WGS84,
    )
    print(
        f"[INFO] grid_analisis: {total} sel total -> {len(gdf)} sel transit desert "
        f"(skor_tdi > {AMBANG_TRANSIT_DESERT})."
    )
    return gdf


def load_halte_real(client) -> gpd.GeoDataFrame:
    """Halte eksisting REAL saja — DUMMY-HLT-* dikecualikan, identik dengan
    compute_tdi_full.load_halte_real()."""
    rows = fetch_all_paginated(client, "halte_eksisting", "id, id_halte_survei, nama, geom")
    rows = [r for r in rows if not str(r["id_halte_survei"]).startswith(PREFIX_HALTE_DUMMY)]
    gdf = gpd.GeoDataFrame(
        {"halte_id": [r["id"] for r in rows], "nama_halte": [r["nama"] for r in rows]},
        geometry=[wkb_hex_to_geom(r["geom"]) for r in rows],
        crs=WGS84,
    )
    print(f"[INFO] halte_eksisting REAL (DUMMY-HLT-* dikecualikan): {len(gdf)} titik.")
    return gdf


def load_kelurahan(client) -> gpd.GeoDataFrame:
    """Poligon kelurahan RBI resmi (56) — untuk label kecamatan/kelurahan usulan."""
    rows = fetch_all_paginated(
        client,
        "batas_administrasi",
        "id, nama_kecamatan, nama_kelurahan, geom",
        filters={"sumber": SUMBER_BATAS_RESMI},
    )
    gdf = gpd.GeoDataFrame(
        {
            "kelurahan_id": [r["id"] for r in rows],
            "kecamatan": [r["nama_kecamatan"] for r in rows],
            "kelurahan": [r["nama_kelurahan"] for r in rows],
        },
        geometry=[wkb_hex_to_geom(r["geom"]) for r in rows],
        crs=WGS84,
    )
    print(f"[INFO] batas_administrasi (sumber={SUMBER_BATAS_RESMI}): {len(gdf)} kelurahan.")
    return gdf


# ---------------------------------------------------------------------------
# 2. Seleksi
# ---------------------------------------------------------------------------
def saring_jauh_dari_halte(grid: gpd.GeoDataFrame, halte: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Buang sel yang centroid-nya < JARAK_MIN_DARI_HALTE_M dari halte real
    mana pun. Jarak dihitung di EPSG:32748 (meter riil), bukan derajat."""
    grid_m = grid.to_crs(METRIC_CRS).copy()
    grid_m["geometry"] = grid_m.geometry.centroid

    if halte.empty:
        raise SystemExit("[GAGAL] Tidak ada halte_eksisting REAL — filter jarak tidak bisa dijalankan.")

    halte_m = halte.to_crs(METRIC_CRS)
    nearest = gpd.sjoin_nearest(
        grid_m, halte_m[["halte_id", "nama_halte", "geometry"]], how="left", distance_col="jarak_halte_m"
    )
    nearest = nearest.loc[~nearest.index.duplicated(keep="first")]
    grid_m["jarak_halte_terdekat_m"] = nearest["jarak_halte_m"].values
    grid_m["nama_halte_terdekat"] = nearest["nama_halte"].values

    keep = grid_m[grid_m["jarak_halte_terdekat_m"] >= JARAK_MIN_DARI_HALTE_M].copy()
    print(
        f"[INFO] Filter jarak >= {JARAK_MIN_DARI_HALTE_M} m dari halte real: "
        f"{len(grid_m)} -> {len(keep)} sel ({len(grid_m) - len(keep)} sel dibuang karena sudah "
        f"berada dalam catchment halte eksisting)."
    )
    return keep


def deklaster_greedy(cells_m: gpd.GeoDataFrame, maks: int) -> gpd.GeoDataFrame:
    """Greedy: urut skor_tdi desc, ambil sel, tolak sel berikutnya yang
    < JARAK_MIN_ANTAR_USULAN_M dari sel yang sudah terpilih. Deterministik
    (tie-break sekunder: kepadatan_penduduk desc, lalu grid_analisis_id asc)."""
    urut = cells_m.sort_values(
        ["skor_tdi", "kepadatan_penduduk", "grid_analisis_id"], ascending=[False, False, True]
    ).reset_index(drop=True)

    terpilih_idx, terpilih_geom, ditolak = [], [], 0
    for i, row in urut.iterrows():
        g = row.geometry
        if any(g.distance(gt) < JARAK_MIN_ANTAR_USULAN_M for gt in terpilih_geom):
            ditolak += 1
            continue
        terpilih_idx.append(i)
        terpilih_geom.append(g)
        if len(terpilih_idx) >= maks:
            break

    out = urut.loc[terpilih_idx].reset_index(drop=True)
    print(
        f"[INFO] De-klaster greedy (jarak min antar-usulan {JARAK_MIN_ANTAR_USULAN_M} m): "
        f"{len(out)} titik terpilih, {ditolak} sel ditolak karena berimpit dengan titik "
        f"berperingkat lebih tinggi (pemindaian berhenti setelah kuota {maks} terpenuhi)."
    )
    return out


def label_wilayah(titik_wgs: gpd.GeoDataFrame, kelurahan: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Point-in-polygon centroid usulan -> kecamatan/kelurahan RBI. Sel yang
    jatuh di celah antar-poligon RBI 25K dibiarkan NULL (jujur), tidak
    ditebak."""
    joined = gpd.sjoin(
        titik_wgs.to_crs(METRIC_CRS),
        kelurahan.to_crs(METRIC_CRS)[["kecamatan", "kelurahan", "geometry"]],
        how="left",
        predicate="within",
    )
    joined = joined.loc[~joined.index.duplicated(keep="first")]
    out = titik_wgs.copy()
    out["kecamatan"] = joined["kecamatan"].values
    out["kelurahan"] = joined["kelurahan"].values
    n_null = int(out["kecamatan"].isna().sum())
    if n_null:
        print(
            f"[PERINGATAN] {n_null}/{len(out)} usulan tidak match ke poligon kelurahan RBI "
            f"(celah antar-poligon RBI 25K) -> kecamatan/kelurahan dibiarkan NULL, tidak ditebak."
        )
    return out


# ---------------------------------------------------------------------------
# 3. Skor dampak lewat RPC simulate_new_stop (mesin yang sudah divalidasi)
# ---------------------------------------------------------------------------
def hitung_dampak(client, titik_wgs: gpd.GeoDataFrame) -> pd.DataFrame:
    hasil = []
    for _, r in titik_wgs.iterrows():
        lat, lon = float(r.geometry.y), float(r.geometry.x)
        res = client.rpc("simulate_new_stop", {"lat": lat, "lon": lon}).execute().data
        if res.get("di_luar_area_analisis"):
            # Tidak boleh terjadi: titik ini ADALAH centroid sel grid.
            print(f"[PERINGATAN] grid_analisis_id={r['grid_analisis_id']} dianggap di luar area analisis oleh RPC.")
            p400 = p800 = None
        else:
            p400 = res.get("penduduk_terlayani_400m")
            p800 = res.get("penduduk_terlayani_800m")
        hasil.append({
            "grid_analisis_id": int(r["grid_analisis_id"]),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "skor_tdi_sel": round(float(r["skor_tdi"]), 4),
            "jarak_halte_terdekat_m": round(float(r["jarak_halte_terdekat_m"]), 2),
            "kecamatan": r["kecamatan"],
            "kelurahan": r["kelurahan"],
            "penduduk_terlayani_400m": p400,
            "penduduk_terlayani_800m": p800,
        })
    return pd.DataFrame(hasil)


def ranking_dan_kode(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(
        ["penduduk_terlayani_800m", "skor_tdi_sel"], ascending=[False, False]
    ).reset_index(drop=True)
    df["ranking"] = df.index + 1
    df["kode"] = [f"MDL-{i:03d}" for i in df["ranking"]]
    df["sumber"] = SUMBER_PROVENANCE
    return df


# ---------------------------------------------------------------------------
# 4. Sanity check + upload
# ---------------------------------------------------------------------------
def sanity_check(df: pd.DataFrame, titik_wgs: gpd.GeoDataFrame) -> bool:
    print("\n--- Sanity check ---")
    ok = True

    n_null = int(df[["penduduk_terlayani_400m", "penduduk_terlayani_800m"]].isna().sum().sum())
    print(f"  penduduk_terlayani_* NULL : {n_null} (harus 0)")
    ok &= n_null == 0

    if n_null == 0:
        n_zero = int((df["penduduk_terlayani_800m"] <= 0).sum())
        print(f"  penduduk_terlayani_800m <= 0 : {n_zero} (harus 0)")
        ok &= n_zero == 0

    jmin = df["jarak_halte_terdekat_m"].min()
    print(f"  jarak ke halte real terdekat: min={jmin:.1f} m (harus >= {JARAK_MIN_DARI_HALTE_M})")
    ok &= jmin >= JARAK_MIN_DARI_HALTE_M

    pts = titik_wgs.to_crs(METRIC_CRS).geometry.tolist()
    dmin = min(
        (a.distance(b) for i, a in enumerate(pts) for b in pts[i + 1:]),
        default=float("inf"),
    )
    print(f"  jarak antar-usulan terdekat : {dmin:.1f} m (harus >= {JARAK_MIN_ANTAR_USULAN_M})")
    ok &= dmin >= JARAK_MIN_ANTAR_USULAN_M

    tmin = df["skor_tdi_sel"].min()
    print(f"  skor_tdi_sel minimum        : {tmin:.4f} (harus > {AMBANG_TRANSIT_DESERT})")
    ok &= tmin > AMBANG_TRANSIT_DESERT

    n_wil = int(df["kecamatan"].isna().sum())
    print(f"  kecamatan/kelurahan NULL    : {n_wil} (informatif, tidak fatal)")

    print(f"  => {'LOLOS' if ok else 'GAGAL'}")
    return ok


def upload(client, df: pd.DataFrame):
    """Idempotent: hapus semua baris lalu insert ulang (tabel ini sepenuhnya
    turunan model — tidak ada data hasil kerja manusia yang bisa hilang)."""
    client.table("usulan_halte_model").delete().neq("id", 0).execute()
    payload = []
    for _, r in df.iterrows():
        payload.append({
            "kode": r["kode"],
            "geom": f"SRID=4326;POINT({r['lon']} {r['lat']})",
            "grid_analisis_id": int(r["grid_analisis_id"]),
            "skor_tdi_sel": float(r["skor_tdi_sel"]),
            "penduduk_terlayani_400m": int(r["penduduk_terlayani_400m"]),
            "penduduk_terlayani_800m": int(r["penduduk_terlayani_800m"]),
            "jarak_halte_terdekat_m": float(r["jarak_halte_terdekat_m"]),
            "kecamatan": None if pd.isna(r["kecamatan"]) else r["kecamatan"],
            "kelurahan": None if pd.isna(r["kelurahan"]) else r["kelurahan"],
            "ranking": int(r["ranking"]),
            "sumber": r["sumber"],
            "catatan": (
                f"Diturunkan dari sel grid_analisis id={int(r['grid_analisis_id'])} "
                f"(skor_tdi={r['skor_tdi_sel']:.4f}); halte eksisting real terdekat "
                f"{r['jarak_halte_terdekat_m']:.0f} m. BELUM DISURVEI LAPANGAN — "
                f"skor CAI tidak dihitung karena kriteria volume butuh traffic counting lapangan."
            ),
        })
    client.table("usulan_halte_model").insert(payload).execute()
    print(f"[OK] {len(payload)} baris ditulis ke usulan_halte_model.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload", action="store_true", help="Tulis hasil ke usulan_halte_model (default: dry-run)")
    parser.add_argument("--maks", type=int, default=MAKS_USULAN_DEFAULT, help=f"Panjang daftar-pendek (default {MAKS_USULAN_DEFAULT})")
    args = parser.parse_args()

    client = get_client()

    print("=== 1. Muat sel transit desert + halte real + batas kelurahan ===\n")
    grid = load_grid_transit_desert(client)
    halte = load_halte_real(client)
    kelurahan = load_kelurahan(client)
    if grid.empty:
        raise SystemExit("Tidak ada sel transit desert — tidak ada yang bisa diusulkan.")

    print(f"\n=== 2. Saring sel >= {JARAK_MIN_DARI_HALTE_M} m dari halte eksisting real ===\n")
    kandidat_m = saring_jauh_dari_halte(grid, halte)
    if kandidat_m.empty:
        raise SystemExit("Tidak ada sel tersisa setelah filter jarak halte.")

    print(f"\n=== 3. De-klaster greedy (min {JARAK_MIN_ANTAR_USULAN_M} m antar-usulan, maks {args.maks}) ===\n")
    terpilih_m = deklaster_greedy(kandidat_m, args.maks)

    titik_wgs = terpilih_m.to_crs(WGS84)
    titik_wgs = label_wilayah(titik_wgs, kelurahan)

    print("\n=== 4. Skor dampak via RPC simulate_new_stop (mesin What-If yang sudah divalidasi) ===\n")
    dampak = hitung_dampak(client, titik_wgs)

    print("\n=== 5. Ranking (primer: penduduk_terlayani_800m; sekunder: skor_tdi_sel) ===\n")
    hasil = ranking_dan_kode(dampak)

    kolom = [
        "kode", "ranking", "lat", "lon", "kecamatan", "kelurahan",
        "skor_tdi_sel", "jarak_halte_terdekat_m",
        "penduduk_terlayani_400m", "penduduk_terlayani_800m", "grid_analisis_id",
    ]
    print(hasil[kolom].to_string(index=False))

    print("\n--- Ringkasan ---")
    print(f"  Total usulan            : {len(hasil)}")
    if hasil["penduduk_terlayani_800m"].notna().all():
        print(f"  penduduk_terlayani_800m : min={int(hasil['penduduk_terlayani_800m'].min())} "
              f"median={int(hasil['penduduk_terlayani_800m'].median())} "
              f"max={int(hasil['penduduk_terlayani_800m'].max())}")
        print(f"  penduduk_terlayani_400m : min={int(hasil['penduduk_terlayani_400m'].min())} "
              f"median={int(hasil['penduduk_terlayani_400m'].median())} "
              f"max={int(hasil['penduduk_terlayani_400m'].max())}")
    print(f"  skor_tdi_sel            : min={hasil['skor_tdi_sel'].min():.4f} max={hasil['skor_tdi_sel'].max():.4f}")
    print("  Sebaran kecamatan       : " + str(dict(hasil["kecamatan"].value_counts(dropna=False))))

    lolos = sanity_check(hasil, titik_wgs)

    if args.upload:
        if not lolos:
            raise SystemExit("\n[BATAL] Sanity check GAGAL — tidak menulis apa pun ke Supabase.")
        print("\n=== 6. Upload ke usulan_halte_model ===")
        upload(client, hasil)
    else:
        print(
            "\n[DRY-RUN] --upload tidak diberikan, TIDAK ada perubahan ditulis ke Supabase. "
            "Jalankan ulang dengan --upload setelah hasil di atas diverifikasi masuk akal."
        )
