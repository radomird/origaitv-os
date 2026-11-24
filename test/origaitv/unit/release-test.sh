#!/bin/bash

# Guards which release Settings, System says a TV runs: the package's on
# stable, the one its ISO wrote on edge, and none on a build without either.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/release.test.mts"
