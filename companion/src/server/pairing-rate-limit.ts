const windowMs = 60_000;
const maximumAttempts = 20;

interface AttemptWindow {
  startedAt: number;
  attempts: number;
}

export class PairingRateLimit {
  readonly #attempts = new Map<string, AttemptWindow>();

  allows(key: string, now = Date.now()): boolean {
    if (this.#attempts.size >= 10_000) {
      for (const [candidate, attempt] of this.#attempts) {
        if (now - attempt.startedAt >= windowMs) this.#attempts.delete(candidate);
      }
    }
    const current = this.#attempts.get(key);
    if (current === undefined || now - current.startedAt >= windowMs) {
      this.#attempts.set(key, { startedAt: now, attempts: 1 });
      return true;
    }
    current.attempts += 1;
    return current.attempts <= maximumAttempts;
  }
}
