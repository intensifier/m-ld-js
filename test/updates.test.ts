import { mockFn } from 'jest-mock-extended';
import {
  asSubjectUpdates, includesValue, includeValues, propertyValue, Reference, Subject, updateSubject
} from '../src';
import { SubjectGraph } from '../src/engine/SubjectGraph';
import { XS } from '../src/ns';

describe('Update utilities', () => {
  test('converts simple group update to subject updates', () => {
    expect(asSubjectUpdates({
      '@delete': [{ '@id': 'foo', size: 10 }],
      '@insert': [{ '@id': 'foo', size: 20 }]
    })).toEqual({
      'foo': {
        '@delete': { '@id': 'foo', size: 10 },
        '@insert': { '@id': 'foo', size: 20 }
      }
    });
  });

  test('un-reifies references in subject updates', () => {
    expect(asSubjectUpdates({
      '@delete': [{ '@id': 'foo', friend: { '@id': 'bar', name: 'Bob' } }],
      '@insert': []
    })).toEqual({
      'foo': {
        '@delete': { '@id': 'foo', friend: { '@id': 'bar' } },
        '@insert': undefined
      }
    });
  });

  test('converts array group update to subject updates', () => {
    expect(asSubjectUpdates({
      '@delete': [{ '@id': 'foo', size: 10 }, { '@id': 'bar', size: 30 }],
      '@insert': [{ '@id': 'foo', size: 20 }, { '@id': 'bar', size: 40 }]
    })).toEqual({
      'foo': {
        '@delete': { '@id': 'foo', size: 10 },
        '@insert': { '@id': 'foo', size: 20 }
      },
      'bar': {
        '@delete': { '@id': 'bar', size: 30 },
        '@insert': { '@id': 'bar', size: 40 }
      }
    });
  });

  interface Box extends Subject {
    '@id': string;
    size: number;
    label?: string;
    contents?: (Box | Reference)[];
    history?: {
      '@id': string;
      '@list': (string | Box)[];
    };
  }

  test('include single value in subject', () => {
    const box: Box = { '@id': 'bar', size: 10 };
    includeValues(box, 'label', 'My Box');
    expect(box.label).toBe('My Box');
  });

  test('include multiple values in subject', () => {
    const box: Box = { '@id': 'bar', size: 10 };
    includeValues(box, 'label', 'My Box');
    includeValues(box, 'label', 'Your Box');
    expect(box.label).toEqual(['My Box', 'Your Box']);
  });

  test('include set values in subject', () => {
    // Using a plain Subject here because Box doesn't admit a label @set
    const box: Subject = { '@id': 'bar', size: 10, label: { '@set': 'My Box' } };
    includeValues(box, 'label', 'Your Box');
    expect(box.label).toEqual({ '@set': ['My Box', 'Your Box'] });
  });

  test('includes value in subject', () => {
    const box: Box = { '@id': 'bar', size: 10, label: 'My Box' };
    expect(includesValue(box, 'label', 'My Box')).toBe(true);
  });

  test('set includes value in subject', () => {
    // Using a plain Subject here because Box doesn't admit a label @set
    const box: Subject = { '@id': 'bar', size: 10, label: { '@set': 'My Box' } };
    expect(includesValue(box, 'label', 'My Box')).toBe(true);
  });

  test('does not update mismatching ids', () => {
    const box: Box = { '@id': 'bar', size: 10, label: 'My box' };
    updateSubject(box, { foo: { '@insert': { '@id': 'foo', size: 20 }, '@delete': undefined } });
    expect(box).toEqual({ '@id': 'bar', size: 10, label: 'My box' });
  });

  test('adds a missing value', () => {
    const box: Box = { '@id': 'foo', size: 10 };
    updateSubject(box, {
      foo: {
        '@insert': { '@id': 'foo', label: 'My box' },
        '@delete': undefined
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: 10, label: 'My box' });
  });

  test('adds an array value', () => {
    const box: Box = { '@id': 'foo', size: 10 };
    updateSubject(box, {
      foo: {
        '@insert': { '@id': 'foo', size: [20, 30] },
        '@delete': undefined
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: [10, 20, 30] });
  });

  test('removes a value to leave undefined', () => {
    const box: Box = { '@id': 'foo', size: 10 };
    updateSubject(box, { foo: { '@insert': undefined, '@delete': { '@id': 'foo', size: 10 } } });
    expect(box).toEqual({ '@id': 'foo' });
  });

  test('removes last array value to leave undefined', () => {
    const box = { '@id': 'foo', size: [10, 20] };
    updateSubject(box, {
      foo: {
        '@insert': undefined,
        '@delete': { '@id': 'foo', size: [10, 20] }
      }
    });
    expect(box).toEqual({ '@id': 'foo' });
  });

  test('does not add an empty array value', () => {
    const box: Box = { '@id': 'foo', size: 10 };
    updateSubject(box, { foo: { '@insert': { '@id': 'foo', size: [] }, '@delete': undefined } });
    expect(box).toEqual({ '@id': 'foo', size: 10 });
  });

  test('adds an inserted value', () => {
    const box: Box = { '@id': 'foo', size: 10, label: 'My box' };
    updateSubject(box, { foo: { '@insert': { '@id': 'foo', size: 20 }, '@delete': undefined } });
    expect(box).toEqual({ '@id': 'foo', size: [10, 20], label: 'My box' });
  });

  test('does not insert a duplicate value', () => {
    const box: Box = { '@id': 'foo', size: 10, label: 'My box' };
    updateSubject(box, { foo: { '@insert': { '@id': 'foo', size: 10 }, '@delete': undefined } });
    expect(box).toEqual({ '@id': 'foo', size: 10, label: 'My box' });
  });

  test('removes a deleted value', () => {
    const box: Box = { '@id': 'foo', size: 10, label: 'My box' };
    updateSubject(box, { foo: { '@delete': { '@id': 'foo', size: 10 }, '@insert': undefined } });
    expect(box).toEqual({ '@id': 'foo', label: 'My box' });
  });

  test('updates a value', () => {
    const box: Box = { '@id': 'foo', size: 10, label: 'My box' };
    updateSubject(box, {
      foo: {
        '@insert': { '@id': 'foo', size: 20 },
        '@delete': { '@id': 'foo', size: 10 }
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: 20, label: 'My box' });
  });

  test('updates unchanged value', () => {
    const box: Box = { '@id': 'foo', size: 10, label: 'My box' };
    updateSubject(box, {
      foo: {
        '@insert': { '@id': 'foo', size: 10 },
        '@delete': { '@id': 'foo', size: 10 }
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: 10, label: 'My box' });
  });

  // FIXME This breaks the Node type, but not possible to prevent at runtime
  test('adds a singleton reference as a singleton if array property undefined', () => {
    const box: Box = { '@id': 'foo', size: 10 };
    updateSubject(box, {
      foo: {
        '@insert': { '@id': 'foo', contents: { '@id': 'bar' } }, '@delete': undefined
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: 10, contents: { '@id': 'bar' } });
  });

  test('adds a singleton reference into array if array property defined', () => {
    const box: Box = { '@id': 'foo', size: 10, contents: [] };
    updateSubject(box, {
      foo: {
        '@insert': { '@id': 'foo', contents: { '@id': 'bar' } }, '@delete': undefined
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: 10, contents: [{ '@id': 'bar' }] });
  });

  test('updates a reference', () => {
    const box: Box = { '@id': 'foo', size: 10, contents: [{ '@id': 'bar' }] };
    updateSubject(box, {
      foo: {
        '@delete': { '@id': 'foo', contents: { '@id': 'bar' } },
        '@insert': { '@id': 'foo', contents: { '@id': 'baz' } }
      }
    });
    expect(box).toEqual({ '@id': 'foo', size: 10, contents: [{ '@id': 'baz' }] });
  });

  describe('Deep updates', () => {
    test('updates nested subject', () => {
      const box: Box = {
        '@id': 'foo', size: 10, contents: [{
          '@id': 'bar', size: 5
        }]
      };
      updateSubject(box, {
        bar: {
          '@delete': { '@id': 'bar', size: 5 },
          '@insert': { '@id': 'bar', size: 6 }
        }
      });
      expect(box).toEqual({
        '@id': 'foo', size: 10, contents: [{
          '@id': 'bar', size: 6
        }]
      });
    });

    test('updates nested subject with graph', () => {
      const box: Box = {
        '@id': 'foo', size: 10, contents: [{
          '@id': 'bar', size: 5
        }]
      };
      updateSubject(box, {
        '@delete': new SubjectGraph([
          { '@id': 'foo', size: 10 },
          { '@id': 'bar', size: 5 }
        ]),
        '@insert': new SubjectGraph([
          { '@id': 'foo', size: 11 },
          { '@id': 'bar', size: 6 }
        ])
      });
      expect(box).toEqual({
        '@id': 'foo', size: 11, contents: [{
          '@id': 'bar', size: 6
        }]
      });
    });

    test('updates nested subject with subject updates', () => {
      const box: Box = {
        '@id': 'foo', size: 10, contents: [{
          '@id': 'bar', size: 5
        }]
      };
      updateSubject(box, {
        foo: {
          '@delete': { '@id': 'foo', size: 10 },
          '@insert': { '@id': 'foo', size: 11 }
        },
        bar: {
          '@delete': { '@id': 'bar', size: 5 },
          '@insert': { '@id': 'bar', size: 6 }
        }
      });
      expect(box).toEqual({
        '@id': 'foo', size: 11, contents: [{
          '@id': 'bar', size: 6
        }]
      });
    });

    test('updates circular nesting', () => {
      const box: Box = { '@id': 'foo', size: 10 };
      box.contents = [box];
      updateSubject(box, {
        foo: {
          '@delete': { '@id': 'foo', size: 10 },
          '@insert': { '@id': 'foo', size: 11 }
        }
      });
      expect(box['@id']).toBe('foo');
      expect(box.size).toBe(11);
      expect(box.contents).toEqual([box]);
    });
  });

  describe('List updates', () => {
    // Note: List updates are always expressed with identified slots
    test('appends one item to a list', () => {
      const box: Box = {
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': [] }
      };
      updateSubject(box, {
        'foo-history': {
          '@delete': undefined,
          '@insert': {
            '@id': 'foo-history',
            '@list': { 0: { '@id': 'slot1' } }
          }
        },
        slot1: {
          '@delete': undefined,
          '@insert': { '@id': 'slot1', '@item': 'made' }
        }
      });
      expect(box).toEqual({
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': ['made'] }
      });
    });

    test('removes one item from a list', () => {
      const box: Box = {
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': ['made'] }
      };
      updateSubject(box, {
        'foo-history': {
          '@delete': {
            '@id': 'foo-history',
            '@list': { 0: { '@id': 'slot1' } }
          },
          '@insert': undefined
        }
      });
      expect(box).toEqual({
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': [] }
      });
    });

    test('replaces one item in a list', () => {
      const box: Box = {
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': ['made'] }
      };
      updateSubject(box, {
        'foo-history': {
          '@delete': {
            '@id': 'foo-history',
            '@list': { 0: { '@id': 'slot1' } }
          },
          '@insert': {
            '@id': 'foo-history',
            '@list': { 0: { '@id': 'slot1' } }
          }
        },
        'slot1': {
          '@insert': { '@id': 'slot1', '@item': 'manufactured' }, '@delete': undefined
        }
      });
      expect(box).toEqual({
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': ['manufactured'] }
      });
    });

    test('replaces two items in the middle of a list with one splice', () => {
      const splice = mockFn().mockImplementation([].splice);
      const history = ['made', 'filled', 'sold', 'disposed'];
      history.splice = splice;
      const box: Box = {
        '@id': 'foo', size: 10, history: { '@id': 'foo-history', '@list': history }
      };
      updateSubject(box, {
        'foo-history': {
          '@delete': {
            '@id': 'foo-history', '@list': { 1: { '@id': 'slot1' }, 2: { '@id': 'slot2' } }
          },
          '@insert': {
            '@id': 'foo-history', '@list': { 1: { '@id': 'slot3' } }
          }
        },
        'slot3': {
          '@insert': { '@id': 'slot3', '@item': 'soled' }, '@delete': undefined
        }
      });
      // @ts-ignore Remove mock impl which affects toEqual
      delete history.splice;
      expect(box).toEqual({
        '@id': 'foo', size: 10,
        history: {
          '@id': 'foo-history',
          '@list': ['made', 'soled', 'disposed']
        }
      });
      expect(splice).toBeCalledWith(1, 2, 'soled');
    });

    test('updates nested list subject', () => {
      const box: Box = {
        '@id': 'foo', size: 10, history: {
          '@id': 'foo-history',
          '@list': [{
            '@id': 'bar', size: 5
          }]
        }
      };
      updateSubject(box, {
        bar: {
          '@delete': { '@id': 'bar', size: 5 },
          '@insert': { '@id': 'bar', size: 6 }
        }
      });
      expect(box).toEqual({
        '@id': 'foo', size: 10, history: {
          '@id': 'foo-history',
          '@list': [{
            '@id': 'bar', size: 6
          }]
        }
      });
    });
  });

  describe('property value casting', () => {
    test('cast string', () => {
      expect(propertyValue({
        name: 'Fred'
      }, 'name', String)).toBe('Fred');
      expect(propertyValue({
        name: ['Fred']
      }, 'name', String)).toBe('Fred');
      expect(propertyValue({
        name: { '@type': XS.string, '@value': 'Fred' }
      }, 'name', String)).toBe('Fred');
      expect(propertyValue({
        name: { '@language': 'en', '@value': 'Fred' }
      }, 'name', String)).toBe('Fred');
      expect(() => propertyValue({
        name: []
      }, 'name', String)).toThrow();
      expect(() => propertyValue({
        name: ['Fred', 'Flintstone']
      }, 'name', String)).toThrow();
      expect(() => propertyValue({
        name: 10
      }, 'name', String)).toThrow();
      expect(() => propertyValue({
        age: 10
      }, 'name', String)).toThrow();
      expect(() => propertyValue({
        name: { '@type': XS.integer, '@value': 10 }
      }, 'name', String)).toThrow();
    });

    test('cast number', () => {
      expect(propertyValue({
        age: 40
      }, 'age', Number)).toBe(40);
      expect(propertyValue({
        age: { '@type': XS.integer, '@value': 40 }
      }, 'age', Number)).toBe(40);
      expect(propertyValue({
        age: { '@type': XS.double, '@value': 40 }
      }, 'age', Number)).toBe(40);
      expect(() => propertyValue({
        age: 'middle'
      }, 'age', Number)).toThrow();
      expect(() => propertyValue({
        age: { '@type': XS.string, '@value': 'middle' }
      }, 'age', Number)).toThrow();
    });

    test('cast boolean', () => {
      expect(propertyValue({
        married: true
      }, 'married', Boolean)).toBe(true);
      expect(propertyValue({
        married: { '@type': XS.boolean, '@value': true }
      }, 'married', Boolean)).toBe(true);
      expect(() => propertyValue({
        married: 'Wilma'
      }, 'married', Boolean)).toThrow();
    });

    test('cast date', () => {
      const now = new Date();
      expect(propertyValue({
        birthday: now.toISOString()
      }, 'birthday', Date).getDate()).toBe(now.getDate());
      expect(propertyValue({
        birthday: { '@type': XS.dateTime, '@value': now.toISOString() }
      }, 'birthday', Date).getDate()).toBe(now.getDate());
      expect(() => propertyValue({
        birthday: 'Pleistocene'
      }, 'birthday', Date)).toThrow();
    });

    test('cast object', () => {
      expect(propertyValue({
        wife: { name: 'Wilma' }
      }, 'wife', Object)).toEqual({ name: 'Wilma' });
      expect(() => propertyValue({
        wife: 'Wilma'
      }, 'wife', Object)).toThrow();
    });

    test('cast buffer', () => {
      const avatar = Buffer.of(0, 1);
      expect(avatar.equals(propertyValue({
        avatar: { '@type': XS.base64Binary, '@value': avatar.toString('base64') }
      }, 'avatar', Uint8Array))).toBe(true);
      expect(() => propertyValue({
        avatar: avatar.toString('base64')
      }, 'avatar', Uint8Array)).toThrow();
    });

    test('cast container', () => {
      expect(propertyValue({
        ears: ['left', 'right']
      }, 'ears', Array)).toEqual(['left', 'right']);
      expect(propertyValue({
        nose: true
      }, 'nose', Array)).toEqual([true]);
      expect(propertyValue({
        nose: { '@type': XS.boolean, '@value': true }
      }, 'nose', Array, Boolean)).toEqual([true]);
      expect(propertyValue({
        ears: ['left', 'right']
      }, 'ears', Set)).toEqual(new Set(['right', 'left']));
      expect(propertyValue({
        ears: [
          { '@type': XS.string, '@value': 'left' },
          { '@type': XS.string, '@value': 'right' }
        ]
      }, 'ears', Array)).toEqual([
        { '@type': XS.string, '@value': 'left' },
        { '@type': XS.string, '@value': 'right' }
      ]);
      expect(propertyValue({
        ears: [
          { '@type': XS.string, '@value': 'left' },
          { '@type': XS.string, '@value': 'right' }
        ]
      }, 'ears', Array, String)).toEqual(['left', 'right']);
      expect(propertyValue({
        ears: { '@list': ['left', 'right'] }
      }, 'ears', Array)).toEqual(['left', 'right']);
      expect(propertyValue({
        ears: { '@set': ['left', 'right'] }
      }, 'ears', Array)).toEqual(['left', 'right']);
    });

    test('cast empty', () => {
      expect(propertyValue({
        ears: undefined
      }, 'ears', Array)).toEqual([]);
      expect(propertyValue({
        name: 'Fred'
      }, 'ears', Array)).toEqual([]);
      expect(propertyValue({
        name: 'Fred'
      }, 'ears', Set)).toEqual(new Set([]));
    });
  });
});
