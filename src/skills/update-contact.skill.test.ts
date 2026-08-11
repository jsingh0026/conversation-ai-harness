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
    )) as { updated: boolean; savedFields: string[] };

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
      savedFields: string[];
    };
    expect(out.savedFields).toEqual(['budget']);
  });

  it('flags a conflict instead of silently overwriting (Alex → Sam)', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1', name: 'Alex' });
    const skill = createUpdateContactSkill();
    const out = (await skill.run({ name: 'Sam' }, makeToolContext({ crm }))) as {
      updated: boolean;
      needsConfirmation?: boolean;
      conflicts?: { field: string; existing: string; requested: string }[];
    };
    expect(out.updated).toBe(false);
    expect(out.needsConfirmation).toBe(true);
    expect(out.conflicts?.[0]).toMatchObject({ field: 'name', existing: 'Alex', requested: 'Sam' });
    expect((await crm.getContact('ct1')).name).toBe('Alex'); // NOT overwritten
  });

  it('overwrites once confirmOverwrite is set', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1', name: 'Alex' });
    const skill = createUpdateContactSkill();
    const out = (await skill.run(
      { name: 'Sam', confirmOverwrite: true },
      makeToolContext({ crm }),
    )) as { updated: boolean };
    expect(out.updated).toBe(true);
    expect((await crm.getContact('ct1')).name).toBe('Sam');
  });

  it('saves non-conflicting fields while flagging the conflicting one', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1', name: 'Alex' });
    const skill = createUpdateContactSkill();
    const out = (await skill.run(
      { name: 'Sam', email: 'sam@example.com' }, // name conflicts; email is new
      makeToolContext({ crm }),
    )) as { needsConfirmation?: boolean; savedFields: string[] };
    expect(out.needsConfirmation).toBe(true);
    expect(out.savedFields).toEqual(['email']); // email saved, name held
    const c = await crm.getContact('ct1');
    expect(c.email).toBe('sam@example.com');
    expect(c.name).toBe('Alex'); // still not overwritten
  });

  it('treats the same value as unchanged (no conflict)', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1', name: 'Alex' });
    const skill = createUpdateContactSkill();
    const out = (await skill.run({ name: 'alex' }, makeToolContext({ crm }))) as {
      updated: boolean;
      unchanged: string[];
    };
    expect(out.updated).toBe(true); // no conflict
    expect(out.unchanged).toContain('name');
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
