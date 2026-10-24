# ChatGPT Long Chat Smoother — v1.1.0 changelog

## Added

1. **Time-budgeted processing** — up to 24 operations per chunk, targeting 6 ms; idle scheduling with browser fallback; cancels stale work when the route or settings change.
2. **Background suspension** — pauses queued work, root DOM observer and Long Task observer when hidden; resumes after becoming visible.
3. **Dashboard metrics** — completed scans, last/average total scan time, aggregate work time, last/peak chunk time, over-budget count, two-frame interval, and page-wide Long Tasks when the browser exposes them. No data leaves the page.
4. **Large-message optimization** — opt-in toggle enabled by default only for the older ChatGPT layout. Targets long code blocks, tables, paragraphs, blockquotes; leaves the newest two turns and active selections untouched.
5. **Scroll stabilization** — visible-turn anchoring or bottom-distance preservation per compact batch, and for manual reveal/show all, while giving priority to manual scrolling.

## Preserved

- Modern/native-virtualized interface bypass.
- Streaming/typing/scroll interaction pause.
- No fetch interception, React internals, DOM element removal, message caching, or external telemetry.
- CSS-only compact folds and immediate disable/restore.

## Validation

- `node --check` passed.
- Synthetic Node VM tests passed for Safe/Compact/Show all/Reveal 20/large blocks/stream pause/resume/background pause/resume/native bypass/chunk limits/failed-DOM rollback.
- No live ChatGPT browser/production performance benchmark has been run.

## Caveats

Performance measurements are local heuristics. The chunk time target is not a hard bound; a single DOM query can exceed it. Browser Long Tasks are page-wide, not script-specific. ChatGPT can change selectors at any time.