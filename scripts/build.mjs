import { build as esbuild, context as esbuildContext } from 'esbuild'
import { build as viteBuild } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const nodeTargets = [
  { entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(root, 'out/main/index.cjs') },
  { entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(root, 'out/preload/index.cjs') },
  { entryPoints: [path.join(root, 'src/main/render/smokeMain.ts')], outfile: path.join(root, 'out/main/smoke.cjs') },
  { entryPoints: [path.join(root, 'src/main/ml/audio/correlateWorker.ts')], outfile: path.join(root, 'out/main/correlateWorker.cjs') },
  { entryPoints: [path.join(root, 'src/main/ml/search/worker.ts')], outfile: path.join(root, 'out/main/searchWorker.cjs') },
  { entryPoints: [path.join(root, 'src/main/ml/audio/speakerWorker.ts')], outfile: path.join(root, 'out/main/speakerWorker.cjs') },
]

export function nodeOptions(target, { dev = false } = {}) {
  return {
    ...target,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: dev ? 'inline' : false,
    external: ['electron', 'ffmpeg-static', 'onnxruntime-node', 'sherpa-onnx-node'],
    define: { 'process.env.PALMIER_DEV': JSON.stringify(dev ? '1' : '') },
    logLevel: 'warning',
  }
}

export async function buildNode({ dev = false } = {}) {
  await Promise.all(nodeTargets.map((t) => esbuild(nodeOptions(t, { dev }))))
}

export async function watchNode(onRebuild) {
  return Promise.all(
    nodeTargets.map(async (t) => {
      const ctx = await esbuildContext({
        ...nodeOptions(t, { dev: true }),
        plugins: [{ name: 'notify', setup: (b) => b.onEnd((r) => r.errors.length === 0 && onRebuild?.()) }],
      })
      await ctx.watch()
      return ctx
    }),
  )
}

export async function buildRenderer() {
  await viteBuild({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn' })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await Promise.all([buildNode(), buildRenderer()])
  console.log('build complete → out/')
}
