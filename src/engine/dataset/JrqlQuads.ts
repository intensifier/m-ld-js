import { compact } from 'jsonld';
import { Iri, Url } from 'jsonld/jsonld-spec';
import { clone } from 'jsonld/lib/util';
import { Binding } from 'quadstore';
import { DataFactory, Quad } from 'rdf-js';
import { GraphName } from '.';
import { any, array, uuid } from '../..';
import {
  Context, Subject, Result, Value, isValueObject, isReference, isSet, isList
} from '../../jrql-support';
import { activeCtx, compactIri, dataUrlData, jsonToRdf, rdfToJson } from '../jsonld';
import { inPosition, TriplePos } from '../quads';

export namespace jrql {
  export const $id = 'http://json-rql.org';
  export const item = 'http://json-rql.org/#item'; // Slot item property
  export const hiddenVar = (name: string) => `${$id}/var#${name}`;
  export const hiddenVarRegex = new RegExp(`^${hiddenVar('([\\d\\w]+)')}$`);

  export interface Slot extends Subject {
    '@id': Iri;
    [item]: Value | Value[];
  }

  export function isSlot(s: Subject): s is Slot {
    return s['@id'] != null && s[item] != null;
  }
}

export interface JrqlQuadsOptions {
  /** Whether this will be used to match quads or insert them */
  query: boolean;
  /** The variable names found (sans '?') */
  vars?: Set<string>;
}

export class JrqlQuads {
  constructor(
    private readonly rdf: Required<DataFactory>,
    private readonly graphName: GraphName,
    private readonly base?: Iri) {
  }

  async solutionSubject(results: Result[] | Result, binding: Binding, context: Context) {
    const solutionId = this.rdf.blankNode();
    // Construct quads that represent the solution's variable values
    const subject = await this.toSubject(Object.entries(binding).map(([variable, term]) =>
      this.rdf.quad(
        solutionId,
        this.rdf.namedNode(hiddenVar(variable.slice(1))),
        inPosition('object', term))), [/* TODO: list-items */], context);
    // Unhide the variables and strip out anything that's not selected
    return Object.assign({}, ...Object.entries(subject).map(([key, value]) => {
      if (key !== '@id') { // Strip out blank node identifier
        const varName = matchHiddenVar(key), newKey = varName ? '?' + varName : key;
        if (isSelected(results, newKey))
          return { [newKey]: value };
      }
    }));
  }

  async quads(g: Subject | Subject[], opts: JrqlQuadsOptions, context: Context): Promise<Quad[]> {
    // The pre-processor acts on the input graph in-place
    const jsonld = { '@graph': clone(g), '@context': context };
    new PreProcessor(opts, this.base).process(jsonld['@graph']);
    const quads = await jsonToRdf(this.graphName.termType !== 'DefaultGraph' ?
      { ...jsonld, '@id': this.graphName.value } : jsonld) as Quad[];
    return this.postProcess(quads);
  }

  private postProcess(quads: Quad[]): Quad[] {
    // TODO: Detect RDF lists e.g. from '@container': '@list' in context, and
    // convert them to m-ld lists
    return quads.map(quad => this.rdf.quad(
      this.unhideVar('subject', quad.subject),
      this.unhideVar('predicate', quad.predicate),
      this.unhideVar('object', quad.object),
      quad.graph));
  }

  private unhideVar<P extends TriplePos>(_pos: P, term: Quad[P]): Quad[P] {
    switch (term.termType) {
      case 'NamedNode':
        const varName = matchHiddenVar(term.value);
        if (varName)
          return this.rdf.variable(varName);
    }
    return term;
  }

  /**
   * @param propertyQuads subject-property-value quads
   * @param listItemQuads subject-index-item quads for list-like subjects
   * @returns a single subject compacted against the given context
   */
  async toSubject(
    propertyQuads: Quad[], listItemQuads: Quad[], context: Context): Promise<Subject> {
    const subject = (await compact(await rdfToJson(propertyQuads), context || {})) as Subject;
    if (listItemQuads.length) {
      const ctx = await activeCtx(context);
      // Sort the list items lexically by index and construct an rdf:List
      // TODO: Use list implementation-specific ordering
      const indexes = listItemQuads.map(iq => iq.predicate.value).sort()
        .map(index => compactIri(index, ctx));
      // Create a subject containing only the list items
      const list = await this.toSubject(listItemQuads, [], context);
      subject['@list'] = indexes.map(index => <Value>list[index]);
    }
    return subject;
  }
}

class PreProcessor {
  query: boolean;
  vars?: Set<string>;

  constructor(
    { query, vars }: JrqlQuadsOptions,
    readonly base?: Iri) {
    this.query = query;
    this.vars = vars;
  }

  process(values: Value | Value[], top: boolean = true) {
    array(values).forEach(value => {
      // JSON-LD value object (with @value) cannot contain a variable
      if (typeof value === 'object' && !isValueObject(value)) {
        // If this is a Reference, we treat it as a Subject
        const subject: Subject = value as Subject;
        if (isList(subject))
          this.expandListSlots(subject);
        // Process predicates and objects
        this.processEntries(subject);
        // References at top level => implicit wildcard p-o
        if (top && this.query && isReference(subject))
          (<any>subject)[genHiddenVar(this.vars)] = { '@id': genHiddenVar(this.vars) };
        // Anonymous query subjects => blank node subject (match any) or skolem
        if (!subject['@id'])
          subject['@id'] = this.query ? hiddenVar(genVarName(), this.vars) : skolem(this.base);
      }
    });
  }

  private processEntries(subject: Subject) {
    Object.entries(subject).forEach(([key, value]) => {
      if (key !== '@context') {
        const varKey = hideVar(key, this.vars);
        if (isSet(value)) {
          this.process(value['@set'], false);
        } else if (typeof value === 'object') {
          this.process(value as Value | Value[], false);
        } else if (typeof value === 'string') {
          const varVal = hideVar(value, this.vars);
          if (varVal !== value)
            value = !key.startsWith('@') ? { '@id': varVal } : varVal;
        }
        subject[varKey] = value;
        if (varKey !== key)
          delete subject[key];
      }
    });
  }

  private expandListSlots(list: Subject) {
    // Normalise explicit list objects: expand fully to slots
    if (typeof list['@list'] === 'object') {
      // This handles arrays as well as hashes
      // Normalise indexes to data URLs (throw if not convertible)
      Object.entries(list['@list']).forEach(([indexKey, item]) => {
        const i = toIndexNumber(indexKey);
        if (i == null)
          throw new Error('Malformed list index');
        if (!Array.isArray(i) && Array.isArray(item) && !Array.isArray(list['@list'])) {
          // Inserting multiple sub-items at one index
          item.forEach((subItem, subIndex) =>
            addSlot(list, toIndexDataUrl([i, subIndex]), subItem));
        } else {
          addSlot(list, toIndexDataUrl(i), item);
        }
      });
    } else {
      // Singleton list item at position zero
      addSlot(list, toIndexDataUrl(0), list['@list']);
    }
    delete list['@list'];
  }
}

function addSlot(subject: Subject, index: string, item: any) {
  if (index !== '@context') {
    // Anonymous slot will have a variable or skolem @id added later
    // FIXME: If item is an array, this loses ordering
    const slot = { [jrql.item]: item };
    const existing = subject[index] as Exclude<Subject['any'], Context>;
    if (isSet(existing))
      existing['@set'] = array(existing['@set']).concat(slot);
    else
      subject[index] = array(existing).concat(slot);
  } else {
    throw new Error('Cannot include context in list');
  }
}

function hideVar(token: string, vars?: Set<string>): string {
  const name = matchVar(token);
  // Allow anonymous variables as '?'
  return name === '' ? genHiddenVar(vars) : name ? hiddenVar(name, vars) : token;
}

export function matchVar(token: string): string | undefined {
  return /^\?([\d\w]*)$/g.exec(token)?.[1];
}

function matchHiddenVar(value: string): string | undefined {
  return jrql.hiddenVarRegex.exec(value)?.[1];
}

function genHiddenVar(vars?: Set<string>) {
  return hiddenVar(genVarName(), vars);
}

export function genVarName() {
  return any().slice(1);
}

function hiddenVar(name: string, vars?: Set<string>) {
  vars && vars.add(name);
  return jrql.hiddenVar(name);
}

/**
 * Generates a new skolemization IRI for a blank node. The base is allowed to be
 * `undefined` but the function will throw a `TypeError` if it is.
 * @see https://www.w3.org/TR/rdf11-concepts/#h3_section-skolemization
 */
function skolem(base: Iri | undefined): Iri {
  return new URL(`/.well-known/genid/${uuid()}`, base).href;
}

function isSelected(results: Result[] | Result, key: string) {
  return results === '*' || key.startsWith('@') ||
    (Array.isArray(results) ? results.includes(key) : results === key);
}

export function toIndexNumber(indexKey: any): number | [number, number] | undefined {
  const isNaturalNumber = (n: any) =>
    typeof n == 'number' && Number.isSafeInteger(n) && n >= 0;
  if (indexKey != null && indexKey !== '') {
    if (isNaturalNumber(indexKey)) // ℕ
      return indexKey;
    switch (typeof indexKey) {
      case 'string':
        return toIndexNumber(indexKey.startsWith('data') ?
          dataUrlData(indexKey, 'text/plain') : // 'data:,ℕ' or 'data:,ℕ,ℕ'
          indexKey.includes(',') ?
            indexKey.split(',').map(Number) : // 'ℕ,ℕ'
            Number(indexKey)); // 'ℕ'
      case 'object': // [ℕ,ℕ]
        if (Array.isArray(indexKey) &&
          indexKey.length == 2 &&
          indexKey.every(isNaturalNumber))
          return indexKey as [number, number];
    }
  }
}

function toIndexDataUrl(index: number | [number, number]): Url {
  return `data:,${array(index).map(i => i.toFixed(0)).join(',')}`;
}