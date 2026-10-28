import type {KeyObject} from 'node:crypto';
import type {UpdateManifestV1} from './update-manifest-common.mjs';

export function privateKeyOf(pem: string): KeyObject;
export function loadSigningKey(options: {keyPath?: string; keyEnv?: string; channel: string; env?: Record<string, string | undefined>}): KeyObject;
export function signManifestBytes(manifestBytes: Uint8Array, privateKey: KeyObject): {manifest: UpdateManifestV1; signature: Buffer};
