import type { TrackPosition } from '@workout/contracts/tracks';
import { localMeters } from './geo';

function perpendicularMeters(
  point: [number, number],
  start: [number, number],
  end: [number, number],
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (start[0] + clamped * dx), point[1] - (start[1] + clamped * dy));
}

/**
 * Douglas-Peucker over locally projected metres. Display only: it changes which vertices
 * are drawn and never the samples, their order, or any time/distance/pace aggregate.
 * Endpoints are always kept, so a simplified line still starts and ends where the recording did.
 */
export function simplifyIndices(line: readonly TrackPosition[], toleranceMeters: number): number[] {
  if (line.length <= 2 || toleranceMeters <= 0) return line.map((_, index) => index);
  const reference = line[0]?.[1] ?? 0;
  const projected = line.map((position) => localMeters(position, reference));
  const keep = new Array<boolean>(line.length).fill(false);
  keep[0] = true;
  keep[line.length - 1] = true;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const span = stack.pop();
    if (!span) break;
    const [first, last] = span;
    const start = projected[first];
    const end = projected[last];
    if (!start || !end) continue;
    let farthest = -1;
    let distance = toleranceMeters;
    for (let index = first + 1; index < last; index += 1) {
      const point = projected[index];
      if (!point) continue;
      const candidate = perpendicularMeters(point, start, end);
      if (candidate > distance) {
        distance = candidate;
        farthest = index;
      }
    }
    if (farthest > 0) {
      keep[farthest] = true;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return keep.flatMap((kept, index) => (kept ? [index] : []));
}
