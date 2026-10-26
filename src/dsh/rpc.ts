/**
 * 一元 RPC 客户端：POST /api/<endpoint>，信封必须一字不差。
 *
 *   {type:'client-request', rpcId, method:<endpoint>, payload:{args:{...}}}
 *
 * 关键细节（实测）：
 * - method 必须等于 URL 里的 endpoint，否则 200 + gateway/bad-request。
 * - payload 外层必须包 args：{"payload":{"args":{...}}}。
 * - 成功响应里带二进制时是 multipart/form-data，不能一律 res.json()。
 */

import type { ClientRequest, RemoteError, ServerResponse } from './types';
import type { Logger } from '../log';

export class DshHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'DshHttpError';
  }
}

export class RemoteInvokeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'RemoteInvokeError';
  }
}

export interface MultipartPart {
  name?: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface MultipartBody {
  metadata?: unknown;
  parts: MultipartPart[];
}

export type UnaryResult = unknown;

const RPC_TIMEOUT_MS = 120000;

let rpcSeq = 0;
export function nextRpcId(prefix = 'vsc'): string {
  rpcSeq = (rpcSeq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${rpcSeq.toString(36)}`;
}

function parseMultipart(buffer: Buffer, boundary: string): MultipartBody {
  const out: MultipartBody = { parts: [] };
  const delim = `--${boundary}`;
  const text = buffer.toString('latin1');
  const chunks = text.split(delim);
  for (const chunkRaw of chunks) {
    let chunk = chunkRaw;
    if (!chunk || chunk === '--\r\n' || chunk === '--') continue;
    if (chunk.startsWith('\r\n')) chunk = chunk.slice(2);
    if (chunk.endsWith('\r\n')) chunk = chunk.slice(0, -2);
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const headerText = chunk.slice(0, sep);
    const bodyText = chunk.slice(sep + 4);
    const part: MultipartPart = { data: Buffer.from(bodyText, 'latin1') };
    for (const line of headerText.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === 'content-type') part.contentType = value;
      else if (key === 'content-disposition') {
        const nameM = /name="([^"]*)"/.exec(value);
        const fileM = /filename="([^"]*)"/.exec(value);
        if (nameM) part.name = nameM[1];
        if (fileM) part.filename = fileM[1];
      }
    }
    if (part.name === 'metadata') {
      try {
        out.metadata = JSON.parse(part.data.toString('utf8'));
      } catch {
        out.metadata = undefined;
      }
    }
    out.parts.push(part);
  }
  return out;
}

export interface UnaryClientOptions {
  base: string;
  cookie: string;
  logger: Logger;
  /** 401 时回调，用于上层重新 /connect；返回新的 Cookie 头则重试一次 */
  onUnauthorized?: () => Promise<string | undefined>;
}

export class UnaryClient {
  constructor(private opts: UnaryClientOptions) {}

  get base(): string {
    return this.opts.base;
  }

  setCookie(cookie: string): void {
    this.opts.cookie = cookie;
  }

  /**
   * @param endpoint 形如 session/list
   * @param args payload.args 的内容（字段名必须按各包 typert 签名，别自己猜）
   */
  async call<T = UnaryResult>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    try {
      return await this.invoke<T>(endpoint, args, signal);
    } catch (e) {
      if (e instanceof DshHttpError && e.status === 401 && this.opts.onUnauthorized) {
        const fresh = await this.opts.onUnauthorized();
        if (fresh) {
          this.opts.cookie = fresh;
          return this.invoke<T>(endpoint, args, signal);
        }
      }
      throw e;
    }
  }

  /**
   * 普通 GET 路由（不带 typert 信封）。
   *
   * 少数端点不是 RPC，而是 connection fence 里的直连 HTTP：比如
   * `/api/changes.summary`、`/api/changes.diff`，参数走 query string，
   * 返回裸 JSON（不是 `{type:'server-response'}`）。401 时同样重试一次。
   */
  async getJson<T>(path: string, query: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
    try {
      return await this.getOnce<T>(path, query, signal);
    } catch (e) {
      if (e instanceof DshHttpError && e.status === 401 && this.opts.onUnauthorized) {
        const fresh = await this.opts.onUnauthorized();
        if (fresh) {
          this.opts.cookie = fresh;
          return this.getOnce<T>(path, query, signal);
        }
      }
      throw e;
    }
  }

  private async getOnce<T>(path: string, query: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('..')) throw new Error(`非法 GET 路径: ${path}`);
    const url = new URL(`${this.opts.base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { method: 'GET', headers: { Cookie: this.opts.cookie }, signal: ac.signal });
    } catch (e) {
      throw new DshHttpError(`GET ${path} 失败：${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      this.opts.logger('debug', `GET ${path} HTTP ${res.status}`, text.slice(0, 300));
      throw new DshHttpError(`GET ${path} → HTTP ${res.status}`, res.status, text.slice(0, 2000));
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DshHttpError(`GET ${path} 返回非 JSON`, res.status, text.slice(0, 2000));
    }
  }

  private async invoke<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!endpoint || endpoint.startsWith('/') || endpoint.includes('..')) {
      throw new Error(`非法 endpoint: ${endpoint}`);
    }
    const body: ClientRequest = {
      type: 'client-request',
      rpcId: nextRpcId(),
      method: endpoint,
      payload: { args },
    };
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.opts.base}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: this.opts.cookie },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      this.opts.logger('debug', `rpc ${endpoint} 网络错误`, (e as Error).message);
      throw new DshHttpError(`请求 ${endpoint} 失败：${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      this.opts.logger('error', `rpc ${endpoint} HTTP ${res.status}`, text.slice(0, 2000));
      throw new DshHttpError(`${endpoint} → HTTP ${res.status}`, res.status, text);
    }

    const contentType = res.headers.get('content-type') || '';
    const raw = Buffer.from(await res.arrayBuffer());

    if (contentType.includes('multipart/form-data')) {
      const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
      const boundary = (m?.[1] || m?.[2] || '').trim();
      if (!boundary) throw new Error(`${endpoint} 返回 multipart 但没有 boundary`);
      const parsed = parseMultipart(raw, boundary);
      const meta = parsed.metadata as ServerResponse | undefined;
      if (meta && 'result' in meta) return this.unwrap<T>(meta, endpoint);
      return parsed as unknown as T;
    }

    const text = raw.toString('utf8');
    let json: ServerResponse;
    try {
      json = JSON.parse(text) as ServerResponse;
    } catch {
      this.opts.logger('error', `rpc ${endpoint} 返回非 JSON`, text.slice(0, 2000));
      throw new DshHttpError(`${endpoint} 返回非 JSON`, res.status, text.slice(0, 2000));
    }
    const value = this.unwrap<T>(json, endpoint);
    this.opts.logger('debug', `rpc ${endpoint} ok`, value === undefined ? undefined : undefined);
    return value;
  }

  private unwrap<T>(json: ServerResponse, endpoint: string): T {
    if (!json || json.type !== 'server-response') {
      throw new RemoteInvokeError('gateway/protocol', `响应不是 server-response（${endpoint}）`, json, endpoint);
    }
    const result = json.result;
    if (!result) throw new RemoteInvokeError('gateway/protocol', `响应缺少 result（${endpoint}）`, json, endpoint);
    if (result.ok) return result.value as T;
    const err: RemoteError = result.error;
    this.opts.logger('error', `rpc ${endpoint} 失败 ${err.code}`, err);
    throw new RemoteInvokeError(err.code, err.message, err.details, endpoint);
  }
}
