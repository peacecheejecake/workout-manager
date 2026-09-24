import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { commandLatency, stripAnsi, worstLoopDelay } from './protocol-lines';

/**
 * Opt-in (`IDENTITY_E2E_DIAGNOSTICS=1`) failure evidence for the identity E2E run.
 *
 * While the run lasts it samples the machine every two seconds: load average, free memory,
 * the OS memory-pressure level, and the busiest processes. When a test fails it writes, into
 * `<diagnostics dir>/<test>/`:
 * - `protocol.log` — that test's `pw:api`/`pw:protocol`/`pw:browser` lines from the worker;
 * - `pressure.log` — the samples from 30 s before the test started until it ended;
 * - `summary.txt` — the CDP commands never answered or answered slowly, the worker's worst
 *   event-loop delay, the pressure peaks, and where the trace is.
 * A run without failures deletes its raw protocol logs, so only failures leave anything.
 */
const execFileAsync = promisify(execFile);
const sampleEveryMs = 2000;
const lookBehindMs = 30_000;
const keepSamples = 3600;

type Sample = {
  at: number;
  load: [number, number, number];
  freeMb: number;
  totalMb: number;
  pressure: string;
  top: string[];
};
type Failure = { test: TestCase; result: TestResult };

async function memoryPressure(): Promise<string> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('sysctl', [
        '-n',
        'kern.memorystatus_vm_pressure_level',
      ]);
      const level = stdout.trim();
      return { '1': 'normal', '2': 'warn', '4': 'critical' }[level] ?? `level ${level}`;
    }
    const pressure = await readFile('/proc/pressure/memory', 'utf8');
    return pressure.split('\n')[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function busiestProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,pcpu=,rss=,comm='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 4)
      .map(([pid, cpu, rss, ...command]) => ({
        pid,
        cpu: Number(cpu),
        rssMb: Math.round(Number(rss) / 1024),
        command: command.join(' ').split('/').slice(-2).join('/'),
      }))
      .sort((left, right) => right.cpu - left.cpu)
      .slice(0, 8)
      .map(({ pid, cpu, rssMb, command }) => `${pid} ${cpu}% ${rssMb}MB ${command}`);
  } catch {
    return [];
  }
}

function slug(test: TestCase, retry: number) {
  const file = test.location.file.split('/').pop() ?? 'spec';
  const title = test.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60);
  return `${file}-${test.location.line}-${title}-retry${retry}`;
}

export default class IdentityDiagnosticsReporter implements Reporter {
  private readonly directory = process.env['IDENTITY_E2E_DIAGNOSTICS_DIR'] ?? '';
  private readonly samples: Sample[] = [];
  private readonly failures: Failure[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;

  onBegin() {
    if (!this.directory) return;
    const sample = async () => {
      if (this.sampling) return;
      this.sampling = true;
      try {
        const [pressure, top] = await Promise.all([memoryPressure(), busiestProcesses()]);
        const [one = 0, five = 0, fifteen = 0] = loadavg();
        this.samples.push({
          at: Date.now(),
          load: [one, five, fifteen],
          freeMb: Math.round(freemem() / 1048576),
          totalMb: Math.round(totalmem() / 1048576),
          pressure,
          top,
        });
        if (this.samples.length > keepSamples) this.samples.shift();
      } finally {
        this.sampling = false;
      }
    };
    void sample();
    this.timer = setInterval(() => void sample(), sampleEveryMs);
    this.timer.unref();
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.directory) return;
    if (result.status === test.expectedStatus) return;
    this.failures.push({ test, result });
  }

  private async protocolLines(testId: string) {
    const lines: string[] = [];
    const files = (await readdir(this.directory).catch(() => [])).filter((name) =>
      /^protocol-\d+\.log$/.test(name),
    );
    for (const name of files) {
      const input = createInterface({ input: createReadStream(join(this.directory, name)) });
      for await (const line of input) if (line.split(' ', 2)[1] === testId) lines.push(line);
    }
    return lines.sort();
  }

  private async record({ test, result }: Failure) {
    const started = result.startTime.getTime();
    const ended = started + result.duration;
    const directory = join(this.directory, slug(test, result.retry));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lines = await this.protocolLines(test.id);
    const window = this.samples.filter(
      ({ at }) => at >= started - lookBehindMs && at <= ended + sampleEveryMs,
    );
    await writeFile(join(directory, 'protocol.log'), `${lines.join('\n')}\n`, { mode: 0o600 });
    await writeFile(
      join(directory, 'pressure.log'),
      window
        .map(
          (sample) =>
            `${new Date(sample.at).toISOString()} load ${sample.load.map((value) => value.toFixed(2)).join(' ')}` +
            ` free ${sample.freeMb}/${sample.totalMb}MB pressure ${sample.pressure}\n  ${sample.top.join('\n  ')}`,
        )
        .join('\n'),
      { mode: 0o600 },
    );
    const { unanswered, slow } = commandLatency(lines);
    const peakLoad = Math.max(0, ...window.map(({ load }) => load[0]));
    const leastFree = Math.min(...window.map(({ freeMb }) => freeMb));
    const pressures = [...new Set(window.map(({ pressure }) => pressure))];
    const trace = result.attachments.find(({ name }) => name === 'trace')?.path ?? 'none';
    const summary = [
      `${test.titlePath().slice(1).join(' › ')}`,
      `${test.location.file}:${test.location.line} — ${result.status} after ${result.duration} ms`,
      `window ${new Date(started).toISOString()} … ${new Date(ended).toISOString()}`,
      `error: ${stripAnsi(result.error?.message ?? '')
        .split('\n')
        .slice(0, 3)
        .join(' | ')}`,
      `protocol lines: ${lines.length}`,
      `CDP commands never answered (${unanswered.length}; teardown closes the page, so the last ones may be expected):`,
      ...unanswered.slice(-15).map((line) => `  ${line}`),
      `CDP commands answered after 1 s or more (${slow.length}):`,
      ...slow.slice(-15).map((line) => `  ${line}`),
      `worst worker event-loop delay: ${worstLoopDelay(lines).toFixed(1)} ms`,
      `peak 1-min load: ${peakLoad.toFixed(2)}; least free memory: ${Number.isFinite(leastFree) ? leastFree : '?'} MB; memory pressure: ${pressures.join(', ') || 'no samples'}`,
      `trace: ${trace}`,
    ].join('\n');
    await writeFile(join(directory, 'summary.txt'), `${summary}\n`, { mode: 0o600 });
    console.log(`\n[identity diagnostics] ${directory}\n${summary}\n`);
  }

  async onEnd(_result: FullResult) {
    if (!this.directory) return;
    if (this.timer) clearInterval(this.timer);
    for (const failure of this.failures) await this.record(failure);
    if (this.failures.length > 0) return;
    const files = await readdir(this.directory).catch(() => []);
    for (const name of files)
      if (/^protocol-\d+\.log$/.test(name)) await rm(join(this.directory, name), { force: true });
    // The run's own directory (named after its run id), now empty unless someone added to it.
    if ((await readdir(this.directory).catch(() => [])).length === 0)
      await rm(this.directory, { recursive: true, force: true });
    console.log('[identity diagnostics] no failures; raw protocol logs removed.');
  }

  printsToStdio() {
    return false;
  }
}
