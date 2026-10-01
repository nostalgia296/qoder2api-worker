import { OPENAPI, HttpError, resolveCreds, refreshDeviceToken } from './qoder.js';

function campaignHeaders(token) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Qoder',
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'Cosy-Version': '0.3.3',
  };
}

async function campaignsApi(env, creds, method, path, body) {
  let r = await fetch(OPENAPI + path, { method, headers: campaignHeaders(creds.token), body: body ? JSON.stringify(body) : undefined });
  if ((r.status === 401 || r.status === 403) && creds.refresh_token) {
    const updated = await refreshDeviceToken(env, creds);
    r = await fetch(OPENAPI + path, { method, headers: campaignHeaders(updated.token), body: body ? JSON.stringify(body) : undefined });
  }
  let j = null;
  try { j = await r.json(); } catch { j = { raw: 'non-json response' }; }
  if (r.status !== 200) {
    throw new HttpError(r.status === 401 || r.status === 403 ? 401 : 502, `campaigns HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j;
}

export async function listCampaigns(env) {
  const creds = await resolveCreds(env);
  const j = await campaignsApi(env, creds, 'GET', '/sash/api/v1/me/campaigns');
  return {
    showCampaign: j.showCampaign ?? null,
    claimable: j.claimable ?? null,
    campaignUrl: j.campaignUrl ?? null,
    campaigns: j.campaigns || [],
  };
}

export async function runCheckin(env) {
  const creds = await resolveCreds(env);
  const list = await campaignsApi(env, creds, 'GET', '/sash/api/v1/me/campaigns');
  const campaigns = list.campaigns || [];
  const targets = campaigns.filter(c => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
  const results = [];
  let granted = 0;
  for (const c of targets) {
    const j = await campaignsApi(env, creds, 'POST', `/sash/api/v1/me/campaigns/${c.campaignId}/claim`, {});
    results.push({
      campaignKey: c.campaignKey,
      campaignId: c.campaignId,
      status: j.status ?? null,
      replayed: !!j.replayed,
      grantId: j.grantId ?? null,
      failureCode: j.failureCode ?? null,
      benefit: j.benefit ?? null,
    });
    if (j.status === 'GRANTED') granted += j.benefit?.amount || 0;
  }
  return { ok: true, granted, claimed: results.length, results, campaigns };
}

export async function lastCheckin(env) {
  if (!env.QODER_KV) return null;
  try { return await env.QODER_KV.get('checkin:last', 'json'); } catch { return null; }
}

export async function recordCheckin(env, outcome) {
  if (!env.QODER_KV) return;
  try { await env.QODER_KV.put('checkin:last', JSON.stringify(outcome)); } catch {}
}
