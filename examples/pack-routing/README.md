# Pack routing eval

One mixed Soot (`soots/forge`) with 15 Forge capabilities and `evals/routing.eval.json`: does the model pick the
right pack tool for a plain request, and stay tool-free for small talk, out-of-scope asks and missing recipients?

Copy this folder next to a `packs.d/` that holds the packs named in `soots/forge/soot.json`, set a provider in
`deployment.example.json` (saved as `deployment.json`), then:

```sh
soot check --strict && soot serve --config deployment.json &
soot eval
```

Tools are not configured here, so real calls end `blocked`; the gates check the tool chosen, not the effect.
Measured 2026-10-28 on claude-code/claude-sonnet-5-5: every routing case picks the intended tool.
