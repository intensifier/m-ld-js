import { DeleteInsert, InterimUpdate, MeldUpdate } from '../../api';
import { TreeClock } from '../clocks';
import { Subject, SubjectProperty, Update } from '../../jrql-support';
import { PatchQuads } from '.';
import { JrqlGraph } from './JrqlGraph';
import { GraphAliases, SubjectGraph } from '../SubjectGraph';
import { Iri } from 'jsonld/jsonld-spec';
import { ActiveContext } from 'jsonld/lib/context';
import { Quad } from '../quads';

export class InterimUpdatePatch implements InterimUpdate {
  /** Assertions made by the constraint (not including the app patch if not mutable) */
  private readonly assertions: PatchQuads;
  /** Entailments made by the constraint */
  private entailments = new PatchQuads();
  /** Whether to recreate the insert & delete fields from the assertions */
  private needsUpdate: PromiseLike<boolean>;
  /** Cached interim update, lazily recreated after changes */
  private _update: MeldUpdate | undefined;
  /** Aliases for use in updates */
  private subjectAliases = new Map<Iri | null, { [property in '@id' | string]: SubjectProperty }>();

  /**
   * @param graph
   * @param ctx
   * @param time
   * @param patch the starting app patch (will not be mutated unless 'mutable')
   * @param mutable?
   */
  constructor(
    private readonly graph: JrqlGraph,
    private readonly ctx: ActiveContext,
    private readonly time: TreeClock,
    private readonly patch: PatchQuads, private readonly mutable?: 'mutable') {
    // If mutable, we treat the app patch as assertions
    this.assertions = mutable ? patch : new PatchQuads();
    this.needsUpdate = Promise.resolve(true);
  }

  /** @returns the final update to be presented to the app */
  async finalise() {
    await this.needsUpdate; // Ensure up-to-date with any changes
    this.needsUpdate = {
      then: () => {
        throw 'Interim update has been finalised';
      }
    };
    // The final update to the app includes all assertions and entailments
    const update = this.createUpdate(
      new PatchQuads(this.allAssertions).append(this.entailments), this.ctx);
    const { assertions, entailments } = this;
    return { update, assertions, entailments };
  }

  /** @returns an interim update to be presented to constraints */
  get update(): Promise<MeldUpdate> {
    return Promise.resolve(this.needsUpdate).then(needsUpdate => {
      if (needsUpdate || this._update == null) {
        this.needsUpdate = Promise.resolve(false);
        this._update = this.createUpdate(this.allAssertions);
      }
      return this._update;
    });
  }

  assert = (update: Update) => this.mutate(async () => {
    const patch = await this.graph.write(update, this.ctx);
    this.assertions.append(patch);
    return !patch.isEmpty;
  });

  entail = (update: Update) => this.mutate(async () => {
    const patch = await this.graph.write(update, this.ctx);
    this.entailments.append(patch);
    return false;
  });

  remove = (key: keyof DeleteInsert<any>, pattern: Subject | Subject[]) =>
    this.mutate(() => {
      const toRemove = this.graph.graphQuads(pattern, this.ctx);
      const removed = this.assertions.remove(
        key == '@delete' ? 'deletes' : 'inserts', toRemove);
      return removed.length !== 0;
    });

  alias(subjectId: Iri | null, property: '@id' | Iri, alias: Iri | SubjectProperty): void {
    this.subjectAliases.set(subjectId, {
      ...this.subjectAliases.get(subjectId), [property]: alias
    });
  }

  private aliases: GraphAliases = (subject, property) => {
    return this.subjectAliases.get(subject)?.[property];
  };

  private createUpdate(patch: PatchQuads, ctx?: ActiveContext): MeldUpdate {
    return {
      '@ticks': this.time.ticks,
      '@delete': this.quadSubjects(patch.deletes, ctx),
      '@insert': this.quadSubjects(patch.inserts, ctx)
    };
  }

  private quadSubjects(quads: Iterable<Quad>, ctx?: ActiveContext) {
    return SubjectGraph.fromRDF([...quads], { aliases: this.aliases, ctx });
  }

  private mutate(fn: () => Promise<boolean> | boolean) {
    this.needsUpdate = this.needsUpdate.then(
      async needsUpdate => (await fn()) || needsUpdate);
  }

  private get allAssertions() {
    return this.mutable ? this.assertions :
      new PatchQuads(this.patch).append(this.assertions);
  }
}
