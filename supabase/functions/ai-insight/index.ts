// supabase/functions/ai-insight/index.ts
// GeoTransit Insight — Tim MBG
//
// Deploy: supabase functions deploy ai-insight
// Set secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx
//
// Alur (lihat CLAUDE.md):
//   1. Terima { query, area_filter, simulasi } dari frontend:
//        - area_filter = nama kecamatan, opsional
//        - simulasi    = OPSIONAL, pass-through mentah output RPC simulate_new_stop()
//          (penduduk_terlayani_400m/800m, transit_eksisting_terdekat, dst). Kalau
//          dikirim, tahap ACTION narasi mengutip angka "+N jiwa" RIIL dari sini —
//          bukan mengarang. Kalau tidak, ACTION pakai teks rekomendasi_intervensi DB.
//   2. Query skor_equity dari Supabase (skor sudah pasti, dihitung offline), filter per
//      kecamatan kalau area_filter dikirim & cocok
//   3. Kirim skor tsb ke Claude API secara STREAMING (Messages API stream:true),
//      minta narasi berkerangka CCIA (Condition -> Cause -> Impact -> Action) +
//      rekomendasi SMART Spasial (PRD Bab 7.5)
//   4. Forward tiap text delta ke browser sebagai Server-Sent Events (`event: delta`).
//      Setelah stream selesai, jalankan validasi anti-halusinasi pada teks LENGKAP:
//      setiap angka desimal di narasi harus cocok dengan salah satu skor asli ATAU
//      angka simulasi yang dikirim (toleran format titik/koma & pembulatan) — hasilnya
//      (narasi_flagged) dikirim di event terminal `event: done`.
//   5. Respons = text/event-stream. Event: `delta` (0..N) -> `done` (terminal sukses)
//      atau `error` (stream putus di tengah, membawa narasi template pengganti).
//      Fallback template (key kosong / Claude error pra-stream) memakai SSE yang SAMA:
//      1 delta besar + `done` (narasi_source:"template"). KONTRAK SSE lengkap ada di
//      blok komentar tepat di atas `new ReadableStream(...)` di dalam handler.
//      Error pra-stream non-SSE (400/500) tetap JSON `{ error }` — cek res.ok dulu.

import { createClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Model cepat & murah — cocok untuk tugas narasi ringkas dengan target
// acceptance criteria PRD "< 5 detik". Naikkan ke claude-sonnet-5 kalau
// butuh kualitas interpretasi yang lebih dalam (trade-off: lebih lambat).
const MODEL = "claude-haiku-4-5-20251001";

// CORS — WAJIB. Frontend memanggil fungsi ini dari browser (Vercel/localhost)
// lewat supabase-js `functions.invoke`, yang selalu memicu preflight OPTIONS.
// Tanpa header ini, browser memblokir request dan supabase-js melempar
// "Failed to send a request to the Edge Function" (bukan error HTTP dari kode
// di bawah — request-nya memang tidak pernah sampai). "*" aman di sini karena
// fungsi tidak membaca cookie dan tidak mengembalikan data sensitif per-user.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Semua response JSON (non-stream) HARUS lewat sini supaya header CORS tidak
// pernah kelupaan di salah satu jalur return. Dipakai HANYA untuk error
// pra-stream: preflight, body rusak (400), field 'query' kosong (400), dan
// kegagalan Supabase sebelum stream dibuka (500). Begitu stream SSE dibuka,
// semua komunikasi lewat event SSE (lihat KONTRAK SSE di atas handler).
// deno-lint-ignore no-explicit-any
function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Header wajib untuk Server-Sent Events. corsHeaders tetap disertakan karena
// browser memanggil fungsi ini lintas-origin (Vercel/localhost).
const sseHeaders = {
  ...corsHeaders,
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
};

// Serialise satu event SSE: `event: <name>\n` diikuti satu baris `data: <json>\n`
// lalu baris kosong sebagai pemisah. data SELALU JSON satu baris (JSON.stringify
// meng-escape newline), jadi tidak perlu multi-baris `data:`.
// deno-lint-ignore no-explicit-any
function sseChunk(event: string, data: any): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

// Format skor 0-1 -> string 2 desimal dengan koma (konvensi Bahasa Indonesia),
// dipakai narasi template supaya konsisten dengan aturan format di systemPrompt.
function fmtSkor(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2).replace(".", ",") : "-";
}

// Bilangan bulat dengan pemisah ribuan titik (konvensi Bahasa Indonesia),
// dipakai narasi template untuk angka penduduk hasil simulasi What-If.
function fmtJiwa(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString("id-ID") : "-";
}

// Ambil & bersihkan payload simulasi What-If (opsional). Bentuknya = output
// mentah RPC simulate_new_stop() yang diteruskan frontend apa adanya. Return
// null kalau tidak ada / tidak memuat minimal satu angka penduduk terlayani
// (tanpa itu, payload ini tidak berguna untuk tahap ACTION).
// deno-lint-ignore no-explicit-any
function pickSimulasi(raw: any) {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const p400 = num(raw.penduduk_terlayani_400m);
  const p800 = num(raw.penduduk_terlayani_800m);
  if (p400 === undefined && p800 === undefined) return null;
  const t =
    raw.transit_eksisting_terdekat && typeof raw.transit_eksisting_terdekat === "object"
      ? raw.transit_eksisting_terdekat
      : {};
  const lok = raw.lokasi && typeof raw.lokasi === "object" ? raw.lokasi : {};
  return {
    lokasi: { lat: num(lok.lat), lon: num(lok.lon) },
    penduduk_terlayani_400m: p400,
    penduduk_terlayani_800m: p800,
    transit_eksisting_terdekat: {
      nama: typeof t.nama === "string" ? t.nama : undefined,
      jarak_m: num(t.jarak_m),
    },
    estimasi_pengurangan_waktu_tempuh_menit: num(raw.estimasi_pengurangan_waktu_tempuh_menit),
    fasilitas_pendidikan_400m: num(raw.fasilitas_pendidikan_400m),
    fasilitas_kesehatan_400m: num(raw.fasilitas_kesehatan_400m),
  };
}

// Semua angka yang SAH muncul di narasi jalur LLM dari payload simulasi
// (dipakai validasi anti-halusinasi supaya "+N jiwa" riil tidak ikut di-flag).
// deno-lint-ignore no-explicit-any
function angkaDariSimulasi(sim: any): number[] {
  if (!sim) return [];
  const cand = [
    sim.penduduk_terlayani_400m,
    sim.penduduk_terlayani_800m,
    sim.transit_eksisting_terdekat?.jarak_m,
    sim.estimasi_pengurangan_waktu_tempuh_menit,
    sim.fasilitas_pendidikan_400m,
    sim.fasilitas_kesehatan_400m,
  ];
  return cand.filter((v) => Number.isFinite(Number(v))).map((v) => Number(v));
}

// Narasi FALLBACK deterministik (tanpa LLM) — dipakai kalau Claude API tidak
// tersedia (ANTHROPIC_API_KEY belum diset, kredit habis, atau API error).
// PRD final Bab 12 (Risiko & Mitigasi) menjanjikan panel AI tetap menampilkan
// interpretasi berbasis skor model spasial meski layanan AI mati. Angka di sini
// diambil apa adanya dari skor yang sudah dihitung offline — tidak ada angka
// yang dikarang — jadi tidak perlu lewat validasi anti-halusinasi.
// Struktur mengikuti kerangka CCIA (Condition -> Cause -> Impact -> Action),
// sama seperti yang diminta ke Claude di systemPrompt.
// deno-lint-ignore no-explicit-any
function buildTemplateNarasi(
  data: any[],
  ctx: { hasAreaFilter: boolean; areaFilterRaw: string; areaFilterMatched: boolean },
  // deno-lint-ignore no-explicit-any
  simulasi?: any
): string {
  if (!data || data.length === 0) return "Data skor belum tersedia.";

  const cakupan =
    ctx.hasAreaFilter && ctx.areaFilterMatched
      ? `Kecamatan ${ctx.areaFilterRaw}`
      : "Kota Bekasi";

  const top = data[0];
  const namaTop = [top.kelurahan, top.kecamatan].filter(Boolean).join(", ") || "(tanpa nama)";

  const daftar = data
    .map((d, i) => {
      const nama = d.kelurahan ?? "(tanpa nama)";
      const kec = d.kecamatan ? ` (${d.kecamatan})` : "";
      return `${i + 1}. ${nama}${kec} — skor ketimpangan ${fmtSkor(d.skor_ketimpangan)}`;
    })
    .join("; ");

  // Condition — kondisi terukur dari Transit Equity Index
  const condition =
    `Berdasarkan Transit Equity Index untuk ${cakupan}, ${namaTop} menempati peringkat 1 ` +
    `dengan skor ketimpangan ${fmtSkor(top.skor_ketimpangan)} (makin tinggi skor = makin ` +
    `tertinggal akses transitnya). Kelurahan dengan ketimpangan tertinggi: ${daftar}.`;

  // Cause — asal skor + kelompok terdampak (tanpa mengarang kalau null)
  const kelompok = top.kelompok_terdampak
    ? `Kelompok yang paling terdampak di ${top.kelurahan}: ${top.kelompok_terdampak}.`
    : `Analisis kerentanan sosial rinci untuk ${top.kelurahan} belum tersedia dan perlu ditindaklanjuti tim.`;
  const cause =
    `Skor ini dibentuk dari Composite Accessibility Index yang di-inverse lalu dipadukan ` +
    `dengan dimensi kerentanan sosial per kelurahan (usia rentan, akses pendidikan/kesehatan/kerja), ` +
    `dengan bobot tiap dimensi dari AHP pairwise (consistency ratio < 0,1). ${kelompok}`;

  // Impact — konsekuensi kalau dibiarkan
  const impact =
    `Tanpa intervensi, kesenjangan akses transit di kelurahan-kelurahan ini berpotensi ` +
    `terus melebar dibanding wilayah lain di ${cakupan}.`;

  // Action — rekomendasi (pakai yang sudah dirumuskan tim, jangan dikarang)
  const actionDasar = top.rekomendasi_intervensi
    ? `Rekomendasi intervensi untuk ${top.kelurahan}: ${top.rekomendasi_intervensi}`
    : `Rekomendasi intervensi spesifik untuk ${top.kelurahan} belum dirumuskan tim — ` +
      `prioritaskan kajian lapangan lanjutan untuk kelurahan berperingkat teratas di atas.`;

  // Kalau ada hasil Simulasi What-If, lampirkan angka penerima manfaat RIIL
  // (bukan karangan) ke tahap Action — ini yang bikin rekomendasi jadi
  // "Measurable" dalam kerangka SMART Spasial.
  let actionSimulasi = "";
  if (simulasi) {
    const p800 = simulasi.penduduk_terlayani_800m;
    const p400 = simulasi.penduduk_terlayani_400m;
    const namaTransit = simulasi.transit_eksisting_terdekat?.nama;
    const jarakTransit = simulasi.transit_eksisting_terdekat?.jarak_m;
    const potensi = Number.isFinite(Number(p800))
      ? `${fmtJiwa(p800)} jiwa dalam radius jalan kaki 800 m`
      : Number.isFinite(Number(p400))
      ? `${fmtJiwa(p400)} jiwa dalam radius jalan kaki 400 m`
      : null;
    if (potensi) {
      actionSimulasi =
        ` Simulasi penambahan titik transit pada lokasi terpilih memproyeksikan potensi ` +
        `tambahan penerima manfaat sekitar ${potensi}` +
        (Number.isFinite(Number(jarakTransit)) && namaTransit
          ? `; transit eksisting terdekat saat ini adalah ${namaTransit} sejauh ${fmtJiwa(jarakTransit)} m.`
          : `.`);
    }
  }

  // Point per point (BUKAN prosa mengalir) — SELARAS dengan format yang
  // diwajibkan ke Claude di systemPrompt "=== FORMAT OUTPUT ===" (permintaan
  // Sam 2026-09-13), supaya narasi TEMPLATE fallback & narasi AI terlihat
  // sama strukturnya di AIPanel.jsx (whitespace-pre-wrap merender "\n" apa
  // adanya, tidak perlu markdown renderer).
  return [
    `1. Kondisi: ${condition}`,
    `2. Penyebab: ${cause}`,
    `3. Dampak: ${impact}`,
    `4. Aksi: ${actionDasar + actionSimulasi}`,
  ].join("\n\n");
}

Deno.serve(async (req) => {
  // Preflight CORS — balas sebelum menyentuh body/logika apa pun.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Parse body terpisah dari try/catch utama: JSON body yang rusak adalah
  // kesalahan KLIEN (bad request), bukan kegagalan server — harus balas 400,
  // bukan 500 seperti error internal lain di bawah (Supabase/Claude API).
  // deno-lint-ignore no-explicit-any
  let query: any;
  // deno-lint-ignore no-explicit-any
  let area_filter: any;
  // deno-lint-ignore no-explicit-any
  let simulasi: any;
  try {
    const body = await req.json();
    query = body?.query;
    area_filter = body?.area_filter;
    // OPSIONAL — output mentah RPC simulate_new_stop() diteruskan frontend
    // (lihat AIPanel.jsx). Boleh tidak ada; dibersihkan lewat pickSimulasi().
    simulasi = body?.simulasi;
  } catch (_parseErr) {
    return jsonResponse({ error: "Body request bukan JSON yang valid" }, 400);
  }

  try {
    if (!query) {
      return jsonResponse({ error: "Field 'query' wajib diisi" }, 400);
    }
    // ANTHROPIC_API_KEY yang kosong BUKAN lagi error fatal — di bawah kita
    // fallback ke narasi template deterministik (PRD final Bab 12). Panel AI
    // harus tetap bisa didemokan ke juri walau kredit Anthropic belum aktif.

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // 1. Ambil skor yang sudah dihitung offline — Claude hanya boleh
    //    MENJELASKAN angka ini, tidak boleh menghitung/menebak sendiri.
    //
    // area_filter (opsional, string nama kecamatan, case-insensitive) — kontrak field
    // ini SUDAH ditentukan bersama frontend, jangan diganti namanya.
    // Kolom nama_kecamatan ada di batas_administrasi (lihat 001_init_tables.sql), yang
    // terhubung ke skor_equity lewat kelurahan_id -> batas_administrasi.id.
    //
    // Catatan teknis PostgREST: filter pada tabel yang di-embed (`batas_administrasi.*`)
    // hanya benar-benar membatasi baris skor_equity kalau relasinya pakai `!inner`
    // (inner join) — tanpa itu, filter cuma memengaruhi isi objek embed, bukan baris
    // top-level yang dikembalikan. Makanya pakai `batas_administrasi!inner(...)` di sini.
    const areaFilterRaw = typeof area_filter === "string" ? area_filter.trim() : "";
    const hasAreaFilter = areaFilterRaw.length > 0;

    const selectColumns =
      "skor_final, ranking, kelompok_terdampak, rekomendasi_intervensi, " +
      (hasAreaFilter
        ? "batas_administrasi!inner(nama_kelurahan, nama_kecamatan)"
        : "batas_administrasi(nama_kelurahan, nama_kecamatan)");

    // FIX (27 Agu 2026, data-ai-analyst): `sumber` WAJIB difilter sebelum
    // order('ranking').limit(N) — lihat 010_skor_equity_sumber.sql. Tabel
    // skor_equity sekarang berisi 5 baris DUMMY (ranking 1-5, testing) DAN
    // 56 baris REAL (ranking 1-56, agregasi 56 kelurahan RBI asli) SEKALIGUS
    // — keduanya punya ranking mulai dari 1, jadi tanpa filter ini query
    // top-5 bisa mengembalikan campuran ranking=1 dummy & ranking=1 real
    // secara tidak terduga. Prioritaskan REAL (data sungguhan Kota Bekasi);
    // ilike dipakai (bukan eq) karena nilai `sumber` REAL menyertakan detail
    // dinamis (mis. "REAL - agregasi lokal (... n=4)"), bukan string tetap.
    let queryBuilder = supabase
      .from("skor_equity")
      .select(selectColumns)
      .ilike("sumber", "REAL%")
      .order("ranking", { ascending: true })
      .limit(5);

    // FIX (6 Sep 2026, data-ai-analyst): pencocokan kecamatan HARUS
    // space-insensitive + case-insensitive. DB menyimpan 8 kecamatan sebagai
    // satu kata (Mustikajaya, Rawalumbu, Jatiasih, Jatisampurna, Medansatria,
    // Pondokgede, Pondokmelati, Bantargebang) sedangkan dropdown UI mengirim
    // versi berspasi ("Mustika Jaya", dst) — `.ilike(col, "Mustika Jaya")`
    // exact-match diam-diam gagal (QA: 8/12 filter rusak). Solusi: ganti setiap
    // runtun whitespace di input jadi wildcard `%`, jadi "Mustika Jaya" ->
    // "Mustika%Jaya" yang cocok baik "Mustikajaya" (0 char) maupun "Mustika
    // Jaya" (1 spasi). 4 kecamatan yang MEMANG berspasi di DB (Bekasi
    // Timur/Barat/Utara/Selatan) tetap cocok: "Bekasi Timur" -> "Bekasi%Timur".
    // Pola tetap ter-anchor di kedua ujung (tanpa % pembungkus) sehingga tidak
    // salah tangkap kecamatan lain.
    const areaFilterPattern = areaFilterRaw.replace(/\s+/g, "%");

    if (hasAreaFilter) {
      queryBuilder = queryBuilder.ilike(
        "batas_administrasi.nama_kecamatan",
        areaFilterPattern
      );
    }

    let { data: skorRows, error } = await queryBuilder;
    if (error) throw error;

    let areaFilterMatched = true;
    let areaFilterNote: string | null = null;

    if (hasAreaFilter && (!skorRows || skorRows.length === 0)) {
      // Tidak ada kecamatan yang cocok — fallback ke semua data, dengan catatan
      // eksplisit di response supaya user tahu filter-nya tidak diterapkan.
      areaFilterMatched = false;
      areaFilterNote =
        `Kecamatan '${areaFilterRaw}' tidak ditemukan di data — menampilkan hasil ` +
        `untuk seluruh Kota Bekasi sebagai fallback.`;

      const fallback = await supabase
        .from("skor_equity")
        .select("skor_final, ranking, kelompok_terdampak, rekomendasi_intervensi, batas_administrasi(nama_kelurahan, nama_kecamatan)")
        // Sama seperti query utama di atas: WAJIB filter sumber REAL supaya
        // tidak campur dengan 5 baris DUMMY (ranking 1-5) — lihat catatan FIX
        // di query utama.
        .ilike("sumber", "REAL%")
        .order("ranking", { ascending: true })
        .limit(5);
      if (fallback.error) throw fallback.error;
      skorRows = fallback.data;
    }

    // Fallback TERAKHIR: kalau tidak ada satu pun baris REAL sama sekali
    // (mis. environment testing/lokal sebelum data 56 kelurahan RBI
    // diupload — lihat etl/aggregate_equity_kelurahan.py), pakai baris
    // DUMMY apa adanya supaya dashboard tidak kosong total saat development,
    // TAPI catat eksplisit di response (areaFilterNote) supaya tidak
    // disalahartikan sebagai data Kota Bekasi sungguhan.
    if (!skorRows || skorRows.length === 0) {
      const dummyFallback = await supabase
        .from("skor_equity")
        .select("skor_final, ranking, kelompok_terdampak, rekomendasi_intervensi, batas_administrasi(nama_kelurahan, nama_kecamatan)")
        .order("ranking", { ascending: true })
        .limit(5);
      if (dummyFallback.error) throw dummyFallback.error;
      if (dummyFallback.data && dummyFallback.data.length > 0) {
        skorRows = dummyFallback.data;
        areaFilterNote =
          (areaFilterNote ? areaFilterNote + " " : "") +
          "PERINGATAN: belum ada data skor_equity REAL (56 kelurahan) di database ini — " +
          "menampilkan data sintetis/testing, BUKAN hasil analisis Kota Bekasi sungguhan.";
      }
    }

    if (!skorRows || skorRows.length === 0) {
      // Tidak ada data sama sekali — tetap balas lewat SSE yang sama (satu code
      // path di frontend): satu delta berisi pesan, lalu event `done`.
      const kosongNarasi =
        "Data skor belum tersedia — jalankan pipeline compute_scores lalu upload ke Supabase terlebih dahulu.";
      const kosongStream = new ReadableStream({
        start(controller) {
          controller.enqueue(sseChunk("delta", { text: kosongNarasi }));
          controller.enqueue(
            sseChunk("done", {
              narasi: kosongNarasi,
              ranking: [],
              narasi_flagged: false,
              flagged_reason: null,
              narasi_source: "template",
              narasi_note: null,
              simulasi_dipakai: null,
              area_filter: {
                requested: hasAreaFilter ? areaFilterRaw : null,
                applied: hasAreaFilter,
                matched: areaFilterMatched,
                note: areaFilterNote,
              },
            })
          );
          controller.close();
        },
      });
      return new Response(kosongStream, { headers: sseHeaders });
    }

    // NOTE field internal (bukan skema DB): key dikirim ke Claude sebagai
    // "skor_ketimpangan", bukan "skor_equity" — supaya nama field itu sendiri
    // sudah menyiratkan arah skala ke model (skor makin tinggi = makin
    // timpang), mengurangi risiko LLM salah tafsir "equity" sebagai "makin
    // tinggi makin adil". Nama kolom Supabase (skor_equity, tabel skor_equity)
    // TIDAK berubah — ini murni field JSON di payload prompt & sepenuhnya
    // independen dari skema database.
    const promptData = skorRows.map((r: any) => ({
      kelurahan: r.batas_administrasi?.nama_kelurahan,
      kecamatan: r.batas_administrasi?.nama_kecamatan,
      skor_ketimpangan: r.skor_final,
      ranking: r.ranking,
      kelompok_terdampak: r.kelompok_terdampak,
      rekomendasi_intervensi: r.rekomendasi_intervensi,
    }));

    // Payload simulasi What-If (opsional) — kalau ada, tahap ACTION narasi
    // WAJIB mengutip angka penduduk terlayani dari sini (bukan mengarang).
    const simulasiData = pickSimulasi(simulasi);

    // Versi payload simulasi yang AMAN dikirim ke Claude: TANPA properti
    // "lokasi" (lat/lon). Koordinat mentah tidak boleh masuk teks prompt LLM
    // (CLAUDE.md: "bukan raw coordinates dikirim ke LLM"). Angka manfaat
    // (penduduk_terlayani_*, jarak_m, waktu tempuh, hitungan fasilitas) tetap
    // dikirim. simulasiData penuh tetap dipakai internal (validasi angka) &
    // boleh dikembalikan ke frontend.
    const simulasiUntukLLM = simulasiData
      ? (({ lokasi: _lokasi, ...rest }) => rest)(simulasiData)
      : null;

    const systemPrompt = `Kamu adalah AI Spatial Consultant untuk Dishub & Bappeda Kota Bekasi.
Tugasmu MENJELASKAN skor yang sudah dihitung model spasial deterministik — bukan menghitung,
menebak, atau menambah angka. Kamu tidak pernah menghasilkan skor sendiri.

=== PANJANG ===
Ringkas tapi LENGKAP — cukupkan tiap POIN CCIA menyampaikan isinya, jangan bertele-tele,
jangan mengulang. Perkiraan 150-220 kata untuk KESELURUHAN narasi (4 poin digabung); ini
perkiraan, bukan batas keras — JANGAN mengorbankan kelengkapan isi demi menekan jumlah kata.
Yang wajib: keempat poin (Condition, Cause, Impact, Action) utuh tersampaikan dan narasi
TIDAK terpotong di tengah kalimat — khususnya poin Action beserta angka "+N jiwa"-nya harus
selesai penuh. Setelah kalimat terakhir poin Action, BERHENTI: tidak ada penutup, ringkasan,
atau kalimat tambahan apa pun.

=== FORMAT OUTPUT (WAJIB — point per point, BUKAN prosa mengalir) ===
Output HARUS 4 poin bernomor "1." sampai "4.", SATU POIN PER PARAGRAF (pisahkan tiap poin
dengan SATU baris kosong — yaitu DUA karakter baris baru berturutan di antara poin; jangan
gabung dua poin jadi satu baris/paragraf). Tiap poin diawali label tahapnya persis begini
(angka + titik + spasi + label + titik dua + spasi, lalu isi):
  1. Kondisi: <isi>
  2. Penyebab: <isi>
  3. Dampak: <isi>
  4. Aksi: <isi>
DILARANG KERAS: heading markdown ("#"), teks tebal "**", bullet "-"/"*", sub-list bernomor
di dalam satu poin, garis pemisah "---", atau kalimat pembuka/penutup di luar keempat poin
itu (langsung mulai dari "1. Kondisi:", langsung berhenti setelah kalimat terakhir "4. Aksi:").
Tiap poin sendiri tetap satu paragraf mengalir (boleh lebih dari satu kalimat) — yang
dilarang adalah menggabung ISI ANTAR poin jadi satu paragraf besar tanpa nomor/label.

=== KERANGKA WAJIB: CCIA (Condition -> Cause -> Impact -> Action) ===
Bangun keempat poin HANYA di sekitar SATU kelurahan fokus: yang "ranking":1
(skor_ketimpangan tertinggi). JANGAN mengulang kerangka CCIA untuk tiap kelurahan;
kelurahan lain cukup disinggung ringkas (nama + skor_ketimpangan) di poin Kondisi.
1. CONDITION (Kondisi): sebut kelurahan fokus (ranking 1) beserta skor ketimpangannya dan
   kondisi terukur akses transitnya untuk cakupan yang diminta; sisipkan singkat kelurahan
   lain (nama + skor) sebagai konteks.
2. CAUSE (Penyebab): skor berasal dari Composite Accessibility Index yang di-inverse lalu
   dipadukan dengan dimensi kerentanan sosial (usia rentan, akses pendidikan/kesehatan/kerja),
   dengan bobot hasil AHP pairwise (CR < 0,1). Jangan menghitung ulang / mengarang sub-skor
   CAI/TDI per kriteria — data tidak memuatnya.
   ISTILAH WAJIB DIBEDAKAN (jangan pernah tertukar): sebutan di atas adalah "consistency ratio"
   atau disingkat "CR" — validitas matriks pairwise AHP, BUKAN "confidence ratio". "Confidence
   ratio"/"confidence" adalah metrik LAIN (keandalan skor per lokasi terhadap kondisi lapangan)
   yang HANYA boleh disebut kalau field "confidence"/"confidence_ratio" benar-benar ada di data
   yang dilampirkan — kalau tidak ada di data, jangan sebut "confidence ratio" sama sekali.
3. IMPACT (Dampak): konsekuensi konkret bila tanpa intervensi BAGI "kelompok_terdampak" dari
   data (mis. lansia, pelajar, warga tanpa kendaraan): mobilitas makin terbatas, kesenjangan
   makin lebar. Bila "kelompok_terdampak" null, nyatakan profilnya belum tersedia dan perlu
   tindak lanjut tim — jangan mengarang kelompoknya.
4. ACTION (Aksi): rumuskan rekomendasi intervensi SMART Spasial dengan MEMPARAFRASE isi
   "rekomendasi_intervensi" dari data — JANGAN menyalin string panjangnya verbatim (500+ char),
   olah jadi kalimat yang mudah dibaca pejabat non-teknis. Meski diparafrase, ACTION WAJIB tetap
   memuat detail SMART Spasial LENGKAP dari data: nama koridor/ruas jalan, radius layanan
   (mis. "< 400 m"), dan jam operasi feeder bila disebut di data. Relevan dengan transit massal
   (halte/feeder BisKita Trans Patriot, integrasi KRL/LRT Jabodebek). BUKAN imbauan umum seperti
   "prioritaskan Kecamatan X". URUTAN KALIMAT ACTION: bila objek "simulasi_what_if" dilampirkan,
   MULAI dari angka potensi tambahan penerima manfaat ("berpotensi melayani tambahan N jiwa dalam
   radius jalan kaki 800 m"), BARU sebutkan koridor, radius, dan jam operasi feeder sesudahnya.
   Bila "rekomendasi_intervensi" null, nyatakan rekomendasi detail belum dirumuskan tim.

=== ANGKA UNTUK TAHAP ACTION ===
- Bila data memuat objek "simulasi_what_if": tahap ACTION WAJIB MEMBUKA dengan
  "penduduk_terlayani_800m" (atau "penduduk_terlayani_400m" bila 800m tidak ada) dari objek itu
  sebagai potensi tambahan penerima manfaat — angka ini muncul DI AWAL kalimat Action, sebelum
  detail koridor/radius/jam, mis. "berpotensi melayani tambahan N jiwa dalam radius jalan kaki
  800 m". Boleh menyebut "transit_eksisting_terdekat" dan "estimasi_pengurangan_waktu_tempuh_menit"
  dari objek itu. Jangan mengarang angka lain.
- Bila TIDAK ada objek "simulasi_what_if": PARAFRASE teks "rekomendasi_intervensi" jadi kalimat
  Action (tetap sertakan koridor/radius/jam bila ada di teksnya), dan JANGAN menyebut angka
  penerima manfaat "+N jiwa" yang tidak ada di data (jangan mengarang).

=== ARAH SKALA (jangan dibalik) ===
"skor_ketimpangan" = skor KETIMPANGAN/kesenjangan akses transit, BUKAN skor keadilan. Makin
TINGGI = kelurahan makin TERTINGGAL/DIRUGIKAN. "ranking": 1 = skor_ketimpangan paling tinggi
= paling butuh prioritas. JANGAN pernah menyimpulkan "skor tinggi = akses bagus" atau
"ranking 1 = paling adil" — itu terbalik dan menyesatkan.

=== FORMAT ===
- Bahasa Indonesia, untuk pembaca pejabat non-teknis.
- Skor: maksimal 2 desimal, pemisah desimal koma (contoh: 0,46). JANGAN diubah ke persen.
- Jumlah penduduk: bilangan bulat, boleh pakai pemisah ribuan titik (contoh: 12.500).
- JANGAN menghitung ulang atau menambah angka apa pun di luar data yang diberikan.
- DILARANG membuat, menjumlahkan, merata-ratakan, mempersentasekan, atau memproyeksikan
  angka baru. SETIAP angka dalam narasi harus sudah muncul persis di data yang diberikan
  (skor_ketimpangan, ranking, atau objek "simulasi_what_if"). Tidak ada pengecualian —
  termasuk estimasi "+N jiwa terlayani" bila "simulasi_what_if" TIDAK dilampirkan: dalam
  kasus itu tahap ACTION memparafrase teks "rekomendasi_intervensi" tanpa angka manfaat.
- Angka yang boleh muncul di narasi TERBATAS pada: "skor_ketimpangan"/"ranking" dari data,
  angka di dalam objek "simulasi_what_if", dan ambang "0,1" (CR AHP). Selain itu: tidak ada.
- Bila "kelompok_terdampak" atau "rekomendasi_intervensi" bernilai null untuk suatu kelurahan,
  nyatakan eksplisit bahwa analisis/rekomendasi detail untuk kelurahan itu belum tersedia dan
  perlu tindak lanjut tim — jangan mengarang.`;

    // Isi pesan user ke Claude — sama untuk jalur stream. promptData & simulasi
    // (tanpa koordinat) dikirim sebagai konteks; LLM hanya MENJELASKAN.
    const userContent =
      `Pertanyaan pengguna: ${query}\n\n` +
      `Cakupan: ${
        hasAreaFilter && areaFilterMatched
          ? `Kecamatan ${areaFilterRaw}`
          : "seluruh Kota Bekasi"
      }\n\n` +
      `Data skor (ranking ketimpangan tertinggi lebih dulu):\n` +
      `${JSON.stringify(promptData, null, 2)}\n\n` +
      (simulasiUntukLLM
        ? `simulasi_what_if (kutip angka INI di tahap ACTION; tanpa koordinat):\n` +
          `${JSON.stringify(simulasiUntukLLM, null, 2)}`
        : `(Tidak ada hasil Simulasi What-If dilampirkan — tahap ACTION pakai teks ` +
          `rekomendasi_intervensi, jangan mengarang angka penerima manfaat.)`);

    // Narasi FALLBACK template deterministik — dipakai bila ANTHROPIC_API_KEY
    // kosong ATAU Claude gagal (pra-stream / putus di tengah). buildTemplateNarasi()
    // TIDAK diubah; angka di dalamnya langsung dari promptData/simulasiData.
    const templateNarasi = buildTemplateNarasi(
      promptData,
      { hasAreaFilter, areaFilterRaw, areaFilterMatched },
      simulasiData
    );

    // 2. Validasi anti-halusinasi: setiap angka desimal yang disebut narasi harus
    //    cocok dengan salah satu skor_equity asli yang dikirim ke Claude.
    //
    //    Kenapa bukan `narasi.includes(skor.toString())` seperti versi lama: toString()
    //    JS selalu pakai titik desimal ("0.4567"), sementara system prompt minta Claude
    //    menjawab Bahasa Indonesia yang konvensinya pakai koma ("0,4567") — jadi hampir
    //    selalu false-mismatch meski narasinya benar. Di sini kita:
    //      a) toleran format titik ATAU koma sebagai pemisah desimal,
    //      b) toleran pembulatan (Claude sering menulis "0,46" utk skor 0.4567),
    //      c) toleran kalau angka ditulis sebagai bentuk skala-100 tanpa simbol '%'
    //         eksplisit (mis. "45,67" utk 0.4567) — bentuk ini tetap bisa lolos toleransi
    //         supaya tidak over-flag narasi yang sebenarnya valid.
    //    Kalau ADA angka desimal di narasi yang tidak cocok skor manapun ATAU angka
    //    simulasi manapun (di luar toleransi ini), respons ditandai narasi_flagged=true
    //    — bukan cuma console.warn — supaya frontend bisa menampilkan peringatan ke user
    //    (sesuai prinsip CLAUDE.md: "setiap skor harus bisa ditelusuri").
    //
    //    Token angka yang dicek: hanya yang PUNYA pemisah (titik/koma). Ini menangkap
    //    dua bentuk sekaligus: skor desimal ("0,46") DAN jumlah penduduk ber-pemisah
    //    ribuan ("12.500"). Bilangan bulat polos tanpa pemisah ("15 jiwa", "2026")
    //    sengaja diabaikan — terlalu banyak angka wajar (tahun, hitungan) yang bukan
    //    indikasi halusinasi.
    function extractNumberTokens(text: string): string[] {
      return text.match(/\d+[.,]\d+/g) || [];
    }

    // Angka yang SAH: skor ketimpangan (0-1) + semua angka dari payload simulasi.
    const skorAsli = promptData
      .map((d) => Number(d.skor_ketimpangan))
      .filter((n) => Number.isFinite(n));
    const angkaSimulasiValid = angkaDariSimulasi(simulasiData);

    // Teks sumber yang MEMANG dikirim ke model dan boleh dikutip apa adanya di
    // tahap ACTION (SMART Spasial): rekomendasi_intervensi + kelompok_terdampak
    // dari DB. Angka di dalamnya (jam operasi "05.30-08.00", radius "< 400 m",
    // spasi halte, tahap bulan) adalah bagian rekomendasi tim yang sudah
    // divalidasi — kalau narasi mengutipnya verbatim itu BUKAN halusinasi.
    // Ini menutup celah false-positive kerangka CCIA baru; deteksi angka KARANGAN
    // (skor/proyeksi yang tidak ada di data manapun) tetap jalan seperti semula.
    const sumberTeksAction = promptData
      .flatMap((d) => [
        typeof d.rekomendasi_intervensi === "string" ? d.rekomendasi_intervensi : "",
        Array.isArray(d.kelompok_terdampak)
          ? d.kelompok_terdampak.join(" ")
          : typeof d.kelompok_terdampak === "string"
          ? d.kelompok_terdampak
          : "",
      ])
      .join(" \n ");

    function tokenCocok(token: string): boolean {
      // Interpretasi (a): pemisah = desimal -> bandingkan dengan skor 0-1.
      const desimal = parseFloat(token.replace(",", "."));
      if (
        skorAsli.some(
          (s) =>
            Math.abs(desimal - s) < 0.005 || // pembulatan 2 desimal
            Math.abs(desimal - s) < 0.05 || // pembulatan 1 desimal
            Math.abs(desimal / 100 - s) < 0.005 // ditulis skala 0-100
        )
      ) {
        return true;
      }
      // Interpretasi (b): pemisah = ribuan -> bilangan bulat (mis. "12.500" -> 12500).
      const bulat = parseInt(token.replace(/[.,]/g, ""), 10);
      if (
        Number.isFinite(bulat) &&
        angkaSimulasiValid.some((n) => Math.abs(bulat - n) <= Math.max(1, n * 0.02))
      ) {
        return true;
      }
      // Interpretasi (c): angka simulasi kecil ber-desimal (mis. menit "5,3").
      if (angkaSimulasiValid.some((n) => Math.abs(desimal - n) < 0.15)) return true;
      // Interpretasi (d): token muncul VERBATIM di teks rekomendasi_intervensi /
      // kelompok_terdampak yang dikirim ke model — kutipan setia, bukan karangan
      // (mis. jam operasi feeder "05.30-08.00" -> token "05.30" & "08.00").
      if (token.length >= 3 && sumberTeksAction.includes(token)) return true;
      // Interpretasi (e): ambang consistency ratio AHP yang eksplisit diizinkan
      // systemPrompt ("bobot hasil AHP pairwise (CR < 0,1)").
      if (token === "0,1" || token === "0.1") return true;
      return false;
    }

    // Payload yang identik untuk SEMUA jalur terminal (done / error) — dihitung
    // sekali. ranking pakai key "skor" (kontrak lama AIPanel.jsx, jangan diubah).
    const doneCommon = {
      ranking: promptData.map((d) => ({
        kelurahan: d.kelurahan,
        skor: d.skor_ketimpangan,
        kecamatan: d.kecamatan,
        kelompok_terdampak: d.kelompok_terdampak,
        rekomendasi_intervensi: d.rekomendasi_intervensi,
      })),
      area_filter: {
        requested: hasAreaFilter ? areaFilterRaw : null,
        applied: hasAreaFilter,
        matched: areaFilterMatched,
        note: areaFilterNote,
      },
      // Konfirmasi apakah payload Simulasi What-If dipakai untuk tahap ACTION.
      // null = tidak dikirim / tidak valid (tanpa angka penduduk terlayani).
      simulasi_dipakai: simulasiData
        ? {
            penduduk_terlayani_400m: simulasiData.penduduk_terlayani_400m ?? null,
            penduduk_terlayani_800m: simulasiData.penduduk_terlayani_800m ?? null,
          }
        : null,
    };

    // ================================================================
    //  KONTRAK SSE (untuk webgis-developer — AIPanel.jsx implement PERSIS ini)
    // ----------------------------------------------------------------
    //  Response 200, Content-Type: text/event-stream. HANYA status non-200
    //  (400 body rusak / query kosong, 500 gagal Supabase pra-stream) yang
    //  berupa JSON biasa `{ error }` — cek `res.ok` sebelum membaca stream.
    //
    //  Urutan event:
    //    1. `event: delta`  (0..N kali)   data: { "text": "<potongan narasi>" }
    //         Sambung semua .text sesuai urutan tiba = narasi lengkap.
    //         Jalur template mengirim SATU delta besar berisi seluruh narasi.
    //    2. `event: done`   (1 kali, terminal-sukses)  data:
    //         {
    //           "narasi": string,              // narasi final LENGKAP (= gabungan semua delta)
    //           "narasi_source": "ai"|"template",
    //           "narasi_flagged": boolean,     // true = ada angka tak cocok skor/simulasi
    //           "flagged_reason": string|null,
    //           "narasi_note": string|null,    // catatan utk ditampilkan bila source=template
    //           "stop_reason": string|null,    // dari Claude (mis. "end_turn"); null utk template
    //           "ranking": [ { kelurahan, skor, kecamatan, kelompok_terdampak, rekomendasi_intervensi } ],
    //           "area_filter": { requested, applied, matched, note },
    //           "simulasi_dipakai": { penduduk_terlayani_400m, penduduk_terlayani_800m } | null
    //         }
    //    3. `event: error` (1 kali, terminal-gagal — MENGGANTIKAN `done`, tidak ada `done` sesudahnya)
    //         Dikirim HANYA bila stream Claude putus SETELAH beberapa delta terkirim.
    //         Membawa payload lengkap + narasi template pengganti supaya frontend
    //         cukup MEMBUANG teks delta yang sudah terkumpul dan memakai `.narasi`:
    //         {
    //           "error": string,               // pesan teknis singkat
    //           "recovered": true,
    //           "narasi": string,              // narasi TEMPLATE pengganti (pakai ini)
    //           "narasi_source": "template",
    //           "narasi_flagged": false,
    //           "flagged_reason": null,
    //           "narasi_note": string,
    //           "stop_reason": null,
    //           "ranking": [...], "area_filter": {...}, "simulasi_dipakai": ... (sama seperti done)
    //         }
    //    Kegagalan PRA-stream (API key kosong / Claude non-OK / fetch gagal) TIDAK
    //    memakai `event: error` — langsung jalur template: 1 delta besar + `done`
    //    (narasi_source:"template"). Jadi frontend hanya perlu menangani delta+done,
    //    plus error sebagai kasus "ganti teks".
    //
    //    Kasus lain yang JUGA jatuh ke jalur template di atas (1 delta besar +
    //    `done` narasi_source:"template", BUKAN `event: error`) meski beberapa
    //    delta AI sempat terkirim lebih dulu: stream Claude selesai NORMAL
    //    (bukan putus) tapi `stop_reason === "max_tokens"` — narasi asli
    //    terpotong sebelum kalimat selesai, jadi seluruh teks yang terkumpul
    //    dibuang dan diganti template LENGKAP. Frontend tidak perlu kode baru:
    //    `done.narasi` selalu MENIMPA penuh teks yang sempat ter-stream (lihat
    //    `applyTerminal` di AIPanel.jsx yang meng-assign `text: data.narasi`,
    //    bukan menyambungnya ke delta sebelumnya), jadi delta parsial sebelum
    //    `done` ini otomatis tidak pernah terlihat final oleh user.
    //
    //  Contoh mentah (curl -N):
    //    event: delta
    //    data: {"text":"Kelurahan Padurenan menempati peringkat 1 "}
    //
    //    event: delta
    //    data: {"text":"dengan skor ketimpangan 0,82..."}
    //
    //    event: done
    //    data: {"narasi":"Kelurahan Padurenan ...","narasi_source":"ai","narasi_flagged":false,...}
    // ================================================================
    const stream = new ReadableStream({
      async start(controller) {
        // deno-lint-ignore no-explicit-any
        const send = (event: string, data: any) =>
          controller.enqueue(sseChunk(event, data));

        // Jalur template lewat SSE yang sama: 1 delta besar + done.
        const emitTemplate = (note: string | null) => {
          send("delta", { text: templateNarasi });
          send("done", {
            ...doneCommon,
            narasi: templateNarasi,
            narasi_source: "template",
            narasi_flagged: false,
            flagged_reason: null,
            narasi_note: note,
            stop_reason: null,
          });
          controller.close();
        };

        // --- Pra-stream: tidak ada API key -> template ---
        if (!ANTHROPIC_API_KEY) {
          emitTemplate(
            "ANTHROPIC_API_KEY belum diset — narasi disusun dari template deterministik " +
              "berbasis skor model spasial. Angka & ranking tetap akurat."
          );
          return;
        }

        // --- Buka stream ke Claude Messages API ---
        let claudeRes: Response;
        try {
          claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              // 900 (naik dari 420): dengan streaming, total token TIDAK lagi
              // menentukan latensi yang dirasakan user (token pertama ~1,5-2s).
              // 420 dulu memotong ~7/10 narasi jalur simulasi di tengah kalimat
              // & 3/10 kehilangan angka "+N jiwa" (komponen Measurable SMART).
              // Target isi 150-220 kata (~300-450 token) + margin aman -> 900.
              max_tokens: 900,
              stream: true,
              // systemPrompt statis -> tandai cacheable (prefix reuse antar-request).
              system: [
                {
                  type: "text",
                  text: systemPrompt,
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: [{ role: "user", content: userContent }],
            }),
          });
        } catch (netErr) {
          const m = netErr instanceof Error ? netErr.message : String(netErr);
          console.warn(`[ai-insight] fetch Claude gagal (pra-stream): ${m}`);
          emitTemplate(
            "Layanan AI sedang tidak tersedia — narasi disusun dari template deterministik " +
              "berbasis skor model spasial. Angka & ranking tetap akurat."
          );
          return;
        }

        if (!claudeRes.ok || !claudeRes.body) {
          let errText = "";
          try {
            errText = await claudeRes.text();
          } catch (_e) {
            /* body mungkin sudah habis / tidak ada */
          }
          console.warn(
            `[ai-insight] Claude non-OK ${claudeRes.status}: ${errText.slice(0, 300)}`
          );
          emitTemplate(
            "Layanan AI sedang tidak tersedia — narasi disusun dari template deterministik " +
              "berbasis skor model spasial. Angka & ranking tetap akurat."
          );
          return;
        }

        // --- Parse SSE Anthropic, forward text delta ke browser ---
        let full = "";
        let deltaTerkirim = 0;
        let stopReason: string | null = null;
        try {
          const reader = claudeRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
              const rawEvent = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataStr = rawEvent
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("");
              if (!dataStr || dataStr === "[DONE]") continue;
              // deno-lint-ignore no-explicit-any
              let evt: any;
              try {
                evt = JSON.parse(dataStr);
              } catch (_e) {
                continue;
              }
              if (
                evt.type === "content_block_delta" &&
                evt.delta?.type === "text_delta"
              ) {
                const piece: string = evt.delta.text ?? "";
                if (piece) {
                  full += piece;
                  send("delta", { text: piece });
                  deltaTerkirim++;
                }
              } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
                stopReason = evt.delta.stop_reason;
              } else if (evt.type === "error") {
                throw new Error(
                  `Claude stream error: ${JSON.stringify(evt.error ?? evt)}`
                );
              }
              // message_start / content_block_start|stop / message_stop / ping: diabaikan
            }
          }
        } catch (streamErr) {
          const m = streamErr instanceof Error ? streamErr.message : String(streamErr);
          console.warn(
            `[ai-insight] stream Claude putus di tengah (${deltaTerkirim} delta terkirim): ${m}`
          );
          // Keputusan (didokumentasikan): stream putus SETELAH sebagian delta
          // terkirim -> kirim `event: error` yang membawa narasi TEMPLATE penuh
          // + payload done-lengkap. Frontend membuang delta yang sudah terkumpul
          // dan memakai `.narasi`. Tidak ada `done` sesudah `error`. Tidak perlu
          // panggilan kedua dari frontend.
          send("error", {
            error: m,
            recovered: true,
            ...doneCommon,
            narasi: templateNarasi,
            narasi_source: "template",
            narasi_flagged: false,
            flagged_reason: null,
            narasi_note:
              "Koneksi ke layanan AI terputus di tengah proses — narasi diganti " +
              "template deterministik berbasis skor. Angka & ranking tetap akurat.",
            stop_reason: null,
          });
          controller.close();
          return;
        }

        // --- Stream Claude selesai normal ---
        // Kalau Claude tidak mengirim satu pun teks (mis. langsung stop) —
        // perlakukan sebagai kegagalan lembut, jatuh ke template.
        if (deltaTerkirim === 0) {
          emitTemplate(
            "Layanan AI tidak mengembalikan teks — fallback ke template deterministik. " +
              "Angka & ranking tetap akurat."
          );
          return;
        }

        // Claude berhenti karena mencapai batas `max_tokens` SEBELUM narasi
        // selesai -> `full` yang sudah terkumpul adalah kalimat terpotong,
        // paling berbahaya kalau kejadian di tahap Action (angka "+N jiwa"
        // ikut hilang/terpotong — lihat komentar max_tokens di atas). Jangan
        // pernah kirim narasi sebagian ke user: buang `full`, fallback ke
        // template LENGKAP lewat jalur done/narasi_source:"template" yang
        // sama seperti cabang deltaTerkirim === 0 di atas (bukan `event:
        // error` — lihat KONTRAK SSE: error dipakai utk stream yang PUTUS,
        // bukan yang selesai normal tapi kepotong batas token).
        if (stopReason === "max_tokens") {
          console.warn(
            `[ai-insight] narasi terpotong oleh batas max_tokens (${deltaTerkirim} delta, ` +
              `${full.length} char terkumpul) -> fallback template`
          );
          emitTemplate(
            "Narasi AI terpotong karena mencapai batas token (max_tokens) sebelum kalimat " +
              "selesai — diganti template deterministik berbasis skor model spasial supaya " +
              "tidak menampilkan narasi yang berhenti di tengah kalimat. Angka & ranking tetap akurat."
          );
          return;
        }

        // Validasi anti-halusinasi dijalankan pada teks LENGKAP (akumulasi semua
        // delta), lalu dikirim di event terminal `done`.
        const narasi = full.trim();
        const tokenTidakCocok = extractNumberTokens(narasi).filter(
          (t) => !tokenCocok(t)
        );
        const narasiFlagged = tokenTidakCocok.length > 0;
        const flaggedReason = narasiFlagged
          ? `Narasi AI menyebut angka (${tokenTidakCocok.join(", ")}) yang tidak cocok dengan ` +
            `skor asli maupun angka simulasi What-If manapun dari data (toleransi pembulatan). ` +
            `Perlu ditinjau manual sebelum dipercaya sepenuhnya.`
          : null;
        if (narasiFlagged) {
          console.warn(
            `[ai-insight] narasi_flagged=true — angka tidak cocok: ${tokenTidakCocok.join(", ")}`
          );
        }

        send("done", {
          ...doneCommon,
          narasi,
          narasi_source: "ai",
          narasi_flagged: narasiFlagged,
          flagged_reason: flaggedReason,
          narasi_note: null,
          stop_reason: stopReason,
        });
        controller.close();
      },
    });

    return new Response(stream, { headers: sseHeaders });
  } catch (err) {
    console.error(err);
    // err bisa berupa Error biasa, atau object error mentah dari Supabase
    // (mis. PostgrestError) — String(err) pada object polos menghasilkan
    // "[object Object]" yang tidak berguna, jadi ambil .message kalau ada.
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    return jsonResponse({ error: message }, 500);
  }
});
