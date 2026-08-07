/** Raised when booking a slot that was taken between fetch and create (a race). */
export class SlotTakenError extends Error {
  constructor(public readonly startTime: string) {
    super(`Slot no longer available: ${startTime}`);
    this.name = 'SlotTakenError';
  }
}
