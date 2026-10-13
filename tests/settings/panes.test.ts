import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMELINE_COLORS, withTimelineColor } from '../../src/renderer/dialogs/settings/TimelineColorsPane'
import { matchesSkill } from '../../src/renderer/dialogs/settings/SkillsPane'
import { splitSkill } from '../../src/renderer/dialogs/settings/SkillDetailSheet'
import { NEW_SKILL_TEMPLATE } from '../../src/shared/skills'

describe('settings panes (pure parts)', () => {
  it('timeline color picks are overrides (even the default value), like the Mac', () => {
    expect(withTimelineColor(undefined, 'video', '#ff0000')).toEqual({ video: '#FF0000' })
    expect(withTimelineColor({ audio: '#00FF00' }, 'video', DEFAULT_TIMELINE_COLORS.video.toLowerCase())).toEqual({ audio: '#00FF00', video: DEFAULT_TIMELINE_COLORS.video })
  })

  it('searches skills by name and description (not id), like the Mac', () => {
    const s = { id: 'beat-cuts', name: 'Beat Cuts', description: 'Cut to music' }
    expect(matchesSkill(s, '')).toBe(true)
    expect(matchesSkill(s, 'MUSIC')).toBe(true)
    expect(matchesSkill(s, 'beat-c')).toBe(false)
    expect(matchesSkill(s, 'color')).toBe(false)
  })

  it('splits SKILL.md for the detail view', () => {
    expect(splitSkill(NEW_SKILL_TEMPLATE)).toEqual({
      name: 'New skill',
      description: 'Describe in one line when the assistant should use this skill.',
      body: '## Workflow\n1. First step.\n2. Second step.',
    })
  })
})

describe('skill frontmatter edits', () => {
  it('replaces or inserts a field', async () => {
    const { replaceSkillField } = await import('../../src/renderer/dialogs/settings/SkillDetailSheet')
    expect(replaceSkillField('---\nname: A\ndescription: D\n---\nbody', 'name', 'B')).toBe('---\nname: B\ndescription: D\n---\nbody')
    expect(replaceSkillField('---\ndescription: D\n---\nbody', 'name', 'B')).toBe('---\ndescription: D\nname: B\n---\nbody')
    expect(replaceSkillField('no frontmatter', 'name', 'B')).toBe('no frontmatter')
  })
})
