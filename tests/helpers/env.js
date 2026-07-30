// Подключает браузерные глобальные объекты, необходимые парсерам, в среде Node.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

export const libs = { JSZip, XLSX };

export function buffer(path) {
  const data = readFileSync(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}
