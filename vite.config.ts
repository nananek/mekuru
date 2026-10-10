import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const sha = (process.env.VITE_APP_SHA || process.env.GITHUB_SHA || 'dev').slice(0, 7);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}+${sha}`),
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Mekuru（めくる）- ミニマル・クロッキー',
        short_name: 'Mekuru',
        description: 'Apple Pencil 特化型 ミニマル・クロッキー PWA',
        theme_color: '#fdfbf7',
        background_color: '#fdfbf7',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        debug: new URL('./debug.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 3000,
    host: true,
  },
});
