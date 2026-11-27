// The account board read (read-data/account-board.ts accountBoardOf) and the person's label for an option contract
// (humanLabelForSymbol). Ported outcomes: bitfield-packages packages/trade-order/read-data/trade-order-live.ts
// (d926b7adb, OCC option symbol -> human label, lines 196-236) and packages/portfolio-connector/read-data/account-board.ts
// (d926b7adb, the hero, balances and holdings projections).
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { accountBoardOf, humanLabelForSymbol, parseOccSymbol } from '../read-data/account-board.ts';

const cycle = {
  cycle_id: 'c-1',
  equity: 100000,
  last_equity: 99000,
  daily_pl_pct: 1.01,
  target_pct: 5,
  buying_power: 200000,
  positions: [
    { symbol: 'AAPL260116C00150000', qty: 2, market_value: 1200 },
    { symbol: 'BREAD', qty: 10, market_value: 900 },
  ],
};
const envelope = { attribute: 'agent:trading-momentum.last-cycle', value_json: JSON.stringify(cycle) };

test('an option contract reads as a person\'s label, a plain ticker as it is', () => {
  assert.equal(humanLabelForSymbol('AAPL260116C00150000'), "AAPL $150 Call · Jan 16 '26");
  assert.equal(humanLabelForSymbol('SPY260320P00012500'), "SPY $12.50 Put · Mar 20 '26");
  assert.equal(humanLabelForSymbol('BREAD'), 'BREAD');
  assert.equal(humanLabelForSymbol('AAPL26C'), 'AAPL26C');
  assert.equal(parseOccSymbol('BREAD'), null);
  assert.deepEqual(parseOccSymbol('AAPL260116C00150000'), { underlying: 'AAPL', strike: 150, expiry: '2026-01-16', right: 'Call' });
});

test('the board reads the hero, the account figures and the holdings from the live cycle fact', () => {
  const board = accountBoardOf({ cycle: envelope });
  assert.equal(board.live, true);
  assert.equal(board.headline.value, '$100,000.00');
  assert.equal(board.headline.deltaValue, '+$1,000.00');
  assert.equal(board.headline.deltaPct, '+1.01%');
  assert.equal(board.headline.deltaTone, 'up');
  assert.equal(board.headline.goalLabel, '20% of the 5% daily goal');
  assert.equal(board.account.buying_power, 200000);
  assert.equal(board.account.positions, undefined, 'the holdings are records, not account scalars');
  assert.deepEqual(board.positions.map(record => record.id), ['AAPL260116C00150000', 'BREAD']);
  assert.equal(board.positions[0].payload.label, "AAPL $150 Call · Jan 16 '26");
  assert.equal(board.positions[1].payload.label, undefined);
});

test('an already unwrapped cycle reads the same, and no cycle answers an honest empty board', () => {
  assert.equal(accountBoardOf({ cycle }).headline.value, '$100,000.00');
  for (const input of [{}, { cycle: 'not a fact' }, { cycle: { value_json: '{broken' } }, undefined]) {
    const board = accountBoardOf(input);
    assert.equal(board.live, false);
    assert.equal(board.headline.value, null);
    assert.deepEqual(board.positions, []);
    assert.equal(board.account, null);
  }
});

// The row runs the reader the way the engine does (run-a-row.mjs lays the packed files and runs the argv on this computer).
test('the account board row answers the same board as the reader, and holds no broker credential', async () => {
  const row = rowOf(rows, 'tool:read-my-trading-account-board');
  const answer = await answerOf(row, { cycle: envelope });
  assert.equal(answer.status, 0);
  assert.equal(answer.result.live, true);
  assert.equal(answer.result.headline.value, '$100,000.00');
  assert.equal(answer.result.positions[0].payload.label, "AAPL $150 Call · Jan 16 '26");
  assert.deepEqual(answer.result, JSON.parse(JSON.stringify(accountBoardOf({ cycle: envelope }))));
  const none = await answerOf(row, {});
  assert.equal(none.result.live, false);
});
