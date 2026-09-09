# Deployment — Vercel (Fase 6)

Checklist eksekusi untuk submission WebGIS **13 Sep 2026**. Frontend = Vite app di
subdirektori `frontend/`. Backend (Supabase) sudah live di project
`vpymlmaebvfmpowomsec` — tidak di-deploy ulang, hanya frontend yang di-Vercel.

> Urutan penting: **6.1 → 6.2 → 6.3 paralel → 6.4 → 6.5 → 6.6 → 6.7**.
> 6.3 (subdomain MAPID) punya lead time eksternal — **ajukan paling awal**, jangan tunggu.

---

## 6.1 Setup project Vercel

1. [ ] Login [vercel.com](https://vercel.com) (akun Vercel Pro tim).
2. [ ] **Add New → Project** → import repo GitHub **`Agentsae/mbg-map-id`** (repo privat — beri akses Vercel ke repo itu kalau diminta).
3. [ ] Di layar konfigurasi project:
   - **Root Directory**: `frontend`  ← **wajib** (repo tidak punya `package.json` di root)
   - **Framework Preset**: `Vite` (harusnya auto-terdeteksi)
   - **Build Command**: `vite build` (default preset — biarkan)
   - **Output Directory**: `dist` (default preset — biarkan)
   - **Install Command**: default (`npm install`)
4. [ ] **JANGAN klik Deploy dulu** — set environment variables (6.2) di layar yang sama, baru deploy.

Tidak perlu `vercel.json` untuk sekarang. App tidak pakai client-side routing (navigasi lewat state `activeTab`, bukan URL), jadi SPA-rewrite tidak wajib. Tambah `frontend/vercel.json` hanya kalau smoke test menunjukkan butuh.

---

## 6.2 Environment variables

Di **Project → Settings → Environment Variables**, tambah untuk scope **Production** (dan Preview kalau mau preview URL ikut fungsional). Ambil nilai dari `frontend/.env` lokal:

| Key | Isi | Catatan |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://vpymlmaebvfmpowomsec.supabase.co` | |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_...` (anon key, dari `frontend/.env`) | Publik by design (RLS baca-saja aktif di semua tabel) |
| `VITE_MAPID_MAPS_STYLE_URL` | URL style MAPID (dari `frontend/.env`) | |
| `VITE_MAPID_MAPS_API_KEY` | key MAPID (dari `frontend/.env`) | Client-side by design (dibatasi domain/referrer di dashboard MAPID) |

**JANGAN set:**
- `VITE_AUTH_REQUIRED` — biarkan tidak ada / `false`. Login wall OFF untuk submission supaya juri akses langsung. (Nyalakan `true` hanya pasca-13 Sep kalau perlu, lalu redeploy.)
- **Apa pun `VITE_ANTHROPIC*` / `sk-ant-*`** — key Claude hanya di Supabase secret, dipanggil server-side dari Edge Function `ai-insight`. Kalau ter-set dengan prefix `VITE_`, ter-bundle ke JS publik.

5. [ ] Verifikasi tidak ada key selain 4 di atas.
6. [ ] **Deploy** → tunggu build selesai. Kalau build gagal: cek log, biasanya soal Root Directory atau env var kurang.

---

## 6.3 Ajukan subdomain resmi WebGIS MAPID  ⚠️ MULAI PALING AWAL

1. [ ] Hubungi PIC MAPID (jalur koordinasi tim) — minta subdomain resmi WebGIS MAPID untuk project (mis. `geotransit.mapid.io` atau format yang mereka tentukan).
2. [ ] Sampaikan bahwa hosting frontend di Vercel — mereka akan minta **CNAME record** mengarah ke Vercel (biasanya `cname.vercel-dns.com`, atau nilai persis dari Vercel → Project → Settings → Domains setelah domain custom ditambahkan).
3. [ ] Catat estimasi waktu prosesnya dari MAPID. Kalau > 2 hari, pastikan sudah diajukan H-4 minimal.

---

## 6.4 Domain custom di Vercel + verifikasi

1. [ ] Vercel → Project → **Settings → Domains** → **Add** → masukkan subdomain dari MAPID.
2. [ ] Vercel kasih target CNAME → teruskan ke MAPID untuk dipasang (kalau belum).
3. [ ] Tunggu propagasi DNS (menit s/d jam). Status "Valid Configuration" di Vercel = siap.
4. [ ] Tambahkan domain baru ke **referrer/domain allowlist di dashboard MAPID** (kalau key basemap dibatasi domain) — kalau tidak, tiles bisa gagal di domain publik meski jalan di `*.vercel.app`.

---

## 6.5 Smoke test (jalankan di preview URL 6.2, ulangi di domain publik 6.4)

Buka URL, cek satu per satu:

- [ ] **8 menu sidebar** render tanpa layar putih: Dashboard, Peta Interaktif, Analisis Spasial, AI Spatial Consultant, Simulasi Skenario, Rekomendasi, Data & Laporan, Pengaturan
- [ ] **DevTools Console** (F12) bersih — tidak ada error merah saat pindah antar menu
- [ ] **Peta** tampil dengan basemap MAPID (bukan abu kosong) di "Peta Interaktif" dan "Analisis Spasial"
- [ ] **Dashboard** — kartu "Ringkasan Kota Bekasi" menampilkan angka nyata (**2.607.248** jiwa, dst — bukan badge "demo"). Transit Desert count ≈ **1.503**
- [ ] **Analisis Spasial** — radio "Indeks Gap Aksesibilitas" → grid TDI ter-warnai. Klik satu sel → panel rincian komponen muncul (termasuk "usia sekolah 5-19")
- [ ] **Simulasi** — klik titik di peta → hasil proyeksi muncul < 3 dtk
- [ ] **AI Spatial Consultant** — kirim pertanyaan → teks streaming mulai muncul ~1-2 dtk, narasi lengkap + ranking kelurahan. **Ini uji CORS Edge Function dari origin baru** — kalau gagal "Failed to send request", cek Network tab: preflight `OPTIONS` ke `/functions/v1/ai-insight` harus `204`
- [ ] **Data & Laporan** — Export PDF + PNG jalan, isi peta + indikator
- [ ] Refresh halaman (F5) di tiap menu — tidak 404 (kalau 404 di sub-path, tambah `frontend/vercel.json` dengan rewrite ke `/index.html`)

---

## 6.6 Rekam video demo

Rekam **setelah 6.4/6.5 lolos di domain publik final** (bukan localhost, bukan `*.vercel.app`) supaya tidak rekam ulang kalau ada isu last-minute.

Alur demo (urut): Peta Multi-Layer Gap Analysis → klik CAI/TDI rincian → AI Spatial Consultant → Simulasi What-If → Transit Equity Index Dashboard → Export Report.

Untuk segmen AI: pakai instance **warm** (panggil sekali dulu sebelum rekam), hindari pertanyaan yang memicu jalur narasi-di-atas-simulasi (lebih lambat). Sebut jujur: "teks mulai ~2 dtk, narasi penuh ~5-6 dtk, kerangka CCIA, tiap angka bisa ditelusuri".

---

## 6.7 Submission 13 Sep

- [ ] Link publik (domain MAPID)
- [ ] Video demo
- [ ] Code (sesuai instruksi submission lomba)
- [ ] Cross-check semua acceptance criteria Bab 8 sekali lagi sebelum kirim

---

## Catatan risiko

- **CORS Edge Function**: `ai-insight` sudah kirim `Access-Control-Allow-Origin: *` + handler `OPTIONS` → panggilan dari origin Vercel/domain baru seharusnya jalan. Verifikasi di 6.5.
- **RLS**: baca-publik aktif di 10/10 tabel, tanpa policy tulis untuk anon — aman diekspos.
- **Supabase Pro**: pastикan project di paket Pro (bukan free yang auto-pause) menjelang submission.
- **MAPID key**: kalau tiles gagal hanya di domain publik (bukan `*.vercel.app`), hampir pasti soal domain allowlist di dashboard MAPID (6.4 langkah 4).
