# ChatGPT Long Chat Smoother — Analysis and Design

**Input:** `Archive.zip` supplied by the user, including userscripts and packaged Firefox/Chrome extensions.  
**Output:** [`ChatGPT-Long-Chat-Smoother.user.js`](ChatGPT-Long-Chat-Smoother.user.js) (version 1.0.0)  
**Goal:** improve *browser-side* responsiveness in long ChatGPT chats without breaking the conversation or rewriting ChatGPT responses.

## Source script comparison

| Userscript from archive | Useful idea | Risk/limitation | Decision |
| --- | --- | --- | --- |
| **ChatGPT Long Chat Booster** | `content-visibility`, idle scheduling, compacting old content | Broad global CSS rules can alter tables, media, and UI; optional collapsing changes scrolling | Adapt idea of native browser rendering hints; target only detected turn containers |
| **ChatGPT Conversation Pruner** | Stream-aware batching, reveal-on-scroll, route awareness, scroll preservation | Physically detaches/removes React-owned elements; caches detached DOM; structural assumptions | Adapt route/scroll safeguards, **do not detach** nodes |
| **ChatGPT Lazy Chat++** | Hard pause while streaming, configurable recent window, incremental reveal | Hide/detach modes and token calculations add complexity; GPL-3.0 licensing | Use independent implementations of pause/reveal concepts; **no source copied** |
| **ChatGPT Long Conversation DOM Optimizer** | Detect newer native virtualization; keep modern and legacy strategies separate; fail safely | UI contract can change; auto-clicking reasoning controls is version-sensitive | Include modern-layout detection and fail-open behavior; **do not auto-click controls** |
| **ChatGPT Browser Memory Reducer** | Reversible previews, local restore, compact older content | Copies live HTML into IndexedDB, mutates `innerHTML`, and introduces persistence/privacy and stale-snapshot concerns | Use CSS-only reversible collapse; **never snapshot conversation HTML** |
| **ChatGPT Show Last N Messages** | Small last-N configuration, aggressive load reduction | Overrides `window.fetch`, patches response decoding, changes conversation tree, and deletes DOM nodes | **Reject** network response modification and removal |

### Archive quality note

- The six GitHub project directories contain real `// ==UserScript==` scripts.
- The standalone copies of Long Chat Booster and Web Optimizer are **HTML challenge pages** misnamed `.user.js`, so they are not executable userscripts. They were excluded.
- Other standalone entries duplicate the GitHub sources and were not double-counted.
- The archive also includes Chrome/Firefox extension packages; those are browser extensions, not installable Tampermonkey source scripts.

## Features built

1. **Safe mode (default):** use CSS `content-visibility: auto` with `contain-intrinsic-size: auto 420px` on older turns of the **legacy** interface. Old DOM nodes remain in place, and ordinary find-in-page and accessibility can continue to see the content.
2. **Compact mode (opt-in):** hide the *children* of older legacy conversation turns using CSS, leaving clickable labeled rows. Click an older row to reveal it. This is deliberately stronger and can interfere with searching hidden content, so it is not the default.
3. **Modern ChatGPT detection:** if `[data-thread-find-target="conversation"]` and `[data-turn-key]` are present, recognize native virtualization and make no DOM changes to conversation turns.
4. **Stream and interaction safety:** pause scans during generation and avoid work immediately after typing or scrolling; protect focused or selected turns.
5. **Efficient scheduling:** only observe child-list changes in the conversation root, coalesce scans, use idle time when available, and detect SPA navigation with a low-frequency route check rather than patching `history`.
6. **Reversibility:** `Reveal 20 older`, `Show all`, script enable/disable, and route-specific reset.
7. **Privacy and isolation:** no remote connections, no fetch interception, no persistent conversation HTML, no injected external libraries, and a Shadow DOM settings panel.

## Defaults

| Setting | Default |
| --- | --- |
| Enabled | Yes |
| Optimization mode | Safe |
| Recent turns kept unmodified | 30 |
| Start optimization at | 50 detected turns |
| Reduce animations | No |
| Compact mode on natively virtualized UI | Disabled by design |

## What it does **not** do

- It cannot speed up ChatGPT's server-side model inference or reduce token generation time.
- Safe mode **does not delete DOM nodes**, so it primarily reduces layout/rendering work, not JavaScript heap size.
- Compact mode hides content visually but still retains DOM nodes and associated JS memory.
- It deliberately avoids IndexedDB snapshots, network/API interception, automatic reasoning-panel clicks, and detached React-owned nodes.
- Modern ChatGPT's native virtualization may already solve the problem; in that layout the script reports a no-op instead of fighting it.
- React/ChatGPT's markup is subject to change; the legacy selectors may need updates.

## Validation performed

- **Syntax:** passed `node --check` for the generated `.user.js`.
- **Core logic (simulated DOM):** passed Node VM tests with 80 synthetic turns:
  - legacy + Safe mode: 50 older turns marked for native rendering optimization;
  - legacy + Compact mode: 50 older turns folded;
  - Compact mode + reveal 20: 30 remain folded;
  - Show all: every fold removed;
  - switching to Safe mode: 50 auto-marked;
  - disabling: marks removed;
  - native virtualization: zero turn modifications;
  - active streaming: zero initial turn modifications.
- **Browser integration:** not validated against a live signed-in ChatGPT page. A local headless Chromium test could not complete in this environment (even a simple empty-page test hung). Run a real-browser smoke test before relying on compact mode with important conversations.

## Installation

1. Install [Tampermonkey for Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) or [Tampermonkey for Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open the **Dashboard**, choose **Create a new script**, replace the sample with `ChatGPT-Long-Chat-Smoother.user.js`, and save (Ctrl+S).
3. Disable other long-chat DOM optimizers while evaluating this one.
4. Reload `https://chatgpt.com/`, open a long conversation, and click the bottom-right **Smoother** button.
5. Leave **Safe** mode enabled initially. Try **Compact** only when you understand the tradeoffs.
6. To restore the original rendering immediately, choose **Show all** or uncheck **Enabled**. If something looks wrong, disable the userscript and reload ChatGPT.

## How to measure improvement

1. Pick the **same long conversation** and test without other optimization extensions/scripts.
2. In Firefox Developer Edition, record a trace using [Firefox Profiler](https://profiler.firefox.com/).
3. Compare scrolling and typing responsiveness with the userscript disabled vs Safe vs Compact; note CPU, memory, and long main-thread tasks.
4. Test find-in-page, code blocks, tables, attachments, long reasoning sections, copy/export, and turning generation on/off.
5. Repeat after a ChatGPT interface update because layout assumptions can change.

## Why this approach

MDN documents that `content-visibility: auto` can skip offscreen rendering while retaining content in the DOM and accessibility tree. `content-visibility: hidden` and `display: none` offer stronger skipping but hide content from find-in-page and accessibility until restored. This makes safe/native rendering hints the better default for an intervention in a third-party React application.

- [MDN: content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)
- [MDN: contain-intrinsic-size](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain-intrinsic-size)
- [Tampermonkey official documentation](https://www.tampermonkey.net/documentation.php)

## Licensing

This userscript is a new implementation based on broadly applicable techniques and comparisons of the supplied works; it does not include copied GPL or proprietary source. The produced script declares the MIT license. The original projects retain their own licenses and credits.