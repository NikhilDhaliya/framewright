/**
 * The Mac MCP contract (docs/port-spec/02-mcp-tools.tools.json) with only its product-name text rebranded.
 * Tool names, schemas, enums (`mode: 'palmier'`), `.palmier` paths and `palmier://models/*` resources are
 * unchanged. The two "sign in to Palmier and subscribe" sentences point at BYOK API keys instead, because this
 * build has no Palmier account. `REBRAND` is reversible: tests/mcp/brandedSpec.test.ts maps it back to the Mac text.
 */
import spec from '../../../docs/port-spec/02-mcp-tools.tools.json'
import { APP_NAME, APP_SLUG } from '../../shared/brand'

/** [Mac text, Linux text] pairs, applied to every string in the spec. */
export const REBRAND: readonly (readonly [string, string])[] = [
  ['connected to palmier-pro, an AI-native video editor', `connected to ${APP_SLUG}, an AI-native video editor`],
  ['ask the user to sign in to Palmier and   subscribe first.', 'ask the user to add an API key in Settings › Models & API Keys   first.'],
  ['tell the user to sign in to Palmier and subscribe before attempting them', 'tell the user to add an API key in Settings › Models & API Keys before attempting them'],
  ['Palmier project exports preserve them', `${APP_NAME} project exports preserve them`],
  ['readable by the Palmier process', `readable by the ${APP_NAME} process`],
  ['bug to the Palmier team', `bug to the ${APP_NAME} team`],
  ['close Palmier projects for this MCP session', `close ${APP_NAME} projects for this MCP session`],
]

const rebrandString = (s: string): string => REBRAND.reduce((acc, [mac, linux]) => acc.split(mac).join(linux), s)

function rebrand<T>(v: T): T {
  if (typeof v === 'string') return rebrandString(v) as T
  if (Array.isArray(v)) return v.map(rebrand) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebrand(x)])) as T
  return v
}

type Spec = typeof spec

/** Pure: the rebranded copy of a tools.json-shaped object (also used by tests). */
export function brandSpec(source: Spec): Spec {
  const out = rebrand(source)
  return { ...out, serverInfo: { ...out.serverInfo, name: APP_SLUG } }
}

export const BRANDED_SPEC: Spec = brandSpec(spec)
