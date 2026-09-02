/**
 * The one place a value read out of a `v1/Secret` is turned into something safe to hand a
 * client. Used by every client-facing rendering of secret-sourced data — today the resolved
 * inventory download (api/modules/inventory-download.ts), which shows *which* host vars a
 * `varsBySecret` entry contributes (hosts.ts) without ever revealing what they hold.
 *
 * The operator deliberately does NOT mask: an `ansible-playbook` run needs the real values, and
 * it keeps them out of reach by rendering the inventory into a run-owned Secret rather than a
 * ConfigMap (see run-controller.ts).
 */

/**
 * Values of at most this length are passed through verbatim; anything longer is masked.
 *
 * The threshold exists because a mask is a blanket substitution: a 1–5 character value ("yes",
 * "true", "22", a single-digit index) collides with unrelated text everywhere it appears, so
 * masking those would shred legitimate output while protecting nothing an attacker couldn't
 * guess in a handful of tries anyway. Anything longer is treated as real credential material.
 */
export const SECRET_VALUE_MASK_MIN_LENGTH = 5;

/** Fixed-width regardless of the input, so the mask itself doesn't leak the value's length. */
export const SECRET_VALUE_MASK = '********';

export function maskSecretValue(value: string): string {
  return value.length > SECRET_VALUE_MASK_MIN_LENGTH ? SECRET_VALUE_MASK : value;
}

/** `maskSecretValue` over a whole var map — key names are kept, every value is masked. */
export function maskSecretValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, maskSecretValue(v)]));
}
