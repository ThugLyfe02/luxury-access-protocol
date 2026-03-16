import { DomainError } from '../errors/DomainError';
import { CustodyEvent } from './CustodyEvent';
import { CustodyEventType } from '../enums/CustodyEventType';

export class ChainOfCustody {
  readonly rentalId: string;
  private readonly _events: CustodyEvent[];

  constructor(rentalId: string) {
    if (!rentalId) {
      throw new DomainError(
        'Rental ID is required for chain of custody',
        'CUSTODY_EVIDENCE_REQUIRED',
      );
    }
    this.rentalId = rentalId;
    this._events = [];
  }

  get events(): ReadonlyArray<CustodyEvent> {
    return this._events;
  }

  get length(): number {
    return this._events.length;
  }

  appendEvent(event: CustodyEvent): void {
    if (event.rentalId !== this.rentalId) {
      throw new DomainError(
        'Custody event rental ID does not match chain',
        'CUSTODY_EVIDENCE_REQUIRED',
      );
    }

    const lastEvent = this._events[this._events.length - 1];
    if (lastEvent && event.occurredAt < lastEvent.occurredAt) {
      throw new DomainError(
        'Custody events must be in chronological order',
        'CUSTODY_VIOLATION',
      );
    }

    this._events.push(event);
  }

  hasEventOfType(eventType: CustodyEventType): boolean {
    return this._events.some((e) => e.eventType === eventType);
  }

  isComplete(): boolean {
    return (
      this.hasEventOfType(CustodyEventType.OWNER_HANDOFF) &&
      this.hasEventOfType(CustodyEventType.RENTER_DELIVERY) &&
      this.hasEventOfType(CustodyEventType.RENTER_RETURN) &&
      this.hasEventOfType(CustodyEventType.OWNER_RETURN)
    );
  }

  lastEvent(): CustodyEvent | null {
    return this._events[this._events.length - 1] ?? null;
  }
}
