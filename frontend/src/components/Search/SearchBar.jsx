import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Loader2, Building2, Bus, MapPin, Sparkles, Train, Route } from 'lucide-react'
import { supabase, isConfigured } from '../../lib/supabaseClient'

// Marker stasiun kereta (KRL + LRT) — aset STATIS di-bundle saat build, sama
// sumbernya dengan layer referensi di App.jsx. Di-import lewat `?raw` +
// JSON.parse karena Vite tidak memproses `.geojson` sebagai JSON modul.
// Sengaja di-parse di sini (bukan dioper lewat prop) supaya App.jsx tidak
// perlu diubah lebih dari yang diperlukan — ini bundle statis, bukan fetch.
import stasiunKotaBekasiRaw from '../../data/stasiun_kota_bekasi.geojson?raw'

const STASIUN_FEATURES = (JSON.parse(stasiunKotaBekasiRaw).features || [])
  .map((f) => {
    const [lon, lat] = f.geometry?.coordinates || []
    if (lat == null || lon == null) return null
    return { lat, lon, nama: f.properties?.nama || 'Stasiun', moda: f.properties?.moda || 'KRL' }
  })
  .filter(Boolean)

const DEBOUNCE_MS = 250
const MIN_CHARS = 2
const PER_GROUP_LIMIT = 6

// Ikon + tint badge per kelompok hasil. Warna mengikuti rumpun warna marker
// layer terkait di App.jsx (ungu=halte, hijau=titik survei, magenta/pink=usulan
// model, biru=stasiun, oranye=koridor) supaya baris hasil kebaca sekelompok
// dengan markernya di peta.
// TODO(ui-ux-designer): tint ini asumsi webgis-developer, bukan keputusan desain final.
const GROUP_META = {
  Wilayah: { icon: Building2, tint: 'bg-brand-blue/10 text-brand-blue' },
  Halte: { icon: Bus, tint: 'bg-violet-100 text-violet-700' },
  'Titik Survei': { icon: MapPin, tint: 'bg-emerald-100 text-emerald-700' },
  'Usulan Model': { icon: Sparkles, tint: 'bg-pink-100 text-pink-700' },
  Stasiun: { icon: Train, tint: 'bg-blue-100 text-blue-700' },
  Koridor: { icon: Route, tint: 'bg-orange-100 text-orange-700' },
}

const GROUP_ORDER = ['Wilayah', 'Halte', 'Titik Survei', 'Usulan Model', 'Stasiun', 'Koridor']

function norm(s) {
  return String(s ?? '').toLowerCase()
}

function wilayahLabel(...parts) {
  return parts.filter(Boolean).join(', ')
}

// Bounding box [minLng, minLat, maxLng, maxLat] dari deretan koordinat GeoJSON
// ([lon,lat]) — dipakai untuk fitBounds saat hasil koridor/garis dipilih.
function boundsFromCoords(coords) {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const c of coords) {
    const [lng, lat] = c
    if (lng == null || lat == null) continue
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  if (minLng === Infinity) return null
  return [minLng, minLat, maxLng, maxLat]
}

// Gabung fitur garis dengan label sama jadi satu hasil (jaringan KRL sering
// terpecah jadi banyak ruas tanpa nama — tanpa merge, dropdown penuh baris
// duplikat). Koordinat MultiLineString diratakan.
function mergeLineItems(fc, fallbackLabel, sublabel, prefix) {
  const byLabel = new Map()
  for (const f of fc?.features || []) {
    const g = f.geometry
    let coords = []
    if (g?.type === 'LineString') coords = g.coordinates || []
    else if (g?.type === 'MultiLineString') coords = (g.coordinates || []).flat()
    if (!coords.length) continue
    const label = f.properties?.nama?.trim() || f.properties?.ref || fallbackLabel
    byLabel.set(label, (byLabel.get(label) || []).concat(coords))
  }
  return [...byLabel.entries()].map(([label, coords], i) => ({
    id: `${prefix}-${i}`,
    group: 'Koridor',
    kind: 'line',
    label,
    sublabel,
    coords,
  }))
}

/**
 * SearchBar — pencarian di header. Menggabungkan:
 *  - hasil client-side (substring, case-insensitive) atas fitur titik/garis yang
 *    SUDAH dimuat App.jsx (tidak fetch ulang): halte tersurvei, titik kandidat
 *    survei, usulan halte model, stasiun KRL/LRT (bundle), koridor BisKita/KRL.
 *  - hasil server-side wilayah administratif via RPC `search_admin_bounds`.
 *    Kalau RPC error / mode demo (`!isConfigured`), hasil wilayah dilewati diam —
 *    hasil client-side tetap tampil.
 *
 * Props:
 *  - className?: string — kelas untuk wrapper (slot header: `flex-1 max-w-sm`).
 *  - mapInstance: maplibre-gl Map | null — instance peta (di-lift dari MapView
 *    lewat onMapReady di App.jsx; sejak 2026-09-08 diserahkan segera setelah
 *    konstruktor, tidak menunggu event 'load'). Kalau masih null, hasil tetap
 *    bisa dipilih dan tab tetap dipindah, tapi kamera tidak bergerak — kondisi
 *    itu DITAMPILKAN ke user (baris redup di kaki dropdown + keterangan setelah
 *    memilih), bukan gagal diam-diam.
 *  - onResultSelected?: () => void — dipanggil saat sebuah hasil dipilih;
 *    App.jsx memakainya untuk pindah ke tab 'peta'.
 *  - onWilayahSelected?: (sorot: {level, nama, geojson} | null) => void — dipanggil
 *    saat hasil dipilih ATAU input dibersihkan. Berisi geometri batas wilayah
 *    (dari RPC `get_admin_geometry`) kalau yang dipilih hasil Wilayah, dan `null`
 *    untuk semua kasus lain (hasil titik/garis, input dibersihkan, RPC gagal /
 *    belum ter-deploy / mode demo). App.jsx memakainya untuk menggambar layer
 *    sorotan batas wilayah di peta.
 *  - halte: Array<{lat, lon, nama, kecamatan?, kelurahan?}> — haltePoints.points.
 *  - titikKandidat: Array<{lat, lon, titik:{id_titik_survei, deskripsi_lokasi, ...}}> — caiPoints.points.
 *  - usulanModel: Array<{lat, lon, kode, ranking, kecamatan?, kelurahan?}> — usulanModel.
 *  - ruteTransit: {biskitaGeoJSON, krlLinesGeoJSON} — ruteTransit.
 */
export default function SearchBar({
  className = '',
  mapInstance = null,
  onResultSelected,
  onWilayahSelected,
  halte = [],
  titikKandidat = [],
  usulanModel = [],
  ruteTransit = {},
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [adminResults, setAdminResults] = useState([])
  const [adminLoading, setAdminLoading] = useState(false)
  // true kalau user memilih hasil tapi peta belum siap digerakkan — dipakai
  // untuk menampilkan keterangan singkat, bukan gagal diam-diam.
  const [mapNotReady, setMapNotReady] = useState(false)

  const inputRef = useRef(null)
  const listRef = useRef(null)
  // Penanda urutan permintaan get_admin_geometry — respons yang datang
  // terlambat (pilihan sudah berganti) dibuang, supaya sorotan tidak "mundur"
  // ke wilayah yang dipilih sebelumnya.
  const sorotReqRef = useRef(0)

  // --- Debounce input ---
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // Keterangan "peta belum siap" hilang sendiri begitu instance peta datang,
  // atau setelah beberapa detik supaya tidak menetap di header.
  useEffect(() => {
    if (mapInstance) setMapNotReady(false)
  }, [mapInstance])

  useEffect(() => {
    if (!mapNotReady) return
    const t = setTimeout(() => setMapNotReady(false), 6000)
    return () => clearTimeout(t)
  }, [mapNotReady])

  // --- Hasil server-side: wilayah administratif (RPC search_admin_bounds) ---
  useEffect(() => {
    const q = debounced.trim()
    if (q.length < MIN_CHARS || !isConfigured) {
      setAdminResults([])
      setAdminLoading(false)
      return
    }
    let cancelled = false
    setAdminLoading(true)
    ;(async () => {
      try {
        const { data, error } = await supabase.rpc('search_admin_bounds', { q })
        if (cancelled) return
        if (error || !Array.isArray(data)) {
          setAdminResults([])
          return
        }
        setAdminResults(
          data.map((row, i) => ({
            id: `wilayah-${row.level}-${i}`,
            group: 'Wilayah',
            kind: 'bbox',
            // level + nama dibawa apa adanya (ejaan asli dari tabel, lihat
            // migration 031) — dipakai sebagai argumen RPC get_admin_geometry
            // saat baris ini dipilih, supaya batas wilayahnya ikut digambar.
            level: row.level,
            nama: row.nama,
            label: row.nama,
            sublabel:
              row.level === 'kelurahan'
                ? wilayahLabel('Kelurahan', row.nama_kecamatan && `Kec. ${row.nama_kecamatan}`)
                : 'Kecamatan',
            bbox: [row.min_lng, row.min_lat, row.max_lng, row.max_lat],
          })),
        )
      } catch {
        if (!cancelled) setAdminResults([])
      } finally {
        if (!cancelled) setAdminLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [debounced])

  // --- Hasil client-side atas fitur yang sudah dimuat ---
  const clientGroups = useMemo(() => {
    const q = norm(debounced.trim())
    if (q.length < MIN_CHARS) return []

    const halteItems = halte
      .filter((h) => h.lat != null && h.lon != null && norm(h.nama).includes(q))
      .slice(0, PER_GROUP_LIMIT)
      .map((h, i) => ({
        id: `halte-${i}`,
        group: 'Halte',
        kind: 'point',
        label: h.nama || 'Halte tersurvei',
        sublabel: wilayahLabel(h.kelurahan, h.kecamatan),
        lat: h.lat,
        lon: h.lon,
      }))

    const kandidatItems = titikKandidat
      .filter((p) => {
        if (p.lat == null || p.lon == null) return false
        const t = p.titik || {}
        return norm(t.id_titik_survei).includes(q) || norm(t.deskripsi_lokasi).includes(q)
      })
      .slice(0, PER_GROUP_LIMIT)
      .map((p, i) => {
        const t = p.titik || {}
        return {
          id: `kandidat-${i}`,
          group: 'Titik Survei',
          kind: 'point',
          label: t.deskripsi_lokasi || t.id_titik_survei || 'Titik survei',
          sublabel: wilayahLabel(t.id_titik_survei, wilayahLabel(t.kelurahan, t.kecamatan)),
          lat: p.lat,
          lon: p.lon,
        }
      })

    const usulanItems = usulanModel
      .filter((u) => {
        if (u.lat == null || u.lon == null) return false
        return (
          norm(u.kode).includes(q) ||
          norm(u.kelurahan).includes(q) ||
          norm(u.kecamatan).includes(q)
        )
      })
      .slice(0, PER_GROUP_LIMIT)
      .map((u, i) => ({
        id: `usulan-${i}`,
        group: 'Usulan Model',
        kind: 'point',
        label: `${u.kode || 'Usulan'}${u.ranking != null ? ` — Usulan #${u.ranking}` : ''}`,
        sublabel: wilayahLabel(u.kelurahan, u.kecamatan) || 'Usulan model spasial (belum disurvei)',
        lat: u.lat,
        lon: u.lon,
      }))

    const stasiunItems = STASIUN_FEATURES.filter((s) => norm(s.nama).includes(q))
      .slice(0, PER_GROUP_LIMIT)
      .map((s, i) => ({
        id: `stasiun-${i}`,
        group: 'Stasiun',
        kind: 'point',
        label: s.nama,
        sublabel: s.moda,
        lat: s.lat,
        lon: s.lon,
      }))

    const koridorItems = [
      ...mergeLineItems(ruteTransit.biskitaGeoJSON, 'Koridor BisKita (tersurvei)', 'Koridor BisKita', 'koridor-biskita'),
      ...mergeLineItems(ruteTransit.krlLinesGeoJSON, 'Jalur KRL Commuter Line', 'Jaringan KRL', 'koridor-krl'),
    ]
      .filter((it) => norm(it.label).includes(q))
      .slice(0, PER_GROUP_LIMIT)

    const groups = []
    if (halteItems.length) groups.push({ name: 'Halte', items: halteItems })
    if (kandidatItems.length) groups.push({ name: 'Titik Survei', items: kandidatItems })
    if (usulanItems.length) groups.push({ name: 'Usulan Model', items: usulanItems })
    if (stasiunItems.length) groups.push({ name: 'Stasiun', items: stasiunItems })
    if (koridorItems.length) groups.push({ name: 'Koridor', items: koridorItems })
    return groups
  }, [debounced, halte, titikKandidat, usulanModel, ruteTransit])

  // Gabung wilayah (server) + client, urutkan sesuai GROUP_ORDER.
  const groups = useMemo(() => {
    const merged = [...clientGroups]
    if (adminResults.length) {
      merged.push({ name: 'Wilayah', items: adminResults.slice(0, PER_GROUP_LIMIT) })
    }
    return merged.sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name))
  }, [clientGroups, adminResults])

  // Daftar datar (untuk navigasi keyboard) + baris render (header + item).
  const { rows, flat } = useMemo(() => {
    const r = []
    const f = []
    for (const g of groups) {
      r.push({ type: 'header', name: g.name })
      for (const item of g.items) {
        r.push({ type: 'item', item, idx: f.length })
        f.push(item)
      }
    }
    return { rows: r, flat: f }
  }, [groups])

  const longEnough = debounced.trim().length >= MIN_CHARS
  const showDropdown = open && longEnough
  const showEmpty = showDropdown && flat.length === 0 && !adminLoading
  // Highlight aktif hanya valid kalau masih dalam rentang daftar terkini
  // (daftar bisa menyusut saat hasil wilayah async datang/hilang).
  const safeActive = activeIndex >= 0 && activeIndex < flat.length ? activeIndex : -1

  // Scroll baris aktif ke dalam viewport dropdown.
  useEffect(() => {
    if (safeActive < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${safeActive}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  // Mengembalikan true kalau kamera benar-benar digerakkan. Sengaja TIDAK diam
  // saat gagal — pemanggil memakai nilai ini untuk memunculkan keterangan ke
  // user (dulu fungsi ini early-return tanpa jejak, jadi hasil pencarian
  // terlihat "tidak melakukan apa-apa" — temuan QA 2026-09-08).
  function moveMap(item) {
    const map = mapInstance
    if (!map || !item) return false
    if (item.kind === 'point') {
      map.flyTo({ center: [item.lon, item.lat], zoom: 16, duration: 800 })
    } else if (item.kind === 'bbox' && item.bbox) {
      const [w, s, e, n] = item.bbox
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 60, duration: 800, maxZoom: 15 },
      )
    } else if (item.kind === 'line') {
      const b = boundsFromCoords(item.coords || [])
      if (!b) return false
      const [w, s, e, n] = b
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 60, duration: 800, maxZoom: 15 },
      )
    }
    return true
  }

  // Membatalkan sorotan wilayah yang sedang tampil (dan menganulir respons RPC
  // yang mungkin masih dalam perjalanan) — dipakai saat hasil non-wilayah
  // dipilih, input dibersihkan (× / Esc), atau RPC gagal.
  function bersihkanSorot() {
    sorotReqRef.current += 1
    onWilayahSelected?.(null)
  }

  // Ambil geometri batas wilayah terpilih. LAZY: hanya dipanggil saat sebuah
  // baris Wilayah BENAR-BENAR dipilih, bukan saat mengetik atau per baris hasil
  // (geometri poligon jauh lebih berat dari bbox — jangan ikut di jalur ketik).
  // Kamera TIDAK menunggu ini: fitBounds sudah jalan dari bbox baris pencarian,
  // jadi kalau RPC lambat/gagal/belum ter-deploy petanya tetap berpindah, cuma
  // tanpa sorotan. Gagal = diam di UI, tapi jujur (tidak ada sorotan basi yang
  // tertinggal dari pilihan sebelumnya).
  async function ambilSorotWilayah(item) {
    const req = (sorotReqRef.current += 1)
    if (!isConfigured) {
      onWilayahSelected?.(null)
      return
    }
    try {
      const { data, error } = await supabase.rpc('get_admin_geometry', {
        p_level: item.level,
        p_nama: item.nama,
      })
      // Pilihan sudah tergeser ke hasil lain — buang respons basi supaya tidak
      // menimpa sorotan yang lebih baru.
      if (req !== sorotReqRef.current) return
      const row = Array.isArray(data) ? data[0] : data
      if (error || !row?.geojson) {
        onWilayahSelected?.(null)
        return
      }
      onWilayahSelected?.({
        level: row.level || item.level,
        nama: row.nama || item.nama,
        geojson: row.geojson,
      })
    } catch {
      if (req === sorotReqRef.current) onWilayahSelected?.(null)
    }
  }

  function handleSelect(item) {
    if (!item) return
    // Pindah tab tetap dilakukan lebih dulu (UX yang dimaksud: hasil pencarian
    // selalu membawa user ke tab Peta), tapi kalau kameranya gagal bergerak
    // user diberi tahu — jangan tinggalkan dia dengan panel tertutup + peta
    // diam tanpa penjelasan.
    onResultSelected?.()
    const moved = moveMap(item)
    setMapNotReady(!moved)
    // Sorotan batas wilayah: hanya untuk hasil Wilayah (kind 'bbox'). Hasil
    // titik/garis WAJIB membersihkan sorotan sebelumnya supaya tidak ada area
    // tersorot yang tidak nyambung dengan apa yang barusan dipilih.
    if (item.kind === 'bbox' && item.level && item.nama) ambilSorotWilayah(item)
    else bersihkanSorot()
    setQuery(item.label)
    setOpen(false)
    setActiveIndex(-1)
    inputRef.current?.blur()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
      bersihkanSorot()
      inputRef.current?.blur()
      return
    }
    if (!showDropdown || flat.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(Math.min(safeActive + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(Math.max(safeActive - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleSelect(flat[safeActive >= 0 ? safeActive : 0])
    }
  }

  return (
    <div className={className}>
      <div className="relative">
        <Search
          size={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50 pointer-events-none"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActiveIndex(-1)
          }}
          onFocus={() => {
            if (longEnough) setOpen(true)
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          placeholder="Cari wilayah, halte, koridor…"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          className="w-full bg-white/10 border border-white/20 rounded-full pl-9 pr-8 py-1.5 text-sm text-white placeholder:text-white/50 focus:outline-none focus:border-white/40"
        />
        {query && (
          <button
            type="button"
            title="Bersihkan"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery('')
              setOpen(false)
              bersihkanSorot()
              inputRef.current?.focus()
            }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/60 hover:text-white"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          ref={listRef}
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 text-slate-700 shadow-lg"
        >
          {adminLoading && isConfigured && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400">
              <Loader2 size={12} className="animate-spin" />
              Mencari wilayah…
            </div>
          )}

          {showEmpty && !adminLoading && (
            <div className="px-3 py-3 text-sm text-slate-400">Tidak ada hasil</div>
          )}

          {rows.map((row, i) => {
            if (row.type === 'header') {
              const Meta = GROUP_META[row.name] || GROUP_META.Wilayah
              const Icon = Meta.icon
              return (
                <div
                  key={`h-${row.name}-${i}`}
                  className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  <Icon size={11} />
                  {row.name}
                </div>
              )
            }
            const { item, idx } = row
            const Meta = GROUP_META[item.group] || GROUP_META.Wilayah
            const Icon = Meta.icon
            const active = idx === safeActive
            return (
              <button
                key={item.id}
                type="button"
                data-idx={idx}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleSelect(item)}
                className={
                  'flex w-full items-start gap-2.5 px-3 py-2 text-left transition ' +
                  (active ? 'bg-brand-blue/10' : 'hover:bg-slate-50')
                }
              >
                <span
                  className={
                    'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ' +
                    Meta.tint
                  }
                >
                  <Icon size={12} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">{item.label}</span>
                  {item.sublabel && (
                    <span className="block truncate text-xs text-slate-400">{item.sublabel}</span>
                  )}
                </span>
              </button>
            )
          })}

          {/* Peta belum terpasang -> hasil tetap bisa dipilih (tab tetap
              pindah), tapi kamera belum bisa digerakkan. Ditulis sebagai baris
              redup di kaki dropdown, bukan alert/modal, dan tidak memblokir
              pengetikan maupun daftar hasil. */}
          {!mapInstance && flat.length > 0 && (
            <div className="border-t border-slate-100 mt-1 px-3 py-2 text-xs text-slate-400">
              Peta belum siap — hasil bisa dipilih, tapi tampilan peta belum akan berpindah.
            </div>
          )}
        </div>
      )}

      {/* Konfirmasi setelah hasil dipilih saat peta belum siap — kalau tidak,
          user cuma melihat panel kanan tertutup dan peta diam tanpa alasan. */}
      {mapNotReady && !showDropdown && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-lg">
          Peta belum siap dimuat, jadi tampilan belum berpindah ke lokasi itu. Coba lagi sebentar
          lagi.
        </div>
      )}
    </div>
  )
}
