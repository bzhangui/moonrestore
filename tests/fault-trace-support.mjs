// Finite synthetic actions only; traces never carry user paths, code or credentials.
export function generatedTraces(seed = 12, count = 12) {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 128
  )
    throw new Error("Fault trace budget");
  let x = seed >>> 0;
  const random = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const errors = ["ENOSPC", "EIO", "EACCES", "EROFS"];
  return Array.from({ length: count }, (_, i) => ({
    format: 1,
    seed,
    index: i,
    format5: Math.floor(i / 4) % 2 === 1,
    steps: [
      { action: "io", code: errors[i % 4], stage: "restore-written" },
      { action: "io", code: errors[random() % 4], stage: "restore-checkpoint" },
      { action: "target-conflict" },
      { action: i % 2 ? "damaged-pack" : "cancel" },
      { action: "resume" },
    ],
  }));
}
export async function shrinkTrace(trace, evaluate, expected) {
  if (trace.steps.length > 32) throw new Error("Shrink trace budget");
  let result = structuredClone(trace),
    attempts = 0,
    i = 0;
  for (; i < result.steps.length && attempts < 64; ) {
    const candidate = {
      ...result,
      steps: result.steps.filter((_, j) => j !== i),
    };
    if (!candidate.steps.length) {
      i++;
      continue;
    }
    attempts++;
    if ((await evaluate(candidate)) === expected) {
      result = candidate;
      i = 0;
    } else i++;
  }
  return {
    trace: result,
    attempts,
    one_step_minimal: i === result.steps.length,
    global_minimum_proven: false,
  };
}
