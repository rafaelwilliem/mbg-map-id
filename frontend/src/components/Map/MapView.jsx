import { useEffect, useRef } from 'react'
import { Map as MapLibreMap, NavigationControl, Marker, Popup } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Pusat peta: Kota Bekasi (perkiraan dari titik Summarecon Bekasi di proposal)
const BEKASI_CENTER = [107.0074, -6.2185]
const BEKASI_ZOOM = 12

// MAPID Maps GL Style — dari Map Services > Styles > Styles Privat (GL Style)
// Dua bagian dipisah env var supaya gampang ganti style (street-2d-building /
// basic / dst) tanpa menyentuh key, dan sebaliknya.
const MAPID_STYLE_BASE = import.meta.env.VITE_MAPID_MAPS_STYLE_URL
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
const mapStyle =
  MAPID_STYLE_BASE && MAPID_API_KEY
    ? `${MAPID_STYLE_BASE}?key=${MAPID_API_KEY}`
    : FALLBACK_STYLE

if (!(MAPID_STYLE_BASE && MAPID_API_KEY)) {
  console.warn(
    '[GeoTransit Insight] VITE_MAPID_MAPS_STYLE_URL / VITE_MAPID_MAPS_API_KEY belum diisi — ' +
    'basemap memakai OSM fallback, bukan MAPID Maps resmi.'
  )
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
 *    visible?, popupHtml? } — generic GeoJSON layer, dipakai untuk multi-layer gap
 *    analysis (Analisis Spasial) maupun layer rute transit (Peta Interaktif, lihat
 *    App.jsx). Sengaja generik (bukan hardcode nama layer) supaya dipakai ulang oleh
 *    instance MapView manapun tanpa menambah pola integrasi baru. `popupHtml` opsional:
 *    kalau diisi, klik pada FITUR APA PUN di layer itu akan menampilkan popup statis
 *    berisi HTML ini (dipakai mis. untuk disclaimer "rute aproksimasi, bukan resmi
 *    operator" pada layer koridor BisKita) — bukan popup per-fitur individual seperti
 *    `markers`, cukup untuk kasus satu layer = satu pesan seragam.
 *  - children: overlay opsional yang dirender di atas canvas peta (mis.
 *    <CaiScorePanel>) — diposisikan absolute di dalam container relative,
 *    tidak menggantikan canvas MapLibre. Kalau tidak dikirim (mis. dipakai
 *    dari AnalisisSpasial), tidak merender apa pun tambahan.
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
  const mapRef = useRef(null)
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

  // Init peta sekali saat komponen pertama kali render
  useEffect(() => {
    if (mapRef.current) return

    mapRef.current = new MapLibreMap({
      container: containerRef.current,
      style: mapStyle,
      center: BEKASI_CENTER,
      zoom: BEKASI_ZOOM,
      // Wajib supaya canvas WebGL bisa dibaca ulang (html2canvas / toDataURL)
      // untuk fitur Export Report (Data & Laporan). Overhead kecil, dapat
      // diterima untuk aplikasi analitik satu-peta ini.
      preserveDrawingBuffer: true,
    })

    mapRef.current.addControl(new NavigationControl(), 'top-right')

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
    {
      const map = mapRef.current
      if (!mapReadyFiredRef.current) {
        mapReadyFiredRef.current = true
        onMapReadyRef.current?.(map)
      }
    }

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
      // Reset supaya instance peta BARU (mis. remount / StrictMode double-mount
      // di dev) tetap diserahkan lagi ke pemanggil.
      mapReadyFiredRef.current = false
    }
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

  // Buat satu Marker MapLibre dari spec {lat, lon, color?, popupHtml?,
  // popupText?, onClick?}. CATATAN maplibre-gl 6.x: setPopup() TIDAK lagi
  // meng-toggle popup saat marker diklik (hanya keypress Space/Enter) — jadi
  // toggle-nya harus dipasang manual di sini, kalau tidak popup tidak pernah
  // muncul saat diklik.
  const createMarker = (map, m) => {
    const el = document.createElement('div')
    el.style.width = '14px'
    el.style.height = '14px'
    el.style.borderRadius = '50%'
    el.style.border = '2px solid white'
    el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)'
    el.style.background = m.color || '#1B659D'

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
  // indeks gap aksesibilitas untuk Analisis Spasial, sorotan wilayah hasil
  // pencarian). addSource/addLayer baru boleh dipanggil setelah style selesai
  // di-PARSE — lihat catatan kesiapan style di bawah.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const applyLayers = () => {
      const nextIds = new Set(layers.map((l) => l.id))
      // Buang layer/source lama yang sudah tidak ada di prop terbaru
      layerIdsRef.current.forEach((id) => {
        if (!nextIds.has(id)) {
          if (map.getLayer(id)) map.removeLayer(id)
          if (map.getSource(id)) map.removeSource(id)
        }
      })

      layers.forEach((layer) => {
        const { id, type, data, paint = {}, layout = {}, visible = true } = layer
        if (map.getSource(id)) {
          map.getSource(id).setData(data)
        } else {
          map.addSource(id, { type: 'geojson', data })
        }
        if (!map.getLayer(id)) {
          map.addLayer({ id, type, source: id, paint, layout })
        } else {
          Object.entries(paint).forEach(([k, v]) => map.setPaintProperty(id, k, v))
        }
        map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      })

      layerIdsRef.current = layers.map((l) => l.id)
    }

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
    const coba = () => {
      try {
        applyLayers()
        return true
      } catch (err) {
        // Satu-satunya kegagalan yang WAJAR di sini: style belum selesai
        // di-parse (akan dicoba lagi lewat listener di bawah). Kegagalan lain
        // dimunculkan supaya tidak hilang tanpa jejak.
        if (!/style is not done loading/i.test(String(err?.message))) {
          console.warn('[GeoTransit Insight] gagal menyinkronkan layer peta:', err)
        }
        return false
      }
    }

    if (coba()) return

    const onStyleSiap = () => coba()
    map.on('styledata', onStyleSiap)
    map.once('load', onStyleSiap)
    return () => {
      map.off('styledata', onStyleSiap)
      map.off('load', onStyleSiap)
    }
  }, [layers])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {simulationMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-brand-orange text-white text-sm font-medium px-4 py-2 rounded-full shadow-lg">
          Mode Simulasi aktif — klik di peta untuk menguji lokasi halte baru
        </div>
      )}
      {children}
    </div>
  )
}
