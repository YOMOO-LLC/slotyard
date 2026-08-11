#!/usr/bin/env bash
# End-to-end checks for the probe layer, which has no unit tests: mocking
# docker, lsof and git would mean testing nothing at all.
#
# Why this exists. Five bugs were found in this layer in a single day, every one
# of them by hand — and "by hand" meant creating orphans, starting real stacks
# and rewriting worktree configs on a machine somebody was working on. That is
# not a sustainable way to test. This reproduces the same situations against a
# throwaway fixture instead.
#
# Safety boundaries (hold these when editing):
#   - Dedicated prefix and port range, physically isolated from any real project
#   - Every docker call filtered by label or name prefix. Never prune.
#   - trap EXIT cleans up, so an abort midway leaves nothing behind
#   - Containers are created, never started: they declare their port bindings
#     without actually holding the ports, so running this disturbs nothing
#
# Usage: test/e2e.sh     (needs docker and git; deliberately outside node --test)

set -euo pipefail

PREFIX=slotyard-fixture
LABEL=com.supabase.cli.project
PORT_BASE=59321
SLOTYARD="$(cd "$(dirname "$0")/.." && pwd)/src/cli.ts"
# Deliberately not $TMPDIR: paths under /tmp and /var/folders are classified as
# ephemeral, so unassigned-default correctly degrades to unassigned-noise and the
# case we want to exercise never fires.
BASE="${HOME}/.cache/slotyard"
mkdir -p "$BASE"
WORK=$(mktemp -d "$BASE/e2e.XXXXXX")
PASS=0; FAIL=0

sy() { (cd "$1" && node --experimental-strip-types "$SLOTYARD" "${@:2}"); }

cleanup() {
  local ids
  ids=$(docker ps -aq --filter "label=$LABEL" --filter "name=$PREFIX" 2>/dev/null || true)
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  local vols
  vols=$(docker volume ls -q 2>/dev/null | grep "$PREFIX" || true)
  [ -n "$vols" ] && docker volume rm $vols >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n     expected %s, got %s\n' "$1" "$2" "$3"; }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# jq may not be installed; node certainly is, since that is what this runs on
q() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const d=JSON.parse(s); let v=d;
    for (const k of process.argv[1].split(".")) v = v?.[k];
    process.stdout.write(String(Array.isArray(v) ? v.length : v));
  })' "$1"; }

# ── Build the fixture ─────────────────────────────────────
mkrepo() {
  local dir="$1" pid="$2"
  mkdir -p "$dir/supabase"
  cat > "$dir/supabase/config.toml" <<TOML
project_id = "$pid"
[api]
port = $PORT_BASE
[db]
port = $((PORT_BASE+1))
[studio]
port = $((PORT_BASE+2))
[inbucket]
port = $((PORT_BASE+3))
smtp_port = $((PORT_BASE+4))
pop3_port = $((PORT_BASE+5))
TOML
}

# Created, not started: the container declares which port it will bind without
# holding it. That is exactly the state another project's cold stack is in, and
# exactly the case worth testing.
mkstack() {
  local slot="$1" state="${2:-created}"
  local pid="$PREFIX-s$slot"
  for role in db kong auth; do
    docker create --name "supabase_${role}_${pid}" --label "$LABEL=$pid" \
      -p "$((PORT_BASE + slot*10)):80" busybox true >/dev/null
  done
  docker volume create "supabase_db_${pid}" >/dev/null
}

echo "── Building fixture (prefix ${PREFIX}, ports ${PORT_BASE}+)"
docker image inspect busybox >/dev/null 2>&1 || docker pull -q busybox >/dev/null

MAIN="$WORK/main"
mkrepo "$MAIN" "$PREFIX"
git -C "$MAIN" init -q
git -C "$MAIN" add -A && git -C "$MAIN" -c user.email=e2e@x -c user.name=e2e commit -qm init

wt() { git -C "$MAIN" worktree add -q "$WORK/$1" -b "$1" >/dev/null 2>&1; }
setpid() {
  local dir="$WORK/$1"
  sed -i.bak -E "s|^project_id *= *\".*\"|project_id = \"$2\"|" "$dir/supabase/config.toml"
  rm -f "$dir/supabase/config.toml.bak"
}
# cold and intent-drift read the registry file (intent), which is a different
# thing from config.toml (effective)
setintent() { printf 'SLOT=%s\nPROJECT_ID=%s-s%s\n' "$2" "$PREFIX" "$2" > "$WORK/$1/.wt-slot"; }

wt alpha; setpid alpha "$PREFIX-s1"
wt beta;  setpid beta  "$PREFIX-s1"      # same slot as alpha -> collision
wt gamma; setpid gamma "$PREFIX-s2"; setintent gamma 2   # containers and volumes, not running -> cold
wt delta                                  # left on the default project_id
wt epsilon                                # ditto; two of them = unassigned-default

mkstack 1      # the slot alpha and beta both claim
mkstack 2      # gamma's cold stack
mkstack 5      # claimed by nobody -> orphan-data

echo
echo "── doctor"
J=$(sy "$MAIN" --json)
eq "layout inferred from config.toml   " "$PREFIX (inferred)" "$(echo "$J" | q layout)"
eq "sees only the fixture's containers " "9"                  "$(echo "$J" | q summary.containers)"
eq "collision reported                " "1"                  "$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d.findings.filter(f=>f.kind==="collision").length))})')"
eq "unassigned-default reported       " "1"                  "$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d.findings.filter(f=>f.kind==="unassigned-default").length))})')"
eq "orphan-data reported for slot 5   " "5"                  "$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d.findings.find(f=>f.kind==="orphan-data")?.slot))})')"
eq "cold reported                     " "1"                  "$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d.findings.filter(f=>f.kind==="cold").length))})')"

echo
echo "── alloc"
A=$(sy "$WORK/delta" alloc --json)
GOT=$(echo "$A" | q slot)
eq "skips taken slots 1, 2 and 5      " "3"                  "$GOT"
eq "gamma idempotently gets 2 back    " "2"                  "$(sy "$WORK/gamma" alloc)"
eq "the main repo is always 0         " "0"                  "$(sy "$MAIN" alloc)"

echo
echo "── Cross-project: declared ports block a project sharing the range"
OTHER="$WORK/other"
mkrepo "$OTHER" "other-app"          # identical port range to the fixture
git -C "$OTHER" init -q
git -C "$OTHER" add -A && git -C "$OTHER" -c user.email=e2e@x -c user.name=e2e commit -qm init
git -C "$OTHER" worktree add -q "$WORK/other-wt" -b feat >/dev/null 2>&1
B=$(sy "$WORK/other-wt" alloc --json)
eq "second project sees nothing of its own" "0"                  "$(echo "$B" | q occupied)"
eq "but 3 slots are port-blocked      " "3"                  "$(echo "$B" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(Object.keys(d.portBlocked).length))})')"
eq "so it avoids slot 1               " "true"               "$([ "$(echo "$B" | q slot)" != "1" ] && echo true || echo false)"

echo
printf '── %d passed / %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
