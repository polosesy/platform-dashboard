#!/usr/bin/env bash
# =============================================================================
# gp.sh — Git commit + push automation (token-efficient)
# Usage:
#   ./scripts/gp.sh "feat: message"          — commit all staged+modified + push
#   ./scripts/gp.sh                           — auto-generate commit message
#   ./scripts/gp.sh --status                  — show compact status only (no commit)
#   ./scripts/gp.sh --dry-run "feat: message" — preview without executing
#   ./scripts/gp.sh --files "f1 f2" "message" — commit specific files only
# =============================================================================
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# ── Parse args ────────────────────────────────────────────────────────────────
DRY_RUN=false
STATUS_ONLY=false
SPECIFIC_FILES=""
COMMIT_MSG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=true;  shift ;;
    --status)   STATUS_ONLY=true; shift ;;
    --files)    SPECIFIC_FILES="$2"; shift 2 ;;
    *)          COMMIT_MSG="$1"; shift ;;
  esac
done

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; RESET='\033[0m'; BOLD='\033[1m'

# ── Status summary ────────────────────────────────────────────────────────────
print_status() {
  local branch
  branch="$(git branch --show-current)"
  local ahead behind
  ahead=$(git rev-list --count "origin/${branch}..HEAD" 2>/dev/null || echo "?")
  behind=$(git rev-list --count "HEAD..origin/${branch}" 2>/dev/null || echo "?")

  echo -e "\n${BOLD}── Status ──────────────────────────────────────${RESET}"
  echo -e "  Branch : ${CYAN}${branch}${RESET}  (↑${ahead} ahead, ↓${behind} behind)"
  echo -e "\n${BOLD}  Modified files:${RESET}"

  local staged
  staged=$(git diff --name-only --cached 2>/dev/null)
  if [[ -n "$staged" ]]; then
    echo -e "  ${GREEN}[staged]${RESET}"
    echo "$staged" | while read -r f; do echo -e "    ${GREEN}+${RESET} $f"; done
  fi

  local modified
  modified=$(git diff --name-only 2>/dev/null)
  if [[ -n "$modified" ]]; then
    echo -e "  ${YELLOW}[modified]${RESET}"
    echo "$modified" | while read -r f; do echo -e "    ${YELLOW}~${RESET} $f"; done
  fi

  local untracked
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null | grep -v "^\.claude/" || true)
  if [[ -n "$untracked" ]]; then
    echo -e "  ${BLUE}[untracked]${RESET}"
    echo "$untracked" | while read -r f; do echo -e "    ${BLUE}?${RESET} $f"; done
  fi

  echo -e "\n${BOLD}  Diff stat:${RESET}"
  git diff --stat HEAD 2>/dev/null | tail -5 | while read -r line; do
    echo "  $line"
  done
  echo -e "${BOLD}────────────────────────────────────────────────${RESET}\n"
}

# ── Auto-generate commit message from diff ────────────────────────────────────
auto_commit_msg() {
  local files_changed
  files_changed=$(git diff --name-only HEAD 2>/dev/null | head -20)

  local scope=""
  if echo "$files_changed" | grep -q "apps/web"; then scope="web"; fi
  if echo "$files_changed" | grep -q "apps/api"; then
    scope="${scope:+$scope,}api"
  fi
  if echo "$files_changed" | grep -q "packages/types"; then
    scope="${scope:+$scope,}types"
  fi
  scope="${scope:-app}"

  local type="feat"
  if echo "$files_changed" | grep -qE "\.(test|spec)\.(ts|tsx)$"; then type="test"; fi
  if echo "$files_changed" | grep -qE "styles?\.module\.css$"; then type="style"; fi

  local n_files
  n_files=$(echo "$files_changed" | grep -c . 2>/dev/null || echo "0")

  local names
  names=$(echo "$files_changed" | xargs -I{} basename {} 2>/dev/null | sort -u | head -5 | tr '\n' ', ' | sed 's/,$//')

  echo "${type}(${scope}): update ${names} [${n_files} files]"
}

# ── Stage files (only called when NOT dry-run) ────────────────────────────────
stage_files() {
  if [[ -n "$SPECIFIC_FILES" ]]; then
    echo -e "${CYAN}Staging specific files:${RESET} $SPECIFIC_FILES"
    # shellcheck disable=SC2086
    git add $SPECIFIC_FILES
  else
    # Stage all tracked modified files
    git add --update
    # Stage untracked files — exclude .env/secrets/.claude
    local untracked
    untracked=$(git ls-files --others --exclude-standard \
      | grep -vE "(^\.claude/|\.env$|\.env\.|secrets|credentials|\.pem$|\.key$)" || true)
    if [[ -n "$untracked" ]]; then
      echo "$untracked" | xargs git add
    fi
    echo -e "${CYAN}Staged all modified + untracked files${RESET} (excluded: .claude, .env, secrets)"
  fi
}

# =============================================================================
# Main
# =============================================================================
print_status

[[ "$STATUS_ONLY" == true ]] && exit 0

# ── Dry-run: just preview ─────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  if [[ -z "$COMMIT_MSG" ]]; then
    COMMIT_MSG=$(auto_commit_msg)
    echo -e "${CYAN}Auto-generated message:${RESET} ${COMMIT_MSG}"
  fi
  BRANCH=$(git branch --show-current)
  echo -e "\n${BOLD}── Dry-run Preview ──────────────────────────────${RESET}"
  echo -e "  Message : ${GREEN}${COMMIT_MSG}${RESET}"
  echo -e "  Branch  : ${CYAN}${BRANCH}${RESET}"
  echo -e "  ${YELLOW}[dry-run] No changes will be made${RESET}"
  echo -e "  Would run: git add [files] && git commit -m '...' && git push origin ${BRANCH}"
  echo -e "${BOLD}────────────────────────────────────────────────${RESET}\n"
  exit 0
fi

# ── Nothing to commit check ───────────────────────────────────────────────────
if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
  echo -e "${YELLOW}Nothing to commit. Working tree is clean.${RESET}"
  BRANCH=$(git branch --show-current)
  AHEAD=$(git rev-list --count "origin/${BRANCH}..HEAD" 2>/dev/null || echo "0")
  if [[ "$AHEAD" -gt 0 ]]; then
    echo -e "${CYAN}Pushing ${AHEAD} unpushed commit(s)...${RESET}"
    git push origin "${BRANCH}"
    echo -e "${GREEN}Pushed.${RESET}"
  fi
  exit 0
fi

# ── Stage ────────────────────────────────────────────────────────────────────
stage_files

# ── Auto-generate message if not provided ────────────────────────────────────
if [[ -z "$COMMIT_MSG" ]]; then
  COMMIT_MSG=$(auto_commit_msg)
  echo -e "${CYAN}Auto-generated message:${RESET} ${COMMIT_MSG}"
fi

BRANCH=$(git branch --show-current)

echo -e "\n${BOLD}── Commit ───────────────────────────────────────${RESET}"
echo -e "  Message : ${GREEN}${COMMIT_MSG}${RESET}"
echo -e "  Branch  : ${CYAN}${BRANCH}${RESET}"
echo -e "${BOLD}────────────────────────────────────────────────${RESET}\n"

# ── Commit ───────────────────────────────────────────────────────────────────
FULL_MSG="${COMMIT_MSG}

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git commit -m "$FULL_MSG"

# ── Push ─────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Pushing to origin/${BRANCH}...${RESET}"
git push origin "${BRANCH}"

echo -e "\n${GREEN}${BOLD}Done.${RESET} Committed and pushed to ${CYAN}origin/${BRANCH}${RESET}\n"
