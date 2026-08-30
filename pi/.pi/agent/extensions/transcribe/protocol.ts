import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// Wire shapes mirror transcribe-server/src/api.rs (LiveEvent, Transcription,
// ErrorEnvelope). Live and batch responses use different vocabularies, so they
// get independent schemas and parsers rather than a shared union.

const LiveReadyEventSchema = Type.Object(
  {
    type: Type.Literal("ready"),
    model: Type.String(),
    sample_rate: Type.Number(),
    frame_samples: Type.Number(),
    max_audio_ms: Type.Number(),
  },
  { additionalProperties: false },
);

const LiveRevisionEventSchema = Type.Object(
  {
    type: Type.Literal("revision"),
    revision: Type.Number(),
    input_received_ms: Type.Number(),
    audio_committed_ms: Type.Number(),
    buffered_ms: Type.Number(),
    committed: Type.String(),
    tentative: Type.String(),
  },
  { additionalProperties: false },
);

const LiveFinalEventSchema = Type.Object(
  {
    type: Type.Literal("final"),
    text: Type.String(),
    model: Type.String(),
    audio_ms: Type.Number(),
    inference_ms: Type.Number(),
    mel_ms: Type.Number(),
    encode_ms: Type.Number(),
    decode_ms: Type.Number(),
  },
  { additionalProperties: false },
);

const LiveErrorEventSchema = Type.Object(
  {
    type: Type.Literal("error"),
    code: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

const LiveEventSchema = Type.Union([
  LiveReadyEventSchema,
  LiveRevisionEventSchema,
  LiveFinalEventSchema,
  LiveErrorEventSchema,
]);

export type LiveReadyEvent = Static<typeof LiveReadyEventSchema>;
export type LiveRevisionEvent = Static<typeof LiveRevisionEventSchema>;
export type LiveFinalEvent = Static<typeof LiveFinalEventSchema>;
export type LiveErrorEvent = Static<typeof LiveErrorEventSchema>;
export type LiveEvent = Static<typeof LiveEventSchema>;

/** Strictly validates one live-transcription server event (closed variant). */
export function parseLiveEvent(raw: string): LiveEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Live transcription server sent invalid JSON");
  }
  if (!Value.Check(LiveEventSchema, parsed)) {
    throw new Error("Live transcription server sent a malformed event");
  }
  return parsed;
}

const BatchSuccessSchema = Type.Object(
  {
    text: Type.String(),
    language: Type.Union([Type.String(), Type.Null()]),
    model: Type.String(),
    audio_ms: Type.Number(),
    inference_ms: Type.Number(),
    mel_ms: Type.Number(),
    encode_ms: Type.Number(),
    decode_ms: Type.Number(),
  },
  { additionalProperties: false },
);

export type BatchSuccess = Static<typeof BatchSuccessSchema>;

/** Strictly validates a successful `POST /api/transcribe` response body. */
export function parseBatchSuccess(raw: string): BatchSuccess {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Transcription server sent invalid JSON");
  }
  if (!Value.Check(BatchSuccessSchema, parsed)) {
    throw new Error("Transcription server sent a malformed response");
  }
  return parsed;
}

const BatchErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type BatchError = Static<typeof BatchErrorEnvelopeSchema>["error"];

/** Strictly validates a `{"error":{"code","message"}}` envelope. */
export function parseBatchError(raw: string): BatchError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Transcription server sent invalid error JSON");
  }
  if (!Value.Check(BatchErrorEnvelopeSchema, parsed)) {
    throw new Error("Transcription server sent a malformed error response");
  }
  return parsed.error;
}
