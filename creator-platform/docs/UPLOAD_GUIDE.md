# 다른 채팅에 올릴 파일 안내

이 폴더의 `project_handoff.json` 이 이전 채팅의 전체 내용(결정 사항, 구현 상태, 검증 결과, 미완료 항목)입니다.

## 가장 간단한 방법
- **`creator-platform-full.zip` 1개만 업로드**합니다. 압축 안에 `docs/project_handoff.json`, 전체 코드, Colab 노트북, 통계 스크립트가 들어 있습니다.

## 작업별로 필요한 파일만 올리려면

### A watermark_engine_work: 워터마크 엔진의 정확도/속도/강도 개선, 벤치마크
- docs/project_handoff.json
- worker/wmark/core.py
- worker/wmark/attacks.py
- worker/wmark/__init__.py
- worker/colab_bench.py
- worker/bench.py
- worker/server.py
- worker/requirements.txt
- (선택) worker/tests/test_core.py, worker/tests/test_server.py

### B backend_ts_work: 원장/구독/인증/미디어/배포 등 백엔드 작업
- docs/project_handoff.json
- package.json
- tsconfig.json
- tsconfig.build.json
- src/*.ts (24개 파일)
- test/*.ts (8개 파일)
- test/fixtures/photo.jpg
- 참고: node_modules는 올리지 말 것(npm install로 복원). 실제 워커 결합 테스트까지 하려면 시나리오 A의 worker 파일도 함께.

### C colab_results_analysis: Colab에서 새로 돌린 벤치마크 결과 분석
- docs/project_handoff.json
- watermark_results.csv
- results.jsonl
- fp.jsonl
- watermark_quality.csv
- 참고: 파일명에 (1) 같은 접미사가 붙어도 상관없음. 실행에 쓴 설정(STRENGTH, ATTACK_SET, N_IMAGES, N_DECOYS)도 메시지에 적어 줄 것.

### D statistics: 통계 검증/보고서
- docs/project_handoff.json
- results.jsonl
- fp.jsonl
- 참고: 분석 코드는 사용자가 선호하는 형식(데이터 문자열 내장)으로 받으려면 그렇게 요청. watermark_stats_check.py 를 올리면 같은 형식을 이어갈 수 있음.

### E planning_document: 기획안 수정/법률·규제 검토
- docs/project_handoff.json
- 기획안 Markdown 또는 Word(Claude Docs에서 내보내기)

### F colab_notebook_fix: 노트북 자체 수정
- docs/project_handoff.json
- watermark_benchmark_colab.ipynb
- 참고: 노트북에 엔진 소스가 임베드되어 있으므로 엔진을 바꾸면 노트북도 다시 생성해야 함.

## 올리지 말 것
- node_modules/
- dist/
- data/
- __pycache__/
- test_images/ (큰 이미지 폴더; 필요하면 몇 장만)
- 비밀키/.env 파일(실제 값)

## 새 채팅의 첫 메시지(붙여넣기)

첨부한 project_handoff.json 은 이전 채팅의 인수인계 문서입니다. 먼저 전체를 읽고, 'verified'와 'unverified'를 구분해서 현재 상태를 5줄 이내로 요약해 주세요. 그다음 todo_prioritized 의 1번부터 진행하되, 시작 전에 필요한 파일이 빠졌으면 알려 주세요. 규칙: (1) 한국어로 답한다. (2) 실행해서 확인하지 않은 것을 확인된 것처럼 말하지 않는다. (3) 코드를 수정하면 관련 테스트와 벤치마크를 다시 돌려 이전 결과와 직접 비교한다. (4) 내가 직접 실행할 파이썬 코드는 데이터를 코드 안에 문자열로 넣는 형식으로 쓴다.

## 꼭 알아둘 것
- 속도 개선된 새 엔진은 EasyPortrait 실데이터에서 아직 재측정하지 않았습니다. 가장 먼저 `watermark_benchmark_colab.ipynb` 를 Colab에서 실행해 결과를 올려 주세요.
- 기획안은 Claude Docs 문서입니다. 다른 채팅에서는 접근이 안 될 수 있으니 Markdown/Word로 내보내 올려 주세요.
- 비밀키가 들어 있는 실제 `.env` 파일은 올리지 마세요(`.env.example`만 포함되어 있습니다).