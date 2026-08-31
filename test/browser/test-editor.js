const d = require('./cdp.js');
const fs = require('fs');
let fails = 0;
const check = (l, ok, det) => { console.log((ok ? 'PASS ' : 'FAIL ') + l + (ok ? '' : '  -> ' + JSON.stringify(det))); if (!ok) fails++; };
const ev = (x) => d.evaluate(x);

(async () => {
	await d.connect();
	await d.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
	await d.navigate('http://10.9.0.133/cgi-bin/luci/');
	await ev(d.HELPERS);
	await ev(`(() => { const u = document.querySelector('input[name=luci_username]'); if (!u) return 0;
		u.value='root'; document.querySelector('input[name=luci_password]').value=''; u.form.submit(); return 1 })()`);
	await new Promise(r => setTimeout(r, 2500));
	await d.navigate('http://10.9.0.133/cgi-bin/luci/admin/network/network');
	await ev(d.HELPERS);

	/* open wg0 -> Peers tab */
	await ev(`(async () => {
		const row = await __wait(() => [...document.querySelectorAll('tr.cbi-section-table-row')].find(r => /^wg0/.test(r.textContent.trim())), 15000);
		row.querySelector('.cbi-button-edit').click();
		await __wait(() => document.querySelector('.modal .cbi-map'));
		/* the tab handler sits on the anchor: clicking the <li> leaves the pane hidden */
		(await __wait(() => [...document.querySelectorAll('.modal ul.cbi-tabmenu li > a')].find(a => a.textContent.trim() == 'Peers'))).click();
		await __wait(() => __find('.modal ul.cbi-tabmenu li.cbi-tab', '^Peers$'));
		await __wait(() => __find('.modal button, .modal .btn', 'Add peer'));
		return 1;
	})()`);

	check('Edit defaults button on the peers tab', await ev(`!!__find('.modal button', 'Edit defaults')`), 'missing');

	/* open the editor from the peers tab */
	await ev(`(async () => { __find('.modal button', 'Edit defaults').click();
		await __wait(() => __find('.modal button', 'Save defaults'), 10000); return 1 })()`);

	const shown = await ev(`(() => {
		const fields = {};
		for (const el of document.querySelectorAll('.modal [id^="cbid.json."]')) {
			const name = el.id.replace('cbid.json.', '');
			const inputs = [...el.querySelectorAll('input')].filter(i => i.type !== 'button');
			if (!inputs.length) continue;
			fields[name] = inputs.map(i => i.type === 'checkbox' ? i.checked : i.value).filter(v => v !== '' && v !== false);
		}
		return { fields, headline: document.querySelector('.modal h4').textContent.trim(),
			mapHidden: document.querySelector('.modal .cbi-map').style.display === 'none',
			legends: [...document.querySelectorAll('.modal legend, .modal h3')].map(l => l.textContent.trim()) };
	})()`);
	console.log(JSON.stringify(shown, null, 1));
	check('breadcrumb shows the sub-view', /Edit defaults$/.test(shown.headline), shown.headline);
	check('underlying dialog hidden', shown.mapHidden === true, shown);
	check('both groups rendered', shown.legends.some(l => /new peers/.test(l)) && shown.legends.some(l => /client configuration/.test(l)), shown.legends);
	check('peer endpoint prefilled from uci', shown.fields['peer.endpoint_host']?.[0] === 'peer.example.com', shown.fields['peer.endpoint_host']);
	check('peer flags prefilled', shown.fields['peer.generate_keys']?.[0] === true && shown.fields['peer.generate_psk']?.[0] === true, shown.fields);
	check('client mtu prefilled', shown.fields['client.mtu']?.[0] === '1380', shown.fields['client.mtu']);
	check('client allowed_ips prefilled as a list', JSON.stringify(shown.fields['client.allowed_ips']) === JSON.stringify(['10.10.11.0/24','10.0.0.0/24']), shown.fields['client.allowed_ips']);

	fs.writeFileSync(process.argv[2], Buffer.from((await d.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

	/* validation guard */
	await ev(`(async () => {
		const el = document.querySelector('[id="cbid.json.client.mtu"] input');
		el.value = '99999'; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur();
		await new Promise(r => setTimeout(r, 400));
		__find('.modal button', 'Save defaults').click();
		await new Promise(r => setTimeout(r, 800));
		return 1;
	})()`);
	check('invalid value keeps the sub-view open', await ev(`!!__find('.modal button', 'Save defaults')`), 'sub-view closed on an invalid value');
	check('invalid value blocks saving and says which field',
		await ev(`!!document.querySelector('.modal .edit-defaults-error') && /MTU/.test(document.querySelector('.modal .edit-defaults-error').textContent)`),
		await ev(`document.querySelector('.modal .edit-defaults-error')?.textContent ?? 'no error shown'`));

	/* fix it, change a value, save */
	await ev(`(async () => {
		const mtu = document.querySelector('[id="cbid.json.client.mtu"] input');
		mtu.value = '1400'; mtu.dispatchEvent(new Event('input', { bubbles: true })); mtu.blur();
		const kp = document.querySelector('[id="cbid.json.peer.persistent_keepalive"] input');
		kp.value = '30'; kp.dispatchEvent(new Event('input', { bubbles: true })); kp.blur();
		const psk = document.querySelector('[id="cbid.json.peer.generate_psk"] input[type=checkbox]');
		psk.click();
		await new Promise(r => setTimeout(r, 400));
		__find('.modal button', 'Save defaults').click();
		await new Promise(r => setTimeout(r, 2500));
		return 1;
	})()`);
	check('sub-view closed after saving', await ev(`!__find('.modal button', 'Save defaults') && document.querySelector('.modal .cbi-map').style.display !== 'none'`), 'still open');
	check('breadcrumb restored', await ev(`!/Edit defaults$/.test(document.querySelector('.modal h4').textContent.trim())`), await ev(`document.querySelector('.modal h4').textContent`));

	/* the values must have reached the session on the router, not just the client cache */
	const server = await ev(`(async () => {
		const ask = (option) => fetch('/ubus', { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call',
				params: [ L.env.sessionid, 'uci', 'get', { config: 'network', section: 'wg0', option } ] }) })
			.then(r => r.json()).then(r => r.result?.[1]?.value ?? null);
		return { client_mtu: await ask('client_mtu'), peer_persistent_keepalive: await ask('peer_persistent_keepalive'), peer_generate_psk: await ask('peer_generate_psk') };
	})()`, true);
	console.log('server side after save: ' + JSON.stringify(server));
	check('edited MTU stored on the router', server.client_mtu === '1400', server);
	check('edited keepalive stored on the router', server.peer_persistent_keepalive === '30', server);
	check('unchecked flag removed on the router', server.peer_generate_psk === null, server);

	/* put the defaults back the way they were */
	await ev(`(async () => {
		__find('.modal button', 'Edit defaults').click();
		await __wait(() => __find('.modal button', 'Save defaults'), 10000);
		const set = (id, v) => { const el = document.querySelector('[id="cbid.json.' + id + '"] input'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); };
		set('client.mtu', '1380');
		set('peer.persistent_keepalive', '25');
		document.querySelector('[id="cbid.json.peer.generate_psk"] input[type=checkbox]').click();
		await new Promise(r => setTimeout(r, 400));
		__find('.modal button', 'Save defaults').click();
		await new Promise(r => setTimeout(r, 2500));
		return 1;
	})()`);
	console.log('restored: ' + JSON.stringify(await ev(`(async () => {
		const ask = (option) => fetch('/ubus', { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ L.env.sessionid, 'uci', 'get', { config: 'network', section: 'wg0', option } ] }) })
			.then(r => r.json()).then(r => r.result?.[1]?.value ?? null);
		return { client_mtu: await ask('client_mtu'), peer_persistent_keepalive: await ask('peer_persistent_keepalive'), peer_generate_psk: await ask('peer_generate_psk') };
	})()`, true)));

	console.log('\n== console ==\n' + (d.logs.filter(l => !/file\/list|uci\/get/.test(l)).join('\n') || '(no errors)'));
	console.log(fails ? `\n${fails} FAILURE(S)` : '\nall editor checks passed');
	d.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('DRIVER ERROR:', e.message); console.error(d.logs.join('\n')); d.close(); process.exit(1); });
