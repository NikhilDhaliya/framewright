import { useEffect, useState, type ReactNode } from 'react'
import { closeDialog } from '../state/dialogs'
import { Capsule, IconButton } from '../ui/buttons'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { cursorInstallUrl } from '../../shared/firstRun'
import { APP_SLUG } from '../../shared/brand'
import { SheetFooter, copyText, dialogKeys } from './common'
import { t } from '../i18n'

const DEFAULT_URL = 'http://127.0.0.1:19789/mcp'

function CopyButton({ text, size = 26 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(id)
  }, [copied])
  return <IconButton sf={copied ? 'checkmark' : 'doc.on.doc'} size={11} frame={size} tone="tertiary" tip={copied ? t('Copied') : t('Copy')} onClick={() => void copyText(text).then(setCopied)} />
}

function CodeBlock({ text, small }: { text: string; small?: boolean }) {
  return (
    <div className={`pp-mcp-code${small ? ' small' : ''}`}>
      <code className="mono">{text}</code>
      <CopyButton text={text} />
    </div>
  )
}

function AgentRow({ mark, name, description, action, children }: { mark: string; name: string; description: string; action?: { label: string; onClick: () => void }; children?: ReactNode }) {
  return (
    <div className="pp-mcp-agent">
      <div className="pp-mcp-agent-head">
        <span className="pp-mcp-mark">{mark}</span>
        <div className="pp-mcp-agent-text">
          <span className="pp-mcp-agent-name">{name}</span>
          <span className="pp-mcp-agent-desc">{description}</span>
        </div>
        {action && (
          <button type="button" className="pp-set-link pp-mcp-action" style={{ marginLeft: 'auto', flex: 'none', alignSelf: 'center' }} onClick={action.onClick}>
            {action.label}
            <Icon sf="arrow.up.right" size={9} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

export function McpDialog() {
  const [url, setUrl] = useState(DEFAULT_URL)
  const [manual, setManual] = useState(false)
  useEffect(() => {
    void window.palmier.app.info().then((i) => i.mcpUrl && setUrl(i.mcpUrl))
  }, [])
  const json = JSON.stringify({ mcpServers: { [APP_SLUG]: { type: 'http', url } } }, null, 2)
  return (
    <Sheet width={640} onClose={closeDialog}>
      <div className="pp-dlg pp-mcp" {...dialogKeys(closeDialog)}>
        <div className="pp-dlg-header">
          <span className="pp-dlg-title-lg">{t('MCP')}</span>
        </div>
        <div className="pp-mcp-scroll">
          <p className="pp-mcp-intro">{t('Connect an external agent to inspect and edit the open {app} project.')}</p>
          <section className="pp-mcp-group">
            <div className="pp-set-section-title">{t('Server URL')}</div>
            <CodeBlock text={url} />
          </section>
          <section className="pp-mcp-group">
            <div className="pp-set-section-title">{t('Connect an agent')}</div>
            <div className="pp-mcp-agents">
              <AgentRow mark="C" name="Claude Code" description={t('Run this command once in Terminal.')}>
                <CodeBlock small text={`claude mcp add --transport http ${APP_SLUG} ${url}`} />
              </AgentRow>
              <AgentRow mark="X" name="Codex" description={t('Run this command once in Terminal.')}>
                <CodeBlock small text={`codex mcp add ${APP_SLUG} --url ${url}`} />
              </AgentRow>
              <AgentRow
                mark="▲"
                name="Cursor"
                description={t('Install the {app} MCP server in Cursor.')}
                action={{ label: t('Install in Cursor'), onClick: () => window.palmier.app.openExternal(cursorInstallUrl(url)) }}
              >
                <button type="button" className="pp-mcp-disclosure" onClick={() => setManual(!manual)}>
                  <Icon sf={manual ? 'chevron.down' : 'chevron.right'} size={9} strokeWidth={2.5} />
                  {t('Manual setup')}
                </button>
                {manual && (
                  <>
                    <span className="pp-mcp-agent-desc">{t('Add this configuration to ~/.cursor/mcp.json.')}</span>
                    <CodeBlock small text={json} />
                  </>
                )}
              </AgentRow>
              <AgentRow mark="✳" name="Claude Desktop" description={t('Claude Desktop doesn’t ship for Linux. On another machine, add the same JSON to its MCP configuration and point it at this computer.')}>
                <CodeBlock small text={json} />
              </AgentRow>
            </div>
          </section>
        </div>
        <SheetFooter>
          <Capsule size="regular" variant="prominent" onClick={closeDialog}>
            {t('Done')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}
