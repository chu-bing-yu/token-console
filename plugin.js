/*!
 * token-console v1.2.0 — Roche 插件
 * Token 账单：观察页面发往 AI 服务的请求（模型、输入/输出 token、DeepSeek 缓存命中、预估费用、调用位置）。
 * 只记录请求元信息（地址、模型、token 数、调用栈文件名/行号），不保存对话正文，不保存 API Key。
 * 价格：DeepSeek 官方公布价（元 / 百万 tokens），按北京时间高峰 / 空闲自动切换。
 */
(function () {
  'use strict';

  var VERSION = '1.2.0';
  var STYLE_ID = 'rtc-style';
  var LOG_KEY = 'logs';
  var PURGED_KEY = 'purged';
  var SETTINGS_KEY = 'settings';
  var MAX_LOGS = 300;
  var SELF_SRC = (document.currentScript && document.currentScript.src) || '';

  /* ============================== 价格 ============================== */

  var PRICING = {
    flash: {
      name: 'deepseek-flash',
      hit: { peak: 0.04, off: 0.02 },
      miss: { peak: 2, off: 1 },
      out: { peak: 8, off: 4 }
    },
    pro: {
      name: 'deepseek-v4-pro',
      hit: { peak: 0.3, off: 0.15 },
      miss: { peak: 9, off: 4.5 },
      out: { peak: 27, off: 13.5 }
    }
  };

  /** 北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰（不含法定节假日） */
  function isPeak(ts) {
    var d = new Date(ts + 8 * 3600000);
    var day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    var min = d.getUTCHours() * 60 + d.getUTCMinutes();
    return (min >= 540 && min < 720) || (min >= 840 && min < 1080);
  }

  function bandLabel(peak) { return peak ? '高峰' : '空闲'; }

  function clsOf(model) {
    return String(model || '').toLowerCase().indexOf('pro') !== -1 ? 'pro' : 'flash';
  }

  function isDeepseek(host, model) {
    return /deepseek/i.test(String(host || '')) || /deepseek/i.test(String(model || ''));
  }

  function computeCost(rec) {
    // 只对成功的聊天调用估价：生图 / 语音 / 向量按次或字符计费，失败请求不计费
    if (!rec || !rec.deepseek || rec.kind !== 'chat' || !rec.ok) return null;
    var p = PRICING[rec.cls] || PRICING.flash;
    var band = rec.peak ? 'peak' : 'off';
    return (num(rec.hit) * p.hit[band] + num(rec.miss) * p.miss[band] + num(rec.out) * p.out[band]) / 1e6;
  }

  /* ============================== 工具 ============================== */

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function fmtInt(n) {
    var v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtMoney(v) {
    if (v === null || v === undefined) return '—';
    if (!v) return '¥0';
    if (v < 0.00005) return '<¥0.0001';
    if (v < 1) return '¥' + v.toFixed(4);
    return '¥' + v.toFixed(2);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtClock(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtDay(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtMs(ms) {
    var v = Math.max(0, Math.round(Number(ms) || 0));
    if (v < 1000) return v + 'ms';
    return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 's';
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dayStart(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dayEnd(ts) {
    var d = new Date(ts);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function keyToTs(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return 0;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }

  function textOfContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    var out = '';
    for (var i = 0; i < content.length; i++) {
      var part = content[i];
      if (!part) continue;
      if (typeof part === 'string') out += part;
      else if (typeof part.text === 'string') out += part.text;
    }
    return out;
  }

  /** 估算 token：中文 1 字 ≈ 0.6 token，其他 1 字符 ≈ 0.3 token */
  function estimateTokens(text) {
    if (!text) return 0;
    var str = String(text);
    var cjk = 0;
    var other = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
      else if (c === 10 || c === 13 || c === 32 || c === 9) other += 0.5;
      else other += 1;
    }
    return Math.round(cjk * 0.6 + other * 0.3);
  }

  function el(tag, opts, children) {
    var node = document.createElement(tag);
    if (opts) {
      Object.keys(opts).forEach(function (k) {
        var v = opts[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  var ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/></svg>'
  };

  var KIND_LABEL = { chat: '聊天', image: '生图', tts: '语音', embed: '向量' };

  /* ============================== 状态 ============================== */

  var logs = [];
  var purged = {};
  var settings = { range: 'today', start: '', end: '', theme: 'auto' };
  var store = null;
  var hydratedFull = false;
  var subs = [];
  var saveTimer = 0;
  var app = null;

  function normalizeSettings(raw) {
    var out = { range: 'today', start: '', end: '', theme: 'auto' };
    if (!raw || typeof raw !== 'object') return out;
    var ranges = ['today', '7d', '30d', 'all', 'custom'];
    out.range = ranges.indexOf(raw.range) !== -1 ? raw.range : 'today';
    out.start = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.start || '')) ? String(raw.start) : '';
    out.end = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.end || '')) ? String(raw.end) : '';
    out.theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'auto';
    return out;
  }

  function subscribe(fn) {
    subs.push(fn);
    return function () {
      subs = subs.filter(function (item) { return item !== fn; });
    };
  }

  function notify() {
    subs.slice().forEach(function (fn) {
      try { fn(); } catch (e) { console.error('[token-console]', e); }
    });
  }

  function pushRecord(rec) {
    logs.unshift(rec);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    notify();
    scheduleSave();
  }

  function scheduleSave() {
    if (!store || saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      flushSave();
    }, 1000);
  }

  function flushSave() {
    if (!store) return;
    try {
      Promise.resolve(store.set(LOG_KEY, logs.slice(0, MAX_LOGS))).catch(function () {});
      Promise.resolve(store.set(PURGED_KEY, purged)).catch(function () {});
      Promise.resolve(store.set(SETTINGS_KEY, settings)).catch(function () {});
    } catch (e) { /* 存储不可用不影响记录 */ }
  }

  async function readLogsFrom(storageLike) {
    if (!storageLike) return;
    try {
      var savedLogs = await storageLike.get(LOG_KEY);
      if (Array.isArray(savedLogs)) logs = mergeLogs(savedLogs, logs);
    } catch (e) { /* ignore */ }
  }

  async function hydrateApp(rocheLike) {
    if (!rocheLike || !rocheLike.storage) return;
    store = rocheLike.storage;
    await readLogsFrom(store);
    if (hydratedFull) return;
    hydratedFull = true;

    try {
      var savedPurged = await store.get(PURGED_KEY);
      if (savedPurged && typeof savedPurged === 'object' && !Array.isArray(savedPurged)) purged = savedPurged;
    } catch (e) { /* ignore */ }

    try {
      var savedSettings = await store.get(SETTINGS_KEY);
      if (savedSettings) settings = normalizeSettings(savedSettings);
    } catch (e) { /* ignore */ }
  }

  /** 「+」面板只读：不清空全局 store，避免写到别的存储作用域 */
  async function hydrateReadOnly(rocheLike) {
    if (!rocheLike || !rocheLike.storage) return;
    var storageLike = rocheLike.storage;
    await readLogsFrom(storageLike);
    if (hydratedFull) return;
    try {
      var savedPurged = await storageLike.get(PURGED_KEY);
      if (savedPurged && typeof savedPurged === 'object' && !Array.isArray(savedPurged)) purged = savedPurged;
    } catch (e) { /* ignore */ }
  }

  function mergeLogs(a, b) {
    var seen = {};
    var out = [];
    a.concat(b).forEach(function (rec) {
      if (!rec || !rec.id || seen[rec.id]) return;
      seen[rec.id] = true;
      rec.cost = computeCost(rec);
      out.push(rec);
    });
    out.sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
    return out.slice(0, MAX_LOGS);
  }

  /* ============================== 统计 ============================== */

  var RANGES = [
    { id: 'today', label: '今天' },
    { id: '7d', label: '近 7 天' },
    { id: '30d', label: '近 30 天' },
    { id: 'all', label: '全部' },
    { id: 'custom', label: '自定义' }
  ];

  function resolveRange(cfg, now) {
    var id = (cfg && cfg.range) || 'today';
    var from = dayStart(now);
    var to = dayEnd(now);
    var label = '今天';

    if (id === '7d') {
      from = dayStart(now - 6 * 86400000);
      label = '近 7 天';
    } else if (id === '30d') {
      from = dayStart(now - 29 * 86400000);
      label = '近 30 天';
    } else if (id === 'all') {
      from = 0;
      label = '全部';
    } else if (id === 'custom') {
      var s = keyToTs(cfg.start) || dayStart(now);
      var e = keyToTs(cfg.end) || dayStart(now);
      if (e < s) { var tmp = s; s = e; e = tmp; }
      from = s;
      to = dayEnd(e);
      label = fmtDay(s) + ' - ' + fmtDay(e);
    }

    return { id: id, from: from, to: to, label: label };
  }

  function emptyStat() { return { calls: 0, fail: 0, prompt: 0, hit: 0, out: 0, cost: 0, priced: 0 }; }

  function addRecord(stat, rec) {
    stat.calls += 1;
    if (!rec.ok) stat.fail += 1;
    stat.prompt += num(rec.prompt);
    stat.hit += num(rec.hit);
    stat.out += num(rec.out);
    if (rec.cost !== null && rec.cost !== undefined) {
      stat.cost += rec.cost;
      stat.priced += 1;
    }
  }

  function addBucket(stat, bucket) {
    if (!bucket) return;
    stat.calls += num(bucket.calls);
    stat.fail += num(bucket.fail);
    stat.prompt += num(bucket.prompt);
    stat.hit += num(bucket.hit);
    stat.out += num(bucket.out);
    stat.cost += num(bucket.cost);
    stat.priced += num(bucket.priced);
  }

  function recordsIn(from, to) {
    return logs.filter(function (rec) { return rec.at >= from && rec.at <= to; });
  }

  /** 统计 = 明细 + 已清除的日期汇总，所以清除明细后次数与 token 不变 */
  function statsIn(from, to) {
    var stat = emptyStat();
    recordsIn(from, to).forEach(function (rec) { addRecord(stat, rec); });
    Object.keys(purged).forEach(function (key) {
      var ts = keyToTs(key);
      if (!ts || ts < from || ts > to) return;
      addBucket(stat, purged[key]);
    });
    return stat;
  }

  function purgedCallsIn(from, to) {
    var total = 0;
    Object.keys(purged).forEach(function (key) {
      var ts = keyToTs(key);
      if (!ts || ts < from || ts > to) return;
      total += num(purged[key].calls);
    });
    return total;
  }

  /** 清除某个范围的明细：折叠进按天的汇总，统计总数保持不变 */
  function purgeRange(from, to) {
    var keep = [];
    var removed = 0;
    logs.forEach(function (rec) {
      if (rec.at < from || rec.at > to) { keep.push(rec); return; }
      removed += 1;
      var key = dayKey(rec.at);
      var bucket = purged[key] || { calls: 0, fail: 0, prompt: 0, hit: 0, out: 0, cost: 0, priced: 0 };
      bucket.calls += 1;
      if (!rec.ok) bucket.fail += 1;
      bucket.prompt += num(rec.prompt);
      bucket.hit += num(rec.hit);
      bucket.out += num(rec.out);
      if (rec.cost !== null && rec.cost !== undefined) {
        bucket.cost += rec.cost;
        bucket.priced += 1;
      }
      purged[key] = bucket;
    });
    logs = keep;
    notify();
    flushSave();
    return removed;
  }

  /* ============================== 请求识别 ============================== */

  var AI_HOSTS = [
    'deepseek', 'openai', 'anthropic', 'openrouter', 'siliconflow', 'moonshot',
    'bigmodel', 'groq', 'x.ai', 'volces', 'together.xyz', 'mistral', 'cohere',
    'stepfun', 'baichuan', 'lingyiwanwu', 'dashscope', 'minimax', 'hunyuan',
    'perplexity', 'elevenlabs', 'generativelanguage', '302.ai', 'jiuzhan',
    'jina.ai', 'gemini'
  ];

  var AI_PATHS = [
    /chat\/completions/i, /chatcompletion/i, /completions/i, /\/messages/i,
    /generatecontent/i, /embeddings?/i, /images?\/(generations|edits)/i,
    /audio\/(speech|transcriptions)/i, /text-to-speech/i, /\/responses/i
  ];

  // 中转站 / 自建代理域名不固定，命中这些路径就直接当 AI 请求
  var AI_PATHS_STRONG = [
    /chat\/completions/i, /chatcompletion/i, /generatecontent/i, /\/responses$/i
  ];

  function absolute(url) {
    try { return new URL(url, location.href).href; } catch (e) { return String(url || ''); }
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      if (input && typeof input.href === 'string') return input.href;
    } catch (e) { /* ignore */ }
    return '';
  }

  function hostOf(url) {
    try { return new URL(url, location.href).host; } catch (e) { return ''; }
  }

  function pathOf(url) {
    try { return new URL(url, location.href).pathname; } catch (e) { return ''; }
  }

  function isAiRequest(url) {
    if (!url) return false;
    var host = hostOf(url).toLowerCase();
    var path = pathOf(url);
    if (!host) return false;
    if (AI_PATHS_STRONG.some(function (re) { return re.test(path); })) return true;
    var hostHit = AI_HOSTS.some(function (item) { return host.indexOf(item) !== -1; });
    if (!hostHit) return false;
    return AI_PATHS.some(function (re) { return re.test(path); });
  }

  function kindOf(path) {
    var p = String(path || '').toLowerCase();
    if (/image/.test(p)) return 'image';
    if (/audio|speech|tts/.test(p)) return 'tts';
    if (/embedding/.test(p)) return 'embed';
    return 'chat';
  }

  function modelOf(body) {
    if (!body) return '';
    try {
      var data = JSON.parse(body);
      if (data && typeof data.model === 'string') return data.model.slice(0, 60);
      if (data && data.model && typeof data.model === 'object') return String(data.model.name || '').slice(0, 60);
    } catch (e) { /* 不是 JSON */ }
    var m = String(body).match(/"model"\s*:\s*"([^"]{1,60})"/);
    return m ? m[1] : '';
  }

  /** 请求体像不像一次 LLM 调用：有 model 字段 + messages/contents/prompt/input */
  function looksLikeLlmBody(text) {
    if (!text) return false;
    var s = String(text);
    if (s.length > 3145728) return false;
    var data = null;
    if (s.charAt(0) === '{') {
      try { data = JSON.parse(s); } catch (e) { data = null; }
    }
    if (data && typeof data === 'object') {
      var hasModel = typeof data.model === 'string' && !!data.model;
      var hasMsgs = Array.isArray(data.messages) || Array.isArray(data.contents) ||
        typeof data.prompt === 'string' || typeof data.input === 'string';
      return hasModel && hasMsgs;
    }
    return /"model"\s*:\s*"[^"]{1,80}"/.test(s) &&
      (/"messages"\s*:/.test(s) || /"contents"\s*:/.test(s) || /"prompt"\s*:/.test(s));
  }

  function promptTokensFromBody(body) {
    if (!body) return { tokens: 0, messages: 0 };
    var data = null;
    try { data = JSON.parse(body); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') return { tokens: estimateTokens(body), messages: 0 };

    var parts = [];
    var count = 0;
    if (Array.isArray(data.messages)) {
      data.messages.forEach(function (m) {
        if (!m) return;
        count++;
        var t = textOfContent(m.content);
        if (t) parts.push(t);
      });
    }
    if (typeof data.system === 'string') parts.push(data.system);
    if (typeof data.prompt === 'string') parts.push(data.prompt);
    if (typeof data.input === 'string') parts.push(data.input);
    if (Array.isArray(data.contents)) {
      data.contents.forEach(function (c) {
        if (c && Array.isArray(c.parts)) {
          c.parts.forEach(function (p) { if (p && typeof p.text === 'string') parts.push(p.text); });
        }
      });
    }
    return { tokens: estimateTokens(parts.join('\n')) + count * 4, messages: count };
  }

  function parseResponse(text) {
    var out = { usage: null, model: '', text: '' };
    if (!text) return out;
    var s = String(text).trim();
    if (!s) return out;

    if (s.charAt(0) === '{') {
      var json = null;
      try { json = JSON.parse(s); } catch (e) { json = null; }
      if (json) {
        out.usage = json.usage || (json.response && json.response.usage) || null;
        if (typeof json.model === 'string') out.model = json.model;
        var choice = json.choices && json.choices[0];
        if (choice) out.text = textOfContent(choice.message ? choice.message.content : choice.text);
        if (!out.text && typeof json.output_text === 'string') out.text = json.output_text;
        if (!out.text && Array.isArray(json.content)) out.text = textOfContent(json.content);
        if (!out.text && json.candidates && json.candidates[0]) {
          var c0 = json.candidates[0];
          if (c0 && c0.content) {
            out.text = Array.isArray(c0.content.parts)
              ? textOfContent(c0.content.parts.map(function (p) { return p && p.text ? p.text : ''; }))
              : textOfContent(c0.content);
          }
        }
        return out;
      }
    }

    var lines = s.split('\n');
    var chunks = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === ':') continue;
      var payload = '';
      if (line.indexOf('data:') === 0) payload = line.slice(5).trim();
      else if (line.charAt(0) === '{') payload = line;
      if (!payload || payload === '[DONE]') continue;
      var obj = null;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      if (!obj) continue;
      if (typeof obj.model === 'string' && !out.model) out.model = obj.model;
      if (obj.usage) out.usage = obj.usage;
      if (obj.response && obj.response.usage) out.usage = obj.response.usage;
      var ch = obj.choices && obj.choices[0];
      if (ch) {
        var d = ch.delta || ch.message;
        if (d) chunks.push(textOfContent(d.content));
        if (typeof ch.text === 'string') chunks.push(ch.text);
      }
      if (obj.delta && typeof obj.delta.text === 'string') chunks.push(obj.delta.text);
    }
    out.text = chunks.join('');
    return out;
  }

  function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    var prompt = num(usage.prompt_tokens) || num(usage.input_tokens);
    var outTok = num(usage.completion_tokens) || num(usage.output_tokens);
    var cachedRead = num(usage.cache_read_input_tokens);
    var cachedWrite = num(usage.cache_creation_input_tokens);
    var hit = num(usage.prompt_cache_hit_tokens) || cachedRead;
    if (!hit && usage.prompt_tokens_details) hit = num(usage.prompt_tokens_details.cached_tokens);
    var miss = num(usage.prompt_cache_miss_tokens);
    if (cachedRead || cachedWrite) prompt = prompt + cachedRead + cachedWrite;
    if (!prompt) prompt = hit + miss;
    if (!miss) miss = Math.max(0, prompt - hit);
    if (!prompt && !outTok) return null;
    return { prompt: prompt, hit: hit, miss: miss, out: outTok };
  }

  function readBody(input, init) {
    try {
      if (init && init.body !== null && init.body !== undefined) {
        if (typeof init.body === 'string') return Promise.resolve(init.body);
        if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
          return Promise.resolve(init.body.toString());
        }
      }
      if (input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.text === 'function') {
        return input.clone().text();
      }
    } catch (e) { /* 读不到就算了 */ }
    return Promise.resolve('');
  }

  function fileOf(url) {
    var s = String(url || '').split('?')[0].split('#')[0];
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function isSelfUrl(url) {
    if (!url) return false;
    if (SELF_SRC && (url === SELF_SRC || fileOf(url) === fileOf(SELF_SRC))) return true;
    return /token-console/i.test(url);
  }

  /** 调用位置：从错误栈里取出前几帧（跳过插件自己） */
  function callFrames() {
    var stack = '';
    try { throw new Error('rtc'); } catch (e) { stack = e && e.stack ? String(e.stack) : ''; }
    if (!stack) return [];
    var out = [];
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length && out.length < 4; i++) {
      var m = lines[i].match(/(https?:\/\/[^\s()]+|[^\s()]+\.js):(\d+):(\d+)/);
      if (!m || isSelfUrl(m[1])) continue;
      var frame = { file: fileOf(m[1]), line: Number(m[2]) };
      var last = out[out.length - 1];
      if (last && last.file === frame.file && last.line === frame.line) continue;
      out.push(frame);
    }
    return out;
  }

  function callerText(rec) {
    var f = rec.frames && rec.frames[0];
    return f ? f.file + ':' + f.line : '页面脚本';
  }

  /* ============================== 拦截 fetch ============================== */

  var hooked = false;

  function applyParsed(rec, parsed, usage) {
    if (parsed.model) rec.model = rec.model || parsed.model;
    rec.deepseek = isDeepseek(rec.host, rec.model);
    rec.cls = clsOf(rec.model);
    var u = usage;
    if (u && (u.prompt || u.out)) {
      rec.prompt = u.prompt || rec.prompt;
      rec.hit = u.hit;
      rec.miss = u.miss || Math.max(0, (u.prompt || rec.prompt) - u.hit);
      rec.out = u.out;
      rec.estimated = false;
    } else {
      rec.estimated = true;
      rec.hit = 0;
      rec.miss = rec.prompt;
      rec.out = estimateTokens(parsed.text);
    }
  }

  function applyResponseText(rec, text) {
    var parsed = parseResponse(text);
    applyParsed(rec, parsed, normalizeUsage(parsed.usage));
  }

  function finalize(rec) {
    if (rec.done) return;
    rec.done = true;
    rec.elapsedMs = Math.max(0, Date.now() - rec.at);
    rec.cost = computeCost(rec);
    rec.id = 'r_' + rec.at.toString(36) + Math.random().toString(36).slice(2, 6);
    pushRecord(rec);
  }

  function makeRec(method, url, startedAt) {
    var path = pathOf(url);
    return {
      at: startedAt,
      url: absolute(url),
      host: hostOf(url),
      path: path,
      method: String(method || 'GET').toUpperCase(),
      frames: callFrames(),
      kind: kindOf(path),
      status: 0,
      ok: true,
      stream: false,
      model: '',
      deepseek: false,
      cls: 'flash',
      peak: isPeak(startedAt),
      prompt: 0,
      hit: 0,
      miss: 0,
      out: 0,
      messages: 0,
      estimated: true,
      elapsedMs: 0,
      cost: null,
      error: '',
      tentative: false,
      needsUsage: false
    };
  }

  function collect(rec, bodyPromise, resPromise) {
    Promise.resolve(bodyPromise).then(function (body) {
      var bodyText = String(body || '');
      rec.stream = /"stream"\s*:\s*true/.test(bodyText);
      rec.model = modelOf(bodyText);
      rec.deepseek = isDeepseek(rec.host, rec.model);
      rec.cls = clsOf(rec.model);
      var promptInfo = promptTokensFromBody(bodyText);
      rec.prompt = promptInfo.tokens;
      rec.miss = promptInfo.tokens;
      rec.messages = promptInfo.messages;

      // 探测请求：请求体不像 LLM 时，只有响应带 usage 才确认是 AI 调用
      var bodyLooksLlm = looksLikeLlmBody(bodyText);
      if (rec.tentative) {
        if (bodyLooksLlm) rec.tentative = false;
        else rec.needsUsage = true;
      }

      return Promise.resolve(resPromise).then(function (res) {
        rec.status = res && res.status ? res.status : 0;
        rec.ok = !!(res && res.ok);

        // 生图、语音返回二进制，读 body 只为浪费内存，直接记元信息
        if (rec.kind === 'image' || rec.kind === 'tts') {
          if (rec.needsUsage) return null;
          rec.estimated = false;
          finalize(rec);
          return null;
        }

        var clone = null;
        try {
          clone = res && typeof res.clone === 'function' ? res.clone() : null;
        } catch (e) { clone = null; }
        if (!clone || typeof clone.text !== 'function') {
          if (!rec.needsUsage) finalize(rec);
          return null;
        }

        // 探测请求别去读超大响应
        if (rec.needsUsage) {
          var len = Number(res && res.headers && res.headers.get('content-length')) || 0;
          if (len > 3145728) return null;
        }

        return clone.text().then(function (text) {
          var parsed = parseResponse(text);
          var u = normalizeUsage(parsed.usage);
          if (rec.needsUsage && !u) return null; // 不是 AI 接口，丢弃
          applyParsed(rec, parsed, u);
          finalize(rec);
        }, function () {
          if (!rec.needsUsage) finalize(rec);
        });
      });
    }).catch(function (err) {
      if (rec.needsUsage) return;
      rec.ok = false;
      rec.error = String((err && err.message) || err || '请求失败').slice(0, 120);
      finalize(rec);
    });
  }

  var hookedXhr = false;

  /** 有些插件用 axios/XHR 自己调 AI，把 XHR 也补上 */
  function installXhrHook() {
    if (hookedXhr) return;
    var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__rtcHooked || typeof proto.open !== 'function' || typeof proto.send !== 'function') return;
    hookedXhr = true;

    var openOrig = proto.open;
    var sendOrig = proto.send;

    proto.open = function (method, url) {
      try {
        this.__rtcInfo = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      } catch (e) { /* ignore */ }
      return openOrig.apply(this, arguments);
    };

    proto.send = function (body) {
      var xhr = this;
      var info = xhr.__rtcInfo;
      if (info && isAiRequest(info.url)) {
        var startedAt = Date.now();
        var rec = makeRec(info.method, info.url, startedAt);
        rec.prompt = promptTokensFromBody(typeof body === 'string' ? body : '').tokens;
        rec.miss = rec.prompt;
        var done = false;
        var onDone = function () {
          if (done) return;
          done = true;
          rec.status = xhr.status || 0;
          rec.ok = xhr.status >= 200 && xhr.status < 300;
          var text = '';
          try {
            if (rec.kind !== 'image' && rec.kind !== 'tts' && typeof xhr.responseText === 'string') {
              text = xhr.responseText;
            }
          } catch (e) { text = ''; }
          applyResponseText(rec, text);
          finalize(rec);
        };
        try { xhr.addEventListener('loadend', onDone); } catch (e) { /* ignore */ }
      }
      return sendOrig.apply(this, arguments);
    };

    proto.__rtcHooked = true;
  }

  function installHook() {
    if (hooked) { installXhrHook(); return; }
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    var orig = window.fetch;
    if (orig.__rtcHooked) { hooked = true; installXhrHook(); return; }
    hooked = true;

    var patched = function (input, init) {
      var url = urlOf(input);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var startedAt = Date.now();

      if (isAiRequest(url)) {
        var rec = makeRec(method, url, startedAt);
        var bodyPromise = readBody(input, init);
        var resPromise;
        try {
          resPromise = orig.call(this, input, init);
        } catch (err) {
          rec.ok = false;
          rec.error = String((err && err.message) || err || '请求失败').slice(0, 120);
          finalize(rec);
          throw err;
        }
        collect(rec, bodyPromise, resPromise);
        return resPromise;
      }

      // 未知域名 / 路径的中转站：POST 时先读请求体，像 LLM 调用就记下来
      var res = orig.call(this, input, init);
      if ((method === 'POST' || method === 'PUT') && url) {
        var probe = makeRec(method, url, startedAt);
        probe.tentative = true;
        collect(probe, readBody(input, init), res);
      }
      return res;
    };

    patched.__rtcHooked = true;
    window.fetch = patched;
    installXhrHook();
  }

  /* ============================== 样式 ============================== */

  var CSS = [
    '.rtc-root,.rtc-mask{',
    '--rtc-bg:#ffffff;--rtc-soft:#f6f7f9;--rtc-soft-2:#eef0f3;--rtc-line:#ecedf0;--rtc-line-strong:#dcdee3;',
    '--rtc-ink:#1b1c1f;--rtc-ink-2:#55585e;--rtc-muted:#8b9099;--rtc-accent:#1b1c1f;--rtc-on-accent:#ffffff;',
    '--rtc-warn:#b03a2e;--rtc-warn-bg:#fdecea;--rtc-radius:12px;',
    '--rtc-font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;',
    '--rtc-mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;',
    '}',
    '.rtc-root[data-theme="dark"],.rtc-mask[data-theme="dark"]{',
    '--rtc-bg:#151619;--rtc-soft:#1d1f23;--rtc-soft-2:#24262b;--rtc-line:#2a2d33;--rtc-line-strong:#383c43;',
    '--rtc-ink:#f2f3f5;--rtc-ink-2:#c2c6cd;--rtc-muted:#8c919b;--rtc-accent:#f2f3f5;--rtc-on-accent:#151619;',
    '--rtc-warn:#ff8a80;--rtc-warn-bg:#3a201d;',
    '}',
    '.rtc-root *,.rtc-mask *{box-sizing:border-box;}',
    '.rtc-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;',
    'overflow:hidden;background:var(--rtc-bg);color:var(--rtc-ink);font-family:var(--rtc-font);-webkit-font-smoothing:antialiased;}',
    '.rtc-header{flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;padding:12px 16px 8px;}',
    '.rtc-header__text{flex:1 1 auto;min-width:0;}',
    '.rtc-title{margin:0;font-size:17px;font-weight:600;letter-spacing:.01em;}',
    '.rtc-sub{margin:2px 0 0;font-size:11.5px;color:var(--rtc-muted);}',
    '.rtc-header__actions{flex:0 0 auto;display:flex;gap:6px;}',
    '.rtc-iconbtn{width:32px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;',
    'border:0;border-radius:999px;background:var(--rtc-soft);color:var(--rtc-ink-2);cursor:pointer;}',
    '.rtc-iconbtn:hover{background:var(--rtc-soft-2);}',
    '.rtc-iconbtn svg{width:17px;height:17px;}',
    '.rtc-iconbtn--close{background:transparent;}',
    '.rtc-body{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px 20px;}',
    '.rtc-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}',
    '.rtc-tile{display:flex;flex-direction:column;gap:1px;padding:9px 4px;border-radius:var(--rtc-radius);',
    'background:var(--rtc-soft);text-align:center;}',
    '.rtc-tile b{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;}',
    '.rtc-tile span{font-size:9.5px;color:var(--rtc-muted);}',
    '.rtc-toolbar{display:flex;align-items:center;gap:8px;margin:14px 0 2px;}',
    '.rtc-chips{display:flex;flex:1 1 auto;flex-wrap:wrap;gap:6px;}',
    '.rtc-chip{padding:5px 10px;border:1px solid var(--rtc-line);border-radius:999px;background:transparent;',
    'color:var(--rtc-muted);font:500 11.5px/1 var(--rtc-font);cursor:pointer;}',
    '.rtc-chip.is-active{background:var(--rtc-accent);border-color:var(--rtc-accent);color:var(--rtc-on-accent);}',
    '.rtc-rangebtn{flex:0 0 auto;display:inline-flex;align-items:center;gap:3px;padding:5px 2px;border:0;background:none;',
    'color:var(--rtc-ink-2);font:500 11.5px/1 var(--rtc-font);cursor:pointer;}',
    '.rtc-rangebtn::after{content:"▾";font-size:10px;opacity:.6;margin-left:1px;}',
    '.rtc-list{min-height:0;}',
    '.rtc-row{padding:10px 2px;border-bottom:1px solid var(--rtc-line);cursor:pointer;}',
    '.rtc-row:last-child{border-bottom:0;}',
    '.rtc-row--mini{cursor:default;padding:8px 2px;}',
    '.rtc-row__head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
    '.rtc-row__time{font-size:12px;font-variant-numeric:tabular-nums;}',
    '.rtc-row__badge{padding:1px 6px;border-radius:999px;background:var(--rtc-soft-2);color:var(--rtc-ink-2);font-size:10px;}',
    '.rtc-row__badge.is-fail{background:var(--rtc-warn-bg);color:var(--rtc-warn);}',
    '.rtc-row__model{max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:10.5px;color:var(--rtc-muted);}',
    '.rtc-row__cost{margin-left:auto;font-size:11.5px;font-variant-numeric:tabular-nums;}',
    '.rtc-row__meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:3px;font-size:10.5px;color:var(--rtc-muted);}',
    '.rtc-row__meta--dim{opacity:.85;}',
    '.rtc-row__more{margin-left:auto;color:var(--rtc-muted);opacity:.75;}',
    '.rtc-row__detail{display:none;margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--rtc-soft);',
    'font:10.5px/1.7 var(--rtc-mono);color:var(--rtc-ink-2);white-space:pre-wrap;word-break:break-all;}',
    '.rtc-row.is-open .rtc-row__detail{display:block;}',
    '.rtc-empty{padding:34px 8px;text-align:center;color:var(--rtc-muted);font-size:12px;line-height:1.9;}',
    '.rtc-empty div:last-child{margin-top:4px;font-size:11px;opacity:.85;}',
    '.rtc-footmargin{margin:10px 0 0;font-size:10.5px;color:var(--rtc-muted);text-align:center;}',
    '.rtc-pricebar{margin:12px 0 0;padding:8px 10px;border-radius:10px;background:var(--rtc-soft);',
    'font-size:10px;line-height:1.7;color:var(--rtc-muted);white-space:pre-line;}',
    '.rtc-note{margin:10px 0 0;font-size:10.5px;line-height:1.7;color:var(--rtc-muted);}',
    '.rtc-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
    'padding:24px;background:rgba(18,19,22,.38);font-family:var(--rtc-font);animation:rtc-fade .15s ease;}',
    '@keyframes rtc-fade{from{opacity:0}to{opacity:1}}',
    '.rtc-dialog{display:flex;flex-direction:column;width:100%;max-width:340px;max-height:82vh;padding:18px 16px 14px;',
    'border-radius:20px;background:var(--rtc-bg);color:var(--rtc-ink);box-shadow:0 18px 44px rgba(17,18,20,.2);',
    'animation:rtc-pop .16s ease;}',
    '@keyframes rtc-pop{from{transform:translateY(6px) scale(.98);opacity:.6}to{transform:none;opacity:1}}',
    '.rtc-dialog__head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
    '.rtc-dialog__title{flex:1 1 auto;margin:0;font-size:15.5px;font-weight:600;}',
    '.rtc-dialog__sub{margin:0 0 10px;font-size:11px;color:var(--rtc-muted);}',
    '.rtc-dialog__body{min-height:0;overflow-y:auto;font-size:12.5px;color:var(--rtc-ink-2);}',
    '.rtc-field{margin-bottom:14px;}',
    '.rtc-field__label{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11px;color:var(--rtc-muted);}',
    '.rtc-input{width:100%;padding:8px 10px;border:1px solid var(--rtc-line-strong);border-radius:10px;',
    'background:var(--rtc-soft);color:var(--rtc-ink);font:400 13px/1.4 var(--rtc-font);outline:none;}',
    '.rtc-input:focus{border-color:var(--rtc-ink-2);}',
    '.rtc-daterow{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--rtc-muted);}',
    '.rtc-daterow .rtc-input{flex:1 1 0;min-width:0;}',
    '.rtc-actions{display:flex;gap:8px;margin-top:14px;}',
    '.rtc-btn{flex:1 1 0;padding:9px 12px;border:1px solid var(--rtc-line-strong);border-radius:999px;background:transparent;',
    'color:var(--rtc-ink);font:500 12.5px/1 var(--rtc-font);cursor:pointer;}',
    '.rtc-btn--primary{background:var(--rtc-accent);border-color:var(--rtc-accent);color:var(--rtc-on-accent);}',
    '.rtc-btn--danger{color:var(--rtc-warn);border-color:var(--rtc-warn);background:transparent;}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function removeStyle() {
    var style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  /* ============================== 主题 ============================== */

  function detectTheme() {
    try {
      var docEl = document.documentElement;
      var bodyEl = document.body;
      var attr = docEl.getAttribute('data-theme') || (bodyEl && bodyEl.getAttribute('data-theme')) || '';
      if (/dark/i.test(attr)) return 'dark';
      if (/light/i.test(attr)) return 'light';
      if (docEl.classList.contains('dark') || (bodyEl && bodyEl.classList.contains('dark'))) return 'dark';
      var bg = getComputedStyle(bodyEl || docEl).backgroundColor;
      var m = bg && bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        var p = m[1].split(',').map(Number);
        var lum = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;
        var alpha = p.length > 3 ? p[3] : 1;
        if (alpha > 0.5 && lum < 0.45) return 'dark';
      }
    } catch (e) { /* 检测失败按浅色 */ }
    return 'light';
  }

  function currentTheme() {
    return settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : detectTheme();
  }

  /* ============================== 弹层基础 ============================== */

  var openDialogs = [];

  function closeDialogs() {
    openDialogs.slice().forEach(function (fn) {
      try { fn(); } catch (e) { /* ignore */ }
    });
    openDialogs = [];
  }

  /** 通用弹层：title / subtitle / build(bodyEl, close) / actions */
  function openDialog(opts) {
    ensureStyle();

    var overlay = el('div', { class: 'rtc-mask', 'data-theme': currentTheme() });

    function destroy() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      openDialogs = openDialogs.filter(function (fn) { return fn !== destroy; });
    }

    function onKey(e) {
      if (e.key === 'Escape') destroy();
    }

    var closeBtn = el('button', {
      class: 'rtc-iconbtn', type: 'button', title: '关闭', 'aria-label': '关闭', html: ICONS.close
    });
    closeBtn.addEventListener('click', destroy);

    var bodyEl = el('div', { class: 'rtc-dialog__body' });
    if (typeof opts.build === 'function') opts.build(bodyEl, destroy);

    var actions = (opts.actions || [{ label: '关闭', value: 'close', primary: true }]).map(function (item) {
      var btn = el('button', {
        class: 'rtc-btn' + (item.primary ? ' rtc-btn--primary' : '') + (item.danger ? ' rtc-btn--danger' : ''),
        type: 'button',
        text: item.label
      });
      btn.addEventListener('click', function () {
        if (typeof item.onClick === 'function') item.onClick(destroy);
        else destroy();
      });
      return btn;
    });

    overlay.appendChild(el('div', { class: 'rtc-dialog' }, [
      el('div', { class: 'rtc-dialog__head' }, [
        el('h2', { class: 'rtc-dialog__title', text: opts.title || '' }),
        closeBtn
      ]),
      opts.subtitle ? el('p', { class: 'rtc-dialog__sub', text: opts.subtitle }) : null,
      bodyEl,
      el('div', { class: 'rtc-actions' }, actions)
    ]));

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) destroy();
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    openDialogs.push(destroy);
    return destroy;
  }

  /* ============================== 共用渲染 ============================== */

  function kindText(rec) {
    if (!rec.ok) return '失败';
    return KIND_LABEL[rec.kind] || 'AI';
  }

  function costText(rec) {
    return rec.cost === null || rec.cost === undefined ? '—' : fmtMoney(rec.cost);
  }

  function summaryChildren(stat) {
    var ratio = stat.prompt ? Math.round(stat.hit / stat.prompt * 100) + '%' : '—';
    var cost = stat.priced ? fmtMoney(stat.cost) : '—';
    return [
      el('div', { class: 'rtc-tile' }, [el('b', { text: fmtInt(stat.calls) }), el('span', { text: '调用' })]),
      el('div', { class: 'rtc-tile' }, [el('b', { text: fmtInt(stat.prompt + stat.out) }), el('span', { text: 'Token' })]),
      el('div', { class: 'rtc-tile' }, [el('b', { text: ratio }), el('span', { text: '缓存命中' })]),
      el('div', { class: 'rtc-tile' }, [el('b', { text: cost }), el('span', { text: '预估费用' })])
    ];
  }

  function detailText(rec) {
    var lines = [];
    lines.push(rec.method + ' ' + rec.url);
    lines.push('状态 ' + (rec.status || '—') + ' · 耗时 ' + fmtMs(rec.elapsedMs) + ' · ' +
      (rec.stream ? '流式' : '非流式') + ' · 模型 ' + (rec.model || '未知'));
    if (rec.kind === 'image' || rec.kind === 'tts' || rec.kind === 'embed') {
      lines.push('生图 / 语音 / 向量接口不按 token 计价，只记录调用');
    } else if (!rec.ok) {
      lines.push('调用失败，不计费 · 输入 ' + fmtInt(rec.prompt) + '（估算）');
    } else if (rec.deepseek) {
      var p = PRICING[rec.cls] || PRICING.flash;
      var band = rec.peak ? 'peak' : 'off';
      lines.push('单价（' + p.name + ' · ' + bandLabel(rec.peak) + '）命中 ¥' + p.hit[band] +
        ' / 未命中 ¥' + p.miss[band] + ' / 输出 ¥' + p.out[band] + ' 每百万 tokens');
      lines.push('命中 ' + fmtInt(rec.hit) + ' · 未命中 ' + fmtInt(rec.miss) + ' · 输出 ' + fmtInt(rec.out) +
        (rec.estimated ? '（估算）' : '（接口返回）') + ' · 费用 ' + fmtMoney(rec.cost));
    } else {
      lines.push('该服务不在 DeepSeek 价格表内，只统计 token：输入 ' + fmtInt(rec.prompt) +
        ' · 输出 ' + fmtInt(rec.out) + (rec.estimated ? '（估算）' : ''));
    }
    if (rec.messages) lines.push('上下文 ' + rec.messages + ' 条消息');
    if (rec.error) lines.push('错误：' + rec.error);
    (rec.frames || []).slice(0, 3).forEach(function (f, i) {
      lines.push('调用位置 ' + (i + 1) + '：' + f.file + ':' + f.line);
    });
    lines.push('点这一行可收起');
    return lines.join('\n');
  }

  function fullRow(rec) {
    var row = el('div', { class: 'rtc-row' }, [
      el('div', { class: 'rtc-row__head' }, [
        el('span', { class: 'rtc-row__time', text: fmtClock(rec.at) }),
        el('span', { class: 'rtc-row__badge' + (rec.ok ? '' : ' is-fail'), text: kindText(rec) }),
        el('span', { class: 'rtc-row__model', text: rec.model || rec.host || '未知模型' }),
        el('span', { class: 'rtc-row__cost', text: costText(rec) })
      ]),
      el('div', { class: 'rtc-row__meta' }, [
        el('span', { text: rec.host || '未知服务' }),
        el('span', { text: '输入 ' + fmtInt(rec.prompt) + (num(rec.hit) ? ' · 缓存 ' + fmtInt(rec.hit) : '') }),
        el('span', { text: '输出 ' + fmtInt(rec.out) }),
        el('span', { text: fmtMs(rec.elapsedMs) })
      ]),
      el('div', { class: 'rtc-row__meta rtc-row__meta--dim' }, [
        el('span', { text: '来源 ' + callerText(rec) }),
        rec.estimated ? el('span', { text: '≈ 估算' }) : null,
        rec.stream ? el('span', { text: '流式' }) : null,
        el('span', { class: 'rtc-row__more', text: '详情' })
      ]),
      el('div', { class: 'rtc-row__detail', text: detailText(rec) })
    ]);
    row.addEventListener('click', function () {
      row.classList.toggle('is-open');
    });
    return row;
  }

  function miniRow(rec) {
    return el('div', { class: 'rtc-row rtc-row--mini' }, [
      el('div', { class: 'rtc-row__head' }, [
        el('span', { class: 'rtc-row__time', text: fmtClock(rec.at) }),
        el('span', { class: 'rtc-row__badge' + (rec.ok ? '' : ' is-fail'), text: kindText(rec) }),
        el('span', { class: 'rtc-row__model', text: rec.model || rec.host || '未知模型' }),
        el('span', { class: 'rtc-row__cost', text: costText(rec) })
      ]),
      el('div', { class: 'rtc-row__meta' }, [
        el('span', { text: '入 ' + fmtInt(rec.prompt) + (num(rec.hit) ? '（缓存 ' + fmtInt(rec.hit) + '）' : '') }),
        el('span', { text: '出 ' + fmtInt(rec.out) }),
        el('span', { text: rec.host || '' }),
        el('span', { text: fmtMs(rec.elapsedMs) })
      ])
    ]);
  }

  /* ============================== 「+」面板账单 ============================== */

  async function openBill(roche) {
    await hydrateReadOnly(roche);

    var now = Date.now();
    var range = { from: dayStart(now), to: dayEnd(now), label: '今天' };
    var stat = statsIn(range.from, range.to);
    var list = recordsIn(range.from, range.to);
    var cleared = purgedCallsIn(range.from, range.to);

    openDialog({
      title: 'Token 账单',
      subtitle: '今天 · ' + fmtInt(stat.calls) + ' 次调用 · ' + fmtInt(stat.prompt + stat.out) + ' tokens',
      build: function (body) {
        body.appendChild(el('div', { class: 'rtc-summary' }, summaryChildren(stat)));

        if (!list.length) {
          body.appendChild(el('div', { class: 'rtc-empty' }, [
            el('div', { text: '今天还没有 AI 调用' }),
            el('div', { text: '正常聊天几句，这里就会出现记录' })
          ]));
          if (cleared) {
            body.appendChild(el('p', {
              class: 'rtc-footmargin',
              text: '已清除 ' + fmtInt(cleared) + ' 次调用的明细，统计仍包含它们'
            }));
          }
          return;
        }

        var wrap = el('div', { class: 'rtc-list' });
        list.slice(0, 6).forEach(function (rec) { wrap.appendChild(miniRow(rec)); });
        body.appendChild(wrap);

        if (list.length > 6) {
          body.appendChild(el('p', {
            class: 'rtc-footmargin',
            text: '还有 ' + (list.length - 6) + ' 条，进 App 看完整账单'
          }));
        } else if (cleared) {
          body.appendChild(el('p', {
            class: 'rtc-footmargin',
            text: '已清除 ' + fmtInt(cleared) + ' 次调用的明细，统计仍包含它们'
          }));
        }
      },
      actions: [
        {
          label: '完整账单',
          onClick: function (destroy) {
            destroy();
            try {
              if (roche && roche.ui && typeof roche.ui.openApp === 'function') roche.ui.openApp('token-console-home');
            } catch (e) { /* ignore */ }
          }
        },
        { label: '关闭', primary: true }
      ]
    });
  }

  /* ============================== 设置 ============================== */

  function openSettings(roche, onChange) {
    var draft = normalizeSettings(settings);

    function apply(patch) {
      Object.keys(patch).forEach(function (k) { draft[k] = patch[k]; });
      settings = normalizeSettings(draft);
      if (store) scheduleSave();
      if (typeof onChange === 'function') onChange();
      refresh();
    }

    var rangeChips = el('div', { class: 'rtc-chips' });
    var dateRow = el('div', { class: 'rtc-daterow' });
    var clearBtn = el('button', { class: 'rtc-btn rtc-btn--danger', type: 'button' });
    var themeChips = el('div', { class: 'rtc-chips' });

    var startInput = el('input', { class: 'rtc-input', type: 'date' });
    var endInput = el('input', { class: 'rtc-input', type: 'date' });
    startInput.value = draft.start || dayKey(Date.now());
    endInput.value = draft.end || dayKey(Date.now());

    function refresh() {
      Array.prototype.forEach.call(rangeChips.children, function (node) {
        node.classList.toggle('is-active', node.getAttribute('data-range') === settings.range);
      });
      Array.prototype.forEach.call(themeChips.children, function (node) {
        node.classList.toggle('is-active', node.getAttribute('data-theme-value') === settings.theme);
      });
      dateRow.style.display = settings.range === 'custom' ? 'flex' : 'none';
      var range = resolveRange(settings, Date.now());
      clearBtn.textContent = '清除「' + range.label + '」的明细';
    }

    RANGES.forEach(function (item) {
      var btn = el('button', {
        class: 'rtc-chip' + (draft.range === item.id ? ' is-active' : ''),
        type: 'button',
        text: item.label,
        'data-range': item.id
      });
      btn.addEventListener('click', function () { apply({ range: item.id }); });
      rangeChips.appendChild(btn);
    });

    startInput.addEventListener('change', function () {
      apply({ start: startInput.value, range: 'custom' });
    });
    endInput.addEventListener('change', function () {
      apply({ end: endInput.value, range: 'custom' });
    });

    dateRow.appendChild(startInput);
    dateRow.appendChild(el('span', { text: '至' }));
    dateRow.appendChild(endInput);

    [['auto', '跟随宿主'], ['light', '日间'], ['dark', '夜间']].forEach(function (pair) {
      var btn = el('button', {
        class: 'rtc-chip' + (draft.theme === pair[0] ? ' is-active' : ''),
        type: 'button',
        text: pair[1],
        'data-theme-value': pair[0]
      });
      btn.addEventListener('click', function () { apply({ theme: pair[0] }); });
      themeChips.appendChild(btn);
    });

    clearBtn.addEventListener('click', async function () {
      var range = resolveRange(settings, Date.now());
      var ok = true;
      if (roche && roche.ui && typeof roche.ui.confirm === 'function') {
        ok = await roche.ui.confirm({
          title: '清除明细',
          message: '清除「' + range.label + '」的明细记录？调用次数和 token 数会保留在统计里。'
        });
      }
      if (!ok) return;
      var removed = purgeRange(range.from, range.to);
      if (typeof onChange === 'function') onChange();
      if (roche && roche.ui && roche.ui.toast) {
        roche.ui.toast(removed ? '已清除 ' + removed + ' 条明细' : '这段范围没有明细可清');
      }
    });

    openDialog({
      title: '设置',
      build: function (body) {
        body.appendChild(el('div', { class: 'rtc-field' }, [
          el('div', { class: 'rtc-field__label' }, [
            el('span', { text: '查看范围' }),
            el('span', { text: '默认今天' })
          ]),
          rangeChips,
          dateRow
        ]));

        body.appendChild(el('div', { class: 'rtc-field' }, [
          el('div', { class: 'rtc-field__label' }, [el('span', { text: '主题' })]),
          themeChips
        ]));

        body.appendChild(el('div', { class: 'rtc-field' }, [
          el('div', { class: 'rtc-field__label' }, [el('span', { text: '清除日志' })]),
          clearBtn,
          el('p', {
            class: 'rtc-note',
            text: '只删除明细行，调用次数与 token 数会保留在统计里。'
          })
        ]));
      },
      actions: [{ label: '完成', primary: true }]
    });

    refresh();
  }

  /* ============================== App 页面 ============================== */

  async function createView(container, roche) {
    await hydrateApp(roche);

    var filter = 'all';

    var root = el('div', { class: 'rtc-root', 'data-theme': currentTheme() });
    var subEl = el('p', { class: 'rtc-sub' });
    var summaryEl = el('div', { class: 'rtc-summary' });
    var listEl = el('div', { class: 'rtc-list' });
    var footerEl = el('p', { class: 'rtc-footmargin' });

    var settingsBtn = el('button', {
      class: 'rtc-iconbtn', type: 'button', title: '设置', 'aria-label': '设置', html: ICONS.settings
    });
    var closeBtn = el('button', {
      class: 'rtc-iconbtn rtc-iconbtn--close', type: 'button', title: '关闭', 'aria-label': '关闭', html: ICONS.close
    });

    var FILTERS = [['all', '全部'], ['hit', '命中缓存'], ['fail', '失败']];
    var chipsEl = el('div', { class: 'rtc-chips' });
    var chipNodes = FILTERS.map(function (pair) {
      var btn = el('button', {
        class: 'rtc-chip' + (pair[0] === filter ? ' is-active' : ''),
        type: 'button',
        text: pair[1],
        'data-filter': pair[0]
      });
      btn.addEventListener('click', function () {
        filter = pair[0];
        chipNodes.forEach(function (node) {
          node.classList.toggle('is-active', node.getAttribute('data-filter') === filter);
        });
        renderList();
      });
      chipsEl.appendChild(btn);
      return btn;
    });

    var rangeBtn = el('button', { class: 'rtc-rangebtn', type: 'button', text: '今天' });
    rangeBtn.addEventListener('click', function () { openSettings(roche, render); });

    var priceBar = el('p', { class: 'rtc-pricebar' });

    function applyTheme() {
      var t = currentTheme();
      root.setAttribute('data-theme', t);
      container.setAttribute('data-theme', t);
    }

    function renderSummary(range) {
      var stat = statsIn(range.from, range.to);
      summaryEl.replaceChildren();
      summaryChildren(stat).forEach(function (node) { summaryEl.appendChild(node); });
      subEl.textContent = range.label + ' · ' + fmtInt(stat.calls) + ' 次调用 · ' +
        fmtInt(stat.prompt + stat.out) + ' tokens';
      return stat;
    }

    function renderPriceBar() {
      var peak = isPeak(Date.now());
      var band = peak ? 'peak' : 'off';
      var f = PRICING.flash;
      var p = PRICING.pro;
      priceBar.textContent = 'DeepSeek 官方价 · ' + bandLabel(peak) + '时段（元/百万 tokens）\n' +
        'Flash  命中 ¥' + f.hit[band] + ' · 未命中 ¥' + f.miss[band] + ' · 输出 ¥' + f.out[band] + '\n' +
        'V4 Pro 命中 ¥' + p.hit[band] + ' · 未命中 ¥' + p.miss[band] + ' · 输出 ¥' + p.out[band];
    }

    function filterRecords(list) {
      return list.filter(function (rec) {
        if (filter === 'hit') return num(rec.hit) > 0;
        if (filter === 'fail') return !rec.ok;
        return true;
      });
    }

    function renderList() {
      var range = resolveRange(settings, Date.now());
      var list = filterRecords(recordsIn(range.from, range.to));
      var cleared = purgedCallsIn(range.from, range.to);

      listEl.replaceChildren();
      if (!list.length) {
        listEl.appendChild(el('div', { class: 'rtc-empty' }, [
          el('div', { text: recordsIn(range.from, range.to).length ? '没有符合条件的记录' : range.label + '还没有调用记录' }),
          el('div', {
            text: recordsIn(range.from, range.to).length
              ? '换个筛选条件试试'
              : '正常聊天、生图或插件调用 AI 后，这里会自动出现记录'
          })
        ]));
      } else {
        list.forEach(function (rec) { listEl.appendChild(fullRow(rec)); });
      }

      if (cleared) {
        footerEl.textContent = '已清除 ' + fmtInt(cleared) + ' 次调用的明细，统计仍包含它们';
        footerEl.style.display = 'block';
      } else {
        footerEl.style.display = 'none';
      }
    }

    function render() {
      applyTheme();
      var range = resolveRange(settings, Date.now());
      renderSummary(range);
      rangeBtn.textContent = range.label;
      renderList();
      renderPriceBar();
    }

    root.appendChild(el('header', { class: 'rtc-header' }, [
      el('div', { class: 'rtc-header__text' }, [
        el('h1', { class: 'rtc-title', text: 'Token 账单' }),
        subEl
      ]),
      el('div', { class: 'rtc-header__actions' }, [settingsBtn, closeBtn])
    ]));

    root.appendChild(el('div', { class: 'rtc-body' }, [
      summaryEl,
      el('div', { class: 'rtc-toolbar' }, [chipsEl, rangeBtn]),
      listEl,
      footerEl,
      priceBar,
      el('p', {
        class: 'rtc-note',
        text: '只记录请求地址、模型、token 数与调用位置，不保存对话正文和 API Key。高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，节假日不计。'
      })
    ]));

    container.appendChild(root);

    // 兜底铺满：个别机型宿主 h-full 链条断裂导致页面塌陷时，按视口高度补齐
    function fitFullscreen() {
      try {
        var rect = root.getBoundingClientRect();
        var vh = window.innerHeight || document.documentElement.clientHeight;
        if (vh && rect.height < vh * 0.6) root.style.height = Math.ceil(vh) + 'px';
      } catch (e) { /* ignore */ }
    }
    fitFullscreen();
    window.addEventListener('resize', fitFullscreen);

    settingsBtn.addEventListener('click', function () { openSettings(roche, render); });
    closeBtn.addEventListener('click', function () {
      if (roche && roche.ui && typeof roche.ui.closeApp === 'function') roche.ui.closeApp();
    });

    var off = subscribe(render);
    render();

    return {
      destroy: function () {
        off();
        window.removeEventListener('resize', fitFullscreen);
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = 0;
        }
        flushSave();
      }
    };
  }

  async function mount(container, roche) {
    ensureStyle();
    closeDialogs();
    app = await createView(container, roche);
  }

  async function unmount(container) {
    if (app) {
      app.destroy();
      app = null;
    }
    closeDialogs();
    container.replaceChildren();
    container.removeAttribute('data-theme');
    removeStyle();
  }

  /* ============================== 注册 ============================== */

  installHook();

  window.RochePlugin.register({
    id: 'token-console',
    name: 'Token 控制台',
    version: VERSION,
    description: 'Token 账单：模型、输入/输出 token、DeepSeek 缓存命中、预估费用与调用位置。',
    apps: [
      {
        id: 'token-console-home',
        name: 'Token 账单',
        icon: 'chart',
        iconImage: '',
        mount: mount,
        unmount: unmount
      }
    ],
    chat: {
      plusActions: [
        {
          id: 'token-bill',
          label: 'Token 账单',
          iconSvg: ICONS.bill,
          open: function (ctx, roche) {
            openBill(roche || (ctx && ctx.roche));
          }
        }
      ]
    }
  });
})();
