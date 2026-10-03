// Integration test against a real Redis. Runs only when REDIS_TEST_URL is set, e.g.
//   docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis
//   REDIS_TEST_URL=redis://localhost:6379/15 pnpm test bus.redis
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, DLQ_STREAM, makeEvent, type AgentCommand, type Envelope, type StreamKey } from '../src/contracts/index.js';

const url = process.env.REDIS_TEST_URL;
const quiet = { warn: () => {}, error: () => {} };

describe.skipIf(!url)('bus (Redis)', () => {
  let bus: ReturnType<typeof createBus>;
  beforeAll(async () => {
    bus = createBus(url!, 'gateway', quiet);
    await bus.redis.flushdb();
  });
  afterAll(() => bus.close());

  // Unique stream per test so runs don't interfere; typed as a StreamKey for the API.
  const freshStream = () => `sk:test.${randomUUID()}` as StreamKey;
  const ask = (text: string) =>
    makeEvent<AgentCommand>({
      type: 'agent.command',
      org_id: 'o',
      session_id: 's',
      t_ms: 0,
      producer: 'brain',
      data: { type: 'ask', question_id: 'q', text, qtype: 'why' },
    });

  it('delivers published events in order and acks them', async () => {
    const stream = freshStream();
    const seen: string[] = [];
    const stop = bus.consume<AgentCommand>(stream, async (ev) => {
      seen.push((ev.data as { text: string }).text);
    });
    await vi.waitFor(async () => expect(await bus.redis.exists(stream)).toBe(1));
    for (const t of ['a', 'b', 'c']) await bus.publish(stream, ask(t));

    await vi.waitFor(() => expect(seen).toEqual(['a', 'b', 'c']), { timeout: 3000 });
    await vi.waitFor(async () => expect(((await bus.redis.xpending(stream, 'gateway')) as unknown[])[0]).toBe(0));
    stop();
  });

  it('dead-letters an event after 3 failed attempts', async () => {
    const stream = freshStream();
    let attempts = 0;
    const stop = bus.consume(stream, async () => {
      attempts++;
      throw new Error('boom');
    });
    await vi.waitFor(async () => expect(await bus.redis.exists(stream)).toBe(1));
    await bus.publish(stream, ask('x'));

    await vi.waitFor(async () => expect(await bus.redis.xlen(DLQ_STREAM)).toBeGreaterThan(0), { timeout: 3000 });
    expect(attempts).toBe(3);
    stop();
  });

  it('acks invalid events without calling the handler', async () => {
    const stream = 'sk:agent.commands' as StreamKey;
    const handled: Envelope<unknown>[] = [];
    const stop = bus.consume(stream, async (ev) => {
      handled.push(ev);
    }, { group: `test-${randomUUID()}` });
    await vi.waitFor(async () => expect(await bus.redis.exists(stream)).toBe(1));

    await bus.redis.xadd(stream, '*', 'data', 'not json');
    await bus.publish(stream, { ...ask('ok'), data: { type: 'ask' } } as Envelope<unknown>);
    await bus.publish(stream, ask('valid'));

    await vi.waitFor(() => expect(handled).toHaveLength(1), { timeout: 3000 });
    expect((handled[0]!.data as { text: string }).text).toBe('valid');
    stop();
  });
});
