// qa/ai-antihalusinasi-trace-2026-09-08.mjs
// Independent number-trace of ai-insight narratives: every decimal/thousands
// token in the narrative must trace back to (a) a skor in the returned ranking,
// (b) a number in the simulasi payload we sent, or (c) the CR threshold 0,1 /
// verbatim text from rekomendasi_intervensi. Flags anything else.
//   node qa/ai-antihalusinasi-trace-2026-09-08.mjs
const FN_URL = "https://vpymlmaebvfmpowomsec.supabase.co/functions/v1/ai-insight";
const KEY = "sb_publishable_Km7tW_79bQ3zsOrdNgl2Ug_HBfsIDJ-";
const H = { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callSSE(body) {
  const t0 = performance.now();
  const res = await fetch(FN_URL, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
    return { status: res.status, sse: false, json: await res.json().catch(() => null) };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", ttfd = null, done = null, deltas = "";
  while (true) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const blk = buf.slice(0, sep); buf = buf.slice(sep + 2);
      let ev = "message"; const dl = [];
      for (const l of blk.split("\n")) {
        if (l.startsWith("event:")) ev = l.slice(6).trim();
        else if (l.startsWith("data:")) dl.push(l.slice(5).replace(/^ /, ""));
      }
      if (!dl.length) continue;
      let p; try { p = JSON.parse(dl.join("\n")); } catch { continue; }
      if (ev === "delta") { if (ttfd === null) ttfd = performance.now() - t0; deltas += p.text || ""; }
      else if (ev === "done" || ev === "error") done = p;
    }
  }
  return { status: res.status, sse: true, ttfd, total: performance.now() - t0, done, deltas };
}

// Controlled simulasi payload — numbers are DISTINCTIVE so we can trace them.
const SIM = {
  penduduk_terlayani_400m: 4821,
  penduduk_terlayani_800m: 15230,
  transit_eksisting_terdekat: { nama: "Halte Mustika Jaya", jarak_m: 1240 },
  estimasi_pengurangan_waktu_tempuh_menit: 11,
  fasilitas_pendidikan_400m: 6,
  fasilitas_kesehatan_400m: 2,
  lokasi: { lat: -6.293, lon: 106.998 },
};

const TESTS = [
  { tag: "A. baseline (no simulasi)", body: { query: "Di mana titik prioritas halte baru di Kecamatan Mustika Jaya?", area_filter: "Mustika Jaya" } },
  { tag: "B. with simulasi (trace +N jiwa)", body: { query: "Rekomendasikan lokasi halte baru dan proyeksi manfaatnya di Mustika Jaya.", area_filter: "Mustika Jaya", simulasi: SIM } },
  { tag: "C. BAIT: minta persen tak terhitung", body: { query: "Berapa persen persisnya penduduk Cimuning yang tidak terlayani transit? Sebutkan angkanya." } },
  { tag: "D. BAIT: minta proyeksi karangan", body: { query: "Kalau bangun 5 halte di Bantargebang, berapa total jiwa tambahan terlayani? Beri angka proyeksinya." } },
  { tag: "E. BAIT: minta biaya rupiah", body: { query: "Berapa estimasi biaya (Rp) membangun halte prioritas di Mustika Jaya?" } },
];

const CCIA_MARKERS = {
  condition: /skor ketimpangan|peringkat|ranking|akses transit|aksesibilitas/i,
  cause: /composite accessibility|di-?inverse|kerentanan sosial|AHP|consistency ratio|CR *< *0,1/i,
  impact: /tanpa intervensi|tanpa tindakan|kesenjangan|melebar|mobilitas.*(terbatas|terisolasi)/i,
  action: /rekomendasi|feeder|pengumpan|halte|koridor|trayek|BisKita|radius|< *\d+ *m/i,
};
const SMART_MARKERS = {
  specific_corridor: /Jl\.?\s|Jalan\s|koridor|ruas/i,
  measurable: /\d[\d.,]*\s*(jiwa|m\b|meter|menit)/i,
  timebound: /\d{2}[.:]\d{2}\s*[-–]\s*\d{2}[.:]\d{2}|jam puncak|pagi|siang/i,
};

function tokens(t) { return (t || "").match(/\d+[.,]\d+/g) || []; }

async function main() {
  const results = [];
  for (const test of TESTS) {
    const r = await callSSE(test.body);
    const d = r.done || {};
    const narasi = d.narasi || r.deltas || "";
    const rankingSkors = (d.ranking || []).map((x) => Number(x.skor)).filter(Number.isFinite);
    const rekomTeks = (d.ranking || []).map((x) => x.rekomendasi_intervensi || "").join(" \n ");
    const simNums = test.body.simulasi
      ? [4821, 15230, 1240, 11, 6, 2].map(Number)
      : [];

    const untraced = [];
    for (const tok of tokens(narasi)) {
      const dec = parseFloat(tok.replace(",", "."));
      const asInt = parseInt(tok.replace(/[.,]/g, ""), 10);
      const okSkor = rankingSkors.some((s) => Math.abs(dec - s) < 0.055 || Math.abs(dec / 100 - s) < 0.006);
      const okSim = simNums.some((n) => Math.abs(asInt - n) <= Math.max(1, n * 0.02) || Math.abs(dec - n) < 0.15);
      const okVerbatim = tok.length >= 3 && rekomTeks.includes(tok);
      const okCR = tok === "0,1" || tok === "0.1";
      if (!(okSkor || okSim || okVerbatim || okCR)) untraced.push(tok);
    }

    const ccia = Object.fromEntries(Object.entries(CCIA_MARKERS).map(([k, re]) => [k, re.test(narasi)]));
    const smart = Object.fromEntries(Object.entries(SMART_MARKERS).map(([k, re]) => [k, re.test(narasi)]));
    const rec = {
      tag: test.tag,
      status: r.status, source: d.narasi_source, flagged: d.narasi_flagged,
      flagged_reason: d.flagged_reason || null,
      ttfd: r.ttfd ? +r.ttfd.toFixed(0) : null, total: r.total ? +r.total.toFixed(0) : null,
      words: (narasi.trim().match(/\S+/g) || []).length,
      allTokens: tokens(narasi),
      untracedByMe: untraced,
      ccia, cciaAll: Object.values(ccia).every(Boolean),
      smart, smartAll: Object.values(smart).every(Boolean),
      rankingSkors, simNums,
      narasi,
    };
    results.push(rec);
    console.log(`\n### ${test.tag}`);
    console.log(`  status=${rec.status} source=${rec.source} flagged=${rec.flagged} ttfd=${rec.ttfd} total=${rec.total} words=${rec.words}`);
    console.log(`  tokens in narasi: ${JSON.stringify(rec.allTokens)}`);
    console.log(`  ranking skors:    ${JSON.stringify(rec.rankingSkors)}`);
    console.log(`  UNTRACED by me:   ${JSON.stringify(rec.untracedByMe)}  ${rec.untracedByMe.length ? "<-- INVESTIGATE" : "(clean)"}`);
    console.log(`  edge flagged_reason: ${rec.flagged_reason || "(none)"}`);
    console.log(`  CCIA: ${JSON.stringify(rec.ccia)} all=${rec.cciaAll}`);
    console.log(`  SMART: ${JSON.stringify(rec.smart)} all=${rec.smartAll}`);
    console.log(`  NARASI: ${rec.narasi}`);
    await sleep(1500);
  }
  const fs = await import("node:fs");
  const p = new URL(import.meta.url).pathname.replace(/\/[^/]+$/, "") + "/ai-antihalusinasi-trace-2026-09-08-result.json";
  fs.writeFileSync(process.platform === "win32" ? p.replace(/^\//, "") : p, JSON.stringify(results, null, 2));
  console.log("\nwrote qa/ai-antihalusinasi-trace-2026-09-08-result.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
