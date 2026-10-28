import type {CompiledUpdateKey, UpdateManifestV1} from './update-manifest-common.mjs';
import type {ReleaseFacts} from './write-update-manifest.mjs';

export function verifySignedManifest(options: {manifestBytes: Uint8Array; signatureBytes: Uint8Array; facts: ReleaseFacts; keys: readonly CompiledUpdateKey[]}): UpdateManifestV1;
