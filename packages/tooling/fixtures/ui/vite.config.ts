import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  build: { outDir: '../../dist/fixture', emptyOutDir: true },
  plugins: [
    {
      name: 'development-only-echo',
      configureServer(server) {
        server.middlewares.use('/fixture-api/echo', (request, response) => {
          response.setHeader('Content-Type', 'application/json');
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }
          let body = '';
          request.setEncoding('utf8');
          request.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > 4096) request.destroy();
          });
          request.on('end', () => {
            try {
              const payload: unknown = JSON.parse(body);
              if (
                typeof payload !== 'object' ||
                payload === null ||
                !('message' in payload) ||
                typeof payload.message !== 'string' ||
                !payload.message.trim() ||
                payload.message.length > 200
              ) {
                throw new Error('Invalid message');
              }
              response.end(JSON.stringify({ message: payload.message.trim() }));
            } catch {
              response.statusCode = 400;
              response.end(JSON.stringify({ error: 'Invalid fixture message' }));
            }
          });
        });
      },
    },
  ],
});
