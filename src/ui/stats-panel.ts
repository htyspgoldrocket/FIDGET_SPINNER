// 통계 패널 — 최고 RPM / 총 회전수 / 최장 회전 시간 / 세션 수 + 백업 코드 내보내기·불러오기.
//
// 스타일 계열은 debug-overlay / 미지원 안내 배너와 같다 (다크 #0e1116, 네온 #39d5ff / #9ef01a).
//
// **플릭을 방해하지 않는다**: 루트 컨테이너는 pointer-events:none 이고, 실제로 이벤트를 받는 것은
// 모서리의 토글 버튼과 열려 있는 동안의 패널뿐이다. 패널이 닫혀 있으면 화면 전체가 캔버스의 것이다.
//
// **Phase 5 대비**: 열기/닫기는 `open()` / `close()` 함수로 분리돼 있고, 버튼은 곧바로 이 함수를
// 부르지 않고 `onOpenRequest` / `onCloseRequest` 훅을 먼저 본다. Phase 5 에서 History API 로
// 화면 전환을 옮길 때, 훅에 history.pushState / history.back 을 꽂고 popstate 에서 open/close 를
// 부르면 이 파일은 한 줄도 바뀌지 않는다.

import {
  FLICK_SENSITIVITY_DEFAULT,
  FLICK_SENSITIVITY_MAX,
  FLICK_SENSITIVITY_MIN,
} from '../core/constants';
import { clampFlickSensitivity } from '../core/input-model';
import type { SpinAggregate } from '../core/stats';
import { EMPTY_SPIN_AGGREGATE } from '../core/stats';
import { BackupError } from '../platform/storage/adapter';

const COLOR_SURFACE = 'rgba(14, 17, 22, 0.96)';
const COLOR_LINE = 'rgba(57, 213, 255, 0.35)';
const COLOR_TEXT = '#cfe9f5';
const COLOR_MUTED = 'rgba(207, 233, 245, 0.6)';
const COLOR_ACCENT = '#39d5ff';
const COLOR_HIGHLIGHT = '#9ef01a';

/** 백업 코드를 복사한 뒤 안내 문구가 남아 있는 시간 [ms]. */
const MESSAGE_LINGER_MS = 4000;

/** 민감도 슬라이더의 눈금 간격 [%]. 5%p 는 손가락으로 짚을 수 있으면서 체감이 나는 최소 단위다. */
const SENSITIVITY_STEP_PERCENT = 5;

/** 배율(0.25~1.5) → 화면·슬라이더가 쓰는 백분율. 슬라이더는 정수로만 다룬다 —
 *  step 을 0.05 로 두면 부동소수 누적 때문에 눈금이 0.7500000000000001 같은 값에 걸린다. */
function toPercent(sensitivity: number): number {
  return Math.round(sensitivity * 100);
}

export interface StatsPanelHandlers {
  /** 백업 코드를 만들어 온다. 실패하면 reject — 패널이 에러 문구로 보여준다. */
  onExport(): Promise<string>;
  /** 백업 코드를 적용한다. 실패하면 reject. */
  onImport(code: string): Promise<void>;
  /**
   * 민감도 슬라이더가 움직였다. 매 눈금마다 불린다 (드래그 중에도).
   *
   * 호출부는 **즉시 적용**하고 저장은 스스로 미룬다 — 이 훅은 저장을 기다리지 않는다.
   * 슬라이더의 반응이 IndexedDB 의 속도에 묶이면 손가락이 걸리는 느낌이 난다.
   */
  onSensitivityChange(sensitivity: number): void;
  /** 있으면 토글 버튼이 open() 대신 이것을 부른다 (Phase 5: history.pushState). */
  onOpenRequest?(): void;
  /** 있으면 닫기 버튼·배경 탭이 close() 대신 이것을 부른다 (Phase 5: history.back). */
  onCloseRequest?(): void;
}

export interface StatsPanel {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 화면의 숫자를 갱신한다. 패널이 닫혀 있어도 값은 반영해둔다. */
  setAggregate(aggregate: SpinAggregate): void;
  /** 슬라이더 위치를 맞춘다 (저장소에서 읽어온 값 반영). onSensitivityChange 는 불리지 않는다. */
  setSensitivity(sensitivity: number): void;
  dispose(): void;
}

// ── 값 표시 형식 ──────────────────────────────────────────────

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return Math.round(value).toLocaleString('ko-KR');
}

/** 회전수는 한 바퀴가 큰 단위라 100 미만에서는 소수 첫째 자리까지 보여준다. */
function formatRevolutions(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 100) return value.toFixed(1);
  return Math.round(value).toLocaleString('ko-KR');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0초';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds - minutes * 60);
  return `${String(minutes)}분 ${String(rest).padStart(2, '0')}초`;
}

// ── DOM 조립 ──────────────────────────────────────────────────

function styleButton(button: HTMLButtonElement, emphasis: boolean): void {
  Object.assign(button.style, {
    flex: '1 1 auto',
    minHeight: '38px',
    padding: '0 12px',
    borderRadius: '9px',
    border: `1px solid ${emphasis ? COLOR_LINE : 'rgba(207, 233, 245, 0.2)'}`,
    background: emphasis ? 'rgba(57, 213, 255, 0.16)' : 'rgba(207, 233, 245, 0.06)',
    color: emphasis ? COLOR_ACCENT : COLOR_TEXT,
    font: '13px/1 system-ui, sans-serif',
    cursor: 'pointer',
  });
}

function styleTextarea(area: HTMLTextAreaElement): void {
  Object.assign(area.style, {
    width: '100%',
    // 줄 높이(11px × 1.4)의 정수 배 + 세로 여백. 마지막 줄이 반만 보이면 코드가 잘린 것처럼 읽힌다.
    minHeight: '78px',
    marginTop: '8px',
    padding: '8px',
    boxSizing: 'border-box',
    borderRadius: '8px',
    border: '1px solid rgba(207, 233, 245, 0.2)',
    background: 'rgba(4, 8, 12, 0.72)',
    color: COLOR_TEXT,
    font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    resize: 'none',
    wordBreak: 'break-all',
  });
}

function createStatRow(label: string, key: string): [HTMLDivElement, HTMLSpanElement] {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '9px 0',
    borderBottom: '1px solid rgba(207, 233, 245, 0.1)',
  });

  const name = document.createElement('span');
  name.textContent = label;
  Object.assign(name.style, { color: COLOR_MUTED, font: '13px/1.3 system-ui, sans-serif' });

  const value = document.createElement('span');
  value.dataset['stat'] = key;
  value.textContent = '—';
  Object.assign(value.style, {
    color: COLOR_HIGHLIGHT,
    font: '600 18px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
  });

  row.append(name, value);
  return [row, value];
}

/**
 * 패널을 만들어 host 에 붙인다. 처음에는 닫혀 있다.
 *
 * 어떤 실패도 콘솔 에러로 새어나가지 않는다 (e2e 가 콘솔 에러 0 을 검사한다).
 * 사용자에게 필요한 것은 스택 트레이스가 아니라 "무엇이 잘못됐는지" 한 줄이다.
 */
export function mountStatsPanel(host: HTMLElement, handlers: StatsPanelHandlers): StatsPanel {
  const root = document.createElement('div');
  root.id = 'stats-root';
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '25',
  });

  // ── 토글 버튼 (우상단 모서리) ────────────────────────────────
  const toggle = document.createElement('button');
  toggle.id = 'stats-toggle';
  toggle.type = 'button';
  toggle.textContent = '기록';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', '기록 보기');
  Object.assign(toggle.style, {
    position: 'absolute',
    top: 'calc(8px + env(safe-area-inset-top, 0px))',
    right: 'calc(8px + env(safe-area-inset-right, 0px))',
    minWidth: '52px',
    height: '34px',
    padding: '0 10px',
    borderRadius: '10px',
    border: `1px solid ${COLOR_LINE}`,
    background: 'rgba(14, 17, 22, 0.78)',
    color: COLOR_ACCENT,
    font: '13px/1 system-ui, sans-serif',
    pointerEvents: 'auto',
    cursor: 'pointer',
  });

  // ── 패널 ────────────────────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.id = 'stats-panel';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', '기록');
  Object.assign(backdrop.style, {
    position: 'absolute',
    inset: '0',
    display: 'none',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: 'calc(14px + env(safe-area-inset-top, 0px)) 14px 14px',
    boxSizing: 'border-box',
    background: 'rgba(4, 8, 12, 0.62)',
    pointerEvents: 'none',
    overflowY: 'auto',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    width: '100%',
    maxWidth: '360px',
    padding: '14px 16px 16px',
    boxSizing: 'border-box',
    borderRadius: '14px',
    border: `1px solid ${COLOR_LINE}`,
    background: COLOR_SURFACE,
    color: COLOR_TEXT,
    font: '13px/1.5 system-ui, sans-serif',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '4px',
  });

  const title = document.createElement('h2');
  title.textContent = '기록';
  Object.assign(title.style, {
    margin: '0',
    color: COLOR_ACCENT,
    font: '600 15px/1.2 system-ui, sans-serif',
    letterSpacing: '0.06em',
  });

  const closeButton = document.createElement('button');
  closeButton.id = 'stats-close';
  closeButton.type = 'button';
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', '기록 닫기');
  Object.assign(closeButton.style, {
    width: '30px',
    height: '30px',
    borderRadius: '8px',
    border: '0',
    background: 'rgba(57, 213, 255, 0.14)',
    color: COLOR_ACCENT,
    font: '13px/1 system-ui, sans-serif',
    cursor: 'pointer',
  });

  header.append(title, closeButton);

  const [rowRpm, valueRpm] = createStatRow('최고 RPM', 'bestRpm');
  const [rowRevolutions, valueRevolutions] = createStatRow('총 회전수', 'totalRevolutions');
  const [rowDuration, valueDuration] = createStatRow('최장 회전 시간', 'bestDurationMs');
  const [rowSessions, valueSessions] = createStatRow('세션 수', 'sessionCount');

  // ── 조작 민감도 ─────────────────────────────────────────────
  const sensitivityTitle = document.createElement('p');
  sensitivityTitle.textContent = '조작 민감도';
  Object.assign(sensitivityTitle.style, {
    margin: '14px 0 0',
    color: COLOR_MUTED,
    font: '12px/1.4 system-ui, sans-serif',
  });

  const sensitivityHint = document.createElement('p');
  sensitivityHint.textContent = '터치에 너무 예민하면 낮추세요. 다음 플릭부터 적용됩니다.';
  Object.assign(sensitivityHint.style, {
    margin: '2px 0 8px',
    color: COLOR_MUTED,
    font: '11px/1.45 system-ui, sans-serif',
  });

  const sensitivityRow = document.createElement('div');
  Object.assign(sensitivityRow.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  });

  const sensitivitySlider = document.createElement('input');
  sensitivitySlider.id = 'stats-sensitivity';
  sensitivitySlider.type = 'range';
  sensitivitySlider.min = String(toPercent(FLICK_SENSITIVITY_MIN));
  sensitivitySlider.max = String(toPercent(FLICK_SENSITIVITY_MAX));
  sensitivitySlider.step = String(SENSITIVITY_STEP_PERCENT);
  sensitivitySlider.setAttribute('aria-label', '플릭 민감도');
  Object.assign(sensitivitySlider.style, {
    flex: '1 1 auto',
    minWidth: '0',
    height: '34px', // 손가락으로 잡을 수 있는 최소 높이. 트랙은 얇아도 히트 영역은 넓어야 한다.
    accentColor: COLOR_ACCENT,
    // html/body 가 touch-action:none 이라 터치 드래그가 슬라이더까지 오지 않는다. 여기서만
    // 세로 팬을 허용해두면(= 가로는 여전히 브라우저가 안 가져간다) 가로 드래그가 슬라이더 몫이 되고,
    // 패널이 길어져 세로로 넘칠 때 슬라이더 위에서 시작한 스크롤도 그대로 먹는다.
    touchAction: 'pan-y',
    cursor: 'pointer',
  });

  const sensitivityValue = document.createElement('span');
  sensitivityValue.id = 'stats-sensitivity-value';
  Object.assign(sensitivityValue.style, {
    flex: '0 0 auto',
    // 25%~150% 사이에서 자릿수가 바뀌어도 슬라이더 끝이 밀리지 않게 폭을 고정한다.
    minWidth: '48px',
    textAlign: 'right',
    color: COLOR_HIGHLIGHT,
    font: '600 14px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
  });

  sensitivityRow.append(sensitivitySlider, sensitivityValue);

  const backupTitle = document.createElement('p');
  backupTitle.textContent = '백업 코드';
  Object.assign(backupTitle.style, {
    margin: '14px 0 0',
    color: COLOR_MUTED,
    font: '12px/1.4 system-ui, sans-serif',
  });

  const backupHint = document.createElement('p');
  backupHint.textContent = '브라우저 저장소를 지우면 기록이 사라집니다. 코드를 따로 보관하세요.';
  Object.assign(backupHint.style, {
    margin: '2px 0 8px',
    color: COLOR_MUTED,
    font: '11px/1.45 system-ui, sans-serif',
  });

  const exportRow = document.createElement('div');
  Object.assign(exportRow.style, { display: 'flex', gap: '8px' });

  const exportButton = document.createElement('button');
  exportButton.id = 'stats-export';
  exportButton.type = 'button';
  exportButton.textContent = '내보내기';
  styleButton(exportButton, true);

  const copyButton = document.createElement('button');
  copyButton.id = 'stats-copy';
  copyButton.type = 'button';
  copyButton.textContent = '복사';
  copyButton.disabled = true;
  styleButton(copyButton, false);
  copyButton.style.opacity = '0.5';

  exportRow.append(exportButton, copyButton);

  const exportCode = document.createElement('textarea');
  exportCode.id = 'stats-code';
  exportCode.readOnly = true;
  exportCode.setAttribute('aria-label', '백업 코드');
  exportCode.placeholder = '내보내기를 누르면 여기에 코드가 나옵니다.';
  styleTextarea(exportCode);

  const importCode = document.createElement('textarea');
  importCode.id = 'stats-import-code';
  importCode.setAttribute('aria-label', '불러올 백업 코드');
  importCode.placeholder = '백업 코드를 붙여넣으세요.';
  styleTextarea(importCode);
  importCode.style.marginTop = '14px';

  const importButton = document.createElement('button');
  importButton.id = 'stats-import';
  importButton.type = 'button';
  importButton.textContent = '불러오기 (현재 기록을 덮어씁니다)';
  styleButton(importButton, false);
  importButton.style.marginTop = '8px';
  importButton.style.width = '100%';

  const message = document.createElement('p');
  message.id = 'stats-message';
  message.setAttribute('role', 'status');
  message.textContent = '';
  Object.assign(message.style, {
    margin: '10px 0 0',
    minHeight: '16px',
    font: '12px/1.4 system-ui, sans-serif',
    color: COLOR_MUTED,
  });

  card.append(
    header,
    rowRpm,
    rowRevolutions,
    rowDuration,
    rowSessions,
    sensitivityTitle,
    sensitivityHint,
    sensitivityRow,
    backupTitle,
    backupHint,
    exportRow,
    exportCode,
    importCode,
    importButton,
    message,
  );
  backdrop.append(card);
  root.append(toggle, backdrop);
  host.append(root);

  // ── 동작 ────────────────────────────────────────────────────

  let opened = false;
  let messageTimer = 0;

  function showMessage(text: string, tone: 'info' | 'error' | 'ok'): void {
    if (messageTimer !== 0) {
      window.clearTimeout(messageTimer);
      messageTimer = 0;
    }
    message.textContent = text;
    message.style.color =
      tone === 'error' ? '#ff8b7d' : tone === 'ok' ? COLOR_HIGHLIGHT : COLOR_MUTED;
    if (text !== '' && tone !== 'error') {
      messageTimer = window.setTimeout(() => {
        message.textContent = '';
        messageTimer = 0;
      }, MESSAGE_LINGER_MS);
    }
  }

  function open(): void {
    if (opened) return;
    opened = true;
    backdrop.style.display = 'flex';
    backdrop.style.pointerEvents = 'auto';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.style.visibility = 'hidden';
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    backdrop.style.display = 'none';
    backdrop.style.pointerEvents = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.style.visibility = 'visible';
    showMessage('', 'info');
  }

  function onToggleClick(): void {
    if (handlers.onOpenRequest !== undefined) handlers.onOpenRequest();
    else open();
  }

  function onCloseClick(): void {
    if (handlers.onCloseRequest !== undefined) handlers.onCloseRequest();
    else close();
  }

  function onBackdropClick(event: MouseEvent): void {
    if (event.target === backdrop) onCloseClick();
  }

  function setCopyEnabled(enabled: boolean): void {
    copyButton.disabled = !enabled;
    copyButton.style.opacity = enabled ? '1' : '0.5';
  }

  function onExportClick(): void {
    exportButton.disabled = true;
    handlers.onExport().then(
      (code) => {
        exportButton.disabled = false;
        exportCode.value = code;
        setCopyEnabled(code !== '');
        showMessage('백업 코드를 만들었습니다. 복사해서 보관하세요.', 'ok');
      },
      () => {
        exportButton.disabled = false;
        showMessage('백업 코드를 만들지 못했습니다. 잠시 후 다시 시도하세요.', 'error');
      },
    );
  }

  /** 클립보드는 권한·컨텍스트에 따라 조용히 실패한다. 실패해도 코드는 화면에 남아 있다. */
  function onCopyClick(): void {
    const code = exportCode.value;
    if (code === '') return;

    exportCode.focus();
    exportCode.select();

    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      showMessage('이 브라우저에서는 자동 복사가 안 됩니다. 코드를 길게 눌러 복사하세요.', 'info');
      return;
    }

    clipboard.writeText(code).then(
      () => showMessage('백업 코드를 복사했습니다.', 'ok'),
      () => showMessage('복사하지 못했습니다. 코드를 길게 눌러 직접 복사하세요.', 'info'),
    );
  }

  /** 슬라이더 위치와 % 표시를 한 값으로 맞춘다. 이벤트는 발생시키지 않는다. */
  function paintSensitivity(sensitivity: number): void {
    const percent = toPercent(sensitivity);
    sensitivitySlider.value = String(percent);
    sensitivityValue.textContent = `${String(percent)}%`;
    // 화면 표기는 반올림된 %지만, 검증(e2e)과 접근성 도구에는 실제 배율을 그대로 남긴다.
    sensitivityValue.dataset['value'] = String(sensitivity);
    sensitivitySlider.setAttribute('aria-valuetext', `${String(percent)}%`);
  }

  /** 드래그 중에도 눈금마다 불린다 — 표시는 여기서, 저장은 호출부가 미뤄서 한다. */
  function onSensitivityInput(): void {
    const sensitivity = clampFlickSensitivity(Number(sensitivitySlider.value) / 100);
    paintSensitivity(sensitivity);
    handlers.onSensitivityChange(sensitivity);
  }

  function onImportClick(): void {
    const code = importCode.value;
    if (code.trim() === '') {
      showMessage('불러올 백업 코드를 붙여넣으세요.', 'error');
      return;
    }

    importButton.disabled = true;
    handlers.onImport(code).then(
      () => {
        importButton.disabled = false;
        importCode.value = '';
        showMessage('백업 코드를 불러왔습니다. 기록이 교체되었습니다.', 'ok');
      },
      (error: unknown) => {
        importButton.disabled = false;
        showMessage(
          error instanceof BackupError
            ? error.message
            : '기록을 불러오지 못했습니다. 코드를 다시 확인하세요.',
          'error',
        );
      },
    );
  }

  toggle.addEventListener('click', onToggleClick);
  closeButton.addEventListener('click', onCloseClick);
  backdrop.addEventListener('click', onBackdropClick);
  exportButton.addEventListener('click', onExportClick);
  copyButton.addEventListener('click', onCopyClick);
  importButton.addEventListener('click', onImportClick);
  sensitivitySlider.addEventListener('input', onSensitivityInput);

  const panel: StatsPanel = {
    open,
    close,
    isOpen: (): boolean => opened,

    setAggregate(aggregate: SpinAggregate): void {
      valueRpm.textContent = formatCount(aggregate.bestRpm);
      valueRpm.dataset['value'] = String(aggregate.bestRpm);
      valueRevolutions.textContent = formatRevolutions(aggregate.totalRevolutions);
      valueRevolutions.dataset['value'] = String(aggregate.totalRevolutions);
      valueDuration.textContent = formatDuration(aggregate.bestDurationMs);
      valueDuration.dataset['value'] = String(aggregate.bestDurationMs);
      valueSessions.textContent = formatCount(aggregate.sessionCount);
      valueSessions.dataset['value'] = String(aggregate.sessionCount);
    },

    setSensitivity(sensitivity: number): void {
      paintSensitivity(clampFlickSensitivity(sensitivity));
    },

    dispose(): void {
      if (messageTimer !== 0) window.clearTimeout(messageTimer);
      toggle.removeEventListener('click', onToggleClick);
      closeButton.removeEventListener('click', onCloseClick);
      backdrop.removeEventListener('click', onBackdropClick);
      exportButton.removeEventListener('click', onExportClick);
      copyButton.removeEventListener('click', onCopyClick);
      importButton.removeEventListener('click', onImportClick);
      sensitivitySlider.removeEventListener('input', onSensitivityInput);
      root.remove();
    },
  };

  panel.setAggregate(EMPTY_SPIN_AGGREGATE);
  panel.setSensitivity(FLICK_SENSITIVITY_DEFAULT);
  return panel;
}
