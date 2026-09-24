/**
 * The one place the repository builds a GraphHopper command line (M2-01k-c2).
 *
 * The routing adapter sends every waypoint in the request line
 * (`GET /route?...&point=lat,lon`). Dropwizard's default request log writes that line to
 * stdout, which puts exact waypoints in the engine's operational log.
 *
 * The serving profile cannot switch it off yet. Its SHA-256 is pinned in every graph
 * manifest (`profileConfigSha256`), so editing the file would make each deployed graph
 * refuse to load (`PROFILE_CONFIG_MISMATCH`). The next graph rebuild adds
 * `server.request_log.appenders: []` to the profile.
 *
 * Until then protection rests on TWO things, and neither alone is enough:
 *
 * 1. **This launch override** selects Dropwizard's `external` request log. In the shipped
 *    jar, `ExternalRequestLogFactory` builds `new CustomRequestLog(new Slf4jRequestLogWriter(),
 *    ClassicLogFormat.pattern())`. It does not read `logback-access.xml`. Request lines
 *    therefore go to the application's SLF4J logger `org.eclipse.jetty.server.RequestLog` at
 *    INFO, and they carry the **path only, without the query string**, so without the
 *    waypoints. Measured with `probe-routing-engine-logs.mts --console-threshold INFO`.
 * 2. **The profile's console `threshold: WARN`.** It drops those INFO request lines. It is
 *    also the ONLY thing that stops GraphHopper's `com.graphhopper.resources.RouteResource`
 *    INFO line, which prints the waypoints themselves (`[37.57…,126.97…, …]`). Any
 *    INFO-level appender added later leaks those waypoints: a file appender, a lower
 *    threshold, or `-Ddw.logging.appenders[0].threshold=INFO`. This helper therefore never
 *    overrides `logging`, and the guard test requires every appender threshold to be WARN or
 *    higher.
 *
 * An empty appender list cannot be written as a JVM override (Dropwizard reads `[]` as a
 * string), and an indexed appender needs an array the profile does not have. So the
 * override switches the request log's type instead.
 *
 * Once a profile disables the request log itself, the override is left out. Two request-log
 * settings that disagree about the type are not left for Dropwizard to reconcile.
 *
 * `packages/tooling/tests/graphhopper-launch.test.mjs` fails when anything in the
 * repository launches the GraphHopper jar without this helper, when the override leaves it,
 * and when any appender threshold drops below WARN.
 */
import { readFileSync } from 'node:fs';

/** Request lines through the application logger, path only: the query string is not written. */
export const REQUEST_LOG_OVERRIDE = '-Ddw.server.request_log.type=external';

/**
 * Whether a serving profile disables Dropwizard's request log itself.
 *
 * @param {string} profileText
 * @returns {boolean}
 */
export function profileDisablesRequestLog(profileText) {
  return /^ {2}request_log:[ \t]*\r?\n {4}appenders:[ \t]*\[\][ \t]*$/m.test(profileText);
}

/**
 * @param {{
 *   jarPath: string,
 *   configPath: string,
 *   extractPath: string,
 *   graphPath: string,
 *   heapMegabytes?: number,
 *   initialHeapMegabytes?: number,
 *   ports?: { application: number, admin: number },
 * }} options
 * @returns {string[]} the arguments after `java`
 */
export function graphhopperJavaArguments(options) {
  const disabledInProfile = profileDisablesRequestLog(readFileSync(options.configPath, 'utf8'));
  return [
    `-Xmx${options.heapMegabytes ?? 2048}m`,
    `-Xms${options.initialHeapMegabytes ?? 512}m`,
    `-Ddw.graphhopper.datareader.file=${options.extractPath}`,
    `-Ddw.graphhopper.graph.location=${options.graphPath}`,
    ...(options.ports === undefined
      ? []
      : [
          `-Ddw.server.application_connectors[0].port=${options.ports.application}`,
          `-Ddw.server.admin_connectors[0].port=${options.ports.admin}`,
        ]),
    ...(disabledInProfile ? [] : [REQUEST_LOG_OVERRIDE]),
    '-jar',
    options.jarPath,
    'server',
    options.configPath,
  ];
}
