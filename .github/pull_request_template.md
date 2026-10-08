## Pack

ID and purpose:

- [ ] Bundled pack under `packs/<id>`
- [ ] Link to an external GitHub repository, pinned to a reviewed full commit

## Review

- [ ] Source license permits redistribution; attribution is in the pack README
- [ ] README describes dependency preparation, capabilities, effects and credentials
- [ ] No secrets, binaries, runtime data or automatic grants
- [ ] Catalog entry matches the manifest ID
- [ ] `node --test scripts/*.test.mjs` and `node scripts/validate.mjs` pass
- [ ] Pinned external content was validated (`--remote`, if applicable)
