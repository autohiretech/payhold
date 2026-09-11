/**
 * A name a platform reported must never read as a PayHold user.
 *
 * On a relayed dispute decision the backend records the API key as the decider
 * and the platform's named human as `reported_decider`. Rendering the second as
 * "Decided by …" would present an unverified claim exactly the way an
 * authenticated person here is presented, which is the one thing this file is
 * for preventing.
 */

import { describe, expect, it } from 'vitest'
import { deciderSentence, platformOf, timelineActor } from './decider'

const RELAYED = {
  decided_by: 'api_key:AutoHire live',
  decider_source: 'platform_reported' as const,
  reported_decider: 'autohire-admin:jane@example.com',
}

describe('the outcome sentence', () => {
  it('reads a relayed decision as reported, with the key it came on', () => {
    const sentence = deciderSentence(RELAYED)
    expect(sentence).toBe(
      'Reported by AutoHire live via API key: autohire-admin:jane@example.com.',
    )
    expect(sentence).not.toMatch(/^Decided by/)
  })

  it('reads a person here as a person here', () => {
    expect(
      deciderSentence({
        decided_by: 'user:dana@autohire.rw',
        decider_source: 'person',
        reported_decider: null,
      }),
    ).toBe('Decided by user:dana@autohire.rw.')
  })

  it('reads an agreement as an agreement, including one decided before the label existed', () => {
    for (const decider_source of ['both_parties', null] as const) {
      expect(
        deciderSentence({ decided_by: 'both-parties', decider_source, reported_decider: null }),
      ).toBe('The two sides agreed with each other.')
    }
  })

  it('says so when nobody is recorded', () => {
    expect(
      deciderSentence({ decided_by: null, decider_source: null, reported_decider: null }),
    ).toBe('Decided by nobody recorded.')
  })
})

describe('the timeline', () => {
  it('attributes a relayed resolution to the report, not to a user', () => {
    expect(
      timelineActor({
        kind: 'resolved',
        actor: 'api_key:AutoHire live',
        details: {
          status: 'resolved_released',
          decider_source: 'platform_reported',
          reported_decider: 'autohire-admin:jane@example.com',
        },
      }),
    ).toBe('Reported by AutoHire live via API key: autohire-admin:jane@example.com')
  })

  it('leaves every other row as the backend recorded it', () => {
    expect(
      timelineActor({
        kind: 'resolved',
        actor: 'user:dana@autohire.rw',
        details: { decider_source: 'person', reported_decider: null },
      }),
    ).toBe('user:dana@autohire.rw')
    expect(
      timelineActor({ kind: 'dispute_opened', actor: 'api_key:AutoHire live', details: {} }),
    ).toBe('api_key:AutoHire live')
  })
})

describe('the platform name', () => {
  it('is the key label without its prefix', () => {
    expect(platformOf('api_key:AutoHire live')).toBe('AutoHire live')
    expect(platformOf(null)).toBe('your platform')
  })
})
