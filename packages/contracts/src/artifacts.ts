/** Pointer to a file or blob exchanged with a task, so payloads never travel inline. */
export interface ArtifactRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly label?: string;
  /** Size of the stored content, when the producer knows it. */
  readonly sizeBytes?: number;
  /** Lowercase hex SHA-256 of the stored content. */
  readonly sha256?: string;
  /** True for content that is not final and must be reviewed before it is used or sent. */
  readonly draft?: boolean;
}
