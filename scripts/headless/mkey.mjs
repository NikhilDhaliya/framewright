// usage: node mkey.mjs <cdpPort> <keyCode> [mods]  — real key event through webContents.sendInputEvent (fires menu accelerators)
// mods: comma list of control,shift,alt,meta
const [port, keyCode, mods] = process.argv.slice(2)
const list = await (await fetch(`http://127.0.0.1:${+port + 1000}/json/list`)).json()
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
const modifiers = JSON.stringify(mods ? mods.split(',') : [])
const expr = `(() => { const { BrowserWindow } = process.mainModule.require('electron'); const w = BrowserWindow.getAllWindows().find((x) => x.isVisible()); w.focus();
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${modifiers} });
  ${keyCode.length === 1 ? `w.webContents.sendInputEvent({ type: 'char', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${modifiers} });` : ''}
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${modifiers} }); return 'sent' })()`
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d.result ?? d.error)); ws.close(); process.exit(0) } }
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, includeCommandLineAPI: true } }))
