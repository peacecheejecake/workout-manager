import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@workout/ui-foundation/button';
import { TextAreaField, TextField } from '@workout/ui-foundation/text-field';
import { StatusNotice } from '@workout/ui-foundation/status-notice';
import { AdaptiveWorkspace } from '@workout/ui-foundation/adaptive-workspace';
import styles from './foundation.module.css';

function FoundationExample() {
  const [note, setNote] = useState('');
  const [view, setView] = useState<'stack' | 'split'>('split');
  return (
    <main className="wm-page">
      <h1>공통 컨트롤</h1>
      <Button variant="secondary" aria-pressed={view === 'stack'} onClick={() => setView('stack')}>
        한 열 보기
      </Button>
      <Button variant="secondary" aria-pressed={view === 'split'} onClick={() => setView('split')}>
        나란히 보기
      </Button>
      <AdaptiveWorkspace requestedView={view}>
        <div>
          <TextField label="제목" description="키보드와 IME 입력을 확인하세요." />
          <TextField label="오류 예시" error="제목을 입력하세요." />
          <Button disabled>사용 불가</Button>
        </div>
        <div>
          <TextAreaField
            label="임시 메모"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button variant="secondary" onClick={() => setNote('')}>
            초기화
          </Button>
        </div>
      </AdaptiveWorkspace>
      {(
        ['loading', 'empty', 'partial', 'error', 'stale', 'unavailable', 'sync-pending'] as const
      ).map((state) => (
        <StatusNotice key={state} state={state}>
          상태별 설명과 가능한 다음 행동을 표시합니다.
        </StatusNotice>
      ))}
    </main>
  );
}
const meta = {
  title: 'Foundation/Workspace',
  component: FoundationExample,
  decorators: [
    (Story) => (
      <div className={styles.canvas}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FoundationExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Alpine: Story = {};
export const Aurora: Story = {
  decorators: [
    (Story) => (
      <div data-theme="aurora" className={styles.canvas}>
        <Story />
      </div>
    ),
  ],
};
export const Solid: Story = {
  decorators: [
    (Story) => (
      <div data-transparency="reduced" className={styles.canvas}>
        <Story />
      </div>
    ),
  ],
};
