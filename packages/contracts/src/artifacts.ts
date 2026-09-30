/** Pointer to a file or blob exchanged with a task, so payloads never travel inline. */
export interface ArtifactRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly label?: string;
}
