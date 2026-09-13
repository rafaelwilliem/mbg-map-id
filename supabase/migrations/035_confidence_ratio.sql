-- ============================================================
-- GeoTransit Insight — 035_confidence_ratio.sql
--
-- Confidence Ratio — metrik BARU (diminta Sam + mentor 2026-09-13),
-- TIDAK SAMA dengan AHP consistency_ratio (konfigurasi_bobot). Lihat
-- docs/CONFIDENCE_RATIO.md untuk desain lengkap & justifikasi tiap formula
-- (dibaca DULU sebelum mengubah file ini).
--
-- APA INI: "seberapa yakin kita bahwa skor CAI/TDI/Equity di lokasi ini
-- betul-betul merepresentasikan kondisi nyata lapangan" — sinyal keandalan
-- PER SKOR, bukan validitas metodologi pembobotan (itu peran consistency_
-- ratio yang sudah ada sejak migration 018).
--
-- BATASAN KERAS (diikuti persis):
--   * TIDAK mengubah skor CAI/TDI/Equity ATAU bobot AHP mana pun — murni
--     kolom TAMBAHAN, dibaca berdampingan, tidak pernah menggantikan.
--   * TIDAK ada pengumpulan data baru — semua formula di bawah diturunkan
--     dari kolom yang SUDAH ADA (cai_bobot_volume/survei dari migration 033,
--     halte gabungan survei+OSM dari compute_tdi_full.py 2026-09-11).
--   * ADITIF murni: `alter table ... add column if not exists`, `create or
--     replace function` (signature RPC TIDAK berubah), tidak ada DROP.
--
-- URUTAN FILE: migration ke-035, setelah 034_admin_geometry_filter_sumber.sql.
--
-- ------------------------------------------------------------
-- RINGKASAN 3 FORMULA (detail & contoh manual: docs/CONFIDENCE_RATIO.md)
-- ------------------------------------------------------------
--  1. CAI (per sel grid)  : confidence_ratio = n_kriteria_aktif / 4
--       (kepadatan+jarak SELALU aktif = 2; +survei kalau ada halte tersurvei
--        <=400m; +volume kalau ada titik cacah lapangan <=300m — kolom
--        cai_bobot_survei/cai_bobot_volume non-null = kriteria itu aktif,
--        SUDAH ada sejak 033, dibaca apa adanya, tidak dihitung ulang.)
--       Dihitung LANGSUNG di SQL (backfill di bawah) — tidak perlu rerun ETL.
--  2. TDI (per sel grid)  : confidence_ratio berdasar SUMBER halte terdekat
--       yang dipakai skor_aksesibilitas_transit: 'survei_lapangan' -> 1,00
--       (Tinggi); 'osm_belum_disurvei' -> 0,60 (Sedang). Kolom sumber ini
--       BELUM pernah dipersist ke grid_analisis sebelumnya (compute_tdi_full.
--       py menghitungnya in-memory lalu buang) — ditambahkan di sini sebagai
--       kolom BARU, NULL sampai `python etl/compute_tdi_full.py --upload`
--       dijalankan ulang (skor_tdi itu sendiri TIDAK berubah).
--  3. Equity (per kelurahan): confidence_ratio = MIN(cai_confidence_ratio)
--       atas semua sel grid_analisis yang jatuh di kelurahan itu (bukan
--       rata-rata — defensif, "weakest link", lihat justifikasi di dok).
--       NULL sampai `python etl/aggregate_equity_kelurahan.py --upload`
--       dijalankan ulang (butuh kolom #1 di atas sudah terisi — sudah,
--       lewat backfill SQL migration ini).
--
-- Ambang tier (sama utk ketiganya): >=0,90 Tinggi | >=0,50 Sedang | <0,50 Rendah.
-- ============================================================

-- ------------------------------------------------------------
-- 1. grid_analisis — kolom confidence CAI (backfill SQL LANGSUNG di bawah)
-- ------------------------------------------------------------
alter table grid_analisis add column if not exists cai_confidence_n_kriteria smallint;
alter table grid_analisis add column if not exists cai_confidence_ratio     numeric(5,4);
alter table grid_analisis add column if not exists cai_confidence_tier     text;

comment on column grid_analisis.cai_confidence_ratio is
    'Confidence Ratio CAI (BARU 2026-09-13, BUKAN AHP consistency_ratio — lihat '
    'docs/CONFIDENCE_RATIO.md) = n_kriteria_aktif / 4. n_kriteria_aktif dihitung dari '
    'cai_bobot_volume/cai_bobot_survei non-null (033) + kepadatan & jarak yang selalu '
    'aktif. TIDAK memengaruhi cai_skor — murni sinyal keandalan tambahan.';
comment on column grid_analisis.cai_confidence_tier is
    'Label kategorikal dari cai_confidence_ratio: Tinggi (>=0,90, 4 kriteria) / '
    'Sedang (>=0,50, 3 kriteria) / Rendah (<0,50, 2 kriteria). Lihat docs/CONFIDENCE_RATIO.md.';

-- Backfill LANGSUNG dari kolom yang sudah ada (033) — TIDAK butuh rerun ETL
-- untuk CAI confidence (beda dengan TDI/Equity di bawah, yang butuh 1x rerun
-- karena kolom sumbernya belum pernah dipersist).
update grid_analisis
set
    cai_confidence_n_kriteria = 2
        + (case when cai_bobot_volume is not null then 1 else 0 end)
        + (case when cai_bobot_survei is not null then 1 else 0 end),
    cai_confidence_ratio = (
        2
        + (case when cai_bobot_volume is not null then 1 else 0 end)
        + (case when cai_bobot_survei is not null then 1 else 0 end)
    )::numeric / 4,
    cai_confidence_tier = case
        when (case when cai_bobot_volume is not null then 1 else 0 end)
           + (case when cai_bobot_survei is not null then 1 else 0 end) = 2 then 'Tinggi'
        when (case when cai_bobot_volume is not null then 1 else 0 end)
           + (case when cai_bobot_survei is not null then 1 else 0 end) = 1 then 'Sedang'
        else 'Rendah'
    end
where cai_skor is not null;  -- hanya sel yang CAI grid-nya sudah dihitung (033/compute_cai_grid.py)

-- ------------------------------------------------------------
-- 2. grid_analisis — provenance halte terdekat + confidence TDI
--    (kolom BARU; NULL sampai rerun `python etl/compute_tdi_full.py --upload`)
-- ------------------------------------------------------------
alter table grid_analisis add column if not exists jarak_halte_terdekat_m   numeric(9,2);
alter table grid_analisis add column if not exists sumber_halte_terdekat    text;
alter table grid_analisis add column if not exists tdi_confidence_ratio     numeric(5,4);
alter table grid_analisis add column if not exists tdi_confidence_tier     text;

comment on column grid_analisis.sumber_halte_terdekat is
    'Asal titik halte gabungan (survei+OSM, compute_tdi_full.load_halte_gabungan(), sejak '
    '2026-09-11) yang terdekat dari sel ini dan dipakai skor_aksesibilitas_transit: '
    '''survei_lapangan'' (15 halte_eksisting REAL tersurvei tim) atau ''osm_belum_disurvei'' '
    '(~32 titik BisKita Trans Patriot dari OSM, belum disurvei fisik tim). Kolom provenance '
    'BARU (035) — sebelumnya dihitung in-memory oleh compute_tdi_full.py tapi tidak pernah '
    'dipersist. Diisi oleh `python etl/compute_tdi_full.py --upload`.';
comment on column grid_analisis.tdi_confidence_ratio is
    'Confidence Ratio TDI (BARU 2026-09-13, BUKAN AHP consistency_ratio) berdasar '
    'sumber_halte_terdekat: survei_lapangan -> 1,00 (Tinggi) / osm_belum_disurvei -> 0,60 '
    '(Sedang). TIDAK memengaruhi skor_tdi. Lihat docs/CONFIDENCE_RATIO.md untuk justifikasi '
    'angka 0,60. Diisi oleh `python etl/compute_tdi_full.py --upload`.';
comment on column grid_analisis.tdi_confidence_tier is
    'Label kategorikal dari tdi_confidence_ratio: Tinggi (>=0,90) / Sedang (>=0,50) / '
    'Rendah (<0,50). Dengan hanya 2 sumber halte saat ini, nilai yang muncul hanya Tinggi '
    'atau Sedang (tidak pernah Rendah) — lihat docs/CONFIDENCE_RATIO.md.';

-- ------------------------------------------------------------
-- 3. skor_equity — agregasi confidence CAI per kelurahan
--    (kolom BARU; NULL sampai rerun `python etl/aggregate_equity_kelurahan.py --upload`)
-- ------------------------------------------------------------
alter table skor_equity add column if not exists confidence_ratio       numeric(5,4);
alter table skor_equity add column if not exists confidence_ratio_rata2 numeric(5,4);
alter table skor_equity add column if not exists confidence_tier       text;
alter table skor_equity add column if not exists confidence_n_sel      integer;
alter table skor_equity add column if not exists confidence_metode     text;

comment on column skor_equity.confidence_ratio is
    'Confidence Ratio Equity (BARU 2026-09-13, BUKAN AHP consistency_ratio) = MINIMUM '
    'grid_analisis.cai_confidence_ratio atas semua sel grid yang centroidnya jatuh di '
    'kelurahan ini ("weakest link", defensif — lihat justifikasi lengkap docs/'
    'CONFIDENCE_RATIO.md). NULL kalau kelurahan tidak match sel grid manapun (celah RBI, '
    'pola sama dengan jarak_rata2_*). TIDAK memengaruhi skor_final. Diisi oleh '
    '`python etl/aggregate_equity_kelurahan.py --upload`.';
comment on column skor_equity.confidence_ratio_rata2 is
    'Rata-rata (BUKAN minimum) cai_confidence_ratio sel grid kelurahan ini — disimpan HANYA '
    'sebagai pembanding transparansi/audit, BUKAN nilai otoritatif (UI/AI pakai '
    'confidence_ratio/minimum). Lihat docs/CONFIDENCE_RATIO.md.';
comment on column skor_equity.confidence_n_sel is
    'Jumlah sel grid_analisis yang diagregasi untuk confidence_ratio/confidence_ratio_rata2 '
    'kelurahan ini.';
comment on column skor_equity.confidence_metode is
    'Deskripsi metode agregasi confidence (selalu "minimum (konservatif) atas '
    'cai_confidence_ratio sel grid dalam kelurahan" untuk baris yang diisi script 2026-09-13 '
    'ke atas) — lihat docs/CONFIDENCE_RATIO.md.';

-- ------------------------------------------------------------
-- 4. RPC get_cai_breakdown — tambah objek `confidence` (signature TIDAK berubah)
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
    ambang_luar_grid_m constant numeric := 500;
    skor_reproduksi numeric;
    komponen jsonb;
    catatan_txt text;
    formula_txt constant text :=
        'cai_skor = Sum( nilai_ternormalisasi_i x bobot_efektif_i ) untuk i pada '
        || '{kepadatan, jarak_fasilitas_inv, volume_transit, survei_halte} yang AKTIF di sel; '
        || 'tiap nilai dinormalisasi min-max 0-1 (volume: lintas hanya sel terukur); bobot dari '
        || 'AHP pairwise Saaty (konfigurasi_bobot nama_index=''CAI''), lalu subset kriteria aktif '
        || 'direnormalisasi ke jumlah 1. Model ADITIF (nilai x bobot) - BUKAN rasio spt TDI.';
    confidence_formula_txt constant text :=
        'confidence_ratio = n_kriteria_aktif / 4 (BUKAN AHP consistency_ratio — metrik BEDA, '
        || 'lihat docs/CONFIDENCE_RATIO.md). Mengukur keluasan bukti data (berapa kriteria '
        || 'independen menyusun skor ini), bukan validitas metodologi bobot.';
begin
    select g.* into sel
    from grid_analisis g
    where ST_Contains(g.geom, titik)
    limit 1;

    if found then
        match_type := 'memuat';
        jarak_m := 0;
    else
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

    skor_reproduksi := round((
          coalesce(sel.cai_n_kepadatan * sel.cai_bobot_kepadatan, 0)
        + coalesce(sel.cai_n_jarak_inv * sel.cai_bobot_jarak,     0)
        + coalesce(sel.cai_n_volume    * sel.cai_bobot_volume,    0)
        + coalesce(sel.cai_n_survei    * sel.cai_bobot_survei,    0)
    )::numeric, 4);

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
        'match', match_type,
        'jarak_ke_sel_m', jarak_m,
        'skor_cai', round(sel.cai_skor::numeric, 4),
        'skor_cai_reproduksi', skor_reproduksi,
        'formula', formula_txt,
        'volume_estimasi', coalesce(sel.cai_volume_estimasi, false),
        'komponen', komponen,
        -- BARU (035): Confidence Ratio — lihat docs/CONFIDENCE_RATIO.md. TIDAK SAMA
        -- dengan AHP consistency_ratio (konfigurasi_bobot); JANGAN dipertukar di UI/narasi.
        'confidence', case when sel.cai_confidence_ratio is null then null else json_build_object(
            'n_kriteria_aktif', sel.cai_confidence_n_kriteria,
            'n_kriteria_total', 4,
            'confidence_ratio', round(sel.cai_confidence_ratio::numeric, 4),
            'confidence_tier', sel.cai_confidence_tier,
            'formula', confidence_formula_txt
        ) end,
        'catatan', catatan_txt
    );
end;
$$;

comment on function get_cai_breakdown(float, float) is
    'Rincian per-kriteria Composite Accessibility Index (surface grid 300 m, hybrid) + objek '
    'confidence (Confidence Ratio, BUKAN AHP consistency_ratio — 035/docs/CONFIDENCE_RATIO.md) '
    'untuk sel grid_analisis yang memuat (atau terdekat <= 500 m dengan) titik lng/lat. Model '
    'ADITIF (Sum nilai x bobot); komponen 2/3/4 entri sesuai kriteria aktif sel. Titik > 500 m '
    'dari sel terdekat -> di_luar_cakupan_grid=true. Read-only.';

grant execute on function get_cai_breakdown(float, float) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. RPC get_tdi_breakdown — tambah objek `confidence` (signature TIDAK berubah)
--    Badan fungsi IDENTIK dengan 027, hanya menambah field 'confidence'.
-- ------------------------------------------------------------
create or replace function get_tdi_breakdown(lng float, lat float)
returns json
language plpgsql
security definer
as $$
declare
    titik geometry := ST_SetSRID(ST_MakePoint(lng, lat), 4326);
    sel   record;
    match_type text;
    jarak_m numeric;
    akses_floor constant numeric := 0.01;
    ambang_luar_grid_m constant numeric := 500;
    tdi_raw_sel numeric;
    ln_min numeric;
    ln_max numeric;
    skor_tdi_reproduksi numeric;
    confidence_formula_txt constant text :=
        'tdi_confidence_ratio berdasar sumber halte gabungan (survei+OSM) terdekat yang '
        || 'dipakai skor_aksesibilitas_transit: survei_lapangan -> 1,00 (Tinggi) / '
        || 'osm_belum_disurvei -> 0,60 (Sedang). BUKAN AHP consistency_ratio — metrik BEDA, '
        || 'lihat docs/CONFIDENCE_RATIO.md.';
begin
    select g.* into sel
    from grid_analisis g
    where ST_Contains(g.geom, titik)
    limit 1;

    if found then
        match_type := 'memuat';
        jarak_m := 0;
    else
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

        if jarak_m > ambang_luar_grid_m then
            return json_build_object(
                'ditemukan', false,
                'di_luar_cakupan_grid', true,
                'match', 'terdekat',
                'cell_id_terdekat', sel.id,
                'jarak_ke_sel_terdekat_m', jarak_m,
                'ambang_luar_grid_m', ambang_luar_grid_m,
                'catatan',
                    'Titik berada ' || jarak_m || ' m dari sel grid terdekat (> ambang '
                    || ambang_luar_grid_m || ' m). Grid analisis Transit Desert Index hanya '
                    || 'dibangun pada area berpenduduk (footprint bangunan OSM, dasymetric) '
                    || 'sehingga lokasi ini di luar cakupan analisis — tidak ada skor TDI '
                    || 'yang bisa ditampilkan di sini, bukan berarti skornya 0.'
            );
        end if;
    end if;

    tdi_raw_sel :=
        sel.kepadatan_penduduk
        * sel.indeks_kebutuhan_mobilitas
        / greatest(sel.skor_aksesibilitas_transit, akses_floor);

    select min(ln(1 + gr.raw)), max(ln(1 + gr.raw))
      into ln_min, ln_max
    from (
        select
            g.kepadatan_penduduk
            * g.indeks_kebutuhan_mobilitas
            / greatest(g.skor_aksesibilitas_transit, akses_floor) as raw
        from grid_analisis g
        where g.kepadatan_penduduk is not null
          and g.indeks_kebutuhan_mobilitas is not null
          and g.skor_aksesibilitas_transit is not null
    ) gr;

    if ln_max is not null and ln_max > ln_min then
        skor_tdi_reproduksi := round(
            ((ln(1 + tdi_raw_sel) - ln_min) / (ln_max - ln_min))::numeric, 4
        );
    else
        skor_tdi_reproduksi := null;
    end if;

    return json_build_object(
        'ditemukan', true,
        'cell_id', sel.id,
        'match', match_type,
        'jarak_ke_sel_m', jarak_m,
        'skor_tdi', round(sel.skor_tdi::numeric, 4),
        'skor_tdi_reproduksi_perkiraan', skor_tdi_reproduksi,
        'tdi_raw', round(tdi_raw_sel::numeric, 4),
        'aksesibilitas_floor', akses_floor,
        'formula',
            'TDI_raw = kepadatan_penduduk x indeks_kebutuhan_mobilitas / maks(skor_aksesibilitas_transit, 0,01); '
            || 'skor_tdi = normalisasi_minmax(ln(1 + TDI_raw)) lintas seluruh sel grid',
        'komponen', json_build_array(
            json_build_object(
                'kunci', 'kepadatan_penduduk',
                'label', 'Kepadatan penduduk',
                'nilai', round(sel.kepadatan_penduduk::numeric, 2),
                'satuan', 'jiwa per sel (~300 x 300 m, hasil dasymetric mapping)',
                'peran', 'pembilang',
                'arah', 'Makin tinggi -> TDI makin tinggi (defisit layanan makin besar)'
            ),
            json_build_object(
                'kunci', 'indeks_kebutuhan_mobilitas',
                'label', 'Indeks Kebutuhan Mobilitas',
                'nilai', round(sel.indeks_kebutuhan_mobilitas::numeric, 4),
                'satuan', 'indeks 0-1 (proksi: proporsi usia rentan, kepadatan POI harian, proporsi usia sekolah 5-19)',
                'peran', 'pembilang',
                'arah', 'Makin tinggi -> TDI makin tinggi'
            ),
            json_build_object(
                'kunci', 'skor_aksesibilitas_transit',
                'label', 'Skor Aksesibilitas Transit',
                'nilai', round(sel.skor_aksesibilitas_transit::numeric, 4),
                'satuan', 'indeks 0-1 (coverage isochrone 400/800 m ke halte eksisting terdekat)',
                'peran', 'penyebut',
                'arah', 'Makin tinggi -> TDI makin RENDAH (akses transit sudah baik)'
            )
        ),
        -- BARU (035): Confidence Ratio — lihat docs/CONFIDENCE_RATIO.md. NULL sampai
        -- `python etl/compute_tdi_full.py --upload` dijalankan ulang (kolom provenance
        -- sumber_halte_terdekat baru ditambahkan di migration ini).
        'confidence', case when sel.tdi_confidence_ratio is null then null else json_build_object(
            'sumber_halte_terdekat', sel.sumber_halte_terdekat,
            'jarak_halte_terdekat_m', round(sel.jarak_halte_terdekat_m::numeric, 1),
            'confidence_ratio', round(sel.tdi_confidence_ratio::numeric, 4),
            'confidence_tier', sel.tdi_confidence_tier,
            'formula', confidence_formula_txt
        ) end,
        'catatan',
            'skor_tdi lebih tinggi = sel makin "transit desert" (makin butuh prioritas). '
            || 'Nilai komponen diambil apa adanya dari grid_analisis (sudah dihitung offline oleh '
            || 'etl/compute_tdi_full.py) — RPC ini hanya menyajikan rincian, tidak menghitung ulang skor.'
    );
end;
$$;

comment on function get_tdi_breakdown(float, float) is
    'Rincian per-kriteria Transit Desert Index + objek confidence (Confidence Ratio, BUKAN AHP '
    'consistency_ratio — 035/docs/CONFIDENCE_RATIO.md) untuk sel grid_analisis yang memuat '
    '(atau terdekat <=500 m dengan) titik lng/lat. Titik >500 m dari sel terdekat dikembalikan '
    'sebagai di_luar_cakupan_grid=true (021). Read-only.';

grant execute on function get_tdi_breakdown(float, float) to anon, authenticated;

-- ============================================================
-- Uji cepat sesudah `supabase db push`:
--   select cai_confidence_n_kriteria, cai_confidence_ratio, cai_confidence_tier
--     from grid_analisis where cai_skor is not null limit 5;
--   select get_cai_breakdown(106.9900, -6.2400);  -- confidence harus terisi (backfill SQL)
--   select get_tdi_breakdown(106.9900, -6.2400);  -- confidence NULL sampai etl rerun (harapan)
--
-- Setelah `python etl/compute_tdi_full.py --upload`:
--   select sumber_halte_terdekat, tdi_confidence_ratio, tdi_confidence_tier
--     from grid_analisis where skor_tdi is not null limit 5;   -- harus terisi
--
-- Setelah `python etl/aggregate_equity_kelurahan.py --upload`:
--   select confidence_ratio, confidence_ratio_rata2, confidence_tier, confidence_n_sel
--     from skor_equity where sumber ilike 'REAL%' limit 5;     -- harus terisi
-- ============================================================
