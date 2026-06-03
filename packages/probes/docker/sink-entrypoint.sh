#!/bin/sh
# Sinkhole entrypoint. Runs with --cap-add=NET_ADMIN (the sink is trusted; the
# TARGET runs with all caps dropped). Redirect all inbound TCP to the sink port,
# then run the sinkhole with our own IP so DNS answers point back here.
set -e
SINK_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
export SINK_IP
iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-port 8443 2>/dev/null || true
exec node /sinkhole.mjs
