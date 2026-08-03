# Identity Architecture

Global user identities are separate from workspace membership. `IdentityService` owns registration, activation, hashed session tokens, revocation, authentication methods, device trust, and expiring step-up challenges. Authentication creates append-only audit and versioned outbox evidence. Device trust never changes authorization or identity assurance by itself.
