import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import {
  AiSettingsWorkspace,
  AiSettingsPortError,
  type AiSettingsPort,
} from '../src/ai-settings-workspace.js';
import {
  aiExecutionCatalogV1Schema,
  type AiSettingsWriteV1,
  type AiSettingsV1,
} from '@workout/contracts/ai-settings';
const absent = {
  schemaVersion: 1,
  revision: 0,
  updatedAt: null,
  defaultSelection: null,
  syntheticComparison: { kind: 'off' },
};
function catalog() {
  return aiExecutionCatalogV1Schema.parse({
    schemaVersion: 1,
    catalogRevision: 7,
    policyVersion: 'policy:1',
    disclosureVersion: 'disclosure:1',
    approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
    providers: [
      {
        providerId: 'openai',
        displayName: 'OpenAI',
        selectable: true,
        availability: { kind: 'unavailable', reasonCode: 'unconfigured' },
        recipient: {
          recipientId: 'openai',
          displayName: 'OpenAI',
          disclosureVersion: 'disclosure:1',
        },
        models: [
          {
            modelId: 'gpt-6.1-sol',
            displayName: '기본 모델',
            selectable: true,
            availability: { kind: 'unavailable', reasonCode: 'unconfigured' },
            purposes: ['coaching'],
          },
          {
            modelId: 'gpt-6-luna',
            displayName: '비교 모델',
            selectable: true,
            availability: { kind: 'unavailable', reasonCode: 'unconfigured' },
            purposes: ['synthetic_comparison'],
          },
        ],
      },
    ],
    recommendedDefault: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
    recommendedSyntheticComparison: { kind: 'off' },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function port(overrides: Partial<AiSettingsPort> = {}) {
  return {
    getCatalog: vi.fn(async () => catalog()),
    getSettings: vi.fn(async () => absent),
    save: vi.fn(async (_context, command: AiSettingsWriteV1) => ({
      schemaVersion: 1,
      revision: command.expectedRevision + 1,
      updatedAt: '2026-10-06T00:00:00Z',
      defaultSelection: command.defaultSelection,
      syntheticComparison: command.syntheticComparison,
    })),
    ...overrides,
  } satisfies AiSettingsPort;
}
async function choose() {
  const user = userEvent.setup();
  await screen.findByLabelText('기본 제공자');
  await user.selectOptions(screen.getByLabelText('기본 제공자'), 'openai');
  expect(screen.getByLabelText('기본 모델')).toHaveValue('');
  await user.selectOptions(screen.getByLabelText('기본 모델'), 'gpt-6.1-sol');
  return user;
}
test('independent reads start together and recommendations never fill absent preferences', async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const fake = port({
    getCatalog: vi.fn(() => first.promise),
    getSettings: vi.fn(() => second.promise),
  });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  expect(fake.getCatalog).toHaveBeenCalledOnce();
  expect(fake.getSettings).toHaveBeenCalledOnce();
  await act(async () => {
    first.resolve(catalog());
    second.resolve(absent);
  });
  expect(await screen.findByLabelText('기본 제공자')).toHaveValue('');
  expect(screen.getByLabelText('합성 비교 사용')).toHaveValue('off');
  expect(screen.getByText(/50,000원/)).toBeVisible();
  expect(screen.getByText(/새 요청에 사용할 선택을 저장합니다/)).toBeVisible();
  expect(fake.save).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /실행|연결|동의/ })).not.toBeInTheDocument();
});
test('explicit choices save only after committed response; prepared model remains unavailable', async () => {
  const pending = deferred<unknown>();
  const save = vi.fn((_context, _command: AiSettingsWriteV1) => pending.promise);
  const fake = port({ save });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  const user = await choose();
  expect(screen.getByText(/AI 연결이 준비되지/)).toBeVisible();
  expect(screen.getByText('정보를 받는 곳: OpenAI')).toBeVisible();
  for (const label of ['계획 요약', '실제 기록 요약', '체크인', '참고 자료 발췌'])
    expect(screen.getByText(label)).toBeVisible();
  expect(screen.getByText(/기존 코칭·계획을 변경하지 않습니다/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  expect(screen.queryByText('AI 설정을 저장했습니다.')).not.toBeInTheDocument();
  const command = save.mock.calls[0]?.[1];
  expect(command?.expectedRevision).toBe(0);
  expect(command?.syntheticComparison).toEqual({ kind: 'off' });
  await act(async () =>
    pending.resolve({
      ...absent,
      revision: 1,
      updatedAt: '2026-10-06T00:00:00Z',
      defaultSelection: command?.defaultSelection,
    }),
  );
  expect(await screen.findByText('AI 설정을 저장했습니다.')).toBeVisible();
  expect(save).toHaveBeenCalledOnce();
});
test('conflict preserves draft; explicit reload changes revision and cancel restores focus', async () => {
  let latest: AiSettingsV1 = { ...absent, schemaVersion: 1, syntheticComparison: { kind: 'off' } };
  const fake = port({
    getSettings: vi.fn(async () => latest),
    save: vi.fn(async () => {
      throw new AiSettingsPortError('STALE_CATALOG');
    }),
  });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  const user = await choose();
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  expect(await screen.findByText(/초안을 유지했으니/)).toBeVisible();
  expect(screen.getByLabelText('기본 모델')).toHaveValue('gpt-6.1-sol');
  latest = {
    schemaVersion: 1,
    revision: 4,
    updatedAt: '2026-10-06T00:00:00Z',
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  };
  await user.click(screen.getByRole('button', { name: '최신 설정 다시 확인' }));
  await waitFor(() => expect(fake.getSettings).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('기본 모델')).toHaveValue('gpt-6.1-sol');
  await waitFor(() => expect(screen.getByRole('button', { name: '설정 저장' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  expect(vi.mocked(fake.save).mock.calls[1]?.[1].expectedRevision).toBe(4);
  await screen.findByText(/초안을 유지했으니/);
  await user.click(screen.getByRole('button', { name: '변경 취소' }));
  expect(screen.getByLabelText('기본 제공자')).toHaveValue('');
  expect(screen.getByLabelText('기본 제공자')).toHaveFocus();
});
test('malformed save response cannot report success or discard draft', async () => {
  const fake = port({ save: vi.fn(async () => ({ ...absent, apiKey: 'fake' })) });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  const user = await choose();
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  expect(await screen.findByText(/설정을 저장하지 못했습니다/)).toBeVisible();
  expect(screen.getByLabelText('기본 모델')).toHaveValue('gpt-6.1-sol');
  expect(screen.queryByText('AI 설정을 저장했습니다.')).not.toBeInTheDocument();
});
test('removed stored selection is retained without fallback and can explicitly be cleared', async () => {
  const empty = { ...catalog(), providers: [], recommendedDefault: null };
  const fake = port({
    getCatalog: vi.fn(async () => empty),
    getSettings: vi.fn(async () => ({
      ...absent,
      revision: 2,
      updatedAt: '2026-10-06T00:00:00Z',
      defaultSelection: { providerId: 'removed', modelId: 'old' },
    })),
  });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  expect(await screen.findByLabelText('기본 제공자')).toHaveValue('removed');
  expect(screen.getByText('현재 선택할 수 있는 AI 제공자가 없습니다.')).toBeVisible();
  expect(screen.getByRole('button', { name: '설정 저장' })).toBeDisabled();
  expect(screen.queryByText('removed')).not.toBeInTheDocument();
  await userEvent.setup().selectOptions(screen.getByLabelText('기본 제공자'), '');
  expect(screen.getByRole('button', { name: '설정 저장' })).toBeEnabled();
});
test('late account reads are aborted and cannot replace the new account', async () => {
  const pending = deferred<unknown>();
  const oldRead = vi.fn(() => pending.promise);
  const old = port({ getSettings: oldRead });
  const next = port();
  const view = render(<AiSettingsWorkspace athleteId="a" sessionId="old" port={old} />);
  view.rerender(<AiSettingsWorkspace athleteId="b" sessionId="new" port={next} />);
  expect(await screen.findByLabelText('기본 제공자')).toHaveValue('');
  expect(vi.mocked(old.getSettings).mock.calls[0]?.[0].signal.aborted).toBe(true);
  await act(async () =>
    pending.resolve({
      ...absent,
      revision: 1,
      updatedAt: '2026-10-06T00:00:00Z',
      defaultSelection: { providerId: 'removed', modelId: 'old' },
    }),
  );
  expect(screen.getByLabelText('기본 제공자')).toHaveValue('');
});
test('late save from another account cannot display success', async () => {
  const pending = deferred<unknown>();
  const save = vi.fn((_context, _command: AiSettingsWriteV1) => pending.promise);
  const old = port({ save });
  const view = render(<AiSettingsWorkspace athleteId="a" sessionId="old" port={old} />);
  const user = await choose();
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  view.rerender(<AiSettingsWorkspace athleteId="b" sessionId="new" port={port()} />);
  await screen.findByLabelText('기본 제공자');
  expect(save.mock.calls[0]?.[0].signal.aborted).toBe(true);
  await act(async () =>
    pending.resolve({
      ...absent,
      revision: 1,
      updatedAt: '2026-10-06T00:00:00Z',
      defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
    }),
  );
  expect(screen.queryByText('AI 설정을 저장했습니다.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('기본 제공자')).toHaveValue('');
});
test('unauthenticated workspace makes no port calls', () => {
  const fake = port();
  render(<AiSettingsWorkspace athleteId={null} sessionId={null} port={fake} />);
  expect(screen.getByText(/로그인 후/)).toBeVisible();
  expect(fake.getCatalog).not.toHaveBeenCalled();
  expect(fake.getSettings).not.toHaveBeenCalled();
});

test('unapproved provider and invalid catalog data fail closed at the boundary', async () => {
  const data = catalog();
  const provider = data.providers[0];
  if (!provider) throw new Error('missing fixture provider');
  const fake = port({
    getCatalog: vi.fn(async () => ({
      ...data,
      providers: [{ ...provider, providerId: 'other' }],
      recommendedDefault: null,
    })),
  });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('설정을 불러오지 못했습니다');
  expect(screen.queryByLabelText('기본 제공자')).not.toBeInTheDocument();
  expect(fake.save).not.toHaveBeenCalled();
});

test('CSRF rejection preserves explicit draft without success or automatic retry', async () => {
  const save = vi.fn(async () => {
    throw new AiSettingsPortError('CSRF_REJECTED');
  });
  const fake = port({ save });
  render(<AiSettingsWorkspace athleteId="a" sessionId="s" port={fake} />);
  const user = await choose();
  await user.click(screen.getByRole('button', { name: '설정 저장' }));
  expect(
    await screen.findByText(
      '요청을 확인하지 못했습니다. 페이지를 새로 열어 다시 시도해 주세요. 선택한 초안은 유지됩니다.',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('기본 제공자')).toHaveValue('openai');
  expect(screen.getByLabelText('기본 모델')).toHaveValue('gpt-6.1-sol');
  expect(screen.getByLabelText('합성 비교 사용')).toHaveValue('off');
  expect(screen.queryByText('AI 설정을 저장했습니다.')).not.toBeInTheDocument();
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '설정 저장' })).toBeEnabled();
});
