import { performance } from 'node:perf_hooks';
import type { FastifyPluginAsync, onRequestAsyncHookHandler } from 'fastify';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import {
  DomEventSchema,
  makeEvent,
  SpeechSignalSchema,
  STREAMS,
  verifySessionToken,
  type Bus,
  type DomEvent,
  type SessionClaims,
  type SpeechSignal,
  type StreamKey,
  type TranscriptTurn,
} from '../contracts/index.js';
import { forbidden, HttpError, notFound, unauthorized } from '../errors.js';
import type { OffRecordState } from '../services/off-record.js';
import type { Redactor } from '../services/redact.js';
import type { SessionRow, Store } from '../store/types.js';

export type WsClientOptions = {
  store: Store;
  bus: Bus;
  redactor: Redactor;
  offRecord: OffRecordState;
  /** Called once per accepted connection, e.g. to open the session's Realtime channel early. */
  onConnect?: (sessionId: string) => void;
  sessionSecret: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    wsSession?: { session: SessionRow; claims: SessionClaims };
  }
}

const TMs = z.number().int().nonnegative();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn'),
    role: z.enum(['user', 'agent']),
    text: z.string().max(10_000),
    t_ms: TMs.optional(),
    turn_id: z.string().min(1).max(64).optional(),
  }),
  z.object({
    type: z.literal('speech'),
    kind: SpeechSignalSchema.shape.kind,
    source: SpeechSignalSchema.shape.source.optional(),
    t_ms: TMs.optional(),
  }),
  DomEventSchema.extend({ type: z.literal('dom'), t_ms: TMs.optional() }),
  z.object({ type: z.literal('agent_event') }).passthrough(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * WS /ws/client/:sid?t=<sk_token> (DESIGN §3). Turns are redacted before they reach the bus;
 * while the session is off the record, turns, speech and DOM events are dropped.
 */
export const wsClientRoutes: FastifyPluginAsync<WsClientOptions> = async (app, opts) => {
  const { store, bus, redactor, offRecord } = opts;

  // Runs before the upgrade, so a rejected client gets a plain HTTP error.
  const authenticate: onRequestAsyncHookHandler = async (request) => {
    const { sid } = request.params as { sid: string };
    const { t } = request.query as { t?: string };
    if (!t) throw unauthorized('Missing sk_token');

    let claims: SessionClaims;
    try {
      claims = await verifySessionToken(t, opts.sessionSecret);
    } catch {
      throw unauthorized('Invalid or expired sk_token');
    }
    if (claims.sid !== sid) throw forbidden('sk_token is for another session');

    const session = await store.getSession(sid);
    if (!session || session.org_id !== claims.org) throw notFound('Session not found');
    if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
    if (!session.consent_at) throw new HttpError(409, 'consent_required', 'Consent has not been recorded');

    request.wsSession = { session, claims };
  };

  app.get('/ws/client/:sid', { websocket: true, onRequest: authenticate }, (socket, request) => {
    const { session } = request.wsSession!;
    const log = request.log.child({ session_id: session.id, org_id: session.org_id });
    const startedAt = Date.parse(session.started_at);
    offRecord.seed(session.id, session.off_record);
    opts.onConnect?.(session.id);
    log.info('client connected');

    const publish = async <T>(stream: StreamKey, type: string, t_ms: number | undefined, data: T) => {
      const ev = makeEvent({
        type,
        org_id: session.org_id,
        session_id: session.id,
        t_ms: t_ms ?? Math.max(0, Date.now() - startedAt),
        producer: 'gateway',
        data,
      });
      await bus.publish(stream, ev);
      return ev;
    };

    const handleTurn = async (msg: Extract<ClientMessage, { type: 'turn' }>) => {
      const received = performance.now();
      if (offRecord.isOn(session.id)) {
        log.info({ t_ms: msg.t_ms }, 'turn dropped: off the record');
        return;
      }
      const redacted = await redactor.redact(msg.text, session.language);
      if (redacted.engine === 'fallback') {
        log.warn({ err: redacted.error }, 'presidio unavailable; turn redacted with fallback patterns');
      }
      // Off-record may have been switched on while Presidio was running.
      if (offRecord.isOn(session.id)) {
        log.info({ t_ms: msg.t_ms }, 'turn dropped: off the record');
        return;
      }
      const turn: TranscriptTurn = {
        turn_id: msg.turn_id ?? ulid(),
        role: msg.role,
        text: redacted.text,
        lang: session.language,
        source: 'live',
        redacted: true,
      };
      const ev = await publish(STREAMS.turns, 'transcript.turn', msg.t_ms, turn);
      log.info(
        {
          event_id: ev.id,
          turn_id: turn.turn_id,
          engine: redacted.engine,
          entities: redacted.entities,
          latency_ms: Math.round(performance.now() - received),
        },
        'turn published',
      );
    };

    // Turns go through one queue so they reach the bus in the order they were spoken.
    let turnQueue = Promise.resolve();

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const msg = parseMessage(raw, isBinary, socket);
      if (!msg) return;

      if (msg.type === 'agent_event') {
        log.info({ agent_event: msg }, 'agent event');
        return;
      }
      if (msg.type === 'turn') {
        turnQueue = turnQueue
          .then(() => handleTurn(msg))
          .catch((err) => log.error({ err }, 'turn failed'));
        return;
      }
      if (offRecord.isOn(session.id)) {
        log.debug({ type: msg.type }, 'message dropped: off the record');
        return;
      }
      const sent =
        msg.type === 'speech'
          ? publish<SpeechSignal>(STREAMS.speech, 'speech.signal', msg.t_ms, {
              kind: msg.kind,
              source: msg.source ?? 'sdk',
            })
          : publish<DomEvent>(STREAMS.dom, 'dom.event', msg.t_ms, stripEnvelopeFields(msg));
      sent.catch((err) => log.error({ err, type: msg.type }, 'publish failed'));
    });

    socket.on('close', (code: number) => log.info({ code }, 'client disconnected'));
  });
};

function parseMessage(raw: RawData, isBinary: boolean, socket: WebSocket): ClientMessage | null {
  if (isBinary) {
    sendError(socket, 'Binary messages are not accepted on /ws/client');
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    sendError(socket, 'Message is not valid JSON');
    return null;
  }
  const parsed = ClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendError(socket, issue ? `${issue.path.join('.') || 'message'}: ${issue.message}` : 'Invalid message');
    return null;
  }
  return parsed.data;
}

function sendError(socket: WebSocket, message: string) {
  socket.send(JSON.stringify({ type: 'error', error: 'bad_message', message }));
}

function stripEnvelopeFields({ type: _type, t_ms: _t, ...dom }: Extract<ClientMessage, { type: 'dom' }>): DomEvent {
  return dom;
}
