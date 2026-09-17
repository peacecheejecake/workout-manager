import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActivityDetailTabs } from '../src/activity-detail-tabs';
import {
  readActivitySearch,
  updateActivitySearch,
  type ActivityDetailTab,
} from '../src/browser-search';

describe('URL-owned activity detail tabs', () => {
  it('keeps the list view/filter/page/selection independent and rejects only the unknown detail tab', () => {
    const search =
      'view=table&offset=20&selected=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&tag=run&sort=title_asc';
    expect(readActivitySearch(search).detailTab).toBe('overview');
    for (const tab of ['overview', 'intervals', 'impact', 'source', 'route', 'media']) {
      const changed = updateActivitySearch(search, { detailTab: tab });
      expect(readActivitySearch(changed)).toMatchObject({
        detailTab: tab,
        view: 'table',
        invalid: false,
      });
      expect(readActivitySearch(changed).query).toEqual(readActivitySearch(search).query);
      expect(readActivitySearch(changed).selected).toBe(readActivitySearch(search).selected);
    }
    expect(readActivitySearch(`${search}&detailTab=unknown`)).toMatchObject({
      detailTab: null,
      invalid: false,
    });
  });
  it('implements a single roving focus target with arrow/home/end activation that skips unavailable tabs', async () => {
    function Host() {
      const [value, setValue] = useState<ActivityDetailTab>('overview');
      return (
        <ActivityDetailTabs value={value} onChange={setValue}>
          <p>{value}</p>
        </ActivityDetailTabs>
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('tab', { name: '개요' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '구간', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '영향', selected: true })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: '출처', selected: true })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: '출처' })).toHaveTextContent('source');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '개요', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: '출처', selected: true })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: '개요', selected: true })).toHaveFocus();
    expect(screen.getAllByRole('tab').filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('tab', { name: '개요' }), {
      key: 'ArrowRight',
      altKey: true,
    });
    expect(screen.getByRole('tab', { name: '개요', selected: true })).toHaveFocus();
  });
  it.each([null, 'route', 'media'] as const)(
    'explains %s deep links and explicitly restores overview',
    async (value) => {
      const changed = vi.fn();
      render(
        <ActivityDetailTabs value={value} onChange={changed}>
          <span />
        </ActivityDetailTabs>,
      );
      expect(screen.getByRole('tab', { name: '경로' })).toBeDisabled();
      expect(screen.getByRole('tab', { name: '미디어' })).toBeDisabled();
      expect(screen.getByRole('tab', { name: '경로' })).toHaveAccessibleDescription(
        /GPS 기록 유무를 판단할 수 없습니다/,
      );
      if (value === null) expect(screen.getByRole('alert')).toHaveTextContent('알 수 없는');
      else
        expect(screen.getByRole('status')).toHaveTextContent(
          value === 'route' ? '경로 데이터를 제공하지 않습니다' : '미디어 연결을 제공하지 않습니다',
        );
      await userEvent.click(screen.getByRole('button', { name: '개요로 이동' }));
      expect(changed).toHaveBeenCalledExactlyOnceWith('overview');
      expect(screen.getByRole('tab', { name: '개요' })).toHaveFocus();
    },
  );
});
