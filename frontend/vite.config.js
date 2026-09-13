import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // maplibre-gl@6.4.1 me-resolve tile Web Worker-nya (`maplibre-gl-worker.mjs`)
  // di runtime lewat ekspresi DINAMIS di dist/maplibre-gl.mjs `wi()`:
  //   let e = import.meta.url
  //   let t = e.endsWith('-dev.mjs') ? 'maplibre-gl-worker-dev.mjs' : 'maplibre-gl-worker.mjs'
  //   return new URL(`./${t}`, e).href
  // Karena `t` dan `e` variabel (bukan pola literal `new URL('./x.mjs',
  // import.meta.url)`), Vite/Rollup TIDAK bisa mendeteksinya secara statis
  // sehingga `vite build` tidak pernah meng-emit file worker itu. Di produksi
  // `GET /assets/maplibre-gl-worker.mjs` -> 404, worker tidak boot, tile .pbf
  // tak pernah di-fetch, basemap tak pernah tampil (marker/kontrol tetap
  // muncul karena di main thread). KOREKSI komentar lama: klaim "`vite build`
  // pakai Rollup jadi produksi tidak terpengaruh" ITU SALAH untuk maplibre v6.
  // Ekstra: `maplibre-gl-worker.mjs` bukan file mandiri — baris pertamanya
  // `import ... from "./maplibre-gl-shared.mjs"` (~470 KB), jadi sekadar
  // meng-copy file worker 18 KB akan 404 di sibling itu. Worker harus
  // DI-BUNDLE, bukan cuma disalin.
  //
  // Perbaikan (di src/components/Map/MapView.jsx): impor worker via
  // `?worker&url` -> Vite mem-bundle worker + inline `maplibre-gl-shared.mjs`
  // jadi satu aset ber-hash, lalu `setWorkerUrl(url)` menyerahkannya ke
  // maplibre sebelum Map dibangun. `worker.format: 'es'` di bawah menyelaraskan
  // output worker dengan `new Worker(url, { type: 'module' })` milik maplibre.
  worker: {
    format: 'es',
  },
  // Dev-only: menjaga maplibre sebagai file berdiri sendiri di node_modules
  // supaya worker sibling tetap ter-resolve saat `npm run dev` (build produksi
  // sudah ditangani lewat `?worker&url` di atas).
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
