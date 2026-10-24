// ==UserScript==
// @name         ChatGPT Long Chat Smoother (Best-of, Safe First)
// @namespace    local.chatgpt.long-chat-smoother
// @version      1.1.0
// @description  Budgeted safe long-chat rendering hints, optional compact mode, large-block hints, and live diagnostics.
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
    largeBlocks: true,
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
        largeBlocks: typeof parsed.largeBlocks === 'boolean' ? parsed.largeBlocks : DEFAULTS.largeBlocks,
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
  let scanJob = null;
  let jobSerial = 0;
  let userScrollEpoch = 0;
  let suppressScrollUntil = 0;
  let blockedByVisibility = false;
  const CHUNK_BUDGET_MS = 6;
  const CHUNK_MAX_OPERATIONS = 24;
  const BLOCK_MIN_CHARS = { PRE: 1300, TABLE: 1700, P: 1700, BLOCKQUOTE: 2000 };
  const largeManaged = new Set();
  const perf = {
    scans: 0, lastTotalMs: 0, meanTotalMs: 0, maxTotalMs: 0,
    lastWorkMs: 0, lastChunkMs: 0, maxChunkMs: 0, overBudget: 0,
    lastNodes: 0, lastBlocks: 0, frameGapMs: null,
    longTasks: 0, longTaskMs: 0, supportedLongTasks: false
  };
  let longTaskObserver = null;
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
      .${TAG}-block {
        content-visibility: auto !important;
        contain-intrinsic-size: auto 360px !important;
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
        .${TAG}-auto, .${TAG}-block { content-visibility: visible !important; contain-intrinsic-size: none !important; }
        .${TAG}-folded { max-height: none !important; overflow: visible !important; }
        .${TAG}-folded > * { display: revert !important; }
        .${TAG}-folded::before { display: none !important; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function cleanupMarks() {
    for (const node of largeManaged) node.classList.remove(`${TAG}-block`);
    largeManaged.clear();
    for (const node of managed) {
      node.classList.remove(`${TAG}-auto`, `${TAG}-folded`);
      node.removeAttribute('data-cgpt-smoother-label');
    }
    managed.clear();
    document.querySelectorAll(`main.${TAG}-less-motion`).forEach(n => n.classList.remove(`${TAG}-less-motion`));
    foldedCount = 0;
  }

  function resetOnRouteChange(nextRoute) {
    cancelJob();
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

  function cancelJob() {
    jobSerial++;
    scanJob = null;
    if (idleTask) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleTask);
      else clearTimeout(idleTask);
    }
    idleTask = 0;
  }

  function queueScan(delay = 400) {
    if (document.hidden) {
      blockedByVisibility = true;
      return;
    }
    cancelJob();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scheduleWork(scan);
    }, delay);
  }

  function scheduleWork(fn) {
    if (document.hidden) return;
    if (typeof window.requestIdleCallback === 'function') {
      idleTask = window.requestIdleCallback(deadline => {
        idleTask = 0;
        if (!document.hidden) fn(deadline);
      }, { timeout: 250 });
    } else {
      idleTask = setTimeout(() => {
        idleTask = 0;
        if (!document.hidden) fn({ timeRemaining: () => CHUNK_BUDGET_MS });
      }, 0);
    }
  }

  function suspendBackground() {
    blockedByVisibility = true;
    clearTimeout(scanTimer);
    scanTimer = 0;
    cancelJob();
    stopLongTaskObserver();
    rootObserver?.disconnect();
    rootObserver = null;
    currentRoot = null;
    lastState = 'Suspended in background tab';
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

  function chooseVisibleAnchor(scroller, turns) {
    if (typeof document.elementFromPoint !== 'function') return null;
    const r = scroller === document.scrollingElement || scroller === document.documentElement
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : scroller.getBoundingClientRect();
    const x = Math.max(5, Math.min(window.innerWidth - 5, r.left + r.width / 2));
    const y = Math.max(5, Math.min(window.innerHeight - 5, r.top + Math.min(r.height / 3, 125)));
    let node = document.elementFromPoint(x, y);
    const turnSet = new Set(turns);
    while (node && !turnSet.has(node)) node = node.parentElement;
    return node;
  }

  function captureScroll(job) {
    if (job.mode !== 'compact' || !job.scroller?.isConnected) return null;
    const scroller = job.scroller;
    const bottomDistance = Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
    const anchor = chooseVisibleAnchor(scroller, job.turns);
    return {
      scroller, bottomDistance,
      anchor, top: anchor?.getBoundingClientRect().top,
      epoch: userScrollEpoch,
      route: job.route,
      stickBottom: bottomDistance < 180
    };
  }

  function restoreScroll(snapshot) {
    if (!snapshot || snapshot.epoch !== userScrollEpoch ||
        snapshot.route !== location.pathname + location.search ||
        !snapshot.scroller?.isConnected || document.hidden || isStreaming()) return;
    const { scroller } = snapshot;
    suppressScrollUntil = performance.now() + 90;
    if (snapshot.stickBottom) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - snapshot.bottomDistance);
    } else if (snapshot.anchor?.isConnected && Number.isFinite(snapshot.top)) {
      scroller.scrollTop += snapshot.anchor.getBoundingClientRect().top - snapshot.top;
    }
  }

  function shouldPause() {
    return document.hidden || isStreaming() ||
      (performance.now() - lastScroll < 300) ||
      (performance.now() - lastTyping < 350);
  }

  function isBlockCandidate(node) {
    if (!(node instanceof Element) || !node.isConnected || protectedTurn(node)) return false;
    const limit = BLOCK_MIN_CHARS[node.tagName];
    // Text length is an inexpensive early filter compared with scrollHeight/forced layout.
    // Do not read or store the text content; only measure its length.
    return Boolean(limit && node.textContent?.length >= limit);
  }

  function updateBlocksForTurn(turn, job) {
    if (!settings.largeBlocks || !supportsCV || job.layout === 'native') return;
    // Never touch the newest two turns, active selection, or editable UI.
    if (job.index >= job.turns.length - 2 || protectedTurn(turn)) return;
    if (job.blockQueue.length >= 800) return;
    const blocks = turn.querySelectorAll('pre, table, .markdown p, .prose p, .markdown blockquote, .prose blockquote');
    for (const node of blocks) {
      if (job.blockQueue.length >= 800) break;
      // Avoid nested marking of a paragraph within a marked table/pre.
      if (node.closest('pre, table') && !node.matches('pre, table')) continue;
      job.blockQueue.push(node);
    }
  }

  function updateLongTaskObserver() {
    if (!settings.panelOpen || document.hidden || !settings.enabled) {
      stopLongTaskObserver();
      return;
    }
    if (longTaskObserver || typeof PerformanceObserver !== 'function') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    try {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          perf.longTasks++;
          perf.longTaskMs += entry.duration;
        }
        render();
      });
      longTaskObserver.observe({ type: 'longtask', buffered: false });
      perf.supportedLongTasks = true;
    } catch { stopLongTaskObserver(); }
  }
  function stopLongTaskObserver() {
    longTaskObserver?.disconnect();
    longTaskObserver = null;
  }

  function finishJob(job) {
    if (scanJob !== job || document.hidden) return;
    scanJob = null;
    for (const node of [...managed]) {
      if (!node.isConnected || !job.turnSet.has(node)) mark(node, 'none');
    }
    for (const node of [...largeManaged]) {
      if (!node.isConnected || !job.blockSeen.has(node)) {
        node.classList.remove(`${TAG}-block`);
        largeManaged.delete(node);
      }
    }
    foldedCount = job.folded;
    perf.scans++;
    perf.lastTotalMs = Math.round((performance.now() - job.started) * 10) / 10;
    perf.meanTotalMs += (perf.lastTotalMs - perf.meanTotalMs) / perf.scans;
    perf.maxTotalMs = Math.max(perf.maxTotalMs, perf.lastTotalMs);
    perf.lastWorkMs = Math.round(job.workMs * 10) / 10;
    perf.lastNodes = job.turns.length;
    perf.lastBlocks = largeManaged.size;
    lastScanMs = perf.lastTotalMs;
    lastState = job.mode === 'compact' ? `Compact: ${job.folded} older turns folded` :
      supportsCV ? `Safe: ${job.cutoff} older turns optimized` : 'content-visibility unsupported';
    render();
    // A sampled two-frame interval reflects responsiveness, not exact paint latency.
    if (settings.panelOpen && typeof requestAnimationFrame === 'function') {
      const ticket = jobSerial;
      requestAnimationFrame(t1 => requestAnimationFrame(t2 => {
        if (ticket === jobSerial && !document.hidden) {
          perf.frameGapMs = Math.round((t2 - t1) * 10) / 10;
          render();
        }
      }));
    }
  }

  function runChunkInternal(job) {
    if (scanJob !== job || document.hidden) return;
    if (job.route !== location.pathname + location.search) { queueScan(0); return; }
    if (shouldPause()) {
      lastState = 'Paused during interaction or generation';
      queueScan(600);
      return;
    }
    const snapshot = captureScroll(job);
    const begin = performance.now();
    let operations = 0;
    while (operations < CHUNK_MAX_OPERATIONS && performance.now() - begin < CHUNK_BUDGET_MS) {
      if (job.index < job.turns.length) {
        const i = job.index++;
        const node = job.turns[i];
        const keepVisible = i >= job.cutoff || protectedTurn(node) || independentlyOpened.has(node);
        const desired = keepVisible ? 'none' :
          (job.mode === 'compact' ? 'fold' : (supportsCV ? 'auto' : 'none'));
        const already = desired === 'fold' ? node.classList.contains(`${TAG}-folded`) :
          desired === 'auto' ? node.classList.contains(`${TAG}-auto`) :
          (!node.classList.contains(`${TAG}-auto`) && !node.classList.contains(`${TAG}-folded`));
        if (!already) mark(node, desired, `Older turn ${i + 1} — click to expand`);
        if (desired === 'fold') job.folded++;
        if (desired !== 'fold') updateBlocksForTurn(node, job);
      } else if (job.blockIndex < job.blockQueue.length) {
        const node = job.blockQueue[job.blockIndex++];
        if (!node.isConnected || !job.root.contains(node)) continue;
        if (isBlockCandidate(node)) {
          job.blockSeen.add(node);
          if (!node.classList.contains(`${TAG}-block`)) node.classList.add(`${TAG}-block`);
          largeManaged.add(node);
        }
      } else break;
      operations++;
    }
    const chunkMs = performance.now() - begin;
    job.workMs += chunkMs;
    perf.lastChunkMs = Math.round(chunkMs * 10) / 10;
    perf.maxChunkMs = Math.max(perf.maxChunkMs, chunkMs);
    if (chunkMs > CHUNK_BUDGET_MS + 2) perf.overBudget++;
    const more = job.index < job.turns.length || job.blockIndex < job.blockQueue.length;
    if (snapshot) {
      requestAnimationFrame(() => {
        if (scanJob !== job || document.hidden) return;
        restoreScroll(snapshot);
        if (more) scheduleWork(() => runChunk(job));
        else finishJob(job);
      });
    } else if (more) scheduleWork(() => runChunk(job));
    else finishJob(job);
  }

  function runChunk(job) {
    try { runChunkInternal(job); }
    catch (error) {
      cancelJob();
      cleanupMarks();
      lastState = `Safety fallback (${error?.message || 'DOM changed'})`;
      console.warn('[ChatGPT Smoother] Work interrupted; original page restored', error);
      render();
    }
  }

  function scan() {
    if (document.hidden) { blockedByVisibility = true; return; }
    cancelJob();
    const t0 = performance.now();
    try {
      const nextRoute = location.pathname + location.search;
      if (nextRoute !== route) resetOnRouteChange(nextRoute);
      const { root, layout, turns } = discover();
      bindRootObserver(root);
      currentLayout = layout;
      latestCount = turns.length;
      if (!settings.enabled) {
        cleanupMarks(); lastState = 'Disabled — original ChatGPT view'; return;
      }
      if (!turns.length) {
        cleanupMarks(); lastState = 'Waiting for a conversation'; return;
      }
      if (layout === 'native') {
        cleanupMarks(); lastState = 'Native ChatGPT virtualization detected — left untouched'; return;
      }
      if (shouldPause()) {
        lastState = isStreaming() ? 'Paused while ChatGPT is generating' : 'Paused during interaction';
        if (!document.hidden && !isStreaming()) queueScan(650);
        return;
      }
      if (turns.length < settings.minimumTurns && !(settings.largeBlocks && supportsCV) || showAllUntilRouteChange) {
        cleanupMarks();
        lastState = showAllUntilRouteChange ? 'Full conversation restored' : 'Below optimization threshold';
        return;
      }
      const scroller = getScroller(turns[turns.length - 1]);
      if (settings.mode === 'compact' && foldedCount === 0 && !nearBottom(scroller) &&
          turns.length >= settings.minimumTurns) {
        lastState = 'Compact mode waits until near the bottom';
        return;
      }
      const cutoff = turns.length >= settings.minimumTurns
        ? Math.max(0, turns.length - Math.min(turns.length, settings.keepRecent + extraRecent))
        : 0;
      scanJob = {
        id: ++jobSerial, route: nextRoute, root, layout, turns,
        turnSet: new Set(turns), mode: settings.mode, cutoff,
        index: 0, folded: 0, blockQueue: [], blockIndex: 0,
        blockSeen: new Set(), workMs: 0, scroller, started: t0
      };
      // The work is sliced into <=6ms / <=24-operation chunks.
      runChunk(scanJob);
    } catch (error) {
      cancelJob();
      cleanupMarks();
      lastState = `Safety fallback (${error?.message || 'DOM changed'})`;
      console.warn('[ChatGPT Smoother] Restored page after error', error);
    } finally {
      applyMotion();
      render();
    }
  }

  function captureCurrentScroll() {
    const { turns } = discover();
    if (!turns.length) return null;
    return captureScroll({
      mode: 'compact', turns, scroller: getScroller(turns[turns.length - 1]),
      route: location.pathname + location.search
    });
  }

  function revealOlder(step = 20) {
    showAllUntilRouteChange = false;
    extraRecent = Math.min(100000, extraRecent + step);
    queueScan(0);
  }
  function restoreAll() {
    cancelJob();
    const snapshot = captureCurrentScroll();
    showAllUntilRouteChange = true;
    cleanupMarks();
    if (snapshot) requestAnimationFrame(() => restoreScroll(snapshot));
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
    if (!settings.enabled || !settings.largeBlocks) {
      if (!settings.enabled) cleanupMarks();
      else { for (const node of largeManaged) node.classList.remove(`${TAG}-block`); largeManaged.clear(); }
    }
    updateLongTaskObserver();
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
      .metrics { margin-top:10px; color:#bbc8d8; font-size:11px; white-space:pre-line; line-height:1.65; }
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
        <label>Optimize large reply blocks <input name="largeBlocks" type="checkbox"></label>
        <label>Reduce animations <input name="reduceMotion" type="checkbox"></label>
        <div class="status" id="status" role="status"></div>
        <div class="warn" id="warning"></div>
        <div class="actions">
          <button type="button" data-action="older">Reveal 20 older</button>
          <button type="button" data-action="all">Show all</button>
          <button type="button" data-action="reapply">Reapply</button>
        </div>
        <div class="metrics" id="metrics" aria-live="off"></div>
        <p class="description">Timing measurements describe this page, not AI inference speed. Long tasks are page-wide.</p>
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
        updateLongTaskObserver();
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
    const total = Number.isFinite(perf.lastTotalMs) ? perf.lastTotalMs.toFixed(1) : '—';
    const avg = perf.scans ? perf.meanTotalMs.toFixed(1) : '—';
    const frame = perf.frameGapMs === null ? 'n/a' : `${perf.frameGapMs.toFixed(1)} ms`;
    ui.metrics.textContent = `${latestCount} turns · ${foldedCount} folded · ${largeManaged.size} large blocks · ${currentLayout} layout\n` +
      `Scans ${perf.scans} · last ${total} ms · avg ${avg} ms\n` +
      `Last work ${perf.lastWorkMs.toFixed(1)} ms · chunk ${perf.lastChunkMs.toFixed(1)} ms · peak ${perf.maxChunkMs.toFixed(1)} ms\n` +
      `Budget overruns ${perf.overBudget} · frame interval ${frame}\n` +
      (perf.supportedLongTasks ? `Page long tasks ${perf.longTasks} · total ${perf.longTaskMs.toFixed(0)} ms` : 'Page long tasks unavailable in this browser');
  }

  function start() {
    if (document.getElementById(`${TAG}-host`)) return;
    injectCSS();
    makeUI();
    updateLongTaskObserver();
    document.addEventListener('scroll', () => {
      const now = performance.now();
      if (now >= suppressScrollUntil) { lastScroll = now; userScrollEpoch++; }
    }, { capture: true, passive: true });
    for (const eventName of ['wheel', 'touchstart', 'pointerdown']) {
      document.addEventListener(eventName, () => { userScrollEpoch++; }, { capture: true, passive: true });
    }
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
      const snapshot = captureCurrentScroll();
      independentlyOpened.add(folded);
      mark(folded, 'none');
      if (snapshot) requestAnimationFrame(() => restoreScroll(snapshot));
      foldedCount = Math.max(0, foldedCount - 1);
      queueScan(100);
      render();
    }, true);
    // Avoid monkey-patching history.pushState and ChatGPT's React runtime.
    // A low-frequency route check is cheap and catches SPA navigation.
    setInterval(() => {
      if (document.hidden) return;
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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) suspendBackground();
      else {
        blockedByVisibility = false;
        updateLongTaskObserver();
        queueScan(250);
      }
    });
    queueScan(600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();