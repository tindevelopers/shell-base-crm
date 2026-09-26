# @tindevelopers/domain-pipeline

## 1.0.1

Corrective republish of 1.0.0 under a new version; the source is unchanged.
**Do not use 1.0.0**: it was published by `npm publish`, which left the
`"@tindevelopers/schema-crm": "workspace:^"` dependency unrewritten, so it
cannot be installed outside this repo. 1.0.1 is packed with `pnpm pack`, and
its manifest depends on `@tindevelopers/schema-crm ^1.2.0`.

## 1.0.0

Initial extraction of Konnect's CRM pipeline (companies, deal stages, deals,
tasks, notes, activities — `apps/app/app/actions/crm/{companies,deals,tasks,notes,activities}.ts`)
into a shared hub package, following the pattern `domain-contacts` and
`domain-support` established:

- **New public API**: `createCompanyStore`, `createDealStageStore`,
  `createDealStore`, `createTaskStore`, `createNoteStore`,
  `createActivityStore`, and `createPipelineStore` (all
  `(client: SupabaseClient, tenantId: string) => …`, the same
  injection-only shape as `domain-contacts`' `createContactsStore` and
  `domain-support`'s `createSupportStore`). Row/insert/update types come
  from `@tindevelopers/schema-crm`, not redeclared here.
- **Tenant resolution moves to the host.** Konnect's `updateDeal()` used
  `getCurrentTenant()` while every other function used `getTenantForCrm()`
  — an inconsistency that disappears here: every store takes `tenantId`
  once, at construction, and the host resolves it however it resolves
  tenants for any other call.
- **Identity resolution moves to the host.** Konnect's `create*` functions
  read `supabase.auth.getUser()` internally; these stores instead take
  `created_by`/`assigned_to` as explicit optional arguments, matching
  `domain-support`'s ticket store (R2, injection-only).
- **New: cross-tenant reference verification.** `createDealStore` verifies
  `company_id`/`contact_id`/`stage_id`; `createTaskStore` and
  `createNoteStore` verify `company_id`/`contact_id`/`deal_id`. Konnect
  trusted a host-supplied id as-is; a foreign key alone only proves the row
  exists somewhere, not that it belongs to the caller's tenant.
- **New: `tasks_has_reference`/`notes_has_reference` enforced at the
  application layer.** `createTaskStore().create` requires exactly one of
  `contact_id`/`company_id`/`deal_id`; `createNoteStore().create` requires
  at least one. Neither CHECK is represented in `@tindevelopers/schema-crm`'s
  Zod schemas yet, so without this a bad request reached the database and
  failed with a raw constraint-violation error instead of a clear one.
- **New: deal stages are no longer hard-coded.** `createDealStageStore`
  exposes full CRUD so a tenant can customize its stages, plus a
  `seedDefaults()` helper that seeds the same six names/colors Konnect's
  `createDefaultDealStages()` hard-codes, only for a tenant that has none
  yet (Konnect's version re-runs the insert every call and relies on the
  `UNIQUE(tenant_id, position)` constraint to skip duplicates row-by-row).
- **Empty-string optional fields.** Every `create()` treats `''` as `null`
  for optional string/uuid columns (e.g. company `website`/`phone`/`email`,
  deal `currency`/`description`, task `priority`/`due_date`) — an empty
  string sent to a `uuid` column fails at the database. Numeric/boolean/
  jsonb/array fields use `?? null` instead, so a legitimate falsy value
  (`0`, `false`) is never coerced away.
- **`bulkComplete`/`bulkRemove` return the count of rows actually matched**
  (via `.select("id")` on the tenant-scoped mutation), not the length of the
  input id array — Konnect's `bulkCompleteTasks` returned `ids.length`
  regardless of how many ids actually belonged to the tenant.
- **New: `createCustomFieldStore`**, ported from Konnect's
  `apps/ops/app/actions/crm/custom-fields.ts` (per-tenant admin-defined
  extra fields on contacts/companies/deals). `list(entity?)` / `get` /
  `create` / `update` / `remove`, typed from `@tindevelopers/schema-crm`'s
  `CustomFieldDefinitionRow`/`Insert`/`Update`. Added to `createPipelineStore`
  as `customFields`, alongside the six existing stores.
