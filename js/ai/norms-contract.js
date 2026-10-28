// Общие ограничения клиента и прокси: документы не обрезаются незаметно.
export const EXTRACTION_LIMITS = {
  fileBytes: 16 * 1024 * 1024,
  bodyBytes: 24 * 1024 * 1024,
  textChars: 400000,
  entries: 1000,
};

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const NORMS_EXTENSIONS = /\.(docx|pdf|xlsx|xlsm|xls|ods|txt|csv|png|jpe?g|webp|gif)$/i;

function binary(data) {
  if (typeof data !== 'string' || !data.length || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Повреждённые данные файла');
  const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > EXTRACTION_LIMITS.fileBytes) throw new Error('Файл больше 16 МБ. Разделите документ на части.');
  return bytes;
}

/** Возвращает только разрешённые поля, без произвольных блоков сообщений API. */
export function validateNormsDocument(input) {
  if (!input || typeof input !== 'object') throw new Error('Не передан документ нормативов');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 300) {
    throw new Error('Не указано имя документа');
  }
  const document = { name: input.name, mediaType: input.mediaType };
  if (input.mediaType === 'text/plain') {
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('В документе нет текста');
    if (input.text.length > EXTRACTION_LIMITS.textChars) {
      throw new Error('Документ слишком большой. Разделите его на части: текст не был обрезан.');
    }
    document.text = input.text;
    let total = 0;
    if (input.images !== undefined && !Array.isArray(input.images)) throw new Error('Неверный список изображений');
    document.images = (input.images || []).map((item) => {
      if (!IMAGE_TYPES.has(item.mediaType)) throw new Error('Неподдерживаемый формат вложенного изображения');
      total += binary(item.data);
      return { mediaType: item.mediaType, data: item.data };
    });
    if (document.images.length > 50 || total > EXTRACTION_LIMITS.fileBytes) {
      throw new Error('Слишком много вложенных изображений. Разделите документ на части.');
    }
  } else if (input.mediaType === 'application/pdf' || IMAGE_TYPES.has(input.mediaType)) {
    binary(input.data);
    document.data = input.data;
  } else {
    throw new Error('Неподдерживаемый формат документа');
  }
  return document;
}
