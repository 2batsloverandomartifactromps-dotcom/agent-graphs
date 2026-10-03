import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.AGENT_GRAPHS_URL ?? 'http://127.0.0.1:4747';
const proxy = { '/api': api, '/health': api, '/mcp': api };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  worker: { format: 'es' },
  build: {
    // The largest vendor group (CodeMirror) only loads with the spec editors.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-flow', test: /node_modules[\\/](@xyflow|d3-[a-z-]+|@dagrejs)[\\/]/ },
            {
              name: 'vendor-markdown',
              test: /node_modules[\\/](react-markdown|remark-[a-z-]+|rehype-[a-z-]+|micromark[a-z-]*|mdast-[a-z-]+|hast-[a-z-]+|unified|vfile[a-z-]*|unist-[a-z-]+)[\\/]/,
            },
            { name: 'vendor-schema', test: /node_modules[\\/](zod|yaml)[\\/]/ },
            {
              name: 'vendor-ui',
              test: /node_modules[\\/](@radix-ui|radix-ui|@tanstack|cmdk|sonner|lucide-react)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
