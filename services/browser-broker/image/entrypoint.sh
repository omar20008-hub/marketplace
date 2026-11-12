#!/bin/sh
# Chrome 145 ignores --remote-debugging-address in the new headless mode and listens on the container's
# loopback only. socat makes DevTools reachable on the container's own address (9222 -> 127.0.0.1:9223).
# The container sits on a network no other container can reach, and the host's OUTPUT guard lets only
# root (the broker) connect to 9222.
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &
exec /opt/chrome/chrome --headless=new --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/profile --no-first-run --remote-debugging-port=9223 "$@"
