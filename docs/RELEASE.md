# RELEASE.md — TWA 빌드 · 서명 · Play Store 배포 절차

> Phase 7 기준 (2026-08-05). 이 문서가 없으면 AAB 빌드를 재현할 수 없다 — 갱신을 게을리하지 않는다.

## 산출물

| 파일 | 용도 |
|---|---|
| `twa/app-release-bundle.aab` | **Play Console 업로드용** (서명 완료) |
| `twa/app-release-signed.apk` | 실기기 직접 설치 테스트용 (같은 키로 서명) |

## 서명 키 (가장 중요)

- 파일: `twa/android.keystore` (alias `android`) + 비밀번호는 `twa/keystore-credentials.local.txt`
- **둘 다 git 에 없다** (`twa/.gitignore` 가 차단). **분실 = 앱 영구 업데이트 불가.**
- **백업 규칙: 리포지토리 밖 2곳 이상** (USB + 개인 클라우드 등). 백업했는지 릴리즈 전마다 확인한다.
- 이력: 2026-08-05 1차 키의 비밀번호가 빌드 로그에 노출되어 폐기, 2차 키로 재생성 (Play 등록 전이라 영향 없음)
- 업로드 키 SHA-256 지문 (assetlinks 에 들어간 값):
  `72:D6:C9:24:E7:9A:53:6D:75:DD:B8:3C:1C:92:F7:CA:78:28:90:EB:E4:2C:31:EC:82:E1:DA:9B:E4:4F:9D:FC`

## 빌드 절차 (이 머신 기준)

도구 위치: JDK 17 `~/.bubblewrap/jdk/jdk-17.0.11+9`, SDK `~/.bubblewrap/android_sdk/cmdline-tools`

```bash
cd twa
export BUBBLEWRAP_KEYSTORE_PASSWORD=<storepass>   # keystore-credentials.local.txt 참조
export BUBBLEWRAP_KEY_PASSWORD=<keypass>
bubblewrap update --skipVersionUpgrade   # twa-manifest.json 변경 시 (버전 올릴 땐 플래그 제거)
bubblewrap build --skipPwaValidation
```

bubblewrap build 의 마지막 AAB 서명(jarsigner)이 PATH 문제로 실패하면 수동 서명:

```bash
JDK=~/.bubblewrap/jdk/jdk-17.0.11+9/bin
"$JDK/jarsigner.exe" -sigalg SHA256withRSA -digestalg SHA-256 -keystore android.keystore \
  -storepass <PW> -keypass <PW> -signedjar app-release-bundle.aab \
  app/build/outputs/bundle/release/app-release.aab android
```

### 이 머신에만 있는 환경 우회 3가지 (빌드가 갑자기 깨지면 여기부터)

1. **cmd 가 현재 디렉토리에서 실행파일을 찾지 않는다** → 전역 bubblewrap 의
   `@bubblewrap/core/dist/lib/GradleWrapper.js` 를 gradlew.bat **절대 경로**를 쓰도록 로컬 패치함.
   bubblewrap 을 재설치/업데이트하면 패치가 사라진다 — 같은 수정을 다시 적용할 것.
2. **메모리 부족** (기본 힙 1.5GB 확보 실패) → `twa/gradle.properties` 끝에
   `org.gradle.jvmargs=-Xmx768m -XX:MaxMetaspaceSize=256m`, `org.gradle.daemon=false` 추가돼 있음.
3. **SDK 루트가 cmdline-tools 폴더라 AGP 가 platforms 를 못 찾는다** (루트가 자신을 패키지로 선언)
   → 표준 구조의 `~/.bubblewrap/android_sdk_root` 를 정션으로 구성하고 `twa/local.properties` 의
   `sdk.dir` 이 그곳을 가리킨다. 정션: platforms / build-tools / licenses / cmdline-tools\latest.

## assetlinks.json (도메인-앱 소유 증명)

- 위치: `public/.well-known/assetlinks.json` → 배포되면 `https://goldrocket-fidget-spinner.vercel.app/.well-known/assetlinks.json`
- 현재 **업로드 키 지문**만 들어 있다 (직접 설치 APK 테스트용으로 충분).
- **Play App Signing 등록 후 반드시 추가 작업**: Play Console → 설정 → 앱 무결성(App integrity)에서
  **앱 서명 키 인증서의 SHA-256** 을 복사해 `sha256_cert_fingerprints` 배열에 **추가**한다
  (교체가 아니라 추가 — 두 지문이 공존해야 로컬 테스트도 계속 된다). 추가 후 main 머지로 배포해야
  스토어 설치본에서 주소창이 사라진다.

## Play Console 제출 순서 (사용자 작업)

1. https://play.google.com/console 개발자 계정 등록 ($25, 1회)
2. 앱 만들기 → 앱 이름 `FIDGET SPINNER`, 기본 언어 한국어, 앱(게임), 무료
3. Play App Signing 동의 (기본값) → `twa/app-release-bundle.aab` 업로드
4. 앱 무결성 페이지에서 **앱 서명 키 SHA-256** 확인 → 위 assetlinks 갱신 작업 진행
5. 스토어 등록정보(설명·스크린샷·그래픽), 콘텐츠 등급 설문, 개인정보처리방침 URL 작성
6. 비공개 테스트 트랙에 출시 — 개인 계정은 **테스터 12명 × 14일** 요건 충족 후 프로덕션 신청 가능

## 버전 올리기

`twa/twa-manifest.json` 의 `appVersionCode` 를 +1 (정수, Play 는 같은 코드 재업로드 거부),
`appVersionName` 은 표시용. 수정 후 `bubblewrap update --skipVersionUpgrade` 없이
`bubblewrap update` 로 프롬프트에 새 버전을 주거나 twa-manifest.json 을 직접 고친 뒤 build.
