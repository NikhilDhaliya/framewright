// Rasterizes resources/icon.svg into resources/icon.png (1024), resources/icons/<n>x<n>.png and the mcpb icon.
// Run headless (never on the real display):
//   env -u WAYLAND_DISPLAY xvfb-run -a npx electron scripts/icons/render-icons.cjs --ozone-platform=x11
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '../..')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

async function render(svg, size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`
  const file = path.join(os.tmpdir(), `framewright-icon-${process.pid}-${size}.html`)
  fs.writeFileSync(file, html)
  await win.loadFile(file)
  fs.rmSync(file, { force: true })
  await win.webContents.executeJavaScript('document.images[0].decode().then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))')
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  win.destroy()
  return img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' })
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {}) // keep running between per-size windows
app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(path.join(root, 'resources/icon.svg'), 'utf8')
    const outDir = path.join(root, 'resources/icons')
    fs.mkdirSync(outDir, { recursive: true })
    for (const size of SIZES) {
      // Draw small sizes from a 4x render so thin strokes stay crisp after the box filter.
      const big = size < 256 ? await render(svg, size * 4) : await render(svg, size)
      const img = big.getSize().width === size ? big : big.resize({ width: size, height: size, quality: 'best' })
      fs.writeFileSync(path.join(outDir, `${size}x${size}.png`), img.toPNG())
      if (size === 1024) fs.writeFileSync(path.join(root, 'resources/icon.png'), img.toPNG())
      if (size === 512) fs.writeFileSync(path.join(root, 'resources/mcpb/icon.png'), img.toPNG())
      console.log(`wrote ${size}x${size}`)
    }
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  app.quit()
})
