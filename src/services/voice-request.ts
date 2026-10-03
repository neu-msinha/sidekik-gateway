import type { SessionRow, Store } from '../store/types.js';
import type { VoiceTokenRequest } from './voice.js';

export type VoiceSessionInfo = Pick<
  SessionRow,
  'id' | 'workflow_id' | 'kind' | 'phase' | 'language' | 'expert_id' | 'learner_id' | 'workmap_id'
>;

/**
 * The voice `/internal/token` request for a session's current phase, with the dynamic variables
 * the agents' prompts use (sidekik-voice DESIGN §3): `{{expert_name}}`, `{{workflow_name}}`,
 * `{{language}}`, `{{prior_summary}}`, `{{open_items}}`, `{{learner_name}}`, plus `session_id` for tools.
 */
export async function voiceRequestFor(
  store: Store,
  s: VoiceSessionInfo,
  workflowName?: string,
): Promise<VoiceTokenRequest> {
  const workflow_name =
    workflowName ?? (await store.getWorkflow(s.workflow_id))?.name ?? 'the workflow';
  const base = { session_id: s.id, workflow_name, language: s.language };

  if (s.kind === 'tutor') {
    const workmap = s.workmap_id ? await store.getWorkMap(s.workmap_id) : null;
    const [learner, expert] = await Promise.all([
      s.learner_id ? store.getLearner(s.learner_id) : null,
      workmap ? store.getExpert(workmap.expert_id) : null,
    ]);
    return {
      agent: 'tutor',
      phase: 'tutoring',
      session_id: s.id,
      language: s.language,
      dynamic_variables: {
        ...base,
        learner_name: learner?.display_name ?? 'the learner',
        expert_name: expert?.display_name ?? 'the expert',
      },
    };
  }

  const expert = s.expert_id ? await store.getExpert(s.expert_id) : null;
  const expert_name = expert?.display_name ?? 'the expert';
  if (s.phase === 'debrief') {
    return {
      agent: 'interviewer',
      phase: 'debrief',
      session_id: s.id,
      language: s.language,
      dynamic_variables: { ...base, expert_name },
    };
  }
  const memory = expert ? await store.getExpertMemory(expert.id, s.workflow_id) : null;
  return {
    agent: 'interviewer',
    phase: 'capture',
    session_id: s.id,
    language: s.language,
    dynamic_variables: {
      ...base,
      expert_name,
      prior_summary: memory?.summary || 'none',
      open_items: memory?.open_items.join('; ') || 'none',
    },
  };
}
