-- ============================================================
-- GeoTransit Insight — 034_admin_geometry_filter_sumber.sql
-- Tim MBG — MAPID WebGIS Competition 2026
--
-- BUG DITEMUKAN (2026-09-12, konsolidasi tab Analisis Spasial)
-- ------------------------------------------------------------
-- `get_admin_geometry` (032_get_admin_geometry.sql) dan `search_admin_bounds`
-- (030/031, cabang KECAMATAN) melakukan ST_Union/ST_Extent atas SEMUA baris
-- batas_administrasi yang nama_kecamatan-nya cocok, TANPA memfilter kolom
-- `sumber` — tidak seperti kode lain di repo yang membaca tabel ini
-- (AnalisisSpasial.jsx dropdown kecamatan, etl/generate_usulan_halte_model.py
-- load_kelurahan()) yang SELALU memfilter
-- `sumber = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'`.
--
-- batas_administrasi berisi 56 baris poligon ASLI (sumber BIG RBI di atas)
-- ditambah baris SEED DUMMY dari 006_seed_dummy_data.sql (sumber
-- 'DATA SINTETIS - seed testing, bukan batas administratif asli',
-- 008_batas_administrasi_sumber.sql). Dua di antara 6 nama kelurahan/kecamatan
-- dummy itu — 'Bekasi Utara' dan 'Bekasi Timur' — collide PERSIS dengan nama
-- kecamatan asli. Kalau baris dummy itu ada di database (mis. lingkungan
-- lokal/staging baru yang menjalankan seluruh migration dari 001, atau data
-- di-seed ulang), kedua fungsi ini diam-diam melebur/memperluas geometri
-- kecamatan tsb dengan poligon sintetis kasar.
--
-- BUKTI EMPIRIS (dibuktikan 2026-09-12 lewat transaksi yang di-ROLLBACK, tidak
-- mengubah data produksi — lihat laporan tugas untuk skrip persis):
--   * Baris dummy TIDAK ADA lagi di database produksi saat ini (56 baris
--     total, semuanya sumber BIG RBI) — jadi dampak LIVE saat ini nihil.
--     Namun bug ada di DEFINISI FUNGSI, bukan cuma di data: siapa pun yang
--     menjalankan `supabase db reset`/migrasi dari awal (006 akan menyeed
--     ulang 6 baris dummy) akan mereproduksi bug ini.
--   * Simulasi (insert 1 baris dummy 'Bekasi Utara' di dalam transaksi,
--     lalu ROLLBACK):
--       get_admin_geometry('kecamatan','Bekasi Utara') — SEBELUM perbaikan:
--         area 21.860.529 m² (484 titik, setelah simplify)
--       Union hanya sumber BIG RBI (BENAR):
--         area 20.796.095 m² (500 titik, setelah simplify)
--       -> selisih ~1.064.434 m² (~5,1%) dari poligon dummy yang ikut lebur.
--     search_admin_bounds('bekasi utara') cabang kecamatan — SEBELUM
--     perbaikan, dengan baris dummy outlier jauh (107.10–107.12E, 6.08–6.10S):
--         bbox max_lng/max_lat melar dari 107.033999/-6.172188 (benar) jadi
--         107.12/-6.08 (bug) — extent ikut baris dummy yang tidak difilter.
--
-- PERBAIKAN
-- ------------------------------------------------------------
-- Tambah `and b.sumber = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'`
-- (string PERSIS sama dengan yang sudah dipakai AnalisisSpasial.jsx &
-- generate_usulan_halte_model.py) ke KEEMPAT cabang yang membaca
-- batas_administrasi di dua fungsi ini:
--   * get_admin_geometry:   cabang kelurahan DAN kecamatan
--   * search_admin_bounds:  cabang kelurahan DAN kecamatan
-- Kelurahan ikut difilter juga (bukan cuma kecamatan) untuk konsistensi &
-- jaga-jaga — dicek manual (2026-09-12) TIDAK ADA nama kelurahan dummy yang
-- collide dengan nama kelurahan asli saat ini (008 sudah mendokumentasikan
-- hal yang sama), jadi filter ini murni defensif, bukan memperbaiki bug yang
-- sudah termanifestasi di cabang kelurahan.
--
-- KONTRAK OUTPUT: TIDAK BERUBAH (level, nama, geojson/bbox — signature sama
-- persis dengan 030/031/032). Ini PENYEMPITAN hasil (menambah filter WHERE),
-- jadi tidak mungkin merusak pemanggil yang sebelumnya BENAR mengandalkan
-- hasil ter-filter — dicek 2026-09-12: SearchBar.jsx (search_admin_bounds +
-- get_admin_geometry) dan AnalisisSpasial.jsx (get_admin_geometry, dropdown
-- kecamatannya SUDAH memfilter sumber sendiri sebelum memanggil RPC) adalah
-- SATU-SATUNYA pemanggil kedua fungsi ini di frontend, dan tidak satu pun
-- sengaja mengandalkan baris dummy ikut tampil/tergambar.
--
-- KENAPA FILE BARU, BUKAN MENGEDIT 030/031/032
-- ------------------------------------------------------------
-- Ketiga migration itu sudah ter-apply ke project remote (vpymlmaebvfmpowomsec).
-- Mengedit file lama tidak akan dijalankan ulang oleh `supabase db push` dan
-- membuat riwayat lokal desync dari remote — pola yang sama seperti 031
-- (revisi 030) dan 027 (revisi 015/026). Migration ini `create or replace`
-- kedua fungsi dengan definisi yang identik kecuali filter sumber tambahan.
--
-- URUTAN FILE: migration ke-034, setelah 033_skor_cai_grid.sql.
-- Perubahan vs sebelumnya: MURNI PERBAIKAN BUG — tambah 1 klausa filter di
-- tiap cabang kedua fungsi + comment + re-grant. Tidak ada DDL tabel, tidak
-- ada data yang diubah/dihapus, tidak ada policy RLS baru, tidak menyentuh
-- CAI/TDI/Equity/konfigurasi_bobot/RPC lain.
-- ============================================================

create or replace function get_admin_geometry(p_level text, p_nama text)
returns table (
    level    text,
    nama     text,
    geojson  jsonb,
    min_lng  double precision,
    min_lat  double precision,
    max_lng  double precision,
    max_lat  double precision
)
language sql
stable
as $$
    with params as (
        select
            lower(btrim(coalesce(p_level, '')))                    as lvl,
            lower(replace(btrim(coalesce(p_nama, '')), ' ', ''))    as nm_norm
    ),
    -- --- Cabang KELURAHAN: geometri 1 record apa adanya (disederhanakan).
    --     Filter sumber = BIG RBI ditambahkan 034 (defensif — belum ada
    --     collision nama kelurahan dummy vs asli saat ini, tapi konsisten
    --     dengan cabang kecamatan & pola bacaan tabel ini di tempat lain).
    kelurahan as (
        select
            'kelurahan'::text                                as level,
            b.nama_kelurahan                                 as nama,
            ST_SimplifyPreserveTopology(b.geom, 0.00003)     as g
        from batas_administrasi b
        cross join params p
        where p.lvl = 'kelurahan'
          and p.nm_norm <> ''
          and lower(replace(b.nama_kelurahan, ' ', '')) = p.nm_norm
          and b.sumber = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'
        order by b.id
        limit 1
    ),
    -- --- Cabang KECAMATAN: lebur semua kelurahan ASLI (sumber BIG RBI) di
    --     kecamatan itu jadi satu poligon (batas internal hilang), baru
    --     disederhanakan. Filter sumber ditambahkan 034 — SEBELUMNYA baris
    --     dummy 006_seed_dummy_data.sql ('Bekasi Utara'/'Bekasi Timur') ikut
    --     ke-ST_Union kalau ada di database, lihat catatan bug di atas.
    kecamatan as (
        select
            'kecamatan'::text                                          as level,
            min(b.nama_kecamatan)                                      as nama,
            ST_SimplifyPreserveTopology(ST_Union(b.geom), 0.00003)     as g
        from batas_administrasi b
        cross join params p
        where p.lvl = 'kecamatan'
          and p.nm_norm <> ''
          and lower(replace(b.nama_kecamatan, ' ', '')) = p.nm_norm
          and b.sumber = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'
        having count(*) > 0
    ),
    gabungan as (
        select * from kelurahan
        union all
        select * from kecamatan
    )
    select
        x.level,
        x.nama,
        ST_AsGeoJSON(x.g)::jsonb                  as geojson,
        ST_XMin(x.g)::double precision            as min_lng,
        ST_YMin(x.g)::double precision            as min_lat,
        ST_XMax(x.g)::double precision            as max_lng,
        ST_YMax(x.g)::double precision            as max_lat
    from gabungan x
    where x.g is not null
    limit 1;
$$;

comment on function get_admin_geometry(text, text) is
    'Helper read-only untuk frontend: ambil GEOMETRI batas administrasi satu '
    'kelurahan (geom record itu) atau satu kecamatan (ST_Union semua kelurahan '
    'di dalamnya) sebagai objek GeoJSON geometry (jsonb) + bbox WGS84, untuk '
    'digambar sebagai outline di peta. 0 atau 1 baris. Pencocokan nama EXACT '
    'setelah spasi dibuang & case diabaikan ("Mustika Jaya" = "Mustikajaya"), '
    'bukan substring. HANYA membaca baris sumber = ''BIG RBI 25K KUGI50 '
    '2022-12-31 (tanahair.indonesia.go.id)'' (56 poligon asli) — baris seed '
    'dummy 006_seed_dummy_data.sql dikecualikan sejak 034 (bug: dua nama '
    'kecamatan dummy ''Bekasi Utara''/''Bekasi Timur'' collide dengan nama asli '
    'dan sempat bisa ikut ST_Union kalau baris dummy ada di database). '
    'Geometri disederhanakan ST_SimplifyPreserveTopology 0.00003 deg (~3,3 m, '
    'sub-piksel di zoom 15) supaya payload ~4-5x lebih kecil. Sengaja terpisah '
    'dari search_admin_bounds agar poligon di-fetch lazy saat hasil dipilih, '
    'bukan 12 poligon per ketikan. Tidak ada dampak metodologi — hanya membaca '
    'batas_administrasi (RLS SELECT publik, 002_rls_policies.sql). '
    'Lihat 032_get_admin_geometry.sql (versi awal) dan '
    '034_admin_geometry_filter_sumber.sql (perbaikan filter sumber).';

grant execute on function get_admin_geometry(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- search_admin_bounds: SAMA persis dengan 031, hanya menambah filter sumber
-- di kedua cabang (kecamatan DAN kelurahan). Kontrak output/pencocokan/guard/
-- urutan/LIMIT 12 TIDAK berubah dari 031.
-- ------------------------------------------------------------
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
        select
            btrim(coalesce(q, ''))                        as qq,
            replace(btrim(coalesce(q, '')), ' ', '')      as qq_norm
    ),
    -- --- Baris KECAMATAN: 1 baris per nama_kecamatan DISTINCT yang cocok,
    --     bbox = ST_Extent atas kelurahan ASLI (sumber BIG RBI) di kecamatan
    --     itu. Filter sumber ditambahkan 034 — SEBELUMNYA baris dummy
    --     006_seed_dummy_data.sql ('Bekasi Utara'/'Bekasi Timur') ikut
    --     ST_Extent kalau ada di database, melebarkan bbox (dibuktikan
    --     2026-09-12, lihat catatan bug di atas).
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
          and replace(b.nama_kecamatan, ' ', '') ilike '%' || replace(p.qq, ' ', '') || '%'
          and b.sumber = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'
        group by b.nama_kecamatan
    ),
    -- --- Baris KELURAHAN: 1 baris per record batas_administrasi yang cocok.
    --     Filter sumber ditambahkan 034 (defensif, sama seperti cabang
    --     kelurahan get_admin_geometry — belum ada collision nama saat ini).
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
          and replace(b.nama_kelurahan, ' ', '') ilike '%' || replace(p.qq, ' ', '') || '%'
          and b.sumber = 'BIG RBI 25K KUGI50 2022-12-31 (tanahair.indonesia.go.id)'
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
    order by g.grup_urut, g.nama
    limit 12;
$$;

comment on function search_admin_bounds(text) is
    'Helper read-only untuk search bar frontend: cari kelurahan/kecamatan Kota '
    'Bekasi via substring case-insensitive DAN tak-peduli-spasi, kembalikan '
    'bounding box (lng/lat, WGS84) tiap kecocokan untuk fitBounds peta. HANYA '
    'membaca baris sumber = ''BIG RBI 25K KUGI50 2022-12-31 '
    '(tanahair.indonesia.go.id)'' (56 poligon asli) — baris seed dummy '
    '006_seed_dummy_data.sql dikecualikan sejak 034 (bug: nama kecamatan dummy '
    '''Bekasi Utara''/''Bekasi Timur'' collide dengan nama asli dan sempat bisa '
    'ikut ST_Extent, melebarkan bbox, kalau baris dummy ada di database). Nama '
    'yang dikembalikan tetap ejaan asli dari tabel. Baris kecamatan dulu lalu '
    'kelurahan, alfabetis, LIMIT 12. Guard panjang >= 2 karakter dihitung '
    'sebelum spasi dibuang. Tidak ada dampak metodologi — hanya membaca '
    'batas_administrasi (RLS SELECT publik, 002_rls_policies.sql). '
    'Lihat 031_search_admin_bounds_normalisasi_spasi.sql (versi sebelumnya) dan '
    '034_admin_geometry_filter_sumber.sql (perbaikan filter sumber).';

grant execute on function search_admin_bounds(text) to anon, authenticated;

-- Uji cepat (SQL Editor) — fokus regresi vs perbaikan:
--   select nama, geojson->>'type' from get_admin_geometry('kecamatan','Bekasi Utara');
--   select nama, geojson->>'type' from get_admin_geometry('kecamatan','Bekasi Timur');
--   -- ^ keduanya harus SAMA dengan sebelum migration ini KALAU database
--   --   produksi tidak sedang punya baris dummy (kondisi saat ini, 2026-09-12).
--   --   Untuk membuktikan filter benar-benar aktif, jalankan di dalam
--   --   transaksi yang di-ROLLBACK (jangan commit ke produksi):
--   --     begin;
--   --     insert into batas_administrasi (nama_kecamatan, nama_kelurahan, geom, sumber)
--   --       values ('Bekasi Utara','TEST-DUMMY',
--   --               ST_MakeEnvelope(107.10,-6.10,107.12,-6.08,4326),
--   --               'DATA SINTETIS - seed testing, bukan batas administratif asli');
--   --     select min_lng,min_lat,max_lng,max_lat from get_admin_geometry('kecamatan','Bekasi Utara');
--   --     select min_lng,min_lat,max_lng,max_lat from search_admin_bounds('bekasi utara') where level='kecamatan';
--   --     -- bbox HARUS TETAP 106.978734/-6.238717/107.033999/-6.172188, TIDAK melebar ke 107.12/-6.08
--   --     rollback;
