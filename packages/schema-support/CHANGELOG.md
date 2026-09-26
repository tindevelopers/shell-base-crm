# @tindevelopers/schema-support

## 1.0.0

**BREAKING.** Adopts Konnect's owner-scoped support escalation chain
(ADR-0002: this package is the schema owner for the tables below) and
retires the partner ticket queue it replaces.

- **Every support table is now owned by exactly one of `tenant` | `partner`
  | `platform`** (`owner_scope`, plus a nullable `partner_id` alongside the
  now-nullable `tenant_id`) on `support_tickets`, `support_categories`,
  `support_ticket_threads`, `support_ticket_attachments`, and
  `support_ticket_history`. Ground truth:
  `20260924100000_support_owner_escalation.sql`.
- **`support_tickets.status`** gains `waiting_on_customer` and
  `waiting_on_upstream`; **`support_tickets.escalated_to_platform_admin_at`
  is dropped** (platform escalation now goes through `owner_scope =
  'platform'` and the escalation gateway below); **`+ support_tickets.group_id`**
  (FK to the new `support_groups`).
- **`support_ticket_history.changed_by` is now nullable** — the rewritten
  `track_ticket_history()` trigger writes `NULL` for a system actor.
- **New tables**: `support_groups` (tiers inside one owner),
  `support_ticket_links` (cross-organization escalation/merge, written by the
  SECURITY DEFINER gateway functions in
  `20260924110000_support_escalation_gateway.sql`), and
  `support_access_grants`/`support_access_events` (Support access, option C —
  a consented, time-boxed, read-only, logged grant for a partner or the
  platform to read an owner's tickets; ground truth:
  `20260924120000_support_access_grants.sql`).
- **`partner_support_tickets`/`partner_support_ticket_replies` are retired**
  and their schemas/manifest entries removed (`src/partner-tickets.ts`
  deleted). The migration that dropped them
  (`20260924100000_support_owner_escalation.sql`) confirms "no production
  data of substance, confirmed 2026-09-24". Partner-owned tickets now live in
  `support_tickets` with `owner_scope = 'partner'`. See `retiredTables` in
  `./manifest` for the create/drop migration pair, kept for provenance.
  `@tindevelopers/domain-support`'s `createCounterpartyTicketStore` (the
  store built on these two tables) is removed in the same release — see that
  package's changelog.
- **`support_tickets.created_by` is now immutable** and the owner-member
  INSERT policy requires it to be the caller or a fellow member of the same
  owner, closing a gap where any owner member could hand ticket read/reply
  access to an arbitrary outside user. No column type/nullability/CHECK
  change — Zod schemas are unaffected. Ground truth:
  `20260925090000_pin_support_ticket_created_by.sql`.
- **Every support table's RLS policies (and the shared support-storage
  policies) now apply to `authenticated` only**, and anon's `EXECUTE` on the
  support helper/RPC functions is revoked — found by the Supabase security
  advisor; no data had leaked (helpers answered `false`/`NULL` for anon), this
  closes the surface. No column change. Ground truth:
  `20260926120000_support_anon_lockdown.sql`.

Konnect's hosted database applied these last two migrations under renumbered
migration-history versions (`20260926000001`–`20260926000010`) during a
history cleanup; the file names above (this package's `migrations/`) are the
ADR-0002 source of truth, not the hosted `schema_migrations` history table.
