# Linux ARM64 Gallery codec image recipe

이 디렉터리는 고정된 공개 입력으로 Gallery codec 이미지를 만드는 source-only recipe다. Dockerfile과 안전 압축 해제 helper는 실제 v4 Linux 빌드에 사용한 입력 바이트를 유지한다. 아카이브, npm 캐시, 확장된 node_modules, emitted JS, context, image/id/result 파일은 이 디렉터리에 넣거나 커밋하지 않는다.

고정된 실제 v4 historical image는 `sha256:8cdca45bfe22b05adfd774acb3f28c7c31725772177e6d56145e85b23bd64658`다. 같은 입력 바이트를 재구성하는 것은 새 빌드 이미지의 bit-identical 결과를 보장하거나 현재 배포 image를 등록하는 행위가 아니다. Root actual AV1/H264/PNG technicalpass와 imageCmd absent-only inventory 관측은 별도 역사 증거이며 policy/cgroup admission/worker 권한이 아니다.

파일은 Dockerfile, unpack-tools.py, build-inputs.json, npm-pins.json, materialize.py, README.md 여섯 개다. root-owned registry/workflow/패키지 script wiring과 image 설정은 이 recipe가 변경하지 않는다. `byte-check.json` 같은 실행 기록은 외부 TMP 산출물로 남긴다.

## Historical v4 입력 검증 범위

- Dockerfile SHA aa34b10ddcf40765ee88bf34b2d117d20ba7029be347a08acd26d27c12ac374f — 성공 v4 bytes 그대로.
- unpack-tools.py f50a3c10b463239e9ce84d7832d14a41b32ec1a8cf679767d61aaa036cc269b8 — 성공 v4 bytes 그대로.
- build-inputs.json f22628dba3871f31006a2b8867f7cb26a06876e8ab27aee8938b67c326fd62ad
- npm-pins.json fcdd2025664532eac78563b9fc332839481c86787b4c95fb22c422da70aff9a4
- materialize.py 76622a076432413c3e8d594a082746dfe873ef632cb440e1e245e9d00f89d7c8
- byte-check.json 483da677f49a6c6decbbf25711d1c0df451ed4b53305bcdf8136de62129ea550

통합 전 TMP recipe에서 실제 offline materializer exit0 (150files), verify-reference exit0을 확인했다. 이 기록은 해당 입력에서의 역사 검증이다. `/private/tmp/wm-gallery-codec-context-durable-check-20261009`의 전체 file roster/bytesSHA가 v4 `/private/tmp/wm-gallery-linux-dav1d-context-v4-20261009/context` 150개와 exact동일. PythonASTsyntax0. 다운로드/설치/패키지 lifecycle scripts/native codec/Docker 실행0. 원v4 150입력 불변.

## 입력 분류

1. **공개 소스/바이너리 artifacts(외부 cache, commit0)**: FFmpeg9.0.2 tar+asc+officialkey, immutablex264 archive, Node24.12 ARM64 tar, dav1d1.5.4 tar, Meson1.9.2 source+wheel, Ninja1.13.1 ARM64 zip+immutableCOPYING. build-inputs150파일 allowlist에 모든 exact bytesSHA, dav1d/Meson/Ninja officialURL metadata도 수록. 실제 downloads hashverified된 캐시만 preflight하며 소스 signer verification이 binary hash proof와 혼동되지 않는다.
2. **고정 registry packages6(캐시/expanded outputs commit0)**: sharp0.35.4, @img/colour1.1.0, detect-libc2.1.2, semver7.8.5, @img/sharp-linux-arm640.35.4, @img/sharp-libvips-linux-arm641.3.3. npm-pins는 lock의 exact SRIsha512+version+공식URL. Materializer는 0.tgz..5.tgz ordered6cache 각각 SRI독립 검증, safe manual TAR extraction(no links/traversal/duplicate, finite count/expanded budget), actual package name/version/directdependency roster 검증. 실제 동일 expanded node_modules143원자료+서버source outputs를 포함한 final150 bytes는 independent expectedSHA로 다시 전수검증. floatingnpm/pnpm install 없이 Linux optional nativefiles도 exact포함.
3. **현 repo allowlisted runtime inputs**: entry/input/output3MJS; `packages/server/media/dist/gallery-codec` emitted3JS; narrowtsconfig; exact pnpm-lock snapshot. `pnpm exec tsc -p deploy/gallery-codec/tsconfig.codec.json`으로 생성된 emitted outputs 자체는 generated이며 commit0. Materializer는 repo전체복사 안함, manifest sourceMap8개만 hash검증/복사. 새로운 runtime source/lock 변경은 Root의 검증 후 manifest 갱신이 필요하며 임의 현재bytes를 권한으로 채택하지 않는다.
4. **public notices/build provenance**: Node LICENSE, FFmpeg GPLv2+x264 COPYING, dav1dBSD2 COPYING, Meson/Ninja COPYING, 각 archive source image내보존. Existing GPL configure/staticx264+newstaticPICdav1d config/binarysha/buildversion도 이미지 `/usr/share/gallery-codec/build` 보존. `source-verification.json`은 실제 기존publicdownload/FFmpegPGP 검증기록이며 Root가 별도 exacthash path를 공급. pnpm-lock/tsconfig는 source/not binary 산출물. Inline checksum/packageJSON은 original동일 canonical bytes.

## Root offline workflow

외부 download/verification 단계는 별도다. Context materializer는 네트워크나Docker를 호출하지 않는다. 각 artifact actual bytes/hash와 npm exactSRI가 맞는 공개cache 준비 후, narrow TypeScript emit과 source핀을 검증한다. 공통 deps/install/build은 Root의 별도 승인 lane; 이 후보 script는 설치하지 않는다.

```
python3 deploy/gallery-codec/image-build/materialize.py materialize \
 --repo ABSOLUTE_REPO \
 --artifacts VERIFIED_PUBLIC_ARTIFACT_DIR \
 --source-verification VERIFIED_PUBLIC_SOURCE_RECORD_JSON \
 --npm-cache VERIFIED_NPM_6_TARBALL_CACHE \
 --output /private/tmp/wm-gallery-codec-context-UNIQUE_RUN
python3 deploy/gallery-codec/image-build/materialize.py verify-reference /private/tmp/wm-gallery-codec-context-UNIQUE_RUN
```

output는 fresh immediate child of `/private/tmp`이며 wm-gallery-codec-context- prefix; exists/symlink/source mismatch failclosed, no adopting/overwrite. 모든 inputs검증 후 exclusive0700 output 생성. 실패 partial output은 ownedpath로 보존, 임의 자동삭제0. source cache 및 원 repository inputs untouched. `.env`/credentials/privatefixture/whole repo context없음.

Root가 freeze/filehash/imageinputs를 읽은 뒤 별도 실행:

```
docker build --platform linux/arm64 --network none --progress plain --iidfile OWN_NEW_IID_PATH OWN_CONTEXT
```

GCC14.3 immutable66035.../Debianbookworm a1b86... digests 그대로. Python3.11.2는 Root actual base 관측, Meson1.9.2와 Ninja1.13.1 native 실제 v4 build 성공 근거; inspect만으로 제조하지 않는다. nativechild PYTHONPATH propagation2prefix 포함. tar safetyhelper/count/bytes/type/rootguards 원v4같음. 마지막 USER20001 nativeimport/version/libdav1d listed RUN 보존. HostTMPprivatepermissions 유지, imagecode-readable perms만 정규화.

## 권한과 후속 수용 경계

actualbinary/buildSHA/newimageID 등록과 technicalPNG/H264/AV1 original/sourceObservation/outputframe semantic verification, fixed loader/FD/no-network/nonroot/sourceprepost/ownedcleanup은 Root 실제 증거로 연결. Docker Engine V2 recipe labels/limits/namespace/knownhardening/cgroup-roottrusted emptydescendants는 별도 currentpolicy gate. 이 recipe의 buildexit0 또는 technicalcodec 성공만으로 OS totalmemory/CPU/disk/network/termination/workerDBlease/CAS/sourceaccess/deletion/export/restore/admission을 완료하지 않는다. 최종 실기기는 actual org.workoutmanager.app 별도 마지막수용, 이번 기기0.
