#!/bin/bash

# Edge's package counts from the last release or candidate: a build is
# 1.0.0rc6.r12.gabc1234 twelve commits after 1.0.0-rc6, and
# 1.0.0.r3.gabc1234 three after 1.0.0. This checks the places here that
# read that shape still do: a night's edge ISO is named after its package
# (image.yml), the Nightly finds the commit a package was built from
# (nightly-checks), and nothing takes such a build for a release.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

image="$ROOT/.github/workflows/image.yml"

# The lines of image.yml that say what an edge package's version looks
# like, one for each job that names an ISO.
tests=()
while IFS= read -r line; do
  tests+=("$line")
# shellcheck disable=SC2016 # the single quotes hold sed, not shell
done < <(sed -nE 's/^ *if (\[\[ \$version =~ .* \]\]); then$/\1/p' "$image")
(( ${#tests[@]} == 2 )) || fail "image.yml names the edge ISO in two jobs" "found ${#tests[@]}"
[[ ${tests[0]} == "${tests[1]}" ]] || fail "both jobs read an edge version the same way" "$(printf '%s\n' "${tests[@]}")"

edge_version() {
  local version=$1
  eval "${tests[0]}"
}

for version in 0.2.0.r1157.g8880c58c5 1.0.0rc6.r0.g8880c58c5 1.0.0rc6.r12.gabc1234 1.0.0rc10.r0.gabc1234 1.0.0.r0.gabc1234 1.0.1rc1.r3.gabc1234; do
  edge_version "$version" || fail "an edge ISO is named after its package, $version"
done
pass "an edge ISO is named after its package, also one that counts from a candidate"

for version in 1.0.0 1.0.0-rc6 1.0.0rc6 1.0.0rc06.r1.gabc1234 1.0.0rc0.r1.gabc1234 1.0.0rc.r1.gabc1234 1.0.0-rc6.r1.gabc1234 1.0.0rc6.r1 edge; do
  ! edge_version "$version" || fail "$version isn't an edge package's version"
done
pass "a release's or a candidate's own version isn't taken for an edge package's"

# The Nightly reads the commit off the end of the version.
checks="$ROOT/.github/scripts/nightly-checks"
mkdir -p "$SCRATCH/os" "$SCRATCH/iso"
for repo in os iso; do
  git -C "$SCRATCH/$repo" init --quiet --initial-branch origaitv
  git -C "$SCRATCH/$repo" -c user.name=test -c user.email=test@example.invalid commit --quiet --allow-empty -m "first"
done
sha=$(git -C "$SCRATCH/os" rev-parse HEAD)
for version in "0.2.0.r1157.g${sha:0:9}" "1.0.0rc6.r0.g${sha:0:9}" "1.0.0rc10.r4.g${sha:0:7}" "1.0.0.r2.g${sha:0:9}"; do
  out=$(GITHUB_OUTPUT=/dev/stdout "$checks" "$version" "$SCRATCH/os" "$SCRATCH/iso" 2>&1) || fail "the Nightly finds the commit $version was built from" "$out"
  grep -qx "built=$sha" <<<"$out" || fail "the Nightly finds the commit $version was built from" "$out"
done
pass "the Nightly finds the commit a package was built from, whatever it counts from"

# origaitv version: a build named after a candidate isn't a release, so the
# ISO's file still says which release the TV runs.
mkdir -p "$SCRATCH/box"
says() {
  printf 'ORIGAITV_VERSION=%s\nORIGAITV_CHANNEL=edge\n' "$1" >"$SCRATCH/box/settings"
  printf '%s\n' "${@:2}" >"$SCRATCH/box/release"
  PATH=/usr/bin:/bin ORIGAITV_PATH="$SCRATCH/box" ORIGAITV_RELEASE_FILE="$SCRATCH/box/release" bash "$ROOT/bin/origaitv-version"
}
said=$(says 1.0.0rc6.r12.gabc1234 1.0.0-rc7 1.0.0rc6.r12.gabc1234)
[[ $said == $'OrigaiTV 1.0.0rc6.r12.gabc1234 (edge)\nRelease 1.0.0-rc7' ]] || fail "rc7's ISO, with a build named after rc6, runs Release 1.0.0-rc7" "$said"
said=$(says 1.0.0rc7.r1.gabc1234 1.0.0-rc7 1.0.0rc6.r12.gabc1234)
[[ $said == $'OrigaiTV 1.0.0rc7.r1.gabc1234 (edge)\nEdge channel, installed from 1.0.0-rc7' ]] || fail "updated past it, it's edge, installed from 1.0.0-rc7" "$said"
pass "origaitv version never takes a build named after a candidate for a release"
