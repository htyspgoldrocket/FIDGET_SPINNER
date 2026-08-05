// 메뉴 패널 — 기록 / 설정 / 설명서 세 탭을 가진 오버레이.
//
//  - 기록: 최고 RPM / 총 회전수 / 최장 회전 시간 / 세션 수 + 백업 코드 내보내기·불러오기
//  - 설정: 조작 민감도 슬라이더
//  - 설명서: 조작법 안내. 최초 실행 시 호출부(main)가 이 탭을 열어 보여준다.
//
// 스타일 계열은 debug-overlay / 미지원 안내 배너와 같다 (다크 #0e1116, 네온 #39d5ff / #9ef01a).
//
// **플릭을 방해하지 않는다**: 루트 컨테이너는 pointer-events:none 이고, 실제로 이벤트를 받는 것은
// 모서리의 토글 버튼과 열려 있는 동안의 패널뿐이다. 패널이 닫혀 있으면 화면 전체가 캔버스의 것이다.
//
// **탭은 히스토리 엔트리가 아니다**: 안드로이드 백버튼(History API)은 "패널 열림/닫힘"에만
// 대응한다. 탭 전환마다 엔트리를 쌓으면 백버튼을 탭 수만큼 눌러야 패널이 닫힌다 — 사용자가
// 기대하는 것은 "백버튼 = 패널 닫기" 한 번이다. 그래서 open/close 만 훅(onOpenRequest /
// onCloseRequest)을 거치고, 탭 전환은 패널 내부에서 끝난다.
//
// **DOM id 는 이전 stats-panel 시절 그대로다** (#stats-toggle, #stats-panel, #stats-sensitivity …).
// e2e 와 시각 회귀가 이 id 를 기준으로 잡혀 있어, 요소가 어느 탭에 있는지만 달라진다.

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

export type PanelTab = 'stats' | 'settings' | 'manual';

const TAB_TITLES: Record<PanelTab, string> = {
  stats: '기록',
  settings: '설정',
  manual: '설명서',
};

export interface PanelHandlers {
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
  /** 설명서 탭이 화면에 보이게 될 때마다 불린다. 호출부가 "봤다" 표시를 저장하는 데 쓴다. */
  onManualViewed?(): void;
  /** 있으면 토글 버튼이 open() 대신 이것을 부른다 (History API: history.pushState). */
  onOpenRequest?(): void;
  /** 있으면 닫기 버튼·배경 탭이 close() 대신 이것을 부른다 (History API: history.back). */
  onCloseRequest?(): void;
}

export interface Panel {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 활성 탭을 바꾼다. 닫혀 있어도 동작한다 — 다음 open() 이 이 탭으로 열린다. */
  setTab(tab: PanelTab): void;
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

/** 섹션 소제목 ("조작 민감도", "백업 코드" 같은 것). */
function createSectionTitle(text: string): HTMLParagraphElement {
  const title = document.createElement('p');
  title.textContent = text;
  Object.assign(title.style, {
    margin: '14px 0 0',
    color: COLOR_MUTED,
    font: '12px/1.4 system-ui, sans-serif',
  });
  return title;
}

/** 소제목 밑의 설명 한 줄. */
function createHint(text: string): HTMLParagraphElement {
  const hint = document.createElement('p');
  hint.textContent = text;
  Object.assign(hint.style, {
    margin: '2px 0 8px',
    color: COLOR_MUTED,
    font: '11px/1.45 system-ui, sans-serif',
  });
  return hint;
}

/** 설명서의 항목 하나: 왼쪽에 조작 이름, 오른쪽에 설명. */
function createManualRow(label: string, text: string): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    gap: '12px',
    padding: '9px 0',
    borderBottom: '1px solid rgba(207, 233, 245, 0.1)',
  });

  const name = document.createElement('span');
  name.textContent = label;
  Object.assign(name.style, {
    flex: '0 0 76px',
    color: COLOR_HIGHLIGHT,
    font: '600 13px/1.5 system-ui, sans-serif',
  });

  const body = document.createElement('span');
  body.textContent = text;
  Object.assign(body.style, {
    flex: '1 1 auto',
    color: COLOR_TEXT,
    font: '13px/1.5 system-ui, sans-serif',
  });

  row.append(name, body);
  return row;
}

/**
 * 패널을 만들어 host 에 붙인다. 처음에는 닫혀 있고, 활성 탭은 '기록'이다.
 *
 * 어떤 실패도 콘솔 에러로 새어나가지 않는다 (e2e 가 콘솔 에러 0 을 검사한다).
 * 사용자에게 필요한 것은 스택 트레이스가 아니라 "무엇이 잘못됐는지" 한 줄이다.
 */
export function mountPanel(host: HTMLElement, handlers: PanelHandlers): Panel {
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
  toggle.textContent = '메뉴';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', '메뉴 열기');
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
  backdrop.setAttribute('aria-label', '메뉴');
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
    marginBottom: '10px',
  });

  const title = document.createElement('h2');
  title.textContent = TAB_TITLES.stats;
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
  closeButton.setAttribute('aria-label', '메뉴 닫기');
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

  // ── 탭 바 ───────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', '메뉴 탭');
  Object.assign(tabBar.style, {
    display: 'flex',
    gap: '6px',
    marginBottom: '4px',
  });

  const tabButtons = new Map<PanelTab, HTMLButtonElement>();
  for (const tab of ['stats', 'settings', 'manual'] as const) {
    const button = document.createElement('button');
    button.id = `tab-${tab}`;
    button.type = 'button';
    button.textContent = TAB_TITLES[tab];
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    Object.assign(button.style, {
      flex: '1 1 0',
      minHeight: '34px',
      borderRadius: '9px',
      border: '1px solid rgba(207, 233, 245, 0.2)',
      background: 'rgba(207, 233, 245, 0.06)',
      color: COLOR_TEXT,
      font: '13px/1 system-ui, sans-serif',
      cursor: 'pointer',
    });
    tabButtons.set(tab, button);
    tabBar.append(button);
  }

  // ── 기록 탭 ─────────────────────────────────────────────────
  const statsSection = document.createElement('div');
  statsSection.id = 'section-stats';
  statsSection.setAttribute('role', 'tabpanel');
  statsSection.setAttribute('aria-label', '기록');

  const [rowRpm, valueRpm] = createStatRow('최고 RPM', 'bestRpm');
  const [rowRevolutions, valueRevolutions] = createStatRow('총 회전수', 'totalRevolutions');
  const [rowDuration, valueDuration] = createStatRow('최장 회전 시간', 'bestDurationMs');
  const [rowSessions, valueSessions] = createStatRow('세션 수', 'sessionCount');

  const backupTitle = createSectionTitle('백업 코드');
  const backupHint = createHint(
    '브라우저 저장소를 지우면 기록이 사라집니다. 코드를 따로 보관하세요.',
  );

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

  statsSection.append(
    rowRpm,
    rowRevolutions,
    rowDuration,
    rowSessions,
    backupTitle,
    backupHint,
    exportRow,
    exportCode,
    importCode,
    importButton,
  );

  // ── 설정 탭 ─────────────────────────────────────────────────
  const settingsSection = document.createElement('div');
  settingsSection.id = 'section-settings';
  settingsSection.setAttribute('role', 'tabpanel');
  settingsSection.setAttribute('aria-label', '설정');

  const sensitivityTitle = createSectionTitle('조작 민감도');
  sensitivityTitle.style.margin = '4px 0 0';
  const sensitivityHint = createHint(
    '낮추면 플릭이 약해지고 최고 회전 속도도 함께 낮아집니다. 다음 플릭부터 적용됩니다.',
  );

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
  settingsSection.append(sensitivityTitle, sensitivityHint, sensitivityRow);

  // ── 설명서 탭 ───────────────────────────────────────────────
  const manualSection = document.createElement('div');
  manualSection.id = 'section-manual';
  manualSection.setAttribute('role', 'tabpanel');
  manualSection.setAttribute('aria-label', '설명서');

  const manualIntro = createHint('손끝으로 돌리는 피젯 스피너입니다. 이렇게 조작하세요.');
  manualIntro.style.margin = '6px 0 0';

  manualSection.append(
    manualIntro,
    createManualRow('돌리기', '스피너를 손가락으로 빠르게 튕기세요. 연달아 튕기면 더 빨라집니다.'),
    createManualRow('브레이크', '도는 스피너를 꾹 누르고 있으면 긁히듯 느려집니다.'),
    createManualRow('즉시 정지', '화면을 빠르게 두 번 탭하면 그 자리에서 멈춥니다.'),
    createManualRow(
      '진동',
      '회전에 맞춰 딸깍이는 진동이 손에 전달됩니다. Android Chrome · 삼성 인터넷에서 지원됩니다.',
    ),
    createManualRow(
      '기록',
      '최고 RPM · 총 회전수가 자동으로 저장됩니다. 기록 탭의 백업 코드로 따로 보관할 수 있습니다.',
    ),
    createManualRow('민감도', '터치 반응이 너무 예민하거나 둔하면 설정 탭에서 조절하세요.'),
  );

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

  card.append(header, tabBar, statsSection, settingsSection, manualSection, message);
  backdrop.append(card);
  root.append(toggle, backdrop);
  host.append(root);

  // ── 동작 ────────────────────────────────────────────────────

  let opened = false;
  let activeTab: PanelTab = 'stats';
  let messageTimer = 0;

  const sections: Record<PanelTab, HTMLDivElement> = {
    stats: statsSection,
    settings: settingsSection,
    manual: manualSection,
  };

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

  /** 탭 버튼·본문·제목을 activeTab 하나에 맞춘다. 설명서가 보이게 되면 onManualViewed 를 알린다. */
  function paintTab(): void {
    title.textContent = TAB_TITLES[activeTab];
    for (const [tab, button] of tabButtons) {
      const active = tab === activeTab;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      Object.assign(button.style, {
        border: `1px solid ${active ? COLOR_LINE : 'rgba(207, 233, 245, 0.2)'}`,
        background: active ? 'rgba(57, 213, 255, 0.16)' : 'rgba(207, 233, 245, 0.06)',
        color: active ? COLOR_ACCENT : COLOR_TEXT,
      });
      sections[tab].style.display = active ? 'block' : 'none';
    }
  }

  function setTab(tab: PanelTab): void {
    if (tab === activeTab) {
      if (opened && tab === 'manual') handlers.onManualViewed?.();
      return;
    }
    activeTab = tab;
    paintTab();
    showMessage('', 'info'); // 탭이 바뀌면 이전 탭의 안내 문구는 맥락을 잃는다
    if (opened && tab === 'manual') handlers.onManualViewed?.();
  }

  function open(): void {
    if (opened) return;
    opened = true;
    backdrop.style.display = 'flex';
    backdrop.style.pointerEvents = 'auto';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.style.visibility = 'hidden';
    if (activeTab === 'manual') handlers.onManualViewed?.();
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

  function onTabBarClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    for (const [tab, button] of tabButtons) {
      if (button === target) {
        setTab(tab);
        return;
      }
    }
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
  tabBar.addEventListener('click', onTabBarClick);
  exportButton.addEventListener('click', onExportClick);
  copyButton.addEventListener('click', onCopyClick);
  importButton.addEventListener('click', onImportClick);
  sensitivitySlider.addEventListener('input', onSensitivityInput);

  const panel: Panel = {
    open,
    close,
    isOpen: (): boolean => opened,
    setTab,

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
      tabBar.removeEventListener('click', onTabBarClick);
      exportButton.removeEventListener('click', onExportClick);
      copyButton.removeEventListener('click', onCopyClick);
      importButton.removeEventListener('click', onImportClick);
      sensitivitySlider.removeEventListener('input', onSensitivityInput);
      root.remove();
    },
  };

  paintTab();
  panel.setAggregate(EMPTY_SPIN_AGGREGATE);
  panel.setSensitivity(FLICK_SENSITIVITY_DEFAULT);
  return panel;
}
