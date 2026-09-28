# EXT-HOSTING · AWS HTTPS 배포

상태: **in_progress**. 2026-09-29 사용자가 AWS 서울 리전과 월 10만 원 상한으로 시험 호스팅을 결정했다. 공개 도메인은 미정이다. AWS Organizations·Identity Center·예산 경고는 생성했으나, 유료 앱/DB 자원 생성·Zitadel HTTPS callback 등록·로그인/로그아웃/배포 시험은 **not_executed**다.

## 계정·배포 사전 확인

- 로컬 AWS CLI 2.34.29의 기본 리전은 자리표시자 `NEW_REGION`이라 명시적으로 `ap-northeast-2`를 지정한다. 사용자가 CLI 임시 로그인과 AWS Console 루트/MFA 로그인을 완료했다. 읽기 전용 조회에서 Route 53 hosted zone, RDS, EFS, ECR, ECS cluster는 없었고 기본 VPC만 확인했다. 루트에 장기 access key는 없다.
- 사용자 결정에 따라 AWS Organizations 전체 기능 조직 `o-8apkonua15`를 만들고, 콘솔에서 서울 **단일 리전 조직용** IAM Identity Center `ssoins-72308476c2cb0857`를 활성화했다. `sso-admin list-instances`에서 `ACTIVE`를 확인했다. 다중 리전 기본안의 추가 customer-managed KMS key 비용은 피했다. 사용자가 `peace.cheejecake`를 직접 추가했으며, AWS 콘솔에서 이 사용자에게 해당 AWS 계정의 `AdministratorAccess`(1시간 세션) 할당 완료 및 계정의 assigned users 목록을 확인했다. 초대 이메일에 따른 비밀번호 설정·MFA·비루트 로그인은 **not_executed**다.
- `workout-manager-test-monthly` AWS Budget은 **월 USD 60**으로 생성하고 실제 비용 50/80/100% 알림을 사용자 지정 이메일에 등록했다. AWS 조회에서 예산액·세 알림·100% 알림의 수신 주소를 확인했다. USD 60은 월 KRW 100,000 상한에 환율·세금 여유를 둔 운영 목표이며, Budget은 **경고이지 지출 차단이 아니다**. 유료 자원은 총비용 견적을 검증한 뒤 만든다.
- AWS는 App Runner를 신규 고객에게 닫고 ECS Express Mode를 권장한다. ECS Express Mode는 기본 HTTPS 주소를 제공하므로 사용자 소유 도메인 없이 시험 주소를 만들 수 있다. 실제 계정의 사용 가능 여부와 비용은 확인 전이다.
- 월 상한의 잠정 후보는 서울 Lightsail IPv4 8 GiB 인스턴스에 웹·API·worker·전국 경로 엔진·PostgreSQL을 함께 올리고, 별도 비공개 백업 버킷을 쓰는 방식이다. 공식 요금표의 인스턴스 $44, 100 GB 버킷 $3, Secrets Manager 2개 약 $0.80, Route 53 hosted zone 사용 시 $0.50에 스냅샷 저장량 160 GB를 **예시로** $8로 잡으면 월 약 $56.30이다. 이는 **상한이 아닌 조건부 예시**다. 도메인 등록·DNS 질의·초과 전송·추가 스냅샷 변경 블록·세금·환율이 더해지며, 월 10만 원 이하 청구를 아직 증명하지 못했다. 로컬 전국 graph 308 MB, basemap 97 MB와 경로 엔진 peak RSS 1,391 MiB는 확인했지만 전체 프로세스 동시 메모리와 운영 백업 크기는 미측정이다. 단일 서버의 장애 복구·백업 복원과 삭제 억제 보존을 검증해야 한다. Lightsail의 일반 service role 부재 때문에 서버가 Secrets Manager를 무자격증명으로 직접 읽는 설계는 쓰지 않는다. 단기 배포 신원으로 읽어 제한된 서버 환경 파일에 전달하는 방식은 비밀 회전·권한·운영 수용 기준을 별도 확인해야 한다.
- 현재 API는 개발용 TypeScript 실행만 제공했다. 이 phase의 배포 준비 변경은 API를 Node 24 실행용 JavaScript로 번들링하고, 웹과 loopback API를 단일 컨테이너에서 기동하며 별도 private resource mountpoint가 없으면 시작을 거부한다. mountpoint 확인만으로 영속성을 증명하지 않는다. ECS 서비스에 EFS 또는 동등한 영속 저장소를 연결하고 재시작 후 같은 객체를 읽는 검증은 외부 수용 조건이다. 웹 프로세스에는 명시한 환경 변수만 전달하여 API의 DB 접속 문자열과 OIDC secret을 제외한다. 컨테이너 healthcheck는 API·웹 응답과 PostgreSQL `SELECT 1`을 모두 요구하며 오류 세부 정보를 출력하지 않는다. 잠금 파일 고정 설치, contracts/API/Web 빌드, 설정 누락 시 종료, lint·format·diff 검사는 통과했다. Docker daemon을 사용할 수 없어 **이미지 빌드·컨테이너 내부 실행은 not_executed**다.

## ODbL 산출물 로컬 재빌드

- 기존 배포·rollback 포인터는 건드리지 않았다. 전국 extract `osm-extract-south-korea`를 허용 목록에서 새 root로 받아 286,403,403 byte와 pin SHA-256 `848daadc56b2c2a808b30b2778f834c2802097ab382805c9fd42f248f4d6284b`를 확인했다. 취득 기록에는 HTTP 200과 Last-Modified `2026-09-02 05:13:33 GMT`가 남았다.
- 새 전국 graph는 `.geo-build-routing/kr-260929-odbl/foot`, build ID `c41b48d128fee2d5`, content SHA-256 `c3cb95d62b6972047397ae7940568bbf245afb6daf354268201193807e6e587f`다. 새 배경 지도는 `.geo-build-basemap-kr-260929-odbl/dist/ebe407d9dcbe-muldszzf`, build ID `ebe407d9dcbe`, 4,817 tiles다. 배경은 현재 스크립트의 서울 extract를 사용했고 동일 SHA의 기존 PBF와 앞선 build report의 취득 기록을 재사용했다.
- `scripts/check-odbl-artifacts.mts`를 두 새 root에 대해 실행해 basemap·graph 모두 `passed: true`를 확인했다. 이는 **로컬 산출물 검사**이며 공개 HTTPS 응답·활성 manifest·실제 서빙·coverage 판정이 아니다. 로컬 artifact root는 Git 제외 상태이고 배포 경로가 정해질 때 이동·보존 방식을 결정한다.

## 남은 외부 수용

1. 관리자 Identity Center 초대·권한·로그인을 완료하고, 서울 리전의 실제 자원·월 총비용을 확인한다. ECS Express Mode 또는 예산에 맞는 대안, PostgreSQL·영속 저장소·secret manager의 설계와 접근 권한을 검증한다. 별도 mountpoint 검사와 실제 영속성은 구분하고, 배포 후 컨테이너 재시작을 거쳐 같은 private resource 객체를 다시 읽어 증명한다.
2. 이미지 빌드·실행을 확인하고 위 새 ODbL 산출물만 배포한다. 공개 `/map-data-licence`와 script 응답 바이트를 활성 manifest SHA-256에 대조한다.
3. HTTPS origin을 Zitadel redirect·post-logout·back-channel 설정에 등록한다. `NODE_ENV=production`, secure `__Host-` cookie, secret manager 주입과 배포 환경의 로그인·계정 전환·로그아웃·취소·만료·back-channel 전파를 각각 확인한다.

참고: [AWS App Runner 신규 고객 제한](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html), [ECS Express Mode 기본 HTTPS 주소](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-getting-started.html), [Lightsail 요금](https://aws.amazon.com/lightsail/pricing/), [Secrets Manager 요금](https://aws.amazon.com/secrets-manager/pricing/), [Route 53 요금](https://aws.amazon.com/route53/pricing/), [Lightsail 스냅샷 과금](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html), [Lightsail IAM 범위](https://docs.aws.amazon.com/lightsail/latest/userguide/security_iam_service-with-iam.html).
