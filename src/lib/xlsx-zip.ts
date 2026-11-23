import { deflateRawSync, inflateRawSync } from "node:zlib";

const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;

export class XlsxInputError extends Error {
  constructor(message: string) { super(message); this.name = "XlsxInputError"; }
}

type ZipEntry = { name: string; data: Buffer };
type SheetInfo = { name: string; path: string };
export type XlsxInspection = {
  sheetName: string;
  worksheetPath: string;
  headerRow: number;
  idColumn: number;
  idHeader: string;
  maxColumn: number;
  maxRow: number;
  studentIds: string[];
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(input: Buffer): Map<string, ZipEntry> {
  if (input.length < 22) throw new XlsxInputError("The file is not a valid Excel workbook.");
  let eocd = -1;
  const floor = Math.max(0, input.length - 22 - 0xffff);
  for (let i = input.length - 22; i >= floor; i--) {
    if (input.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxInputError("The Excel file is damaged or uses an unsupported ZIP format.");
  const disk = input.readUInt16LE(eocd + 4);
  const centralDisk = input.readUInt16LE(eocd + 6);
  const entries = input.readUInt16LE(eocd + 10);
  const centralOffset = input.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entries === 0xffff || centralOffset === 0xffffffff || entries > MAX_ZIP_ENTRIES) {
    throw new XlsxInputError("This Excel workbook uses a ZIP64 or multi-disk format that is not supported. Save it as a standard .xlsx file.");
  }

  const result = new Map<string, ZipEntry>();
  let cursor = centralOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (input.readUInt32LE(cursor) !== 0x02014b50) throw new XlsxInputError("The Excel workbook has an invalid ZIP directory.");
    const flags = input.readUInt16LE(cursor + 8);
    const method = input.readUInt16LE(cursor + 10);
    const checksum = input.readUInt32LE(cursor + 16);
    const compressedSize = input.readUInt32LE(cursor + 20);
    const uncompressedSize = input.readUInt32LE(cursor + 24);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const commentLength = input.readUInt16LE(cursor + 32);
    const localOffset = input.readUInt32LE(cursor + 42);
    const name = input.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0) throw new XlsxInputError("Password-protected Excel files are not supported.");
    if (uncompressedSize > MAX_UNCOMPRESSED_BYTES || total + uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      throw new XlsxInputError("The uncompressed workbook is too large. Keep it under 50 MB.");
    }
    if (input.readUInt32LE(localOffset) !== 0x04034b50) throw new XlsxInputError("The Excel workbook contains an invalid file entry.");
    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = input.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    try {
      if (method === 0) data = Buffer.from(compressed);
      else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
      else throw new XlsxInputError(`This workbook uses unsupported ZIP compression method ${method}.`);
    } catch (error) {
      if (error instanceof XlsxInputError) throw error;
      throw new XlsxInputError("The Excel workbook could not be decompressed. It may be damaged.");
    }
    if (data.length !== uncompressedSize || crc32(data) !== checksum) throw new XlsxInputError("The Excel workbook failed its integrity check.");
    total += data.length;
    result.set(name, { name, data });
  }
  return result;
}

function writeZip(entries: Map<string, ZipEntry>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const entry of entries.values()) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length > 0xffff || entry.data.length > 0xffffffff) throw new XlsxInputError("The generated workbook exceeds the supported Excel file size.");
    const compressed = deflateRawSync(entry.data, { level: 6 });
    if (compressed.length > 0xffffffff) throw new XlsxInputError("The generated workbook exceeds the supported Excel file size.");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  if (entries.size > 0xffff || offset > 0xffffffff) throw new XlsxInputError("This workbook is too large to update safely.");
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function decodeXml(value: string) {
  return value.replace(/&#x([\da-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function encodeXml(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function attr(xml: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}
function columnNumber(ref: string) {
  const letters = ref.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return 0;
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}
function columnName(index: number) {
  let n = index; let out = "";
  while (n > 0) { const rem = (n - 1) % 26; out = String.fromCharCode(65 + rem) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
function normalizedHeader(value: string) {
  return value.toLocaleLowerCase().normalize("NFKC").replace(/[\s_\-./\\()\[\]{}:]+/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}
export function normalizeUniversityId(value: unknown) {
  if (value == null) return "";
  return String(value).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[\u200e\u200f\u200b\ufeff]/g, "").trim().replace(/\s+/g, "").replace(/\.0$/, "").toLocaleLowerCase();
}

function parseSharedStrings(xml: string | undefined) {
  if (!xml) return [] as string[];
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const pieces = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    values.push(pieces.join(""));
  }
  return values;
}

function parseCellValue(cellXml: string, sharedStrings: string[], zeroFormats: Map<number, string>) {
  const type = attr(cellXml, "t");
  const style = Number(attr(cellXml, "s") ?? 0);
  if (type === "inlineStr") {
    const inline = cellXml.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
    return inline ? [...inline[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("") : "";
  }
  const v = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (v == null) return "";
  const raw = decodeXml(v);
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (!type && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    const zeros = zeroFormats.get(style);
    if (zeros && /^0+$/.test(zeros) && Number.isInteger(Number(raw))) return String(Math.trunc(Number(raw))).padStart(zeros.length, "0");
  }
  return raw;
}

type CellData = { ref: string; column: number; value: string; xml: string };
type RowData = { number: number; xml: string; cells: CellData[] };
function parseWorksheet(xml: string, sharedStrings: string[], zeroFormats: Map<number, string>): RowData[] {
  const rows: RowData[] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rowMatch[1], "r") ?? rows.length + 1);
    const rowXml = rowMatch[0];
    const cells: CellData[] = [];
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellXml = cellMatch[0];
      const ref = attr(cellMatch[1], "r");
      if (!ref) continue;
      cells.push({ ref, column: columnNumber(ref), value: parseCellValue(cellXml, sharedStrings, zeroFormats), xml: cellXml });
    }
    rows.push({ number: rowNumber, xml: rowXml, cells });
  }
  return rows;
}

function getWorkbookSheets(entries: Map<string, ZipEntry>): SheetInfo[] {
  const workbook = entries.get("xl/workbook.xml")?.data.toString("utf8");
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.data.toString("utf8");
  if (!workbook || !rels) throw new XlsxInputError("This .xlsx file is missing its workbook information.");
  const relationMap = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
    const id = attr(rel[1], "Id"); const target = attr(rel[1], "Target");
    if (id && target) relationMap.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const sheets: SheetInfo[] = [];
  for (const sheet of workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)) {
    const name = attr(sheet[1], "name"); const relationId = attr(sheet[1], "r:id");
    const path = relationId ? relationMap.get(relationId) : null;
    if (name && path && entries.has(path)) sheets.push({ name, path });
  }
  if (!sheets.length) throw new XlsxInputError("No readable worksheet was found in this Excel file.");
  return sheets;
}

function zeroNumberFormats(entries: Map<string, ZipEntry>) {
  const result = new Map<number, string>();
  const styles = entries.get("xl/styles.xml")?.data.toString("utf8");
  if (!styles) return result;
  const formats = new Map<number, string>();
  const numFmts = styles.match(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/)?.[1] ?? "";
  for (const m of numFmts.matchAll(/<numFmt\b([^>]*?)\/?\s*>/g)) {
    const id = Number(attr(m[1], "numFmtId")); const code = attr(m[1], "formatCode");
    if (Number.isFinite(id) && code) formats.set(id, code);
  }
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  let index = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)\/?\s*>/g)) {
    const format = formats.get(Number(attr(m[1], "numFmtId") ?? 0));
    if (format) result.set(index, format);
    index++;
  }
  return result;
}

function findIdHeader(rows: RowData[], forcedHeader?: string) {
  const aliases = new Set(["id", "studentid", "universityid", "studentuniversityid", "universitystudentid", "studentnumber", "studentno", "رقمالطالب", "الرقمالجامعي"]);
  const forced = forcedHeader ? normalizedHeader(forcedHeader) : "";
  for (const row of rows.slice(0, 50)) {
    const candidates = row.cells.filter((cell) => {
      const label = normalizedHeader(cell.value);
      return forced ? label === forced : aliases.has(label);
    });
    if (candidates.length === 1) return { row, cell: candidates[0] };
    if (candidates.length > 1) {
      const exact = candidates.filter((cell) => ["universityid", "studentid", "id", "رقمالجامعي"].includes(normalizedHeader(cell.value)));
      if (exact.length === 1) return { row, cell: exact[0] };
      throw new XlsxInputError(`More than one possible ID column was found in row ${row.number}. Enter the exact ID column header in the upload form.`);
    }
  }
  throw new XlsxInputError(forcedHeader
    ? `The column header “${forcedHeader}” was not found in the first 50 rows. Check its spelling or leave the field empty for automatic detection.`
    : "I couldn't identify the student ID column. Name it ID, Student ID, or University ID, or enter its exact header in the upload form.");
}

export function inspectXlsxWorkbook(input: Buffer, forcedIdHeader?: string): XlsxInspection {
  const entries = readZip(input);
  const sheets = getWorkbookSheets(entries);
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.data.toString("utf8"));
  const zeros = zeroNumberFormats(entries);
  let selected: { sheet: SheetInfo; rows: RowData[]; header: { row: RowData; cell: CellData } } | null = null;
  let lastError: unknown;
  for (const sheet of sheets) {
    const xml = entries.get(sheet.path)!.data.toString("utf8");
    const rows = parseWorksheet(xml, shared, zeros);
    try {
      const header = findIdHeader(rows, forcedIdHeader);
      selected = { sheet, rows, header };
      break;
    } catch (error) {
      lastError = error;
      continue;
    }
  }
  if (!selected) {
    if (lastError instanceof Error) throw lastError;
    throw new XlsxInputError("No worksheet with a recognizable student ID column was found.");
  }
  const ids = selected.rows.filter((row) => row.number > selected!.header.row.number)
    .map((row) => normalizeUniversityId(row.cells.find((cell) => cell.column === selected!.header.cell.column)?.value))
    .filter(Boolean);
  if (!ids.length) throw new XlsxInputError("The detected ID column has no student IDs below its header row.");
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new XlsxInputError(`The ID column contains duplicate student ID “${id}”. Each student must appear only once.`);
    seen.add(id);
  }
  const maxColumn = Math.max(0, ...selected.rows.flatMap((row) => row.cells.map((cell) => cell.column)));
  const maxRow = Math.max(0, ...selected.rows.map((row) => row.number));
  return {
    sheetName: selected.sheet.name, worksheetPath: selected.sheet.path,
    headerRow: selected.header.row.number, idColumn: selected.header.cell.column,
    idHeader: selected.header.cell.value, maxColumn, maxRow, studentIds: ids,
  };
}

export function findExistingSessionColumn(input: Buffer, inspection: Pick<XlsxInspection, "worksheetPath" | "headerRow">, sessionNumber: number) {
  const entries = readZip(input);
  const xml = entries.get(inspection.worksheetPath)?.data.toString("utf8");
  if (!xml) throw new XlsxInputError("The selected worksheet no longer exists in the uploaded workbook.");
  const rows = parseWorksheet(xml, parseSharedStrings(entries.get("xl/sharedStrings.xml")?.data.toString("utf8")), zeroNumberFormats(entries));
  const header = rows.find((row) => row.number === inspection.headerRow);
  const wanted = normalizedHeader(`Session ${sessionNumber}`);
  return header?.cells.find((cell) => normalizedHeader(cell.value) === wanted)?.column ?? null;
}

export type AttendanceColumnResult = { buffer: Buffer; matched: number; unknown: number; missingFromWorkbook: number; columnNumber: number };
export function writeAttendanceColumn(
  input: Buffer,
  inspection: Pick<XlsxInspection, "worksheetPath" | "headerRow" | "idColumn">,
  options: { sessionNumber: number; columnNumber: number; attendanceById: Map<string, string>; subjectIds: Set<string> },
): AttendanceColumnResult {
  const entries = readZip(input);
  const entry = entries.get(inspection.worksheetPath);
  if (!entry) throw new XlsxInputError("The selected worksheet no longer exists in the uploaded workbook.");
  const xml = entry.data.toString("utf8");
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.data.toString("utf8"));
  const zeros = zeroNumberFormats(entries);
  const rows = parseWorksheet(xml, shared, zeros);
  if (!rows.some((row) => row.number === inspection.headerRow)) throw new XlsxInputError("The student ID header row could not be found. Upload the roster again.");

  const actualCol = findExistingSessionColumn(input, inspection, options.sessionNumber) ?? options.columnNumber;
  const ref = (row: number) => `${columnName(actualCol)}${row}`;
  let matched = 0; let unknown = 0; let missing = 0;
  const workbookIds = new Set<string>();
  let updatedXml = xml;
  for (const row of rows) {
    let newValue: string | null = null;
    if (row.number === inspection.headerRow) newValue = `Session ${options.sessionNumber}`;
    else if (row.number > inspection.headerRow) {
      const idCell = row.cells.find((cell) => cell.column === inspection.idColumn);
      const id = normalizeUniversityId(idCell?.value);
      if (id) {
        workbookIds.add(id);
        const status = options.attendanceById.get(id);
        if (status) { newValue = status; matched++; }
        else if (options.subjectIds.has(id)) newValue = "Not in session";
        else { newValue = "ID not found"; unknown++; }
      }
    }
    if (newValue == null) continue;
    const existing = row.cells.filter((cell) => cell.column < actualCol).sort((a, b) => b.column - a.column)[0];
    const sameColumn = row.cells.find((cell) => cell.column === actualCol);
    const style = sameColumn ? attr(sameColumn.xml, "s") : existing ? attr(existing.xml, "s") : null;
    const styleAttr = style == null ? "" : ` s="${encodeXml(style)}"`;
    const cell = `<c r="${ref(row.number)}"${styleAttr} t="inlineStr"><is><t>${encodeXml(newValue)}</t></is></c>`;
    const nextCell = row.cells.filter((candidate) => candidate.column > actualCol).sort((a, b) => a.column - b.column)[0];
    const replacement = sameColumn
      ? row.xml.replace(sameColumn.xml, cell)
      : nextCell
        ? row.xml.replace(nextCell.xml, `${cell}${nextCell.xml}`)
        : row.xml.replace(/<\/row>\s*$/, `${cell}</row>`);
    if (replacement === row.xml && !sameColumn) throw new XlsxInputError(`Could not add the new attendance cell to worksheet row ${row.number}.`);
    updatedXml = updatedXml.replace(row.xml, replacement);
  }
  for (const id of options.attendanceById.keys()) if (!workbookIds.has(id)) missing++;

  const lastRow = Math.max(inspection.headerRow, ...rows.map((row) => row.number));
  const firstCell = xml.match(/<dimension\b[^>]*\bref="([A-Z]+\d+)/)?.[1] ?? "A1";
  const maxExistingColumn = Math.max(0, ...rows.flatMap((row) => row.cells.map((cell) => cell.column)));
  const lastCell = `${columnName(Math.max(actualCol, maxExistingColumn))}${lastRow}`;
  if (/<dimension\b[^>]*\/>/.test(updatedXml)) {
    updatedXml = updatedXml.replace(/<dimension\b([^>]*?)\/>/, (_m, attrs: string) => {
      const oldRef = attr(attrs, "ref") ?? firstCell;
      return `<dimension${attrs.replace(/\s*ref="[^"]*"/, "")} ref="${oldRef.split(":")[0]}:${lastCell}"/>`;
    });
  } else if (!/<dimension\b/.test(updatedXml)) {
    updatedXml = updatedXml.replace(/(<worksheet\b[^>]*>)/, `$1<dimension ref="${firstCell}:${lastCell}"/>`);
  }
  entry.data = Buffer.from(updatedXml, "utf8");
  return { buffer: writeZip(entries), matched, unknown, missingFromWorkbook: missing, columnNumber: actualCol };
}
