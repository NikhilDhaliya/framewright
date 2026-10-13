import { describe, expect, it } from 'vitest'
import spec from '../../docs/port-spec/02-mcp-tools.tools.json'
import { BRANDED_SPEC, REBRAND } from '../../src/main/mcp/brandedSpec'

const unbrand = (s: string): string => REBRAND.reduce((acc, [mac, linux]) => acc.split(linux).join(mac), s)

describe('rebranded MCP contract', () => {
  it('changes only product-name text (and the sign-in sentences) and keeps names, schemas and enums', () => {
    const branded = JSON.stringify({ ...BRANDED_SPEC, serverInfo: spec.serverInfo })
    expect(JSON.parse(unbrand(branded))).toEqual(spec)
    expect(BRANDED_SPEC.tools.map((t) => t.name)).toEqual(spec.tools.map((t) => t.name))
    expect(BRANDED_SPEC.serverInfo).toEqual({ name: 'framewright', version: spec.serverInfo.version })
  })

  it('applies every rewrite and leaves no Palmier product name behind', () => {
    const text = JSON.stringify({ ...BRANDED_SPEC, source: '' })
    for (const [mac, linux] of REBRAND) {
      expect(JSON.stringify(spec)).toContain(mac)
      expect(text).toContain(linux)
    }
    expect(text).not.toMatch(/Palmier|palmier-pro/)
    // Compatibility identifiers stay: the export mode enum and .palmier packages.
    expect(text).toContain('"enum":["video","xml","fcpxml","palmier"]')
    expect(text).toContain('.palmier path')
  })
})
