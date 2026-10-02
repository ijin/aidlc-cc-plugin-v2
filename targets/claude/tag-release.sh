#!/usr/bin/env bash
# Mint an annotated provenance tag, optionally push it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
PUSH=0
case "${1:-}" in '') ;; --push) PUSH=1 ;; *) die 'Usage: tag-release.sh [--push]' ;; esac
[ "$#" -le 1 ] || die 'Too many arguments'
[ -z "$(git -C "$ROOT" status --porcelain)" ] || die 'Dirty tree; commit changes before tagging'
provenance=$(git -C "$ROOT" show HEAD:UPSTREAM.lock)
pins=$(git -C "$ROOT" show HEAD:dist/claude/data/pins.env)
node --input-type=module - "$provenance" "$pins" <<'JS'
const parse = s => Object.fromEntries(s.split('\n').filter(l=>l && !l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
const [lock, pins] = process.argv.slice(2).map(parse);
for (const [p,l] of [['PINNED_VERSION','UPSTREAM_VERSION'],['PINNED_TAG','UPSTREAM_TAG'],['INSTALL_SH_SHA256','INSTALL_SH_SHA256'],['INSTALL_PS1_SHA256','INSTALL_PS1_SHA256']]) {
  if (!lock[l] || pins[`AIDLC_V2_${p}`] !== lock[l]) throw new Error(`Committed pins disagree with UPSTREAM.lock: ${l}; rebuild and commit`);
}
JS
get() { printf '%s\n' "$provenance" | sed -n "s/^$1=//p"; }
case "$(get SYNCED_NOTE)" in *SKIP_ATTESTATION*) die 'Attestation verification was bypassed; run sync-upstream.sh --reverify before tagging' ;; esac
VERSION=$(node -p "require('$ROOT/package.json').version")
SHA=$(get UPSTREAM_SHA)
TAG="v$VERSION+up.${SHA:0:7}"
if ! git -C "$ROOT" fetch --tags --quiet; then
    [ "$PUSH" = 0 ] || die 'Cannot fetch authoritative tags for push'
    echo 'WARNING: fetch failed; checking local tags only' >&2
fi
[ -z "$(git -C "$ROOT" tag --list "v$VERSION+up.*")" ] || die "Version $VERSION already released"
git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "Tag $TAG exists"
message="aidlc-v2 $VERSION

Upstream tag: $(get UPSTREAM_TAG)
Upstream repository: $(get UPSTREAM_REPO)
Upstream commit: $SHA
Release date: $(get UPSTREAM_DATE)
install.sh SHA256: $(get INSTALL_SH_SHA256)
install.ps1 SHA256: $(get INSTALL_PS1_SHA256)
Built by targets/claude/build.mjs from the verified release pins."
git -C "$ROOT" tag -a "$TAG" -m "$message"
if [ "$PUSH" = 1 ]; then git -C "$ROOT" push origin "$TAG"
else echo "Created $TAG. Publish with: git push origin $TAG"; fi
