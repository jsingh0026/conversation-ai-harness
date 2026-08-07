import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockCrmClient } from '../crm/mock.js';
import type { InboundMessage } from '../crm/types.js';
import { StubProvider, textResult, toolCallResult } from '../testkit/stub-provider.js';
import type { AgentTool } from './agent-tool.js';
import { ConversationStore } from './history.js';
import { Orchestrator } from './orchestrator.js';

const msg = (body: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: 'm1',
  conversationId: 'c1',
  contactId: 'ct1',
  body,
  channel: 'SMS',
  timestamp: '2026-08-08T00:00:00Z',
  ...over,
});

describe('Orchestrator', () => {
  it('answers chit-chat in one round-trip and sends the reply', async () => {
    const crm = new MockCrmClient();
    const provider = new StubProvider([textResult('Hi there!')]);
    const orch = new Orchestrator({ provider, crm });

    const trace = await orch.runTurn(msg('hello'));

    expect(crm.lastSent()?.body).toBe('Hi there!');
    expect(trace.decision).toBe('chitchat');
    expect(trace.reply).toBe('Hi there!');
    expect(trace.steps).toHaveLength(1);
    expect(trace.tokens.outputTokens).toBe(5);
  });

  it('runs a tool then answers, recording the tool step', async () => {
    const crm = new MockCrmClient();
    const calls: unknown[] = [];
    const echo: AgentTool = {
      spec: { name: 'echo', description: 'echo', parameters: z.object({ v: z.string() }) },
      run: async (args) => {
        calls.push(args);
        return { echoed: (args as { v: string }).v };
      },
    };
    const provider = new StubProvider([
      toolCallResult([{ id: 't1', name: 'echo', args: { v: 'x' } }]),
      textResult('done'),
    ]);
    const orch = new Orchestrator({ provider, crm, tools: [echo] });

    const trace = await orch.runTurn(msg('do it'));

    expect(calls).toEqual([{ v: 'x' }]);
    expect(crm.lastSent()?.body).toBe('done');
    expect(trace.decision).toBe('skill:echo');
    const toolStep = trace.steps.find((s) => s.type === 'tool');
    expect(toolStep).toMatchObject({ name: 'echo', ok: true, output: { echoed: 'x' } });
    // second generate() should have seen the tool result in its messages
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('stays silent when the bot is disabled (already handed over)', async () => {
    const crm = new MockCrmClient();
    await crm.setBotEnabled('c1', false);
    const provider = new StubProvider([textResult('should not send')]);
    const orch = new Orchestrator({ provider, crm });

    const trace = await orch.runTurn(msg('hi'));

    expect(crm.lastSent()).toBeUndefined();
    expect(trace.decision).toBe('bot_disabled');
    expect(trace.reply).toBeNull();
  });

  it('feeds an error result back when a tool is unknown, then continues', async () => {
    const crm = new MockCrmClient();
    const provider = new StubProvider([
      toolCallResult([{ id: 't1', name: 'nope', args: {} }]),
      textResult('recovered'),
    ]);
    const orch = new Orchestrator({ provider, crm });

    const trace = await orch.runTurn(msg('hi'));

    expect(crm.lastSent()?.body).toBe('recovered');
    const toolStep = trace.steps.find((s) => s.type === 'tool');
    expect(toolStep).toMatchObject({ ok: false });
  });

  it('rejects invalid tool args without calling the tool', async () => {
    const crm = new MockCrmClient();
    let ran = false;
    const tool: AgentTool = {
      spec: { name: 'strict', description: 't', parameters: z.object({ n: z.number() }) },
      run: async () => {
        ran = true;
        return {};
      },
    };
    const provider = new StubProvider([
      toolCallResult([{ id: 't1', name: 'strict', args: { n: 'not-a-number' } }]),
      textResult('ok'),
    ]);
    const orch = new Orchestrator({ provider, crm, tools: [tool] });

    await orch.runTurn(msg('hi'));
    expect(ran).toBe(false);
  });

  it('carries conversation history across turns', async () => {
    const crm = new MockCrmClient();
    const history = new ConversationStore();
    const provider = new StubProvider([textResult('one'), textResult('two')]);
    const orch = new Orchestrator({ provider, crm, history });

    await orch.runTurn(msg('first', { messageId: 'm1' }));
    await orch.runTurn(msg('second', { messageId: 'm2' }));

    // Second turn's request should include the first user+assistant exchange.
    const secondReqMessages = provider.requests[1]?.messages ?? [];
    expect(secondReqMessages.length).toBe(3); // user, assistant, user
    expect(secondReqMessages[0]).toEqual({ role: 'user', content: 'first' });
  });

  it('bails with a fallback after hitting max steps', async () => {
    const crm = new MockCrmClient();
    const loopTool: AgentTool = {
      spec: { name: 'echo', description: 'e', parameters: z.object({}) },
      run: async () => ({}),
    };
    // Always ask for a tool call → never terminates on its own.
    const provider = new StubProvider(() => toolCallResult([{ id: 't', name: 'echo', args: {} }]));
    const orch = new Orchestrator({ provider, crm, tools: [loopTool], maxSteps: 3 });

    const trace = await orch.runTurn(msg('loop'));
    expect(crm.lastSent()?.body).toMatch(/team member/i);
    expect(trace.steps.filter((s) => s.type === 'provider_call')).toHaveLength(3);
  });
});
