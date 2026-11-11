#!/bin/bash
# Browser containers: br-browser / 172.30.0.0/24. Open internet; no access to the host or internal networks.
# Everything lives in BROWSER-* chains; nothing existing is touched.  Usage: apply | remove | status
# Installed as /usr/local/sbin/browser-firewall.sh (step 2 of phase 1).
#
# NEW in this version (needs a re-apply, with approval): the OUTPUT guard. The broker (root) is the only
# local process allowed to reach a browser's DevTools port (9222) on the browser network; any other local
# user (the assistant's own OS user included) is refused, so one profile cannot attach to another's browser.
set -euo pipefail
BR=br-browser; NET=browser-net; SUBNET=172.30.0.0/24
DENY="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
chain() { iptables -N "$1" 2>/dev/null || true; }
first() { local c=$1; shift; iptables -C "$c" "$@" 2>/dev/null || iptables -I "$c" 1 "$@"; }

apply() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --driver bridge \
    --subnet "$SUBNET" --gateway 172.30.0.1 -o com.docker.network.bridge.name="$BR" \
    -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null
  chain BROWSER-BLOCK     # empty on purpose: add a rule here to block something later
  chain BROWSER-DENY; iptables -F BROWSER-DENY
  iptables -A BROWSER-DENY -m limit --limit 30/second --limit-burst 60 -j LOG --log-prefix "BROWSER-DENY "
  iptables -A BROWSER-DENY -j DROP
  chain BROWSER-EGRESS; iptables -F BROWSER-EGRESS
  iptables -A BROWSER-EGRESS -j BROWSER-BLOCK
  for r in $DENY; do iptables -A BROWSER-EGRESS -d "$r" -j BROWSER-DENY; done
  iptables -A BROWSER-EGRESS -m conntrack --ctstate NEW -m limit --limit 30/second --limit-burst 60 -j LOG --log-prefix "BROWSER-NEW "
  first DOCKER-USER -i "$BR" -j BROWSER-EGRESS
  first INPUT -i "$BR" -j DROP
  first OUTPUT -d "$SUBNET" -p tcp --dport 9222 -m owner ! --uid-owner 0 -j REJECT --reject-with tcp-reset
}
remove() {
  iptables -D DOCKER-USER -i "$BR" -j BROWSER-EGRESS 2>/dev/null || true
  iptables -D INPUT -i "$BR" -j DROP 2>/dev/null || true
  iptables -D OUTPUT -d "$SUBNET" -p tcp --dport 9222 -m owner ! --uid-owner 0 -j REJECT --reject-with tcp-reset 2>/dev/null || true
  for c in BROWSER-EGRESS BROWSER-DENY BROWSER-BLOCK; do iptables -F "$c" 2>/dev/null || true; iptables -X "$c" 2>/dev/null || true; done
  echo "rules removed. The network stays; remove it with: docker network rm $NET"
}
status() {
  docker network ls --filter name="$NET" --format '{{.Name}} {{.ID}}'
  iptables -S BROWSER-EGRESS BROWSER-DENY BROWSER-BLOCK 2>&1
  iptables -S DOCKER-USER; iptables -S INPUT | head -3; iptables -S OUTPUT | head -3
}
"${1:-status}"
