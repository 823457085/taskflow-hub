import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(mode === 'singlefile' ? [viteSingleFile()] : []),
  ],
  ...(mode !== 'singlefile'
    ? {
        build: {
          chunkSizeWarningLimit: 750,
          rolldownOptions: {
            output: {
              manualChunks(id: string) {
                if (!id.includes('node_modules')) return undefined;
                if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
                  return 'vendor-react';
                }
                if (id.includes('lucide-react')) {
                  return 'vendor-icons';
                }
                if (id.includes('@ant-design/icons')) {
                  return 'vendor-antd-icons';
                }
                if (id.includes('@ant-design/cssinjs')) {
                  return 'vendor-antd-cssinjs';
                }
                return undefined;
              },
            },
          },
        },
      }
    : {}),
  server: {
    host: '127.0.0.1',
    port: 5186,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5187',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            if (incoming.headers.origin === 'http://127.0.0.1:5186') {
              request.setHeader('origin', 'http://127.0.0.1:5187');
            }
          });
        },
      },
    },
  },
}));
