import { describe, expect, it } from 'vitest'
import { APP_NAME } from '../../src/shared/brand'
import { createTranslator, formatMessage, keyMatcher, matchLocale, nativeLanguageName, resolveSystemLocale, sortedLocales } from '../../src/shared/i18n'

describe('formatMessage', () => {
  it('fills positional arguments and the product name', () => {
    expect(formatMessage('{0} of {1}', ['a', 3])).toBe('a of 3')
    expect(formatMessage('Welcome to {app}', [])).toBe(`Welcome to ${APP_NAME}`)
    expect(formatMessage('{1} before {0}', ['x', 'y'])).toBe('y before x')
    expect(formatMessage('Port {0}', [19789])).toBe('Port 19789')
    expect(formatMessage('missing {2}', ['a'])).toBe('missing {2}')
  })
})

describe('translator', () => {
  const tr = createTranslator('de', { 'Export': 'Exportieren', '{0} clips': '{0} Clips', '1 clip': '1 Clip', 'Hi {app}': 'Hallo {app}' })
  it('looks keys up and falls back to English', () => {
    expect(tr.t('Export')).toBe('Exportieren')
    expect(tr.t('Unknown {0}', 'x')).toBe('Unknown x')
    expect(tr.t('Hi {app}')).toBe(`Hallo ${APP_NAME}`)
  })
  it('uses Mac-style plural pairs', () => {
    expect(tr.plural(1, '1 clip', '{0} clips')).toBe('1 Clip')
    expect(tr.plural(4, '1 clip', '{0} clips')).toBe('4 Clips')
    expect(tr.plural(0, '1 clip', '{0} clips')).toBe('0 Clips')
  })
})

describe('system locale', () => {
  it('matches like Bundle.preferredLocalizations', () => {
    expect(resolveSystemLocale(['de-DE', 'en-US'])).toBe('de')
    expect(resolveSystemLocale(['xx', 'fr_FR.UTF-8'])).toBe('fr')
    expect(resolveSystemLocale(['zh-TW'])).toBe('zh-Hant')
    expect(resolveSystemLocale(['zh-CN'])).toBe('zh-Hans')
    expect(resolveSystemLocale(['pt'])).toBe('pt-BR')
    expect(resolveSystemLocale(['pt-PT'])).toBe('pt-PT')
    expect(resolveSystemLocale(['nn-NO'])).toBe('nb')
    expect(resolveSystemLocale(['C'])).toBe('en')
    expect(resolveSystemLocale(['xx-YY'])).toBe('en')
    expect(matchLocale('ar-EG')).toBe('ar')
  })
  it('names languages natively and sorts by that name', () => {
    expect(nativeLanguageName('de')).toBe('Deutsch')
    expect(nativeLanguageName('en')).toBe('English')
    const order = sortedLocales('en')
    expect(order).toHaveLength(28)
    expect(order.indexOf('de')).toBeLessThan(order.indexOf('en'))
  })
})

describe('keyMatcher', () => {
  it('recovers arguments from a finished English message', () => {
    expect(keyMatcher('{0} does not accept this media')('Kling does not accept this media')).toEqual(['Kling'])
    expect(keyMatcher('Relinked {0} of {1} offline clips.')('Relinked 2 of 5 offline clips.')).toEqual(['2', '5'])
    expect(keyMatcher('{0} is ready.')('nothing here')).toBeNull()
    expect(keyMatcher(`Quit {app}`)(`Quit ${APP_NAME}`)).toEqual([])
  })
})
