// Test cases and bugs share one file list, so deleting a file removes BOTH its test cases and
// its bugs (no orphans). Pure: returns the surviving collections; persisting is the repo layer's job.
export function deleteFileCascade<F extends { id: string }, T extends { fileId?: string }, B extends { fileId?: string }>(
  state: { files: F[]; testcases: T[]; bugs: B[] }, fileId: string,
): { files: F[]; testcases: T[]; bugs: B[] } {
  return {
    files: state.files.filter(f => f.id !== fileId),
    testcases: state.testcases.filter(t => t.fileId !== fileId),
    bugs: state.bugs.filter(b => b.fileId !== fileId),
  };
}
