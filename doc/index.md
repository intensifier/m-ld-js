🚧 *This documentation is for
the [developer preview](http://m-ld.org/#developer-preview) of **m-ld**.*

[![github](https://img.shields.io/badge/m--ld-m--ld--js-red?logo=github)](https://github.com/m-ld/m-ld-js)
[![licence](https://img.shields.io/github/license/m-ld/m-ld-js)](https://github.com/m-ld/m-ld-js/blob/master/LICENSE)
[![npm (tag)](https://img.shields.io/npm/v/@m-ld/m-ld/master?label=npm)](https://www.npmjs.com/package/@m-ld/m-ld)

# **m-ld** Javascript clone engine

The Javascript engine can be used in a modern browser or a server engine like
[Node.js](https://nodejs.org/).

> The Javascript clone engine conforms to the **m-ld**
> [specification](http://spec.m-ld.org/). Its support for transaction pattern
> complexity is detailed [below](#transactions). Its [concurrency](#concurrency)
> model is based on immutable states.

## Getting Started

`npm install @m-ld/m-ld`

There are two starter projects available:

- The [Node.js&nbsp;project](https://github.com/m-ld/m-ld-nodejs-starter)
  uses Node processes to initialise two clones, and an MQTT broker for
  messaging.
- The [Web&nbsp;project](https://github.com/m-ld/m-ld-web-starter) shows one way
  to build a multi-collaborator forms application for browsers, using Socket.io
  for messaging.

### Data Persistence

**m-ld** uses [levelup](https://github.com/level/levelup) to interface with a
LevelDB-compatible storage backend.

For the fastest in-memory responses, this library provides `MeldMemDown`, an optimised variant of [memdown](https://github.com/level/memdown), which can be imported from `'@m-ld/m-ld/dist/memdown'` as shown in the example below. To use, you must also install the [`memdown`](https://www.npmjs.com/package/memdown) package as a peer of `@m-ld/m-ld`.

In a service or native application, use [leveldown](https://github.com/level/leveldown/) (file system storage).

In a browser, you can use [level-js](https://github.com/Level/level-js) (browser-local storage).

### Connecting to Other Clones

A **m-ld** clone uses a 'remotes' object to communicate with other clones.

- With an MQTT broker, use [`MqttRemotes`](#mqtt-remotes).
- For a scalable global managed service, use [`AblyRemotes`](#ably-remotes).
- If you have a live web server (not just CDN or serverless), you can use
  [`IoRemotes`](#socketio-remotes).

> 🚧 *If your architecture includes some other publish/subscribe service like AMQP or Apache Kafka, or you would like to use a fully peer-to-peer protocol, please [contact&nbsp;us](https://m-ld.org/hello/) to discuss your use-case. Remotes can even utilise multiple transport protocols, for example WebRTC with a suitable signalling service.*

### Initialisation

The [clone](#clone) function initialises the m-ld engine with a leveldb back-end
and the clone [configuration](interfaces/meldconfig.html).

```typescript
import { clone, uuid } from '@m-ld/m-ld';
import { MeldMemDown } from '@m-ld/m-ld/dist/memdown';
import { MqttRemotes, MeldMqttConfig } from '@m-ld/m-ld/dist/mqtt';

const config: MeldMqttConfig = {
  '@id': uuid(),
  '@domain': 'test.example.org',
  genesis: true,
  mqtt: { hostname: 'mqtt.example.org' }
};

const meld = await clone(new MemDown, MqttRemotes, config);
```

The `clone` function returns control as soon as it is safe to start making data
transactions against the domain. If this clone has has been re-started from
persisted state, it may still be receiving updates from the domain. This can
cause a UI to start showing these updates. If instead, you want to wait until
the clone has the most recent data, you can add:

```typescript
await meld.status.becomes({ online: true, outdated: false });
```

## Remotes

[[include:mqtt-remotes.md]]

[[include:ably-remotes.md]]

[[include:socketio-remotes.md]]

[[include:transactions.md]]

[[include:subjects.md]]

[[include:concurrency.md]]

[[include:security.md]]
