Collections belong to the workspace, not to a Soot or conversation. A pool ID
is a collection ID. Discover allowed collections with data-pool_pools (paginated,
parent filter and paths), then choose task-relevant sources/destinations without
asking the user to select one for every chat. Do not copy documents just because
another group needs them. Pass collection/document IDs to delegated teammates.
Group membership is host-bound; a model cannot claim membership or grant itself
access. Successful read/write provenance is recorded from host context.

# Manage company pools
Management is explicitly delegated. A host-bound manager can create a pool with `data-pool_manage` action pool_create, stable pool ID, display name and request_id. Every other Soot starts with no pool access. Grant a host-bound Soot read, write or manage permission using action grant; revoke using action revoke. A pool manager may grant/revoke only within its managed pool and only to the host's allowed Soot IDs. Read cannot write; write cannot grant. Host managers retain their delegated administrative access; revoke does not remove a host manager from the operator binding.
Share the company pool with marketing, support and blog Soots by granting each read. Grant write only to data curators. Pool removal deletes all its documents and requires an explicit operator request. Use stable request_id values and inspect pending/uncertain results as described by the read/write skills. Do not submit another removal or overwrite an unresolved effect.
Installation and host capability selection are separate: `soot add` installs this Pack and Nest's existing capability settings select it. Data pool grants never edit runtime capabilities, bind credentials, install code or change the host vault. Changes to host managers/allowed Soots belong to the operator. Do not claim per-user/customer isolation when multiple people share one Soot identity.

Meilisearch installation is an operator choice, separate from this Pack. Never install/start Meilisearch, create a VM, or invoke 2server deployment on behalf of the user. If infrastructure is missing, explain the local Docker and VM template guides in this Pack's docs/meilisearch.md. For local and VM Soots sharing pools, use one central data-pool service; independent local policy stores are not shared merely because the Meilisearch URL matches. Service tokens are per-Soot or per-host (bounded to that host's listed Soots); never ask for or print secret values.

Use pool_create with parent for a child; pool_update renames/moves or changes inherit. New children inherit; inherit:false creates a private boundary. grant/revoke targets exactly one soot or group; group "@workspace" is every bound Soot, at read or write only (pool_create scope workspace/group seeds read unless level write is given). Removing a parent with children is refused. Revoking a direct grant does not remove access inherited or supplied by another group.
