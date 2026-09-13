# GeoTransit Insight — Konteks Proyek untuk Claude Code

> Sumber kebenaran: `docs/MBG_PRD_GeoTransitInsight.pdf` — PRD **final**, submission PRD sudah
> dikumpulkan **30 Agustus 2026** (terpisah dari submission WebGIS 13 September 2026 — lihat
> Jalur Kritis di bawah). PDF ini 114 halaman tapi Bab 1–14 inti cuma di halaman 1–22; sisanya
> (hal. 23–114) lampiran screenshot dokumentasi Survey Activities, bukan bagian spesifikasi.
> File ini adalah ringkasan teknis dari PRD tersebut, dibuat supaya tiap sesi Claude Code
> punya konteks yang sama tanpa perlu membaca ulang dokumen PDF itu.
> **Kalau PRD di-update, update juga file ini.**

## Stack sudah final (dikunci 24 Agustus 2026)

PRD sempat punya inkonsistensi antara tabel teks dan diagram arsitektur (MapLibre vs Leaflet, Claude AI vs Gemini). **Sudah diputuskan tim:**

| Komponen | Keputusan final |
|---|---|
| Library peta | **MapLibre GL JS** |
| AI Service | **Claude API** (Messages API, model `claude-haiku-4-5-20251001` untuk narasi cepat — lihat `supabase/functions/ai-insight/index.ts`) |

Kalau nanti ada kode/diagram lama yang masih menyebut Leaflet atau Gemini, itu sudah usang — update ke keputusan final di atas, jangan diikuti.

## Produk

**GeoTransit Insight** — Spatial Decision Support System (SDSS) berbasis WebGIS untuk membantu Dishub & Bappeda Kota Bekasi menentukan lokasi prioritas pembangunan infrastruktur transit massal berbasis data, bukan intuisi.

Prinsip inti yang TIDAK BOLEH dilanggar saat implementasi:
- **AI adalah lapisan interpretasi, bukan penentu skor.** Model spasial deterministik (weighted overlay/MCDA) menghasilkan skor terlebih dahulu; AI (LLM) hanya menerjemahkan skor itu jadi narasi. AI tidak pernah menghasilkan angka sendiri.
- **API key AI tidak boleh menyentuh frontend.** Hanya dipanggil dari Supabase Edge Function (server-side).
- **Setiap skor harus bisa ditelusuri** — user klik lokasi di peta, sistem tunjukkan rincian kontribusi tiap kriteria, bukan cuma angka tunggal (lihat acceptance criteria Composite Accessibility Index di bawah).

## Tech Stack

| Layer | Teknologi |
|---|---|
| Frontend | React.js + MapLibre GL JS + MAPID Maps sebagai basemap |
| Backend | Supabase Pro (PostgreSQL + PostGIS terkelola, auto-REST API, Storage untuk foto survei, Edge Functions) |
| Database | PostgreSQL + PostGIS via Supabase |
| GIS Platform | GEO MAPID (pengolahan data & analisis lokasi). **Community Maps MAPID (Menu Go, Struk Go) TIDAK dipakai** — lihat Catatan (2026-09-13) di bawah; POI fasilitas umum bersumber dari OpenStreetMap |
| AI | Claude API (Messages API), model `claude-haiku-4-5-20251001`, dipanggil via Supabase Edge Function — API key di server (`ANTHROPIC_API_KEY`, bukan `VITE_...`) |
| Hosting | Vercel Pro (frontend) + Supabase Pro (backend/db) — hybrid, domain publik lewat subdomain resmi WebGIS MAPID (CNAME ke Vercel) |
| Repo | GitHub, privat selama pengembangan |

## Struktur Data / Metodologi (jangan diubah tanpa alasan kuat)

- **Composite Accessibility Index (CAI)** — Weighted Linear Combination dari 4 kriteria, tiap kriteria dinormalisasi 0–1 sebelum dikalikan bobot (supaya kontribusi per kriteria bisa ditelusuri per lokasi saat diklik — PRD final Bab 7.3). **Sejak 2026-09-10 CAI dihitung sebagai permukaan grid 300 m di `grid_analisis` (unit spasial sama dengan TDI), bukan lagi hanya di 18 titik survei — lihat Catatan (2026-09-10) dan Catatan (2026-09-12) di bawah.** Empat kriteria & bobotnya:

  | Kriteria | Arah | Bobot | Sumber data |
  |---|---|---|---|
  | Kepadatan penduduk | makin tinggi → prioritas naik | 0,329 | DKB Semester I 2026, grid 300 m (dasymetric) |
  | Jarak ke fasilitas umum (inverse) | makin dekat → skor naik | 0,329 | POI OSM, `ST_Distance` (Menu Go dievaluasi 2026-09-13, tidak dipakai — lihat Catatan di bawah) |
  | Volume penumpang transit terdekat | makin tinggi → skor naik | 0,200 | Data penumpang KRL (KAI Commuter)/BisKita per radius |
  | Skor survei lapangan (kondisi fisik & akses simpul) | — | 0,142 | 31 titik Survey Activities + instrumen survei (0–1) |

  Bobot CAI di atas = hasil **sesi AHP pairwise (Saaty) formal 2026-09-03** (nilai persis di DB: 0,3290 / 0,3290 / 0,2002 / 0,1418). **Bobot TDI_MOBILITAS dan EQUITY juga berubah pada sesi yang sama** — nilai finalnya ada di `supabase/migrations/018_konfigurasi_bobot_ahp_final.sql` (13 baris, lihat juga tabel di `009` untuk pemetaan huruf kriteria → `nama_kriteria`). **Catatan (2026-09-06):** baris `('TDI_MOBILITAS','tanpa_kendaraan',0,4000)` dari sesi 018 sudah digantikan `('TDI_MOBILITAS','usia_sekolah',0,4000)` oleh `026_tdi_mobilitas_usia_sekolah.sql` (bobot & CR tidak berubah, hanya komponennya) — lihat bagian Transit Desert Index di bawah + `docs/VALIDASI_BOBOT_AHP.md`.

  **Catatan (2026-09-07, keputusan tim — deviasi metodologi yang DISENGAJA):** untuk baris `titik_kandidat` (usulan halte baru), kriteria "Skor survei lapangan" = Form Kondisi Halte atas halte **eksisting** → **tidak berlaku (N/A)** di lokasi yang belum ada haltenya (bukan "bernilai 0"). `recompute_all_cai_scores(..., exclude_criteria=['survei'])` menulis `skor_cai.n_survei` & `bobot_survei` = NULL, lalu **merenormalisasi 3 bobot AHP sisanya** (kepadatan/jarak/volume → ≈ 0,3834 / 0,3834 / 0,2333, jumlah 1). Set bobot 4-kriteria di `konfigurasi_bobot` TETAP definisi kanonik CAI; renormalisasi ini turunan runtime khusus subset `titik_kandidat`. Karena `n_survei` lama seragam 0, efeknya rescale `skor_final` seragam (×1/0,8582 ≈ 1,165) — **ranking 19 kandidat tidak berubah** (`titik_kandidat` masih berisi 19 baris REAL pada saat keputusan ini dijalankan, sebelum KND-011 dihapus nanti hari yang sama — lihat Catatan 2026-09-12), hanya angka absolut + rincian panel. Alasan: memberi 0 membuat term berbobot 0,1418 jadi beban mati seragam yang menekan skor absolut semua kandidat. Detail di `docs/VALIDASI_BOBOT_AHP.md`; grid TDI / `skor_equity` tidak terpengaruh.

  **Catatan (2026-09-10, keputusan tim — deviasi metodologi yang DISENGAJA, sekelas swap `tanpa_kendaraan`→`usia_sekolah` 2026-09-06):** CAI tidak lagi hanya dihitung di 18 `titik_kandidat` lalu ditampilkan lewat *nearest-neighbour lookup*. Sejak 2026-09-10 CAI dihitung sebagai **permukaan grid 300 m** di `grid_analisis`, lewat migration `033_skor_cai_grid.sql` (angka pasti & nama field RPC: rujuk migration `033`, bukan dokumen ini). Alasan: memperluas survei lapangan sebelum submission 13 Sep tidak feasible; grid membuat CAI konsisten-spasial dengan TDI dan menghapus perilaku menyesatkan "skor titik survei terdekat ditampilkan seolah skor lokasi yang diklik" (ambang interim *nearest-point* 2000 m yang sempat dipakai lebih awal 2026-09-10 dicabut — klik di luar grid berpenduduk kini balas "di luar cakupan analisis", sama seperti TDI). **Bobot & AHP TIDAK berubah** (tetap `konfigurasi_bobot` `nama_index='CAI'`: 0,329 / 0,329 / 0,200 / 0,142; CR 0,0226) — yang berubah hanya unit spasial, plus dua kriteria lapangan (`volume`, `survei`) yang otomatis jadi **N/A** di sel tanpa data lapangan yang relevan, dengan bobotnya direnormalisasi ke kriteria tersisa (mekanisme `compute_cai(exclude_criteria=...)` yang sudah dipakai `titik_kandidat` sejak 2026-09-07). **Pendekatan estimasi volume berbasis regresi yang sempat didraft dibatalkan tim 2026-09-10 — Opsi B dipilih: tidak ada estimasi volume, tidak ada R², tidak ada flag.** Normalisasi min-max kini lintas seluruh sel grid berpenduduk. Isi per sel:
    - **Kepadatan penduduk:** nilai dasymetric per sel (sumber tak berubah). Selalu aktif.
    - **Jarak ke fasilitas umum (inverse):** `ST_Distance` centroid sel → POI fasilitas terdekat (OSM sekolah/faskes/kerja). Selalu aktif.
    - **Volume penumpang transit:** AKTIF **hanya di sel yang benar-benar dicacah lapangan** — sel yang memuat / ≤ 300 m dari titik Traffic Counting → pakai `total_aktivitas` terukur. Semua sel lain → **N/A**, bobotnya direnormalisasi ke kriteria tersisa. Tidak ada estimasi, tidak ada flag.
    - **Skor survei kondisi halte:** AKTIF hanya bila ada halte eksisting tersurvei (punya Form Kondisi Halte) ≤ 400 m; jika tidak → **N/A**, bobot direnormalisasi.

    **Empat pola bobot efektif per sel** (dry-run live 2026-09-10, 2.607 sel):

    | Kriteria aktif | Bobot efektif | Jumlah sel |
    |---|---|---|
    | kepadatan + jarak POI | **0,5000 / 0,5000** | 2.526 |
    | + survei halte ≤ 400 m | 0,4113 / 0,4113 / 0,1775 | 44 |
    | + volume terukur ≤ 300 m | 0,3834 / 0,3834 / 0,2331 | 37 |
    | keempat kriteria | 0,3290 / 0,3290 / 0,2002 / 0,1418 | 0 (saat ini) |

    **0,5/0,5 bukan angka karangan** — di AHP pairwise 2026-09-03, `kepadatan` & `jarak_inv` dinilai sama penting (0,3290 = 0,3290 di eigenvector); 0,5/0,5 adalah rasio AHP itu persis, hanya di-rescale karena 2 kriteria lain absen di sel tsb. Tidak ada penilaian pairwise yang diubah. `cai_skor` live: min / mean / max = **0,0000 / 0,3999 / 0,9544** (min 0 sah: sel kepadatan 0 & > 3.000 m dari fasilitas terdekat).

    **Pengungkapan jujur (WAJIB di panel klik peta, Export Report, narasi AI)** — sederhana, tanpa caveat statistik: "volume penumpang transit dipakai hanya di sel yang benar-benar dicacah lapangan (37 sel); di luar itu CAI berdiri di kepadatan penduduk + kedekatan fasilitas umum." Tidak ada klaim estimasi volume di mana pun.

    Grid CAI bersifat **aditif** — tabel `skor_cai` berbasis titik dan ranking 18 kandidat survei **tidak dihapus**: tetap rujukan kanonik CAI untuk ke-18 kandidat **tervalidasi lapangan** dan tetap basis normalisasi min-max `usulan_halte_model`. Prinsip inti tak berubah: **AI tetap hanya lapisan interpretasi**, dan **setiap skor sel tetap bisa ditelusuri** — RPC `get_cai_breakdown` mengembalikan rincian kontribusi tiap kriteria **aktif** + bobot efektifnya per sel, bukan angka tunggal.

  **Catatan (2026-09-12, koreksi dokumentasi — bukan bug, `qa-tester` + `data-ai-analyst`):** seluruh dokumen ini sempat menyebut "19 REAL" `titik_kandidat` di berbagai tempat (bullet CAI di atas, seksi "Usulan Halte Berbasis Model" di bawah, catatan 2026-09-07/2026-09-10). **Angka yang benar SEKARANG adalah 18**, diverifikasi langsung dari live DB (`select count(*) from titik_kandidat` → 18 baris, 0 `KND-DEMO-%`). Kronologi terverifikasi (Excel sumber `Instrumen_Survei_GeoTransitInsight_Final.xlsx` sheet "Form Traffic Counting", catatan baris 25 + migration `029_equity_refill_after_cai_recompute_20260907.sql` + `git log`):
    - **2026-08-29** (sebelum upload pertama): dari 15 titik traffic counting tambahan (`KND-010`..`KND-024`), 4 titik — **`KND-018`, `KND-019`, `KND-021`, `KND-024`** — dibuang di sumber (tidak pernah masuk `titik_kandidat`) karena kecamatannya **"Tambun Selatan"**, yaitu **Kabupaten Bekasi**, bukan Kota Bekasi (`batas_administrasi` cuma berisi 12 kecamatan resmi Kota Bekasi — dicek live, "Tambun Selatan" **tidak ada** di daftar itu). Hasil saat itu: **19 baris REAL aktif** (`KND-002`..`KND-017`, `KND-020`, `KND-022`, `KND-023`) — ini angka yang tertulis di seluruh dokumen sampai hari ini.
    - **2026-09-07** (commit `3a94ad4`, migration `029`): satu lagi titik — **`KND-011`** ("Gerbang Timur Grand Wisata Bekasi", kecamatan **Tambun Selatan**, kelurahan Lambangsari, -6.289326/107.034062) — ternyata **juga** di Kabupaten Bekasi, lolos dari pembersihan 2026-08-29 sebelumnya (kecamatannya sama-sama Tambun Selatan seperti KND-018/019/021/024 yang sudah dibuang, tapi baris ini sempat lolos karena diupload lebih dulu). Dihapus dengan alasan sama persis: "di luar Kota Bekasi". `skor_equity` diselaraskan ulang di migration yang sama. **19 → 18**, dan 18 inilah angka live sekarang.
    - Cek independen (bukan cuma percaya catatan Excel/migration): RPC `simulate_new_stop` dipanggil dengan koordinat KND-011 — hasil normal (bukan cabang "di luar cakupan"), karena guard itu berbasis jarak-ke-grid bukan `ST_Contains` batas administrasi (lihat `025_simulate_new_stop_out_of_area_guard.sql`) sehingga tidak bisa dipakai membuktikan ini sendirian; bukti definitif dipakai `batas_administrasi` yang hanya memuat 12 kecamatan Kota Bekasi dan tidak memuat "Tambun Selatan" sama sekali — kecamatan KND-011 & KND-018/019/021/024 secara administratif bukan bagian dataset yang di-dissolve jadi wilayah studi.
    - **Bukan bug perhitungan:** digrep seluruh `supabase/migrations/*.sql` dan `etl/*.py` untuk literal `19` — semua kemunculan ada di komentar/docstring/print, **tidak ada** `LIMIT 19`, assertion `== 19`, atau angka hardcoded yang dipakai logika normalisasi. Normalisasi min-max `skor_cai` dihitung dinamis dari jumlah baris `titik_kandidat` REAL yang live (agregat SQL/Python atas seluruh baris, bukan konstanta) — dicek live: tabel `skor_cai` sekarang 18 baris, 0 NULL di `skor_final`, rentang **0,1413–0,8963** (mean 0,4774), dan `n_kepadatan`/`n_jarak_inv` masing-masing mencapai penuh 0,0 dan 1,0 di suatu baris — bukti normalisasi 0–1 berjalan sehat atas 18 baris, bukan sisa referensi diam-diam ke baris ke-19 yang sudah tidak ada.
    - **Baris yang SENGAJA dibiarkan apa adanya (bukan typo):** paragraf catatan 2026-09-07 tentang renormalisasi bobot survei ("ranking 19 kandidat tidak berubah") di atas dan entri bertanggal senada di `docs/BUILD_CHECKLIST.md` — pada saat keputusan itu dijalankan (commit `0f891fc`, sebelum `3a94ad4` hari yang sama), `titik_kandidat` memang masih berisi 19 baris REAL; itu rekaman historis yang akurat untuk momen itu, bukan klaim tentang kondisi sekarang.
    - Semua tempat lain di dokumen ini dan di `docs/VALIDASI_BOBOT_AHP.md` yang menyatakan hitungan SAAT INI/berkelanjutan ("tetap kanonik untuk ke-19 kandidat", "basis normalisasi 19 titik", dst.) sudah dikoreksi jadi 18 di commit yang sama dengan catatan ini.

  **Catatan (2026-09-13, keputusan tim — Menu Go/Struk Go/Property Go DIDROP, bukan dibangun):** PRD menyebut Community Maps MAPID (Menu Go, Struk Go) sebagai sumber POI dan GEO MAPID Data Premium untuk Property Go (proksi laju pembangunan hunian/komersial). Dicek langsung di MAPID (modal Import Data → Data Premium, 16 etalase kategori) hari ini:
    - **Menu Go & Struk Go**: keduanya fitur *mission* (user menjalankan survei/scan struk di lapangan), bukan dataset yang bisa diimpor — tidak pernah ada data importable untuk ini. `MAKANAN DAN MINUMAN DI KOTA BEKASI TAHUN 2025` sempat ditemukan di etalase "Makanan dan Minuman" sebagai kandidat pengganti Menu Go (POI F&B riil, akan memperkaya kriteria "jarak ke fasilitas umum" yang sudah ada, bukan kriteria baru), tapi **diputuskan untuk tidak dilanjutkan** — sesi coaching hari ini eksplisit minta **kurangi fitur ~50%**, dan menambah sumber data untuk kriteria yang sudah berjalan baik dengan OSM bukan prioritas di jendela waktu tersisa. Struk Go (proksi volume transaksi harian) tidak ada padanan sama sekali di Data Premium — semua etalase yang dicek (Retail 19.980, Barang Konsumsi 511, Sosial 23.254) hanya berisi listing POI titik (nama usaha & lokasi), bukan data volume transaksi/footfall.
    - **Property Go**: dataset kandidat `PROPERTI DI KOTA BEKASI TAHUN 2025` (5.051 baris, kolom: `NAMA, TIPE_1-3, ALAMAT, HARGA (Rp), HARGA PER M2, LUAS TANAH, LUAS BANGUNAN, JUMLAH LANTAI`) dicek isinya (bukan cuma jumlah baris di etalase) — **tidak ada kolom tanggal/tahun sama sekali** (bukan cuma "satu tahun snapshot", betul-betul nol dimensi waktu), sehingga secara faktual tidak bisa dipakai untuk klaim "laju pembangunan" (rate) — itu perlu minimal 2 titik waktu yang bisa dibandingkan. Selain itu data ini tidak menyuplai kriteria berbobot manapun di CAI/TDI/Equity (PRD menempatkannya sebagai sinyal demand masa depan yang berdiri sendiri, bukan bagian dari WLC yang sudah dikunci AHP) — menambahkannya sebagai layer baru murni dekoratif, tidak menjawab pertanyaan lokasi prioritas transit yang jadi inti produk.
    - **Kesimpulan: ketiganya di-drop dari cakupan submission**, bukan "akan dikerjakan nanti". Ini konsisten dengan arahan reduce-scope, dan dengan prinsip proyek "jangan mengklaim yang tidak didukung data" — sama semangatnya dengan pembatalan estimasi regresi volume CAI 2026-09-10 dan penolakan mengisi 0 untuk kriteria survei N/A 2026-09-07. Tidak ada perubahan kode/skema akibat catatan ini (tidak pernah ada pipeline yang bergantung pada Menu Go/Struk Go/Property Go untuk dilepas).

  Bobot di atas sudah ada di tabel `konfigurasi_bobot` (`nama_index='CAI'`), di-set oleh migration `018_konfigurasi_bobot_ahp_final.sql` (menggantikan draft di `004_konfigurasi_bobot.sql` dan worksheet di `009_bobot_tdi_equity_mentor_review.sql`) — tabel itu **rujukan tunggal** untuk perhitungan skor, bukan angka di dokumen ini. **Metodologi bobot:** nilai ini diturunkan lewat **AHP pairwise-comparison Saaty formal, sesi 2026-09-03** — matriks pairwise dihitung, eigenvector diambil sebagai bobot, dan `consistency_ratio` tersimpan di `konfigurasi_bobot`: **CAI CR = 0,0226 · TDI_MOBILITAS CR = 0,0000 · EQUITY CR = 0,0457** (ketiganya < 0,1, memenuhi ambang Saaty). Ini **menggantikan** langkah interim sebelumnya, yaitu review informal worksheet bobot oleh mentor (27 Agustus 2026, cek distribusi hasil & kesesuaian objektif analisis) — review itu sekarang berstatus tahap awal, bukan dasar bobot yang berlaku. Matriks pairwise diarsipkan di `docs/VALIDASI_BOBOT_AHP.md`. Di narasi AI dan laporan, sebut **"bobot hasil AHP pairwise formal (CR < 0,1)"**. Dasar literatur/standar tiap pilihan metodologis (ambang 400/800 m, WLC/MCDA, konsep transit desert, dasymetric, dll.) didokumentasikan di `docs/REFERENSI_METODOLOGI.md`.
- **Transit Desert Index (TDI)** — per grid **300 m** (dasymetric mapping; PRD final Bab 3.1/7.1 — sudah sama persis dengan implementasi `etl/build_fishnet_grid.py` `DEFAULT_CELL_SIZE_M = 300`, meski beberapa komentar lama di kode & CLAUDE.md draft sebelumnya masih menyebut rentang "250–500m", itu usang). Formula (PRD final Bab 7.2): `TDI = (Kepadatan Penduduk × Indeks Kebutuhan Mobilitas) ÷ Skor Aksesibilitas Transit`. Indeks Kebutuhan Mobilitas didekati dari 3 proksi: proporsi usia rentan (lansia 65+ + balita 0–4), kepadatan POI kebutuhan harian, dan **proporsi penduduk usia sekolah 5–19 (SD–SMA) — proksi populasi di bawah usia mengemudi yang transit-dependent** (menggantikan "rasio rumah tangga tanpa kendaraan pribadi" per keputusan tim 2026-09-06, migration `026_tdi_mobilitas_usia_sekolah.sql`: rasio tanpa-kendaraan tidak tersedia pada resolusi spasial — Susenas hanya angka kota — sehingga selama ini fallback netral 0,5 seragam di semua grid). Bobot 3 komponen ada di `konfigurasi_bobot` (`nama_index='TDI_MOBILITAS'`): `usia_rentan` 0,2000 · `poi_harian` 0,4000 · `usia_sekolah` 0,4000 (matriks pairwise Saaty 3×3 tetap CR = 0,0000; `usia_sekolah` mengambil alih slot bobot `tanpa_kendaraan` apa adanya).

  **Catatan (2026-09-11, perbaikan metodologi, diminta Sam): `skor_aksesibilitas_transit` (penyebut TDI) sekarang diukur terhadap halte GABUNGAN, bukan hanya 15 `halte_eksisting` REAL tersurvei.** Sebelumnya `skor_aksesibilitas_transit` hanya menghitung jarak ke 15 halte yang sempat disurvei tim (HLT-001..015) — padahal jaringan fisik BisKita Trans Patriot riil punya **32 halte** menurut OSM (`network="Trans Bekasi Patriot"`, dimaterialisasi di `frontend/src/data/biskita_halte_osm.geojson` oleh `etl/build_rute_biskita_osm.py`). ~18 halte yang **secara fisik nyata tapi belum sempat disurvei** jadi "tak terlihat" oleh formula lama, sehingga sel di sekitarnya digembungkan artifisial jadi seolah tanpa transit sama sekali. `etl/compute_tdi_full.py` sekarang punya `load_halte_gabungan()` = 15 halte survei + 32 titik OSM = **47 titik**, dipakai untuk nearest-distance decay 400/800 m yang sama (tidak ada dedup — untuk jarak-terdekat, titik duplikat/dekat tidak berbahaya). **Scope ketat: hanya `skor_aksesibilitas_transit`/`skor_tdi` yang berubah.** Kriteria "skor survei kondisi halte" pada `skor_cai` **TIDAK disentuh** — itu terikat pada ketersediaan Form Kondisi Halte (cakupan survei kondisi fisik ≤ 400 m), konsep berbeda dari keberadaan fisik halte (lihat catatan CAI 2026-09-10 di atas).

  **Angka before/after (recompute penuh 2.607 sel, `python etl/compute_tdi_full.py --upload`, 2026-09-11):**
  - `skor_tdi`: LAMA min 0,0000 / median 0,6658 / mean 0,4971 / max 1,0000 → BARU min 0,0000 / median 0,6488 / mean 0,4881 / max 1,0000.
  - Transit desert (`skor_tdi > 0,6`): **1.503 → 1.448 sel** (turun 55 sel, konsisten dengan area sekitar halte-real-belum-tersurvei yang sekarang benar dianggap terlayani).
  - Korelasi Spearman ranking LAMA vs BARU: **rho = 0,9767** — refinement, bukan pengacakan ranking. 82 sel berubah > 0,05; 73 sel berubah > 0,10; delta terbesar 0,3623.
  - 0 nilai NULL, 0 nilai di luar rentang [0,1] setelah recompute.
  - Face-validity: dari 2.099 sel yang halte terdekat gabungannya adalah titik OSM (dulu tak terlihat formula lama), **0% memburuk** (di luar toleransi pembulatan 1e-4) dan sejumlah sel dekat menunjukkan penurunan skor_tdi besar (mis. sel dekat halte "Samedja" 0,9803→0,6180; dekat "Stadion" 0,9353→0,5730; dekat "Jl. Tirta Utama Vida" 0,8732→0,5110) — arah perubahan sesuai ekspektasi (lebih dekat transit riil = TDI turun), tidak ada regresi.
  - **Tidak berubah:** bobot AHP TDI_MOBILITAS (`usia_rentan` 0,2000 · `poi_harian` 0,4000 · `usia_sekolah` 0,4000, CR 0,0000), definisi 3 proksi Indeks Kebutuhan Mobilitas, ambang decay 400/800 m, resolusi grid 300 m, dan CAI/Equity (Equity pakai `skor_cai_rata2`, bukan `skor_tdi` — diverifikasi ulang di `etl/compute_scores.py compute_equity_index()`, tidak ada referensi `skor_tdi` di situ).

  **Dependen yang ikut diperbarui:** `usulan_halte_model` (migration `028`, kolam kandidat `skor_tdi > 0,6` + filter jarak 400 m dari halte eksisting — keduanya sekarang memakai `load_halte_gabungan()` yang sama, lewat `etl/generate_usulan_halte_model.py load_halte_real()` yang didelegasikan ke `compute_tdi_full.load_halte_gabungan()`) — diregenerasi penuh (`--upload`, 25 usulan, sanity check LOLOS). **Tidak perlu diregenerasi/dihitung ulang:** dashboard "jumlah transit desert" dan RPC `potensi_penerima_manfaat` (migration `022`) — keduanya **live query** langsung ke `grid_analisis`/`titik_kandidat`, otomatis merefleksikan `skor_tdi` baru tanpa aksi tambahan (diverifikasi: RPC live sekarang melaporkan `n_sel_transit_desert_total: 1448`, cocok dengan angka BARU di atas).
- **Transit Equity Index** — CAI + dimensi kerentanan sosial (usia rentan, akses pendidikan/kesehatan/kerja) per kelurahan. Ranking ketimpangan, bukan ranking prioritas lokasi.
  **PENTING (arah skala, jangan sampai terbalik):** kolom `skor_final` pada tabel `skor_equity`
  adalah skor KETIMPANGAN (equity gap), BUKAN skor "seberapa equitable" dalam arti tinggi=bagus.
  Semakin TINGGI `skor_final`, semakin DIRUGIKAN/TERTINGGAL kelurahan tsb secara akses transit
  (CAI di-inverse dulu sebelum masuk formula — lihat `etl/compute_scores.py`
  `compute_equity_index()`). **Ranking 1 = `skor_final` tertinggi = kelurahan paling butuh
  intervensi** (bukan kelurahan paling equitable/paling baik kondisinya). Konsisten dengan
  `EquityIndexView.jsx` (frontend) yang sudah menampilkan penjelasan "skor lebih tinggi = lebih
  dirugikan" di UI — pertahankan konvensi ini di narasi AI, dokumen, dan kode baru mana pun yang
  menyebut istilah ini.
- **Usulan Halte Berbasis Model (`usulan_halte_model`, sejak 2026-09-07)** — daftar-pendek lokasi halte baru yang **diturunkan dari model spasial**, menjawab pertanyaan PRD Bab 1.1 ("di titik mana pengembangan transit memberi dampak aksesibilitas terbesar") dengan lokasi yang **ditemukan model**, bukan lokasi yang kebetulan disurvei. Pipeline (script `etl/generate_usulan_halte_model.py`, tabel dari `supabase/migrations/028_usulan_halte_model.sql`): sel `grid_analisis` dengan `skor_tdi` > **0,6** (ambang transit desert yang sama dengan `TRANSIT_DESERT_THRESHOLD` di frontend & migration `022`) → centroid ≥ **400 m** dari `halte_eksisting` REAL (catchment ITDP dari `003_simulate_new_stop.sql`, `DUMMY-HLT-*` dikecualikan) → de-klaster greedy jarak minimum **800 m** antar-usulan (`AMBANG_NIHIL_M`) → maks **100 titik** (lihat Catatan 2026-09-12 di bawah — semula 25) → dampak dari RPC `simulate_new_stop` (`penduduk_terlayani_400m/800m`) → ranking primer populasi terlayani, sekunder `skor_tdi_sel`. Semua ambang dipinjam dari yang sudah berlaku di repo; tidak ada konstanta atau formula skor baru.

  **Catatan (2026-09-12, keputusan Sam — kuota daftar-pendek dinaikkan 25 → 100):** 1.448 sel transit desert (pasca perbaikan TDI 2026-09-11) membentuk satu wilayah mega-kontinu ±288 km² (lebih besar dari luas Kota Bekasi 210,49 km²), sehingga 25 titik yang saling berjarak ≥800 m hanya bisa mencakup sebagian kecil area itu. Cakupan sel transit desert dalam radius 1 km/2 km dari usulan terdekat pada beberapa kuota (dry-run terukur): kuota 25 → 27,3%/46,5%; 50 → 55,3%/85,5%; **100 → 87,3%/97,7%**; 150 → 97,4%/100,0%. Sam memilih **100** (bukan 150). `MAKS_USULAN_DEFAULT` di `etl/generate_usulan_halte_model.py` dinaikkan ke 100 dan tabel di-regenerate penuh (0 → 100 baris, `ranking` 1–100, MDL-001..MDL-100). Algoritma/urutan langkah **tidak berubah**, hanya kuota akhir. Regenerasi 2026-09-12: `skor_tdi_sel` 0,8332–1,0000, `penduduk_terlayani_800m` min 3.259 / median 28.564 / maks 61.728, sebaran 12 kecamatan (termasuk Bekasi Utara & Medansatria, yang tidak muncul pada kuota 25). Kolam 100 baris ini sekarang jadi basis UI berjenjang di frontend (Level 1 = top 25, Level 2 = top 50, Level 3 = top 100, plus slider kontinu 0–100 berbasis kolom `ranking` — dibangun `webgis-developer`, bukan tiga run generator terpisah). `Dashboard.jsx` (kartu ringkasan, ambil `rows[0]` + `rows.length` dari query terurut `ranking`) dan `DataLaporan.jsx` (Export Report, `.limit(5)` terurut `ranking`) sudah top-N berbasis ranking sejak sebelum perubahan ini — tidak ada hardcode jumlah baris, tidak perlu diubah. Tidak ada RPC yang mengagregasi seluruh `usulan_halte_model` (`potensi_penerima_manfaat` migration `022` membaca dari `titik_kandidat`, bukan tabel ini) — pertumbuhan 4× jumlah baris tidak memengaruhi RPC manapun.
  **PEMBEDAAN YANG WAJIB DIJAGA di kode, UI, dokumen, dan narasi AI:**
  `titik_kandidat` = kandidat **tervalidasi lapangan** (31 titik Survey Activities, 18 REAL dipakai CAI — lihat Catatan 2026-09-12 di bagian CAI soal koreksi dari "19" ke "18") · `usulan_halte_model` = **usulan model spasial, BELUM disurvei lapangan**. Jangan digabung dalam satu daftar tanpa label.
  **Sengaja TIDAK punya skor CAI**: kriteria volume CAI diisi dari traffic counting lapangan (`total_aktivitas`) yang titik model tidak punya — mengarangnya melanggar prinsip "model/AI tidak pernah menciptakan angka". Ranking pakai proyeksi penduduk terlayani, metrik yang jujur & dapat ditelusuri.
  **Sengaja TIDAK di-insert ke `titik_kandidat`**: 18 baris di sana jadi basis normalisasi min-max CAI; menambah baris akan merescale skor CAI semua kandidat survei diam-diam.
- Simulasi What-If pakai estimasi jalan kaki (kecepatan 4–5 km/jam), BUKAN network routing riil (eksplisit out-of-scope).
- **Narasi AI Spatial Consultant mengikuti kerangka CCIA** — Condition → Cause → Impact → Action (PRD final Bab 7.5), dipetakan ke fitur: Condition = Peta Multi-Layer Gap Analysis & Dashboard Indikator; Cause = CAI/TDI beserta rincian kriteria; Impact = Simulasi What-If (proyeksi before-after); Action = Transit Equity Index Dashboard (ranking + rekomendasi). Rekomendasi tahap Action harus **SMART Spasial** (Specific, Measurable, Achievable, Relevant, Time-bound) — bukan observasi umum ("prioritaskan Kecamatan X"), tapi konkret ("bangun 1 halte baru radius 500m dari [lokasi], berpotensi melayani tambahan N jiwa" — N dari hasil simulasi What-If riil, bukan angka karangan AI). Cek `supabase/functions/ai-insight/index.ts` sudah mengikuti struktur ini.
- **Angka profil Kota Bekasi (kanonik, diseragamkan tim 2026-08-28).** Sumber kebenaran: `etl/data/demografi/profil_kota_kanonik.json`, dari **DKB (Data Konsolidasi Bersih) Semester I 2026 — Ditjen Dukcapil Kemendagri** (bukan "Dinas Dukcapil Kota Bekasi"; PRD final Bab 1.1 menyebutnya instansi pusat, bukan dinas kota): **2.607.248 jiwa / 12.387 jiwa/km² / 210,49 km²** (luas BPS Kota Bekasi Dalam Angka) / **usia produktif 15–64 th 70,98%** (= 1.850.727 jiwa). Populasi kanonik = Σ `penduduk.jumlah_penduduk` di database. JANGAN reintroduksi angka lama `2.595.927`, `12.333`, `70,99`, atau sumber "DKB Semester II 2025" di kode, dokumen, maupun narasi AI.

## Fitur & Acceptance Criteria (sumber: PRD Bab 8 — pakai ini sebagai definition of done)

| Fitur | Acceptance Criteria |
|---|---|
| Peta Multi-Layer Gap Analysis | Layer kepadatan penduduk, jaringan transit eksisting, indeks gap aksesibilitas. Filter per kecamatan render ulang **< 2 detik**. |
| Composite Accessibility Index & TDI | Klik lokasi di peta → tampilkan skor + **rincian kontribusi tiap kriteria** (bukan angka tunggal tanpa penjelasan). Sejak 2026-09-10 CAI dibaca dari **sel grid 300 m** (`grid_analisis`) via RPC `get_cai_breakdown` (migration `033`) — rincian per kriteria **aktif** + bobot efektif per sel tetap dikembalikan (kriteria Bab 8 tetap terpenuhi); klik di luar grid berpenduduk balas "di luar cakupan analisis". Volume transit hanya aktif di ~37 sel yang dicacah lapangan; di sel lain panel menyatakan apa adanya bahwa CAI berdiri di kepadatan + kedekatan fasilitas (tanpa estimasi volume). |
| AI Spatial Consultant | Respons pertanyaan bahasa natural **< 5 detik**, pakai ringkasan data hasil model spasial — bukan raw coordinates dikirim ke LLM. |
| Simulasi "What-If" | Klik titik di peta → proyeksi penduduk tambahan terlayani + estimasi waktu tempuh jalan kaki, **< 3 detik**. |
| Transit Equity Index Dashboard | Ranking minimal **5 kelurahan** dengan skor ketimpangan **tertinggi** (= kondisi akses transit paling timpang/tertinggal, ranking 1 = paling butuh intervensi — PRD final Bab 8.2 sudah menyatakan ini eksplisit dengan arah skala yang sama, konsisten dengan `skor_final` TERTINGGI pada tabel `skor_equity`; lihat catatan arah skala di bagian Struktur Data di atas) + kelompok terdampak + 1 rekomendasi intervensi per kelurahan. |
| Dashboard Indikator | Coverage ratio, jumlah transit desert teridentifikasi, potensi penerima manfaat — dari data yang sudah divalidasi. |
| Export Report | Unduh ringkasan (peta + indikator kunci) sebagai PDF atau gambar. |

## In-Scope vs Out-of-Scope (Bab 3 — supaya tidak over-engineer)

**Jangan bangun (eksplisit out-of-scope):**
- Network routing riil / jadwal transit / lalu lintas real-time — pakai estimasi jalan kaki saja
- Survei okupansi skala kota penuh — pakai sampel jam puncak
- Prediksi operasional KRL/BRT real-time
- Aplikasi mobile native
- Integrasi ticketing/pembayaran
- Sistem manajemen user multi-role enterprise
- Integrasi data real-time dari sensor, CCTV, atau sistem pihak ketiga di luar MAPID API

## Referensi Visual

Wireframe/mockup dashboard resmi ada di lampiran PRD (**Gambar 6**, Bab 10.2 — PRD final menomori ulang gambar; draft lama sempat menyebutnya Gambar 3, itu usang) — sidebar nav: Dashboard, Peta Interaktif, Analisis Spasial, AI Spatial Consultant, Simulasi Skenario, Rekomendasi, Data & Laporan, Pengaturan. Dashboard utama berisi: ringkasan Kota Bekasi (populasi, kepadatan, luas, usia produktif, indeks aksesibilitas rata-rata), kartu Transit Desert count, kartu Usulan Halte Prioritas, kartu Potensi Penerima Manfaat, Top 3 Rekomendasi AI (skor dampak, potensi manfaat, estimasi biaya), dan panel Simulasi Skenario dengan dropdown pilihan skenario.

**Catatan aksesibilitas warna (PRD final Bab 10.3, temuan Coaching Clinic 4):** skema merah–oranye–hijau di mockup untuk indeks aksesibilitas berisiko tidak terbaca bagi pengguna color vision deficiency (~8% populasi pria). Ganti ke palet sequential colorblind-safe (mis. Viridis/ColorBrewer) + tambahkan pembeda non-warna (label angka/pola) di legenda — jangan bergantung penuh pada warna.

## Jalur Kritis (lihat docs/BUILD_CHECKLIST.md untuk urutan tugas)

PRD final sudah dikumpulkan **30 Agustus 2026** (deadline resmi, terpisah dari submission WebGIS). Sisa jalur kritis (PRD final Bab 11.2):

```
31 Agu-6 Sep  Data processing & analisis spasial (TDI & Equity Index dihitung
              dari 31 titik Survey Activities final + 3 submission Struk Go.
              CAI sejak 2026-09-10 = permukaan grid 300 m; hanya kriteria
              volume (37 sel) & survei (44 sel) yang diturunkan dari 31 titik
              survei, kepadatan & jarak fasilitas dihitung se-grid)
7-12 Sep      Development inti + integrasi AI + Biweekly Mentoring 2
              (deadline dev 12 Sep)  ← PALING BERISIKO
13 Sep        Submission WebGIS (video recording, code, link) — TERPISAH dari
              submission PRD yang sudah lewat
14-18 Sep     Penjurian Grand Final Selection, pengumuman Top 10 (18 Sep)
20-24 Sep     Kondisional kalau lolos Top 10 (Coaching Clinic 6, Final Rehearsal,
              MAPID Catalyst Day 1-2)
```

**Total data survei final (PRD final Bab 6.1 — koreksi dari draft lama yang sempat menyebut "70 titik"): 31 titik Survey Activities + 3 submission Struk Go.** Data ini diposisikan sebagai ground truth/validasi lapangan, BUKAN sampel statistik yang merepresentasikan seluruh Kota Bekasi — jangan generalisasi di narasi AI atau laporan.

⚠️ **Konflik tanggal Field Day di dalam PRD final sendiri, belum diselaraskan tim — jangan asal pilih salah satu tanpa konfirmasi ke tim:** tabel Jadwal Pelaksanaan (Bab 6.5) mencantumkan Field Day 1/2/3 sama-sama tanggal "17 Agustus 2026", sementara Timeline Internal Tim MBG (Bab 11.2) memisahkannya jadi Field Day 1 = 17 Agu, Field Day 2 = 22–23 Agu, Field Day 3 = 29 Agu. Total 31 titik yang dilaporkan tidak berubah oleh perbedaan ini, hanya kronologinya yang ambigu.

**Strategi wajib:** bangun seluruh fitur dengan data sintetis/dummy. Setiap komponen yang butuh data (peta, dashboard, AI panel) harus punya fallback ke data contoh kalau tabel Supabase masih kosong — supaya swap ke data asli tinggal ganti sumber, bukan bangun dari nol di jendela development yang sempit (7–12 Sep).

## Subagents — pembagian kerja 5 peran PRD lewat Claude Code

Proyek ini dikerjakan solo (Sam), tapi PRD mendefinisikan 5 peran. Untuk menjaga struktur dan mempercepat kerja, 5 peran itu dipetakan jadi subagent di `.claude/agents/`. **Delegasikan secara eksplisit berdasarkan jenis tugas:**

- Tugas peta/komponen React/wiring Supabase di frontend → gunakan agent `webgis-developer`
- Tugas formula CAI/TDI/Equity Index, migration SQL, ETL Python, Edge Function AI → gunakan agent `data-ai-analyst`
- Tugas styling/tampilan/kesesuaian dengan mockup resmi → gunakan agent `ui-ux-designer`
- Tugas cek acceptance criteria, sinkronisasi PRD/dokumen, narasi non-teknis → gunakan agent `product-analyst`
- Tugas orientasi awal sesi, cek jalur kritis timeline, audit kebersihan repo → gunakan agent `project-lead`
- Tugas menjalankan/mengukur langsung (build, performa, kebenaran angka, regresi) → gunakan agent `qa-tester`

`qa-tester` beda dengan `product-analyst`: yang satu menilai konsep dari membaca kode/dokumen, yang satu mengeksekusi dan mengukur angka sungguhan. Jalankan `qa-tester` setelah `webgis-developer` atau `data-ai-analyst` melapor selesai — jangan anggap "selesai" sebelum diverifikasi empiris, terutama untuk tiga acceptance criteria berbasis waktu (< 2 detik, < 3 detik, < 5 detik).

Subagent tidak bisa memanggil subagent lain (tidak ada nesting), jadi orkestrasi tetap dari sesi utama — panggil satu per satu atau paralel sesuai kebutuhan, lalu sintesis hasilnya di sesi utama.

**Aturan tetap (Sam, 2026-09-10): tab "Data & Laporan" (`frontend/src/components/DataLaporan/DataLaporan.jsx`, Export Report PDF/PNG) WAJIB ikut diperbarui `webgis-developer` setiap kali ada data/tabel/skor/kartu Dashboard baru** — jangan ditinggal untuk nanti. Laporan sempat tertinggal (belum ada CAI grid / Usulan Halte Prioritas / Potensi Penerima Manfaat sampai 2026-09-10). Tetap "ringkasan satu halaman" (peta + indikator kunci + ranking), bukan dump data; angka baca langsung dari Supabase, jangan hitung ulang CAI/TDI/Equity di sana.



- `README.md` dan `.gitignore` sempat punya conflict marker git yang ter-commit — cek sudah bersih atau belum
- RLS (Row Level Security) di Supabase — pastikan aktif di semua tabel, publik hanya boleh baca
- `.env` — pastikan tidak ada `ANTHROPIC_API_KEY` dengan prefix `VITE_` (akan ter-bundel ke frontend publik); gunakan `ANTHROPIC_API_KEY` sebagai Supabase secret, bukan `.env` frontend
