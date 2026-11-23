#!/bin/bash

# Guards whether a native app's program is on the box (daemon/program.ts):
# its pacman package or its flatpak, as each keeps what's installed.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/program.test.mts"
