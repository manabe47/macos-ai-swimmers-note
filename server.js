const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_PORT = Number(process.env.PORT || 3002);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 120000);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 2400);
const MAX_CONTINUATION_ATTEMPTS = Number(process.env.MAX_CONTINUATION_ATTEMPTS || 4);
const COMPLETION_MARKER = '[回答完了]';
const MAX_HISTORY_COMMENTS = Number(process.env.MAX_HISTORY_COMMENTS || 8);

// Ensure data dir and DB
const dataDir = process.env.SWIMMERS_NOTE_DATA_DIR
  ? path.resolve(process.env.SWIMMERS_NOTE_DATA_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'swimmers.db');
const db = new sqlite3.Database(dbFile);
let serverInstance = null;

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS practices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    title TEXT,
    content TEXT,
    athlete_id INTEGER,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    practice_id INTEGER,
    role TEXT,
    content TEXT,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS athletes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    event TEXT,
    best_time TEXT,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  )`);
});

// Ensure athletes table has recent columns (migrate if necessary)
(async function ensureAthleteColumns(){
  try{
    const cols = await dbAll("PRAGMA table_info(athletes);");
    const names = cols.map(c=>c.name);
    if(!names.includes('group_name')){
      await dbRun('ALTER TABLE athletes ADD COLUMN group_name TEXT');
      console.log('Added athletes.group_name column');
    }
    if(!names.includes('athlete_events')){
      await dbRun('ALTER TABLE athletes ADD COLUMN athlete_events TEXT');
      console.log('Added athletes.athlete_events column');
    }
  }catch(e){ console.error('ensureAthleteColumns failed', e); }
})();

function dbRun(sql, params = []){
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); });
  });
}
function dbAll(sql, params = []){
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if(err) reject(err); else resolve(rows); });
  });
}
function dbGet(sql, params = []){
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if(err) reject(err); else resolve(row); });
  });
}

const DEFAULT_AI_SETTINGS = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434/v1/chat/completions',
  ollamaModel: process.env.GEMMA_MODEL || 'gemma4:26b',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
  menuColumnOrder: ['type', 'stroke', 'distance', 'sets', 'reps', 'rest', 'note']
};

function parseStoredValue(raw, fallback){
  if (raw == null) return fallback;
  try{
    return JSON.parse(raw);
  }catch(e){
    return raw;
  }
}

function serializeSettingValue(value){
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function redactSecret(value){
  const text = value ? String(value) : '';
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.max(text.length - 8, 4))}${text.slice(-4)}`;
}

async function getAISettings(includeSecrets = false){
  const rows = await dbAll('SELECT key, value FROM settings');
  const settings = { ...DEFAULT_AI_SETTINGS };
  for (const row of rows) {
    settings[row.key] = parseStoredValue(row.value, settings[row.key]);
  }
  if (!includeSecrets) {
    return {
      ...settings,
      openaiApiKey: '',
      geminiApiKey: '',
      hasOpenAIApiKey: Boolean(settings.openaiApiKey),
      hasGeminiApiKey: Boolean(settings.geminiApiKey),
      openaiApiKeyMasked: redactSecret(settings.openaiApiKey),
      geminiApiKeyMasked: redactSecret(settings.geminiApiKey)
    };
  }
  return settings;
}

async function upsertSettings(patch){
  const allowedKeys = new Set([
    'provider',
    'ollamaBaseUrl',
    'ollamaModel',
    'openaiApiKey',
    'openaiModel',
    'openaiBaseUrl',
    'geminiApiKey',
    'geminiModel',
    'geminiBaseUrl',
    'menuColumnOrder'
  ]);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowedKeys.has(key)) continue;
    await dbRun(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime("now"))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, serializeSettingValue(value)]
    );
  }
}

function compactText(value, maxLength = 220){
  const text = String(value || '').replace(/s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeOlderComments(comments){
  if (!Array.isArray(comments) || comments.length === 0) return '';
  return comments
    .map((comment, index) => {
      const role = comment.role === 'assistant' ? 'AI' : 'コーチ';
      return `${index + 1}. ${role}: ${compactText(comment.content, 160)}`;
    })
    .join('\n');
}

function buildPracticeAnalysisText(contentObj){
  if (typeof contentObj === 'string') return String(contentObj);
  if (!contentObj || !Array.isArray(contentObj.items) || contentObj.items.length === 0) return '練習メニューなし';
  return contentObj.items.map((item, index) => {
    const type = item && item.type ? String(item.type) : 'Swim';
    const stroke = item && item.stroke ? String(item.stroke) : 'Fr';
    const distance = Number(item && item.distance) || 0;
    const sets = Number(item && item.sets) || 1;
    const reps = Number(item && item.reps) || 1;
    const rest = item && item.rest ? String(item.rest) : '指定なし';
    const note = item && item.note ? String(item.note) : 'なし';
    const totalDistance = distance * sets * reps;
    return [
      `行${index + 1}`,
      `種別:${type}`,
      `種目:${stroke}`,
      `距離:${distance}m`,
      `セット:${sets}`,
      `本数:${reps}`,
      `サイクル:${rest}`,
      `備考:${note}`,
      `総距離:${totalDistance}m`
    ].join(' / ');
  }).join('\n');
}

function buildCoachMessages(practice, athleteContext, contentText, previousComments, contentObj){
  const comments = Array.isArray(previousComments) ? previousComments : [];
  const olderComments = comments.slice(0, Math.max(0, comments.length - MAX_HISTORY_COMMENTS));
  const recentComments = comments.slice(-MAX_HISTORY_COMMENTS);
  const messages = [];
  const structuredPracticeText = buildPracticeAnalysisText(contentObj);

  messages.push({
    role: 'system',
    content:
      'あなたは競泳の現場を深く理解した、水泳競技者・水泳コーチ向けの高度な分析アシスタントです。作成された練習プランについて、良い点、改善点、具体的な修正案（セット内容・目的に沿った調整）を示してください。' +
      '割り当てられた選手のグループ、専門種目、ベストタイム一覧を踏まえ、コメントの一項目として負荷や強度の妥当性も必要に応じて評価してください。' +
      '必ず自然な日本語のみで回答してください。英語の見出し、英語本文、英語の表現、英語の箇条書きは禁止です。競泳の専門用語、トレーニング用語、レース戦略用語は自然な範囲で使って構いません。' +
      '入力にない選手名、レース名、前提条件を勝手に作らないでください。一般論だけで終わらせず、与えられた練習内容に直接ひもづく具体的な助言にしてください。' +
      '必要なら長くなっても構いません。途中で省略せず、最後まで回答を書き切ってください。' +
      '必ず練習メニューの具体的な行番号を引用して評価してください。少なくとも2つ以上の行番号に触れてください。' +
      '一般論だけを述べるのは禁止です。各指摘は、どの行のどの設定を見てそう判断したかが分かるように書いてください。' +
      'メニューに書かれていないことは推測しすぎず、不足情報がある場合はその不足も明示してください。フォーム、テンポ、ストローク効率、乳酸耐性、有酸素・無酸素、レースペース、ディセンディング、ネガティブスプリットなどの観点で踏み込んで構いません。' +
      `回答を書き終えたら、最後の行に必ず ${COMPLETION_MARKER} とだけ書いて終了してください。` +
      'Markdownは使って構いません。'
  });
  messages.push({
    role: 'user',
    content:
      `練習タイトル: ${practice.title || ''}\n\n` +
      `対象チームの選手情報:\n${athleteContext}\n\n` +
      `練習内容(表示用):\n${contentText}\n\n` +
      `練習内容(行ごとの構造化):\n${structuredPracticeText}\n\n` +
      `練習内容(JSON):\n${JSON.stringify(contentObj || {}, null, 2)}`
  });

  if (olderComments.length) {
    messages.push({
      role: 'system',
      content:
        'これまでの会話の要点です。今後の回答ではこの流れを引き継いでください。\n' +
        summarizeOlderComments(olderComments)
    });
  }

  for (const comment of recentComments) {
    messages.push({
      role: comment.role === 'assistant' ? 'assistant' : 'user',
      content: String(comment.content || '')
    });
  }
  return messages;
}

function buildPracticeRevisionMessages(practice, athleteContext, contentObj, contentText, previousComments){
  const comments = Array.isArray(previousComments) ? previousComments : [];
  const olderComments = comments.slice(0, Math.max(0, comments.length - MAX_HISTORY_COMMENTS));
  const recentComments = comments.slice(-MAX_HISTORY_COMMENTS);
  const currentItems = contentObj && Array.isArray(contentObj.items) ? contentObj.items : [];
  const structuredPracticeText = buildPracticeAnalysisText(contentObj);
  const messages = [];
  messages.push({
    role: 'system',
    content:
      'あなたは競泳の現場を深く理解した、水泳競技者・水泳コーチ向けの高度な分析アシスタントです。練習メニューの修正版を提案してください。必ずJSONのみを返してください。' +
      '返却形式は {"comment":"日本語の短い解説","revisedPractice":{"items":[{"type":"","stroke":"","distance":0,"sets":1,"reps":1,"rest":"","note":""}]}} です。' +
      'distance, sets, reps は数値、rest と note は文字列です。項目が不要でも items は配列で返してください。JSON以外の文章は一切含めないでください。' +
      'comment は必ず自然な日本語にしてください。英語禁止です。入力にない人物名や前提を勝手に追加しないでください。競泳の専門用語は自然な範囲で使って構いません。' +
      '元の練習メニューと割り当て選手を必ず参照し、変更理由はどの行を見て判断したか分かるようにしてください。'
  });
  messages.push({
    role: 'user',
    content:
      `練習タイトル: ${practice.title || ''}\n\n` +
      `対象チームの選手情報:\n${athleteContext}\n\n` +
      `現在の練習内容(表示用):\n${contentText}\n\n` +
      `現在の練習内容(行ごとの構造化):\n${structuredPracticeText}\n\n` +
      `現在の練習内容(JSON):\n${JSON.stringify({ items: currentItems }, null, 2)}\n\n` +
      'このメニューを改善した修正版を提案してください。変更理由は comment に短くまとめてください。'
  });

  if (olderComments.length) {
    messages.push({
      role: 'system',
      content:
        'これまでの会話の要点です。今後の回答ではこの流れを引き継いでください。\n' +
        summarizeOlderComments(olderComments)
    });
  }

  for (const comment of recentComments) {
    messages.push({
      role: comment.role === 'assistant' ? 'assistant' : 'user',
      content: String(comment.content || '')
    });
  }
  return messages;
}

function normalizePracticeItems(items){
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    type: item && item.type ? String(item.type) : 'Swim',
    stroke: item && item.stroke ? String(item.stroke) : 'Fr',
    distance: Number(item && item.distance) || 0,
    sets: Number(item && item.sets) || 1,
    reps: Number(item && item.reps) || 1,
    rest: item && item.rest ? String(item.rest) : '',
    note: item && item.note ? String(item.note) : ''
  }));
}

function extractJsonObject(text){
  const raw = String(text || '').trim();
  if (!raw) throw new Error('AI response was empty');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  const jsonText = firstBrace >= 0 && lastBrace >= firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
  return JSON.parse(jsonText);
}

function isLikelyJapanese(text){
  const raw = String(text || '').trim();
  if (!raw) return false;
  const japaneseMatches = raw.match(/[ぁ-んァ-ヶ一-龠々ー]/g) || [];
  const asciiWordMatches = raw.match(/[A-Za-z]{3,}/g) || [];
  return japaneseMatches.length >= Math.max(8, asciiWordMatches.length);
}

function appendRetryInstruction(messages, instruction){
  return [
    ...messages,
    {
      role: 'user',
      content: instruction
    }
  ];
}

function extractGeminiText(data){
  if (!data || !Array.isArray(data.candidates)) return '';
  return data.candidates
    .flatMap((candidate) => candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [])
    .map((part) => part && part.text ? part.text : '')
    .filter(Boolean)
    .join('\n\n');
}

function normalizeProviderResponse(provider, data){
  if (provider === 'gemini') {
    return {
      provider,
      raw: data,
      choices: [
        {
          message: {
            role: 'assistant',
            content: extractGeminiText(data)
          }
        }
      ]
    };
  }
  return {
    provider,
    raw: data,
    choices: Array.isArray(data && data.choices) ? data.choices : []
  };
}

function collectAssistantText(responseData){
  if (!responseData || !Array.isArray(responseData.choices)) return '';
  return responseData.choices
    .map((choice) => choice && choice.message && choice.message.content ? String(choice.message.content) : '')
    .filter(Boolean)
    .join('\n\n');
}

function hasCompletionMarker(text){
  return String(text || '').includes(COMPLETION_MARKER);
}

function stripCompletionMarker(text){
  return String(text || '')
    .replace(new RegExp(`\\s*${COMPLETION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '')
    .trim();
}

function looksIncomplete(text){
  const value = stripCompletionMarker(text);
  if (!value) return true;
  if (hasCompletionMarker(text)) return false;
  if (/[:：(\-（、】【,]$/.test(value)) return true;
  if (/^(#{1,6}|\d+\.)\s*$/.test(value.split('\n').pop() || '')) return true;
  return !/[。！？]$/.test(value);
}

async function requestOllama(settings, messages){
  const payload = {
    model: settings.ollamaModel,
    messages,
    temperature: 0.3,
    max_tokens: AI_MAX_OUTPUT_TOKENS
  };
  const response = await axios.post(settings.ollamaBaseUrl, payload, { timeout: OLLAMA_TIMEOUT_MS });
  return normalizeProviderResponse('ollama', response.data);
}

async function requestOpenAI(settings, messages){
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key is not configured');
  }
  const payload = {
    model: settings.openaiModel,
    messages,
    temperature: 0.3,
    max_tokens: AI_MAX_OUTPUT_TOKENS
  };
  const response = await axios.post(settings.openaiBaseUrl, payload, {
    timeout: OPENAI_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.openaiApiKey}`
    }
  });
  return normalizeProviderResponse('openai', response.data);
}

async function requestGemini(settings, messages){
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not configured');
  }
  const url = `${String(settings.geminiBaseUrl).replace(/\/$/, '')}/${encodeURIComponent(settings.geminiModel)}:generateContent`;
  const payload = {
    contents: messages
      .filter((message) => message && message.content)
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(message.content) }]
      })),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS
    }
  };
  const response = await axios.post(url, payload, {
    timeout: GEMINI_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': settings.geminiApiKey
    }
  });
  return normalizeProviderResponse('gemini', response.data);
}

async function generateCoachComment(settings, messages){
  if (settings.provider === 'openai') return requestOpenAI(settings, messages);
  if (settings.provider === 'gemini') return requestGemini(settings, messages);
  return requestOllama(settings, messages);
}

async function generateCoachCommentWithContinuation(settings, messages){
  let aggregatedText = '';
  let lastResponseData = null;
  let currentMessages = messages.slice();

  for (let attempt = 0; attempt < MAX_CONTINUATION_ATTEMPTS; attempt += 1) {
    const responseData = await generateCoachComment(settings, currentMessages);
    lastResponseData = responseData;
    const chunk = collectAssistantText(responseData).trim();
    if (!chunk) break;

    aggregatedText = aggregatedText ? `${aggregatedText}\n\n${chunk}` : chunk;
    const finishReasons = Array.isArray(responseData && responseData.choices)
      ? responseData.choices.map((choice) => choice && choice.finish_reason ? choice.finish_reason : '').filter(Boolean)
      : [];
    const needsContinuation = finishReasons.includes('length') || looksIncomplete(aggregatedText);
    if (!needsContinuation) break;

    currentMessages = currentMessages.concat([
      { role: 'assistant', content: chunk },
      { role: 'user', content: `回答が途中で切れています。重複を避けて、この続きだけを日本語で最後まで書いてください。書き終えたら最後の行に必ず ${COMPLETION_MARKER} を付けてください。` }
    ]);
  }

  if (lastResponseData && Array.isArray(lastResponseData.choices) && aggregatedText) {
    lastResponseData.choices = [{
      ...(lastResponseData.choices[0] || {}),
      message: {
        role: 'assistant',
        content: stripCompletionMarker(aggregatedText)
      },
      finish_reason: 'stop'
    }];
  }

  return lastResponseData;
}

async function generateJapaneseCoachComment(settings, messages){
  let responseData = await generateCoachCommentWithContinuation(settings, messages);
  const text = responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].message
    ? responseData.choices[0].message.content
    : '';
  if (isLikelyJapanese(text)) return responseData;

  const retryMessages = appendRetryInstruction(
    messages,
    `直前の回答は要件を満たしていません。必ず自然な日本語のみで、英語を一切使わず、入力にない固有名詞を追加せず、最後まで回答を書き切ってください。書き終えたら最後の行に必ず ${COMPLETION_MARKER} を付けてください。`
  );
  return generateCoachCommentWithContinuation(settings, retryMessages);
}

async function generateJapaneseRevision(settings, messages){
  let responseData = await generateCoachComment(settings, messages);
  try{
    const firstText = responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].message
      ? responseData.choices[0].message.content
      : '';
    const parsed = extractJsonObject(firstText);
    if (parsed && isLikelyJapanese(parsed.comment || '')) return { responseData, parsed };
  }catch(e){}

  const retryMessages = appendRetryInstruction(
    messages,
    '直前の回答は要件を満たしていません。必ずJSONのみを返してください。comment は自然な日本語のみ、英語禁止です。revisedPractice.items は指定のキーだけを使って返してください。'
  );
  responseData = await generateCoachComment(settings, retryMessages);
  const retryText = responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].message
    ? responseData.choices[0].message.content
    : '';
  const parsed = extractJsonObject(retryText);
  return { responseData, parsed };
}

function parsePracticeContent(raw){
  if (typeof raw !== 'string') return raw;
  try{
    return JSON.parse(raw);
  }catch(e){
    return raw;
  }
}

function normalizeAthleteEvents(events){
  if (!Array.isArray(events)) return [];
  return events
    .map((entry) => ({
      event: entry && entry.event ? String(entry.event) : '',
      meet: entry && entry.meet ? String(entry.meet) : '',
      date: entry && entry.date ? String(entry.date) : '',
      time: entry && entry.time ? formatSwimTime(entry.time) : ''
    }))
    .filter((entry) => entry.event || entry.meet || entry.date || entry.time);
}

function parseSwimTime(time){
  if (time == null) return null;
  const raw = String(time).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const padded = raw.padStart(6, '0').slice(-6);
    const minutes = Number(padded.slice(0, 2));
    const seconds = Number(padded.slice(2, 4));
    const centiseconds = Number(padded.slice(4, 6));
    return minutes * 60 + seconds + centiseconds / 100;
  }
  const quotedMatch = raw.match(/^(?:(\d+)')?(\d{1,2})"(?:([0-9]{1,2}))?$/);
  if (quotedMatch) {
    const minutes = Number(quotedMatch[1] || '0');
    const seconds = Number(quotedMatch[2] || '0');
    const centiseconds = Number(String(quotedMatch[3] || '0').padEnd(2, '0').slice(0, 2));
    return minutes * 60 + seconds + centiseconds / 100;
  }
  const normalized = raw.replace(/"/g, '.').replace(/'/g, ':');
  const parts = normalized.split(':');
  if (parts.length === 1) {
    const total = Number(parts[0]);
    return Number.isFinite(total) ? total : null;
  }
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    const total = minutes * 60 + seconds;
    return Number.isFinite(total) ? total : null;
  }
  if (parts.length === 3) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    const centiseconds = Number(parts[2]);
    const total = minutes * 60 + seconds + centiseconds / 100;
    return Number.isFinite(total) ? total : null;
  }
  return null;
}

function formatSwimTime(time){
  const seconds = typeof time === 'number' ? time : parseSwimTime(time);
  if (!Number.isFinite(seconds)) return time ? String(time).trim() : '';
  const totalCentiseconds = Math.round(seconds * 100);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const secondsPart = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${String(minutes).padStart(2, '0')}'${String(secondsPart).padStart(2, '0')}"${String(centiseconds).padStart(2, '0')}`;
}

function timeToSortableValue(time){
  const seconds = parseSwimTime(time);
  return Number.isFinite(seconds) ? seconds : Number.POSITIVE_INFINITY;
}

function groupBestTimes(events){
  const grouped = new Map();
  for (const entry of normalizeAthleteEvents(events)) {
    if (!entry.event || !entry.time) continue;
    const current = grouped.get(entry.event);
    if (!current || timeToSortableValue(entry.time) < timeToSortableValue(current.time)) {
      grouped.set(entry.event, entry);
    }
  }
  return Array.from(grouped.values()).sort((a, b) => timeToSortableValue(a.time) - timeToSortableValue(b.time));
}

function normalizeAthlete(row){
  if (!row) return row;
  let athleteEvents = [];
  if (row.athlete_events) {
    try{
      athleteEvents = normalizeAthleteEvents(JSON.parse(row.athlete_events));
    }catch(e){
      athleteEvents = [];
    }
  }
  if (athleteEvents.length === 0 && (row.event || row.best_time)) {
    athleteEvents = normalizeAthleteEvents([{ event: row.event || '', time: row.best_time || '', meet: '既存データ', date: '' }]);
  }
  const bestTimes = groupBestTimes(athleteEvents);
  return {
    ...row,
    athlete_events: athleteEvents,
    best_times: bestTimes,
    primary_event: row.event || (bestTimes[0] ? bestTimes[0].event : '')
  };
}

async function hydratePractice(row){
  const practice = { ...row, parsed: parsePracticeContent(row.content) };
  const athleteIds = new Set();
  if (practice.athlete_id) athleteIds.add(Number(practice.athlete_id));
  if (practice.parsed && Array.isArray(practice.parsed.athleteIds)) {
    for (const athleteId of practice.parsed.athleteIds) {
      if (!Number.isNaN(Number(athleteId))) athleteIds.add(Number(athleteId));
    }
  }
  practice.assignedAthletes = athleteIds.size
    ? (await dbAll(
        `SELECT id, name, event, best_time, group_name, athlete_events FROM athletes WHERE id IN (${Array.from(athleteIds).map(() => '?').join(',')}) ORDER BY id ASC`,
        Array.from(athleteIds)
      )).map(normalizeAthlete)
    : [];
  practice.assignedTeams = Array.from(new Set(practice.assignedAthletes.map((athlete) => athlete.group_name || '未設定')));
  practice.comments = await dbAll('SELECT * FROM comments WHERE practice_id = ? ORDER BY id ASC', [practice.id]);
  return practice;
}

// Create a practice
app.post('/api/practice', async (req, res) => {
  const { title, content, sessionId, athleteId } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const sid = sessionId || 'default';
  try{
    // store structured content as JSON string
    const payload = typeof content === 'string' ? content : JSON.stringify(content);
    const r = await dbRun('INSERT INTO practices (session_id, title, content, athlete_id, created_at) VALUES (?, ?, ?, ?, datetime("now"))', [sid, title || '', payload, athleteId || null]);
    return res.json({ id: r.lastID });
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.put('/api/practice/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { title, content, athleteId } = req.body;
  if (!id) return res.status(400).json({ error: 'valid practice id required' });
  if (!content) return res.status(400).json({ error: 'content required' });
  try{
    const payload = typeof content === 'string' ? content : JSON.stringify(content);
    await dbRun('UPDATE practices SET title = ?, content = ?, athlete_id = ? WHERE id = ?', [title || '', payload, athleteId || null, id]);
    const rows = await dbAll('SELECT * FROM practices WHERE id = ?', [id]);
    if(!rows || rows.length === 0) return res.status(404).json({ error: 'practice not found' });
    return res.json({ id });
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.get('/api/practices', async (req, res) => {
  try{
    const rows = await dbAll('SELECT * FROM practices ORDER BY id DESC');
    const practices = [];
    for (const row of rows) practices.push(await hydratePractice(row));
    return res.json(practices);
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

// Get practice and comments
app.get('/api/practice/:id', async (req, res) => {
  const id = Number(req.params.id);
  try{
    const rows = await dbAll('SELECT * FROM practices WHERE id = ?', [id]);
    if(!rows || rows.length === 0) return res.status(404).json({ error: 'not found' });
    const practice = await hydratePractice(rows[0]);
    return res.json({ practice, comments: practice.comments });
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

// Athletes API
app.post('/api/athlete', async (req, res) => {
  const { name, event, best_time, group_name, athlete_events } = req.body;
  if(!name) return res.status(400).json({ error: 'name required' });
  try{
    const normalizedEvents = normalizeAthleteEvents(athlete_events);
    const bestTimes = groupBestTimes(normalizedEvents);
    const primaryEvent = event || (bestTimes[0] ? bestTimes[0].event : '');
    const legacyBestTime = best_time || (bestTimes[0] ? bestTimes[0].time : '');
    const r = await dbRun(
      'INSERT INTO athletes (name, event, best_time, group_name, athlete_events, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))',
      [name, primaryEvent, legacyBestTime, group_name || '', JSON.stringify(normalizedEvents)]
    );
    const rows = await dbAll('SELECT * FROM athletes WHERE id = ?', [r.lastID]);
    const athlete = rows && rows[0] ? normalizeAthlete(rows[0]) : { id: r.lastID, name, event: primaryEvent, best_time: legacyBestTime, athlete_events: normalizedEvents, best_times: bestTimes, primary_event: primaryEvent };
    return res.json(athlete);
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.get('/api/athletes', async (req, res) => {
  try{
    const rows = await dbAll('SELECT * FROM athletes ORDER BY id ASC');
    return res.json(rows.map(normalizeAthlete));
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.put('/api/athlete/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, event, best_time, group_name, athlete_events } = req.body;
  if(!id) return res.status(400).json({ error: 'valid athlete id required' });
  if(!name) return res.status(400).json({ error: 'name required' });
  try{
    const normalizedEvents = normalizeAthleteEvents(athlete_events);
    const bestTimes = groupBestTimes(normalizedEvents);
    const primaryEvent = event || (bestTimes[0] ? bestTimes[0].event : '');
    const legacyBestTime = best_time || (bestTimes[0] ? bestTimes[0].time : '');
    await dbRun(
      'UPDATE athletes SET name = ?, event = ?, best_time = ?, group_name = ?, athlete_events = ? WHERE id = ?',
      [name, primaryEvent, legacyBestTime, group_name || '', JSON.stringify(normalizedEvents), id]
    );
    const rows = await dbAll('SELECT * FROM athletes WHERE id = ?', [id]);
    if(!rows || rows.length === 0) return res.status(404).json({ error: 'athlete not found' });
    return res.json(normalizeAthlete(rows[0]));
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

// Athlete page: details + related practices and comments
app.get('/api/athlete/:id', async (req, res) => {
  const id = Number(req.params.id);
  try{
    const rows = await dbAll('SELECT * FROM athletes WHERE id = ?', [id]);
    if(!rows || rows.length === 0) return res.status(404).json({ error: 'athlete not found' });
    const athlete = normalizeAthlete(rows[0]);

    // fetch all practices and filter those that reference this athlete (athlete_id or content.athleteIds)
    const practicesAll = await dbAll('SELECT * FROM practices ORDER BY id DESC');
    const practices = [];
    for(const p of practicesAll){
      let include = false;
      if(p.athlete_id && Number(p.athlete_id) === id) include = true;
      try{
        const obj = parsePracticeContent(p.content);
        if(obj){
          if(Array.isArray(obj.athleteIds) && obj.athleteIds.map(Number).includes(id)) include = true;
          if(obj.athleteId && Number(obj.athleteId) === id) include = true;
        }
      }catch(e){}
      if(include){
        p.parsed = parsePracticeContent(p.content);
        const comments = await dbAll('SELECT * FROM comments WHERE practice_id = ? ORDER BY id ASC', [p.id]);
        practices.push({ practice: p, comments });
      }
    }

    return res.json({ athlete, practices });
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.get('/api/settings', async (req, res) => {
  try{
    return res.json(await getAISettings(false));
  }catch(e){
    return res.status(500).json({ error: e.toString() });
  }
});

app.put('/api/settings', async (req, res) => {
  const body = req.body || {};
  const normalized = {
    provider: ['ollama', 'openai', 'gemini'].includes(body.provider) ? body.provider : 'ollama',
    ollamaBaseUrl: body.ollamaBaseUrl ? String(body.ollamaBaseUrl).trim() : DEFAULT_AI_SETTINGS.ollamaBaseUrl,
    ollamaModel: body.ollamaModel ? String(body.ollamaModel).trim() : DEFAULT_AI_SETTINGS.ollamaModel,
    openaiModel: body.openaiModel ? String(body.openaiModel).trim() : DEFAULT_AI_SETTINGS.openaiModel,
    openaiBaseUrl: body.openaiBaseUrl ? String(body.openaiBaseUrl).trim() : DEFAULT_AI_SETTINGS.openaiBaseUrl,
    geminiModel: body.geminiModel ? String(body.geminiModel).trim() : DEFAULT_AI_SETTINGS.geminiModel,
    geminiBaseUrl: body.geminiBaseUrl ? String(body.geminiBaseUrl).trim() : DEFAULT_AI_SETTINGS.geminiBaseUrl
  };

  if (typeof body.openaiApiKey === 'string') normalized.openaiApiKey = body.openaiApiKey.trim();
  if (typeof body.geminiApiKey === 'string') normalized.geminiApiKey = body.geminiApiKey.trim();
  if (body.resetOpenAIApiKey) normalized.openaiApiKey = '';
  if (body.resetGeminiApiKey) normalized.geminiApiKey = '';

  try{
    await upsertSettings(normalized);
    return res.json(await getAISettings(false));
  }catch(e){
    return res.status(500).json({ error: e.toString() });
  }
});

// Ask AI to comment on a practice
app.post('/api/comment', async (req, res) => {
  const { practiceId, sessionId } = req.body;
  if (!practiceId) return res.status(400).json({ error: 'practiceId required' });
  try{
    const pRows = await dbAll('SELECT * FROM practices WHERE id = ?', [practiceId]);
    if(!pRows || pRows.length === 0) return res.status(404).json({ error: 'practice not found' });
    const practice = pRows[0];

    // Parse stored content (may be JSON string) and convert to readable text
    const contentObj = parsePracticeContent(practice.content);
    let contentText = '';
    if (typeof contentObj === 'string') {
      contentText = contentObj;
    } else if (contentObj && Array.isArray(contentObj.items)) {
      contentText = contentObj.items.map((it, idx) => {
        const parts = [];
        if (it.type) parts.push(`${it.type}`);
        if (it.stroke) parts.push(`stroke:${it.stroke}`);
        if (it.distance !== undefined && it.distance !== null) parts.push(`${it.distance}m`);
        if (it.reps) parts.push(`x${it.reps}`);
        if (it.rest) parts.push(`rest:${it.rest}`);
        if (it.note) parts.push(`note:${it.note}`);
        return `${idx+1}. ${parts.join(' ')}`;
      }).join('\n');
    } else {
      try{ contentText = JSON.stringify(contentObj, null, 2); }catch(e){ contentText = String(contentObj); }
    }

    const athleteIds = new Set();
    if(practice.athlete_id) athleteIds.add(Number(practice.athlete_id));
    if(contentObj && Array.isArray(contentObj.athleteIds)){
      for(const athleteId of contentObj.athleteIds){
        if(athleteId !== null && athleteId !== undefined && !Number.isNaN(Number(athleteId))){
          athleteIds.add(Number(athleteId));
        }
      }
    }
    const assignedAthletes = athleteIds.size
      ? await dbAll(
          `SELECT id, name, event, best_time, group_name, athlete_events FROM athletes WHERE id IN (${Array.from(athleteIds).map(()=>'?').join(',')}) ORDER BY id ASC`,
          Array.from(athleteIds)
        )
      : [];
    const normalizedAssignedAthletes = assignedAthletes.map(normalizeAthlete);
    const athleteContext = assignedAthletes.length
      ? normalizedAssignedAthletes.map((athlete, index) => {
          const bestSummary = athlete.best_times && athlete.best_times.length
            ? athlete.best_times.map((entry) => `${entry.event}:${entry.time}`).join(', ')
            : (athlete.best_time || '-');
          return `${index + 1}. ${athlete.name} / group:${athlete.group_name || '-'} / primary:${athlete.primary_event || '-'} / bests:${bestSummary}`;
        }).join('\n')
      : '割り当て選手なし';

    const prev = await dbAll('SELECT role, content FROM comments WHERE practice_id = ? ORDER BY id ASC', [practiceId]);
    const messages = buildCoachMessages(practice, athleteContext, contentText, prev, contentObj);
    const settings = await getAISettings(true);
    const responseData = await generateJapaneseCoachComment(settings, messages);

    // save assistant replies
    try{
      if(responseData && responseData.choices){
        for(const c of responseData.choices){
          const text = (c.message && c.message.content) ? c.message.content : JSON.stringify(c);
          await dbRun('INSERT INTO comments (practice_id, role, content, created_at) VALUES (?, ?, ?, datetime("now"))', [practiceId, 'assistant', text]);
        }
      }
    }catch(e){ console.error('failed to save comment', e); }

    return res.json(responseData);
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.post('/api/practice/:id/revision', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'valid practice id required' });
  try{
    const pRows = await dbAll('SELECT * FROM practices WHERE id = ?', [id]);
    if(!pRows || pRows.length === 0) return res.status(404).json({ error: 'practice not found' });
    const practice = pRows[0];

    const contentObj = parsePracticeContent(practice.content);
    let contentText = '';
    if (typeof contentObj === 'string') {
      contentText = contentObj;
    } else if (contentObj && Array.isArray(contentObj.items)) {
      contentText = contentObj.items.map((it, idx) => {
        const parts = [];
        if (it.type) parts.push(`${it.type}`);
        if (it.stroke) parts.push(`stroke:${it.stroke}`);
        if (it.distance !== undefined && it.distance !== null) parts.push(`${it.distance}m`);
        if (it.sets) parts.push(`sets:${it.sets}`);
        if (it.reps) parts.push(`x${it.reps}`);
        if (it.rest) parts.push(`rest:${it.rest}`);
        if (it.note) parts.push(`note:${it.note}`);
        return `${idx + 1}. ${parts.join(' ')}`;
      }).join('\n');
    } else {
      try{ contentText = JSON.stringify(contentObj, null, 2); }catch(e){ contentText = String(contentObj); }
    }

    const athleteIds = new Set();
    if(practice.athlete_id) athleteIds.add(Number(practice.athlete_id));
    if(contentObj && Array.isArray(contentObj.athleteIds)){
      for(const athleteId of contentObj.athleteIds){
        if(athleteId !== null && athleteId !== undefined && !Number.isNaN(Number(athleteId))){
          athleteIds.add(Number(athleteId));
        }
      }
    }
    const assignedAthletes = athleteIds.size
      ? await dbAll(
          `SELECT id, name, event, best_time, group_name, athlete_events FROM athletes WHERE id IN (${Array.from(athleteIds).map(()=>'?').join(',')}) ORDER BY id ASC`,
          Array.from(athleteIds)
        )
      : [];
    const normalizedAssignedAthletes = assignedAthletes.map(normalizeAthlete);
    const athleteContext = assignedAthletes.length
      ? normalizedAssignedAthletes.map((athlete, index) => {
          const bestSummary = athlete.best_times && athlete.best_times.length
            ? athlete.best_times.map((entry) => `${entry.event}:${entry.time}`).join(', ')
            : (athlete.best_time || '-');
          return `${index + 1}. ${athlete.name} / group:${athlete.group_name || '-'} / primary:${athlete.primary_event || '-'} / bests:${bestSummary}`;
        }).join('\n')
      : '割り当て選手なし';

    const prev = await dbAll('SELECT role, content FROM comments WHERE practice_id = ? ORDER BY id ASC', [id]);
    const settings = await getAISettings(true);
    const messages = buildPracticeRevisionMessages(practice, athleteContext, contentObj, contentText, prev);
    const { parsed } = await generateJapaneseRevision(settings, messages);
    const revisedPractice = parsed && parsed.revisedPractice ? parsed.revisedPractice : {};
    const normalizedItems = normalizePracticeItems(revisedPractice.items);

    return res.json({
      comment: parsed && parsed.comment ? String(parsed.comment) : '',
      revisedPractice: {
        ...revisedPractice,
        items: normalizedItems
      }
    });
  }catch(e){
    return res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/practice/:id/comment', async (req, res) => {
  const id = Number(req.params.id);
  const { content, role } = req.body || {};
  if (!id) return res.status(400).json({ error: 'valid practice id required' });
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content required' });
  try{
    await dbRun(
      'INSERT INTO comments (practice_id, role, content, created_at) VALUES (?, ?, ?, datetime("now"))',
      [id, role === 'assistant' ? 'assistant' : 'coach', String(content).trim()]
    );
    const comments = await dbAll('SELECT * FROM comments WHERE practice_id = ? ORDER BY id ASC', [id]);
    return res.json({ comments });
  }catch(e){ return res.status(500).json({ error: e.toString() }); }
});

app.delete('/api/practice/:id/comments', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'valid practice id required' });
  try{
    await dbRun('DELETE FROM comments WHERE practice_id = ?', [id]);
    return res.json({ comments: [] });
  }catch(e){
    return res.status(500).json({ error: e.toString() });
  }
});

app.post('/api/practice/:id/chat', async (req, res) => {
  const id = Number(req.params.id);
  const { message } = req.body || {};
  if (!id) return res.status(400).json({ error: 'valid practice id required' });
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message required' });
  try{
    const pRows = await dbAll('SELECT * FROM practices WHERE id = ?', [id]);
    if(!pRows || pRows.length === 0) return res.status(404).json({ error: 'practice not found' });
    const practice = pRows[0];

    const contentObj = parsePracticeContent(practice.content);
    let contentText = '';
    if (typeof contentObj === 'string') {
      contentText = contentObj;
    } else if (contentObj && Array.isArray(contentObj.items)) {
      contentText = contentObj.items.map((it, idx) => {
        const parts = [];
        if (it.type) parts.push(`${it.type}`);
        if (it.stroke) parts.push(`stroke:${it.stroke}`);
        if (it.distance !== undefined && it.distance !== null) parts.push(`${it.distance}m`);
        if (it.sets) parts.push(`sets:${it.sets}`);
        if (it.reps) parts.push(`x${it.reps}`);
        if (it.rest) parts.push(`rest:${it.rest}`);
        if (it.note) parts.push(`note:${it.note}`);
        return `${idx + 1}. ${parts.join(' ')}`;
      }).join('\n');
    } else {
      try{ contentText = JSON.stringify(contentObj, null, 2); }catch(e){ contentText = String(contentObj); }
    }

    const athleteIds = new Set();
    if(practice.athlete_id) athleteIds.add(Number(practice.athlete_id));
    if(contentObj && Array.isArray(contentObj.athleteIds)){
      for(const athleteId of contentObj.athleteIds){
        if(athleteId !== null && athleteId !== undefined && !Number.isNaN(Number(athleteId))){
          athleteIds.add(Number(athleteId));
        }
      }
    }
    const assignedAthletes = athleteIds.size
      ? await dbAll(
          `SELECT id, name, event, best_time, group_name, athlete_events FROM athletes WHERE id IN (${Array.from(athleteIds).map(()=>'?').join(',')}) ORDER BY id ASC`,
          Array.from(athleteIds)
        )
      : [];
    const normalizedAssignedAthletes = assignedAthletes.map(normalizeAthlete);
    const athleteContext = assignedAthletes.length
      ? normalizedAssignedAthletes.map((athlete, index) => {
          const bestSummary = athlete.best_times && athlete.best_times.length
            ? athlete.best_times.map((entry) => `${entry.event}:${entry.time}`).join(', ')
            : (athlete.best_time || '-');
          return `${index + 1}. ${athlete.name} / group:${athlete.group_name || '-'} / primary:${athlete.primary_event || '-'} / bests:${bestSummary}`;
        }).join('\n')
      : '割り当て選手なし';

    const userMessage = String(message).trim();
    await dbRun(
      'INSERT INTO comments (practice_id, role, content, created_at) VALUES (?, ?, ?, datetime("now"))',
      [id, 'coach', userMessage]
    );
    const prev = await dbAll('SELECT role, content FROM comments WHERE practice_id = ? ORDER BY id ASC', [id]);
    const messages = buildCoachMessages(practice, athleteContext, contentText, prev, contentObj);
    const settings = await getAISettings(true);
    const responseData = await generateJapaneseCoachComment(settings, messages);

    let assistantText = '';
    if (responseData && responseData.choices) {
      for (const c of responseData.choices) {
        const text = (c.message && c.message.content) ? c.message.content : JSON.stringify(c);
        assistantText = assistantText ? `${assistantText}\n\n${text}` : text;
        await dbRun(
          'INSERT INTO comments (practice_id, role, content, created_at) VALUES (?, ?, ?, datetime("now"))',
          [id, 'assistant', text]
        );
      }
    }

    const comments = await dbAll('SELECT * FROM comments WHERE practice_id = ? ORDER BY id ASC', [id]);
    return res.json({ reply: assistantText, comments });
  }catch(e){
    return res.status(500).json({ error: e.toString() });
  }
});

function startServer(options = {}){
  if (serverInstance) {
    const address = serverInstance.address();
    return Promise.resolve({
      app,
      server: serverInstance,
      port: typeof address === 'object' && address ? address.port : DEFAULT_PORT,
      dataDir,
      dbFile
    });
  }

  const requestedPort = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);

  return new Promise((resolve, reject) => {
    const server = app.listen(requestedPort, () => {
      serverInstance = server;
      const address = server.address();
      const activePort = typeof address === 'object' && address ? address.port : requestedPort;
      console.log(`AI Swimmers Note demo listening on http://localhost:${activePort}`);
      resolve({ app, server, port: activePort, dataDir, dbFile });
    });

    server.once('error', (error) => {
      reject(error);
    });
  });
}

function stopServer(){
  if (!serverInstance) return Promise.resolve();
  return new Promise((resolve, reject) => {
    serverInstance.close((error) => {
      if (error) return reject(error);
      serverInstance = null;
      resolve();
    });
  });
}

module.exports = { app, startServer, stopServer, dataDir, dbFile };

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start AI Swimmers Note demo', error);
    process.exit(1);
  });
}
