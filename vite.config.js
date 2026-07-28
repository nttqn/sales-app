import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false, // đăng ký thủ công qua virtual:pwa-register trong main.js để hiện banner cập nhật
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'SalesFlow - Quản lý bán hàng',
        short_name: 'SalesFlow',
        description: 'Quản lý đơn hàng, tồn kho, doanh thu và lợi nhuận',
        theme_color: '#4f46e5',
        background_color: '#0f0f1a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith('supabase.co'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
