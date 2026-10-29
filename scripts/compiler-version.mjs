// Acceptance floor, not a claim that every historical compiler is supported.
export const MINIMUM_MOONC = [0, 10, 16];
export function assertCompilerVersion(output) {
  const match = /\bmoonc v(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (!match) throw new Error("MoonBit compiler version unavailable");
  const actual = match.slice(1).map(Number);
  let order = 0;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== MINIMUM_MOONC[i]) {
      order = actual[i] > MINIMUM_MOONC[i] ? 1 : -1;
      break;
    }
  }
  if (order < 0) throw new Error("moonc >= 0.10.16 required");
  return actual;
}
