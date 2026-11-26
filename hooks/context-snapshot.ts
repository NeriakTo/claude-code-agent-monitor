// Function hooks 透過引擎執行本機指令。路徑和 JSON 以獨立引數傳入。
export const SNAPSHOT_SCRIPT = `
set -eu
case "$1" in
  /*) path=$1 ;;
  '~/'*) path="$HOME/\${1#'~/'}" ;;
  *)
    printf '%s\\n' '快照路徑必須是絕對路徑或以 ~/ 開頭' >&2
    exit 1
    ;;
esac

if [ -L "$path" ]; then
  printf '%s\\n' '快照路徑為符號連結' >&2
  exit 1
fi

if [ -z "$2" ]; then
  rm -f "$path"
  exit 0
fi

dir=\${path%/*}/
mkdir -p "$dir"
if [ -d "$path" ]; then
  printf '%s\\n' '快照路徑指向目錄' >&2
  exit 1
fi

tmp=$(mktemp "\${dir}.context-snapshot.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
printf '%s\\n' "$2" > "$tmp"
mv -f "$tmp" "$path"
`
