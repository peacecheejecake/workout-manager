import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { ActionMenu } from '@workout/ui-foundation/action-menu';
import { HelpTooltip } from '@workout/ui-foundation/help-tooltip';
import { ModalDialog, type ModalUnavailableReason } from '@workout/ui-foundation/modal-dialog';
import styles from './overlay-panel.module.css';

const subscribe = () => () => {};
const nativePopover = () =>
  typeof HTMLElement !== 'undefined' &&
  typeof HTMLElement.prototype.showPopover === 'function' &&
  typeof HTMLElement.prototype.hidePopover === 'function';

/** Synthetic callbacks live only for this panel lifetime; no domain writes or transport. */
export function OverlayPanel() {
  const titleId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalMenuOpen, setModalMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [launcherHidden, setLauncherHidden] = useState(false);
  const [unavailable, setUnavailable] = useState<ModalUnavailableReason | null>(null);
  const [count, setCount] = useState(0);
  const popover = useSyncExternalStore(subscribe, nativePopover, () => false);
  const actions = [
    {
      id: 'count',
      label: '합성 횟수 증가',
      state: 'enabled' as const,
      onSelect: () => setCount((value) => value + 1),
    },
    { id: 'disabled', label: '사용 불가 합성 동작', state: 'disabled' as const },
    {
      id: 'other',
      label: '다른 합성 횟수 증가',
      state: 'enabled' as const,
      onSelect: () => setCount((value) => value + 1),
    },
  ];
  function closeModal() {
    setModalMenuOpen(false);
    setModalOpen(false);
  }
  return (
    <section className={styles.panel} aria-label="Overlay 조합 검증">
      <h2>Modal · Tooltip · Action menu 조합</h2>
      <p>개인·서버 자료 없는 합성 동작입니다. 횟수는 이 패널을 닫으면 제거됩니다.</p>
      <p role="status" aria-label="합성 동작 횟수">
        합성 동작 횟수: {count}
      </p>
      <p role="status">
        {popover
          ? 'Native popover 사용 가능'
          : 'Native popover 미지원 · 메뉴는 inline 대안이며 clipping 보호를 보장하지 않습니다. 도움말은 설명문으로 표시합니다.'}
      </p>
      {unavailable ? <p role="alert">Modal 사용 불가: {unavailable}</p> : null}
      <div
        className={styles.clip}
        data-native-overlay={popover}
        aria-label="Overflow clipping 검사 영역"
      >
        <ActionMenu
          label="Clipping 내부 메뉴"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          actions={actions}
        />
      </div>
      <div hidden>
        <button type="button">hidden 조상 안 동작</button>
      </div>
      <div className={styles.invisible}>
        <button type="button">visibility hidden 조상 안 동작</button>
      </div>
      <div className={styles.notDisplayed}>
        <button type="button">display none 조상 안 동작</button>
      </div>
      <div className={styles.contentHidden}>
        <button type="button">content visibility hidden 조상 안 동작</button>
      </div>
      <div inert>
        <button type="button">inert 조상 안 동작</button>
      </div>
      <button type="button">메뉴 다음 가시 동작</button>
      <HelpTooltip
        label="합성 횟수 도움말"
        description="횟수 증가는 합성 callback일 뿐 저장이나 승인이 아닙니다."
        interaction="available"
      />
      <div hidden={launcherHidden}>
        <button
          ref={launcher}
          type="button"
          onClick={() => {
            setUnavailable(null);
            setModalOpen(true);
          }}
        >
          조합 모달 열기
        </button>
      </div>
      {launcherHidden ? (
        <button type="button" onClick={() => setLauncherHidden(false)}>
          모달 실행 버튼 복원
        </button>
      ) : null}
      <ModalDialog
        open={modalOpen}
        title="합성 조합 모달"
        titleId={titleId}
        closeLabel="조합 모달 닫기"
        initialFocusRef={initialFocus}
        returnFocusRef={launcher}
        onRequestClose={closeModal}
        onOpenUnavailable={(reason) => {
          setUnavailable(reason);
          closeModal();
        }}
        controls={
          <button
            type="button"
            onClick={() => {
              setLauncherHidden(true);
              closeModal();
            }}
          >
            닫고 실행 버튼 숨기기
          </button>
        }
      >
        <button ref={initialFocus} type="button">
          모달 첫 가시 동작
        </button>
        <HelpTooltip
          label="모달 도움말"
          description="Escape는 먼저 열린 메뉴를 닫고 모달을 유지해야 합니다."
          interaction="available"
        />
        <ActionMenu
          label="모달 안 메뉴"
          open={modalMenuOpen}
          onOpenChange={setModalMenuOpen}
          actions={actions}
        />
        <div hidden>
          <button type="button">모달 hidden 조상 동작</button>
        </div>
        <div className={styles.invisible}>
          <button type="button">모달 visibility hidden 조상 동작</button>
        </div>
        <div className={styles.notDisplayed}>
          <button type="button">모달 display none 조상 동작</button>
        </div>
        <div className={styles.contentHidden}>
          <button type="button">모달 content visibility hidden 조상 동작</button>
        </div>
        <div inert>
          <button type="button">모달 inert 조상 동작</button>
        </div>
        <button type="button">모달 다음 가시 동작</button>
      </ModalDialog>
    </section>
  );
}
