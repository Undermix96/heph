#!/usr/bin/env bash
# Heph new-project bootstrap (§9 "Skill: new project bootstrap", D64).
# Deterministic part of the skill: creates the folder, the repo files from
# ../templates, the first commit(s) and, when `gh` is ready, the GitHub repo
# (SSH remote) and the push. Needs bash and git; gh is optional.
#
#   bootstrap.sh --dir PATH --name NAME --visibility public|private
#                --stack node|python|platformio|generic
#                [--description TEXT] [--slug SLUG] [--repo-name NAME]
#                [--holder NAME] [--design-dir PATH]
#                [--node-version X] [--python-version X] [--no-github]
#
# Prints `key=value` result lines at the end (HEPH_DIR, HEPH_REPO, HEPH_GITHUB,
# HEPH_PUSHED) for the skill to read. Exit codes: 0 done (GitHub may be
# skipped, see HEPH_GITHUB), 2 bad arguments or non-empty folder, 1 git failed.
# Test hook: HEPH_BOOTSTRAP_REMOTE_BASE replaces "git@github.com:" in the remote.

set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true # "&" stays literal in ${v//x/y}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
templates="$here/../templates"

die() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit "${2:-2}"
}

dir="" name="" visibility="" stack="" description="" slug="" repo_name="" holder=""
design_dir="" node_version="" python_version="" github=true
# Value of an option; a missing value is an argument error (exit 2).
val() {
  [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || die "$1 needs a value"
  printf '%s' "$2"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --no-github) github=false; shift; continue ;;
    --dir | --name | --visibility | --stack | --description | --slug | --repo-name | --holder | \
      --design-dir | --node-version | --python-version)
      v="$(val "$@")" || exit 2 ;;
    *) die "unknown option: $1" ;;
  esac
  case "$1" in
    --dir) dir="$v" ;;
    --name) name="$v" ;;
    --visibility) visibility="$v" ;;
    --stack) stack="$v" ;;
    --description) description="$v" ;;
    --slug) slug="$v" ;;
    --repo-name) repo_name="$v" ;;
    --holder) holder="$v" ;;
    --design-dir) design_dir="$v" ;;
    --node-version) node_version="$v" ;;
    --python-version) python_version="$v" ;;
  esac
  shift 2
done

[ -n "$dir" ] || die "--dir is required"
[ -n "$name" ] || die "--name is required"
case "$visibility" in public | private) ;; *) die "--visibility must be public or private" ;; esac
case "$stack" in node | python | platformio | generic) ;; *) die "--stack must be node, python, platformio or generic" ;; esac
command -v git >/dev/null 2>&1 || die "git is not installed" 1
if [ -n "$design_dir" ]; then
  [ -d "$design_dir" ] || die "--design-dir is not a folder: $design_dir"
  # Absolute now: the script changes folder before copying (verification D7).
  design_dir="$(cd "$design_dir" && pwd)"
fi
# Check everything that could fail before the folder is touched, so a rerun is possible.
# Outside any repo, so a repo-local identity of the caller's folder does not count (R2).
(cd / && env -u GIT_DIR -u GIT_WORK_TREE git var GIT_AUTHOR_IDENT) >/dev/null 2>&1 ||
  die "git has no user.name / user.email: set them (git config --global user.name ...) and run again" 1

# Slug like Heph's slugify (packages/core/src/util.ts): accents dropped, lower case,
# letters and digits joined by single dashes, at most 60 characters, never only digits.
# No iconv: its transliteration differs between Git Bash and Linux (verification D7).
# Accented Latin letters → base letter, one substitution each (sed in the C locale sees
# bytes, so a bracket like [àé] would split them).
ACCENTS='s/à/a/g; s/á/a/g; s/â/a/g; s/ã/a/g; s/ä/a/g; s/å/a/g; s/ā/a/g; s/ă/a/g; s/ą/a/g; s/À/a/g; s/Á/a/g; s/Â/a/g; s/Ã/a/g; s/Ä/a/g; s/Å/a/g; s/Ā/a/g; s/Ă/a/g; s/Ą/a/g; s/ç/c/g; s/ć/c/g; s/ĉ/c/g; s/ċ/c/g; s/č/c/g; s/Ç/c/g; s/Ć/c/g; s/Ĉ/c/g; s/Ċ/c/g; s/Č/c/g; s/ď/d/g; s/Ď/d/g; s/è/e/g; s/é/e/g; s/ê/e/g; s/ë/e/g; s/ē/e/g; s/ĕ/e/g; s/ė/e/g; s/ę/e/g; s/ě/e/g; s/È/e/g; s/É/e/g; s/Ê/e/g; s/Ë/e/g; s/Ē/e/g; s/Ĕ/e/g; s/Ė/e/g; s/Ę/e/g; s/Ě/e/g; s/ĝ/g/g; s/ğ/g/g; s/ġ/g/g; s/ģ/g/g; s/Ĝ/g/g; s/Ğ/g/g; s/Ġ/g/g; s/Ģ/g/g; s/ì/i/g; s/í/i/g; s/î/i/g; s/ï/i/g; s/ĩ/i/g; s/ī/i/g; s/ĭ/i/g; s/į/i/g; s/Ì/i/g; s/Í/i/g; s/Î/i/g; s/Ï/i/g; s/Ĩ/i/g; s/Ī/i/g; s/Ĭ/i/g; s/Į/i/g; s/İ/i/g; s/ñ/n/g; s/ń/n/g; s/ņ/n/g; s/ň/n/g; s/Ñ/n/g; s/Ń/n/g; s/Ņ/n/g; s/Ň/n/g; s/ò/o/g; s/ó/o/g; s/ô/o/g; s/õ/o/g; s/ö/o/g; s/ō/o/g; s/ŏ/o/g; s/ő/o/g; s/Ò/o/g; s/Ó/o/g; s/Ô/o/g; s/Õ/o/g; s/Ö/o/g; s/Ō/o/g; s/Ŏ/o/g; s/Ő/o/g; s/ŕ/r/g; s/ŗ/r/g; s/ř/r/g; s/Ŕ/r/g; s/Ŗ/r/g; s/Ř/r/g; s/ś/s/g; s/ŝ/s/g; s/ş/s/g; s/š/s/g; s/Ś/s/g; s/Ŝ/s/g; s/Ş/s/g; s/Š/s/g; s/ţ/t/g; s/ť/t/g; s/Ţ/t/g; s/Ť/t/g; s/ù/u/g; s/ú/u/g; s/û/u/g; s/ü/u/g; s/ũ/u/g; s/ū/u/g; s/ŭ/u/g; s/ů/u/g; s/ű/u/g; s/ų/u/g; s/Ù/u/g; s/Ú/u/g; s/Û/u/g; s/Ü/u/g; s/Ũ/u/g; s/Ū/u/g; s/Ŭ/u/g; s/Ů/u/g; s/Ű/u/g; s/Ų/u/g; s/ý/y/g; s/ÿ/y/g; s/ŷ/y/g; s/Ý/y/g; s/Ÿ/y/g; s/Ŷ/y/g; s/ź/z/g; s/ż/z/g; s/ž/z/g; s/Ź/z/g; s/Ż/z/g; s/Ž/z/g'
to_slug() {
  local out
  # Combining accents (decomposed names, U+0300-U+036F) are dropped first, like NFKD.
  out="$(printf '%s' "$1" | LC_ALL=C sed -e 's/\xcc[\x80-\xbf]//g; s/\xcd[\x80-\xaf]//g' -e "$ACCENTS" |
    LC_ALL=C tr '[:upper:]' '[:lower:]' |
    LC_ALL=C sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' | cut -c1-60 | sed -e 's/-*$//')" || true
  case "$out" in
    '') ;;
    *[!0-9]*) ;;
    *) out="p-$out" ;;
  esac
  printf '%s' "$out"
}
[ -n "$slug" ] || slug="$(to_slug "$name")"
[ -n "$slug" ] || slug="project"
[ -n "$repo_name" ] || repo_name="$slug"
[ -n "$holder" ] || holder="$(git config user.name 2>/dev/null || true)"
[ -n "$holder" ] || holder="TBD"
[ -n "$description" ] || description="TBD"

# Never touch existing work: the folder must be new or empty.
if [ -e "$dir" ]; then
  [ -d "$dir" ] || die "$dir exists and is not a folder"
  if [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then die "$dir is not empty: choose a new folder"; fi
fi
mkdir -p "$dir"
# Windows path in Git Bash (pwd -W), so Claude can use it with its other tools.
dir="$(cd "$dir" && (pwd -W 2>/dev/null || pwd))"

case "$stack" in
  node) stack_label="Node.js / TypeScript" ;;
  python) stack_label="Python" ;;
  platformio) stack_label="PlatformIO / C++" ;;
  *) stack_label="generic" ;;
esac
if [ "$visibility" = public ]; then
  license_line="[MIT](LICENSE)"
else
  license_line="Private repository: no license, all rights reserved."
fi

# Copies a template with {{PLACEHOLDERS}} replaced (values are inserted verbatim).
render() {
  local text
  text="$(cat "$templates/$1")"
  text="${text//\{\{NAME\}\}/$name}"
  text="${text//\{\{DESCRIPTION\}\}/$description}"
  text="${text//\{\{SLUG\}\}/$slug}"
  text="${text//\{\{HOLDER\}\}/$holder}"
  text="${text//\{\{YEAR\}\}/$(date -u +%Y)}"
  text="${text//\{\{DATE\}\}/$(date -u +%Y-%m-%d)}"
  text="${text//\{\{STACK_LABEL\}\}/$stack_label}"
  text="${text//\{\{VISIBILITY\}\}/$visibility}"
  text="${text//\{\{LICENSE_LINE\}\}/$license_line}"
  printf '%s\n' "$text" >"$dir/$2"
}

cd "$dir"
git init -q -b main 2>/dev/null || { git init -q && git symbolic-ref HEAD refs/heads/main; }
cat "$templates/gitignore/common.gitignore" "$templates/gitignore/$stack.gitignore" >.gitignore
cp "$templates/editorconfig" .editorconfig
cp "$templates/gitattributes" .gitattributes
render README.md README.md
render DECISIONS.md DECISIONS.md
render CLAUDE.md CLAUDE.md
[ "$visibility" = public ] && render LICENSE LICENSE
[ "$stack" = node ] && [ -n "$node_version" ] && printf '%s\n' "$node_version" >.nvmrc
[ "$stack" = python ] && [ -n "$python_version" ] && printf '%s\n' "$python_version" >.python-version

git add -A
git commit -q -m "Initial commit" || die "git commit failed (is git user.name/user.email set?)" 1

if [ -n "$design_dir" ]; then
  mkdir -p docs/design
  cp -R "$design_dir"/. docs/design/
  # A design folder that is itself a repo: keep the files, not its .git (verification D7).
  find docs/design -name .git -prune -exec rm -rf {} +
  git add -A
  git commit -q -m "Docs: add design documents" || true
fi

# GitHub (optional): only with gh installed and signed in.
github_status="skipped: --no-github"
repo=""
pushed=false
if $github; then
  if ! command -v gh >/dev/null 2>&1; then
    github_status="skipped: gh is not installed"
  elif ! gh auth status >/dev/null 2>&1; then
    github_status="skipped: gh is not signed in (run gh auth login)"
  elif gh repo create "$repo_name" "--$visibility" --source . >/dev/null 2>&1; then
    repo="$(gh repo view "$repo_name" --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [ -n "$repo" ]; then
      # SSH remote (owner's rule), never HTTPS.
      git remote remove origin >/dev/null 2>&1 || true
      git remote add origin "${HEPH_BOOTSTRAP_REMOTE_BASE:-git@github.com:}$repo.git"
      if git push -q -u origin main >/dev/null 2>&1; then
        pushed=true
        github_status="created"
      else
        github_status="created, push failed (check the SSH key, then git push -u origin main)"
      fi
    else
      github_status="created, but its name could not be read: set the remote by hand"
    fi
  else
    github_status="failed: gh repo create did not succeed (name taken?)"
  fi
fi

printf 'HEPH_DIR=%s\n' "$dir"
printf 'HEPH_SLUG=%s\n' "$slug"
printf 'HEPH_REPO=%s\n' "$repo"
printf 'HEPH_GITHUB=%s\n' "$github_status"
printf 'HEPH_PUSHED=%s\n' "$pushed"
