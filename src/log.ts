/** 极简日志接口。dsh 层不依赖 vscode，靠注入实现（便于 node 下跑 smoke 测试）。 */

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  (level: Exclude<LogLevel, 'off'>, message: string, data?: unknown): void;
}

export const LEVELS: Record<Exclude<LogLevel, 'off'>, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level: LogLevel, sink: (line: string) => void): Logger {
  if (level === 'off') return () => undefined;
  const max = LEVELS[level];
  const write = (l: Exclude<LogLevel, 'off'>, message: string, data?: unknown) => {
    if (LEVELS[l] > max) return;
    let line = `[${new Date().toISOString()}] ${l.toUpperCase()} ${message}`;
    if (data !== undefined) {
      try {
        const s = typeof data === 'string' ? data : JSON.stringify(data);
        line += ` ${s && s.length > 4000 ? s.slice(0, 4000) + '…' : s}`;
      } catch {
        line += ' [unserializable]';
      }
    }
    sink(line);
  };
  return write as Logger;
}

export const silentLogger: Logger = () => undefined;
