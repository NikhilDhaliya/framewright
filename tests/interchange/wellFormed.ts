// Strict parser for the XML subset the exporters write (prolog, doctype, elements, attributes, escaped text), used
// to prove documents are well-formed and round-trip through the writer; plus an expat check via python3 when present.
import { execFileSync } from 'node:child_process'
import { renderDocument, type XmlNode } from '../../src/core/interchange'

const NAME = /^[A-Za-z_:][\w.:-]*/
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescape(raw: string, at: number): string {
  return raw.replace(/&([^;]*);|&/g, (m, name: string | undefined) => {
    if (name === undefined || !(name in ENTITIES)) throw new Error(`Bad entity ${m} near ${at}`)
    return ENTITIES[name]
  })
}

export function parseXmlDocument(doc: string): { doctype: string; root: XmlNode } {
  const prolog = '<?xml version="1.0" encoding="UTF-8"?>\n'
  if (!doc.startsWith(prolog)) throw new Error('Missing XML declaration')
  let i = prolog.length
  const dt = /^<!DOCTYPE ([A-Za-z]+)>\n/.exec(doc.slice(i))
  if (!dt) throw new Error('Missing DOCTYPE')
  i += dt[0].length

  const skipWs = () => {
    while (i < doc.length && /\s/.test(doc[i])) i++
  }
  const element = (): XmlNode => {
    if (doc[i] !== '<') throw new Error(`Expected < at ${i}`)
    i++
    const nm = NAME.exec(doc.slice(i))
    if (!nm) throw new Error(`Bad element name at ${i}`)
    const name = nm[0]
    i += name.length
    const attrs: [string, string][] = []
    for (;;) {
      const ws = /^\s*/.exec(doc.slice(i))![0]
      i += ws.length
      if (doc.startsWith('/>', i)) {
        i += 2
        return { name, attrs, children: [] }
      }
      if (doc[i] === '>') {
        i++
        break
      }
      if (!ws) throw new Error(`Expected whitespace before attribute at ${i}`)
      const an = NAME.exec(doc.slice(i))
      if (!an) throw new Error(`Bad attribute name at ${i}`)
      i += an[0].length
      if (doc[i] !== '=' || doc[i + 1] !== '"') throw new Error(`Expected ="value" at ${i}`)
      const end = doc.indexOf('"', i + 2)
      const raw = doc.slice(i + 2, end)
      if (end < 0 || raw.includes('<')) throw new Error(`Bad attribute value at ${i}`)
      if (attrs.some(([k]) => k === an[0])) throw new Error(`Duplicate attribute ${an[0]} at ${i}`)
      attrs.push([an[0], unescape(raw, i)])
      i = end + 1
    }
    const children: XmlNode[] = []
    let text = ''
    for (;;) {
      if (doc.startsWith('</', i)) {
        const close = `</${name}>`
        if (!doc.startsWith(close, i)) throw new Error(`Mismatched close for <${name}> at ${i}`)
        i += close.length
        if (children.length && text.trim()) throw new Error(`Mixed content in <${name}>`)
        return children.length ? { name, attrs, children } : { name, attrs, text: unescape(text, i), children: [] }
      }
      if (doc[i] === '<') {
        children.push(element())
        continue
      }
      if (i >= doc.length) throw new Error(`Unclosed <${name}>`)
      text += doc[i++]
    }
  }
  const root = element()
  skipWs()
  if (i !== doc.length) throw new Error(`Trailing content at ${i}`)
  return { doctype: dt[1], root }
}

/** Parses the document strictly and re-renders it; returns the parsed tree. */
export function assertWellFormed(doc: string): XmlNode {
  const { doctype, root } = parseXmlDocument(doc)
  if (renderDocument(doctype, root) !== doc) throw new Error('Document does not round-trip through the XML writer')
  expatCheck(doc)
  return root
}

let python: boolean | undefined
function expatCheck(doc: string): void {
  if (python === undefined) {
    try {
      execFileSync('python3', ['-I', '-c', 'pass'], { stdio: 'ignore' })
      python = true
    } catch {
      python = false
    }
  }
  if (!python) return
  execFileSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom; xml.dom.minidom.parseString(sys.stdin.buffer.read())'], { input: doc, stdio: ['pipe', 'ignore', 'pipe'] })
}

/** All elements named `name`, depth-first. */
export function findAll(root: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = []
  const walk = (n: XmlNode) => {
    if (n.name === name) out.push(n)
    n.children.forEach(walk)
  }
  walk(root)
  return out
}

export const attr = (n: XmlNode, k: string): string | undefined => n.attrs.find(([a]) => a === k)?.[1]
export const childText = (n: XmlNode, name: string): string | undefined => n.children.find((c) => c.name === name)?.text
