#!/bin/bash

# Guards the theme in a paired phone's state (daemon/home.ts, T29.1's unit
# half): its name, whether it's dark or light, and the colours
# GET /api/theme.css has, with the same values, for every theme Omarchy
# ships. The state's count goes up once when the theme changes and stays when
# the same theme is handed over again. A phone that isn't paired gets none of
# it, and GET /api/theme.css says what it said.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/phone-theme.test.mts"
