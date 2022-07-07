import type { Bindings, DataFactory, NamedNode, Quad, Term } from 'rdf-js';
import { IndexMap, IndexSet } from './indices';
import { Binding, QueryableRdfSource } from '../rdfjs-support';

export type Triple = Omit<Quad, 'graph'>;
export type TriplePos = 'subject' | 'predicate' | 'object';

export type {
  DefaultGraph, Quad, Term, DataFactory, NamedNode, Source as QuadSource,
  Quad_Subject, Quad_Predicate, Quad_Object, Bindings, Literal
} from 'rdf-js';

export abstract class QueryableRdfSourceProxy implements QueryableRdfSource {
  match: QueryableRdfSource['match'] = (...args) => this.src.match(...args);
  // @ts-ignore - TS can't cope with overloaded query method
  query: QueryableRdfSource['query'] = (...args) => this.src.query(...args);
  countQuads: QueryableRdfSource['countQuads'] = (...args) => this.src.countQuads(...args);

  protected abstract get src(): QueryableRdfSource;
}

export class QuadMap<T> extends IndexMap<Quad, T> {
  protected getIndex(key: Quad): string {
    return quadIndexKey(key);
  }
}

export class TripleMap<T> extends IndexMap<Triple, T> {
  protected getIndex(key: Triple): string {
    return tripleIndexKey(key);
  }
}

export class QuadSet extends IndexSet<Quad> {
  protected construct(quads?: Iterable<Quad>): QuadSet {
    return new QuadSet(quads);
  }

  protected getIndex(quad: Quad): string {
    return quadIndexKey(quad);
  }
}

export function *tripleKey(triple: Triple): Generator<string> {
  switch (triple.object.termType) {
    case 'Literal':
      yield triple.subject.value;
      yield triple.predicate.value;
      yield triple.object.termType;
      yield triple.object.value ?? '';
      yield triple.object.datatype.value ?? '';
      yield triple.object.language ?? '';
      break;
    default:
      yield triple.subject.value;
      yield triple.predicate.value;
      yield triple.object.termType;
      yield triple.object.value;
  }
}

export function tripleIndexKey(triple: Triple) {
  const tik = <Triple & { _tik: string }>triple;
  if (tik._tik == null)
    tik._tik = [...tripleKey(triple)].join('^');
  return tik._tik;
}

export function quadIndexKey(quad: Quad) {
  const qik = <Quad & { _qik: string }>quad;
  if (qik._qik == null)
    qik._qik = `${quad.graph.value}^${tripleIndexKey(quad)}`;
  return qik._qik;
}

export function canPosition<P extends TriplePos>(pos: P, value?: Term): value is Quad[P] {
  if (!value)
    return false;
  // Subjects and Predicate don't allow literals
  if ((pos == 'subject' || pos == 'predicate') && value.termType == 'Literal')
    return false;
  // Predicates don't allow blank nodes
  return !(pos == 'predicate' && value.termType == 'BlankNode');

}

export function inPosition<P extends TriplePos>(pos: P, value?: Term): Quad[P] {
  if (canPosition(pos, value))
    return value;
  else
    throw new Error(`${value} cannot be used in ${pos} position`);
}

export interface RdfFactory extends Required<DataFactory> {
  /**
   * Generates a new skolemization IRI. The dataset base is allowed to be
   * `undefined` but the function will throw a `TypeError` if it is.
   * @see https://www.w3.org/TR/rdf11-concepts/#h3_section-skolemization
   */
  skolem?(): NamedNode;
}

export function toBinding(bindings: Bindings): Binding {
  const binding: Binding = {};
  for (let [variable, term] of bindings)
    binding[`?${variable.value}`] = term;
  return binding;
}
