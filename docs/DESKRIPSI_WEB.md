# Deskripsi Produk — GeoTransit Insight

## Elevator pitch

GeoTransit Insight adalah Spatial Decision Support System (SDSS) berbasis WebGIS yang membantu Dinas Perhubungan dan Bappeda Kota Bekasi menentukan lokasi prioritas pembangunan infrastruktur transit massal berdasarkan data spasial, bukan intuisi. Model spasial deterministik menghitung skor aksesibilitas dan kesenjangan layanan per lokasi; lapisan AI menerjemahkan skor itu menjadi rekomendasi yang bisa dibaca pejabat non-teknis — dan setiap angka bisa ditelusuri ke kriteria pembentuknya.

---

## Deskripsi panjang

Kota Bekasi dihuni lebih dari 2,6 juta jiwa dengan kepadatan sekitar 12.387 jiwa/km², namun layanan transit massalnya masih bertumpu pada sedikit koridor. Keputusan penempatan halte selama ini kerap diambil berdasarkan dugaan dan usulan yang paling vokal. GeoTransit Insight mengubahnya menjadi proses analitis yang runtut dan dapat dipertanggungjawabkan.

Aplikasi ini mengikuti satu alur berpikir — **Condition → Cause → Impact → Action (CCIA)**. Pengguna mulai dari dashboard indikator dan peta multi-layer yang memperlihatkan kondisi terkini: kepadatan penduduk, jaringan transit eksisting, dan indeks kesenjangan aksesibilitas. Untuk menelusuri penyebabnya, pengguna mengklik lokasi mana pun di peta dan sistem menampilkan **Composite Accessibility Index (CAI)** untuk sel grid 300 meter di titik itu, lengkap dengan rincian kontribusi tiap kriteria; pada layer terpisah, **Transit Desert Index (TDI)** menjelaskan wilayah mana yang kebutuhan mobilitasnya tinggi tetapi pasokan layanannya rendah. Fitur **Simulasi What-If** memproyeksikan dampak penambahan sebuah halte — berapa penduduk tambahan yang terlayani dalam radius jalan kaki 400 dan 800 meter, fasilitas yang tersambung, dan penghematan waktu tempuh — dalam hitungan detik. Terakhir, **Transit Equity Index Dashboard** memeringkat kelurahan menurut tingkat ketimpangan akses transit dan menyertakan kelompok terdampak serta satu rekomendasi intervensi SMART Spasial per kelurahan, ditambah daftar usulan lokasi halte yang ditemukan oleh model.

Prinsip yang dipegang: **AI adalah lapisan interpretasi, bukan penentu skor.** Semua angka dihitung lebih dulu oleh model spasial (weighted overlay/MCDA) dengan bobot hasil AHP pairwise formal (rasio konsistensi < 0,1); AI (Claude API, dipanggil dari sisi server) hanya menyusun narasinya dan tidak pernah mengarang angka. Data survei lapangan 31 titik diperlakukan sebagai validasi/ground truth, bukan sampel statistik kota. Keluaran utama: skor prioritas per lokasi yang dapat ditelusuri, ranking ketimpangan antarkelurahan, proyeksi dampak intervensi, dan laporan ringkas siap unduh (PDF/gambar).

---

## Fitur utama (per 8 area)

- **Dashboard Indikator** — ringkasan Kota Bekasi (populasi, kepadatan, luas, usia produktif, indeks aksesibilitas rata-rata), jumlah transit desert teridentifikasi, potensi penerima manfaat, coverage transit kota, jumlah usulan halte prioritas, Top 3 Rekomendasi AI, dan grafik coverage ratio per kecamatan.
- **Peta Interaktif** — peta multi-layer di atas basemap MAPID Maps: batas kota, koridor & halte BisKita, jaringan KRL/LRT, titik survei lapangan, dan usulan halte hasil model (ditandai jelas "belum disurvei"). Klik lokasi mana pun → skor CAI sel grid 300 m + rincian kontribusi tiap kriteria; pencarian wilayah/fitur dengan sorotan batas administrasi.
- **Analisis Spasial** — choropleth kepadatan penduduk dan indeks gap aksesibilitas (TDI), filter per kecamatan yang dirender ulang di bawah 2 detik, palet colorblind-safe (ColorBrewer YlGnBu) dengan label kelas non-warna. Klik sel → rincian komponen formula TDI (pembilang/penyebut).
- **AI Spatial Consultant** — tanya-jawab bahasa natural; narasi berkerangka CCIA yang di-stream dari Claude via Supabase Edge Function, disertai ranking kelurahan. Validasi anti-halusinasi menandai narasi bila angka tak cocok dengan data; tersedia fallback narasi template deterministik bila layanan AI mati.
- **Simulasi Skenario (What-If)** — aktifkan mode lalu klik titik di peta (atau pilih skenario preset) → proyeksi penduduk tambahan terlayani 400/800 m, fasilitas pendidikan/kesehatan terjangkau, estimasi pengurangan waktu tempuh jalan kaki; hasil < 3 detik.
- **Rekomendasi (Transit Equity Index)** — ranking kelurahan menurut skor ketimpangan (ranking 1 = paling butuh intervensi), rincian kontribusi tiap kriteria per kelurahan, kelompok terdampak, rekomendasi intervensi SMART Spasial, dan daftar usulan halte dari model spasial dengan proyeksi penduduk terlayani.
- **Data & Laporan** — unduh ringkasan satu halaman (tampilan peta + indikator kunci + ranking Transit Equity Index teratas) sebagai PDF atau PNG.
- **Pengaturan** — info akun staf (single-role Dishub/Bappeda) dan logout; login wall opsional (default nonaktif untuk akses publik).

---

## Metodologi singkat

- **Composite Accessibility Index (CAI)** — Weighted Linear Combination dari kriteria: kepadatan penduduk, kedekatan ke fasilitas umum (inverse `ST_Distance` ke POI), volume aktivitas transit, dan skor survei kondisi halte. Dihitung sebagai permukaan **grid 300 m**; tiap kriteria dinormalisasi 0–1 lalu dikalikan bobot. Kriteria volume hanya aktif di sel yang benar-benar dicacah lapangan; di sel lain kriteria itu dinyatakan tidak berlaku dan bobotnya direnormalisasi ke kriteria yang tersisa — tanpa mengarang angka.
- **Transit Desert Index (TDI)** — per grid 300 m: `(Kepadatan Penduduk × Indeks Kebutuhan Mobilitas) ÷ Skor Aksesibilitas Transit`. Indeks Kebutuhan Mobilitas dari proksi proporsi usia rentan, kepadatan POI kebutuhan harian, dan proporsi penduduk usia sekolah (5–19). Skor tinggi = wilayah makin "transit desert".
- **Transit Equity Index** — CAI (di-inverse) digabung dimensi kerentanan sosial per kelurahan, menghasilkan ranking ketimpangan (bukan ranking prioritas lokasi).
- **Pembobotan (AHP)** — bobot tiap indeks diturunkan lewat perbandingan berpasangan Saaty formal; rasio konsistensi ketiga indeks < 0,1.
- **Dasymetric mapping** — populasi kelurahan disebar ke grid 300 m proporsional terhadap tutupan bangunan, dengan konservasi total populasi.
- **Narasi CCIA + SMART Spasial** — narasi AI mengikuti kerangka Condition → Cause → Impact → Action; rekomendasi tahap Action harus spesifik dan terukur (koridor/ruas, radius layanan, jadwal), mengutip angka dari model/simulasi, bukan dari AI.

---

## Keterbatasan yang dinyatakan jujur

- **Bukan network routing riil.** Simulasi jarak/waktu tempuh memakai estimasi kecepatan jalan kaki (±4–5 km/jam), bukan perutean jaringan jalan atau jadwal transit real-time — eksplisit di luar lingkup.
- **31 titik Survey Activities = ground truth / validasi lapangan, bukan sampel statistik** yang merepresentasikan seluruh Kota Bekasi. Angka tidak digeneralisasi ke tingkat kota di narasi.
- **Dasymetric mapping menghasilkan estimasi**, bukan sensus per titik; hasilnya bergantung pada kualitas data tutupan bangunan.
- **Volume transit CAI hanya tersedia di sel yang dicacah lapangan** (sekitar puluhan sel). Di sel lain, skor CAI berdiri pada kepadatan penduduk + kedekatan fasilitas; tidak ada estimasi volume yang dikarang.
- **Bobot AHP tetap mengandung penilaian ahli** pada skala perbandingan berpasangannya; subjektivitas residual dimitigasi lewat analisis sensitivitas, bukan dihilangkan.
- **Usulan halte dari model belum disurvei lapangan** dan sengaja tidak diberi skor CAI (data volume lapangannya belum ada) — diperingkat memakai proyeksi penduduk terlayani.
- **Bukan aplikasi mobile native, tanpa integrasi ticketing/pembayaran, tanpa manajemen user multi-role enterprise** — semua di luar lingkup.

---

## Stack teknologi

| Lapisan | Teknologi |
|---|---|
| Frontend | React + Vite, MapLibre GL JS, basemap MAPID Maps |
| Backend / DB | Supabase (PostgreSQL + PostGIS terkelola, auto-REST, Storage, Edge Functions) |
| AI | Claude API (Messages API, `claude-haiku-4-5-20251001`) — dipanggil dari Supabase Edge Function, API key di server |
| Analisis spasial | Python (GeoPandas, Shapely, scikit-learn) + QGIS/PostGIS — batch offline, hasil diunggah ke Supabase |
| Hosting | Vercel (frontend) + Supabase (backend/DB) |

---

## Caption submission / deskripsi repo (1–2 kalimat)

> **GeoTransit Insight** — SDSS WebGIS untuk Dishub & Bappeda Kota Bekasi yang menentukan lokasi prioritas transit massal berbasis data: model spasial deterministik (CAI/TDI/Transit Equity Index, bobot AHP) menghitung skor per lokasi, AI menerjemahkannya jadi rekomendasi CCIA yang bisa ditelusuri, dan Simulasi What-If memproyeksikan dampak sebelum dibangun. Dibangun dengan React + MapLibre GL JS + MAPID Maps, Supabase PostGIS, dan Claude API di sisi server.
