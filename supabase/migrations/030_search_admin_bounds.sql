-- ============================================================
-- GeoTransit Insight — 030_search_admin_bounds.sql
-- Tim MBG — MAPID WebGIS Competition 2026
--
-- TUJUAN
-- ------------------------------------------------------------
-- Menambah SATU fungsi RPC read-only, search_admin_bounds(q text), sebagai
-- helper untuk SEARCH BAR di frontend WebGIS. User mengetik nama kelurahan
-- atau kecamatan Kota Bekasi -> fungsi mengembalikan daftar kecocokan beserta
-- BOUNDING BOX (lng/lat, SRID 4326) tiap wilayah, supaya peta bisa langsung
-- fitBounds ke area yang dicari.
--
-- Ini MURNI utilitas navigasi peta:
--   * TIDAK ada formula, skor, normalisasi, atau pembobotan baru.
--   * TIDAK menyentuh CAI / TDI / Transit Equity Index, tabel skor, ETL,
--     konfigurasi_bobot, maupun RPC lain (simulate_new_stop, get_tdi_breakdown,
--     coverage_ratio_kecamatan, dst).
--   * Hanya MEMBACA tabel batas_administrasi (kolom nama_kecamatan,
--     nama_kelurahan, geom) yang sudah ada sejak 001_init_tables.sql.
--
-- KEAMANAN / RLS
-- ------------------------------------------------------------
-- Fungsi ini SECURITY INVOKER (default) — ia berjalan dengan hak pemanggil,
-- jadi tetap tunduk pada RLS. batas_administrasi SUDAH punya policy SELECT
-- publik:
--     create policy "Publik boleh baca batas_administrasi"
--       on batas_administrasi for select using (true);   -- 002_rls_policies.sql
-- sehingga role `anon` (dipakai frontend lewat publishable key) memang boleh
-- membaca tabel ini. Tidak ada policy INSERT/UPDATE/DELETE untuk anon =>
-- fungsi ini secara desain tidak bisa dipakai untuk menulis apa pun.
-- EXECUTE di-grant eksplisit ke anon + authenticated (lihat bagian bawah).
--
-- KONTRAK OUTPUT (dikunci — frontend dikodekan paralel terhadap signature ini)
-- ------------------------------------------------------------
--   level          text  -- 'kelurahan' atau 'kecamatan'
--   nama           text  -- nama tampil (nama kelurahan, atau nama kecamatan)
--   nama_kecamatan text  -- kecamatan induk (baris kelurahan); sama dg `nama` (baris kecamatan)
--   min_lng/min_lat/max_lng/max_lat double precision  -- bbox derajat (WGS84)
--
-- PERILAKU
-- ------------------------------------------------------------
--   * Pencocokan: substring case-insensitive (ILIKE '%q%').
--       - baris kelurahan : nama_kelurahan ILIKE '%q%' (1 baris per record)
--       - baris kecamatan : nama_kecamatan ILIKE '%q%' (1 baris per kecamatan DISTINCT)
--     Kedua himpunan digabung (UNION ALL).
--   * q < 2 karakter setelah trim  -> tidak mengembalikan baris (guard input).
--   * bbox kelurahan  : ST_XMin/ST_YMin/ST_XMax/ST_YMax atas geom kelurahan itu.
--   * bbox kecamatan  : ST_Extent(geom) teragregasi atas SEMUA kelurahan di
--                       kecamatan tsb.
--   * Urutan: baris kecamatan dulu, lalu kelurahan; masing-masing alfabetis
--     menurut `nama`. LIMIT 12 total (diterapkan SETELAH pengurutan).
--
-- URUTAN FILE: migration ke-030, setelah
-- 029_equity_refill_after_cai_recompute_20260907.sql.
-- Perubahan vs sebelumnya: MURNI ADITIF — 1 fungsi RPC baru + grant EXECUTE.
-- Tidak ada DDL tabel, tidak ada data yang diubah, tidak ada policy RLS baru.
-- ============================================================

create or replace function search_admin_bounds(q text)
returns table (
    level          text,
    nama           text,
    nama_kecamatan text,
    min_lng        double precision,
    min_lat        double precision,
    max_lng        double precision,
    max_lat        double precision
)
language sql
stable
as $$
    with params as (
        -- Satu sumber kebenaran untuk query yang sudah dibersihkan.
        select btrim(coalesce(q, '')) as qq
    ),
    -- --- Baris KECAMATAN: 1 baris per nama_kecamatan DISTINCT yang cocok,
    --     bbox = ST_Extent atas semua kelurahan di kecamatan itu. Cast box2d
    --     -> geometry supaya ST_XMin/ST_YMax dapat argumen geometry (nilai
    --     koordinat tetap derajat WGS84 karena sumbernya SRID 4326).
    kecamatan as (
        select
            'kecamatan'::text                                  as level,
            b.nama_kecamatan                                   as nama,
            b.nama_kecamatan                                   as nama_kecamatan,
            ST_XMin(ST_Extent(b.geom)::geometry)::double precision as min_lng,
            ST_YMin(ST_Extent(b.geom)::geometry)::double precision as min_lat,
            ST_XMax(ST_Extent(b.geom)::geometry)::double precision as max_lng,
            ST_YMax(ST_Extent(b.geom)::geometry)::double precision as max_lat,
            0                                                  as grup_urut
        from batas_administrasi b
        cross join params p
        where char_length(p.qq) >= 2
          and b.nama_kecamatan ilike '%' || p.qq || '%'
        group by b.nama_kecamatan
    ),
    -- --- Baris KELURAHAN: 1 baris per record batas_administrasi yang cocok.
    kelurahan as (
        select
            'kelurahan'::text                     as level,
            b.nama_kelurahan                      as nama,
            b.nama_kecamatan                      as nama_kecamatan,
            ST_XMin(b.geom)::double precision     as min_lng,
            ST_YMin(b.geom)::double precision     as min_lat,
            ST_XMax(b.geom)::double precision     as max_lng,
            ST_YMax(b.geom)::double precision     as max_lat,
            1                                     as grup_urut
        from batas_administrasi b
        cross join params p
        where char_length(p.qq) >= 2
          and b.nama_kelurahan ilike '%' || p.qq || '%'
    ),
    gabungan as (
        select * from kecamatan
        union all
        select * from kelurahan
    )
    select
        g.level,
        g.nama,
        g.nama_kecamatan,
        g.min_lng,
        g.min_lat,
        g.max_lng,
        g.max_lat
    from gabungan g
    order by g.grup_urut, g.nama   -- kecamatan (0) dulu, lalu kelurahan (1); alfabetis
    limit 12;
$$;

comment on function search_admin_bounds(text) is
    'Helper read-only untuk search bar frontend: cari kelurahan/kecamatan Kota '
    'Bekasi via substring case-insensitive, kembalikan bounding box (lng/lat, '
    'WGS84) tiap kecocokan untuk fitBounds peta. Baris kecamatan dulu lalu '
    'kelurahan, alfabetis, LIMIT 12. Tidak ada dampak metodologi — hanya '
    'membaca batas_administrasi (RLS SELECT publik, 002_rls_policies.sql). '
    'Lihat 030_search_admin_bounds.sql.';

-- Konsisten dengan RPC publik lain di proyek (simulate_new_stop 003,
-- get_tdi_breakdown 015) yang juga di-grant ke anon.
grant execute on function search_admin_bounds(text) to anon, authenticated;

-- Uji cepat (SQL Editor):
--   select * from search_admin_bounds('bekasi');   -- kecamatan Bekasi Utara/Selatan/Timur/Barat + kelurahan; bbox ~lng 106.9-107.1, lat -6.1..-6.4
--   select * from search_admin_bounds('a');        -- 0 baris (q < 2 karakter)
--   select * from search_admin_bounds('margahayu');-- 1 baris kelurahan, bbox kecil wajar
