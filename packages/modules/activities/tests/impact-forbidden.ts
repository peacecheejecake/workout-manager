/**
 * What the S09 impact tab must never show anywhere on the screen (01 §7.2 S09-no-causal,
 * 05 V2-F14): a percentage, a number attached to risk, probability, likelihood or a
 * contribution share (before or after the word), a share written as a fraction, or a causal
 * sentence carrying a number in either order. Used by the unit test and both shells' E2E.
 *
 * Every pattern takes Unicode decimal digits (`\p{Nd}`), so full-width `１２` counts as a
 * number. Digits that are identifiers or calendar values rather than quantities — dates,
 * clock times, instants, UUIDs, definition versions, RPE on its 10-point scale, heart-rate zone
 * labels and the observed partial-sum line — are masked by an explicit allow-list first;
 * everything else is checked.
 *
 * Deliberately conservative: a disclaimer that puts any number in the same sentence as a share
 * word ("버전 3 · 확률을 계산하지 않습니다"), or a number within 40 characters of a causal word
 * even across a line break, fails. Write disclaimers without numbers in those sentences.
 */

/** Words a share, a risk or a probability is written with (Korean: substring match). */
const koreanShareWords = [
  '위험',
  '확률',
  '가능성',
  '비중',
  '비율',
  '기여',
  '이행률',
  '달성률',
  '완료율',
  '점유율',
  '차지',
  '몫',
  '리스크',
  '퍼센트',
];
/** English share words, whole words only: `ratio` is inside "duration", `percent` inside "percentile". */
const englishShareWords = [
  'risks?',
  'percent',
  'percentages?',
  'probabilit(?:y|ies)',
  'shares?',
  'ratios?',
  'chances?',
  'likelihood',
  'odds',
];
const shareWords = `(?:${koreanShareWords.join('|')}|\\b(?:${englishShareWords.join('|')})\\b)`;
/** Causal connectives, forward order ("때문에 … 12"). `(으)로 인한` is not "확인한". */
const causalBefore = [
  '때문에',
  '때문으로',
  '탓에',
  '덕분에',
  '(?:으로|로)\\s*인(?:해|한)',
  '영향으로',
  '\\bbecause\\b',
  '\\bdue to\\b',
  '\\bcaused by\\b',
  '\\bas a result\\b',
].join('|');
/** Causal words that follow the number ("12 증가는 … 때문입니다"). */
const causalAfter = [
  '때문',
  '탓',
  '덕분',
  '원인',
  '(?:으로|로)\\s*인(?:해|한)',
  '영향으로',
  '\\bbecause\\b',
  '\\bdue to\\b',
  '\\bcaused by\\b',
  '\\bas a result\\b',
].join('|');
/** Stays inside one sentence and one line of the rendered text. */
const sameSentence = String.raw`[^.。!?\n]{0,20}`;
/** Causal sentences may wrap: a newline does not end them. */
const sameCausalSentence = String.raw`[^.。!?]{0,40}`;

export const forbiddenImpactText: ReadonlyArray<RegExp> = [
  // 12%, １２％, 12 퍼센트, 12프로, 12 percent, 12 percentage points, 12pp, 12%p. "프로" before
  // 그램/필/젝트… and "percentile" are other words.
  /\p{Nd}\s*(?:%|％|‰|퍼센트|프로(?!그램|필|젝트|세스|토콜|모션)|percent(?:age)?(?:\s+points?)?\b|pct\b|pp\b|%p)/iu,
  // 위험 12, 부상 위험이 12, 기여율 0.84, 차지하는 비율은 0.84, share 0.84, odds 1 in 5
  new RegExp(`${shareWords}${sameSentence}\\p{Nd}`, 'iu'),
  // 12 위험, Block 거리의 0.84 비중, Block 거리의 84를 차지, 0.3 확률
  new RegExp(`\\p{Nd}${sameSentence}${shareWords}`, 'iu'),
  // 3/5, 3 ⁄ 5, 5분의 3, ⅗
  /\p{Nd}\s*[/⁄∕]\s*\p{Nd}|\p{Nd}\s*분의\s*\p{Nd}|[¼½¾⅐-⅞]/u,
  // 3:2 (clock times are masked by the allow-list first)
  /\p{Nd}\s*[:∶]\s*\p{Nd}/u,
  // 이번 활동 때문에\n12 늘었습니다, 으로 인한 피로 12, 영향으로 … 12, caused by … 12
  new RegExp(`(?:${causalBefore})${sameCausalSentence}\\p{Nd}`, 'iu'),
  // 12 증가는 이번 활동 때문입니다, 12의 원인은 …, 12 … 탓
  new RegExp(`\\p{Nd}${sameCausalSentence}(?:${causalAfter})`, 'iu'),
];

const digit = /\p{Nd}/gu;
const shareWordNearby = new RegExp(shareWords, 'iu');
const causalWordNearby = new RegExp(`${causalBefore}|${causalAfter}`, 'iu');
/**
 * Identifiers and calendar values whose digits are not quantities. `nearShareWord: 'keep'`
 * leaves a token unmasked when a share word is in the same sentence and line within 20
 * characters, or a causal word is in the same sentence within 40 characters (across lines, as
 * the causal patterns read), so "위험 12:30", "위험 2019-03-02" and "때문에 … 1:30 늘었습니다" are
 * still checked; zone labels and the partial-sum line are always masked.
 */
const allowedNumbers: ReadonlyArray<{ pattern: RegExp; nearShareWord: 'keep' | 'mask' }> = [
  // UUIDs (activity, plan version, thread ids).
  {
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
    nearShareWord: 'keep',
  },
  // Dates and instants: 2019-03-02, 2019.03.02, 2019/03/02, 2019-03-02T08:00:00.000Z, +09:00.
  {
    pattern:
      /(?<!\p{Nd})\p{Nd}{4}([-./])\p{Nd}{1,2}\1\p{Nd}{1,2}(?:[T ]\p{Nd}{2}:\p{Nd}{2}(?::\p{Nd}{2}(?:\.\p{Nd}{1,9})?)?(?:Z|[+-]\p{Nd}{2}:?\p{Nd}{2})?)?(?!\p{Nd})/gu,
    nearShareWord: 'keep',
  },
  // 2019년 3월 2일, 3월 2일
  {
    pattern: /(?:(?<!\p{Nd})\p{Nd}{4}년\s*)?(?<!\p{Nd})\p{Nd}{1,2}월\s*\p{Nd}{1,2}일/gu,
    nearShareWord: 'keep',
  },
  // Clock times and paces: 08:00, 8:00:05, 100:00 (a slow pace per km)
  {
    pattern: /(?<!\p{Nd})\p{Nd}{1,3}:\p{Nd}{2}(?::\p{Nd}{2})?(?!\p{Nd})/gu,
    nearShareWord: 'keep',
  },
  // Definition versions: activity-context-v1, activity-impact-consultation-v1
  { pattern: /(?<=[a-z])-v\p{Nd}+(?!\p{Nd})/gu, nearShareWord: 'keep' },
  // RPE on its fixed 0–10 scale: RPE 7/10
  { pattern: /\bRPE\s*\p{Nd}{1,2}\s*\/\s*10(?!\p{Nd})/gu, nearShareWord: 'keep' },
  // Heart-rate zone labels: Z2, 심박 구간 2, 심박 존 2, HR zone 2
  {
    pattern:
      /(?<![\p{L}\p{Nd}])Z[1-7](?!\p{Nd})|심박\s*(?:구간|존)\s*[1-7](?!\p{Nd})|HR\s*zone\s*[1-7](?!\p{Nd})/giu,
    nearShareWord: 'mask',
  },
  // The observed partial-sum line: absolute distance and time this activity adds, not a share.
  {
    pattern:
      /이 활동의 합계 기여:\s*거리\s*(?:\p{Nd}+(?:\.\p{Nd}+)?\s*m|미확인)\s*·\s*시간\s*(?:\p{Nd}+\s*초|미확인)/gu,
    nearShareWord: 'mask',
  },
];

/** The same sentence (and, unless `acrossLines`, the same line), `reach` characters either side. */
function sentenceWindow(
  text: string,
  start: number,
  end: number,
  reach: number,
  acrossLines: boolean,
): string {
  const boundary = acrossLines ? /[.。!?]/u : /[.。!?\n]/u;
  const before =
    text
      .slice(Math.max(0, start - reach), start)
      .split(boundary)
      .at(-1) ?? '';
  const after = text.slice(end, end + reach).split(boundary)[0] ?? '';
  return `${before} ${after}`;
}

/** The text with allow-listed digits masked as `#`, so only quantities are left to check. */
export function maskAllowedNumbers(text: string): string {
  return allowedNumbers.reduce(
    (masked, { pattern, nearShareWord }) =>
      masked.replace(pattern, (match: string, ...rest: unknown[]) => {
        const offset = rest.find((value): value is number => typeof value === 'number') ?? 0;
        const end = offset + match.length;
        const keep =
          nearShareWord === 'keep' &&
          (shareWordNearby.test(sentenceWindow(masked, offset, end, 20, false)) ||
            causalWordNearby.test(sentenceWindow(masked, offset, end, 40, true)));
        return keep ? match : match.replace(digit, '#');
      }),
    text,
  );
}

/** Every match of every forbidden pattern after the allow-list, for a readable failure. */
export function forbiddenImpactMatches(text: string): string[] {
  const masked = maskAllowedNumbers(text);
  return forbiddenImpactText.flatMap((pattern) =>
    [...masked.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map(
      (found) => `${String(pattern)} → ${JSON.stringify(found[0])}`,
    ),
  );
}
