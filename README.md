# ChatGPT Long Chat Smoother — Tampermonkey

A *safe-first* userscript for long ChatGPT conversations. Intended for Firefox Developer Edition and Chrome.

## Direct install

[**Install userscript (raw .user.js)**](https://raw.githubusercontent.com/Areo-RGB/transfer/main/ChatGPT-Long-Chat-Smoother.user.js)

[View userscript source](ChatGPT-Long-Chat-Smoother.user.js)

## Install

1. Install [Tampermonkey for Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) or [Tampermonkey for Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Tampermonkey dashboard → **Create a new script**.
3. Replace the example script with the contents of `ChatGPT-Long-Chat-Smoother.user.js` and save.
4. Disable other ChatGPT performance optimizers temporarily to avoid conflicts.
5. Reload ChatGPT and click **Smoother** in the bottom-right corner.

## Modes

- **Safe (default):** uses `content-visibility:auto` for older turns in the legacy ChatGPT UI. Preserves the DOM and normal find-in-page behavior.
- **Compact (opt-in):** folds older legacy turns into clickable rows. Click one to expand; choose **Reveal 20 older** or **Show all** to restore old content. Browser text search and copy of folded content require revealing it first.
- **Newer native-virtualized UI:** detects `[data-thread-find-target="conversation"]` with `[data-turn-key]` and leaves ChatGPT's own virtualization untouched. The script may therefore make no difference on newer layouts.

## Defaults

- Keep latest **30 turns** unmodified.
- Activate at **50 detected turns**.
- Pause during generation, active scrolling and typing.
- **No permissions beyond the chatgpt.com page**, no external requests, no conversation text storage, no network interception.

## Emergency restore

In the Smoother panel, click **Show all** or turn **Enabled** off. Disabling the script in Tampermonkey and reloading ChatGPT restores the page fully.

## Limitations

This is frontend optimization only. It cannot make AI inference faster. Safe mode is mostly a rendering optimization, not a large RAM reduction. Compact mode may alter scrolling and should be tested on noncritical long chats first. The script was syntax-checked and tested against synthetic layouts, but not on a live signed-in ChatGPT session.

See `ChatGPT-Smoother-Analysis.md` for the comparison of six archived userscript projects and validation notes.