import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUEST_LOG_OVERRIDE,
  graphhopperJavaArguments,
  profileDisablesRequestLog,
} from '../../../scripts/geo/graphhopper-launch.mjs';

/**
 * M2-01k-c2: no GraphHopper launch writes waypoints to the engine's log.
 *
 * Two things keep them out, and this file guards both:
 *
 * 1. The launch override: request lines go to the application logger without the query.
 *    Every launch in the repository must be built by the helper that adds it.
 * 2. Every console/file appender threshold of each GraphHopper profile at WARN or higher.
 *    `RouteResource` prints the waypoints at INFO, and only the threshold stops that line.
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

function argumentsFor(configPath) {
  return graphhopperJavaArguments({
    jarPath: '/jar/graphhopper-web.jar',
    configPath,
    extractPath: '/extract.osm.pbf',
    graphPath: '/graph',
  });
}

// ---------------------------------------------------------------------------------------
// Appender thresholds, read by a strict line grammar that fails closed.
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
// Rules (re-checks of trees 29167499 and 73b11518):
//
// - Column 0 holds only comments, blank lines and `graphhopper:`, `server:`, `logging:` —
//   the exact top-level keys the profiles use — each at most once (Jackson keeps the last of
//   duplicate keys, so a second `logging` would replace the block read here).
// - `logging:` holds `level:` and `appenders:` at most once each, and nothing else.
//   `loggers:` is refused rather than read: its entries carry their own `appenders`, and with
//   `additive: false` they bypass the root ones, so a per-logger INFO console for
//   `RouteResource` would print waypoints while every root appender reads WARN. Reading it
//   correctly means reproducing Dropwizard's inheritance; refusing it makes any per-logger
//   configuration a reviewed change to this guard. No profile uses it today.
// - `appenders:` is a block list. Each item starts `    - type: <word>`. Its fields are
//   `      <key>: <plain value>` with a letters-only key, each key at most once, and a plain
//   value that starts with no YAML indicator. `threshold` must be one of the log levels.

const SAFE_THRESHOLDS = new Set(['WARN', 'ERROR', 'OFF']);
const TOP_LEVEL_KEYS = new Set(['graphhopper', 'server', 'logging']);
const LEVEL = '(?:ALL|TRACE|DEBUG|INFO|WARN|ERROR|OFF)';
const PLAIN_VALUE = String.raw`[A-Za-z0-9_/.][A-Za-z0-9_/.:+-]*`;
const LOGGING_LINE_SHAPES = [
  { kind: 'level', pattern: new RegExp(`^ {2}level: (${LEVEL})$`) },
  { kind: 'appenders', pattern: /^ {2}appenders:$/ },
  { kind: 'item', pattern: /^ {4}- type: ([a-z][a-z-]*)$/ },
  { kind: 'threshold', pattern: new RegExp(`^ {6}threshold: (${LEVEL})$`) },
  { kind: 'field', pattern: new RegExp(`^ {6}([A-Za-z]+): (${PLAIN_VALUE})$`) },
];

function refuse(code, line) {
  throw new Error(line === undefined ? code : `${code}: ${JSON.stringify(line.slice(0, 60))}`);
}

/** @returns {{ type: string, threshold: string | null }[]} */
export function loggingAppenders(profileText) {
  if (profileText.startsWith('\uFEFF')) refuse('BOM_NOT_ACCEPTED');
  if (profileText.includes('\r')) refuse('CARRIAGE_RETURN_NOT_ACCEPTED');
  if (profileText.includes('\t')) refuse('TAB_NOT_ACCEPTED');
  // SnakeYAML also breaks lines on NEL (U+0085), LS (U+2028) and PS (U+2029), so a comment
  // line split here only on `\n` could carry live YAML (re-check tree f7ccdc6a). The profiles
  // are pure ASCII: refuse everything outside printable ASCII and `\n`.
  if (/[^\x20-\x7E\n]/.test(profileText)) refuse('NON_ASCII_OR_CONTROL_CHARACTER');
  const lines = profileText.split('\n');
  const isQuiet = (line) => line.trim() === '' || /^\s*#/.test(line);

  // Top level: an exact set of keys, each once.
  const seen = new Set();
  let loggingStart = -1;
  for (const [index, line] of lines.entries()) {
    if (isQuiet(line) || /^ /.test(line)) continue;
    const key = /^([a-z]+):$/.exec(line)?.[1];
    if (key === undefined || !TOP_LEVEL_KEYS.has(key)) refuse('UNREADABLE_TOP_LEVEL_LINE', line);
    if (seen.has(key)) throw new Error(`DUPLICATE_TOP_LEVEL_KEY: ${key}`);
    seen.add(key);
    if (key === 'logging') loggingStart = index;
  }
  if (loggingStart === -1) refuse('PROFILE_HAS_NO_LOGGING_BLOCK');

  // Inside `logging:`: every line matches exactly one allowed shape.
  const appenders = [];
  let levelSeen = false;
  let appendersSeen = false;
  /** @type {Set<string> | null} */
  let fieldsOfItem = null;
  for (const line of lines.slice(loggingStart + 1)) {
    if (/^\S/.test(line) && !isQuiet(line)) break;
    if (isQuiet(line)) continue;
    const shape = LOGGING_LINE_SHAPES.find(({ pattern }) => pattern.test(line));
    if (shape === undefined) {
      const key = /^ {2}([a-z]+):/.exec(line)?.[1];
      if (key !== undefined && key !== 'level' && key !== 'appenders')
        throw new Error(`UNREVIEWED_LOGGING_KEY: ${key}`);
      refuse('UNREADABLE_LOGGING_LINE', line);
    }
    const match = shape.pattern.exec(line) ?? [];
    switch (shape.kind) {
      case 'level':
        if (levelSeen) refuse('DUPLICATE_LOGGING_KEY', 'level');
        levelSeen = true;
        fieldsOfItem = null;
        break;
      case 'appenders':
        if (appendersSeen) refuse('DUPLICATE_LOGGING_KEY', 'appenders');
        appendersSeen = true;
        fieldsOfItem = null;
        break;
      case 'item':
        if (!appendersSeen) refuse('APPENDER_OUTSIDE_APPENDERS', line);
        appenders.push({ type: match[1] ?? '', threshold: null });
        fieldsOfItem = new Set(['type']);
        break;
      case 'threshold':
      case 'field': {
        const key = shape.kind === 'threshold' ? 'threshold' : (match[1] ?? '');
        if (fieldsOfItem === null) refuse('APPENDER_FIELD_BEFORE_ITEM', line);
        if (fieldsOfItem.has(key)) refuse('DUPLICATE_APPENDER_FIELD', key);
        fieldsOfItem.add(key);
        const current = appenders.at(-1);
        if (current !== undefined && shape.kind === 'threshold')
          current.threshold = match[1] ?? null;
        break;
      }
    }
  }
  if (!appendersSeen || appenders.length === 0) refuse('PROFILE_HAS_NO_APPENDERS');
  return appenders;
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
      if (path === runbookPath) {
        // The one documented manual launch: it must carry the override.
        if (!chunk.includes(REQUEST_LOG_OVERRIDE))
          offenders.push(`${where}: runbook without override`);
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

describe('GraphHopper launch arguments', () => {
  it('disable the request log for the deployed serving profile, before -jar', () => {
    const args = argumentsFor(servingProfile);
    expect(args).toContain(REQUEST_LOG_OVERRIDE);
    // A JVM system property after -jar would be an application argument and do nothing.
    expect(args.indexOf(REQUEST_LOG_OVERRIDE)).toBeLessThan(args.indexOf('-jar'));
    expect(args.slice(-2)).toEqual(['server', servingProfile]);
    // The helper never touches logging: a logging override could lower a threshold.
    expect(args.filter((arg) => arg.startsWith('-Ddw.logging'))).toEqual([]);
  });

  it('leave the override out once a profile disables the request log itself', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gh-launch-'));
    scratch.push(directory);
    const profile = join(directory, 'serving.yml');
    const text = await readFile(servingProfile, 'utf8');
    const disabled = text.replace(/^server:\n/m, 'server:\n  request_log:\n    appenders: []\n');
    await writeFile(profile, disabled);
    expect(profileDisablesRequestLog(disabled)).toBe(true);
    expect(argumentsFor(profile)).not.toContain(REQUEST_LOG_OVERRIDE);
    // A profile that merely mentions the key, or keeps appenders, is not trusted.
    expect(profileDisablesRequestLog(text)).toBe(false);
    expect(
      profileDisablesRequestLog('server:\n  request_log:\n    appenders:\n      - type: console\n'),
    ).toBe(false);
  });
});

describe('GraphHopper profile appender thresholds', () => {
  it('are WARN or higher on every appender of every GraphHopper profile', async () => {
    const profiles = (await readdir(geoDirectory)).filter((name) =>
      /^graphhopper-.*\.ya?ml$/.test(name),
    );
    expect(profiles).toContain('graphhopper-foot-serving.yml');
    for (const name of profiles) {
      const appenders = loggingAppenders(await readFile(join(geoDirectory, name), 'utf8'));
      for (const appender of appenders)
        expect(
          { profile: name, type: appender.type, threshold: appender.threshold },
          'an appender without WARN+ would print RouteResource waypoints',
        ).toEqual({
          profile: name,
          type: appender.type,
          threshold: expect.toSatisfy((value) => SAFE_THRESHOLDS.has(String(value))),
        });
    }
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
    // appender still reads WARN, and the real engine printed the planted waypoints.
    expect(() =>
      loggingAppenders(
        `${safe}  loggers:\n    com.graphhopper.resources.RouteResource:\n      level: INFO\n` +
          '      additive: false\n      appenders:\n        - type: console\n          threshold: INFO\n',
      ),
    ).toThrow('UNREVIEWED_LOGGING_KEY: loggers');
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
      duplicate_logging_level: real.replace('  level: INFO\n', '  level: INFO\n  level: DEBUG\n'),
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

  it('go through the helper everywhere, and the runbook snippet carries the override', async () => {
    expect(await launchOffenders()).toEqual([]);
  });

  it('are found where they actually are: the known launchers are scanned, not skipped', async () => {
    const scanned = (await repositoryFiles()).map((path) => relative(repositoryRoot, path));
    for (const launcher of [
      'scripts/build-routing-graph.mts',
      'scripts/probe-routing-engines.mjs',
      'scripts/probe-routing-engine-logs.mts',
      'docs/implementation/operations-runbook.md',
      'package.json',
    ])
      expect(scanned).toContain(launcher);
    const runbook = await readFile(runbookPath, 'utf8');
    expect(
      launchableChunks(runbookPath, runbook).some((chunk) => launchRules(chunk).length > 0),
    ).toBe(true);
  });
});
