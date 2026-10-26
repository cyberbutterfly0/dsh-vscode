/**
 * 鉴权：launch token → v2 API cookie。
 *
 * 实测（dsh 0.2.1-rc.2）：
 *   GET /connect?token=<43字符token>&interactions=answer
 *     → 302, location: ./api/remote.mux
 *     → set-cookie: dsh-auth-<b64url(sha256(authority))>=v2.<payload>.<sig>; Max-Age=2592000; ...
 * 重新 /connect 会顶掉旧的 operator，所以整个扩展必须共享同一个 cookie。
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface LaunchTarget {
  /** http://host:port（无结尾斜杠） */
  base: string;
  authority: string;
  token: string;
}

export interface ApiSession {
  authority: string;
  base: string;
  /** 直接放进 Cookie 头的完整串：name=value */
  cookie: string;
  cookieName: string;
  expiresAt?: number;
  /** 换出这个 cookie 时用的 launch token，重启扩展可以复用（dsh 进程还活着的话） */
  launchToken: string;
}

/** 从终端打印的那行里提取 tokenized URL；也接受直接贴 URL。 */
export function parseLaunchUrl(raw: string | undefined | null): LaunchTarget | undefined {
  if (!raw) return undefined;
  const m = String(raw).match(/https?:\/\/[^\s"'<>]+/);
  if (!m) return undefined;
  try {
    const u = new URL(m[0]);
    const token = u.searchParams.get('token');
    if (!token) return undefined;
    return { base: `${u.protocol}//${u.host}`, authority: u.host, token };
  } catch {
    return undefined;
  }
}

function readSetCookies(res: Response): string[] {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

/** 解析 v2 cookie 的 payload（只为拿 expiresAt 和 authority，不验签）。 */
export function decodeCookieValue(value: string): { version?: number; authority?: string; id?: string; expiresAt?: number } | undefined {
  const parts = String(value).split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      version: typeof obj.version === 'number' ? obj.version : undefined,
      authority: typeof obj.authority === 'string' ? obj.authority : undefined,
      id: typeof obj.id === 'string' ? obj.id : undefined,
      expiresAt: typeof obj.expiresAt === 'number' ? obj.expiresAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * 用 launch token 换 v2 API cookie。
 * `interactions=answer` 才能收审批/提问；`none` 收不到。
 */
export async function exchangeLaunchToken(
  base: string,
  token: string,
  interactions: 'answer' | 'none' = 'answer',
  timeoutMs = 15000,
): Promise<ApiSession> {
  const root = base.replace(/\/+$/, '');
  const url = `${root}/connect?token=${encodeURIComponent(token)}&interactions=${interactions}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'manual', signal: ac.signal, headers: { accept: 'text/html,application/json' } });
  } catch (e) {
    throw new AuthError(`/connect 请求失败：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new AuthError('token 无效或已失效（401/403），请重新复制 dsh 打印的那行 URL', res.status);
  if (res.status >= 500) throw new AuthError(`/connect 返回 ${res.status}`, res.status);

  const cookies = readSetCookies(res);
  if (!cookies.length) throw new AuthError(`/connect 返回 ${res.status} 但没有 set-cookie`, res.status);

  const raw = cookies[0];
  const eq = raw.indexOf('=');
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1, raw.indexOf(';') > 0 ? raw.indexOf(';') : undefined);
  if (!name || !value) throw new AuthError('set-cookie 解析失败');

  const u = new URL(root);
  const decoded = decodeCookieValue(value);
  return {
    authority: u.host,
    base: root,
    cookie: `${name}=${value}`,
    cookieName: name,
    expiresAt: decoded?.expiresAt,
    launchToken: token,
  };
}

/** 轻量校验一个 cookie 还能不能用（不打 /connect，不抢 operator）。 */
export async function probeCookie(session: Pick<ApiSession, 'base' | 'cookie'>, timeoutMs = 8000): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${session.base}/api/session/modelCatalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/modelCatalog', payload: { args: {} } }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    return res.status === 200;
  } catch {
    return false;
  }
}
