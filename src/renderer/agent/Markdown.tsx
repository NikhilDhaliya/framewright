import { Fragment, memo, type ReactNode } from 'react'
import { cachedParse, type Inline } from './markdown'

function renderInline(nodes: Inline[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`
    switch (n.kind) {
      case 'text':
        return <Fragment key={k}>{n.text}</Fragment>
      case 'code':
        return (
          <code key={k} className="pp-md-code">
            {n.text}
          </code>
        )
      case 'bold':
        return <strong key={k}>{renderInline(n.children, k + '.')}</strong>
      case 'italic':
        return <em key={k}>{renderInline(n.children, k + '.')}</em>
      case 'strike':
        return <s key={k}>{renderInline(n.children, k + '.')}</s>
      case 'link':
        return (
          <a
            key={k}
            href={n.href}
            className="pp-md-link"
            onClick={(e) => {
              e.preventDefault()
              window.palmier.app.openExternal(n.href)
            }}
          >
            {renderInline(n.children, k + '.')}
          </a>
        )
    }
  })
}

const HEADING_SIZE = [19, 16, 14, 13, 13, 13]

/** MarkdownText: prose runs, fenced code panels and tables; selectable, never raw HTML. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const blocks = cachedParse(text)
  return (
    <div className="pp-md">
      {blocks.map((b, i) => {
        if (b.kind === 'code') {
          return (
            <div key={i} className="pp-md-codeblock">
              {b.lang && <div className="pp-md-lang">{b.lang}</div>}
              <pre>{b.code}</pre>
            </div>
          )
        }
        if (b.kind === 'table') {
          return (
            <div key={i} className="pp-md-table-wrap">
              <table className="pp-md-table">
                <thead>
                  <tr>
                    {b.header.map((c, j) => (
                      <th key={j} style={{ textAlign: b.aligns[j] }}>
                        {renderInline(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, j) => (
                        <td key={j} style={{ textAlign: b.aligns[j] }}>
                          {renderInline(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return (
          <div key={i} className="pp-md-prose">
            {b.parts.map((p, j) =>
              p.kind === 'heading' ? (
                <div key={j} className="pp-md-heading" style={{ fontSize: HEADING_SIZE[p.level - 1], fontWeight: p.level <= 1 ? 700 : 600 }}>
                  {renderInline(p.inline)}
                </div>
              ) : (
                <div key={j} className="pp-md-para">
                  {renderInline(p.inline)}
                </div>
              ),
            )}
          </div>
        )
      })}
    </div>
  )
})
