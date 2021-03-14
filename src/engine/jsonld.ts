import { Options, processContext } from 'jsonld';
import { Context, Iri } from 'jsonld/jsonld-spec';
import { getInitialContext, expandIri, ActiveContext } from 'jsonld/lib/context';
import { compactIri as _compactIri } from 'jsonld/lib/compact';

export * from 'jsonld/lib/util';
export * from 'jsonld/lib/context';

export function expandTerm(value: string, ctx: ActiveContext,
  options?: Options.Expand & { vocab?: boolean }): Iri {
  return expandIri(ctx, value, {
    base: true, vocab: options?.vocab
  }, options ?? {});
}

export function compactIri(iri: Iri, ctx?: ActiveContext,
  options?: Options.CompactIri & { vocab?: boolean }): string {
  return ctx != null ? _compactIri({
    activeCtx: ctx, iri, ...options,
    ...options?.vocab ? { relativeTo: { vocab: options.vocab } } : null
  }) : iri;
}

export async function activeCtx(ctx: Context, options?: Options.DocLoader): Promise<ActiveContext> {
  return processContext(getInitialContext({}), ctx, options ?? {});
}

/**
 * Gets all of the values for a subject's property as an array.
 *
 * @param subject the subject.
 * @param property the property.
 *
 * @return all of the values for a subject's property as an array.
 */
export function getValues(subject: { [key: string]: any }, property: string): Array<any> {
  return [].concat(subject[property] ?? []);
}

export function canonicalDouble(value: number) {
  return value.toExponential(15).replace(/(\d)0*e\+?/, '$1E');
}
