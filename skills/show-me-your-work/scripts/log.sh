#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result>" >&2
  exit 1
fi

logfile="$1"
shift

sanitize() {
  local cell
  cell="$(printf '%s' "$1" | tr '\t\n\r' '   ')"
  case "$cell" in
    [=+@-]*) cell="'$cell" ;;
  esac
  printf '%s' "$cell"
}

if [ ! -f "$logfile" ]; then
  printf 'ts\tphase\tdecision\twhy\tevidence\tresult\n' > "$logfile"
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$ts" \
  "$(sanitize "$1")" \
  "$(sanitize "$2")" \
  "$(sanitize "$3")" \
  "$(sanitize "$4")" \
  "$(sanitize "$5")" >> "$logfile"
