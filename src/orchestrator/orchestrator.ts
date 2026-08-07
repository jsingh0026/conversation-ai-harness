import type { CrmClient, InboundMessage } from '../crm/types.js';
import type { LlmMessage, LLMProvider, ToolCall, ToolResult, ToolSpec } from '../llm/types.js';
import { buildSystemPrompt, type SystemPromptVars } from '../prompts/system.js';
import { TraceCollector } from '../trace/collector.js';
import { emitTrace } from '../trace/emit.js';
import type { Trace } from '../trace/types.js';
import { logger } from '../util/logger.js';
import { indexTools, type AgentTool, type ToolContext } from './agent-tool.js';
import { ConversationStore } from './history.js';

export interface OrchestratorDeps {
  provider: LLMProvider;
  crm: CrmClient;
  tools?: AgentTool[];
  history?: ConversationStore;
  promptVars?: SystemPromptVars;
  /** Max provider↔tool round-trips before we bail with a fallback reply. */
  maxSteps?: number;
}

const FALLBACK_REPLY =
  "I'm having trouble completing that right now — let me get a team member to help.";

/**
 * The harness core. One `runTurn` drives a bounded tool-use loop: the model
 * either answers directly (chit-chat), or calls tools (RAG / skills / handover)
 * that the orchestrator executes and feeds back, until it produces a reply —
 * which is sent into the CRM. Every step is recorded on the Trace.
 */
export class Orchestrator {
  private readonly provider: LLMProvider;
  private readonly crm: CrmClient;
  private readonly tools: Map<string, AgentTool>;
  private readonly toolSpecs: ToolSpec[];
  private readonly history: ConversationStore;
  private readonly promptVars: SystemPromptVars;
  private readonly maxSteps: number;

  constructor(deps: OrchestratorDeps) {
    this.provider = deps.provider;
    this.crm = deps.crm;
    this.tools = indexTools(deps.tools ?? []);
    this.toolSpecs = (deps.tools ?? []).map((t) => t.spec);
    this.history = deps.history ?? new ConversationStore();
    this.promptVars = deps.promptVars ?? {};
    this.maxSteps = deps.maxSteps ?? 6;
  }

  async runTurn(message: InboundMessage): Promise<Trace> {
    const trace = new TraceCollector({
      conversationId: message.conversationId,
      contactId: message.contactId,
      input: message.body,
    });

    try {
      // Once a conversation is handed to a human, the bot stays silent.
      if (!(await this.crm.isBotEnabled(message.conversationId))) {
        trace.setDecision('bot_disabled');
        trace.setReply(null);
        return await this.complete(trace);
      }

      const system = buildSystemPrompt(this.promptVars);
      trace.setSystem(system);

      const messages: LlmMessage[] = [
        ...this.history.get(message.conversationId),
        { role: 'user', content: message.body },
      ];

      const reply = await this.runLoop(system, messages, {
        conversationId: message.conversationId,
        contactId: message.contactId,
        crm: this.crm,
        trace,
      });

      // The bot may have been disabled mid-turn by a handover skill.
      if (await this.crm.isBotEnabled(message.conversationId)) {
        await this.crm.sendMessage({
          conversationId: message.conversationId,
          contactId: message.contactId,
          channel: message.channel,
          body: reply,
        });
      }

      this.history.append(
        message.conversationId,
        { role: 'user', content: message.body },
        { role: 'assistant', content: reply },
      );
      trace.setReply(reply);
      return await this.complete(trace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId: message.conversationId }, 'turn failed');
      trace.setError(msg);
      trace.setReply(null);
      return await this.complete(trace);
    }
  }

  /** The provider↔tool loop. Returns the final assistant reply text. */
  private async runLoop(system: string, messages: LlmMessage[], ctx: ToolContext): Promise<string> {
    for (let step = 0; step < this.maxSteps; step++) {
      const t0 = Date.now();
      const res = await this.provider.generate({
        system,
        messages,
        tools: this.toolSpecs.length > 0 ? this.toolSpecs : undefined,
        toolChoice: this.toolSpecs.length > 0 ? 'auto' : undefined,
      });
      ctx.trace.addProviderStep(res, this.provider.name, this.provider.model, Date.now() - t0);

      if (res.toolCalls.length === 0) {
        return res.text ?? FALLBACK_REPLY;
      }

      messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });
      const toolResults: ToolResult[] = [];
      for (const call of res.toolCalls) {
        toolResults.push(await this.dispatch(call, ctx));
      }
      messages.push({ role: 'tool', toolResults });
    }

    logger.warn({ conversationId: ctx.conversationId }, 'max steps reached');
    return FALLBACK_REPLY;
  }

  /** Validate args, run the named tool, and record the step. */
  private async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    const t0 = Date.now();

    if (!tool) {
      const output = { error: `Unknown tool: ${call.name}` };
      ctx.trace.addToolStep({ name: call.name, input: call.args, output, latencyMs: 0, ok: false });
      return { toolCallId: call.id, name: call.name, result: output };
    }

    const parsed = tool.spec.parameters.safeParse(call.args);
    if (!parsed.success) {
      const output = { error: 'Invalid arguments', issues: parsed.error.issues };
      ctx.trace.addToolStep({
        name: call.name,
        input: call.args,
        output,
        latencyMs: Date.now() - t0,
        ok: false,
      });
      return { toolCallId: call.id, name: call.name, result: output };
    }

    try {
      const output = await tool.run(parsed.data, ctx);
      ctx.trace.addToolStep({
        name: call.name,
        input: parsed.data,
        output,
        latencyMs: Date.now() - t0,
        ok: true,
      });
      return { toolCallId: call.id, name: call.name, result: output };
    } catch (err) {
      const output = { error: err instanceof Error ? err.message : String(err) };
      ctx.trace.addToolStep({
        name: call.name,
        input: parsed.data,
        output,
        latencyMs: Date.now() - t0,
        ok: false,
      });
      return { toolCallId: call.id, name: call.name, result: output };
    }
  }

  private async complete(trace: TraceCollector): Promise<Trace> {
    const finished = trace.finish();
    await emitTrace(finished);
    return finished;
  }
}
