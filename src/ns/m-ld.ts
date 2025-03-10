export const $base = 'http://m-ld.org/';

/** Property for serialisation of transaction IDs in operation messages */
export const tid = `${$base}#tid`;

/** Property for secret known only to domain users */
export const secret = `${$base}#secret`;

/** Class of signed request envelope */
export const signed = `${$base}Signed`;

/** Class of encrypted operation envelope */
export const encrypted = `${$base}Encrypted`;

/** Security Principal class */
export const principal = `${$base}Principal`;

/** Property for asymmetric public key */
export const publicKey = `${$base}#publicKey`;

export const rdflseq = `${$base}RdfLseq`;

const rdflseqPosIdPre = `${rdflseq}/?=`;

export function matchRdflseqPosId(predicate: string): string | undefined {
  if (predicate.startsWith(rdflseqPosIdPre))
    return predicate.slice(rdflseqPosIdPre.length);
}

export function rdflseqPosId(lseqPosId: string): string {
  return rdflseqPosIdPre + lseqPosId;
}

/**
 * `control` subdomain for Pubsub remotes
 * @see ../remotes/ControlMessage.ts
 */
export enum MeldMessageType {
/** The (usually implicit) RDFS Class of m-ld operation messages */
  operation = 'http://m-ld.org/operation',
  request = 'http://control.m-ld.org/request',
  response = 'http://control.m-ld.org/response'
}

export enum MeldRequestType {
  clock = 'http://control.m-ld.org/request/clock',
  snapshot = 'http://control.m-ld.org/request/snapshot',
  revup = 'http://control.m-ld.org/request/revup'
}

export enum MeldResponseType {
  clock = 'http://control.m-ld.org/response/clock',
  snapshot = 'http://control.m-ld.org/response/snapshot',
  revup = 'http://control.m-ld.org/response/revup',
  rejected = 'http://control.m-ld.org/response/rejected'
}