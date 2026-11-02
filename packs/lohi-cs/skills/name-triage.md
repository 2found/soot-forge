# Name triage — a character's name looks wrong

Read this skill when a reader says a character is called the wrong thing:
"main tên A Ngốc chứ không phải A Sốt", "tên nhân vật bị dịch lệch", "chương
này gọi khác chương trước". Reply in the customer's language.

You never rename anything. A name ruling belongs to a person: the Book Bible
(canon) lives with the translators, and the same word can be a person, an item,
a place or an alias. Your job is to collect evidence and open a review case.

## Flow

1. **Get the facts from the reader** — the novel (title or link), the spelling
   they see (WRONG), the spelling they expect (RIGHT) and roughly which chapters.
   If the wrong spelling is missing, ask once; it must be exactly as shown in the
   chapter, with accents.
2. **Find the novel**: `lohi_lookup {"kind":"find_novel","q":"…"}` (same rules as
   `chapter-triage`: several matches → ask, none → ask for the link).
3. **Check**: `lohi_lookup {"kind":"name_check","novelId":"…","name":"<wrong>","other":"<right>","from":N,"to":M}`
   — window at most 60 chapters around the complaint (the reader's chapter −5 …
   +40 is a good default). You get, per spelling, `chaptersWithName`,
   `occurrences` and a few chapter numbers, plus `bibleSays`:
   - `supports_reader` — the Book Bible knows the RIGHT spelling, not the wrong one.
   - `supports_current_text` — the Bible knows the wrong one; the reader may be
     seeing an alias or a different character.
   - `both` / `silent` — no clear answer.
   It is a hint for the team, not a verdict. Never quote chapter text.
4. **Decide**
   - Wrong spelling occurs (`chaptersWithName` > 0): call
     `lohi-cs_lohi_report_content_issue`
     `{"novelId":"…","kind":"name","from":N,"to":M,"wrongName":"…","rightName":"…","note":"<reader's words, one line>","reportId":"<new uuid>"}`.
     Tell the reader which chapters use that spelling and that a team member will
     review the name; never say it will be changed or when.
   - It does not occur in that window: say you could not find it there, ask for
     the chapter number or a screenshot-style quote, and widen once. If still
     nothing, hand off.
5. `no_defect_found` from the report means the server also found nothing — do
   not retry with a different spelling you invented.

## Never

- Never promise a rename, a global replace or a timeline.
- Never open a name case for a reader's taste ("I prefer the Hán-Việt name").
  Only a mismatch between chapters, or against the Bible, is reportable.
- `too_many_pending`: three cases are already waiting → hand off.
