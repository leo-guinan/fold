# The Week

A weekly edition of Future Radio that reads last week back and puts the week ahead on the record. It is a show for fold's live stage ([LIVE.md](LIVE.md)) and its first one with a plan.

Three roles, played by the Future Radio cast:

- **Borges remembers.** What happened, from the receipts.
- **Leonardo creates.** What was made, and what is promised next.
- **Agnolo keeps score.** The numbers, the trends, what failed, and whether last week's promises were kept.

## An edition is a plan

`demos/week/episodes/<monday>.json` is one edition. It holds:

- **Sources**: what the newsletter, the channel and the archive each gave this week, or why one gave nothing. A missing source is shown on screen in the opening, not skipped.
- **Receipts**: the exact words, with date, link and a SHA-256 over `kind|date|url|quote`. This is the Community Archive's Receipt Cuts format, so a post's hash here is the hash the archive gives for it.
- **Segments** of lines: opening, what happened, what was made, the count, what is growing, what failed, last week's promises, the week ahead, close. A line names who says it, what it rests on (`cite`), and what goes on the board (a receipt, a chart, a row of numbers, the ledger).
- **Promises** made in the week-ahead segment, each citing the words it was made in. The next edition lists them under `carried`, and Agnolo has to rule on every one: kept, missed, or open.

The plan is laid out in time by `planBeats`, a pure function, so the same plan is the same events whether a control room stages it live or the page lays it out as a finished scene for export.

## What the show refuses

Two layers, the same rules.

`node tools/week.mjs check <plan>` runs before anything airs. It fails the plan if a line cites a receipt that isn't filed, a receipt's words don't match its hash, a line in a factual segment has nothing behind it, a promise has no words behind it, a carried promise gets no verdict, or anyone but Agnolo gives one.

The world enforces the same on air. A `SAY` that cites a receipt nobody filed is refused with "no receipt on file for that", and the refusal is drawn on the page. So a plan that slipped past the check still can't put an unbacked claim on screen.

Trend lines are the exception worth knowing: a chart counts as backing. The numbers in a chart come from archive queries (phrase counts per week), not from a hashed receipt, and the chart's note says where they came from.

## Making an edition

```sh
# 1. gather the week's receipts (run where the feeds are reachable)
node tools/week.mjs gather --from 2026-11-09 --to 2026-11-16 \
     --newsletter https://hitchhikertothefuture.substack.com/feed \
     --youtube <channel id> --posts posts.json --handle @leo_guinan --out week.json

# 2. write the plan: demos/week/episodes/2026-11-09.json
#    receipts from week.json, lines that cite them, last edition's promises under "carried"

# 3. check it
node tools/week.mjs check demos/week/episodes/2026-11-09.json

# 4. air it in the live stream (it starts a second later)
node tools/room.mjs demos/week/dist/show.mjs --journal out/week.ndjson
node tools/week.mjs air demos/week/episodes/2026-11-09.json

# 5. export it: the full edition, and each segment as a vertical short
node tools/week.mjs cuts demos/week/episodes/2026-11-09.json      # prints the commands
```

Step 2 is the one that needs judgment: which posts mattered, what is a trend and what is noise, what counts as a failure, which statements about the future are promises and which are only thinking aloud. Everything around it is mechanical and checked. `posts.json` is the week's posts from the Community Archive in its own record format (`id`, `url`, `user`, `created_at`, `text`, `likes`, `retweets`, and `reply_to` / `quoted_id` / `retweet_of` where they apply).

To look at an edition without a control room: `node tools/serve.mjs`, then open `demos/week/index.html?plan=episodes/2026-11-02.json`. Add `&layout=9x16` for the tall cut, `&only=trend` for one segment.

## Edition 1

`episodes/2026-11-02.json` covers November 2 to 8, 2026, from 221 archive posts by @leo_guinan. It runs 5:08, files 20 receipts, and leaves three promises open for edition 2. Two of its three sources came up short, and it says so on screen: the channel is represented only by the five episode links found in posts, and no newsletter issue could be read.

## Not done yet

- **Voices.** Each character speaks as a tone that opens and closes on the syllables of the line, with the words on screen. Real speech needs one audio file per line and its loudness envelope, made before the edition is staged.
- **The channel and the newsletter.** `gather` reads both feeds, and its parsers are tested against sample feeds, but it has not been run against the real ones.
- **The look.** `ledgerPage` is a stand-in drawn for this show. The studio's pencil-and-ink style can draw the same log.
- **Between editions** the live page shows a holding card. In a stream that never ends, this show needs company.
