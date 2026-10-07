// Direct tests for the timestamp normalizer. Before this file existed,
// `normalizeTs` had NO direct test: it was reached only incidentally through
// `bookPoller` and `ws`, and the only fixture exercising that path passed an
// ISO string. The live CLOB `/book` endpoint does not send an ISO string — a
// read-only probe on 2026-10-07 found the real field is the STRING
// "1791401045758": 13 digits, milliseconds. So the branch production actually
// executes (`/^\d+$/`) had zero coverage, while the branch that was covered
// (`new Date(v)`) is not the branch the exchange uses.
//
// The value below is transcribed from that probe. It is a fixed literal, never
// derived from the clock, so every expectation here is deterministic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { epochMsToIso, normalizeTs, utcDateOf } from './time.js';

// Observed verbatim from https://clob.polymarket.com/book, 2026-10-07.
const OBSERVED_MS_STRING = '1791401045758';
const OBSERVED_ISO = '2026-10-07T19:24:05.758Z';

describe('normalizeTs / the branch production executes', () => {
  it('reads a 13-digit millisecond STRING as milliseconds — the observed API format', () => {
    // The centrepiece. A numeric string, so `/^\d+$/` matches and it is read as
    // an epoch, NOT handed to `new Date()`. Getting this wrong by 1000x lands
    // every row in 1970, which is silent: files still get written.
    assert.equal(normalizeTs(OBSERVED_MS_STRING), OBSERVED_ISO);
  });

  it('reads a finite millisecond NUMBER the same way, so both spellings agree', () => {
    assert.equal(normalizeTs(1791401045758), OBSERVED_ISO);
    assert.equal(normalizeTs(OBSERVED_MS_STRING), normalizeTs(Number(OBSERVED_MS_STRING)));
  });

  it('reads the digits branch ahead of the Date branch, even for "0"', () => {
    // Order matters and is observable. `/^\d+$/` is checked FIRST, so "0" is an
    // epoch of zero (1970) and never reaches `new Date("0")`, which the Date
    // parser would have read as the year 2000. Leading zeros are equivalent.
    assert.equal(normalizeTs('0'), '1970-01-01T00:00:00.000Z');
    assert.equal(normalizeTs('00'), '1970-01-01T00:00:00.000Z');
  });
});

describe('normalizeTs / known hazards, pinned not endorsed', () => {
  // A 10-digit SECONDS epoch — 1000x smaller than the milliseconds the exchange
  // actually sends. `/^\d+$/` accepts it and it converts without error, so a
  // seconds-vs-milliseconds mix-up produces a 1970 date rather than `null`.
  // The `?? nowIso()` fallback at both call sites does NOT protect against this:
  // it only fires on `null`, and this returns a string.
  //
  // Pinned so the hazard has a name. Fixing it (a plausible-range check) is a
  // SEPARATE, deliberate decision and is deliberately NOT made here.
  it('a seconds-epoch string converts to a 1970 date instead of returning null', () => {
    assert.equal(normalizeTs('1791401045'), '1970-01-21T17:36:41.045Z');
    assert.notEqual(normalizeTs('1791401045'), null, 'this is the hazard: no null, no signal');
  });

  // Second unguarded shape: a non-`/^\d+$/` string that `new Date` happens to
  // parse. "-1000" and ".5" are read as years by the Date parser, not epochs.
  it('a short non-ISO string that Date can still parse becomes an ancient date', () => {
    assert.equal(normalizeTs('-1000'), '1000-01-01T05:44:38.000Z');
    assert.equal(normalizeTs('.5'), '2001-05-01T05:00:00.000Z');
  });
});

describe('normalizeTs / ISO strings', () => {
  it('passes an ISO string through unchanged', () => {
    assert.equal(normalizeTs('2024-01-02T00:00:00.000Z'), '2024-01-02T00:00:00.000Z');
  });

  it('normalises a non-UTC offset input to the UTC form', () => {
    // `new Date(...).toISOString()` is UTC-normalised, so 00:00+02:00 is the
    // PREVIOUS UTC day. Whatever consumes this gets a consistent 'Z' form.
    assert.equal(normalizeTs('2024-01-02T00:00:00+02:00'), '2024-01-01T22:00:00.000Z');
  });
});

describe('normalizeTs / returns null', () => {
  it('returns null for null and undefined', () => {
    assert.equal(normalizeTs(null), null);
    assert.equal(normalizeTs(undefined), null);
  });

  it('returns null for a non-numeric, non-date string', () => {
    assert.equal(normalizeTs('n/a'), null);
    assert.equal(normalizeTs('not a timestamp'), null);
  });

  it('returns null for a non-finite number', () => {
    // `Number.isFinite` excludes these, so they fall through to the null return
    // rather than reaching `epochMsToIso`, which would throw on `NaN`.
    assert.equal(normalizeTs(Number.NaN), null);
    assert.equal(normalizeTs(Number.POSITIVE_INFINITY), null);
    assert.equal(normalizeTs(Number.NEGATIVE_INFINITY), null);
  });

  it('returns null for an empty or whitespace-padded string', () => {
    // Note the asymmetry with '0': an empty string is not digits, and
    // `new Date('')` is Invalid Date. But ' 123' is ALSO not digits and does
    // not parse, so a padded value degrades to null rather than to a wrong date.
    assert.equal(normalizeTs(''), null);
    assert.equal(normalizeTs(' '), null);
    assert.equal(normalizeTs(' 1791401045758'), null);
    assert.equal(normalizeTs('1791401045758 '), null);
  });
});

describe('epochMsToIso', () => {
  it('converts the observed millisecond value to the observed ISO string', () => {
    assert.equal(epochMsToIso(1791401045758), OBSERVED_ISO);
  });
});

describe('utcDateOf / the dt= partition key', () => {
  it('reduces the observed timestamp to its UTC date', () => {
    // This exact string is the partition key on every parquet file the
    // collector writes. A wrong value is silent — no error, just data filed
    // under the wrong day — so it is pinned directly.
    assert.equal(utcDateOf(OBSERVED_ISO), '2026-10-07');
  });

  it('slices lexically and assumes UTC input, so a raw offset string is wrong', () => {
    // Documents the precondition: `utcDateOf` is not a parser. Fed the raw
    // +02:00 spelling of the same instant it returns 2024-01-02, while the UTC
    // instant is 2024-01-01. Callers must pass the `normalizeTs` output.
    assert.equal(utcDateOf('2024-01-02T00:00:00+02:00'), '2024-01-02');
    assert.equal(utcDateOf(normalizeTs('2024-01-02T00:00:00+02:00') ?? ''), '2024-01-01');
  });
});