-- ============================================================
-- GeoTransit Insight — 031_search_admin_bounds_normalisasi_spasi.sql
-- Tim MBG — MAPID WebGIS Competition 2026
--
-- TUJUAN
-- ------------------------------------------------------------
-- Memperbaiki SATU masalah pencocokan teks pada RPC search_admin_bounds(q text)
-- yang dibuat di 030_search_admin_bounds.sql. Ini PURELY perbaikan UX search
-- bar — TIDAK ada dampak metodologi:
--   * TIDAK ada formula, skor, normalisasi, atau pembobotan baru/berubah.
--   * TIDAK menyentuh CAI / TDI / Transit Equity Index, tabel skor, ETL,
--     konfigurasi_bobot, maupun RPC lain (simulate_new_stop, get_tdi_breakdown,
--     coverage_ratio_kecamatan, dst).
--   * Hanya MEMBACA batas_administrasi, sama seperti 030.
--
-- MASALAH (temuan QA 2026-09-08)
-- ------------------------------------------------------------
-- Kolom batas_administrasi.nama_kecamatan menyimpan nama secara TIDAK konsisten:
-- sebagian bersspasi, sebagian dirangkai. 12 kecamatan DISTINCT yang tersimpan:
--     Bantargebang, Bekasi Barat, Bekasi Selatan, Bekasi Timur, Bekasi Utara,
--     Jatiasih, Jatisampurna, Medansatria, Mustikajaya, Pondokgede,
--     Pondokmelati, Rawalumbu
-- Sementara ejaan alami yang diketik pengguna (dan yang dipakai PRD sendiri,
-- mis. "Kecamatan Mustika Jaya") justru MEMAKAI spasi. Karena 030 mencocokkan
-- dengan `nama_kecamatan ILIKE '%' || q || '%'` apa adanya, maka:
--     ketik "mustika jaya"  -> TIDAK cocok dengan baris "Mustikajaya"
--     ketik "rawa lumbu"    -> TIDAK cocok dengan "Rawalumbu"
--     ketik "jati asih"     -> TIDAK cocok dengan "Jatiasih"
--     ketik "pondok gede"   -> TIDAK cocok dengan "Pondokgede"
--     ketik "bantar gebang" -> TIDAK cocok dengan "Bantargebang"
--     ketik "medan satria"  -> TIDAK cocok dengan "Medansatria"
-- Pengguna hanya mendapat baris kelurahan (atau nol baris) di level kecamatan.
--
-- PERBAIKAN
-- ------------------------------------------------------------
-- Pencocokan jadi TAK-PEDULI-SPASI: spasi dibuang dari KEDUA sisi perbandingan
-- (kolom DAN query), sehingga simetris — ejaan berspasi menemukan nama yang
-- dirangkai, dan sebaliknya:
--     replace(b.nama_kecamatan, ' ', '') ilike '%' || replace(p.qq, ' ', '') || '%'
--     replace(b.nama_kelurahan, ' ', '') ilike '%' || replace(p.qq, ' ', '') || '%'
-- Normalisasi yang sama diterapkan ke cabang KELURAHAN, karena nama kelurahan
-- punya risiko inkonsistensi penulisan yang persis sama.
-- Konsekuensi yang diinginkan (bukan bug):
--     "bekasi timur"  tetap cocok "Bekasi Timur"  (kedua sisi jadi "bekasitimur")
--     "bekasitimur"   kini juga cocok "Bekasi Timur"
--
-- NORMALISASI HANYA UNTUK PERBANDINGAN, TIDAK UNTUK TAMPILAN
-- ------------------------------------------------------------
-- Kolom `nama` dan `nama_kecamatan` yang DIKEMBALIKAN tetap nilai APA ADANYA
-- dari tabel (spasi asli dipertahankan). replace() hanya muncul di klausa WHERE
-- dan tidak pernah di SELECT-list — supaya label di peta/dropdown frontend
-- tetap ejaan resmi ("Bekasi Timur", bukan "BekasiTimur").
--
-- GUARD 2 KARAKTER — DIHITUNG SEBELUM SPASI DIBUANG
-- ------------------------------------------------------------
-- Guard tetap `char_length(btrim(q)) >= 2`, yaitu dihitung pada query yang
-- sudah di-trim TAPI BELUM dibuang spasi tengahnya (identik dengan 030).
-- Ini disengaja dan konsisten: input hanya-spasi selalu jadi '' setelah btrim
-- (panjang 0) sehingga tetap terblokir, dan input berspasi tengah pasti punya
-- >= 1 karakter non-spasi di kiri dan kanan sehingga tidak mungkin menyusut
-- jadi kosong. Perilaku guard yang terlihat pengguna TIDAK berubah:
--     ''    -> 0 baris ;  ' ' -> 0 baris ;  'a' -> 0 baris
--
-- KONTRAK OUTPUT: TIDAK BERUBAH SAMA SEKALI (frontend sudah produksi)
-- ------------------------------------------------------------
--   level, nama, nama_kecamatan, min_lng, min_lat, max_lng, max_lat
--   Urutan kecamatan (0) dulu lalu kelurahan (1), masing-masing alfabetis
--   menurut `nama`, LIMIT 12 total, LANGUAGE sql STABLE, SECURITY INVOKER
--   (default -> tetap tunduk RLS; policy SELECT publik dari 002_rls_policies.sql).
--
-- KENAPA FILE BARU, BUKAN MENGEDIT 030
-- ------------------------------------------------------------
-- 030_search_admin_bounds.sql SUDAH TER-APPLY ke project remote
-- (vpymlmaebvfmpowomsec). Mengedit file yang sudah tercatat di riwayat migration
-- tidak akan dijalankan ulang oleh `supabase db push` dan membuat riwayat lokal
-- desync dengan remote. Jadi perbaikan dikirim sebagai migration BARU yang
-- meng-`create or replace` fungsi yang sama.
--
-- URUTAN FILE: migration ke-031, setelah 030_search_admin_bounds.sql.
-- Perubahan vs 030: HANYA ekspresi pencocokan di dua klausa WHERE
-- (ditambah replace(..., ' ', '') di kedua sisi) + comment + re-grant.
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
        --   qq      : query setelah trim  -> dipakai untuk GUARD panjang >= 2
        --   qq_norm : query tanpa spasi   -> dipakai untuk PENCOCOKAN saja
        select
            btrim(coalesce(q, ''))                        as qq,
            replace(btrim(coalesce(q, '')), ' ', '')      as qq_norm
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
          -- Spasi dibuang di KEDUA sisi: "mustika jaya" cocok "Mustikajaya",
          -- "bekasi timur" tetap cocok "Bekasi Timur". Nilai yang di-SELECT
          -- tetap b.nama_kecamatan apa adanya (spasi asli dipertahankan).
          and replace(b.nama_kecamatan, ' ', '') ilike '%' || replace(p.qq, ' ', '') || '%'
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
          -- Normalisasi spasi yang sama untuk nama kelurahan (risiko
          -- inkonsistensi penulisan identik dengan nama kecamatan).
          and replace(b.nama_kelurahan, ' ', '') ilike '%' || replace(p.qq, ' ', '') || '%'
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
    'Bekasi via substring case-insensitive DAN tak-peduli-spasi (spasi dibuang '
    'dari kolom maupun query saat dibandingkan, sehingga "mustika jaya" cocok '
    'dengan "Mustikajaya" dan "bekasi timur" tetap cocok dengan "Bekasi Timur"); '
    'kembalikan bounding box (lng/lat, WGS84) tiap kecocokan untuk fitBounds '
    'peta. Nama yang dikembalikan tetap ejaan asli dari tabel. Baris kecamatan '
    'dulu lalu kelurahan, alfabetis, LIMIT 12. Guard panjang >= 2 karakter '
    'dihitung sebelum spasi dibuang. Tidak ada dampak metodologi — hanya '
    'membaca batas_administrasi (RLS SELECT publik, 002_rls_policies.sql). '
    'Lihat 031_search_admin_bounds_normalisasi_spasi.sql (revisi dari 030).';

-- `create or replace function` bisa mereset grant di sebagian kasus, jadi grant
-- diulang eksplisit — konsisten dengan RPC publik lain di proyek
-- (simulate_new_stop 003, get_tdi_breakdown 015) yang juga di-grant ke anon.
grant execute on function search_admin_bounds(text) to anon, authenticated;

-- Uji cepat (SQL Editor) — fokus regresi vs perbaikan:
--   select * from search_admin_bounds('mustika jaya'); -- PERBAIKAN: kini ada baris kecamatan 'Mustikajaya'
--   select * from search_admin_bounds('mustikajaya');  -- regresi: tetap ada baris kecamatan 'Mustikajaya'
--   select * from search_admin_bounds('bekasi timur'); -- regresi: tetap ada baris kecamatan 'Bekasi Timur'
--   select * from search_admin_bounds('rawa lumbu');   -- PERBAIKAN: kecamatan 'Rawalumbu'
--   select * from search_admin_bounds('pondok gede');  -- PERBAIKAN: kecamatan 'Pondokgede'
--   select * from search_admin_bounds('a');            -- 0 baris (guard < 2 karakter)
--   select * from search_admin_bounds(' ');            -- 0 baris (btrim -> '')
