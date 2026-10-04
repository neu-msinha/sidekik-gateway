import { describe, expect, it } from 'vitest';
import { makeEvent, STREAMS, type WorkMapPublished } from '../src/contracts/index.js';
import { createCurrentWorkMapUpdater } from '../src/services/current-workmap.js';
import { buildTestApp } from './helpers.js';
import { fakeBus, memoryStore } from './fakes/index.js';

const ORG = '00000000-0000-4000-8000-00000000a001';
const WORKFLOW = '00000000-0000-4000-8000-00000000b001';
const EXPERT = '00000000-0000-4000-8000-00000000e001';
const V1 = '00000000-0000-4000-8000-00000000c001';
const V2 = '00000000-0000-4000-8000-00000000c002';

const published = (workmap_id: string, version: number, org_id = ORG) =>
  makeEvent<WorkMapPublished>({
    type: 'workmap.published',
    org_id,
    session_id: '00000000-0000-4000-8000-00000000d001',
    t_ms: 0,
    producer: 'mapper',
    data: { workmap_id, workflow_id: WORKFLOW, version },
  });

function setup(currentId: string | null = V1) {
  const store = memoryStore({
    workflows: [{ id: WORKFLOW, org_id: ORG, name: 'Supplier invoice coding', current_workmap_id: currentId }],
    workmaps: [
      { id: V1, org_id: ORG, workflow_id: WORKFLOW, expert_id: EXPERT, version: 1 },
      { id: V2, org_id: ORG, workflow_id: WORKFLOW, expert_id: EXPERT, version: 2 },
    ],
  });
  const logs: string[] = [];
  const log = { info: (_: object, msg: string) => logs.push(msg), warn: (_: object, msg: string) => logs.push(msg) };
  const current = () => store.data.workflows[0]!.current_workmap_id;
  return { store, logs, current, update: createCurrentWorkMapUpdater({ store, log }) };
}

describe('current Work Map on workmap.published', () => {
  it('points the workflow at the published map, through the bus consumer', async () => {
    const { store, current } = setup();
    const bus = fakeBus();
    const app = await buildTestApp({ store, bus });
    await app.ready();
    await bus.deliver(STREAMS.workmapPublished, published(V2, 2));
    expect(current()).toBe(V2);
    await app.close();
  });

  it('sets the pointer when the workflow has none yet', async () => {
    const { update, current } = setup(null);
    await update(published(V1, 1));
    expect(current()).toBe(V1);
  });

  it('keeps a newer current map when an older version is published again', async () => {
    const { update, current, logs } = setup(V2);
    await update(published(V1, 1));
    expect(current()).toBe(V2);
    expect(logs).toEqual(['older Work Map published; current map kept']);
  });

  it('ignores another org and an unknown workflow, and does nothing on redelivery', async () => {
    const { store, update, current, logs } = setup();
    await update(published(V2, 2, '00000000-0000-4000-8000-00000000a999'));
    expect(current()).toBe(V1);
    store.data.workflows = [];
    await update(published(V2, 2));
    expect(logs).toEqual([
      'workmap.published for an unknown workflow or another org; ignored',
      'workmap.published for an unknown workflow or another org; ignored',
    ]);

    const again = setup(V2);
    await again.update(published(V2, 2));
    expect(again.logs).toEqual([]);
  });
});
