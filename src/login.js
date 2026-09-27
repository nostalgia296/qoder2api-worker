import { OPENAPI, CLIENT_ID, HttpError, saveCreds } from './qoder.js';

const AUTH_BASE = 'https://qoder.cn';
const LOGIN_TTL = 600;            
const POLL_INTERVAL = 1000;       
const POLL_TIMEOUT_MAX = 300_000; 

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function makeVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

function requireKv(env) {
  if (!env.QODER_KV) {
    throw new HttpError(400, '登录流程需要绑定 QODER_KV（跨请求保存 PKCE 会话）, 在 wrangler.toml 配置后重新部署', 'configuration_error');
  }
}

export async function startLogin(env) {
  requireKv(env);
  const machineId = crypto.randomUUID(); 
  const nonce = crypto.randomUUID();
  const verifier = makeVerifier();
  const challenge = await challengeOf(verifier);

  const selectAccounts = new URL('/device/selectAccounts', AUTH_BASE);
  selectAccounts.search = new URLSearchParams({
    challenge, challenge_method: 'S256', nonce, machine_id: machineId, client_id: CLIENT_ID,
  }).toString();
  const loginUrl = new URL('/users/sign-in', selectAccounts.origin);
  loginUrl.searchParams.set('biz_variant', 'qoder');
  loginUrl.searchParams.set('oauth_callback', selectAccounts.toString());

  await env.QODER_KV.put(`login:${nonce}`, JSON.stringify({
    verifier, challenge, machine_id: machineId, created: Date.now(),
  }), { expirationTtl: LOGIN_TTL });

  return {
    nonce,
    machine_id: machineId,
    login_url: loginUrl.toString(),
    direct_url: selectAccounts.toString(), 
    expires_in: LOGIN_TTL,
  };
}

export async function waitLogin(env, nonce, timeoutMs) {
  requireKv(env);
  if (!nonce) throw new HttpError(400, '缺少 nonce（来自 POST /admin/login 响应）', 'invalid_request_error');
  const raw = await env.QODER_KV.get(`login:${nonce}`);
  if (!raw) throw new HttpError(404, '登录会话不存在或已过期, 重新 POST /admin/login');
  const sess = JSON.parse(raw);

  const deadline = Date.now() + Math.min(Number(timeoutMs) || POLL_TIMEOUT_MAX, POLL_TIMEOUT_MAX);
  const pollUrl = new URL('/api/v1/deviceToken/poll', OPENAPI);
  pollUrl.search = new URLSearchParams({ nonce, verifier: sess.verifier, challenge_method: 'S256' }).toString();

  while (true) {
    const r = await fetch(pollUrl, { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      if (typeof d.token !== 'string' || typeof d.refresh_token !== 'string') {
        throw new HttpError(502, 'poll 响应缺少 token/refresh_token');
      }
      const creds = await buildCreds(sess, nonce, d);
      await saveCreds(env, creds);
      try { await env.QODER_KV.delete(`login:${nonce}`); } catch {}
      return {
        ok: true,
        token: creds.token.slice(0, 12) + '...',
        has_refresh_token: true,
        user: creds.userinfo,
        machine_id: creds.machine_id,
        expires_at: creds.expires_at || null,
      };
    }
    if (r.status !== 404) throw new HttpError(502, `poll HTTP ${r.status}`);
    if (Date.now() + POLL_INTERVAL > deadline) {
      return { ok: false, reason: 'pending', message: '用户尚未完成授权, 在浏览器打开 login_url 后重试本接口' };
    }
    await sleep(POLL_INTERVAL);
  }
}

async function buildCreds(sess, nonce, pollBody) {
  const creds = {
    token: pollBody.token,
    refresh_token: pollBody.refresh_token,
    nonce,
    verifier: sess.verifier,
    challenge: sess.challenge,
    machine_id: sess.machine_id,
    env: 'prod',
    ts: new Date().toISOString(),
  };
  if (pollBody.expires_at) creds.expires_at = pollBody.expires_at;
  else if (pollBody.expires_in) creds.expires_at = new Date(Date.now() + Number(pollBody.expires_in)).toISOString();
  if (pollBody.refresh_token_expires_at) creds.refresh_token_expires_at = pollBody.refresh_token_expires_at;
  else if (pollBody.refresh_token_expires_in) creds.refresh_token_expires_at = new Date(Date.now() + Number(pollBody.refresh_token_expires_in)).toISOString();

  const r = await fetch(new URL('/api/v1/userinfo', OPENAPI), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${creds.token}` },
  });
  if (!r.ok) throw new HttpError(502, `userinfo HTTP ${r.status}`);
  const u = await r.json();
  creds.userinfo = {
    id: u.id ?? u.user_id ?? u.uid ?? '',
    name: u.name ?? u.username ?? u.user_name ?? '',
    email: u.email ?? '',
  };
  return creds;
}
