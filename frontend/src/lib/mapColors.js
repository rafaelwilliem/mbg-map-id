// mapColors.js — token warna sorotan wilayah, dipakai bersama oleh App.jsx
// (layer peta) dan AnalisisSpasial.jsx (badge nama kecamatan terpilih di
// panel kontrol) supaya SATU konstanta = satu sumber kebenaran. Jangan
// hardcode ulang hex ini di tempat lain — import dari sini.
//
// Perbaikan 2026-09-13 (Sam melaporkan: sorotan batas kecamatan terpilih
// nyaris tak terlihat di peta, dan nama kecamatan terpilih di panel tidak
// cukup mencolok):
//
// 1) WARNA GARIS: SOROT_WILAYAH_COLOR (gold/amber) DIPERTAHANKAN — masih satu
//    -satunya rumpun warna yang belum dipakai layer lain di App.jsx (hijau,
//    ungu, oranye x3 corak, biru x2, teal x2, magenta, merah, brand-blue
//    semua sudah terpakai untuk layer lain — lihat konstanta *_COLOR di
//    App.jsx), dan tetap menghindari pasangan merah-hijau sesuai CLAUDE.md
//    Bab 10.3.
//
//    Yang berubah: garis sorotan sekarang SELALU digambar dengan "halo"/
//    casing gelap (SOROT_WILAYAH_HALO_COLOR) di bawahnya, bukan gold polos.
//    Kenapa dark-casing + light-core (bukan white-casing seperti kebiasaan
//    umum): kedua overlai analitik grid (lib/choropleth.js) punya ujung
//    PUCAT — YlGnBu kelas terendah #ffffcc (kepadatan) nyaris putih — yang
//    akan MENELAN halo putih di sel-sel berkepadatan rendah, persis kondisi
//    yang sedang diperbaiki. Halo gelap (slate-800) kontras di kedua ujung
//    tiap palet: ujung pucat YlGnBu #ffffcc / ujung gelap YlGnBu #253494;
//    ujung gelap Viridis #440154 / ujung terang Viridis #fde725 — dan juga
//    kontras terhadap jalan basemap yang kebetulan senada oranye/amber,
//    karena jalan basemap tidak memakai casing gelap serupa. Gold core di
//    atas casing gelap tetap terbaca sebagai "garis sorotan", bukan jalan.
//
// 2) BADGE PANEL: SOROT_WILAYAH_COLOR dipakai juga sebagai warna aksen badge
//    nama kecamatan terpilih (AnalisisSpasial.jsx) supaya panel & peta terasa
//    satu indikator visual yang sama, bukan dua warna kebetulan mirip.
export const SOROT_WILAYAH_COLOR = '#CA8A04'

/** Warna halo/casing gelap di bawah garis sorotan wilayah — lihat catatan di atas. */
export const SOROT_WILAYAH_HALO_COLOR = '#1F2937'
