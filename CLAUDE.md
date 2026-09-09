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
| GIS Platform | GEO MAPID (pengolahan data & analisis lokasi), Community Maps MAPID (sumber POI: Menu Go, Struk Go) |
| AI | Claude API (Messages API), model `claude-haiku-4-5-20251001`, dipanggil via Supabase Edge Function — API key di server (`ANTHROPIC_API_KEY`, bukan `VITE_...`) |
| Hosting | Vercel Pro (frontend) + Supabase Pro (backend/db) — hybrid, domain publik lewat subdomain resmi WebGIS MAPID (CNAME ke Vercel) |
| Repo | GitHub, privat selama pengembangan |

## Struktur Data / Metodologi (jangan diubah tanpa alasan kuat)

- **Composite Accessibility Index (CAI)** — Weighted Linear Combination dari 4 kriteria, tiap kriteria dinormalisasi 0–1 sebelum dikalikan bobot (supaya kontribusi per kriteria bisa ditelusuri per lokasi saat diklik — PRD final Bab 7.3):

  | Kriteria | Arah | Bobot | Sumber data |
  |---|---|---|---|
  | Kepadatan penduduk | makin tinggi → prioritas naik | 0,329 | DKB Semester I 2026, grid 300 m (dasymetric) |
  | Jarak ke fasilitas umum (inverse) | makin dekat → skor naik | 0,329 | POI OSM/Menu Go, `ST_Distance` |
  | Volume penumpang transit terdekat | makin tinggi → skor naik | 0,200 | Data penumpang KRL (KAI Commuter)/BisKita per radius |
  | Skor survei lapangan (kondisi fisik & akses simpul) | — | 0,142 | 31 titik Survey Activities + instrumen survei (0–1) |

  Bobot CAI di atas = hasil **sesi AHP pairwise (Saaty) formal 2026-09-03** (nilai persis di DB: 0,3290 / 0,3290 / 0,2002 / 0,1418). **Bobot TDI_MOBILITAS dan EQUITY juga berubah pada sesi yang sama** — nilai finalnya ada di `supabase/migrations/018_konfigurasi_bobot_ahp_final.sql` (13 baris, lihat juga tabel di `009` untuk pemetaan huruf kriteria → `nama_kriteria`). **Catatan (2026-09-06):** baris `('TDI_MOBILITAS','tanpa_kendaraan',0,4000)` dari sesi 018 sudah digantikan `('TDI_MOBILITAS','usia_sekolah',0,4000)` oleh `026_tdi_mobilitas_usia_sekolah.sql` (bobot & CR tidak berubah, hanya komponennya) — lihat bagian Transit Desert Index di bawah + `docs/VALIDASI_BOBOT_AHP.md`.

  **Catatan (2026-09-07, keputusan tim — deviasi metodologi yang DISENGAJA):** untuk baris `titik_kandidat` (usulan halte baru), kriteria "Skor survei lapangan" = Form Kondisi Halte atas halte **eksisting** → **tidak berlaku (N/A)** di lokasi yang belum ada haltenya (bukan "bernilai 0"). `recompute_all_cai_scores(..., exclude_criteria=['survei'])` menulis `skor_cai.n_survei` & `bobot_survei` = NULL, lalu **merenormalisasi 3 bobot AHP sisanya** (kepadatan/jarak/volume → ≈ 0,3834 / 0,3834 / 0,2333, jumlah 1). Set bobot 4-kriteria di `konfigurasi_bobot` TETAP definisi kanonik CAI; renormalisasi ini turunan runtime khusus subset `titik_kandidat`. Karena `n_survei` lama seragam 0, efeknya rescale `skor_final` seragam (×1/0,8582 ≈ 1,165) — **ranking 19 kandidat tidak berubah**, hanya angka absolut + rincian panel. Alasan: memberi 0 membuat term berbobot 0,1418 jadi beban mati seragam yang menekan skor absolut semua kandidat. Detail di `docs/VALIDASI_BOBOT_AHP.md`; grid TDI / `skor_equity` tidak terpengaruh.

  Bobot di atas sudah ada di tabel `konfigurasi_bobot` (`nama_index='CAI'`), di-set oleh migration `018_konfigurasi_bobot_ahp_final.sql` (menggantikan draft di `004_konfigurasi_bobot.sql` dan worksheet di `009_bobot_tdi_equity_mentor_review.sql`) — tabel itu **rujukan tunggal** untuk perhitungan skor, bukan angka di dokumen ini. **Metodologi bobot:** nilai ini diturunkan lewat **AHP pairwise-comparison Saaty formal, sesi 2026-09-03** — matriks pairwise dihitung, eigenvector diambil sebagai bobot, dan `consistency_ratio` tersimpan di `konfigurasi_bobot`: **CAI CR = 0,0226 · TDI_MOBILITAS CR = 0,0000 · EQUITY CR = 0,0457** (ketiganya < 0,1, memenuhi ambang Saaty). Ini **menggantikan** langkah interim sebelumnya, yaitu review informal worksheet bobot oleh mentor (27 Agustus 2026, cek distribusi hasil & kesesuaian objektif analisis) — review itu sekarang berstatus tahap awal, bukan dasar bobot yang berlaku. Matriks pairwise diarsipkan di `docs/VALIDASI_BOBOT_AHP.md`. Di narasi AI dan laporan, sebut **"bobot hasil AHP pairwise formal (CR < 0,1)"**. Dasar literatur/standar tiap pilihan metodologis (ambang 400/800 m, WLC/MCDA, konsep transit desert, dasymetric, dll.) didokumentasikan di `docs/REFERENSI_METODOLOGI.md`.
- **Transit Desert Index (TDI)** — per grid **300 m** (dasymetric mapping; PRD final Bab 3.1/7.1 — sudah sama persis dengan implementasi `etl/build_fishnet_grid.py` `DEFAULT_CELL_SIZE_M = 300`, meski beberapa komentar lama di kode & CLAUDE.md draft sebelumnya masih menyebut rentang "250–500m", itu usang). Formula (PRD final Bab 7.2): `TDI = (Kepadatan Penduduk × Indeks Kebutuhan Mobilitas) ÷ Skor Aksesibilitas Transit`. Indeks Kebutuhan Mobilitas didekati dari 3 proksi: proporsi usia rentan (lansia 65+ + balita 0–4), kepadatan POI kebutuhan harian, dan **proporsi penduduk usia sekolah 5–19 (SD–SMA) — proksi populasi di bawah usia mengemudi yang transit-dependent** (menggantikan "rasio rumah tangga tanpa kendaraan pribadi" per keputusan tim 2026-09-06, migration `026_tdi_mobilitas_usia_sekolah.sql`: rasio tanpa-kendaraan tidak tersedia pada resolusi spasial — Susenas hanya angka kota — sehingga selama ini fallback netral 0,5 seragam di semua grid). Bobot 3 komponen ada di `konfigurasi_bobot` (`nama_index='TDI_MOBILITAS'`): `usia_rentan` 0,2000 · `poi_harian` 0,4000 · `usia_sekolah` 0,4000 (matriks pairwise Saaty 3×3 tetap CR = 0,0000; `usia_sekolah` mengambil alih slot bobot `tanpa_kendaraan` apa adanya).
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
- **Usulan Halte Berbasis Model (`usulan_halte_model`, sejak 2026-09-07)** — daftar-pendek lokasi halte baru yang **diturunkan dari model spasial**, menjawab pertanyaan PRD Bab 1.1 ("di titik mana pengembangan transit memberi dampak aksesibilitas terbesar") dengan lokasi yang **ditemukan model**, bukan lokasi yang kebetulan disurvei. Pipeline (script `etl/generate_usulan_halte_model.py`, tabel dari `supabase/migrations/028_usulan_halte_model.sql`): sel `grid_analisis` dengan `skor_tdi` > **0,6** (ambang transit desert yang sama dengan `TRANSIT_DESERT_THRESHOLD` di frontend & migration `022`) → centroid ≥ **400 m** dari `halte_eksisting` REAL (catchment ITDP dari `003_simulate_new_stop.sql`, `DUMMY-HLT-*` dikecualikan) → de-klaster greedy jarak minimum **800 m** antar-usulan (`AMBANG_NIHIL_M`) → maks 25 titik → dampak dari RPC `simulate_new_stop` (`penduduk_terlayani_400m/800m`) → ranking primer populasi terlayani, sekunder `skor_tdi_sel`. Semua ambang dipinjam dari yang sudah berlaku di repo; tidak ada konstanta atau formula skor baru.
  **PEMBEDAAN YANG WAJIB DIJAGA di kode, UI, dokumen, dan narasi AI:**
  `titik_kandidat` = kandidat **tervalidasi lapangan** (31 titik Survey Activities, 19 REAL dipakai CAI) · `usulan_halte_model` = **usulan model spasial, BELUM disurvei lapangan**. Jangan digabung dalam satu daftar tanpa label.
  **Sengaja TIDAK punya skor CAI**: kriteria volume CAI diisi dari traffic counting lapangan (`total_aktivitas`) yang titik model tidak punya — mengarangnya melanggar prinsip "model/AI tidak pernah menciptakan angka". Ranking pakai proyeksi penduduk terlayani, metrik yang jujur & dapat ditelusuri.
  **Sengaja TIDAK di-insert ke `titik_kandidat`**: 19 baris di sana jadi basis normalisasi min-max CAI; menambah baris akan merescale skor CAI semua kandidat survei diam-diam.
- Simulasi What-If pakai estimasi jalan kaki (kecepatan 4–5 km/jam), BUKAN network routing riil (eksplisit out-of-scope).
- **Narasi AI Spatial Consultant mengikuti kerangka CCIA** — Condition → Cause → Impact → Action (PRD final Bab 7.5), dipetakan ke fitur: Condition = Peta Multi-Layer Gap Analysis & Dashboard Indikator; Cause = CAI/TDI beserta rincian kriteria; Impact = Simulasi What-If (proyeksi before-after); Action = Transit Equity Index Dashboard (ranking + rekomendasi). Rekomendasi tahap Action harus **SMART Spasial** (Specific, Measurable, Achievable, Relevant, Time-bound) — bukan observasi umum ("prioritaskan Kecamatan X"), tapi konkret ("bangun 1 halte baru radius 500m dari [lokasi], berpotensi melayani tambahan N jiwa" — N dari hasil simulasi What-If riil, bukan angka karangan AI). Cek `supabase/functions/ai-insight/index.ts` sudah mengikuti struktur ini.
- **Angka profil Kota Bekasi (kanonik, diseragamkan tim 2026-08-28).** Sumber kebenaran: `etl/data/demografi/profil_kota_kanonik.json`, dari **DKB (Data Konsolidasi Bersih) Semester I 2026 — Ditjen Dukcapil Kemendagri** (bukan "Dinas Dukcapil Kota Bekasi"; PRD final Bab 1.1 menyebutnya instansi pusat, bukan dinas kota): **2.607.248 jiwa / 12.387 jiwa/km² / 210,49 km²** (luas BPS Kota Bekasi Dalam Angka) / **usia produktif 15–64 th 70,98%** (= 1.850.727 jiwa). Populasi kanonik = Σ `penduduk.jumlah_penduduk` di database. JANGAN reintroduksi angka lama `2.595.927`, `12.333`, `70,99`, atau sumber "DKB Semester II 2025" di kode, dokumen, maupun narasi AI.

## Fitur & Acceptance Criteria (sumber: PRD Bab 8 — pakai ini sebagai definition of done)

| Fitur | Acceptance Criteria |
|---|---|
| Peta Multi-Layer Gap Analysis | Layer kepadatan penduduk, jaringan transit eksisting, indeks gap aksesibilitas. Filter per kecamatan render ulang **< 2 detik**. |
| Composite Accessibility Index & TDI | Klik lokasi di peta → tampilkan skor + **rincian kontribusi tiap kriteria** (bukan angka tunggal tanpa penjelasan). |
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
31 Agu-6 Sep  Data processing & analisis spasial (CAI, TDI, Equity Index dihitung
              dari 31 titik Survey Activities final + 3 submission Struk Go)
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



- `README.md` dan `.gitignore` sempat punya conflict marker git yang ter-commit — cek sudah bersih atau belum
- RLS (Row Level Security) di Supabase — pastikan aktif di semua tabel, publik hanya boleh baca
- `.env` — pastikan tidak ada `ANTHROPIC_API_KEY` dengan prefix `VITE_` (akan ter-bundel ke frontend publik); gunakan `ANTHROPIC_API_KEY` sebagai Supabase secret, bukan `.env` frontend
