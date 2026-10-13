// usage: node cdp.mjs <port> <cmd> [args...]   (target = first page whose url has index.html)
// cmds: shot <file> | eval <js> | click <x> <y> [mods] [count] | rclick <x> <y> | move <x> <y>
//       drag <x1> <y1> <x2> <y2> [mods] [steps] | dnd <x1> <y1> <x2> <y2> [mods] | key <key> [mods] | type <text>
//       wheel <x> <y> <dx> <dy> [mods] | targets | size <w> <h>
// mods: comma list of ctrl,shift,alt,meta
const [port, cmd, ...args] = process.argv.slice(2)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
if (cmd === 'targets') { console.log(list.map((t) => `${t.type} ${t.url}`).join('\n')); process.exit(0) }
const target = list.find((t) => t.type === 'page' && /index\.html|5199/.test(t.url)) ?? list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pending = new Map()
const listeners = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result) }
  else if (msg.method) listeners.forEach((l) => l(msg))
}
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
const modBits = (s) => (s || '').split(',').reduce((b, m) => b | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[m] || 0), 0)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: +x, y: +y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
const KEYS = { Enter: 13, Escape: 27, Backspace: 8, Delete: 46, Tab: 9, ' ': 32, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 }
try {
  switch (cmd) {
    case 'shot': {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      const fs = await import('node:fs'); fs.writeFileSync(args[0], Buffer.from(r.data, 'base64')); console.log('saved', args[0]); break
    }
    case 'eval': {
      const r = await send('Runtime.evaluate', { expression: args.join(' '), awaitPromise: true, returnByValue: true })
      console.log(r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails) : JSON.stringify(r.result.value)); break
    }
    case 'move': await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +args[0], y: +args[1], button: 'none', buttons: 0 }); break
    case 'click': {
      const [x, y, mods, count] = args; const modifiers = modBits(mods); const n = +(count || 1)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +x, y: +y, button: 'none', buttons: 0, modifiers })
      for (let c = 1; c <= n; c++) { await mouse('mousePressed', x, y, { modifiers, clickCount: c }); await mouse('mouseReleased', x, y, { modifiers, clickCount: c }) }
      break
    }
    case 'rclick': {
      const [x, y] = args
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: +x, y: +y, button: 'right', buttons: 2, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: +x, y: +y, button: 'right', buttons: 0, clickCount: 1 }); break
    }
    case 'drag': {
      const [x1, y1, x2, y2, mods, steps] = args; const modifiers = modBits(mods); const n = +(steps || 12)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +x1, y: +y1, button: 'none', buttons: 0, modifiers })
      await mouse('mousePressed', x1, y1, { modifiers })
      for (let i = 1; i <= n; i++) { await mouse('mouseMoved', +x1 + ((x2 - x1) * i) / n, +y1 + ((y2 - y1) * i) / n, { modifiers }); await wait(16) }
      if (process.env.HOLD_MS) await wait(+process.env.HOLD_MS)
      if (process.env.HOLD_SHOT) { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(process.env.HOLD_SHOT, Buffer.from(r.data, 'base64')) }
      await mouse('mouseReleased', x2, y2, { modifiers }); break
    }
    case 'dnd': {
      const [x1, y1, x2, y2, mods] = args; const modifiers = modBits(mods)
      await send('Input.setInterceptDrags', { enabled: true })
      const got = new Promise((r) => listeners.push((m) => m.method === 'Input.dragIntercepted' && r(m.params.data)))
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +x1, y: +y1, button: 'none', buttons: 0 })
      await mouse('mousePressed', x1, y1)
      for (let i = 1; i <= 6; i++) await mouse('mouseMoved', +x1 + i * 3, +y1 + i * 3)
      const data = await Promise.race([got, wait(2000).then(() => null)])
      if (!data) { console.log('no drag intercepted'); await mouse('mouseReleased', x1, y1); break }
      await send('Input.dispatchDragEvent', { type: 'dragEnter', x: +x2, y: +y2, data, modifiers })
      for (let i = 0; i < 3; i++) { await send('Input.dispatchDragEvent', { type: 'dragOver', x: +x2, y: +y2, data, modifiers }); await wait(30) }
      if (process.env.HOLD_MS) await wait(+process.env.HOLD_MS)
      if (process.env.HOLD_SHOT) { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(process.env.HOLD_SHOT, Buffer.from(r.data, 'base64')) }
      await send('Input.dispatchDragEvent', { type: 'drop', x: +x2, y: +y2, data, modifiers })
      await mouse('mouseReleased', x2, y2)
      await send('Input.setInterceptDrags', { enabled: false }); console.log('dropped'); break
    }
    case 'key': {
      const [key, mods] = args; const modifiers = modBits(mods)
      const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0)
      const text = key.length === 1 && !(modifiers & 6) ? key : key === 'Enter' ? '\r' : key === ' ' || key === 'Space' ? ' ' : undefined
      const k = key === 'Space' ? ' ' : key
      const codeName = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : undefined) : key === 'Space' ? 'Space' : key
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: codeName, windowsVirtualKeyCode: code, modifiers, text })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: codeName, windowsVirtualKeyCode: code, modifiers }); break
    }
    case 'type': await send('Input.insertText', { text: args.join(' ') }); break
    case 'wheel': {
      const [x, y, dx, dy, mods] = args
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: +x, y: +y, deltaX: +dx, deltaY: +dy, modifiers: modBits(mods) }); break
    }
    default: console.log('unknown cmd', cmd)
  }
} catch (e) { console.log('ERR', e.message) }
await wait(cmd === 'shot' || cmd === 'eval' ? 0 : 150)
ws.close(); process.exit(0)
