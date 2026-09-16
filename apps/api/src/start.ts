import { z } from 'zod';
import { createConfiguredApi } from './configured.js';

try {
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env['PORT'] ?? 4300);
  const app = await createConfiguredApi(process.env);
  process.once('SIGTERM', () => {
    void app.close();
  });
  process.once('SIGINT', () => {
    void app.close();
  });
  await app.listen({ port, host: '127.0.0.1' });
} catch {
  // Configuration/provider errors can contain credentials and issuer payloads.
  process.stderr.write('API startup failed; verify identity and database configuration.\n');
  process.exitCode = 1;
}
