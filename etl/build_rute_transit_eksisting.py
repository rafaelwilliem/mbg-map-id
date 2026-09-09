"""
build_rute_transit_eksisting.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Menyiapkan 2 layer "transit eksisting" untuk Peta Multi-Layer Gap Analysis
(tabel `rute_transit_eksisting`, lihat 013_rute_transit_eksisting.sql):

  B1) jenis='biskita_survei' — APROKSIMASI jalur koridor BisKita: satu
      LineString menghubungkan 15 halte_eksisting REAL (HLT-001..HLT-015)
      sesuai urutan id_halte_survei, diambil LANGSUNG dari tabel
      halte_eksisting (bukan dari CSV survei lagi) supaya konsisten dengan
      data yang sudah live & sudah diperbaiki (lihat docs/DATA_CHECKLIST.md
      "bug rotate-by-one"). INI BUKAN rute resmi GTFS/KMZ operator/Dishub —
      tim tidak punya data itu. Kejujuran soal ini WAJIB ada di kolom
      `catatan` tiap baris yang diupload, bukan cuma di komentar kode ini.

  B2) jenis='krl' — jaringan KRL Commuter Line REAL dari BIG RBI 25K
      (STASIUNKA_PT_25K + RELKA_LN_25K), di-clip ke union 56 kelurahan
      REAL di batas_administrasi (Kota Bekasi), infrastruktur eksisting
      yang BELUM disurvei tim.

  B3) TERMINALBUS_PT_25K dicek (BUKAN diupload) — dilaporkan ke stdout
      apakah ada titik di dalam Kota Bekasi. Kalau 0, itu memang laporan
      jujur "tidak ada data resmi", BUKAN alasan mengarang data rute
      Transjakarta/Damri/angkot.

Sumber .gdb: sama seperti build_admin_boundaries_from_rbi.py (RBI 25K BIG,
tanahair.indonesia.go.id, per 31 Des 2022) — path resolution mengikuti
pola yang sama (default lokal -> env var -> fallback scratchpad sesi).

Cara pakai:
    python build_rute_transit_eksisting.py                 # dry-run, print preview
    python build_rute_transit_eksisting.py --upload         # proses + upload
    python build_rute_transit_eksisting.py --gdb "path\\ke\\file.gdb" --upload
"""

import argparse
import os
import sys
import time
from math import atan2, cos, radians, sin, sqrt

import geopandas as gpd
import requests
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
from upload_to_supabase import get_client

# OSRM public demo routing API -- gratis, tidak butuh API key, tapi rate-limited &
# tidak dijamin SLA (bukan untuk produksi berat). Dipakai HANYA untuk membangun rute
# BisKita mengikuti jaringan jalan sungguhan (bukan garis lurus antar halte), profile
# 'driving' (bus jalan di jalan raya, bukan jalur pejalan kaki). Kalau API ini down
# permanen di masa depan, ganti OSRM_BASE_URL ke instance self-hosted / OSRM lain
# dengan endpoint request format yang sama, atau bangun graph dari layer JALAN_LN_25K
# RBI 25K + networkx (opsi fallback yang dipertimbangkan tim, lihat riwayat commit).
OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving"
OSRM_TIMEOUT_S = 15
OSRM_MAX_RETRY = 3
OSRM_RETRY_DELAY_S = 1.0
OSRM_REQUEST_DELAY_S = 0.5  # jeda sopan antar request supaya tidak membebani API publik

# --- Path .gdb: pola identik build_admin_boundaries_from_rbi.py ---
DEFAULT_LOCAL_GDB_PATH = os.path.join(
    os.path.dirname(__file__), "data", "raw", "rbi25k",
    "2022_RBI25K_KAB_BEKASI_KUGI50_20221231.gdb",
)
FALLBACK_SESSION_GDB_PATH = (
    r"C:\Users\Agentsae\AppData\Local\Temp\claude\C--Users-Agentsae-mbg-webgis"
    r"\b8671aec-b1ae-4871-a267-49b9d973b10b\scratchpad\bekasi_data\KAB BEKASI"
    r"\2022_RBI25K_KAB_BEKASI_KUGI50_20221231.gdb"
)

LAYER_STASIUN = "STASIUNKA_PT_25K"
LAYER_REL = "RELKA_LN_25K"
LAYER_TERMINAL = "TERMINALBUS_PT_25K"

# Buffer batas kota (meter) untuk seleksi TITIK STASIUN saja. Versi lama
# memakai `within(boundary_union)` ketat -> hanya 1 titik lolos, dan NAMOBJ-nya
# kosong (Stasiun Bekasi/Bekasi Timur/Kranji hilang karena peron persis di
# tepi batas RBI yang disederhanakan). Sekarang: `intersects` terhadap batas
# yang di-buffer +500 m, LALU baris tanpa NAMOBJ dibuang (titik nyasar tak
# bernama tidak berguna sebagai layer peta). Stasiun benar-benar di luar kota
# (mis. Cakung, ~2,7 km di luar) tetap tersaring oleh buffer 500 m ini.
# Rel (LineString) TETAP pakai intersects + clip ke batas TANPA buffer.
STASIUN_BOUNDARY_BUFFER_M = 500
METRIC_CRS = "EPSG:32748"  # UTM 48S, CRS metrik proyek

SUMBER_KRL = (
    "BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id) — REAL, "
    "existing infrastructure, belum disurvei tim"
)
CATATAN_KRL = (
    "Jaringan KRL Commuter Line eksisting dari data topografi resmi BIG. "
    "BELUM pernah disurvei lapangan oleh tim (beda dengan halte BisKita) — "
    "atribut headway/okupansi/kondisi fisik TIDAK tersedia untuk moda ini."
)

SUMBER_BISKITA_TEMPLATE = (
    "APROKSIMASI dari urutan id_halte_survei HLT-001..HLT-015 hasil survei lapangan "
    "tim (titik koordinat REAL dari tabel halte_eksisting), digabung mengikuti "
    "jaringan JALAN SUNGGUHAN via OSRM public routing API (router.project-osrm.org, "
    "profile driving, data jalan OpenStreetMap) per pasangan halte berurutan ({n_seg} "
    "segmen{fallback_note}) — BUKAN GeoJSON/KMZ rute resmi operator BisKita/Dishub "
    "Kota Bekasi. Tim tidak memiliki data rute resmi tsb."
)
CATATAN_BISKITA_TEMPLATE = (
    "PERINGATAN: garis ini adalah pendekatan penyusuran korridor berdasarkan urutan "
    "titik survei (HLT-001->HLT-015), disambungkan MENGIKUTI JARINGAN JALAN (routing "
    "OSRM/OpenStreetMap, profile driving) antar tiap pasang halte berurutan{fallback_note} "
    "— BUKAN rute resmi operator. Panjang total ~{route_km:.1f}km (vs ~{straight_km:.1f}km "
    "jarak garis lurus, rasio ~{ratio:.2f}x). Pola koordinat menunjukkan korridor "
    "utara-selatan sepanjang ~6km (lat -6.2556 s.d. -6.3105) TAPI urutan tidak sepenuhnya "
    "monoton — HLT-011, HLT-014/015 kembali ke utara setelah titik lebih selatan "
    "(HLT-009/010), kemungkinan mencerminkan rute pergi-pulang (PP)/pola penyusuran "
    "dua-arah. Jangan sajikan sebagai jalur resmi operator ke pengguna akhir tanpa "
    "disclaimer ini."
)


def resolve_gdb_path(cli_arg: str | None) -> str:
    if cli_arg:
        return cli_arg
    env_path = os.environ.get("RBI_GDB_PATH")
    if env_path:
        return env_path
    if os.path.exists(DEFAULT_LOCAL_GDB_PATH):
        return DEFAULT_LOCAL_GDB_PATH
    if os.path.exists(FALLBACK_SESSION_GDB_PATH):
        print(f"[PERINGATAN] Memakai path scratchpad sesi (sementara): {FALLBACK_SESSION_GDB_PATH}")
        return FALLBACK_SESSION_GDB_PATH
    print("[ERROR] File .gdb tidak ditemukan di path default maupun fallback.")
    sys.exit(1)


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Jarak garis lurus (great-circle) dalam meter, dipakai untuk sanity-check
    rasio panjang rute-jalan vs jarak lurus (bukan untuk geometri yang diupload)."""
    r = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * r * atan2(sqrt(a), sqrt(1 - a))


def _osrm_route_segment(lon1: float, lat1: float, lon2: float, lat2: float):
    """Minta rute jalan (mengikuti jaringan jalan) antara 2 titik ke OSRM public API.
    Return (list_koordinat_[lon,lat], jarak_meter) kalau sukses, atau None kalau gagal
    setelah OSRM_MAX_RETRY percobaan (caller wajib fallback ke garis lurus segmen itu
    saja, JANGAN gagalkan seluruh proses hanya karena satu segmen)."""
    url = f"{OSRM_BASE_URL}/{lon1},{lat1};{lon2},{lat2}?geometries=geojson&overview=full"
    for attempt in range(1, OSRM_MAX_RETRY + 1):
        try:
            r = requests.get(url, timeout=OSRM_TIMEOUT_S)
            if r.status_code == 200:
                d = r.json()
                if d.get("code") == "Ok" and d.get("routes"):
                    route = d["routes"][0]
                    return route["geometry"]["coordinates"], route["distance"]
            print(f"    [OSRM] HTTP {r.status_code} percobaan {attempt}/{OSRM_MAX_RETRY}")
        except requests.RequestException as e:
            print(f"    [OSRM] Error '{e}' percobaan {attempt}/{OSRM_MAX_RETRY}")
        time.sleep(OSRM_RETRY_DELAY_S)
    return None


def route_road_network(coords: list[tuple[float, float]], ids: list[str]) -> dict:
    """Sambungkan titik-titik berurutan (lon, lat) mengikuti jaringan jalan sungguhan
    via OSRM, segmen demi segmen (bukan satu request multi-titik, supaya satu segmen
    gagal tidak menggagalkan seluruhnya). Segmen yang gagal di-routing (OSRM down/rate
    limit habis) fallback ke garis lurus KHUSUS segmen itu, dicatat di `n_fallback`
    supaya transparan di metadata `sumber`/`catatan` yang diupload — bukan disembunyikan
    seolah semuanya berhasil di-routing.

    Return dict: {"coords": [...], "route_total_m": float, "straight_total_m": float,
                  "n_segments": int, "n_fallback": int}
    """
    all_coords: list = []
    route_total_m = 0.0
    straight_total_m = 0.0
    n_fallback = 0
    n_segments = len(coords) - 1

    for i in range(n_segments):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        seg_straight_m = _haversine_m(lon1, lat1, lon2, lat2)
        straight_total_m += seg_straight_m

        result = _osrm_route_segment(lon1, lat1, lon2, lat2)
        if result is not None:
            seg_coords, seg_dist_m = result
            print(f"  [B1] {ids[i]}->{ids[i + 1]}: rute jalan OK, {seg_dist_m:.0f}m "
                  f"({len(seg_coords)} titik)")
        else:
            seg_coords, seg_dist_m = [[lon1, lat1], [lon2, lat2]], seg_straight_m
            n_fallback += 1
            print(f"  [PERINGATAN] {ids[i]}->{ids[i + 1]}: OSRM gagal setelah "
                  f"{OSRM_MAX_RETRY}x percobaan, fallback garis lurus untuk segmen ini saja.")

        route_total_m += seg_dist_m
        if all_coords and all_coords[-1] == seg_coords[0]:
            all_coords.extend(seg_coords[1:])
        else:
            all_coords.extend(seg_coords)

        time.sleep(OSRM_REQUEST_DELAY_S)

    return {
        "coords": all_coords,
        "route_total_m": route_total_m,
        "straight_total_m": straight_total_m,
        "n_segments": n_segments,
        "n_fallback": n_fallback,
    }


# ------------------------------------------------------------
# B1 — Rute BisKita (aproksimasi dari urutan halte tersurvei,
#      digabung mengikuti jaringan jalan sungguhan via OSRM)
# ------------------------------------------------------------
def build_biskita_route(client) -> dict | None:
    res = (
        client.table("halte_eksisting")
        .select("id_halte_survei, nama, geom")
        .execute()
    )
    rows = [r for r in res.data if str(r["id_halte_survei"] or "").startswith("HLT-")]
    rows.sort(key=lambda r: r["id_halte_survei"])

    if len(rows) != 15:
        print(f"[PERINGATAN] Diharapkan 15 halte HLT-001..HLT-015, ditemukan {len(rows)}. "
              "Lanjut memakai yang ada, tapi cek data halte_eksisting dulu kalau ini tidak disengaja.")

    coords = []
    ids = []
    for r in rows:
        g = r["geom"]  # dict GeoJSON {'type': 'Point', 'coordinates': [lon, lat]}
        if not g or g.get("type") != "Point":
            print(f"[PERINGATAN] {r['id_halte_survei']}: geom bukan Point/kosong, dilewati dari rute.")
            continue
        coords.append(tuple(g["coordinates"]))
        ids.append(r["id_halte_survei"])

    if len(coords) < 2:
        print("[ERROR] Tidak cukup titik halte untuk membangun LineString rute BisKita.")
        return None

    print(f"[B1] Rute BisKita: {len(coords)} titik, urutan {ids[0]} -> {ids[-1]}. "
          f"Menghubungkan {len(coords) - 1} pasang halte berurutan lewat OSRM public "
          f"routing (mengikuti jaringan jalan, profile driving) — bukan garis lurus...")

    routed = route_road_network(coords, ids)
    line = LineString(routed["coords"])
    ratio = (routed["route_total_m"] / routed["straight_total_m"]) if routed["straight_total_m"] else 0
    route_km = routed["route_total_m"] / 1000
    straight_km = routed["straight_total_m"] / 1000

    print(f"[B1] Selesai: {routed['n_segments']} segmen, {routed['n_fallback']} fallback garis lurus, "
          f"panjang rute jalan {route_km:.2f}km (jarak lurus total {straight_km:.2f}km, rasio {ratio:.2f}x).")
    if ratio > 3:
        print("[PERINGATAN] Rasio panjang rute-jalan vs garis lurus > 3x — mencurigakan, "
              "cek ulang hasil routing sebelum dipakai (kemungkinan OSRM salah rute/looping).")

    fallback_note = (
        f", {routed['n_fallback']} segmen fallback garis lurus karena OSRM gagal"
        if routed["n_fallback"] > 0 else ""
    )
    sumber = SUMBER_BISKITA_TEMPLATE.format(n_seg=routed["n_segments"], fallback_note=fallback_note)
    catatan = CATATAN_BISKITA_TEMPLATE.format(
        fallback_note=fallback_note, route_km=route_km, straight_km=straight_km, ratio=ratio,
    )

    return {
        "nama": "Koridor BisKita (aproksimasi dari 15 halte tersurvei, mengikuti jaringan jalan)",
        "jenis": "biskita_survei",
        "tipe_geometri": "line",
        "geom": f"SRID=4326;{line.wkt}",
        "sumber": sumber,
        "catatan": catatan,
    }


# ------------------------------------------------------------
# B2 — KRL Commuter Line (stasiun + rel), clip ke Kota Bekasi
# ------------------------------------------------------------
def load_kota_bekasi_boundary(client) -> gpd.GeoDataFrame:
    """Union 56 poligon batas_administrasi REAL (sumber RBI, bukan dummy —
    dummy sudah dihapus dari database per permintaan Sam, lihat commit
    terkait, jadi query tanpa filter sumber pun sekarang aman; filter tetap
    dipasang eksplisit untuk jaga-jaga kalau baris non-RBI lain ditambahkan
    di masa depan)."""
    res = (
        client.table("batas_administrasi")
        .select("nama_kelurahan, geom, sumber")
        .ilike("sumber", "BIG RBI 25K%")
        .execute()
    )
    if len(res.data) != 56:
        print(f"[PERINGATAN] Diharapkan 56 kelurahan RBI untuk boundary, ditemukan {len(res.data)}.")
    gdf = gpd.GeoDataFrame.from_features(
        [{"type": "Feature", "geometry": r["geom"], "properties": {"nama_kelurahan": r["nama_kelurahan"]}} for r in res.data],
        crs="EPSG:4326",
    )
    return gdf


def build_krl_records(gdb_path: str, boundary_union) -> list:
    records = []

    # TITIK STASIUN KRL SENGAJA TIDAK DIBANGUN (keputusan Sam 2026-09-07).
    # Jejak garis rel di bawah + ikon stasiun bawaan basemap MAPID sudah cukup;
    # marker titik stasiun sebelumnya salah lokasi & membingungkan (biru,
    # sebentuk marker "Lokasi dicek"). LAYER_STASIUN / STASIUN_BOUNDARY_BUFFER_M
    # dibiarkan terdefinisi kalau suatu saat keputusan ini dibalik.
    # Kalau .gdb di-rerun dan tabel sudah terisi titik lama, jalankan
    # etl/fix_krl_stasiun_rute_transit.py --upload (DELETE-only) untuk bersih.

    rel = gpd.read_file(gdb_path, layer=LAYER_REL)
    rel["geometry"] = rel.geometry.force_2d()
    rel = rel.set_crs(epsg=4326, allow_override=True)
    rel_clip = rel[rel.geometry.intersects(boundary_union)].copy()
    # Potong tiap ruas persis ke boundary Kota Bekasi (bukan cuma filter
    # baris yang bersinggungan) supaya ruas yang sebagian di luar kota
    # tidak menggambar garis jauh keluar wilayah studi.
    rel_clip["geometry"] = rel_clip.geometry.intersection(boundary_union)
    rel_clip = rel_clip[~rel_clip.geometry.is_empty]
    print(f"[B2] {LAYER_REL}: {len(rel)} total di .gdb, {len(rel_clip)} ruas beririsan dgn Kota Bekasi (setelah clip).")

    nama_col_rel = "NAMOBJ" if "NAMOBJ" in rel_clip.columns else None
    for i, (_, row) in enumerate(rel_clip.iterrows(), start=1):
        nama = (row[nama_col_rel] if nama_col_rel and row[nama_col_rel] else None) or f"Rel KRL ruas {i}"
        geom = row.geometry
        # MultiLineString -> pecah jadi baris terpisah per part supaya
        # tipe_geometri='line' konsisten dgn LineString tunggal per baris
        # (lebih mudah dirender frontend tanpa perlu handle Multi*).
        parts = list(geom.geoms) if geom.geom_type == "MultiLineString" else [geom]
        for j, part in enumerate(parts, start=1):
            if part.is_empty or part.geom_type != "LineString":
                continue
            nama_part = nama if len(parts) == 1 else f"{nama} ({j}/{len(parts)})"
            records.append({
                "nama": nama_part,
                "jenis": "krl",
                "tipe_geometri": "line",
                "geom": f"SRID=4326;{part.wkt}",
                "sumber": SUMBER_KRL,
                "catatan": CATATAN_KRL,
            })

    return records


def check_terminal_bus(gdb_path: str, boundary_union) -> int:
    terminal = gpd.read_file(gdb_path, layer=LAYER_TERMINAL)
    terminal["geometry"] = terminal.geometry.force_2d()
    terminal = terminal.set_crs(epsg=4326, allow_override=True)
    terminal_clip = terminal[terminal.geometry.within(boundary_union)]
    print(f"[B3] {LAYER_TERMINAL}: {len(terminal)} total di .gdb, {len(terminal_clip)} di dalam Kota Bekasi.")
    if terminal_clip.empty:
        print(
            "[B3] TIDAK ADA data rute/terminal resmi untuk moda selain BisKita & KRL "
            "(Transjakarta/Damri/angkot) di dalam .gdb ini. TIDAK dibuat data karangan — "
            "perlu sumber data terpisah (mis. GTFS Transjakarta, data trayek Damri/Dishub) "
            "kalau moda ini ingin ditambahkan ke peta."
        )
    return len(terminal_clip)


# ------------------------------------------------------------
# Upload
# ------------------------------------------------------------
def upload_records(client, records: list, jenis: str):
    """Idempotent SEDERHANA per `jenis`: hapus dulu baris jenis ini yang
    ber-sumber sama (persis seperti pola upload_equity_scores REAL —
    delete-lalu-insert), supaya re-run (mis. setelah RELKA_LN_25K/CSV
    korektif) tidak menumpuk duplikat."""
    if not records:
        print(f"[DILEWATI] Tidak ada record jenis='{jenis}' untuk diupload.")
        return 0
    client.table("rute_transit_eksisting").delete().eq("jenis", jenis).execute()
    CHUNK = 20
    total = 0
    for i in range(0, len(records), CHUNK):
        chunk = records[i:i + CHUNK]
        client.table("rute_transit_eksisting").insert(chunk).execute()
        total += len(chunk)
    print(f"[UPLOAD] jenis='{jenis}': {total} baris ter-upload.")
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gdb", default=None)
    parser.add_argument("--upload", action="store_true")
    args = parser.parse_args()

    gdb_path = resolve_gdb_path(args.gdb)
    print(f"[INFO] Membaca .gdb dari: {gdb_path}\n")

    client = get_client()

    print("=== B1: Rute BisKita (aproksimasi) ===")
    biskita_record = build_biskita_route(client)

    print("\n=== Boundary Kota Bekasi (union 56 kelurahan RBI real) ===")
    boundary_gdf = load_kota_bekasi_boundary(client)
    boundary_union = unary_union(boundary_gdf.geometry)
    print(f"[INFO] Boundary union dari {len(boundary_gdf)} poligon kelurahan.")

    print("\n=== B2: KRL Commuter Line (stasiun + rel, clip ke Kota Bekasi) ===")
    krl_records = build_krl_records(gdb_path, boundary_union)
    print(f"[B2] Total record KRL siap upload: {len(krl_records)} "
          f"({sum(1 for r in krl_records if r['tipe_geometri']=='point')} stasiun, "
          f"{sum(1 for r in krl_records if r['tipe_geometri']=='line')} ruas rel)")

    print("\n=== B3: Cek TERMINALBUS_PT_25K (Transjakarta/Damri/angkot) ===")
    check_terminal_bus(gdb_path, boundary_union)

    if not args.upload:
        print("\n[DRY-RUN] Tidak ada yang diupload. Jalankan ulang dengan --upload untuk menulis ke "
              "rute_transit_eksisting (perlu 013_rute_transit_eksisting.sql sudah diterapkan lebih dulu).")
        return

    print("\n=== Upload ===")
    if biskita_record:
        upload_records(client, [biskita_record], "biskita_survei")
    upload_records(client, krl_records, "krl")


if __name__ == "__main__":
    main()
