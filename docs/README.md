# 문서 구조

```
docs/
├── getting-started/              # 초기 설정 및 Azure 연동
│   ├── setup-guide.md            # 퀵 스타트, 환경변수, 빌드, 배포
│   └── azure-integration-guide.md # Azure AD, RBAC, OBO, 도메인별 API
│
├── architecture/                 # 아키텍처 및 참조
│   └── GLOSSARY.md               # 프로젝트 용어집 (Canvas, Badge, Azure, K8s)
│
├── observability/                # Observability 도메인
│   ├── instrumentation-guide.md  # AKS 메트릭/로그 계측, 수집 경로
│   ├── hubble-guide.md           # Hubble 네트워크 관측 가이드
│   └── hubble-troubleshooting.md # Hubble 에러 케이스 + 진단 명령어
│
└── troubleshooting/              # 에러/버그 통합 문서
    └── error-catalog.md          # 도메인별 에러 카탈로그 (HUB, OBS, AUTH, K8S, FE)
```

## 문서 작성 규칙

1. **도메인별 폴더**에 가이드 문서를 배치
2. **에러 발생 시** `troubleshooting/error-catalog.md`에 `[도메인]-[번호]` 형식으로 추가
3. 도메인별 상세 트러블슈팅이 필요하면 해당 폴더에 `*-troubleshooting.md` 생성
4. 문서 언어: 한국어 (코드/명령어는 영어)
