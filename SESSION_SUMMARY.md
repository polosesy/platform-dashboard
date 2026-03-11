# SESSION_SUMMARY — Azure Unified Dashboard

> 각 기능 단위 세션 종료 후 업데이트. `/status` 명령으로 확인.
> 상세 패턴 참조: `.claude/skills/live-diagram.md`, `.claude/skills/session-workflow.md`

---

## Last Updated

- Date: 2026-03-11
- Feature: CLAUDE.md / skill.md 구조 개선 + 토큰 최적화
- Session Length: ~5턴

---

## Completed Features (Recent)

| Date | Feature | Files Changed |
|------|---------|---------------|
| 2026-03-11 | 프로젝트 설정 구조 개선 (CLAUDE.md, skill.md, skills/, SESSION_SUMMARY, hooks) | CLAUDE.md, skill.md, .claude/skills/*, .claude/settings.local.json |
| 2026-03-11 | VMSS 인스턴스 확장 — 디자인/클릭/드래그 완성 | LiveCanvas, VmssInstanceNode, ResourceDetailPanel, styles.module.css |
| 2026-03-09 | VNet region badge + 리소스 검색 + BackendPool UI | GroupNode, page.tsx, styles.module.css, i18n.tsx |
| 2026-03-09 | Multi-select VNet/Region 필터 + compact layout | LiveCanvas, specGenerator, styles.module.css |
| 2026-03-06 | NSG badge GroupNode 이동 + VNet/Subnet 겹침 수정 | GroupNode, LiveNode, NsgBadgeNode, specGenerator |

---

## Active Domain State

| Domain | Status | Notes |
|--------|--------|-------|
| Live Diagram | Active | VMSS 인스턴스 확장 완성. 다음: 추가 기능 TBD |
| Health | Stable | AbortError 수정 완료 (60s per-page timeout) |
| Cost | Pending | 미구현 |
| Security | Pending | NSG 시각화는 Live Diagram에 통합됨 |
| Governance | Pending | 미구현 |

---

## Known Issues / Next Steps

- [ ] 다음 기능 단위 작업 시 이 파일 업데이트 후 세션 시작
- [ ] Cost 도메인 구현 (신규 세션에서 시작 권장)
