/** Node built-ins inside the render host (nodeIntegration window; the Vite bundle cannot import them). */
type NodeRequire = (id: string) => unknown

const nodeRequire = (globalThis as { require?: NodeRequire }).require
if (!nodeRequire) throw new Error('The render host needs nodeIntegration')

export const childProcess = nodeRequire('child_process') as typeof import('node:child_process')
export const fsp = nodeRequire('fs/promises') as typeof import('node:fs/promises')
export const electron = nodeRequire('electron') as typeof import('electron')
