// 화면 전환을 History API 로 관리한다 (CLAUDE.md 8장 3번 — 안드로이드 뒤로가기 대응).
//
// **왜 필요한가**: TWA 로 감싸면 안드로이드 백버튼이 브라우저 뒤로가기가 된다. 통계 패널을
// 열어둔 채 백버튼을 누른 사용자가 기대하는 것은 "패널이 닫힌다"이지 "앱이 꺼진다"가 아니다.
//
// **왜 루트에서 히스토리를 쌓지 않는가**: 반대로, 아무것도 열려 있지 않은 상태의 백버튼은
// **앱 종료가 정상 동작**이다. 여기서 자리 채우기용 가짜 엔트리를 미리 push 해두면 사용자는
// 앱을 나가려고 백버튼을 두 번 눌러야 하고, 그건 Play Store 리뷰에서 그대로 지적되는 종류의
// 버그다. 그래서 엔트리는 화면을 **열 때만** 생기고 닫으면 반드시 사라진다.
//
// 이 파일은 ui/panel.ts 를 건드리지 않는다. 패널이 미리 뽑아둔 onOpenRequest / onCloseRequest
// 훅에 requestOpen / requestClose 를 꽂는 것으로 연결이 끝난다.

/** 히스토리 엔트리에 남기는 표식. 다른 상태와 섞이지 않도록 키를 하나만 쓴다. */
const STATE_KEY = 'screen';

/** 열고 닫을 수 있는 화면. ui 의 Panel 이 그대로 만족한다. */
export interface HistoryScreen {
  isOpen(): boolean;
  open(): void;
  close(): void;
}

/** 브라우저 전역 경계. 테스트에서 가짜 히스토리를 주입할 수 있도록 인터페이스로 받는다. */
export interface HistoryHost {
  readonly history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string): void;
    back(): void;
  };
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

export interface ScreenHistory {
  /** 화면을 연다. 히스토리 엔트리가 하나 생긴다. */
  requestOpen(): void;
  /** 화면을 닫는다. 우리가 만든 엔트리가 있으면 뒤로가기로 되돌린다. */
  requestClose(): void;
  dispose(): void;
}

/**
 * 화면 하나를 히스토리 엔트리 하나에 대응시킨다.
 *
 * `name` 은 엔트리에 남는 화면 이름이다. 새로고침 후에도 그 엔트리가 현재 위치라면 화면을
 * 다시 열어 히스토리와 화면 상태를 일치시킨다 — 어긋나 있으면 백버튼 한 번이 헛돌게 된다.
 */
export function attachScreenHistory(
  name: string,
  screen: HistoryScreen,
  host: HistoryHost = window,
): ScreenHistory {
  /** 지금 히스토리 위치가 이 화면의 엔트리인가. */
  function isAtScreenEntry(): boolean {
    const state = host.history.state;
    if (typeof state !== 'object' || state === null) return false;
    return (state as Record<string, unknown>)[STATE_KEY] === name;
  }

  /** 히스토리를 진실로 삼아 화면을 맞춘다. popstate 와 최초 진입에서 같은 함수를 쓴다. */
  function sync(): void {
    if (isAtScreenEntry()) screen.open();
    else screen.close();
  }

  function requestOpen(): void {
    if (screen.isOpen()) return;
    host.history.pushState({ [STATE_KEY]: name }, '');
    screen.open();
  }

  function requestClose(): void {
    if (!screen.isOpen()) return;
    // 우리가 push 한 엔트리 위에 서 있을 때만 back 한다. 그렇지 않은데 back 을 부르면
    // 앱 바깥(또는 TWA 종료)으로 나가버린다 — 닫기 버튼이 앱을 끄는 최악의 경우다.
    if (isAtScreenEntry()) host.history.back();
    else screen.close();
  }

  host.addEventListener('popstate', sync);
  sync();

  return {
    requestOpen,
    requestClose,
    dispose(): void {
      host.removeEventListener('popstate', sync);
    },
  };
}
