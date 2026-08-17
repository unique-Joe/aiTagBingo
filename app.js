/**
 * Tag 宾果 - 猜测辅助系统
 * 纯前端静态实现，数据保存在 localStorage 与 Origin Private File System (data.json)
 * AI 分析已接入火山引擎 Responses API + 结构化输出
 */

// ===================== 火山引擎 API 配置 =====================
// ⚠️ 自用本地小工具：Key 与 Model 直接写死在前端。
// 如需部署到公网，请改由后端代理，避免泄露 Key。
const VOLCANO_CONFIG = {
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3/responses',
  apiKey: 'ark-b3d83d3b-6634-4bd4-88c2-4617bdc0e62e-a914a',
  model: 'doubao-seed-2-0-lite-260428',
  thinkingEnabled: true, // true = enabled, false = disabled（参考火山引擎文档）
};

const THINKING_STORAGE_KEY = 'tag-bingo-thinking-enabled';
const STORAGE_KEY = 'tag-bingo-v2';
const DATA_FILE_NAME = 'data.json';

// ===================== JSON Schemas for structured output =====================
const MATCH_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer', description: '候选标签的序号' },
    confidence: { type: 'number', description: '匹配置信度，0 到 1 之间' },
  },
  required: ['index', 'confidence'],
  additionalProperties: false,
};

const SINGLE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: MATCH_ITEM_SCHEMA,
      description: '按置信度降序排列的匹配结果，最多 6 项',
    },
  },
  required: ['results'],
  additionalProperties: false,
};

const CLUSTER_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    personId: { type: 'string', description: '成员 ID' },
    suggestions: {
      type: 'array',
      items: MATCH_ITEM_SCHEMA,
      description: '该成员最匹配的前 3 个标签',
    },
  },
  required: ['personId', 'suggestions'],
  additionalProperties: false,
};

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: CLUSTER_ITEM_SCHEMA,
      description: '每个选中成员的匹配结果',
    },
  },
  required: ['results'],
  additionalProperties: false,
};

// ===================== 生产环境名单 =====================
const PRODUCTION_NAMES = [
  '李雨桐',
  '葛清扬',
  '郭睿鑫',
  '盛安琪',
  '苏小雅',
  '王涵',
  '于佳宁',
  '张凯铭',
  '李欣芮',
  '姜禹安',
  '黄啸坤',
  '余浩然',
  '邓贻祺',
  '吴宇凡',
  '唐瑞希',
  '岳思轩',
  '任昊斌',
  '苗舒然',
  '麦绰桐',
  '史博涵',
  '曾志邦',
  '康哲',
  '赵建德',
  '张丞锐',
  '张鑫鹏',
  '龙俊宇',
  '乔家祺',
  '李梓萱',
  '李娜希',
  '桑一然',
  '张博渊',
  '刘韦嘉',
  '胡皓鑫',
  '陈嘉俊',
  '石可',
  '王萧哲',
  '吴宇涵',
];

// ===================== 数据模型 =====================
function createState() {
  return {
    tags: Array(25).fill(''),
    people: [],
    selectedPersonId: null,
    clusterSelectedIds: new Set(),
    tasks: [],
  };
}

let state = createState();

// ===================== 持久化：localStorage + OPFS data.json =====================
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // localStorage 为空时尝试从 OPFS 的 data.json 恢复
      loadStateFromOPFS();
      return;
    }
    const parsed = JSON.parse(raw);
    applyState(parsed);
  } catch (e) {
    console.error('读取本地数据失败', e);
    loadStateFromOPFS();
  }
}

function applyState(parsed) {
  state.tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 25) : Array(25).fill('');
  state.people = Array.isArray(parsed.people) ? parsed.people : [];
  state.people.forEach(p => {
    if (!Array.isArray(p.bindings)) p.bindings = [];
  });
}

function saveState() {
  try {
    const payload = { tags: state.tags, people: state.people };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    scheduleDataFileWrite();
  } catch (e) {
    console.error('保存本地数据失败', e);
  }
}

// ----- OPFS data.json 自动保存 -----
let opfsRoot = null;
let dataFileWriteTimer = null;
let dataFileDirty = false;
let dataFileLastWrite = 0;
let dataFileWriting = false;

async function ensureOPFS() {
  if (opfsRoot) return opfsRoot;
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try {
    opfsRoot = await navigator.storage.getDirectory();
    return opfsRoot;
  } catch (e) {
    console.warn('OPFS 不可用', e);
    return null;
  }
}

async function loadStateFromOPFS() {
  const root = await ensureOPFS();
  if (!root) return;
  try {
    const fileHandle = await root.getFileHandle(DATA_FILE_NAME);
    const file = await fileHandle.getFile();
    const text = await file.text();
    if (!text) return;
    const parsed = JSON.parse(text);
    applyState(parsed);
    renderAll();
    showToast('已从 data.json 恢复数据');
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      console.warn('从 OPFS 读取 data.json 失败', e);
    }
  }
}

function scheduleDataFileWrite() {
  dataFileDirty = true;
  if (dataFileWriteTimer) return;
  dataFileWriteTimer = setTimeout(() => writeDataFile(), 0);
}

async function writeDataFile(force = false) {
  dataFileWriteTimer = null;
  if (dataFileWriting) {
    scheduleDataFileWrite();
    return;
  }

  const now = Date.now();
  if (!force && !dataFileDirty && now - dataFileLastWrite < 60000) return;

  const root = await ensureOPFS();
  if (!root) return;

  dataFileWriting = true;
  try {
    const payload = {
      tags: state.tags,
      people: state.people,
      savedAt: new Date().toISOString(),
    };
    const handle = await root.getFileHandle(DATA_FILE_NAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    dataFileDirty = false;
    dataFileLastWrite = now;
  } catch (e) {
    console.error('写入 data.json 失败', e);
  } finally {
    dataFileWriting = false;
  }
}

// 无数据变更时 1 分钟保存一次（心跳快照）
setInterval(() => writeDataFile(), 60000);

// ===================== 深度思考配置 =====================
function loadThinkingType() {
  try {
    const saved = localStorage.getItem(THINKING_STORAGE_KEY);
    if (saved !== null) {
      VOLCANO_CONFIG.thinkingEnabled = saved === 'true';
    }
  } catch (e) {
    console.error(e);
  }
}

function saveThinkingType(enabled) {
  try {
    localStorage.setItem(THINKING_STORAGE_KEY, String(enabled));
  } catch (e) {
    console.error(e);
  }
}

// ===================== 工具函数 =====================
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `fixed bottom-6 right-6 px-4 py-3 rounded-xl shadow-lg text-sm text-white border transform transition-all duration-300 pointer-events-none z-50 show ${type === 'error' ? 'bg-red-950 border-red-800' : 'bg-slate-900 border-slate-700'}`;
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

function getPerson(id) {
  return state.people.find(p => p.id === id);
}

function getBindingsForTag(tagIndex) {
  return state.people
    .filter(p => p.bindings.includes(tagIndex))
    .map(p => p.name);
}

function isTagEmpty(tag) {
  return typeof tag !== 'string' || tag.trim() === '';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===================== 自定义确认弹窗（替代原生 confirm） =====================
const confirmModal = document.getElementById('confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const btnConfirmOk = document.getElementById('btn-confirm-ok');
const btnConfirmCancel = document.getElementById('btn-confirm-cancel');

let confirmResolve = null;

function showConfirm(message, title = '确认') {
  if (!confirmModal.classList.contains('hidden')) {
    closeConfirmModal(false);
  }
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    confirmModal.classList.remove('hidden');
  });
}

function closeConfirmModal(result) {
  if (!confirmModal.classList.contains('hidden')) {
    confirmModal.classList.add('hidden');
  }
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
}

btnConfirmOk.addEventListener('click', () => closeConfirmModal(true));
btnConfirmCancel.addEventListener('click', () => closeConfirmModal(false));
confirmModal.querySelector('.modal-backdrop').addEventListener('click', () => closeConfirmModal(false));

// ===================== AI 服务：火山引擎 Responses API + 结构化输出 =====================
const aiService = {
  async _callVolcano(text, schemaName, schema) {
    const body = {
      model: VOLCANO_CONFIG.model,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema,
        },
      },
      thinking: { type: VOLCANO_CONFIG.thinkingEnabled ? 'enabled' : 'disabled' },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000); // 深度思考推荐 30 分钟超时

    try {
      const response = await fetch(VOLCANO_CONFIG.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${VOLCANO_CONFIG.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`API 请求失败 [${response.status}]: ${errText}`);
      }

      const data = await response.json();
      const responseText = this._extractText(data);
      return JSON.parse(responseText);
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        throw new Error('请求超时，深度思考耗时较长，请稍后重试');
      }
      throw e;
    }
  },

  _extractText(data) {
    if (data.output && Array.isArray(data.output)) {
      const first = data.output.find(o => o.role === 'assistant') || data.output[0];
      if (first && Array.isArray(first.content)) {
        const textPart = first.content.find(c => c.type === 'output_text');
        if (textPart && textPart.text) return textPart.text;
      }
    }
    if (data.choices && data.choices[0]) {
      return data.choices[0].message?.content || data.choices[0].text || '';
    }
    return '';
  },

  async analyzeSingle(description, tags) {
    const tagsText = tags.map(t => `${t.index}: ${t.text}`).join('\n');
    const prompt = `请根据自我介绍，从候选标签中选出最匹配的若干项。\n\n自我介绍：\n${description}\n\n候选标签（格式“序号: 标签内容”）：\n${tagsText}\n\n请按置信度降序返回最多 6 项。`;

    const parsed = await this._callVolcano(prompt, 'single_tag_matching', SINGLE_SCHEMA);
    if (!Array.isArray(parsed.results)) throw new Error('模型返回格式错误，缺少 results 数组');

    return parsed.results
      .filter(item => typeof item.index === 'number' && typeof item.confidence === 'number')
      .map(item => ({
        index: item.index,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        selected: false,
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);
  },

  async analyzeCluster(people, tags) {
    const tagsText = tags.map(t => `${t.index}: ${t.text}`).join('\n');
    const peopleText = people.map(p => `- personId: ${p.id}\n  姓名: ${p.name}\n  描述: ${p.description}`).join('\n');
    const prompt = `请根据以下多位成员的自我介绍，为每个人从候选标签中选出最匹配的前 3 项。\n\n成员列表：\n${peopleText}\n\n候选标签（格式“序号: 标签内容”）：\n${tagsText}`;

    const parsed = await this._callVolcano(prompt, 'cluster_tag_matching', CLUSTER_SCHEMA);
    if (!Array.isArray(parsed.results)) throw new Error('模型返回格式错误，缺少 results 数组');

    return people.map(person => {
      const item = parsed.results.find(p => p.personId === person.id);
      let suggestions = [];
      if (item && Array.isArray(item.suggestions)) {
        suggestions = item.suggestions
          .filter(s => typeof s.index === 'number' && typeof s.confidence === 'number')
          .map(s => ({
            index: s.index,
            confidence: Math.max(0, Math.min(1, s.confidence)),
            selected: true,
          }))
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3);
      }
      return { personId: person.id, suggestions };
    });
  },
};

// ===================== 渲染：Tag 表格 =====================
const tagBoardEl = document.getElementById('tag-board');

function setTagInputFontSize(input, text) {
  const len = text.length;
  if (len > 12) input.style.fontSize = '10px';
  else if (len > 8) input.style.fontSize = '11px';
  else if (len > 4) input.style.fontSize = '12px';
  else input.style.fontSize = '13px';
}

function renderTagBoard() {
  tagBoardEl.innerHTML = '';
  state.tags.forEach((text, index) => {
    const boundNames = getBindingsForTag(index);
    const isBound = boundNames.length > 0;

    const cell = document.createElement('div');
    cell.className = `tag-cell ${isBound ? 'bound' : ''}`;
    cell.dataset.index = index;

    const idxLabel = document.createElement('span');
    idxLabel.className = 'tag-cell-index';
    idxLabel.textContent = `#${index + 1}`;

    const manageBtn = document.createElement('button');
    manageBtn.className = 'tag-manage-btn';
    manageBtn.title = '管理绑定';
    manageBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    `;
    manageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBindingModal(index);
    });

    const input = document.createElement('textarea');
    input.className = 'tag-cell-input';
    input.value = text;
    input.placeholder = '留空';
    input.rows = 2;
    setTagInputFontSize(input, text);
    input.addEventListener('focus', () => cell.classList.add('focused'));
    input.addEventListener('blur', () => cell.classList.remove('focused'));
    input.addEventListener('input', () => {
      state.tags[index] = input.value;
      setTagInputFontSize(input, input.value);
      saveState();
    });

    const badges = document.createElement('div');
    badges.className = 'tag-cell-badges';
    boundNames.slice(0, 3).forEach(name => {
      const badge = document.createElement('span');
      badge.className = 'tag-cell-badge';
      badge.textContent = name.slice(0, 2);
      badge.title = name;
      badges.appendChild(badge);
    });
    if (boundNames.length > 3) {
      const more = document.createElement('span');
      more.className = 'tag-cell-badge more';
      more.textContent = `+${boundNames.length - 3}`;
      more.title = `还有 ${boundNames.length - 3} 人`;
      badges.appendChild(more);
    }

    // 拖拽绑定：左侧人员拖到右侧 tag 方格
    cell.addEventListener('dragover', (e) => {
      if (isTagEmpty(state.tags[index])) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      if (isTagEmpty(state.tags[index])) {
        showToast('不能绑定到空 tag', 'error');
        return;
      }
      const personId = e.dataTransfer.getData('text/plain');
      if (!personId) return;
      const bound = bindTagsToPerson(personId, [index]);
      if (bound > 0) {
        showToast(`已绑定 ${bound} 个 tag`);
      }
    });

    cell.appendChild(idxLabel);
    cell.appendChild(manageBtn);
    cell.appendChild(input);
    cell.appendChild(badges);
    tagBoardEl.appendChild(cell);
  });
}

// Excel / 表格粘贴自动填充
tagBoardEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const focused = document.querySelector('.tag-cell.focused');
  if (!focused) {
    showToast('请先点击一个起始格子再粘贴', 'error');
    return;
  }
  const startIndex = parseInt(focused.dataset.index, 10);

  const raw = (e.clipboardData || window.clipboardData).getData('text');
  const rows = raw.split(/\r?\n/).filter(r => r.trim() !== '');
  if (rows.length === 0) return;

  const matrix = rows.map(row => row.split('\t'));
  const startRow = Math.floor(startIndex / 5);
  const startCol = startIndex % 5;

  let filled = 0;
  matrix.forEach((cols, r) => {
    cols.forEach((val, c) => {
      const row = startRow + r;
      const col = startCol + c;
      if (row >= 5 || col >= 5) return;
      const idx = row * 5 + col;
      state.tags[idx] = val.trim();
      filled++;
    });
  });

  saveState();
  renderTagBoard();
  showToast(`已自动填充 ${filled} 个格子`);
});

// ===================== 渲染：成员列表 =====================
const peopleListEl = document.getElementById('people-list');
const peopleCountEl = document.getElementById('people-count');
const inputSearchPeople = document.getElementById('input-search-people');
let peopleSearchQuery = '';
const personEditorEl = document.getElementById('person-editor');
const editorNameEl = document.getElementById('editor-name');
const inputDescriptionEl = document.getElementById('input-description');

function renderPeopleList() {
  peopleListEl.innerHTML = '';
  const query = peopleSearchQuery.trim().toLowerCase();
  const filtered = query
    ? state.people.filter(p => p.name.toLowerCase().includes(query))
    : state.people;
  peopleCountEl.textContent = `${filtered.length} / ${state.people.length} 人`;

  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'text-center text-slate-500 text-sm py-8';
    empty.textContent = query ? '未找到匹配成员' : '暂无成员，请在上方添加';
    peopleListEl.appendChild(empty);
    return;
  }

  filtered.forEach(person => {
    const li = document.createElement('li');
    li.className = `people-item ${person.id === state.selectedPersonId ? 'active' : ''}`;
    li.setAttribute('draggable', 'true');
    li.dataset.personId = person.id;

    li.addEventListener('click', () => selectPerson(person.id));

    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.setData('text/plain', person.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));

    const avatar = document.createElement('div');
    avatar.className = 'people-avatar';
    avatar.textContent = person.name.slice(0, 1);

    const meta = document.createElement('div');
    meta.className = 'people-meta';
    const name = document.createElement('div');
    name.className = 'people-name';
    name.textContent = person.name;
    const hint = document.createElement('div');
    hint.className = 'people-desc-hint';
    hint.textContent = person.description.trim() ? '已填写描述' : '暂无描述';
    meta.appendChild(name);
    meta.appendChild(hint);

    const bindCount = document.createElement('div');
    bindCount.className = 'people-bind-count';
    bindCount.textContent = person.bindings.length > 0 ? `${person.bindings.length} tag` : '';

    li.appendChild(avatar);
    li.appendChild(meta);
    li.appendChild(bindCount);
    peopleListEl.appendChild(li);
  });
}

function renderPersonEditor() {
  if (!state.selectedPersonId) {
    personEditorEl.classList.add('hidden');
    return;
  }
  const person = getPerson(state.selectedPersonId);
  if (!person) {
    state.selectedPersonId = null;
    personEditorEl.classList.add('hidden');
    return;
  }
  editorNameEl.textContent = person.name;
  inputDescriptionEl.value = person.description;
  personEditorEl.classList.remove('hidden');
  renderSinglePanel();
}

function addPerson(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (state.people.some(p => p.name === trimmed)) {
    showToast('该姓名已存在', 'error');
    return;
  }
  const person = { id: uid(), name: trimmed, description: '', bindings: [] };
  state.people.push(person);
  saveState();
  selectPerson(person.id);
  renderPeopleList();
  showToast(`已添加成员：${trimmed}`);
}

async function deletePerson(id) {
  const ok = await showConfirm('确定删除该成员及其所有绑定吗？', '删除成员');
  if (!ok) return;
  state.people = state.people.filter(p => p.id !== id);
  if (state.selectedPersonId === id) state.selectedPersonId = null;
  state.clusterSelectedIds.delete(id);
  state.tasks = state.tasks.filter(t => {
    if (t.type === 'single') return t.personId !== id;
    if (t.type === 'cluster') return !t.personIds.includes(id);
    return true;
  });
  saveState();
  renderAll();
  showToast('已删除成员');
}

function selectPerson(id) {
  state.selectedPersonId = id;
  renderPeopleList();
  renderPersonEditor();
}

function saveDescription() {
  if (!state.selectedPersonId) return;
  const person = getPerson(state.selectedPersonId);
  if (!person) return;
  person.description = inputDescriptionEl.value;
  saveState();
  renderPeopleList();
  renderClusterList();
  showToast('描述已保存');
}

function bindTagsToPerson(personId, tagIndices) {
  const person = getPerson(personId);
  if (!person) return 0;
  const unique = [...new Set(tagIndices)].filter(i => i >= 0 && i < 25 && !isTagEmpty(state.tags[i]));
  unique.forEach(idx => {
    if (!person.bindings.includes(idx)) person.bindings.push(idx);
  });
  if (unique.length > 0) saveState();
  renderTagBoard();
  renderPeopleList();
  return unique.length;
}

function unbindTagFromPerson(personId, tagIndex) {
  const person = getPerson(personId);
  if (!person) return;
  person.bindings = person.bindings.filter(i => i !== tagIndex);
  saveState();
  renderTagBoard();
  renderPeopleList();
}

// ===================== 单人/集群分析面板 =====================
const singleEmptyEl = document.getElementById('single-empty');
const singleContentEl = document.getElementById('single-content');

function renderSinglePanel() {
  const person = state.selectedPersonId ? getPerson(state.selectedPersonId) : null;
  if (person && person.description.trim()) {
    singleEmptyEl.classList.add('hidden');
    singleContentEl.classList.remove('hidden');
  } else {
    singleEmptyEl.classList.remove('hidden');
    singleContentEl.classList.add('hidden');
  }
}

function renderClusterList() {
  const clusterListEl = document.getElementById('cluster-list');
  clusterListEl.innerHTML = '';
  const withDesc = state.people.filter(p => p.description.trim() !== '');

  if (withDesc.length === 0) {
    clusterListEl.innerHTML = '<div class="text-sm text-slate-500 text-center py-6">暂无填写描述的成员</div>';
    return;
  }

  withDesc.forEach(person => {
    const row = document.createElement('div');
    row.className = `cluster-row ${state.clusterSelectedIds.has(person.id) ? 'selected' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.clusterSelectedIds.has(person.id);
    checkbox.className = 'accent-indigo-500 w-4 h-4';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.clusterSelectedIds.add(person.id);
      else state.clusterSelectedIds.delete(person.id);
      renderClusterList();
    });

    const name = document.createElement('div');
    name.className = 'text-sm font-medium text-slate-100 flex-1 min-w-0 truncate';
    name.textContent = person.name;

    const descHint = document.createElement('div');
    descHint.className = 'text-xs text-slate-500 truncate max-w-[140px]';
    descHint.textContent = person.description;

    row.appendChild(checkbox);
    row.appendChild(name);
    row.appendChild(descHint);
    row.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });
    clusterListEl.appendChild(row);
  });
}

// ===================== 任务系统 =====================
function createTask(type, payload) {
  const task = {
    id: uid(),
    type,
    status: 'running',
    createdAt: Date.now(),
    ...payload,
    result: null,
    error: null,
  };
  state.tasks.unshift(task);
  renderTaskList();
  return task;
}

function updateTask(id, updates) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  Object.assign(task, updates);
  renderTaskList();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  renderTaskList();
}

function clearDoneTasks() {
  state.tasks = state.tasks.filter(t => t.status === 'running');
  renderTaskList();
}

async function runSingleAnalysis() {
  if (!state.selectedPersonId) {
    showToast('请先选择一名成员', 'error');
    return;
  }
  const person = getPerson(state.selectedPersonId);
  if (!person || !person.description.trim()) {
    showToast('该成员暂无描述', 'error');
    return;
  }
  const tags = state.tags.map((text, index) => ({ text, index })).filter(t => !isTagEmpty(t.text));
  if (tags.length === 0) {
    showToast('请先填写至少一个 tag', 'error');
    return;
  }

  const task = createTask('single', {
    name: person.name,
    personId: person.id,
    description: person.description,
  });

  try {
    const results = await aiService.analyzeSingle(person.description, tags);
    updateTask(task.id, { status: 'done', result: results });
    showToast(`「${person.name}」分析完成`);
  } catch (e) {
    updateTask(task.id, { status: 'error', error: e.message });
    showToast(`「${person.name}」分析失败`, 'error');
  }
}

async function runClusterAnalysis() {
  const selectedIds = Array.from(state.clusterSelectedIds);
  if (selectedIds.length === 0) {
    showToast('请至少选择一名成员', 'error');
    return;
  }
  const people = selectedIds.map(id => getPerson(id)).filter(Boolean);
  const tags = state.tags.map((text, index) => ({ text, index })).filter(t => !isTagEmpty(t.text));
  if (tags.length === 0) {
    showToast('请先填写至少一个 tag', 'error');
    return;
  }

  const task = createTask('cluster', {
    name: `集群分析（${people.length} 人）`,
    personIds: people.map(p => p.id),
  });

  try {
    const results = await aiService.analyzeCluster(people, tags);
    updateTask(task.id, { status: 'done', result: results });
    showToast('集群分析完成');
  } catch (e) {
    updateTask(task.id, { status: 'error', error: e.message });
    showToast('集群分析失败', 'error');
  }
}

// ===================== 任务中心侧边栏 =====================
const taskCenter = document.getElementById('task-center');
const taskCenterTab = document.getElementById('task-center-tab');
const taskCountBadge = document.getElementById('task-count-badge');
const taskSummaryEl = document.getElementById('task-summary');

function toggleTaskCenter() {
  taskCenter.classList.toggle('expanded');
}

function openTaskCenter() {
  taskCenter.classList.add('expanded');
}

function updateTaskCenterBadge() {
  const running = state.tasks.filter(t => t.status === 'running').length;
  const done = state.tasks.filter(t => t.status === 'done').length;
  const total = state.tasks.length;

  taskCountBadge.classList.toggle('show', total > 0);
  taskCountBadge.classList.toggle('done', running === 0 && done > 0);
  taskCountBadge.textContent = String(running || done || 0);

  if (total === 0) {
    taskSummaryEl.textContent = '暂无任务';
  } else if (running > 0) {
    taskSummaryEl.textContent = `${running} 个运行中`;
  } else {
    taskSummaryEl.textContent = `${done} 个已完成`;
  }
}

function renderTaskList() {
  const taskListEl = document.getElementById('task-list');
  taskListEl.innerHTML = '';
  updateTaskCenterBadge();

  if (state.tasks.length === 0) {
    taskListEl.innerHTML = '<div class="text-center text-slate-500 text-sm py-10">暂无分析任务</div>';
    return;
  }

  state.tasks.forEach(task => {
    const card = document.createElement('div');
    card.className = `task-card ${task.status}`;

    const header = document.createElement('div');
    header.className = 'task-header';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.name;
    const status = document.createElement('div');
    status.className = 'task-status';

    if (task.status === 'running') {
      status.innerHTML = '<span class="spinner"></span> 分析中…';
    } else if (task.status === 'done') {
      status.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> 完成`;
    } else {
      status.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> 失败`;
    }

    header.appendChild(title);
    header.appendChild(status);
    card.appendChild(header);

    if (task.status === 'error') {
      const err = document.createElement('div');
      err.className = 'text-xs text-red-400 mt-1 break-all';
      err.textContent = task.error;
      card.appendChild(err);
    }

    if (task.status === 'done' && task.result) {
      if (task.type === 'single') {
        renderSingleTaskResult(card, task);
      } else if (task.type === 'cluster') {
        renderClusterTaskResult(card, task);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (task.status === 'done') {
      const bindBtn = document.createElement('button');
      bindBtn.className = 'btn btn-primary';
      bindBtn.textContent = '绑定选中';
      bindBtn.addEventListener('click', () => bindFromTask(task));
      actions.appendChild(bindBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-secondary';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => deleteTask(task.id));
    actions.appendChild(delBtn);

    card.appendChild(actions);
    taskListEl.appendChild(card);
  });
}

function renderSingleTaskResult(card, task) {
  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-1 gap-2 mt-2';
  task.result.forEach(sug => {
    const tagText = state.tags[sug.index];
    const item = document.createElement('div');
    item.className = `suggestion-card ${sug.selected ? 'selected' : ''}`;
    item.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-xs text-slate-500 mb-0.5">#${sug.index + 1}</div>
          <div class="text-sm font-medium text-slate-100">${escapeHtml(tagText)}</div>
        </div>
        <div class="text-sm font-bold text-indigo-400">${(sug.confidence * 100).toFixed(0)}%</div>
      </div>
      <div class="confidence-bar"><div class="confidence-fill" style="width:${sug.confidence * 100}%"></div></div>
    `;
    item.addEventListener('click', () => {
      sug.selected = !sug.selected;
      renderTaskList();
    });
    grid.appendChild(item);
  });
  card.appendChild(grid);
}

function renderClusterTaskResult(card, task) {
  task.result.forEach(group => {
    const person = getPerson(group.personId);
    if (!person) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'mt-2 pt-2 border-t border-slate-700/50 first:border-0 first:pt-0';
    const name = document.createElement('div');
    name.className = 'text-xs font-semibold text-slate-300 mb-1';
    name.textContent = person.name;
    wrapper.appendChild(name);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 gap-2';
    group.suggestions.forEach(sug => {
      const tagText = state.tags[sug.index];
      const item = document.createElement('div');
      item.className = `suggestion-card ${sug.selected ? 'selected' : ''}`;
      item.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium text-slate-100 truncate">${escapeHtml(tagText)}</span>
          <span class="text-xs font-bold text-indigo-400">${(sug.confidence * 100).toFixed(0)}%</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">#${sug.index + 1}</div>
      `;
      item.addEventListener('click', () => {
        sug.selected = !sug.selected;
        renderTaskList();
      });
      grid.appendChild(item);
    });
    wrapper.appendChild(grid);
    card.appendChild(wrapper);
  });
}

function bindFromTask(task) {
  let total = 0;
  if (task.type === 'single') {
    const selected = task.result.filter(s => s.selected).map(s => s.index);
    total = bindTagsToPerson(task.personId, selected);
  } else if (task.type === 'cluster') {
    task.result.forEach(group => {
      const selected = group.suggestions.filter(s => s.selected).map(s => s.index);
      total += bindTagsToPerson(group.personId, selected);
    });
  }
  showToast(`已绑定 ${total} 个 tag`);
  renderTaskList();
}

// ===================== 手动绑定管理弹窗（支持搜索） =====================
let modalTagIndex = null;
const bindingModal = document.getElementById('binding-modal');
const modalTagText = document.getElementById('modal-tag-text');
const modalBoundList = document.getElementById('modal-bound-list');
const modalPersonSearch = document.getElementById('modal-person-search');
const modalPersonList = document.getElementById('modal-person-list');

function openBindingModal(tagIndex) {
  if (isTagEmpty(state.tags[tagIndex])) return;
  modalTagIndex = tagIndex;
  modalPersonSearch.value = '';
  bindingModal.classList.remove('hidden');
  renderBindingModal();
  setTimeout(() => modalPersonSearch.focus(), 50);
}

function closeBindingModal() {
  bindingModal.classList.add('hidden');
  modalTagIndex = null;
}

function renderBindingModal() {
  if (modalTagIndex === null) return;
  modalTagText.textContent = state.tags[modalTagIndex];

  modalBoundList.innerHTML = '';
  const boundPeople = state.people.filter(p => p.bindings.includes(modalTagIndex));
  if (boundPeople.length === 0) {
    modalBoundList.innerHTML = '<div class="text-xs text-slate-500 py-2">暂无绑定</div>';
  } else {
    boundPeople.forEach(person => {
      const item = document.createElement('div');
      item.className = 'modal-bound-item';
      item.innerHTML = `<span>${escapeHtml(person.name)}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '移除';
      removeBtn.addEventListener('click', () => {
        unbindTagFromPerson(person.id, modalTagIndex);
        renderBindingModal();
      });
      item.appendChild(removeBtn);
      modalBoundList.appendChild(item);
    });
  }

  renderModalPersonSearch();
}

function renderModalPersonSearch() {
  if (modalTagIndex === null) return;
  const query = modalPersonSearch.value.trim().toLowerCase();
  modalPersonList.innerHTML = '';

  const available = state.people
    .filter(p => !p.bindings.includes(modalTagIndex))
    .filter(p => !query || p.name.toLowerCase().includes(query));

  if (available.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'modal-person-option empty text-slate-500';
    empty.textContent = query ? '未找到匹配成员' : '暂无可用成员';
    modalPersonList.appendChild(empty);
    return;
  }

  available.forEach(person => {
    const div = document.createElement('div');
    div.className = 'modal-person-option';
    div.innerHTML = `<span>${escapeHtml(person.name)}</span><span class="hint">点击绑定</span>`;
    div.addEventListener('click', () => {
      bindTagsToPerson(person.id, [modalTagIndex]);
      renderBindingModal();
    });
    modalPersonList.appendChild(div);
  });
}

// ===================== 导入 / 导出 / 清空 / 示例 / 生产名单 =====================
function exportData() {
  const blob = new Blob([JSON.stringify({ tags: state.tags, people: state.people }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tag-bingo-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 JSON');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.tags) || !Array.isArray(data.people)) throw new Error('格式不正确');
      state.tags = data.tags.slice(0, 25);
      if (state.tags.length < 25) state.tags = state.tags.concat(Array(25 - state.tags.length).fill(''));
      state.people = data.people.map(p => ({
        id: p.id || uid(),
        name: p.name || '未命名',
        description: p.description || '',
        bindings: Array.isArray(p.bindings) ? p.bindings.filter(i => i >= 0 && i < 25) : [],
      }));
      state.selectedPersonId = null;
      state.clusterSelectedIds.clear();
      state.tasks = [];
      saveState();
      renderAll();
      showToast('导入成功');
    } catch (e) {
      showToast('导入失败：' + e.message, 'error');
    }
  };
  reader.readAsText(file);
}

async function clearAll() {
  const ok = await showConfirm('确定清空所有 tag、成员和绑定吗？此操作不可恢复。', '清空全部');
  if (!ok) return;
  try {
    // 直接重置属性，避免替换 state 对象导致潜在引用问题
    state.tags = Array(25).fill('');
    state.people = [];
    state.selectedPersonId = null;
    state.clusterSelectedIds.clear();
    state.tasks = [];
    saveState();
    renderAll();
    showToast('已清空全部数据');
  } catch (e) {
    console.error('清空失败', e);
    showToast('清空时出错：' + e.message, 'error');
  }
}

function loadDemo() {
  state.tags = [
    '剧本杀常客', '特种兵旅行', '咖啡续命', '猫狗双全', '熬夜冠军',
    '健身打卡', '二次元浓度高', '数码发烧友', '做饭翻车选手', '读书会常驻',
    '黑胶唱片收集', '主机游戏党', '胶片摄影', '公益志愿者', '手工 DIY',
    '露营装备党', '陆冲 / 滑板', '书法练字', '追剧到通宵', '密室逃脱坦克',
    '脱口秀观众', '街舞练舞室', '阳台植物园', '烘焙实验家', '城市骑行',
  ];
  state.people = [
    {
      id: uid(),
      name: '小林',
      description: '最近周末不是在骑车就是在找新店打卡，咖啡店和独立书店是我常出没的地方。朋友圈看起来像旅游博主，其实钱包很诚实。喜欢尝试各种手工，做过陶艺也织过围巾，成品一般但过程很治愈。夜猫子属性，凌晨两点还在刷短视频是常态，第二天靠咖啡续命。',
      bindings: [],
    },
    {
      id: uid(),
      name: '阿雯',
      description: '追剧追综艺追番三栖选手，最近同时在追三部剧两部综艺，时间管理能力基本靠倍速播放。喜欢烘焙，虽然蛋糕经常塌 but 不影响我发小红书。对绿植有点执念，家里阳台像小型植物园。社交电量不太稳定，熟人面前话痨，陌生人面前自动开启社恐模式。',
      bindings: [],
    },
    {
      id: uid(),
      name: '浩然',
      description: '运动是我解压的主要方式，跑步、健身、偶尔打篮球，参加过一次半马，目标是下次不被关门。饮食方面很双标，健身餐和奶茶炸鸡交替进行。对科技产品没有抵抗力，耳机键盘换了又换。周末常去线下脱口秀或者livehouse，自认为品味小众但其实歌单都是热榜。',
      bindings: [],
    },
  ];
  state.selectedPersonId = null;
  state.clusterSelectedIds.clear();
  state.tasks = [];
  saveState();
  renderAll();
  showToast('已载入示例数据');
}

async function loadProductionList() {
  const hasData = state.people.length > 0 || state.tags.some(t => t.trim());
  if (hasData) {
    const ok = await showConfirm('载入生产环境名单将清空当前成员与绑定，Tag 表格会保留，是否继续？', '载入生产环境名单');
    if (!ok) return;
  }

  state.people = [];
  state.selectedPersonId = null;
  state.clusterSelectedIds.clear();
  state.tasks = [];

  PRODUCTION_NAMES.forEach(name => {
    state.people.push({ id: uid(), name, description: '', bindings: [] });
  });

  saveState();
  renderAll();
  showToast(`已载入 ${state.people.length} 位生产环境成员`);
}

// ===================== 事件绑定 =====================
document.getElementById('btn-add-person').addEventListener('click', () => {
  const input = document.getElementById('input-new-person');
  addPerson(input.value);
  input.value = '';
});

document.getElementById('input-new-person').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addPerson(e.target.value);
    e.target.value = '';
  }
});

inputSearchPeople.addEventListener('input', (e) => {
  peopleSearchQuery = e.target.value;
  renderPeopleList();
});

document.getElementById('btn-delete-person').addEventListener('click', () => {
  if (state.selectedPersonId) deletePerson(state.selectedPersonId);
});

document.getElementById('btn-save-description').addEventListener('click', saveDescription);
document.getElementById('btn-analyze-person').addEventListener('click', runSingleAnalysis);
document.getElementById('btn-analyze-single-quick').addEventListener('click', runSingleAnalysis);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(`panel-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

document.getElementById('btn-cluster-panel').addEventListener('click', () => {
  document.querySelector('.tab-btn[data-tab="cluster"]').click();
});

document.getElementById('btn-cluster-select-all').addEventListener('click', () => {
  state.people.filter(p => p.description.trim()).forEach(p => state.clusterSelectedIds.add(p.id));
  renderClusterList();
});

document.getElementById('btn-cluster-deselect').addEventListener('click', () => {
  state.clusterSelectedIds.clear();
  renderClusterList();
});

document.getElementById('btn-analyze-cluster').addEventListener('click', runClusterAnalysis);
document.getElementById('btn-clear-tasks').addEventListener('click', clearDoneTasks);

document.getElementById('btn-export').addEventListener('click', exportData);
document.getElementById('input-import').addEventListener('change', (e) => {
  if (e.target.files[0]) importData(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('btn-clear').addEventListener('click', clearAll);
document.getElementById('btn-demo').addEventListener('click', loadDemo);
document.getElementById('btn-load-prod').addEventListener('click', loadProductionList);

// 任务中心侧边栏
taskCenterTab.addEventListener('click', toggleTaskCenter);
document.getElementById('btn-close-task-center').addEventListener('click', () => {
  taskCenter.classList.remove('expanded');
});

// 绑定弹窗
document.getElementById('btn-close-modal').addEventListener('click', closeBindingModal);
modalPersonSearch.addEventListener('input', renderModalPersonSearch);
bindingModal.querySelector('.modal-backdrop').addEventListener('click', closeBindingModal);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!confirmModal.classList.contains('hidden')) {
      closeConfirmModal(false);
      return;
    }
    if (!bindingModal.classList.contains('hidden')) closeBindingModal();
    if (taskCenter.classList.contains('expanded')) taskCenter.classList.remove('expanded');
  }
});

// 深度思考开关
const thinkingCheckbox = document.getElementById('check-thinking');
function updateThinkingUI() {
  if (thinkingCheckbox) thinkingCheckbox.checked = VOLCANO_CONFIG.thinkingEnabled;
}
if (thinkingCheckbox) {
  thinkingCheckbox.addEventListener('change', () => {
    VOLCANO_CONFIG.thinkingEnabled = thinkingCheckbox.checked;
    saveThinkingType(thinkingCheckbox.checked);
    showToast(thinkingCheckbox.checked ? '深度思考已开启' : '深度思考已关闭');
  });
}

// ===================== 初始化 =====================
function renderAll() {
  renderTagBoard();
  renderPeopleList();
  renderPersonEditor();
  renderClusterList();
  renderTaskList();
}

loadState();
loadThinkingType();
renderAll();
updateThinkingUI();
