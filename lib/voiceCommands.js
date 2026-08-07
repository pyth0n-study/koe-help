/** Normalize punctuation and spelling variations without removing Japanese long vowels. */
export function normalizeSpeech(transcript) {
  return transcript
    .toLowerCase()
    .replace(/[\s、。,.!！?？・-]/g, "")
    .replace(/ｓｏｓ/g, "sos")
    .replace(/エスオーエス/g, "sos");
}

export function isHelpCommand(transcript) {
  const normalized = normalizeSpeech(transcript);
  const hasHallSound = normalized.includes("ール");
  const hasHelpWord = normalized.includes("help") || normalized.includes("ヘルプ");
  return (hasHallSound && hasHelpWord)
    || normalized.includes("キッチンsos")
    || normalized.includes("洗い場ヘルプ")
    || normalized.includes("アライバルヘルプ");
}

export function isCancelCommand(transcript) {
  const normalized = normalizeSpeech(transcript);
  return normalized.includes("ホール解除")
    || normalized.includes("キッチン解除")
    || normalized.includes("洗い場キャンセル")
    || normalized.includes("もう大丈夫");
}

/** @returns {"idle" | "busy" | "critical" | null} */
export function getStatusCommand(transcript) {
  const normalized = normalizeSpeech(transcript);
  const isStatusPhrase = normalized.includes("ステータス");
  const isBlue = normalized.includes("青") || normalized.includes("アオ") || normalized.includes("あお");
  const isYellow = normalized.includes("黄色") || normalized.includes("黄") || normalized.includes("キイロ") || normalized.includes("きいろ");
  const isRed = normalized.includes("赤") || normalized.includes("アカ") || normalized.includes("あか");
  if ((isStatusPhrase && isBlue) || normalized.includes("今は大丈夫")) return "idle";
  if ((isStatusPhrase && isYellow) || normalized.includes("ちょっと忙しい")) return "busy";
  if ((isStatusPhrase && isRed) || normalized.includes("本当に忙しい")) return "critical";
  return null;
}

