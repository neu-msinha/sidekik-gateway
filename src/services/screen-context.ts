/**
 * The supplier of the record on screen, per session, so redaction can keep it (docs v0.3: spaCy
 * would otherwise tag a supplier like "Präzisionswerk Ulm" as a person). Updated from the page's
 * DOM events (browser mode) and perception's screen events (meeting mode, where the page sends none).
 */
export class ScreenContext {
  private readonly suppliers = new Map<string, string>();

  update(sessionId: string, supplier: string | undefined): void {
    if (supplier?.trim()) this.suppliers.set(sessionId, supplier.trim());
  }

  /** Names to pass as `keep` to the redactor. */
  keep(sessionId: string): string[] {
    const supplier = this.suppliers.get(sessionId);
    return supplier ? [supplier] : [];
  }

  forget(sessionId: string): void {
    this.suppliers.delete(sessionId);
  }
}
