/**
 * Aholo Open API client.
 *
 * Verified against the platform's OpenAPI 3.0.3 spec (30 endpoints,
 * `AHOLO Open API`), not guessed:
 *
 *   base URL   https://api.aholo3d.cn
 *   auth       header `Authorization: <API key>`   (no "Bearer" prefix)
 *   envelope   { c, m, d, f }   — c === "0" means success, else m says why
 *
 * Only the Lux3D text-to-3D pipeline the game actually needs is wrapped here;
 * the rest of the platform (world reconstruction, cloud render, spatial
 * understanding) is listed in docs/03-Aholo接入.md so it can be added without
 * re-deriving the auth and error conventions.
 *
 * Runs on any runtime with global `fetch` — browser, Node 18+, Deno, workers.
 */

export const AHOLO_BASE_URL = 'https://api.aholo3d.cn';

export interface AholoEnvelope<T> {
  /** "0" on success. */
  c: string;
  /** Human-readable message; "" on success. */
  m: string;
  d: T | null;
  /** Failure detail object; null on success. */
  f: Record<string, unknown> | null;
}

export class AholoError extends Error {
  readonly code: string;
  readonly detail: unknown;

  // Written without TypeScript parameter properties on purpose: this module is
  // imported directly by `node tools/generate-assets.mjs`, and Node's built-in
  // type stripping rejects parameter properties. Keeping the file to erasable
  // syntax means one implementation serves both the browser and the CLI.
  constructor(message: string, code = 'unknown', detail?: unknown) {
    super(message);
    this.name = 'AholoError';
    this.code = code;
    this.detail = detail;
  }
}

/** Task lifecycle, per the spec: 0 init, 1 running, 3 success, 4 failed, 6 cancelled. */
export const TASK_STATUS = {
  INIT: 0,
  RUNNING: 1,
  SUCCESS: 3,
  FAILED: 4,
  CANCELLED: 6,
} as const;

export type TaskStatusValue = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export interface TaskOutput {
  content: string | null;
}

export interface TaskResult {
  taskId: number;
  status: TaskStatusValue;
  outputs: TaskOutput[];
  /** Present when the platform reports why a task failed. */
  failReason?: string;
}

export interface TextTo3DRequest {
  /** Natural-language prompt. Required. */
  prompt: string;
  /** Omit to use the platform default (photorealistic). */
  style?: 'photorealistic' | 'cartoon' | 'anime' | 'hand_painted' | 'cyberpunk' | 'fantasy' | 'glass';
  /** Optional public reference image URL. */
  img?: string;
  /**
   * G1 always returns ZIP + GLB. G1-Turbo returns only what you ask for.
   * G1 is the safer default because the GLB is guaranteed.
   */
  version?: 'G1' | 'G1-Turbo';
  /** Target mesh face count, 10000-300000. Ignored for PLY output. */
  faceCount?: number;
  outputFormat?: ('zip' | 'glb' | 'ply')[];
  /** G1-Turbo only: PBR mesh (true/omitted) or untextured (false). */
  enablePbr?: boolean;
  /** AI size prediction and rescaling. Omitted behaves as true. */
  aiPredictSize?: boolean;
}

export interface AholoClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Retries for transient network / 429 / 5xx responses. */
  maxRetries?: number;
  onLog?: (message: string) => void;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  query?: Record<string, string | number>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AholoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly onLog: (message: string) => void;

  constructor(options: AholoClientOptions) {
    if (!options.apiKey) {
      throw new AholoError('An Aholo API key is required.', 'no-api-key');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? AHOLO_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.onLog = options.onLog ?? (() => {});
    if (typeof this.fetchImpl !== 'function') {
      throw new AholoError('No fetch implementation available.', 'no-fetch');
    }
  }

  /* ------------------------------------------------------------------ *
   * Lux3D generation
   * ------------------------------------------------------------------ */

  /** Creates a text-to-3D task and returns its id. */
  async createTextTo3DTask(request: TextTo3DRequest): Promise<number> {
    if (!request.prompt || !request.prompt.trim()) {
      throw new AholoError('prompt must contain non-whitespace text.', 'bad-prompt');
    }
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      // G1 guarantees a GLB in the outputs even if the format list is odd
      version: request.version ?? 'G1',
      outputFormat: request.outputFormat ?? ['glb'],
    };
    if (request.style) payload.style = request.style;
    if (request.img) payload.img = request.img;
    if (request.faceCount !== undefined) payload.faceCount = request.faceCount;
    if (request.enablePbr !== undefined) payload.enablePbr = request.enablePbr;
    if (request.aiPredictSize !== undefined) payload.aiPredictSize = request.aiPredictSize;

    const data = await this.request<number>({
      method: 'POST',
      path: '/lux3d/v1/generate/text-to-3d/task/create',
      body: payload,
    });
    if (typeof data !== 'number') {
      throw new AholoError(`Expected a numeric task id, got ${JSON.stringify(data)}`, 'bad-task-id', data);
    }
    return data;
  }

  async getTask(taskId: number): Promise<TaskResult> {
    const data = await this.request<{
      taskId: number;
      status: number;
      outputs?: TaskOutput[];
      failReason?: string;
      message?: string;
    }>({
      method: 'GET',
      path: '/lux3d/v1/generate/task/get',
      query: { taskid: taskId },
    });

    return {
      taskId: data?.taskId ?? taskId,
      status: (data?.status ?? TASK_STATUS.INIT) as TaskStatusValue,
      outputs: data?.outputs ?? [],
      failReason: data?.failReason ?? data?.message ?? undefined,
    };
  }

  /**
   * Polls until the task settles. Result URLs expire two hours after the task
   * completes, so callers must download promptly rather than cache the URL.
   */
  async waitForTask(
    taskId: number,
    options: {
      timeoutMs?: number;
      pollMs?: number;
      onProgress?: (elapsedMs: number, status: TaskStatusValue) => void;
    } = {},
  ): Promise<TaskResult> {
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const pollMs = options.pollMs ?? 4000;
    const started = Date.now();

    for (;;) {
      const result = await this.getTask(taskId);
      if (result.status === TASK_STATUS.SUCCESS) return result;
      if (result.status === TASK_STATUS.FAILED || result.status === TASK_STATUS.CANCELLED) {
        throw new AholoError(
          `Task ${taskId} ${result.status === TASK_STATUS.FAILED ? 'failed' : 'was cancelled'}` +
            (result.failReason ? `: ${result.failReason}` : ''),
          result.status === TASK_STATUS.FAILED ? 'task-failed' : 'task-cancelled',
          result,
        );
      }
      if (Date.now() - started > timeoutMs) {
        throw new AholoError(`Task ${taskId} still running after ${timeoutMs} ms`, 'task-timeout', result);
      }
      options.onProgress?.(Date.now() - started, result.status);
      await sleep(pollMs);
    }
  }

  /**
   * Picks the GLB URL out of a completed task.
   *
   * Output order is documented as ZIP, GLB for G1 (and only the requested
   * formats for G1-Turbo), but we sniff by extension so the function survives
   * either version, extra PLY outputs, and `NOT_REQUESTED` placeholders.
   */
  static findGlbUrl(result: TaskResult): string | null {
    const contents = result.outputs
      .map((o) => o.content)
      .filter((c): c is string => typeof c === 'string' && c.length > 0 && c !== 'NOT_REQUESTED');

    const byExtension = contents.find((url) => /\.glb(\?|#|$)/i.test(url));
    if (byExtension) return byExtension;

    // fall back to the documented position for G1
    const second = contents[1];
    return second && /^https?:/i.test(second) ? second : null;
  }

  /** Create -> poll -> return the GLB URL. The whole one-asset pipeline. */
  async generateGlb(
    request: TextTo3DRequest,
    options: {
      timeoutMs?: number;
      pollMs?: number;
      onProgress?: (elapsedMs: number, status: TaskStatusValue) => void;
    } = {},
  ): Promise<{ taskId: number; glbUrl: string }> {
    const taskId = await this.createTextTo3DTask(request);
    this.onLog(`  task ${taskId} created`);
    const result = await this.waitForTask(taskId, options);
    const glbUrl = AholoClient.findGlbUrl(result);
    if (!glbUrl) {
      throw new AholoError(
        `Task ${taskId} succeeded but returned no GLB. Outputs: ${JSON.stringify(result.outputs)}`,
        'no-glb',
        result,
      );
    }
    return { taskId, glbUrl };
  }

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  private async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(url.toString(), {
          method: options.method,
          headers: {
            // the spec is explicit: the raw key, no "Bearer" prefix
            Authorization: this.apiKey,
            ...(options.body ? { 'content-type': 'application/json' } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        });

        if (response.status === 429 || response.status >= 500) {
          lastError = new AholoError(`HTTP ${response.status} from ${options.path}`, `http-${response.status}`);
          if (attempt < this.maxRetries) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw lastError;
        }

        const text = await response.text();
        let envelope: AholoEnvelope<T>;
        try {
          envelope = JSON.parse(text) as AholoEnvelope<T>;
        } catch {
          throw new AholoError(
            `Non-JSON response from ${options.path} (HTTP ${response.status}): ${text.slice(0, 200)}`,
            'bad-json',
          );
        }

        if (envelope.c !== '0') {
          throw new AholoError(
            `Aholo rejected ${options.path}: ${envelope.m || 'no message'} (c=${envelope.c})`,
            envelope.c || 'business-error',
            envelope.f,
          );
        }
        return envelope.d as T;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof AholoError
            ? error.code.startsWith('http-5') || error.code === 'http-429'
            : true; // network-level failure
        if (!retryable || attempt >= this.maxRetries) throw error;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new AholoError('Request failed', 'unknown');
  }
}

function backoffMs(attempt: number): number {
  return Math.min(15_000, 800 * 2 ** attempt) + Math.floor(Math.random() * 250);
}
