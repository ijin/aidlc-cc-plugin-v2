#!/usr/bin/env bash
# tag-release.sh — Mint an annotated release tag for this plugin.
#
# Tag scheme:  v<package.json version>+up.<upstream short SHA>
#   e.g.       v2.0.0-alpha.1+up.392d576
#
# The `+up.<short>` suffix is SemVer build metadata: a human-readable PROVENANCE
# LABEL showing which upstream snapshot this release was built from. It is NOT
# version identity — SemVer ignores build metadata for precedence, so two releases
# must NEVER differ only after the `+`. Always bump the alpha.N in package.json
# (and marketplace.json) for a new release.
#
# Guardrails (per design review):
#   - ANNOTATED tag (-a), so it carries a message and a tagger — lightweight tags
#     have neither and are easy to clobber.
#   - The FULL 40-char upstream SHA + src tree hash go in the tag MESSAGE, so the
#     immutable, unambiguous pin travels with the tag (the short hash in the name
#     is only a label).
#   - Refuses to tag a dirty worktree or re-tag an existing version.
#   - Reminder to push with --follow-tags and to PROTECT the tag on the remote
#     (git tags are not inherently immutable; protect them in the forge).
#
# Usage:  targets/claude/tag-release.sh [--push]
#   Reads the version from package.json and the upstream pin from UPSTREAM.lock.
#   --push  also pushes the tag (git push origin <tag>); otherwise prints the cmd.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="$ROOT/UPSTREAM.lock"
PKG="$ROOT/package.json"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v git >/dev/null || die "git not found on PATH"
command -v node >/dev/null || die "node not found on PATH"
[ -f "$LOCK" ] || die "missing $LOCK"
[ -f "$PKG" ] || die "missing $PKG"

PUSH=""
[ "${1:-}" = "--push" ] && PUSH=1

# Version is single-sourced from package.json (build.mjs already asserts
# marketplace.json agrees — run the build first if unsure).
VERSION="$(node -e "process.stdout.write(require('$PKG').version)")"
[ -n "$VERSION" ] || die "could not read version from package.json"

get() { grep -E "^$1=" "$LOCK" | head -1 | cut -d= -f2-; }
FULL_SHA="$(get UPSTREAM_SHA)"
TREE_HASH="$(get UPSTREAM_SRC_TREE_HASH)"
UP_REPO="$(get UPSTREAM_REPO)"
UP_BRANCH="$(get UPSTREAM_BRANCH)"
UP_DATE="$(get UPSTREAM_DATE)"
[ -n "$FULL_SHA" ] || die "UPSTREAM_SHA not set in lock"
[ -n "$TREE_HASH" ] || die "UPSTREAM_SRC_TREE_HASH not set in lock — re-run sync-upstream.sh to record it before tagging"
SHORT_SHA="${FULL_SHA:0:7}"

TAG="v${VERSION}+up.${SHORT_SHA}"

# Refuse a dirty worktree — a release tag must point at a clean, reproducible state.
# --porcelain catches untracked files too (a plain diff would not).
[ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] ||
  die "worktree has uncommitted/untracked changes; commit them before tagging a release"

# Provenance integrity: the COMMITTED src/ must actually equal the lock's tree
# hash. Otherwise a bad committed lock would mint a tag asserting false
# provenance. HEAD:src is the committed release tree — compare it to the lock.
COMMITTED_SRC="$(git -C "$ROOT" rev-parse "HEAD:$( [ -n "$(get UPSTREAM_SUBDIR)" ] && get UPSTREAM_SUBDIR || echo src )" 2>/dev/null)" ||
  die "could not resolve HEAD:src — is src/ committed?"
[ "$COMMITTED_SRC" = "$TREE_HASH" ] ||
  die "committed src/ tree ($COMMITTED_SRC) != UPSTREAM.lock UPSTREAM_SRC_TREE_HASH ($TREE_HASH). The lock and the committed source disagree — re-run sync-upstream.sh and commit before tagging."

# Refuse to clobber an existing tag for this exact name.
if git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag '$TAG' already exists. Bump the version in package.json (+ marketplace.json) for a new release."
fi
# Refuse to reuse a version that already shipped under a different upstream short
# SHA (build metadata is not identity — same version, different + is forbidden).
# Fetch tags first so this guard sees REMOTE tags, not just local ones (a fresh
# clone may not have them). For a PUBLISH (--push), authoritative tag state is
# mandatory — a failed fetch is FATAL, because publishing without it could mint a
# duplicate SemVer core under different +up metadata. For a local-only tag, a fetch
# failure (e.g. offline) only warns; the tag isn't public yet.
if ! git -C "$ROOT" fetch --tags --quiet 2>/dev/null; then
  if [ -n "$PUSH" ]; then
    die "could not fetch remote tags; refusing to --push without authoritative tag state (a duplicate version could slip through). Resolve connectivity and retry."
  fi
  echo "  (warning: could not fetch remote tags; version-reuse guard sees local tags only — safe because this is a local tag, not a push)"
fi
EXISTING="$(git -C "$ROOT" tag --list "v${VERSION}+up.*" | head -1)"
[ -z "$EXISTING" ] || die "version $VERSION already released as '$EXISTING'. Build metadata is not identity — bump alpha.N instead of re-releasing the same version."

MSG="$(cat <<EOF
aidlc-v2 ${VERSION}

Upstream provenance (the real, immutable pin — the short hash in the tag name is only a label):
  repo:       ${UP_REPO}
  branch:     ${UP_BRANCH}
  commit:     ${FULL_SHA}
  src tree:   ${TREE_HASH}
  commit date:${UP_DATE}

Built by targets/claude/build.mjs from the vendored src/ at the commit above.
EOF
)"

echo "==> Tagging $TAG (annotated)"
git -C "$ROOT" tag -a "$TAG" -m "$MSG"
echo "    tagged at $(git -C "$ROOT" rev-parse --short HEAD)"

if [ -n "$PUSH" ]; then
  echo "==> Pushing $TAG"
  git -C "$ROOT" push origin "$TAG"
else
  echo "==> Not pushed. To publish:  git push origin $TAG"
fi

cat <<EOF

Reminder: git tags are not inherently immutable. PROTECT this tag on the remote
(branch/tag protection rules) so it cannot be force-moved — the release's identity
depends on it staying put.
EOF
