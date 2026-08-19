// Состояние приложения и связывание этапов обработки.

import { parseNorms, applyLayouts } from './parse/norms.js';
import { parseRegistryWorkbook, aggregateRegistry, buildRegistrySample } from './parse/registry.js';
import { parseTemplate } from './parse/template.js';
import {
  templateCategories, matchNorms, matchRegistryCategories, matchZones, STATUS,
} from './lib/match.js';
import { buildResults } from './lib/calc.js';
import { verify } from './lib/verify.js';
import { fillTemplate } from './export/fill.js';
import { buildReportWorkbook } from './export/report.js';
import { normalize } from './lib/text.js';
import { el, $, clear, toast, withOverlay, download } from './ui/dom.js';
import { renderNormsMapping } from './ui/mapping-view.js';
import { renderFiles, renderZones, renderRegistryMapping, renderResults, renderCheck } from './ui/views.js';
import { renderAi } from './ui/ai-view.js';
import {
  getEndpoint, setEndpoint, validateEndpoint, requestNormsMarkup, requestRegistryMarkup,
  isCustomEndpoint,
} from './ai/client.js';
import { buildSample, validateMarkup, compare } from './ai/norms-markup.js';
import {
  describeSample as describeRegistrySample, validateMarkup as validateRegistryMarkup,
} from './ai/registry-markup.js';

const RULES_STORAGE_KEY = 'tko-ioo.rules.v1';

const libs = { JSZip: globalThis.JSZip, XLSX: globalThis.XLSX };

const state = {
  files: [],
  template: null,
  norms: null,
  registryFiles: [],
  registry: null,
  categories: [],
  templateZones: [],
  normById: new Map(),
  normMapping: new Map(),
  registryMapping: new Map(),
  zoneMapping: new Map(),
  results: null,
  verification: null,
  // Правила, заданные пользователем: переживают повторную загрузку файлов.
  rules: { norms: {}, registry: {}, zones: {} },
  ai: {
    endpoint: '',
    norms: { status: 'idle', proposal: null, error: null, sample: null },
    registry: { status: 'idle', proposal: null, error: null, sample: null },
  },
  step: 'files',
};

let fileCounter = 0;

/* ------------------------------------------------------------------ файлы */

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsArrayBuffer(file);
  });
}

/** Определяет вид файла по содержимому, с опорой на имя как на подсказку. */
function detectKind(file, arrayBuffer) {
  // Реестр и общие сведения приходят только книгами Excel, поэтому приказ —
  // единственное, что бывает в .docx и .pdf.
  if (/\.(docx|pdf)$/i.test(file.name)) return 'norms';
  let headerText = '';
  try {
    const workbook = libs.XLSX.read(arrayBuffer, { type: 'array', sheetRows: 30 });
    const parts = [workbook.SheetNames.join(' ')];
    for (const name of workbook.SheetNames) {
      const grid = libs.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
      parts.push(grid.slice(0, 12).map((row) => row.join(' ')).join(' '));
    }
    headerText = normalize(parts.join(' '));
  } catch {
    headerText = '';
  }
  if (/коэффициент плотности|расчетн[а-я]* масс/.test(headerText)) return 'template';
  if (/наименование категори/.test(headerText) && /куб|кг в год|норматив накопления/.test(headerText)) return 'norms';
  if (/категор/.test(headerText) && /расчетн/.test(headerText)) return 'registry';
  if (/норматив/i.test(file.name)) return 'norms';
  if (/общи[хе]\s*сведени/i.test(file.name)) return 'template';
  if (/реестр|иоо/i.test(file.name)) return 'registry';
  return 'unknown';
}

async function parseEntry(entry) {
  entry.error = null;
  entry.info = 'Обработка…';
  if (entry.kind === 'template') {
    const template = await parseTemplate(entry.buffer.slice(0), entry.name, libs.JSZip);
    entry.parsed = template;
    entry.info = `лист «${template.sheetName}», строк данных: ${template.rows.length}, ` +
      `столбцы: ${Object.keys(template.columns).length}`;
  } else if (entry.kind === 'norms') {
    const norms = applySavedLayout(await parseNorms({ name: entry.name }, entry.buffer.slice(0), libs));
    entry.parsed = norms;
    entry.info = norms.entries.length
      ? `нормативов: ${norms.entries.length}, таблиц: ${norms.tables.length}`
        + (norms.skipped.length ? `, пропущено таблиц: ${norms.skipped.length}` : '')
        + (norms.source !== 'эвристика' ? `, разметка: ${norms.source}` : '')
      : `таблиц в файле: ${norms.rawTables.length}, нормативы не распознаны`;
  } else if (entry.kind === 'registry') {
    const registry = parseRegistryWorkbook(
      entry.buffer.slice(0), entry.name, libs.XLSX, savedRegistryMarkup(),
    );
    entry.parsed = registry;
    entry.info = `лист «${registry.sheetName}», строк: ${registry.rows.length}`
      + (registry.hasUnits ? '' : ', без количества расчётных единиц')
      + (registry.source !== 'эвристика' ? `, разметка: ${registry.source}` : '')
      + (registry.warningsTotal ? `, предупреждений: ${registry.warningsTotal}` : '');
  } else {
    entry.info = 'Укажите вид файла вручную';
  }
}

async function addFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length) return;
  await withOverlay('Чтение файлов…', async () => {
    for (const file of incoming) {
      const entry = {
        id: `f${(fileCounter += 1)}`,
        name: file.name,
        size: file.size,
        buffer: null,
        kind: 'unknown',
        parsed: null,
        error: null,
        info: '',
      };
      state.files.push(entry);
      try {
        entry.buffer = await readFile(file);
        entry.kind = detectKind(file, entry.buffer.slice(0));
        await parseEntry(entry);
      } catch (error) {
        entry.error = error.message;
        entry.info = '';
      }
    }
    collectParsed();
  });
  refreshAll();
}

/**
 * Применяет разметку, сохранённую при прошлой обработке.
 * Файл мог смениться, поэтому результат принимается только если он осмыслен.
 */
function savedRegistryMarkup() {
  const saved = state.rules.registryMarkup;
  if (!saved || !saved.columns) return null;
  return { ...saved, source: `${saved.source || 'разметка'} (сохранена)` };
}

function applySavedLayout(norms) {
  const saved = state.rules.normsLayout;
  if (!saved) return norms;
  try {
    const result = applyLayouts(norms, { ...saved, source: `${saved.source || 'разметка'} (сохранена)` });
    if (result.entries.length < 2) return norms;
    return result;
  } catch {
    return norms;
  }
}

/** Пересобирает разобранные данные из списка файлов. */
function collectParsed() {
  const template = state.files.find((item) => item.kind === 'template' && item.parsed);
  const norms = state.files.find((item) => item.kind === 'norms' && item.parsed);
  const registries = state.files.filter((item) => item.kind === 'registry' && item.parsed);

  state.template = template ? template.parsed : null;
  state.norms = norms ? norms.parsed : null;
  state.registryFiles = registries.map((item) => item.parsed);
  state.registry = state.registryFiles.length ? aggregateRegistry(state.registryFiles) : null;

  if (state.template && state.norms && state.registry) buildMappings();
  else {
    state.results = null;
    state.verification = null;
  }
}

/* -------------------------------------------------------- сопоставления */

function buildMappings() {
  state.categories = templateCategories(state.template.rows);
  state.normById = new Map(state.norms.entries.map((entry) => [entry.id, entry]));
  state.normMapping = matchNorms(state.categories, state.norms.entries);
  state.registryMapping = matchRegistryCategories(state.registry.categories, state.categories);
  const zones = matchZones(state.registry.zones, state.template.rows);
  state.zoneMapping = zones.zoneMapping;
  state.templateZones = zones.templateZones;
  applyRules();
  recalculate();
}

/** Накладывает сохранённые пользовательские правила поверх автоподбора. */
function applyRules() {
  const byName = new Map(state.norms.entries.map((entry) => [normalize(entry.name), entry.id]));

  for (const [key, rule] of Object.entries(state.rules.norms)) {
    const mapping = state.normMapping.get(key);
    if (!mapping) continue;
    const entryId = rule.entryName ? byName.get(normalize(rule.entryName)) : null;
    const expression = rule.expression
      ? rule.expression.replace(/\[@([^\]]+)\]/g, (match, name) => {
        const id = byName.get(normalize(name));
        return id ? `[${id}]` : match;
      })
      : '';
    Object.assign(mapping, {
      mode: rule.mode,
      entryId: entryId || null,
      expression,
      manualMass: Number.isFinite(rule.manualMass) ? rule.manualMass : null,
      manualVolume: Number.isFinite(rule.manualVolume) ? rule.manualVolume : null,
      auto: false,
      status: statusForMode(rule.mode, entryId),
    });
  }

  for (const [key, templateKey] of Object.entries(state.rules.registry)) {
    const mapping = state.registryMapping.get(key);
    if (!mapping) continue;
    mapping.templateKey = templateKey || null;
    mapping.auto = false;
    mapping.status = templateKey ? STATUS.MANUAL : STATUS.IGNORED;
  }

  for (const [key, templateKey] of Object.entries(state.rules.zones)) {
    const mapping = state.zoneMapping.get(key);
    if (!mapping) continue;
    mapping.templateKey = templateKey || null;
    mapping.auto = false;
    mapping.status = templateKey ? STATUS.MANUAL : STATUS.IGNORED;
  }
}

function statusForMode(mode, entryId) {
  if (mode === 'formula') return STATUS.FORMULA;
  if (mode === 'manual') return STATUS.MANUAL;
  if (mode === 'none') return STATUS.IGNORED;
  return entryId ? STATUS.MANUAL : STATUS.NONE;
}

/** Сохраняет правило в переносимом виде — по наименованиям, а не по номерам. */
function storeNormRule(key) {
  const mapping = state.normMapping.get(key);
  const entry = mapping.entryId ? state.normById.get(mapping.entryId) : null;
  state.rules.norms[key] = {
    mode: mapping.mode,
    entryName: entry ? entry.name : null,
    expression: (mapping.expression || '').replace(/\[([^\]@]+)\]/g, (match, id) => {
      const target = state.normById.get(id.trim());
      return target ? `[@${target.name}]` : match;
    }),
    manualMass: mapping.manualMass,
    manualVolume: mapping.manualVolume,
  };
  persistRules();
}

function persistRules() {
  try {
    localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(state.rules));
  } catch {
    // Приватный режим браузера — сохранение недоступно, работа продолжается.
  }
}

function restoreRules() {
  try {
    const saved = localStorage.getItem(RULES_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      state.rules = {
        norms: parsed.norms || {},
        registry: parsed.registry || {},
        zones: parsed.zones || {},
        normsLayout: parsed.normsLayout || undefined,
      };
    }
  } catch {
    state.rules = { norms: {}, registry: {}, zones: {} };
  }
}

/* ----------------------------------------------------------------- расчёт */

function recalculate() {
  if (!state.template || !state.norms || !state.registry) return;
  state.results = buildResults({
    templateRows: state.template.rows,
    registryGroups: state.registry.groups,
    registryMapping: state.registryMapping,
    zoneMapping: state.zoneMapping,
    normMapping: state.normMapping,
    normById: state.normById,
  });
  state.verification = verify({
    results: state.results,
    registry: state.registry,
    normById: state.normById,
    normMapping: state.normMapping,
    templateRows: state.template.rows,
  });
}

/* --------------------------------------------------------------- действия */

const actions = {
  async changeKind(id, kind) {
    const entry = state.files.find((item) => item.id === id);
    if (!entry || entry.kind === kind) return;
    entry.kind = kind;
    entry.parsed = null;
    await withOverlay('Разбор файла…', async () => {
      try {
        await parseEntry(entry);
      } catch (error) {
        entry.error = error.message;
      }
      collectParsed();
    });
    refreshAll();
  },

  removeFile(id) {
    state.files = state.files.filter((item) => item.id !== id);
    collectParsed();
    refreshAll();
  },

  setNormRule(key, patch) {
    const mapping = state.normMapping.get(key);
    if (!mapping) return;
    Object.assign(mapping, patch);
    mapping.auto = false;
    mapping.status = statusForMode(mapping.mode, mapping.entryId);
    storeNormRule(key);
    recalculate();
    refreshData();
  },

  resetNormRule(key) {
    delete state.rules.norms[key];
    persistRules();
    const auto = matchNorms(state.categories.filter((item) => item.key === key), state.norms.entries);
    state.normMapping.set(key, auto.get(key));
    recalculate();
    refreshData();
  },

  setRegistryRule(key, templateKey) {
    const mapping = state.registryMapping.get(key);
    if (!mapping) return;
    mapping.templateKey = templateKey;
    mapping.auto = false;
    mapping.status = templateKey ? STATUS.MANUAL : STATUS.IGNORED;
    state.rules.registry[key] = templateKey;
    persistRules();
    recalculate();
    refreshData();
  },

  resetRegistryRule(key) {
    delete state.rules.registry[key];
    persistRules();
    const category = state.registry.categories.filter((item) => item.key === key);
    const auto = matchRegistryCategories(category, state.categories);
    state.registryMapping.set(key, auto.get(key));
    recalculate();
    refreshData();
  },

  aiSaveEndpoint(url) {
    const problem = url ? validateEndpoint(url) : null;
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setEndpoint(url);
    state.ai.endpoint = getEndpoint();
    document.getElementById('ai-endpoint').value = state.ai.endpoint;
    toast(url ? 'Адрес прокси сохранён' : 'Возвращён адрес, встроенный в программу', 'ok');
    renderAi(state, actions);
  },

  async aiRun() {
    if (!state.norms || !state.ai.endpoint) return;
    const task = state.ai.norms;
    Object.assign(task, { status: 'running', error: null, proposal: null, sample: null });
    renderAi(state, actions);
    try {
      task.sample = buildSample(state.norms);
      const answer = await requestNormsMarkup(state.ai.endpoint, task.sample);
      const checked = validateMarkup(state.norms, answer.result);
      if (checked.ok) checked.compare = compare(state.norms, checked.preview);
      task.proposal = checked;
      if (!checked.ok) toast('Предложение помощника по нормативам не прошло проверку', 'error');
    } catch (error) {
      task.error = error.message;
      toast(error.message, 'error');
    }
    task.status = 'idle';
    renderAi(state, actions);
  },

  async aiRunRegistry() {
    const entry = state.files.find((item) => item.kind === 'registry');
    if (!entry || !entry.buffer || !state.ai.endpoint) return;
    const task = state.ai.registry;
    Object.assign(task, { status: 'running', error: null, proposal: null, sample: null });
    renderAi(state, actions);
    try {
      task.sample = buildRegistrySample(entry.buffer.slice(0), libs.XLSX);
      const answer = await requestRegistryMarkup(state.ai.endpoint, task.sample);
      task.proposal = validateRegistryMarkup(
        entry.buffer.slice(0), task.sample, answer.result, entry.name, libs.XLSX,
      );
      if (!task.proposal.ok) toast('Предложение помощника по реестру не прошло проверку', 'error');
    } catch (error) {
      task.error = error.message;
      toast(error.message, 'error');
    }
    task.status = 'idle';
    renderAi(state, actions);
  },

  aiApply() {
    const proposal = state.ai.norms.proposal;
    if (!proposal || !proposal.ok) return;
    const entry = state.files.find((item) => item.kind === 'norms' && item.parsed);
    if (entry) {
      entry.parsed = proposal.preview;
      entry.info = `нормативов: ${proposal.preview.entries.length}, `
        + `таблиц: ${proposal.preview.tables.length}, разметка: ${proposal.preview.source}`;
    }
    state.rules.normsLayout = proposal.markup;
    persistRules();
    state.ai.norms.proposal = null;
    collectParsed();
    refreshAll();
    toast(`Разметка нормативов применена: ${proposal.preview.entries.length}`, 'ok');
  },

  aiApplyRegistry() {
    const proposal = state.ai.registry.proposal;
    if (!proposal || !proposal.ok) return;
    const entry = state.files.find((item) => item.kind === 'registry');
    if (entry) {
      entry.parsed = proposal.parsed;
      entry.info = `лист «${proposal.parsed.sheetName}», строк: ${proposal.parsed.rows.length}`
        + (proposal.parsed.hasUnits ? '' : ', без количества расчётных единиц')
        + `, разметка: ${proposal.parsed.source}`;
    }
    state.rules.registryMarkup = proposal.markup;
    persistRules();
    state.ai.registry.proposal = null;
    collectParsed();
    refreshAll();
    toast(`Разметка реестра применена: строк ${proposal.parsed.rows.length}`, 'ok');
  },

  aiDismiss(which) {
    const task = state.ai[which];
    task.proposal = null;
    task.sample = null;
    task.error = null;
    renderAi(state, actions);
  },

  aiReset(which) {
    if (which === 'registry') delete state.rules.registryMarkup;
    else delete state.rules.normsLayout;
    persistRules();
    const kind = which === 'registry' ? 'registry' : 'norms';
    const entry = state.files.find((item) => item.kind === kind);
    if (!entry) return;
    withOverlay('Повторный разбор…', async () => {
      try {
        entry.parsed = null;
        await parseEntry(entry);
      } catch (error) {
        entry.error = error.message;
      }
      collectParsed();
    }).then(() => refreshAll());
  },

  setZoneRule(key, templateKey) {
    const mapping = state.zoneMapping.get(key);
    if (!mapping) return;
    mapping.templateKey = templateKey;
    mapping.auto = false;
    mapping.status = templateKey ? STATUS.MANUAL : STATUS.IGNORED;
    state.rules.zones[key] = templateKey;
    persistRules();
    recalculate();
    refreshData();
  },
};

/* ------------------------------------------------------------ отображение */

function refreshData() {
  if (state.template && state.norms && state.registry) {
    renderNormsMapping(state, actions);
    renderZones(state, actions);
    renderRegistryMapping(state, actions);
    renderResults(state);
    renderCheck(state);
  }
  updateSteps();
}

function refreshAll() {
  renderFiles(state, actions);
  renderAi(state, actions);
  refreshData();
}

function updateSteps() {
  const ready = Boolean(state.template && state.norms && state.registry);
  for (const button of document.querySelectorAll('.step')) {
    const step = button.dataset.step;
    button.disabled = step !== 'files' && !ready;
    button.classList.toggle('active', step === state.step);
    button.classList.toggle('done', ready && step !== state.step);
  }
  for (const panel of document.querySelectorAll('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== state.step;
  }
}

function goToStep(step) {
  state.step = step;
  updateSteps();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------- выгрузка */

function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function logLine(message) {
  document.getElementById('export-log').prepend(el('div', {}, message));
}

async function downloadTemplate() {
  if (!state.results) return;
  await withOverlay('Формирование файла…', async () => {
    const blob = await fillTemplate(state.template, state.results);
    const name = `${baseName(state.template.fileName)}_заполнено_${timestamp()}.xlsx`;
    download(blob, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    logLine(`Сохранён файл общих сведений: ${name}`);
  });
  toast('Файл общих сведений сохранён', 'ok');
}

async function downloadReport() {
  if (!state.results) return;
  await withOverlay('Формирование отчёта…', async () => {
    const data = buildReportWorkbook({
      categories: state.categories,
      normMapping: state.normMapping,
      normById: state.normById,
      results: state.results,
      registry: state.registry,
      registryMapping: state.registryMapping,
      categoryByKey: new Map(state.categories.map((item) => [item.key, item])),
      norms: state.norms,
      verification: state.verification,
      meta: {
        templateFile: state.template.fileName,
        normsFile: state.norms.fileName,
        registryFiles: state.registryFiles.map((item) => item.fileName),
        generatedAt: new Date().toLocaleString('ru-RU'),
      },
    }, libs.XLSX);
    const name = `Отчёт_сопоставление_и_проверка_${timestamp()}.xlsx`;
    download(new Blob([data]), name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    logLine(`Сохранён отчёт: ${name}`);
  });
  toast('Отчёт сохранён', 'ok');
}

function downloadRules() {
  const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), rules: state.rules }, null, 2);
  const name = `Правила_сопоставления_${timestamp()}.json`;
  download(new Blob([payload], { type: 'application/json' }), name, 'application/json');
  logLine(`Сохранены правила сопоставления: ${name}`);
}

async function loadRules(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const rules = parsed.rules || parsed;
    state.rules = {
      norms: rules.norms || {},
      registry: rules.registry || {},
      zones: rules.zones || {},
      normsLayout: rules.normsLayout || undefined,
      registryMarkup: rules.registryMarkup || undefined,
    };
    persistRules();
    if (state.template && state.norms && state.registry) buildMappings();
    refreshAll();
    toast('Правила сопоставления применены', 'ok');
    logLine(`Загружены правила из файла ${file.name}`);
  } catch (error) {
    toast(`Не удалось прочитать правила: ${error.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ старт */

function bind() {
  const dropzone = $('#dropzone');
  const input = $('#file-input');

  input.addEventListener('change', () => {
    addFiles(input.files).catch((error) => toast(error.message, 'error'));
    input.value = '';
  });

  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('over');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('over');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) addFiles(files).catch((error) => toast(error.message, 'error'));
  });

  for (const button of document.querySelectorAll('.step')) {
    button.addEventListener('click', () => goToStep(button.dataset.step));
  }

  $('#norms-filter').addEventListener('change', () => renderNormsMapping(state, actions));
  $('#norms-search').addEventListener('input', () => renderNormsMapping(state, actions));
  $('#registry-filter').addEventListener('change', () => renderRegistryMapping(state, actions));
  $('#registry-search').addEventListener('input', () => renderRegistryMapping(state, actions));
  $('#result-only-data').addEventListener('change', () => renderResults(state));

  $('#download-template').addEventListener('click', () => {
    downloadTemplate().catch((error) => toast(error.message, 'error'));
  });
  $('#download-report').addEventListener('click', () => {
    downloadReport().catch((error) => toast(error.message, 'error'));
  });
  const endpointInput = $('#ai-endpoint');
  endpointInput.value = state.ai.endpoint;
  $('#ai-save').addEventListener('click', () => actions.aiSaveEndpoint(endpointInput.value.trim()));
  $('#ai-run').addEventListener('click', () => actions.aiRun());
  $('#ai-run-registry').addEventListener('click', () => actions.aiRunRegistry());

  $('#download-rules').addEventListener('click', downloadRules);
  $('#rules-input').addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) loadRules(file);
    event.target.value = '';
  });

  window.addEventListener('error', (event) => toast(`Сбой: ${event.message}`, 'error'));
  window.addEventListener('unhandledrejection', (event) => {
    toast(`Сбой: ${event.reason && event.reason.message ? event.reason.message : event.reason}`, 'error');
  });
}

function checkLibraries() {
  if (libs.JSZip && libs.XLSX) return true;
  clear(document.querySelector('main')).append(
    el('section.panel', {}, [
      el('h2', {}, 'Не загрузились компоненты приложения'),
      el('p.hint', {}, 'Обновите страницу. Если ошибка повторяется, очистите кэш браузера.'),
    ]),
  );
  return false;
}

restoreRules();
state.ai.endpoint = getEndpoint();
if (checkLibraries()) {
  bind();
  updateSteps();
}
