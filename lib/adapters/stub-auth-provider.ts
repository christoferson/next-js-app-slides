/**
 * v1 auth: everyone is `DEFAULT_USER_ID` (SPEC §11).
 *
 * This is a real implementation of the port, not a placeholder to be replaced by inline code
 * later. Because it satisfies `AuthProvider`, every layer above is already written against a
 * principal it did not choose — so a Cognito provider is one factory case, and no service or route
 * changes when the userId stops being a constant.
 */

import type { AuthProvider, Principal } from "@/lib/ports/auth-provider";

export class StubAuthProvider implements AuthProvider {
  constructor(private readonly userId: string) {}

  async authenticate(_headers: Headers): Promise<Principal | null> {
    // Headers are ignored deliberately: a stub that honoured, say, an `x-user-id` header would be
    // an authentication bypass the moment this shipped anywhere non-local.
    return { userId: this.userId, displayName: "Local user" };
  }
}
