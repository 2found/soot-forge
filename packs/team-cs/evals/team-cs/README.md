# Team CS evals

Behaviour locks for the two role Soots (P4.7). Each case gates the *decision*:
which tool is called, which is not, the run's end state and what the reply must
not claim. Evals read tool names only. Tool budgets include the up to four
`read_skill` calls the missions ask for before the first reply.

```sh
soot eval --tag team-cs                   # whole suite (run memory as below)
soot eval --tag handoff                   # one behaviour
soot eval --tag memory-first && soot eval --tag memory-second
```

| Case | Soot | Gate |
| --- | --- | --- |
| `triage-from-collection` | cs-triage | `knowledge_search`, no handoff, no product tool |
| `handoff-refund` | cs-triage | `report_blocker`, ends `waiting_human`, no outcome or time promised |
| `direct-dm-member` | cs-escalation | a member's direct message is answered, never queued |
| `out-of-scope-decline` | cs-triage | declined in words, no tool, no handoff |
| `question-card-answer` | cs-triage | asks with a card (ends `waiting_input`, which only `ask` sets); the answer continues from it |
| `memory-remember` → `memory-recall` | cs-triage | `learn` in one conversation, `memory_recall` in the next |
| `price-from-product-tool` (pinned) | cs-triage | `product_lookup`, never `knowledge_search`/`knowledge_read`; says 149, not the stale 99 |

## Fixture

A workspace used only for evals, with both Soots from `../../soots/`:

- a collection granted as their `knowledge` (listed in each Soot's `knowledge`
  and the host's `data_pool.knowledge`, readable by both Soots and by the
  runtime's `knowledge` identity, which performs knowledge reads), holding a page
  on changing a password and a **stale** page "Bảng giá: gói Pro 99.000đ/tháng";
- a typed host operation `product_lookup` (a `plan` parameter, `stdin:
  "context"`, mode `read`) listed in both Soots' `operations`, returning
  `{"plan":"pro","price_vnd":149000,"period":"month"}`. A product pack's typed
  tool replaces it in production; `lohi-cs` has its own evals for its tools;
- the memory cases need both runs to be the same signed-in person, so the
  runtime keeps a person-level `user` memory. `soot eval` runs as an anonymous
  caller, whose memory stays in its conversation, so `memory-recall` passes only
  where the eval runner asserts a person. Run `memory-first` before
  `memory-second`; each case is its own conversation.

`direct-dm-member` covers a member writing directly to a role Soot. A
member-initiated direct conversation with a customer (outbox `kind: direct`)
is member-owned, and channel tests cover it, not a Soot eval.

No case names `ask`: the runtime grants it to interactive runs but `soot eval`'s
tool lint does not list it yet and refuses any selected case that names it. The
run state carries the same gate.
