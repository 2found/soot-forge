// The Lohi agent role each tool needs (api/src/modules/agent-access/policy.ts is the authority; this is the pack's
// copy so a 403 names the role to mint instead of a generic "agent_mod"). First role is the one named in the message;
// the rest also pass. An empty list means the tool sends no Lohi key.
const ANALYTICS = ['agent_analyst', 'agent_curator'];
const READ = ['agent_catalog_exec', 'agent_curator', 'agent_analyst'];
export const TOOL_ROLES = {
  catalog_health: ANALYTICS, quality_list: ANALYTICS, duplicates_scan: ANALYTICS, litrans_health: ANALYTICS, pricing_report: ANALYTICS,
  comments_pull: ['agent_moderator'], comments_decide: ['agent_moderator'], comments_resolve: ['agent_moderator'],
  violations_list: ['agent_moderator'], violation_resolve: ['agent_moderator'],
  catalog_jobs_sync: ['agent_curator'],
  requests_pending: ['agent_curator'], request_accept: ['agent_curator'], request_reject: ['agent_curator'],
  edits_pending: ['agent_curator'], edits_context: ['agent_curator'], edit_verdict: ['agent_curator'], enrichment_enqueue: ['agent_curator'],
  translate_start: ['agent_catalog_exec'], translate_step: ['agent_catalog_exec'],
  request_finish: ['agent_catalog_exec', 'agent_curator'],
  fixes_pull: READ, fix_recheck: READ,
  reports_open: READ,
  fix_execute: ['agent_catalog_exec'], chapter_retranslate: ['agent_catalog_exec'], chapter_tts: ['agent_catalog_exec'],
  // WP7: the no-model fix pass, a review task's context (read) and Catalog Exec's decision on it.
  fixes_run: ['agent_catalog_exec'], fix_context: READ, fix_resolve: ['agent_catalog_exec'],
  // Request → release (bs-kh1atl85): the sample is a read; the verdict dispatches platform-paid audio (catalog.spend).
  quality_sample: READ, quality_verdict: ['agent_catalog_exec'], release_step: ['agent_catalog_exec'],
  // No Lohi key: cards and pack-table work only.
  onboard_card: [], catalog_jobs_answer: [], catalog_jobs_decide: [], fix_ack: [],
};
/** "agent_curator" or "agent_analyst hoặc agent_curator" for the message of a refused call. */
export const roleLabel = tool => {
  const roles = TOOL_ROLES[tool];
  return roles?.length ? roles.join(' hoặc ') : null;
};
