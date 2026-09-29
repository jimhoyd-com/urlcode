// The exit decision for scripts/workerd-parity.ts, kept apart from the run so a test can reach it without the network.
// A run that compared no request proves nothing, so it never passes: a SKIP (workerd was never reached) exits 0 only
// when WORKERD_PARITY_REQUIRED is unset, and a run that reached the comparison but compared fewer requests than it
// declared fails either way.
export interface ParityVerdict { line: string; exitCode: 0 | 1 }

export function skipVerdict(reason: string, required: boolean): ParityVerdict {
  return required
    ? { line: `FAIL: compared 0 requests: ${reason} (WORKERD_PARITY_REQUIRED=1 turns a skip into a failure)`, exitCode: 1 }
    : { line: `SKIP: compared 0 requests: ${reason}`, exitCode: 0 };
}

export function comparisonVerdict(compared: number, declared: number, different: number): ParityVerdict {
  if (compared === 0 || compared !== declared) return { line: `FAIL: compared ${compared} of ${declared} requests`, exitCode: 1 };
  if (different) return { line: `FAIL: ${different} of ${compared} request(s) differ`, exitCode: 1 };
  return { line: `all ${compared} responses identical (status, headers except request id, body)`, exitCode: 0 };
}
