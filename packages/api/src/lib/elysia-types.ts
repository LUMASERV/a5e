import type { Elysia } from 'elysia';

/**
 * Elysia's fluent `.get(...).post(...)` chain accumulates an increasingly specific type per call
 * so `app = registerX(app)`-style reassignment across many dynamically-registered route modules
 * (registerResourceRoutes is called once per CRD kind, in a loop) doesn't roundtrip through
 * TypeScript's structural checks — each module would need the exact prior-accumulated type,
 * which a loop can't express statically. None of these routes use Elysia's typed
 * body/response schema validation anyway (params/body are read as plain JS), so route modules
 * take/return this deliberately widened alias instead of chasing exact inference.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional — see comment above
export type AnyElysia = Elysia<any, any, any, any, any, any, any>;
