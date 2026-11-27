#!/bin/sh
# Starts osrm-routed on Railway's private network.
#
# Railway's private DNS resolves service names to IPv6 (only IPv6, in older environments), so
# the server should listen on "::". This OSRM release resolves its listen address before
# binding and fails outright on "::" when the container has no IPv6, so: try "::" when IPv6 is
# present, and fall back to IPv4 (loudly) if that fails. OSRM_LISTEN_IP pins an address and
# skips the attempt.
set -u
PORT="${PORT:-5000}"

serve() {
  osrm-routed --algorithm mld --ip "$1" --port "$PORT" --max-viaroute-size 100 /data/region.osrm
}

if [ -z "${OSRM_LISTEN_IP:-}" ] && { [ "${OSRM_ASSUME_IPV6:-}" = 1 ] || [ -s /proc/net/if_inet6 ]; }; then
  echo "[start] IPv6 available; listening on [::]:$PORT"
  serve "::" &
  pid=$!
  # Forward a stop request (redeploy, scale-down) so shutdown stays clean.
  trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
  wait "$pid"
  rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 143 ] || [ "$rc" -eq 130 ]; then
    exit "$rc"
  fi
  echo "[start] WARNING: osrm-routed on [::] exited with $rc; falling back to 0.0.0.0 (IPv4 only)." >&2
  echo "[start] If the API can't reach this service over the private network, that is why." >&2
fi

LISTEN="${OSRM_LISTEN_IP:-0.0.0.0}"
echo "[start] listening on $LISTEN:$PORT"
exec osrm-routed --algorithm mld --ip "$LISTEN" --port "$PORT" --max-viaroute-size 100 /data/region.osrm
