import { sanitizeAwsQuickWsHost, serializeOAuthCredential, type OAuthCredential } from "../aws-quick/oauth-client.js";
import { GatewayError } from "../core/types.js";
import { isRecord } from "../protocols/common.js";
import { validateProxyUrl } from "../utils/proxy-agent.js";

export interface ImportedCredential {
  apiKey: string;
  enabled: boolean;
  label?: string;
  proxyUrl?: string;
}

function invalid(field: string): never {
  throw new GatewayError(`Invalid yuanzhang JSON field: ${field}.`, 400, "invalid_request_error", field);
}

function text(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) invalid(field);
    return undefined;
  }
  if (typeof value !== "string" || /[\r\n\x00]/.test(value)) invalid(field);
  const result = value.trim();
  if (!result && required) invalid(field);
  return result || undefined;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(field);
  return value;
}

function epochMilliseconds(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(field);
  const ms = value * 1000;
  if (!Number.isSafeInteger(ms) || ms > 8.64e15) invalid(field);
  return ms;
}

function identity(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try { return object(JSON.parse(value), field); } catch { invalid(field); }
  }
  return object(value, field);
}

function importProxy(account: Record<string, unknown>, field: string): string | undefined {
  // A dormant URL in global mode must not become an account-specific proxy.
  if (account.proxy_mode === "global" || account.proxy_mode === "direct") return undefined;
  const raw = text(account.proxy_url, `${field}.proxy_url`);
  if (!raw) return undefined;
  try {
    const proxy = new URL(validateProxyUrl(raw)!);
    const username = text(account.proxy_username, `${field}.proxy_username`);
    const password = text(account.proxy_password, `${field}.proxy_password`);
    if (username !== undefined) proxy.username = username;
    if (password !== undefined) proxy.password = password;
    return validateProxyUrl(proxy.toString());
  } catch { invalid(`${field}.proxy_url`); }
}

function importAccount(value: unknown, index: number): ImportedCredential {
  const field = `accounts[${index}]`;
  const account = object(value, field);
  if (account.disabled !== undefined && typeof account.disabled !== "boolean") invalid(`${field}.disabled`);
  const session = object(account.session, `${field}.session`);
  const upstream = object(account.upstream, `${field}.upstream`);
  const client = object(upstream.client, `${field}.upstream.client`);
  const tokens = object(upstream.tokens, `${field}.upstream.tokens`);
  const discovery = upstream.discovery === undefined || upstream.discovery === null
    ? {} : object(upstream.discovery, `${field}.upstream.discovery`);
  const user = identity(upstream.user_info, `${field}.upstream.user_info`);

  const region = text(client.idc_region ?? discovery.idc_region ?? upstream.region ?? session.region,
    `${field}.upstream.client.idc_region`) || "us-east-1";
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) invalid(`${field}.upstream.client.idc_region`);
  const host = text(session.ws_host || upstream.tenant_url || session.tenant_url,
    `${field}.session.ws_host`, true)!;
  let wsHost: string;
  try { wsHost = sanitizeAwsQuickWsHost(host); } catch { invalid(`${field}.session.ws_host`); }
  const expiresAt = epochMilliseconds(session.usable_until, `${field}.session.usable_until`);
  const email = text(user.email || user.user_name, `${field}.upstream.user_info.email`);
  const name = text(user.display_name, `${field}.upstream.user_info.display_name`);
  const label = text(account.label, `${field}.label`) || email || name;
  const accountId = text(user.aws_account_id || session.aws_account_id, `${field}.session.aws_account_id`);
  const credential: OAuthCredential = {
    region,
    issuerUrl: text(client.issuer_url ?? discovery.issuer_url, `${field}.upstream.client.issuer_url`) || "",
    wsHost,
    clientId: text(client.client_id, `${field}.upstream.client.client_id`, true)!,
    clientSecret: text(client.client_secret, `${field}.upstream.client.client_secret`, true)!,
    refreshToken: text(tokens.refresh_token, `${field}.upstream.tokens.refresh_token`, true)!,
    accessToken: text(tokens.access_token || session.jwt || session.id_token, `${field}.upstream.tokens.access_token`),
    expiresAt,
    accountId,
    email,
    name: name || label,
  };
  return { apiKey: serializeOAuthCredential(credential), enabled: account.disabled !== true,
    label, proxyUrl: importProxy(account, field) };
}

// Called only by the explicitly selected yuanzhang endpoint; the native import
// path must never auto-detect this schema. Validate every entry before writes.
export function parseYuanzhangJson(body: unknown): ImportedCredential[] {
  if (!isRecord(body) || !Array.isArray(body.accounts) || body.accounts.length === 0) {
    throw new GatewayError("yuanzhang JSON requires a non-empty `accounts` array.", 400, "invalid_request_error", "accounts");
  }
  return Array.from(body.accounts, importAccount);
}
