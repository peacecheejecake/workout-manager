# v0.2.2 보완 근거와 출처 범위

확인일: 2026-09-15. Breakpoint·화면·API·데이터 모델과 우선순위는 이 제품의 설계 결정이며 외부 표준의 숫자라고 주장하지 않는다. 기존 `sources.md`는 보존하며 이번에 전체 재검증하지 않았다.

<a id="r01"></a>
## R01 · W3C — Reflow

https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

일반 콘텐츠의 320 CSS px 상당 reflow와 본질적인 2차원 콘텐츠의 예외를 참고한다. 우리 앱의 접근성 적합성은 별도 실제 검사 대상이다.

<a id="r02"></a>
## R02 · MDN — CSS container queries

https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries

Viewport와 component container 반응형을 나누는 기능적 근거. 특정 WebView/라이브러리 조합의 지원 검증을 이번에 수행한 것은 아니다.

<a id="r03"></a>
## R03 · W3C — Target Size (Minimum)

https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

AA 최소 기준과 예외를 참고한다. 제품의 주요 action 44×44 목표는 별도 선택이며 전체 WCAG 인증 주장과 다르다.

<a id="r04"></a>
## R04 · W3C — Dragging Movements

https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html

Drag 없이 같은 기능을 single pointer로 수행하는 대안을 요구하는 기준. 키보드 대안만으로 대체하지 않는다.

<a id="r05"></a>
## R05 · AND / DC / ACSM — Nutrition and Athletic Performance (2016)

https://pubmed.ncbi.nlm.nih.gov/26891166/
https://pubmed.ncbi.nlm.nih.gov/26920240/

원 학회 공동 position statement의 서지·검색 초록을 참고했다. 개인 영양 계획의 전문 검토 필요성을 검토할 자료이며, 이번 설계에서 본문 전체의 처방표·숫자를 추출하거나 최신 종합 가이드라고 확정하지 않았다. 실제 tip·target 규칙을 배포하기 전 원문·최신 근거와 검토자를 확정한다.

<a id="r06"></a>
## R06 · IOC — Relative Energy Deficiency in Sport consensus (2023)

https://pubmed.ncbi.nlm.nih.gov/37752011/
https://bjsm.bmj.com/content/57/17/1073

서지·검색 초록을 참고했다. 출판사 본문은 이번 조회에서 접근이 차단되어 전체 내용을 검토했다고 하지 않는다. REDs를 식사 앱의 단순 점수로 자동 진단하지 않는 제품 경계에 관련된 검토 자료다. 임상 판정식·개인 처방·효과 크기는 이번에 구현하지 않는다.

## 제품 문서 확인 범위

이 대화에 첨부된 v0.2의 01/03/contracts와 최신 v0.2.1의 05/06을 읽고, 배포 ZIP의 해당 파일을 기준으로 개정했다. 기존 02·04 설계는 관련 통합 경계를 유지하며 명시적인 추가 절을 붙였다. 실제 GitHub 코드·외부 승인 상태·사용자 건강 원본은 확인하지 않았다.
