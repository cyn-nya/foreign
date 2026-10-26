import { describe, expect, it, vi } from 'vitest';
import { AHOLO_BASE_URL, AholoClient, AholoError, TASK_STATUS } from '../src/aholo/client';

/**
 * These tests pin the platform contract that the OpenAPI spec states, so a
 * future refactor cannot quietly break it:
 *   - `Authorization` carries the raw key, never "Bearer <key>"
 *   - the response envelope is { c, m, d, f } and c !== "0" means failure
 *   - G1 text-to-3D returns outputs in the order ZIP, GLB
 *   - task status 0/1 are "keep polling", 3 is success, 4/6 are terminal
 */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: (call: Call) => { status?: number; json: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, json } = responses(call);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = <T>(d: T) => ({ c: '0', m: '', d, f: null });

describe('AholoClient transport', () => {
  it('sends the raw API key in Authorization, with no Bearer prefix', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ json: ok(55) }));
    const client = new AholoClient({ apiKey: 'sk-secret', fetchImpl });

    await client.createTextTo3DTask({ prompt: 'a rubber duck' });

    expect(calls[0].headers.Authorization).toBe('sk-secret');
    expect(calls[0].headers.Authorization).not.toMatch(/^Bearer/i);
    expect(calls[0].url).toBe(`${AHOLO_BASE_URL}/lux3d/v1/generate/text-to-3d/task/create`);
    expect(calls[0].method).toBe('POST');
  });

  it('defaults to G1 with glb output, because G1 always returns a GLB', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ json: ok(1) }));
    await new AholoClient({ apiKey: 'k', fetchImpl }).createTextTo3DTask({ prompt: 'a cone' });

    expect(calls[0].body).toMatchObject({ version: 'G1', outputFormat: ['glb'], prompt: 'a cone' });
  });

  it('surfaces a business error with its code and message', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      json: { c: 'BIZ_11003', m: 'insufficient credits', d: null, f: { need: 20 } },
    }));
    const client = new AholoClient({ apiKey: 'k', fetchImpl, maxRetries: 0 });

    await expect(client.createTextTo3DTask({ prompt: 'x' })).rejects.toThrowError(/insufficient credits/);
    await client
      .createTextTo3DTask({ prompt: 'x' })
      .catch((e: AholoError) => expect(e.code).toBe('BIZ_11003'));
  });

  it('retries a 5xx and then succeeds', async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch(() => {
      n += 1;
      return n === 1 ? { status: 503, json: {} } : { json: ok(7) };
    });
    const client = new AholoClient({ apiKey: 'k', fetchImpl, maxRetries: 2 });

    expect(await client.createTextTo3DTask({ prompt: 'x' })).toBe(7);
    expect(calls.length).toBe(2);
  });

  it('does not retry a rejected request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ json: { c: '-1', m: 'bad prompt', d: null, f: null } }));
    const client = new AholoClient({ apiKey: 'k', fetchImpl, maxRetries: 3 });

    await expect(client.createTextTo3DTask({ prompt: 'x' })).rejects.toThrowError();
    expect(calls.length).toBe(1);
  });

  it('refuses to build a client without a key', () => {
    expect(() => new AholoClient({ apiKey: '' })).toThrowError(/API key is required/);
  });

  it('rejects a prompt that is only whitespace', async () => {
    const { fetchImpl } = fakeFetch(() => ({ json: ok(1) }));
    const client = new AholoClient({ apiKey: 'k', fetchImpl });
    await expect(client.createTextTo3DTask({ prompt: '   ' })).rejects.toThrowError(/non-whitespace/);
  });
});

describe('AholoClient task polling', () => {
  it('polls through INIT and RUNNING until SUCCESS', async () => {
    const statuses = [0, 1, 1, 3];
    let i = 0;
    const { fetchImpl } = fakeFetch(() => ({
      json: ok({ taskId: 42, status: statuses[i++], outputs: [{ content: 'https://x/a.zip' }, { content: 'https://x/a.glb' }] }),
    }));
    const client = new AholoClient({ apiKey: 'k', fetchImpl });

    const result = await client.waitForTask(42, { pollMs: 1 });
    expect(result.status).toBe(TASK_STATUS.SUCCESS);
    expect(i).toBe(4);
  });

  it('reports a failed task with the platform reason', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      json: ok({ taskId: 9, status: 4, outputs: [], failReason: 'generation produced no mesh' }),
    }));
    const client = new AholoClient({ apiKey: 'k', fetchImpl });

    await expect(client.waitForTask(9, { pollMs: 1 })).rejects.toThrowError(/produced no mesh/);
  });

  it('gives up on a task that never settles', async () => {
    const { fetchImpl } = fakeFetch(() => ({ json: ok({ taskId: 3, status: 1, outputs: [] }) }));
    const client = new AholoClient({ apiKey: 'k', fetchImpl });

    await expect(client.waitForTask(3, { pollMs: 1, timeoutMs: 20 })).rejects.toThrowError(/still running/);
  });
});

describe('finding the GLB in a task result', () => {
  const result = (contents: (string | null)[]) => ({
    taskId: 1,
    status: TASK_STATUS.SUCCESS as 3,
    outputs: contents.map((content) => ({ content })),
  });

  it('picks the GLB out of the documented ZIP, GLB order', () => {
    expect(AholoClient.findGlbUrl(result(['https://cdn/a.zip', 'https://cdn/a.glb']))).toBe('https://cdn/a.glb');
  });

  it('works when GLB is the only requested output (G1-Turbo)', () => {
    expect(AholoClient.findGlbUrl(result(['https://cdn/a.glb']))).toBe('https://cdn/a.glb');
  });

  it('ignores NOT_REQUESTED placeholders and nulls', () => {
    const url = AholoClient.findGlbUrl(result([null, 'NOT_REQUESTED', 'https://cdn/a.glb']));
    expect(url).toBe('https://cdn/a.glb');
  });

  it('tolerates a query string after .glb', () => {
    expect(AholoClient.findGlbUrl(result(['https://cdn/a.glb?sign=xyz']))).toBe('https://cdn/a.glb?sign=xyz');
  });

  it('returns null rather than a bogus URL when no GLB was produced', () => {
    expect(AholoClient.findGlbUrl(result(['NOT_REQUESTED', 'NOT_REQUESTED']))).toBeNull();
    expect(AholoClient.findGlbUrl(result([]))).toBeNull();
  });
});

describe('the whole one-asset pipeline', () => {
  it('creates, polls, and returns the GLB url', async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.includes('task/create')) return { json: ok(1234) };
      return {
        json: ok({
          taskId: 1234,
          status: 3,
          outputs: [{ content: 'https://cdn/model.zip' }, { content: 'https://cdn/model.glb' }],
        }),
      };
    });
    const client = new AholoClient({ apiKey: 'k', fetchImpl, onLog: vi.fn() });

    const { taskId, glbUrl } = await client.generateGlb({ prompt: 'a garden gnome' }, { pollMs: 1 });

    expect(taskId).toBe(1234);
    expect(glbUrl).toBe('https://cdn/model.glb');
    expect(calls[1].url).toContain('taskid=1234');
  });

  it('fails loudly when the task succeeds without a GLB', async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.url.includes('task/create')
        ? { json: ok(2) }
        : { json: ok({ taskId: 2, status: 3, outputs: [{ content: 'NOT_REQUESTED' }] }) },
    );
    const client = new AholoClient({ apiKey: 'k', fetchImpl });

    await expect(client.generateGlb({ prompt: 'x' }, { pollMs: 1 })).rejects.toThrowError(/returned no GLB/);
  });
});
