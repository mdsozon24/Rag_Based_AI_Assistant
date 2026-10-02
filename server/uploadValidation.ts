const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  json: ['application/json', 'text/plain'],
  md: ['text/markdown', 'text/plain'],
  pdf: ['application/pdf'],
  txt: ['text/plain'],
};

export class UploadValidationError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

export function decodeUploadedDocument(input: unknown): { fileName: string; fileType: string; fileBase64: string; buffer: Buffer; isPdf: boolean; text?: string } {
  if (!input || typeof input !== 'object') throw new UploadValidationError('File name and content are required.', 400);
  const { fileName, fileType, fileBase64 } = input as Record<string, unknown>;
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255 || /[\\/\u0000-\u001f]/.test(fileName)) {
    throw new UploadValidationError('File name must be a simple name of at most 255 characters.', 400);
  }
  if (typeof fileType !== 'string' || typeof fileBase64 !== 'string' || fileBase64.length === 0) {
    throw new UploadValidationError('File name, type, and content are required.', 400);
  }
  if (fileBase64.length > MAX_BASE64_CHARS) throw new UploadValidationError('Document exceeds the 10 MiB upload limit.', 413);
  if (!BASE64.test(fileBase64)) throw new UploadValidationError('File content must be valid base64.', 400);

  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const acceptedTypes = MIME_BY_EXTENSION[extension];
  if (!acceptedTypes) throw new UploadValidationError('Only TXT, MD, JSON, CSV, and PDF documents are supported.', 415);
  if (fileType && !acceptedTypes.includes(fileType)) throw new UploadValidationError('File type does not match the document extension.', 415);

  const buffer = Buffer.from(fileBase64, 'base64');
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new UploadValidationError('Document exceeds the 10 MiB upload limit.', 413);
  if (buffer.toString('base64') !== fileBase64) throw new UploadValidationError('File content must be canonical base64.', 400);

  if (extension === 'pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new UploadValidationError('PDF signature is missing.', 400);
    return { fileName, fileType, fileBase64, buffer, isPdf: true };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new UploadValidationError('Text documents must be valid UTF-8.', 400);
  }
  if (text.includes('\0')) throw new UploadValidationError('Text documents cannot contain binary data.', 400);
  return { fileName, fileType, fileBase64, buffer, isPdf: false, text };
}