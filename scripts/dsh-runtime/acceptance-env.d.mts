export function linuxAcceptanceNode(env?: Readonly<Record<string, string | undefined>>): string;
export function linuxAcceptanceRuntime(env?: Readonly<Record<string, string | undefined>>): {
  NEXAR_DSH_BIN: string;
  NEXAR_DSH_TOOLCHAIN: string;
};
