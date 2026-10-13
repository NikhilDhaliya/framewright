/** 05 §7.5.7 Multicam tab (read-only): one row per group member with kind badge, label, master star and sync status. */
import type { Clip, MulticamMember, MulticamSource } from '@core/model'
import { memberUsable } from '@core/ops/multicam'
import { useProject } from '../state/project'
import { Icon } from '../ui/Icon'
import { Group } from '../ui/panels'
import { palette, readableForeground } from '../timeline/colors'
import { t } from '../i18n'

const KIND_TITLE: Record<MulticamMember['kind'], string> = { angle: t('Angle'), mic: t('Mic'), both: t('Both') }
/** Badge fill: the video / audio track colour, red (`--pp-multicam`) for both. */
function kindFill(kind: MulticamMember['kind']): string {
  const p = palette()
  return kind === 'angle' ? p.clip.video : kind === 'mic' ? p.clip.audio : p.multicam
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const signed = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}`

/** Mac `%+.2fs · %.0f%%`. */
export const syncLabel = (m: MulticamMember) => `${signed(m.sync.offsetSeconds)}s · ${Math.round(m.sync.confidence * 100)}%`

/** Groups referenced by the selection, in first-seen order. */
export function selectedGroups(groups: MulticamSource[] | undefined, clips: Clip[]): MulticamSource[] {
  const out: MulticamSource[] = []
  for (const c of clips) {
    const g = c.multicamGroupId ? groups?.find((x) => x.id === c.multicamGroupId) : undefined
    if (g && !out.includes(g)) out.push(g)
  }
  return out
}

function MemberRow({ m, master }: { m: MulticamMember; master: boolean }) {
  const fill = kindFill(m.kind)
  return (
    <div className="pp-mc-row">
      <span className="pp-mc-kind" style={{ background: fill, color: withAlpha(readableForeground(fill), 0.8) }}>
        {KIND_TITLE[m.kind]}
      </span>
      <span className="pp-mc-label ellipsis">{m.angleLabel}</span>
      {master && (
        <span className="pp-mc-master" data-tip={t("Master — defines the group's clock and transcript.")}>
          <Icon sf="star.fill" size={9} />
        </span>
      )}
      <span style={{ flex: 1 }} />
      {memberUsable(m) ? (
        <span className="pp-mc-sync">{syncLabel(m)}</span>
      ) : (
        <span className="pp-mc-unsynced" data-tip={t('Not synced — unusable as an angle.')}>
          <Icon sf="exclamationmark.triangle.fill" size={10} />
        </span>
      )}
    </div>
  )
}

export function MulticamTab({ clips }: { clips: Clip[] }) {
  const groups = useProject((s) => (s.preview ?? s.snapshot?.doc)?.file.multicamGroups)
  return (
    <>
      {selectedGroups(groups, clips).map((g) => (
        <Group key={g.id} stateId={`multicam:${g.id}`} title={g.name || t('Multicam')}>
          <div className="pp-mc-list">
            {g.members.map((m) => (
              <MemberRow key={m.id} m={m} master={m.id === g.masterMemberId} />
            ))}
          </div>
        </Group>
      ))}
    </>
  )
}
