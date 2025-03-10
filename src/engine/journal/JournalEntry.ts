import { MeldOperation } from '../MeldEncoding';
import { JournalOperation, TickTid } from './JournalOperation';
import { OperationMessage } from '../index';
import type { Journal, TickKey } from '.';
import { EntryIndex } from '.';

/**
 * Lightweight encoding of a transaction operation reference (TID) and the previous public tick
 * from the entry's process clock.
 */
type JournalEntryJson = [
  /** Previous public tick and TID for this entry's clock (may be remote) */
  prev: TickTid,
  /** Operation transaction ID */
  tid: string
];

/** Immutable expansion of JournalEntryJson, with the referenced operation */
export class JournalEntry {
  static async fromJson(journal: Journal, key: TickKey, json: JournalEntryJson) {
    // Destructuring fields for convenience
    const [prev, tid] = json;
    const operation = await journal.operation(tid, 'require');
    return new JournalEntry(journal, key, prev, operation);
  }

  static fromOperation(journal: Journal,
    key: TickKey, prev: TickTid, operation: MeldOperation
  ) {
    return new JournalEntry(journal, key, prev,
      JournalOperation.fromOperation(journal, operation));
  }

  private constructor(
    private readonly journal: Journal,
    readonly key: TickKey,
    readonly prev: TickTid,
    readonly operation: JournalOperation
  ) {
  }

  get index(): EntryIndex {
    return { key: this.key, tid: this.operation.tid };
  }

  get json(): JournalEntryJson {
    return [this.prev, this.operation.tid];
  }

  commitTail = this.journal.commitEntry(this);

  static prev(json: JournalEntryJson) {
    const [prev] = json;
    return prev;
  }

  async next(): Promise<JournalEntry | undefined> {
    return this.journal.entryAfter(this.key);
  }

  asMessage(): OperationMessage {
    const [prevTick] = this.prev;
    return new OperationMessage(prevTick, this.operation.json, this.operation.time);
  }
}