-- ============================================================
-- GeoTransit Insight — 032_get_admin_geometry.sql
-- Tim MBG — MAPID WebGIS Competition 2026
--
-- TUJUAN
-- ------------------------------------------------------------
-- Menambah SATU fungsi RPC read-only, get_admin_geometry(p_level, p_nama),
-- yang mengembalikan GEOMETRI batas administrasi (poligon) sebuah kelurahan
-- atau kecamatan Kota Bekasi dalam bentuk GeoJSON — supaya frontend bisa
-- MENGGAMBAR outline wilayah yang dicari di peta, bukan cuma fitBounds ke
-- bounding box-nya seperti sekarang.
--
-- Sama seperti 030/031, ini MURNI utilitas navigasi/visualisasi peta:
--   * TIDAK ada formula, skor, normalisasi, atau pembobotan baru/berubah.
--   * TIDAK menyentuh CAI / TDI / Transit Equity Index, tabel skor, ETL,
--     konfigurasi_bobot, maupun RPC lain (simulate_new_stop, get_tdi_breakdown,
--     coverage_ratio_kecamatan, search_admin_bounds, dst).
--   * Hanya MEMBACA tabel batas_administrasi (nama_kecamatan, nama_kelurahan,
--     geom) yang sudah ada sejak 001_init_tables.sql.
--
-- KENAPA FUNGSI TERPISAH, BUKAN MENAMBAH KOLOM DI search_admin_bounds
-- ------------------------------------------------------------
-- search_admin_bounds(q) dipanggil PER KETIKAN di search bar dan mengembalikan
-- sampai 12 baris kecocokan. Kalau poligon ikut dikirim di sana, tiap keystroke
-- berpotensi mengirim 12 poligon sekaligus — diukur pada data riil, 12 kecamatan
-- Kota Bekasi (hasil ST_Union, GeoJSON mentah) berjumlah ~675 KB, dan 56
-- kelurahan mentah ~1,07 MB. Itu tidak masuk akal untuk autocomplete.
-- Jadi polanya dipecah jadi dua panggilan:
--     1) search_admin_bounds(q)          -> daftar kecocokan + bbox (ringan, per ketikan)
--     2) get_admin_geometry(level, nama) -> geometri 1 wilayah (lazy, HANYA saat
--                                           user memilih satu hasil "Wilayah")
-- Hasil titik (halte, titik survei, usulan model, stasiun) tidak perlu geometri
-- batas sama sekali, jadi tidak pernah memanggil fungsi ini.
-- 030 dan 031 SUDAH ter-apply ke project remote (vpymlmaebvfmpowomsec) dan
-- TIDAK diubah oleh file ini — kontrak search_admin_bounds tetap apa adanya.
--
-- KONTRAK OUTPUT (dikunci — frontend dikodekan paralel terhadap signature ini)
-- ------------------------------------------------------------
--   level    text     -- echo p_level yang sudah dinormalisasi: 'kelurahan' | 'kecamatan'
--   nama     text     -- nama SEPERTI TERSIMPAN di tabel (spasi asli, mis. 'Mustikajaya')
--   geojson  jsonb    -- objek GEOMETRY GeoJSON (Polygon / MultiPolygon).
--                     --   BUKAN Feature, BUKAN FeatureCollection.
--                     --   Frontend yang membungkusnya sendiri jadi Feature.
--   min_lng/min_lat/max_lng/max_lat double precision -- bbox derajat (WGS84)
-- Mengembalikan 0 ATAU 1 BARIS saja.
--
-- PERILAKU
-- ------------------------------------------------------------
--   * p_level = 'kelurahan' -> cocokkan ke nama_kelurahan, kembalikan geom
--                              record kelurahan itu saja.
--   * p_level = 'kecamatan' -> cocokkan ke nama_kecamatan, kembalikan
--                              ST_Union(geom) SEMUA kelurahan di kecamatan itu,
--                              jadi satu poligon gabungan — batas antar-kelurahan
--                              di dalamnya tidak ikut tergambar.
--   * p_level toleran: di-btrim + lower dulu sebelum dibandingkan. Selain
--     'kelurahan'/'kecamatan' (mis. NULL, '', 'bogus') -> 0 baris.
--   * p_nama NULL atau kosong/hanya spasi -> 0 baris.
--   * bbox dihitung dari GEOMETRI YANG SAMA dengan yang dikembalikan (untuk
--     kecamatan: SETELAH union & simplifikasi), sehingga frontend bisa
--     fitBounds cukup dari satu panggilan ini tanpa perlu baris hasil search.
--
-- PENCOCOKAN NAMA: EXACT SETELAH SPASI DIBUANG (bukan ILIKE '%...%')
-- ------------------------------------------------------------
-- Ekspresi yang dipakai (dua sisi dinormalisasi, sejiwa dengan 031):
--     lower(replace(b.nama_kelurahan, ' ', '')) = lower(replace(p_nama, ' ', ''))
--     lower(replace(b.nama_kecamatan, ' ', '')) = lower(replace(p_nama, ' ', ''))
-- Space-insensitive di KEDUA sisi, sehingga kecamatan yang tersimpan sebagai
-- 'Mustikajaya' tetap ketemu baik pemanggil mengirim 'Mustikajaya' MAUPUN
-- 'Mustika Jaya' (juga 'Rawalumbu'/'Rawa Lumbu', 'Pondokgede'/'Pondok Gede', dst).
-- BEDA DENGAN 031: di sini pakai KESAMAAN PERSIS (=), BUKAN substring ILIKE.
-- Alasannya, ini lookup dengan nama eksak yang SUDAH didapat frontend dari
-- search_admin_bounds; substring match bisa memulangkan wilayah yang salah
-- (mis. 'Bekasi Timur' juga tersubstring di pencarian longgar 'bekasi', dan
-- kelurahan 'Jatibening' vs 'Jatibening Baru' saling bersubstring). Case tetap
-- diabaikan lewat lower() supaya tidak rapuh terhadap kapitalisasi.
-- Normalisasi HANYA untuk perbandingan: kolom `nama` yang dikembalikan tetap
-- ejaan asli dari tabel (mis. 'Bekasi Timur' dengan spasinya).
--
-- SIMPLIFIKASI: ST_SimplifyPreserveTopology(geom, 0.00003)
-- ------------------------------------------------------------
-- Toleransi 0,00003 derajat ~= 3,3 m di lintang Kota Bekasi (-6,2 deg).
-- Kenapa segitu, dari pengukuran nyata pada data batas_administrasi (56
-- kelurahan / 12 kecamatan) — ukuran ST_AsGeoJSON dalam byte:
--
--   Kelurahan (median) : mentah 16.578 B  -> 4.537 B   (27%, hemat ~73%)
--   Kelurahan Margahayu: mentah  9.876 B  -> 2.990 B   (30%, 343 -> 103 titik)
--   Kelurahan terbesar (Sumurbatu): 46.126 B -> 8.162 B (18%)
--   Kecamatan TERBESAR (Jatisampurna, union): 117.653 B -> 22.400 B (19%)
--   Kecamatan Bekasi Timur (union): 29.408 B -> 7.097 B (24%)
--
-- Jadi penghematannya BESAR (~4-5x), bukan marginal — simplifikasi layak
-- dipertahankan. Dari sisi tampilan: pada zoom 15 resolusi layar ~4,7 m/piksel,
-- sehingga penyimpangan maksimum 3,3 m masih SUB-PIKSEL; pada zoom 13 (~19
-- m/piksel) jauh lebih kecil lagi. Outline tetap terbaca sebagai batas asli di
-- rentang zoom pemakaian (13-15) — sengaja TIDAK memakai toleransi lebih agresif
-- (0,0001-0,0002 derajat = 11-22 m) yang mulai memotong tikungan batas secara
-- kasatmata. ST_SimplifyPreserveTopology (bukan ST_Simplify) dipilih supaya
-- poligon hasilnya dijamin tetap valid/tidak self-intersect dan tidak ada ring
-- yang hilang.
-- Simplifikasi dilakukan SETELAH ST_Union untuk kecamatan, supaya titik-titik
-- di batas antar-kelurahan yang sudah lebur tidak ikut diperhitungkan.
--
-- KEAMANAN / RLS
-- ------------------------------------------------------------
-- LANGUAGE sql STABLE, SECURITY INVOKER (default) — berjalan dengan hak
-- pemanggil sehingga tetap tunduk RLS. batas_administrasi sudah punya policy
-- SELECT publik dari 002_rls_policies.sql:
--     create policy "Publik boleh baca batas_administrasi"
--       on batas_administrasi for select using (true);
-- Tidak ada policy INSERT/UPDATE/DELETE untuk anon => fungsi ini secara desain
-- tidak bisa dipakai menulis apa pun. EXECUTE di-grant eksplisit ke anon +
-- authenticated, konsisten dengan RPC publik lain (simulate_new_stop 003,
-- get_tdi_breakdown 015, search_admin_bounds 030/031).
--
-- URUTAN FILE: migration ke-032, setelah
-- 031_search_admin_bounds_normalisasi_spasi.sql.
-- Perubahan vs sebelumnya: MURNI ADITIF — 1 fungsi RPC baru + grant EXECUTE.
-- Tidak ada DDL tabel, tidak ada data yang diubah, tidak ada policy RLS baru,
-- tidak ada fungsi lama yang diubah/di-drop.
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
        -- Satu sumber kebenaran untuk argumen yang sudah dibersihkan.
        --   lvl     : level di-trim + lower  -> toleran 'Kelurahan', ' KECAMATAN '
        --   nm_norm : nama di-trim + lower + spasi dibuang -> dipakai PENCOCOKAN
        --             ('Mustika Jaya' dan 'Mustikajaya' sama-sama jadi 'mustikajaya')
        select
            lower(btrim(coalesce(p_level, '')))                    as lvl,
            lower(replace(btrim(coalesce(p_nama, '')), ' ', ''))    as nm_norm
    ),
    -- --- Cabang KELURAHAN: geometri 1 record apa adanya (disederhanakan).
    --     order by id + limit 1 => output dijamin maksimum 1 baris walau
    --     kelak ada nama kelurahan kembar (saat ini 56 nama semuanya unik).
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
        order by b.id
        limit 1
    ),
    -- --- Cabang KECAMATAN: lebur semua kelurahan di kecamatan itu jadi satu
    --     poligon (batas internal hilang), baru disederhanakan.
    --     `having count(*) > 0` PENTING: agregat tanpa GROUP BY selalu memulangkan
    --     1 baris (berisi NULL) meski tidak ada baris yang cocok — having ini
    --     yang membuat "tidak ketemu" benar-benar jadi 0 baris.
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
        ST_AsGeoJSON(x.g)::jsonb                  as geojson,   -- objek geometry, bukan Feature
        ST_XMin(x.g)::double precision            as min_lng,   -- bbox dari geometri
        ST_YMin(x.g)::double precision            as min_lat,   -- YANG SAMA dengan
        ST_XMax(x.g)::double precision            as max_lng,   -- yang dikembalikan
        ST_YMax(x.g)::double precision            as max_lat
    from gabungan x
    where x.g is not null
    limit 1;   -- kontrak: 0 atau 1 baris (kedua cabang mustahil terisi bersamaan)
$$;

comment on function get_admin_geometry(text, text) is
    'Helper read-only untuk frontend: ambil GEOMETRI batas administrasi satu '
    'kelurahan (geom record itu) atau satu kecamatan (ST_Union semua kelurahan '
    'di dalamnya) sebagai objek GeoJSON geometry (jsonb) + bbox WGS84, untuk '
    'digambar sebagai outline di peta. 0 atau 1 baris. Pencocokan nama EXACT '
    'setelah spasi dibuang & case diabaikan ("Mustika Jaya" = "Mustikajaya"), '
    'bukan substring — karena ini lookup nama pasti dari search_admin_bounds. '
    'Geometri disederhanakan ST_SimplifyPreserveTopology 0.00003 deg (~3,3 m, '
    'sub-piksel di zoom 15) supaya payload ~4-5x lebih kecil. Sengaja terpisah '
    'dari search_admin_bounds agar poligon di-fetch lazy saat hasil dipilih, '
    'bukan 12 poligon per ketikan. Tidak ada dampak metodologi — hanya membaca '
    'batas_administrasi (RLS SELECT publik, 002_rls_policies.sql). '
    'Lihat 032_get_admin_geometry.sql.';

grant execute on function get_admin_geometry(text, text) to anon, authenticated;

-- Uji cepat (SQL Editor):
--   select level, nama, geojson->>'type', min_lng, min_lat, max_lng, max_lat,
--          length(geojson::text) as bytes
--     from get_admin_geometry('kelurahan','Margahayu');   -- 1 baris, Polygon
--   select level, nama, geojson->>'type' from get_admin_geometry('kecamatan','Bekasi Timur');
--   select nama from get_admin_geometry('kecamatan','Mustika Jaya'); -- -> 'Mustikajaya'
--   select nama from get_admin_geometry('kecamatan','Mustikajaya');  -- -> 'Mustikajaya' (sama)
--   select * from get_admin_geometry('kecamatan','Margahayu');       -- 0 baris (salah level)
--   select * from get_admin_geometry('kelurahan','');                -- 0 baris
--   select * from get_admin_geometry(null,'Margahayu');              -- 0 baris
--   select * from get_admin_geometry('bogus','Margahayu');           -- 0 baris
