/* "Quick add peer" on the peers tab: one press creates a peer from the defaults. */
const d = require('./cdp.js');
const HOST = process.env.HOST || 'http://10.9.0.133';
let fails = 0;
const check = (l, ok, det) => { console.log((ok ? 'PASS ' : 'FAIL ') + l + (ok ? '' : '  -> ' + JSON.stringify(det))); if (!ok) fails++; };
const ev = (x) => d.evaluate(x);

/* the peer as it is staged in uci, read back through the page's own uci module */
const peerByDescription = (desc) => ev(`(async () => {
	const uci = await L.require('uci');
	const peers = uci.sections('network', 'wireguard_wg0');
	return peers.find(p => p.description === ${JSON.stringify(desc)}) ?? null;
})()`);

(async () => {
	await d.connect();
	/* the default headless viewport is small enough to push the warning band out of view */
	await d.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
	await d.navigate(HOST + '/cgi-bin/luci/');
	await ev(d.HELPERS);
	await ev(`(() => { const u = document.querySelector('input[name=luci_username]'); if (!u) return 0;
		u.value = 'root'; document.querySelector('input[name=luci_password]').value = ''; u.form.submit(); return 1 })()`);
	await new Promise(r => setTimeout(r, 2500));
	await d.navigate(HOST + '/cgi-bin/luci/admin/network/network');
	await ev(d.HELPERS);

	/* open wg0 -> Peers tab */
	await ev(`(async () => {
		const row = await __wait(() => [...document.querySelectorAll('tr.cbi-section-table-row')].find(r => /^wg0/.test(r.textContent.trim())), 15000);
		row.querySelector('.cbi-button-edit').click();
		await __wait(() => document.querySelector('.modal .cbi-map'));
		/* the tab handler sits on the anchor: clicking the <li> leaves the pane hidden */
		(await __wait(() => [...document.querySelectorAll('.modal ul.cbi-tabmenu li > a')].find(a => a.textContent.trim() == 'Peers'))).click();
		await __wait(() => __find('.modal ul.cbi-tabmenu li.cbi-tab', '^Peers$'));
		await __wait(() => document.querySelector('.modal button.quick-add-peer'), 10000);
		return 1;
	})()`);

	const row = await ev(`(() => {
		const btn = document.querySelector('.modal button.quick-add-peer');
		const inp = document.querySelector('.modal input.quick-add-description');
		return {
			order: [...btn.parentNode.children].map(e => (e.textContent || e.placeholder || '').trim()),
			enabled: !btn.disabled && !inp.disabled,
			placeholder: inp?.placeholder,
			besideDefaults: inp.previousElementSibling === btn && btn.previousElementSibling?.classList.contains('edit-defaults')
		};
	})()`);
	check('quick add button follows Edit defaults, the field follows the button', row.besideDefaults, row);
	check('both controls live', row.enabled, row);
	check('description field has a placeholder', /description/i.test(row.placeholder ?? ''), row);

	/* ---- pressing it with an empty field warns instead of adding ---------- */
	const countPeers = () => ev(`(async () => (await L.require('uci')).sections('network', 'wireguard_wg0').length)()`);
	const beforeEmpty = await countPeers();
	await ev(`(async () => {
		document.querySelector('.modal input.quick-add-description').value = '   ';
		document.querySelector('.modal button.quick-add-peer').click();
		await new Promise(r => setTimeout(r, 1200));
		return 1;
	})()`);
	const emptyWarning = await ev(`(() => {
		const n = document.querySelector('.modal .cbi-map:not(.hidden) .quick-add-warning');
		if (!n) return null;
		n.scrollIntoView({ block: 'center' });
		const r = n.getBoundingClientRect();
		return { text: n.textContent, onTop: n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 10)) };
	})()`);
	check('an empty description warns, visibly', /description/i.test(emptyWarning?.text ?? '') && emptyWarning?.onTop === true, emptyWarning);
	check('an empty description adds no peer', (await countPeers()) === beforeEmpty, [beforeEmpty, await countPeers()]);
	check('the description field keeps the focus', await ev(`document.activeElement === document.querySelector('.modal input.quick-add-description')`), 'not focused');

	/* ---- one press -------------------------------------------------------- */
	const desc1 = 'Quick test ' + Date.now();
	const before = await countPeers();

	await ev(`(async () => {
		const inp = document.querySelector('.modal input.quick-add-description');
		inp.value = ${JSON.stringify(desc1)};
		document.querySelector('.modal button.quick-add-peer').click();
		await new Promise(r => setTimeout(r, 3000));
		return 1;
	})()`);

	const p1 = await peerByDescription(desc1);
	check('a peer was created', p1 != null, { before, after: await countPeers() });

	const used = (process.env.USED || '').split(',').filter(Boolean);
	const isFreeHost = (v) => /^10\.10\.11\.\d+\/32$/.test(v ?? '') && !used.includes(String(v).split('/')[0]) && v !== '10.10.11.1/32';

	check('allowed_ips: free host address ahead of the configured route',
		isFreeHost(p1?.allowed_ips?.[0]) && p1?.allowed_ips?.[1] === '10.0.0.0/24', p1?.allowed_ips);
	check('endpoint from the defaults', p1?.endpoint_host === 'peer.example.com' && p1?.endpoint_port === '5559', [p1?.endpoint_host, p1?.endpoint_port]);
	check('keepalive and route flag from the defaults', p1?.persistent_keepalive === '25' && p1?.route_allowed_ips === '1', [p1?.persistent_keepalive, p1?.route_allowed_ips]);
	check('key pair generated', /^[A-Za-z0-9+/]{43}=$/.test(p1?.private_key ?? '') && /^[A-Za-z0-9+/]{43}=$/.test(p1?.public_key ?? ''), p1?.private_key);
	check('preshared key generated', /^[A-Za-z0-9+/]{43}=$/.test(p1?.preshared_key ?? ''), p1?.preshared_key);
	check('no key material copied from the defaults', p1?.mtu === undefined, p1);

	check('the new peer shows up in the grid', await ev(`[...document.querySelectorAll('.modal tr.cbi-section-table-row')].some(r => r.textContent.includes(${JSON.stringify(desc1)}))`),
		await ev(`[...document.querySelectorAll('.modal tr.cbi-section-table-row')].map(r => r.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60))`));
	check('the description field is cleared again', (await ev(`document.querySelector('.modal input.quick-add-description').value`)) === '', 'still filled');
	/* with every default valid and peer_generate_keys on, nothing is left to warn about;
	   set UNKNOWN_DEFAULT (see test-full.js) to exercise the warning band instead */
	const unknown = process.env.UNKNOWN_DEFAULT;
	const warning = await ev(`document.querySelector('.modal .quick-add-warning')?.textContent ?? null`);
	check('the earlier warning is cleared by a successful add', unknown ? true : !/description/i.test(warning ?? ''), warning);
	check(unknown ? `skipped default ${unknown} warned about after a quick add` : 'no warning band for a clean set of defaults',
		unknown ? new RegExp(unknown).test(warning ?? '') : warning === null, warning);

	/* ---- second press: Enter in the field, next free address -------------- */
	const desc2 = 'Quick test B ' + Date.now();
	await ev(`(async () => {
		const inp = document.querySelector('.modal input.quick-add-description');
		inp.value = ${JSON.stringify(desc2)};
		inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await new Promise(r => setTimeout(r, 3000));
		return 1;
	})()`);

	const p2 = await peerByDescription(desc2);
	check('Enter in the description field adds a peer too', p2 != null, 'no second peer');
	check('the second peer gets a different free address',
		isFreeHost(p2?.allowed_ips?.[0]) && p2?.allowed_ips?.[0] !== p1?.allowed_ips?.[0], [p1?.allowed_ips, p2?.allowed_ips]);
	check('the second peer has its own key pair', p2?.private_key && p2.private_key !== p1?.private_key, 'same key');

	/* ---- the created peer opens and exports -------------------------------- */
	await ev(`(async () => {
		const row = [...document.querySelectorAll('.modal tr.cbi-section-table-row')].find(r => r.textContent.includes(${JSON.stringify(desc2)}));
		row.querySelector('.cbi-button-edit').click();
		await __wait(() => document.querySelectorAll('.modal .cbi-map').length > 1);
		await new Promise(r => setTimeout(r, 500));
		return 1;
	})()`);
	check('the quick-added peer can be exported right away',
		(await ev(`(() => { const b = document.querySelector('.modal .btn.qr-code'); return b ? !b.disabled : 'no button' })()`)) === true,
		'export button disabled');

	console.log('\n== console ==\n' + (d.logs.filter(l => !/file\/list/.test(l)).join('\n') || '(no errors)'));
	console.log(fails ? `\n${fails} FAILURE(S)` : '\nall quick add checks passed');
	d.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('DRIVER ERROR:', e.message); console.error(d.logs.join('\n')); d.close(); process.exit(1); });
