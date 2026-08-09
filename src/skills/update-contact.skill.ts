import { z } from 'zod';
import type { AgentTool } from '../orchestrator/agent-tool.js';

/**
 * Update Contact Field skill — extracts details the customer shares and writes
 * them to the CRM contact. Only fields the customer actually provided are sent;
 * the CRM client maps standard vs custom fields (name/email/phone → standard,
 * budget/preferred time → custom fields).
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
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field the customer shared.',
  });

const DESCRIPTION =
  'Save details the customer shares about themselves — their name, email, phone, ' +
  'budget, or preferred viewing/contact time — to their CRM contact record. ' +
  'Only include fields the customer actually stated. Do not guess or ask for all of them.';

export function createUpdateContactSkill(): AgentTool {
  return {
    spec: { name: 'update_contact_field', description: DESCRIPTION, parameters: ParamsSchema },
    run: async (args, ctx) => {
      const input = ParamsSchema.parse(args);
      const fields: Record<string, string | number> = {};
      if (input.name !== undefined) fields.name = input.name;
      if (input.email !== undefined) fields.email = input.email;
      if (input.phone !== undefined) fields.phone = input.phone;
      if (input.budget !== undefined) fields.budget = input.budget;
      if (input.preferredTime !== undefined) fields.preferredTime = input.preferredTime;

      await ctx.crm.updateContactFields(ctx.contactId, fields);
      return { updated: true, fields: Object.keys(fields) };
    },
  };
}
