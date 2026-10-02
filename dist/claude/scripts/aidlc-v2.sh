#!/bin/sh
# Thin, non-interactive adapter over the pinned upstream installer and CLI.
set -u
fail() { printf '%s\n' "$2" >&2; exit "$1"; }
DATA=$(CDPATH='' cd -P "$(dirname "$0")/../data" && pwd -P) || fail 1 'Cannot locate plugin data; rebuild or reinstall this plugin'
CR=$(printf '\r')
mode=${1:-}
[ "$#" -gt 0 ] && shift
case "$mode" in plan|apply) ;; *) fail 2 'Usage: aidlc-v2.sh plan|apply [--project dir] [--mcp defaults|none] [--check] [--yes]' ;; esac
project=$PWD
mcp=defaults
yes=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --project|--mcp)
            [ "$#" -ge 2 ] || fail 2 "Missing value for $1"
            case "$1" in --project) project=$2 ;; --mcp) mcp=$2 ;; esac
            shift 2 ;;
        --yes) yes=1; shift ;;
        --check) [ "$mode" = plan ] || fail 2 '--check is only accepted by plan'; shift ;;
        *) fail 2 "Unknown argument: $1" ;;
    esac
done
case "$mcp" in defaults|none) ;; *) fail 2 'MCP must be defaults or none' ;; esac
[ "$mode" != apply ] || [ "$yes" = 1 ] || fail 2 'apply requires --yes'
[ -n "$project" ] || fail 2 '--project must not be empty'
P=$(CDPATH='' cd -P "$project" && pwd -P) || fail 2 'Project must be an existing directory'
home_physical=
if [ -n "${HOME:-}" ]; then home_physical=$(CDPATH='' cd -P "$HOME" 2>/dev/null && pwd -P); fi
config_dir=${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}
config_physical=$(CDPATH='' cd -P "$config_dir" 2>/dev/null && pwd -P)
project_claude=$(CDPATH='' cd -P "$P/.claude" 2>/dev/null && pwd -P)
if [ "$P" = / ] || [ "$P" = "$home_physical" ] || [ "$P" = "$config_physical" ] || { [ -n "$project_claude" ] && [ "$project_claude" = "$config_physical" ]; }; then
    fail 5 "Refusing to set up AI-DLC in your home directory or Claude Code's own config directory; run it inside a project."
fi
platform=${AIDLC_V2_PLATFORM:-}
if [ -z "$platform" ]; then
    system=$(uname -s) || fail 5 'Cannot determine platform'
    [ -n "$system" ] || fail 5 'Cannot determine platform'
    case "$system" in MINGW*|MSYS*|CYGWIN*) platform=windows ;; *) platform=unix ;; esac
fi
case "$platform" in unix|windows) ;; *) fail 5 "Unsupported platform: $platform" ;; esac
version=''; tag=''; sh_hash=''; ps_hash=''
while IFS='=' read -r key value || [ -n "$key" ]; do
    value=${value%"$CR"}
    case "$key" in
        AIDLC_V2_PINNED_VERSION) version=$value ;;
        AIDLC_V2_PINNED_TAG) tag=$value ;;
        AIDLC_V2_INSTALL_SH_SHA256) sh_hash=$value ;;
        AIDLC_V2_INSTALL_PS1_SHA256) ps_hash=$value ;;
    esac
done < "$DATA/pins.env"
[ -n "$version" ] && [ -n "$tag" ] && [ -n "$sh_hash" ] && [ -n "$ps_hash" ] || fail 1 'Missing pins; rebuild this plugin'
if [ "$platform" = windows ]; then bin=${AIDLC_BIN_DIR:-${LOCALAPPDATA:-}/aidlc/bin}
else bin=${AIDLC_BIN_DIR:-${HOME:-}/.local/bin}; fi
kind=fresh
marker=$P/.claude/tools/aidlc-version.ts
if [ -e "$P/.claude/tools/data/aidlc-stamp.json" ]; then
    kind=upstream-managed
elif [ -e "$marker" ]; then
    kind=unknown-aidlc
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%"$CR"}
        case "$line" in 'export const AIDLC_VERSION = "2.1.4"'|'export const AIDLC_VERSION = "2.1.4";') kind=legacy-2.1.4 ;; esac
    done < "$marker"
fi
[ "$kind" != unknown-aidlc ] || fail 5 'This project was set up by something other than upstream aidlc config or this plugin 2.1.4. Move .claude/ aside first.'
# Return 0 when the first version is newer, 1 otherwise, 2 for invalid input.
# A subshell confines the temporary field splitting and pathname settings.
version_newer() (
    left=$1; right=$2
    set -f
    IFS=.
    left_numeric=${left%%-*}; left_numeric=${left_numeric%%+*}
    # shellcheck disable=SC2086
    set -- $left_numeric
    [ "$#" = 3 ] || exit 2
    for part do case "$part" in ''|*[!0-9]*) exit 2 ;; esac; done
    left_major=$1; left_minor=$2; left_patch=$3
    right_numeric=${right%%-*}; right_numeric=${right_numeric%%+*}
    # shellcheck disable=SC2086
    set -- $right_numeric
    [ "$#" = 3 ] || exit 2
    for part do case "$part" in ''|*[!0-9]*) exit 2 ;; esac; done
    [ "$left_major" -le "$1" ] || exit 0
    [ "$left_major" -ge "$1" ] || exit 1
    [ "$left_minor" -le "$2" ] || exit 0
    [ "$left_minor" -ge "$2" ] || exit 1
    [ "$left_patch" -le "$3" ] || exit 0
    [ "$left_patch" -ge "$3" ] || exit 1
    case "$left" in *-preview*) exit 1 ;; esac
    case "$right" in *-preview*) exit 0 ;; esac
    exit 1
)
current=none
project_version=''
if [ -f "$P/.aidlc-version" ]; then
    current=$(head -n 1 "$P/.aidlc-version")
    current=${current%"$CR"}
    # An empty pin file pins nothing; treat it as absent (revert = unpin).
    [ -n "$current" ] || current=none
    [ "$current" = none ] || project_version=$current
fi
if [ "$kind" = upstream-managed ] && [ -f "$marker" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%"$CR"}
        case "$line" in
            *'export const AIDLC_VERSION = "'*)
                framework_version=${line#*'export const AIDLC_VERSION = "'}
                framework_version=${framework_version%%\"*}
                if [ -z "$project_version" ]; then project_version=$framework_version
                else
                    version_newer "$framework_version" "$project_version"
                    comparison=$?
                    [ "$comparison" -ne 2 ] || fail 5 'Cannot parse the current project AI-DLC version'
                    [ "$comparison" -ne 0 ] || project_version=$framework_version
                fi ;;
        esac
    done < "$marker"
fi
if [ -n "$project_version" ]; then
    version_newer "$project_version" "$version"
    comparison=$?
    [ "$comparison" -ne 2 ] || fail 5 'Cannot parse the current project AI-DLC version'
    [ "$comparison" -ne 0 ] || fail 5 "This project is on AI-DLC $project_version, newer than the version this plugin pins ($version). Run upstream's aidlc config directly, or update this plugin."
fi
migration_changed=0
real_pin=0
setup_complete=0
quiet=0
runtime=''; scratch=''; scratch_pin=0; removed_file=''; strip_tmp=''
cli=''; not_on_path=0
cleanup() {
    final_rc=$?
    trap - 0
    if [ "$scratch_pin" = 1 ]; then
        "$cli" config --unpin --project-dir "$scratch" --quiet < /dev/null || printf '%s\n' 'Could not unregister the rehearsal pin; run aidlc config --unpin for the scratch path above.' >&2
    fi
    if [ "$final_rc" -ne 0 ] && [ -n "$scratch" ] && [ "$real_pin" = 0 ]; then
        printf '%s\n' 'Rehearsal ended; nothing in your project was changed.'
    fi
    if [ "$final_rc" -ne 0 ] && [ "$real_pin" = 1 ] && [ "$setup_complete" = 0 ]; then
        if [ "$current" = none ]; then
            "$cli" config --unpin --project-dir "$P" --quiet < /dev/null
        else
            "$cli" config --pin "$current" --project-dir "$P" --quiet < /dev/null
        fi
        rollback_rc=$?
        if [ "$rollback_rc" -eq 0 ]; then printf 'Reverted project pin to %s.\n' "$current"
        elif [ "$current" = none ]; then
            printf '%s\n' 'Could not revert the project pin: the project had no .aidlc-version before; delete it, and run aidlc config --unpin in the project.' >&2
        else
            printf 'Could not revert the project pin: set .aidlc-version back to %s (its previous value), then run aidlc config --pin %s in the project once that version is installed.\n' "$current" "$current" >&2
        fi
    fi
    if [ "$final_rc" -ne 0 ] && [ "$migration_changed" = 1 ] && [ "$setup_complete" = 0 ]; then
        printf '%s\n' 'The real migration already removed or stripped unmodified v2.1.4 files; upstream configuration did not complete and may have written some new files (check git status).' >&2
        printf 'The migrated paths are listed one per line in %s.\n' "$removed_file" >&2
        if git -C "$P" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            printf '%s\n' 'To restore the ones tracked in git (this resets .gitignore to its committed version if it is listed), run this from the project directory:' >&2
            # shellcheck disable=SC2016
            printf '  while IFS= read -r f; do git checkout HEAD -- "$f" 2>/dev/null; done < "%s"\n' "$removed_file" >&2
        else
            printf '%s\n' 'The removed files were unmodified copies of public release v2.1.4.' >&2
        fi
        removed_file=''
    fi
    [ -z "$strip_tmp" ] || rm -f "$strip_tmp"
    [ -z "$removed_file" ] || rm -f "$removed_file"
    [ -z "$runtime" ] || rm -rf "$runtime"
    exit "$final_rc"
}
trap cleanup 0
trap 'exit 1' 1 2 15
ensure_runtime() {
    [ -z "$runtime" ] || return 0
    runtime=$(mktemp -d) || fail 1 'Cannot create temporary directory'
    runtime=$(CDPATH='' cd -P "$runtime" && pwd -P) || fail 1 'Cannot resolve temporary directory'
    case "$runtime" in "$P"/*) fail 1 'Temporary directory must be outside the project; set TMPDIR outside it' ;; esac
    block_file=$runtime/gitignore-block
    while IFS= read -r block_line; do
        block_line=${block_line%"$CR"}
        printf '%s\n' "$block_line"
    done < "$DATA/legacy-2.1.4.gitignore-block" > "$block_file"
    printf '\n' > "$runtime/lf"
}
find_aidlc() {
    cli=''; not_on_path=0
    if [ -n "${AIDLC_V2_AIDLC:-}" ] && [ -x "$AIDLC_V2_AIDLC" ]; then cli=$AIDLC_V2_AIDLC; return; fi
    cli=$(command -v aidlc 2>/dev/null) && return
    cli=''
    if [ "$platform" = windows ]; then
        cli=$(command -v aidlc.cmd 2>/dev/null) && return
        cli=''
        if [ -n "${AIDLC_BIN_DIR:-}" ]; then
            candidate=$AIDLC_BIN_DIR/aidlc.cmd
            if command -v cygpath >/dev/null 2>&1; then candidate=$(cygpath -u "$candidate"); fi
            if [ -x "$candidate" ]; then cli=$candidate; bin=$(dirname "$candidate"); not_on_path=1; return; fi
        fi
        candidate=${LOCALAPPDATA:-}/aidlc/bin/aidlc.cmd
        if command -v cygpath >/dev/null 2>&1; then candidate=$(cygpath -u "$candidate"); fi
    else
        candidate=$bin/aidlc
    fi
    if [ -x "$candidate" ]; then cli=$candidate; bin=$(dirname "$candidate"); not_on_path=1; fi
}
check_version() {
    output=$("$cli" --version < /dev/null) || fail 1 'Cannot read aidlc version'
    output=${output%"$CR"}
    set -f
    # shellcheck disable=SC2086
    set -- $output
    [ "${1:-}" = aidlc ] || fail 5 "Cannot parse CLI version: $output"
    cli_version=${2:-}; cli_version=${cli_version%"$CR"}; cli_version=${cli_version%%+*}
    numeric=${cli_version%%-*}
    oldifs=$IFS; IFS=.
    # shellcheck disable=SC2086
    set -- $numeric
    IFS=$oldifs
    [ "$#" = 3 ] || fail 5 "Cannot parse CLI version: $output"
    for part do case "$part" in ''|*[!0-9]*) fail 5 "Cannot parse CLI version: $output" ;; esac; done
    if [ "$1" -lt 2 ] || { [ "$1" -eq 2 ] && [ "$2" -lt 8 ]; }; then
        fail 5 "Your aidlc CLI is $cli_version; run aidlc update and re-run."
    fi
    set +f
}
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then result=$(sha256sum "$1") || return 1
    else result=$(shasum -a 256 "$1") || return 1; fi
    printf '%s\n' "${result%% *}"
}
safe() {
    [ ! -L "$T" ] || { reason=symlink; return 1; }
    logical_parent=$(dirname "$T")
    parent=$(CDPATH='' cd -P "$logical_parent" 2>/dev/null && pwd -P) || { reason='outside project'; return 1; }
    case "$parent" in "$M"|"$M"/*) ;; *) reason='outside project'; return 1 ;; esac
    [ "$parent" = "$logical_parent" ] || { reason='symlinked directory'; return 1; }
}
suffix_matches() {
    [ -f "$T" ] || return 1
    size=$(wc -c < "$T")
    block_size=$(wc -c < "$block_file")
    [ "$size" -ge "$block_size" ] || return 1
    tail -c "$block_size" "$T" | cmp -s - "$block_file"
}
strip_suffix() {
    strip_tmp=$(mktemp "$(dirname "$T")/.aidlc-v2-gitignore.XXXXXX") || return 1
    # Preserve the original mode and write only to a sibling until mv succeeds.
    cp -p "$T" "$strip_tmp" || { rm -f "$strip_tmp"; strip_tmp=''; return 1; }
    prefix_size=$((size - block_size))
    while [ "$prefix_size" -gt 0 ]; do
        head -c "$prefix_size" "$T" | tail -c 1 | cmp -s - "$runtime/lf" || break
        prefix_size=$((prefix_size - 1))
    done
    if [ "$prefix_size" -gt 0 ]; then
        if ! head -c "$prefix_size" "$T" > "$strip_tmp" || ! printf '\n' >> "$strip_tmp"; then rm -f "$strip_tmp"; strip_tmp=''; return 1; fi
    else
        : > "$strip_tmp" || { rm -f "$strip_tmp"; strip_tmp=''; return 1; }
    fi
    if ! safe || ! suffix_matches || ! mv "$strip_tmp" "$T"; then rm -f "$strip_tmp"; strip_tmp=''; return 1; fi
    strip_tmp=''
}
record_path() {
    [ "$M" = "$P" ] || return 0
    migration_changed=1
    printf '%s\n' "$rel" >> "$removed_file" || fail 1 'Cannot record migrated path'
}
migrate() {
    M=$1; migration_action=$2
    removes=0; keeps=0; strips=0
    empty_before=''
    if [ "$migration_action" = execute ] && [ -d "$M/.claude" ] && [ ! -L "$M/.claude" ]; then
        empty_before=$(find "$M/.claude" -type d -empty)
    fi
    while IFS= read -r entry || [ -n "$entry" ]; do
        entry=${entry%"$CR"}
        expected=${entry%% *}; rel=${entry#*  }; T=$M/$rel
        [ -e "$T" ] || [ -L "$T" ] || continue
        reason='locally modified'
        if ! safe; then
            keeps=$((keeps + 1)); [ "$quiet" = 1 ] || printf 'keep %s (%s)\n' "$rel" "$reason"
        elif [ -f "$T" ] && [ "$(sha256_of "$T")" = "$expected" ]; then
            removes=$((removes + 1))
            if [ "$migration_action" = execute ]; then
                if safe && [ "$(sha256_of "$T")" = "$expected" ]; then
                    rm "$T" || fail 1 "Cannot remove $rel"
                    record_path
                    [ "$quiet" = 1 ] || [ "$removes" -gt 10 ] || printf 'removed %s\n' "$rel"
                fi
            elif [ "$removes" -le 10 ]; then printf 'remove %s\n' "$rel"; fi
        elif [ "$rel" = .gitignore ] && suffix_matches; then
            strips=$((strips + 1)); [ "$quiet" = 1 ] || printf 'strip-suffix %s\n' "$rel"
            if [ "$migration_action" = execute ] && safe && suffix_matches; then strip_suffix || fail 1 'Cannot strip gitignore suffix'; record_path; fi
        else
            keeps=$((keeps + 1)); [ "$quiet" = 1 ] || printf 'keep %s (%s)\n' "$rel" "$reason"
        fi
    done < "$DATA/legacy-2.1.4.sha256"
    [ "$quiet" = 1 ] || printf 'Legacy migration: remove %s, keep %s, strip-suffix %s. Removed files are pristine copies of a public release.\n' "$removes" "$keeps" "$strips"
    if [ "$migration_action" = execute ] && [ -d "$M/.claude" ] && [ ! -L "$M/.claude" ]; then
        find "$M/.claude" -depth -type d -empty -exec sh -c '
            case "
$2
" in *"
$1
"*) exit 0 ;; esac
            find "$1" -depth -type d -empty -delete
        ' sh {} "$empty_before" \;
    fi
}
path_guidance() {
    if [ "$platform" = windows ]; then
        printf 'Add "%s" to your user PATH. Hooks will not work until it is on PATH.\n' "$bin"
    else
        # shellcheck disable=SC2016
        printf 'export PATH="%s:$PATH"\n' "$bin"
        printf '%s\n' 'Put this in ~/.zshenv for zsh or ~/.bashrc for bash; Claude Code hooks run non-interactively. Hooks will not work until it is on PATH.'
    fi
}
conflict_guidance() {
    printf '%s\n' 'Move the named conflicting files aside and re-run. Never use --force: it replaces your CLAUDE.md and drops your own permissions entries without backup.' >&2
}
map_config_rc() {
    mapped=0
    case "$1" in
        0) ;;
        4) case "$command_output" in *'config conflict'*) mapped=3; conflict_guidance ;; *) mapped=5 ;; esac ;;
        5) mapped=5 ;;
        *) mapped=1 ;;
    esac
}
run_config() {
    command_output=$("$cli" config "$@" < /dev/null 2>&1)
    command_rc=$?
    [ -z "$command_output" ] || printf '%s\n' "$command_output"
    map_config_rc "$command_rc"
}
run_pin() {
    command_output=$("$cli" config "$@" < /dev/null 2>&1)
    command_rc=$?
    [ -z "$command_output" ] || printf '%s\n' "$command_output"
    mapped=0
    case "$command_rc" in 0) ;; 5) mapped=5 ;; *) mapped=1 ;; esac
}
rehearse() {
    ensure_runtime
    scratch=$runtime/rehearsal
    mkdir "$scratch" || fail 1 'Cannot create rehearsal project'
    for item in .claude .mcp.json .gitignore aidlc .aidlc-version; do
        if [ -e "$P/$item" ] || [ -L "$P/$item" ]; then cp -RP "$P/$item" "$scratch/$item" || fail 1 'Cannot copy legacy project for rehearsal'; fi
    done
    # Plan shows what the real migration will do; the scratch pass itself stays quiet.
    [ "$mode" != plan ] || migrate "$P" plan
    printf '%s\n' 'Rehearsing the migration in a scratch copy of .claude/, .mcp.json, .gitignore and aidlc/ (a large aidlc/ workspace takes a moment).'
    printf 'Scratch copy: %s\n' "$scratch"
    quiet=1
    migrate "$scratch" execute
    quiet=0
    if [ "$mode" = apply ]; then
        scratch_pin=1
        run_pin --pin "$version" --project-dir "$scratch" --quiet
        if [ "$mapped" -ne 0 ]; then printf '%s\n' 'Rehearsal refused.'; exit "$mapped"; fi
    else
        # A copied project pin would select its engine instead of the active CLI.
        rm -f "$scratch/.aidlc-version" || fail 1 'Cannot remove the scratch project pin'
        printf '%s\n' "The rehearsal used the CLI's active version; plan does not pin the scratch project."
    fi
    run_config --harness claude --project-dir "$scratch" --mcp "$mcp" --dry-run
    rehearsal_rc=$mapped
    if [ "$mode" = apply ]; then
        run_pin --unpin --project-dir "$scratch" --quiet
        if [ "$mapped" = 0 ]; then scratch_pin=0
        elif [ "$rehearsal_rc" = 0 ]; then rehearsal_rc=$mapped; fi
    fi
    [ "$rehearsal_rc" -eq 0 ] || { printf '%s\n' 'Rehearsal refused.'; exit "$rehearsal_rc"; }
    printf '%s\n' 'Legacy rehearsal succeeded; nothing in your project was changed.'
}
find_aidlc
[ -z "$cli" ] || check_version
printf 'Platform: %s\nProject: %s (%s)\n' "$platform" "$P" "$kind"
if [ -n "$cli" ]; then printf 'CLI: %s, version %s, off PATH: %s\n' "$cli" "$cli_version" "$not_on_path"
else printf 'will install aidlc %s into %s\n' "$version" "$bin"; fi
printf 'Project pin: %s -> %s\n' "$current" "$version"
if [ "$mode" = plan ]; then
    if [ "$kind" = legacy-2.1.4 ]; then
        if [ -n "$cli" ]; then
            rehearse
        else
            # No CLI to rehearse with yet: show the static plan. Apply installs the CLI and
            # rehearses on a scratch copy before it changes anything in the project.
            ensure_runtime
            migrate "$P" plan
            printf '%s\n' 'Apply will install the aidlc CLI, then rehearse this migration on a scratch copy before changing anything in your project.'
        fi
    elif [ -n "$cli" ]; then
        printf '%s\n' "Preview uses the CLI's current version until the project is pinned."
        run_config --harness claude --project-dir "$P" --mcp "$mcp" --dry-run
        [ "$mapped" -eq 0 ] || exit "$mapped"
    fi
    [ "$not_on_path" = 0 ] || { printf '%s' 'Note: after setup, '; path_guidance; }
    exit 0
fi
if [ -z "$cli" ]; then
    ensure_runtime
    if [ "$platform" = unix ]; then asset=install.sh; expected=$sh_hash
    else asset=install.ps1; expected=$ps_hash; fi
    url=${AIDLC_V2_RELEASE_BASE:-https://github.com/awslabs/aidlc-workflows/releases/download}/$tag/$asset
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$runtime/$asset" || fail 1 'Installer download failed'
    elif command -v wget >/dev/null 2>&1; then wget -q -O "$runtime/$asset" "$url" || fail 1 'Installer download failed'
    else fail 1 'curl or wget is required'; fi
    actual=$(sha256_of "$runtime/$asset") || fail 1 'Cannot hash installer'
    [ "$actual" = "$expected" ] || fail 4 "refusing to run an installer that does not match the hash this plugin pins: expected $expected; actual $actual"
    if [ "$platform" = unix ]; then
        sh "$runtime/$asset" --version "$version" --yes --quiet < /dev/null || fail 1 'Installer failed'
    else
        ps=${AIDLC_V2_POWERSHELL:-}
        if [ -z "$ps" ]; then ps=$(command -v powershell.exe 2>/dev/null) || ps=$(command -v pwsh 2>/dev/null) || fail 5 'PowerShell is unavailable'; fi
        winpath=$runtime/$asset
        if command -v cygpath >/dev/null 2>&1; then winpath=$(cygpath -w "$winpath"); fi
        "$ps" -NoProfile -ExecutionPolicy Bypass -File "$winpath" -Version "$version" -Yes -Quiet < /dev/null || fail 1 'Installer failed'
    fi
    find_aidlc
    [ -n "$cli" ] || fail 5 'Installed CLI could not be found; add the upstream bin directory to PATH'
    check_version
fi
[ "$kind" != legacy-2.1.4 ] || rehearse
run_pin --pin "$version" --project-dir "$P" --quiet
[ "$mapped" -eq 0 ] || exit "$mapped"
real_pin=1
if [ "$kind" = legacy-2.1.4 ]; then
    removed_file=$(mktemp "${TMPDIR:-/tmp}/aidlc-v2-removed.XXXXXX") || fail 1 'Cannot create migration path record'
    migrate "$P" execute
fi
run_config --harness claude --project-dir "$P" --mcp "$mcp" --dry-run
[ "$mapped" -eq 0 ] || exit "$mapped"
run_config --harness claude --project-dir "$P" --mcp "$mcp"
[ "$mapped" -eq 0 ] || exit "$mapped"
# Upstream has now written the project at the pinned version. From here on the pin must stay,
# and the migrated 2.1.4 files must not be restored, whatever doctor reports.
setup_complete=1
"$cli" doctor --project-dir "$P" --quiet < /dev/null
rc=$?
if [ "$not_on_path" = 1 ]; then
    path_guidance
    printf '%s\n' 'doctor may report the hook runtime until aidlc is on PATH'
    exit 5
fi
[ "$rc" -eq 0 ] || fail 1 'Doctor reported a failure'
printf '%s\n' 'Restart the Claude Code session, then /aidlc; commit .aidlc-version, .claude/, aidlc/.'
