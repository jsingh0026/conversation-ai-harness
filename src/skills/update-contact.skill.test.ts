import { describe, expect, it } from 'vitest';
import { MockCrmClient } from '../crm/mock.js';
import { makeToolContext } from '../testkit/tool-context.js';
import { createUpdateContactSkill } from './update-contact.skill.js';

describe('update_contact_field skill', () => {
  it('writes shared details to the contact (standard + custom fields)', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1' });
    const skill = createUpdateContactSkill();

    const out = (await skill.run(
      { name: 'Ada Lovelace', email: 'ada@example.com', budget: 750000, preferredTime: 'Saturday morning' },
      makeToolContext({ crm }),
    )) as { updated: boolean; fields: string[] };

    expect(out.updated).toBe(true);
    const contact = await crm.getContact('ct1');
    expect(contact.name).toBe('Ada Lovelace');
    expect(contact.email).toBe('ada@example.com');
    expect(contact.fields.budget).toBe(750000);
    expect(contact.fields.preferredTime).toBe('Saturday morning');
  });

  it('only writes the fields provided', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1' });
    const skill = createUpdateContactSkill();
    const out = (await skill.run({ budget: 500000 }, makeToolContext({ crm }))) as {
      fields: string[];
    };
    expect(out.fields).toEqual(['budget']);
  });

  it('rejects an update with no fields (schema refine)', () => {
    const skill = createUpdateContactSkill();
    expect(skill.spec.parameters.safeParse({}).success).toBe(false);
  });

  it('rejects a malformed email at the schema layer', () => {
    const skill = createUpdateContactSkill();
    expect(skill.spec.parameters.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});
