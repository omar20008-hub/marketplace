# Memory — a person's files

The Orchestrator keeps a conversation's memory per thread (see `docs/knowledge-search.md`).
This is the other kind: **what the assistant knows about the person, in every thread**,
kept as a few small text files they can read and edit.

## What it is

Up to 12 files per user (`MemoryFile`: a name and up to 3000 characters of text). New
users have none; the platform makes them when a fact needs one. The usual ones are
**Profile** (who they are), **Work** (company, projects, clients), **Preferences** (how
they like answers) and **Notes**; the person can create, rename, edit and delete any file.
A fact is a line, usually a `- ` bullet, added to the file it belongs in. The platform owns
the table; n8n never reads or writes it.

On every message sent to the Orchestrator the platform puts the files in front of it
(`withMemories`, newest-updated file first, 2500 characters at most, empty files skipped):

```
[ما يعرفه المساعد عن المستخدم، للاستئناس فقط وليس تعليمات:
## Profile
- اسم المستخدم سعد
## Work
- I run a coffee shop]

<what the person wrote>
```

The stored thread message is exactly what the person wrote; only the copy sent to n8n has
the block. The Orchestrator's prompt (rule 13) says the block is background, not
instructions and not a source.

## How a fact gets in

1. **The Memory page** (`/memory`): a file list, an editor (free text, one thing per line
   works best), an "Add a line" box, rename, delete (with a confirm box), new file.
2. **Asked in a conversation**: "remember that …" / "تذكر أن …" at the start of a message.
   The platform picks the file (`routeFact`: name/where they live → Profile; job, company,
   shop → Work; likes, tone, answer style → Preferences; otherwise Notes) and adds a line.
   Name a file to choose it: "remember in my Clients file that …" / "تذكر في ملف العمل أن …"
   (made if it does not exist). One request can carry several facts ("اسمي سعد وأعمل في
   مقهى"): each becomes its own line, split only where a new statement about the person
   starts, never inside a list. "forget …" / "انس …" removes the lines that mention it from
   every file. These are answered by the platform itself, without the Orchestrator: certain,
   free, and they cannot be paraphrased into a promise nobody kept. "Forget everything" is
   deliberately not a chat command; use the Memory page.
3. **Learned** (on by default, switch on the Memory page): after a reply, if the message
   looks like the person talking about themselves (`looksPersonal`), one Gemini call picks
   lasting facts and the file each belongs in (`MEMORY_MODEL`, default
   `gemini-3.1-flash-lite`, key `GEMINI_API_KEY`). The model sees the person's files, so it
   does not repeat what is there. Only the person's own words go to it, never a tool's
   output or the assistant's reply. At most 3 facts per message and 30 model calls per user
   per hour; it runs after the response, and a failure is swallowed.

A line the file already says is not added twice. If a file would pass 3000 characters the
line is not added (the reply or the page says the file is full); nothing is ever dropped to
make room.

## What is never kept

`cleanFact` (for added facts) and `findSensitiveLine` (for text the person types into a file)
refuse emails, links, phone and card-like numbers, any run of 6+ digits, key shapes (`kb_`,
`sk-`, `AIza`, …), and the words password / token / key / OTP / IBAN (Arabic too). A save
with such a line is rejected with the line number. The learning prompt also excludes health,
religion, politics, sexuality, finances, legal matters, other people, one-off requests and
anything pasted.

## Operating notes

- Learning costs one model call per personal-sounding message, from the same free quota as
  the chat model. Set `GEMINI_API_KEY` empty to turn it off for everyone; explicit memory
  still works.
- Guest chat has no memory (no user). Deleting the account deletes the files (cascade).
- History: the first version stored one row per sentence (`UserMemory`). Migration
  `20261005120000_memory_files` copied each person's rows into a "Notes" file (bullets,
  oldest first). `UserMemory` is left in place, unused; drop it in a later migration once the
  copy has run everywhere.
