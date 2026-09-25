import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUEST_LOG_OVERRIDE,
  blockLines,
  graphhopperJavaArguments,
  isQuietProfileLine as isQuiet,
  profileDisablesRequestLog,
  profileLines,
  refuseProfileLine as refuse,
  requestLogSetting,
} from '../../../scripts/geo/graphhopper-launch.mjs';

/**
 * M2-01k-c2, M2-01af: no GraphHopper launch writes waypoints to the engine's log.
 *
 * What keeps them out, and this file guards each:
 *
 * 1. The serving profile itself (M2-01af): `server.request_log.appenders: []` switches the
 *    request log off, and `logging.loggers` pins `RouteResource` (which prints each route
 *    request's points at INFO) to WARN or higher. That holds for any launch of the profile,
 *    with or without the repository's helper.
 * 2. Every console/file appender threshold of each GraphHopper profile at WARN or higher, a
 *    second layer under the logger pin.
 * 3. For a profile that does not switch the request log off itself (the M2-01d measurement
 *    profile, and serving-profile copies deployed before M2-01af), the launch override:
 *    request lines go to the application logger without the query. Every launch in the
 *    repository must be built by the helper that adds it.
 */
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const geoDirectory = join(repositoryRoot, 'scripts/geo');
const servingProfile = join(geoDirectory, 'graphhopper-foot-serving.yml');
const helperPath = join(geoDirectory, 'graphhopper-launch.mjs');
const runbookPath = join(repositoryRoot, 'docs/implementation/operations-runbook.md');
const thisFile = fileURLToPath(import.meta.url);
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const logProbe = 'scripts/probe-routing-engine-logs.mts';

function argumentsFor(configPath, extra = {}) {
  return graphhopperJavaArguments({
    jarPath: '/jar/graphhopper-web.jar',
    configPath,
    extractPath: '/extract.osm.pbf',
    graphPath: '/graph',
    ...extra,
  });
}

// ---------------------------------------------------------------------------------------
// Profile logging settings, read by a strict line grammar that fails closed.
//
// Why a grammar and not a YAML parser: no YAML parser is a dependency of this workspace (the
// only copy is js-yaml as a transitive dependency under node_modules/.pnpm, which the
// workspace cannot import without changing the lockfile). A parser would also have to
// reproduce Dropwizard's own merge of `logging` (duplicate keys, `loggers`, `additive`)
// to be trusted. The profiles use one small shape, so instead every line of that shape is
// matched exactly, and ANY other line — a quoted key, a space before a colon, explicit-key
// `?`/`:`, anchors, aliases, tags, flow style, a document separator, a directive, a tab, a
// CRLF or a BOM — throws. A spelling YAML accepts but this grammar does not know is refused,
// never skipped.
//
// Rules (re-checks of trees 29167499 and 73b11518, extended in M2-01af):
//
// - Column 0 holds only comments, blank lines and `graphhopper:`, `server:`, `logging:` —
//   the exact top-level keys the profiles use — each at most once (Jackson keeps the last of
//   duplicate keys, so a second `logging` would replace the block read here).
// - `logging:` holds `level:`, `loggers:` and `appenders:` at most once each, and nothing
//   else. Each line belongs to the section opened last.
// - `loggers:` (M2-01af) holds only the string form `    <java.logger.name>: <LEVEL>`, each
//   logger at most once. That form sets a level and nothing else: the logger keeps the root
//   appenders, so their thresholds still apply. The object form (`level`, `additive`,
//   its own `appenders`) is refused rather than read: with `additive: false` a per-logger
//   INFO console for `RouteResource` would print waypoints while every root appender reads
//   WARN (re-check tree 29167499, X1). Reading it correctly means reproducing Dropwizard's
//   inheritance; refusing it makes any per-logger appender a reviewed change to this guard.
// - `appenders:` is a block list. Each item starts `    - type: <word>`. Its fields are
//   `      <key>: <plain value>` with a letters-only key, each key at most once, and a plain
//   value that starts with no YAML indicator. `threshold` must be one of the log levels.
// - `server:` (M2-01af) is read for one thing, `request_log`. Its direct keys must be spelled
//   `  <snake_case>:` with nothing after the colon, each at most once, so no other spelling of
//   `request_log` (quoted, flow, merge key, inline value) can sit beside the one read here.
//   `request_log:` may hold exactly one line, `    appenders: []`, and nothing else.

const SAFE_THRESHOLDS = new Set(['WARN', 'ERROR', 'OFF']);
const LEVEL = '(?:ALL|TRACE|DEBUG|INFO|WARN|ERROR|OFF)';
const PLAIN_VALUE = String.raw`[A-Za-z0-9_/.][A-Za-z0-9_/.:+-]*`;
const JAVA_NAME = String.raw`[a-z][A-Za-z0-9_$]*(?:\.[A-Za-z][A-Za-z0-9_$]*)*`;
const LOGGING_LINE_SHAPES = [
  { kind: 'level', pattern: new RegExp(`^ {2}level: (${LEVEL})$`) },
  { kind: 'loggers', pattern: /^ {2}loggers:$/ },
  { kind: 'appenders', pattern: /^ {2}appenders:$/ },
  { kind: 'logger', pattern: new RegExp(`^ {4}(${JAVA_NAME}): (${LEVEL})$`) },
  { kind: 'item', pattern: /^ {4}- type: ([a-z][a-z-]*)$/ },
  { kind: 'threshold', pattern: new RegExp(`^ {6}threshold: (${LEVEL})$`) },
  { kind: 'field', pattern: new RegExp(`^ {6}([A-Za-z]+): (${PLAIN_VALUE})$`) },
];
/**
 * The GraphHopper 10.0 packages whose loggers write request content at INFO (M2-01af review,
 * jar bytecode and the real engine): the HTTP resources (`RouteResource`, `SPTResource`,
 * `IsochroneResource`, `MapMatchingResource` log the request's points) and the exception
 * mappers (`MultiExceptionMapper`, `IllegalArgumentExceptionMapper` quote the failing point).
 * Pinned whole: a class-by-class list missed `SPTResource`, and the review saw it print a
 * planted waypoint with the root level at INFO. `resources` and `http` log nothing at WARN or
 * ERROR; `navigation` is listed below.
 */
export const RESOURCES_PACKAGE = 'com.graphhopper.resources';
export const REQUEST_CONTENT_PACKAGES = [
  RESOURCES_PACKAGE,
  'com.graphhopper.http',
  // Review round 2: NavigateResource (registered by GraphHopperApplication, not the bundle)
  // logs the request's points at INFO. Pinning the package also drops its one ERROR and
  // NavigateResponseConverter's one WARN; the adapter never calls /navigate.
  'com.graphhopper.navigation',
];

/**
 * @returns {{
 *   level: string | null,
 *   appenders: { type: string, threshold: string | null }[],
 *   loggers: Map<string, string>,
 * }}
 */
export function loggingSettings(profileText) {
  const { lines, starts } = profileLines(profileText);
  const loggingStart = starts.get('logging');
  if (loggingStart === undefined) refuse('PROFILE_HAS_NO_LOGGING_BLOCK');

  // Inside `logging:`: every line matches exactly one allowed shape, in the right section.
  const appenders = [];
  const loggers = new Map();
  /** @type {string | null} */
  let level = null;
  const seenKeys = new Set();
  /** @type {'none' | 'loggers' | 'appenders'} */
  let section = 'none';
  /** @type {Set<string> | null} */
  let fieldsOfItem = null;
  for (const line of blockLines(lines, loggingStart)) {
    if (isQuiet(line)) continue;
    const shape = LOGGING_LINE_SHAPES.find(({ pattern }) => pattern.test(line));
    if (shape === undefined) {
      const key = /^ {2}([a-z]+):/.exec(line)?.[1];
      if (key !== undefined && !['level', 'loggers', 'appenders'].includes(key))
        throw new Error(`UNREVIEWED_LOGGING_KEY: ${key}`);
      refuse('UNREADABLE_LOGGING_LINE', line);
    }
    const match = shape.pattern.exec(line) ?? [];
    if (shape.kind === 'level') level = match[1] ?? null;
    switch (shape.kind) {
      case 'level':
      case 'loggers':
      case 'appenders':
        if (seenKeys.has(shape.kind)) refuse('DUPLICATE_LOGGING_KEY', shape.kind);
        seenKeys.add(shape.kind);
        section = shape.kind === 'level' ? 'none' : shape.kind;
        fieldsOfItem = null;
        break;
      case 'logger': {
        if (section !== 'loggers') refuse('LOGGER_OUTSIDE_LOGGERS', line);
        const name = match[1] ?? '';
        if (loggers.has(name)) refuse('DUPLICATE_LOGGER', name);
        loggers.set(name, match[2] ?? '');
        break;
      }
      case 'item':
        if (section !== 'appenders') refuse('APPENDER_OUTSIDE_APPENDERS', line);
        appenders.push({ type: match[1] ?? '', threshold: null });
        fieldsOfItem = new Set(['type']);
        break;
      case 'threshold':
      case 'field': {
        const key = shape.kind === 'threshold' ? 'threshold' : (match[1] ?? '');
        if (section !== 'appenders' || fieldsOfItem === null)
          refuse('APPENDER_FIELD_BEFORE_ITEM', line);
        if (fieldsOfItem.has(key)) refuse('DUPLICATE_APPENDER_FIELD', key);
        fieldsOfItem.add(key);
        const current = appenders.at(-1);
        if (current !== undefined && shape.kind === 'threshold')
          current.threshold = match[1] ?? null;
        break;
      }
    }
  }
  if (!seenKeys.has('appenders') || appenders.length === 0) refuse('PROFILE_HAS_NO_APPENDERS');
  if (seenKeys.has('loggers') && loggers.size === 0) refuse('EMPTY_LOGGERS');
  return { level, appenders, loggers };
}

/** @returns {{ type: string, threshold: string | null }[]} */
export function loggingAppenders(profileText) {
  return loggingSettings(profileText).appenders;
}

// ---------------------------------------------------------------------------------------
// Launch detection, in any quoting or template form, in code, shell, YAML, Dockerfiles,
// package.json scripts and documentation code blocks.

const LAUNCH_PATTERNS = [
  // A shell or template command: `java … -jar`, including backslash-continued lines.
  { rule: 'java-dash-jar', pattern: /\bjava\b[^\n;|&]*?\s-jar\b/ },
  // A process API given `java` as the program, in any quote style.
  {
    rule: 'process-api-java',
    pattern:
      /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execa|execaSync)\s*\(\s*[`'"]java[`'"]/,
  },
  // An argument vector element `-jar`, in any quote style.
  { rule: 'argv-dash-jar', pattern: /[`'"]-jar[`'"]/ },
];

/** @returns {string[]} the launch rules the text matches */
export function launchRules(text) {
  const joined = text.replace(/\\\r?\n\s*/g, ' ');
  return LAUNCH_PATTERNS.filter(({ pattern }) => pattern.test(joined)).map(({ rule }) => rule);
}

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.geo-build',
  '.git',
  '.claude',
  '.turbo',
  'coverage',
  'test-results',
  'playwright-report',
  '.venv',
  '__pycache__',
]);
const CODE_FILE = /\.(?:mjs|mts|cjs|cts|js|ts|tsx|jsx|sh|bash|zsh|py|yml|yaml)$/;

async function repositoryFiles(directory = repositoryRoot) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('worktree')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await repositoryFiles(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** The launchable text of a file: code as is, package.json scripts, Markdown code blocks. */
function launchableChunks(path, text) {
  const name = basename(path);
  if (name === 'package.json') {
    const scripts = JSON.parse(text).scripts ?? {};
    return Object.values(scripts).map(String);
  }
  if (name.endsWith('.md')) return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (name.startsWith('Dockerfile') || CODE_FILE.test(name)) return [text];
  return [];
}

async function launchOffenders() {
  const offenders = [];
  for (const path of await repositoryFiles()) {
    if (path === helperPath || path === thisFile) continue;
    const text = await readFile(path, 'utf8').catch(() => '');
    const chunks = launchableChunks(path, text);
    for (const chunk of chunks) {
      const rules = launchRules(chunk);
      if (rules.length === 0) continue;
      const where = relative(repositoryRoot, path);
      // Documentation has no helper to call: a raw `java` launch there (the runbook's before
      // M2-01af) is an offender. The runbook launches through the helper's command line.
      if (path.endsWith('.md')) {
        offenders.push(`${where}: documented java launch (use the helper's command line)`);
        continue;
      }
      const problem = codeLaunchProblem(text, chunk, rules);
      if (problem !== null) offenders.push(`${where}: ${problem}`);
    }
  }
  return offenders;
}

const PROCESS_API_JAVA =
  /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execa|execaSync)\s*\(\s*[`'"]java[`'"]\s*,?\s*/g;

/**
 * Code may start `java` only with the helper's argument vector, and never spell `-jar`
 * itself. Checked per call, not per file: a file that uses the helper once may not start
 * `java` a second time with arguments of its own.
 *
 * @returns {string | null} what is wrong, or null
 */
export function codeLaunchProblem(fileText, chunk, rules = launchRules(chunk)) {
  if (rules.some((rule) => rule !== 'process-api-java')) return rules.join(',');
  if (!/from ['"][./]*(?:geo\/)?graphhopper-launch\.mjs['"]/.test(fileText))
    return 'java without the launch helper';
  const joined = chunk.replace(/\\\r?\n\s*/g, ' ');
  for (const call of joined.matchAll(PROCESS_API_JAVA)) {
    const rest = joined.slice((call.index ?? 0) + call[0].length);
    if (!/^graphhopperJavaArguments\(/.test(rest)) return 'java with arguments not from the helper';
  }
  return null;
}

async function graphhopperProfiles() {
  const profiles = (await readdir(geoDirectory)).filter((name) =>
    /^graphhopper-.*\.ya?ml$/.test(name),
  );
  expect(profiles).toContain('graphhopper-foot-serving.yml');
  return profiles;
}

describe('GraphHopper launch arguments', () => {
  it('add no request-log override for the serving profile, which switches the log off itself', () => {
    const args = argumentsFor(servingProfile);
    // M2-01af: the profile is safe on its own, so the helper adds nothing that disagrees
    // with it. Dropwizard refuses `appenders` under the `external` type the override selects.
    expect(args).not.toContain(REQUEST_LOG_OVERRIDE);
    expect(args.filter((arg) => arg.startsWith('-Ddw.server.request_log'))).toEqual([]);
    expect(args.slice(-2)).toEqual(['server', servingProfile]);
    // The helper never touches logging: a logging override could lower a threshold or
    // unpin a logger.
    expect(args.filter((arg) => arg.startsWith('-Ddw.logging'))).toEqual([]);
  });

  it('add the override, before -jar, for a profile that leaves the request log on', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gh-launch-'));
    scratch.push(directory);
    // The M2-01d measurement profile, and serving-profile copies deployed before M2-01af.
    const measurement = join(geoDirectory, 'graphhopper-foot.yml');
    const withoutSetting = join(directory, 'serving-before-m2-01af.yml');
    const text = await readFile(servingProfile, 'utf8');
    const enabled = text.replace('  request_log:\n    appenders: []\n', '');
    expect(enabled).not.toBe(text);
    await writeFile(withoutSetting, enabled);
    for (const profile of [measurement, withoutSetting]) {
      const args = argumentsFor(profile);
      expect(args, profile).toContain(REQUEST_LOG_OVERRIDE);
      // A JVM system property after -jar would be an application argument and do nothing.
      expect(args.indexOf(REQUEST_LOG_OVERRIDE)).toBeLessThan(args.indexOf('-jar'));
      expect(args.filter((arg) => arg.startsWith('-Ddw.logging'))).toEqual([]);
    }
    // A profile that merely mentions the key, or keeps appenders, is not trusted.
    expect(profileDisablesRequestLog(enabled)).toBe(false);
    // A request log with appenders is not a shape the strict reader knows: refused, not trusted.
    expect(() =>
      profileDisablesRequestLog('server:\n  request_log:\n    appenders:\n      - type: console\n'),
    ).toThrow('UNREVIEWED_REQUEST_LOG_LINE');
  });

  it("decide exactly as the guard's strict reader does, for every GraphHopper profile", async () => {
    for (const name of await graphhopperProfiles()) {
      const text = await readFile(join(geoDirectory, name), 'utf8');
      expect(profileDisablesRequestLog(text), name).toBe(requestLogSetting(text) === 'disabled');
    }
  });

  /**
   * M2-01af review F2: a file-wide pattern called each of these "disabled" and left the
   * override out, while the strict reader said `default` or refused. Now the helper uses the
   * strict reader, so for each one it either adds the override or refuses to build a command
   * line at all. It never leaves the override out.
   */
  it('never leave the override out for a profile the strict reader does not call disabled', async () => {
    const real = await readFile(servingProfile, 'utf8');
    const requestLog = '  request_log:\n    appenders: []\n';
    const enabled = real.replace(requestLog, '');
    expect(enabled).not.toBe(real);
    const corpus = {
      under_graphhopper: enabled.replace('graphhopper:\n', `graphhopper:\n${requestLog}`),
      under_logging: enabled.replace('logging:\n', `logging:\n${requestLog}`),
      inside_block_scalar: enabled.replace(
        'graphhopper:\n',
        `graphhopper:\n  note: |\n  ${requestLog.replaceAll('\n  ', '\n    ')}`,
      ),
      second_request_log_in_server: real.replace(
        requestLog,
        `${requestLog}  request_log:\n    type: classic\n`,
      ),
      duplicate_appenders: real.replace(
        requestLog,
        `${requestLog}    appenders:\n      - type: console\n`,
      ),
      camel_case_beside: real.replace(
        requestLog,
        `${requestLog}  requestLog:\n    type: classic\n`,
      ),
      type_external_beside: real.replace(requestLog, `${requestLog}    type: external\n`),
      second_document: `${real}---\nserver:\n  request_log:\n    type: classic\n`,
    };
    const directory = await mkdtemp(join(tmpdir(), 'gh-launch-corpus-'));
    scratch.push(directory);
    for (const [name, text] of Object.entries(corpus)) {
      expect(text, name).not.toBe(real);
      const profile = join(directory, `${name}.yml`);
      await writeFile(profile, text);
      let verdict;
      try {
        verdict = requestLogSetting(text);
      } catch {
        verdict = 'refused';
      }
      expect(verdict, name).not.toBe('disabled');
      if (verdict === 'refused') expect(() => argumentsFor(profile), name).toThrow();
      else expect(argumentsFor(profile), name).toContain(REQUEST_LOG_OVERRIDE);
    }
  });
});

describe('GraphHopper profile logging', () => {
  const safeAppender = '    - type: console\n      threshold: WARN\n';
  it('are WARN or higher on every appender and every logger of every GraphHopper profile', async () => {
    for (const name of await graphhopperProfiles()) {
      const { appenders, loggers } = loggingSettings(
        await readFile(join(geoDirectory, name), 'utf8'),
      );
      for (const appender of appenders)
        expect(
          { profile: name, type: appender.type, threshold: appender.threshold },
          'an appender without WARN+ would print RouteResource waypoints',
        ).toEqual({
          profile: name,
          type: appender.type,
          threshold: expect.toSatisfy((value) => SAFE_THRESHOLDS.has(String(value))),
        });
      // A logger's level is a floor, not a threshold: WARN+ only, so none reads as a switch
      // that turns verbose output back on.
      for (const [logger, level] of loggers)
        expect({ profile: name, logger, level }).toEqual({
          profile: name,
          logger,
          level: expect.toSatisfy((value) => SAFE_THRESHOLDS.has(String(value))),
        });
    }
  });

  /**
   * M2-01af: the serving profile is safe by itself, for a launch that does not go through
   * the helper. The request log is off in the file; the root level is WARN, so no INFO event
   * is produced; and both GraphHopper packages that write request content at INFO are pinned
   * at WARN or higher, so a root level lowered to INFO does not bring those lines back. (A
   * more specific logger inside them could lower it again; the rule above refuses any logger
   * below WARN.) Nothing here makes DEBUG safe.
   */
  it('the serving profile switches the request log off and pins the request-content packages itself', async () => {
    const text = await readFile(servingProfile, 'utf8');
    expect(requestLogSetting(text)).toBe('disabled');
    const { level, loggers } = loggingSettings(text);
    expect(level, 'the root level').toEqual(
      expect.toSatisfy((value) => SAFE_THRESHOLDS.has(String(value))),
    );
    for (const logger of REQUEST_CONTENT_PACKAGES)
      expect({ logger, level: loggers.get(logger) }, 'writes request content at INFO').toEqual({
        logger,
        level: expect.toSatisfy((value) => SAFE_THRESHOLDS.has(String(value))),
      });
  });

  it('read the request log and the loggers by the same strict grammar', async () => {
    const real = await readFile(servingProfile, 'utf8');
    const requestLog = '  request_log:\n    appenders: []\n';
    const pin = `    ${RESOURCES_PACKAGE}: OFF\n`;
    expect(real.split(requestLog)).toHaveLength(2);
    expect(real.split(pin)).toHaveLength(2);
    const withRequestLog = (replacement) => real.replace(requestLog, replacement);
    const withPin = (replacement) => real.replace(pin, replacement);

    // Accepted: the setting absent (the default request log), and other plain loggers.
    expect(requestLogSetting(withRequestLog(''))).toBe('default');
    expect(requestLogSetting(real.replace(/^server:\n(?: .*\n|\n)*/m, ''))).toBe('default');
    expect([
      ...loggingSettings(withPin(`${pin}    org.eclipse.jetty: ERROR\n`)).loggers.keys(),
    ]).toEqual([RESOURCES_PACKAGE, 'org.eclipse.jetty', ...REQUEST_CONTENT_PACKAGES.slice(1)]);

    const refusedRequestLog = {
      appender_list: withRequestLog('  request_log:\n    appenders:\n      - type: console\n'),
      flow_appender: withRequestLog('  request_log:\n    appenders: [{type: console}]\n'),
      type_beside_empty_list: withRequestLog(`${requestLog}    type: classic\n`),
      empty_block: withRequestLog('  request_log:\n'),
      inline_value: withRequestLog('  request_log: {appenders: []}\n'),
      quoted_key: withRequestLog('  "request_log":\n    appenders: []\n'),
      second_request_log: withRequestLog(`${requestLog}  request_log:\n    type: external\n`),
      merge_key: withRequestLog(`${requestLog}  <<: *defaults\n`),
      duplicate_empty_list: withRequestLog(`${requestLog}    appenders: []\n`),
      three_space_indent: withRequestLog('  request_log:\n   appenders: []\n'),
    };
    for (const [name, text] of Object.entries(refusedRequestLog))
      expect(() => requestLogSetting(text), name).toThrow();

    const refusedLoggers = {
      // X1 (re-check tree 29167499): a per-logger appender for RouteResource at INFO, in the
      // object form. The root appender still reads WARN, and the real engine printed the
      // planted waypoints.
      X1_object_form: withPin(
        `    ${RESOURCES_PACKAGE}.RouteResource:\n      level: INFO\n      additive: false\n` +
          '      appenders:\n        - type: console\n          threshold: INFO\n',
      ),
      quoted_logger: withPin(`    "${RESOURCES_PACKAGE}": OFF\n`),
      duplicate_logger: withPin(`${pin}    ${RESOURCES_PACKAGE}: INFO\n`),
      unknown_level: withPin(`    ${RESOURCES_PACKAGE}: QUIET\n`),
      quoted_level: withPin(`    ${RESOURCES_PACKAGE}: "OFF"\n`),
      flow_loggers: real.replace(
        / {2}loggers:\n {4}.*\n/,
        `  loggers: {${RESOURCES_PACKAGE}: OFF}\n`,
      ),
      second_loggers: real.replace('  appenders:\n', `  loggers:\n${pin}  appenders:\n`),
      logger_among_appenders: real.replace(
        safeAppender,
        `${safeAppender}    org.eclipse.jetty: ERROR\n`,
      ),
      empty_loggers: real.replace(/( {2}loggers:\n)(?: {4}.*\n)+/, '$1'),
    };
    for (const [name, text] of Object.entries(refusedLoggers))
      expect(() => loggingSettings(text), name).toThrow();
  });

  it('read every appender, so one safe appender cannot hide an unsafe one', () => {
    const profile = (appenders) =>
      `server:\n  x: 1\n\nlogging:\n  level: INFO\n  appenders:\n${appenders}`;
    expect(
      loggingAppenders(
        profile(
          '    - type: console\n      threshold: WARN\n    - type: file\n      threshold: INFO\n',
        ),
      ),
    ).toEqual([
      { type: 'console', threshold: 'WARN' },
      { type: 'file', threshold: 'INFO' },
    ]);
    // No threshold means Dropwizard's default, ALL.
    expect(loggingAppenders(profile('    - type: console\n'))).toEqual([
      { type: 'console', threshold: null },
    ]);
    // Shapes this reader does not know are refused, not passed.
    expect(() => loggingAppenders(profile('    [console]\n'))).toThrow();
    expect(() => loggingAppenders('logging:\n  appenders: [ { type: console } ]\n')).toThrow();
    expect(() => loggingAppenders('server:\n  x: 1\n')).toThrow();
    const safe = profile('    - type: console\n      threshold: WARN\n');
    expect(loggingAppenders(safe)).toEqual([{ type: 'console', threshold: 'WARN' }]);
    // X1 (re-check tree 29167499): a per-logger appender for RouteResource at INFO. The root
    // appender still reads WARN, and the real engine printed the planted waypoints. Only the
    // string form of a logger is read (M2-01af); the object form stays refused.
    expect(() =>
      loggingAppenders(
        `${safe}  loggers:\n    com.graphhopper.resources.RouteResource:\n      level: INFO\n` +
          '      additive: false\n      appenders:\n        - type: console\n          threshold: INFO\n',
      ),
    ).toThrow('UNREADABLE_LOGGING_LINE');
    // X2: a second top-level `logging:` at the end. Jackson keeps the last duplicate key.
    expect(() =>
      loggingAppenders(
        `${safe}\nlogging:\n  level: INFO\n  appenders:\n    - type: console\n      threshold: INFO\n`,
      ),
    ).toThrow('DUPLICATE_TOP_LEVEL_KEY: logging');
    // Any other duplicate top-level key, and any other key under `logging`, is refused too.
    expect(() => loggingAppenders(`${safe}server:\n  y: 2\n`)).toThrow('DUPLICATE_TOP_LEVEL_KEY');
    expect(() => loggingAppenders(`${safe}  include: other.yml\n`)).toThrow(
      'UNREVIEWED_LOGGING_KEY',
    );
  });

  it('refuse every other YAML spelling, and accept only the exact shape', async () => {
    const real = await readFile(servingProfile, 'utf8');
    const safeLine = '      threshold: WARN\n';
    expect(real.split(safeLine)).toHaveLength(2);
    const replaced = (replacement) => real.replace(safeLine, replacement);
    const secondLogging = (header, body = '  level: INFO\n  appenders:\n') =>
      `${real}\n${header}\n${body}    - type: console\n      threshold: INFO\n`;
    const refused = {
      // Re-check tree 73b11518: a second `logging` the old lexical duplicate check missed.
      B1_quoted_key: secondLogging('"logging":'),
      B2_space_before_colon: secondLogging('logging :'),
      B3_explicit_key: `${real}\n? logging\n: level: INFO\n`,
      // Spellings YAML accepts that a naive reader might skip.
      quoted_threshold_key: replaced('      "threshold": INFO\n'),
      space_before_threshold_colon: replaced('      threshold : INFO\n'),
      second_document: `${real}---\nlogging:\n  appenders:\n    - type: console\n      threshold: INFO\n`,
      yaml_directive: `%YAML 1.2\n---\n${real}`,
      crlf_line_endings: real.replaceAll('\n', '\r\n'),
      byte_order_mark: `\uFEFF${real}`,
      tab_indentation: replaced('\tthreshold: WARN\n'),
      anchor_on_item: real.replace('    - type: console\n', '    - &c type: console\n'),
      alias_as_threshold: replaced('      threshold: *level\n'),
      tagged_threshold: replaced('      threshold: !!str INFO\n'),
      quoted_threshold_value: replaced('      threshold: "WARN"\n'),
      threshold_with_comment: replaced('      threshold: WARN # quiet\n'),
      duplicate_threshold: replaced('      threshold: WARN\n      threshold: INFO\n'),
      flow_style_appenders: real.replace(
        / {2}appenders:\n(?: {4}.*\n)+/,
        '  appenders: [{type: console, threshold: INFO}]\n',
      ),
      nested_appender_field: replaced(`${safeLine}      layout:\n        type: json\n`),
      duplicate_logging_level: real.replace('  level: WARN\n', '  level: WARN\n  level: DEBUG\n'),
      unknown_top_level_key: `${real}metrics:\n  frequency: 1m\n`,
      // Re-check tree f7ccdc6a: YAML line breaks this reader does not split on.
      U1_line_separator_in_comment: replaced(
        `${safeLine}    # note\u2028    - type: console\u2028      threshold: INFO\n`,
      ),
      U3_next_line_in_comment: replaced(`${safeLine}      # c\u0085      threshold: INFO\n`),
      paragraph_separator_in_comment: replaced(`${safeLine}      # c\u2029      threshold: INFO\n`),
      nbsp_indent: replaced('\u00A0     threshold: WARN\n'),
    };
    for (const [name, text] of Object.entries(refused))
      expect(() => loggingAppenders(text), name).toThrow();

    // Accepted: comments and blank lines anywhere, and every safe level spelled plainly.
    const commented = real
      .replace('logging:\n', '# the console is the only appender\nlogging:\n  # root\n\n')
      .replace(safeLine, `      # no INFO here\n${safeLine}`);
    expect(loggingAppenders(commented)).toEqual([{ type: 'console', threshold: 'WARN' }]);
    for (const level of ['ERROR', 'OFF'])
      expect(loggingAppenders(replaced(`      threshold: ${level}\n`))).toEqual([
        { type: 'console', threshold: level },
      ]);
  });
});

describe('GraphHopper launches in the repository', () => {
  it('recognise a java -jar launch in every quoting, template and process-API form', () => {
    for (const text of [
      "spawn('java', ['-jar', jar])",
      'spawnSync("java", args)',
      'execFile(`java`, args)',
      'execFileSync("java", [...args])',
      'const args = [`-jar`, jar];',
      'java -Xmx2g -jar graphhopper-web.jar server config.yml',
      'java -Xmx2g \\\n  -Ddw.x=1 \\\n  -jar graphhopper-web.jar server c.yml',
      'command: `java ${flags} -jar ${jar} server ${config}`',
      'CMD ["java", "-jar", "/opt/graphhopper-web.jar", "server", "/etc/gh.yml"]',
    ])
      expect(launchRules(text), text).not.toEqual([]);
    for (const text of ["const jar = 'graphhopper-web.jar';", 'javascript -h', 'java -version'])
      expect(launchRules(text), text).toEqual([]);
  });

  it('take their arguments from the helper at every java call, not once per file', () => {
    const imports = "import { graphhopperJavaArguments } from './geo/graphhopper-launch.mjs';\n";
    const helped = "spawn('java', graphhopperJavaArguments({ jarPath, configPath }), options);\n";
    expect(codeLaunchProblem(imports + helped, imports + helped)).toBeNull();
    expect(
      codeLaunchProblem(
        imports + helped,
        imports + "spawn(\n  'java',\n  graphhopperJavaArguments(o),\n)",
      ),
    ).toBeNull();
    // X3: the file uses the helper once, then starts java again with its own arguments.
    const raw = `${imports}${helped}spawn('java', rawArgs);\n`;
    expect(codeLaunchProblem(raw, raw)).toBe('java with arguments not from the helper');
    expect(codeLaunchProblem(helped, helped)).toBe('java without the launch helper');
    const dashJar = `${imports}spawn('java', ['-jar', jar]);\n`;
    expect(codeLaunchProblem(dashJar, dashJar)).not.toBeNull();
  });

  it('go through the helper everywhere, the runbook included', async () => {
    expect(await launchOffenders()).toEqual([]);
  });

  it("leave the helper's request-log decision to the profile, except in the log probe", async () => {
    // `requestLogOverride` lets the engine-log probe run a profile with and without the
    // override. A launcher that passed it could start a profile that leaves the request log
    // on without the override.
    const allowed = new Set([helperPath, thisFile, join(repositoryRoot, logProbe)]);
    const offenders = [];
    for (const path of await repositoryFiles()) {
      if (allowed.has(path) || !CODE_FILE.test(basename(path))) continue;
      const text = await readFile(path, 'utf8').catch(() => '');
      if (text.includes('requestLogOverride')) offenders.push(relative(repositoryRoot, path));
    }
    expect(offenders).toEqual([]);
    expect(() => argumentsFor(servingProfile, { requestLogOverride: 'sometimes' })).toThrow(
      'UNKNOWN_REQUEST_LOG_OVERRIDE_CHOICE',
    );
    expect(argumentsFor(servingProfile, { requestLogOverride: 'add' })).toContain(
      REQUEST_LOG_OVERRIDE,
    );
  });

  it('are found where they actually are: the known launchers are scanned, not skipped', async () => {
    const scanned = (await repositoryFiles()).map((path) => relative(repositoryRoot, path));
    for (const launcher of [
      'scripts/build-routing-graph.mts',
      'scripts/probe-routing-engines.mjs',
      logProbe,
      'docs/implementation/operations-runbook.md',
      'package.json',
    ])
      expect(scanned).toContain(launcher);
    // The runbook's manual launch is the helper's command line, in a code block that is
    // scanned like any other.
    const runbook = await readFile(runbookPath, 'utf8');
    expect(
      launchableChunks(runbookPath, runbook).some((chunk) =>
        /\bnode scripts\/geo\/graphhopper-launch\.mjs\b/.test(chunk),
      ),
    ).toBe(true);
  });
});
