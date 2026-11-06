// Подготовка полного документа и приведение извлечённых ИИ нормативов к расчётной схеме.
import { unitBasis } from '../lib/units.js';
import { EXTRACTION_LIMITS, IMAGE_TYPES, validateNormsDocument } from './norms-contract.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const children = (node, name) => Array.from(node.childNodes || [])
  .filter((child) => child.nodeType === 1 && (!name || child.localName === name));
function wordText(node) {
  if (node.localName === 't') return node.textContent;
  if (node.localName === 'tab') return '\t';
  if (node.localName === 'br' || node.localName === 'cr') return '\n';
  if (node.localName === 'footnoteReference' || node.localName === 'endnoteReference') {
    return `[сноска ${node.getAttributeNS(W, 'id')}]`;
  }
  return children(node).map(wordText).join('');
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(text);
}

/** Все абзацы и таблицы в исходном порядке, включая пустые и объединённые ячейки. */
function wordDocument(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('Повреждённый DOCX');
  let tableNumber = 0;
  function walk(node) {
    if (node.localName === 'p') return wordText(node);
    if (node.localName === 'footnote' || node.localName === 'endnote') {
      return `Сноска ${node.getAttributeNS(W, 'id')}: ${children(node).map(walk).join('\n')}`;
    }
    if (node.localName === 'tbl') {
      tableNumber += 1;
      return `Таблица ${tableNumber}\n` + children(node, 'tr').map((row, index) => {
        const cells = children(row, 'tc').map((cell) => {
          const span = cell.getElementsByTagNameNS(W, 'gridSpan')[0];
          const merge = cell.getElementsByTagNameNS(W, 'vMerge')[0];
          const attr = (item) => item?.getAttributeNS(W, 'val') || item?.getAttribute('w:val');
          return {
            text: children(cell).filter((part) => part.localName !== 'tcPr').map(walk).join('\n'),
            ...(span ? { columns: Number(attr(span)) } : {}),
            ...(merge ? { verticalMerge: attr(merge) || 'continue' } : {}),
          };
        });
        return `Строка ${index + 1}: ${JSON.stringify(cells)}`;
      }).join('\n');
    }
    return children(node).map(walk).filter(Boolean).join('\n');
  }
  return walk(document.documentElement);
}

/** Здесь нет поиска «подходящих» таблиц: ИИ получает весь исходный материал. */
export async function prepareNormsDocument(file, buffer, libs) {
  if (buffer.byteLength > EXTRACTION_LIMITS.fileBytes) throw new Error('Файл больше 16 МБ. Разделите документ на части.');
  const name = file.name;
  const extension = name.split('.').pop().toLowerCase();
  if (extension === 'pdf') {
    return validateNormsDocument({ name, mediaType: 'application/pdf', data: toBase64(buffer) });
  }
  const imageType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[extension];
  if (imageType) return validateNormsDocument({ name, mediaType: imageType, data: toBase64(buffer) });
  let text;
  const images = [];
  if (extension === 'docx') {
    const zip = await libs.JSZip.loadAsync(buffer);
    if (!zip.file('word/document.xml')) throw new Error('Файл не является DOCX');
    const paths = ['word/document.xml', ...Object.keys(zip.files).filter((path) =>
      /^word\/(footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(path))];
    const parts = [];
    for (const path of paths) parts.push(`${path}\n${wordDocument(await zip.file(path).async('string'))}`);
    text = parts.join('\n\n');
    for (const path of Object.keys(zip.files).filter((path) => /^word\/media\//.test(path) && !zip.files[path].dir)) {
      const ext = path.split('.').pop().toLowerCase();
      const mediaType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
      if (IMAGE_TYPES.has(mediaType)) images.push({ mediaType, data: await zip.file(path).async('base64') });
      else text += `\nВложение ${path}: изображение этого формата не прочитано; если оно содержит нормативы, сообщи о неполном извлечении.`;
    }
  } else if (/^(xlsx|xlsm|xls|ods)$/.test(extension)) {
    const workbook = libs.XLSX.read(buffer, { type: 'array', cellDates: false });
    text = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = libs.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true, range: 0 });
      return `Лист ${JSON.stringify(sheetName)}\nОбъединения: ${JSON.stringify(sheet['!merges'] || [])}\n`
        + rows.map((row, i) => `Строка ${i + 1}: ${JSON.stringify(row)}`).join('\n');
    }).join('\n\n');
  } else if (extension === 'txt' || extension === 'csv') {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } else {
    throw new Error('Для нормативов поддерживаются PDF, DOCX, Excel/ODS, TXT/CSV и изображения PNG/JPEG/WebP/GIF. Сохраните другой формат в PDF.');
  }
  return validateNormsDocument({ name, mediaType: 'text/plain', text, images });
}

export function describeNormsDocument(document) {
  if (!document) return '';
  if (document.mediaType === 'application/pdf') return `Исходный PDF «${document.name}» целиком, включая изображения страниц. Предварительное OCR не требуется.`;
  if (document.mediaType.startsWith('image/')) return `Изображение «${document.name}» целиком.`;
  return `Документ «${document.name}»: полный текст и все таблицы${document.images?.length ? `, изображений: ${document.images.length}` : ''}.\n\n${document.text}`;
}

const PERIODS = { year: 1, month: 12, day: 365 };
const MASS = { kg: 1, t: 1000, g: 0.001 };
const VOLUME = { m3: 1, l: 0.001 };

function measure(input, factors, label) {
  if (input === null) return null;
  if (!input || typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0) {
    throw new Error(`${label}: требуется неотрицательное число или null`);
  }
  if (!Object.hasOwn(factors, input.unit) || !Object.hasOwn(PERIODS, input.period)
    || typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error(`${label}: неизвестная размерность, период или количество расчётных единиц`);
  }
  const value = input.value * factors[input.unit] * PERIODS[input.period] / input.quantity;
  if (!Number.isFinite(value)) throw new Error(`${label}: значение слишком большое`);
  return value;
}

/** Проверяем структуру; визуальную точность распознавания должен проверить пользователь. */
export function validateExtractedNorms(fileName, answer, fallback = {}) {
  const problems = [];
  if (!answer || answer.complete !== true) {
    problems.push('ИИ не подтвердил обработку всего документа. Неполный результат не применён.');
    if (Array.isArray(answer?.warnings)) problems.push(...answer.warnings.map(clean).filter(Boolean));
    if (clean(answer?.reason)) problems.push(clean(answer.reason));
  }
  if (!Array.isArray(answer?.entries) || !answer.entries.length) problems.push('В документе не извлечено ни одного норматива.');
  if (answer?.entries?.length > EXTRACTION_LIMITS.entries) problems.push('Слишком много нормативов; разделите документ на части.');
  if (problems.length) return { ok: false, problems };
  const entries = [];
  for (const [index, item] of answer.entries.entries()) {
    try {
      const category = clean(item.name);
      const context = clean(item.context);
      const unitText = clean(item.unit);
      const sourceLocation = clean(item.source?.location);
      const sourceQuote = clean(item.source?.quote);
      if (!category || !unitText || !sourceLocation || !sourceQuote) throw new Error('не указаны категория, расчётная единица или источник');
      const mass = measure(item.mass, MASS, 'масса');
      const volume = measure(item.volume, VOLUME, 'объём');
      entries.push({
        id: `n${index}`, name: context ? `${category} — ${context}` : category, category, context,
        unitText, basis: unitBasis(unitText) || 'other', mass, volume,
        rawMass: item.mass?.value ?? null, rawVolume: item.volume?.value ?? null,
        massUnit: item.mass?.unit || '', volumeUnit: item.volume?.unit || '',
        originalMass: item.mass, originalVolume: item.volume,
        sourceLocation, sourceQuote, table: context || sourceLocation, file: fileName,
      });
    } catch (error) {
      problems.push(`Норматив ${index + 1}: ${error.message}`);
    }
  }
  if (problems.length) return { ok: false, problems };
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.table)) groups.set(entry.table, { index: groups.size, title: entry.table, count: 0 });
    groups.get(entry.table).count += 1;
  }
  const warnings = Array.isArray(answer.warnings) ? answer.warnings.map(clean).filter(Boolean) : [];
  const withoutValues = entries.filter((entry) => entry.mass === null && entry.volume === null);
  if (withoutValues.length) {
    warnings.push(`В документе не указаны ни масса, ни объём для ${withoutValues.length} записей: `
      + withoutValues.map((entry) => `${entry.name} (${entry.unitText})`).join('; ')
      + '. Эти строки сохранены без значений, прочерки не заменены нулями.');
  }
  const preview = {
    ...fallback, fileName, entries, tables: [...groups.values()], skipped: [],
    rawTables: fallback.rawTables || [], source: 'ИИ: извлечение нормативов', warnings,
  };
  return {
    ok: true, problems: [], preview,
    summary: { count: entries.length, withMass: entries.filter((entry) => entry.mass !== null).length,
      withVolume: entries.filter((entry) => entry.volume !== null).length,
      withoutValues: withoutValues.length, warnings, reason: clean(answer.reason) },
  };
}
