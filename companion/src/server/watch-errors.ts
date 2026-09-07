import type { FastifyReply, FastifyRequest } from "fastify";
import { errorResponseSchema, type WatchError } from "../protocol/index.js";

const errors = {
  AUTH_REQUIRED: {
    statusCode: 401,
    message: "Pair this watch with the companion.",
    retryable: false
  },
  DEVICE_REVOKED: {
    statusCode: 401,
    message: "This watch was removed. Pair it again.",
    retryable: false
  },
  PAIRING_CODE_INVALID: {
    statusCode: 400,
    message: "Check the pairing code and try again.",
    retryable: false
  },
  PAIRING_CODE_EXPIRED: {
    statusCode: 400,
    message: "Create a new pairing code in the companion.",
    retryable: false
  },
  PROTOCOL_UNSUPPORTED: {
    statusCode: 426,
    message: "Update the companion or watch application.",
    retryable: false
  },
  RATE_LIMITED: {
    statusCode: 429,
    message: "Wait before trying again.",
    retryable: true
  },
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The watch sent an invalid request.",
    retryable: false
  },
  PLAYLIST_NOT_FOUND: {
    statusCode: 404,
    message: "The playlist was removed from Plex.",
    retryable: false
  },
  TRACK_NOT_FOUND: {
    statusCode: 404,
    message: "The track was removed from Plex.",
    retryable: false
  },
  PLEX_UNAVAILABLE: {
    statusCode: 503,
    message: "The Plex server is unavailable. Try again later.",
    retryable: true
  },
  PLEX_TOKEN_INVALID: {
    statusCode: 401,
    message: "Reconnect Plex in the companion.",
    retryable: false
  },
  TRANSCODE_FAILED: {
    statusCode: 502,
    message: "Plex could not convert this track.",
    retryable: true
  },
  INTERNAL_ERROR: {
    statusCode: 500,
    message: "The companion could not complete the request.",
    retryable: true
  }
} as const;

export type WatchRouteErrorCode = keyof typeof errors;

export function sendWatchError(request: FastifyRequest, reply: FastifyReply, code: WatchRouteErrorCode) {
  const definition = errors[code];
  const body: WatchError = {
    error: {
      code,
      message: definition.message,
      retryable: definition.retryable,
      requestId: request.id
    }
  };
  return reply.code(definition.statusCode).send(errorResponseSchema.parse(body));
}
