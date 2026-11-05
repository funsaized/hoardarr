#!/usr/bin/env bash
# A real ephemeral WireGuard gateway: no commercial VPN credentials or host VPN changes.
set -euo pipefail
name="hoardarr-net-${GITHUB_RUN_ID:-$$}"
net="$name-net"; gateway="$name-gateway"; vpn="$name-vpn"; probe="$name-probe"
cleanup() {
  code=$?
  if [[ $code != 0 ]]; then docker logs "$vpn" || true; docker logs "$gateway" || true; fi
  docker rm -f "$probe" "$vpn" "$gateway" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT
docker build -q -t hoardarr-network-test tests/network
docker network create --subnet 172.30.90.0/24 "$net" >/dev/null
docker run -d --name "$gateway" --network "$net" --ip 172.30.90.2 --cap-add NET_ADMIN --sysctl net.ipv4.ip_forward=1 hoardarr-network-test >/dev/null
server_private=$(docker exec "$gateway" wg genkey)
server_public=$(printf '%s' "$server_private" | docker exec -i "$gateway" wg pubkey)
client_private=$(docker exec "$gateway" wg genkey)
client_public=$(printf '%s' "$client_private" | docker exec -i "$gateway" wg pubkey)
printf '%s' "$server_private" | docker exec -i "$gateway" sh -c 'umask 077; cat > /tmp/wg-private'
docker exec "$gateway" ip link add wg0 type wireguard
docker exec "$gateway" ip address add 10.66.0.1/24 dev wg0
docker exec "$gateway" wg set wg0 private-key /tmp/wg-private listen-port 51820 peer "$client_public" allowed-ips 10.66.0.2/32
docker exec "$gateway" ip link set wg0 up
docker exec "$gateway" iptables -t nat -A POSTROUTING -s 10.66.0.0/24 -o eth0 -j MASQUERADE
docker exec "$gateway" iptables -A FORWARD -i wg0 -j ACCEPT
docker exec "$gateway" iptables -A FORWARD -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
docker exec -d "$gateway" python3 -m http.server 8080 --bind 10.66.0.1
docker run -d --name "$vpn" --network "$net" --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  -e VPN_SERVICE_PROVIDER=custom -e VPN_TYPE=wireguard -e WIREGUARD_IMPLEMENTATION=kernelspace \
  -e WIREGUARD_PRIVATE_KEY="$client_private" -e WIREGUARD_PUBLIC_KEY="$server_public" \
  -e WIREGUARD_ADDRESSES=10.66.0.2/32 -e WIREGUARD_ENDPOINT_IP=172.30.90.2 -e WIREGUARD_ENDPOINT_PORT=51820 \
  -e WIREGUARD_ALLOWED_IPS=0.0.0.0/0 -e FIREWALL=on \
  -e 'HTTP_CONTROL_SERVER_AUTH_DEFAULT_ROLE={"auth":"none"}' qmcgaw/gluetun:v3.41.3 >/dev/null
docker run -d --name "$probe" --network "container:$vpn" --cap-drop ALL hoardarr-network-test >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$probe" curl --fail --silent --connect-timeout 2 --max-time 3 http://10.66.0.1:8080 >/dev/null; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
docker exec "$probe" curl --silent --connect-timeout 3 --max-time 10 http://1.1.1.1 >/dev/null
docker exec "$probe" dig +time=3 +tries=1 @1.1.1.1 example.com A | grep -q 'status: NOERROR'
echo 'Tunnel, IPv4 egress and DNS work through the gateway'
blocked() {
  if docker exec "$probe" curl --silent --connect-timeout 2 --max-time 4 http://1.1.1.1 >/dev/null; then echo 'IPv4 traffic escaped a failed tunnel'; exit 1; fi
  if docker exec "$probe" curl -6 --silent --connect-timeout 2 --max-time 4 'http://[2606:4700:4700::1111]' >/dev/null; then echo 'IPv6 traffic escaped'; exit 1; fi
  if docker exec "$probe" dig +time=1 +tries=1 @1.1.1.1 "$(date +%s).example.com" A | grep -q 'status:'; then echo 'External DNS escaped'; exit 1; fi
  # Resolver configuration must not send queries through Docker's host-side DNS proxy.
  if docker exec "$probe" cat /etc/resolv.conf | grep -q 'nameserver 127.0.0.11'; then echo 'Docker DNS proxy bypasses VPN boundary'; exit 1; fi
}
# Remote tunnel loss must not reopen the default route.
docker exec "$gateway" ip link set wg0 down
blocked
docker exec "$gateway" ip link set wg0 up
for attempt in $(seq 1 20); do
  if docker exec "$probe" curl --fail --silent --max-time 3 http://10.66.0.1:8080 >/dev/null; then break; fi
  sleep 1
done
docker exec "$probe" curl --fail --silent --max-time 5 http://10.66.0.1:8080 >/dev/null
# Administrative tunnel shutdown keeps the firewall and local control channel available.
docker exec "$probe" curl --fail --silent -X PUT -H 'Content-Type: application/json' -d '{"status":"stopped"}' http://127.0.0.1:8000/v1/vpn/status >/dev/null
sleep 2
blocked
docker exec "$probe" curl --fail --silent http://127.0.0.1:8000/v1/vpn/status | grep -q stopped
docker stop "$vpn" >/dev/null
blocked
echo 'Verified tunnel loss, recovery, administrative stop, daemon stop, IPv4, IPv6 and DNS fail-closed behavior'
