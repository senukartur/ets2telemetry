export function verifyPackage(directory: string): {
  packageSha256: string;
  unpackedFilesVerified: number;
  packageFilesVerified: number;
};
