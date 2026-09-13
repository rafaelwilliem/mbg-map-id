# Skrip Video Demo — GeoTransit Insight

**Untuk:** Submission WebGIS MAPID Competition 2026 (13 September) — video recording.
**Target durasi:** 5–7 menit (skrip ini ±7:10; tiap scene diberi estimasi + jam kumulatif, boleh dipangkas — lihat "Kalau harus 5 menit" di bawah).
**Bahasa:** Indonesia. **Tone:** profesional, tenang, tidak kaku. Narator seolah memandu pejabat Dishub/Bappeda, bukan developer.
**Alur = kerangka CCIA** (Condition → Cause → Impact → Action, PRD Bab 7.5):
Condition = Dashboard + Peta Multi-Layer · Cause = CAI/TDI + rincian kriteria · Impact = Simulasi What-If · Action = Transit Equity Index + rekomendasi SMART Spasial.

---

## Prinsip yang WAJIB terdengar di narasi (sisipkan, jangan diceramahkan)

1. **AI = lapisan interpretasi, bukan penentu skor.** Model spasial deterministik (weighted overlay/MCDA) menghitung angka lebih dulu; AI hanya menerjemahkannya jadi narasi. AI tidak pernah mengarang skor.
2. **Setiap skor bisa ditelusuri** — klik lokasi → rincian kontribusi tiap kriteria, bukan angka tunggal.
3. **Bobot kriteria dari AHP pairwise formal**, rasio konsistensi (CR) < 0,1 — bukan tebakan.
4. **31 titik Survey Activities = ground truth / validasi lapangan, bukan sampel statistik** yang mewakili seluruh kota.
5. **Kejujuran data:** angka yang belum tersedia ditandai apa adanya; volume transit CAI hanya dipakai di sel yang benar-benar dicacah lapangan.

---

## Aset & persiapan sebelum rekam

- Browser Chrome, zoom 100%, jendela ±1440 px lebar (supaya peta kiri + panel kanan 384 px sama-sama terbaca). Bookmark bar & ekstensi disembunyikan, notifikasi OS dimatikan, DevTools tertutup.
- Rekam 1920×1080 / 30fps. Kursor diperbesar bila memungkinkan.
- **Supabase tersambung & tabel terisi data asli** — pastikan TIDAK ada badge "Mode demo" di header, tidak ada badge "demo" di kartu, tidak ada label `[contoh]` di laporan. (Kalau muncul, hentikan — env `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` belum benar.)
- **Basemap MAPID Maps aktif** (bukan fallback OSM). Kalau peta terlihat seperti OSM polos, `VITE_MAPID_MAPS_STYLE_URL` / `VITE_MAPID_MAPS_API_KEY` belum diisi.
- **Login wall OFF** (default): `VITE_AUTH_REQUIRED` tidak di-set / bukan `'true'`. Header menampilkan "Dishub Kota Bekasi", bukan email pribadi.
- **Anthropic API aktif** supaya AI Spatial Consultant men-stream narasi Claude sungguhan. Kalau kredit habis, panel akan menampilkan badge "Narasi template" (itu fallback deterministik bawaan — boleh, tapi kurang mengesankan; usahakan API hidup).
- Siapkan 1 pertanyaan AI yang sudah dicoba sebelumnya (lihat Scene 6) supaya jawabannya rapi.
- Jalankan sekali seluruh alur tanpa rekam sebagai gladi.

---

## SCENE-BY-SCENE

### Scene 1 — Pembuka: masalahnya · ~40 dtk · (0:00–0:40)

**Di layar:**
- Mulai dari peta penuh (tab **Peta Interaktif**) dalam keadaan diam, ter-zoom ke Kota Bekasi. Basemap MAPID, garis batas kota (biru putus-putus) terlihat, koridor BisKita (oranye) menonjol sebagai satu-satunya jaringan yang padat.
- Pelan-pelan geser/zoom sedikit ke area timur kota yang kosong dari halte.

**Narasi (VO):**
> "Kota Bekasi dihuni lebih dari dua koma enam juta jiwa dengan kepadatan sekitar dua belas ribu jiwa per kilometer persegi — salah satu kota terpadat di Indonesia. Tapi layanan transit massalnya masih bertumpu pada segelintir koridor. Selebihnya, seperti area yang tampak kosong di peta ini, warganya bergantung pada kendaraan pribadi atau angkutan informal.
> Selama ini keputusan 'di mana halte berikutnya dibangun' sering diambil berdasarkan intuisi dan usulan yang datang paling keras. Bagi Fahmi, analis di Dinas Perhubungan, pertanyaannya sederhana tapi sulit dijawab dengan data: titik mana yang, kalau dibangun, memberi dampak aksesibilitas paling besar bagi paling banyak orang?"

**Teks on-screen (lower-third):** `Kota Bekasi · 2.607.248 jiwa · 12.387 jiwa/km² · 210,49 km²`

---

### Scene 2 — Solusi & tur singkat antarmuka · ~35 dtk · (0:40–1:15)

**Di layar:**
- Sorot sidebar kiri: 8 menu berurutan — **Dashboard, Peta Interaktif, Analisis Spasial, AI Spatial Consultant, Simulasi Skenario, Rekomendasi, Data & Laporan, Pengaturan**.
- Sorot header (judul tab aktif + "GeoTransit Insight — Kota Bekasi") dan kolom pencarian di header.
- Klik kontrol "kembali ke tampilan Kota Bekasi" (ikon rumah) di pojok kanan-atas peta supaya kamera pulang ke posisi awal.

**Narasi (VO):**
> "GeoTransit Insight adalah sistem pendukung keputusan spasial berbasis WebGIS untuk menjawab pertanyaan itu dengan data, bukan dugaan. Dibangun dengan React dan MapLibre di atas basemap MAPID Maps, dengan basis data PostGIS dan lapisan AI di sisi server.
> Delapan menu di kiri mengikuti satu alur berpikir: memahami kondisi, menelusuri penyebabnya, menguji dampak sebuah intervensi, lalu menyusun rekomendasi. Kita ikuti alur itu."

**Teks on-screen:** `SDSS WebGIS · React + MapLibre GL JS + MAPID Maps · Supabase PostGIS · Claude API (server-side)`

---

### Scene 3 — Dashboard: kondisi kota hari ini (CONDITION) · ~50 dtk · (1:15–2:05)

**Di layar:**
- Klik menu **Dashboard**. Panel kanan "Dashboard Indikator" terbuka.
- Sorot berurutan: kartu **Ringkasan Kota Bekasi** (Populasi, Kepadatan, Luas Wilayah, Usia Produktif, Indeks Aksesibilitas Rata-rata).
- Turun ke baris kartu: **Transit Desert Teridentifikasi**, **Potensi Penerima Manfaat**, **Coverage Transit Kota**, **Usulan Halte Prioritas**.
- Sorot kartu **Top 3 Rekomendasi AI** (3 kelurahan + skor dampak + kalimat rekomendasi + thumbnail peta kecil).
- Scroll ke **bar chart coverage ratio per kecamatan**; arahkan kursor ke satu batang.

**Narasi (VO):**
> "Dashboard merangkum kondisi awal. Angka populasi dan kepadatan diambil langsung dari data kependudukan resmi — DKB Semester I 2026 dari Ditjen Dukcapil — bukan angka yang diketik manual. Usia produktif lima belas sampai enam puluh empat tahun mencapai hampir tujuh puluh satu persen; ini populasi yang paling butuh mobilitas harian.
> Sistem mengidentifikasi ribuan sel grid berstatus 'transit desert' — wilayah dengan kebutuhan mobilitas tinggi tapi pasokan layanan transit rendah — dan memperkirakan ratusan ribu jiwa di dalamnya bisa terjangkau bila halte prioritas dibangun.
> Grafik di bawah menegaskan masalahnya: cakupan layanan transit dalam radius jalan kaki delapan ratus meter masih sangat rendah di hampir semua kecamatan. Itu bukan galat data — itu potret transit desert Kota Bekasi."

**Teks on-screen:** `CONDITION — potret kondisi terukur`

---

### Scene 4 — Peta Interaktif: gap analysis & skor CAI per lokasi (CONDITION → CAUSE) · ~65 dtk · (2:05–3:10)

**Di layar:**
- Klik menu **Peta Interaktif**. Peta penuh, panel kanan tertutup. Buka legenda "Keterangan Peta" (pojok kanan-bawah) — tunjukkan kelompok: batas kota, transit tersurvei tim (halte ungu, koridor BisKita oranye), infrastruktur eksisting belum disurvei (KRL, LRT, halte OSM), titik analisis (titik survei lapangan hijau, **usulan halte dari model spasial — magenta, belum disurvei**).
- Di kolom pencarian header, ketik nama sebuah kecamatan (mis. "Mustikajaya"), pilih hasil **Wilayah** → batas kecamatan tersorot emas, kamera pindah ke sana. (Tunjukkan ini cepat sebagai fitur navigasi.)
- **Klik satu titik di dalam area berpenduduk** (bukan di atas marker). Panel **"Skor Composite Accessibility Index"** muncul di kiri-bawah: angka 0–1 besar, label "Skor CAI — sel grid 300 m", lalu **Rincian kontribusi tiap kriteria** (Kepadatan penduduk, Jarak ke fasilitas umum) dengan nilai + bobot, plus baris abu-abu "Volume transit — tidak berlaku di sel ini" / "Skor survei kondisi halte — tidak berlaku di sel ini", catatan, dan baris "Formula".
- Klik titik kedua yang lebih dekat ke koridor / titik survei → tunjukkan breakdown dengan **3 kriteria** (kepadatan, jarak, volume terukur).
- Klik jauh di luar area berpenduduk (mis. di luar batas kota) → panel menampilkan "Lokasi ini di luar cakupan analisis."

**Narasi (VO):**
> "Peta ini menyatukan beberapa lapisan: kepadatan penduduk, jaringan transit yang sudah ada, dan kesenjangan aksesibilitas. Yang berwarna magenta adalah usulan lokasi halte yang ditemukan oleh model — dan sistem selalu menegaskan bahwa titik ini belum disurvei lapangan, terpisah dari titik survei berwarna hijau.
> Inti dari tab ini: klik lokasi mana pun. Sistem menghitung Composite Accessibility Index untuk sel grid tiga ratus meter di titik itu — skor nol sampai satu — dan yang penting, sistem membuka isinya. Skor ini bukan angka tunggal: ada kontribusi kepadatan penduduk, kontribusi kedekatan ke fasilitas umum, dan di sel yang memang dicacah lapangan, kontribusi volume aktivitas transit.
> Di lokasi yang belum pernah disurvei, kriteria volume dinyatakan 'tidak berlaku', bukan diisi angka karangan — bobotnya dibagikan ke kriteria lain secara transparan. Bobot tiap kriteria sendiri diturunkan lewat perbandingan berpasangan AHP dengan rasio konsistensi di bawah nol koma satu.
> Klik di luar area berpenduduk, sistem jujur bilang lokasi itu di luar cakupan analisis."

**Teks on-screen:** `CAUSE — setiap skor bisa ditelusuri ke kriteria pembentuknya` · `Bobot: AHP pairwise, CR < 0,1`

---

### Scene 5 — Analisis Spasial: Transit Desert Index & rincian komponen (CAUSE) · ~50 dtk · (3:10–4:00)

**Di layar:**
- Klik menu **Analisis Spasial**. Panel kanan berisi kontrol + peta kecil.
- Tunjukkan **Filter kecamatan** (dropdown), pilih satu kecamatan → choropleth render ulang, dan baris teks **"Filter diterapkan dalam N ms (target < 2000 ms)"** muncul. Diamkan sebentar supaya angka terbaca.
- Ganti radio ke **"Indeks Gap Aksesibilitas"** (TDI). Choropleth berubah ke palet biru-hijau-kuning (ColorBrewer YlGnBu, colorblind-safe) dengan legenda **Kelas 1–5 + rentang angka**.
- (Opsional, disarankan) klik tombol **fullscreen** pada peta kecil itu supaya choropleth terlihat besar.
- **Klik satu sel** pada choropleth TDI → panel **"Rincian Transit Desert Index"**: skor TDI 0–1, **Formula ditulis sebagai rasio** (Kepadatan × Indeks Kebutuhan Mobilitas ÷ Skor Aksesibilitas Transit), lalu tiap komponen ditandai **"pembilang — menaikkan TDI"** atau **"penyebut — menurunkan TDI"**.

**Narasi (VO):**
> "Kalau CAI menilai seberapa layak sebuah lokasi, Transit Desert Index menjelaskan mengapa sebuah wilayah tertinggal. Filter per kecamatan dirender ulang di bawah dua detik — angkanya ditampilkan apa adanya di layar.
> Perhatikan skema warnanya: palet sekuensial yang tetap terbaca oleh sekitar delapan persen pria dengan defisiensi penglihatan warna, dan tiap kelas diberi nomor serta rentang angka, jadi tidak bergantung pada warna saja.
> Klik satu sel, dan lagi-lagi sistem membuka isinya. TDI adalah sebuah rasio: kebutuhan mobilitas — kepadatan penduduk dikali indeks kebutuhan mobilitas — dibagi pasokan, yaitu skor aksesibilitas transit. Setiap komponen ditandai apakah ia menaikkan atau menurunkan skor. Tidak ada kotak hitam."

**Teks on-screen:** `Filter kecamatan < 2 detik` · `Palet colorblind-safe + label kelas`

---

### Scene 6 — AI Spatial Consultant: interpretasi, bukan penghitung · ~50 dtk · (4:00–4:50)

**Di layar:**
- Klik menu **AI Spatial Consultant**. Panel chat terbuka.
- (Opsional) pilih satu kecamatan di dropdown "Batasi ke kecamatan".
- Ketik pertanyaan, mis.: **"Kecamatan mana yang perlu diprioritaskan untuk halte baru dan kenapa?"** Tekan kirim.
- Tunjukkan narasi **men-stream** masuk (teks muncul bertahap dalam hitungan detik), berbentuk **prosa mengalir** (Condition → Cause → Impact → Action tanpa label), diakhiri **daftar ranking kelurahan + skor**.
- Sorot sebentar: kalau ada, badge kecil info (mis. "Filter kecamatan diabaikan" bila nama tak dikenali) — bukti sistem transparan soal batasannya.

**Narasi (VO):**
> "Sekarang lapisan AI. Penting untuk digarisbawahi: AI di sini tidak menghitung satu angka pun. Semua skor sudah dihitung lebih dulu oleh model spasial deterministik. Yang dilakukan AI — model Claude yang dipanggil dari sisi server, kunci API-nya tidak pernah menyentuh browser — hanya menerjemahkan skor itu menjadi narasi yang bisa dibaca pejabat non-teknis.
> Narasinya mengikuti kerangka tetap: kondisi, penyebab, dampak, lalu aksi — dengan rekomendasi yang spesifik dan terukur, mengutip angka dari model, bukan mengarang. Sistem bahkan menandai narasinya sendiri kalau mendeteksi ada angka yang tidak cocok dengan data. Dan jika layanan AI sedang tidak tersedia, panel tetap menyusun narasi dari skor model secara otomatis."

**Teks on-screen:** `AI = interpreter, bukan kalkulator` · `Kerangka CCIA · rekomendasi SMART Spasial` · `API key di server (Supabase Edge Function)`

---

### Scene 7 — Simulasi What-If: menguji dampak sebelum dibangun (IMPACT) · ~45 dtk · (4:50–5:35)

**Di layar:**
- Klik menu **Simulasi Skenario**. Panel "Simulasi What-If".
- Klik **"Aktifkan mode simulasi"** → tombol jadi oranye, banner "Mode Simulasi aktif — klik di peta" muncul di atas peta, kursor jadi crosshair.
- **Klik satu titik** di area transit desert (mis. dekat marker usulan model magenta). Hasil muncul: **Penduduk terlayani 400 m**, **Penduduk terlayani 800 m**, **Estimasi pengurangan waktu tempuh (menit)**, **Fasilitas pendidikan 400 m**, **Fasilitas kesehatan 400 m**, **Transit eksisting terdekat**.
- (Opsional) tunjukkan **dropdown skenario preset** ("Halte baru — Terminal Bekasi", dll.) → "Lihat Hasil Simulasi".
- Diamkan sebentar: hasil kembali dalam ±1–2 detik (di bawah ambang 3 detik).

**Narasi (VO):**
> "Sebelum satu rupiah dianggarkan, skenario bisa diuji di sini. Aktifkan mode simulasi, klik calon lokasi halte, dan sistem memproyeksikan: berapa penduduk tambahan yang masuk radius jalan kaki empat ratus dan delapan ratus meter, berapa fasilitas pendidikan dan kesehatan yang tersambung, dan perkiraan penghematan waktu tempuh.
> Estimasi jarak memakai kecepatan jalan kaki, bukan perutean jaringan jalan real-time — itu memang di luar lingkup, dan sistem menyatakannya. Hasilnya kembali dalam hitungan detik, jadi Miko di Bappeda bisa membandingkan beberapa lokasi dalam satu rapat.
> Angka proyeksi inilah yang kemudian bisa dikutip oleh AI Spatial Consultant pada tahap rekomendasi — 'plus sekian ribu jiwa' yang nyata, bukan karangan."

**Teks on-screen:** `IMPACT — proyeksi sebelum-sesudah, < 3 detik` · `Estimasi jalan kaki (bukan network routing — out of scope)`

---

### Scene 8 — Rekomendasi / Transit Equity Index: siapa yang paling dirugikan (ACTION) · ~50 dtk · (5:35–6:25)

**Di layar:**
- Klik menu **Rekomendasi**. Panel "Transit Equity Index".
- Tunjukkan **ranking kelurahan** (skor ketimpangan, bar, angka 2 desimal). Sorot kalimat pengantar: "skor lebih tinggi = lebih dirugikan".
- **Klik satu kelurahan teratas** untuk memperluas: **Kelompok terdampak**, **Rekomendasi intervensi** (kalimat SMART Spasial: koridor/ruas, radius, jadwal), lalu **Rincian kontribusi tiap kriteria** (kepadatan, usia rentan, akses pendidikan/kesehatan/kerja) dengan bar per kriteria.
- Scroll ke bawah ke bagian **"Usulan Halte dari Model Spasial"** — daftar bernomor pink dengan kode lokasi, kelurahan, **proyeksi penduduk terlayani 800 m / 400 m**, skor TDI sel asal. Sorot disclaimer "usulan ini belum disurvei".

**Narasi (VO):**
> "Tahap terakhir: aksi. Transit Equity Index menggabungkan aksesibilitas dengan kerentanan sosial per kelurahan, lalu memeringkat mana yang paling dirugikan — ranking satu berarti paling butuh intervensi, bukan paling baik.
> Buka satu kelurahan, dan setiap skor bisa ditelusuri ke kriteria pembentuknya, sama seperti di peta. Setiap kelurahan disertai kelompok yang paling terdampak dan satu rekomendasi intervensi yang konkret: koridor mana, radius layanan berapa, kapan.
> Di bawahnya, daftar usulan halte yang ditemukan oleh model spasial — bukan lokasi yang kebetulan kami survei, tapi sel transit desert dengan proyeksi manfaat terbesar. Ranking-nya memakai proyeksi penduduk terlayani, metrik yang jujur dan bisa ditelusuri, karena titik model ini sengaja tidak diberi skor CAI palsu. Ini daftar kerja untuk Heru dan tim operator: sudah diprioritaskan, tinggal divalidasi lapangan."

**Teks on-screen:** `ACTION — ranking ketimpangan + rekomendasi SMART Spasial` · `Ranking 1 = paling butuh intervensi`

---

### Scene 9 — Data & Laporan: ekspor · ~25 dtk · (6:25–6:50)

**Di layar:**
- Klik menu **Data & Laporan**. Tunjukkan pratinjau peta + daftar "Isi laporan" (ringkasan kota, transit desert, coverage, ranking Transit Equity Index).
- Klik **"Unduh PDF"** → tunjukkan berkas PDF satu halaman terunduh (peta + indikator kunci + ranking 5 kelurahan teratas). Sebut ada juga opsi **PNG**.

**Narasi (VO):**
> "Semua ini bisa dibawa keluar dari layar. Satu klik menghasilkan ringkasan satu halaman — tampilan peta plus indikator kunci dan ranking kelurahan paling timpang — sebagai PDF atau gambar, siap dilampirkan ke nota dinas atau bahan rapat."

**Teks on-screen:** `Export Report — PDF / PNG`

---

### Scene 10 — Penutup · ~20 dtk · (6:50–7:10)

**Di layar:**
- Kembali ke tab **Peta Interaktif**, klik ikon "kembali ke tampilan Kota Bekasi", biarkan peta penuh terlihat dengan legenda terbuka.
- Fade / tahan pada logo + judul "GeoTransit Insight".

**Narasi (VO):**
> "GeoTransit Insight mengubah pertanyaan 'di mana halte berikutnya' dari perdebatan menjadi analisis yang bisa ditelusuri — dari kondisi, penyebab, dampak, sampai rekomendasi. Model spasial yang menghitung, AI yang menjelaskan, dan setiap angka bisa dibuka isinya. Untuk Dinas Perhubungan dan Bappeda Kota Bekasi, ini dasar keputusan infrastruktur transit yang bisa dipertanggungjawabkan."

**Teks on-screen:** `GeoTransit Insight · Tim MBG (MassTransit Based Geoinsight) · MAPID WebGIS Competition 2026`

---

## Kalau harus dipadatkan ke 5 menit

Pangkas dengan urutan prioritas ini:
1. Scene 2 → 20 dtk (lewati penyebutan stack detail, cukup "React, MapLibre, MAPID Maps, PostGIS, AI di server").
2. Scene 9 → 15 dtk (cukup satu klik PDF, tanpa jeda).
3. Scene 3 → 35 dtk (lewati bar chart per kecamatan, cukup 4 kartu ringkas).
4. Scene 4 → hapus demo pencarian wilayah + klik lokasi ke-3 (di luar area); sisakan 2 klik CAI.
5. Scene 7 → lewati dropdown preset, cukup 1 klik peta.
Jangan pangkas Scene 5, 6, 8 (inti CCIA Cause/Action + prinsip AI).

---

## Checklist perekaman

**Sebelum rekam**
- [ ] `frontend/.env` (atau env Vercel) terisi `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_MAPID_MAPS_STYLE_URL`, `VITE_MAPID_MAPS_API_KEY`. TIDAK ada `VITE_ANTHROPIC_API_KEY`.
- [ ] `VITE_AUTH_REQUIRED` tidak di-set ke `'true'` (login wall OFF).
- [ ] Buka app → header **tidak** menampilkan badge "Mode demo". Tab Dashboard: **tidak** ada badge "demo" di kartu mana pun. Tab Data & Laporan: **tidak** ada label `[contoh]`.
- [ ] Basemap tampil sebagai MAPID Maps (peta bergaya, ada gedung) — bukan OSM raster polos.
- [ ] AI Spatial Consultant diuji 1×: narasi Claude men-stream, **tanpa** badge "Narasi template" dan **tanpa** badge kuning "Narasi ditandai — periksa kembali". (Kalau "template" muncul: kredit Anthropic habis — isi ulang, atau rekam tetap jalan dan sebut verbal bahwa itu fallback bawaan.)
- [ ] Tab Analisis Spasial: filter kecamatan → teks "diterapkan dalam N ms" muncul dan N < 2000.
- [ ] Tab Simulasi: klik peta di dalam batas kota mengembalikan angka (bukan "di luar area analisis").
- [ ] Peta sudah selesai dimuat (spinner "Memuat peta Kota Bekasi…" hilang) sebelum mulai — penting juga untuk Export di Scene 9.
- [ ] Data terbaru sudah ter-`push`: skor CAI grid (migration 033), skor TDI, skor_equity, usulan_halte_model. Konfirmasi ke qa-tester bila ragu.
- [ ] Gladi 1× tanpa rekam.

**Saat rekam**
- [ ] Gerakan kursor pelan; beri jeda 1–2 detik setelah tiap klik supaya panel sempat render dan terbaca.
- [ ] Untuk Scene 5, gunakan tombol fullscreen pada peta kecil di panel supaya choropleth terlihat jelas.
- [ ] Jangan klik ikon **lonceng** / **tanda tanya** di header — keduanya dekoratif, tidak melakukan apa-apa.
- [ ] Kalau tak sengaja masuk tab **Pengaturan**, tutup cepat — isinya minimal (info akun + logout), bukan bagian demo inti.

**Sesudah rekam**
- [ ] Audio VO bersih, tanpa noise; level konsisten.
- [ ] Tidak ada informasi sensitif tampil (email pribadi, token URL). Kalau login wall ternyata menyala dan email muncul di header → blur atau rekam ulang dengan flag OFF.
- [ ] Durasi final 5–7 menit.

---

## Catatan: yang sebaiknya di-skip / di-blur

- **Tab Pengaturan** — cukup disebut sekilas di Scene 2 sebagai menu ke-8, tidak perlu discene-kan. Manajemen multi-user enterprise memang di luar lingkup (PRD Bab 3).
- **Ikon lonceng & tanda tanya** di header — dekoratif, jangan diklik saat rekam.
- **Badge "Mode demo" / "demo" / label `[contoh]`** — kalau sempat muncul, itu tanda data belum tersambung; hentikan rekaman, jangan tayangkan.
- **Badge "Narasi template"** pada AI — sebenarnya fitur mitigasi (PRD Bab 12), tapi untuk kesan terbaik pastikan API Claude aktif agar yang tampil narasi streaming sungguhan.
- **Email di header** (hanya muncul kalau login wall ON) — blur bila terlihat.
- **Peta kecil di panel Analisis Spasial** sempit di lebar default — fullscreen-kan saat menyorot choropleth, atau perlebar jendela browser sebelum scene itu.
- **URL dengan query key** (mis. saat tab jaringan devtools terbuka) — jangan tampilkan DevTools sama sekali.
