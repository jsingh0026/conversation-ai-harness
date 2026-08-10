import { describe, expect, it } from 'vitest';
import { MockCrmClient } from '../crm/mock.js';
import { makeToolContext } from '../testkit/tool-context.js';
import { createHandoverSkill } from './handover.skill.js';

describe('request_human_handover skill', () => {
  // A contact we can already reach (name + email) — so the HITL gate passes.
  const reachable = { id: 'ct1', name: 'Alex Rivera', email: 'alex@example.com' };

  it('disables the bot, tags the contact, and sends a final message', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact(reachable);
    const skill = createHandoverSkill({ tag: 'bot-handover' });

    const out = (await skill.run(
      { reason: 'explicit_request', finalMessage: 'A team member will reach out shortly.' },
      makeToolContext({ crm }),
    )) as { handedOver: boolean };

    expect(out.handedOver).toBe(true);
    expect(await crm.isBotEnabled('c1')).toBe(false);
    expect((await crm.getContact('ct1')).tags).toContain('bot-handover');
    expect(crm.lastSent()?.body).toBe('A team member will reach out shortly.');
  });

  it('asks for contact info instead of handing off when we cannot reach the customer', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1' }); // no name/email/phone
    const skill = createHandoverSkill({ tag: 'bot-handover' });

    const out = (await skill.run(
      { reason: 'explicit_request', finalMessage: 'Connecting you now.' },
      makeToolContext({ crm }),
    )) as { handedOver: boolean; needContactInfo?: boolean };

    expect(out.handedOver).toBe(false);
    expect(out.needContactInfo).toBe(true);
    // Bot stays enabled so the next turn can capture the details; no tag yet.
    expect(await crm.isBotEnabled('c1')).toBe(true);
    expect((await crm.getContact('ct1')).tags).not.toContain('bot-handover');
  });

  it('reassigns the owner when configured', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact(reachable);
    const skill = createHandoverSkill({ tag: 't', ownerUserId: 'user-9' });
    await skill.run({ reason: 'frustration', finalMessage: 'Sorry about that!' }, makeToolContext({ crm }));
    expect((await crm.getContact('ct1')).assignedUserId).toBe('user-9');
  });

  it('does not disable the bot if the final message fails to send', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact(reachable);
    crm.sendMessage = async () => {
      throw new Error('channel down');
    };
    const skill = createHandoverSkill();

    await expect(
      skill.run({ reason: 'explicit_request', finalMessage: 'hi' }, makeToolContext({ crm })),
    ).rejects.toThrow('channel down');
    // Bot must remain enabled so the turn can be retried (no silent dead-end).
    expect(await crm.isBotEnabled('c1')).toBe(true);
  });

  it('constrains the reason to the allowed set', () => {
    const skill = createHandoverSkill();
    expect(skill.spec.parameters.safeParse({ reason: 'because', finalMessage: 'x' }).success).toBe(
      false,
    );
  });
});
