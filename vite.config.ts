import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          onnx: ['onnxruntime-web'],
        },
      },
    },
  },
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: [
            'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
            'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
            'node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs',
          ],
          dest: 'onnx',
        },
      ],
    }),
  ],
})
