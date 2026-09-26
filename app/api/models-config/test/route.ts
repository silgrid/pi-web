import { NextResponse } from "next/server";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { withTempModelsRuntime, TempModelsLoadError } from "@/lib/model-discovery-auth";
import {
  getConfiguredProviderBaseUrl,
  getConfiguredProviderCredentials,
  isConfigExpression,
  redirectRefusingFetch,
  resolveModelDiscoveryCredentialDecision,
  validateModelDiscoveryModel,
  validateModelDiscoveryProvider,
  verifyConfigExpressionsAreConfigured,
} from "@/lib/model-discovery-guards";
import { readModelsConfig } from "@/lib/models-config-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  try {
    const body = await req.json().catch(() => null);
    const validated = validateModelDiscoveryProvider(body);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.reason }, { status: 400 });
    }
    const { providerName, provider } = validated;
    const rawModel = isRecord(body) ? body.model : undefined;
    const validatedModel = validateModelDiscoveryModel(rawModel);
    if (!validatedModel.ok) {
      return NextResponse.json({ ok: false, error: validatedModel.reason }, { status: 400 });
    }
    const model = validatedModel.model;

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
      return NextResponse.json({ ok: false, error: configExpressionCheck.reason }, { status: 403 });
    }
    // An expression apiKey is never a portable "request-chosen" literal, even
    // once verified authentic — it is resolved exclusively through the
    // configured (getAuth) path below, so it still requires the configured-
    // base-URL gate to pass.
    const literalApiKey = provider.apiKey && !isConfigExpression(provider.apiKey) ? provider.apiKey : undefined;

    // Audit S2 (review r1): the credential policy is decided against the
    // EFFECTIVE destination — the SDK's modelFromJson gives a model-level
    // baseUrl precedence over the provider's, so the provider-level check
    // alone would let a model.baseUrl override smuggle the operator's stored
    // credential to a foreign URL.
    const decision = resolveModelDiscoveryCredentialDecision({
      baseUrl: provider.baseUrl,
      ...(literalApiKey ? { requestApiKey: literalApiKey } : {}),
      modelBaseUrl: model.baseUrl ?? null,
      configuredBaseUrl: getConfiguredProviderBaseUrl(providerName, modelsConfig),
    });
    if (!decision.attach) {
      return NextResponse.json({ ok: false, error: decision.reason }, { status: 403 });
    }
    const isRequestKey = decision.source === "requestApiKey";

    const providerEntry: Record<string, unknown> = {
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(Object.keys(provider.headers).length > 0 ? { headers: provider.headers } : {}),
      ...provider.extra,
    };

    const outcome = await withTempModelsRuntime(
      providerName,
      providerEntry,
      [model.entry],
      async (modelRuntime) => {
        const resolvedModel = modelRuntime.getModel(providerName, model.id);
        if (!resolvedModel) return { ok: false as const, error: `Model not found: ${providerName}/${model.id}` };

        // Request-key path (review r1): the key is the client's own LITERAL —
        // it goes out exactly as supplied, on an ISOLATED runtime whose
        // credential store is empty, so no getAuth() resolution can swap in
        // the operator's stored credential (the SDK's auth precedence puts
        // auth.json ahead of a models.json apiKey), inherit OAuth tokens, or
        // resolve server env/command expressions. The stored path resolves
        // through the operator's real auth storage and was gated above on the
        // configured base URL.
        let apiKey: string | undefined;
        let requestHeaders: Record<string, string> | undefined;
        if (isRequestKey) {
          apiKey = literalApiKey;
          requestHeaders = provider.headers;
        } else {
          const resolved = await modelRuntime.getAuth(resolvedModel);
          apiKey = resolved?.auth.apiKey;
          const resolvedHeaders = resolved?.auth.headers;
          requestHeaders = resolvedHeaders
            ? Object.fromEntries(Object.entries(resolvedHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
            : undefined;
        }
        if (!apiKey) {
          return { ok: false as const, error: `No API key found for "${providerName}"` };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        let status: number | undefined;
        const startedAt = Date.now();

        try {
          const message = await completeSimple(resolvedModel, {
            messages: [{
              role: "user",
              content: "Reply with OK only.",
              timestamp: Date.now(),
            }],
          }, {
            apiKey,
            ...(requestHeaders && Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
            maxTokens: 16,
            timeoutMs: TEST_TIMEOUT_MS,
            maxRetries: 0,
            cacheRetention: "none",
            signal: controller.signal,
            fetch: redirectRefusingFetch,
            onResponse: (response) => { status = response.status; },
          });

          const latencyMs = Date.now() - startedAt;
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            return {
              ok: false as const,
              error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
              latencyMs,
              status,
            };
          }

          return {
            ok: true as const,
            latencyMs,
            status,
            responseText: getAssistantText(message).slice(0, 300),
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      { isolatedCredentials: isRequestKey },
    );

    return NextResponse.json(outcome);
  } catch (error) {
    if (error instanceof TempModelsLoadError) {
      return NextResponse.json({ ok: false, error: error.message });
    }
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}
