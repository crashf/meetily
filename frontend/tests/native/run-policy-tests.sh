#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../src-tauri/src/audio" && pwd)
if command -v rustc >/dev/null 2>&1; then
  temp=$(mktemp -d); trap 'rm -rf "$temp"' EXIT
  rustc --edition=2021 --test "$root/lifecycle_policy.rs" -o "$temp/policy-tests"
  "$temp/policy-tests"
else
  docker run --rm -v "$root/lifecycle_policy.rs:/policy.rs:ro" rust:1.85-slim sh -c 'rustc --edition=2021 --test /policy.rs -o /tmp/policy-tests && /tmp/policy-tests'
fi
