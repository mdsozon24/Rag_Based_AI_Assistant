import { describe, expect, it } from 'vitest';
import { decodeUploadedDocument } from '../../../server/uploadValidation.ts';

describe('legacy document upload validation', () => {
  it('decodes supported UTF-8 text documents', () => {
    const result = decodeUploadedDocument({ fileName: 'notes.txt', fileType: 'text/plain', fileBase64: Buffer.from('হ্যালো').toString('base64') });
    expect(result).toMatchObject({ fileName: 'notes.txt', isPdf: false, text: 'হ্যালো' });
  });

  it('requires a supported extension, matching MIME type, and valid base64', () => {
    expect(() => decodeUploadedDocument({ fileName: 'payload.exe', fileType: 'application/octet-stream', fileBase64: 'AAAA' })).toThrow(/Only TXT/);
    expect(() => decodeUploadedDocument({ fileName: 'notes.txt', fileType: 'application/pdf', fileBase64: 'AAAA' })).toThrow(/does not match/);
    expect(() => decodeUploadedDocument({ fileName: 'notes.txt', fileType: 'text/plain', fileBase64: '%%%bad' })).toThrow(/valid base64/);
  });

  it('checks PDF magic bytes instead of trusting the filename and MIME type', () => {
    expect(() => decodeUploadedDocument({ fileName: 'fake.pdf', fileType: 'application/pdf', fileBase64: Buffer.from('not a pdf').toString('base64') })).toThrow(/signature is missing/);
    expect(decodeUploadedDocument({ fileName: 'real.pdf', fileType: 'application/pdf', fileBase64: Buffer.from('%PDF-1.7').toString('base64') }).isPdf).toBe(true);
  });
});