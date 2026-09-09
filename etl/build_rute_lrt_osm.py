"""
build_rute_lrt_osm.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

Membangun layer GARIS jalur LRT Jabodebek di dalam Kota Bekasi dari OpenStreetMap.

KENAPA ADA SCRIPT INI:
  Peta sudah punya marker 7 stasiun (stasiun_kota_bekasi.geojson: 3 KRL + 4 LRT),
  tapi jalur LRT-nya belum tergambar — jadi 4 titik LRT tampak melayang tanpa
  konteks koridor. Beda dengan koridor BisKita yang harus DIAPROKSIMASI (OSM
  tidak punya relasi route-nya, lihat build_rute_biskita_osm.py), geometri rel
  LRT Jabodebek SUDAH ADA di OSM sebagai way `railway=light_rail`
  `name="LRT Jabodebek"` — jadi garis ini geometri asli, bukan aproksimasi.

APA YANG DIHASILKAN (aset GeoJSON statis ke frontend/src/data/ — pola sama
dengan build_rute_biskita_osm.py / build_bekasi_boundary_geojson.py: aset
build-time yang di-bundle frontend, BUKAN tabel Supabase, dan TIDAK dipakai
perhitungan skor CAI/TDI/Equity — murni layer konteks peta):
  lrt_jabodebek_osm.geojson — FeatureCollection MultiLineString/LineString,
  ruas rel LRT Jabodebek yang di-clip ke batas Kota Bekasi.

FILTER YANG DIPAKAI (dan alasannya):
  - `name = "LRT Jabodebek"` — bbox query juga menangkap **LRT Jakarta**
    (koridor Kelapa Gading–Velodrome, sistem yang BERBEDA dan tidak melayani
    Kota Bekasi). Tanpa filter nama, dua sistem itu tergambar sebagai satu
    jaringan dan menyesatkan.
  - buang way ber-tag `service` (depot/yard) — rel langsir depo bukan jalur
    layanan penumpang; kalau ikut, peta menampilkan "jalur" di area depo.
  - clip ke union 56 poligon kelurahan RBI Kota Bekasi (sumber batas yang sama
    dengan build_rute_transit_eksisting.py), bukan sekadar filter bbox, supaya
    garis tidak menjulur jauh ke luar wilayah studi.

Cara pakai:
    python build_rute_lrt_osm.py            # fetch + tulis geojson
    python build_rute_lrt_osm.py --dry-run  # fetch + ringkas, TIDAK menulis file
"""

import argparse
import json
import os
import urllib.parse
import urllib.request
from datetime import date

import geopandas as gpd
from shapely.geometry import LineString, mapping, shape
from shapely.ops import unary_union

from upload_to_supabase import get_client

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# bbox longgar sekitar Jabodebek timur; penyaringan sebenarnya lewat nama + clip batas kota.
OVERPASS_QUERY = (
    '[out:json][timeout:60];'
    'way["railway"="light_rail"](-6.34,106.88,-6.15,107.08);'
    'out geom;'
)
USER_AGENT = (
    "GeoTransitInsight/1.0 (MAPID WebGIS Competition 2026; "
    "repo github.com/Agentsae/mbg-map-id)"
)
NAMA_JALUR = "LRT Jabodebek"

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "src", "data")
OUT_PATH = os.path.join(OUT_DIR, "lrt_jabodebek_osm.geojson")


def fetch_overpass() -> dict:
    body = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    last = None
    for url in OVERPASS_ENDPOINTS:
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={"User-Agent": USER_AGENT,
                         "Content-Type": "application/x-www-form-urlencoded"},
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                print(f"[OSM] {url} -> HTTP {resp.status}")
                return json.loads(resp.read().decode())
        except Exception as exc:  # noqa: BLE001 — endpoint fallback disengaja
            print(f"[OSM] {url} gagal: {exc}")
            last = exc
    raise RuntimeError(f"Semua endpoint Overpass gagal: {last}")


def load_boundary_union(client):
    """Union 56 poligon kelurahan RBI — sumber batas yang sama dengan
    build_rute_transit_eksisting.py (filter sumber eksplisit, jaga-jaga
    kalau baris non-RBI ditambahkan di kemudian hari)."""
    res = (
        client.table("batas_administrasi")
        .select("nama_kelurahan, geom, sumber")
        .ilike("sumber", "BIG RBI 25K%")
        .execute()
    )
    if len(res.data) != 56:
        print(f"[PERINGATAN] Diharapkan 56 kelurahan RBI, ditemukan {len(res.data)}.")
    geoms = [shape(r["geom"]) for r in res.data]
    return unary_union(geoms)


def main(dry_run: bool = False) -> None:
    data = fetch_overpass()
    ways = data.get("elements", [])
    print(f"[OSM] {len(ways)} way railway=light_rail di bbox.")

    dipakai, ditolak_nama, ditolak_service = [], 0, 0
    for w in ways:
        tags = w.get("tags", {}) or {}
        if tags.get("name") != NAMA_JALUR:
            ditolak_nama += 1
            continue
        if tags.get("service"):  # depot/yard/siding — bukan jalur layanan
            ditolak_service += 1
            continue
        coords = [(g["lon"], g["lat"]) for g in w.get("geometry", [])]
        if len(coords) >= 2:
            dipakai.append(LineString(coords))
    print(f"[FILTER] nama != {NAMA_JALUR!r}: {ditolak_nama} dibuang · "
          f"ber-tag service (depo): {ditolak_service} dibuang · dipakai: {len(dipakai)} ruas")
    if not dipakai:
        raise RuntimeError("Tidak ada ruas LRT Jabodebek yang lolos filter — cek query/tag OSM.")

    boundary = load_boundary_union(get_client())
    gdf = gpd.GeoDataFrame(geometry=dipakai, crs="EPSG:4326")
    clipped = gdf.geometry.intersection(boundary)
    clipped = clipped[~clipped.is_empty]
    print(f"[CLIP] {len(gdf)} ruas -> {len(clipped)} ruas beririsan dengan Kota Bekasi.")
    if clipped.empty:
        raise RuntimeError("Semua ruas terbuang saat clip ke batas Kota Bekasi.")

    merged = unary_union(list(clipped))
    panjang_km = (
        gpd.GeoSeries([merged], crs="EPSG:4326").to_crs(32748).length.iloc[0] / 1000
    )
    print(f"[HASIL] panjang jalur LRT di dalam Kota Bekasi: {panjang_km:.2f} km")

    fc = {
        "type": "FeatureCollection",
        "properties": {
            "name": "Jalur LRT Jabodebek (dalam Kota Bekasi)",
            "sumber": (
                f"OpenStreetMap way railway=light_rail name={NAMA_JALUR!r}, "
                f"diambil {date.today().isoformat()}; di-clip ke union 56 kelurahan "
                "RBI Kota Bekasi"
            ),
            "catatan": (
                "Geometri rel ASLI dari OSM (bukan aproksimasi seperti koridor "
                "BisKita). Infrastruktur eksisting, BELUM disurvei lapangan oleh "
                "tim. Layer konteks peta — tidak dipakai untuk skoring "
                "CAI/TDI/Equity."
            ),
            "panjang_km_dalam_kota": round(float(panjang_km), 2),
        },
        "features": [{"type": "Feature", "geometry": mapping(merged), "properties": {}}],
    }

    if dry_run:
        print("\n[DRY-RUN] --dry-run diberikan, file TIDAK ditulis.")
        return
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f"[TULIS] {os.path.normpath(OUT_PATH)} ({os.path.getsize(OUT_PATH)} bytes)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Fetch + ringkas saja, tidak menulis file")
    main(**vars(ap.parse_args()))
