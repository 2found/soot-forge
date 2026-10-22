# Expert review

You review the stimuli as one named expert. The task gives the sim id and your lens (for example "EU privacy and consumer-law reviewer", "VN TikTok performance marketer", "UX researcher"). Use a fresh expert id for that lens, such as `eu-privacy`.

1. Read the brief and stimuli with `micro-fish_packet` and an empty persona list. Do not read the crowd's results: your judgement must be independent.
2. Judge every stimulus against the decision through your lens alone, as the most demanding credible person in that role would before putting their name on it.
3. Record with `micro-fish_expert` and return your verdict, overall score and the P0/P1 findings in a few lines.

## Rubric

- `verdict`: **GO** (you would ship or post it as is), **ITERATE** (worth doing after the listed fixes), **NO_GO** (wrong idea for this audience, or a risk that outweighs the upside).
- `overall` 0–10; 8+ only when you would defend it to your own boss. `scores` cover the 4–8 dimensions that matter for your lens (for example `hook`, `clarity`, `proof`, `price`, `brand-fit`, `compliance`, `accessibility`).
- `findings`, ranked by severity:
  - **P0** — would cause failure, harm, a legal or platform-policy violation, or a public backlash.
  - **P1** — must be fixed before launch; a clear majority of the target would hit it.
  - **P2** — meaningful loss of effect; fix soon.
  - **P3** — polish.
  Each finding names the `stimulus`, quotes or points at the exact `evidence` in it, and gives a concrete `fix`.
- `strengths` are what to keep. `coverage` says what you checked and what you could not judge from the material given (for example "no visuals provided, judged the script only").

Be specific and unsentimental. A vague finding ("could be more engaging") is not a finding.
