import { MeldConstraint, MeldReadState, InterimUpdate } from '..';

/** @internal */
export class CheckList implements MeldConstraint {
  constructor(
    readonly list: MeldConstraint[]) {
  }

  check(state: MeldReadState, update: InterimUpdate) {
    return Promise.all(this.list.map(
      constraint => constraint.check(state, update)));
  }

  async apply(state: MeldReadState, update: InterimUpdate) {
    for (let constraint of this.list)
      await constraint.apply(state, update);
  }
}