import test from "node:test";
import assert from "node:assert/strict";
import { getStatusCommand, isCancelCommand, isHelpCommand, normalizeSpeech } from "../lib/voiceCommands.js";

const statusCases = [
  ["ステータス、赤。", "critical"],
  ["ステータス、アカ。", "critical"],
  ["ステータスあか", "critical"],
  ["ステータス 黄色", "busy"],
  ["ステータス、キイロ。", "busy"],
  ["ステータスきいろ", "busy"],
  ["ステータス 青", "idle"],
  ["ステータス、アオ。", "idle"],
  ["ステータスあお", "idle"],
];

for (const [speech, expected] of statusCases) {
  test(`${speech} を ${expected} と判定する`, () => {
    assert.equal(getStatusCommand(speech), expected);
  });
}

for (const speech of ["ホールヘルプ。", "コールヘルプ", "オールHELP", "ボール、ヘルプ！"]) {
  test(`${speech} を緊急ヘルプと判定する`, () => {
    assert.equal(isHelpCommand(speech), true);
  });
}

for (const speech of ["ホール解除", "洗い場キャンセル。", "もう大丈夫"]) {
  test(`${speech} を解除と判定する`, () => {
    assert.equal(isCancelCommand(speech), true);
  });
}

test("通常会話には反応しない", () => {
  for (const speech of ["今日も頑張ろう", "赤い皿を取って", "黄色いお皿です", "ホールをお願いします"]) {
    assert.equal(getStatusCommand(speech), null);
    assert.equal(isHelpCommand(speech), false);
    assert.equal(isCancelCommand(speech), false);
  }
});

test("句読点を除去して長音記号を残す", () => {
  assert.equal(normalizeSpeech("ステータス、赤。"), "ステータス赤");
  assert.equal(normalizeSpeech("ホール・ヘルプ！"), "ホールヘルプ");
});

