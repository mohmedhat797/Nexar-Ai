export const INSTALL_RECEIPT: string;
export const ARTIFACT_SEAL: string;

export interface RuntimeArtifactSeal {
  readonly schema: string;
  readonly package: string;
  readonly version: string;
  readonly lockSha256: string;
  readonly platform: string;
  readonly arch: string;
  readonly installGeneration: string;
  readonly sealGeneration: string;
  readonly sealedAt: string;
  readonly treeSha256: string;
  readonly files: number;
  readonly bytes: number;
}

export function installReceipt(options: {
  generation: string;
  pinDir: string;
}): Readonly<Record<string, unknown>>;

export function hashRuntimeTree(
  root: string,
): readonly { readonly rel: string; readonly size: number; readonly sha256: string }[];

export function sealRuntimeArtifact(options: {
  dir: string;
  pinDir: string;
  now?: () => Date;
  id?: () => string;
}): RuntimeArtifactSeal;

export function inspectRuntimeArtifact(options: { dir: string; pinDir: string }):
  | { readonly status: 'absent' | 'unsealed' }
  | {
      readonly status: 'sealed';
      readonly seal: RuntimeArtifactSeal;
    };

export function promoteRuntimeArtifact(options: {
  dir: string;
  target: string;
  pinDir: string;
  id?: () => string;
  onCopied?: () => void;
}): RuntimeArtifactSeal;

export function verifyPackagedRuntime(options: {
  dir: string;
  seal: RuntimeArtifactSeal;
  reference: string;
}): {
  readonly matches: boolean;
  readonly treeSha256: string;
  readonly files: number;
  readonly bytes: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly changed: readonly string[];
};
