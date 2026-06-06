#!/usr/bin/env bash
# sync-upstream.sh — Refresh the vendored src/ from upstream at an explicit commit.
#
# Replaces the git-subtree workflow. Subtree is a poor fit here: upstream does not
# publish a branch whose ROOT is the src/ we vendor, so a `git subtree pull` of the
# full v2-evaluator branch would map upstream's repo root into our src/. Instead we
# pin an explicit upstream SHA, sparse-checkout just its src/ subdir, swap it in,
# and record the pin in UPSTREAM.lock.
#
# This script automates the MECHANICS only. It deliberately does NOT commit: review
# the diff and the build report, then commit/PR by hand. Upstream v2 has no tags and
# v2-evaluator is force-pushable, so a human approves every snapshot.
#
# Usage:
#   targets/claude/sync-upstream.sh [--force] [<upstream-sha>]
#     <upstream-sha>  Full or short commit SHA to pin to. If omitted, resolves the
#                     current tip of UPSTREAM_BRANCH from the remote and uses that.
#     --force         Skip the clean-worktree guard (allow uncommitted src//dist/
#                     /UPSTREAM.lock changes to be overwritten).
#
# After it runs: review `git diff --stat src/ UPSTREAM.lock dist/` (include dist/ —
# it is the shipped artifact), eyeball the build report, then commit/PR by hand.
# The script runs the build for you and fails loudly if the adapter contract is
# violated; it does NOT rewrite the lock or commit when the build fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="$ROOT/UPSTREAM.lock"

die() { echo "ERROR: $*" >&2; exit 1; }

# --- Pre-flight: fail early (before any mutation) on missing dependencies ---
command -v git >/dev/null || die "git not found on PATH"
command -v node >/dev/null || die "node not found on PATH"
[ -f "$SCRIPT_DIR/build.mjs" ] || die "missing build script: $SCRIPT_DIR/build.mjs"

# This sync overwrites src/ and dist/. Refuse to run with uncommitted changes in
# those paths so a maintainer can't lose local work (and so a failed sync leaves a
# clean baseline to `git checkout` back to). `git status --porcelain` covers BOTH
# tracked modifications AND untracked files (a plain `git diff` would miss the
# latter, e.g. a stray new file under src/). Pass --force to override.
FORCE=""
[ "${1:-}" = "--force" ] && { FORCE=1; shift; }
if [ -z "$FORCE" ] && [ -n "$(git -C "$ROOT" status --porcelain -- src dist UPSTREAM.lock 2>/dev/null)" ]; then
  die "uncommitted/untracked changes in src/, dist/, or UPSTREAM.lock. Commit/stash them first, or pass --force."
fi

# --- Read the lock for repo/branch/subdir (SHA may be overridden by argv) ---
[ -f "$LOCK" ] || die "missing $LOCK"
get() { grep -E "^$1=" "$LOCK" | head -1 | cut -d= -f2-; }
UPSTREAM_REPO="$(get UPSTREAM_REPO)"
UPSTREAM_BRANCH="$(get UPSTREAM_BRANCH)"
UPSTREAM_SUBDIR="$(get UPSTREAM_SUBDIR)"
OLD_SHA="$(get UPSTREAM_SHA)"
OLD_TREE_HASH="$(get UPSTREAM_SRC_TREE_HASH)"
: "${UPSTREAM_REPO:?UPSTREAM_REPO not set in lock}"
: "${UPSTREAM_BRANCH:?UPSTREAM_BRANCH not set in lock}"
: "${UPSTREAM_SUBDIR:=src}"

# Git tree hash of the current vendored src/ (content-addressed: path+content).
# Computed via a throwaway index in its own temp dir so the real index is
# untouched and cleanup is reliable. CRITICAL: --force so .gitignore does NOT
# omit files — the hash must reflect EVERY file in src/, matching upstream's
# `<sha>:src` object exactly. (Without --force, an upstream file matching a
# .gitignore pattern like *.swp/node_modules would be silently dropped and the
# hash would diverge from the upstream object.)
src_tree_hash() {
  local idxdir idx
  idxdir="$(mktemp -d)"
  idx="$idxdir/index"
  GIT_INDEX_FILE="$idx" git -C "$ROOT" add -A --force src >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git -C "$ROOT" write-tree --prefix=src 2>/dev/null
  rm -rf "$idxdir"
}

# Skew guard: the vendored src/ must match the hash the lock claims. A mismatch
# means src/ was hand-edited (it must stay a pristine mirror) or a prior sync left
# it inconsistent. Surface it before we overwrite anything. Empty OLD_TREE_HASH
# (pre-this-field locks) skips the check with a note.
if [ -n "$OLD_TREE_HASH" ]; then
  CUR_TREE_HASH="$(src_tree_hash)"
  if [ "$CUR_TREE_HASH" != "$OLD_TREE_HASH" ]; then
    die "vendored src/ ($CUR_TREE_HASH) does not match UPSTREAM.lock UPSTREAM_SRC_TREE_HASH ($OLD_TREE_HASH). src/ must stay a pristine upstream mirror — do not hand-edit it. Restore with 'git checkout -- src', or if this is an intentional re-pin, reconcile the lock."
  fi
else
  echo "==> Note: lock has no UPSTREAM_SRC_TREE_HASH yet; skipping skew check (will record one)."
fi

TARGET_SHA="${1:-}"

echo "==> Upstream: $UPSTREAM_REPO ($UPSTREAM_BRANCH), subdir '$UPSTREAM_SUBDIR'"
echo "==> Currently pinned: ${OLD_SHA:-<none>}"

# --- Fetch into a throwaway clone (sparse, blobless, depth-light) ---
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Cloning upstream (blobless, sparse) ..."
git clone --filter=blob:none --no-checkout --quiet "$UPSTREAM_REPO" "$TMP/up"
git -C "$TMP/up" sparse-checkout set --no-cone "$UPSTREAM_SUBDIR" >/dev/null

if [ -z "$TARGET_SHA" ]; then
  TARGET_SHA="$(git -C "$TMP/up" rev-parse "origin/$UPSTREAM_BRANCH")"
  echo "==> No SHA given; resolved $UPSTREAM_BRANCH tip = $TARGET_SHA"
fi
git -C "$TMP/up" checkout --quiet "$TARGET_SHA" ||
  die "SHA '$TARGET_SHA' not found in $UPSTREAM_REPO (force-pushed away? wrong SHA?)"
FULL_SHA="$(git -C "$TMP/up" rev-parse HEAD)"
SHA_DATE="$(git -C "$TMP/up" log -1 --format=%cd --date=short HEAD)"

[ -d "$TMP/up/$UPSTREAM_SUBDIR" ] || die "upstream $FULL_SHA has no '$UPSTREAM_SUBDIR/' directory"

# The CANONICAL provenance hash is the upstream git object for the subdir, read
# straight from the upstream repo — not a hash we reconstruct locally after copy.
# This is what we record in the lock and assert our copy against.
UPSTREAM_TREE_HASH="$(git -C "$TMP/up" rev-parse "$FULL_SHA:$UPSTREAM_SUBDIR")" ||
  die "could not resolve upstream tree $FULL_SHA:$UPSTREAM_SUBDIR"

if [ "$FULL_SHA" = "$OLD_SHA" ]; then
  echo "==> Already at $FULL_SHA — nothing to sync."
  exit 0
fi

# --- T1 diff-triage (BEFORE the swap) ---
# Classify what upstream changed so a human reviews the genuinely-novel residual
# before we adopt the snapshot. T1 uses our LOCAL vendored src/ as the "old" side
# (immune to upstream force-push); only the TARGET SHA must be reachable in the
# clone ($TMP/up). Gating:
#   - interactive TTY  : pause on escalations; abort unless the human confirms.
#   - non-interactive  : print and PROCEED by default (advisory) — UNLESS
#                        STRICT_TRIAGE=1, in which case escalations HARD-FAIL the
#                        sync (use this in CI to make T1 a real gate). T0's build
#                        contract still gates the build either way.
# Skip entirely with SKIP_TRIAGE=1.
if [ -z "${SKIP_TRIAGE:-}" ] && [ -f "$SCRIPT_DIR/sync-triage.mjs" ]; then
  echo "==> T1 triage: classifying upstream changes ${OLD_SHA:-<lock>} -> $FULL_SHA ..."
  set +e
  node "$SCRIPT_DIR/sync-triage.mjs" "$FULL_SHA" --repo "$TMP/up"
  TRIAGE_RC=$?
  set -e
  if [ "$TRIAGE_RC" -eq 2 ]; then
    if [ -t 0 ]; then
      printf "Items above need human review. Proceed with the sync anyway? [y/N] "
      read -r ans
      case "$ans" in
        y|Y) echo "==> Proceeding past triage on human confirmation." ;;
        *) die "Aborted at T1 triage. Review the ESCALATE items, then re-run (or SKIP_TRIAGE=1 to bypass)." ;;
      esac
    elif [ -n "${STRICT_TRIAGE:-}" ]; then
      die "T1 triage found items needing review (STRICT_TRIAGE=1, non-interactive). Review the output above, then re-run with SKIP_TRIAGE=1 once adopted."
    else
      echo "==> (non-interactive: triage escalations printed above; proceeding — set STRICT_TRIAGE=1 to hard-gate in CI)"
    fi
  elif [ "$TRIAGE_RC" -ne 0 ]; then
    echo "==> (warning: triage could not run cleanly [rc=$TRIAGE_RC]; continuing — the build contract still gates)"
  fi
fi

# --- Swap src/ in place ---
# Guard the destructive rm: ROOT is derived (cd && pwd), so it can't be empty here,
# but a belt-and-suspenders check keeps the rm honest against future refactors.
# The rm is also load-bearing for the cp below: `cp -R src dst` NESTS into dst/src
# if dst already exists, so src/ must be absent first.
[ -n "$ROOT" ] && [ -d "$ROOT/src" ] || die "refusing to replace: '$ROOT/src' is not a directory"
echo "==> Replacing $ROOT/src with upstream $FULL_SHA:$UPSTREAM_SUBDIR/ ..."
rm -rf "$ROOT/src"
cp -R "$TMP/up/$UPSTREAM_SUBDIR" "$ROOT/src"
# Drop a stray nested git repo if one somehow rode along (a sparse subdir checkout
# shouldn't contain one). Intentionally NOT deleting .gitignore/.gitattributes —
# those are legitimate upstream source files.
find "$ROOT/src" -maxdepth 2 -name '.git' -type d -print -exec rm -rf {} + 2>/dev/null || true

# Copy-fidelity assertion: the copied src/ must hash-equal the upstream object.
# If they differ, cp normalized something (modes/symlinks/encoding) — fail rather
# than record a divergent "provenance" hash.
COPIED_HASH="$(src_tree_hash)"
if [ "$COPIED_HASH" != "$UPSTREAM_TREE_HASH" ]; then
  die "copied src/ ($COPIED_HASH) != upstream $FULL_SHA:$UPSTREAM_SUBDIR ($UPSTREAM_TREE_HASH). The copy was not faithful (mode/symlink/encoding normalization?). Investigate before recording the lock."
fi

# --- Build + adapter contract checks (fails loudly on drift) ---
# Run the build BEFORE recording the new pin. If a contract check fails, the lock
# still reflects the last KNOWN-GOOD state, so it never lies and a re-run retries
# (rather than short-circuiting on the "already at SHA" check). src/ and dist/ are
# left modified — `git checkout -- src dist` to discard, or fix the adapter and re-run.
echo "==> Building dist/ and running adapter contract checks ..."
node "$SCRIPT_DIR/build.mjs" build ||
  die "build/contract check failed for $FULL_SHA. src/ and dist/ are modified but UPSTREAM.lock is unchanged. Fix targets/claude/build.mjs and re-run, or 'git checkout -- src dist' to abort."

# --- T2a load smoke (post-build, BEFORE the lock) — OPT-IN ---
# The load smoke runs the built plugin under `claude -p` (a real, billable Bedrock
# call). It is OFF by default: T0's build contract already proves the plugin is
# structurally valid, and T2 found no plugin defects in practice. Opt in with
# RUN_SMOKE=1 (e.g. the release skill enables it for a release candidate);
# STRICT_SMOKE=1 additionally makes a failure abort the sync.
if [ -n "${RUN_SMOKE:-}" ] && [ -f "$SCRIPT_DIR/smoke.mjs" ]; then
  echo "==> T2a load smoke (RUN_SMOKE=1) ..."
  set +e
  node "$SCRIPT_DIR/smoke.mjs"
  SMOKE_RC=$?
  set -e
  if [ "$SMOKE_RC" -ne 0 ]; then
    if [ -n "${STRICT_SMOKE:-}" ]; then
      die "T2a load smoke failed (STRICT_SMOKE=1). src/ and dist/ are modified but UPSTREAM.lock is unchanged. Investigate, then re-run."
    fi
    echo "==> (warning: load smoke failed [rc=$SMOKE_RC]; continuing — set STRICT_SMOKE=1 to hard-gate)"
  fi
fi

# --- Rewrite the lock (only after a successful, validated build) ---
# Record the CANONICAL upstream object hash (already asserted == our copied src/),
# so the lock's provenance is upstream's truth, not a local reconstruction.
NEW_TREE_HASH="$UPSTREAM_TREE_HASH"
echo "==> Updating UPSTREAM.lock -> $FULL_SHA (src tree $NEW_TREE_HASH)"
{
  grep -E '^#' "$LOCK"
  echo "UPSTREAM_REPO=$UPSTREAM_REPO"
  echo "UPSTREAM_BRANCH=$UPSTREAM_BRANCH"
  echo "UPSTREAM_SHA=$FULL_SHA"
  echo "UPSTREAM_SUBDIR=$UPSTREAM_SUBDIR"
  echo "UPSTREAM_SRC_TREE_HASH=$NEW_TREE_HASH"
  echo "UPSTREAM_DATE=$SHA_DATE"
  echo "SYNCED_NOTE=Synced from $UPSTREAM_BRANCH; previous pin ${OLD_SHA:-<none>}."
} > "$LOCK.tmp"
mv "$LOCK.tmp" "$LOCK"

cat <<EOF

==> Sync complete.
    upstream: ${OLD_SHA:-<none>} -> $FULL_SHA  ($SHA_DATE)

    Next steps (NOT done automatically — a human reviews every snapshot):
      git diff --stat src/ UPSTREAM.lock dist/
      git add -A && git commit   # then open a PR

    If the build above FAILED on a contract check, upstream changed something the
    adapter does not yet handle. Read the failure, update targets/claude/build.mjs,
    rebuild, and only then commit.
EOF
