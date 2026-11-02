// Run the console unit tests from the repository root as well, so `npm test`
// covers the shared formatting helpers next to the backend suites.
import test from 'node:test'
import assert from 'node:assert/strict'
import { abbreviateCount, abbreviatedOrDash } from '../web/src/format.ts'

test('token abbreviation is shared with the console deployment', () => {
  assert.equal(abbreviateCount(23_019_762), '23.02M')
  assert.equal(abbreviateCount(999_999), '1M')
  assert.equal(abbreviateCount(999), '')
  assert.equal(abbreviateCount(1_000_000_000_000), '1000B')
  assert.equal(abbreviatedOrDash(null), '—')
})
