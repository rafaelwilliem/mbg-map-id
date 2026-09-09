"""
upload_cai_titik_kandidat_batch2.py — GeoTransit Insight
Tim MBG — MAPID WebGIS Competition 2026

*** DEPRECATED 26 Agu 2026 — jangan dijadikan contoh untuk batch berikutnya. ***

Script ini AWALNYA ditulis untuk menghitung & upload skor_cai untuk 8
titik_kandidat ASLI (KND-002..KND-009) sebagai batch terpisah dari 4 baris
skor_cai id 1-4 (KND-DEMO-001..004, lihat 007_seed_titik_kandidat_link_cai.sql).

MASALAH yang ditemukan (26 Agu 2026, arahan Sam): pola "compute_cai() cuma
untuk baris yang baru diupload sesi ini" membuat normalisasi min-max
(normalize_min_max() di compute_scores.py) memakai skala yang berbeda tiap
kali ada batch upload/revisi baru — skor_cai antar sesi upload jadi TIDAK
SEBANDING, walau sama-sama disebut "skor_cai". Menulis script batch baru
setiap kali ada titik_kandidat baru (seperti file ini) juga membuat 2+ cara
berbeda melakukan hal yang sama dan berisiko tidak sinkron di masa depan.

PENGGANTI: upload_to_supabase.recompute_all_cai_scores(client) — fungsi
STANDAR yang menghitung ulang SELURUH titik_kandidat REAL (semua baris yang
id_titik_survei-nya BUKAN berpola 'KND-DEMO-%') sebagai SATU batch gabungan
setiap kali dipanggil, lalu UPSERT ke skor_cai (UPDATE kalau baris skor_cai
untuk titik_kandidat_id itu sudah ada, INSERT kalau belum). Baca docstring
fungsi itu di upload_to_supabase.py untuk detail lengkap proxy/placeholder
yang dipakai (identik dengan yang dulu dipakai script ini) dan alasan
KND-DEMO-001..004 dikecualikan total dari perhitungan maupun penulisan.

MULAI SEKARANG: setiap kali ada titik_kandidat baru diupload (mis. dari
MAPID Apps) atau data mentah titik_kandidat direvisi, PANGGIL
recompute_all_cai_scores(client) — JANGAN menulis script batch_N.py baru.

Cara pakai (sekarang tinggal wrapper tipis, dipertahankan supaya perintah
lama `python upload_cai_titik_kandidat_batch2.py` tetap berfungsi):
    python upload_cai_titik_kandidat_batch2.py

Sanity check 26 Agu 2026: dijalankan setelah recompute_all_cai_scores()
ditulis, terhadap database yang saat itu cuma punya 8 titik REAL
(KND-002..009) — hasilnya IDENTIK dengan skor_cai yang sudah ada dari
pemanggilan batch lama (regression check, bukan perubahan data). Lihat
laporan sesi terkait untuk angka before/after.
"""

from upload_to_supabase import get_client, recompute_all_cai_scores

if __name__ == "__main__":
    # DEPRECATED — jalur kanonik skor_cai titik_kandidat sekarang
    # etl/attach_cai_features_titik_kandidat.py (kepadatan & jarak dari GEOM,
    # kriteria 'survei' N/A). Wrapper ini dipertahankan hanya supaya perintah
    # lama tidak error; ia TIDAK menyusun kepadatan/jarak dari geom, tapi
    # tetap mengoper exclude_criteria=['survei'] supaya tidak me-reintroduksi
    # n_survei=0 kalau seseorang menjalankannya. Untuk hasil penuh & benar,
    # pakai attach_cai_features_titik_kandidat.py --upload.
    print("[DEPRECATED] Pakai etl/attach_cai_features_titik_kandidat.py --upload untuk hasil lengkap.")
    client = get_client()
    scored = recompute_all_cai_scores(client, exclude_criteria=["survei"])
    if not scored.empty:
        print("\n=== Hasil recompute_all_cai_scores() (seluruh titik_kandidat REAL) ===")
        print(scored[[
            "id_titik_survei", "nama_lokasi", "titik_kandidat_id",
            "n_kepadatan", "n_jarak_inv", "n_volume", "n_survei", "skor_cai",
        ]].round(4).to_string(index=False))
