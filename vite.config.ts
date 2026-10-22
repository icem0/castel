import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  build: {
    // Top-level await in main.ts (DEV_MODE-Bootstrap) braucht ES2022.
    // Default ist 'modules' (= ES2020 ohne TLA), das bricht den Build.
    target: 'es2022',
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // SW-Generierung nur für den Production-Build; im Dev stört der SW den Vite-HMR.
      devOptions: { enabled: false },
      includeAssets: ['castel-logo.png'],
      manifest: {
        name: 'castel',
        short_name: 'castel',
        description: 'Offline-fähige Lagerverwaltung auf Basis IndexedDB.',
        lang: 'de-DE',
        start_url: '/',
        scope: '/',
        // Android/Chrome: 'fullscreen' blendet Adressleiste UND Statusleiste
        // aus — nur so verschwindet die Browsereinblendung im installierten
        // WebAPK wirklich. iOS kennt 'fullscreen' nicht und faellt laut
        // Spezifikation still auf 'standalone' zurueck; `display` bleibt
        // darum der sichere Fallback fuer Browser, die `display_override`
        // ignorieren (Safari, Firefox). A2HS-Metadaten dafuer stehen in
        // index.html.
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#0b3d91',
        icons: [
          { src: 'castel-logo.png', sizes: '192x192', type: 'image/png' },
          { src: 'castel-logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'castel-logo.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App-Shell precachen.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // config.js wird zur Laufzeit vom Container-Entrypoint generiert
        // (scripts/pwa-entrypoint.sh) und darf NICHT precached werden —
        // sonst liefert der SW eine stale URL aus.
        globIgnores: ['config.js'],
        // Bilder: CacheFirst mit Größenlimit (60 Einträge, 30 Tage).
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'castel-images',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
        ],
        // Navigation-Fallback für SPA-Routing im Offline-Modus.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
})
