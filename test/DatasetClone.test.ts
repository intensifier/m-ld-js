import { DatasetClone } from '../src/dataset/DatasetClone';
import { Subject, Describe } from '../src/m-ld/jsonrql';
import { genesisClone } from './testClones';

describe('Meld store implementation', () => {
  let store: DatasetClone;

  beforeEach(async () => {
    store = await genesisClone(); 
  });

  test('not found is empty', async () => {
    await expect(store.transact({
      '@describe': 'http://test.m-ld.org/fred'
    } as Describe).toPromise()).resolves.toBeUndefined();
  });

  test('stores a JSON-LD object', async () => {
    await expect(store.transact({
      '@id': 'http://test.m-ld.org/fred',
      'http://test.m-ld.org/#name': 'Fred'
    } as Subject).toPromise())
      // Expecting nothing to be emitted for an insert
      .resolves.toBeUndefined();
  });

  test('retrieves a JSON-LD object', async () => {
    await store.transact({
      '@id': 'http://test.m-ld.org/fred',
      'http://test.m-ld.org/#name': 'Fred'
    } as Subject).toPromise();
    const fred = await store.transact({
      '@describe': 'http://test.m-ld.org/fred'
    } as Describe).toPromise();
    expect(fred['@id']).toBe('http://test.m-ld.org/fred');
    expect(fred['http://test.m-ld.org/#name']).toBe('Fred');
  });
});