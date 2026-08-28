/* Minimal Chrome DevTools Protocol driver: no npm deps, node 22 global WebSocket. */
const { spawn } = require('child_process');
const BIN = process.env.CHROME;
const PORT = 9333;

let id = 0, pending = new Map(), ws, proc;
const logs = [];

function send(method, params = {}) {
	return new Promise((res, rej) => {
		const msg = { id: ++id, method, params };
		pending.set(msg.id, { res, rej });
		ws.send(JSON.stringify(msg));
	});
}

async function connect() {
	proc = spawn(BIN, ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu',
		'--disable-dev-shm-usage', '--headless', 'about:blank'], { stdio: 'ignore' });
	let info;
	for (let i = 0; i < 60; i++) {
		try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (info.length) break; }
		catch (e) {}
		await new Promise(r => setTimeout(r, 250));
	}
	const page = info.find(t => t.type === 'page');
	ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise(r => ws.addEventListener('open', r));
	ws.addEventListener('message', ev => {
		const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) {
			const { res, rej } = pending.get(m.id); pending.delete(m.id);
			m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
		}
		else if (m.method === 'Runtime.consoleAPICalled')
			logs.push('console.' + m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
		else if (m.method === 'Runtime.exceptionThrown')
			logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
	});
	await send('Runtime.enable');
	await send('Page.enable');
	await send('Network.enable');
}

async function evaluate(expression, awaitPromise = true) {
	const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
	if (r.exceptionDetails)
		throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r.result.value;
}

async function navigate(url) {
	await send('Page.navigate', { url });
	await new Promise(r => setTimeout(r, 1500));
}

const HELPERS = `
window.__wait = (fn, timeout) => new Promise((res, rej) => {
	const t0 = Date.now();
	(function poll() {
		let v = null;
		try { v = fn(); } catch (e) {}
		if (v) return res(v);
		if (Date.now() - t0 > (timeout || 10000)) return rej(new Error('timeout waiting'));
		setTimeout(poll, 100);
	})();
});
window.__find = (sel, re) => [...document.querySelectorAll(sel)].find(e => new RegExp(re).test(e.textContent));
true;
`;

module.exports = { connect, send, evaluate, navigate, logs, HELPERS, close: () => { try { ws.close(); } catch (e) {} proc.kill(); } };
