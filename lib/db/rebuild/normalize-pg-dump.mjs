import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function normalizePgDump(source) {
  const marker = '--\n-- PostgreSQL database dump\n--\n';
  if (!source.startsWith(marker)) return source;
  const lines = source.split('\n');
  const firstStatement = lines.findIndex(line => line && !line.startsWith('--') && !line.startsWith('\\restrict '));
  if (firstStatement < 0) return source;
  const header = lines.slice(0, firstStatement).join('\n') + '\n';
  const normalizedHeader = header
    .replace(/^\\restrict [A-Za-z0-9]+\n(?:\n)?/m, '')
    .replace(/^-- Dumped from database version .+$/m, '-- Dumped from database version NORMALIZED')
    .replace(/^-- Dumped by pg_dump version .+$/m, '-- Dumped by pg_dump version NORMALIZED');
  const remainder = lines.slice(firstStatement).join('\n');
  const footerMarker = '-- PostgreSQL database dump complete\n--\n';
  const footerStart = remainder.lastIndexOf(footerMarker);
  if (footerStart < 0) return normalizedHeader + remainder;
  return normalizedHeader + remainder.slice(0, footerStart)
    + remainder.slice(footerStart).replace(/^\\unrestrict [A-Za-z0-9]+\n(?:\n)?/m, '');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(normalizePgDump(readFileSync(process.argv[2] ?? 0, 'utf8')));
}
