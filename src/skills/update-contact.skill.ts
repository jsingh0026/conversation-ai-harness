import { z } from 'zod';
import { env } from '../config/env.js';
import type { Contact } from '../crm/types.js';
import type { AgentTool } from '../orchestrator/agent-tool.js';

/**
 * Update Contact Field skill — extracts details the customer shares and writes
 * them to the CRM contact. Only fields the customer actually provided are sent;
 * the CRM client maps standard vs custom fields (name/email/phone → standard,
 * budget/preferred time → custom fields).
 *
 * Conflict-aware: before overwriting a field that already holds a DIFFERENT
 * value (e.g. record says "Alex" but the customer now says "Sam"), the tool
 * returns `needsConfirmation` with the existing value so the model confirms the
 * change with the customer first, then re-calls with confirmOverwrite=true.
 */
const ParamsSchema = z
  .object({
    name: z.string().min(1).optional().describe('The customer\'s full name.'),
    // Simple RE2-safe pattern (no lookaheads) so the tool schema validates on
    // strict gateways like Groq; Zod's .email() emits a lookahead regex that
    // RE2-based validators reject.
    email: z
      .string()
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Invalid email')
      .optional()
      .describe('The customer\'s email address.'),
    phone: z.string().min(3).optional().describe('The customer\'s phone number.'),
    budget: z.coerce
      .number()
      .positive()
      .optional()
      .describe('Purchase/rental budget as a number (no currency symbols).'),
    preferredTime: z
      .string()
      .min(1)
      .optional()
      .describe('Preferred day/time to view or be contacted, as the customer phrased it.'),
    confirmOverwrite: z
      .boolean()
      .optional()
      .describe(
        'Set true ONLY after the customer confirmed changing a field that already had a ' +
          'different value on record.',
      ),
  })
  .refine(
    (v) =>
      [v.name, v.email, v.phone, v.budget, v.preferredTime].some((x) => x !== undefined),
    { message: 'Provide at least one field the customer shared.' },
  );

const DESCRIPTION =
  'Save details the customer shares about themselves — their name, email, phone, ' +
  'budget, or preferred viewing/contact time — to their CRM contact record. ' +
  'Only include fields the customer actually stated. If a field already has a DIFFERENT ' +
  'value on record, the tool returns needsConfirmation with the existing value — tell the ' +
  'customer what we have and confirm before changing it (then re-call with confirmOverwrite=true). ' +
  'Do not guess or ask for all of them.';

type FieldKey = 'name' | 'email' | 'phone' | 'budget' | 'preferredTime';

/** Existing value for a logical field, reading standard fields from the top
 *  level and custom fields by their configured HighLevel id (or friendly key,
 *  as the mock stores them). */
function existingValue(contact: Contact, field: FieldKey): string | number | undefined {
  if (field === 'name') return contact.name;
  if (field === 'email') return contact.email;
  if (field === 'phone') return contact.phone;
  const idFor: Record<'budget' | 'preferredTime', string | undefined> = {
    budget: env.HL_FIELD_BUDGET_ID,
    preferredTime: env.HL_FIELD_PREFERRED_TIME_ID,
  };
  const id = idFor[field];
  return contact.fields[field] ?? (id ? contact.fields[id] : undefined);
}

/** Comparable, normalized form of a value for conflict detection. */
function norm(field: FieldKey, v: string | number): string {
  if (field === 'budget') return String(Number(v));
  if (field === 'phone') return String(v).replace(/\D/g, '');
  return String(v).trim().toLowerCase();
}

export function createUpdateContactSkill(): AgentTool {
  return {
    spec: { name: 'update_contact_field', description: DESCRIPTION, parameters: ParamsSchema },
    run: async (args, ctx) => {
      const input = ParamsSchema.parse(args);
      const provided: Partial<Record<FieldKey, string | number>> = {};
      if (input.name !== undefined) provided.name = input.name;
      if (input.email !== undefined) provided.email = input.email;
      if (input.phone !== undefined) provided.phone = input.phone;
      if (input.budget !== undefined) provided.budget = input.budget;
      if (input.preferredTime !== undefined) provided.preferredTime = input.preferredTime;

      const contact = await ctx.crm.getContact(ctx.contactId).catch(() => undefined);

      const toWrite: Record<string, string | number> = {};
      const unchanged: string[] = [];
      const conflicts: { field: string; existing: string; requested: string }[] = [];

      for (const [field, value] of Object.entries(provided) as [FieldKey, string | number][]) {
        const existing = contact ? existingValue(contact, field) : undefined;
        const isBlank = existing === undefined || existing === null || String(existing).trim() === '';
        if (isBlank) {
          toWrite[field] = value; // first time — just save
        } else if (norm(field, existing) === norm(field, value)) {
          unchanged.push(field); // already what we have — no-op
        } else if (input.confirmOverwrite) {
          toWrite[field] = value; // customer confirmed the change
        } else {
          conflicts.push({ field, existing: String(existing), requested: String(value) });
        }
      }

      // Save the non-conflicting fields immediately.
      if (Object.keys(toWrite).length) await ctx.crm.updateContactFields(ctx.contactId, toWrite);

      if (conflicts.length > 0) {
        return {
          updated: false,
          needsConfirmation: true,
          conflicts,
          savedFields: Object.keys(toWrite),
          unchanged,
          instruction:
            'Our records already have a different value for: ' +
            conflicts.map((c) => `${c.field} is "${c.existing}" (customer now says "${c.requested}")`).join('; ') +
            '. Tell the customer what we have on file and ask if they want to update it. ' +
            'If they confirm, call update_contact_field again with confirmOverwrite=true for those fields.',
        };
      }

      return { updated: true, savedFields: Object.keys(toWrite), unchanged };
    },
  };
}
