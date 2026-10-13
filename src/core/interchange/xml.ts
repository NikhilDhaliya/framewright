/**
 * Minimal XML element tree shared by the XMEML and FCPXML exporters (spec 07 §6): the renderer owns all indentation
 * and escaping, so the exporters never hand-write whitespace.
 */

export interface XmlNode {
  name: string
  attrs: [string, string][]
  text?: string
  children: XmlNode[]
}

export type XmlChild = XmlNode | null | undefined | false

const compact = (children: XmlChild[]): XmlNode[] => children.filter((c): c is XmlNode => !!c)

/** Element with attributes (insertion order) and children; null/undefined/false children are skipped. */
export function el(name: string, attrs: [string, string][] = [], children: XmlChild[] = []): XmlNode {
  return { name, attrs, children: compact(children) }
}

/** Element with children only. */
export const node = (name: string, children: XmlChild[] = []): XmlNode => el(name, [], children)

/** Text-only element; integers print like Swift's `String(Int)`. */
export const leaf = (name: string, value: string | number): XmlNode => ({ name, attrs: [], text: String(value), children: [] })

/** Text element that also carries attributes. */
export const textEl = (name: string, attrs: [string, string][], text: string): XmlNode => ({ name, attrs, text, children: [] })

/** FCP7 boolean element (`TRUE` / `FALSE`). */
export const bool = (name: string, value: boolean): XmlNode => leaf(name, value ? 'TRUE' : 'FALSE')

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function renderXml(n: XmlNode, indent = 0): string {
  const pad = ' '.repeat(indent)
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')
  if (n.text !== undefined) return `${pad}<${n.name}${attrs}>${escapeXml(n.text)}</${n.name}>`
  if (n.children.length === 0) return `${pad}<${n.name}${attrs}/>`
  const inner = n.children.map((c) => renderXml(c, indent + 2)).join('\n')
  return `${pad}<${n.name}${attrs}>\n${inner}\n${pad}</${n.name}>`
}

/** Prolog + doctype + root; no trailing newline. */
export function renderDocument(doctype: string, root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ${doctype}>\n${renderXml(root, 0)}`
}
