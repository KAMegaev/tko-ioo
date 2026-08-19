// Чтение PDF: pdf.js достаёт обрывки текста с координатами,
// восстановление таблиц из них — в pdf-layout.js.

import { tablesFromPages } from './pdf-layout.js';
import { tablesFromScanPages } from './pdf-scan.js';

const VENDOR = new URL('../../vendor/', import.meta.url);

let loading = null;

/**
 * Подгружает pdf.js по требованию: библиотека весит больше остальных вместе
 * взятых, а нужна только тем, кто принёс приказ в PDF.
 */
export function loadPdfjs() {
  if (!loading) {
    loading = import(new URL('pdf.min.mjs', VENDOR).href).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;
      return pdfjs;
    }).catch((error) => {
      loading = null;
      throw new Error(`Не удалось загрузить чтение PDF: ${error.message}`);
    });
  }
  return loading;
}

/**
 * Возвращает таблицы документа в том же виде, что и разбор .docx: сетка строк
 * и подпись перед таблицей.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} [pdfjsLib] готовая библиотека; по умолчанию подгружается сама
 * @returns {Promise<Array<{title: string, grid: string[][]}>>}
 */
export async function readPdfTables(arrayBuffer, pdfjsLib = null) {
  const pdfjs = pdfjsLib || await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const document = await task.promise;
  const pages = [];
  let textItems = 0;
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        // transform: [a, b, c, d, e, f]; e и f — левый край и базовая линия.
        const [, , , scaleY, x, y] = item.transform;
        items.push({
          text: item.str,
          x,
          y: viewport.height - y, // отсчёт сверху вниз — как читают страницу
          width: item.width,
          height: item.height || Math.abs(scaleY) || 10,
        });
      }
      textItems += items.length;
      pages.push(items);
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }

  if (!textItems) {
    throw new Error('В PDF нет текстового слоя — похоже, это скан без распознавания. '
      + 'Распознайте его (OCR) или возьмите приказ в .docx либо .xlsx.');
  }
  return isScanned(pages) ? tablesFromScanPages(pages) : tablesFromPages(pages);
}

/**
 * Скан это или PDF, сделанный из Word.
 *
 * PDF из редактора пишет текст ячейками — в куске обычно несколько слов.
 * Распознавание скана выдаёт слова поодиночке, и разбирать такой файл надо
 * иначе: по расположению текста на странице, а не по порядку записи.
 */
export function isScanned(pages) {
  const items = pages.flat();
  if (!items.length) return false;
  const multiWord = items.filter((item) => /\s/.test(item.text.trim())).length;
  return multiWord < items.length * 0.2;
}
