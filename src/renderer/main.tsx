import { setAutoFreeze } from 'immer'
import './theme/tokens.css'
import './theme/base.css'
import './ui/ui.css'
import './editor/editor.css'
import './i18n/rtl.css'
import { loadLocale } from './i18n'

setAutoFreeze(false)
// The string table must be in place before any UI module runs (module-level labels call t()).
await loadLocale()

const [{ createRoot }, { App }, { loadSettings }, { installSelectionReporting }, { installTooltips }] = await Promise.all([
  import('react-dom/client'),
  import('./App'),
  import('./state/settings'),
  import('./state/sync'),
  import('./ui/tooltip'),
])
installTooltips()
installSelectionReporting()

await Promise.all([loadSettings(), document.fonts.load('11px Inter'), document.fonts.load('11px "Geist Mono"')])
createRoot(document.getElementById('root')!).render(<App />)
