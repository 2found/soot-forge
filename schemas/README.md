# Soot authoring schema

pack.json is the generated public soot/v1 pack schema exported by 2found/2agent. SOURCE.md records the baseline import revision.

Runtime semantic validation remains soot add/check. Refresh this file from Soot contract generation (`go run ./scripts/contractgen` in 2agent) when the public contract changes; never hand-edit it. Forge ships the schema to keep PR validation public and independent of the private runtime repository.
