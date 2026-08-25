import { type AppRole, resolveRole, roleAtLeast } from './roles';
import { type Session, resolveSession } from './session';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The one gate every protected route should call: not logged in -> 401; logged in but below the
 * required app role (see auth/roles.ts) -> 403 with a message the UI can show directly, instead
 * of letting a missing role surface as a raw Kubernetes 403/500 from deeper in the call stack.
 * Usage: `const auth = await authorize(extractBearerToken(headers), 'user'); if (auth instanceof
 * Response) return auth; const { session } = auth;`
 */
export async function authorize(
  token: unknown,
  min: Exclude<AppRole, 'none'>,
): Promise<{ session: Session; role: AppRole } | Response> {
  const session = resolveSession(token);
  if (!session) return jsonResponse(401, { error: 'unauthorized' });

  const role = await resolveRole(session);
  if (!roleAtLeast(role, min)) {
    return jsonResponse(403, {
      error:
        role === 'none'
          ? 'no role assigned yet — ask an admin to grant you access'
          : `requires the "${min}" role`,
    });
  }
  return { session, role };
}
