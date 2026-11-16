# Soot authoring schema

pack.json is the generated public pack v2 schema printed by `soot schema pack` (2found/2agent); the folder name is the pack id. SOURCE.md records the baseline import revision.

Runtime semantic validation remains soot add/check. Refresh this file with `soot schema pack > schemas/pack.json` when the public contract changes; never hand-edit it. Forge ships the schema to keep PR validation public and independent of the private runtime repository.
