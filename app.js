const articleEl = document.getElementById('article');
const wordcountEl = document.getElementById('wordcount');
const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');

const CLEAN_EXAMPLE = `The cheetah is the fastest land animal, capable of reaching speeds of about 70 miles per hour in short bursts. Water is the only common substance found naturally on Earth in all three physical states: solid, liquid, and gas. The Great Barrier Reef, located off the coast of Australia, is the largest living structure on the planet. Photosynthesis in plants converts carbon dioxide and water into glucose and oxygen using energy from sunlight. Mount Everest, at roughly 29,032 feet, is the tallest mountain above sea level on Earth.`;

const FLAWED_EXAMPLE = `The Great Wall of China is the only man-made structure visible from the Moon with the naked eye. Humans only use about 10 percent of their brains at any given time. Photosynthesis in plants converts carbon dioxide and water into glucose and oxygen using energy from sunlight. Bats are completely blind and navigate purely through echolocation. Mount Everest, at roughly 29,032 feet, is the tallest mountain above sea level on Earth.`;

document.getElementById('ex-clean').addEventListener('click', () => {
  articleEl.value = CLEAN_EXAMPLE;
  updateWordcount();
});
document.getElementById('ex-flawed').addEventListener('click', () => {
  articleEl.value = FLAWED_EXAMPLE;
  updateWordcount();
});

function updateWordcount() {
  const words = articleEl.value.trim().split(/\s+/).filter(Boolean).length;
  wordcountEl.textContent = `${words} word${words === 1 ? '' : 's'}`;
}
articleEl.addEventListener('input', updateWordcount);

function setStatus(text, isErr) {
  statusEl.classList.toggle('err', !!isErr);
  statusEl.innerHTML = '<span class="spinner" id="spinner"></span>' + text;
}
function spinnerOn(on) {
  const s = document.getElementById('spinner');
  if (s) s.classList.toggle('on', on);
}

function setStage(n, state) {
  const el = document.getElementById('stage-' + n);
  el.classList.remove('active', 'done', 'err');
  if (state) el.classList.add(state);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// pull the json out even if the model wraps it in ```
function extractJson(text) {
  let cleaned = text.replace(/```json\s*|```/g, '').trim();
  const firstBrace = cleaned.search(/[\[{]/);
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);
  return JSON.parse(cleaned);
}

/* ---------------------------------------------------------------
   Platform catalog. Each entry describes what a section needs to
   show (model choices, key label) and whether it can do live search.
--------------------------------------------------------------- */
const PLATFORMS = {
  claude: {
    label: 'Claude (Anthropic)',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    models: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
    supportsSearch: true
  },
  gemini: {
    label: 'Gemini (Google)',
    keyLabel: 'Google AI API key',
    keyPlaceholder: 'AIza…',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    supportsSearch: true
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
    supportsSearch: true
  },
  cordatus: {
    label: 'Cordatus (local)',
    keyLabel: 'Cordatus API key',
    keyPlaceholder: 'token',
    models: ['mobil-app-model'],
    supportsSearch: false
  }
};

/* ---------------------------------------------------------------
   Builds the picker + fields for one section ("llm" or "search")
   into the given container, and wires up the platform switcher.
--------------------------------------------------------------- */
function buildSection(container) {
  const section = container.dataset.section;
  const title = container.dataset.title;

  container.innerHTML = `
    <div class="settings-group-title">${title}</div>
    <div class="field">
      <label for="platform-${section}">Platform</label>
      <select id="platform-${section}">
        ${Object.entries(PLATFORMS).map(([key, p]) => `<option value="${key}">${p.label}</option>`).join('')}
      </select>
    </div>
    <div id="platform-fields-${section}"></div>
  `;

  const platformSelect = document.getElementById(`platform-${section}`);
  platformSelect.addEventListener('change', () => renderPlatformFields(section, platformSelect.value));
  renderPlatformFields(section, platformSelect.value);
}

function renderPlatformFields(section, platformKey) {
  const platform = PLATFORMS[platformKey];
  const holder = document.getElementById(`platform-fields-${section}`);

  const warning = (section === 'search' && !platform.supportsSearch)
    ? `<div class="platform-warning">${platform.label} has no live search tool here — it will just answer from what it already knows, not fresh sources.</div>`
    : '';

  holder.innerHTML = `
    <div class="field">
      <label for="model-${section}">Model</label>
      <select id="model-${section}">
        ${platform.models.map(m => `<option value="${m}">${m}</option>`).join('')}
        <option value="custom">Custom model string…</option>
      </select>
    </div>
    <div class="field" id="custom-model-${section}-field" style="display:none;">
      <label for="custom-model-${section}">Custom model string</label>
      <input type="text" id="custom-model-${section}" placeholder="e.g. ${platform.models[0]}">
    </div>
    <div class="field">
      <label for="api-key-${section}">${platform.keyLabel}</label>
      <input type="password" id="api-key-${section}" placeholder="${platform.keyPlaceholder}" autocomplete="off">
    </div>
    ${warning}
  `;

  const modelSelect = document.getElementById(`model-${section}`);
  const customField = document.getElementById(`custom-model-${section}-field`);
  modelSelect.addEventListener('change', () => {
    customField.style.display = modelSelect.value === 'custom' ? 'flex' : 'none';
  });
}

function getSectionConfig(section) {
  const platform = document.getElementById(`platform-${section}`).value;
  const modelSelect = document.getElementById(`model-${section}`);
  const customModelEl = document.getElementById(`custom-model-${section}`);
  const model = modelSelect.value === 'custom' ? customModelEl.value.trim() : modelSelect.value;
  const apiKey = document.getElementById(`api-key-${section}`).value.trim();
  return { platform, model, apiKey };
}

buildSection(document.getElementById('llm-settings'));
buildSection(document.getElementById('search-settings'));

/* ---------------------------------------------------------------
   One call function per platform. Each takes { model, apiKey,
   system, userContent, wantSearch } and returns plain text back.
--------------------------------------------------------------- */
async function callClaude({ model, apiKey, system, userContent, wantSearch }) {
  if (!apiKey) throw new Error('Enter an Anthropic API key first.');

  const payload = {
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: userContent }]
  };
  if (wantSearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude error (${response.status}): ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function callGemini({ model, apiKey, system, userContent, wantSearch }) {
  if (!apiKey) throw new Error('Enter a Google AI API key first.');

  const payload = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: { temperature: 0.1 }
  };
  if (wantSearch) payload.tools = [{ google_search: {} }];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini error (${response.status}): ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('\n');
}

async function callOpenAi({ model, apiKey, system, userContent, wantSearch }) {
  if (!apiKey) throw new Error('Enter an OpenAI API key first.');

  if (wantSearch) {
    // web search lives on the Responses API, not classic chat completions
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        instructions: system,
        input: userContent,
        tools: [{ type: 'web_search_preview' }]
      })
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`OpenAI error (${response.status}): ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const chunks = [];
    (data.output || []).forEach(item => {
      (item.content || []).forEach(c => {
        if (c.type === 'output_text' && c.text) chunks.push(c.text);
      });
    });
    return chunks.join('\n');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI error (${response.status}): ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callCordatus({ model, apiKey, system, userContent }) {
  if (!apiKey) throw new Error('Enter a Cordatus API key first.');

  const response = await fetch('https://cordatus-model.cordatus.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'mobil-app-model',
      messages: [{ role: 'user', content: `Instruction: ${system}\n\nText to process: ${userContent}` }],
      stream: true,
      temperature: 0.1,
      max_tokens: 4096
    })
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Cordatus error (${response.status}): ${errText.slice(0, 200)}`);
  }

  const raw = await response.text();
  const pieces = [];
  raw.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ') && !trimmed.endsWith('[DONE]')) {
      try {
        const chunk = JSON.parse(trimmed.slice(6));
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) pieces.push(piece);
      } catch (e) { /* skip a malformed chunk */ }
    }
  });
  return pieces.join('');
}

// single entry point every step calls through
async function callLLM(section, { system, userContent, wantSearch }) {
  const { platform, model, apiKey } = getSectionConfig(section);
  const args = { model, apiKey, system, userContent, wantSearch };

  if (platform === 'claude') return callClaude(args);
  if (platform === 'gemini') return callGemini(args);
  if (platform === 'openai') return callOpenAi(args);
  if (platform === 'cordatus') return callCordatus(args);
  throw new Error('Unknown platform selected.');
}

// step 1: pull claims out of the passage
async function extractFacts(articleText) {
  const instruction = `You are a fact-checking assistant. Read the passage and pull out every checkable factual or numerical claim. For each claim, write a short neutral question that someone would need to answer to verify it.

Respond with ONLY a raw JSON object, no markdown fences, no commentary, in this exact shape:
{"facts": ["claim 1", "claim 2"], "questions": ["question about claim 1?", "question about claim 2?"]}

The facts and questions arrays must be the same length and in the same order. Limit to at most 8 of the most clearly checkable claims.`;

  const text = await callLLM('llm', { system: instruction, userContent: articleText });

  const data = extractJson(text);
  if (!Array.isArray(data.facts) || !Array.isArray(data.questions)) {
    throw new Error('Extraction did not return the expected facts/questions arrays.');
  }
  return data;
}

// step 2: look each question up
async function searchQuestions(questions) {
  const instruction = `You are a research assistant with live web search. For each numbered question below, search the web and answer it in 1-2 sentences, then name the source (site name or domain) you relied on most.

Respond with ONLY a raw JSON array, no markdown fences, no commentary, in this exact shape:
[{"question": "...", "answer": "...", "source": "..."}]

Include one object per question, in the same order they were given.`;

  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');

  const text = await callLLM('search', { system: instruction, userContent: numbered, wantSearch: true });

  const data = extractJson(text);
  if (!Array.isArray(data)) throw new Error('Search step did not return an array.');
  return data;
}

// step 3: decide who's right
async function buildVerdicts(facts, findings) {
  const instruction = `You compare an original claim against independent web search findings and decide a verdict.

For each item, decide one of: "verified" (search supports the claim), "conflict" (search contradicts the claim), or "unclear" (search is inconclusive or mixed). Write one short sentence explaining why.

Respond with ONLY a raw JSON array, no markdown fences, no commentary, in this exact shape:
[{"fact": "...", "verdict": "verified", "note": "..."}]

Preserve the original order and wording of the facts.`;

  const pairs = facts.map((f, i) => ({
    fact: f,
    question: findings[i] ? findings[i].question : '',
    search_answer: findings[i] ? findings[i].answer : '',
    search_source: findings[i] ? findings[i].source : ''
  }));

  const text = await callLLM('llm', { system: instruction, userContent: JSON.stringify(pairs, null, 2) });

  const data = extractJson(text);
  if (!Array.isArray(data)) throw new Error('Verdict step did not return an array.');
  return data;
}

function renderExtraction(facts, questions) {
  const out = document.getElementById('extract-out');
  out.innerHTML = facts.map((f, i) => `
    <div class="fact-row">
      <div class="q">${escapeHtml(questions[i] || '')}</div>
      <div class="f">${escapeHtml(f)}</div>
    </div>`).join('');
}

function renderSearch(findings) {
  const out = document.getElementById('search-out');
  out.innerHTML = findings.map(item => `
    <div class="find-row">
      <div class="find-q">${escapeHtml(item.question || '')}</div>
      <div class="find-a">${escapeHtml(item.answer || '')}</div>
      <div class="find-src">source: ${escapeHtml(item.source || 'unspecified')}</div>
    </div>`).join('');
}

function renderVerdicts(verdicts) {
  const out = document.getElementById('verdict-out');
  const label = { verified: 'Verified', conflict: 'Disputed', unclear: 'Unclear' };
  out.innerHTML = verdicts.map(v => {
    const cls = ['verified', 'conflict', 'unclear'].includes(v.verdict) ? v.verdict : 'unclear';
    return `
    <div class="verdict-row">
      <div class="stamp ${cls}">${label[cls]}</div>
      <div class="verdict-text">
        <div class="vf">${escapeHtml(v.fact || '')}</div>
        <div class="vn">${escapeHtml(v.note || '')}</div>
      </div>
    </div>`;
  }).join('');
}

function renderSummary(verdicts) {
  const counts = { verified: 0, conflict: 0, unclear: 0 };
  verdicts.forEach(v => { if (counts[v.verdict] !== undefined) counts[v.verdict]++; });

  const tally = document.getElementById('tally');
  tally.innerHTML = `<b class="sv">${counts.verified} verified</b> &nbsp;/&nbsp; <b class="sc">${counts.conflict} disputed</b> &nbsp;/&nbsp; <b class="su">${counts.unclear} unclear</b>`;

  const summaryText = document.getElementById('summary-text');
  let lead;
  if (counts.conflict === 0 && counts.unclear === 0) {
    lead = `Every claim checked out against independent sources. No disputes found.`;
  } else if (counts.conflict > 0) {
    lead = `${counts.conflict} claim${counts.conflict === 1 ? '' : 's'} directly conflicted with what the search turned up. Worth a second look before this passage is relied on.`;
  } else {
    lead = `Nothing was directly contradicted, but ${counts.unclear} claim${counts.unclear === 1 ? '' : 's'} couldn't be pinned down with confidence.`;
  }
  summaryText.innerHTML = `<p>${escapeHtml(lead)}</p>`;
  document.getElementById('summary').classList.add('show');
}

// run the whole thing, stage by stage
async function runPipeline() {
  const article = articleEl.value.trim();
  if (!article) {
    setStatus('Paste some text first.', true);
    return;
  }

  const llmConfig = getSectionConfig('llm');
  if (!llmConfig.apiKey) {
    setStatus('Enter an API key in the LLM section first.', true);
    return;
  }
  if (!llmConfig.model) {
    setStatus('Enter a model string in the LLM section first.', true);
    return;
  }

  const searchConfig = getSectionConfig('search');
  if (!searchConfig.apiKey) {
    setStatus('Enter an API key in the web search section first.', true);
    return;
  }
  if (!searchConfig.model) {
    setStatus('Enter a model string in the web search section first.', true);
    return;
  }

  runBtn.disabled = true;
  document.getElementById('summary').classList.remove('show');
  ['extract-out', 'search-out', 'verdict-out'].forEach(id => {
    document.getElementById(id).innerHTML = '<div class="empty-note">Working…</div>';
  });

  try {
    setStage(1, 'active'); setStage(2, null); setStage(3, null);
    setStatus('Extracting claims…'); spinnerOn(true);
    const { facts, questions } = await extractFacts(article);
    renderExtraction(facts, questions);
    setStage(1, 'done');

    if (facts.length === 0) {
      document.getElementById('search-out').innerHTML = '<div class="empty-note">No checkable claims found in this passage.</div>';
      document.getElementById('verdict-out').innerHTML = '<div class="empty-note">Nothing to verify.</div>';
      setStage(2, 'done'); setStage(3, 'done');
      setStatus('Done — no checkable claims found.');
      return;
    }

    setStage(2, 'active');
    setStatus('Searching the web for each question…');
    const findings = await searchQuestions(questions);
    renderSearch(findings);
    setStage(2, 'done');

    setStage(3, 'active');
    setStatus('Weighing claims against findings…');
    const verdicts = await buildVerdicts(facts, findings);
    renderVerdicts(verdicts);
    renderSummary(verdicts);
    setStage(3, 'done');

    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong: ' + err.message, true);
    document.querySelectorAll('.stage.active').forEach(el => el.classList.replace('active', 'err'));
  } finally {
    spinnerOn(false);
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', runPipeline);
updateWordcount();
