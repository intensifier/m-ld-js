import { DatasetEngine } from '../src/engine/dataset/DatasetEngine';
import { memStore, mockRemotes, hotLive, testConfig } from './testClones';
import { NEVER, Subject as Source, asapScheduler, EMPTY, throwError } from 'rxjs';
import { comesAlive } from '../src/engine/AbstractMeld';
import { first, take, toArray, map, observeOn, single } from 'rxjs/operators';
import { TreeClock } from '../src/engine/clocks';
import { DeltaMessage, MeldRemotes, Snapshot } from '../src/engine';
import { uuid } from 'short-uuid';
import { MeldConfig, Subject, Describe, Group, Update } from '../src';
import MemDown from 'memdown';
import { AbstractLevelDOWN } from 'abstract-leveldown';
import { Hash } from '../src/engine/hash';

describe('Dataset engine', () => {
  describe('as genesis', () => {
    async function genesis(remotes: MeldRemotes, config?: Partial<MeldConfig>): Promise<DatasetEngine> {
      let clone = new DatasetEngine({ dataset: await memStore(), remotes, config: testConfig(config) });
      await clone.initialise();
      return clone;
    }

    test('starts offline with unknown remotes', async () => {
      const clone = await genesis(mockRemotes(NEVER, [null]));
      expect(clone.live.value).toBe(false);
      expect(clone.status.value).toEqual({ online: false, outdated: false, silo: false, ticks: 0 });
    });

    test('comes alive if siloed', async () => {
      const clone = await genesis(mockRemotes(NEVER, [null, false]));
      await expect(comesAlive(clone)).resolves.toBe(true);
      expect(clone.status.value).toEqual({ online: true, outdated: false, silo: true, ticks: 0 });
    });

    test('stays live without reconnect if siloed', async () => {
      const clone = await genesis(mockRemotes(NEVER, [true, false]));
      await expect(comesAlive(clone)).resolves.toBe(true);
      expect(clone.status.value).toEqual({ online: true, outdated: false, silo: true, ticks: 0 });
    });

    test('non-genesis fails to initialise if siloed', async () => {
      await expect(genesis(mockRemotes(NEVER, [false],
        TreeClock.GENESIS.forked().left), { genesis: false })).rejects.toThrow();
    });
  });

  describe('as silo genesis', () => {
    let silo: DatasetEngine;

    beforeEach(async () => {
      silo = new DatasetEngine({ dataset: await memStore(), remotes: mockRemotes(), config: testConfig() });
      await silo.initialise();
    });

    test('not found is empty', async () => {
      await expect(silo.read({
        '@describe': 'http://test.m-ld.org/fred'
      } as Describe).toPromise()).resolves.toBeUndefined();
    });

    test('stores a JSON-LD object', async () => {
      await expect(silo.write({
        '@id': 'http://test.m-ld.org/fred',
        'http://test.m-ld.org/#name': 'Fred'
      } as Subject)).resolves.toBeUndefined();
      expect(silo.status.value.ticks).toBe(1);
    });

    test('retrieves a JSON-LD object', async () => {
      await silo.write({
        '@id': 'http://test.m-ld.org/fred',
        'http://test.m-ld.org/#name': 'Fred'
      } as Subject);
      const result = silo.read({
        '@describe': 'http://test.m-ld.org/fred'
      } as Describe);
      const fred = await result.toPromise();
      expect(fred['@id']).toBe('http://test.m-ld.org/fred');
      expect(fred['http://test.m-ld.org/#name']).toBe('Fred');
    });

    test('has no ticks from genesis', async () => {
      expect(silo.status.value).toEqual({ online: true, outdated: false, silo: true, ticks: 0 });
    });

    test('has ticks after update', async () => {
      silo.write({
        '@id': 'http://test.m-ld.org/fred',
        'http://test.m-ld.org/#name': 'Fred'
      } as Subject);
      await silo.dataUpdates.pipe(first()).toPromise();
      expect(silo.status.value).toEqual({ online: true, outdated: false, silo: true, ticks: 1 });
    });

    test('follow after initial ticks', async () => {
      const firstUpdate = silo.dataUpdates.pipe(first()).toPromise();
      silo.write({
        '@id': 'http://test.m-ld.org/fred',
        'http://test.m-ld.org/#name': 'Fred'
      } as Subject);
      await expect(firstUpdate).resolves.toHaveProperty('@ticks', 1);
    });

    test('follow after current tick', async () => {
      await silo.write({
        '@id': 'http://test.m-ld.org/fred',
        'http://test.m-ld.org/#name': 'Fred'
      } as Subject);
      expect(silo.status.value.ticks).toBe(1);
      const firstUpdate = silo.dataUpdates.pipe(first()).toPromise();
      await silo.write({
        '@id': 'http://test.m-ld.org/wilma',
        'http://test.m-ld.org/#name': 'Wilma'
      } as Subject);
      await expect(firstUpdate).resolves.toHaveProperty('@ticks', 2);
    });
  });

  describe('as genesis with remote clone', () => {
    let clone: DatasetEngine;
    let remoteTime: TreeClock;
    let remoteUpdates: Source<DeltaMessage> = new Source;

    beforeEach(async () => {
      const remotesLive = hotLive([false]);
      clone = new DatasetEngine({
        dataset: await memStore(),
        // Ensure that remote updates are async
        remotes: mockRemotes(remoteUpdates.pipe(observeOn(asapScheduler)), remotesLive),
        config: testConfig()
      });
      await clone.initialise();
      await comesAlive(clone); // genesis is alive
      remoteTime = await clone.newClock(); // no longer genesis
      remotesLive.next(true); // remotes come alive
    });

    test('answers rev-up from the new clone', async () => {
      await expect(clone.revupFrom(remoteTime)).resolves.toBeDefined();
    });

    test('comes online as not silo', async () => {
      await expect(clone.status.becomes({ online: true, silo: false })).resolves.toBeDefined();
    });

    test('ticks increase monotonically', async () => {
      // Edge case from compliance tests: a local transaction racing a remote
      // transaction could cause a clock reversal.
      const updates = clone.dataUpdates.pipe(map(next => next['@ticks']), take(2), toArray()).toPromise();
      clone.write({
        '@id': 'http://test.m-ld.org/fred',
        'http://test.m-ld.org/#name': 'Fred'
      } as Subject);
      remoteUpdates.next(new DeltaMessage(remoteTime.ticked(),
        [0, uuid(), '{}', '{"@id":"http://test.m-ld.org/wilma","http://test.m-ld.org/#name":"Wilma"}']));
      // Note extra tick for constraint application in remote update
      await expect(updates).resolves.toEqual([1, 3]);
    });

    // Edge cases from system testing: newClock exposes the current clock state
    // even if it doesn't have a journalled entry. This can also happen due to:
    // 1. a remote transaction, because of the clock space made for a constraint
    test('answers rev-up from next new clone after apply', async () => {
      const updated = clone.dataUpdates.pipe(take(1)).toPromise();
      remoteUpdates.next(new DeltaMessage(remoteTime.ticked(),
        [0, uuid(), '{}', '{"@id":"http://test.m-ld.org/wilma","http://test.m-ld.org/#name":"Wilma"}']));
      await updated;
      const thirdTime = await clone.newClock();
      await expect(clone.revupFrom(thirdTime)).resolves.toBeDefined();
    });
    // 2. a failed transaction
    test('answers rev-up from next new clone after failure', async () => {
      // Insert with variables is not valid
      await clone.write(<Update>{ '@insert': { '@id': '?s', '?p': '?o' } })
        .then(() => fail('Expecting error'), () => { });
      const thirdTime = await clone.newClock();
      await expect(clone.revupFrom(thirdTime)).resolves.toBeDefined();
    });
  });

  describe('as new clone', () => {
    let remotes: MeldRemotes;
    let snapshot: jest.Mock<Promise<Snapshot>, void[]>;
    const remotesLive = hotLive([true]);

    beforeEach(async () => {
      const { left: cloneClock, right: collabClock } = TreeClock.GENESIS.forked()
      remotes = mockRemotes(NEVER, remotesLive, cloneClock);
      snapshot = jest.fn().mockReturnValueOnce(Promise.resolve<Snapshot>({
        lastHash: Hash.random(),
        lastTime: collabClock.ticked(),
        quads: EMPTY,
        tids: EMPTY,
        updates: EMPTY
      }));
      remotes.snapshot = snapshot;
    });

    test('initialises from snapshot', async () => {
      const clone = new DatasetEngine({ dataset: await memStore(), remotes, config: testConfig({ genesis: false }) });
      await clone.initialise();
      await expect(clone.status.becomes({ outdated: false })).resolves.toBeDefined();
      expect(snapshot.mock.calls.length).toBe(1);
    });

    test('can become a silo', async () => {
      const clone = new DatasetEngine({ dataset: await memStore(), remotes, config: testConfig({ genesis: false }) });
      await clone.initialise();
      remotesLive.next(false);
      await expect(clone.status.becomes({ silo: true })).resolves.toBeDefined();
    });
  });

  describe('as post-genesis clone', () => {
    let ldb: AbstractLevelDOWN;
    let config: MeldConfig;

    beforeEach(async () => {
      ldb = new MemDown();
      config = testConfig();
      // Start a temporary genesis clone to initialise the store
      let clone = new DatasetEngine({ dataset: await memStore(ldb), remotes: mockRemotes(), config });
      await clone.initialise();
      await clone.newClock(); // Forks the clock so no longer genesis
      await clone.close();
      // Now the ldb represents a former genesis clone
    });

    test('is outdated while revving-up', async () => {
      // Re-start on the same data, with a rev-up that never completes
      const remotes = mockRemotes(NEVER, [true]);
      remotes.revupFrom = async () => NEVER;
      const clone = new DatasetEngine({ dataset: await memStore(ldb), remotes, config: testConfig() });

      // Check that we are never not outdated
      const everNotOutdated = clone.status.becomes({ outdated: false });

      await clone.initialise();

      expect(clone.status.value).toEqual({ online: true, outdated: true, silo: false, ticks: 0 });
      await expect(Promise.race([everNotOutdated, Promise.resolve()])).resolves.toBeUndefined();
    });

    test('is not outdated when revved-up', async () => {
      // Re-start on the same data, with a rev-up that never completes
      const remotes = mockRemotes(NEVER, [true]);
      remotes.revupFrom = async () => EMPTY;
      const clone = new DatasetEngine({ dataset: await memStore(ldb), remotes, config: testConfig() });

      // Check that we do transition through an outdated state
      const wasOutdated = clone.status.becomes({ outdated: true });

      await clone.initialise();

      await expect(wasOutdated).resolves.toMatchObject({ online: true, outdated: true });
      await expect(clone.status.becomes({ outdated: false }))
        .resolves.toEqual({ online: true, outdated: false, silo: false, ticks: 0 });
    });

    test('immediately re-connects if rev-up fails', async () => {
      const remotes = mockRemotes(NEVER, [true]);
      const revupFrom = jest.fn()
        .mockReturnValueOnce(Promise.resolve(throwError('boom')))
        .mockReturnValueOnce(Promise.resolve(EMPTY));
      remotes.revupFrom = revupFrom;
      const clone = new DatasetEngine({ dataset: await memStore(ldb), remotes, config: testConfig() });
      await clone.initialise();
      await expect(clone.status.becomes({ outdated: false })).resolves.toBeDefined();
      expect(revupFrom.mock.calls.length).toBe(2);
    });
  });
});
