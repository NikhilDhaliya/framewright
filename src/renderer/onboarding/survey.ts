/**
 * Onboarding survey questions (spec 05 §8.6, 07 §7.2; Mac `OnboardingStore`). On Linux the answers are cosmetic:
 * nothing is sent anywhere and nothing is stored (class d).
 */
import { tk } from '../../shared/i18n'

export interface SurveyQuestion {
  id: string
  title: string
  options: { id: string; label: string }[]
  multi: boolean
  /** Option that clears the others when picked, and is removed when another is picked. */
  exclusive?: string
}

const opts = (...labels: string[]) => labels.map((label) => ({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label }))

export const DISCOVERY_QUESTIONS: SurveyQuestion[] = [
  { id: 'acquisitionSource', title: tk('How did you find {app}?'), multi: false, options: opts(tk('Google'), tk('GitHub'), tk('X'), tk('Instagram'), tk('YouTube'), tk('Hacker News'), tk('Friend or colleague'), tk('Other')) },
  {
    id: 'previousEditors',
    title: tk('Which editors did you use before?'),
    multi: true,
    exclusive: 'none',
    options: opts(tk('Adobe Premiere Pro'), tk('DaVinci Resolve'), tk('Final Cut Pro'), tk('CapCut'), tk('Instagram Edits'), tk('iMovie'), tk('Descript'), tk('None'), tk('Other')),
  },
]

export const PROFILE_QUESTIONS: SurveyQuestion[] = [
  { id: 'roles', title: tk('What best describes your role?'), multi: true, options: opts(tk('Video editor'), tk('Filmmaker'), tk('Hobbyist'), tk('Founder'), tk('Designer'), tk('Content creator'), tk('Student'), tk('Marketer'), tk('Other')) },
  {
    id: 'videoTypes',
    title: tk('What do you make?'),
    multi: true,
    options: opts(tk('Short-form and social'), tk('YouTube'), tk('Podcast'), tk('AI videos'), tk('Ads and branded content'), tk('Product demos'), tk('Education and tutorials'), tk('Other')),
  },
  {
    id: 'interests',
    title: tk('What interests you most about {app}?'),
    multi: true,
    options: opts(tk('AI videos'), tk('AI transcription'), tk('Agentic editing'), tk('Integration with your own agent'), tk('Video automation')),
  },
]

/** `OnboardingStore.toggle`: single choice toggles off when re-picked; an exclusive option clears the others and vice versa. */
export function toggleOption(q: SurveyQuestion, selected: readonly string[], option: string): string[] {
  const has = selected.includes(option)
  if (!q.multi) return has ? [] : [option]
  if (has) return selected.filter((o) => o !== option)
  if (q.exclusive && option === q.exclusive) return [option]
  return [...selected.filter((o) => o !== q.exclusive), option]
}
