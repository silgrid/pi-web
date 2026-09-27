import { NextResponse } from "next/server";
import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import { buildModelsListUrl, parseDiscoveredModels } from "@/lib/model-discovery";
import {
  getConfiguredProviderBaseUrl,
  getConfiguredProviderCredentials,
  isConfigExpression,
  resolveModelDiscoveryCredentialDecision,
  validateModelDiscoveryProvider,
  verifyConfigExpressionsAreConfigured,
} from "@/lib/model-discovery-guards";
import { readModelsConfig } from "@/lib/models-config-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json().catch(() => null);
    const validated = validateModelDiscoveryProvider(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.reason }, { status: 400 });
    }
    const { providerName, provider } = validated;

    let endpoint: URL;
    try {
      endpoint = buildModelsListUrl(provider.baseUrl, provider.api);
    } catch {
      return NextResponse.json({ error: "invalidBaseUrl" }, { status: 400 });
    }

    const modelsConfig = readModelsConfig();

    // review r2: an expression apiKey/header ("$VAR", "!command") is refused
    // unless it exactly matches what the operator already persisted for this
    // provider name — an attacker can replay an authorized expression, never
    // forge a new one (see lib/model-discovery-guards.ts module doc).
    const configExpressionCheck = verifyConfigExpressionsAreConfigured(
      provider,
      getConfiguredProviderCredentials(providerName, modelsConfig),
    );
    if (!configExpressionCheck.ok) {
      return NextResponse.json({ error: configExpressionCheck.reason }, { status: 403 });
    }
    // An expression apiKey is never a portable "request-chosen" literal, even
    // once verified authentic — it is resolved exclusively through the
    // configured path below, so it still requires the configured-base-URL
    // gate to pass.
    const literalApiKey = provider.apiKey && !isConfigExpression(provider.apiKey) ? provider.apiKey : undefined;

    // Audit S2: a credential resolved from the operator's stored config may
    // only be attached to the provider's configured base URL; a key the
    // request itself supplies may go where the request says — as a LITERAL:
    // the request-key path never runs SDK auth resolution, so the operator's
    // stored credential for a colliding provider id cannot be swapped in.
    const decision = resolveModelDiscoveryCredentialDecision({
      baseUrl: provider.baseUrl,
      ...(literalApiKey ? { requestApiKey: literalApiKey } : {}),
      configuredBaseUrl: getConfiguredProviderBaseUrl(providerName, modelsConfig),
    });
    if (!decision.attach) {
      return NextResponse.json({ error: decision.reason }, { status: 403 });
    }

    const providerEntry: Record<string, unknown> = {
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(Object.keys(provider.headers).length > 0 ? { headers: provider.headers } : {}),
      ...provider.extra,
    };
    // Request-key path: the literal goes out untouched — resolveModelDiscoveryAuth
    // (SDK auth resolution) is only consulted on the stored/verified-expression
    // path, where the destination gate above already pinned the operator's
    // configured URL.
    const auth = literalApiKey
      ? { apiKey: literalApiKey, headers: provider.headers }
      : await resolveModelDiscoveryAuth(providerName, providerEntry);

    const response = await fetch(endpoint, {
      cache: "no-store",
      // Audit S2: a redirect would be a second exfil hop for whatever
      // credential the headers carry.
      redirect: "error",
      headers: buildHeaders(provider.api, auth.apiKey, auth.headers),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json({
        error: responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
        status: response.status,
      }, { status: 502 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return NextResponse.json({ error: "Upstream model list was not valid JSON" }, { status: 502 });
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }

    return NextResponse.json({ models, endpoint: endpoint.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
