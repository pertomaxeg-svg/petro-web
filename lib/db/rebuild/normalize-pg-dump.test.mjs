import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePgDump } from './normalize-pg-dump.mjs';
const header = '--\n-- PostgreSQL database dump\n--\n\n';
const old = header + '-- Dumped from database version 17.5\n-- Dumped by pg_dump version 17.5\n\nCREATE TABLE public.items (id uuid);\n\n-- PostgreSQL database dump complete\n--\n\n';
const current = header + '\\restrict GeneratedSafetyKey123\n\n-- Dumped from database version 17.11 (Ubuntu 17.11-1.pgdg24.04+2)\n-- Dumped by pg_dump version 17.11 (Ubuntu 17.11-1.pgdg24.04+2)\n\nCREATE TABLE public.items (id uuid);\n\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict GeneratedSafetyKey123\n\n';
test('equivalent PostgreSQL 17 patch versions compare without generated client metadata', () => {
  assert.equal(normalizePgDump(current), normalizePgDump(old));
});
test('real table and constraint differences remain visible', () => {
  assert.notEqual(normalizePgDump(current.replace('(id uuid)', '(id uuid NOT NULL)')), normalizePgDump(old));
});
test('preserves metadata-looking content inside SQL definitions', () => {
  const sql = "CREATE FUNCTION f() RETURNS text AS $$\n\\restrict businessText\n-- Dumped by pg_dump version 17.5\n$$ LANGUAGE sql;\n";
  assert.equal(normalizePgDump(sql), sql);
});
