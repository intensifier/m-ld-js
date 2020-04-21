import { MeldClone, Snapshot, DeltaMessage, MeldRemotes, MeldJournalEntry } from '../m-ld';
import { Pattern, Subject, isRead, Group, DeleteInsert } from '../m-ld/jsonrql';
import { Observable, Subject as Source, PartialObserver, merge, empty, from, concat, asapScheduler } from 'rxjs';
import { TreeClock } from '../clocks';
import { SuSetDataset } from './SuSetDataset';
import { TreeClockMessageService } from '../messages';
import { Dataset } from '.';
import { catchError, publishReplay, refCount, filter, ignoreElements, materialize, dematerialize, tap, observeOn } from 'rxjs/operators';
import { Hash } from '../hash';

export class DatasetClone implements MeldClone {
  readonly updates: Observable<MeldJournalEntry>;
  private readonly updateSource: Source<MeldJournalEntry> = new Source;
  private readonly dataset: SuSetDataset;
  private messageService: TreeClockMessageService;
  private readonly orderingBuffer: DeltaMessage[] = [];
  private readonly updateReceiver: PartialObserver<DeltaMessage> = {
    next: delta => this.messageService.receive(delta, this.orderingBuffer, acceptedMsg =>
      this.dataset.apply(acceptedMsg.data, this.localTime)),
    error: err => this.close(err),
    complete: () => this.close()
  };

  constructor(dataset: Dataset,
    private readonly remotes: MeldRemotes) {
    this.dataset = new SuSetDataset(dataset);
    // Update notifications are delayed to ensure internal processing has priority
    this.updates = this.updateSource.pipe(observeOn(asapScheduler));
  }

  get id() {
    return this.dataset.id;
  }

  async initialise(): Promise<void> {
    await this.dataset.initialise();
    // Establish a clock for this clone
    let newClone = false, time = await this.dataset.loadClock();
    if (!time) {
      newClone = true;
      time = await this.remotes.newClock();
      await this.dataset.saveClock(time, true);
    }
    console.info(`${this.id}: has time ${time}`);
    this.messageService = new TreeClockMessageService(time);
    // Flush unsent operations
    await new Promise<void>((resolve, reject) => {
      this.dataset.unsentLocalOperations().subscribe(
        entry => this.updateSource.next(entry), reject, resolve);
    });
    if (time.isId) { // Top-level is Id, never been forked
      // No rev-up to do, so just subscribe to updates from later clones
      this.remotes.updates.subscribe(this.updateReceiver);
    } else {
      const remoteRevups = new Source<DeltaMessage>();
      merge(this.remotes.updates, remoteRevups.pipe(catchError(this.revupLost)))
        .subscribe(this.updateReceiver);
      if (newClone) {
        await this.requestSnapshot(remoteRevups);
      } else {
        const revup = await this.remotes.revupFrom(await this.dataset.lastHash());
        if (revup) {
          revup.subscribe(remoteRevups);
        } else {
          await this.requestSnapshot(remoteRevups);
        }
      }
    }
    this.remotes.connect(this);
  }

  private revupLost(err: any) {
    // Not a catastrophe but may get ordering overflow later
    console.warn(`${this.id}: Revup lost with ${err}`);
    return empty();
  }

  private async requestSnapshot(remoteRevups: PartialObserver<DeltaMessage>) {
    const snapshot = await this.remotes.snapshot();
    // Deliver the message immediately through the message service
    const snapshotMsg = { time: snapshot.time } as DeltaMessage;
    await new Promise<void>((resolve, reject) => {
      this.messageService.deliver(snapshotMsg, this.orderingBuffer, acceptedMsg => {
        if (acceptedMsg == snapshotMsg) {
          this.dataset.applySnapshot(
            snapshot.data, snapshot.lastHash, snapshot.time, this.localTime)
            .then(resolve, reject);
        } else {
          this.dataset.apply(acceptedMsg.data, this.localTime);
        }
      });
      snapshot.updates.subscribe(remoteRevups);
    });
  }

  async newClock(): Promise<TreeClock> {
    const newClock = this.messageService.fork();
    // Forking is a mutation operation, need to save the new clock state
    await this.dataset.saveClock(this.localTime);
    return newClock;
  }

  async snapshot(): Promise<Snapshot> {
    console.info(`${this.id}: Compiling snapshot`);
    const dataSnapshot = await this.dataset.takeSnapshot();
    return {
      time: dataSnapshot.time,
      // Snapshotting holds open a transaction, so buffer/replay triples
      data: dataSnapshot.data.pipe(publishReplay(), refCount()),
      lastHash: dataSnapshot.lastHash,
      updates: this.remoteUpdatesBeforeNow()
    };
  }

  private remoteUpdatesBeforeNow(): Observable<DeltaMessage> {
    const now = this.localTime;
    const updatesBeforeNow = merge(
      // #1 Anything that arrives stamped prior to now
      this.remotes.updates.pipe(filter(message => message.time.anyLt(now))),
      // #2 Anything currently in our ordering buffer
      from(this.orderingBuffer));
    // #3 terminate the flow when this process disposes
    return merge(
      updatesBeforeNow.pipe(materialize()),
      this.asCompletable().pipe(materialize()))
      .pipe(dematerialize());
  }

  private asCompletable(): Observable<never> {
    return this.updateSource.pipe(ignoreElements());
  }

  private get localTime() {
    return this.messageService.peek();
  }

  async revupFrom(lastHash: Hash): Promise<Observable<DeltaMessage> | undefined> {
    const operations = await this.dataset.operationsSince(lastHash);
    if (operations)
      return concat(operations, this.remoteUpdatesBeforeNow());
  }

  transact(request: Pattern): Observable<Subject> {
    if (isRead(request)) {
      return this.dataset.read(request);
    } else {
      return from(this.dataset.transact(async () => {
        const patch = await this.dataset.write(request);
        return [this.messageService.send(), patch];
      }).then(journalEntry => {
        // Publish the MeldJournalEntry
        this.updateSource.next(journalEntry);
      })).pipe(ignoreElements()); // Ignores the void promise result
    }
  }

  follow(): Observable<DeleteInsert<Group>> {
    return this.dataset.updates;
  }

  close(err?: any) {
    console.log(`${this.id}: Shutting down clone ${err ? 'due to ' + err : 'normally'}`);
    if (err)
      this.updateSource.error(err);
    else
      this.updateSource.complete();
    return this.dataset.close(err);
  }
}