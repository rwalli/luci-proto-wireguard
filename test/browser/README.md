# Browser test for the peer dialog

Drives a real LuCI session in headless Chrome and checks the *Load defaults*
button and the configuration export end to end. Not part of the package —
`luci.mk` only installs `htdocs/` and `root/`.

## Setup (no root beyond the shared libraries, no X server)

    # one-off: the libraries chrome links against
    sudo apt-get install -y libnss3 libatk-bridge2.0-0 libxcomposite1 libxdamage1

    # one-off: a headless chrome, unpacked wherever you run this from
    npx --yes @puppeteer/browsers install chrome-headless-shell@stable

`cdp.js` speaks the DevTools protocol over node's built-in WebSocket, so there
is nothing to `npm install`.

## Run

    cat htdocs/luci-static/resources/protocol/wireguard.js \
        | ssh root@10.9.0.133 'cat > /www/luci-static/resources/protocol/wireguard.js'

    CHROME=./chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell \
        node test/browser/test-full.js      # Load defaults + configuration export
    CHROME=… node test/browser/test-editor.js shot.png   # the Edit defaults dialog

`test-full.js` takes the host addresses already in use in `USED` (comma separated) so it can tell a
freshly calculated address from an occupied one:

    USED=$(ssh root@10.9.0.133 "uci show network | sed -n 's/.*allowed_ips=//p' \
        | tr -d \"'\" | tr ' ' '\n' | sed 's#/32$##' | tr '\n' ','")

The test assumes the router at `10.9.0.133` with a blank root password, a `wg0`
interface holding `10.10.11.1/24`, and the `peer_*` / `client_*` defaults set on
it. It expects a clean peer list — reset with:

    ssh root@10.9.0.133 'uci export network > /root/network.bak; \
        while uci -q delete network.@wireguard_wg0[0]; do :; done; \
        uci commit network; /etc/init.d/rpcd restart'

Peers added through the dialog are staged in the *LuCI session*, not in
`/etc/config/network`, so `uci changes` over ssh will not show them; restarting
`rpcd` drops them.
