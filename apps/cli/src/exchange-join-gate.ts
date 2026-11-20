import { type ExchangePair, EXCHANGE_JOIN_TIMEOUT_MS } from "./exchange-owner";

export const EXCHANGE_JOIN_GATE = "SORAGE_EXCHANGE_JOIN_GATE";
export const EXCHANGE_JOIN_ACK = "exchange-join-ack";

/** Only the MCP-launched child uses this channel. Public command output remains on stdout/stderr. */
export function awaitExchangeJoinAck(pair: ExchangePair): Promise<boolean> {
  return new Promise((resolve) => {
    const send = process.send?.bind(process);
    if (!send || !process.connected) {
      resolve(false);
      return;
    }
    const deadline = setTimeout(() => finish(false), EXCHANGE_JOIN_TIMEOUT_MS);
    let settled = false;
    function receive(message: unknown): void {
      finish(message === EXCHANGE_JOIN_ACK);
    }
    function disconnected(): void {
      finish(false);
    }
    function finish(allowed: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      process.off("message", receive);
      process.off("disconnect", disconnected);
      if (process.connected) process.disconnect?.();
      resolve(allowed);
    }
    process.once("message", receive);
    process.once("disconnect", disconnected);
    send(pair, (error) => {
      if (error) finish(false);
    });
  });
}

interface JoinSlot {
  actor?: string;
  acknowledged: boolean;
  cancelled: boolean;
  ack(): void;
}

/** No actor resolution happens here. Earlier unidentified calls cannot be bypassed by an alias. */
export class ExchangeJoinGate {
  private readonly exchanges = new Map<string, JoinSlot[]>();
  private closing = false;

  add(exchangeId: string, ack: () => void) {
    const slot: JoinSlot = { ack, acknowledged: false, cancelled: false };
    const pending = this.exchanges.get(exchangeId) ?? [];
    pending.push(slot);
    this.exchanges.set(exchangeId, pending);
    return {
      announce: (pair: ExchangePair): boolean => {
        if (slot.actor !== undefined || pair.exchangeId !== exchangeId || slot.cancelled) return false;
        slot.actor = pair.projectId;
        this.advance(pending);
        return true;
      },
      cancel: () => {
        slot.cancelled = true;
        this.advance(pending);
      },
      finish: () => {
        const index = pending.indexOf(slot);
        if (index === -1) return;
        pending.splice(index, 1);
        if (!pending.length) this.exchanges.delete(exchangeId);
        this.advance(pending);
      },
    };
  }

  close(): void {
    this.closing = true;
  }

  private advance(pending: JoinSlot[]): void {
    if (this.closing) return;
    const occupied = new Set<string>();
    for (const slot of pending) {
      if (!slot.actor) return;
      if (occupied.has(slot.actor)) continue;
      occupied.add(slot.actor);
      if (!slot.acknowledged && !slot.cancelled) {
        slot.acknowledged = true;
        slot.ack();
      }
    }
  }
}
