import { toPrefixedId } from './SuSetGraph';
import { EncodedOperation } from '..';
import { TreeClock, TreeClockJson } from '../clocks';
import { MsgPack } from '../util';
import { Kvps, KvpStore } from '.';
import { MeldEncoder, MeldOperation } from '../MeldEncoding';
import { CausalTimeRange } from '../ops';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** There is only one journal with a fixed key. */
const JOURNAL_KEY = '_qs:journal';

/**
 * Journal entries are indexed by end-tick as
 * `_qs:entry:${zeroPad(tick.toString(36), 8)}`. This gives a maximum tick of
 * 36^8, about 3 trillion, about 90 years in milliseconds.
 */
type EntryKey = ReturnType<typeof entryKey>;
const ENTRY_KEY_PRE = '_qs:entry';
const ENTRY_KEY_LEN = 8;
const ENTRY_KEY_RADIX = 36;
const ENTRY_KEY_PAD = new Array(ENTRY_KEY_LEN).fill('0').join('');
const ENTRY_KEY_MAX = toPrefixedId(ENTRY_KEY_PRE, '~'); // > 'z'
function entryKey(tick: number) {
  return toPrefixedId(ENTRY_KEY_PRE,
    `${ENTRY_KEY_PAD}${tick.toString(ENTRY_KEY_RADIX)}`.slice(-ENTRY_KEY_LEN));
}

/** Causally-fused operation from a clone, indexed by time hash (TID) */
const OPERATION_KEY_PRE = '_qs:op';
const OPERATION_KEY_MIN = toPrefixedId(OPERATION_KEY_PRE, '!'); // < '+'
const OPERATION_KEY_MAX = toPrefixedId(OPERATION_KEY_PRE, '~'); // > 'z'
function operationKey(tid: string) {
  return toPrefixedId(OPERATION_KEY_PRE, tid);
}

interface JournalJson {
  /**
   * The last tick for which a journal entry exists. This may not be
   * `time.ticks` if the local clock has ticked without an entry.
   */
  tailTick: number;
  /** local clock time, including internal ticks */
  time: TreeClockJson;
  /**
   * JSON-encoded public clock time ('global wall clock' or 'Great Westminster
   * Clock'). This has latest public ticks seen for all processes (not internal
   * ticks), unlike an entry time, which may be causally related to older
   * messages from third parties, and the journal time, which has internal ticks
   * for the local clone identity. This clock has no identity.
   */
  gwc: TreeClockJson;
}

type JournalEntryJson = [
  /** Previous tick for this entry's clock (may be remote) */
  prev: number,
  /** Start of _local_ tick range, inclusive. The entry key is the encoded end. */
  start: number,
  /** Raw operation - may contain Buffers */
  encoded: EncodedOperation
];

/**
 * Utility class for key entry details
 */
interface JournalEntry {
  key: string,
  prev: number,
  start: number,
  operation: MeldOperation
}

/** Immutable expansion of JournalEntryJson */
export class SuSetJournalEntry implements JournalEntry {
  static fromJson(data: SuSetJournalData, key: EntryKey, json: JournalEntryJson) {
    // Destructuring fields for convenience
    const [prev, start, encoded] = json;
    const [, from, timeJson] = encoded;
    const time = TreeClock.fromJson(timeJson) as TreeClock;
    return new SuSetJournalEntry(data, key, prev, start, encoded, from, time);
  }

  static fromEntry(data: SuSetJournalData, entry: JournalEntry) {
    const { key, prev, start, operation } = entry;
    const { from, time } = operation;
    return new SuSetJournalEntry(data, key, prev, start, operation, from, time);
  }

  /** Cache of operation if available */
  private _operation?: MeldOperation;
  encoded: EncodedOperation;

  private constructor(
    private readonly data: SuSetJournalData,
    readonly key: EntryKey,
    readonly prev: number,
    readonly start: number,
    op: EncodedOperation | MeldOperation,
    readonly from: number,
    readonly time: TreeClock) {
    if (op instanceof MeldOperation) {
      this._operation = op;
      this.encoded = op.encoded;
    } else {
      this.encoded = op;
    }
  }

  get operation() {
    if (this._operation == null)
      this._operation = MeldOperation.fromEncoded(this.data.encoder, this.encoded);
    return this._operation;
  }

  private get json(): JournalEntryJson {
    return [this.prev, this.start, this.encoded];
  }

  async next(): Promise<SuSetJournalEntry | undefined> {
    return this.data.entry({ gt: this.key });
  }

  static head(localTime = TreeClock.GENESIS): [number, JournalEntryJson] {
    const tick = localTime.ticks;
    // Dummy operation for head
    return [tick, [0, tick, [2, tick, localTime.toJson(), '[]', '[]']]];
  }

  builder(journal: SuSetJournal) {
    // The head represents this entry, made ready for appending new entries
    let head = new EntryBuilder(this.data, this, journal.time, journal.gwc), tail = head;
    const builder = {
      next: (operation: MeldOperation, localTime: TreeClock) => {
        tail = tail.next(operation, localTime);
        return builder;
      },
      /** Commits the built journal entries to the journal */
      commit: <Kvps>(async batch => {
        const entries = [...head.build()];
        if (entries[0].key !== this.key)
          batch.del(this.key);
        await Promise.all(entries.map(async entry => {
          batch.put(entry.key, MsgPack.encode(entry.json));
          await this.data.updateLatestOperation(entry)(batch);
        }));
        journal.commit(tail.localTime.ticks, tail.localTime, tail.gwc, entries.slice(-1)[0])(batch);
      })
    };
    return builder;
  }
}

class EntryBuilder {
  private nextBuilder?: EntryBuilder

  constructor(
    private readonly data: SuSetJournalData,
    private entry: JournalEntry,
    public localTime: TreeClock,
    public gwc: TreeClock) {
  }

  next(operation: MeldOperation, localTime: TreeClock) {
    if (CausalTimeRange.contiguous(this.entry.operation, operation))
      return this.fuseNext(operation, localTime);
    else
      return this.makeNext(operation, localTime);
  }

  *build(): Iterable<SuSetJournalEntry> {
    yield SuSetJournalEntry.fromEntry(this.data, this.entry);
    if (this.nextBuilder != null)
      yield* this.nextBuilder.build();
  }

  private makeNext(operation: MeldOperation, localTime: TreeClock) {
    return this.nextBuilder = new EntryBuilder(this.data, {
      key: entryKey(localTime.ticks),
      prev: this.gwc.getTicks(operation.time),
      start: localTime.ticks,
      operation
    }, localTime, this.nextGwc(operation));
  }

  private fuseNext(operation: MeldOperation, localTime: TreeClock) {
    const thisOp = this.entry.operation;
    const fused = MeldOperation.fromOperation(this.data.encoder, thisOp.fuse(operation));
    this.entry = {
      key: entryKey(localTime.ticks),
      prev: this.entry.prev,
      start: this.entry.start,
      operation: fused
    };
    this.localTime = localTime;
    this.gwc = this.nextGwc(operation);
    return this;
  }

  private nextGwc(operation: MeldOperation): TreeClock {
    return this.gwc.update(operation.time);
  }
}

/** Immutable expansion of JournalJson */
export class SuSetJournal {
  /** Tail state cache */
  _tail: SuSetJournalEntry | null = null;

  static fromJson(data: SuSetJournalData, json: JournalJson) {
    const time = TreeClock.fromJson(json.time) as TreeClock;
    const gwc = TreeClock.fromJson(json.gwc) as TreeClock;
    return new SuSetJournal(data, json.tailTick, time, gwc);
  }

  private constructor(
    private readonly data: SuSetJournalData,
    readonly tailTick: number,
    readonly time: TreeClock,
    readonly gwc: TreeClock) {
  }

  async tail(): Promise<SuSetJournalEntry> {
    if (this._tail == null) {
      this._tail = await this.data.entryFor(this.tailTick) ?? null;
      if (this._tail == null)
        throw new Error(`Journal tail tick ${this.tailTick} is missing at ${this.time}`);
    }
    return this._tail;
  }

  setLocalTime(localTime: TreeClock, newClone = false): Kvps {
    return async batch => {
      let tailTick = this.tailTick;
      if (newClone) {
        // For a new clone, the journal's temp tail is bogus
        batch.del(entryKey(tailTick));
        const [headTick, headJson] = SuSetJournalEntry.head(localTime);
        batch.put(entryKey(headTick), MsgPack.encode(headJson));
        tailTick = headTick;
      }
      // A genesis clone has an initial head without a GWC. Other clones will
      // have their journal reset with a snapshot. So, it's safe to use the
      // local time as the gwc, which is needed for subsequent entries.
      const gwc = this.gwc ?? localTime.scrubId();
      // Not updating tail cache for rare time update
      this.commit(tailTick, localTime, gwc)(batch);
    };
  }

  /** Optional parameters are for temporary head only */
  static json(tailTick: number, localTime?: TreeClock, gwc?: TreeClock): Partial<JournalJson> {
    return { tailTick, time: localTime?.toJson(), gwc: gwc?.toJson() };
  }

  /**
   * Commits a new tail and time, with updates to the journal and tail cache
   */
  commit(tailTick: number, localTime: TreeClock, gwc: TreeClock, tail?: SuSetJournalEntry): Kvps {
    return batch => {
      const json = SuSetJournal.json(tailTick, localTime, gwc);
      batch.put(JOURNAL_KEY, MsgPack.encode(json));
      this.data._journal = new SuSetJournal(this.data, tailTick, localTime, gwc);
      this.data._journal._tail = tail ?? null;
    };
  }
}

export class SuSetJournalData {
  /** Journal state cache */
  _journal: SuSetJournal | null = null;

  constructor(
    private readonly kvps: KvpStore,
    readonly encoder: MeldEncoder) {
  }

  async initialise(): Promise<Kvps | undefined> {
    // Create the Journal if not exists
    const journal = await this.kvps.get(JOURNAL_KEY);
    if (journal == null)
      return this.reset();
  }

  reset(localTime?: TreeClock, gwc?: TreeClock): Kvps {
    const [headTick, headJson] = SuSetJournalEntry.head(localTime);
    const journalJson = SuSetJournal.json(headTick, localTime, gwc);
    return batch => {
      batch.put(JOURNAL_KEY, MsgPack.encode(journalJson));
      batch.put(entryKey(headTick), MsgPack.encode(headJson));
      this._journal = null; // Not caching one-time change
    };
  }

  async journal() {
    if (this._journal == null) {
      const value = await this.kvps.get(JOURNAL_KEY);
      if (value == null)
        throw new Error('Missing journal');
      this._journal = SuSetJournal.fromJson(this, MsgPack.decode(value));
    }
    return this._journal;
  }

  async entry(key: { gt: EntryKey } | { gte: EntryKey }) {
    const kvp = await this.kvps.read({ ...key, lt: ENTRY_KEY_MAX, limit: 1 }).toPromise();
    if (kvp != null) {
      const [key, value] = kvp;
      return SuSetJournalEntry.fromJson(this, key, MsgPack.decode(value));
    }
  }

  async entryFor(tick: number) {
    const firstAfter = await this.entry({ gte: entryKey(tick) });
    // Check that the entry's tick range covers the request
    if (firstAfter != null && firstAfter.start <= tick)
      return firstAfter;
  }

  async operation(tid: string): Promise<EncodedOperation | undefined> {
    const value = await this.kvps.get(operationKey(tid));
    if (value != null)
      return MsgPack.decode(value);
  }

  insertLatestOperation(latest: EncodedOperation): Kvps {
    return async batch => {
      const [, , timeJson] = latest;
      const time = TreeClock.fromJson(timeJson) as TreeClock;
      batch.put(operationKey(time.hash()), MsgPack.encode(latest));
    };
  }

  updateLatestOperation(entry: SuSetJournalEntry): Kvps {
    return async batch => {
      // Do we have an operation for the entry's prev tick?
      if (entry.prev >= 0) {
        const prevTime = entry.time.ticked(entry.prev);
        const prevTid = prevTime.hash();
        const prevOp = await this.operation(prevTid);
        let newLatest = entry.encoded;
        if (prevOp != null) {
          const [, from] = prevOp;
          if (CausalTimeRange.contiguous({ from, time: prevTime }, entry)) {
            const fused = MeldOperation.fromEncoded(this.encoder, prevOp).fuse(entry.operation);
            newLatest = MeldOperation.fromOperation(this.encoder, fused).encoded;
          }
          // Always delete the old latest
          // TODO: This is not perfect garbage collection, see fused-updates spec
          batch.del(operationKey(prevTid));
        }
        batch.put(operationKey(entry.time.hash()), MsgPack.encode(newLatest));
      }
    };
  }

  latestOperations(): Observable<EncodedOperation> {
    return this.kvps.read({ gt: OPERATION_KEY_MIN, lt: OPERATION_KEY_MAX })
      .pipe(map(([, value]) => MsgPack.decode(value)));
  }
}
