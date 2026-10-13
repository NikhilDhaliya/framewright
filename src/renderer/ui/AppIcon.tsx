import iconSvg from '../../../resources/icon.svg?raw'
import logoSvg from '../../../resources/logo-mono.svg?raw'
import { APP_NAME } from '../../shared/brand'

/** The app icon, drawn from resources/icon.svg (the same source the packaged PNG icons are rendered from). */
const ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg)}`

export function AppIcon({ size, className }: { size: number; className?: string }) {
  return <img className={className} src={ICON_URL} width={size} height={size} alt="" draggable={false} />
}

/** The full logo (icon + wordmark), drawn inline from resources/logo-mono.svg so the wordmark takes the text color. */
export function AppLogo({ height, className }: { height: number; className?: string }) {
  return (
    <span
      className={['pp-app-logo', className].filter(Boolean).join(' ')}
      style={{ height }}
      role="img"
      aria-label={APP_NAME}
      dangerouslySetInnerHTML={{ __html: logoSvg }}
    />
  )
}
