import { QuadStoreDataset } from './engine/dataset';
import { DatasetEngine } from './engine/dataset/DatasetEngine';
import { AbstractLevelDOWN } from 'abstract-leveldown';
import { ApiStateMachine } from "./engine/MeldState";
import { LogLevelDesc } from 'loglevel';
import { ConstraintConfig, constraintFromConfig } from './constraints';
import { DomainContext } from './engine/MeldEncoding';
import { Context } from './jrql-support';
import { MeldClone, MeldConstraint } from './api';
import { MeldStatus, LiveStatus } from '@m-ld/m-ld-spec';
import { Observable } from 'rxjs';
import { MeldRemotes } from './engine';

export {
  Pattern, Reference, Context, Variable, Value, Describe, Construct,
  Group, Query, Read, Result, Select, Subject, Update,
  isRead, isWrite
} from './jrql-support';

export * from './util';
export * from './api';
export * from './updates';

/**
 * **m-ld** clone configuration, used to initialise a {@link clone} for use.
 */
export interface MeldConfig {
  /**
   * The local identity of the m-ld clone session, used for message bus identity
   * and logging. This identity does not need to be the same across re-starts of
   * a clone with persistent data. It must be unique among the clones for the
   * domain. For convenience, you can use the {@link uuid} function.
   */
  '@id': string;
  /**
   * A URI domain name, which defines the universal identity of the dataset
   * being manipulated by a set of clones (for example, on the configured
   * message bus). For a clone with persistent data from a prior session, this
   * *must* be the same as the previous session.
   */
  '@domain': string;
  /**
   * An optional JSON-LD context for the domain data. If not specified:
   * * `@base` defaults to `http://{domain}`
   * * `@vocab` defaults to the resolution of `/#` against the base
   */
  '@context'?: Context;
  /**
   * Semantic constraints to apply to the domain data.
   */
  constraints?: ConstraintConfig[];
  /**
   * Set to `true` to indicate that this clone will be 'genesis'; that is, the
   * first new clone on a new domain. This flag will be ignored if the clone is
   * not new. If `false`, and this clone is new, successful clone initialisation
   * is dependent on the availability of another clone. If set to true, and
   * subsequently another non-new clone appears on the same domain, either or
   * both clones will immediately close to preserve their data integrity.
   */
  genesis: boolean;
  /**
   * An sane upper bound on how long any to wait for a response over the
   * network, in milliseconds. Used for message send timeouts and to trigger
   * fallback behaviours. Default is five seconds.
   */
  networkTimeout?: number;
  /**
   * An upper bound on operation message size, in bytes. Usually imposed by the
   * message publishing implementation. Default is infinity. Exceeding this
   * limit will cause a transaction to fail, to prevent a clone from being
   * unable to transmit the update to its peers.
   */
  maxOperationSize?: number;
  /**
   * Log level for the clone
   */
  logLevel?: LogLevelDesc;
}

/**
 * Create or initialise a local clone, depending on whether the given LevelDB
 * database already exists. This function returns as soon as it is safe to begin
 * transactions against the clone; this may be before the clone has received all
 * updates from the domain. You can wait until the clone is up-to-date using the
 * {@link MeldClone.status} property.
 *
 * @param backend an instance of a leveldb backend
 * @param remotes a driver for connecting to remote m-ld clones on the domain.
 * This can be a configured object (e.g. `new MqttRemotes(config)`) or just the
 * class (`MqttRemotes`).
 * @param config the clone configuration
 * @param constraints constraints in addition to those in the configuration. 🚧
 * Experimental: use with caution.
 */
export async function clone(
  backend: AbstractLevelDOWN,
  remotes: MeldRemotes | (new (config: MeldConfig) => MeldRemotes),
  config: MeldConfig,
  constraints?: MeldConstraint[]): Promise<MeldClone> {

  const context = new DomainContext(config['@domain'], config['@context']);
  const dataset = await new QuadStoreDataset(backend, context).initialise();

  if (typeof remotes == 'function')
    remotes = new remotes(config);
  
  constraints ??= await Promise.all((config.constraints ?? [])
    .map(item => constraintFromConfig(item, context)));

  const engine = new DatasetEngine({ dataset, remotes, config, constraints, context });
  await engine.initialise();
  return new DatasetClone(engine);
}

/** @internal */
class DatasetClone extends ApiStateMachine implements MeldClone {
  constructor(private readonly dataset: DatasetEngine) {
    super(dataset);
  }

  get status(): Observable<MeldStatus> & LiveStatus {
    return this.dataset.status;
  }

  close(err?: any): Promise<unknown> {
    return this.dataset.close(err);
  }
}