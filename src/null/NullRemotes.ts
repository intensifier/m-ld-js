import { BehaviorSubject, NEVER, type Observable } from "rxjs";

import { MeldRemotes, OperationMessage, MeldLocal } from "../engine";
import type { LiveValue } from '../engine/api-support';

class NotImplementedError extends Error {
  constructor(methodName: string) {
    super(
      `${methodName} is not implemented for a NullRemote. The local clone should be genesis.`
    );
  }
}

export class NullRemotes implements MeldRemotes {
  readonly operations: Observable<OperationMessage> = NEVER;
  readonly updates: Observable<OperationMessage> = NEVER;
  readonly live: LiveValue<boolean | null> = new BehaviorSubject(false);

  setLocal(_clone: MeldLocal | null): void {}

  newClock(): never {
    throw new NotImplementedError("newClock");
  }

  revupFrom(): never {
    throw new NotImplementedError("revupFrom");
  }

  snapshot(): never {
    throw new NotImplementedError("snapshot");
  }
}
