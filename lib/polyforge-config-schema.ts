/**
 * Browser-safe key-schema facts for the Settings › Polyforge configuration
 * panel.
 *
 * The panel's controls are built from pf's own key schema, and the form
 * enforces the same bounds before a write reaches the route. That guard must
 * run in the browser, so this module is deliberately import-free: the
 * server-side reads in `lib/polyforge-config.ts` pull `node:child_process`
 * and the pi SDK, which must never enter the client bundle. `polyforge-config.ts`
 * uses the `PolyforgeConfigSchema` type from here; the client form uses
 * `configValueError`. One definition, two consumers.
 */

/** The shape of pf's per-key validator facts, unchanged from the wire. */
export interface PolyforgeConfigSchema {
  kind: string;
  min?: number;
  max?: number;
  min_exclusive?: number;
  nonzero?: boolean;
  allow_negative?: boolean;
  enum?: unknown;
  [key: string]: unknown;
}

/** Parse a Go duration (the `supervision` keys' syntax) to milliseconds, or
 *  null when the text is not one. Pure and exported so the form can enforce
 *  pf's duration schema client-side. */
export function parseGoDurationMs(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "0" || trimmed === "-0" || trimmed === "+0") return 0;
  if (!/^-?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(trimmed)) return null;
  const factors: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  for (let m = re.exec(trimmed); m !== null; m = re.exec(trimmed)) {
    total += Number(m[1]) * factors[m[2]];
  }
  return trimmed.startsWith("-") ? -total : total;
}

/** The form's client-side enforcement of pf's key schema (spec: "Unreachable
 *  in the form"): an int's min/max and a duration's min_exclusive/nonzero are
 *  checked here so the form cannot submit 0 or 9. It is a guard, not a second
 *  validator — the route still hands every value to pf. */
export function configValueError(key: string, value: unknown, schema: PolyforgeConfigSchema | undefined): string | null {
  const kind = schema?.kind;
  if (kind === "model-list" || key === "summarize.models") {
    if (!Array.isArray(value) || value.length === 0) return "at least one model candidate is required";
    if (value.some((item) => typeof item !== "string" || item.trim() === "")) return "model candidates must be non-empty strings";
    return null;
  }
  if (kind === "int") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(n)) return "an integer is required";
    if (typeof schema?.min === "number" && n < schema.min) return `must be at least ${schema.min}`;
    if (typeof schema?.max === "number" && n > schema.max) return `must be at most ${schema.max}`;
    return null;
  }
  if (kind === "duration") {
    const ms = typeof value === "string" ? parseGoDurationMs(value) : null;
    if (ms === null) return "a Go duration such as 45m is required";
    if (typeof schema?.min_exclusive === "number" && ms <= schema.min_exclusive * 1000) return "must be greater than zero";
    if (schema?.nonzero === true && ms === 0) return "must be non-zero";
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") return "a value is required";
  return null;
}
