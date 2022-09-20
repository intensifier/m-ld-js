import {
  AgreementCondition, DeleteInsert, GraphSubject, GraphUpdate, InterimUpdate, MeldConstraint,
  MeldExtensions, MeldPreUpdate, MeldReadState, StateManaged
} from '../api';
import { Shape } from '../shacl';
import { M_LD } from '../ns';
import { Describe, isPropertyObject, isReference, Reference, Subject } from '../jrql-support';
import { ExtensionEnvironment, ExtensionSubject, OrmDomain, OrmSubject, OrmUpdating } from '../orm';
import { MeldError } from '../engine/MeldError';
import { Iri } from '@m-ld/jsonld';
import { array } from '../util';
import { SubjectGraph } from '../engine/SubjectGraph';
import { asSubjectUpdates } from '../updates';
import { Logger } from 'loglevel';
import { getIdLogger } from '../engine/logging';

export class Statutory extends OrmDomain implements StateManaged<MeldExtensions> {
  /**
   * Extension declaration. Insert into the domain data to install the
   * extension. For example (assuming a **m-ld** `clone` object):
   *
   * ```typescript
   * clone.write(Statutory.declare(0));
   * ```
   *
   * @param priority the preferred index into the existing list of extensions
   * (lower value is higher priority).
   */
  static declare = (priority: number): Subject => ({
    '@id': M_LD.extensions,
    '@list': {
      [priority]: {
        '@id': `${M_LD.EXT.$base}constraints/Statutory`,
        '@type': M_LD.JS.commonJsModule,
        [M_LD.JS.require]: '@m-ld/m-ld/ext/constraints/Statutory',
        [M_LD.JS.className]: 'Statutory'
      }
    }
  });

  /**
   * Declares that some set of shapes are statutory, that is, they cannot change
   * without agreement. In order to have agreement, the given conditions must be
   * met.
   *
   * For example (assuming a **m-ld** `clone` object):
   *
   * ```typescript
   * clone.write(Statutory.declareStatute(
   *   'https://alice.example/profile#me',
   *   { '@id': 'documentStateShape' }
   * ));
   * ```
   *
   * @param statuteId the new statute's identity. Omit to auto-generate.
   * @param statutoryShapes shape Subjects, or References to pre-existing shapes
   * @param sufficientConditions References to pre-existing agreement conditions
   */
  static declareStatute = ({ statuteId, statutoryShapes, sufficientConditions }: {
    statuteId?: Iri,
    statutoryShapes: Subject | Reference | (Subject | Reference)[],
    sufficientConditions: Subject | Reference | (Subject | Reference)[]
  }): Subject => ({
    '@id': statuteId,
    '@type': M_LD.Statute,
    [M_LD.statutoryShape]: statutoryShapes,
    [M_LD.sufficientCondition]: sufficientConditions
  });

  /**
   * Declares a principal to have authority over some shape, for example
   * (assuming a **m-ld** `clone` object):
   *
   * ```typescript
   * clone.write(Statutory.declareAuthority(
   *   'https://alice.example/profile#me',
   *   { '@id': 'documentStateShape' }
   * ));
   * ```
   *
   * @param principalIri the principal's identity. As for all domain data, this
   * can be a relative IRI, e.g. `'fred'`.
   * @param shape the shape Subject, or a Reference to a pre-existing shape
   */
  static declareAuthority = (principalIri: Iri, shape: Subject | Reference): Subject => ({
    '@id': principalIri,
    [M_LD.hasAuthority]: shape
  });

  private statutes = new Map<Iri, Statute>();
  private readonly env: ExtensionEnvironment;
  private readonly log: Logger;

  constructor({ env }: { env: ExtensionEnvironment }) {
    super();
    this.env = env;
    this.log = getIdLogger(this.constructor, env.config['@id'], env.config.logLevel);
  }

  ready(): Promise<MeldExtensions> {
    return this.upToDate().then(() => ({
      constraints: [{
        check: (state, update) => Promise.all(Array.from(this.statutes.values(),
          statute => statute.check(state, update)))
      }],
      agreementConditions: [{
        test: (state, update) => Promise.all(Array.from(this.statutes.values(),
          statute => statute.test(state, update)))
      }]
    }));
  }

  initialise(state: MeldReadState) {
    // Read the available statutes
    return this.updating(state, orm =>
      state.read<Describe>({
        '@describe': '?statute',
        '@where': { '@id': '?statute', '@type': M_LD.Statute }
      }).each(src => this.loadStatute(src, orm)));
  }

  onUpdate(update: MeldPreUpdate, state: MeldReadState) {
    return this.updating(state, orm =>
      orm.updated(update, deleted => {
        // Remove any deleted statutes
        this.statutes.delete(deleted.src['@id']);
      }, async insert => {
        // Capture any new statutes (the type has been inserted)
        if (insert['@type'] === M_LD.Statute)
          await this.loadStatute(insert, orm);
      }));
  }

  private async loadStatute(src: GraphSubject, orm: OrmUpdating) {
    // Putting into both our statutes map and the domain cache
    this.statutes.set(src['@id'], await orm.get(src, src =>
      new Statute(src, orm, src => {
        if (src['@id'] === M_LD.hasAuthority)
          return new HasAuthority(src, this, this.log);
        else if (array(src['@type']).includes(M_LD.JS.commonJsModule))
          return new ExtensionCondition(src, this.env, this.log);
        else
          throw new TypeError(`${src['@id']} is not an agreement condition`);
      })));
  }
}

/**
 * A scope of data for which an agreement is required, if the data is to change
 */
export class Statute extends OrmSubject implements MeldConstraint, AgreementCondition {
  /** shapes describing statutory graph content */
  statutoryShapes: Shape[];
  sufficientConditions: (ShapeAgreementCondition & OrmSubject)[];

  constructor(
    src: GraphSubject,
    orm: OrmUpdating,
    // Substitutable for unit tests
    prover: (src: GraphSubject) => ShapeAgreementCondition & OrmSubject
  ) {
    super(src);
    this.initSrcProperty(src, M_LD.statutoryShape, [Array, Subject], {
      local: 'statutoryShapes', orm, construct: Shape.from
    });
    this.initSrcProperty(src, M_LD.sufficientCondition, [Array, Subject], {
      local: 'sufficientConditions', orm, construct: prover
    });
  }

  async check(state: MeldReadState, interim: InterimUpdate) {
    // Detect a change to the shape in the update
    const update = await interim.update;
    await this.withAffected(state, update, async affected => {
      for (let condition of this.sufficientConditions) {
        const proof = await condition.prove(state, affected, update['@principal']);
        if (proof) // Test for sufficient truthiness
          return interim.assert({ '@agree': proof });
      }
      throw `Agreement not provable for ${this.statutoryShapes}`;
    });
  }

  async test(state: MeldReadState, update: MeldPreUpdate) {
    await this.withAffected(state, update, async affected => {
      const failures: string[] = [];
      for (let condition of this.sufficientConditions) {
        const { '@agree': proof, '@principal': principal } = update;
        const testResult = await condition.test(state, affected, proof, principal);
        if (testResult === true)
          return;
        failures.push(testResult);
      }
      throw `Inadequate agreement proof for ${this.statutoryShapes}, ` +
      `failures: ${[...failures]}`;
    });
  }

  private async withAffected(
    state: MeldReadState,
    update: MeldPreUpdate,
    proc: (affected: GraphUpdate) => Promise<unknown>
  ) {
    const affected = new AffectedUpdate;
    for (let statutory of this.statutoryShapes)
      affected.add(await statutory.affected(state, update));
    if (!affected.isEmpty)
      return proc(affected.asUpdate());
  }
}

class AffectedUpdate {
  affected: {
    [id: string]: {
      '@delete'?: Subject & Reference;
      '@insert'?: Subject & Reference;
    }
  } = {};

  constructor(update?: GraphUpdate) {
    if (update != null)
      this.affected = asSubjectUpdates(update);
  }

  add(update: GraphUpdate) {
    this.addKey('@delete', update);
    this.addKey('@insert', update);
  }

  subtract(update: GraphUpdate) {
    this.subtractKey('@delete', update);
    this.subtractKey('@insert', update);
  }

  get isEmpty() {
    return Object.keys(this.affected).length === 0;
  }

  asUpdate() {
    return {
      '@delete': this.keyGraph('@delete'),
      '@insert': this.keyGraph('@insert')
    };
  }

  private addKey(key: keyof DeleteInsert<any>, update: GraphUpdate) {
    for (let subject of update[key]) {
      (this.affected[subject['@id']] ??= {})[key] ??= { '@id': subject['@id'] };
      // FIXME: this assumes the values are irrelevant!
      Object.assign(this.affected[subject['@id']][key]!, subject);
    }
  }

  private subtractKey(key: keyof DeleteInsert<any>, update: GraphUpdate) {
    for (let subject of update[key]) {
      const ourSubject = this.affected[subject['@id']]?.[key];
      if (ourSubject != null) {
        // FIXME: this assumes the values are irrelevant!
        for (let property in subject)
          if (isPropertyObject(property, subject[property]))
            delete ourSubject[property];
        if (isReference(ourSubject))
          delete this.affected[subject['@id']][key];
        if (Object.values(this.affected[subject['@id']]).every(v => v == null))
          delete this.affected[subject['@id']];
      }
    }
  }

  private keyGraph(key: keyof DeleteInsert<any>) {
    return new SubjectGraph(Object
      .values(this.affected)
      .map(subjectUpdate => subjectUpdate[key])
      .filter((subject): subject is GraphSubject => subject != null));
  }
}

export interface ShapeAgreementCondition {
  /** @returns a truthy proof, or a falsey lack of proof */
  prove(
    state: MeldReadState,
    affected: GraphUpdate,
    principal?: Reference
  ): Promise<any>;

  /** @returns `true` if condition passed, otherwise error string */
  test(
    state: MeldReadState,
    affected: GraphUpdate,
    proof: any,
    principal?: Reference
  ): Promise<true | string>;
}

export class HasAuthority extends OrmSubject implements ShapeAgreementCondition {
  constructor(src: GraphSubject, readonly domain: OrmDomain, readonly log?: Logger) {
    super(src);
  }

  /**
   * Does the update's responsible principal have authority over the statutory
   * shapes being updated?
   */
  async prove(state: MeldReadState, affected: GraphUpdate, principalRef?: Reference) {
    if (principalRef == null)
      throw new MeldError('Unauthorised', 'No identified principal');
    // Load the principal's authorities if we don't already have them
    const principal = await this.domain.updating(state, orm => orm.get(
      principalRef, src => new Principal(src, orm)));
    if (!principal.deleted) {
      // Every affected subject must be covered by an authority assignment.
      // For each authority, subtract anything affected by that authority.
      const remaining = new AffectedUpdate(affected);
      for (let authority of principal.hasAuthority)
        remaining.subtract(await authority.affected(state, affected));
      return remaining.isEmpty;
    } else {
      this.log?.debug('No proof possible for affected', affected);
      return false;
    }
  }

  async test(state: MeldReadState, affected: GraphUpdate, proof: any, principalRef?: Reference) {
    // We don't care about the proof - just check authority
    return await this.prove(state, affected, principalRef) || 'Principal does not have authority';
  }
}

class Principal extends OrmSubject {
  hasAuthority: Shape[];

  constructor(src: GraphSubject, orm: OrmUpdating) {
    super(src);
    this.initSrcProperty(src, M_LD.hasAuthority, [Array, Subject], {
      local: 'hasAuthority', orm, construct: Shape.from
    });
  }
}

class ExtensionCondition
  extends ExtensionSubject<ShapeAgreementCondition>
  implements ShapeAgreementCondition {

  constructor(src: GraphSubject, env: ExtensionEnvironment, readonly log?: Logger) {
    super(src, env);
  }

  prove(state: MeldReadState, affected: GraphUpdate, principal?: Reference) {
    this.log?.debug('Proving condition for', affected);
    return this.instance.prove(state, affected, principal);
  }

  test(state: MeldReadState, affected: GraphUpdate, proof: any, principal?: Reference) {
    this.log?.debug('Testing condition proof', proof, 'for', affected);
    return this.instance.test(state, affected, proof, principal);
  }
}
