# Phase 6d-3 result: TestForge, Translate, print

Closes slice 6d. After this only the human gate G6 and Phase 7 (cutover) remain.

## Built
- `lib/client/ai-tools.ts`: TestForge request building and validation (field, content, image count), `generate` (calls the existing `/api/testforge/generate`), `saveStaged` (all-or-nothing, rows without a code so the server numbers them, `<` and `>` neutralised in AI text, rollback that is not stopped by the write block), and `translateFile` (direction chosen per test case from its own text, every translation computed before anything is written, so a translation failure changes nothing; a write failure part-way restores the rows already written, not stopped by the write block, and reports any it could not restore). MyMemory answers are checked: `responseStatus` other than 200 and its quota/length error strings throw, and text over 450 chars is split on line breaks and sentences).
- `components/testforge-panel.tsx`: field pick, BRS / screenshot / free text, review and edit staged rows, save all. `components/testcase-screen.tsx`: "Generate AI" and "Translate file" buttons, both disabled offline.
- `app/print.css`: printing a page prints its content only (no header, nav, buttons, filters).

## Evidence
- `bun test`: 337 pass (13 new in `test/ai-tools.test.ts`); `tsc` clean; `next build` passes.
- `scripts/g6d3-e2e.cjs` (headless Chrome 155): the real route's disabled message shown in the panel; a stubbed draft reviewed, edited, one row removed, the rest saved and coded by the server; markup stored escaped; Translate confirm names MyMemory, both directions applied; an API failure changes nothing and shows the error; both buttons disabled offline; print media hides header, nav and buttons and keeps the table.

## Not done or not checked
- No real Gemini call and no real MyMemory call: the e2e stubs both. The real TestForge route needs `TESTFORGE_ENABLED=1` and a key on the server.
- AI text with `<` or `>` ends up double-escaped (shown as `&lt;`), the same as the legacy page. Safe, slightly ugly.
- Translate sends test case text to the public MyMemory service (legacy behaviour). A server-side proxy or an internal translator is a decision for the owner; it is not made here.
- The legacy single-bug print layout is not ported; print is the page, stripped of chrome. Not checked on a real printer or in PDF output.
- Chrome only.
