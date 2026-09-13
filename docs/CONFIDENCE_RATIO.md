# Confidence Ratio — GeoTransit Insight

> Ditambahkan 2026-09-13 (hari submission WebGIS), atas permintaan Sam + mentor.
> **BUKAN** `consistency_ratio` (AHP, Saaty pairwise) yang sudah ada di
> `konfigurasi_bobot` sejak migration `018`. Dua istilah ini SERING TERTUKAR —
> lihat bagian "Jangan tertukar dengan consistency ratio (CR)" di bawah, WAJIB
> dibaca sebelum menyentuh prompt AI atau menulis narasi apa pun yang menyebut
> keduanya.

## Kenapa metrik ini ada

`consistency_ratio` mengukur apakah **matriks pairwise AHP** yang dipakai
mentukan bobot itu logis secara internal (Saaty, < 0,1 = koheren). Itu
metrik tentang **metodologi pembobotan**, bukan tentang data.

`confidence_ratio` menjawab pertanyaan yang berbeda sama sekali: **"untuk
skor SPESIFIK di lokasi/kelurahan ini, seberapa yakin kita bahwa angka itu
betul-betul merepresentasikan kondisi nyata di lapangan?"** — bukan validitas
rumus, tapi keandalan/kepercayaan (*trust/reliability signal*) per skor,
berdasarkan seberapa banyak & seberapa langsung data yang menyusunnya berasal
dari pengukuran lapangan vs. proksi/geodata sekunder.

## Batasan desain (wajib, disetujui Sam 2026-09-13)

- **Tidak mengubah skor CAI/TDI/Equity atau bobot AHP** — confidence adalah
  kolom/field TAMBAHAN murni aditif, dibaca berdampingan dengan skor, tidak
  pernah menggantikannya.
- **Tidak ada pengumpulan data baru** — confidence diturunkan semata-mata dari
  field yang SUDAH ada di pipeline (jumlah kriteria CAI yang aktif, sumber
  halte terdekat TDI, agregasi confidence CAI untuk Equity).
- **Threshold & formula eksplisit, dapat ditelusuri** — bukan black box, sama
  seperti prinsip breakdown skor itu sendiri (`get_cai_breakdown`,
  `get_tdi_breakdown`).
- Skala 0–1 (`*_confidence_ratio`) + label kategorikal (`*_confidence_tier`
  ∈ {"Tinggi", "Sedang", "Rendah"}) untuk ketiga index, supaya konsisten
  dipakai lintas panel UI & narasi AI.

## 1. CAI — confidence dari jumlah kriteria AKTIF per sel

CAI grid (migration `033`) punya 4 kriteria yang bisa aktif/tidak per sel
(kepadatan & jarak SELALU aktif; volume aktif hanya di sel yang dicacah
lapangan ≤300 m; survei aktif hanya di sel dekat halte tersurvei ≤400 m —
lihat Catatan 2026-09-10 di CLAUDE.md). Ini SUDAH jadi sinyal keandalan yang
alami: sel dengan lebih banyak kriteria aktif dibangun dari lebih banyak
sumber data independen (termasuk data lapangan langsung), bukan cuma dua
proksi geodata (kepadatan dasymetric + jarak POI OSM).

```
n_kriteria_aktif   = 2, 3, atau 4   (kepadatan+jarak selalu 2; +survei; +volume; +keduanya)
cai_confidence_ratio = n_kriteria_aktif / 4
cai_confidence_tier   = "Rendah"  kalau n_kriteria_aktif == 2   (ratio 0,50)
                        "Sedang"  kalau n_kriteria_aktif == 3   (ratio 0,75)
                        "Tinggi"  kalau n_kriteria_aktif == 4   (ratio 1,00)
```

**Kenapa linear/jumlah kriteria, bukan tertimbang bobot AHP:** confidence di
sini mengukur *breadth* bukti (berapa sumber independen yang menyusun angka
ini), bukan *besarnya pengaruh* tiap kriteria pada skor akhir (itu peran
bobot AHP, sudah dijawab `consistency_ratio`). Menggabungkan keduanya
(mis. confidence = bobot kriteria yang N/A) akan membuat confidence dan skor
CAI saling redundan/inkonsisten secara konseptual — bukan sinyal baru.

**Contoh perhitungan manual (3 sel, angka sama seperti contoh formula CAI di
migration `033`):**

| Sel | Kriteria aktif | n_kriteria_aktif | confidence_ratio | confidence_tier |
|---|---|---|---|---|
| A | kepadatan + jarak | 2 | 2/4 = 0,50 | Rendah |
| B | kepadatan + jarak + survei | 3 | 3/4 = 0,75 | Sedang |
| C | kepadatan + jarak + volume + survei | 4 | 4/4 = 1,00 | Tinggi |

Live (2.607 sel; distribusi kasus bobot sudah diketahui dari run CAI grid
2026-09-10, lihat CLAUDE.md): 2.526 sel dengan 2 kriteria aktif (kepadatan+
jarak) -> Rendah; 44 sel +survei (3 kriteria) -> Sedang; 37 sel +volume (3
kriteria) -> Sedang; 0 sel dengan keempat kriteria sekaligus (belum ada sel
yang punya volume DAN survei aktif bersamaan pada data saat ini) -> Tinggi.
Jadi live saat ini: **2.526 Rendah, 81 Sedang (44+37), 0 Tinggi** — lihat
sanity check di bawah untuk angka final setelah migration dijalankan.

**Implementasi:** dihitung LANGSUNG di SQL saat migration (`035`) dijalankan
(backfill `update grid_analisis set ... where cai_skor is not null`, dari
kolom `cai_bobot_volume`/`cai_bobot_survei` yang sudah ada — non-null berarti
kriteria itu aktif di sel tsb), dan juga ditulis oleh
`etl/compute_cai_grid.py --upload` untuk run berikutnya supaya tetap
konsisten kalau CAI grid dihitung ulang. RPC `get_cai_breakdown` (migration
`035`, `create or replace`) mengembalikan objek `confidence` baru di level
atas.

## 2. TDI — confidence dari sumber halte terdekat (survei vs OSM)

Sejak perbaikan 2026-09-11, `skor_aksesibilitas_transit` (penyebut TDI)
memakai halte GABUNGAN: 15 halte `halte_eksisting` yang **disurvei lapangan
langsung oleh tim** + 32 titik OSM BisKita Trans Patriot yang **belum
disurvei** (lihat Catatan 2026-09-11 di CLAUDE.md). Keduanya dianggap sama
kuat untuk *skor* (posisi geografis OSM cukup dipercaya untuk nearest-
distance), tapi TIDAK sama kuat untuk *confidence* — data survei lapangan tim
sendiri (foto, verifikasi fisik ada/tidaknya halte) lebih dapat dipercaya
daripada titik community-mapped yang belum pernah dicek keberadaan/kondisi
fisiknya oleh tim.

```
sumber_halte_terdekat == 'survei_lapangan'      -> tdi_confidence_ratio = 1,00 -> "Tinggi"
sumber_halte_terdekat == 'osm_belum_disurvei'   -> tdi_confidence_ratio = 0,60 -> "Sedang"
```

Tier: `>= 0,90` "Tinggi" · `>= 0,50` "Sedang" · sisanya "Rendah" (ambang yang
sama dipakai CAI & Equity, lihat bagian umum di bawah) — dengan hanya 2 nilai
kemungkinan (1,00 / 0,60) saat ini, hasilnya selalu jatuh ke Tinggi atau
Sedang, tidak pernah Rendah; itu disengaja (halte gabungan sendiri sudah
dua sumber yang keduanya diverifikasi keberadaan fisiknya — survei tim
langsung atau OSM community-mapped yang sudah dipakai jadi acuan visual peta
BisKita — jadi tidak ada kasus "sama sekali tidak bisa dipercaya" di sini).

**Kenapa 0,60, bukan angka lain:** dipilih di tengah rentang "cukup bisa
dipercaya, tapi tidak setara verifikasi langsung" — bukan mendekati 0 (data
OSM BisKita sudah dikonfirmasi sebagai jaringan resmi `network="Trans Bekasi
Patriot"`, bukan sembarang tag POI acak) dan bukan mendekati 1 (belum ada
foto/pengecekan fisik tim seperti 15 halte survei). Ini judgment call
eksplisit, bukan hasil perhitungan statistik — dicatat di sini & di komentar
kode (`compute_scores.py`) supaya bisa didebat/direvisi mentor, bukan
disembunyikan sebagai angka ajaib.

**Kenapa TIDAK memakai jarak sebagai faktor tambahan (mis. makin jauh dari
SEMUA halte, makin rendah confidence):** dipertimbangkan tapi disengaja
DITUNDA (bukan ditolak permanen) untuk versi minimal hari ini — menambah
dimensi jarak akan membuat formula 2 dimensi (sumber x jarak) yang perlu
kalibrasi lebih hati-hati dan tidak ada waktu untuk memvalidasinya sebelum
deadline submission. Confidence versi ini murni fungsi dari *sumber* data,
bukan *kualitas geometris* jaraknya.

**Implementasi:** `etl/compute_tdi_full.py` SUDAH menghitung
`jarak_halte_terdekat_m` & `sumber_halte_terdekat` per sel (dipakai untuk
`skor_aksesibilitas_transit`), TAPI sebelum perubahan ini keduanya tidak
pernah dipersist ke `grid_analisis` — hanya dipakai in-memory lalu dibuang.
Migration `035` menambah 4 kolom (`jarak_halte_terdekat_m`,
`sumber_halte_terdekat`, `tdi_confidence_ratio`, `tdi_confidence_tier`);
`etl/upload_to_supabase.upload_tdi_scores()` diperluas untuk ikut menulis
keempatnya. **Perlu satu kali rerun `python etl/compute_tdi_full.py
--upload`** (skor_tdi/skor_aksesibilitas_transit itu sendiri TIDAK berubah
nilainya — hanya kolom baru yang terisi; lihat sanity check di bawah untuk
bukti tidak ada regresi). RPC `get_tdi_breakdown` (migration `035`) diperluas
mengembalikan objek `confidence` baru di level atas.

## 3. Equity — agregasi confidence CAI per kelurahan (MINIMUM, bukan rata-rata)

`skor_equity.skor_cai_rata2` per kelurahan adalah rata-rata `skor_cai` semua
`titik_kandidat` survei yang jatuh di kelurahan itu (atau fallback kota kalau
kosong — lihat `etl/aggregate_equity_kelurahan.py`). Confidence versi ini
dibangun dari sumber yang BERBEDA: agregasi `cai_confidence_ratio` grid
(bagian 1 di atas) atas SEMUA sel `grid_analisis` yang jatuh (point-in-
polygon centroid) di kelurahan itu — bukan dari `titik_kandidat`, karena
grid 2.607 sel jauh lebih rapat/representatif secara spasial di seluruh
kelurahan (pola yang sama dipakai `attach_jarak_poi()` di script yang sama
untuk `jarak_rata2_*`).

**Dipilih MINIMUM, bukan rata-rata (mean):**

```
skor_equity.confidence_ratio = MIN( cai_confidence_ratio ) atas semua sel grid di kelurahan tsb
```

Alasan (lebih defensif secara statistik untuk konteks *policy claim*):
sebuah klaim ketimpangan level-kelurahan yang dipakai untuk memprioritaskan
intervensi TIDAK BOLEH terlihat lebih andal daripada bagian **paling lemah**
datanya. Rata-rata bisa menyembunyikan kantong sel berconfidence rendah di
dalam kelurahan yang sebagian besar sisanya berconfidence tinggi — padahal
`skor_cai_rata2` kelurahan itu sendiri ikut dibentuk oleh sel-sel lemah itu.
Prinsip "weakest link" ini konsisten dengan pola kehati-hatian yang sudah
dipakai proyek ini di tempat lain (mis. keputusan Opsi B 2026-09-10: menolak
estimasi regresi ketimbang mengklaim akurasi yang tidak didukung data).
Sebagai pembanding transparansi (bukan angka otoritatif), rata-rata tetap
disimpan di kolom terpisah `confidence_ratio_rata2` supaya perbedaannya
terlihat kalau ada yang mau audit, tapi kolom yang dipakai UI/AI adalah
`confidence_ratio` (minimum).

```
skor_equity.confidence_tier = tier(confidence_ratio)          -- dari MIN
skor_equity.confidence_n_sel = jumlah sel grid yang diagregasi
skor_equity.confidence_metode = 'minimum (konservatif) atas cai_confidence_ratio sel grid dalam kelurahan; lihat docs/CONFIDENCE_RATIO.md'
```

Kelurahan yang tidak match ke sel grid manapun (celah antar-polygon RBI 25K,
kasus sama seperti `jarak_rata2_*`) → `confidence_ratio` NULL (bukan 0),
dicatat sebagai N/A, konsisten dengan pola "N/A bukan 0" proyek ini.

## Ambang tier (dipakai konsisten lintas 3 index)

```
ratio >= 0,90  -> "Tinggi"
ratio >= 0,50  -> "Sedang"
ratio <  0,50  -> "Rendah"
```

Satu fungsi (`confidence_tier_dari_ratio()`, `etl/compute_scores.py`) dipakai
CAI grid, TDI grid, dan agregasi Equity — supaya label "Tinggi/Sedang/Rendah"
berarti hal yang konsisten di ketiga index, meski formula ratio-nya berbeda
per index (dijelaskan & dijustifikasi masing-masing di atas).

## Jangan tertukar dengan consistency ratio (CR)

| | `consistency_ratio` (CR, sudah ada) | `confidence_ratio` (BARU, dokumen ini) |
|---|---|---|
| Mengukur | Koherensi matriks pairwise AHP Saaty | Keandalan skor SPESIFIK suatu lokasi/kelurahan |
| Level | Per index (CAI/TDI_MOBILITAS/EQUITY), satu angka utk SELURUH bobot | Per sel grid / per kelurahan, beda-beda tiap baris |
| Tabel | `konfigurasi_bobot.consistency_ratio` | `grid_analisis.cai_confidence_ratio` / `.tdi_confidence_ratio`, `skor_equity.confidence_ratio` |
| Ambang baik | `< 0,1` (standar Saaty) | `>= 0,90` "Tinggi" (skala berbeda, JANGAN disamakan) |
| Disebut di narasi AI sebagai | "consistency ratio (CR)" atau "bobot hasil AHP pairwise (CR < 0,1)" | "confidence ratio" atau "tingkat keyakinan data" |

Prompt `supabase/functions/ai-insight/index.ts` (system prompt) diperbarui
2026-09-13 untuk secara eksplisit melarang AI memakai kata "confidence" utk
CR AHP atau sebaliknya — lihat bagian `=== ISTILAH: confidence ratio vs
consistency ratio (CR) ===` di system prompt.

**Insiden yang memicu penegasan ini:** satu narasi AI arsip
(`qa/ai-insight-sse-verify-result.PREV-20260906.json`, sebelum confidence
ratio ini ada) sempat menyebut "...bobot hasil AHP dengan confidence ratio di
bawah 0,1..." — jelas keliru istilah (maksudnya consistency ratio; sebelum
2026-09-13 tidak ada "confidence ratio" apa pun di sistem ini, jadi tidak
mungkin dimaksudkan sebagai metrik yang didokumentasikan di sini). File itu
arsip historis, tidak diedit — tapi ini alasan konkret kenapa dokumen ini
menegaskan pemisahan istilah begitu eksplisit di prompt AI baru.

## Verifikasi live (2026-09-13, setelah migration `035` + rerun ETL)

**Bug ditemukan & diperbaiki saat verifikasi:** `confidence_tier_dari_ratio()` di
`etl/compute_scores.py` memakai batas `ratio >= 0,50 -> "Sedang"` (inklusif) —
salah untuk CAI, yang punya lantai struktural persis di `ratio = 0,50` (2
kriteria dasar selalu aktif). Akibatnya SEMUA sel/kelurahan di lantai itu
salah masuk "Sedang", dan "Rendah" jadi tier yang tidak pernah muncul untuk
CAI. Ketahuan lewat verifikasi silang: agregasi MIN Equity per kelurahan
melaporkan 56/56 kelurahan "Sedang" — mustahil mengingat 96,9% sel CAI
ber-tier "Rendah" (2.526/2.607), diverifikasi independen lewat spatial join
terpisah dari kode produksi. Backfill SQL migration `035` untuk `grid_analisis
.cai_confidence_tier` TIDAK terkena bug ini (pakai `CASE WHEN` independen atas
jumlah kriteria, bukan perbandingan ratio) — jadi kolom itu benar sejak awal.
Fix: ganti jadi `ratio > 0,50 -> "Sedang"` (eksklusif) di
`confidence_tier_dari_ratio()`, lalu rerun `aggregate_equity_kelurahan.py
--upload` (nilai `confidence_ratio` numerik SENDIRI tidak pernah salah, hanya
label `confidence_tier`-nya — jadi tidak ada re-hitung ranking/skor apa pun).

**Distribusi final setelah verifikasi + rerun ETL:**

| Index | Rendah | Sedang | Tinggi | Total | Catatan |
|---|---|---|---|---|---|
| CAI (`grid_analisis`, per sel) | 2.526 | 81 | 0 | 2.607 | Sesuai proyeksi dry-run 2026-09-10 di CLAUDE.md |
| TDI (`grid_analisis`, per sel) | 0 | 2.099 | 508 | 2.607 | Tidak pernah "Rendah" — sesuai desain (2 sumber halte, keduanya terverifikasi fisik) |
| Equity (`skor_equity`, per kelurahan, MIN) | 56 | 0 | 0 | 56 | Konsekuensi jujur dari MIN "weakest link": hampir semua kelurahan memuat >=1 sel CAI dengan hanya 2 kriteria (kepadatan+jarak) — cakupan lapangan (survei/traffic-counting) masih terlalu jarang untuk mengangkat *floor* kelurahan mana pun di atas "Rendah". Bukan bug — sinyal jujur soal keterbatasan cakupan data lapangan saat ini. |

`skor_tdi` sendiri diverifikasi TIDAK berubah oleh rerun ini (LAMA vs BARU:
median 0,6488 = 0,6488, rho Spearman = 1,0000, 0 sel berubah > 1e-4) — rerun
murni mengisi kolom provenance/`confidence` yang sebelumnya kosong. 0 NULL,
0 nilai di luar rentang [0,1] pada ketiga index setelah rerun.

## File yang terlibat

- `supabase/migrations/035_confidence_ratio.sql` — kolom baru + backfill SQL
  langsung untuk CAI (dari kolom `cai_bobot_*` yang sudah ada) + RPC
  `get_cai_breakdown`/`get_tdi_breakdown` diperluas (`create or replace`,
  signature sama).
- `etl/compute_scores.py` — `confidence_tier_dari_ratio()`,
  `TDI_CONFIDENCE_BY_SUMBER`, `compute_tdi_confidence()`.
- `etl/compute_cai_grid.py` — hitung & upload `cai_confidence_*` (redundan
  dengan backfill SQL migration, supaya run berikutnya tetap konsisten).
- `etl/compute_tdi_full.py` + `etl/upload_to_supabase.upload_tdi_scores()` —
  persist `jarak_halte_terdekat_m`, `sumber_halte_terdekat`,
  `tdi_confidence_*` (kolom baru, BUTUH rerun `--upload` sekali).
- `etl/aggregate_equity_kelurahan.py` — agregasi `confidence_ratio` (MIN) per
  kelurahan dari `grid_analisis.cai_confidence_ratio` (BUTUH rerun
  `--upload` sekali, setelah CAI grid confidence terisi).
- `supabase/functions/ai-insight/index.ts` — system prompt + payload +
  validasi anti-halusinasi diperluas mengenali `confidence_ratio` sebagai
  angka SAH (bukan di-flag sebagai karangan) dan istilahnya dipisahkan tegas
  dari CR AHP.
