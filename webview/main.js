/* eslint-env browser */
/* global acquireVsCodeApi */

import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import shell from 'highlight.js/lib/languages/shell';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('powershell', shell);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);

(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const emptyEl = $('empty-state');
  const inputEl = $('input');
  const sendBtn = $('btn-send');
  const stopBtn = $('btn-stop');
  const statusEl = $('status');
  const hintEl = $('hint');
  const modelSelect = $('model-select');
  const modeSelect = $('mode-select');
  const popoverEl = $('popover');
  const planBanner = $('plan-banner');
  const resultMetaInline = $('result-meta-inline');

  let busy = false;
  let useCtrlEnter = false;
  let hideOnboarding = false;
  let allowDangerousBypass = false;
  let disableLoginPrompt = false;
  let sessionId = null;
  let currentModel = 'default';
  let currentMode = 'default';
  let lastResultMeta = '';

  const assistantNodes = new Map();

  // ---------------------------------------------------------------------------
  // Streaming render scheduler — coalesce deltas to one paint per rAF
  // ---------------------------------------------------------------------------
  const dirtyBlocks = new Set();
  let frameScheduled = false;
  let scrollPending = false;

  function scheduleFlush() {
    if (frameScheduled) return;
    frameScheduled = true;
    requestAnimationFrame(flushDirtyBlocks);
  }

  function flushDirtyBlocks() {
    frameScheduled = false;
    for (const state of dirtyBlocks) {
      const target = state.text;
      const prev = state.rendered || '';
      if (target === prev) continue;
      if (target.startsWith(prev)) {
        state.el.appendChild(document.createTextNode(target.slice(prev.length)));
      } else {
        state.el.textContent = target;
      }
      state.rendered = target;
    }
    dirtyBlocks.clear();
    if (scrollPending) {
      scrollPending = false;
      const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      if (distanceFromBottom <= 140) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function markDirty(state) {
    dirtyBlocks.add(state);
    scrollPending = true;
    scheduleFlush();
  }

  // ---------------------------------------------------------------------------
  // DOM bookkeeping
  // ---------------------------------------------------------------------------
  function clearEmptyState() {
    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
  }

  function clearMessages() {
    messagesEl.innerHTML = '';
    assistantNodes.clear();
    partialBlocks.clear();
    currentAssistantId = null;
    if (emptyEl) messagesEl.appendChild(emptyEl);
  }

  function appendUser(text) {
    clearEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = 'You';
    const body = document.createElement('div');
    body.className = 'msg-body';
    renderUserText(body, text);
    wrap.appendChild(role);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // User messages get @mention pill rendering for tokens like "@src/foo.ts".
  function renderUserText(parent, text) {
    const re = /@(\S+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const path = m[1];
      // Heuristic: looks like a path if it has a dot or slash and is plausible.
      if (/[./\\]/.test(path)) {
        const pill = document.createElement('span');
        pill.className = 'file-mention';
        pill.textContent = path;
        pill.title = `Open ${path}`;
        pill.addEventListener('click', () => vscode.postMessage({ type: 'openFile', filePath: path }));
        parent.appendChild(pill);
      } else {
        parent.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function getOrCreateAssistant(id) {
    let entry = id ? assistantNodes.get(id) : null;
    if (entry) return entry;
    clearEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = 'Claude';
    const body = document.createElement('div');
    body.className = 'msg-body';
    wrap.appendChild(role);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    entry = { wrap, bodyEl: body, blocks: new Map() };
    if (id) assistantNodes.set(id, entry);
    return entry;
  }

  function ensureTextBlock(parent, key) {
    let state = parent.blocks.get(key);
    if (state) return state;
    const el = document.createElement('div');
    el.className = 'text-block';
    parent.bodyEl.appendChild(el);
    state = { el, type: 'text', text: '', rendered: '', finalized: false };
    parent.blocks.set(key, state);
    return state;
  }

  function ensureThinkingBlock(parent, key) {
    let state = parent.blocks.get(key);
    if (state) return state;
    const wrap = document.createElement('div');
    wrap.className = 'thinking streaming';
    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.innerHTML = `<span class="thinking-arrow">▸</span><span>Thinking</span>`;
    const body = document.createElement('div');
    body.className = 'thinking-body';
    wrap.appendChild(header);
    wrap.appendChild(body);
    header.addEventListener('click', () => {
      if (wrap.classList.contains('streaming')) return;
      wrap.classList.toggle('expanded');
    });
    parent.bodyEl.appendChild(wrap);
    state = { el: body, wrap, type: 'thinking', text: '', rendered: '', finalized: false };
    parent.blocks.set(key, state);
    return state;
  }

  function ensureToolBlock(parent, key, name, input) {
    let state = parent.blocks.get(key);
    if (state) {
      updateToolBlock(state, name, input);
      return state;
    }
    const wrap = document.createElement('div');
    wrap.className = 'tool';
    const header = document.createElement('div');
    header.className = 'tool-header';
    const arrow = document.createElement('span');
    arrow.className = 'tool-arrow';
    arrow.textContent = '▸';
    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    const title = document.createElement('span');
    title.className = 'tool-title';
    const targetSpan = document.createElement('span');
    targetSpan.className = 'tool-target';
    const meta = document.createElement('span');
    meta.className = 'tool-meta';
    header.append(arrow, icon, title, targetSpan, meta);
    const body = document.createElement('div');
    body.className = 'tool-body';
    wrap.append(header, body);
    header.addEventListener('click', () => wrap.classList.toggle('expanded'));
    parent.bodyEl.appendChild(wrap);
    state = { wrap, header, body, icon, title, targetSpan, meta, type: 'tool_use', name, input, text: '' };
    parent.blocks.set(key, state);
    updateToolBlock(state, name, input);
    return state;
  }

  function updateToolBlock(state, name, input) {
    state.name = name || state.name;
    state.input = input || {};
    state.icon.textContent = iconForTool(state.name);
    state.title.textContent = state.name || 'tool';
    state.targetSpan.textContent = targetForTool(state.name, state.input);
    state.meta.textContent = metaForTool(state.name, state.input);
    state.body.innerHTML = '';
    state.body.appendChild(renderToolBody(state.name, state.input));
  }

  function iconForTool(name) {
    switch (name) {
      case 'Read': return '◈';
      case 'Write': return '✎';
      case 'Edit': return '✦';
      case 'Bash':
      case 'PowerShell': return '▸';
      case 'Grep':
      case 'Glob': return '◎';
      case 'WebFetch':
      case 'WebSearch': return '⊙';
      case 'TodoWrite': return '✓';
      default: return '⚙';
    }
  }

  function targetForTool(name, input) {
    if (!input || typeof input !== 'object') return '';
    const i = input;
    if (typeof i.file_path === 'string') return shortenPath(i.file_path);
    if (typeof i.path === 'string') return shortenPath(i.path);
    if (typeof i.command === 'string') return truncate(i.command, 200);
    if (typeof i.pattern === 'string') return i.pattern;
    if (typeof i.url === 'string') return i.url;
    if (typeof i.query === 'string') return i.query;
    return '';
  }

  function metaForTool(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (name === 'Read') {
      if (typeof input.offset === 'number' && typeof input.limit === 'number') {
        return `:${input.offset}-${input.offset + input.limit}`;
      }
      if (typeof input.limit === 'number') return `(${input.limit} lines)`;
    }
    return '';
  }

  function shortenPath(p) {
    if (!p) return '';
    const norm = p.replace(/\\/g, '/');
    const parts = norm.split('/');
    if (parts.length <= 2) return norm;
    return '…/' + parts.slice(-2).join('/');
  }

  function renderToolBody(name, input) {
    const frag = document.createDocumentFragment();
    if (!input || typeof input !== 'object') return frag;

    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      frag.appendChild(renderDiff(input.old_string, input.new_string));
      const actions = document.createElement('div');
      actions.className = 'actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'tool-action-btn primary';
      openBtn.textContent = 'Open diff in editor';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: 'openDiff',
          filePath: input.file_path || '',
          oldStr: input.old_string,
          newStr: input.new_string,
        });
      });
      actions.appendChild(openBtn);
      if (input.file_path) {
        const openFile = document.createElement('button');
        openFile.className = 'tool-action-btn';
        openFile.textContent = 'Open file';
        openFile.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'openFile', filePath: input.file_path });
        });
        actions.appendChild(openFile);
      }
      frag.appendChild(actions);
      return frag;
    }

    if (name === 'Write' && typeof input.content === 'string') {
      const ext = input.file_path ? extOf(input.file_path) : '';
      frag.appendChild(renderHighlightedCode(input.content, langFromExt(ext)));
      const actions = document.createElement('div');
      actions.className = 'actions';
      const apply = document.createElement('button');
      apply.className = 'tool-action-btn primary';
      apply.textContent = 'Apply to file';
      apply.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'applyEdit', filePath: input.file_path, content: input.content });
      });
      const copy = document.createElement('button');
      copy.className = 'tool-action-btn';
      copy.textContent = 'Copy';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'copyToClipboard', text: input.content });
      });
      actions.append(apply, copy);
      frag.appendChild(actions);
      return frag;
    }

    if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
      frag.appendChild(renderHighlightedCode(input.command, name === 'PowerShell' ? 'powershell' : 'bash'));
      if (typeof input.description === 'string' && input.description.trim()) {
        const desc = document.createElement('div');
        desc.style.color = 'var(--vscode-descriptionForeground)';
        desc.style.fontStyle = 'italic';
        desc.style.marginTop = '4px';
        desc.style.fontSize = '0.92em';
        desc.textContent = input.description;
        frag.appendChild(desc);
      }
      return frag;
    }

    const pre = document.createElement('pre');
    try { pre.textContent = JSON.stringify(input, null, 2); }
    catch { pre.textContent = String(input); }
    frag.appendChild(pre);
    return frag;
  }

  function renderDiff(oldStr, newStr) {
    const wrap = document.createElement('div');
    wrap.className = 'diff';
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    for (const line of oldLines) {
      const el = document.createElement('div');
      el.className = 'diff-line del';
      el.textContent = line;
      wrap.appendChild(el);
    }
    for (const line of newLines) {
      const el = document.createElement('div');
      el.className = 'diff-line add';
      el.textContent = line;
      wrap.appendChild(el);
    }
    return wrap;
  }

  function renderHighlightedCode(code, lang) {
    const wrap = document.createElement('div');
    wrap.className = 'code-fence';
    const header = document.createElement('div');
    header.className = 'code-fence-header';
    const langSpan = document.createElement('span');
    langSpan.textContent = lang || 'plaintext';
    const actions = document.createElement('div');
    actions.className = 'code-fence-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-fence-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'copyToClipboard', text: code });
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    });
    actions.appendChild(copyBtn);
    header.append(langSpan, actions);
    wrap.appendChild(header);

    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    const trimmed = code.replace(/\n$/, '');
    if (lang && hljs.getLanguage(lang)) {
      try {
        const result = hljs.highlight(trimmed, { language: lang, ignoreIllegals: true });
        codeEl.innerHTML = result.value;
        codeEl.className = 'hljs language-' + lang;
      } catch {
        codeEl.textContent = trimmed;
      }
    } else {
      // Auto-detect for unknown langs
      try {
        const result = hljs.highlightAuto(trimmed);
        codeEl.innerHTML = result.value;
        codeEl.className = 'hljs';
      } catch {
        codeEl.textContent = trimmed;
      }
    }
    pre.appendChild(codeEl);
    wrap.appendChild(pre);
    return wrap;
  }

  function langFromExt(ext) {
    const m = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', go: 'go', rs: 'rust', java: 'java', cs: 'csharp',
      json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown',
      html: 'html', xml: 'xml', css: 'css', scss: 'css',
      sh: 'bash', bash: 'bash', sql: 'sql',
    };
    return m[(ext || '').toLowerCase()] || '';
  }

  function extOf(filePath) {
    if (!filePath) return '';
    const i = filePath.lastIndexOf('.');
    return i === -1 ? '' : filePath.slice(i + 1);
  }

  function appendErrorBubble(message) {
    clearEmptyState();
    const el = document.createElement('div');
    el.className = 'error';
    el.textContent = `Error: ${message}`;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendToolResultError(content) {
    clearEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'tool error expanded';
    const header = document.createElement('div');
    header.className = 'tool-header';
    header.innerHTML = `<span class="tool-arrow">▸</span><span class="tool-icon">⚠</span><span class="tool-title">Tool error</span><span class="tool-target"></span>`;
    const body = document.createElement('div');
    body.className = 'tool-body';
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content.map((c) => (c && c.text) || JSON.stringify(c)).join('\n') : JSON.stringify(content));
    const pre = document.createElement('pre');
    pre.textContent = truncate(text, 4000);
    body.appendChild(pre);
    wrap.append(header, body);
    header.addEventListener('click', () => wrap.classList.toggle('expanded'));
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setResultMeta(event) {
    if (!event) { lastResultMeta = ''; resultMetaInline.textContent = ''; return; }
    const parts = [];
    if (typeof event.duration_ms === 'number') parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
    if (event.usage) {
      const u = event.usage;
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const outTok = u.output_tokens || 0;
      if (inTok || outTok) parts.push(`${formatNum(inTok)}↓ ${formatNum(outTok)}↑`);
    }
    if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd.toFixed(4)}`);
    lastResultMeta = parts.join('  ·  ');
    resultMetaInline.textContent = lastResultMeta;
  }

  function formatNum(n) {
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }

  function truncate(s, n) {
    if (!s) return '';
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
  }

  // ---------------------------------------------------------------------------
  // Markdown renderer (block-level: paragraphs, headings, lists, fenced code).
  // Inline rendering is applied per-paragraph via tokenizeInline.
  // ---------------------------------------------------------------------------
  function renderMarkdown(text) {
    const out = document.createDocumentFragment();
    if (!text) return out;
    const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      if (m.index > lastIndex) out.appendChild(renderInlineBlock(text.slice(lastIndex, m.index)));
      const lang = m[1].trim();
      out.appendChild(renderHighlightedCode(m[2], lang));
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) out.appendChild(renderInlineBlock(text.slice(lastIndex)));
    return out;
  }

  function renderInlineBlock(text) {
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const el = document.createElement('h' + h[1].length);
        applyInline(el, h[2]);
        frag.appendChild(el);
        i++;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          applyInline(li, lines[i].replace(/^\s*[-*]\s+/, ''));
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = document.createElement('li');
          applyInline(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
          ol.appendChild(li);
          i++;
        }
        frag.appendChild(ol);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      const p = document.createElement('p');
      applyInline(p, buf.join('\n'));
      frag.appendChild(p);
    }
    return frag;
  }

  function applyInline(parent, text) {
    const tokens = tokenizeInline(text);
    for (const tok of tokens) {
      if (tok.type === 'text') parent.appendChild(document.createTextNode(tok.value));
      else if (tok.type === 'code') {
        const el = document.createElement('code'); el.textContent = tok.value; parent.appendChild(el);
      } else if (tok.type === 'bold') {
        const el = document.createElement('strong'); applyInline(el, tok.value); parent.appendChild(el);
      } else if (tok.type === 'italic') {
        const el = document.createElement('em'); applyInline(el, tok.value); parent.appendChild(el);
      } else if (tok.type === 'link') {
        const a = document.createElement('a'); a.href = tok.href; a.textContent = tok.value; a.target = '_blank'; parent.appendChild(a);
      }
    }
  }

  function tokenizeInline(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
      if (text[i] === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) { tokens.push({ type: 'code', value: text.slice(i + 1, end) }); i = end + 1; continue; }
      }
      if (text[i] === '[') {
        const cb = text.indexOf(']', i + 1);
        if (cb !== -1 && text[cb + 1] === '(') {
          const cp = text.indexOf(')', cb + 2);
          if (cp !== -1) {
            tokens.push({ type: 'link', value: text.slice(i + 1, cb), href: text.slice(cb + 2, cp) });
            i = cp + 1; continue;
          }
        }
      }
      if (text[i] === '*' && text[i + 1] === '*') {
        const end = text.indexOf('**', i + 2);
        if (end !== -1) { tokens.push({ type: 'bold', value: text.slice(i + 2, end) }); i = end + 2; continue; }
      }
      if (text[i] === '*') {
        const end = text.indexOf('*', i + 1);
        if (end !== -1 && end > i + 1) { tokens.push({ type: 'italic', value: text.slice(i + 1, end) }); i = end + 1; continue; }
      }
      let j = i;
      while (j < text.length && text[j] !== '`' && text[j] !== '*' && text[j] !== '[') j++;
      if (j === i) { tokens.push({ type: 'text', value: text[i] }); i++; }
      else { tokens.push({ type: 'text', value: text.slice(i, j) }); i = j; }
    }
    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Stream event router
  // ---------------------------------------------------------------------------
  const partialBlocks = new Map();
  // The Anthropic message id of the assistant turn currently being streamed.
  // Captured from `message_start` so subsequent content_block_* events bind
  // to the same bubble that the final `assistant` event will resolve to —
  // otherwise the streamed copy and the finalized copy land in two bubbles.
  let currentAssistantId = null;

  function handlePartialEvent(event) {
    const inner = event.event;
    if (!inner || typeof inner !== 'object') return;
    if (inner.type === 'message_start' && inner.message && inner.message.id) {
      currentAssistantId = inner.message.id;
    } else if (inner.type === 'message_stop') {
      currentAssistantId = null;
    }
    const parentId = currentAssistantId || event.parent_message_id || event.message_id || event.parent_tool_use_id || 'live';
    const idx = typeof inner.index === 'number' ? inner.index : 0;
    const key = `${parentId}:${idx}`;
    const entry = getOrCreateAssistant(parentId);

    if (inner.type === 'content_block_start') {
      const cb = inner.content_block || {};
      const blockKey = cb.type === 'tool_use' ? `tool:${idx}` : `${cb.type}:${idx}`;
      if (cb.type === 'text') partialBlocks.set(key, ensureTextBlock(entry, blockKey));
      else if (cb.type === 'thinking') partialBlocks.set(key, ensureThinkingBlock(entry, blockKey));
      else if (cb.type === 'tool_use') partialBlocks.set(key, ensureToolBlock(entry, blockKey, cb.name, cb.input || {}));
    } else if (inner.type === 'content_block_delta') {
      const state = partialBlocks.get(key);
      if (!state) return;
      const delta = inner.delta || {};
      if (delta.type === 'text_delta' && state.type === 'text') {
        state.text += delta.text || '';
        markDirty(state);
      } else if (delta.type === 'thinking_delta' && state.type === 'thinking') {
        state.text += delta.thinking || '';
        markDirty(state);
      }
    } else if (inner.type === 'content_block_stop') {
      const state = partialBlocks.get(key);
      if (state && state.type === 'thinking' && state.wrap) state.wrap.classList.remove('streaming');
    }
  }

  function handleStreamEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'stream_event') { handlePartialEvent(event); return; }

    if (event.type === 'system' && event.subtype === 'init') {
      sessionId = event.session_id || sessionId;
      if (event.model && typeof event.model === 'string') {
        currentModel = event.model;
        syncModelSelect();
      }
      updateStatus();
      return;
    }

    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block && block.type === 'tool_result') {
          if (block.is_error) appendToolResultError(block.content);
        } else if (block && block.type === 'text' && typeof block.text === 'string') {
          if (!hasAnyAssistant()) appendUser(block.text);
        }
      }
      return;
    }

    if (event.type === 'assistant' && event.message) {
      const id = event.message.id || `live-${Date.now()}`;
      const entry = getOrCreateAssistant(id);
      const blocks = Array.isArray(event.message.content) ? event.message.content : [];
      blocks.forEach((block, idx) => {
        if (block.type === 'text') finalizeTextBlock(entry, `text:${idx}`, block.text || '');
        else if (block.type === 'thinking') finalizeThinkingBlock(entry, `thinking:${idx}`, block.thinking || '');
        else if (block.type === 'tool_use') ensureToolBlock(entry, `tool:${idx}`, block.name, block.input);
      });
      return;
    }

    if (event.type === 'result') {
      sessionId = event.session_id || sessionId;
      if (event.is_error || event.subtype !== 'success') {
        appendErrorBubble(event.result || event.subtype || 'Turn ended with error');
      }
      setResultMeta(event);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      updateStatus();
      return;
    }
  }

  function finalizeTextBlock(parent, key, fullText) {
    let state = parent.blocks.get(key);
    if (!state) state = ensureTextBlock(parent, key);
    state.text = fullText;
    state.el.innerHTML = '';
    state.el.appendChild(renderMarkdown(fullText));
    state.rendered = fullText;
    state.finalized = true;
  }

  function finalizeThinkingBlock(parent, key, fullText) {
    let state = parent.blocks.get(key);
    if (!state) state = ensureThinkingBlock(parent, key);
    state.text = fullText;
    state.el.textContent = fullText;
    state.rendered = fullText;
    state.finalized = true;
    if (state.wrap) state.wrap.classList.remove('streaming');
  }

  function hasAnyAssistant() { return assistantNodes.size > 0; }

  // ---------------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------------
  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b || inputEl.value.trim().length === 0;
    stopBtn.hidden = !b;
    sendBtn.hidden = b;
    statusEl.classList.toggle('busy', b);
    if (modelSelect) modelSelect.disabled = b;
    if (modeSelect) modeSelect.disabled = b;
    updateStatus();
  }

  function updateStatus() {
    const parts = [];
    parts.push(busy ? 'Working…' : 'Ready');
    if (currentModel && currentModel !== 'default') parts.push(currentModel);
    if (currentMode && currentMode !== 'default') parts.push(currentMode);
    if (sessionId) parts.push(`session ${sessionId.slice(0, 8)}`);
    statusEl.textContent = parts.join(' · ');
    if (planBanner) planBanner.hidden = currentMode !== 'plan';
  }

  function syncModelSelect() {
    if (!modelSelect) return;
    const m = (currentModel || '').toLowerCase();
    let pick = 'default';
    if (m.includes('opus')) pick = 'opus';
    else if (m.includes('sonnet')) pick = 'sonnet';
    else if (m.includes('haiku')) pick = 'haiku';
    if (modelSelect.value !== pick) modelSelect.value = pick;
  }

  function syncModeSelect() {
    if (!modeSelect) return;
    if (modeSelect.value !== currentMode) modeSelect.value = currentMode;
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 240) + 'px';
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    if (text.startsWith('/')) {
      // Map slash commands to host actions when known; otherwise pass through to the CLI.
      const cmd = text.split(/\s+/)[0].toLowerCase();
      const consume = () => { inputEl.value = ''; autoResize(); sendBtn.disabled = true; hidePopover(); };
      if (cmd === '/clear' || cmd === '/new') { vscode.postMessage({ type: 'newConversation' }); consume(); return; }
      if (cmd === '/resume') { vscode.postMessage({ type: 'resume' }); consume(); return; }
      if (cmd === '/settings') { vscode.postMessage({ type: 'openSettings' }); consume(); return; }
      if (cmd === '/login') { vscode.postMessage({ type: 'login' }); consume(); return; }
      if (cmd === '/logout') { vscode.postMessage({ type: 'logout' }); consume(); return; }
      if (cmd === '/usage') { vscode.postMessage({ type: 'usage' }); consume(); return; }
      if (cmd === '/compact') { vscode.postMessage({ type: 'compact' }); consume(); return; }
      if (cmd === '/mcp') { vscode.postMessage({ type: 'mcp' }); consume(); return; }
      if (cmd === '/plugins') { vscode.postMessage({ type: 'plugins' }); consume(); return; }
      if (cmd === '/walkthrough') { vscode.postMessage({ type: 'openWalkthrough' }); consume(); return; }
      if (cmd === '/diagnostics') { vscode.postMessage({ type: 'requestDiagnostics' }); consume(); return; }
      if (cmd === '/terminal') { vscode.postMessage({ type: 'requestTerminalOutput' }); consume(); return; }
    }
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
    autoResize();
    sendBtn.disabled = true;
    hidePopover();
  }

  function updateHint() {
    hintEl.textContent = useCtrlEnter
      ? `${isMac() ? '⌘' : 'Ctrl'}+Enter to send · Enter for newline`
      : 'Enter to send · Shift+Enter for newline';
  }

  function isMac() { return navigator.platform.toUpperCase().includes('MAC'); }

  // ---------------------------------------------------------------------------
  // Slash command + file mention popover
  // ---------------------------------------------------------------------------
  const SLASH_COMMANDS = [
    { cmd: '/clear', detail: 'Start a new conversation' },
    { cmd: '/new', detail: 'Start a new conversation' },
    { cmd: '/resume', detail: 'Resume by session id' },
    { cmd: '/compact', detail: 'Compact the current conversation' },
    { cmd: '/usage', detail: 'View plan usage' },
    { cmd: '/mcp', detail: 'Manage MCP servers' },
    { cmd: '/plugins', detail: 'Manage plugins and marketplaces' },
    { cmd: '/login', detail: 'Sign in to Anthropic' },
    { cmd: '/logout', detail: 'Sign out of Anthropic' },
    { cmd: '/settings', detail: 'Open extension settings' },
    { cmd: '/walkthrough', detail: 'Open the getting-started walkthrough' },
    { cmd: '/diagnostics', detail: 'Send VS Code Problems to Claude' },
    { cmd: '/terminal', detail: 'Send the active terminal selection to Claude' },
    { cmd: '/help', detail: 'Show available commands (sent to Claude)' },
    { cmd: '/init', detail: 'Initialize a CLAUDE.md (sent to Claude)' },
    { cmd: '/review', detail: 'Code review the current branch (sent to Claude)' },
  ];

  let popoverItems = [];
  let popoverActive = -1;
  let popoverContext = null; // { kind: 'slash' | 'mention', start: number }

  function showPopover(items, context) {
    popoverItems = items;
    popoverActive = items.length ? 0 : -1;
    popoverContext = context;
    popoverEl.innerHTML = '';
    if (!items.length) { hidePopover(); return; }
    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'popover-item' + (idx === popoverActive ? ' active' : '');
      const ic = document.createElement('span');
      ic.className = 'popover-icon';
      ic.textContent = item.icon || (context.kind === 'slash' ? '/' : '@');
      const lbl = document.createElement('span');
      lbl.className = 'popover-label';
      lbl.textContent = item.label;
      const det = document.createElement('span');
      det.className = 'popover-detail';
      det.textContent = item.detail || '';
      row.append(ic, lbl, det);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); applyPopoverItem(idx); });
      popoverEl.appendChild(row);
    });
    popoverEl.hidden = false;
  }

  function hidePopover() {
    popoverEl.hidden = true;
    popoverItems = [];
    popoverActive = -1;
    popoverContext = null;
  }

  function applyPopoverItem(idx) {
    if (idx < 0 || idx >= popoverItems.length || !popoverContext) return;
    const item = popoverItems[idx];
    const text = inputEl.value;
    const before = text.slice(0, popoverContext.start);
    const afterStart = popoverContext.start + popoverContext.length;
    const after = text.slice(afterStart);
    const inserted = item.insert + ' ';
    inputEl.value = before + inserted + after;
    const newPos = (before + inserted).length;
    inputEl.setSelectionRange(newPos, newPos);
    autoResize();
    sendBtn.disabled = busy || inputEl.value.trim().length === 0;
    hidePopover();
    inputEl.focus();
  }

  function refreshPopoverHighlight() {
    const rows = popoverEl.querySelectorAll('.popover-item');
    rows.forEach((row, i) => row.classList.toggle('active', i === popoverActive));
    const active = rows[popoverActive];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function tryShowPopover() {
    const v = inputEl.value;
    const pos = inputEl.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    // Slash: only at line start
    const slashMatch = /(^|\n)(\/\S*)$/.exec(before);
    if (slashMatch) {
      const tok = slashMatch[2];
      const start = before.length - tok.length;
      const items = SLASH_COMMANDS
        .filter((c) => c.cmd.startsWith(tok.toLowerCase()))
        .map((c) => ({ icon: '/', label: c.cmd, detail: c.detail, insert: c.cmd }));
      showPopover(items, { kind: 'slash', start, length: tok.length });
      return;
    }
    // @-mention: anywhere — preceded by whitespace or start.
    const mentionMatch = /(^|\s)@(\S*)$/.exec(before);
    if (mentionMatch) {
      const query = mentionMatch[2];
      const start = before.length - (query.length + 1); // include @
      vscode.postMessage({ type: 'searchFiles', query });
      // Show a placeholder; real results arrive via 'fileSuggestions'.
      showPopover(
        query ? [{ icon: '@', label: 'Searching…', detail: query, insert: '@' + query }] : [],
        { kind: 'mention', start, length: query.length + 1, query }
      );
      return;
    }
    hidePopover();
  }

  function applyFileSuggestions(query, results) {
    if (!popoverContext || popoverContext.kind !== 'mention') return;
    if ((popoverContext.query || '') !== query) return;
    const items = results.map((r) => ({
      icon: '◇',
      label: '@' + r.relPath,
      detail: '',
      insert: '@' + r.relPath,
    }));
    if (!items.length) {
      items.push({ icon: '@', label: 'No files match', detail: query, insert: '@' + query });
    }
    showPopover(items, popoverContext);
  }

  // ---------------------------------------------------------------------------
  // Input event handlers
  // ---------------------------------------------------------------------------
  inputEl.addEventListener('input', () => {
    autoResize();
    sendBtn.disabled = busy || inputEl.value.trim().length === 0;
    tryShowPopover();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (!popoverEl.hidden && popoverItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); popoverActive = (popoverActive + 1) % popoverItems.length; refreshPopoverHighlight(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); popoverActive = (popoverActive - 1 + popoverItems.length) % popoverItems.length; refreshPopoverHighlight(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (popoverActive >= 0 && popoverActive < popoverItems.length) {
          e.preventDefault();
          applyPopoverItem(popoverActive);
          return;
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); hidePopover(); return; }
    }
    if (e.key === 'Enter') {
      const wantSend = useCtrlEnter ? (e.ctrlKey || e.metaKey) : !e.shiftKey;
      if (wantSend) { e.preventDefault(); send(); }
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      vscode.postMessage({ type: 'stop' });
    }
  });

  inputEl.addEventListener('blur', () => setTimeout(hidePopover, 120));

  inputEl.addEventListener('dragover', (e) => { e.preventDefault(); inputEl.classList.add('drag-active'); });
  inputEl.addEventListener('dragleave', () => inputEl.classList.remove('drag-active'));
  inputEl.addEventListener('drop', (e) => {
    e.preventDefault();
    inputEl.classList.remove('drag-active');
    const dt = e.dataTransfer;
    if (!dt) return;
    const uriList = dt.getData('text/uri-list') || dt.getData('application/vnd.code.uri-list');
    if (uriList) {
      const files = uriList.split(/\r?\n/).filter(Boolean).map((u) => {
        try {
          const url = new URL(u);
          const p = decodeURIComponent(url.pathname.replace(/^\/([a-zA-Z]):/, '$1:'));
          return { path: p, name: p.split(/[\\/]/).pop() || p };
        } catch { return null; }
      }).filter(Boolean);
      if (files.length) vscode.postMessage({ type: 'attachFiles', files });
      return;
    }
    const txt = dt.getData('text/plain');
    if (txt) insertText(txt);
  });

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('btn-new').addEventListener('click', () => vscode.postMessage({ type: 'newConversation' }));
  $('btn-resume').addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  $('btn-settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  // Empty-state prompt cards prefill the input.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target instanceof Element) {
      const card = target.closest('.prompt-card');
      if (card) {
        const prompt = card.getAttribute('data-prompt') || '';
        inputEl.value = prompt;
        autoResize();
        inputEl.focus();
        sendBtn.disabled = busy || !prompt.trim();
      }
    }
  });

  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      const value = modelSelect.value;
      currentModel = value;
      vscode.postMessage({ type: 'setModel', model: value === 'default' ? '' : value });
      updateStatus();
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      const value = modeSelect.value;
      currentMode = value;
      vscode.postMessage({ type: 'setPermissionMode', mode: value });
      updateStatus();
    });
  }

  // ---------------------------------------------------------------------------
  // Host -> webview
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'state':
        sessionId = msg.sessionId;
        if (typeof msg.model === 'string') { currentModel = msg.model; syncModelSelect(); }
        if (typeof msg.permissionMode === 'string') { currentMode = msg.permissionMode; syncModeSelect(); }
        setBusy(!!msg.busy);
        return;
      case 'event':
        handleStreamEvent(msg.event);
        return;
      case 'error':
        appendErrorBubble(msg.message || 'unknown error');
        setBusy(false);
        return;
      case 'cleared':
        clearMessages();
        sessionId = null;
        lastResultMeta = '';
        resultMetaInline.textContent = '';
        updateStatus();
        return;
      case 'config': {
        const cfg = msg.config || {};
        useCtrlEnter = !!cfg.useCtrlEnterToSend;
        hideOnboarding = !!cfg.hideOnboarding;
        allowDangerousBypass = !!cfg.allowDangerouslySkipPermissions;
        disableLoginPrompt = !!cfg.disableLoginPrompt;
        updateHint();
        applyConfigToUI();
        return;
      }
      case 'mention':
        insertText(msg.text || '');
        inputEl.focus();
        return;
      case 'fileSuggestions':
        applyFileSuggestions(msg.query, msg.results || []);
        return;
      case 'focus-input':
        inputEl.focus();
        return;
      case 'plan':
        showPlanBanner(msg.markdown || '');
        return;
      case 'diagnostics':
        insertText('Diagnostics:\n```\n' + (msg.text || '') + '\n```\n');
        inputEl.focus();
        return;
      case 'terminalOutput':
        insertText(`Terminal output (${msg.name || 'terminal'}):\n\`\`\`\n` + (msg.text || '') + '\n```\n');
        inputEl.focus();
        return;
    }
  });

  function applyConfigToUI() {
    // Hide the bypassPermissions option from the picker unless the dangerous flag is on.
    if (modeSelect) {
      const opt = modeSelect.querySelector('option[value="bypassPermissions"]');
      if (opt) opt.hidden = !allowDangerousBypass;
    }
    void disableLoginPrompt;
    void hideOnboarding;
  }

  function showPlanBanner(markdown) {
    if (!planBanner) return;
    planBanner.hidden = false;
    planBanner.textContent = '';
    const title = document.createElement('div');
    title.className = 'plan-banner-title';
    title.textContent = 'Plan ready for review';
    const body = document.createElement('pre');
    body.className = 'plan-banner-body';
    body.textContent = truncate(markdown, 4000);
    planBanner.append(title, body);
  }

  function insertText(text) {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? inputEl.value.length;
    inputEl.value = inputEl.value.slice(0, start) + text + inputEl.value.slice(end);
    const newPos = start + text.length;
    inputEl.setSelectionRange(newPos, newPos);
    autoResize();
    sendBtn.disabled = busy || inputEl.value.trim().length === 0;
  }

  updateHint();
  updateStatus();
  vscode.postMessage({ type: 'ready' });
})();
