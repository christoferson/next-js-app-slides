/**
 * CLAUDE.md §2 step 3 — the auth PORT.
 *
 * v1 ships a stub that returns `DEFAULT_USER_ID`, but every repository call is already
 * `(userId, …)`-keyed (§6.4), so switching to Cognito is one factory case and zero service
 * changes. The port takes the incoming `Headers` rather than a framework request object so it
 * stays independent of Next.
 */

export interface Principal {
  /** The scoping key for ALL persisted data. Never derived from user input. */
  userId: string;
  displayName?: string;
}

export interface AuthProvider {
  /**
   * Resolve the caller, or `null` if unauthenticated. Returning `null` (rather than throwing)
   * keeps the `Unauthorized` mapping a route/facade decision, matching the repository ports'
   * absence convention.
   */
  authenticate(headers: Headers): Promise<Principal | null>;
}
