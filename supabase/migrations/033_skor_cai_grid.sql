-- ============================================================
-- GeoTransit Insight — 033_skor_cai_grid.sql
--
-- SURFACE Composite Accessibility Index (CAI) 300 m di grid_analisis —
-- HYBRID: kriteria DIUKUR di sel yang punya data lapangan di dekatnya
-- (titik survei / halte tersurvei) dan DITURUNKAN dari geodata (kepadatan
-- dasymetric, jarak POI OSM) di sel lain. Menjawab acceptance criteria
-- PRD Bab 8 ("klik lokasi -> skor + rincian kontribusi tiap kriteria")
-- untuk SELURUH kota, bukan hanya titik_kandidat yang kebetulan disurvei.
--
-- ------------------------------------------------------------
-- KAPABILITAS BARU & MURNI ADITIF — TIDAK ADA yang di-drop/di-ubah:
--   * TIDAK menyentuh tabel skor_cai berbasis titik, alur titik_kandidat,
--     maupun fungsi recompute_all_cai_scores(). Baris titik_kandidat REAL
--     tetap jadi basis normalisasi min-max CAI titik yang dipakai
--     usulan_halte_model — surface ini dihitung TERPISAH, dinormalisasi
--     lintas 2.607 sel grid sendiri.
--   * Hanya `alter table grid_analisis add column if not exists ...` (14
--     kolom cai_*) + 1 RPC baru get_cai_breakdown(). Tidak ada perubahan
--     tabel lain, tidak ada perubahan RLS (grid_analisis sudah
--     "Publik boleh baca ..." di 002_rls_policies.sql; kolom baru ikut
--     kebijakan select yang sama). Tidak ada DROP apa pun.
--
-- URUTAN FILE: migration ke-033, setelah 032_get_admin_geometry.sql.
--   (Brief tugas menyebut 030, tapi 030/031/032 sudah terpakai untuk
--    search_admin_bounds & get_admin_geometry — file ini pakai 033, nomor
--    bebas berikutnya, supaya `supabase db push` tidak bentrok.)
--
-- ------------------------------------------------------------
-- FORMULA (ADITIF — Weighted Linear Combination, sejajar CAI titik;
-- BUKAN rasio multiplikatif seperti TDI):
--
--   cai_skor = Sum( cai_n_i x cai_bobot_i )   i pada {kepadatan, jarak_inv,
--                                             volume, survei} yang AKTIF di sel tsb
--
--   cai_n_kepadatan = minmax( kepadatan_penduduk )                 -- SELALU aktif (dasymetric, apa adanya)
--   cai_n_jarak_inv = minmax( cai_jarak_fasilitas_m, INVERSE )     -- SELALU aktif; jarak ke POI, clip 3000 m
--   cai_n_volume    = minmax( cai_volume_penumpang )               -- aktif HANYA di sel terukur (lihat di bawah)
--   cai_n_survei    = cai_skor_survei apa adanya (0-1)             -- aktif HANYA kalau ada halte tersurvei <= 400 m
--   minmax kepadatan & jarak dihitung lintas SELURUH 2.607 sel;
--   minmax volume dihitung lintas HANYA sel terukur.
--   Bobot dasar dari konfigurasi_bobot nama_index='CAI' (AHP pairwise Saaty
--   formal 2026-09-03, CR = 0,0226): kepadatan 0,3290 / jarak_inv 0,3290 /
--   volume 0,2002 / survei 0,1418.
--
-- BOBOT EFEKTIF PER SEL — renormalisasi subset kriteria yang AKTIF ke jumlah 1
-- (logika identik compute_scores.compute_cai(exclude_criteria=...), tapi
-- exclude bisa {'volume'}, {'survei'}, atau {'volume','survei'} per sel).
-- Empat kasus (kepadatan & jarak SELALU aktif):
--   | kriteria aktif                    | cai_bobot_kepadatan/jarak/volume/survei |
--   |-----------------------------------|-----------------------------------------|
--   | kepadatan + jarak                 | 0,5000 / 0,5000 / -      / -             |  <- mayoritas sel
--   | kepadatan + jarak + survei        | 0,4113 / 0,4113 / -      / 0,1775        |
--   | kepadatan + jarak + volume        | 0,3834 / 0,3834 / 0,2331 / -            |
--   | kepadatan + jarak + volume + surv | 0,3290 / 0,3290 / 0,2002 / 0,1418       |
--   Kepadatan & jarak dinilai SAMA di AHP 2026-09-03 (0,329 = 0,329) -> kasus
--   2-kriteria 0,5/0,5 adalah RASIO AHP PERSIS, cuma di-rescale ke jumlah 1.
--
-- VOLUME — HANYA sel terukur (tidak ada estimasi apa pun):
--   * Sel MEMUAT titik survei ATAU centroid <= 300 m dari titik survei REAL
--     -> cai_volume_penumpang = total_aktivitas titik terdekat; kriteria volume AKTIF.
--   * Sel lain -> cai_volume_penumpang / cai_n_volume / cai_bobot_volume = NULL
--     (volume N/A, mekanisme sama persis dg survei N/A). Keputusan Sam
--     2026-09-10 (Opsi B): regresi kepadatan<->volume ditolak (R^2 ~0,07
--     terlalu lemah, intercept volume>0 saat kepadatan 0 tidak masuk akal)
--     -> volume hanya dipakai di ~37 sel yang benar-benar dicacah lapangan.
--   Kolom cai_volume_estimasi DIPERTAHANKAN di schema untuk stabilitas
--   kontrak, tapi SELALU false (tidak ada sel estimasi).
--
-- RADII (semua DIPINJAM dari konstanta yang sudah berlaku di repo):
--   POI clip 3000 m · volume "terukur" <= 300 m (= lebar sel) ·
--   survei halte <= 400 m (= walking catchment ITDP / AMBANG_PENUH_M) ·
--   RPC "di luar grid" > 500 m (cermin get_tdi_breakdown / migration 021).
--
-- KETERTELUSURAN (prinsip CLAUDE.md "model/AI tidak pernah menciptakan
-- angka" + "setiap skor harus bisa ditelusuri"): RPC mengembalikan
--   skor_cai_reproduksi = round( Sum cai_n_i x cai_bobot_i , 4 )
-- dihitung ulang dari kolom tersimpan — HARUS sama dengan cai_skor
-- (model aditif, tak ada log/rasio; run live 2026-09-10: selisih maks 0,0000).
--
-- CONTOH PERHITUNGAN MANUAL (3 sel, dari run offline self-test
-- etl/compute_cai_grid.py — deterministik, seed 42):
--   sel 4-kriteria (kepadatan+jarak+volume+survei; bobot 0,329/0,329/0,2002/0,1418):
--     0,0279*0,3290 + 0,5930*0,3290 + 0,0000*0,2002 + 0,6200*0,1418
--     = 0,0092 + 0,1951 + 0,0000 + 0,0879             = 0,2922  ok (tersimpan 0,2922)
--   sel 3-kriteria (kepadatan+jarak+survei; bobot 0,4114/0,4114/0,1773):
--     0,7790*0,4114 + 0,7144*0,4114 + 0,6200*0,1773
--     = 0,3204 + 0,2939 + 0,1099                       = 0,7242  ok (tersimpan 0,7242)
--   sel 2-kriteria (kepadatan+jarak; bobot 0,5000/0,5000):
--     0,6481*0,5000 + 0,5851*0,5000
--     = 0,3240 + 0,2926                                = 0,6166  ok (tersimpan 0,6166)
--   (kasus kepadatan+jarak+volume, bobot 0,3834/0,3834/0,2331, analog.)
--
-- CARA PAKAI:
--   supabase db push                          -- terapkan file ini
--   python etl/compute_cai_grid.py            -- hitung + print (TIDAK upload)
--   python etl/compute_cai_grid.py --upload   -- isi kolom cai_* (2.607 sel)
--   grid_analisis HARUS sudah terisi (sudah: 2.607 sel dg skor_tdi).
--
-- HASIL RUN LIVE (dry-run) 2026-09-10:
--   distribusi kasus bobot: kepadatan+jarak 2526 · +survei 44 · +volume 37 ·
--   +volume+survei 0 (tak ada sel yg keduanya terpenuhi pada data saat ini);
--   cai_skor min/mean/max = 0,0000 / 0,3999 / 0,9544; |cai_skor - Sum| = 0.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Kolom cai_* di grid_analisis (idempoten, additive)
-- ------------------------------------------------------------
-- raw / mentah
alter table grid_analisis add column if not exists cai_jarak_fasilitas_m numeric;
alter table grid_analisis add column if not exists cai_volume_penumpang  numeric;
alter table grid_analisis add column if not exists cai_skor_survei       numeric(5,4);
alter table grid_analisis add column if not exists cai_volume_estimasi   boolean;
-- ternormalisasi 0-1 (min-max); cai_n_volume / cai_n_survei NULL kalau kriteria N/A di sel itu
alter table grid_analisis add column if not exists cai_n_kepadatan       numeric(5,4);
alter table grid_analisis add column if not exists cai_n_jarak_inv       numeric(5,4);
alter table grid_analisis add column if not exists cai_n_volume          numeric(5,4);
alter table grid_analisis add column if not exists cai_n_survei          numeric(5,4);
-- bobot EFEKTIF per sel (renormalisasi subset kriteria aktif -> jumlah 1; NULL utk kriteria N/A)
alter table grid_analisis add column if not exists cai_bobot_kepadatan   numeric(5,4);
alter table grid_analisis add column if not exists cai_bobot_jarak       numeric(5,4);
alter table grid_analisis add column if not exists cai_bobot_volume      numeric(5,4);
alter table grid_analisis add column if not exists cai_bobot_survei      numeric(5,4);
-- skor akhir + timestamp
alter table grid_analisis add column if not exists cai_skor              numeric(5,4);
alter table grid_analisis add column if not exists cai_dihitung_pada     timestamptz;

comment on column grid_analisis.cai_skor is
    'Composite Accessibility Index surface 300 m (hybrid), 0-1. Sum(cai_n_i * cai_bobot_i) '
    'atas kriteria AKTIF di sel tsb. Additive/WLC, sejajar CAI titik (skor_cai) - BUKAN rasio '
    'spt skor_tdi. Diisi etl/compute_cai_grid.py --upload. Lihat 033_skor_cai_grid.sql.';
comment on column grid_analisis.cai_volume_estimasi is
    'Selalu false (dipertahankan utk stabilitas kontrak). Kriteria volume hanya aktif di ~37 '
    'sel yang benar-benar dicacah lapangan (<= 300 m titik survei); sel lain cai_n_volume NULL. '
    'Tidak ada estimasi regresi (keputusan Opsi B 2026-09-10).';

-- ------------------------------------------------------------
-- 2. RPC get_cai_breakdown(lng, lat) — cermin get_tdi_breakdown (015/021)
-- ------------------------------------------------------------
create or replace function get_cai_breakdown(lng float, lat float)
returns json
language plpgsql
security definer
as $$
declare
    titik geometry := ST_SetSRID(ST_MakePoint(lng, lat), 4326);
    sel   record;
    match_type text;
    jarak_m numeric;
    ambang_luar_grid_m constant numeric := 500;  -- cermin 021: > 1 lebar sel (300 m) di luar area beranalisis
    skor_reproduksi numeric;
    komponen jsonb;
    catatan_txt text;
    formula_txt constant text :=
        'cai_skor = Sum( nilai_ternormalisasi_i x bobot_efektif_i ) untuk i pada '
        || '{kepadatan, jarak_fasilitas_inv, volume_transit, survei_halte} yang AKTIF di sel; '
        || 'tiap nilai dinormalisasi min-max 0-1 (volume: lintas hanya sel terukur); bobot dari '
        || 'AHP pairwise Saaty (konfigurasi_bobot nama_index=''CAI''), lalu subset kriteria aktif '
        || 'direnormalisasi ke jumlah 1. Model ADITIF (nilai x bobot) - BUKAN rasio spt TDI.';
begin
    -- 1. Sel grid yang MEMUAT titik klik.
    select g.* into sel
    from grid_analisis g
    where ST_Contains(g.geom, titik)
    limit 1;

    if found then
        match_type := 'memuat';
        jarak_m := 0;
    else
        -- 2. Fallback: sel TERDEKAT (<-> pakai index GIST idx_grid_analisis_geom).
        select g.* into sel
        from grid_analisis g
        order by g.geom <-> titik
        limit 1;

        if not found then
            return json_build_object(
                'ditemukan', false,
                'pesan', 'Tidak ada baris grid_analisis di database.'
            );
        end if;

        match_type := 'terdekat';
        jarak_m := round(
            ST_Distance(ST_Centroid(sel.geom)::geography, titik::geography)::numeric, 0
        );

        -- 2b. GUARD LUAR GRID (cermin migration 021).
        if jarak_m > ambang_luar_grid_m then
            return json_build_object(
                'ditemukan', false,
                'di_luar_cakupan_grid', true,
                'cell_id_terdekat', sel.id,
                'jarak_ke_sel_terdekat_m', jarak_m,
                'ambang_luar_grid_m', ambang_luar_grid_m,
                'catatan',
                    'Titik berada ' || jarak_m || ' m dari sel grid terdekat (> ambang '
                    || ambang_luar_grid_m || ' m). Surface CAI grid hanya dibangun pada area '
                    || 'berpenduduk (footprint bangunan OSM, dasymetric) sehingga lokasi ini di '
                    || 'luar cakupan analisis - tidak ada skor CAI grid yang bisa ditampilkan di '
                    || 'sini, bukan berarti skornya 0.'
            );
        end if;
    end if;

    -- 3. Sel ditemukan tapi kolom cai_* belum diisi (033 sudah dipush, tapi
    --    etl/compute_cai_grid.py --upload belum dijalankan).
    if sel.cai_skor is null then
        return json_build_object(
            'ditemukan', false,
            'cell_id', sel.id,
            'match', match_type,
            'jarak_ke_sel_m', jarak_m,
            'pesan', 'Sel grid ditemukan, tetapi skor CAI grid belum dihitung '
                     || '(kolom cai_skor NULL). Jalankan: python etl/compute_cai_grid.py --upload.'
        );
    end if;

    -- 4. Reproduksi aditif dari kolom tersimpan (bukti ketertelusuran).
    skor_reproduksi := round((
          coalesce(sel.cai_n_kepadatan * sel.cai_bobot_kepadatan, 0)
        + coalesce(sel.cai_n_jarak_inv * sel.cai_bobot_jarak,     0)
        + coalesce(sel.cai_n_volume    * sel.cai_bobot_volume,    0)
        + coalesce(sel.cai_n_survei    * sel.cai_bobot_survei,    0)
    )::numeric, 4);

    -- 5. komponen: 2 entri (kepadatan+jarak, selalu ada) + volume kalau aktif + survei kalau aktif.
    komponen := jsonb_build_array(
        jsonb_build_object(
            'kunci', 'kepadatan',
            'label', 'Kepadatan penduduk',
            'nilai', round(sel.cai_n_kepadatan::numeric, 4),
            'bobot', round(sel.cai_bobot_kepadatan::numeric, 4),
            'kontribusi', round((sel.cai_n_kepadatan * sel.cai_bobot_kepadatan)::numeric, 4),
            'nilai_mentah', round(sel.kepadatan_penduduk::numeric, 2),
            'satuan', 'jiwa per sel (~300 x 300 m, dasymetric mapping)',
            'arah', 'Makin padat -> skor CAI naik (prioritas naik)'
        ),
        jsonb_build_object(
            'kunci', 'jarak_fasilitas_inv',
            'label', 'Jarak ke fasilitas umum (inverse)',
            'nilai', round(sel.cai_n_jarak_inv::numeric, 4),
            'bobot', round(sel.cai_bobot_jarak::numeric, 4),
            'kontribusi', round((sel.cai_n_jarak_inv * sel.cai_bobot_jarak)::numeric, 4),
            'nilai_mentah', round(sel.cai_jarak_fasilitas_m::numeric, 1),
            'satuan', 'meter ke POI fasilitas umum terdekat (sekolah/faskes/kerja, OSM; dibatasi 3000 m)',
            'arah', 'Makin dekat -> skor CAI naik'
        )
    );

    if sel.cai_n_volume is not null then
        komponen := komponen || jsonb_build_array(jsonb_build_object(
            'kunci', 'volume',
            'label', 'Volume penumpang / aktivitas transit',
            'nilai', round(sel.cai_n_volume::numeric, 4),
            'bobot', round(sel.cai_bobot_volume::numeric, 4),
            'kontribusi', round((sel.cai_n_volume * sel.cai_bobot_volume)::numeric, 4),
            'nilai_mentah', round(sel.cai_volume_penumpang::numeric, 1),
            'satuan', 'aktivitas / 2 jam (traffic counting lapangan, titik survei <= 300 m)',
            'arah', 'Makin tinggi -> skor CAI naik'
        ));
    end if;

    if sel.cai_n_survei is not null then
        komponen := komponen || jsonb_build_array(jsonb_build_object(
            'kunci', 'survei',
            'label', 'Skor survei kondisi halte (simpul terdekat)',
            'nilai', round(sel.cai_n_survei::numeric, 4),
            'bobot', round(sel.cai_bobot_survei::numeric, 4),
            'kontribusi', round((sel.cai_n_survei * sel.cai_bobot_survei)::numeric, 4),
            'nilai_mentah', round(sel.cai_skor_survei::numeric, 4),
            'satuan', 'indeks 0-1 (Form Kondisi Halte, halte eksisting tersurvei <= 400 m dari sel)',
            'arah', 'Makin baik kondisi halte -> skor CAI naik'
        ));
    end if;

    -- 6. catatan.
    catatan_txt :=
        'Surface CAI grid 300 m HYBRID: kriteria diukur di sel yang punya data lapangan di '
        || 'dekatnya dan diturunkan dari geodata (kepadatan dasymetric, jarak POI OSM) di sel '
        || 'lain. Nilai ternormalisasi & bobot diambil apa adanya dari grid_analisis (dihitung '
        || 'offline oleh etl/compute_cai_grid.py) - RPC ini hanya menyajikan rincian, tidak '
        || 'menghitung ulang skor. Model ADITIF (Sum nilai x bobot), sejajar CAI titik - bukan '
        || 'rasio seperti TDI.';
    if sel.cai_n_volume is null then
        catatan_txt := catatan_txt
            || ' Kriteria volume transit N/A untuk sel ini - tidak ada titik cacah lapangan '
            || '<= 300 m. Volume hanya dipakai di ~37 sel yang benar-benar dicacah; bobot 2/3 '
            || 'kriteria sisanya direnormalisasi ke jumlah 1.';
    end if;
    if sel.cai_n_survei is null then
        catatan_txt := catatan_txt
            || ' Kriteria survei kondisi halte N/A untuk sel ini (tidak ada halte tersurvei '
            || '<= 400 m); bobot kriteria sisanya direnormalisasi ke jumlah 1.';
    end if;

    return json_build_object(
        'ditemukan', true,
        'cell_id', sel.id,
        'match', match_type,                          -- 'memuat' | 'terdekat'
        'jarak_ke_sel_m', jarak_m,                    -- 0 kalau 'memuat'
        'skor_cai', round(sel.cai_skor::numeric, 4),
        'skor_cai_reproduksi', skor_reproduksi,       -- Sum(n_i x bobot_i) dari kolom tersimpan
        'formula', formula_txt,
        'volume_estimasi', coalesce(sel.cai_volume_estimasi, false),  -- selalu false (kontrak stabil)
        'komponen', komponen,                         -- 2, 3, atau 4 entri sesuai kriteria aktif
        'catatan', catatan_txt
    );
end;
$$;

comment on function get_cai_breakdown(float, float) is
    'Rincian per-kriteria Composite Accessibility Index (surface grid 300 m, hybrid) untuk sel '
    'grid_analisis yang memuat (atau terdekat <= 500 m dengan) titik lng/lat. Model ADITIF '
    '(Sum nilai x bobot); komponen 2/3/4 entri sesuai kriteria aktif sel. Titik > 500 m dari '
    'sel terdekat -> di_luar_cakupan_grid=true. Cermin get_tdi_breakdown (015/021). Read-only. '
    'Lihat 033_skor_cai_grid.sql.';

-- RPC read-only atas data publik-baca (grid_analisis, RLS 002). Konsisten
-- dengan get_tdi_breakdown / simulate_new_stop yang juga di-grant ke anon.
grant execute on function get_cai_breakdown(float, float) to anon, authenticated;

-- Uji cepat sesudah push + `python etl/compute_cai_grid.py --upload`:
--   select get_cai_breakdown(106.9900, -6.2400);   -- in-grid  -> ditemukan=true, match='memuat'
--   select get_cai_breakdown(107.0074, -6.2185);   -- in-grid  -> ditemukan=true
--   select get_cai_breakdown(107.0620, -6.2986);   -- Mustika Jaya timur -> ditemukan=false, di_luar_cakupan_grid=true
--   select get_cai_breakdown(107.3000, -6.1000);   -- laut     -> ditemukan=false, di_luar_cakupan_grid=true
-- Diharapkan pada jalur sukses: skor_cai == skor_cai_reproduksi (selisih 0),
-- komponen 2 entri (mayoritas sel: kepadatan+jarak), 3 kalau ada volume ATAU
-- survei, 4 kalau keduanya.
