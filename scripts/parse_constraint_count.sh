#!/usr/bin/env bash
set -euo pipefail

# snarkjs writes ANSI colour codes around its log prefix. Remove them before
# parsing so colour parameters cannot become the reported constraint count.
count=$(
  sed $'s/\033\\[[0-9;]*m//g' |
    sed -nE 's/.*# of Constraints:[[:space:]]*([0-9]+).*/\1/p' |
    sed -n '1p'
)

if [[ ! "$count" =~ ^[0-9]+$ ]]; then
  echo "Could not parse the snarkjs constraint count." >&2
  exit 1
fi

printf '%s\n' "$count"
