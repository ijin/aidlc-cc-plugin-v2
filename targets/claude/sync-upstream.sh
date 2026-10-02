#!/usr/bin/env bash
# Adopt a verified release; never commits.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
allow_preview=0
reverify=0
TAG=
for arg in "$@"; do
    case "$arg" in --reverify) reverify=1 ;; --allow-preview) allow_preview=1 ;; v*) [ -z "$TAG" ] || exit 2; TAG=$arg ;; *) echo "Unknown argument: $arg" >&2; exit 2 ;; esac
done
if [ "$reverify" = 1 ]; then
    current_tag=$(sed -n 's/^UPSTREAM_TAG=//p' "$ROOT/UPSTREAM.lock")
    [ -z "$TAG" ] || [ "$TAG" = "$current_tag" ] || { echo '--reverify only accepts the current pinned tag' >&2; exit 2; }
    TAG=$current_tag
    [ "${SKIP_ATTESTATION:-0}" != 1 ] || { echo '--reverify requires attestation verification; unset SKIP_ATTESTATION' >&2; exit 2; }
fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]{8}\.[0-9]+)?$ ]] || { echo 'Usage: sync-upstream.sh <tag> [--allow-preview]' >&2; exit 2; }
workflow=release.yml
if [[ "$TAG" == *-preview.* ]]; then
    [ "$allow_preview" = 1 ] || { echo 'Preview tags require --allow-preview' >&2; exit 2; }
    workflow=preview-release.yml
fi
if [ "$reverify" = 0 ] && [ "$(sed -n 's/^UPSTREAM_TAG=//p' "$ROOT/UPSTREAM.lock")" = "$TAG" ]; then echo 'nothing to sync'; exit 0; fi
for tool in curl git node; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
repo=https://github.com/awslabs/aidlc-workflows.git
for asset in install.sh install.ps1 checksums.txt version.json aidlc-release.intoto.jsonl; do
    curl -fsSL "https://github.com/awslabs/aidlc-workflows/releases/download/$TAG/$asset" -o "$TMP/$asset"
done
if [ "$reverify" = 1 ]; then
    node --input-type=module - "$ROOT/UPSTREAM.lock" "$TMP/checksums.txt" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
const [lockPath, checksumPath] = process.argv.slice(2);
const expected = fs.readFileSync(lockPath,'utf8').match(/^CHECKSUMS_SHA256=(.+)$/m)?.[1];
const actual = crypto.createHash('sha256').update(fs.readFileSync(checksumPath)).digest('hex');
if (actual !== expected) throw new Error(`REUPLOAD REFUSAL: checksums.txt hash changed: expected ${expected}; actual ${actual}. Pinned values will not be changed.`);
JS
fi
remote=$(git ls-remote "$repo" "refs/tags/$TAG" "refs/tags/$TAG^{}")
sha=$(printf '%s\n' "$remote" | awk '$2 ~ /\^\{\}$/ {print $1}')
[ -n "$sha" ] || sha=$(printf '%s\n' "$remote" | awk 'NR==1 {print $1}')
[ -n "$sha" ] || { echo 'Cannot resolve release tag' >&2; exit 1; }
node --input-type=module - "$TMP" "$TAG" "$sha" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
const [dir, tag, sha] = process.argv.slice(2);
const text = fs.readFileSync(`${dir}/checksums.txt`, 'utf8');
for (const asset of ['install.sh', 'install.ps1', 'version.json']) {
  const rows = text.split('\n').map(l => l.match(/^([0-9a-f]{64})\s+\*?(.+)$/)).filter(Boolean).filter(m => m[2] === asset);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(`${dir}/${asset}`)).digest('hex');
  if (rows.length !== 1 || rows[0][1] !== actual) throw new Error(`Checksum mismatch for ${asset}`);
}
const v = JSON.parse(fs.readFileSync(`${dir}/version.json`));
if (v.version !== tag.slice(1) || v.sourceRef !== `refs/tags/${tag}` || v.sourceDigest !== sha) throw new Error('Release metadata disagrees with peeled tag');
JS
note="Verified checksums and Sigstore attestations for $TAG."
if [ "${SKIP_ATTESTATION:-0}" = 1 ]; then
    echo 'WARNING: SKIP_ATTESTATION=1 bypasses mandatory signature verification!' >&2
    note="WARNING: SKIP_ATTESTATION=1; signature verification bypassed for $TAG."
else
    command -v gh >/dev/null || { echo 'gh is required for signature verification' >&2; exit 1; }
    # Keep Sigstore's trust cache temporary; preserve gh's configured auth source.
    mkdir "$TMP/gh-home"
    gh_config=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}
    for asset in install.sh install.ps1; do
        HOME="$TMP/gh-home" GH_CONFIG_DIR="$gh_config" gh attestation verify "$TMP/$asset" --bundle "$TMP/aidlc-release.intoto.jsonl" --repo awslabs/aidlc-workflows --signer-workflow "awslabs/aidlc-workflows/.github/workflows/$workflow" --source-ref "refs/tags/$TAG" || { echo 'Attestation verification failed; check authentication with gh auth status.' >&2; exit 1; }
    done
fi
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh api "repos/awslabs/aidlc-workflows/releases/tags/$TAG" > "$TMP/release.json"
else
    curl -fsSL "https://api.github.com/repos/awslabs/aidlc-workflows/releases/tags/$TAG" -o "$TMP/release.json"
fi
release_date=$(node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1])).published_at;if(!d)process.exit(1);process.stdout.write(d.slice(0,10))' "$TMP/release.json")

node --input-type=module - "$ROOT" "$TMP" "$TAG" "$sha" "$workflow" "$note" "$release_date" "$reverify" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
const [root, dir, tag, sha, workflow, note, date, reverify] = process.argv.slice(2);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(`${dir}/${file}`)).digest('hex');
const header = fs.readFileSync(`${root}/UPSTREAM.lock`, 'utf8').split('\n').filter(l => l.startsWith('#')).join('\n');
const fields = { UPSTREAM_REPO: 'https://github.com/awslabs/aidlc-workflows.git', UPSTREAM_TAG: tag, UPSTREAM_VERSION: tag.slice(1), UPSTREAM_SHA: sha, UPSTREAM_DATE: date, UPSTREAM_SIGNER_WORKFLOW: `awslabs/aidlc-workflows/.github/workflows/${workflow}`, INSTALL_SH_SHA256: hash('install.sh'), INSTALL_PS1_SHA256: hash('install.ps1'), CHECKSUMS_SHA256: hash('checksums.txt'), SYNCED_NOTE: note };
if (reverify === '1') {
  const old = Object.fromEntries(fs.readFileSync(`${root}/UPSTREAM.lock`,'utf8').split('\n').filter(l=>l && !l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
  for(const [key,value] of Object.entries(fields)) if(key !== 'SYNCED_NOTE' && old[key] !== value) throw new Error(`Reverification would change pinned ${key}; refusing to rewrite the lock`);
}
fs.writeFileSync(`${root}/UPSTREAM.lock`, header + '\n' + Object.entries(fields).map(([k,v]) => `${k}=${v}\n`).join(''));
JS
node - "$ROOT" "${TAG#v}" <<'JS'
const fs = require('fs');
const [root, version] = process.argv.slice(2);
for (const file of ['package.json', '.claude-plugin/marketplace.json']) {
  const p = `${root}/${file}`, data = JSON.parse(fs.readFileSync(p));
  if (file === 'package.json') data.version = version;
  else data.plugins.find(p => p.name === 'aidlc-v2').version = version;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
JS
node "$ROOT/targets/claude/build.mjs" build
printf 'Set plugin version to %s (mirrors upstream). Next: CHANGELOG entry, npm test, npm run gate, commit, tag.\n' "${TAG#v}"
