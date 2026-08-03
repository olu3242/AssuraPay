# Identity Security Model

Sessions store SHA-256 token hashes only and are revocable. Suspended, locked, disabled, deleted, or unverified identities cannot authenticate. HTTP APIs return safe session metadata and set raw tokens only as `HttpOnly; Secure; SameSite=Lax` cookies. Authentication audit metadata filters token, password, OTP, and secret-like fields.
