// EXT-OIDC local stack against the real Zitadel Cloud instance (not committed; reads the
// git-ignored .env, never prints its values).
//
//   node --import tsx <this file> up            start (waits for the harness lock), returns when ready
//   node --import tsx <this file> down          stop everything, release the lock (DB data kept)
//   node --import tsx <this file> status        processes, ports, lock owner
//   node --import tsx <this file> outage-on     restart only the API with an unreachable issuer
//   node --import tsx <this file> outage-off    restart only the API with the real issuer
//   node --import tsx <this file> sessions      account/session/attempt rows (no tokens)
//   node --import tsx <this file> expire-sessions   set every live session's expires_at to now-1s
//   node --import tsx <this file> log-check     API log: events, and proof no secret/token leaked
//   node --import tsx <this file> purge         down + delete the DB cluster and logs
//
// Run from the EXT-OIDC worktree root.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as migrations from '../../packages/server/persistence/src/migrate.ts';
import { loadEnv } from './env.mjs';

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKOUT_ID = createHash('sha256').update(WORKTREE).digest('hex').slice(0, 12);
const SCRATCH = join(tmpdir(), 'workout-manager-ext-oidc', CHECKOUT_ID);
const LOCK = join(SCRATCH, 'harness.lock');
const PRIORITY = join(SCRATCH, 'harness.root-priority');
const STATE = join(SCRATCH, 'ext-oidc', 'state');
const PGDATA = join(STATE, 'pgdata');
// Unix socket paths are limited to 103 bytes; keep this short and checkout-specific.
const SOCK = join('/tmp', `wm-ext-oidc-${CHECKOUT_ID}-sock`);
const LOGS = join(STATE, 'logs');
const RESOURCES = join(STATE, 'resources');
const PIDFILE = join(STATE, 'supervisor.pid');
const READY = join(STATE, 'ready');
const MODEFILE = join(STATE, 'api-mode');
const PG_BIN = '/opt/homebrew/opt/postgresql@14/bin';
const NODE_BIN = `${process.env.HOME}/.local/share/fnm/node-versions/v24.12.0/installation/bin`;
const PORTS = [3100, 4200, 4300, 4400];
const NODE_NAME = 'EXT-OIDC';
const DB = 'workout_ext_oidc';
const BOOT = 'ext_oidc_bootstrap'; // cluster superuser, used only for roles/DB creation and checks
const OWNER = 'workout_owner'; // migration owner: NOSUPERUSER NOBYPASSRLS
const RUNTIME = 'workout_runtime'; // app role: NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
const url = (user: string, db = DB) =>
  `postgresql://${user}@localhost/${db}?host=${encodeURIComponent(SOCK)}`;
/** An issuer nothing answers on (connection refused): a provider outage as the API sees it. */
const OUTAGE_ISSUER = 'https://localhost:9/';

function run(cmd: string, args: string[], quiet = true) {
  const r = spawnSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit' });
  if (r.error || r.status !== 0) throw new Error(`command failed: ${cmd} ${args[0] ?? ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function portOpen(port: number, host = '127.0.0.1') {
  return new Promise<boolean>((resolve) => {
    const s = connect({ port, host });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}
async function waitHttp(target: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return true;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  return false;
}

// ---------- lock ----------
function lockOwner() {
  try {
    return readFileSync(join(LOCK, 'owner'), 'utf8').trim();
  } catch {
    return existsSync(LOCK) ? '(no owner file)' : null;
  }
}
async function acquireLock(maxMs: number) {
  const until = Date.now() + maxMs;
  for (;;) {
    if (!existsSync(PRIORITY)) {
      try {
        mkdirSync(LOCK);
        writeFileSync(
          join(LOCK, 'owner'),
          `${NODE_NAME} ${process.pid} ${new Date().toISOString()}\n`,
        );
        return;
      } catch {
        /* held */
      }
    }
    if (Date.now() > until) throw new Error(`harness lock busy: ${lockOwner()}`);
    await sleep(30_000);
  }
}
function releaseLock() {
  const owner = lockOwner();
  if (owner !== null && owner.startsWith(`${NODE_NAME} ${process.pid} `))
    rmSync(LOCK, { recursive: true, force: true });
}

// ---------- database ----------
function pgRunning() {
  return (
    spawnSync(join(PG_BIN, 'pg_ctl'), ['-D', PGDATA, 'status'], { stdio: 'ignore' }).status === 0
  );
}
async function ensureDatabase() {
  mkdirSync(SOCK, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(RESOURCES, { recursive: true });
  const fresh = !existsSync(join(PGDATA, 'PG_VERSION'));
  if (fresh)
    run(join(PG_BIN, 'initdb'), [
      '-D',
      PGDATA,
      '-U',
      BOOT,
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
    ]);
  if (!pgRunning())
    run(join(PG_BIN, 'pg_ctl'), [
      '-D',
      PGDATA,
      '-l',
      join(LOGS, 'postgres.log'),
      '-o',
      `-k ${SOCK} -h ''`,
      '-w',
      'start',
    ]);
  const boot = new pg.Pool({ connectionString: url(BOOT, 'postgres'), max: 1 });
  try {
    const roles = await boot.query<{ rolname: string }>('SELECT rolname FROM pg_roles');
    const have = new Set(roles.rows.map((r) => r.rolname));
    if (!have.has(OWNER))
      await boot.query(
        `CREATE ROLE ${OWNER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    if (!have.has(RUNTIME))
      await boot.query(
        `CREATE ROLE ${RUNTIME} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    const dbs = await boot.query('SELECT 1 FROM pg_database WHERE datname=$1', [DB]);
    if (dbs.rowCount === 0) await boot.query(`CREATE DATABASE ${DB} OWNER ${OWNER}`);
  } finally {
    await boot.end();
  }
  // Migrations and grants as the (plain) migration owner, as a deployment runs them.
  const m = migrations as unknown as Record<string, (url: string, role?: string) => Promise<void>>;
  const owner = url(OWNER);
  await migrations.migrate(owner);
  const o = new pg.Pool({ connectionString: owner, max: 1 });
  try {
    await o.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME}`);
    await o.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt, plan_head, activity_canonical, activity_source_head, activity_overlay TO ${RUNTIME}`,
    );
    await o.query(
      `GRANT SELECT, INSERT ON plan_snapshot, plan_history, activity_source_revision, activity_overlay_revision, activity_suppression, activity_import_receipt TO ${RUNTIME}`,
    );
  } finally {
    await o.end();
  }
  for (const grant of [
    'grantIdentityFunctions',
    'grantOperations',
    'grantNutritionCore',
    'grantSupplementaryCore',
    'grantRoutineCore',
    'grantStretchingCore',
    'grantRecoveryCore',
    'grantCheckIns',
    'grantSessionCompletions',
    'grantPlanScenarios',
    'grantCoachingConstraints',
    'grantCoachingThreads',
    'grantCoreEvidenceSnapshots',
    'grantCoachingRuns',
    'grantCoachingCandidates',
    'grantIntegratedApprovalV4',
    'grantResources',
    'grantResourceRetrieval',
    'grantGalleryMedia',
    'grantActivityTracks',
    'grantCourses',
    'grantGarmin',
  ])
    await m[grant](owner, RUNTIME);
  return fresh;
}

// ---------- processes ----------
function apiEnv(outage: boolean): NodeJS.ProcessEnv {
  const e = loadEnv();
  return {
    PATH: `${NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: process.env.HOME,
    NODE_ENV: 'development',
    PORT: '4300',
    DATABASE_URL: url(RUNTIME),
    PRIVATE_RESOURCE_STORAGE_ROOT: RESOURCES,
    PUBLIC_ORIGIN: e.PUBLIC_ORIGIN,
    ALLOW_INSECURE_LOCALHOST: e.ALLOW_INSECURE_LOCALHOST,
    OIDC_ISSUER: outage ? OUTAGE_ISSUER : e.OIDC_ISSUER,
    OIDC_CLIENT_ID: e.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: e.OIDC_CLIENT_SECRET,
    // Product defaults, stated explicitly.
    OIDC_VERIFY_REAUTHENTICATION: 'true',
    OIDC_PROVIDER_LOGOUT: 'true',
  };
}
function startApi(outage: boolean) {
  const out = openSync(join(LOGS, 'api.log'), 'a');
  writeFileSync(MODEFILE, outage ? 'outage' : 'real');
  return spawn(join(NODE_BIN, 'node'), ['--import', 'tsx', 'src/start.ts'], {
    cwd: join(WORKTREE, 'apps/api'),
    env: apiEnv(outage),
    stdio: ['ignore', out, out],
  });
}
function startWeb() {
  const out = openSync(join(LOGS, 'web.log'), 'a');
  return spawn(
    join(WORKTREE, 'apps/web/node_modules/.bin/next'),
    ['start', '--hostname', '127.0.0.1', '--port', '3100'],
    {
      cwd: join(WORKTREE, 'apps/web'),
      env: {
        PATH: `${NODE_BIN}:/usr/bin:/bin`,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        API_ORIGIN: 'http://127.0.0.1:4300',
      },
      stdio: ['ignore', out, out],
    },
  );
}
function stopChild(child: ChildProcess | undefined) {
  return new Promise<void>((resolve) => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null)
      return resolve();
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => (clearTimeout(t), resolve()));
    child.kill('SIGTERM');
  });
}

async function supervise() {
  writeFileSync(PIDFILE, String(process.pid));
  rmSync(READY, { force: true });
  let api: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await Promise.all([stopChild(web), stopChild(api)]);
    try {
      if (pgRunning()) run(join(PG_BIN, 'pg_ctl'), ['-D', PGDATA, '-m', 'fast', '-w', 'stop']);
    } finally {
      releaseLock();
      rmSync(PIDFILE, { force: true });
      rmSync(READY, { force: true });
      process.exit(code);
    }
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  try {
    await acquireLock(15 * 60_000);
    for (const p of PORTS) if (await portOpen(p)) throw new Error(`port ${p} busy`);
    const fresh = await ensureDatabase();
    console.log(`db ready (${fresh ? 'new cluster' : 'existing cluster'})`);
    api = startApi(false);
    if (!(await waitHttp('http://127.0.0.1:4300/health', 60_000)))
      throw new Error('API not healthy');
    web = startWeb();
    if (!(await waitHttp('http://127.0.0.1:3100/', 90_000))) throw new Error('web not up');
    const restart = async (outage: boolean) => {
      await stopChild(api);
      api = startApi(outage);
      const ok = await waitHttp('http://127.0.0.1:4300/health', 60_000);
      console.log(`api restarted mode=${outage ? 'outage' : 'real'} healthy=${ok}`);
    };
    process.on('SIGUSR1', () => void restart(false));
    process.on('SIGUSR2', () => void restart(true));
    writeFileSync(READY, new Date().toISOString());
    console.log('ready');
  } catch (error) {
    console.log(`startup failed: ${error instanceof Error ? error.message : 'error'}`);
    await shutdown(1);
  }
  setInterval(() => undefined, 1 << 30);
}

function supervisorPid() {
  try {
    const pid = Number(readFileSync(PIDFILE, 'utf8'));
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function up() {
  if (supervisorPid() !== null) return console.log('already running; `status` for details');
  mkdirSync(LOGS, { recursive: true });
  const out = openSync(join(LOGS, 'supervisor.log'), 'a');
  const child = spawn(
    process.execPath,
    [...process.execArgv, new URL(import.meta.url).pathname, 'supervise'],
    {
      cwd: WORKTREE,
      detached: true,
      stdio: ['ignore', out, out],
    },
  );
  child.unref();
  console.log(
    `supervisor pid ${child.pid}; waiting for the harness lock and startup (log: ${join(LOGS, 'supervisor.log')})`,
  );
  for (;;) {
    await sleep(1000);
    if (existsSync(READY)) break;
    if (child.pid === undefined || !alive(child.pid)) {
      console.log('supervisor exited; see supervisor.log');
      process.exitCode = 1;
      return;
    }
  }
  console.log('stack up: web http://localhost:3100  api http://127.0.0.1:4300 (loopback)');
}
async function down() {
  const pid = supervisorPid();
  if (pid === null) return console.log('not running');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(500);
  console.log(alive(pid) ? 'supervisor still alive' : 'stack down (lock released, DB data kept)');
}
async function status() {
  console.log('supervisor:', supervisorPid() ?? 'not running');
  console.log('api mode:', existsSync(MODEFILE) ? readFileSync(MODEFILE, 'utf8') : '-');
  console.log('lock owner:', lockOwner() ?? '(free)');
  for (const p of PORTS) console.log(`port ${p}:`, (await portOpen(p)) ? 'listening' : 'free');
  console.log('postgres:', pgRunning() ? 'running' : 'stopped');
}
async function admin<T>(fn: (c: pg.Pool) => Promise<T>) {
  const c = new pg.Pool({ connectionString: url(BOOT), max: 1 });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const short = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
async function sessions() {
  await admin(async (c) => {
    const acc = await c.query(
      'SELECT athlete_id::text, issuer, subject FROM identity_private.account ORDER BY athlete_id',
    );
    console.log('accounts (subject shown as sha256 prefix):');
    for (const r of acc.rows)
      console.log(`  ${r.athlete_id}  issuer=${r.issuer}  subject#${short(r.subject)}`);
    const s = await c.query(
      `SELECT session_id::text, athlete_id::text, expires_at, expires_at > clock_timestamp() AS live,
              round(extract(epoch FROM expires_at - clock_timestamp()))::int AS seconds_left
         FROM identity_private.session ORDER BY expires_at`,
    );
    console.log(`sessions: ${s.rowCount}`);
    for (const r of s.rows)
      console.log(
        `  session=${r.session_id} athlete=${r.athlete_id} expires=${r.expires_at.toISOString()} live=${r.live} seconds_left=${r.seconds_left}`,
      );
    const a = await c.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE expires_at > clock_timestamp())::int AS live
         FROM identity_private.login_attempt`,
    );
    console.log(`login attempts: ${a.rows[0].n} (${a.rows[0].live} unexpired)`);
    console.log(
      'db clock:',
      (await c.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString(),
    );
  });
}
async function expireSessions() {
  await admin(async (c) => {
    const r = await c.query(
      `UPDATE identity_private.session SET expires_at = clock_timestamp() - interval '1 second'
        WHERE expires_at > clock_timestamp()`,
    );
    console.log(`expired ${r.rowCount} live session(s) (simulated 8 h expiry)`);
  });
}
function logCheck() {
  const file = join(LOGS, 'api.log');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const e = loadEnv();
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /"event":"([a-z_]+)"(?:,"(?:code|reason)":"([a-z_]+)")?/.exec(line);
    if (m)
      counts.set(
        `${m[1]}${m[2] ? `:${m[2]}` : ''}`,
        (counts.get(`${m[1]}${m[2] ? `:${m[2]}` : ''}`) ?? 0) + 1,
      );
    const s = /"statusCode":(\d+)/.exec(line);
    if (s && m?.[1] === 'request_completed')
      counts.set(`status:${s[1]}`, (counts.get(`status:${s[1]}`) ?? 0) + 1);
  }
  console.log('api.log lines:', text.split('\n').filter(Boolean).length);
  for (const [k, v] of [...counts].sort()) console.log(`  ${k} x${v}`);
  const probes: Array<[string, boolean]> = [
    ['client id', text.includes(e.OIDC_CLIENT_ID)],
    ['client secret', text.includes(e.OIDC_CLIENT_SECRET)],
    ['code=/state=/nonce= query', /[?&](code|state|nonce|code_verifier)=/.test(text)],
    ['id_token/access_token', /id_token|access_token|eyJ[A-Za-z0-9_-]{10,}\./.test(text)],
    ['cookie values', /workout_(session|login|signed_out)=/.test(text)],
    ['authorization header', /authorization/i.test(text)],
  ];
  for (const [name, found] of probes)
    console.log(`  leak check ${name}: ${found ? 'FOUND' : 'absent'}`);
}

const command = process.argv[2];
switch (command) {
  case 'supervise':
    await supervise();
    break;
  case 'up':
    await up();
    break;
  case 'down':
    await down();
    break;
  case 'status':
    await status();
    break;
  case 'outage-on':
  case 'outage-off': {
    const pid = supervisorPid();
    if (pid === null) console.log('not running');
    else {
      const want = command === 'outage-on' ? 'outage' : 'real';
      process.kill(pid, command === 'outage-on' ? 'SIGUSR2' : 'SIGUSR1');
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        if (
          readFileSync(MODEFILE, 'utf8') === want &&
          (await waitHttp('http://127.0.0.1:4300/health', 1000))
        )
          break;
      }
      console.log(`api mode: ${readFileSync(MODEFILE, 'utf8')}`);
    }
    break;
  }
  case 'sessions':
    await sessions();
    break;
  case 'expire-sessions':
    await expireSessions();
    break;
  case 'log-check':
    logCheck();
    break;
  case 'purge':
    await down();
    rmSync(STATE, { recursive: true, force: true });
    console.log('state removed');
    break;
  default:
    console.log(
      'usage: up | down | status | outage-on | outage-off | sessions | expire-sessions | log-check | purge',
    );
    process.exitCode = 2;
}
