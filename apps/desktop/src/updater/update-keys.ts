import type {ReleaseChannel} from '../channel';

// The compiled update-manifest public keys of each channel (ET-055 UP5; docs/release.md, "Update manifest"). A manifest
// names its signing key by `keyId`; only a key listed here for the build's own channel can verify it, so a staging key
// never verifies a production manifest and the reverse. Rotation adds the new key beside the old one, releases sign with
// the new one, and a later build drops the old one.
//
// Each `publicKey` is the base64 of the raw 32-byte Ed25519 public key. Only public keys belong in this file; the
// production private key stays offline with the owner and the staging key is a secret of the `release-staging`
// environment. Agents never generate, hold or use a signing key.
//
// The owner generated the production key offline on October 28, 2026 (docs/release.md, release checklist step 0); the
// staging list stays empty until the owner adds the staging key. With an empty list every manifest of that channel is
// refused with SIGNATURE_INVALID, so no update of that channel installs.

export interface UpdatePublicKey {
  /** The manifest's `keyId`: 1 to 64 letters, digits, `.`, `_` or `-`. */
  readonly keyId: string;
  /** Base64 of the raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
}

export const UPDATE_PUBLIC_KEYS: Readonly<Record<ReleaseChannel, readonly UpdatePublicKey[]>> = Object.freeze({
  production: Object.freeze([{keyId: 'production-611eb870520f2b0f', publicKey: 'xNO3Nk8zVa8Cs4xTB7/leXn4THF9TS/7+1rJaFDR52U='}]),
  staging: Object.freeze([])
});
