import type { BaseQuad, Quad, Source, Stream, Term } from 'rdf-js';
import type { Algebra } from 'sparqlalgebrajs';
import type { EventEmitter } from 'events';

/**
 * This module defines the RDF/JS and other extended RDF JS community style
 * methods supported by JrqlGraph.
 */

/**
 * Bound variable values from a SPARQL projection.
 * Keys include the variable prefix `?`.
 * @category RDF/JS
 */
export interface Binding<T = Term> {
  [key: string]: T;
}

/**
 * Abstract stream of any type; implicit supertype of an RDF/JS
 * [Stream](https://rdf.js.org/stream-spec/#stream-interface)
 * @category RDF/JS
 */
// Using type not interface so typedoc does not document EventEmitter
export type BaseStream<T> = EventEmitter & {
  read: () => T | null;
}

/**
 * SPARQL query methods
 * @category RDF/JS
 */
export interface QueryableRdf<Q extends BaseQuad = Quad> {
  query(query: Algebra.Construct): Stream<Q>;
  query(query: Algebra.Describe): Stream<Q>;
  query(query: Algebra.Project): BaseStream<Binding>;
  query(query: Algebra.Distinct): BaseStream<Binding>;
}

/**
 * A [Source](https://rdf.js.org/stream-spec/#source-interface) which is able to
 * count quads, as an optimisation for query engines
 *
 * @see https://www.npmjs.com/package/@comunica/query-sparql-rdfjs#optimization
 * @category RDF/JS
 */
export interface CountableRdf {
  countQuads(...args: Parameters<Source['match']>): Promise<number>;
}

/**
 * Rollup interface for an RDF source that can answer SPARQL queries
 * @category RDF/JS
 */
export interface QueryableRdfSource<Q extends BaseQuad = Quad>
  extends Source<Q>, QueryableRdf<Q>, CountableRdf {
}

/**
 * Implicit supertype of Algebra.DeleteInsert that does not require a factory
 * @category RDF/JS
 */
export type BaseDeleteInsert<Q extends BaseQuad = Quad> = { delete?: Q[], insert?: Q[] };

/**
 * An RDF dataset representation that provides update semantics.
 * @category RDF/JS
 */
export interface UpdatableRdf<State> {
  /**
   * Performs an atomic update to the dataset. The deletes and inserts will be
   * committed in the resolved state, which is expected to also be updatable for
   * further modifications.
   */
  updateQuads(update: BaseDeleteInsert): Promise<State>;
}

/**
 * An RDF dataset that transitions from one state to another via updates, which
 * can be iterated over, for example to update some user state.
 * @category RDF/JS
 */
export interface LiveRdf<State, Update extends BaseDeleteInsert> {
  /**
   * Obtains a generator of states, with the updates that led to them. The
   * states are immutable until `next`, `return` or `throw` are called on the
   * generator – if a `for await` loop is being used, these will be called by
   * Javascript as the loop continues or terminates.
   *
   * The optional snapshot handler receives an initial state prior to any
   * updates. Its passed state is immutable until the procedure's returned
   * promise settles.
   */
  quadStates(snapshot?: (state: State) => Promise<unknown>): AsyncGenerator<[Update, State]>;
}