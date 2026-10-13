# luci-proto-wireguard — with peer defaults

OpenWrt's LuCI WireGuard protocol handler, plus a way to stop retyping the same
values for every peer. Everything is configured once per interface in
`/etc/config/network` and pulled into the forms on demand.

* **Load defaults** in the peer dialog — fills the device-side peer fields and
  prepends a freshly calculated, unused tunnel address from the interface subnet
  (`/32`, plus `/128` when the interface has IPv6). Optionally generates the key
  pair and preshared key in the same press.
* **Quick add peer** on the peers tab — a description field and one button;
  creates the peer from the defaults without opening a dialog.
* **Edit defaults…** — a dialog for the defaults themselves, so they need not be
  hand-edited in `/etc/config/network`.
* **Generate configuration…** is prefilled from the client-side defaults and
  gained *Endpoint port*, *MTU* and *Keepalive* inputs, so those reach the
  generated `.conf`.

Everything else is stock. Only `htdocs/luci-static/resources/protocol/wireguard.js`
differs from upstream; the other five files are byte-identical to
[openwrt/luci](https://github.com/openwrt/luci/tree/master/protocols/luci-proto-wireguard).

## Quick install

The package ships a single JavaScript file that LuCI loads at runtime, so the
fast path is to replace that one file. No restart, no rebuild.

Run this **on the router**, at its own shell prompt:

```sh
RAW=https://raw.githubusercontent.com/rwalli/luci-proto-wireguard/main
JS=/www/luci-static/resources/protocol/wireguard.js

# keep the stock file so you can go back
cp "$JS" /root/wireguard.js.orig

# fetch next to it, then move into place, so a failed download cannot
# leave you with a truncated wireguard.js
wget -O /tmp/wireguard.js "$RAW/htdocs/luci-static/resources/protocol/wireguard.js" \
	&& mv /tmp/wireguard.js "$JS"
```

Then **hard-reload** the LuCI page (Ctrl-Shift-R) — LuCI caches JS aggressively
and a normal reload will keep serving the old file.

Set some defaults to have anything to load — see [examples](examples/):

```sh
wget -O /tmp/set-defaults.sh "$RAW/examples/set-defaults.sh" && sh /tmp/set-defaults.sh wg0
```

If `wget` fails on certificate verification, the router is missing the CA
bundle: `apk add ca-bundle` (or `opkg install ca-bundle`), then retry.

<details>
<summary>Installing from a checkout instead</summary>

```sh
ROUTER=root@192.168.1.1

ssh $ROUTER 'cp /www/luci-static/resources/protocol/wireguard.js \
                /root/wireguard.js.orig'

cat htdocs/luci-static/resources/protocol/wireguard.js \
    | ssh $ROUTER 'cat > /www/luci-static/resources/protocol/wireguard.js'

ssh $ROUTER 'sh -s wg0' < examples/set-defaults.sh
```

</details>

## Quick uninstall

Also on the router:

```sh
# back to the stock file
cp /root/wireguard.js.orig /www/luci-static/resources/protocol/wireguard.js
```

or let the package manager restore it:

```sh
apk fix luci-proto-wireguard                        # apk (24.10+)
opkg install --force-reinstall luci-proto-wireguard # opkg
```

Hard-reload again afterwards. The `peer_*` / `client_*` options left behind in
`/etc/config/network` are inert — netifd ignores them — but to clear them:

```sh
for o in $(uci show network.wg0 \
	| sed -n "s/^network\.wg0\.\(peer_[a-z_]*\)=.*/\1/p; s/^network\.wg0\.\(client_[a-z_]*\)=.*/\1/p"); do
		uci -q delete network.wg0.$o
done
uci commit network
```

Peers created while the feature was installed are ordinary peer sections and
keep working without it.

## Installing as a package

To build it into an image or an `.ipk`/`.apk`, drop the tree into an OpenWrt
build root or SDK as `feeds/luci/protocols/luci-proto-wireguard` (replacing the
stock one) and build `luci-proto-wireguard` as usual. The `Makefile` is
unchanged, so nothing else about the build differs.

## Configuring the defaults

Defaults live on the WireGuard interface section itself. Two prefixes, because
the same name means different things in each place:

| prefix | destination |
|---|---|
| `peer_*` | the peer dialog → `config wireguard_<iface>` on this router |
| `client_*` | the export dialog → the peer's own `.conf` |

Within `client_*` the key name decides the section: `client_dns`, `client_mtu`
and `client_listen_port` go to `[Interface]`, while `client_endpoint_host`,
`client_endpoint_port`, `client_allowed_ips` and `client_persistent_keepalive`
go to `[Peer]`.

`peer_generate_keys` and `peer_generate_psk` are flags rather than field values:
they decide whether a key pair and a preshared key are generated when defaults
are loaded or a peer is quick-added. Key material itself
(`peer_public_key`, `peer_private_key`, `peer_preshared_key`) is deliberately
ignored — it has no business being shared between peers. Any other `peer_*` name
that matches no peer field is named in a warning band, so typos are visible.

A full annotated example is in
[`examples/network.wg0.defaults`](examples/network.wg0.defaults), and
[`examples/set-defaults.sh`](examples/set-defaults.sh) applies it with `uci`.

### Two things worth knowing

* The peer's tunnel address is **required** in the router's `allowed_ips` for
  that peer — it is the cryptokey-routing filter, not just a route. That is why
  a free `/32` is always prepended.
* On the client, `AllowedIPs` is what it routes *into* the tunnel; its own
  address belongs in `[Interface] Address`. If `client_dns` points at the
  router's tunnel IP, that IP must be covered by `client_allowed_ips` or the
  peer connects but cannot resolve.

## Compatibility with the official LuCI snapshot

Last merged from `openwrt/luci` master on 2026-10-13, at upstream commit
`1a36248e` ("luci-proto-wireguard: add tunlink option", 2026-10-09):

* Five of the six package files are byte-identical to upstream; the only
  divergence is the feature work in `wireguard.js`, which carries every upstream
  change merged in — including the **Underlying interface** (`tunlink`) field on
  the General tab.
* Every luci-base API this uses is present in master — `addModalOptions`
  (same `(modalSection, section_id, ev)` signature and call site),
  `renderMoreOptionsModal`, `getActiveModalMap`, `triggerValidation`,
  `getValidationError`, `form.JSONMap`, `form.NamedSection`, `form.DynamicList`,
  `ui.createHandlerFn`, `uci.save`, `validation.parseIPv4` / `parseIPv6`.
* The two structural assumptions still hold in master's `form.js`: the modal's
  button row is `div.button-row` (shared with the parent dialog when stacked),
  and `CBITableSection.parse()` only parses children that are
  `editable && !modalonly` — which is what makes it safe for *Quick add peer* to
  write the new section straight to uci.
* Since the fork, luci-base master has no commits to `form.js`, `uci.js` or
  `validation.js`, and one to `ui.js` (a textarea scrolling fix, unrelated).

To re-sync later, diff the fork point against upstream and three-way merge:

```sh
git show 360a415:htdocs/luci-static/resources/protocol/wireguard.js > /tmp/base.js
curl -sfL https://raw.githubusercontent.com/openwrt/luci/master/protocols/\
luci-proto-wireguard/htdocs/luci-static/resources/protocol/wireguard.js > /tmp/upstream.js
git merge-file htdocs/luci-static/resources/protocol/wireguard.js /tmp/base.js /tmp/upstream.js
```

Our own hunks sit at the top of the file (the helpers) and from the peers
section down, so upstream changes to the interface tabs merge cleanly.

Tested on OpenWrt 25.12.0-rc4 with LuCI snapshot `26.029.67016`.

## Tests

`test/browser/` drives a real LuCI session in headless Chrome — see its
[README](test/browser/README.md). Not part of the package; `luci.mk` installs
only `htdocs/` and `root/`.

## License

Apache-2.0, as upstream.
