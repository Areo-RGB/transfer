// ==UserScript==
// @name         ChatGPT Long Chat Smoother (Best-of, Safe First)
// @namespace    local.chatgpt.long-chat-smoother
// @version      1.0.0
// @description  Safer long-chat rendering hints; optional reversible compact mode for legacy ChatGPT conversations.
// @author       Community best-of implementation
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/*
 * Design goals:
 * - Keep ChatGPT's React DOM and network responses intact. No fetch patches,
 *   removal, detaching, innerHTML rewriting, or conversation-content storage.
 * - Leave ChatGPT's newer, natively virtualized conversation layout alone.
 * - On the older layout, prefer content-visibility:auto (Safe mode).
 * - Optional Compact mode hides old turns by CSS ONLY; every turn is restorable.
 * - Skip updates while streaming, typing, selecting text, or actively scrolling.
 * - Never send data anywhere. localStorage contains settings only.
 */
(() => {
  'use strict';

  const TAG = 'cgpt-smoother-v1';
  const KEY = 'cgpt-long-chat-smoother-settings-v1';
  const CSS_ID = `${TAG}-style`;
  const TURN_HINT = '[data-turn-key], [data-turn-id-container], section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"]';
  const STOP_HINT = '[data-testid="stop-button"], [data-testid="composer-stop-button"], [data-is-streaming="true"], [data-streaming="true"]';
  const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'safe',
    keepRecent: 30,
    minimumTurns: 50,
    reduceMotion: false,
    panelOpen: false
  });
  const clamp = (v, min, max, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        mode: parsed.mode === 'compact' ? 'compact' : 'safe',
        keepRecent: clamp(parsed.keepRecent, 10, 200, DEFAULTS.keepRecent),
        minimumTurns: clamp(parsed.minimumTurns, 20, 500, DEFAULTS.minimumTurns),
        reduceMotion: Boolean(parsed.reduceMotion),
        panelOpen: Boolean(parsed.panelOpen)
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  const settings = load();
  const managed = new Set();
  let independentlyOpened = new WeakSet();
  let showAllUntilRouteChange = false;
  let extraRecent = 0;
  let route = location.pathname + location.search;
  let currentRoot = null;
  let currentLayout = 'none';
  let rootObserver = null;
  let scanTimer = 0;
  let idleTask = 0;
  let scanning = false;
  let lastScroll = -Infinity;
  let lastTyping = -Infinity;
  let wasStreaming = false;
  let latestCount = 0;
  let foldedCount = 0;
  let lastScanMs = 0;
  let lastState = 'Waiting for a conversation';
  let host = null;
  let shadow = null;
  let ui = null;
  const supportsCV = Boolean(window.CSS?.supports?.('content-visibility', 'auto') &&
    window.CSS?.supports?.('contain-intrinsic-size', 'auto 420px'));

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* Storage may be blocked */ }
  }

  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = `
      .${TAG}-auto {
        content-visibility: auto !important;
        contain-intrinsic-size: auto 420px !important;
      }
      .${TAG}-folded {
        box-sizing: border-box !important;
        max-height: 38px !important;
        min-height: 38px !important;
        overflow: hidden !important;
        border: 1px dashed rgba(140,140,150,.5) !important;
        border-radius: 7px !important;
        margin-block: 3px !important;
        padding: 0 9px !important;
        cursor: pointer !important;
      }
      .${TAG}-folded > * { display: none !important; }
      .${TAG}-folded::before {
        content: attr(data-cgpt-smoother-label);
        display: block !important;
        font: 12px/36px system-ui, sans-serif !important;
        color: var(--token-text-secondary, #888) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      main.${TAG}-less-motion *, main.${TAG}-less-motion *::before,
      main.${TAG}-less-motion *::after {
        animation-duration: .001ms !important;
        transition-duration: .001ms !important;
      }
      @media print {
        .${TAG}-auto { content-visibility: visible !important; contain-intrinsic-size: none !important; }
        .${TAG}-folded { max-height: none !important; overflow: visible !important; }
        .${TAG}-folded > * { display: revert !important; }
        .${TAG}-folded::before { display: none !important; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function cleanupMarks() {
    for (const node of managed) {
      node.classList.remove(`${TAG}-auto`, `${TAG}-folded`);
      node.removeAttribute('data-cgpt-smoother-label');
    }
    managed.clear();
    document.querySelectorAll(`main.${TAG}-less-motion`).forEach(n => n.classList.remove(`${TAG}-less-motion`));
    foldedCount = 0;
  }

  function resetOnRouteChange(nextRoute) {
    cleanupMarks();
    route = nextRoute;
    extraRecent = 0;
    independentlyOpened = new WeakSet();
    showAllUntilRouteChange = false;
    currentRoot = null;
    if (rootObserver) { rootObserver.disconnect(); rootObserver = null; }
  }

  function outermost(elements) {
    const set = new Set(elements);
    return elements.filter(el => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (set.has(parent)) return false;
      }
      return true;
    });
  }

  function discover() {
    const modern = document.querySelector('[data-thread-find-target="conversation"]');
    if (modern && modern.querySelector('[data-turn-key]')) {
      return { root: modern, layout: 'native', turns: outermost([...modern.querySelectorAll('[data-turn-key]')]) };
    }
    const root = document.querySelector('#thread') || document.querySelector('main') || document.querySelector('[role="main"]');
    if (!root) return { root: null, layout: 'none', turns: [] };
    const containers = root.querySelectorAll('[data-turn-id-container]:not([data-turn-id-container="client-created-root"])');
    if (containers.length) return { root, layout: 'legacy', turns: outermost([...containers]) };
    const sections = root.querySelectorAll('section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"]');
    if (sections.length) return { root, layout: 'legacy', turns: outermost([...sections]) };
    return { root, layout: 'none', turns: [] };
  }

  function isStreaming() { return Boolean(document.querySelector(STOP_HINT)); }
  function selectedIn(node) {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) return false;
    return Boolean((selection.anchorNode && node.contains(selection.anchorNode)) ||
                   (selection.focusNode && node.contains(selection.focusNode)));
  }
  function protectedTurn(node) {
    return (document.activeElement && node.contains(document.activeElement)) || selectedIn(node);
  }
  function getScroller(first) {
    for (let e = first?.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight + 12) return e;
    }
    return document.scrollingElement || document.documentElement;
  }
  function nearBottom(scroller) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 900;
  }

  function applyMotion() {
    document.querySelectorAll(`main.${TAG}-less-motion`).forEach(n => n.classList.remove(`${TAG}-less-motion`));
    if (settings.enabled && settings.reduceMotion) document.querySelector('main')?.classList.add(`${TAG}-less-motion`);
  }

  function bindRootObserver(nextRoot) {
    if (currentRoot === nextRoot && rootObserver) return;
    if (rootObserver) rootObserver.disconnect();
    currentRoot = nextRoot;
    if (!currentRoot) return;
    rootObserver = new MutationObserver(records => {
      // Token-by-token streaming creates many mutations. Ignore them unless
      // actual turn wrappers have been added or removed.
      for (const r of records) {
        if (r.type !== 'childList') continue;
        for (const node of [...r.addedNodes, ...r.removedNodes]) {
          if (node.nodeType !== 1) continue;
          if (node.matches(TURN_HINT) || node.querySelector(TURN_HINT)) {
            queueScan(450);
            return;
          }
        }
      }
    });
    rootObserver.observe(currentRoot, { childList: true, subtree: true });
  }

  function queueScan(delay = 400) {
    clearTimeout(scanTimer);
    if (idleTask && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleTask);
      idleTask = 0;
    }
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if ('requestIdleCallback' in window) {
        idleTask = window.requestIdleCallback(() => { idleTask = 0; scan(); }, { timeout: 1200 });
      } else {
        scan();
      }
    }, delay);
  }

  function mark(node, mode, label) {
    const auto = `${TAG}-auto`;
    const folded = `${TAG}-folded`;
    if (mode === 'fold') {
      node.classList.remove(auto);
      node.classList.add(folded);
      node.setAttribute('data-cgpt-smoother-label', label);
    } else if (mode === 'auto') {
      node.classList.remove(folded);
      node.removeAttribute('data-cgpt-smoother-label');
      node.classList.add(auto);
    } else {
      node.classList.remove(auto, folded);
      node.removeAttribute('data-cgpt-smoother-label');
    }
    if (mode !== 'none') managed.add(node);
    else managed.delete(node);
  }

  function scan() {
    if (scanning) return;
    scanning = true;
    const t0 = performance.now();
    try {
      const nextRoute = location.pathname + location.search;
      if (nextRoute !== route) resetOnRouteChange(nextRoute);
      const { root, layout, turns } = discover();
      bindRootObserver(root);
      currentLayout = layout;
      latestCount = turns.length;
      if (!settings.enabled) {
        cleanupMarks();
        lastState = 'Disabled — original ChatGPT view';
        return;
      }
      if (!turns.length) {
        cleanupMarks();
        lastState = 'Waiting for a conversation';
        return;
      }
      if (layout === 'native') {
        cleanupMarks();
        lastState = 'Native ChatGPT virtualization detected — left untouched';
        return;
      }
      if (isStreaming()) {
        lastState = 'Paused while ChatGPT is generating';
        return;
      }
      if (performance.now() - lastScroll < 250 || performance.now() - lastTyping < 300) {
        lastState = 'Paused during interaction';
        queueScan(500);
        return;
      }
      if (turns.length < settings.minimumTurns || showAllUntilRouteChange) {
        cleanupMarks();
        lastState = showAllUntilRouteChange ? 'Full conversation restored' : 'Below optimization threshold';
        return;
      }
      const scroller = getScroller(turns[turns.length - 1]);
      // Compacting while reading old history can make the page jump. Wait until
      // the reader comes back down. Safe mode does not hide anything.
      if (settings.mode === 'compact' && foldedCount === 0 && !nearBottom(scroller)) {
        lastState = 'Compact mode waits until near the bottom';
        return;
      }
      const keep = Math.min(turns.length, settings.keepRecent + extraRecent);
      const cutoff = turns.length - keep;
      const current = new Set(turns);
      const anchor = turns[cutoff] || turns[turns.length - 1];
      const anchorTop = anchor?.getBoundingClientRect().top;
      const atBottom = nearBottom(scroller);
      const bottomDistance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      let folded = 0;
      for (let i = 0; i < turns.length; i++) {
        const node = turns[i];
        const keepVisible = i >= cutoff || protectedTurn(node) || independentlyOpened.has(node);
        const desired = keepVisible ? 'none' :
          (settings.mode === 'compact' ? 'fold' : (supportsCV ? 'auto' : 'none'));
        const already = desired === 'fold' ? node.classList.contains(`${TAG}-folded`) :
          desired === 'auto' ? node.classList.contains(`${TAG}-auto`) :
          (!node.classList.contains(`${TAG}-auto`) && !node.classList.contains(`${TAG}-folded`));
        if (!already) mark(node, desired, `Older turn ${i + 1} — click to expand`);
        if (desired === 'fold') folded++;
      }
      for (const node of [...managed]) {
        if (!node.isConnected || !current.has(node)) mark(node, 'none');
      }
      foldedCount = folded;
      // Preserve scroll only after the browser has applied layout changes.
      if (settings.mode === 'compact' && folded && scroller.isConnected) {
        requestAnimationFrame(() => {
          if (!anchor?.isConnected || isStreaming()) return;
          if (atBottom) {
            scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - bottomDistance);
          } else if (Number.isFinite(anchorTop)) {
            scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
          }
        });
      }
      lastState = settings.mode === 'compact' ? `Compact: ${folded} older turns folded` :
        supportsCV ? `Safe: ${cutoff} older turns optimized` : 'content-visibility unsupported';
    } catch (error) {
      // Fail open. Never leave the conversation partially transformed on error.
      cleanupMarks();
      lastState = `Safety fallback (${error?.message || 'DOM changed'})`;
      console.warn('[ChatGPT Smoother] Restored original page after error', error);
    } finally {
      scanning = false;
      lastScanMs = Math.round((performance.now() - t0) * 10) / 10;
      applyMotion();
      render();
    }
  }

  function revealOlder(step = 20) {
    showAllUntilRouteChange = false;
    extraRecent = Math.min(100000, extraRecent + step);
    queueScan(0);
  }
  function restoreAll() {
    showAllUntilRouteChange = true;
    cleanupMarks();
    lastState = 'Full conversation restored for this conversation';
    render();
  }
  function changeSetting(name, value) {
    if (name === 'keepRecent') value = clamp(value, 10, 200, DEFAULTS.keepRecent);
    if (name === 'minimumTurns') value = clamp(value, 20, 500, DEFAULTS.minimumTurns);
    if (name === 'mode') value = value === 'compact' ? 'compact' : 'safe';
    settings[name] = value;
    extraRecent = 0;
    showAllUntilRouteChange = false;
    save();
    if (!settings.enabled) cleanupMarks();
    queueScan(0);
    render();
  }

  function makeUI() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = `${TAG}-host`;
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483646;pointer-events:none';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      button, input, select { font: inherit; }
      .launcher { pointer-events:auto; float:right; border:1px solid #64748b; border-radius:25px;
        padding:8px 12px; cursor:pointer; background:#1f2937; color:#fff;
        box-shadow:0 3px 12px #0004; font:600 12px system-ui; }
      .panel { clear:both; pointer-events:auto; width:min(322px, calc(100vw - 24px));
        max-height:min(620px, calc(100vh - 84px)); overflow:auto; margin-bottom:10px;
        padding:14px; color:#e5e7eb; background:#1b2430; border:1px solid #475569;
        border-radius:12px; box-shadow:0 8px 28px #0008; font:13px/1.45 system-ui; }
      .head { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      .head strong { font-size:15px; }
      .close { border:0; color:#fff; background:transparent; cursor:pointer; font-size:18px; }
      .description { font-size:11px; color:#bbc8d8; margin:7px 0 10px; }
      .status { margin:10px 0; padding:8px; border-radius:6px; background:#334155; color:#eef2ff; }
      label { display:flex; justify-content:space-between; align-items:center; gap:8px; margin:9px 0; }
      input[type=number], select { width:112px; background:#111827; color:#fff; border:1px solid #64748b;
        border-radius:5px; padding:5px; }
      input[type=checkbox] { accent-color:#90b4fc; width:16px; height:16px; }
      .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
      .actions button { border:1px solid #64748b; padding:6px 9px; border-radius:6px;
        cursor:pointer; color:#fff; background:#374151; }
      button:focus-visible,input:focus-visible,select:focus-visible { outline:2px solid #93c5fd; outline-offset:2px; }
      .metrics { margin-top:10px; color:#bbc8d8; font-size:11px; }
      .warn { color:#fcd34d; font-size:11px; }
    `;
    shadow.appendChild(style);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="panel" id="settings-panel" hidden>
        <div class="head"><strong>ChatGPT Smoother</strong><button class="close" type="button" data-action="close" aria-label="Close settings">×</button></div>
        <p class="description">Preserves original messages and requests. Safe mode uses browser-native rendering hints.</p>
        <label>Enabled <input name="enabled" type="checkbox"></label>
        <label>Mode <select name="mode"><option value="safe">Safe — recommended</option><option value="compact">Compact — more aggressive</option></select></label>
        <label>Recent turns to keep <input name="keepRecent" type="number" min="10" max="200" step="10"></label>
        <label>Start optimizing at <input name="minimumTurns" type="number" min="20" max="500" step="10"></label>
        <label>Reduce animations <input name="reduceMotion" type="checkbox"></label>
        <div class="status" id="status" role="status"></div>
        <div class="warn" id="warning"></div>
        <div class="actions">
          <button type="button" data-action="older">Reveal 20 older</button>
          <button type="button" data-action="all">Show all</button>
          <button type="button" data-action="reapply">Reapply</button>
        </div>
        <div class="metrics" id="metrics"></div>
      </div>
      <button type="button" class="launcher" id="launcher" aria-expanded="false" aria-controls="settings-panel">Smoother</button>
    `;
    shadow.appendChild(wrapper);
    ui = {
      panel: shadow.getElementById('settings-panel'),
      launcher: shadow.getElementById('launcher'),
      status: shadow.getElementById('status'),
      warning: shadow.getElementById('warning'),
      metrics: shadow.getElementById('metrics')
    };
    shadow.addEventListener('change', e => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.getAttribute('name')) return;
      changeSetting(el.name, el.type === 'checkbox' ? el.checked : el.value);
    });
    shadow.addEventListener('click', e => {
      const button = e.target.closest('button');
      if (!button) return;
      const action = button.getAttribute('data-action');
      if (button.id === 'launcher' || action === 'close') {
        settings.panelOpen = button.id === 'launcher' ? !settings.panelOpen : false;
        save();
        render();
      } else if (action === 'older') revealOlder();
      else if (action === 'all') restoreAll();
      else if (action === 'reapply') {
        showAllUntilRouteChange = false;
        queueScan(0);
      }
    });
    document.body.appendChild(host);
    render();
  }

  function render() {
    if (!ui || !host?.isConnected) return;
    ui.panel.hidden = !settings.panelOpen;
    ui.launcher.setAttribute('aria-expanded', String(settings.panelOpen));
    if (!settings.panelOpen) return;
    for (const [name, value] of Object.entries(settings)) {
      const control = shadow.querySelector(`[name="${name}"]`);
      if (!control) continue;
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else if (document.activeElement !== control) control.value = String(value);
    }
    ui.status.textContent = lastState;
    ui.warning.textContent = currentLayout === 'native'
      ? 'This ChatGPT layout already virtualizes turns. No additional DOM optimization is applied.'
      : settings.mode === 'compact'
        ? 'Compact mode visually hides older turns. Use “Show all” for search, copy, or export.'
        : 'Safe mode keeps older turns searchable and accessible.';
    ui.metrics.textContent = `${latestCount} turns detected · ${foldedCount} folded · layout: ${currentLayout} · last scan: ${lastScanMs} ms`;
  }

  function start() {
    if (document.getElementById(`${TAG}-host`)) return;
    injectCSS();
    makeUI();
    document.addEventListener('scroll', () => { lastScroll = performance.now(); }, { capture: true, passive: true });
    document.addEventListener('input', e => {
      const t = e.target;
      if (t instanceof Element && (t.closest('[contenteditable="true"]') || t.matches('textarea, input'))) {
        lastTyping = performance.now();
      }
    }, { capture: true, passive: true });
    document.addEventListener('click', e => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const folded = target.closest(`.${TAG}-folded`);
      if (!folded || !managed.has(folded)) return;
      // A collapsed wrapper is a visual summary; reveal its existing DOM in place.
      independentlyOpened.add(folded);
      mark(folded, 'none');
      foldedCount = Math.max(0, foldedCount - 1);
      queueScan(100);
      render();
    }, true);
    // Avoid monkey-patching history.pushState and ChatGPT's React runtime.
    // A low-frequency route check is cheap and catches SPA navigation.
    setInterval(() => {
      const nextRoute = location.pathname + location.search;
      const streaming = isStreaming();
      // Recheck only on navigation, replaced roots or streaming transitions,
      // rather than rescanning all turns on every interval tick.
      if (nextRoute !== route || !currentRoot?.isConnected || streaming !== wasStreaming) {
        wasStreaming = streaming;
        queueScan(250);
      }
      if (ui && !host?.isConnected) makeUI();
    }, 2400);
    window.addEventListener('popstate', () => queueScan(100));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) queueScan(250); });
    queueScan(600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();