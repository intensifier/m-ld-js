import { any, anyName, blank } from '../api';
import {
  Atom,
  Constraint,
  InlineConstraint,
  isInlineConstraint,
  isPropertyObject,
  isReference,
  isSet,
  isValueObject,
  isVocabReference,
  Reference,
  Subject,
  SubjectPropertyObject,
  VariableExpression
} from '../jrql-support';
import { JsonldContext, mapValue } from './jsonld';
import { asQueryVar, Quad, Quad_Object, Quad_Subject, RdfFactory } from './quads';
import { JRQL, RDF } from '../ns';
import { JrqlMode, ListIndex, listItems, toIndexDataUrl } from './jrql-util';
import { isArray, lazy, mapObject } from './util';
import { array } from '../util';

const NO_VARS: ReadonlySet<string> = new Set<string>();

export interface InlineConstraints {
  filters: ReadonlyArray<Constraint>,
  binds: ReadonlyArray<VariableExpression>
}

export namespace InlineConstraints {
  export const NONE: InlineConstraints = { filters: [], binds: [] };
}

export class SubjectQuads implements InlineConstraints {
  /** Populated with inline filters found, if mode is 'match' */
  private readonly _filters?: Constraint[];
  /** Populated with inline bindings found, if mode is 'load' */
  private readonly _binds?: VariableExpression[];

  /**
   * @param rdf
   * @param mode
   * @param ctx
   * @param _vars Populated with variable names found (sans '?')
   */
  constructor(
    readonly rdf: RdfFactory,
    readonly mode: JrqlMode,
    readonly ctx: JsonldContext,
    private readonly _vars?: Set<string>
  ) {
    if (mode === JrqlMode.match)
      this._filters = [];
    if (mode === JrqlMode.load)
      this._binds = [];
  }

  get vars(): ReadonlySet<string> {
    return this._vars ?? NO_VARS;
  }

  get filters(): ReadonlyArray<Constraint> {
    return this._filters ?? [];
  }

  get binds(): ReadonlyArray<VariableExpression> {
    return this._binds ?? [];
  }

  quads(subjects: Subject | Subject[]) {
    return [...this.process(subjects)];
  }

  private *process(
    object: SubjectPropertyObject,
    outer: Quad_Subject | null = null,
    property: string | null = null
  ): Iterable<Quad> {
    // TODO: property is @list in context
    for (let value of array(object))
      if (isArray(value))
        // Nested array is flattened
        yield *this.process(value, outer, property);
      else if (isSet(value))
        // @set is elided
        yield *this.process(value['@set'], outer, property);
      else if (typeof value === 'object' &&
        !isValueObject(value) &&
        !isVocabReference(value) &&
        !isInlineConstraint(value))
        // TODO: @json type, nested @context object
        yield *this.subjectQuads(value, outer, property);
      else if (outer != null && property != null)
        // This is an atom, so yield one quad
        yield this.rdf.quad(
          outer,
          this.predicate(property),
          this.objectTerm(value, property)
        );
      // TODO: What if the property expands to a keyword in the context?
      else
        throw new Error(`Cannot yield quad from top-level value: ${value}`);
  }

  private *subjectQuads(
    object: Subject | Reference,
    outer: Quad_Subject | null,
    property: string | null
  ) {
    const subject: Subject = object as Subject;
    // If this is a Reference, we treat it as a Subject
    const sid = this.subjectId(subject);

    if (outer != null && property != null)
      // Yield the outer quad referencing this subject
      yield this.rdf.quad(outer, this.predicate(property), sid);
    else if (this.mode === JrqlMode.match && isReference(subject))
      // References at top level => implicit wildcard p-o
      yield this.rdf.quad(sid, this.genVar(), this.genVar());

    // Process predicates and objects
    for (let [property, value] of Object.entries(subject))
      if (isPropertyObject(property, value))
        if (property === '@list')
          yield *this.listQuads(sid, value);
        else
          yield *this.process(value, sid, property);
  }

  private subjectId(subject: Subject) {
    if (subject['@id'] != null)
      if (subject['@id'].startsWith('_:'))
        return this.rdf.blankNode(subject['@id']);
      else
        return this.expandNode(subject['@id']);
    else if (this.mode === JrqlMode.match)
      return this.genVar();
    else if (this.mode === JrqlMode.load && this.rdf.skolem != null)
      return this.rdf.skolem();
    else
      return this.rdf.blankNode(blank());
  }

  private *listQuads(lid: Quad_Subject, list: SubjectPropertyObject): Iterable<Quad> {
    // Normalise explicit list objects: expand fully to slots
    for (let [index, item] of listItems(list, this.mode))
      yield *this.slotQuads(lid, index, item);
  }

  private *slotQuads(
    lid: Quad_Subject,
    index: string | ListIndex,
    item: SubjectPropertyObject
  ): Iterable<Quad> {
    const slot = this.asSlot(item);
    let indexKey: string;
    if (typeof index === 'string') {
      // Index is a variable
      index ||= this.genVarName(); // We need the var name now to generate sub-var names
      indexKey = JRQL.subVar(index, 'listKey');
      // Generate the slot id variable if not available
      if (!('@id' in slot))
        slot['@id'] = JRQL.subVar(index, 'slotId');
    } else if (this.mode !== JrqlMode.match) {
      // Inserting at a numeric index
      indexKey = toIndexDataUrl(index);
    } else {
      // Index is specified numerically in match mode. The value will be matched
      // with the slot index below, and the key index with the slot ID, if present
      const slotVarName = slot['@id'] != null && JRQL.matchVar(slot['@id']);
      indexKey = slotVarName ? JRQL.subVar(slotVarName, 'listKey') : any();
    }
    // Slot index is never asserted, only entailed
    if (this.mode === JrqlMode.match)
      // Sub-index should never exist for matching
      slot['@index'] = typeof index == 'string' ? `?${index}` : index[0];
    // This will yield the index key as a property, as well as the slot
    yield *this.process(slot, lid, indexKey);
  }

  /** @returns a mutable proto-slot object */
  private asSlot(item: SubjectPropertyObject): Subject {
    if (isArray(item))
      // A nested list is a nested list (not flattened or a set)
      return { '@item': { '@list': item } };
    if (typeof item == 'object' && ('@item' in item || this.mode === JrqlMode.graph))
      // The item is already a slot (with an @item key)
      return { ...item };
    else
      return { '@item': item };
  }

  private matchVar = (term: string) => {
    if (this.mode !== JrqlMode.graph) {
      const varName = JRQL.matchVar(term);
      if (varName != null) {
        if (!varName)
          // Allow anonymous variables as '?'
          return this.genVar();
        this._vars?.add(varName);
        return this.rdf.variable(varName);
      }
    }
  };

  private predicate = lazy(property => {
    switch (property) {
      case '@type':
        return this.rdf.namedNode(RDF.type);
      case '@index':
        return this.rdf.namedNode(JRQL.index);
      case '@item':
        return this.rdf.namedNode(JRQL.item);
      default:
        return this.expandNode(property, true);
    }
  });

  private expandNode(term: string, vocab = false) {
    return this.matchVar(term) ??
      this.rdf.namedNode(this.ctx.expandTerm(term, { vocab }));
  }

  private genVarName() {
    const varName = anyName();
    this._vars?.add(varName);
    return varName;
  }

  private genVar() {
    return this.rdf.variable(this.genVarName());
  }

  objectTerm(value: Atom | InlineConstraint, property?: string): Quad_Object {
    if (this.mode !== JrqlMode.graph && isInlineConstraint(value)) {
      let { variable, constraint } = this.inlineConstraintDetails(value);
      // The variable is the 1st parameter of the resultant constraint expression.
      constraint = mapObject(constraint, (operator, expression) => ({
        [operator]: [asQueryVar(variable), ...array(expression)]
      }));
      if (this.mode === JrqlMode.match) {
        // If we're matching, the variable is the object e.g. ?o > 1
        this._filters?.push(constraint);
        return variable;
      } else /*if (this.mode === JrqlMode.load)*/ {
        // If we're loading, the object is the return value of the expression e.g.
        // ?o = ?x + 1, so we expect two variables
        const returnVar = this.genVar();
        this._binds?.push({ [asQueryVar(returnVar)]: constraint });
        return returnVar;
      }
    } else {
      return mapValue<Quad_Object>(property ?? null, value, (value, type, language) => {
        if (type === '@id' || type === '@vocab')
          return this.rdf.namedNode(value);
        else if (language)
          return this.rdf.literal(value, language);
        else if (type !== '@none')
          return this.rdf.literal(value, this.rdf.namedNode(type));
        else
          return this.rdf.literal(value);
      }, { ctx: this.ctx, interceptRaw: this.matchVar });
    }
  }

  private inlineConstraintDetails(inlineConstraint: InlineConstraint) {
    if ('@value' in inlineConstraint) {
      const variable = this.matchVar(inlineConstraint['@value']);
      if (variable == null)
        throw new Error(`Invalid variable for inline constraint: ${inlineConstraint}`);
      const { '@value': _, ...constraint } = inlineConstraint;
      return { variable, constraint };
    } else {
      return { variable: this.genVar(), constraint: inlineConstraint };
    }
  }
}
