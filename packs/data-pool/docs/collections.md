# Workspace collections

The operator-bound service `namespace` identifies the workspace/company.
Collections contain documents and subcollections. Groups and Soots receive
access independently of the tree; conversations/runs record provenance.
Department, team, project and product are user-chosen organization, not fixed
levels. Existing `pool` IDs and operation names remain compatible with `soot/v1`.
No documents, source URIs, receipts, revisions or Meilisearch indexes are renamed.
The one-time upgrade indexes bounded metadata, not document bodies.

## Organize

```json
{"action":"pool_create","pool":"launch-alpha","name":"Launch Alpha","parent":"projects","request_id":"create-launch"}
```

New children inherit permissions by default; `inherit:false` creates a private
boundary. Existing roots retain their previous private/direct-grant behavior.
Creating a root requires a workspace manager; a child requires management of its
parent. A delegated creator retains a direct management grant on the new child.

`pool_update` accepts `name`, `parent` and `inherit`. Empty parent means workspace
root. Moving requires management of source and destination; it recalculates
inherited access without rewriting documents. Cycles and paths deeper than 8
collections are rejected. Removing a parent with children is refused, never
implicitly recursive. The current workspace limit is 256 collections; overview
serves limits to the UI.

`data-pool_pools` paginates at most 20 results with accessible breadcrumbs. Omit
`parent` to discover all accessible collections; `parent:""` lists roots and a
parent ID lists immediate children. Documents/search use collection ID as `pool`.
Search remains fuzzy, accent-insensitive and Meilisearch index-backed within the
chosen collection. No unbounded client-side workspace search is introduced.

## Host groups, access and defaults

Extend the existing private backend binding (not a standalone credential):

```json
{
  "groups": {"marketing": ["collector", "writer", "publisher"]},
  "defaults": {"collector": "research-inbox", "writer": "drafts"}
}
```

Supply membership from the operator-approved host roster. `configure-service.py`
preserves these fields in the private service config. Restart the service to
apply changed membership/defaults, like existing Soot/token bindings; rotate
client tokens when removing an identity. Editing a runtime group alone does not
silently update another service's configuration. No synchronization daemon is
added. Model input and envelope `group_id` never grant membership.

```json
{"action":"grant","pool":"launch-alpha","group":"marketing","level":"read","request_id":"grant-team"}
```

Target exactly one `group` or `soot`. `"group":"@workspace"` targets every
bound Soot; it is what `pool_create` with `scope:"workspace"` writes, appears in
pool detail `grants` as `"@workspace"`, and is limited to `read` or `write`
(scope seeding defaults to `read`). Bound group IDs cannot start with `@`, so the
spelling never collides with a real group. The highest applicable `read`,
`write` or `manage` grant wins across direct, workspace, group and inherited
permissions. `revoke`
removes that explicit grant; another group or ancestor may still grant access.
`inherit:false` cuts ancestor grants while keeping local grants. Workspace
administrators remain host-owned. Grants never install tools or add members.

Effective principal indexes update on policy/hierarchy changes for the affected
subtree. Discovery merges Soot/group index cursors. Document writes do not rebuild
or scan the tree. Moves/revokes retain the exclusive policy barrier; independent
reads/writes retain shared admission and durable receipt/document fences.
Descendant policy revisions advance so stale human editors detect ancestor edits.

Soots discover allowed collections, choose task-relevant sources/destinations,
and pass IDs to teammates. A job can read Brand and Product Alpha while writing
Launch Alpha/Drafts; users need not choose a collection for every chat. Omit
`pool` on a write only when the host configured its default. Missing/revoked
defaults fail, never silently redirect data. Collection creation/classification
is not on the ingestion path; append continues accepting duplicate observations.

## Conversation references

Only host envelope conversation/run IDs and eligible group identity are retained,
not event text, prompts or provider config. Document `origin` includes workspace,
credential-bound Soot and available correlation IDs. These are host-reported
correlation, not new authorization credentials. A no-op write keeps the existing
document origin and records the new successful use separately.

```json
{"action":"references","conversation_id":"HOST_CONVERSATION_ID","run_id":"HOST_RUN_ID","limit":20}
```

References record successful explicit document reads and committed writes with
collection generation, ID, revision and hash. A committed write replay adds no
reference. Read-time authorization hides revoked collections and deleted/reused
generations. A Soot sees its own references; workspace managers can inspect the
team. Retain the latest 1,000 references per conversation; sequence pagination and
`oldest_sequence` disclose truncation. This is not a version archive or proof the
model used a source in its final answer.

Nest's existing Data pane provides root/child navigation, breadcrumbs, group and
direct access, private boundaries, rename/move and original-conversation links.
Human writes retain generation/revision checks. Policy conflicts preserve entered
fields and let the operator reload the current policy before resubmitting.
