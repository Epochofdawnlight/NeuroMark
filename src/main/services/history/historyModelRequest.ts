import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import type { HistoryEndpoint } from '@preload/history';
import {
  extractCompletionText,
  extractStreamingDeltaText,
} from '../llmStreamUtils';

type HistoryFailure =
  | 'timeout'
  | 'rate-limit'
  | 'http'
  | 'connection'
  | 'response'
  | 'cancelled';

export interface HistoryUsageEvent {
  operation: string;
  rawUsage?: unknown;
  durationMs: number;
  outcome: 'success' | 'error';
  failure?: HistoryFailure;
}

export type HistoryConnection = HistoryEndpoint & {
  apiKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUsage?: (event: HistoryUsageEvent) => void;
};

interface HistoryRequestOptions<T> {
  operation?: string;
  timeoutMs?: number;
  stream?: boolean;
  disableThinking?: boolean;
  parseResponse?: (value: unknown) => T;
}

const maxResponseChars = 1_000_000;
const retryLimitMs = 2_000;
const temporaryHttpStatuses = new Set([408, 429, 500, 502, 503, 504]);
const temporaryConnectionCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w.:-]{1,96}$/.test(value)
    ? value
    : undefined;
}

function connectionCode(error: Error): string | undefined {
  const cause = error.cause as
    | { code?: unknown; cause?: { code?: unknown } }
    | undefined;
  return safeIdentifier(cause?.code ?? cause?.cause?.code);
}

function retryDelay(headers?: Headers): number | undefined {
  if (headers?.get('x-should-retry') === 'false') return undefined;
  const milliseconds = headers?.get('retry-after-ms');
  const secondsOrDate = headers?.get('retry-after');
  const requested = milliseconds
    ? Number(milliseconds)
    : secondsOrDate && Number.isNaN(Number(secondsOrDate))
      ? Date.parse(secondsOrDate) - Date.now()
      : Number(secondsOrDate) * 1_000;
  if (requested > retryLimitMs) return undefined;
  return Math.max(250 + Math.round(Math.random() * 150), requested || 0);
}

function classifyFailure(
  error: unknown,
  operation: string,
  elapsed: number,
  timedOut: boolean,
  cancelled: boolean,
): { failure: HistoryFailure; error: Error; retryMs?: number } {
  const time = `${(elapsed / 1000).toFixed(1)} 秒`;
  if (cancelled)
    return { failure: 'cancelled', error: new Error(`${operation}已取消。`) };
  if (timedOut || error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      failure: 'timeout',
      error: new Error(`${operation}等待超时（${time}）。`),
      retryMs: retryDelay(),
    };
  }
  const code = error instanceof Error ? connectionCode(error) : undefined;
  if (
    error instanceof OpenAI.APIConnectionError ||
    (error instanceof TypeError && code && temporaryConnectionCodes.has(code))
  ) {
    return {
      failure: 'connection',
      error: new Error(
        `${operation}连接中断（${[time, code].filter(Boolean).join('，')}）。`,
      ),
      retryMs:
        !code || temporaryConnectionCodes.has(code) ? retryDelay() : undefined,
    };
  }
  if (error instanceof OpenAI.APIError && error.status) {
    const details = [
      `HTTP ${error.status}`,
      safeIdentifier(error.code ?? error.type),
      time,
      safeIdentifier(error.requestID) && `请求 ID ${error.requestID}`,
    ]
      .filter(Boolean)
      .join('，');
    return {
      failure: error.status === 429 ? 'rate-limit' : 'http',
      error: new Error(`${operation}被模型服务拒绝（${details}）。`),
      retryMs:
        temporaryHttpStatuses.has(error.status) &&
        error.code !== 'insufficient_quota'
          ? retryDelay(error.headers)
          : undefined,
    };
  }
  return {
    failure: 'response',
    error:
      error instanceof HistoryResponseError ||
      (error instanceof Error && error.name === 'ZodError')
        ? error
        : new Error(`${operation}的接口响应格式无效（${time}）。`),
  };
}

class HistoryResponseError extends Error {}

function decodeHistoryResponse(
  operation: string,
  text: string,
  finishReason?: string | null,
): unknown {
  if (text.length > maxResponseChars || finishReason === 'length') {
    throw new HistoryResponseError(`${operation}达到模型输出长度上限。`);
  }
  if (finishReason === 'content_filter')
    throw new HistoryResponseError(`${operation}触发模型服务的内容过滤。`);
  const content = text
    .trim()
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\s*\x60{3}$/, '');
  if (!content) throw new HistoryResponseError(`${operation}未收到模型正文。`);
  try {
    return JSON.parse(content);
  } catch {
    throw new HistoryResponseError(`${operation}收到的模型正文不是有效 JSON。`);
  }
}

function report(config: HistoryConnection, event: HistoryUsageEvent): void {
  try {
    config.onUsage?.(event);
  } catch {
    // A telemetry failure must not change the result of the provider request.
  }
}

export async function requestHistoryJson<T = unknown>(
  config: HistoryConnection,
  system: string,
  user: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
  options: HistoryRequestOptions<T> = {},
): Promise<T> {
  const configuredTimeout = config.timeoutMs ?? options.timeoutMs ?? 90_000;
  const timeout = Number.isFinite(configuredTimeout)
    ? Math.min(600_000, Math.max(1, Math.trunc(configuredTimeout)))
    : 90_000;
  const operation = options.operation ?? '模型请求';
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout,
    maxRetries: 0,
    logLevel: 'off',
  });
  const request = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  };

  for (let attempt = 0; ; attempt++) {
    if (config.signal?.aborted) throw new Error(`${operation}已取消。`);
    const deadline = AbortSignal.timeout(timeout);
    const signal = config.signal
      ? AbortSignal.any([config.signal, deadline])
      : deadline;
    const started = performance.now();
    let rawUsage: unknown;
    try {
      let text = '';
      let finishReason: string | null | undefined;
      if (options.stream) {
        const stream = await client.chat.completions.create(
          {
            ...request,
            stream: true,
            ...(config.onUsage && { stream_options: { include_usage: true } }),
            ...(options.disableThinking && { enable_thinking: false }),
          },
          { signal },
        );
        for await (const chunk of stream) {
          rawUsage = chunk.usage ?? rawUsage;
          const choice = chunk.choices?.[0];
          if (!finishReason)
            text += extractStreamingDeltaText(choice?.delta?.content);
          finishReason = finishReason ?? choice?.finish_reason ?? undefined;
          if (
            text.length > maxResponseChars ||
            (finishReason && (!config.onUsage || rawUsage))
          )
            break;
        }
      } else {
        const response = await client.chat.completions.create(request, {
          signal,
        });
        const payload =
          typeof response === 'string'
            ? (JSON.parse(response) as OpenAI.Chat.Completions.ChatCompletion)
            : response;
        rawUsage = payload?.usage;
        const choice = payload?.choices?.[0];
        if (!choice) throw new SyntaxError('Missing completion choices');
        text = extractCompletionText(choice.message?.content);
        finishReason = choice.finish_reason;
      }
      signal.throwIfAborted();
      const value = decodeHistoryResponse(operation, text, finishReason);
      const result = options.parseResponse
        ? options.parseResponse(value)
        : (value as T);
      report(config, {
        operation,
        rawUsage,
        durationMs: performance.now() - started,
        outcome: 'success',
      });
      return result;
    } catch (error) {
      const durationMs = performance.now() - started;
      const failure = classifyFailure(
        error,
        operation,
        durationMs,
        deadline.aborted,
        config.signal?.aborted ?? false,
      );
      report(config, {
        operation,
        rawUsage,
        durationMs,
        outcome: 'error',
        failure: failure.failure,
      });
      if (attempt > 0 || failure.retryMs === undefined) throw failure.error;
      try {
        await delay(failure.retryMs, undefined, { signal: config.signal });
      } catch {
        throw new Error(`${operation}已取消。`);
      }
    }
  }
}
