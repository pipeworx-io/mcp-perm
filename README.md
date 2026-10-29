# @pipeworx/perm

US green-card labor certification data from DOL PERM (Program Electronic
Review Management, Form ETA-9089) disclosures — "does company X sponsor
green cards", "what does role Y pay at company X under PERM", "who sponsors
the most data engineers for green cards". The permanent-labor-certification
sibling of `@pipeworx/h1b` (which covers the LCA / temporary-visa side).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `perm_employer_certifications(employer, year?)` — filing count, offered-wage
  range, top titles/locations for an employer. Total count first, `data_as_of`
  on every response.
- `perm_salary(job_title, employer?, city?, year?, limit?)` — real disclosed
  offered-wage stats + a sample of records for a role.
- `perm_top_sponsors(job_title, city?, year?, limit?)` — employers ranked by
  filing count for a role, with median offered wage.

## Auth

Keyless. Local mirror only — no caller credential is needed or accepted.

## Local mirror, no live fallback

**Why a mirror**: PERM, like LCA, is published only as bulk quarterly/annual
`.xlsx` files — it is not on the `apiprod.dol.gov` v4 gateway that
`dol-whd`/`osha`/`ebsa` already use (checked live 2026-10-17: not present in
that gateway's 45-dataset catalog). A local Supabase mirror is this pack's
only source.

**Unlike `h1b`, there is no live fallback.** LCA has h1bdata.info, a
long-standing third-party aggregator of the same DOL data; no comparable
third-party mirror of PERM disclosures was found. So when a query falls
outside the mirror's currently loaded fiscal-year window, or the mirror
cannot be read at all, every tool returns a `coverage_status` field and a
`null` (not `false`) sponsorship/count — never a bare empty result that
reads as "this employer doesn't sponsor" when the real reason is that the
mirror has not loaded that year yet, or has not completed its first load.
Three distinguishable states, same discipline as `h1b`'s fleet #3198 fix:

- **`not_loaded_yet`** — the mirror's ingest table is genuinely empty (the
  first refresh has never run). "This data source has not completed its
  first load yet."
- **`mirror_unreachable`** — the coverage read itself failed (no
  credentials, a timeout, a transient DB error). "Not confirmation of zero
  filings — the data source was never actually consulted this call."
- **`out_of_window`** — the mirror answered fine, but the requested fiscal
  year is outside its loaded range. A real (if incomplete-coverage) signal.

**Employer-name match grading.** Both `perm_search`'s SQL
(`employer_name ILIKE '%' || p_employer || '%'`) and the stats RPC's grouping
are plain substring matches, so a query like "Amazon" can legitimately pull
back more than one distinct legal name (verified live against the real
FY2025 file: `AMAZON.COM SERVICES LLC` / `Amazon.com Services LLC` /
`Amazon.Com Services Llc` / `Amazon Data Services, Inc.` all appear).
`matched_employers` ranks exact-match first (after stripping case/punctuation
and common entity suffixes), then name-contains variants, each tagged
`name_match` — same `employerNameKey`/`gradeEmployerMatch`/
`rankEmployerVariants` logic `h1b` uses (fleet #3198).

## PERSONAL-DATA RULE (mandatory, local-copy rule — task #3263)

DOL's own record layout (`PERM_Record_Layout_FY2026_Q3.pdf`, read in full
2026-10-17) carries named-individual contact fields that are **never read
into the mirror** — `scripts/perm-transform.py` uses an ALLOWLIST of source
columns (not a blocklist), so a column DOL adds later is excluded by
default:

- `EMP_POC_{LAST,FIRST,MIDDLE}_NAME`, `EMP_POC_EMAIL`, `EMP_POC_PHONE` and
  every `EMP_POC_ADDR*` field — the employer's named point of contact.
- `ATTY_AG_{LAST,FIRST,MIDDLE}_NAME`, `ATTY_AG_EMAIL`, `ATTY_AG_PHONE`, every
  `ATTY_AG_ADDRESS*`/`STATE_BAR_NUMBER`/`GOOD_STANDING*` field — the
  individual attorney or agent representing the employer
  (`ATTY_AG_LAW_FIRM_NAME`, a business name, is also dropped: unused by any
  tool here).
- `DECL_PREP_{LAST,FIRST,MIDDLE}_NAME`, `DECL_PREP_EMAIL` — whoever signed
  the employer declaration.
- Every `FOREIGN_WORKER_*`/`COUNTRY_OF_CITIZENSHIP`/`CLASS_OF_ADMISSION`
  field — PERM's layout carries no foreign-worker **name** field at all
  (confirmed by reading the full layout), but these still describe the
  sponsored worker's own nationality/education/experience, and no tool here
  needs them.

Kept: `EMP_BUSINESS_NAME`/`EMP_TRADE_NAME` and employer city/state/country/
FEIN/NAICS (no street — same discipline as `h1b_lca_disclosures`), plus
job/wage/worksite fields and case status/dates — this identifies the
employer making a mandatory public disclosure, not a private individual.

## Data sources

- U.S. Department of Labor, Office of Foreign Labor Certification — PERM
  disclosure data. Published quarterly, by federal fiscal year (Oct 1 -
  Sep 30). No auth, no rate limit observed. US federal administrative data —
  public domain.
- **Verified live 2026-10-17: a closed fiscal year's own Q4-labelled file IS
  the full fiscal year already** — DIFFERENT from `h1b`'s LCA mirror, where
  a closed year's quarterly files are each discrete and all four are needed.
  `PERM_Record_Layout_FY2025_Q4.pdf`'s own cover page states "Reporting
  Period: October 1, 2024 through September 30, 2025". So exactly ONE file
  per fiscal year gives full-year coverage. The still-open current fiscal
  year's latest quarterly file is likewise cumulative from Oct 1
  (`FY2026_Q3.pdf`: "October 1, 2025 through June 30, 2026").

## NEW FORM ONLY

DOL's PERM form (ETA-9089) changed 2023-06-01. Verified live 2026-10-17
against two real downloads: an FY2024 file carries the OLD 155-column shape
(e.g. a single `EMP_CONTACT_NAME` field, no `JOB_OPP_WAGE_FROM`), while
FY2025 and later use the NEW 137-column shape this pack's transform expects.
`scripts/perm-transform.py`'s `REQUIRED_SOURCE` check refuses an old-form
file outright rather than silently mis-mapping it — old-form historical
backfill (pre-FY2025) is future work, not attempted here. The mirror
currently loads FY2025 onward.

## Ingest harness

- `supabase/migrations/259_perm_disclosures.sql` — `perm_disclosures` table +
  `perm_ingest_runs` bookkeeping + four RPCs (`perm_search`, `perm_stats`,
  `perm_top_sponsors`, `perm_coverage`). RLS on; `anon`/`authenticated` have
  no grants; `service_role` only.
- `scripts/perm-transform.py` — streams one `.xlsx` file row-by-row via
  `openpyxl(read_only=True)` (never buffers a whole workbook), allowlist-selects
  the non-personal columns, and computes `base_salary_annual` from
  `JOB_OPP_WAGE_FROM`/`JOB_OPP_WAGE_PER` (Hour×2080, Week×52, Bi-Weekly×26,
  Month×12, Year×1), with the same filer-typo guard `h1b`'s transform uses
  (an "Hour"-tagged four/five-figure amount is treated as already annual; any
  annualized result above $5,000,000 is nulled rather than served as data).
- `scripts/perm-upsert.sh` — per file: download (tries the current-year URL,
  falls back to the closed-year archive URL), transform, `\copy` into a
  staging table, then `INSERT ... ON CONFLICT (case_number) DO UPDATE`
  (`CASE_NUMBER` is DOL's own stable per-application id — no synthetic key
  needed).
- `.github/workflows/perm-refresh.yml` — `workflow_dispatch` only
  (deliberately no `schedule:` — Bruce's "supa stagger" rule queues big
  Supabase loads one at a time, overnight, on purpose; GitHub's `schedule:`
  trigger has also been unreliable fleet-wide since ~2026-09-09). Default
  `files` input: `2026:FY2026_Q3` (current open year) + `2025:FY2025_Q4`
  (full FY2025).

### Observed sizes/rows (live, 2026-10-17 — proof-of-transform dry run, store not yet loaded)

| File | Bytes | Real data rows (transform only, no DB write) |
|---|---|---|
| FY2025_Q4 (full FY2025, Oct'24-Sep'25) | 87,007,731 | 147,056 kept, 1,603 dropped (no CASE_NUMBER) |
| FY2024_Q4 (old form, NOT loaded) | 76,167,854 | refused by transform — old-form shape |
| FY2026_Q3 (current, cumulative) | 156,267,808 | not downloaded during the proof run — estimate ~110k-130k by pro-rating FY2025's full-year count to 9 of 12 months |

## Gotchas

- `case_status` values observed live in the real FY2025 file: `Certified`,
  `Certified - Expired` (with spaces around the dash — not
  `Certified-Expired` as the record-layout prose might suggest), `Denied`,
  `Withdrawn`. "Certified" filters match the first two.
- Do not add an FY2024-or-earlier file to the refresh without first building
  an old-form transform path — see "NEW FORM ONLY" above.
- `perm_employer_certifications`/`perm_salary`/`perm_top_sponsors` all
  return `null` (never `false`/`0`) for sponsorship/counts when the mirror
  could not answer — check `coverage_status` before treating an empty result
  as a real negative.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "perm": {
      "url": "https://gateway.pipeworx.io/perm/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/perm/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/perm_employer_certifications \
  -H 'Content-Type: application/json' \
  -d '{"employer":"Microsoft","year":2025}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/perm_employer_certifications`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-perm` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/perm/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "perm": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-perm"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Perm data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
