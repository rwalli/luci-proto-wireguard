const d = require('./cdp.js');
const HOST = 'http://10.9.0.133';
let fails = 0;
const check = (label, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '  -> ' + JSON.stringify(detail))); if (!ok) fails++; };

const ev = (x) => d.evaluate(x);
const modalFields = `(() => {
	const map = document.querySelector('.modal .cbi-map:not(.hidden)');
	const out = {};
	for (const el of map.querySelectorAll('[id^="cbid."]')) {
		const name = el.id.replace(/^cbid\\.network\\.[^.]+\\./, '');
		const inputs = [...el.querySelectorAll('input, select, textarea')].filter(i => i.type !== 'button');
		if (!inputs.length) continue;
		out[name] = inputs.map(i => i.type === 'checkbox' ? i.checked : i.value).filter(v => v !== '' && v !== false);
	}
	return out;
})()`;

(async () => {
	await d.connect();
	await d.navigate(HOST + '/cgi-bin/luci/');
	await ev(d.HELPERS);
	await ev(`(() => { const u = document.querySelector('input[name=luci_username]'); if (!u) return 0;
		u.value = 'root'; document.querySelector('input[name=luci_password]').value = ''; u.form.submit(); return 1; })()`);
	await new Promise(r => setTimeout(r, 2500));
	await d.navigate(HOST + '/cgi-bin/luci/admin/network/network');
	await ev(d.HELPERS);

	const openPeerDialog = async () => {
		console.log('   [open peer dialog] ' + await ev(`(async () => {
			if (!document.querySelector('.modal .cbi-map')) {
				const row = await __wait(() => [...document.querySelectorAll('tr.cbi-section-table-row')].find(r => /^wg0/.test(r.textContent.trim())), 15000);
				row.querySelector('.cbi-button-edit').click();
				await __wait(() => document.querySelector('.modal .cbi-map'));
			}
			(await __wait(() => __find('.cbi-tab, .cbi-tab-disabled, li a', '^\\\\s*Peers'))).click();
			(await __wait(() => __find('.modal button, .modal .btn', 'Add peer'))).click();
			await __wait(() => document.querySelectorAll('.modal .cbi-map').length > 1);
			await __wait(() => document.querySelector('.modal button.load-defaults'));
			return 'ok';
		})().catch(e => 'STUCK: ' + e.message + ' | modals=' + document.querySelectorAll('.modal .cbi-map').length
			+ ' | tabs=' + [...document.querySelectorAll('.cbi-tab, .cbi-tab-disabled')].map(t => t.textContent.trim()).join(',')
			+ ' | buttons=' + [...document.querySelectorAll('.modal button, .modal .btn')].map(b => b.textContent.trim()).slice(0, 12).join(','))`));
	};

	/* ---- peer 1 ---------------------------------------------------------- */
	await openPeerDialog();
	await ev(`window.__confirms = []; window.__confirmAnswer = false; window.confirm = (m) => { window.__confirms.push(m); return window.__confirmAnswer; }; 1`);
	await ev(`(async () => { document.querySelector('.modal button.load-defaults').click(); await new Promise(r => setTimeout(r, 1200)); return 1 })()`);
	let f = await ev(modalFields);
	const used = (process.env.USED || '').split(',').filter(Boolean);
	const isFreeHost = (v) => /^10\.10\.11\.\d+\/32$/.test(v) && !used.includes(v.split('/')[0]) && v !== '10.10.11.1/32';
	check('peer 1: unused host address prepended to the configured route',
		isFreeHost(f.allowed_ips?.[0]) && f.allowed_ips?.[1] === '10.0.0.0/24', { got: f.allowed_ips, used });
	check('peer 1: endpoint host + port', f.endpoint_host?.[0] === 'peer.example.com' && f.endpoint_port?.[0] === '5559', [f.endpoint_host, f.endpoint_port]);
	check('peer 1: keepalive + route flag', f.persistent_keepalive?.[0] === '25' && f.route_allowed_ips?.[0] === true, [f.persistent_keepalive, f.route_allowed_ips]);
	check('peer 1: key pair generated', /^[A-Za-z0-9+/]{43}=$/.test(f.private_key?.[0] ?? '') && /^[A-Za-z0-9+/]{43}=$/.test(f.public_key?.[0] ?? ''), f.private_key);
	check('peer 1: psk generated', /^[A-Za-z0-9+/]{43}=$/.test(f.preshared_key?.[0] ?? ''), f.preshared_key);
	check('peer 1: no confirm on a fresh peer', (await ev(`window.__confirms.length`)) === 0, await ev(`window.__confirms`));

	/* re-press with values in place -> confirm, cancel keeps everything */
	await ev(`window.__confirmAnswer = false; 1`);
	await ev(`(async () => { document.querySelector('.modal button.load-defaults').click(); await new Promise(r => setTimeout(r, 800)); return 1 })()`);
	const confirms = await ev(`window.__confirms`);
	check('re-press asks for confirmation', confirms.length === 1 && /Overwrite \d+ already filled/.test(confirms[0]), confirms);
	const f2 = await ev(modalFields);
	check('cancel keeps the generated private key', f2.private_key?.[0] === f.private_key?.[0], [f.private_key, f2.private_key]);

	const priv1 = f.private_key[0];
	await ev(`(async () => { __find('.modal div.button-row button', '^Save$').click(); await new Promise(r => setTimeout(r, 1500)); return 1 })()`);
	check('button removed from the shared row after closing the peer dialog',
		(await ev(`!document.querySelector('.modal button.load-defaults')`)) === true,
		await ev(`[...document.querySelectorAll('.modal div.button-row button')].map(b => b.textContent)`));

	console.log('   peers grid now: ' + JSON.stringify(await ev(`[...document.querySelectorAll('.modal .cbi-section-table-row, .modal tr.cbi-section-table-row')].map(r => r.textContent.trim().replace(/\\s+/g, ' ').slice(0, 70))`)));

	/* ---- peer 2: the unsaved peer 1 must already count as occupied -------- */
	await openPeerDialog();
	await ev(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return false }; 1`);
	await ev(`(async () => { document.querySelector('.modal button.load-defaults').click(); await new Promise(r => setTimeout(r, 1200)); return 1 })()`);
	const g = await ev(modalFields);
	check('peer 2: different unused address, staged peer 1 counted',
		isFreeHost(g.allowed_ips?.[0]) && g.allowed_ips[0] !== f.allowed_ips[0] && g.allowed_ips?.[1] === '10.0.0.0/24',
		{ peer1: f.allowed_ips, peer2: g.allowed_ips });
	check('skipped defaults warned about inside the dialog, above the overlay', await ev(`(() => {
		const n = document.querySelector('.modal .cbi-map:not(.hidden) .load-defaults-warning');
		if (!n) return false;
		const r = n.getBoundingClientRect();
		return n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 10)) && /peer_mtu/.test(n.textContent);
	})()`), 'no visible in-dialog warning');

	check('peer 2: fresh key pair, different from peer 1', g.private_key?.[0] && g.private_key[0] !== priv1, [priv1, g.private_key]);

	/* ---- export dialog --------------------------------------------------- */
	await ev(`(async () => {
		const b = await __wait(() => document.querySelector('.modal .btn.qr-code'));
		if (b.disabled) return 'disabled';
		b.click();
		await __wait(() => document.querySelector('.modal pre.client-config'), 15000);
		await new Promise(r => setTimeout(r, 800));
		return 1;
	})()`);
	const conf = await ev(`document.querySelector('.modal pre.client-config').textContent`);
	console.log('--- generated client config ---\n' + conf + '\n------------------------------');
	check('export: MTU from client_mtu', /^MTU = 1380$/m.test(conf), conf);
	check('export: DNS from client_dns', /^DNS = 10\.10\.11\.1$/m.test(conf), conf);
	check('export: endpoint from client_endpoint_host/port', /^Endpoint = endpoint\.example\.com:1234$/m.test(conf), conf);
	check('export: AllowedIPs from client_allowed_ips', /^AllowedIPs = 10\.10\.11\.0\/24, 10\.0\.0\.0\/24$/m.test(conf), conf);
	check('export: keepalive from client_persistent_keepalive', /^PersistentKeepAlive = 25$/m.test(conf), conf);
	check('export: Address is the host entry only, routes dropped',
		new RegExp('^Address = ' + g.allowed_ips[0].replace(/[./]/g, '\\$&') + '$', 'm').test(conf) && !/^Address =.*10\.0\.0\.0/m.test(conf), conf);
	check('export: ListenPort falls back to the peer endpoint port', /^ListenPort = 5559$/m.test(conf), conf);
	const inputs = await ev(`[...document.querySelectorAll('.modal .cbi-map:not(.hidden) [id^="cbid."]')].map(e => e.id.split('.').pop())`);
	check('export: new inputs present', ['endpoint_port','mtu','keepalive'].every(n => inputs.includes(n)), inputs);

	console.log('   export dialog ids: ' + JSON.stringify(await ev(`[...document.querySelectorAll('.modal .cbi-map:not(.hidden) [id^="cbid."]')].map(e => e.id)`)));

	/* live edit of the MTU field must flow into the config text */
	await ev(`(async () => {
		const el = document.querySelector('.modal .cbi-map:not(.hidden) [id$=".mtu"] input');
		el.value = '1280';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		el.blur();
		await new Promise(r => setTimeout(r, 900));
		return 1;
	})()`);
	check('export: editing MTU updates the config text',
		/^MTU = 1280$/m.test(await ev(`document.querySelector('.modal pre.client-config').textContent`)),
		await ev(`document.querySelector('.modal pre.client-config').textContent`));

	console.log('\n== console ==\n' + (d.logs.filter(l => !/file\/list/.test(l)).join('\n') || '(no errors)'));
	console.log(fails ? `\n${fails} FAILURE(S)` : '\nall browser checks passed');
	d.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('DRIVER ERROR:', e.message); console.error(d.logs.join('\n')); d.close(); process.exit(1); });
