import { readFile, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const holdingPath = resolve(directory, 'workout-holding.caddy');
const proxyPath = resolve(directory, 'workout.caddy');
const siteStart = 'workout.red-10-proto.xyz {';

function siteBlock(source) {
  const start = source.indexOf(siteStart);
  if (start < 0 || source.indexOf(siteStart, start + 1) >= 0) {
    throw new Error('Expected exactly one Workout site block');
  }
  return source.slice(start).trimEnd();
}

export function prepareCandidate(active, holding, proxy) {
  const oldBlock = siteBlock(holding);
  const newBlock = siteBlock(proxy);
  if (!oldBlock.includes('respond "Workout Manager setup in progress" 503')) {
    throw new Error('Holding block is not the expected 503 site');
  }
  if (!newBlock.includes('reverse_proxy wm-hosting-app:3100') || newBlock.includes('respond ')) {
    throw new Error('Proxy candidate is not the expected Workout target');
  }
  const first = active.indexOf(oldBlock);
  if (first < 0 || active.indexOf(oldBlock, first + 1) >= 0) {
    throw new Error('Active Caddyfile does not contain exactly one exact holding block');
  }
  if (
    active.indexOf(siteStart, first + oldBlock.length) >= 0 ||
    active.indexOf(siteStart) !== first
  ) {
    throw new Error('Active Caddyfile contains another Workout site block');
  }
  return active.slice(0, first) + newBlock + active.slice(first + oldBlock.length);
}

async function main() {
  const [activePath, outputPath] = process.argv.slice(2);
  if (!activePath || !outputPath || process.argv.length !== 4) {
    throw new Error('Usage: node prepare-caddy-candidate.mjs <active-Caddyfile> <new-output-file>');
  }
  if (resolve(activePath) === resolve(outputPath)) {
    throw new Error('Output must be a new file');
  }
  const [active, holding, proxy] = await Promise.all([
    readFile(activePath, 'utf8'),
    readFile(holdingPath, 'utf8'),
    readFile(proxyPath, 'utf8'),
  ]);
  const candidate = prepareCandidate(active, holding, proxy);
  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(candidate);
  } catch {
    await handle.close();
    await rm(outputPath, { force: true });
    throw new Error('Candidate write failed');
  } finally {
    await handle.close().catch(() => {});
  }
  process.stdout.write('CADDY_CANDIDATE_WRITTEN\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write('CADDY_CANDIDATE_REFUSED\n');
    process.exitCode = 1;
  }
}
