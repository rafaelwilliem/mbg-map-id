-- ============================================================
-- GeoTransit Insight — 028_usulan_halte_model.sql
-- Tim MBG — MAPID WebGIS Competition 2026
--
-- KENAPA MIGRATION INI ADA (menutup gap metodologis terbesar, 2026-09-07)
-- ------------------------------------------------------------
-- PRD Bab 1.1 memposisikan produk ini sebagai penjawab pertanyaan "di titik
-- mana pengembangan layanan transit akan memberikan dampak aksesibilitas
-- terbesar" — artinya MODEL SPASIAL yang harus MENGUSULKAN lokasi.
--
-- Yang sudah terbangun sebelum migration ini:
--   * grid_analisis (2.607 sel @300 m, skor_tdi)  -> transit desert, sekota, model-driven
--   * skor_equity   (56 kelurahan)                -> ranking ketimpangan, sekota, model-driven
--   * skor_cai      -> HANYA dihitung di 19 titik_kandidat hasil survei lapangan
--
-- Akibatnya "Usulan Halte Prioritas" selama ini = 19 titik yang KEBETULAN
-- didatangi surveyor, diurutkan CAI. Tidak ada satu langkah pun yang
-- MENURUNKAN kandidat halte dari keluaran TDI/Equity. Kalau juri bertanya
-- "kenapa 19 titik ini?", jawaban jujurnya adalah "karena kami survei di
-- sana", bukan "karena model menemukannya".
--
-- Tabel `usulan_halte_model` menutup gap itu: daftar-pendek lokasi halte baru
-- yang DITURUNKAN MURNI DARI MODEL (grid_analisis.skor_tdi + halte_eksisting
-- + RPC simulate_new_stop), tanpa input survei apa pun.
--
-- PEMISAHAN TEGAS DARI `titik_kandidat` (jangan dicampur):
--   * titik_kandidat     = kandidat TERVALIDASI LAPANGAN (31 titik Survey
--     Activities, 19 REAL dipakai CAI). Punya total_aktivitas hasil traffic
--     counting -> layak masuk formula CAI.
--   * usulan_halte_model = USULAN MODEL, BELUM DISURVEI. Tidak punya
--     total_aktivitas, jadi kriteria 'volume' CAI tidak bisa diisi tanpa
--     mengarang angka. Karena itu tabel ini SENGAJA tidak menyimpan skor_cai.
--
-- SENGAJA TIDAK INSERT KE `titik_kandidat`: ke-19 baris di sana menjadi basis
-- normalisasi min-max CAI. Menambah baris di situ akan diam-diam merescale
-- skor CAI semua kandidat survei (ranking bisa berubah tanpa disadari).
--
-- METODOLOGI PEMILIHAN (detail + contoh hitung ada di
-- etl/generate_usulan_halte_model.py):
--   1. Sumber   : sel grid_analisis dengan skor_tdi > 0,6 — ambang transit
--                 desert yang SUDAH dipakai di Dashboard.jsx / DataLaporan.jsx
--                 (TRANSIT_DESERT_THRESHOLD) dan migration 022
--                 (potensi_penerima_manfaat.ambang_tdi default 0.6).
--   2. Saring   : centroid sel >= 400 m dari SETIAP halte_eksisting real
--                 (id_halte_survei DUMMY-HLT-* dikecualikan, sama seperti
--                 compute_tdi_full.load_halte_real()). 400 m = walking
--                 catchment ITDP yang sudah dipakai simulate_new_stop (003)
--                 dan AMBANG_PENUH_M di compute_tdi_full.py — bukan angka baru.
--   3. De-klaster: greedy, urut skor_tdi desc, tolak sel yang < 800 m dari
--                 titik terpilih sebelumnya. 800 m = catchment luar yang sudah
--                 dipakai (AMBANG_NIHIL_M / radius 800 m simulate_new_stop) —
--                 mencegah dua usulan berimpit melayani populasi yang sama.
--   4. Dampak   : untuk tiap titik terpilih, panggil RPC simulate_new_stop()
--                 -> penduduk_terlayani_400m / _800m. Ini metrik "dampak
--                 aksesibilitas" riil dan memakai mesin yang sudah divalidasi;
--                 TIDAK ada formula skor baru yang diciptakan di sini.
--   5. Ranking  : primer = penduduk_terlayani_800m (proyeksi penduduk
--                 tambahan terlayani), sekunder = skor_tdi sel asal (sinyal
--                 kebutuhan). Keduanya disimpan supaya bisa ditelusuri.
--
-- URUTAN FILE: migration ke-028, setelah 027_get_tdi_breakdown_usia_sekolah_label.sql.
-- Perubahan vs sebelumnya: MURNI ADITIF — satu tabel baru + index + RLS.
-- Tidak menyentuh grid_analisis, titik_kandidat, skor_cai, skor_tdi,
-- skor_equity, konfigurasi_bobot, maupun fungsi RPC mana pun.
-- ============================================================

create table if not exists usulan_halte_model (
    id                       bigint generated always as identity primary key,
    kode                     text unique not null,          -- 'MDL-001', 'MDL-002', ...
    geom                     geometry(Point, 4326) not null,
    grid_analisis_id         bigint references grid_analisis(id) on delete set null,
    skor_tdi_sel             numeric(6,4),                  -- skor_tdi sel grid asal (sinyal kebutuhan)
    penduduk_terlayani_400m  integer,                       -- dari RPC simulate_new_stop
    penduduk_terlayani_800m  integer,                       -- dari RPC simulate_new_stop
    jarak_halte_terdekat_m   numeric(9,2),                  -- ke halte_eksisting REAL terdekat (>= 400 m by construction)
    kecamatan                text,                          -- spatial join centroid -> batas_administrasi
    kelurahan                text,
    ranking                  integer,                       -- 1 = dampak terbesar (penduduk_terlayani_800m tertinggi)
    sumber                   text,                          -- deskripsi penurunan (lihat script ETL)
    catatan                  text,
    dibuat_pada              timestamptz default now()
);

create index if not exists idx_usulan_halte_model_geom on usulan_halte_model using gist (geom);
create index if not exists idx_usulan_halte_model_ranking on usulan_halte_model (ranking);

comment on table usulan_halte_model is
    'Usulan lokasi halte baru yang DITURUNKAN DARI MODEL SPASIAL (grid_analisis.skor_tdi > 0,6,
     >= 400 m dari halte eksisting real, de-klaster greedy 800 m), diranking dengan proyeksi
     penduduk terlayani dari RPC simulate_new_stop. BELUM DISURVEI LAPANGAN — berbeda dari
     titik_kandidat yang merupakan kandidat tervalidasi lapangan (Survey Activities). Tabel ini
     sengaja TIDAK menyimpan skor CAI: kriteria volume CAI berasal dari traffic counting
     lapangan yang tidak dimiliki titik hasil model, dan mengarang angkanya akan melanggar
     prinsip "model/AI tidak pernah menciptakan angka" (CLAUDE.md).';

comment on column usulan_halte_model.ranking is
    'Ranking dampak: 1 = proyeksi penduduk terlayani 800 m tertinggi. Tie-break: skor_tdi_sel.';
comment on column usulan_halte_model.sumber is
    'Jejak penurunan (provenance) titik ini — ambang & metode, supaya skor bisa ditelusuri.';

-- ------------------------------------------------------------
-- RLS: sama seperti seluruh tabel proyek (lihat 002_rls_policies.sql) —
-- publik HANYA boleh SELECT; penulisan hanya lewat service_role (ETL Python).
-- ------------------------------------------------------------
alter table usulan_halte_model enable row level security;

drop policy if exists "Publik boleh baca usulan_halte_model" on usulan_halte_model;
create policy "Publik boleh baca usulan_halte_model"
    on usulan_halte_model for select using (true);

-- TIDAK ada policy INSERT/UPDATE/DELETE -> anon & authenticated read-only.

-- Uji cepat:
--   select kode, ranking, skor_tdi_sel, penduduk_terlayani_800m, kecamatan, kelurahan
--   from usulan_halte_model order by ranking limit 10;
