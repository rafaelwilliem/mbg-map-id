import { useCallback, useEffect, useRef, useState } from 'react'
import { Crosshair, Layers, Satellite } from 'lucide-react'
import {
  Map as MapLibreMap,
  NavigationControl,
  GeolocateControl,
  FullscreenControl,
  ScaleControl,
  Marker,
  Popup,
  setWorkerUrl,
} from 'maplibre-gl'
// maplibre-gl@6 me-resolve tile Web Worker-nya lewat ekspresi DINAMIS di
// runtime (`new URL(`./${t}`, import.meta.url)` dengan `t`/`e` sebagai
// variabel), bukan pola literal `new URL('./x.mjs', import.meta.url)`.
// Vite/Rollup tidak bisa mendeteksi itu secara statis, jadi `vite build`
// TIDAK pernah meng-emit `maplibre-gl-worker.mjs` -> di produksi worker
// 404 -> tile .pbf tidak pernah di-fetch/parse -> basemap tidak pernah
// tampil (marker/kontrol tetap muncul karena di main thread). Solusi:
// impor worker via `?worker&url` supaya Vite MEM-BUNDLE-nya (inline chunk
// `maplibre-gl-shared.mjs` ~470 KB yang di-import worker) dan meng-emit
// satu URL aset ber-hash, lalu serahkan URL itu ke maplibre lewat
// setWorkerUrl() di scope modul (sekali, sebelum Map mana pun dibangun).
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'

setWorkerUrl(maplibreWorkerUrl)

// Pusat peta: Kota Bekasi (perkiraan dari titik Summarecon Bekasi di proposal)
const BEKASI_CENTER = [107.0074, -6.2185]
const BEKASI_ZOOM = 12
// Pitch default kamera — style MAPID "basic" (VITE_MAPID_MAPS_STYLE_URL) punya
// layer fill-extrusion gedung 3D, tapi pada pitch 0 (lurus dari atas) gedung
// 3D terlihat identik dengan 2D karena tidak ada sudut untuk melihat
// ketinggiannya. 45° = sudut umum untuk basemap 3D (konvensi Google Maps/
// Mapbox). ResetViewControl di bawah juga mengembalikan ke pitch ini, BUKAN
// ke 0, supaya tombol "kembali ke tampilan awal" tidak meratakan gedung 3D.
const BEKASI_PITCH = 45

// MAPID Maps GL Style — dari Map Services > Styles > Styles Privat (GL Style)
// Dua bagian dipisah env var supaya gampang ganti style (street-2d-building /
// basic / satellite / dst) tanpa menyentuh key, dan sebaliknya. Key sama
// dipakai untuk kedua basemap (toggle Peta/Satelit di bawah).
const MAPID_STYLE_BASE = import.meta.env.VITE_MAPID_MAPS_STYLE_URL
const MAPID_SATELLITE_STYLE_BASE = import.meta.env.VITE_MAPID_MAPS_SATELLITE_STYLE_URL
const MAPID_API_KEY = import.meta.env.VITE_MAPID_MAPS_API_KEY

// Fallback ke OSM raster gratis kalau .env belum diisi — supaya dev lokal
// tetap bisa jalan tanpa key sambil menunggu konfirmasi/kuota MAPID.
const FALLBACK_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors — mode fallback, MAPID Maps belum dikonfigurasi',
    },
  },
  layers: [{ id: 'osm-basemap', type: 'raster', source: 'osm' }],
}

// MapLibre menerima "style" berupa URL string (akan di-fetch otomatis) atau
// objek style JSON langsung. Kalau kredensial MAPID ada, pakai URL asli;
// kalau belum, pakai objek fallback di atas.
function buildMapidStyle(base, key) {
  return base && key ? `${base}?key=${key}` : FALLBACK_STYLE
}

// Dua basemap yang tersedia lewat toggle "Peta / Satelit" (tombol di dalam
// render MapView, dekat badge zoom top-right). STREET tetap default (jangan
// diubah — lihat instruksi Sam).
const STREET_STYLE = buildMapidStyle(MAPID_STYLE_BASE, MAPID_API_KEY)
const SATELLITE_STYLE = buildMapidStyle(MAPID_SATELLITE_STYLE_BASE, MAPID_API_KEY)
const mapStyle = STREET_STYLE

if (!(MAPID_STYLE_BASE && MAPID_API_KEY)) {
  console.warn(
    '[GeoTransit Insight] VITE_MAPID_MAPS_STYLE_URL / VITE_MAPID_MAPS_API_KEY belum diisi — ' +
    'basemap memakai OSM fallback, bukan MAPID Maps resmi.'
  )
}
if (!(MAPID_SATELLITE_STYLE_BASE && MAPID_API_KEY)) {
  console.warn(
    '[GeoTransit Insight] VITE_MAPID_MAPS_SATELLITE_STYLE_URL belum diisi — ' +
    'tombol "Satelit" akan jatuh ke OSM fallback, bukan citra satelit MAPID.'
  )
}

/**
 * Kontrol kustom "kembali ke tampilan awal" — di-render sebagai tombol di
 * dalam grup kontrol MapLibre (top-right) supaya visualnya menyatu dengan
 * tombol zoom/kompas, bukan overlay React terpisah. flyTo mereset juga
 * bearing & pitch ke nilai AWAL (BEKASI_PITCH, bukan hardcode 0) supaya
 * kamera benar-benar pulang ke keadaan awal — termasuk tampilan gedung 3D,
 * bukan malah meratakannya ke pitch 0.
 */
class ResetViewControl {
  constructor({ center, zoom, pitch = 0, bearing = 0 }) {
    this._center = center
    this._zoom = zoom
    this._pitch = pitch
    this._bearing = bearing
  }

  onAdd(map) {
    this._map = map
    this._container = document.createElement('div')
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group'

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'gti-ctrl-reset'
    btn.title = 'Kembali ke tampilan Kota Bekasi'
    btn.setAttribute('aria-label', 'Kembali ke tampilan Kota Bekasi')
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>'
    btn.addEventListener('click', () => {
      map.flyTo({
        center: this._center,
        zoom: this._zoom,
        bearing: this._bearing,
        pitch: this._pitch,
        duration: 700,
      })
    })

    this._container.appendChild(btn)
    return this._container
  }

  onRemove() {
    this._container?.parentNode?.removeChild(this._container)
    this._map = undefined
  }
}

/**
 * MapView — komponen peta inti GeoTransit Insight.
 *
 * Props:
 *  - simulationMode: boolean — kalau true, klik di peta akan memanggil onMapClick
 *    dengan {lat, lon} (dipakai fitur Simulasi What-If)
 *  - onMapClick: (coords: {lat, lon}) => void
 *  - markers: array of {lat, lon, color?, popupText?, popupHtml?, onClick?} —
 *    dipakai untuk render halte eksisting / titik kandidat / hasil simulasi.
 *    popupHtml (opsional) dipakai kalau butuh format lebih dari satu baris
 *    (mis. deskripsi + wilayah + catatan titik kandidat); kalau ada,
 *    didahulukan dari popupText. onClick (opsional) dipanggil saat marker
 *    itu sendiri diklik langsung (bukan cuma klik peta lalu dicari terdekat)
 *    — dipakai supaya titik_kandidat bisa langsung dipilih dari markernya.
 *  - layers: array of { id, type: 'fill'|'line'|'circle', data: GeoJSON, paint?, layout?,
 *    visible?, popupHtml? } — generic GeoJSON layer, dipakai untuk overlai analitik
 *    multi-layer gap analysis (kepadatan/TDI, dikendalikan bersama tab "Peta
 *    Interaktif" DAN "Analisis Spasial" — lihat state `analyticOverlay` di App.jsx)
 *    maupun layer rute transit. Sengaja generik (bukan hardcode nama layer) supaya
 *    dipakai ulang tanpa menambah pola integrasi baru. `popupHtml` opsional:
 *    kalau diisi, klik pada FITUR APA PUN di layer itu akan menampilkan popup statis
 *    berisi HTML ini (dipakai mis. untuk disclaimer "rute aproksimasi, bukan resmi
 *    operator" pada layer koridor BisKita) — bukan popup per-fitur individual seperti
 *    `markers`, cukup untuk kasus satu layer = satu pesan seragam.
 *  - children: overlay opsional yang dirender di atas canvas peta (mis.
 *    <CaiScorePanel>/<TdiScorePanel>) — diposisikan absolute di dalam container
 *    relative, tidak menggantikan canvas MapLibre. Sejak konsolidasi peta
 *    2026-09-12, HANYA satu instance MapView yang pernah dipasang (App.jsx
 *    <main>, dipakai bersama semua tab) — AnalisisSpasial.jsx tidak lagi
 *    memasang instance-nya sendiri.
 */
export default function MapView({
  simulationMode = false,
  onMapClick,
  markers = [],
  clickMarker = null,
  layers = [],
  onMapReady,
  children,
}) {
  const containerRef = useRef(null)
  const wrapperRef = useRef(null)
  const mapRef = useRef(null)
  // Overlay "memuat peta" ditutup begitu style/tile pertama render — atau
  // paling lambat setelah fallback timeout (basemap MAPID kadang tidak
  // pernah mencapai 'idle', lihat catatan sinkronisasi layer di bawah).
  const [mapLoaded, setMapLoaded] = useState(false)
  // Indikator level zoom (overlay kecil, lihat render di bawah) — state lokal
  // saja, tidak diangkat ke App.jsx karena tidak dipakai komponen lain.
  const [zoomLevel, setZoomLevel] = useState(BEKASI_ZOOM)
  const markerRefs = useRef([])
  const clickMarkerRef = useRef(null)
  const layerIdsRef = useRef([])
  // onMapReady disimpan di ref supaya effect init (mount-only) tidak perlu
  // memasukkannya ke dependency array.
  const onMapReadyRef = useRef(onMapReady)
  useEffect(() => {
    onMapReadyRef.current = onMapReady
  }, [onMapReady])
  // Penjaga supaya onMapReady dipanggil maksimal SEKALI per instance peta.
  const mapReadyFiredRef = useRef(false)

  // Basemap aktif — 'street' (default, JANGAN diubah) atau 'satellite'.
  // Instance MapLibre-nya sendiri TIDAK dibongkar-pasang saat toggle (mahal +
  // memicu re-init semua kontrol); cukup map.setStyle() di effect terpisah di
  // bawah. State ini hidup selama MapView terpasang — karena sejak konsolidasi
  // 2026-09-12 hanya ada SATU instance MapView yang dipasang di seluruh app
  // (App.jsx <main>), pilihan basemap otomatis bertahan lintas tab tanpa perlu
  // localStorage/context tambahan.
  const [basemap, setBasemap] = useState('street')
  const isFirstBasemapRenderRef = useRef(true)
  // Sumber kebenaran layer GeoJSON generik TERBARU, dibaca oleh reapplyLayers
  // di bawah. Dibutuhkan (bukan cukup pakai closure atas prop `layers`)
  // karena reapplyLayers juga dipanggil dari listener 'style.load' yang
  // dipasang SEKALI di effect init peta (mount-only) — closure di situ akan
  // basi kalau tidak membaca lewat ref.
  const layersRef = useRef(layers)
  useEffect(() => {
    layersRef.current = layers
  }, [layers])

  // Terapkan seluruh layer GeoJSON generik (prop `layers`, dibaca dari
  // layersRef) ke instance peta saat ini. Diekstrak jadi callback stabil
  // (bukan didefinisikan inline di dalam effect sinkronisasi layer) supaya
  // BISA DIPANGGIL ULANG dari dua tempat: (1) effect sinkronisasi layer biasa
  // saat prop `layers` berubah, dan (2) listener 'style.load' yang dipasang
  // di effect init peta (mount-only) — dipicu tiap kali map.setStyle()
  // (toggle basemap Peta/Satelit) SELESAI memuat style baru.
  //
  // KENAPA INI PENTING (gotcha MapLibre): map.setStyle() membuang SEMUA
  // source/layer custom yang ditambah lewat addSource/addLayer (grid CAI/TDI,
  // koridor, dll) — hanya isi style JSON baru yang tersisa. Tanpa
  // reapplyLayers dipanggil ulang setelah tiap style swap, toggle ke Satelit
  // (atau kembali ke Peta) akan meninggalkan peta TANPA choropleth/overlay
  // apa pun sampai prop `layers` kebetulan berubah lagi dari App.jsx.
  // Idempoten by design (getSource/getLayer dicek sebelum add), jadi aman
  // dipanggil berulang termasuk saat style TIDAK berubah.
  const reapplyLayers = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const currentLayers = layersRef.current
    const nextIds = new Set(currentLayers.map((l) => l.id))
    // Buang layer/source lama yang sudah tidak ada di prop terbaru. Aman
    // dipanggil juga tepat setelah style swap (id lama sudah otomatis hilang
    // dari style baru) karena getLayer/getSource akan undefined.
    layerIdsRef.current.forEach((id) => {
      if (!nextIds.has(id)) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
    })

    currentLayers.forEach((layer) => {
      const { id, type, data, paint = {}, layout = {}, visible = true } = layer
      if (map.getSource(id)) {
        map.getSource(id).setData(data)
      } else {
        map.addSource(id, { type: 'geojson', data })
      }
      if (!map.getLayer(id)) {
        // TANPA beforeId: MapLibre menaruh layer BARU di paling ATAS stack
        // internal peta, TERLEPAS dari posisi elemen ini di array `layers` —
        // itu z-order MapLibre yang sebenarnya (kapan addLayer dipanggil),
        // BUKAN urutan array. Reorder eksplisit di bawah (setelah loop ini)
        // yang benar-benar menegakkan "array order = urutan gambar".
        map.addLayer({ id, type, source: id, paint, layout })
      } else {
        Object.entries(paint).forEach(([k, v]) => map.setPaintProperty(id, k, v))
      }
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    })

    // Tegakkan ulang z-order = urutan array `currentLayers` (elemen terakhir
    // = paling atas), TERLEPAS dari kapan tiap layer ditambahkan.
    //
    // BUG YANG DIPERBAIKI (2026-09-13, ditemukan smoke test setelah fix
    // sorotan kecamatan): sorot-wilayah-* ditaruh PALING AKHIR di array
    // App.jsx supaya selalu di atas overlay analitik — tapi itu HANYA benar
    // kalau overlay analitik itu sudah ada di peta SEBELUM sorot-wilayah
    // ditambahkan. Urutan sebaliknya (pilih kecamatan dulu saat overlay
    // Kepadatan aktif -> sorot-wilayah ke atas dg benar -> lalu GANTI overlay
    // ke TDI) membuat layer TDI yang baru (id beda dari Kepadatan) ditambah
    // LEBIH BELAKANGAN secara waktu, sehingga MapLibre menaruhnya di ATAS
    // sorot-wilayah yang sudah ada duluan -- sorotan jadi tertutup TDI,
    // persis skenario yang smoke test temukan. `if (!map.getLayer(id))` di
    // atas sengaja tidak pernah memindahkan layer yang SUDAH ada, jadi bug
    // ini tidak bisa hilang sendiri hanya dari re-run reconcile biasa.
    //
    // moveLayer(id) TANPA argumen kedua memindahkan layer ke PALING ATAS;
    // memanggilnya berurutan sesuai urutan array (bukan urutan waktu
    // addLayer) membangun ulang persis urutan yang dimaksud array setiap
    // reconcile — biaya rendah (mutasi style, bukan re-render/refetch data)
    // dan idempoten, aman dipanggil di setiap sinkronisasi termasuk saat
    // urutan sebenarnya sudah benar.
    currentLayers.forEach((layer) => {
      if (map.getLayer(layer.id)) map.moveLayer(layer.id)
    })

    layerIdsRef.current = currentLayers.map((l) => l.id)
  }, [])

  // Bungkus reapplyLayers dengan try/catch: satu-satunya kegagalan yang WAJAR
  // adalah style belum selesai di-parse (pemanggil di bawah akan mencoba lagi
  // lewat listener event). Kegagalan lain dimunculkan supaya tidak hilang
  // tanpa jejak.
  const tryReapplyLayers = useCallback(() => {
    try {
      reapplyLayers()
      return true
    } catch (err) {
      if (!/style is not done loading/i.test(String(err?.message))) {
        console.warn('[GeoTransit Insight] gagal menyinkronkan layer peta:', err)
      }
      return false
    }
  }, [reapplyLayers])

  // Init peta sekali saat komponen pertama kali render
  useEffect(() => {
    if (mapRef.current) return

    mapRef.current = new MapLibreMap({
      container: containerRef.current,
      style: mapStyle,
      center: BEKASI_CENTER,
      zoom: BEKASI_ZOOM,
      pitch: BEKASI_PITCH,
      // Wajib supaya canvas WebGL bisa dibaca ulang (html2canvas / toDataURL)
      // untuk fitur Export Report (Data & Laporan). Overhead kecil, dapat
      // diterima untuk aplikasi analitik satu-peta ini.
      preserveDrawingBuffer: true,
    })

    const map = mapRef.current
    // Cluster kontrol top-right: zoom + kompas, "kembali ke Kota Bekasi",
    // geolokasi, dan fullscreen. Fullscreen menyasar wrapper (bukan canvas)
    // supaya overlay CaiScorePanel/MapLegend ikut tampil saat layar penuh.
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(
      new ResetViewControl({ center: BEKASI_CENTER, zoom: BEKASI_ZOOM, pitch: BEKASI_PITCH }),
      'top-right',
    )
    map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserLocation: true,
      }),
      'top-right',
    )
    if (wrapperRef.current) {
      map.addControl(new FullscreenControl({ container: wrapperRef.current }), 'top-right')
    }
    map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')

    // Tutup overlay "memuat peta" pada sinyal paling awal yang tersedia:
    // event 'load' (style + tile pertama), 'idle' (render selesai), atau
    // fallback timeout kalau MAPID tak pernah menyentuh keduanya.
    let cancelled = false
    const markLoaded = () => {
      if (!cancelled) setMapLoaded(true)
    }
    map.on('load', markLoaded)
    map.once('idle', markLoaded)
    const loadFallback = setTimeout(markLoaded, 4500)

    // Re-terapkan layer GeoJSON generik setiap kali sebuah style SELESAI
    // dimuat — bukan cuma effect sinkronisasi layer di bawah (yang keyed ke
    // prop `layers`), supaya toggle basemap Peta/Satelit (map.setStyle() di
    // effect terpisah) tidak meninggalkan peta tanpa choropleth/overlay.
    // 'style.load' menyala SEKALI untuk style AWAL ini (di-dobel-jaga oleh
    // effect sinkronisasi layer di bawah, tidak masalah — reapplyLayers
    // idempoten) DAN sekali lagi tiap kali map.setStyle() dipanggil setelahnya
    // — beda dengan 'load' yang cuma menyala sekali seumur instance peta.
    map.on('style.load', tryReapplyLayers)

    // Serahkan instance peta ke pemanggil SEGERA setelah konstruktor, JANGAN
    // menunggu event 'load'. Alasannya (temuan QA 2026-09-08): kalau style
    // basemap gagal render (MAPID style JSON balik 200 & ter-parse, tapi vector
    // tile-nya tidak pernah sampai), event 'load' TIDAK PERNAH menyala →
    // mapInstance di App.jsx tetap null → moveMap() di SearchBar diam-diam
    // early-return dan kamera tidak pernah bergerak, tanpa error/log apa pun.
    // Konsumen onMapReady saat ini cuma butuh objek Map-nya ada, bukan style
    // yang selesai dimuat: SearchBar (flyTo/fitBounds — aman sebelum style
    // load, MapLibre menyimpan target kamera) dan DataLaporan (getCanvas, baru
    // dipanggil saat user menekan tombol export). Kalau nanti ada konsumen yang
    // butuh addSource/addLayer, dia yang harus menunggu 'load'/isStyleLoaded()
    // sendiri — jangan kembalikan penantian itu ke sini.
    if (!mapReadyFiredRef.current) {
      mapReadyFiredRef.current = true
      onMapReadyRef.current?.(map)
    }

    // Hook debug/QA (DEV-only, di-tree-shake dari build produksi): ekspos
    // instance peta ke global supaya harness browser bisa memeriksa
    // getStyle().layers / isSourceLoaded tanpa jalur khusus. Bukan API produk.
    if (import.meta.env.DEV && typeof window !== 'undefined') window.__gtiMap = map

    return () => {
      cancelled = true
      clearTimeout(loadFallback)
      map.off('load', markLoaded)
      map.off('style.load', tryReapplyLayers)
      mapRef.current?.remove()
      mapRef.current = null
      // Reset supaya instance peta BARU (mis. remount / StrictMode double-mount
      // di dev) tetap diserahkan lagi ke pemanggil.
      mapReadyFiredRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by
    // design (lihat komentar di atas); tryReapplyLayers stabil (useCallback
    // tanpa dependency yang berubah), aman dikecualikan dari deps.
  }, [])

  // Klik peta -> trigger callback selalu (bukan hanya saat simulationMode
  // aktif). Pemanggil (App.jsx) yang memutuskan alur mana yang jalan
  // (simulasi RPC vs cek skor CAI) berdasarkan mode aktifnya sendiri — kalau
  // handler ini dibatasi ke simulationMode saja, klik peta biasa di luar
  // mode simulasi tidak akan pernah memicu panel skor CAI sama sekali
  // (bug: acceptance criteria "klik lokasi di peta -> skor CAI" jadi mati).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const handleClick = (e) => {
      // Prioritaskan layer GeoJSON generik yang punya popupHtml (mis. disclaimer
      // rute BisKita — lihat App.jsx) sebelum meneruskan ke onMapClick. Dicek
      // lewat queryRenderedFeatures di DALAM handler klik generik yang sama
      // (bukan map.on('click', layerId, ...) terpisah) supaya urutan eksekusi
      // deterministik — MapLibre tidak menjamin urutan antar listener 'click'
      // kalau didaftarkan lewat pemanggilan map.on() yang berbeda.
      const clickableLayerIds = layers
        .filter((l) => l.popupHtml && l.visible !== false && map.getLayer(l.id))
        .map((l) => l.id)

      if (clickableLayerIds.length) {
        const hits = map.queryRenderedFeatures(e.point, { layers: clickableLayerIds })
        if (hits.length) {
          const hitLayer = layers.find((l) => l.id === hits[0].layer.id)
          if (hitLayer?.popupHtml) {
            new Popup({ offset: 8 }).setLngLat(e.lngLat).setHTML(hitLayer.popupHtml).addTo(map)
            return
          }
        }
      }

      onMapClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng })
    }

    map.on('click', handleClick)
    return () => map.off('click', handleClick)
  }, [onMapClick, layers])

  // Update cursor supaya jelas kapan mode simulasi aktif
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.getCanvas().style.cursor = simulationMode ? 'crosshair' : ''
  }, [simulationMode])

  // Indikator level zoom (badge kecil top-right, lihat render di bawah) — asal
  // pertanyaan Sam soal perilaku heatmap-radius di zoom berapa. Dengar event
  // 'zoom' bawaan MapLibre supaya angkanya live saat pan/zoom/scroll-wheel,
  // bukan cuma saat mount. Mount-only (deps []): map instance tidak pernah
  // berganti selama komponen hidup, jadi tidak perlu re-subscribe.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const updateZoom = () => setZoomLevel(map.getZoom())
    updateZoom()
    map.on('zoom', updateZoom)
    return () => map.off('zoom', updateZoom)
  }, [])

  // Buat satu Marker MapLibre dari spec {lat, lon, color?, popupHtml?,
  // popupText?, onClick?}. CATATAN maplibre-gl 6.x: setPopup() TIDAK lagi
  // meng-toggle popup saat marker diklik (hanya keypress Space/Enter) — jadi
  // toggle-nya harus dipasang manual di sini, kalau tidak popup tidak pernah
  // muncul saat diklik.
  const createMarker = (map, m) => {
    const el = document.createElement('div')
    const color = m.color || '#1B659D'
    if (m.icon) {
      // Badge ikon ~24px: latar putih, tepi 2px warna marker, glyph SVG di
      // tengah mewarisi warna lewat currentColor (el.style.color). Dipakai untuk
      // halte/stasiun/usulan supaya moda transit terbedakan lewat BENTUK ikon,
      // bukan warna saja (syarat colorblind-safe CLAUDE.md Bab 10.3). Tepi
      // 'dashed' (m.iconStyle) menandai layer yang BELUM riil/tersurvei
      // (usulan halte model).
      el.style.width = '24px'
      el.style.height = '24px'
      el.style.display = 'flex'
      el.style.alignItems = 'center'
      el.style.justifyContent = 'center'
      el.style.borderRadius = '7px'
      el.style.background = '#ffffff'
      el.style.border = `2px ${m.iconStyle === 'dashed' ? 'dashed' : 'solid'} ${color}`
      el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.35)'
      el.style.color = color
      el.innerHTML = m.icon
    } else {
      el.style.width = '14px'
      el.style.height = '14px'
      el.style.borderRadius = '50%'
      el.style.border = '2px solid white'
      el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)'
      el.style.background = color
    }
    if (m.title) el.title = m.title
    // Marker transient (lokasi yang baru diklik) memakai cincin denyut —
    // ::after di .gti-marker-pulse mengambil warna dari `color` di bawah.
    if (m.pulse) {
      el.classList.add('gti-marker-pulse')
      el.style.position = 'relative'
      el.style.color = color
    }

    const marker = new Marker({ element: el }).setLngLat([m.lon, m.lat])
    const hasPopup = !!(m.popupHtml || m.popupText)
    if (m.popupHtml) marker.setPopup(new Popup({ offset: 12 }).setHTML(m.popupHtml))
    else if (m.popupText) marker.setPopup(new Popup({ offset: 12 }).setText(m.popupText))

    if (hasPopup || m.onClick) {
      el.style.cursor = 'pointer'
      el.addEventListener('click', (ev) => {
        // Jangan biarkan klik marker jatuh ke handler klik-peta (mode simulasi /
        // cek CAI di koordinat lain).
        ev.stopPropagation()
        // Kalau marker punya aksi khusus (mis. titik kandidat -> buka panel
        // skor CAI), itu yang jalan; kalau tidak, toggle popup info.
        if (m.onClick) m.onClick()
        else if (hasPopup) marker.togglePopup()
      })
    }

    marker.addTo(map)
    return marker
  }

  // Marker persisten (halte, titik kandidat, dll). markers WAJIB stabil-refs
  // dari pemanggil (useMemo di App.jsx) — kalau array baru tiap render, marker
  // + popup yang sedang terbuka ikut dibongkar-pasang tiap render.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markerRefs.current.forEach((mk) => mk.remove())
    markerRefs.current = markers.map((m) => createMarker(map, m))
    return () => {
      markerRefs.current.forEach((mk) => mk.remove())
      markerRefs.current = []
    }
  }, [markers])

  // Marker transient "lokasi yang baru diklik" — effect terpisah supaya
  // perubahannya (tiap klik) tidak membongkar marker persisten di atas.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    clickMarkerRef.current?.remove()
    clickMarkerRef.current = clickMarker ? createMarker(map, clickMarker) : null
    return () => {
      clickMarkerRef.current?.remove()
      clickMarkerRef.current = null
    }
  }, [clickMarker])

  // Sinkronisasi layer GeoJSON generik (mis. grid kepadatan, jaringan transit,
  // Transit Desert Index (TDI), sorotan wilayah hasil pencarian ATAU filter
  // kecamatan di tab Analisis Spasial). addSource/addLayer baru boleh dipanggil
  // setelah style selesai di-PARSE — lihat catatan kesiapan style di bawah.
  // Logika penerapannya sendiri ada di reapplyLayers/tryReapplyLayers (di atas,
  // dekat effect init peta) — dipakai ulang oleh listener 'style.load' supaya
  // toggle basemap Peta/Satelit tidak menghilangkan layer-layer ini.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // KENAPA TIDAK CUKUP `if (map.isStyleLoaded()) ... else map.once('load')`
    // (bentuk lama, diganti 2026-09-08): isStyleLoaded() JUGA bernilai false
    // selama tile sumber masih dimuat — mis. TEPAT setelah fitBounds dari hasil
    // pencarian — padahal MapLibre sebenarnya sudah menerima addSource/addLayer
    // begitu style selesai di-parse. Karena event 'load' hanya menyala SEKALI
    // seumur instance peta, setiap pembaruan layer yang kebetulan datang saat
    // kamera sedang bergerak akan menunggu event yang tidak akan pernah datang
    // lagi, alias HILANG diam-diam (ditemukan saat menambah layer sorotan
    // wilayah: state React sudah terisi, legenda sudah muncul, tapi layernya
    // tidak pernah masuk ke peta).
    // Sekarang: coba terapkan langsung; hanya kalau MapLibre benar-benar
    // menolak karena style belum siap, baru menunggu event berikutnya.
    // KENAPA 'styledata' dan BUKAN 'idle' (revisi 2026-09-09): bentuk
    // sebelumnya menunggu `map.once('idle', ...)`. Dengan basemap MAPID,
    // vector tile-nya kadang stall/retry terus sehingga peta TIDAK PERNAH
    // mencapai 'idle' — akibatnya coba() tak pernah dijalankan ulang dan
    // layer 'sorot-wilayah-*' (dipasang saat user memilih kelurahan/
    // kecamatan dari search) diam-diam tidak pernah muncul, sementara
    // kamera tetap bergerak (fitBounds jalan dari bbox secara terpisah) —
    // terlihat seolah "sudah pan ke area tapi tanpa outline". 'styledata'
    // menyala BERULANG di tiap progres data style (style lambat selesai
    // di-parse, source dimuat), jadi coba() akan terus mencoba sampai
    // style bisa menerima addLayer. coba()/applyLayers() idempoten (tiap
    // addSource/addLayer dijaga getSource/getLayer), aman dipanggil ulang.
    // 'load' tetap dipasang sekali sebagai jaring pengaman paint pertama.
    if (tryReapplyLayers()) return

    const onStyleSiap = () => tryReapplyLayers()
    map.on('styledata', onStyleSiap)
    map.once('load', onStyleSiap)
    return () => {
      map.off('styledata', onStyleSiap)
      map.off('load', onStyleSiap)
    }
  }, [layers, tryReapplyLayers])

  // Toggle basemap Peta/Satelit -> map.setStyle(). Efek terpisah (bukan
  // ditaruh di effect init) supaya HANYA jalan saat `basemap` benar-benar
  // berubah setelah mount pertama — pada mount pertama style sudah dipasang
  // via constructor MapLibreMap (mapStyle = STREET_STYLE), setStyle() ulang
  // di situ percuma (dan berisiko flicker). Layer custom di-restore otomatis
  // oleh listener 'style.load' (effect init peta) begitu style baru selesai.
  useEffect(() => {
    if (isFirstBasemapRenderRef.current) {
      isFirstBasemapRenderRef.current = false
      return
    }
    const map = mapRef.current
    if (!map) return
    map.setStyle(basemap === 'satellite' ? SATELLITE_STYLE : STREET_STYLE)
  }, [basemap])

  return (
    <div ref={wrapperRef} className="relative w-full h-full bg-slate-100">
      <div ref={containerRef} className="w-full h-full" />

      {!mapLoaded && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-50">
          <div className="flex flex-col items-center gap-3 text-slate-400">
            <span
              className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200"
              style={{ borderTopColor: '#1B659D' }}
            />
            <p className="text-xs font-medium">Memuat peta Kota Bekasi…</p>
          </div>
        </div>
      )}

      {/* Badge level zoom — top-right, di SAMPING (bukan di bawah) kolom tombol
          NavigationControl/Reset/Geolocate/Fullscreen bawaan MapLibre, supaya
          tidak perlu menebak tinggi total tumpukan kontrol itu (bertambah
          kalau ada kontrol baru ditambah nanti). LayerControl ada di
          top-left, CaiScorePanel di bottom-left, MapLegend di bottom-right,
          banner mode simulasi di top-center — pojok ini sengaja kosong. */}
      <div className="absolute top-3 right-14 z-10 rounded-xl border border-slate-200 bg-white/95 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-lg backdrop-blur-sm">
        Zoom: {zoomLevel.toFixed(1)}
      </div>

      {/* Toggle basemap Peta/Satelit — tepat di bawah badge zoom, kolom
          top-right yang sama, supaya tidak tumpang tindih dengan kontrol lain
          (LayerControl top-left, CaiScorePanel/TdiScorePanel bottom-left-ish,
          MapLegend bottom-right, banner mode simulasi top-center). */}
      <div className="absolute top-12 right-14 z-10 flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white/95 p-1 text-xs font-medium shadow-lg backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setBasemap('street')}
          aria-pressed={basemap === 'street'}
          title="Basemap Peta (jalan)"
          className={`flex items-center gap-1 rounded-lg px-2 py-1 transition-colors ${
            basemap === 'street'
              ? 'bg-brand-blue text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Layers size={13} className="shrink-0" />
          Peta
        </button>
        <button
          type="button"
          onClick={() => setBasemap('satellite')}
          aria-pressed={basemap === 'satellite'}
          title="Basemap Satelit (citra)"
          className={`flex items-center gap-1 rounded-lg px-2 py-1 transition-colors ${
            basemap === 'satellite'
              ? 'bg-brand-blue text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Satellite size={13} className="shrink-0" />
          Satelit
        </button>
      </div>

      {simulationMode && (
        <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-brand-orange/95 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur-sm">
          <Crosshair size={15} className="shrink-0" />
          Mode Simulasi aktif — klik di peta untuk menguji lokasi halte baru
        </div>
      )}

      {children}
    </div>
  )
}
