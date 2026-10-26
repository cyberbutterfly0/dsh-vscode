/**
 * WS 多路复用：一条 /api/remote.mux 连接承载所有逻辑流。
 *
 * 上行 {type:'open'|'item'|'end'|'cancel', streamId, endpoint?, payload?}
 * 下行 {type:'item'|'end'|'error', streamId, value?/error?}
 *
 * 断线后自动重连并重新 open 所有逻辑流；follow/control 的第一帧会重发 snapshot/baseline，
 * 所以重连时通过 onReopen 通知调用方清空增量状态。
 */

import WebSocket from 'ws';

import type { JsonValue, MuxDown, MuxUp, RemoteError } from './types';
import type { Logger } from '../log';

export type MuxState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamHandlers {
  onValue?: (value: JsonValue) => void;
  onEnd?: () => void;
  onError?: (error: RemoteError) => void;
  /** 重连后流被重新打开：此时增量状态不可信，等新的 snapshot/baseline */
  onReopen?: () => void;
  /** 上游主动 end 或本地 close */
  onClose?: () => void;
}

export interface StreamHandle {
  readonly streamId: string;
  close(): void;
  readonly closed: boolean;
}

interface Registration {
  streamId: string;
  endpoint: string;
  args: Record<string, unknown>;
  handlers: StreamHandlers;
  closed: boolean;
  everOpened: boolean;
}

export interface MuxClientOptions {
  getAuth: () => Promise<{ authority: string; cookie: string } | null>;
  logger: Logger;
  onState?: (state: MuxState, detail?: string) => void;
  /**
   * 握手被 401/409 拒了时调用，给上层一次换凭据的机会。
   * 409 = 同一个 cookie 已经有一条 mux socket（一个 cookie 只能一条），
   * 401 = cookie 过期。返回 true 表示凭据已换好，这里会立刻重试一次。
   */
  onAuthReject?: (status: number) => Promise<boolean>;
  /** 首次连接成功后 resolve 用的回调 */
  heartbeatMs?: number;
}

const MAX_BACKOFF_MS = 20000;

let streamSeq = 0;

export class MuxClient {
  private ws: WebSocket | null = null;
  private regs = new Map<string, Registration>();
  private state: MuxState = 'closed';
  private disposed = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private awaitingPong = false;
  /** 最近一次收到任何字节的时间（消息/pong），心跳判活用 */
  private lastActivityAt = 0;

  constructor(private opts: MuxClientOptions) {}

  get currentState(): MuxState {
    return this.state;
  }

  nextStreamId(prefix: string): string {
    streamSeq += 1;
    return `${prefix}-${streamSeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async start(): Promise<void> {
    this.disposed = false;
    await this.connectOnce();
  }

  /** 打开一条逻辑流；返回句柄用于取消。 */
  open(endpoint: string, args: Record<string, unknown>, handlers: StreamHandlers, prefix = 's'): StreamHandle {
    const streamId = this.nextStreamId(prefix);
    const reg: Registration = { streamId, endpoint, args, handlers, closed: false, everOpened: false };
    this.regs.set(streamId, reg);
    this.sendOpen(reg);
    this.opts.logger('debug', `mux open ${endpoint} ${streamId}`);
    return {
      streamId,
      get closed() {
        return reg.closed;
      },
      close: () => this.closeStream(streamId, true),
    };
  }

  closeStream(streamId: string, notify = false, sendCancel = true): void {
    const reg = this.regs.get(streamId);
    if (!reg) return;
    reg.closed = true;
    this.regs.delete(streamId);
    if (sendCancel && this.state === 'open' && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'cancel', streamId });
    }
    if (notify) reg.handlers.onClose?.();
  }

  close(): void {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const id of [...this.regs.keys()]) this.closeStream(id, true, false);
    this.setState('closed');
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private setState(state: MuxState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state, detail);
  }

  private send(frame: MuxUp): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (e) {
      this.opts.logger('debug', 'mux send 失败', (e as Error).message);
    }
  }

  private sendOpen(reg: Registration): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'open', streamId: reg.streamId, endpoint: reg.endpoint, payload: { args: reg.args } });
  }

  private async connectOnce(retried = false): Promise<void> {
    const auth = await this.opts.getAuth();
    if (!auth) {
      this.setState('closed', 'no-auth');
      throw new Error('没有可用的鉴权信息');
    }
    const url = `ws://${auth.authority}/api/remote.mux`;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // 旧 socket 必须先彻底断掉：服务端一个 peer 只认一条 mux，
    // 留着半死的 socket 会让新的 upgrade 一直挂着直到 handshakeTimeout。
    const previous = this.ws;
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      try {
        previous.terminate();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, {
        headers: { Cookie: auth.cookie, Host: auth.authority },
        handshakeTimeout: 15000,
        perMessageDeflate: false,
      });
      this.ws = ws;

      ws.on('open', () => {
        settled = true;
        this.attempt = 0;
        this.setState('open');
        this.startHeartbeat();
        // 重连后把所有流重新打开
        for (const reg of this.regs.values()) {
          if (reg.closed) continue;
          if (reg.everOpened) reg.handlers.onReopen?.();
          this.sendOpen(reg);
          reg.everOpened = true;
        }
        this.opts.logger('info', `mux 已连接 ${auth.authority}`);
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => this.onMessage(data));

      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        this.opts.logger(
          status === 409 ? 'warn' : 'error',
          status === 409
            ? 'mux 握手 409：这个 cookie 已经有一条 socket 了，换凭据后重试'
            : `mux 握手失败 HTTP ${status}`,
        );
        if (settled) {
          ws.terminate();
          return;
        }
        settled = true;
        ws.terminate();
        const canRefresh = (status === 401 || status === 409) && !retried && this.opts.onAuthReject;
        if (canRefresh) {
          void this.opts.onAuthReject!(status)
            .then((ok) => {
              if (ok && !this.disposed) return this.connectOnce(true);
              throw new Error(`WS 握手失败 ${status}`);
            })
            .then(resolve, reject);
          return;
        }
        reject(new Error(`WS 握手失败 ${status}`));
      });

      ws.on('error', (err: Error) => {
        this.opts.logger('debug', 'mux 错误', err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (this.ws !== ws) return; // 已被新连接取代，旧 socket 的关闭事件忽略
        this.stopHeartbeat();
        if (!settled) {
          settled = true;
          reject(new Error(`WS 关闭 ${code}`));
        }
        if (this.disposed) return;
        const detail = `${code}${reason?.length ? ' ' + reason.toString() : ''}`;
        this.opts.logger('info', `mux 断开 ${detail}，准备重连`);
        this.setState('reconnecting', detail);
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempt - 1, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      this.connectOnce().catch((e: Error) => {
        this.opts.logger('debug', 'mux 重连失败', e.message);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const every = this.opts.heartbeatMs ?? 20000;
    const ws = this.ws;
    if (!ws) return;
    this.lastActivityAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this.lastActivityAt;
      // 只要连接上有任何字节（消息/pong）流过就不算死；
      // 真正判死要连续两轮心跳周期完全没有动静，避免慢响应被误杀。
      if (this.awaitingPong && idle > every * 2 + 5000) {
        this.opts.logger('info', `mux 心跳超时（${Math.round(idle / 1000)}s 无响应），主动断开`);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      if (this.awaitingPong) return; // 还在等上一轮的回音，别叠加 ping
      this.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, every);
    ws.on('pong', () => {
      if (this.ws !== ws) return;
      this.awaitingPong = false;
      this.lastActivityAt = Date.now();
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.awaitingPong = false;
  }

  private onMessage(data: WebSocket.RawData): void {
    this.lastActivityAt = Date.now();
    this.awaitingPong = false;
    let frame: MuxDown;
    try {
      frame = JSON.parse(data.toString()) as MuxDown;
    } catch {
      this.opts.logger('debug', 'mux 收到非 JSON 帧');
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const streamId = (frame as { streamId?: string }).streamId;
    if (!streamId) return;
    const reg = this.regs.get(streamId);
    if (!reg || reg.closed) {
      if (frame.type === 'item' && (frame as { value?: JsonValue }).value) {
        this.opts.logger('debug', `mux 丢弃未知流 ${streamId} 的帧`);
      }
      return;
    }
    reg.everOpened = true;
    switch (frame.type) {
      case 'item':
        reg.handlers.onValue?.(frame.value);
        break;
      case 'end':
        reg.closed = true;
        this.regs.delete(streamId);
        reg.handlers.onEnd?.();
        break;
      case 'error':
        this.opts.logger('error', `流 ${reg.endpoint} 报错`, frame.error);
        reg.handlers.onError?.(frame.error);
        break;
      default:
        break;
    }
  }
}
