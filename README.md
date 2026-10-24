# ChatGPT Long Chat Smoother v1.1.0 — Tampermonkey

A privacy-conscious userscript for reducing **browser-side** lag in long ChatGPT conversations. Designed for Firefox Developer Edition and Chrome. It does **not** speed up OpenAI's servers.

## Install

1. Install [Tampermonkey for Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) or [Tampermonkey for Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open the **[direct userscript link](https://raw.githubusercontent.com/Areo-RGB/transfer/main/ChatGPT-Long-Chat-Smoother.user.js)**. Tampermonkey should offer to install it. If not, open **Tampermonkey → Create a new script**, paste the code, and save.
3. Disable any other ChatGPT DOM/performance optimizers temporarily while testing.
4. Reload ChatGPT and click **Smoother** (bottom right) to configure it.

## What v1.1 adds

- **Time-budgeted work**: no more than 24 DOM operations per chunk, targeting a 6 ms JavaScript budget; exceptions are rolled back to the original page. DOM discovery and emergency rollback still have synchronous costs; the budget is a target, not a hard browser guarantee.
- **Background-tab suspension**: stops queued work, disconnects the root observer, and pauses dashboard diagnostics when the tab is hidden; restarts after returning.
- **Performance dashboard**: per-scan timing, total active JavaScript time, last/peak chunk duration, budget overruns, two-frame interval sample, and page-wide Long Tasks where supported (primarily Chromium). The frame interval is **not** exact paint latency, and Long Tasks cannot be attributed to this script alone.
- **Large-reply hints**: optional `content-visibility:auto` for lengthy `pre`, `table`, and Markdown paragraph/blockquote elements on the *legacy* layout. The feature uses text **lengths**, never stores conversation text. It skips the last two turns, selections, focused content, and streaming.
- **Scroll anchoring**: preserves the visible on-screen turn or distance from the bottom between compact-mode batches, including **Show all** and clicking an older folded turn. User scrolling takes precedence over scripted restoration.

## Modes

- **Safe (default)** — uses `content-visibility:auto` on older turns in the legacy interface. Leaves the content DOM intact and usually preserves in-page search. This is a rendering optimization, **not** strong memory reclamation.
- **Compact (opt-in)** — hides old turns using CSS only. Click any folded row, **Reveal 20 older**, or **Show all** to restore content. Searching/copying hidden text requires revealing it first. Use only if Safe is insufficient.
- **Newer native-virtualized interface** — leaves ChatGPT's own virtualization untouched, including large-block hints. This means **no performance gain** on many newer ChatGPT layouts, by design.

## Settings and privacy

Defaults: enabled, Safe mode, keep 30 newest turns unmodified, whole-turn optimization threshold of 50 turns, large-block hints on for legacy layout, reduced animation off. Large-block hints may apply even in shorter chats containing a very large reply.

- No external requests, credential access, API interception, React/Fiber access, or storage of conversation content.
- `localStorage` stores only preference toggles and numbers.
- Work pauses during generation, typing, and recent scrolling. Hidden tabs are suspended.
- The dashboard records page-local aggregate timings only; no telemetry leaves the browser.

## Compatibility and limitations

- Tested with Node syntax checking and isolated simulated DOM cases (Safe/Compact/modern/streaming/hidden/reveal/disable/large blocks/failure recovery). **Not tested in a live signed-in ChatGPT browser session.**
- The selectors for ChatGPT's page structure are undocumented and may change.
- `content-visibility` can sometimes affect in-page find, accessibility, layout, and scrolling; disable **Optimize large reply blocks** if you notice artifacts.
- The newer ChatGPT interface may already optimize large conversations better than these legacy techniques.

## Recover original page

Click **Smoother → Show all**, or turn **Enabled** off. If ChatGPT behaves strangely, disable the userscript in Tampermonkey and reload the tab.

See [ChatGPT-Smoother-Analysis.md](ChatGPT-Smoother-Analysis.md) for the original comparative analysis. Source license: MIT.