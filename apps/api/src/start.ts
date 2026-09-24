import { z } from 'zod';
import { createConfiguredApi } from './configured.js';
import {
  applyRoutingSwitchFile,
  switchRefusalCode,
  type RoutingDeploymentSwitch,
} from './routing-deployment.js';

try {
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env['PORT'] ?? 4300);
  let routingDeployments: RoutingDeploymentSwitch | undefined;
  const app = await createConfiguredApi(process.env, {
    onRoutingDeployments: (control) => {
      routingDeployments = control;
    },
  });
  // Blue/green graph replacement (M2-01k-e): SIGHUP applies ROUTING_SWITCH_FILE. The log
  // carries build ids and a refusal code only, never a path or engine URL.
  const switchFile = process.env['ROUTING_SWITCH_FILE'];
  if (switchFile !== undefined && switchFile !== '') {
    const control = routingDeployments;
    if (control === undefined) throw new Error('ROUTING_SWITCH_FILE_WITHOUT_ROUTING');
    process.on('SIGHUP', () => {
      void applyRoutingSwitchFile(control, switchFile).then(
        (switched) => app.log.info({ event: 'routing_deployment_switched', ...switched }),
        (error: unknown) =>
          app.log.warn({
            event: 'routing_deployment_switch_refused',
            code: switchRefusalCode(error),
            active: control.activeGraphBuildId,
          }),
      );
    });
  }
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
