import type { CrmClient, InboundMessage } from '../crm/types.js';
import type {
  GenerateResult,
  LlmMessage,
  LLMProvider,
  ToolCall,
  ToolResult,
  ToolSpec,
} from '../llm/types.js';
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

/** Guard against a provider returning empty/whitespace text with no tool calls. */
function textOrFallback(text: string | null): string {
  return text && text.trim() ? text : FALLBACK_REPLY;
}

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
        channel: message.channel,
        crm: this.crm,
        trace,
      });

      // A handover skill may have disabled the bot mid-turn. If so, that skill
      // owns the final customer message — we don't send our own reply, and we
      // must NOT persist an assistant message the customer never received.
      const stillEnabled = await this.crm.isBotEnabled(message.conversationId);
      if (stillEnabled) {
        await this.crm.sendMessage({
          conversationId: message.conversationId,
          contactId: message.contactId,
          channel: message.channel,
          body: reply,
        });
        this.history.append(
          message.conversationId,
          { role: 'user', content: message.body },
          { role: 'assistant', content: reply },
        );
        trace.setReply(reply);
      } else {
        // Retain the customer's message for future context, but no assistant turn.
        this.history.append(message.conversationId, { role: 'user', content: message.body });
        trace.setReply(null);
      }
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
      const res = await this.callProvider(system, messages, ctx, true);

      if (res.toolCalls.length === 0) {
        return textOrFallback(res.text);
      }

      messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });
      const toolResults: ToolResult[] = [];
      for (const call of res.toolCalls) {
        toolResults.push(await this.dispatch(call, ctx));
      }
      messages.push({ role: 'tool', toolResults });
    }

    // Budget exhausted while the model still wants tools. Do NOT run more tools
    // (their side effects would fire with their results discarded). Instead make
    // one final call WITHOUT tools so the model closes out from what it gathered.
    logger.warn({ conversationId: ctx.conversationId }, 'max steps reached; closing out');
    ctx.trace.setBudgetExhausted();
    const closing = await this.callProvider(system, messages, ctx, false);
    return textOrFallback(closing.text);
  }

  /** One provider call, timed and recorded on the trace. */
  private async callProvider(
    system: string,
    messages: LlmMessage[],
    ctx: ToolContext,
    withTools: boolean,
  ): Promise<GenerateResult> {
    const useTools = withTools && this.toolSpecs.length > 0;
    const t0 = Date.now();
    const res = await this.provider.generate({
      system,
      messages,
      tools: useTools ? this.toolSpecs : undefined,
      toolChoice: useTools ? 'auto' : undefined,
    });
    ctx.trace.addProviderStep(res, this.provider.name, this.provider.model, Date.now() - t0);
    return res;
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
      // Self-recording tools (e.g. retrieval) already logged a richer step.
      if (!tool.selfRecords) {
        ctx.trace.addToolStep({
          name: call.name,
          input: parsed.data,
          output,
          latencyMs: Date.now() - t0,
          ok: true,
        });
      }
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
