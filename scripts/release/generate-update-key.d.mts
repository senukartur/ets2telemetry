export function generateUpdateKey(channel: string): {privatePem: string; keyId: string; publicKey: string};
export function updateKeyEntry(key: {keyId: string; publicKey: string}): string;
export function writeUpdateKey(channel: string, out: string): {keyId: string; publicKey: string};
