// TEMPORARY: replace with @sidekik/contracts (see ./README.md). Publish only; consume comes with egress.
import { Redis } from 'ioredis';
import type { Envelope, ServiceName } from './envelope.js';
import type { StreamKey } from './streams.js';

export interface Bus {
  publish<T>(stream: StreamKey, ev: Envelope<T>): Promise<string>;
  close(): Promise<void>;
}

export function createBus(redisUrl: string, _service: ServiceName): Bus & { redis: Redis } {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  return {
    redis,
    async publish(stream, ev) {
      const id = await redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'data', JSON.stringify(ev));
      if (!id) throw new Error(`XADD to ${stream} returned no id`);
      return id;
    },
    async close() {
      await redis.quit();
    },
  };
}
