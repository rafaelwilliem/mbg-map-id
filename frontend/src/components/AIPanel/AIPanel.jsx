import { useRef, useState } from 'react'
import { Sparkles, Send, Loader2, AlertTriangle, Info } from 'lucide-react'
import { supabase, isConfigured } from '../../lib/supabaseClient'
import { KECAMATAN_KOTA_BEKASI } from '../../lib/kecamatan'

const SEMUA_KECAMATAN = '' // opsi default dropdown -> tidak mengirim area_filter sama sekali

// Nama env var persis mengikuti frontend/src/lib/supabaseClient.js — jangan hardcode key.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const AI_INSIGHT_ENDPOINT = `${SUPABASE_URL}/functions/v1/ai-insight`

const DEMO_RESPONSE = {
  narasi:
    '[CONTOH — belum tersambung ke Supabase] Kelurahan Mustika Jaya menempati prioritas ' +
    'tertinggi dengan skor CAI 0,78. Kepadatan penduduk tinggi (skor 0,90) dan jarak ke ' +
    'fasilitas umum yang jauh (skor 0,70) menjadi pendorong utama, sementara volume transit ' +
    'eksisting di sekitarnya masih rendah (skor 0,20).',
  ranking: [
    { kelurahan: 'Mustika Jaya', skor: 0.78 },
    { kelurahan: 'Rawa Lumbu', skor: 0.71 },
    { kelurahan: 'Bekasi Utara', skor: 0.65 },
  ],
}

// ---------------------------------------------------------------------------
//  SSE parser — Edge Function ai-insight streaming (kontrak di index.ts ~649).
//  fetch() langsung (bukan supabase.functions.invoke, yang tidak bisa membaca
//  stream). Cek res.ok DULU: non-200 = JSON biasa { error }. Kalau 200,
//  res.body dibaca sebagai text/event-stream: split blok pada "\n\n", tiap blok
//  punya baris `event:` dan satu/lebih baris `data:` (digabung sebelum
//  JSON.parse). Chunk yang terpotong di batas buffer ditahan sampai lengkap.
// ---------------------------------------------------------------------------
async function streamAiInsight(body, { onDelta, onDone, onError }) {
  const res = await fetch(AI_INSIGHT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })

  // Non-200 -> body JSON biasa { error }. Jangan coba baca stream.
  if (!res.ok) {
    let message = `Permintaan gagal (HTTP ${res.status})`
    try {
      const j = await res.json()
      if (j && typeof j.error === 'string' && j.error.trim()) message = j.error
    } catch {
      // body bukan JSON — pakai pesan default di atas
    }
    const err = new Error(message)
    err.handled = true
    throw err
  }

  if (!res.body) throw new Error('Respons streaming kosong dari server.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handleBlock = (rawBlock) => {
    const block = rawBlock.replace(/\r/g, '')
    if (!block.trim()) return
    let eventName = 'message'
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) return
    let payload
    try {
      payload = JSON.parse(dataLines.join('\n'))
    } catch {
      return // blok data tidak valid — abaikan, jangan crash
    }
    if (eventName === 'delta') onDelta(payload)
    else if (eventName === 'done') onDone(payload)
    else if (eventName === 'error') onError(payload)
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawBlock = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      handleBlock(rawBlock)
    }
  }
  // Flush sisa buffer (blok terakhir tanpa "\n\n" penutup)
  buffer += decoder.decode()
  if (buffer.trim()) handleBlock(buffer)
}

export default function AIPanel({ latestSimulasi = null, onWilayahSelected, mapInstance = null }) {
  const [query, setQuery] = useState('')
  const [areaFilter, setAreaFilter] = useState(SEMUA_KECAMATAN)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)
  // Cegah respons RPC basi menimpa sorotan dari pertanyaan yang lebih baru
  // (pola sama dengan reqRef di AnalisisSpasial.jsx / sorotReqRef di SearchBar.jsx).
  const sorotReqRef = useRef(0)

  // Sam: kalau narasi AI menjawab dgn fokus satu kelurahan (kerangka CCIA —
  // "ranking":1 SELALU kelurahan yang dibahas narasi, lihat systemPrompt
  // ai-insight/index.ts), peta utama otomatis menyorot & pindah ke kelurahan
  // itu — bukan cuma teks. Reuse ALUR SAMA dengan ambilSorotWilayah
  // (SearchBar.jsx) / handleFilterChange (AnalisisSpasial.jsx): RPC
  // get_admin_geometry -> onWilayahSelected (state sorotWilayah App.jsx) ->
  // fitBounds peta utama. Diam-diam no-op kalau prop tidak dikasih (mis. someday
  // dipakai di konteks tanpa peta), atau RPC gagal (JANGAN bersihkan sorotan
  // lama yang mungkin sedang aktif dari tab lain — beda dgn SearchBar/
  // AnalisisSpasial yang memang state eksplisit "wilayah sedang dipilih user").
  async function sorotKelurahanFokus(ranking) {
    const nama = ranking?.[0]?.kelurahan
    if (!nama || !onWilayahSelected || !isConfigured) return
    const req = (sorotReqRef.current += 1)
    try {
      const { data, error } = await supabase.rpc('get_admin_geometry', {
        p_level: 'kelurahan',
        p_nama: nama,
      })
      if (req !== sorotReqRef.current) return // pertanyaan baru sudah diajukan, buang respons basi
      const row = Array.isArray(data) ? data[0] : data
      if (error || !row?.geojson) return
      onWilayahSelected({ level: 'kelurahan', nama: row.nama || nama, geojson: row.geojson })
      if (mapInstance && row.min_lng != null) {
        mapInstance.fitBounds(
          [
            [row.min_lng, row.min_lat],
            [row.max_lng, row.max_lat],
          ],
          { padding: 60, duration: 800, maxZoom: 15 },
        )
      }
    } catch {
      // Diam — narasi & ranking tetap tampil normal, cuma peta tidak ikut pindah.
    }
  }

  // Patch pesan AI terakhir (placeholder streaming) tanpa menyentuh pesan lain.
  function patchLastAi(patch) {
    setMessages((prev) => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'ai') {
          next[i] = { ...next[i], ...(typeof patch === 'function' ? patch(next[i]) : patch) }
          break
        }
      }
      return next
    })
  }

  // Terapkan payload terminal (done ATAU error) — timpa teks streaming dengan
  // narasi kanonik dari server, simpan metadata. Untuk `event: error`, server
  // sudah mengirim narasi TEMPLATE pengganti + recovered:true; buang teks delta
  // yang sempat terkumpul dan render data.narasi.
  function applyTerminal(data) {
    const area = data.area_filter || {}
    patchLastAi({
      text: data.narasi,
      streaming: false,
      ranking: data.ranking || null,
      flagged: Boolean(data.narasi_flagged),
      flaggedReason: data.flagged_reason || null,
      templateNarasi: data.narasi_source === 'template',
      narasiNote: data.narasi_note || null,
      // BARU: kecamatan diminta tapi tidak dikenali -> diam-diam fallback ke
      // seluruh kota. QA menemukan 8/12 kecamatan kena ini tanpa jejak ke user.
      areaMismatch: area.requested != null && area.matched === false,
      areaRequested: area.requested != null ? area.requested : null,
    })
    if (data.ranking?.length) sorotKelurahanFokus(data.ranking)
  }

  async function handleAsk() {
    if (!query.trim() || loading || inFlight.current) return
    inFlight.current = true
    const userQuery = query.trim()
    const areaLabel = areaFilter || 'Semua Kecamatan'
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: userQuery, area: areaLabel },
      { role: 'ai', text: '', streaming: true },
    ])
    setQuery('')
    setLoading(true)

    try {
      if (!isConfigured) {
        // Fallback demo — supaya UI tetap bisa dicoba sebelum Edge Function live.
        // Jangan fetch sama sekali kalau Supabase belum tersambung.
        await new Promise((r) => setTimeout(r, 600))
        patchLastAi({
          text: DEMO_RESPONSE.narasi,
          streaming: false,
          ranking: DEMO_RESPONSE.ranking,
        })
        return
      }

      // area_filter hanya disertakan kalau user memilih kecamatan tertentu
      // (nama field harus persis `area_filter`). simulasi = output mentah RPC
      // simulate_new_stop terakhir, supaya tahap Action narasi CCIA bisa
      // mengutip "+N jiwa" riil. Keduanya opsional & backward-compatible.
      const body = { query: userQuery }
      if (areaFilter) body.area_filter = areaFilter
      if (latestSimulasi) body.simulasi = latestSimulasi

      let terminalSeen = false
      await streamAiInsight(body, {
        onDelta: (d) => {
          if (typeof d.text !== 'string') return
          patchLastAi((m) => ({ text: m.text + d.text, streaming: true }))
        },
        onDone: (d) => {
          terminalSeen = true
          applyTerminal(d)
        },
        onError: (d) => {
          terminalSeen = true
          applyTerminal(d) // d.narasi = template pengganti, d.narasi_source = "template"
        },
      })

      // Stream selesai tanpa event terminal (putus di tengah) — jangan biarkan
      // bubble menggantung dengan teks parsial tanpa penanda.
      if (!terminalSeen) {
        patchLastAi((m) => ({
          streaming: false,
          text:
            m.text ||
            'Koneksi ke AI Insight terputus sebelum analisis selesai. Coba ulangi pertanyaan.',
          isError: !m.text,
        }))
      }
    } catch (err) {
      patchLastAi({
        text: `Terjadi kendala memanggil AI Insight: ${err.message}`,
        streaming: false,
        isError: true,
      })
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <Sparkles size={18} className="text-brand-orange" />
        <h2 className="font-semibold text-slate-800">AI Spatial Consultant</h2>
      </div>

      {!isConfigured && (
        <div className="mx-4 mt-3 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded-md px-3 py-2">
          Belum tersambung ke Supabase — menampilkan respons contoh. Isi <code>.env</code> untuk data asli.
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 mt-4">
            Contoh pertanyaan: "Kecamatan mana yang perlu diprioritaskan untuk halte baru tahun depan?"
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            {m.role === 'user' && m.area && (
              <p className="text-[10px] text-slate-400 mb-0.5">Cakupan: {m.area}</p>
            )}
            <div
              className={
                'inline-block max-w-[90%] rounded-lg px-3 py-2 text-sm ' +
                (m.role === 'user'
                  ? 'bg-brand-blue text-white'
                  : m.isError
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-slate-100 text-slate-800')
              }
            >
              {m.role === 'ai' && !m.flagged && m.templateNarasi && (
                <div className="mb-2 flex items-start gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 text-left text-slate-600">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide">
                      Narasi template
                    </p>
                    <p className="text-xs mt-0.5">
                      {m.narasiNote ||
                        'Layanan AI sedang tidak tersedia — narasi ini disusun otomatis dari skor model spasial. Angka & ranking tetap akurat.'}
                    </p>
                  </div>
                </div>
              )}
              {m.role === 'ai' && m.flagged && (
                <div className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-left text-amber-800">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide">
                      Narasi ditandai — periksa kembali
                    </p>
                    <p className="text-xs mt-0.5">
                      {m.flaggedReason ||
                        'Sistem mendeteksi angka pada narasi ini tidak cocok dengan skor pada data. Jangan jadikan satu-satunya dasar keputusan — cek rincian skor di peta.'}
                    </p>
                  </div>
                </div>
              )}
              {m.role === 'ai' && m.areaMismatch && (
                <div className="mb-2 flex items-start gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 text-left text-slate-600">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide">
                      Filter kecamatan diabaikan
                    </p>
                    <p className="text-xs mt-0.5">
                      Filter kecamatan "{m.areaRequested}" tidak dikenali — analisis menampilkan
                      seluruh Kota Bekasi.
                    </p>
                  </div>
                </div>
              )}
              {m.role === 'ai' && m.streaming && !m.text ? (
                <span className="flex items-center gap-2 text-slate-400">
                  <Loader2 size={14} className="animate-spin" /> Menyusun analisis…
                </span>
              ) : (
                <span className="whitespace-pre-wrap">
                  {m.text}
                  {m.role === 'ai' && m.streaming && (
                    <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-slate-400" />
                  )}
                </span>
              )}
              {m.ranking && (
                <ul className="mt-2 space-y-1 text-xs">
                  {m.ranking.map((r, idx) => (
                    <li key={idx} className="flex justify-between border-t border-slate-200 pt-1">
                      <span>{idx + 1}. {r.kelurahan}</span>
                      <span className="font-mono">{r.skor.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 pt-2 border-t border-slate-200">
        {latestSimulasi && (
          <p className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 mb-2">
            Konteks simulasi What-If terakhir disertakan — tahap Action narasi akan mengutip proyeksi
            penduduk terlayani riil.
          </p>
        )}
        <label className="text-[11px] font-medium text-slate-500 block mb-1">
          Batasi ke kecamatan (opsional)
        </label>
        {/* TODO(ui-ux-designer): styling dropdown ini masih pakai select native
            polos, belum disesuaikan dengan sistem desain final. */}
        <select
          value={areaFilter}
          onChange={(e) => setAreaFilter(e.target.value)}
          className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5 mb-2 bg-white focus:outline-none focus:ring-2 focus:ring-brand-blue"
        >
          <option value={SEMUA_KECAMATAN}>Semua Kecamatan</option>
          {KECAMATAN_KOTA_BEKASI.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div className="p-3 pt-0 border-t-0 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
          placeholder="Tanyakan prioritas transit..."
          className="flex-1 text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-blue"
        />
        <button
          onClick={handleAsk}
          disabled={loading}
          className="bg-brand-blue text-white rounded-md px-3 py-2 disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  )
}
