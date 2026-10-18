interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * PERM MCP — US green-card labor certification data from DOL PERM (Program
 * Electronic Review Management, Form ETA-9089) disclosures.
 *
 * Recruiting/immigration use: "does company X sponsor green cards?", "what
 * does company X pay for role Y under PERM?", "who sponsors the most PERM
 * certifications for role Y?". Each PERM record is a real, disclosed
 * employer + job title + offered wage + worksite + filing dates — the
 * green-card track. `h1b` already covers the LCA/temporary-visa side; this
 * is the permanent-labor-certification sibling.
 *
 * SOURCE: a Pipeworx-maintained local mirror of DOL's own PERM disclosure
 * files (dol.gov/agencies/eta/foreign-labor/performance) — loaded by
 * scripts/perm-upsert.sh / .github/workflows/perm-refresh.yml into Supabase
 * perm_disclosures, schema + RPCs in supabase/migrations/259_perm_disclosures.sql.
 * Same shape as mcps/h1b's LCA mirror (fleet #2514), built for the same
 * reason: PERM is published ONLY as bulk .xlsx files, not on the
 * apiprod.dol.gov v4 gateway dol-whd/osha/ebsa already use (checked live
 * 2026-10-17: it is not in that gateway's 45-dataset catalog).
 *
 * NO LIVE FALLBACK (unlike h1b). LCA has h1bdata.info, a long-standing
 * third-party aggregator of the same DOL data; no comparable third-party
 * mirror of PERM disclosures was found. So outside the local mirror's
 * loaded window, or when it is unreachable, this pack returns an honest
 * `coverage_status` rather than a live-scraped answer — never a bare `[]`
 * that reads as "this employer doesn't sponsor" when the real reason is
 * that the mirror has not loaded that year yet, or has not completed its
 * first load.
 *
 * FISCAL YEAR, NOT CALENDAR YEAR. DOL's own files are organized by FEDERAL
 * fiscal year (Oct 1 - Sep 30); `year` here is passed straight through as
 * that fiscal year.
 *
 * NO PERSONAL DATA IN THE MIRROR (local-copy rule, task #3263). DOL's own
 * record layout (PERM_Record_Layout_FY2026_Q3.pdf, read in full 2026-10-17)
 * carries named-individual contact fields — the employer's point-of-contact
 * name/email/phone, the representing attorney/agent's name/email/phone, and
 * the declaration preparer's name/email — none of which are loaded; see the
 * migration header and scripts/perm-transform.py for the full
 * column-by-column accounting. PERM's layout carries no foreign-worker NAME
 * field at all (unlike some other DOL disclosures), and the mirror also
 * excludes every other foreign-worker nationality/education/experience
 * field as unneeded by any tool here.
 *
 * NEW FORM ONLY. DOL's PERM form changed 2023-06-01; the mirror currently
 * loads FY2025 onward (new-form shape). An FY2024-or-earlier query falls
 * outside the loaded window exactly like a too-old LCA query would.
 *
 * `data_as_of` is on every response (the local mirror's last successful
 * refresh, via perm_coverage()).
 */


const DB_QUERY_TIMEOUT_MS = 9000; // PostgREST's authenticated-role statement_timeout is 8s; just past it so a slow query surfaces as our message, not a bare abort.

const tools: McpToolExport['tools'] = [
  {
    name: 'perm_employer_certifications',
    description:
      "Check whether a US employer sponsors green cards (PERM labor certification) and profile their sponsorship, from DOL PERM (Form ETA-9089) disclosures. Answers 'does company X sponsor green cards' for recruiting and candidate advising. Returns the number of certified PERM filings, offered-wage range (min / median / max), the top sponsored job titles, and top worksite locations for the employer. Filter by year (DOL federal fiscal year, Oct-Sep); defaults to the latest full year. Employer name is matched as the disclosed legal name (e.g. 'Microsoft Corporation', 'Amazon.com Services LLC').",
    inputSchema: {
      type: 'object',
      properties: {
        employer: { type: 'string', description: 'Employer name to look up, e.g. "Microsoft", "Oracle", "Amazon".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2025). Defaults to the most recent full year this pack has data for. Interpreted as DOL federal fiscal year (Oct-Sep).' },
      },
      required: ['employer'],
    },
  },
  {
    name: 'perm_salary',
    description:
      "Look up real green-card (PERM) offered wages for a job title from DOL PERM disclosures — a market wage benchmark backed by actual certified filings (not estimates). Answers 'what do green-card-sponsored software engineers earn at company X / in city Y'. Filter by job title, and optionally by employer, city, and year. Returns wage statistics (count, min / median / average / max) plus a sample of individual records (employer, title, wage, location, dates).",
    inputSchema: {
      type: 'object',
      properties: {
        job_title: { type: 'string', description: 'Job title to search, e.g. "software engineer", "data scientist". Matched as a substring of the disclosed title.' },
        employer: { type: 'string', description: 'Optional employer name to scope to, e.g. "Meta".' },
        city: { type: 'string', description: 'Optional worksite city, e.g. "SEATTLE" or "AUSTIN".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2025). Defaults to the most recent full year.' },
        limit: { type: ['number', 'string'], description: 'Max sample records to return (default 15, max 50).' },
      },
      required: ['job_title'],
    },
  },
  {
    name: 'perm_top_sponsors',
    description:
      "Find which US employers sponsor the most green cards (PERM labor certifications) for a given job title (optionally in a specific city) — a candidate-sourcing / target-account signal for recruiting. Answers 'which companies sponsor the most data engineers for green cards' or 'top PERM sponsors for nurses'. Returns employers ranked by certified PERM filings for the role, each with their filing count and median offered wage. Backed by real DOL PERM disclosures.",
    inputSchema: {
      type: 'object',
      properties: {
        job_title: { type: 'string', description: 'Job title to rank sponsors for, e.g. "data engineer", "physical therapist".' },
        city: { type: 'string', description: 'Optional worksite city to scope to, e.g. "AUSTIN" or "NEW YORK".' },
        year: { type: ['number', 'string'], description: 'Filing year (e.g. 2025). Defaults to the most recent full year.' },
        limit: { type: ['number', 'string'], description: 'Max employers to return (default 15, max 50).' },
      },
      required: ['job_title'],
    },
  },
];

interface PermRecord {
  employer: string;
  job_title: string;
  base_salary: number | null;
  location: string;
  received_date: string;
  decision_date: string;
}

interface Coverage {
  min_fiscal_year: number | null;
  max_fiscal_year: number | null;
  total_rows: number;
  data_as_of: string | null;
}

function defaultYear(): number {
  const y = new Date().getUTCFullYear();
  return y - 1;
}

function yearArg(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2008 && n <= 2100 ? n : defaultYear();
}

// ── Local DOL mirror ─────────────────────────────────────────────────────
// Same DbOutcome/dbRpc shape as mcps/h1b/src/index.ts (fleet #3198) — the
// reason a mirror answer is unavailable (no credentials, unreachable, or
// genuinely empty) travels with the result so a caller can tell "the mirror
// doesn't cover this" from "we couldn't read the mirror this time".
type DbOutcome<T> = { ok: true; data: T[] } | { ok: false; reason: 'no_creds' | 'unreachable' };

async function dbRpcOnce<T>(
  supabaseUrl: string,
  supabaseKey: string,
  fn: string,
  body: Record<string, unknown>,
): Promise<DbOutcome<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DB_QUERY_TIMEOUT_MS);
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'pipeworx-mcp-perm/1.0 (+https://pipeworx.io)',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: 'unreachable' };
    return { ok: true, data: (await res.json()) as T[] };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function dbRpc<T>(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  fn: string,
  body: Record<string, unknown>,
): Promise<DbOutcome<T>> {
  if (!supabaseUrl || !supabaseKey) return { ok: false, reason: 'no_creds' };
  const first = await dbRpcOnce<T>(supabaseUrl, supabaseKey, fn, body);
  if (first.ok) return first;
  return dbRpcOnce<T>(supabaseUrl, supabaseKey, fn, body);
}

interface CoverageResult {
  coverage: Coverage | null;
  reason: 'ok' | 'no_creds' | 'unreachable' | 'empty';
}

async function getCoverage(supabaseUrl: string | undefined, supabaseKey: string | undefined): Promise<CoverageResult> {
  const result = await dbRpc<Coverage>(supabaseUrl, supabaseKey, 'perm_coverage', {});
  if (!result.ok) return { coverage: null, reason: result.reason };
  const row = result.data[0];
  if (!row || row.total_rows === 0) return { coverage: null, reason: 'empty' };
  return { coverage: row, reason: 'ok' };
}

function yearInCoverage(year: number, coverage: Coverage | null): boolean {
  if (!coverage || coverage.min_fiscal_year == null || coverage.max_fiscal_year == null) return false;
  return year >= coverage.min_fiscal_year && year <= coverage.max_fiscal_year;
}

/**
 * Unlike h1b's resolveMirror, there is no live fallback source here — a
 * 'not usable' result always means "answer honestly that this could not be
 * checked", never "try a weaker third party".
 */
type MirrorUnusableReason = 'out_of_window' | 'mirror_unreachable' | 'not_loaded_yet';
interface MirrorResolution {
  coverage: Coverage | null;
  useDb: boolean;
  unusableReason: MirrorUnusableReason | null;
}

async function resolveMirror(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  year: number,
): Promise<MirrorResolution> {
  const covResult = await getCoverage(supabaseUrl, supabaseKey);
  if (covResult.reason === 'ok' && covResult.coverage) {
    if (yearInCoverage(year, covResult.coverage)) return { coverage: covResult.coverage, useDb: true, unusableReason: null };
    return { coverage: covResult.coverage, useDb: false, unusableReason: 'out_of_window' };
  }
  if (covResult.reason === 'empty') return { coverage: null, useDb: false, unusableReason: 'not_loaded_yet' };
  return { coverage: null, useDb: false, unusableReason: 'mirror_unreachable' };
}

function unusableMessage(kind: string, query: string, year: number, reason: MirrorUnusableReason): { message: string; coverage_status: string } {
  if (reason === 'not_loaded_yet') {
    return {
      message: `Could not check PERM filings for ${kind} "${query}" in ${year} — this data source has not completed its first load yet.`,
      coverage_status: 'This data source has not completed its first load yet — results may be empty or incomplete. This is a deployment state, not a query problem.',
    };
  }
  if (reason === 'mirror_unreachable') {
    return {
      message: `Could not read our PERM disclosure data source for ${kind} "${query}" in ${year}. This is NOT confirmation of zero filings — the data source was never actually consulted this call. Retry before concluding there were no filings.`,
      coverage_status: 'The primary data source could not be reached this call.',
    };
  }
  return {
    message: `Our PERM disclosure data does not yet cover fiscal year ${year} for ${kind} "${query}". This is not confirmation of zero filings — only that this year is outside the currently loaded window.`,
    coverage_status: `Fiscal year ${year} is outside the currently loaded window.`,
  };
}

interface DbPermRow {
  employer_name: string;
  job_title: string;
  base_salary_annual: number | null;
  worksite_city: string | null;
  worksite_state: string | null;
  received_date: string | null;
  decision_date: string | null;
}

async function fetchPermFromDb(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  params: { em?: string; job?: string; city?: string; year: number },
): Promise<PermRecord[] | null> {
  const result = await dbRpc<DbPermRow>(supabaseUrl, supabaseKey, 'perm_search', {
    p_employer: params.em || null,
    p_job_title: params.job || null,
    p_worksite_city: params.city || null,
    p_fiscal_year: params.year,
    p_limit: 20000,
    p_any_status: false,
  });
  if (!result.ok) return null;
  return result.data.map((r) => ({
    employer: r.employer_name,
    job_title: r.job_title,
    base_salary: r.base_salary_annual,
    location: [r.worksite_city, r.worksite_state].filter(Boolean).join(', '),
    received_date: r.received_date ?? '',
    decision_date: r.decision_date ?? '',
  }));
}

interface DbStatsRow {
  perm_filings: number;
  with_salary: number;
  min_salary: number | null;
  median_salary: number | null;
  avg_salary: number | null;
  max_salary: number | null;
  top_job_titles: { value: string; count: number }[];
  top_locations: { value: string; count: number }[];
  top_employers: { value: string; count: number }[];
}

async function fetchStatsFromDb(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  params: { em?: string; job?: string; city?: string; year: number; topN?: number },
): Promise<DbStatsRow | null> {
  const result = await dbRpc<DbStatsRow>(supabaseUrl, supabaseKey, 'perm_stats', {
    p_employer: params.em || null,
    p_job_title: params.job || null,
    p_worksite_city: params.city || null,
    p_fiscal_year: params.year,
    p_any_status: false,
    p_top_n: params.topN ?? 10,
  });
  if (!result.ok) return null;
  return result.data[0] ?? null;
}

interface DbTopSponsorRow {
  employer_name: string;
  perm_filings: number;
  median_base_salary: number | null;
  total_all_filings: number;
}

async function fetchTopSponsorsFromDb(
  supabaseUrl: string | undefined,
  supabaseKey: string | undefined,
  params: { job: string; city?: string; year: number; limit: number },
): Promise<DbTopSponsorRow[] | null> {
  const result = await dbRpc<DbTopSponsorRow>(supabaseUrl, supabaseKey, 'perm_top_sponsors', {
    p_job_title: params.job,
    p_worksite_city: params.city || null,
    p_fiscal_year: params.year,
    p_limit: params.limit,
  });
  return result.ok ? result.data : null;
}

// ── employer-name match grading — same pattern as h1b's
// employerNameKey/gradeEmployerMatch/rankEmployerVariants (fleet #3198):
// PERM's own employer_name ILIKE substring match can legitimately pull back
// more than one distinct legal name variant (verified live against the real
// FY2025 file: "AMAZON.COM SERVICES LLC" / "Amazon.com Services LLC" /
// "Amazon.Com Services Llc" all appear for the same query). ───────────────
const EMPLOYER_ENTITY_SUFFIX = /\b(l\s*p|llc|l\s*l\s*c|inc|incorporated|ltd|limited|corp|corporation|co|company|plc|lllp|llp)\b/g;
export function employerNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(EMPLOYER_ENTITY_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function gradeEmployerMatch(query: string, candidate: string): 'exact' | 'contains' | 'other' {
  const q = employerNameKey(query);
  const c = employerNameKey(candidate);
  if (!q || !c) return 'other';
  if (q === c) return 'exact';
  return ` ${c} `.includes(` ${q} `) ? 'contains' : 'other';
}
const EMPLOYER_MATCH_ORDER = { exact: 0, contains: 1, other: 2 } as const;
export function rankEmployerVariants(
  query: string,
  variants: { value: string; count: number }[],
): { employer: string; perm_filings: number; name_match: 'exact' | 'contains' | 'other' }[] {
  return variants
    .map((v, i) => ({ row: { employer: v.value, perm_filings: v.count, name_match: gradeEmployerMatch(query, v.value) }, i }))
    .sort((a, b) => EMPLOYER_MATCH_ORDER[a.row.name_match] - EMPLOYER_MATCH_ORDER[b.row.name_match] || a.i - b.i)
    .map(({ row }) => row);
}

// ── tools ────────────────────────────────────────────────────────────────

async function employerCertifications(supabaseUrl: string | undefined, supabaseKey: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const employer = typeof args.employer === 'string' ? args.employer.trim() : '';
  if (!employer) return { error: 'user_error', message: 'Pass an employer name, e.g. {"employer": "Microsoft"}.' };
  const year = yearArg(args.year);

  const mirror = await resolveMirror(supabaseUrl, supabaseKey, year);
  let unusableReason = mirror.unusableReason;
  const stats = mirror.useDb ? await fetchStatsFromDb(supabaseUrl, supabaseKey, { em: employer, year, topN: 10 }) : null;
  if (mirror.useDb && stats === null) unusableReason = 'mirror_unreachable';

  if (stats !== null) {
    if (stats.perm_filings === 0) {
      return {
        employer,
        year,
        sponsors_green_cards: false,
        perm_filings: 0,
        source: 'dol_perm_disclosures',
        data_as_of: mirror.coverage?.data_as_of ?? null,
        message: `No certified PERM filings found for an employer matching "${employer}" in ${year}. They may not sponsor, may file under a different legal name, or had no filings that year (try another year).`,
      };
    }
    return {
      employer,
      year,
      sponsors_green_cards: true,
      perm_filings: stats.perm_filings,
      source: 'dol_perm_disclosures',
      data_as_of: mirror.coverage?.data_as_of ?? null,
      matched_employers: rankEmployerVariants(employer, stats.top_employers),
      offered_wage_usd: { min: stats.min_salary, median: stats.median_salary, average: stats.avg_salary, max: stats.max_salary },
      top_job_titles: stats.top_job_titles,
      top_locations: stats.top_locations,
      note: `Certified PERM filings ≈ the employer has started or completed the green-card labor-certification process for these roles; an approved PERM does not itself grant a green card. Source: DOL PERM disclosures (federal fiscal year ${year}, Oct-Sep). Aggregated over every matching filing, not a truncated sample. matched_employers is ranked exact-match first, then name-contains variants.`,
    };
  }

  const { message, coverage_status } = unusableMessage('employer', employer, year, unusableReason ?? 'mirror_unreachable');
  return {
    employer,
    year,
    sponsors_green_cards: null,
    perm_filings: null,
    source: 'dol_perm_disclosures',
    data_as_of: mirror.coverage?.data_as_of ?? null,
    coverage_status,
    message,
  };
}

async function salary(supabaseUrl: string | undefined, supabaseKey: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const job = typeof args.job_title === 'string' ? args.job_title.trim() : '';
  if (!job) return { error: 'user_error', message: 'Pass a job_title, e.g. {"job_title": "software engineer"}.' };
  const year = yearArg(args.year);
  const employer = typeof args.employer === 'string' ? args.employer.trim() : undefined;
  const city = typeof args.city === 'string' ? args.city.trim().toUpperCase() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);

  const mirror = await resolveMirror(supabaseUrl, supabaseKey, year);
  let unusableReason = mirror.unusableReason;
  const stats = mirror.useDb ? await fetchStatsFromDb(supabaseUrl, supabaseKey, { em: employer, job, city, year }) : null;
  if (mirror.useDb && stats === null) unusableReason = 'mirror_unreachable';

  if (stats !== null) {
    if (stats.perm_filings === 0) {
      return {
        job_title: job,
        year,
        employer: employer ?? null,
        city: city ?? null,
        source: 'dol_perm_disclosures',
        data_as_of: mirror.coverage?.data_as_of ?? null,
        count: 0,
        message: 'No PERM wage records matched. Try a broader title, a different year, or removing the employer/city filter.',
      };
    }
    const sampleRecs = (await fetchPermFromDb(supabaseUrl, supabaseKey, { em: employer, job, city, year })) ?? [];
    return {
      job_title: job,
      year,
      employer: employer ?? null,
      city: city ?? null,
      source: 'dol_perm_disclosures',
      data_as_of: mirror.coverage?.data_as_of ?? null,
      offered_wage_usd: { count: stats.with_salary, min: stats.min_salary, median: stats.median_salary, average: stats.avg_salary, max: stats.max_salary },
      sample: sampleRecs.slice(0, limit).map((r) => ({ employer: r.employer, title: r.job_title, offered_wage: r.base_salary, location: r.location, received_date: r.received_date })),
      note: `Real disclosed offered wages from DOL PERM filings (federal fiscal year ${year}) — a market wage benchmark. Aggregated over every matching filing (${stats.perm_filings} total), not a truncated sample.`,
    };
  }

  const { message, coverage_status } = unusableMessage('job_title', job, year, unusableReason ?? 'mirror_unreachable');
  return {
    job_title: job,
    year,
    employer: employer ?? null,
    city: city ?? null,
    source: 'dol_perm_disclosures',
    data_as_of: mirror.coverage?.data_as_of ?? null,
    count: null,
    coverage_status,
    message,
  };
}

async function topSponsors(supabaseUrl: string | undefined, supabaseKey: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const job = typeof args.job_title === 'string' ? args.job_title.trim() : '';
  if (!job) return { error: 'user_error', message: 'Pass a job_title, e.g. {"job_title": "data engineer"}.' };
  const year = yearArg(args.year);
  const city = typeof args.city === 'string' ? args.city.trim().toUpperCase() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);

  const mirror = await resolveMirror(supabaseUrl, supabaseKey, year);
  let unusableReason = mirror.unusableReason;

  if (mirror.useDb) {
    const dbSponsors = await fetchTopSponsorsFromDb(supabaseUrl, supabaseKey, { job, city, year, limit });
    if (dbSponsors !== null) {
      if (dbSponsors.length === 0) {
        return {
          job_title: job,
          year,
          city: city ?? null,
          source: 'dol_perm_disclosures',
          data_as_of: mirror.coverage?.data_as_of ?? null,
          count: 0,
          message: 'No PERM sponsors matched. Try a broader title, a different year, or removing the city filter.',
        };
      }
      return {
        job_title: job,
        year,
        city: city ?? null,
        source: 'dol_perm_disclosures',
        data_as_of: mirror.coverage?.data_as_of ?? null,
        total_filings: dbSponsors[0].total_all_filings,
        top_sponsors: dbSponsors.map((s) => ({ employer: s.employer_name, perm_filings: s.perm_filings, median_offered_wage: s.median_base_salary })),
        note: `Employers ranked by certified PERM filings for this role — a sourcing/target-account signal. Source: DOL PERM disclosures (federal fiscal year ${year}). Ranked over ALL matching filings, not a truncated sample.`,
      };
    }
    unusableReason = 'mirror_unreachable';
  }

  const { message, coverage_status } = unusableMessage('job_title', job, year, unusableReason ?? 'mirror_unreachable');
  return {
    job_title: job,
    year,
    city: city ?? null,
    source: 'dol_perm_disclosures',
    data_as_of: mirror.coverage?.data_as_of ?? null,
    count: null,
    coverage_status,
    message,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  try {
    switch (name) {
      case 'perm_employer_certifications':
        return await employerCertifications(supabaseUrl, supabaseKey, args);
      case 'perm_salary':
        return await salary(supabaseUrl, supabaseKey, args);
      case 'perm_top_sponsors':
        return await topSponsors(supabaseUrl, supabaseKey, args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
