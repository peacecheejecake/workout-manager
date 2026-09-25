/**
 * The one place the repository builds a GraphHopper command line (M2-01k-c2, M2-01af).
 *
 * Exact waypoints can reach the engine's log two ways: Dropwizard's request log, which writes
 * every request line (a `GET /route?...&point=lat,lon` line carries the waypoints), and
 * GraphHopper's HTTP resources and exception mappers, which log request content at INFO
 * (`RouteResource`, `SPTResource`, `IsochroneResource`, `MapMatchingResource`,
 * `NavigateResource`, and the
 * `MultiExceptionMapper`/`IllegalArgumentExceptionMapper` lines that quote a failing point).
 *
 * Since M2-01af the serving profile closes both by itself, for any launch of it:
 *
 * - `server.request_log.appenders: []` switches the request log off (in the shipped
 *   Dropwizard 3.0.8, `LogbackAccessRequestLogFactory.isEnabled()` is
 *   `!appenders.isEmpty()`).
 * - `logging.level: WARN` produces no INFO event at all, and `logging.loggers` pins the three
 *   packages `com.graphhopper.resources`, `com.graphhopper.http` and `com.graphhopper.navigation`
 *   OFF, so a root level lowered to INFO does not bring their lines back. The first two log
 *   nothing at WARN or ERROR; pinning `navigation` also drops NavigateResource's one ERROR and
 *   NavigateResponseConverter's one WARN (the adapter never calls /navigate). DEBUG is not
 *   covered: other emitters (Dropwizard's `JsonProcessingExceptionMapper`, Jetty,
 *   `GHJerseyViolationExceptionMapper`) can carry request content at DEBUG.
 * - Every appender's `threshold: WARN` stays as a second layer.
 * - And the adapter sends waypoints in a POST body, never in a request line.
 *
 * The launch override below is for the profiles that do NOT switch the request log off:
 * the M2-01d measurement profile, and serving-profile copies deployed with graphs built
 * before M2-01af (their SHA-256 is pinned in those graphs' manifests, so they stay as they
 * are until the graph is replaced). For those, `-Ddw.server.request_log.type=external`
 * selects Dropwizard's `external` request log: in the shipped jar `ExternalRequestLogFactory`
 * builds `new CustomRequestLog(new Slf4jRequestLogWriter(), ClassicLogFormat.pattern())`, so
 * request lines go to the application logger `org.eclipse.jetty.server.RequestLog` at INFO
 * with the **path only, without the query string**, and the WARN threshold drops them.
 *
 * The helper decides from the profile text, with the strict reader below, and refuses a
 * profile that reader cannot read. A profile that switches the request log off
 * gets no override: the override's `external` type has no `appenders` property, and the real
 * jar refuses to start with both (`Unrecognized field at: server.request_log.appenders`,
 * measured in M2-01af). An empty appender list cannot be written as a JVM
 * override either (Dropwizard reads `[]` as a string).
 *
 * This helper never overrides `logging`: a logging override could lower a threshold or
 * unpin a logger. `packages/tooling/tests/graphhopper-launch.test.mjs` fails when anything
 * in the repository launches the GraphHopper jar without this helper, when the serving
 * profile stops switching the request log off, lowers its root level below WARN or unpins
 * one of those packages, when any appender
 * threshold or logger level drops below WARN, and when this helper's decision disagrees with
 * the guard's strict reading of a profile.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * For a profile that leaves the request log on: request lines through the application logger,
 * path only, the query string is not written.
 */
export const REQUEST_LOG_OVERRIDE = '-Ddw.server.request_log.type=external';

// ---------------------------------------------------------------------------------------
// The strict profile reader (M2-01af review F2). It lives here, not in the guard test, so the
// helper's decision to leave the override out and the guard's judgement are the same code. A
// file-wide pattern was not: it called a profile "disabled" for a `request_log` block under
// `graphhopper:`, a second one in `server:`, one inside a block scalar, or a second document.
// The grammar is described in packages/tooling/tests/graphhopper-launch.test.mjs.

const TOP_LEVEL_KEYS = new Set(['graphhopper', 'server', 'logging']);

export function refuseProfileLine(code, line) {
  throw new Error(line === undefined ? code : `${code}: ${JSON.stringify(line.slice(0, 60))}`);
}

export const isQuietProfileLine = (line) => line.trim() === '' || /^\s*#/.test(line);

/**
 * Whole-file checks and the top-level keys.
 *
 * @returns {{ lines: string[], starts: Map<string, number> }}
 */
export function profileLines(profileText) {
  if (profileText.startsWith('\uFEFF')) refuseProfileLine('BOM_NOT_ACCEPTED');
  if (profileText.includes('\r')) refuseProfileLine('CARRIAGE_RETURN_NOT_ACCEPTED');
  if (profileText.includes('\t')) refuseProfileLine('TAB_NOT_ACCEPTED');
  // SnakeYAML also breaks lines on NEL (U+0085), LS (U+2028) and PS (U+2029), so a comment
  // line split here only on `\n` could carry live YAML (re-check tree f7ccdc6a). The profiles
  // are pure ASCII: refuse everything outside printable ASCII and `\n`.
  if (/[^\x20-\x7E\n]/.test(profileText)) refuseProfileLine('NON_ASCII_OR_CONTROL_CHARACTER');
  const lines = profileText.split('\n');
  const starts = new Map();
  for (const [index, line] of lines.entries()) {
    if (isQuietProfileLine(line) || /^ /.test(line)) continue;
    const key = /^([a-z]+):$/.exec(line)?.[1];
    if (key === undefined || !TOP_LEVEL_KEYS.has(key))
      refuseProfileLine('UNREADABLE_TOP_LEVEL_LINE', line);
    if (starts.has(key)) throw new Error(`DUPLICATE_TOP_LEVEL_KEY: ${key}`);
    starts.set(key, index);
  }
  return { lines, starts };
}

/** The lines of one top-level block, up to the next column-0 key. */
export function blockLines(lines, start) {
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !isQuietProfileLine(line)) break;
    block.push(line);
  }
  return block;
}

/**
 * What a profile says about Dropwizard's request log: `disabled` only for exactly
 * `request_log:` / `    appenders: []`, `default` when `server` has no `request_log` (the
 * default request log, which writes every request line). Anything else throws.
 *
 * @returns {'disabled' | 'default'}
 */
export function requestLogSetting(profileText) {
  const { lines, starts } = profileLines(profileText);
  const serverStart = starts.get('server');
  if (serverStart === undefined) return 'default';
  const keys = new Set();
  let current = null;
  let requestLogLines = 0;
  for (const line of blockLines(lines, serverStart)) {
    if (isQuietProfileLine(line)) continue;
    if (/^ {2}\S/.test(line)) {
      const key = /^ {2}([a-z][a-z_]*):$/.exec(line)?.[1];
      if (key === undefined) refuseProfileLine('UNREADABLE_SERVER_LINE', line);
      if (keys.has(key)) refuseProfileLine('DUPLICATE_SERVER_KEY', key);
      keys.add(key);
      current = key;
      continue;
    }
    if (!/^ {4}/.test(line)) refuseProfileLine('UNREADABLE_SERVER_LINE', line);
    if (current !== 'request_log') continue;
    if (line !== '    appenders: []') refuseProfileLine('UNREVIEWED_REQUEST_LOG_LINE', line);
    requestLogLines += 1;
  }
  if (!keys.has('request_log')) return 'default';
  if (requestLogLines !== 1) refuseProfileLine('UNREVIEWED_REQUEST_LOG_SHAPE');
  return 'disabled';
}

/**
 * Whether a serving profile disables Dropwizard's request log itself, by the strict reader.
 * A profile the reader cannot read throws, so no engine is started from it: leaving the
 * override out on a misread would leak waypoints, and adding it to a profile that does switch
 * the log off stops the engine from starting.
 *
 * @param {string} profileText
 * @returns {boolean}
 */
export function profileDisablesRequestLog(profileText) {
  return requestLogSetting(profileText) === 'disabled';
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
 *   requestLogOverride?: 'profile' | 'add' | 'omit',
 * }} options `requestLogOverride` is for `probe-routing-engine-logs.mts` alone, which runs a
 *   profile both ways to show what each layer does. Every launcher leaves it at `profile`:
 *   the override is added exactly when the profile leaves the request log on. The guard test
 *   fails when any other file passes it.
 * @returns {string[]} the arguments after `java`
 */
export function graphhopperJavaArguments(options) {
  const choice = options.requestLogOverride ?? 'profile';
  if (!['profile', 'add', 'omit'].includes(choice))
    throw new Error(`UNKNOWN_REQUEST_LOG_OVERRIDE_CHOICE: ${String(choice)}`);
  const addOverride =
    choice === 'profile'
      ? !profileDisablesRequestLog(readFileSync(options.configPath, 'utf8'))
      : choice === 'add';
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
    ...(addOverride ? [REQUEST_LOG_OVERRIDE] : []),
    '-jar',
    options.jarPath,
    'server',
    options.configPath,
  ];
}

/**
 * The manual launch the runbook uses, so a person starting the engine by hand gets the same
 * command line as every launcher (M2-01af). Paths must be absolute.
 *
 *   node scripts/geo/graphhopper-launch.mjs --jar <jar> --config <profile> --extract <pbf>
 *     --graph <graph dir> [--application-port <n> --admin-port <n>] [--print]
 *
 * `--print` writes the argument vector instead of starting the engine.
 */
async function launchFromCommandLine(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const paths = {
    jarPath: value('--jar'),
    configPath: value('--config'),
    extractPath: value('--extract'),
    graphPath: value('--graph'),
  };
  for (const [name, path] of Object.entries(paths))
    if (path === undefined || !isAbsolute(path)) throw new Error(`ABSOLUTE_PATH_REQUIRED: ${name}`);
  const application = value('--application-port');
  const admin = value('--admin-port');
  if ((application === undefined) !== (admin === undefined))
    throw new Error('BOTH_PORTS_OR_NEITHER');
  for (const port of [application, admin])
    if (port !== undefined && !(/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535))
      throw new Error(`PORT_NOT_AN_INTEGER_1_TO_65535: ${port}`);
  const javaArguments = graphhopperJavaArguments({
    jarPath: String(paths.jarPath),
    configPath: String(paths.configPath),
    extractPath: String(paths.extractPath),
    graphPath: String(paths.graphPath),
    ...(application === undefined
      ? {}
      : { ports: { application: Number(application), admin: Number(admin) } }),
  });
  if (argv.includes('--print')) {
    process.stdout.write(`${JSON.stringify(['java', ...javaArguments])}\n`);
    return;
  }
  const child = spawn('java', javaArguments, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await launchFromCommandLine(process.argv.slice(2));
