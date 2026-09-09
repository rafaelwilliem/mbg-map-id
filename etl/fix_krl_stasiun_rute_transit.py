"""
fix_krl_stasiun_rute_transit.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

HAPUS semua titik stasiun KRL di tabel `rute_transit_eksisting`
(jenis='krl', tipe_geometri='point') — TIDAK diganti.

KEPUTUSAN SAM 2026-09-07: marker titik stasiun KRL dibuang total dari peta.
  - Jejak garis rel (jenis='krl'/'line') sudah cukup jadi konteks spasial.
  - Basemap MAPID sendiri sudah menampilkan ikon stasiun KRL.
  - Riwayat marker ini bermasalah: awalnya 1 baris tanpa nama di ujung
    barat trace rel (bukan di peron), lalu sempat diganti 3 stasiun yang
    salah satunya (Stasiun Bekasi) memakai koordinat DEMO lama ~750 m
    meleset. Warna birunya juga sebentuk dengan marker "Lokasi dicek" —
    sumber kebingungan berulang. Lebih bersih dihapus.

Frontend (App.jsx) juga sudah berhenti me-render krlStasiunMarkers.

PENYEBAB: build_rute_transit_eksisting.py membaca STASIUNKA_PT_25K dari RBI
25K .gdb lalu clip `stasiun.geometry.within(boundary_union)` — dengan batas
RBI yang disederhanakan, hanya 1 titik lolos, dan NAMOBJ-nya kosong.
Stasiun Bekasi, Bekasi Timur, Kranji (disebut di PRD) hilang.

PERBAIKAN DI SINI: .gdb RBI 25K tidak tersedia di environment ini (path
default & fallback tidak resolve), jadi 3 stasiun KRL Commuter Line
(Lin/Line Cikarang) di dalam Kota Bekasi ditambahkan manual dengan nama +
koordinat referensi publik, dan SEMUA baris krl/point lama (titik nyasar
tanpa nama) DIHAPUS. Baris jenis='krl'/tipe_geometri='line' (13 ruas rel)
TIDAK disentuh.

Cakung SENGAJA tidak dimasukkan — verifikasi point-in-polygon menunjukkan
titik itu ~2,7 km di LUAR batas 56 kelurahan Kota Bekasi (ada di Jakarta
Timur).

Layer ini konteks/rujukan peta saja — TIDAK memberi input ke skor CAI/TDI/
Equity, jadi tidak ada recompute skor.

Idempotent: DELETE semua krl/point lalu INSERT 3 — aman dijalankan ulang
(mis. sesudah build_rute_transit_eksisting.py di-rerun dengan .gdb asli
yang mungkin masih memproduksi titik nyasar tsb).

Cara pakai:
    python fix_krl_stasiun_rute_transit.py            # dry-run: print rencana, TIDAK menulis
    python fix_krl_stasiun_rute_transit.py --upload    # terapkan ke rute_transit_eksisting
"""

import argparse

from upload_to_supabase import get_client

SUMBER_STASIUN = (
    "Stasiun Bekasi & Bekasi Timur: koordinat di-anchor ke titik survei "
    "lapangan tim (KND-003 'Akses Masuk Stasiun Bekasi', KND-002 'Area "
    "Parkir Stasiun Bekasi Timur' di titik_kandidat — GPS survei). Kranji: "
    "koordinat pendekatan peta publik (OpenStreetMap), tidak ada titik "
    "survei. STASIUNKA_PT_25K RBI 25K hanya meloloskan 1 titik tanpa NAMOBJ "
    "saat clip 'within' batas kota (build_rute_transit_eksisting.py), "
    "sehingga 3 stasiun in-city ditambahkan manual di sini."
)
CATATAN_STASIUN = (
    "Stasiun KRL Commuter Line eksisting (Lin Cikarang). BELUM disurvei "
    "lapangan oleh tim (beda dengan halte BisKita) — atribut headway/"
    "okupansi/kondisi fisik tidak tersedia untuk moda ini. Koordinat "
    "pendekatan dari peta publik, bukan GPS survei. Layer konteks peta, "
    "tidak dipakai untuk skoring CAI/TDI/Equity."
)

# KOSONG per keputusan Sam 2026-09-07: titik stasiun KRL sebagai marker
# dihapus seluruhnya, TIDAK diganti.
#   - Jejak garis rel (jenis='krl'/'line', 13 ruas) sudah cukup jadi konteks.
#   - Basemap MAPID sendiri sudah menampilkan ikon stasiun KRL.
#   - Marker titik sempat salah lokasi (nilai awal = koordinat DEMO lama)
#     dan membingungkan (biru, sebentuk dengan marker "Lokasi dicek").
# Script ini sekarang = DELETE semua krl/point, INSERT nol. Tetap idempotent
# dan tetap berguna kalau build_rute_transit_eksisting.py suatu saat
# di-rerun dengan .gdb asli yang mungkin memproduksi titik stasiun lagi.
STASIUN_KRL_KOTA_BEKASI = []


def build_records() -> list:
    return [
        {
            "nama": nama,
            "jenis": "krl",
            "tipe_geometri": "point",
            "geom": f"SRID=4326;POINT({lon} {lat})",
            "sumber": SUMBER_STASIUN,
            "catatan": CATATAN_STASIUN,
        }
        for nama, (lon, lat) in STASIUN_KRL_KOTA_BEKASI
    ]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload", action="store_true", help="Terapkan ke DB (default: dry-run)")
    args = parser.parse_args()

    client = get_client()

    existing = (
        client.table("rute_transit_eksisting")
        .select("id, nama, jenis, tipe_geometri, geom")
        .eq("jenis", "krl")
        .execute()
        .data
    )
    pts = [r for r in existing if r["tipe_geometri"] == "point"]
    lines = [r for r in existing if r["tipe_geometri"] == "line"]

    print("=== SEBELUM ===")
    print(f"krl/line : {len(lines)} baris (TIDAK disentuh)")
    print(f"krl/point: {len(pts)} baris ->")
    for r in pts:
        g = r["geom"]
        coords = g["coordinates"] if isinstance(g, dict) and g.get("type") == "Point" else g
        print(f"  id={r['id']} nama={r['nama']!r} coord={coords}")

    records = build_records()
    print("\n=== RENCANA ===")
    print(f"DELETE {len(pts)} baris krl/point lama, INSERT {len(records)} baris baru:")
    for rec in records:
        print(f"  {rec['nama']!r:<26} {rec['geom']}")

    if not args.upload:
        print("\n[DRY-RUN] --upload tidak diberikan, TIDAK ada perubahan ditulis.")
        raise SystemExit(0)

    del_res = client.table("rute_transit_eksisting").delete().eq("jenis", "krl").eq("tipe_geometri", "point").execute()
    print(f"\n[APPLY] DELETE krl/point: {len(del_res.data)} baris terhapus.")
    if records:
        ins_res = client.table("rute_transit_eksisting").insert(records).execute()
        print(f"[APPLY] INSERT krl/point: {len(ins_res.data)} baris.")
    else:
        print("[APPLY] INSERT krl/point: 0 baris (STASIUN_KRL_KOTA_BEKASI kosong — sengaja).")

    after = (
        client.table("rute_transit_eksisting")
        .select("id, nama, tipe_geometri, geom")
        .eq("jenis", "krl")
        .eq("tipe_geometri", "point")
        .execute()
        .data
    )
    print("\n=== SESUDAH (krl/point) ===")
    for r in after:
        g = r["geom"]
        coords = g["coordinates"] if isinstance(g, dict) and g.get("type") == "Point" else g
        print(f"  id={r['id']} nama={r['nama']!r} coord={coords}")
    lines_after = (
        client.table("rute_transit_eksisting").select("id").eq("jenis", "krl").eq("tipe_geometri", "line").execute().data
    )
    print(f"krl/line masih: {len(lines_after)} baris (harus tetap {len(lines)}).")
