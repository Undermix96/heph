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
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2-}"; shift 2 ;;
    --name) name="${2-}"; shift 2 ;;
    --visibility) visibility="${2-}"; shift 2 ;;
    --stack) stack="${2-}"; shift 2 ;;
    --description) description="${2-}"; shift 2 ;;
    --slug) slug="${2-}"; shift 2 ;;
    --repo-name) repo_name="${2-}"; shift 2 ;;
    --holder) holder="${2-}"; shift 2 ;;
    --design-dir) design_dir="${2-}"; shift 2 ;;
    --node-version) node_version="${2-}"; shift 2 ;;
    --python-version) python_version="${2-}"; shift 2 ;;
    --no-github) github=false; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "$dir" ] || die "--dir is required"
[ -n "$name" ] || die "--name is required"
case "$visibility" in public | private) ;; *) die "--visibility must be public or private" ;; esac
case "$stack" in node | python | platformio | generic) ;; *) die "--stack must be node, python, platformio or generic" ;; esac
command -v git >/dev/null 2>&1 || die "git is not installed" 1
if [ -n "$design_dir" ] && [ ! -d "$design_dir" ]; then die "--design-dir is not a folder: $design_dir"; fi

# Slug: lower case letters, digits and dashes (like Heph's slugs).
to_slug() {
  local ascii
  ascii="$(printf '%s' "$1" | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null)" || ascii="$1"
  printf '%s' "$ascii" | tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-60 || true
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
