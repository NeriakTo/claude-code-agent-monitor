#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
snapshot_script=$(node --disable-warning=ExperimentalWarning --experimental-strip-types --input-type=module -e '
  import { SNAPSHOT_SCRIPT } from "./hooks/context-snapshot.ts";
  process.stdout.write(SNAPSHOT_SCRIPT);
')
test_root=$(mktemp -d "${TMPDIR:-$PWD}/agent-monitor-context.XXXXXXXX")
trap 'rm -rf "$test_root"' EXIT
trap 'exit 1' HUP INT TERM

run_snapshot() {
  /bin/sh -c "$snapshot_script" agent-monitor "$@"
}

assert_rejected() {
  if run_snapshot "$1" "$2" 2>snapshot-error; then
    return 1
  fi
  [ "$(cat snapshot-error)" = "$3" ]
}

expand_home() {
  HOME="$PWD/test home" run_snapshot '~/nested/board/context.json' '{"used_percent":26}' &&
    [ "$(cat 'test home/nested/board/context.json')" = '{"used_percent":26}' ]
}

reject_directory() {
  mkdir context.json &&
    assert_rejected "$PWD/context.json" '{}' '快照路徑指向目錄' &&
    [ -z "$(ls -A context.json)" ]
}

replace_atomically() {
  run_snapshot "$PWD/context.json" '{"used_percent":26}' &&
    exec 3<context.json &&
    run_snapshot "$PWD/context.json" '{"used_percent":0}' &&
    [ "$(cat context.json)" = '{"used_percent":0}' ] &&
    [ "$(cat <&3)" = '{"used_percent":26}' ] &&
    [ "$(ls -A)" = 'context.json' ]
}

remove_snapshot() {
  run_snapshot "$PWD/context.json" '{}' &&
    run_snapshot "$PWD/context.json" '' &&
    [ ! -e context.json ]
}

reject_link() {
  printf '%s\n' '原始內容' > target &&
    ln -s target context.json &&
    assert_rejected "$PWD/context.json" '{}' '快照路徑為符號連結' &&
    [ -L context.json ] &&
    [ "$(cat target)" = '原始內容' ]
}

keep_dangling_link() {
  ln -s missing context.json &&
    assert_rejected "$PWD/context.json" '' '快照路徑為符號連結' &&
    [ -L context.json ] &&
    [ ! -e missing ]
}

follow_parent_link() {
  mkdir target &&
    ln -s target parent &&
    run_snapshot "$PWD/parent/context.json" '{}' &&
    [ "$(cat target/context.json)" = '{}' ] &&
    run_snapshot "$PWD/parent/context.json" '' &&
    [ ! -e target/context.json ]
}

clean_failed_rename() {
  mkdir commands &&
    printf '%s\n' '#!/bin/sh' 'exit 1' > commands/mv &&
    chmod +x commands/mv &&
    printf '%s\n' '原始內容' > context.json &&
    assert_rename_failed &&
    [ "$(cat context.json)" = '原始內容' ] &&
    [ "$(ls -A)" = "$(printf '%s\n' commands context.json)" ]
}

assert_rename_failed() {
  if PATH="$PWD/commands:$PATH" run_snapshot "$PWD/context.json" '{}'; then
    return 1
  fi
}

reject_relative() {
  assert_rejected 'relative/context.json' '{}' '快照路徑必須是絕對路徑或以 ~/ 開頭' &&
    [ ! -e relative ]
}

fake_tmux() {
  mkdir commands || return 1
  cat > commands/tmux <<'SH' || return 1
#!/bin/sh
printf '%s\n' "$@" > tmux-called
printf '%s\n' "$FAKE_SESSION"
if [ "${FAKE_TMUX_FAIL:-}" = yes ]; then
  printf '%s\n' '查不到窗格' >&2
  exit 1
fi
SH
  chmod +x commands/tmux || return 1
  export PATH="$PWD/commands:$PATH" TMUX='假 socket' TMUX_PANE= FAKE_SESSION=claude-code-discord
}

session_unconfigured() {
  fake_tmux &&
    run_snapshot "$PWD/context.json" '{"used_percent":26}' '' &&
    [ "$(cat context.json)" = '{"used_percent":26}' ] &&
    [ ! -e tmux-called ]
}

session_matches() {
  fake_tmux &&
    run_snapshot "$PWD/context.json" '{"used_percent":26}' claude-code-discord &&
    [ "$(cat context.json)" = '{"used_percent":26}' ] &&
    [ "$(cat tmux-called)" = "$(printf '%s\n' display-message -p '#S')" ] &&
    TMUX_PANE='%42' run_snapshot "$PWD/context.json" '' claude-code-discord &&
    [ ! -e context.json ] &&
    [ "$(cat tmux-called)" = "$(printf '%s\n' display-message -p -t '%42' '#S')" ]
}

assert_snapshot_preserved() {
  printf '%s\n' '原始內容' > context.json &&
    run_snapshot "$PWD/context.json" "$1" claude-code-discord 2>snapshot-error &&
    [ "$(cat context.json)" = '原始內容' ] &&
    [ ! -s snapshot-error ]
}

session_differs() {
  fake_tmux &&
    export FAKE_SESSION=background &&
    assert_snapshot_preserved '{"used_percent":26}' &&
    assert_snapshot_preserved ''
}

session_prefix_only() {
  fake_tmux &&
    FAKE_SESSION=claude-code-discord-2 assert_snapshot_preserved '{"used_percent":26}'
}

session_outside_tmux() {
  fake_tmux &&
    TMUX= assert_snapshot_preserved '{"used_percent":26}' &&
    [ ! -e tmux-called ]
}

session_tmux_missing() {
  mkdir commands || return 1
  for utility in cat mkdir mktemp mv rm; do
    ln -s "$(command -v "$utility")" "commands/$utility" || return 1
  done
  PATH="$PWD/commands" TMUX='假 socket' TMUX_PANE= \
    assert_snapshot_preserved '{"used_percent":26}'
}

session_lookup_fails() {
  fake_tmux &&
    FAKE_TMUX_FAIL=yes assert_snapshot_preserved ''
}

passed=0
failed=0
check() {
  if (mkdir "$test_root/$1" && cd "$test_root/$1" && "$1"); then
    printf '通過 %s\n' "$1"
    passed=$((passed + 1))
  else
    printf '失敗 %s\n' "$1" >&2
    failed=$((failed + 1))
  fi
}

check expand_home
check reject_directory
check replace_atomically
check remove_snapshot
check reject_link
check keep_dangling_link
check follow_parent_link
check clean_failed_rename
check reject_relative
check session_unconfigured
check session_matches
check session_differs
check session_prefix_only
check session_outside_tmux
check session_tmux_missing
check session_lookup_fails
printf '%s 通過，%s 失敗\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
