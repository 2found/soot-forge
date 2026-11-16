---
name: lohi-ops-release
description: "Catalog Exec's release gate: sample the first batch of a new novel, judge it by the flags, give one verdict. Short; read only this for ops-release-step."
---

# Release gate (Catalog Exec)

Woken by `ops-release-step` with `to_judge` novels. For each: `lohi-ops_quality_sample {slug, from, to}` once, then ONE
`lohi-ops_quality_verdict`. Nothing else; do not read chapters or other skills.

- Fail when any sampled chapter has the flag `empty`, `thin` or `leftover_cjk`, or `names_missing` in more than two chapters;
  otherwise pass. `no_audio` is not a defect (the api voices a pass).
- `score` 0-1 is your honest overall mark. `reason` is one Vietnamese sentence an operator can read. On a fail,
  `retranslate` lists the flagged chapter numbers.
- Pass the `attempt` the sample gave you. The api allows one retranslate; the second fail becomes one Cần bạn card.
- Audio is the api's (pro voice, its daily cap). A `deferred` answer is retried by `release_step`, never by you.
- One Vietnamese line per novel; never retry a refused call.
