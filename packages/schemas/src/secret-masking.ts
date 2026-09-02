/**
 * The one place a value read out of a `v1/Secret` is turned into something safe to hand a
 * client. Used by every client-facing rendering of secret-sourced data — today the resolved
 * inventory download (api/modules/inventory-download.ts), which shows *which* host vars a
 * `varsBySecretRef` entry contributes (hosts.ts) while withholding anything long enough to be
 * credential material. Note the threshold below: this masks, it does not redact unconditionally.
 *
 * The operator deliberately does NOT mask — an `ansible-playbook` run needs the real values. It
 * keeps them out of the artifacts it generates a different way: each referenced Secret is mounted
 * into the Job and the rendered inventory reads the mounted files, so no value is written into the
 * inventory ConfigMap at all (see operator/resolvers/inventory-render.ts's `secretVarLookup`).
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
