/**
 * Who is editing (Mac `Analytics.origin` task-local): edits made while an in-app agent or MCP tool runs carry
 * its origin through every await, so the session can tell agent edits from the user's own.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type EditOrigin = 'user' | 'agent' | 'mcp'

const store = new AsyncLocalStorage<EditOrigin>()

export const withEditOrigin = <T>(origin: EditOrigin, fn: () => T): T => store.run(origin, fn)

export const currentEditOrigin = (): EditOrigin => store.getStore() ?? 'user'

export const isAgentOrigin = (o: EditOrigin = currentEditOrigin()): boolean => o === 'agent' || o === 'mcp'
