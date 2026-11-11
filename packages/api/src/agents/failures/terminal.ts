import { ErrorTypes } from 'librechat-data-provider';
import type { SafeErrorMetadata } from '../../utils/errors';
import type { ModelErrorTrackerCallback } from './tracker';
import {
  resolveLangChainError,
  getModelStreamFailure,
  resolveModelStreamError,
  getProviderErrorMessage,
} from '../errors';
import { getSafeErrorMetadata, isOwnedAbortError } from '../../utils/errors';
import { traceIdForMessage } from '../../langfuse/trace';
import { createModelErrorTracker } from './tracker';

const UPSTREAM_MODEL_ERROR_CODE = 'UPSTREAM_MODEL_ERROR';
const UPSTREAM_MODEL_ERROR_ORIGIN = 'model_provider';
const UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE = '_OTHER';
const UPSTREAM_MODEL_ERROR_FALLBACK = 'The model provider could not complete this request.';

/**
 * Shamwari: refusals the Shamwari gateway makes on purpose, with the plain sentence a person
 * should read (FORK.md). The OpenAI client keeps only the error code from the gateway's body,
 * so without this the person sees `409 "scope_requires_local_inference"` and not why.
 *
 * The text is constant, never taken from the provider, so it is safe to show even when a content
 * policy withholds provider text. Rule 1 is unchanged: the gateway still refuses; this only
 * explains the refusal.
 */
const SHAMWARI_GATEWAY_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  scope_requires_local_inference:
    'Personal-layer data cannot be sent to an external inference provider. ' +
    'This chat generates its answers in the cloud, so it cannot use your personal information. ' +
    'Ask again without it, or use Shamwari Mind on your device.',
});

function readProperty(error: unknown, property: string): unknown {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  try {
    return Reflect.get(error, property);
  } catch {
    return undefined;
  }
}

/** The plain sentence for a known gateway refusal, or undefined for anything else. */
export function getShamwariGatewayRefusal(error: unknown): string | undefined {
  const candidates = [readProperty(error, 'error'), readProperty(error, 'code')];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate in SHAMWARI_GATEWAY_REFUSALS) {
      return SHAMWARI_GATEWAY_REFUSALS[candidate];
    }
  }
  const message = readProperty(error, 'message');
  if (typeof message === 'string') {
    for (const code of Object.keys(SHAMWARI_GATEWAY_REFUSALS)) {
      if (message.includes(code)) {
        return SHAMWARI_GATEWAY_REFUSALS[code];
      }
    }
  }
  return undefined;
}

function safelyResolveLangChainError(error: unknown): string | undefined {
  try {
    return resolveLangChainError(error);
  } catch {
    return undefined;
  }
}

export interface UpstreamModelErrorMetadata extends SafeErrorMetadata {
  readonly errorCode: typeof UPSTREAM_MODEL_ERROR_CODE;
  readonly errorOrigin: typeof UPSTREAM_MODEL_ERROR_ORIGIN;
  readonly errorType: string;
  readonly traceId?: string;
}

export interface TerminalRunErrorLogger {
  error(message: string, metadata: SafeErrorMetadata | UpstreamModelErrorMetadata): void;
}

export interface TerminalRunErrorObserver {
  readonly modelCallback: ModelErrorTrackerCallback;
  readonly log: (error: unknown, signal?: AbortSignal) => void;
  readonly getUserFacingError: (error: unknown, fallback: () => string) => string;
}

/** A run cancellation requires host-owned abort state plus its own reason or an abort shape. */
export function isAgentRunCancellation(error: unknown, signal?: AbortSignal): boolean {
  return isOwnedAbortError(error, signal);
}

/** Preserve rejection status; a successful status can still precede a broken response body. */
function getUpstreamErrorType(error: unknown, status?: number): string {
  if (status != null && status >= 400) {
    return String(status);
  }
  const streamFailure = getModelStreamFailure(error);
  if (streamFailure != null) {
    return `stream_${streamFailure}`;
  }
  return status == null ? UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE : String(status);
}

export function getUpstreamModelErrorMetadata(
  error: unknown,
  responseMessageId?: string,
): UpstreamModelErrorMetadata {
  const safeMetadata = getSafeErrorMetadata(error);
  return {
    ...safeMetadata,
    errorCode: UPSTREAM_MODEL_ERROR_CODE,
    errorOrigin: UPSTREAM_MODEL_ERROR_ORIGIN,
    errorType: getUpstreamErrorType(error, safeMetadata.status),
    ...(typeof responseMessageId === 'string' && responseMessageId !== ''
      ? { traceId: traceIdForMessage(responseMessageId) }
      : {}),
  };
}

/** Applies one terminal-run log taxonomy to every agent ingress. */
export function createTerminalRunErrorObserver({
  logger,
  responseMessageId,
  source,
  protectionEnabled,
  maxProviderErrorChars,
  genericMessage = `${source} Error:`,
}: {
  logger: TerminalRunErrorLogger;
  responseMessageId?: string;
  source: string;
  /**
   * Whether a content policy inspects this deployment's traffic. A provider error body may echo
   * submitted content, so its text stays out of the failure a reader sees while one is active —
   * the same condition every other user-facing failure text is decided by. Omission fails closed
   * for JavaScript callers and older integrations.
   */
  protectionEnabled?: boolean;
  maxProviderErrorChars?: number;
  genericMessage?: string;
}): TerminalRunErrorObserver {
  const modelErrorTracker = createModelErrorTracker();
  return Object.freeze({
    modelCallback: modelErrorTracker.callback,
    getUserFacingError(error: unknown, fallback: () => string) {
      const upstreamModelError = modelErrorTracker.getUpstreamModelError(error);
      if (upstreamModelError == null) {
        return fallback();
      }

      const { status } = getSafeErrorMetadata(upstreamModelError);
      const classifiedError =
        safelyResolveLangChainError(error) ??
        safelyResolveLangChainError(upstreamModelError) ??
        (status == null || status < 400
          ? (resolveModelStreamError(upstreamModelError) ?? resolveModelStreamError(error))
          : undefined);
      if (classifiedError != null) {
        return classifiedError;
      }

      const shamwariRefusal =
        getShamwariGatewayRefusal(upstreamModelError) ?? getShamwariGatewayRefusal(error);
      if (shamwariRefusal != null) {
        return shamwariRefusal;
      }

      /** Unclassified: the provider's own explanation is the only account of what happened, and a
       *  rejection from a gateway or proxy carries it as the whole point of the 400. The status
       *  headlines it either way, so a deployment withholding provider text loses no taxonomy. */
      const providerMessage =
        protectionEnabled !== false
          ? undefined
          : (getProviderErrorMessage(upstreamModelError, maxProviderErrorChars) ??
            getProviderErrorMessage(error, maxProviderErrorChars));
      return `${UPSTREAM_MODEL_ERROR_FALLBACK}\n${JSON.stringify({
        type: ErrorTypes.UPSTREAM_MODEL_ERROR,
        ...(status != null ? { status } : {}),
        ...(providerMessage != null ? { message: providerMessage } : {}),
      })}`;
    },
    log(error: unknown, signal?: AbortSignal) {
      if (isAgentRunCancellation(error, signal)) {
        return;
      }

      const upstreamModelError = modelErrorTracker.getUpstreamModelError(error);
      if (upstreamModelError == null) {
        logger.error(genericMessage, getSafeErrorMetadata(error));
        return;
      }

      logger.error(
        `${source} Upstream model error`,
        getUpstreamModelErrorMetadata(upstreamModelError, responseMessageId),
      );
    },
  });
}
