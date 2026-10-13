// usage: node meval.mjs <cdpPort> <js>  — evaluates in the Electron main process (require via process.mainModule.require)
const [port, ...rest] = process.argv.slice(2)
const list = await (await fetch(`http://127.0.0.1:${+port + 1000}/json/list`)).json()
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d.result?.exceptionDetails?.exception?.description ?? d.error)); ws.close(); process.exit(0) } }
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: rest.join(' '), awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }))
