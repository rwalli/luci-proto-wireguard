#!/bin/sh
# Set the example peer/client defaults on a WireGuard interface.
#
#   sh set-defaults.sh [interface]        # default: wg0
#
# Run it on the router, or pipe it over ssh:
#
#   ssh root@router 'sh -s wg0' < examples/set-defaults.sh

IFACE="${1:-wg0}"

[ "$(uci -q get "network.$IFACE.proto")" = wireguard ] || {
	echo "network.$IFACE is not a wireguard interface" >&2
	exit 1
}

# defaults for a new peer (device side) -- the peer's own tunnel address is
# calculated from the interface subnet, so only the extra routes go here
uci -q delete "network.$IFACE.peer_allowed_ips"
uci add_list "network.$IFACE.peer_allowed_ips=10.0.0.0/24"
uci set "network.$IFACE.peer_route_allowed_ips=1"
uci set "network.$IFACE.peer_endpoint_host=peer.example.com"
uci set "network.$IFACE.peer_endpoint_port=5559"
uci set "network.$IFACE.peer_persistent_keepalive=25"
uci set "network.$IFACE.peer_generate_keys=1"
uci set "network.$IFACE.peer_generate_psk=1"

# defaults for the generated client configuration
uci set "network.$IFACE.client_dns=10.10.11.1"
uci set "network.$IFACE.client_mtu=1380"
uci set "network.$IFACE.client_endpoint_host=vpn.example.com"
uci set "network.$IFACE.client_endpoint_port=51820"
uci set "network.$IFACE.client_persistent_keepalive=25"
uci -q delete "network.$IFACE.client_allowed_ips"
uci add_list "network.$IFACE.client_allowed_ips=10.0.0.0/24"
uci add_list "network.$IFACE.client_allowed_ips=10.10.11.1/32"

uci commit network
uci show "network.$IFACE" | grep -E '\.(peer|client)_'

# LuCI caches uci per session; drop open sessions so the new defaults show up
/etc/init.d/rpcd restart
