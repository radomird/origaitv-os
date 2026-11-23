# The folders TV setup and the TV session use. The services' Chromium
# profile, which will hold the household's sign-ins, belongs to the owner and
# nobody else; so does the home screen's, which has none (ADR-031,
# bin/origaitv-session-setup).
install -d -m 755 /var/lib/origaitv
install -d -m 700 -o "$ORIGAITV_OWNER" -g "$ORIGAITV_OWNER" /var/lib/origaitv/chromium

# The secret the USB stick gave the phone that installed this TV, for that
# phone to pair with once the TV is back, with no code to scan. The stick
# hands it over root's only, and it goes to the daemon's own state, which
# only the daemon reads. The daemon drops it once that phone pairs, or once
# setup is done.
handed_pairing=/etc/origaitv/phone-pairing.json
if [[ -f $handed_pairing ]]; then
  if getent passwd origaitv-server >/dev/null; then
    install -d -m 700 -o origaitv-server -g origaitv-server /var/lib/origaitv/daemon
    install -m 600 -o origaitv-server -g origaitv-server "$handed_pairing" /var/lib/origaitv/daemon/stick-pairing.json
  fi
  rm -f "$handed_pairing"
fi
