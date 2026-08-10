import { z } from 'zod';

/**
 * The primitives every canonical persisted schema is built from.
 *
 * They exist so that a bound is stated once and enforced everywhere. Before this module
 * there were zero Zod schemas in the repository and the only bound on an aggregate field
 * was whatever the engine that wrote it happened to check — which for identity, timestamps
 * and money was nothing.
 *
 * Each primitive is pinned to the database constraint it mirrors, and the pairing is the
 * point: a schema that permits a value the column refuses turns a validation pass into a
 * write failure, and a schema stricter than the column lets a console session create rows
 * the application then cannot read.
 */

/**
 * An aggregate, tenant, workspace, actor or reference identifier.
 *
 * Bounded 1–200 characters because that is the `CHECK (length(...) BETWEEN 1 AND 200)`
 * that `202608090001_wave4_trust_authority` put on every identity column in Batch A when
 * it converged them from `UUID` onto the trust runtime's `TEXT`. Not a UUID pattern: the
 * trust runtime's identifiers are opaque strings — `trust_workspaces.workspace_id` holds
 * whatever the workspace engine minted — and a UUID regex here would reject them.
 */
export const identifier = z.string().min(1).max(200);

/**
 * An instant, as the engines write it: `new Date().toISOString()`.
 *
 * `z.string().datetime()` accepts the `Z` form these produce and rejects a local time with
 * no zone, which is the value that reads as correct and means a different instant in every
 * deployment.
 */
export const instant = z.string().datetime();

/**
 * A calendar date with no time and no zone — `YYYY-MM-DD`.
 *
 * Used for `inspections.scheduled_for` and `corrective_action_plans.due_date`, both `DATE`
 * columns. The domain types declare these `string` with no format, so an ISO datetime
 * typechecks; `DATE` would then accept it and silently discard the time, which
 * `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` forbids ("never silently coerce"). The
 * schema refuses it instead, and canonical engine behaviour agrees — every call site in
 * the Engine 36–37 suites passes a plain date.
 */
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      // Built and compared rather than parsed. `Date.parse('2026-02-30')` does not fail — V8
      // falls back to a lenient parser that rolls the day over to 2 March — so a parse-succeeded
      // check accepts dates that do not exist and shifts them silently, which is the coercion
      // this primitive exists to prevent.
      const [year, month, day] = value.split('-').map(Number);
      const built = new Date(Date.UTC(year, month - 1, day));
      return (
        built.getUTCFullYear() === year &&
        built.getUTCMonth() === month - 1 &&
        built.getUTCDate() === day
      );
    },
    { message: 'not a real calendar date' },
  );

/**
 * A non-negative amount in integer minor units.
 *
 * `docs/finance/MONETARY_INVARIANTS.md`: integer minor units, never binary floating point,
 * base amounts non-negative. Bounded by `Number.MAX_SAFE_INTEGER` rather than by the
 * column's `bigint` range, because the domain types type money as `number` — a value
 * beyond 2^53 would round on the way through JavaScript, and a schema that accepted it
 * would be promising precision the language cannot deliver.
 */
export const minorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The governed currency set.
 *
 * NGN and USD, which are the only codes any canonical behaviour uses, and CLAUDE.md is Naira-first
 * and multi-currency-ready. `202608100002` puts the same pair in a `CHECK` on every settlement
 * table that carries an amount, so the schema and the column agree by construction.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze(['NGN', 'USD']);

/**
 * An ISO 4217 code from the governed set.
 *
 * `z.string().refine(...)` rather than `z.enum([...])`, and the reason is the conformance
 * assertions. The domain types declare `currency: string`; an enum would infer `'NGN' | 'USD'`,
 * which is not identical to `string`, and the compile-time proof binding each schema to its
 * hand-written type would fail. Narrowing the accepted *values* without narrowing the *type* is
 * the same technique `calendarDate` uses, and it keeps the published contract unchanged while the
 * validator still refuses an unsupported code.
 */
export const currencyCode = z
  .string()
  .refine((value) => SUPPORTED_CURRENCIES.includes(value), {
    message: 'not a governed currency',
  });

/**
 * A strictly positive amount in integer minor units.
 *
 * Distinct from `minorUnits`, which permits zero. A gross entitlement, an invoice, a requested
 * release, a reservation and a commitment are all `CHECK (... > 0)` in the schema: a zero-amount
 * claim is not a claim, and the engines refuse it.
 */
export const positiveMinorUnits = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

/**
 * A signed amount in integer minor units.
 *
 * For a *delta*, never for a base amount. `docs/finance/MONETARY_INVARIANTS.md` makes base
 * contractual, claim, invoice, entitlement, funding, release and payment amounts non-negative and
 * requires signed effects to use an explicit adjustment record — a contract variation is neither a
 * base amount nor a posted correction, and it may legitimately reduce an entitlement.
 */
export const signedMinorUnits = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

/** A required-approval count, matching `CHECK (required_approvals >= 1)`. */
export const approvalCount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A non-negative count, as the quality-gate aggregates carry. */
export const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A percentage between 0 and 100 inclusive, matching `CHECK (… BETWEEN 0 AND 100)`. */
export const percentage = z.number().min(0).max(100);

/** Free text that must carry content — the engines' `if (!x.trim()) throw` rule, stated once. */
export const requiredText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must not be blank',
  });

/**
 * Text that may legitimately be empty.
 *
 * Distinct from `requiredText` on purpose: `validation_tests.notes` is `TEXT NOT NULL` and
 * the engine requires content only for a conditional pass, so demanding it always would
 * reject a recorded outright pass.
 */
export const optionalText = z.string();

/**
 * Compile-time proof that two types are identical.
 *
 * The conditional-type identity trick rather than mutual assignability: `[A] extends [B]`
 * both ways treats `{ a?: string }` and `{ a: string | undefined }` as the same shape, and
 * those persist differently — one omits the column, the other writes a null.
 */
export type Identical<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;

/**
 * `true` when a schema's inferred type is exactly a domain type, and `never` otherwise.
 *
 * Used as the annotation on a `const … = true`, so a disagreement is a type error at the
 * declaration rather than a runtime surprise. `never` is what makes it fail: nothing is
 * assignable to it, `true` included.
 *
 * This is the mechanism `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` requires. All 35
 * wave 4–5 aggregates already export a hand-written domain type that other packages
 * import, so those types are canonical (authority rank 4) and replacing them with inferred
 * ones would change published contracts as a side effect of adding validation. Keeping both
 * is only safe because this assertion makes one of them derived in effect: they cannot
 * drift without failing `pnpm typecheck`.
 */
export type SchemaMatchesType<Schema, DomainType> =
  Identical<Schema, DomainType> extends true ? true : never;
