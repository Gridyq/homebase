#!/usr/bin/env bash
# Stop hook: when Claude finishes a turn, typecheck + lint the app and run the
# Rust tests, but only for the parts whose files changed since the last clean run.
# A failure blocks the stop and hands Claude the (trimmed) error output.
set -u
cd "$(dirname "$0")/../.." || exit 0

input=$(cat)
stop_hook_active=$(jq -r '.stop_hook_active // false' <<<"$input" 2>/dev/null)

state_dir=.git/claude-check
mkdir -p "$state_dir"

# Fingerprint = HEAD + uncommitted diff + untracked files, limited to the given paths.
fingerprint() {
  {
    git rev-parse HEAD
    git diff HEAD -- "$@"
    git ls-files -o --exclude-standard -z -- "$@" | xargs -0r sha1sum
  } 2>/dev/null | sha1sum | cut -d' ' -f1
}

app_paths=(src scripts package.json package-lock.json tsconfig.json eslint.config.js app.json)
rust_paths=(status-server-rs)

app_fp=$(fingerprint "${app_paths[@]}")
rust_fp=$(fingerprint "${rust_paths[@]}")

failures=""
run_check() { # name, command...
  local name=$1; shift
  local out
  if ! out=$("$@" 2>&1); then
    failures+="### $name failed"$'\n'"$(tail -n 40 <<<"$out")"$'\n\n'
    return 1
  fi
}

if [[ "$app_fp" != "$(cat "$state_dir/app.pass" 2>/dev/null)" ]]; then
  app_ok=1
  run_check "tsc --noEmit" npx tsc --noEmit || app_ok=0
  run_check "expo lint" npx expo lint || app_ok=0
  ((app_ok)) && echo "$app_fp" >"$state_dir/app.pass"
fi

if [[ "$rust_fp" != "$(cat "$state_dir/rust.pass" 2>/dev/null)" ]]; then
  # Run from inside the crate so its .cargo/config.toml (target dir outside the repo) applies.
  run_check "cargo test (status-server-rs)" bash -c 'cd status-server-rs && cargo test -q' &&
    echo "$rust_fp" >"$state_dir/rust.pass"
fi

[[ -z "$failures" ]] && exit 0

# Don't loop forever: if Claude already got a failure and changed nothing since,
# let it stop and tell the human instead.
combined="$app_fp $rust_fp"
if [[ "$stop_hook_active" == "true" && "$combined" == "$(cat "$state_dir/last.fail" 2>/dev/null)" ]]; then
  jq -n --arg m "Checks still failing (tsc / expo lint / cargo test) — Claude stopped without fixing them." \
    '{systemMessage: $m}'
  exit 0
fi
echo "$combined" >"$state_dir/last.fail"

printf 'Automatic checks failed. Fix these before finishing (or explain why they cannot be fixed):\n\n%s' "$failures" >&2
exit 2
