import test from 'node:test'
import assert from 'node:assert/strict'
import { findForbiddenClaims, type ClaimHit } from '../lib/ai/claim-guard'
import { getSection } from '../lib/rules/rulebook'

/** The canonical fabricated answer from the bug report (section 0 of the worker spec). */
const CANONICAL = [
  'Щоб заблокувати акаунт, використовуйте функцію «Freeze» у особистому кабінеті.',
  'Це тимчасово зупиняє торгівлю, але обов\'язково зверніть увагу на умови: фріз зберігається, поки основний акаунт активний.',
  'Якщо основний акаунт пройшов успішно, фріз розгортається без повернення коштів.',
  'Фріз можна активувати лише після провалу головного акаунта.',
  'Якщо ви хочете закрити акаунт без повернення коштів, подбайте про те, щоб акаунт був неактивний більше 90 календарних днів — це дозволяє системі закрити акаунт без повернення коштів.',
].join(' ')

function hitIds(answer: string): string[] {
  return findForbiddenClaims(answer).map((hit: ClaimHit) => hit.id)
}

test('the canonical hallucinated answer triggers at least 3 hits', () => {
  const ids = hitIds(CANONICAL)
  assert.ok(ids.includes('trader_freeze_feature'), `ids: ${ids.join(', ')}`)
  assert.ok(ids.includes('self_service_closure'), `ids: ${ids.join(', ')}`)
  assert.ok(ids.includes('inactivity_as_advice'), `ids: ${ids.join(', ')}`)
})

test('a legitimate fact passes: the system has no Freeze button', () => {
  assert.equal(findForbiddenClaims('У кабінеті немає функції заморозки акаунта.').length, 0)
})

test('legitimate facts pass: fees are not refundable; on-demand payouts absent', () => {
  assert.equal(findForbiddenClaims('Fee не повертається.').length, 0)
  assert.equal(findForbiddenClaims('Виплати «на вимогу» немає.').length, 0)
})

test('legitimate fact: frozen backup is a checkout option, not a self-service feature', () => {
  const answer = 'Frozen backup — це опція, яку купують на checkout; вона активується, якщо основний акаунт отримав breach.'
  assert.equal(findForbiddenClaims(answer).length, 0)
})

test('legitimate fact: 90 days of inactivity is a consequence, mentioned with a reminder', () => {
  const answer = 'Після 90 календарних днів без торгівлі рахунок може бути закритий без refund; перед закриттям надсилається нагадування.'
  assert.equal(findForbiddenClaims(answer).length, 0)
})

test('a sentence quoted verbatim from the rulebook is never flagged', () => {
  // The rulebook itself says "Inactivity 90 днів"; quoting it must not be punished.
  const section = getSection(19)!
  const sentence = 'Inactivity 90 днів'
  assert.ok(findForbiddenClaims(sentence).length > 0, 'the bare sentence should look like a claim')
  assert.equal(findForbiddenClaims(sentence, [section]).length, 0)
})

test('English negation suppresses a correct statement', () => {
  assert.equal(findForbiddenClaims('There is no on-demand payout; payouts run on a schedule.').length, 0)
  assert.equal(findForbiddenClaims('The trader chat has NO Freeze, pause or close button.').length, 0)
})

test('an English affirmative claim is still caught', () => {
  const ids = findForbiddenClaims('Use the Freeze button in your dashboard to pause trading.').map((hit) => hit.id)
  assert.ok(ids.includes('trader_freeze_feature'), `ids: ${ids.join(', ')}`)
})
