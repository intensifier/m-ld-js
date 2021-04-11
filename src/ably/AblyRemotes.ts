/**
 * [[include:ably-remotes.md]]
 * @packageDocumentation
 * @internal
 */
import * as Ably from 'ably';
import { MeldConfig } from '..';
import {
  PubsubRemotes, SubPubsub, SubPub, SendParams, ReplyParams, NotifyParams, PeerParams
} from '../engine/PubsubRemotes';
import { Observable, from, identity } from 'rxjs';
import { mergeMap, filter, map } from 'rxjs/operators';
import { AblyTraffic, AblyTrafficConfig } from './AblyTraffic';
import type { WrtcPeering, PeerSignaller, PeerSignal } from '../wrtc/WrtcPeering';

export interface AblyMeldConfig extends
  Omit<Ably.Types.ClientOptions, 'echoMessages' | 'clientId'>,
  AblyTrafficConfig {
}

export interface MeldAblyConfig extends MeldConfig {
  ably: AblyMeldConfig;
}

export const ablyConnect =
  (opts: Ably.Types.ClientOptions) => new Ably.Realtime.Promise(opts);

interface SendTypeParams extends SendParams { type: '__send'; }
interface ReplyTypeParams extends ReplyParams { type: '__reply'; }
interface NotifyTypeParams extends NotifyParams { type: '__notify' }
interface SignalTypeParams extends PeerParams { type: '__signal'; channelId: string; }
type PeerTypeParams = SendTypeParams | ReplyTypeParams | NotifyTypeParams | SignalTypeParams;

export class AblyRemotes extends PubsubRemotes implements PeerSignaller {
  private readonly client: Ably.Types.RealtimePromise;
  private readonly operations: Ably.Types.RealtimeChannelPromise;
  private readonly direct: Ably.Types.RealtimeChannelPromise;
  private readonly traffic: AblyTraffic;
  private readonly subscribed: Promise<unknown>;
  private readonly peering?: WrtcPeering;

  constructor(config: MeldAblyConfig,
    impl: typeof ablyConnect | { connect?: typeof ablyConnect, peering: WrtcPeering } = ablyConnect) {
    super(config);
    if (typeof impl != 'function') {
      this.peering = impl.peering;
      this.peering.signaller = this;
      impl = impl.connect ?? ablyConnect;
    }
    this.client = impl({ ...config.ably, echoMessages: false, clientId: config['@id'] });
    this.operations = this.channel('operations');
    this.traffic = new AblyTraffic(config.ably);
    // Direct channel that is specific to us, for sending and replying to
    // requests and receiving notifications
    this.direct = this.channel(config['@id']);
    // Ensure we are fully subscribed before we make any presence claims
    this.subscribed = Promise.all([
      this.traffic.subscribe(this.operations, data => this.onRemoteUpdate(data)),
      this.operations.presence.subscribe(() => this.onPresenceChange()),
      this.traffic.subscribe(this.direct, this.onDirectMessage)
    ]).catch(err => this.close(err));
    // Ably does not notify if no-one around, so check presence once subscribed
    this.subscribed.then(() => this.onPresenceChange());
    // Note that we wait for subscription before claiming to be connected.
    // This is so we don't miss messages that are immediately sent to us.
    // https://support.ably.com/support/solutions/articles/3000067435
    this.client.connection.on('connected', () =>
      this.subscribed.then(() => this.onConnect()).catch(this.warnError));
    // Ably has connection recovery with no message loss for 2min. During that
    // time we treat the remotes as live. After that, the connection becomes
    // suspended and we are offline.
    this.client.connection.on(['suspended', 'failed', 'closing'], () => this.onDisconnect());
  }

  async close(err?: any) {
    await super.close(err);
    this.client.connection.close();
  }

  private channel(id: string) {
    // https://www.ably.io/documentation/realtime/channels#channel-namespaces
    return this.client.channels.get(`${this.domain}:${id}`);
  }

  private onDirectMessage = async (data: any, name: string, clientId: string) => {
    try {
      const params = this.toParams(name, clientId);
      switch (params?.type) {
        case '__send':
          await this.onSent(data, params);
          break;
        case '__reply':
          await this.onReply(data, params);
          break;
        case '__notify':
          this.notify(params.channelId, data);
          break;
        case '__signal':
          this.onSignal(params, data);
      }
    } catch (err) {
      this.warnError(err);
    }
  };

  protected setPresent(present: boolean): Promise<unknown> {
    if (present)
      return this.operations.presence.update('__live');
    else
      return this.operations.presence.leave();
  }

  protected publishDelta(msg: Buffer): Promise<unknown> {
    return this.traffic.publish(this.operations, '__delta', msg);
  }

  protected present(): Observable<string> {
    return from(this.operations.presence.get()).pipe(
      mergeMap(identity), // flatten the array of presence messages
      filter(present => present.data === '__live'),
      map(present => present.clientId));
  }

  protected async notifier(params: NotifyParams): Promise<SubPubsub> {
    // Try to create a peer-to-peer notifier
    return (await this.peerSubPub(params)) ??
      this.directSubPub({ type: '__notify', ...params });
  }

  protected sender(params: SendParams): SubPub {
    return this.directSubPub({ type: '__send', ...params });
  }

  protected replier(params: ReplyParams): SubPub {
    return this.directSubPub({ type: '__reply', ...params });
  }

  private toParams(msgName: string, clientId: string): PeerTypeParams | undefined {
    // Message name is concatenated type:id:sentMessageId, where id is type-specific info
    const [type, ...id] = msgName.split(':');
    const params = { fromId: clientId, toId: this.id };
    switch (type) {
      case '__send':
        return { type, messageId: id[0], ...params };
      case '__reply':
        return { type, messageId: id[0], sentMessageId: id[1], ...params };
      case '__notify':
        return { type, channelId: id[0], ...params };
      case '__signal':
        return { type, channelId: id[0], ...params };
    }
  }

  private fromParams(params: PeerTypeParams): { msgName: string, subPubId: string } {
    switch (params.type) {
      case '__send':
        return { subPubId: params.toId, msgName: `__send:${params.messageId}` };
      case '__reply':
        return { subPubId: params.toId, msgName: `__reply:${params.messageId}:${params.sentMessageId}` };
      case '__notify':
        return { subPubId: params.channelId, msgName: `__notify:${params.channelId}` };
      case '__signal':
        return { subPubId: params.channelId, msgName: `__signal:${params.channelId}` };
    }
  }

  private directSubPub(params: PeerTypeParams): SubPubsub {
    const channel = this.channel(params.toId);
    const { subPubId, msgName } = this.fromParams(params);
    return {
      id: subPubId,
      publish: msg => this.duplexPublish(channel, msgName, msg),
      // Subscription not needed, always using our own direct channel
      subscribe: async () => null, close: () => { }
    };
  }

  /** "duplex" because expecting a response */
  private async duplexPublish(
    channel: Ably.Types.RealtimeChannelPromise, name: string, msg: Buffer | object): Promise<unknown> {
    // Ensure we are subscribed before sending anything, or we won't get the reply
    await this.subscribed;
    return this.traffic.publish(channel, name, msg);
  }

  private peerSubPub(params: NotifyParams): Promise<SubPubsub | undefined> {
    return this.peering != null ? this.peering.pubSub(params).catch(err => {
      this.log.info(`Cannot use peer-to-peer notifier due to ${err}`);
      // Fall through to use a direct pubsub
      return undefined;
    }) : Promise.resolve(undefined);
  }

  private onSignal({ fromId, channelId }: SignalTypeParams, data: PeerSignal) {
    if (this.peering == null)
      // Someone is trying to peer with us but we can't
      this.signal(fromId, channelId, { unavailable: true }).catch(this.warnError);
    else
      this.peering.signal(fromId, channelId, data);
  }

  /** override to make public */
  notify(subPubId: string, payload: Buffer) {
    super.onNotify(subPubId, payload);
  }

  /** implements PeerSignaller.signal */
  signal(peerId: string, channelId: string, data: PeerSignal) {
    const { msgName } = this.fromParams({
      type: '__signal', channelId, fromId: this.id, toId: peerId
    });
    return this.duplexPublish(this.channel(peerId), msgName, data);
  }
}