import { z } from 'zod';
import { env } from '../config/env.js';
import type { AgentTool } from '../orchestrator/agent-tool.js';

export interface HandoverConfig {
  tag?: string;
  ownerUserId?: string;
}

/**
 * Human Handover skill — stops the bot for this conversation, marks it in the
 * CRM (tag + optional owner reassignment), and sends the customer a final
 * message. Because it disables the bot, the orchestrator suppresses its own
 * reply for this turn: this skill owns the last word.
 */
const ParamsSchema = z.object({
  reason: z
    .enum(['explicit_request', 'frustration', 'out_of_scope'])
    .describe('Why a human is needed.'),
  finalMessage: z
    .string()
    .min(1)
    .describe('A brief, warm message telling the customer a team member will follow up.'),
});

const DESCRIPTION =
  'Hand the conversation to a human and stop the bot. Call this when the customer ' +
  'explicitly asks for a person, is clearly frustrated, or asks for something outside ' +
  'what this assistant can help with (e.g. legal advice, complaints, commercial real estate). ' +
  'Provide a short final message; do not also answer the underlying question yourself.';

export function createHandoverSkill(config: HandoverConfig = {}): AgentTool {
  const tag = config.tag ?? env.HL_HANDOVER_TAG;
  const ownerUserId = config.ownerUserId ?? env.HL_HANDOVER_USER_ID;

  return {
    spec: { name: 'request_human_handover', description: DESCRIPTION, parameters: ParamsSchema },
    run: async (args, ctx) => {
      const { reason, finalMessage } = ParamsSchema.parse(args);

      // HITL gate: only hand off once a human can actually reach the customer.
      // If we're missing their name or any contact channel, DON'T hand off yet —
      // return a signal so the model asks for the missing details first (the bot
      // stays enabled so the next turn can capture them). Only asks when needed.
      const contact = await ctx.crm.getContact(ctx.contactId).catch(() => undefined);
      const hasName = Boolean(contact?.name?.trim());
      const hasReach = Boolean(contact?.email || contact?.phone);
      if (!hasName || !hasReach) {
        const missing = [!hasName ? 'their name' : '', !hasReach ? 'an email or phone number' : '']
          .filter(Boolean)
          .join(' and ');
        return {
          handedOver: false,
          needContactInfo: true,
          missing,
          instruction:
            `Before connecting a human, ask the customer for ${missing} so the team can ` +
            `follow up. Do NOT tell them they've been handed off yet.`,
        };
      }

      // Send the final message FIRST. If the send fails, we haven't disabled the
      // bot yet, so the turn errors and can be retried — avoiding a silent
      // dead-end where the bot is off but the customer was never told.
      await ctx.crm.sendMessage({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        channel: ctx.channel,
        body: finalMessage,
      });

      await ctx.crm.setBotEnabled(ctx.conversationId, false);
      await ctx.crm.addTag(ctx.contactId, tag);
      if (ownerUserId) await ctx.crm.assignOwner(ctx.contactId, ownerUserId);

      return { handedOver: true, reason, tag };
    },
  };
}
