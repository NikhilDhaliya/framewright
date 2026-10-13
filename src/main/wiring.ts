import { createExportService, type ExportServiceOptions } from './export/exportService'
import { startMcpServer, type McpServerHandle } from './mcp/server'
import { createRenderService } from './render/renderService'
import type { AppContext, ExportService, RenderService } from './services'

export type McpHandle = McpServerHandle

export interface Wiring {
  render: RenderService & { dispose(): Promise<void> }
  exporter: ExportService & { dispose(): void }
  startMcp(ctx: AppContext, opts: { port: number; host?: string }): Promise<McpHandle>
}

export function createWiring(opts: ExportServiceOptions = {}): Wiring {
  const render = createRenderService()
  return { render, exporter: createExportService(render, opts), startMcp: startMcpServer }
}
