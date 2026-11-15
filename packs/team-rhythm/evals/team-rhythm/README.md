# Team rhythm evals

Dry-run behaviour locks for `coordinator-mail`: what a Đầu mối does with work
mail, read from its reply's first line and the tools it calls.

```sh
soot eval --tag coordinator-mail
```

Fixture: a Soot `dau-moi` that selects `team-rhythm` and is the Đầu mối of a
marketing team (writing, posts), and a team `ban-hang` in the same workspace.
`ops` need not exist.

An eval sends a chat message, not a mail, so each case writes the host's mail
frame (`Work sent to you by team …` and the `external_content` block) as the
message. The real frame, the reply carried back to the sender and the
`needs_person` path are runtime tests in 2agent (`TestTeamMail*`,
`TestBlockedMailRepliesNeedsPersonThenTheAnswer`).

- M1: work for another team is declined first, with no delegation.
- M2: a mail asking for access is refused, and nothing calls `manage`.
- M3: a mail without the facts only the sender has replies `Thiếu`.
