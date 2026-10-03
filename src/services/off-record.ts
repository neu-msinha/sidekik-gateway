/**
 * In-process view of `sessions.off_record`, read on every inbound message and agent command.
 * The gateway is the only writer of that column (DESIGN §4), so this cache stays in step
 * as long as every toggle goes through {@link OffRecordState.set}.
 */
export class OffRecordState {
  private readonly state = new Map<string, boolean>();

  /** Seeds the cache from the database row; a value already set in this process wins. */
  seed(sessionId: string, offRecord: boolean): void {
    if (!this.state.has(sessionId)) this.state.set(sessionId, offRecord);
  }

  set(sessionId: string, on: boolean): void {
    this.state.set(sessionId, on);
  }

  has(sessionId: string): boolean {
    return this.state.has(sessionId);
  }

  isOn(sessionId: string): boolean {
    return this.state.get(sessionId) ?? false;
  }

  forget(sessionId: string): void {
    this.state.delete(sessionId);
  }
}
