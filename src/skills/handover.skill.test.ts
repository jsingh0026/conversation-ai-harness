import { describe, expect, it } from 'vitest';
import { MockCrmClient } from '../crm/mock.js';
import { makeToolContext } from '../testkit/tool-context.js';
import { createHandoverSkill } from './handover.skill.js';

describe('request_human_handover skill', () => {
  it('disables the bot, tags the contact, and sends a final message', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1' });
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

  it('reassigns the owner when configured', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1' });
    const skill = createHandoverSkill({ tag: 't', ownerUserId: 'user-9' });
    await skill.run({ reason: 'frustration', finalMessage: 'Sorry about that!' }, makeToolContext({ crm }));
    expect((await crm.getContact('ct1')).assignedUserId).toBe('user-9');
  });

  it('constrains the reason to the allowed set', () => {
    const skill = createHandoverSkill();
    expect(skill.spec.parameters.safeParse({ reason: 'because', finalMessage: 'x' }).success).toBe(
      false,
    );
  });
});
